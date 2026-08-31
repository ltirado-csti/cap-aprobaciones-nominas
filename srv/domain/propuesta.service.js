"use strict";
/**
 * Lógica de dominio de la Propuesta de Pago. No contiene llamadas HTTP
 * directas; delega en los clientes de infraestructura.
 *
 * Cubre lectura y contingencia de creación de propuesta, actualización de
 * estado en HANA, y validación de documentos adjuntos y adelantos.
 */

const cds  = require("@sap/cds");
const LOG  = cds.log("propuesta.service");

// ─── LECTURA ──────────────────────────────────────────────────────────────────

/**
 * Obtiene la propuesta de pago desde HANA con sus expansiones.
 * Si no existe (404) la crea en HANA como contingencia desde el contexto BPA.
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

/** Construye la clave HANA de una propuesta. */
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
 * Sella el estado de la propuesta (estadoPP, ya definido por el handler de rol)
 * previo a BPA. El estado y sus flags viven en el contexto BPA; no hay
 * persistencia local.
 */
async function actualizarEstado(propuesta, usuario) {
  LOG.info(`actualizarEstado | numeroPropuesta=${propuesta.numeroPropuesta} | estadoPP=${propuesta.estadoPP} | usuario=${usuario?.name ?? usuario}`);
  return propuesta;
}

// ─── VALIDACIÓN ───────────────────────────────────────────────────────────────

/**
 * Verifica si hay adelanto y si existe el adjunto requerido.
 * @returns {string|null} null si está OK, o un mensaje de error si debe bloquearse.
 */
async function validarAdelanto(propuesta) {
  if (propuesta.indicadorPagoAdelanto !== "X") return null;

  // TODO: verificar el adjunto de sustento vía CPI (cpi.getAdjuntos) cuando el
  // iFlow exponga el tipo de documento.
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