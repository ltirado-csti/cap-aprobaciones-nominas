"use strict";
/**
 * srv/infrastructure/con-timeout.js
 *
 * Pone un techo al tiempo que un handler espera por una llamada remota.
 *
 * POR QUÉ NO SE CONFIGURA EN package.json
 * ---------------------------------------
 * Parece que debería bastar con un `requestTimeout` junto al destino, pero no
 * existe: el runtime de servicios remotos de CAP sí sabe aplicar un timeout
 * —libx/_runtime/remote/utils/fetchClient.js lo convierte en un AbortSignal—
 * pero solo lo lee de `requestConfig.timeout`, y `extractRequestConfig` NUNCA
 * lo rellena a partir de las opciones del servicio. Una clave de configuración
 * ahí se ignoraría en silencio, que es peor que no ponerla. De ahí este envoltorio.
 *
 * QUÉ ACOTA EXACTAMENTE
 * ---------------------
 * Acota la ESPERA, no el socket. Al vencer, la promesa remota sigue viva en
 * segundo plano hasta que el otro extremo conteste o el sistema operativo corte
 * la conexión; lo que se corta es el bloqueo del handler. Para el problema real
 * —el usuario mirando un diálogo congelado mientras BPA o CPI no responden— eso
 * es justo lo que hace falta: el clic termina en un mensaje en vez de en el
 * "busy lock timed out after 30 seconds" de UI5, que solo era UI5 rindiéndose
 * antes que el backend.
 *
 * Los rechazos de la promesa original que lleguen DESPUÉS del vencimiento se
 * absorben aquí: sin eso serían unhandled rejections capaces de tumbar el proceso.
 */

const cds = require("@sap/cds");

const LOG = cds.log("con-timeout");

/**
 * Techos por defecto, en milisegundos.
 *
 * BPA son GET/PATCH REST contra el runtime de Workflow: si tardan más de unos
 * pocos segundos es que algo va mal, no que haya mucho trabajo que hacer.
 *
 * CPI va más alto porque detrás hay un iFlow que a su vez llama a ECP por SOAP
 * —el historial de aprobaciones es la llamada más lenta de la aplicación— y
 * cortarlo demasiado pronto convertiría una lentitud tolerable en un fallo.
 */
const TECHOS = {
  bpa: 15000,
  cpi: 20000,
};

/**
 * Error de vencimiento. Se marca con `status` 504 para que la capa de dominio
 * pueda distinguirlo de un fallo funcional del sistema remoto.
 */
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
 *
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
    // No debe mantener vivo el proceso solo por estar pendiente.
    temporizador.unref?.();
  });

  // Si la llamada remota falla DESPUÉS de que haya vencido el techo, su rechazo
  // ya no tiene quien lo escuche —la carrera la ganó el vencimiento— y sería una
  // unhandled rejection. Se absorbe aquí. Cuando el fallo llega antes de vencer
  // no se toca: ese error es el que debe propagar la carrera.
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
