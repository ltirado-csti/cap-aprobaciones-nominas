"use strict";
/**
 * Tabla del "Grupo Pers." — texto de negocio del código `tipoTrabajador`
 * que BPA entrega en el contexto de la propuesta.
 */

/** Códigos del DataType de BPA. */
const GRUPOS_PERSONAL = { E: "Empleados", P: "Practicantes" };

/**
 * Texto del grupo de personal a partir del código de BPA.
 * @param {string} tipoTrabajador - código del contexto BPA (E / P)
 * @returns {string} etiqueta de negocio, o "" si no se reconoce
 */
function grupoPersonal(tipoTrabajador) {
    const codigo = String(tipoTrabajador ?? "").trim().toUpperCase();
    return GRUPOS_PERSONAL[codigo] ?? "";
}

module.exports = { GRUPOS_PERSONAL, grupoPersonal };
