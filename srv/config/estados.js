"use strict";
/**
 * Tabla de los estados de la propuesta y su color semántico (criticidad).
 */

/** com.sap.vocabularies.UI.v1.CriticalityType — color e ícono en Fiori Elements. */
const CRITICIDAD = {
    NEUTRAL    : 0,   // gris
    NEGATIVE   : 1,   // rojo
    CRITICAL   : 2,   // ámbar
    POSITIVE   : 3,   // verde
    INFORMATION: 5,   // azul
};

/** Estados posibles de una propuesta. `activo: false` = no se muestra en la UI. */
const ESTADOS = {
    APODERADOS : { texto: "Pendiente de aprobación Apoderados", criticidad: CRITICIDAD.INFORMATION, activo: true  },
    LIBERACION : { texto: "Pendiente de Liberación",  criticidad: CRITICIDAD.CRITICAL,    activo: true  },
    LIBERADO   : { texto: "Liberado",                 criticidad: CRITICIDAD.POSITIVE,    activo: true  },
    ANULADO    : { texto: "Anulado",                  criticidad: CRITICIDAD.NEGATIVE,    activo: true  },
    PENDIENTE  : { texto: "Pendiente",                criticidad: CRITICIDAD.NEUTRAL,     activo: true  },
    COORDINADOR: { texto: "Pendiente de Coordinador", criticidad: CRITICIDAD.INFORMATION, activo: false },
};

/**
 * Estados activos para el desplegable del filtro "Estado".
 * @returns {{estadoPP: string, criticidad: number}[]}
 */
function listar() {
    return Object.values(ESTADOS)
        .filter(estado => estado.activo)
        .map(estado => ({ estadoPP: estado.texto, criticidad: estado.criticidad }));
}

module.exports = { CRITICIDAD, ESTADOS, listar };
