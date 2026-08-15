"use strict";
/**
 * infrastructure/cpi-client.js
 *
 * Acceso a SAP CPI (Integration Suite)  →  CPI_H2H_DEST
 * Equivale a: oScpPiService.ejecutarLlamada() en ScpPi.js
 *
 * SOLO 2 endpoints verificados en código fuente UI5 como reales de CPI:
 *
 *  1. POST /http/h2h/apoReg
 *     → ZfiWsH2hApoReg (SOAP)   — Registro de firma apoderado F1/F2
 *     Usado por: Apoderado  (oScpPiService.ejecutarLlamada("/http/h2h/apoReg", oApoReg))
 *
 *  2. POST /http/h2h/Obs
 *     → ZfiWsH2hObs (SOAP)      — Registro de observación en SAP
 *     Usado por: Supervisor observarSuper(), Revisor, Apoderado, Caja
 *
 *  3. POST /http/H2H/ECP/HistorialAprobaciones
 *     → ZhrfH2hDetailAprobacionWf (SOAP) — Cadena de firmas de la propuesta
 *     Usado por: domain/historial.service.js (ProcessFlow del Object Page)
 *
 * OJO con las rutas de 1 y 2: el destino Cloud_Integration apunta a la raíz del
 * iflmap, así que la ruta del iFlow va COMPLETA en el post() — como en 3. Las de
 * apoReg/Obs se escribieron sin el prefijo /http/h2h y están pendientes de
 * verificación contra el iFlow desplegado.
 *
 * Estos endpoints ejecutaban via ScpPiService → ahora van via CAP → CPI_H2H_DEST.
 *
 * DESCARTADO en nueva arquitectura BTP:
 *   POST /http/h2h/workflow/completartarea
 *   → Reemplazado completamente por bpa-client.js (BPA Workflow REST API)
 *   → El iFlow CPI que orquestaba el workflow ya no es necesario.
 *
 * PENDIENTE de decisión arquitectónica:
 *   POST /http/gcp/object_gcp_h2h     → GCP Storage (¿destino directo desde CAP?)
 *   POST /http/h2h/PortalProv/ObtenerDocs → Portal proveedores (¿alcance del proyecto?)
 */

const cds = require("@sap/cds");
const LOG = cds.log("cpi-client");

let _svc;
const getSvc = async () => (_svc ??= await cds.connect.to("CPI_H2H"));

// ─── REGISTRO DE FIRMA APODERADO ──────────────────────────────────────────────

/**
 * Invoca ZfiWsH2hApoReg en SAP vía iFlow CPI.
 * oScpPiService.ejecutarLlamada("/http/h2h/apoReg", oApoReg)
 *
 * Payload verificado en Apoderado.js:
 * {
 *   Body: {
 *     ZfiWsH2hApoReg: {
 *       PiBukrs  : "0025",         ← Sociedad SAP
 *       PiErdat  : "dd-MM-yyyy",   ← Fecha registro
 *       PiEstado : "F1" | "F2",    ← Primera o segunda firma
 *       PiLaufd  : Date,           ← Fecha propuesta (FechaPPJS)
 *       PiLaufi  : "R4603",        ← NroPP
 *       PiUsuario: "USRSAP01",     ← Usuario SAP del apoderado (de ApoderadosSet.UsuarioSAP)
 *       PiUzeit  : "HH:mm:ss",     ← Hora registro
 *       PiVerif  : "X",
 *       PiVersn  : "0001",         ← Version
 *       TApoderados: {}
 *     }
 *   }
 * }
 *
 * Respuesta CPI/SAP:
 * { "n0:ZfiWsH2hApoRegResponse": { EpMensaje: "OK..." } }
 *
 * @returns {{ "n0:ZfiWsH2hApoRegResponse": { EpMensaje: string } }|null}
 */
async function registrarAprobacionSAP(oApoReg) {
  const svc = await getSvc();
  try {
    const res = await svc.post("/apoReg", oApoReg);
    LOG.info(`registrarAprobacionSAP OK`);
    return res;
  } catch (err) {
    LOG.error(`registrarAprobacionSAP ERROR`, err.message);
    return null;
  }
}

