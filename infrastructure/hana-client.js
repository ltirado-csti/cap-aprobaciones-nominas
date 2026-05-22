"use strict";
/**
 * infrastructure/hana-client.js
 *
 * Acceso a HANA XSOData  →  /HanaCFH2H/v2/h2-h/
 * Destino BTP             →  HANA_H2H_DEST
 * Modelo UI5 original     →  HanaModel  (oHanaModel en PPOData.js)
 *
 * Entidades consumidas (verificadas en PPOData.js):
 *   /Constantes                   → getConstantes()
 *   /PropuestaPago                → getPropuestaPago(), createPropuestaPago(), updatePropuestaPago()
 *   /PropuestaPagoAdjuntos        → getPPAdjuntos(), evaluarDocumentoAdjunto()
 *   /PropuestaPagoAprobadores     → guardarConfirmacion()
 *   /TipoAdjunto                  → (referencia en fragment Adjuntos.xml, lectura directa UI5)
 */

const cds = require("@sap/cds");
const LOG = cds.log("hana-client");

let _svc;
const getSvc = async () => (_svc ??= await cds.connect.to("HANA_H2H"));

// ─── helpers ──────────────────────────────────────────────────────────────────
const toArray = (res) => (Array.isArray(res) ? res : (res?.results ?? []));

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

/**
 * Lee /Constantes y devuelve el objeto que Master/Detail esperan
 * en this.oConstantes.rpta
 *
 * TipoParametro            Valor1              Valor2
 * ─────────────────────────────────────────────────────
 * SociedadesRevision       código sociedad      -
 * ValidarViaPago           vía de pago (C,I..)  -
 * AprobarViaPago           vía de pago          -
 * SociedadesTermina        código sociedad      -
 * DocumentUrl              URL portal           -
 * Tesoreros                código sociedad      email
 */
async function getConstantes() {
  const svc  = await getSvc();
  const rows = toArray(await svc.get("/Constantes"));

  const rpta = {
    aSociedadesRevision: [],
    aValidarViaPago    : [],
    aAprobarViaPago    : [],
    aSociedadesTermina : [],
    oTesoreros         : {},
    sDocumentUrl       : "",
    sDocumentUrlTasa   : "",
  };

  for (const r of rows) {
    switch (r.TipoParametro) {
      case "SociedadesRevision": rpta.aSociedadesRevision.push(r.Valor1); break;
      case "ValidarViaPago"    : rpta.aValidarViaPago.push(r.Valor1);     break;
      case "AprobarViaPago"    : rpta.aAprobarViaPago.push(r.Valor1);     break;
      case "SociedadesTermina" : rpta.aSociedadesTermina.push(r.Valor1);  break;
      case "DocumentUrl"       : rpta.sDocumentUrl = rpta.sDocumentUrlTasa = r.Valor1; break;
      case "Tesoreros"         : rpta.oTesoreros[r.Valor1] = r.Valor2;    break;
    }
  }
  LOG.info(`getConstantes OK | ${rows.length} registros`);
  return { rpta };
}

// ─── PROPUESTA DE PAGO ────────────────────────────────────────────────────────

/**
 * PPOData.getPropuestaPago(NroPP, Sociedad, FechaPP)
 * GET /PropuestaPago?$filter=...&$expand=Estado,Aprobadores/Estado,Aprobadores/Rol,Adjuntos/TipoDocInfo
 */
async function getPropuestaPago(NroPP, Sociedad, FechaPP) {
  const svc = await getSvc();
  const res = await svc.get("/PropuestaPago", {
    params: {
      $filter : `NroPP eq '${NroPP}' and Sociedad eq '${Sociedad}' and FechaPP eq datetime'${FechaPP}'`,
      $expand : "Estado,Aprobadores/Estado,Aprobadores/Rol,Adjuntos/TipoDocInfo",
    },
  });
  LOG.info(`getPropuestaPago OK | NroPP=${NroPP}`);
  return toArray(res)[0] ?? null;
}

/**
 * Contingencia: si la propuesta no existe en HANA se crea desde el contexto BPA.
 * PPOData.ejecutarCreate("/PropuestaPago", oPropuestaSCP)
 */
