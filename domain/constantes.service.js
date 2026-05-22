"use strict";
/**
 * domain/constantes.service.js
 *
 * Lógica de dominio de constantes de negocio.
 * Las constantes vienen de HANA XSOData /Constantes y se usan en:
 *   - Master   : onPressHome (sDocumentUrl)
 *   - Detail   : aSociedadesRevision, aValidarViaPago, oTesoreros, aSociedadesTermina
 *   - Handlers : para enrutamiento de aprobación
 */

const hana = require("../infrastructure/hana-client");
const cds  = require("@sap/cds");
const LOG  = cds.log("constantes.service");

// Cache en memoria por proceso (TTL implícito: vida del proceso CAP)
let _cache = null;

/**
 * Obtiene y cachea las constantes de negocio.
 * Primera llamada → HANA XSOData. Siguientes → cache en memoria.
 * @returns {{ rpta: object }} objeto con todas las constantes
 */
async function getConstantes() {
  if (_cache) return _cache;
  _cache = await hana.getConstantes();
  LOG.info("getConstantes: cargadas y cacheadas");
  return _cache;
}

/**
 * Invalida el cache (útil si se sospecha que cambiaron las constantes).
 */
function invalidarCache() {
  _cache = null;
  LOG.info("getConstantes: cache invalidado");
}

module.exports = { getConstantes, invalidarCache };
