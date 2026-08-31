"use strict";
/**
 * Pone un techo al tiempo que un handler espera por una llamada remota.
 * Acota la espera del handler, no el socket: al vencer, la promesa original
 * puede seguir viva en segundo plano, pero deja de bloquear al llamador.
 */

const cds = require("@sap/cds");

const LOG = cds.log("con-timeout");

/** Techos por defecto, en milisegundos, por destino remoto. */
const TECHOS = {
  bpa: 15000,
  cpi: 20000,
};

/** Error de vencimiento. `status` 504 para que la capa de dominio lo distinga de un fallo funcional. */
class TimeoutRemoto extends Error {
  constructor(etiqueta, ms) {
    super(`La llamada remota "${etiqueta}" superó el límite de ${ms} ms`);
    this.name    = "TimeoutRemoto";
    this.status  = 504;
    this.timeout = true;
  }
}

/**
 * Ejecuta una promesa con un techo de tiempo.
 * @template T
 * @param {Promise<T>} promesa - llamada remota ya lanzada
 * @param {number} ms          - techo en milisegundos
 * @param {string} etiqueta    - nombre para el log y el mensaje de error
 * @returns {Promise<T>}
 */
function conTimeout(promesa, ms, etiqueta) {
  let temporizador;
  let vencido = false;

  const vencimiento = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => {
      vencido = true;
      LOG.warn(`vencido | ${etiqueta} | limite=${ms}ms`);
      rechazar(new TimeoutRemoto(etiqueta, ms));
    }, ms);
    temporizador.unref?.();
  });

  // Un rechazo que llega después de vencer ya no tiene quien lo escuche;
  // se absorbe para no dejar una unhandled rejection.
  promesa.catch(error => {
    if (vencido) LOG.warn(`fallo tras vencer (absorbido) | ${etiqueta} | ${error?.message ?? error}`);
  });

  return Promise.race([promesa, vencimiento]).finally(() => clearTimeout(temporizador));
}

/** Techo para llamadas a BPA Workflow. */
const conTimeoutBpa = (promesa, etiqueta) => conTimeout(promesa, TECHOS.bpa, etiqueta);

/** Techo para llamadas a Cloud Integration. */
const conTimeoutCpi = (promesa, etiqueta) => conTimeout(promesa, TECHOS.cpi, etiqueta);

module.exports = { conTimeout, conTimeoutBpa, conTimeoutCpi, TimeoutRemoto, TECHOS };