async function createPropuestaPago(oPropuestaSCP) {
  const svc = await getSvc();
  const res = await svc.post("/PropuestaPago", oPropuestaSCP);
  LOG.info(`createPropuestaPago OK | NroPP=${oPropuestaSCP.NroPP}`);
  return res;
}

/**
 * Actualiza EstadoPP, FechaModif, UserModif (y datos de compensación si aplica).
 * PPOData.updatePropuestaPago(oPropuestaPago) → oHanaModel.update("/PropuestaPago(...)")
 *
 * LLAMAR SIEMPRE antes de completarTareaWF (era el bug #8 del análisis anterior).
 */
async function updatePropuestaPago(pp) {
  const svc = await getSvc();
  await svc.patch("/PropuestaPago", {
    NroPP             : pp.NroPP,
    Sociedad          : pp.Sociedad,
    FechaPP           : pp.FechaPP,
    EstadoPP          : pp.EstadoPP,
    FechaModif        : pp.FechaModif ?? new Date(),
    UserModif         : pp.UserModif  ?? "",
    NroDocCompensacion: pp.NroDocCompensacion ?? "",
    FechaCompensacion : pp.FechaCompensacion  ?? "",
  });
  LOG.info(`updatePropuestaPago OK | NroPP=${pp.NroPP} EstadoPP=${pp.EstadoPP}`);
  return true;
}

// ─── ADJUNTOS ─────────────────────────────────────────────────────────────────

/**
 * PPOData.getPPAdjuntos(NroPP, Sociedad, FechaPP)
 * GET /PropuestaPagoAdjuntos?$filter=...Activo eq '1'&$expand=TipoDocInfo&$orderby=TipoDocInfo/Orden
 */
async function getPPAdjuntos(NroPP, Sociedad, FechaPP) {
  const svc = await getSvc();
  const res = await svc.get("/PropuestaPagoAdjuntos", {
    params: {
      $filter : `NroPP eq '${NroPP}' and Sociedad eq '${Sociedad}' and FechaPP eq datetime'${FechaPP}' and Activo eq '1'`,
      $expand : "TipoDocInfo",
      $orderby: "TipoDocInfo/Orden",
    },
  });
  const rows = toArray(res);
  LOG.info(`getPPAdjuntos OK | NroPP=${NroPP} | ${rows.length} adjuntos`);
  return rows;
}

/**
 * Cuenta adjuntos activos de un tipo específico.
 * PPOData.evaluarDocumentoAdjunto(pp, tipo) → oHanaModel.read("/PropuestaPagoAdjuntos/$count")
 * tipo: "ADELANTO" | "CARGA_BANK" | "PAGO_TRANS"
 */
async function evaluarDocumentoAdjunto(pp, tipo) {
  const svc   = await getSvc();
  const count = await svc.get("/PropuestaPagoAdjuntos/$count", {
    params: {
      $filter: `NroPP eq '${pp.NroPP}' and Sociedad eq '${pp.Sociedad}' and TipoAdjunto eq '${tipo}' and Activo eq '1'`,
    },
  });
  LOG.info(`evaluarDocumentoAdjunto OK | tipo=${tipo} count=${count}`);
  return Number(count);
}

// ─── APROBACIONES ─────────────────────────────────────────────────────────────

/**
 * Guarda registro en /PropuestaPagoAprobadores.
 * PPOData.guardarConfirmacion(pp, user, rol, aprobado, comentario)
 *
 * LLAMAR siempre ANTES de completarTareaWF.
 */
async function guardarConfirmacion(pp, user, rol, aprobado, comentario) {
  const svc = await getSvc();
  const now = new Date();
  await svc.post("/PropuestaPagoAprobadores", {
    NroPP      : pp.NroPP,
    Sociedad   : pp.Sociedad,
    FechaPP    : pp.FechaPP,
    Usuario    : user,
    RolID      : rol,
    Aprobado   : aprobado,
    Observacion: comentario ?? "",
    FechaAprob : now,
    HoraAprob  : `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`,
  });
  LOG.info(`guardarConfirmacion OK | NroPP=${pp.NroPP} rol=${rol} aprobado=${aprobado}`);
  return true;
}

module.exports = {
  getConstantes,
  getPropuestaPago,
  createPropuestaPago,
  updatePropuestaPago,
  getPPAdjuntos,
  evaluarDocumentoAdjunto,
  guardarConfirmacion,
};
