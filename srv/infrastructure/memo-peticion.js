"use strict";
/**
 * srv/infrastructure/memo-peticion.js
 *
 * Memoiza trabajo asíncrono durante lo que dura UNA petición HTTP.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * Fiori Elements no pide el Object Page en una sola petición: pide la entidad y
 * luego, por separado, cada tabla de sección (proveedores, adjuntos,
 * aprobadores, niveles). Cada uno de esos handlers reconstruía el detalle
 * completo por su cuenta, así que abrir un Object Page ejecutaba CINCO veces el
 * mismo trabajo — 10 llamadas a BPA y 15 a CPI, de las cuales 8 y 12 eran
 * literalmente el mismo dato pedido otra vez.
 *
 * Y ese desperdicio no se solapa: CAP procesa las entradas de un $batch en serie
 * (odata.max_batch_parallelization), así que se SUMA. Con el SOAP del historial
 * de ECP costando segundos, era lo que empujaba un clic por encima de los 30 s
 * del busy lock de UI5.
 *
 * ALCANCE Y FRESCURA
 * ------------------
 * El mapa vive colgado de `cds.context`, el contexto de la petición. Se memoiza
 * la PROMESA y no el resultado, para que dos llamadas concurrentes compartan el
 * mismo vuelo en lugar de lanzar dos.
 *
 * Esto NO es una caché con TTL, y esa es la propiedad importante: nada sobrevive
 * a la petición, así que después de completar una tarea el siguiente refresco
 * vuelve a preguntarle a BPA. En un flujo de aprobación de nómina servir un
 * estado obsoleto sería mucho peor que la latencia que se ahorra.
 *
 * Sin `cds.context` (llamada fuera de una petición, p. ej. un test) no memoiza y
 * se comporta igual que si no existiera.
 *
 * NOTA SOBRE $batch: dentro de un $batch de OData v4 todas las entradas
 * comparten el contexto de la petición, que es lo que hace que el memo cubra las
 * cinco lecturas del Object Page. Si una versión futura de CAP diera un contexto
 * por entrada, esto degrada a "no memoiza" — más lento, nunca incorrecto.
 */

const cds = require("@sap/cds");

const LOG = cds.log("memo-peticion");

/**
 * Clave del mapa colgado del contexto. Símbolo, y no string, para no chocar con
 * nada que CAP guarde en ese mismo objeto.
 */
const MEMO = Symbol.for("h2h.memo-peticion");

/**
 * Ejecuta `cargar` como mucho una vez por petición y clave.
 *
 * @template T
 * @param {string} clave - identifica la llamada (función + argumentos)
 * @param {() => Promise<T>} cargar - trabajo real, solo si no está memoizado
 * @returns {Promise<T>}
 */
function memoPorPeticion(clave, cargar) {
  const ctx = cds.context;
  if (!ctx) return cargar();

  const memo = (ctx[MEMO] ??= new Map());
  if (memo.has(clave)) {
    LOG.info(`acierto | ${clave}`);
    return memo.get(clave);
  }

  // Se guarda la promesa ANTES de esperarla: si el handler de la sección
  // siguiente entra mientras esta sigue en vuelo, se engancha a la misma.
  const promesa = cargar();
  memo.set(clave, promesa);

  // Un fallo no debe quedar memoizado: condenaría al resto de la petición a
  // repetir el mismo error aunque un reintento pudiera funcionar. El catch es
  // solo para desalojar; el rechazo sigue viajando a quien llamó.
  promesa.catch(() => memo.delete(clave));

  return promesa;
}

module.exports = { memoPorPeticion, MEMO };
