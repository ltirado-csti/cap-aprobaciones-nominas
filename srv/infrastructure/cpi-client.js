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

module.exports = {
  registrarAprobacionSAP,
  registrarObservacionSAP,
  buildObsPayload,
  buildApoRegPayload,
};
