"use strict";
/**
 * srv/config/perfiles.js
 *
 * Mapeo centralizado entre nombres funcionales del flujo BTP, códigos de
 * perfil SAP Payroll y la configuración de SAP Build Process Automation (BPA).
 *
 * Fuente:
 *   - Códigos SAP: definición del arquitecto (ltirado@csticorp.biz)
 *       CO = Coordinador   (antes TR/SUPERVISOR en el legado)
 *       AP = Apoderado
 *       LI = Liberador     (pendiente confirmar: ¿equivale a RV/REVISOR o es nuevo nivel?)
 *       AN = Analista de Nómina
 *   - taskDefinitionId + decisions: extraídos del despliegue BPA H2H_Nomina_1_0_12.mtar
 *     y documentados en MAPEO_WORKFLOW_BPA.md.
 *
 * REGLA: aprobacion.service.js siempre usa nombres funcionales (claves de este objeto).
 *        cpi-client.js recibe el código SAP (resolverCodigo) en el query param ?rol=XX
 *        y CPI lo pasa a Payroll (ECP) sin traducción. CPI es la única fachada:
 *        no hay sap-gateway-client ni acceso directo a Gateway/HANA.
 *        bpa-client.js recibe el taskDefinitionId y el decision resueltos aquí.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HALLAZGOS DEL .mtar (3 procesos BPA):
 *   aprobacionDeNomina         → proceso principal. Trigger: iniciarAprobacionDeNomina.
 *                                Contexto anidado bajo startEvent.propuesta.
 *                                User task: Coordinador (form_aprobacionDelCoordinador_2).
 *   aprobacionDeLosApoderados  → subproceso paralelo de 2 firmas (F1/F2).
 *                                Contexto anidado bajo startEvent.body.
 *                                User tasks: form_aprobacionDelApoderado_1 / _2.
 *   aprobacionFinal            → proceso independiente. Trigger: aprobadorFinal.
 *                                Contexto anidado bajo startEvent.body.
 *                                User task: Liberador (form_aprobacionFinalForm_2).
 *
 *   Solo Coordinador, Apoderados y Liberador tienen user task en BPA.
 *   Analista y Caja son 100% CAP (no completan tarea BPA — ver esTareaBpa).
 *
 * PENDIENTES DE ARQUITECTO (no resueltos en este bloque, marcados con TODO):
 *   1. ¿LI (Liberador) reemplaza a RV (Revisor) o es un nivel adicional?
 *   2. Loop de observación del Coordinador: ¿nueva instancia o mismo proceso?
 *   3. ¿Caja completa una user task en BPA o es 100% CAP? (asumido 100% CAP).
 *   4. definitionId cualificado del proceso aprobacionFinal (falta del BPA Studio).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── PROCESOS BPA ────────────────────────────────────────────────────────────
//
// Configuración a nivel de proceso (no de rol):
//   definitionId : ID cualificado del workflow para POST /v1/workflow-instances.
//   trigger      : nombre del trigger declarado en BPA Studio (Triggers tab).
//   contextPath  : dónde se anida la PropuestaNomina dentro del contexto BPA.
//                  El principal usa "propuesta"; los demás usan "body".
//
const PROCESOS = {
    aprobacionDeNomina: {
        definitionId: "us30.centriah2hnominadevqas.h2hnomina.aprobacionDeNomina",
        trigger     : "iniciarAprobacionDeNomina",
        contextPath : "propuesta",
    },
    aprobacionDeLosApoderados: {
        // Subproceso: se instancia desde el proceso principal, no se inicia directo.
        definitionId: null,
        trigger     : null,
        contextPath : "body",
    },
    aprobacionFinal: {
        // TODO(arquitecto): confirmar definitionId cualificado en BPA Studio → Triggers.
        definitionId: null,
        trigger     : "aprobadorFinal",
        contextPath : "body",
    },
};

// ─── PERFILES POR ROL ────────────────────────────────────────────────────────
const PERFILES = {
    /**
     * Analista de Nómina — arma el lote e INICIA la instancia del flujo.
     * Legado: ANALISTA_T / AN  →  sin cambio de código.
     * No completa user task en BPA: dispara iniciarInstancia(aprobacionDeNomina).
     */
    analista: {
        codigo : "AN",
        label  : "Analista de Nómina",
        sufijo : "AT",   // sufijo del tituloTarea BPA
        flagBpa: "tieneAnalista",
        bpa: {
            esTareaBpa      : false,                 // 100% CAP — inicia, no completa
            proceso         : "aprobacionDeNomina",  // proceso que dispara al enviar
            taskDefinitionId: null,
            decisions       : {},                    // sin decisions: no hay user task
            inicia          : true,                  // este rol inicia la instancia BPA
        },
    },

    /**
     * Coordinador — valida el lote y lo enruta al siguiente nivel.
     * Legado: SUPERVISOR / TR  →  nuevo código CO.
     * User task BPA del proceso principal aprobacionDeNomina.
     */
    coordinador: {
        codigo : "CO",
        label  : "Coordinador",
        sufijo : "S",
        flagBpa: "estaConforme",
        bpa: {
            esTareaBpa      : true,
            proceso         : "aprobacionDeNomina",
            taskDefinitionId: "form_aprobacionDelCoordinador_2",
            // decisions del .mtar: aprobar | anular | observar (recipients: usuariosRevisores)
            decisions       : {
                aprobar : "aprobar",
                anular  : "anular",
                observar: "observar",
            },
            inicia          : false,
        },
    },

    /**
     * Apoderado — firma F1 y F2 en representación de la sociedad.
     * Legado: APODERADO / AP  →  sin cambio de código.
     * User task BPA del subproceso aprobacionDeLosApoderados (2 firmas paralelas).
     * Dos taskDefinitionId según la firma; se resuelve por contadorFirma en runtime.
     */
    apoderado: {
        codigo : "AP",
        label  : "Apoderado",
        sufijo : "A",
        flagBpa: "estaAprobado",
        bpa: {
            esTareaBpa      : true,
            proceso         : "aprobacionDeLosApoderados",
            // F1 = primera firma (contadorFirma 0), F2 = segunda firma (contadorFirma ≥ 1)
            taskDefinitionId: {
                firma1: "form_aprobacionDelApoderado_1",
                firma2: "form_aprobacionDelApoderado_2",
            },
            // decisions del .mtar: aprobar | observar (recipients: usuarioApoderado)
            // NOTA: la decision "reject" del Apoderado se eliminó del BPA.
            decisions       : {
                aprobar : "aprobar",
                observar: "observar",
            },
            inicia          : false,
        },
    },

    /**
     * Liberador Final — última aprobación del proceso independiente aprobacionFinal.
     * Legado: REVISOR / RV  →  nuevo código LI (pendiente validación).
     * User task BPA: form_aprobacionFinalForm_2 (recipients: usuarioApoderado).
     * Sus decisions usan IDs en inglés (approve/reject/cancel), a diferencia de los
     * otros formularios que usan español — inconsistencia heredada del .mtar.
     */
    liberador: {
        codigo : "LI",
        label  : "Liberador Final",
        sufijo : "L",
        flagBpa: "tieneRevisor",   // provisional — ajustar según decisión del arquitecto
        bpa: {
            esTareaBpa      : true,
            proceso         : "aprobacionFinal",
            taskDefinitionId: "form_aprobacionFinalForm_2",
            // decisions del .mtar: approve | reject | cancel (IDs en inglés)
            // TODO(arquitecto): confirmar mapeo funcional si LI == RV (Revisor).
            decisions       : {
                aprobar : "approve",
                rechazar: "reject",
                anular  : "cancel",
            },
            inicia          : false,
        },
    },

    /**
     * Caja — confirma pagos con vía de pago tipo W (ventanilla).
     * Código SAP pendiente de confirmar con el arquitecto.
     * Asumido 100% CAP (sin user task BPA) — ver pendiente #3.
     */
    caja: {
        codigo : "CA",
        label  : "Caja",
        sufijo : "C",
        flagBpa: "esCaja",
        bpa: {
            esTareaBpa      : false,   // TODO(arquitecto): confirmar si Caja tiene user task
            proceso         : "aprobacionDeNomina",
            taskDefinitionId: null,
            decisions       : {},
            inicia          : false,
        },
    },
};

