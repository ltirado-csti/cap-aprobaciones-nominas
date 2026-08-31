"use strict";
/**
 * La hora que se muestra al usuario es siempre la de Perú (America/Lima),
 * sin importar en qué zona corra el servidor o el navegador.
 *
 * La cadena BPA → CPI → ECP escribe y transporta las horas en UTC; este
 * módulo centraliza la conversión a hora de Lima para presentación. La
 * conversión vive en la lectura, no en la escritura: CAP no controla el
 * reloj con el que BPA/ABAP escriben, solo cómo se muestra.
 *
 * Usado por domain/historial.service.js, utils.js e infrastructure/cpi-client.js.
 * El lado UI5 usa Localization.setTimezone("America/Lima") en cada Component.
 */

/** Zona de presentación (IANA). */
const ZONA = "America/Lima";

/** Marca de zona con la que se sellan las horas que llegan de SAP sin zona ("Z" = UTC). */
const ZONA_ORIGEN_SAP = "Z";

/** Desfase fijo de Lima respecto a UTC, usado para anclar una fecha sin hora al día que representa. */
const DESFASE_LIMA = "-05:00";

/**
 * Partes de un instante en la zona pedida, rellenadas a dos dígitos.
 * @param {Date} fecha
 * @param {string} [zona] - IANA; por defecto, la de presentación
 * @returns {{year:string, month:string, day:string, hour:string, minute:string, second:string}}
 */
function partesEn(fecha, zona = ZONA) {
    return new Intl.DateTimeFormat("es-PE", {
        timeZone: zona,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
    })
        .formatToParts(fecha)
        .reduce((acc, parte) => { acc[parte.type] = parte.value; return acc; }, {});
}

/**
 * Fecha con el formato que espera Payroll: "dd-MM-yyyy", en UTC.
 * @param {Date} [fecha] - instante a convertir; por defecto, ahora
 */
function fechaSap(fecha = new Date()) {
    const p = partesEn(fecha, "UTC");
    return `${p.day}-${p.month}-${p.year}`;
}

/**
 * Hora con el formato que espera Payroll: "HH:mm:ss", en UTC.
 * @param {Date} [fecha] - instante a convertir; por defecto, ahora
 */
function horaSap(fecha = new Date()) {
    const p = partesEn(fecha, "UTC");
    return `${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Fecha y hora de SAP (campos separados, sin zona) → ISO 8601 sellado en UTC.
 * Sin hora, se ancla a la medianoche de Lima para conservar el día que ECP envió.
 *
 * @param {string} dia  - "yyyy-MM-dd"
 * @param {string} hora - "HH:mm:ss"; vacío = solo fecha
 * @returns {string} cadena vacía si no hay día
 */
function isoDesdeSap(dia, hora) {
    const d = String(dia ?? "").trim();
    if (!d) return "";
    const h = String(hora ?? "").trim();
    return h ? `${d}T${h}${ZONA_ORIGEN_SAP}` : `${d}T00:00:00${DESFASE_LIMA}`;
}

/**
 * Fecha de presentación en la convención peruana: "dd/MM/yyyy HH:mm", en hora de Lima.
 * @param {string|number|Date} valor - cualquier cosa que `new Date()` entienda
 * @returns {string} cadena vacía si el valor no es una fecha válida
 */
function formatearFechaHora(valor) {
    if (!valor) return "";
    const fecha = new Date(valor);
    if (Number.isNaN(fecha.getTime())) return "";

    const p = partesEn(fecha);
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

module.exports = {
    ZONA, ZONA_ORIGEN_SAP, DESFASE_LIMA,
    partesEn, fechaSap, horaSap, isoDesdeSap, formatearFechaHora,
};
