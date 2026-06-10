"use strict";
/**
 * domain/constantes.service.js
 *
 * Constantes de negocio del flujo H2H Aprobaciones.
 *
 * SIN HANA CLOUD: los valores se mantienen directamente en este archivo
 * en un objeto en memoria. No hay llamada a base de datos ni a CPI.
 *
 * ¿Por qué en memoria y no en CPI?
 *   - Son valores de configuración que raramente cambian
 *   - No dependen de transacciones ni de datos de usuario
 *   - El equipo de desarrollo puede actualizar este archivo
 *     y hacer un redeploy cuando cambien (ej: nueva sociedad, nuevo tesorero)
 *
 * Cuando se cuente con HANA Cloud o se decida externalizarlos a un iFlow CPI,
 * basta con reemplazar CONSTANTES_ESTATICAS por una llamada al cliente
 * correspondiente, manteniendo la misma firma de getConstantes().
 *
 * Usadas en:
 *   Master   → onPressHome (documentUrl / documentUrlTasa)
 *   Detail   → sociedadesRevision, validarViaPago, sociedadesTermina
 *   domain/aprobacion.service → enrutamiento por sociedad y vía de pago
 */

const cds = require("@sap/cds");
const LOG = cds.log("constantes.service");

// ─── DATOS EN MEMORIA ─────────────────────────────────────────────────────────
//
// Equivale a los registros de /Constantes en HANA XSOData.
// Estructura original:
//   TipoParametro        Valor1              Valor2
//   ─────────────────────────────────────────────────
//   SociedadesRevision   código sociedad      -
//   ValidarViaPago       vía de pago (C,I..)  -
//   AprobarViaPago       vía de pago          -
//   SociedadesTermina    código sociedad      -
//   DocumentUrl          URL portal           -
//   Tesoreros            código sociedad      email tesorero
//
// ⚠ MANTENER ACTUALIZADO cuando cambien los parámetros de negocio.

const CONSTANTES_ESTATICAS = {

  // Sociedades que requieren paso de Revisor antes del Apoderado.
  // Si la sociedad NO está aquí → va directo a Apoderado.
  sociedadesRevision: [
    "0025",
    // Agregar más códigos de sociedad según corresponda
  ],

  // Vías de pago que NO permiten terminar flujo directamente desde Supervisor.
  // Verifica en supervisorTerminarFlujo().
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
  // Si la sociedad está aquí → bConformeTermina = true en apoderadoFirmar().
  sociedadesTermina: [
    // Completar con los códigos de sociedad reales
    // "XXXX",
  ],

  // Mapa de tesoreros por sociedad.
  // Usado para envío de correo (enviarCorreoAprobadores profil="TR").
  // Clave: código de sociedad SAP (4 chars). Valor: email del tesorero.
  tesoreros: {
    "0025": "tesorero@empresa.com.pe",
    // Agregar más entradas según corresponda
  },

  // URL del portal de documentos (onPressHome en Master.controller.js).
  // Aplica para usuarios con dominio genérico.
  documentUrl: "https://portal.empresa.com.pe/documentos",

  // URL del portal para usuarios con dominio @tasa.com.pe.
  documentUrlTasa: "https://portal.empresa.com.pe/documentos",
};

// ─── CACHE EN MEMORIA ─────────────────────────────────────────────────────────
// Se inicializa una sola vez al primer llamado; vive mientras el proceso CAP esté activo.

let _cache = null;

/**
 * Retorna las constantes de negocio.
 * Primera llamada → inicializa desde CONSTANTES_ESTATICAS.
 * Llamadas siguientes → retorna el objeto cacheado.
 *
 * Misma firma que tenía cuando leía de HANA:
 *   returns { rpta: { sociedadesRevision, validarViaPago, ... } }
 *
 * @returns {{ rpta: object }}
 */
async function getConstantes() {
  if (_cache) return _cache;

  // Copia profunda para evitar mutaciones accidentales en el objeto estático
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

/**
 * Invalida el cache en memoria.
 * Útil en tests o si se modifica CONSTANTES_ESTATICAS en caliente.
 */
function invalidarCache() {
  _cache = null;
  LOG.info("getConstantes: cache invalidado");
}

module.exports = { getConstantes, invalidarCache };