// ─── FUNCIONES DE RESOLUCIÓN ─────────────────────────────────────────────────

/**
 * Obtiene el perfil completo o lanza error si el nombre funcional no existe.
 * Helper interno reutilizado por el resto de resolvers.
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {object} perfil completo
 * @throws {Error} si el nombre funcional no existe
 */
function _perfil(nombreFuncional) {
    const perfil = PERFILES[nombreFuncional];
    if (!perfil) {
        throw new Error(
            `Perfil desconocido: "${nombreFuncional}". ` +
            `Valores válidos: ${Object.keys(PERFILES).join(", ")}`
        );
    }
    return perfil;
}

/**
 * Resuelve el código SAP a partir del nombre funcional.
 * Usado por sap-gateway-client.js antes de llamar a CPI.
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {string} código de dos letras para Payroll (AN, CO, AP, LI, CA)
 *
 * Ejemplo:
 *   resolverCodigo("coordinador")  → "CO"
 */
function resolverCodigo(nombreFuncional) {
    return _perfil(nombreFuncional).codigo;
}

/**
 * Resuelve el sufijo del tituloTarea a partir del nombre funcional.
 * El tituloTarea en BPA sigue el formato: "Sociedad-NroPP-Banco-Fecha-Sufijo"
 * Ejemplo: "0025-R4603-BCP-20/05/2026-A"
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {string} sufijo de una o dos letras para el tituloTarea BPA
 */
function resolverSufijo(nombreFuncional) {
    return _perfil(nombreFuncional).sufijo;
}

/**
 * Resuelve el flag BPA a partir del nombre funcional.
 * Usado al construir o evaluar el contexto PropuestaNomina.json.
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {string} nombre del flag en el contexto BPA
 *
 * Ejemplo:
 *   resolverFlagBpa("coordinador")  → "estaConforme"
 */