// ─── REGISTRO DE OBSERVACIÓN ──────────────────────────────────────────────────

/**
 * Invoca ZfiWsH2hObs en SAP vía iFlow CPI.
 * oScpPiService.ejecutarLlamada("/http/h2h/Obs", oObservacion)
 *
 * Payload verificado en Supervisor.js → observarSuper():
 * {
 *   Body: {
 *     ZfiWsH2hObs: {
 *       PiBukrs  : "0025",
 *       PiErdat  : "dd-MM-yyyy",
 *       PiEstado : "OBTR",          ← Código de estado de observación SAP
 *       PiLaufd  : Date,
 *       PiLaufi  : "R4603",
 *       PiSgtxt  : {
 *         Feld1  : sObservacion,    ← Texto de la observación
 *         Feld2  : "",
 *         Feld3  : "",
 *         Feld4  : ""
 *       },
 *       PiUsuario: "USRSAP01",      ← UsuarioSAP del observador
 *       PiUzeit  : "HH:mm:ss",
 *       PiVersn  : "0001"
 *     }
 *   }
 * }
 *
 * Retorna la respuesta del WS SAP o null si falla.
 */
async function registrarObservacionSAP(oObservacion) {
  const svc = await getSvc();
  try {
    const res = await svc.post("/Obs", oObservacion);
    LOG.info(`registrarObservacionSAP OK`);
    return res;
  } catch (err) {
    LOG.error(`registrarObservacionSAP ERROR`, err.message);
    return null;
  }
}

/**
 * Helper: construye el payload ZfiWsH2hObs.
 * Centraliza la construcción para todos los handlers que observan.
 *
 * @param {object} pp            - propuestaPago (NroPP, Sociedad, FechaPPJS, Version)
 * @param {string} userSAP       - usuario SAP del observador (de ApoderadosSet)
 * @param {string} sObservacion  - texto de la observación
 * @param {string} piEstado      - código de estado SAP: "OBTR"|"OBAP"|"OBRA"|"OBCA"
 * @param {object} formatter     - referencia al formatter del controller (para fechas)
 */
