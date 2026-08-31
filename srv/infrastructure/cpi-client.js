"use strict";
/**
 * Acceso a SAP CPI (Integration Suite) vía el destino CPI_H2H.
 *
 * Endpoints usados:
 *   POST /apoReg  → ZfiWsH2hApoReg (SOAP) - registro de firma de apoderado
 *   POST /Obs     → ZfiWsH2hObs (SOAP) - registro de observación en SAP
 *   POST /http/H2H/ECP/HistorialAprobaciones → ZhrfH2hDetailAprobacionWf (SOAP),
 *        consumido por domain/historial.service.js
 */

const cds = require("@sap/cds");
const { conTimeoutCpi } = require("./con-timeout");
const hora = require("../config/zona-horaria");

const LOG = cds.log("cpi-client");

let _svc;
const getSvc = async () => (_svc ??= await cds.connect.to("CPI_H2H"));

/**
 * Invoca ZfiWsH2hApoReg (registro de firma de apoderado) vía iFlow CPI.
 * @returns {Promise<{ "n0:ZfiWsH2hApoRegResponse": { EpMensaje: string } }|null>}
 */
async function registrarAprobacionSAP(oApoReg) {
  const svc = await getSvc();
  try {
    const res = await conTimeoutCpi(svc.post("/apoReg", oApoReg), "registrarAprobacionSAP");
    LOG.info(`registrarAprobacionSAP OK`);
    return res;
  } catch (err) {
    LOG.error(`registrarAprobacionSAP ERROR`, err.message);
    return null;
  }
}

/**
 * Invoca ZfiWsH2hObs (registro de observación) vía iFlow CPI.
 * @returns {Promise<object|null>} respuesta del WS SAP, o null si falla
 */
async function registrarObservacionSAP(oObservacion) {
  const svc = await getSvc();
  try {
    const res = await conTimeoutCpi(svc.post("/Obs", oObservacion), "registrarObservacionSAP");
    LOG.info(`registrarObservacionSAP OK`);
    return res;
  } catch (err) {
    LOG.error(`registrarObservacionSAP ERROR`, err.message);
    return null;
  }
}

/**
 * Construye el payload ZfiWsH2hObs.
 * @param {object} pp            - propuestaPago (NroPP, Sociedad, FechaPPJS, Version)
 * @param {string} userSAP       - usuario SAP del observador
 * @param {string} sObservacion  - texto de la observación
 * @param {string} piEstado      - código de estado SAP: "OBTR"|"OBAP"|"OBRA"|"OBCA"
 */
function buildObsPayload(pp, userSAP, sObservacion, piEstado = "OBTR") {
  const now    = new Date();
  const fecha  = hora.fechaSap(now);   // "dd-MM-yyyy", UTC
  const tiempo = hora.horaSap(now);    // "HH:mm:ss", UTC

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
 * Construye el payload ZfiWsH2hApoReg.
 * @param {object} pp             - propuestaPago
 * @param {string} userSAP        - usuario SAP del apoderado
 * @param {number} iContadorFirma - número actual de firmas (0=primera, 1+=segunda)
 */
function buildApoRegPayload(pp, userSAP, iContadorFirma) {
  const now    = new Date();
  const fecha  = hora.fechaSap(now);   // "dd-MM-yyyy", UTC
  const tiempo = hora.horaSap(now);    // "HH:mm:ss", UTC

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

/** Obtiene los proveedores beneficiarios de la propuesta. */
async function getProveedores(propuesta) {
  const cpiSvc = await cds.connect.to("CPI_H2H");
  const respuesta = await conTimeoutCpi(cpiSvc.get("/proveedores", {
    NroPP   : propuesta.numeroPropuesta,
    FechaPP : propuesta.fechaPropuestaPago,
    Sociedad: propuesta.sociedad
  }), "getProveedores");
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

/** Obtiene los adjuntos de la propuesta desde HANA vía CPI. */
async function getAdjuntos(propuesta) {
  const cpiSvc = await cds.connect.to("CPI_H2H");
  const respuesta = await conTimeoutCpi(cpiSvc.get("/adjuntos", {
    NroPP   : propuesta.numeroPropuesta,
    FechaPP : propuesta.fechaPropuestaPago,
    Sociedad: propuesta.sociedad
  }), "getAdjuntos");
  return (Array.isArray(respuesta) ? respuesta : (respuesta?.adjuntos ?? []))
    .map(item => ({
      adjuntoId          : item.id                 ?? item.AdjuntoId          ?? cds.utils.uuid(),
      nombre             : item.nombre             ?? item.Nombre             ?? "",
      tipoAdjunto        : item.tipoAdjunto        ?? item.TipoAdjunto        ?? "",
      activo             : item.activo             ?? item.Activo             ?? true,
      docServiceObjectID : item.docServiceObjectID ?? item.DocServiceObjectID ?? ""
    }));
}

/** Ruta del iFlow que expone ZhrfH2hDetailAprobacionWf (ECP). */
const RUTA_HISTORIAL = "/http/H2H/ECP/HistorialAprobaciones";

/**
 * Obtiene el historial de aprobaciones (cadena de firmas) desde ECP vía CPI.
 * Devuelve las filas crudas de EtDetalle; la traducción a nodos del diagrama
 * la hace domain/historial.service.js.
 *
 * @param {object} propuesta - PropuestaNomina del contexto BPA
 * @returns {Promise<object[]>} filas de EtDetalle.item, sin normalizar
 */
async function getHistorialAprobaciones(propuesta) {
  const cpiSvc = await cds.connect.to("CPI_H2H");

  const respuesta = await conTimeoutCpi(cpiSvc.post(RUTA_HISTORIAL, {
    ZhrfH2hDetailAprobacionWf: {
      IpBukrs: propuesta.sociedad        ?? "",
      IpLaufi: propuesta.numeroPropuesta ?? "",
      IpLaufd: _aFechaEcp(propuesta.fechaPropuestaPago),
      // La subdivisión de personal solo aplica a AESA; para el resto va vacía.
      IpBtrtl: propuesta.subdivision     ?? "",
      IpBanco: propuesta.banco           ?? "",
      IpWaers: propuesta.moneda          ?? "",
    },
  }), "getHistorialAprobaciones");

  return _extraerDetalle(respuesta);
}

/**
 * Desenvuelve EtDetalle de la respuesta del iFlow: la clave de respuesta se
 * busca por sufijo (el prefijo de namespace lo genera CPI) y `item` se
 * normaliza a array cuando llega una sola fila.
 */
function _extraerDetalle(respuesta) {
  const cuerpo = _porSufijo(respuesta, "ZhrfH2hDetailAprobacionWfResponse");
  if (!cuerpo) {
    LOG.warn("getHistorialAprobaciones: respuesta sin ZhrfH2hDetailAprobacionWfResponse");
    return [];
  }

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

/** Normaliza la fecha de propuesta al formato que exige ECP: yyyy-MM-dd. */
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
