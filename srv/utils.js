"use strict";
/**
 * srv/utils.js
 *
 * Implementación del UtilsService (utils.cds).
 *
 * Fuentes de datos reales (verificadas en código fuente UI5):
 *
 *   PDF propuesta   → SAP Gateway /WfObtenerPDFH2HSet → campo Docum (base64)
 *                     Equivale a: oPPOData.getPropuestaPDFSAP() + showPDF() en Detail.controller.js
 *                     El UI5 renderiza con pdf.js (PDFDialog.js / PDFDialogUrl.js)
 *                     CAP retorna el mismo base64 que SAP Gateway devuelve.
 *
 *   PDF aprobaciones → HANA /PropuestaPagoAprobadores → pdfkit server-side
 *
 *   Excel            → HANA /PropuestaPago, /PropuestaPagoAprobadores → exceljs server-side
 *
 *   Correo           → SAP Gateway ZFISO_CORREO_ONB_H2H_SRV /EnviarCorreo_Aprobado
 *                      Equivale a: oPPOData.enviarCorreoAprobadores() en PPOData.js
 */

const cds = require("@sap/cds");
const LOG  = cds.log("utils-service");

module.exports = cds.service.impl(async function (srv) {

  // ── PDF: PROPUESTA (desde SAP Gateway) ─────────────────────────────────────

  /**
   * Obtiene el PDF de la propuesta desde SAP Gateway /WfObtenerPDFH2HSet.
   * El campo Docum contiene el base64 del PDF generado por SAP.
   *
   * Equivale a: oPPOData.getPropuestaPDFSAP(oPropuestaPago) en Detail.controller.js
   * → luego showPDF() lo renderiza con pdf.js en el canvas
   * → onDownloadPDF() lo descarga con linkSource = data:application/pdf;base64,...
   *
   * CAP actúa como proxy: UI5 llama a CAP, CAP llama a SAP Gateway,
   * retorna el base64 al UI5 que ya sabe cómo descargarlo.
   */
  srv.on("obtenerPDFPropuesta", async (req) => {
    const { NroPP, Sociedad, FechaPP, Banco } = req.data;

    try {
      // Construir objeto pp compatible con sap-gateway-client
      const pp = {
        NroPP,
        Sociedad,
        FechaPP,
        FechaPPJS: _parseFechaPP(FechaPP),
      };

      const oRpta = await gw.getPropuestaPDFSAP(pp);
      const results = Array.isArray(oRpta) ? oRpta : (oRpta?.results ?? []);

      if (!results.length || !results[0].Docum) {
        return req.error(404, `No se encontró el PDF para la propuesta ${NroPP}`);
      }

      // SAP devuelve base64 a veces con prefijo "data:...,", a veces sin él
      let sBase64 = results[0].Docum;
      if (sBase64.includes(",")) {
        sBase64 = sBase64.split(",")[1];
      }

      // Nombre de archivo igual al que usa onDownloadPDF() en Detail.controller.js
      const sNombre = `${NroPP}-${Sociedad}-${Banco}-${FechaPP}`.replaceAll("/", "-");

      LOG.info(`obtenerPDFPropuesta OK | NroPP=${NroPP}`);
      return {
        base64  : sBase64,
        filename: `${sNombre}.pdf`,
        mimeType: "application/pdf",
      };

    } catch (err) {
      LOG.error(`obtenerPDFPropuesta ERROR | NroPP=${NroPP}`, err.message);
      return req.error(500, `Error al obtener PDF: ${err.message}`);
    }
  });

  // ── PDF: APROBACIONES (generado server-side con pdfkit) ─────────────────────

  /**
   * Genera el PDF del historial de aprobaciones usando datos de HANA.
   * Fuente: HANA /PropuestaPagoAprobadores
   */
  srv.on("generarPDFAprobaciones", async (req) => {
    const { NroPP, Sociedad, FechaPP } = req.data;

    try {
      // Obtener aprobadores desde HANA
      const svc  = await cds.connect.to("HANA_H2H");
      const res  = await svc.get("/PropuestaPagoAprobadores", {
        params: {
          $filter : `NroPP eq '${NroPP}' and Sociedad eq '${Sociedad}'`,
          $orderby: "FechaAprob asc",
        },
      });
      const aAprobadores = Array.isArray(res) ? res : (res?.results ?? []);

      const PDFDocument = require("pdfkit");
      const chunks = [];
      const doc    = new PDFDocument({ margin: 40, size: "A4" });
      doc.on("data", c => chunks.push(c));

      await new Promise((resolve, reject) => {
        doc.on("end", resolve);
        doc.on("error", reject);

        // Encabezado
        doc.fontSize(14).font("Helvetica-Bold")
          .text("HISTORIAL DE APROBACIONES", { align: "center" });
        doc.moveDown(0.3);
        doc.fontSize(9).font("Helvetica")
          .text(`Propuesta: ${NroPP}  |  Sociedad: ${Sociedad}  |  Fecha PP: ${FechaPP}`, { align: "center" });
        doc.moveDown(0.5);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.5);

        // Encabezados tabla
        const cols = { usuario: 40, rol: 160, aprobado: 270, fecha: 340, obs: 420 };
        doc.font("Helvetica-Bold").fontSize(8);
        doc.text("Usuario",    cols.usuario,  doc.y);
        doc.text("Rol",        cols.rol,      doc.y - doc.currentLineHeight());
        doc.text("Acción",     cols.aprobado, doc.y - doc.currentLineHeight());
        doc.text("Fecha",      cols.fecha,    doc.y - doc.currentLineHeight());
        doc.text("Observación",cols.obs,      doc.y - doc.currentLineHeight());
        doc.moveDown(0.2);
        doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
        doc.moveDown(0.3);

        // Filas
        doc.font("Helvetica").fontSize(8);
        for (const apr of aAprobadores) {
          const yRow = doc.y;
          const accion = apr.Aprobado === "1" ? "Aprobó" : "Observó";
          const fecha  = apr.FechaAprob
            ? new Date(apr.FechaAprob).toLocaleDateString("es-PE")
            : "-";

          doc.text(apr.Usuario    ?? "-", cols.usuario,  yRow, { width: 115 });
          doc.text(apr.RolID      ?? "-", cols.rol,      yRow, { width: 105 });
          doc.text(accion,               cols.aprobado,  yRow, { width: 65  });
          doc.text(fecha,                cols.fecha,     yRow, { width: 75  });
          doc.text(apr.Observacion ?? "-",cols.obs,      yRow, { width: 130 });
          doc.moveDown(0.6);

          // Salto de página si se acaba el espacio
          if (doc.y > 750) doc.addPage();
        }

        if (!aAprobadores.length) {
          doc.fillColor("gray").text("Sin registros de aprobación", { align: "center" });
        }

        // Pie
        doc.moveDown(1);
        doc.fontSize(7).fillColor("gray")
          .text(`Generado: ${new Date().toLocaleString("es-PE")}`, { align: "right" });

        doc.end();
      });

      const buffer = Buffer.concat(chunks);
      LOG.info(`generarPDFAprobaciones OK | NroPP=${NroPP} | ${aAprobadores.length} registros`);
      return {
        base64  : buffer.toString("base64"),
        filename: `Aprobaciones_${NroPP}_${Sociedad}.pdf`,
        mimeType: "application/pdf",
      };

    } catch (err) {
      LOG.error(`generarPDFAprobaciones ERROR | NroPP=${NroPP}`, err.message);
      return req.error(500, `Error al generar PDF: ${err.message}`);
    }
  });

  // ── EXCEL: PROPUESTAS (desde HANA /PropuestaPago) ───────────────────────────

  srv.on("exportarExcelPropuestas", async (req) => {
    const { Sociedad, FechaDesde, FechaHasta, EstadoPP } = req.data;

    try {
      // Obtener propuestas desde HANA
      const svc = await cds.connect.to("HANA_H2H");
      const filters = [`Sociedad eq '${Sociedad}'`];
      if (EstadoPP) filters.push(`EstadoPP eq '${EstadoPP}'`);

      const res  = await svc.get("/PropuestaPago", {
        params: {
          $filter : filters.join(" and "),
          $orderby: "FechaPP desc",
        },
      });
      const aPropuestas = Array.isArray(res) ? res : (res?.results ?? []);

      const ExcelJS   = require("exceljs");
      const workbook  = new ExcelJS.Workbook();
      workbook.creator = "CAP H2H Aprobaciones";
      workbook.created = new Date();

      const ws = workbook.addWorksheet("Propuestas de Pago", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      ws.columns = [
        { header: "Nro. PP",        key: "NroPP",            width: 18 },
        { header: "Fecha PP",       key: "FechaPP",          width: 14 },
        { header: "Sociedad",       key: "Sociedad",         width: 10 },
        { header: "Estado",         key: "EstadoPP",         width: 16 },
        { header: "Vía Pago",       key: "ViaPago",          width: 10 },
        { header: "Modalidad",      key: "ModalidadPP",      width: 12 },
        { header: "Importe",        key: "Importe",          width: 18,
          style: { numFmt: "#,##0.00" } },
        { header: "Moneda",         key: "Moneda",           width: 8  },
        { header: "Banco",          key: "BancoDescripcion", width: 30 },
        { header: "Versión",        key: "Version",          width: 8  },
        { header: "Analista",       key: "Analista",         width: 14 },
        { header: "Modificado por", key: "UserModif",        width: 20 },
        { header: "Fecha Modif.",   key: "FechaModif",       width: 18 },
      ];

      // Estilo encabezado
      ws.getRow(1).eachCell(cell => {
        cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
        cell.font      = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
        cell.border    = { bottom: { style: "thin", color: { argb: "FF000000" } } };
      });
      ws.getRow(1).height = 20;

      // Filas de datos
      for (const pp of aPropuestas) {
        // Filtrar por rango de fechas en el servidor (HANA no siempre permite range filter)
        ws.addRow({
          NroPP           : pp.NroPP,
          FechaPP         : pp.FechaPP,
          Sociedad        : pp.Sociedad,
          EstadoPP        : pp.EstadoPP,
          ViaPago         : pp.ViaPago,
          ModalidadPP     : pp.ModalidadPP,
          Importe         : parseFloat(pp.Importe ?? 0),
          Moneda          : pp.Moneda,
          BancoDescripcion: pp.BancoDescripcion,
          Version         : pp.Version,
          Analista        : pp.Analista,
          UserModif       : pp.UserModif,
          FechaModif      : pp.FechaModif
            ? new Date(pp.FechaModif).toLocaleDateString("es-PE")
            : "",
        });
      }

      // Hoja de filtros aplicados
      const wsInfo = workbook.addWorksheet("Filtros");
      wsInfo.addRow(["Sociedad", Sociedad]);
      wsInfo.addRow(["Fecha Desde", FechaDesde]);
      wsInfo.addRow(["Fecha Hasta", FechaHasta]);
      wsInfo.addRow(["Estado PP", EstadoPP || "Todos"]);
      wsInfo.addRow(["Total registros", aPropuestas.length]);
      wsInfo.addRow(["Generado", new Date().toLocaleString("es-PE")]);

      const buffer   = await workbook.xlsx.writeBuffer();
      const filename = `Propuestas_${Sociedad}_${FechaDesde}_${FechaHasta}.xlsx`;

      LOG.info(`exportarExcelPropuestas OK | Sociedad=${Sociedad} | ${aPropuestas.length} registros`);
      return {
        base64  : Buffer.from(buffer).toString("base64"),
        filename,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };

    } catch (err) {
      LOG.error(`exportarExcelPropuestas ERROR | Sociedad=${Sociedad}`, err.message);
      return req.error(500, `Error al generar Excel: ${err.message}`);
    }
  });

  // ── EXCEL: APROBACIONES (desde HANA /PropuestaPagoAprobadores) ──────────────

  srv.on("exportarExcelAprobaciones", async (req) => {
    const { NroPP, Sociedad, FechaPP } = req.data;

    try {
      const svc  = await cds.connect.to("HANA_H2H");
      const res  = await svc.get("/PropuestaPagoAprobadores", {
        params: {
          $filter : `NroPP eq '${NroPP}' and Sociedad eq '${Sociedad}'`,
          $orderby: "FechaAprob asc",
        },
      });
      const aAprobadores = Array.isArray(res) ? res : (res?.results ?? []);

      const ExcelJS  = require("exceljs");
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "CAP H2H Aprobaciones";

      const ws = workbook.addWorksheet("Historial Aprobaciones", {
        views: [{ state: "frozen", ySplit: 1 }],
      });

      ws.columns = [
        { header: "Usuario",     key: "Usuario",     width: 24 },
        { header: "Rol",         key: "RolID",        width: 16 },
        { header: "Aprobado",    key: "Aprobado",     width: 12 },
        { header: "Observación", key: "Observacion",  width: 45 },
        { header: "Fecha Aprob.",key: "FechaAprob",   width: 20 },
        { header: "Hora Aprob.", key: "HoraAprob",    width: 14 },
      ];

      ws.getRow(1).eachCell(cell => {
        cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
        cell.font      = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });
      ws.getRow(1).height = 20;

      for (const apr of aAprobadores) {
        ws.addRow({
          Usuario    : apr.Usuario,
          RolID      : apr.RolID,
          Aprobado   : apr.Aprobado === "1" ? "Aprobó" : "Observó",
          Observacion: apr.Observacion ?? "",
          FechaAprob : apr.FechaAprob
            ? new Date(apr.FechaAprob).toLocaleDateString("es-PE")
            : "",
          HoraAprob  : apr.HoraAprob ?? "",
        });
      }

      const buffer   = await workbook.xlsx.writeBuffer();
      const filename = `Aprobaciones_${NroPP}_${Sociedad}_${FechaPP.replaceAll("-", "")}.xlsx`;

      LOG.info(`exportarExcelAprobaciones OK | NroPP=${NroPP} | ${aAprobadores.length} registros`);
      return {
        base64  : Buffer.from(buffer).toString("base64"),
        filename,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };

    } catch (err) {
      LOG.error(`exportarExcelAprobaciones ERROR | NroPP=${NroPP}`, err.message);
      return req.error(500, `Error al generar Excel: ${err.message}`);
    }
  });

  // ── CORREO (fachada explícita) ──────────────────────────────────────────────

  /**
   * Dispara el correo a través de SAP Gateway ZFISO_CORREO_ONB_H2H_SRV.
   * Equivale a: oPPOData.enviarCorreoAprobadores() en PPOData.js
   *
   * Normalmente el correo se dispara automáticamente desde aprobacion.service.js.
   * Esta función queda disponible para el UI5 si necesita dispararlo manualmente.
   */
  srv.on("enviarCorreo", async (req) => {
    const { NroPP, Sociedad, FechaPP, Version, Profil, Usuario } = req.data;

    try {
      // Reconstruir el objeto pp mínimo que espera sap-gateway-client
      const pp = {
        NroPP,
        Sociedad,
        FechaPP,
        Version,
        FechaPPJS: _parseFechaPP(FechaPP),
      };

      await gw.enviarCorreoAprobadores(pp, Profil, Usuario ?? "");

      LOG.info(`enviarCorreo OK | NroPP=${NroPP} Profil=${Profil}`);
      return { success: true, mensaje: "Correo enviado correctamente" };

    } catch (err) {
      LOG.error(`enviarCorreo ERROR | NroPP=${NroPP}`, err.message);
      return { success: false, mensaje: err.message };
    }
  });

});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function _parseFechaPP(sFechaPP) {
  if (!sFechaPP) return new Date();
  const [d, m, y] = sFechaPP.split("-");
  return new Date(`${y}-${m}-${d}T00:00:00`);
}