function buildObsPayload(pp, userSAP, sObservacion, piEstado = "OBTR") {
  const now   = new Date();
  const fecha = [
    String(now.getDate()).padStart(2, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    now.getFullYear(),
  ].join("-"); // "dd-MM-yyyy"
  const tiempo = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;

  return {
    Body: {
      ZfiWsH2hObs: {
        PiBukrs  : pp.Sociedad,
        PiErdat  : fecha,
        PiEstado : piEstado,
        PiLaufd  : pp.FechaPPJS ?? pp.FechaPP,
        PiLaufi  : pp.NroPP,
        PiSgtxt  : { Feld1: sObservacion, Feld2: "", Feld3: "", Feld4: "" },
        PiUsuario: userSAP,
        PiUzeit  : tiempo,
        PiVersn  : pp.Version,
      },
    },
  };
}

/**
 * Helper: construye el payload ZfiWsH2hApoReg.
 * Centraliza la construcción para el handler Apoderado.
 *
 * @param {object} pp            - propuestaPago
 * @param {string} userSAP       - usuario SAP del apoderado (de ApoderadosSet.UsuarioSAP)
 * @param {number} iContadorFirma - número actual de firmas (0=primera, 1+=segunda)
 */
function buildApoRegPayload(pp, userSAP, iContadorFirma) {
  const now   = new Date();
  const fecha = [
    String(now.getDate()).padStart(2, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    now.getFullYear(),
  ].join("-");
  const tiempo = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;

  return {
    Body: {
      ZfiWsH2hApoReg: {
        PiBukrs     : pp.Sociedad,
        PiErdat     : fecha,
        PiEstado    : iContadorFirma >= 1 ? "F2" : "F1",
        PiLaufd     : pp.FechaPPJS ?? pp.FechaPP,
        PiLaufi     : pp.NroPP,
        PiUsuario   : userSAP,
        PiUzeit     : tiempo,
        PiVerif     : "X",
        PiVersn     : pp.Version,
        TApoderados : {},
      },
    },
  };
}

/**
 * Obtiene los proveedores beneficiarios de la propuesta.
 * Origen legado: Detail.controller.js → getProveedoresInfo()
 */
async function getProveedores(propuesta) {
  const cpiSvc = await cds.connect.to("CPI_H2H");
  const respuesta = await cpiSvc.get("/proveedores", {
    NroPP   : propuesta.numeroPropuesta,
    FechaPP : propuesta.fechaPropuestaPago,
    Sociedad: propuesta.sociedad
  });
  return (Array.isArray(respuesta) ? respuesta : (respuesta?.proveedores ?? []))
    .map((item, idx) => ({
      proveedorId: String(idx + 1).padStart(3, "0"),
      ruc        : item.RUC      ?? item.ruc      ?? "",
      nombre     : item.Nombre   ?? item.nombre   ?? "",
      glosa      : item.Glosa    ?? item.glosa    ?? "",
      monto      : parseFloat(item.Monto ?? item.monto ?? "0"),
      facturas   : item.Facturas ?? item.facturas ?? ""
    }));
}

/**
 * Obtiene los adjuntos de la propuesta desde HANA vía CPI.
 * Origen legado: Detail.controller.js → getPPAdjuntos()
 */
async function getAdjuntos(propuesta) {
  const cpiSvc = await cds.connect.to("CPI_H2H");
  const respuesta = await cpiSvc.get("/adjuntos", {
    NroPP   : propuesta.numeroPropuesta,
    FechaPP : propuesta.fechaPropuestaPago,
    Sociedad: propuesta.sociedad
  });
  return (Array.isArray(respuesta) ? respuesta : (respuesta?.adjuntos ?? []))
    .map(item => ({
      adjuntoId          : item.id                 ?? item.AdjuntoId          ?? cds.utils.uuid(),
      nombre             : item.nombre             ?? item.Nombre             ?? "",
      tipoAdjunto        : item.tipoAdjunto        ?? item.TipoAdjunto        ?? "",
      activo             : item.activo             ?? item.Activo             ?? true,
      docServiceObjectID : item.docServiceObjectID ?? item.DocServiceObjectID ?? ""
    }));
}

// ─── HISTORIAL DE APROBACIONES ────────────────────────────────────────────────

/**
 * Ruta del iFlow que expone ZhrfH2hDetailAprobacionWf (ECP).
 * Va completa porque el destino Cloud_Integration apunta a la RAÍZ del iflmap
 * (https://e400129-iflmap.hcisbt.br1.hana.ondemand.com), no a un prefijo.
 */
const RUTA_HISTORIAL = "/http/H2H/ECP/HistorialAprobaciones";

/**
 * Obtiene el historial de aprobaciones (cadena de firmas) desde ECP vía CPI.
 *
 * Es un POST con envoltorio SOAP-a-JSON, no un GET con query params: el iFlow
 * expone el RFC ZhrfH2hDetailAprobacionWf tal cual.
 *
 * Petición:
 * {
 *   "ZhrfH2hDetailAprobacionWf": {
 *     "IpBukrs": "0031",        ← sociedad
 *     "IpLaufi": "23303P",      ← número de propuesta
 *     "IpLaufd": "2026-08-07",  ← fecha de propuesta, yyyy-MM-dd SIEMPRE
 *     "IpBtrtl": "3107",        ← subdivisión de personal (solo AESA; ver abajo)
 *     "IpBanco": "BBVA",        ← código corto del banco, no la descripción
 *     "IpWaers": "PEN"          ← moneda
 *   }
 * }
 *
 * Respuesta:
 * {
 *   "n0:ZhrfH2hDetailAprobacionWfResponse": {
 *     "EpMensaje": "",                  ← texto de negocio; vacío = todo bien
 *     "EtDetalle": { "item": [ {
 *        Zbukr, Laufi, Laufd, Werks, Btrtl, Hbkid, Waers,  ← eco de la clave
 *        Perfil   : "1",                ← SLOT DE FIRMA: 1|2 apoderado, 3 liberador
 *        Aprobador: "ARODAS",           ← usuario SAP, NO correo
 *        Status   : "AP",               ← AP|OB|RE|AN (ver STATUS_ECP en el dominio)
 *        Erdat    : "2026-08-07",       ← fecha y hora van SEPARADAS
 *        Uzeit    : "23:40:00"
 *     }, … ] }
 *   }
 * }
 *
 * Devuelve las filas CRUDAS de EtDetalle: la traducción a nodos del diagrama la
 * hace domain/historial.service.js. Aquí solo se transporta y se desenvuelve.
 *
 * @param {object} propuesta - PropuestaNomina del contexto BPA
 * @returns {Promise<object[]>} filas de EtDetalle.item, SIN normalizar
 */
async function getHistorialAprobaciones(propuesta) {
  const cpiSvc = await cds.connect.to("CPI_H2H");

  const respuesta = await cpiSvc.post(RUTA_HISTORIAL, {
    ZhrfH2hDetailAprobacionWf: {
      IpBukrs: propuesta.sociedad        ?? "",
      IpLaufi: propuesta.numeroPropuesta ?? "",
      IpLaufd: _aFechaEcp(propuesta.fechaPropuestaPago),
      // Regla de negocio: la subdivisión de personal solo aplica a AESA. Para el
      // resto de sociedades la propuesta no la trae y va vacía — es lo que ECP
      // espera, no una omisión. No se filtra por sociedad aquí: la que decide si
      // hay subdivisión es Payroll al armar la propuesta.
      IpBtrtl: propuesta.subdivision     ?? "",
      IpBanco: propuesta.banco           ?? "",
      IpWaers: propuesta.moneda          ?? "",
    },
  });

  return _extraerDetalle(respuesta);
}

/**
 * Desenvuelve EtDetalle de la respuesta del iFlow.
 *
 * Dos trampas del conversor SOAP→JSON de CPI, las dos reales:
 *   · el prefijo de namespace ("n0:") lo genera CPI y puede cambiar entre
 *     despliegues, así que la clave se busca por SUFIJO y no literalmente.
 *   · con UNA sola fila, `item` llega como objeto suelto y no como array.
 */
function _extraerDetalle(respuesta) {
  const cuerpo = _porSufijo(respuesta, "ZhrfH2hDetailAprobacionWfResponse");
  if (!cuerpo) {
    LOG.warn("getHistorialAprobaciones: respuesta sin ZhrfH2hDetailAprobacionWfResponse");
    return [];
  }

  // EpMensaje transporta el texto de negocio de ECP. No se convierte en error:
  // el historial es informativo y una propuesta sin firmas todavía es un caso
  // válido. Se registra para poder diagnosticar un diagrama vacío.
  const mensaje = String(cuerpo.EpMensaje ?? "").trim();
  if (mensaje) LOG.warn(`getHistorialAprobaciones EpMensaje: ${mensaje}`);

  const item = cuerpo.EtDetalle?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

/** Devuelve el valor de la primera clave cuyo nombre, sin namespace, sea `sufijo`. */
function _porSufijo(objeto, sufijo) {
  if (!objeto || typeof objeto !== "object") return null;
  const clave = Object.keys(objeto).find(k => k.split(":").pop() === sufijo);
  return clave ? objeto[clave] : null;
}

/**
 * Normaliza la fecha de propuesta al formato que exige ECP: yyyy-MM-dd.
 * El contexto BPA la entrega ya en ISO, pero los mocks y algunos flujos legados
 * usan dd-MM-yyyy; enviar ese formato devuelve un EtDetalle vacío sin error.
 */
function _aFechaEcp(valor) {
  const texto = String(valor ?? "").trim();
  const ddmmaaaa = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(texto);
  return ddmmaaaa ? `${ddmmaaaa[3]}-${ddmmaaaa[2]}-${ddmmaaaa[1]}` : texto;
}

module.exports = {
  registrarAprobacionSAP,
  registrarObservacionSAP,
  buildObsPayload,
  buildApoRegPayload,
  getProveedores,
  getAdjuntos,
  getHistorialAprobaciones
};
