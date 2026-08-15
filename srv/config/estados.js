"use strict";
/**
 * srv/config/estados.js
 *
 * Tabla única de los estados de la propuesta y su color semántico.
 *
 * POR QUÉ EXISTE
 * --------------
 * El estado se usa en tres sitios que tienen que decir lo mismo:
 *
 *   1. La columna "Estado" del List Report y la cabecera del Object Page
 *      (texto + color)                      → pagos-service.js/_calcularEstado
 *   2. El desplegable del filtro "Estado"   → entidad EstadosPropuesta
 *   3. El $filter que llega de ese filtro   → se compara contra el mismo texto
 *
 * Mientras los textos estaban escritos como literales dentro de _calcularEstado,
 * cualquier lista de valores era una copia a mano condenada a desincronizarse:
 * bastaba con retocar una tilde para que el filtro dejara de encontrar filas,
 * porque la comparación es sobre el texto. Con esta tabla el texto y el color
 * salen del mismo sitio para los tres.
 *
 * No hay campo "estadoPP" en el contexto BPA — era de la arquitectura HANA
 * anterior y nunca se migró — así que el estado se deriva en vivo de quién tiene
 * la tarea pendiente y de si el flujo cerró. Ver pagos-service.js/_calcularEstado.
 */

/**
 * com.sap.vocabularies.UI.v1.CriticalityType — los valores que Fiori Elements
 * traduce a color e ícono cuando se anota Criticality en un DataField.
 */
const CRITICIDAD = {
    NEUTRAL    : 0,   // gris  — sin ícono
    NEGATIVE   : 1,   // rojo  — ícono de error
    CRITICAL   : 2,   // ámbar — ícono de advertencia
    POSITIVE   : 3,   // verde — ícono de confirmación
    INFORMATION: 5,   // azul  — ícono informativo (no hay 4 en el vocabulario)
};

/**
 * CRITERIO DE COLOR
 * -----------------
 * El color distingue EN QUÉ PUNTO del flujo está la propuesta:
 *
 *   azul  → en firma de apoderados, curso normal   (quórum en curso)
 *   ámbar → último paso antes del desembolso       (Liberación)
 *   verde → cerró bien                             (Liberado)
 *   rojo  → cerró mal                              (Anulado)
 *   gris  → estado desconocido                     (Pendiente)
 *
 * Dos intentos previos y por qué no servían:
 *
 *   Todos los pendientes en ÁMBAR — era el estado original. El inbox solo
 *   muestra tareas pendientes del propio usuario, así que la lista entera salía
 *   naranja y el color no separaba nada.
 *
 *   Todos los pendientes en NEUTRAL — por el mismo motivo el resultado fue una
 *   lista sin ningún color: al no haber nunca filas cerradas en el inbox, verde
 *   y rojo no llegaban a verse jamás.
 *
 * De ahí el reparto actual: los estados que SÍ conviven en el inbox (firma vs.
 * liberación) son los que reciben colores distintos, que es donde el color hace
 * trabajo. Verde y rojo quedan para cuando la propuesta ya cerró.
 *
 * `activo: false` marca los estados que el flujo vigente (BPA v1.2.0) no puede
 * producir: se conservan para que _calcularEstado siga cubriendo el caso, pero
 * no se ofrecen en el filtro, donde serían una opción que nunca devuelve nada.
 *
 * APODERADO_1 y APODERADO_2 se fundieron en APODERADOS con el quórum de
 * v1.2.0: ya no hay una tarea por apoderado, sino una sola con pool de
 * destinatarios (ver config/perfiles.js). Distinguir "Apoderado 1" de
 * "Apoderado 2" en la columna Estado habría dejado de significar nada — el
 * orden de firma lo decide quién llega primero, no el flujo.
 */
const ESTADOS = {
    APODERADOS : { texto: "Pendiente de Apoderados",  criticidad: CRITICIDAD.INFORMATION, activo: true  },
    LIBERACION : { texto: "Pendiente de Liberación",  criticidad: CRITICIDAD.CRITICAL,    activo: true  },
    LIBERADO   : { texto: "Liberado",                 criticidad: CRITICIDAD.POSITIVE,    activo: true  },
    ANULADO    : { texto: "Anulado",                  criticidad: CRITICIDAD.NEGATIVE,    activo: true  },

    // Fallback: la tarea no corresponde a ninguno de los roles conocidos.
    // Gris a propósito: no es un paso del flujo, es "no se pudo determinar".
    // Se ofrece en el filtro porque, si llega a aparecer en la columna, el
    // usuario tiene que poder aislar esas filas para reportarlas.
    PENDIENTE  : { texto: "Pendiente",                criticidad: CRITICIDAD.NEUTRAL,     activo: true  },

    // Coordinador: anulado en BPA v1.1.0, reservado para uso futuro
    // (ver config/perfiles.js). Fuera del filtro mientras el flujo no lo emita.
    COORDINADOR: { texto: "Pendiente de Coordinador", criticidad: CRITICIDAD.INFORMATION, activo: false },
};

/**
 * Los estados ofrecidos en el desplegable del filtro "Estado".
 *
 * El orden de esta lista NO es el que ve el usuario: el ValueHelp de valores
 * fijos de Fiori Elements reordena las entradas alfabéticamente por el texto.
 * Para imponer un orden propio haría falta un campo de orden en la entidad más
 * un UI.PresentationVariant; con seis opciones no compensa.
 *
 * @returns {{estadoPP: string, criticidad: number}[]} filas de EstadosPropuesta
 */
function listar() {
    return Object.values(ESTADOS)
        .filter(estado => estado.activo)
        .map(estado => ({ estadoPP: estado.texto, criticidad: estado.criticidad }));
}

module.exports = { CRITICIDAD, ESTADOS, listar };
