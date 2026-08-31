"use strict";
/**
 * Constantes de negocio del flujo H2H Aprobaciones, mantenidas en memoria
 * (sin HANA Cloud ni llamada a CPI).
 *
 * Usadas en:
 *   Master   → onPressHome (documentUrl / documentUrlTasa)
 *   Detail   → sociedadesRevision, validarViaPago, sociedadesTermina
 *   domain/aprobacion.service → enrutamiento por sociedad y vía de pago
 */

const cds = require("@sap/cds");
const LOG = cds.log("constantes.service");

const CONSTANTES_ESTATICAS = {

  // Sociedades que requieren paso de Revisor antes del Apoderado.
  // Si la sociedad NO está aquí → va directo a Apoderado.
  sociedadesRevision: [
    "0025",
  ],

  // Vías de pago que NO permiten terminar flujo directamente desde Supervisor.
  validarViaPago: [
    "C",  // Cheque
    "I",  // Interbank
    "W",  // Caja
    "Z",  // Interbancario
  ],

  // Vías de pago que requieren adjunto de constancia de banco antes de aprobar.
  aprobarViaPago: [
    "I",
    "Z",
  ],

  // Sociedades que permiten terminar el flujo luego de una sola firma (F1).
  sociedadesTermina: [
  ],

  // Mapa de tesoreros por sociedad (código SAP → email), usado en el envío de correo.
  tesoreros: {
    "0025": "tesorero@empresa.com.pe",
  },

  // URL del portal de documentos (dominio genérico).
  documentUrl: "https://portal.empresa.com.pe/documentos",

  // URL del portal de documentos para usuarios @tasa.com.pe.
  documentUrlTasa: "https://portal.empresa.com.pe/documentos",
};

let _cache = null;

/**
 * Retorna las constantes de negocio, cacheadas en memoria tras la primera llamada.
 * @returns {{ rpta: object }}
 */
async function getConstantes() {
  if (_cache) return _cache;

  _cache = {
    rpta: {
      sociedadesRevision: [...CONSTANTES_ESTATICAS.sociedadesRevision],
      validarViaPago    : [...CONSTANTES_ESTATICAS.validarViaPago],
      aprobarViaPago    : [...CONSTANTES_ESTATICAS.aprobarViaPago],
      sociedadesTermina : [...CONSTANTES_ESTATICAS.sociedadesTermina],
      tesoreros         : { ...CONSTANTES_ESTATICAS.tesoreros },
      documentUrl       : CONSTANTES_ESTATICAS.documentUrl,
      documentUrlTasa   : CONSTANTES_ESTATICAS.documentUrlTasa,
    },
  };

  LOG.info("getConstantes: cargadas desde memoria estática");
  return _cache;
}

/** Invalida el cache en memoria. */
function invalidarCache() {
  _cache = null;
  LOG.info("getConstantes: cache invalidado");
}

module.exports = { getConstantes, invalidarCache };
