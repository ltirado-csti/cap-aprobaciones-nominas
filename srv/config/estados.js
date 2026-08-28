"use strict";
/**
 * srv/config/estados.js
 *
 * Tabla única de los estados de la propuesta y su color semántico.
 *
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
 */
const ESTADOS = {
    APODERADOS : { texto: "Pendiente de aprobación Apoderados", criticidad: CRITICIDAD.INFORMATION, activo: true  },
    LIBERACION : { texto: "Pendiente de Liberación",  criticidad: CRITICIDAD.CRITICAL,    activo: true  },
    LIBERADO   : { texto: "Liberado",                 criticidad: CRITICIDAD.POSITIVE,    activo: true  },
    ANULADO    : { texto: "Anulado",                  criticidad: CRITICIDAD.NEGATIVE,    activo: true  },

    // Fallback: la tarea no corresponde a ninguno de los roles conocidos.
    PENDIENTE  : { texto: "Pendiente",                criticidad: CRITICIDAD.NEUTRAL,     activo: true  },

    // Coordinador: anulado en BPA v1.1.0, reservado para uso futuro
    // (ver config/perfiles.js). Fuera del filtro mientras el flujo no lo emita.
    COORDINADOR: { texto: "Pendiente de Coordinador", criticidad: CRITICIDAD.INFORMATION, activo: false },
};

/**
 * Los estados ofrecidos en el desplegable del filtro "Estado".
 *
 * @returns {{estadoPP: string, criticidad: number}[]} filas de EstadosPropuesta
 */
function listar() {
    return Object.values(ESTADOS)
        .filter(estado => estado.activo)
        .map(estado => ({ estadoPP: estado.texto, criticidad: estado.criticidad }));
}

module.exports = { CRITICIDAD, ESTADOS, listar };
