"use strict";
/**
 * domain/propuesta.service.js
 *
 * Lógica de dominio de la Propuesta de Pago.
 * No contiene llamadas HTTP directas; delega en los clientes de infraestructura.
 *
 * Cubre:
 *   - Lectura y contingencia de creación de propuesta
 *   - Actualización de estado en HANA
 *   - Validación de documentos adjuntos y adelantos
 *   - Construcción de la clave HANA (createKey)
 *
 * Clasificación por lógica de negocio:
 *   LECTURA      → getPropuestaPago, getPPAdjuntos, getInfoPropuestaSAP, getPDFSAP
 *   ESCRITURA    → updatePropuestaPago, createPropuestaPago (contingencia)
 *   VALIDACIÓN   → checkAdelanto, evaluarDocumentoAdjunto
 */

const hana = require("../infrastructure/hana-client");
const gw   = require("../infrastructure/sap-gateway-client");
const cds  = require("@sap/cds");
const LOG  = cds.log("propuesta.service");

// ─── LECTURA ──────────────────────────────────────────────────────────────────

/**
 * Obtiene la propuesta de pago desde HANA con sus expansiones.
 * Si no existe (404) la crea en HANA como contingencia desde el contexto BPA.
 *
 * Equivale al bloque principal de _onBindingChange() en Detail.controller.js:
 *   oPropuestaPago = await this.oPPOData.getPropuestaPago(...)
 *     .catch(async err => { if (err.statusCode === "404") → ejecutarCreate })
 *
 * @param {object} contexto - objeto contexto.json leído desde BPA
 * @param {string} taskId   - InstanceID del BPA (para IdInstanciaWF)
 * @returns {object} propuestaPago con expansiones
 */
async function obtenerOCrearPropuesta(contexto, taskId) {
  try {
    const pp = await hana.getPropuestaPago(contexto.NroPP, contexto.Sociedad, contexto.FechaPP);
    if (pp) return pp;
  } catch (err) {
    if (err.statusCode !== "404" && String(err.code) !== "404") throw err;
  }

  // Contingencia: crear desde contexto BPA
  LOG.warn(`Propuesta no encontrada en HANA. Creando contingencia | NroPP=${contexto.NroPP}`);
  const oPropuestaSCP = {
    NroPP          : contexto.NroPP,
    Sociedad       : contexto.Sociedad,
    FechaPP        : contexto.FechaPP,
    Importe        : contexto.Importe,
    Moneda         : contexto.Moneda,
    UsrCreacionPP  : contexto.UsrCreacionPP,
    ModalidadPP    : contexto.ModalidadPP,
    ExisteDoc      : contexto.ExisteDoc,
    ViaPago        : contexto.ViaPago,
    BancoDescripcion: contexto.BancoDescripcion,
    Banco          : contexto.Banco,
    Version        : contexto.Version,
    IdInstanciaWF  : taskId,
    UserCrea       : contexto.UserCrea,
    EstadoPP       : "PENDIENTE",
    Analista       : contexto.Analista,
    CorreoAnalista : contexto.CorreoAnalista,
    IndPAdelanto   : contexto.IndPAdelanto,
  };
  const creada = await hana.createPropuestaPago(oPropuestaSCP);
  return creada ?? oPropuestaSCP;
}

/**
 * Construye la clave HANA de una propuesta.
 * Equivale a: oHanaModel.createKey("/PropuestaPago", { NroPP, Sociedad, FechaPP })
 */
function buildHanaPath(pp) {
  return `/PropuestaPago(NroPP='${pp.NroPP}',Sociedad='${pp.Sociedad}',FechaPP='${pp.FechaPP}')`;
}

async function getPPAdjuntos(pp) {
  return hana.getPPAdjuntos(pp.NroPP, pp.Sociedad, pp.FechaPP);
}

async function getInfoPropuestaSAP(pp) {
  return gw.getInfoPropuestaSAP(pp);
}

async function getPDFSAP(pp) {
  return gw.getPropuestaPDFSAP(pp);
}

// ─── ESCRITURA ────────────────────────────────────────────────────────────────

/**
 * Actualiza EstadoPP + auditoría en HANA XSOData.
 * DEBE llamarse ANTES de completarTareaWF en todo handler de aprobación.
 */
async function actualizarEstado(pp, currentUser) {
  pp.FechaModif = new Date();
  pp.UserModif  = currentUser.name ?? currentUser;
  const ok = await hana.updatePropuestaPago(pp);
  if (!ok) throw new Error(`No se pudo actualizar PropuestaPago NroPP=${pp.NroPP}`);
  return pp;
}

// ─── VALIDACIÓN ───────────────────────────────────────────────────────────────

/**
 * Verifica si hay adelanto y si existe el adjunto requerido.
 * Retorna null si todo está OK, o un mensaje de error si debe bloquearse.
 *
 * Equivale a la lógica de AnalistaTesorería antes de enviarSupervisorOCaja.
 */
async function validarAdelanto(pp) {
  const oCheck = await gw.checkAdelanto(pp);
  if (oCheck?.IndAdelanto !== "X") return null; // sin adelanto, OK

  const iAdjuntos = await hana.evaluarDocumentoAdjunto(pp, "ADELANTO");
  if (!iAdjuntos || isNaN(iAdjuntos) || iAdjuntos === 0) {
    return "Debe adjuntar el sustento de adelanto antes de continuar";
  }
  return null;
}

/**
 * Verifica adjunto de un tipo específico.
 * Retorna null si existe, o mensaje de error si falta.
 * tipo: "CARGA_BANK" | "PAGO_TRANS"
 */
async function validarAdjunto(pp, tipo) {
  const iAdjuntos = await hana.evaluarDocumentoAdjunto(pp, tipo);
  if (!iAdjuntos || isNaN(iAdjuntos) || iAdjuntos === 0) {
    return `Debe adjuntar el documento de tipo ${tipo}`;
  }
  return null;
}

module.exports = {
  obtenerOCrearPropuesta,
  buildHanaPath,
  getPPAdjuntos,
  getInfoPropuestaSAP,
  getPDFSAP,
  actualizarEstado,
  validarAdelanto,
  validarAdjunto,
};
