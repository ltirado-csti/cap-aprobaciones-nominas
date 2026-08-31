"use strict";
/**
 * Memoiza trabajo asíncrono durante lo que dura una petición HTTP.
 *
 * El mapa vive colgado de `cds.context`, así que no sobrevive a la petición:
 * el siguiente refresco vuelve a consultar el origen. Se memoiza la PROMESA,
 * no el resultado, para que llamadas concurrentes compartan el mismo vuelo.
 * Sin `cds.context` (fuera de una petición) no memoiza.
 */

const cds = require("@sap/cds");

const LOG = cds.log("memo-peticion");

/** Clave del mapa colgado del contexto. */
const MEMO = Symbol.for("h2h.memo-peticion");

/**
 * Ejecuta `cargar` como mucho una vez por petición y clave.
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

  const promesa = cargar();
  memo.set(clave, promesa);

  // Un fallo no queda memoizado: se desaloja para que un reintento pueda funcionar.
  promesa.catch(() => memo.delete(clave));

  return promesa;
}

module.exports = { memoPorPeticion, MEMO };