function resolverFlagBpa(nombreFuncional) {
    return _perfil(nombreFuncional).flagBpa;
}

/**
 * Resuelve el nombre funcional a partir del código SAP.
 * Útil para convertir lo que devuelve Payroll a nombres funcionales internos.
 *
 * @param {string} codigoSAP - código de dos letras (AN, CO, AP, LI, CA)
 * @returns {string|null} nombre funcional o null si no se encuentra
 */
function resolverNombre(codigoSAP) {
    const entrada = Object.entries(PERFILES)
        .find(([, perfil]) => perfil.codigo === codigoSAP);
    return entrada ? entrada[0] : null;
}

// ─── RESOLVERS BPA (nuevos en este bloque) ───────────────────────────────────

/**
 * Indica si el rol completa una user task en BPA.
 * Los roles 100% CAP (analista, caja) devuelven false.
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {boolean}
 *
 * Ejemplo:
 *   esTareaBpa("coordinador") → true
 *   esTareaBpa("analista")    → false
 */
function esTareaBpa(nombreFuncional) {
    return _perfil(nombreFuncional).bpa.esTareaBpa === true;
}

/**
 * Indica si el rol INICIA la instancia del flujo (en lugar de completar una tarea).
 * Hoy solo el Analista inicia (POST /v1/workflow-instances).
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {boolean}
 */
function inicia(nombreFuncional) {
    return _perfil(nombreFuncional).bpa.inicia === true;
}

/**
 * Resuelve el ID de decision BPA que se envía en PATCH /v1/task-instances/{id}.
 * Traduce la acción funcional (aprobar|observar|anular|rechazar) al ID real del
 * formulario BPA, que difiere entre procesos (español vs. inglés).
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @param {string} accionFuncional - "aprobar" | "observar" | "anular" | "rechazar"
 * @returns {string} ID de decision tal como lo espera el formulario BPA
 * @throws {Error} si el rol no tiene esa decision (ej. Apoderado no tiene "anular")
 *
 * Ejemplos:
 *   resolverDecision("coordinador", "aprobar")  → "aprobar"
 *   resolverDecision("liberador",   "aprobar")  → "approve"
 *   resolverDecision("liberador",   "anular")   → "cancel"
 */
function resolverDecision(nombreFuncional, accionFuncional) {
    const { decisions, label } = _perfil(nombreFuncional).bpa;
    const decision = decisions[accionFuncional];
    if (!decision) {
        throw new Error(
            `El perfil "${nombreFuncional}" (${label ?? ""}) no define la decision ` +
            `"${accionFuncional}". Decisions válidas: ${Object.keys(decisions).join(", ") || "(ninguna)"}`
        );
    }
    return decision;
}

/**
 * Resuelve el taskDefinitionId del formulario BPA del rol.
 * Para el Apoderado, que tiene dos formularios (F1/F2), se elige según la firma.
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @param {object} [opts]          - { firma: 1 | 2 } solo relevante para apoderado
 * @returns {string|null} taskDefinitionId o null si el rol no tiene user task
 *
 * Ejemplos:
 *   resolverTaskDefinitionId("coordinador")            → "form_aprobacionDelCoordinador_2"
 *   resolverTaskDefinitionId("apoderado", { firma: 1 }) → "form_aprobacionDelApoderado_1"
 *   resolverTaskDefinitionId("apoderado", { firma: 2 }) → "form_aprobacionDelApoderado_2"
 */
function resolverTaskDefinitionId(nombreFuncional, opts = {}) {
    const tdi = _perfil(nombreFuncional).bpa.taskDefinitionId;
    if (!tdi) return null;
    if (typeof tdi === "string") return tdi;
    // Objeto firma1/firma2 (apoderado): firma 2 = segunda firma; el resto = primera
    return opts.firma >= 2 ? tdi.firma2 : tdi.firma1;
}

/**
 * Devuelve la configuración del proceso BPA asociado al rol.
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {object} entrada de PROCESOS (definitionId, trigger, contextPath)
 */
function resolverProceso(nombreFuncional) {
    const nombreProceso = _perfil(nombreFuncional).bpa.proceso;
    return PROCESOS[nombreProceso] ?? null;
}

/**
 * Resuelve el contextPath donde se anida la PropuestaNomina para un proceso.
 * Centraliza la diferencia "propuesta" (principal) vs. "body" (subprocesos).
 *
 * @param {string} nombreProceso - clave del objeto PROCESOS
 * @returns {string} "propuesta" | "body"
 */
function resolverContextPath(nombreProceso) {
    return PROCESOS[nombreProceso]?.contextPath ?? "propuesta";
}

// ─── EXPORTACIONES ───────────────────────────────────────────────────────────

module.exports = {
    PERFILES,
    PROCESOS,
    // Resolvers SAP (existentes)
    resolverCodigo,
    resolverSufijo,
    resolverFlagBpa,
    resolverNombre,
    // Resolvers BPA (nuevos en este bloque)
    esTareaBpa,
    inicia,
    resolverDecision,
    resolverTaskDefinitionId,
    resolverProceso,
    resolverContextPath,
};