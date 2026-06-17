"use strict";
/**
 * srv/config/perfiles.js
 *
 * Mapeo centralizado de roles del flujo BPA H2H Nómina.
 *
 * Contiene DOS tablas complementarias:
 *
 *   PERFILES  — códigos SAP Payroll (IpPerfil que CPI pasa a Payroll vía iFlow ZhrfApoReg).
 *   ROLES_BPA — IDs de tareas BPA v1.1.0 (usados por aprobacion.service.js).
 *
 * Principio de perfil por tarea (definitivo):
 *   El rol pertenece a la TAREA, no al usuario.
 *   La cadena es: Payroll resuelve emails → BPA asigna destinatario →
 *   CAP filtra inbox por token XSUAA → taskDefinitionId define el rol via
 *   calcularFlagsRol() → UI muestra los botones del rol correspondiente.
 *
 * Estado BPA v1.1.5 (activos):
 *   AP1  →  form_aprobacionDelApoderado_1
 *   AP2  →  form_aprobacionDelApoderado_2
 *   LI   →  form_aprobacionLiberadorFinal_1
 *
 * Estado BPA v1.1.5 (anulados — reservados para uso futuro):
 *   CO   →  form_aprobacionDelCoordinador_2
 */

// ─── TABLA 1: Códigos SAP Payroll ────────────────────────────────────────────

const PERFILES = {
    /**
     * Analista de Nómina — arma el lote y lo envía al flujo.
     * Opera en Payroll; no tiene tarea visible en la Fiori app.
     */
    analista: {
        codigo: "AN",
        label : "Analista de Nómina",
    },

    /**
     * Coordinador — anulado en BPA v1.1.0. Reservado para uso futuro.
     * Los objetos se conservan; no debe mostrarse en la UI.
     */
    coordinador: {
        codigo: "CO",
        label : "Coordinador",
        activo: false,
    },

    /**
     * Apoderado — firma F1 y F2 en representación de la sociedad.
     * Dos usuarios distintos: Apoderado1 y Apoderado2 (flujo paralelo en BPA).
     */
    apoderado: {
        codigo: "AP",
        label : "Apoderado",
        activo: true,
    },

    /**
     * Liberador Final — aprobación definitiva sobre el proceso principal.
     * Lee su contexto desde startEvent.propuesta (ruta del proceso raíz).
     */
    liberador: {
        codigo: "LI",
        label : "Liberador Final",
        activo: true,
    },

    /**
     * Caja — confirma pagos con vía de pago tipo W (ventanilla).
     * Código SAP pendiente de confirmar con el arquitecto.
     */
    caja: {
        codigo: "CA",
        label : "Caja",
        activo: false,  // fuera del alcance de esta entrega
    },
};

// ─── TABLA 2: Roles BPA v1.1.0 ───────────────────────────────────────────────
// Vincula cada taskDefinitionId de BPA al rol funcional y sus reglas.
// Usada por aprobacion.service.js y pagos-service.js.

const ROLES_BPA = {
    /**
     * Primer Apoderado — subproceso paralelo de aprobación.
     * Contexto: startEvent.body (subproceso de Apoderados).
     * Decisiones válidas: aprobar | observar.
     * IpPerfil para CPI: "AP"
     * Campo propuesta que contiene su email: usuarioApoderado1
     */
    apoderado1: {
        taskDefinitionId: "form_aprobacionDelApoderado_1",
        decisiones      : ["aprobar", "observar"],
        contextPath     : "startEvent.body",
        perfilCPI       : "AP",
        campoPropuesta  : "usuarioApoderado1",
        activo          : true,
    },

    /**
     * Segundo Apoderado — subproceso paralelo de aprobación.
     * Contexto: startEvent.body (subproceso de Apoderados).
     * Decisiones válidas: aprobar | observar.
     * IpPerfil para CPI: "AP"
     * Campo propuesta que contiene su email: usuarioApoderado2
     */
    apoderado2: {
        taskDefinitionId: "form_aprobacionDelApoderado_2",
        decisiones      : ["aprobar", "observar"],
        contextPath     : "startEvent.body",
        perfilCPI       : "AP",
        campoPropuesta  : "usuarioApoderado2",
        activo          : true,
    },

    /**
     * Liberador Final — proceso principal (aprobacionDeNomina).
     * Contexto: startEvent.propuesta (proceso raíz, no subproceso).
     * Decisiones válidas: liberar | rechazar | anular.
     * IpPerfil para CPI: "LI"
     * Campo propuesta que contiene su email: usuarioLiberador
     */
    liberador: {
        taskDefinitionId: "form_aprobacionLiberadorFinal_1",
        decisiones      : ["liberar", "rechazar", "anular"],
        contextPath     : "startEvent.propuesta",
        perfilCPI       : "LI",
        campoPropuesta  : "usuarioLiberador",
        activo          : true,
    },

    /**
     * Coordinador — ANULADO en BPA v1.1.0. Reservado para uso futuro.
     * Los objetos se conservan; activo: false evita que se use en la UI.
     * taskDefinitionId obsoleto: no debe aparecer en el flujo activo.
     */
    coordinador: {
        taskDefinitionId: "form_aprobacionDelCoordinador_2",
        decisiones      : ["aprobar", "rechazar"],
        contextPath     : "startEvent.body",
        perfilCPI       : "CO",
        campoPropuesta  : "usuarioCoordinador",
        activo          : false,  // anulado — reservado para uso futuro
    },
};

// ─── IDs OBSOLETOS (retenidos en BPA Studio, fuera del flujo activo) ────────
// No deben usarse en ningún handler activo.
const TASK_IDS_OBSOLETOS = [
    "form_aprobacionFinalForm_2",      // aprobacionFinal (proceso eliminado)
    "form_aprobacionDelCoordinador_2", // coordinador (anulado en v1.1.0)
];

// ─── FUNCIONES DE RESOLUCIÓN — PERFILES SAP ──────────────────────────────────

/**
 * Resuelve el código SAP a partir del nombre funcional.
 * El código es el literal IpPerfil que CPI envía a Payroll en el iFlow ZhrfApoReg.
 * CAP no llama a Payroll directamente: toda comunicación pasa por CPI.
 *
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {string} código de dos letras para Payroll (AN, CO, AP, LI, CA)
 * @throws {Error} si el nombre funcional no existe en PERFILES
 *
 * Ejemplo:
 *   resolverCodigo("coordinador")  → "CO"
 *   resolverCodigo("apoderado")    → "AP"
 */
function resolverCodigo(nombreFuncional) {
    const perfil = PERFILES[nombreFuncional];
    if (!perfil) {
        throw new Error(
            `Perfil desconocido: "${nombreFuncional}". ` +
            `Válidos: ${Object.keys(PERFILES).join(", ")}`
        );
    }
    return perfil.codigo;
}

/**
 * Resuelve el nombre funcional a partir del código SAP.
 * Útil para convertir lo que devuelve Payroll a nombres funcionales internos.
 *
 * @param {string} codigoSAP - código de dos letras (AN, CO, AP, LI, CA)
 * @returns {string|null} nombre funcional o null si no se encuentra
 *
 * Ejemplo:
 *   resolverNombre("AP")  → "apoderado"
 *   resolverNombre("LI")  → "liberador"
 */
function resolverNombre(codigoSAP) {
    const entrada = Object.entries(PERFILES)
        .find(([, perfil]) => perfil.codigo === codigoSAP);
    return entrada ? entrada[0] : null;
}

// ─── FUNCIONES DE RESOLUCIÓN — ROLES BPA ────────────────────────────────────

/**
 * Calcula los flags de visibilidad de rol a partir del taskDefinitionId.
 * Es la función central que la UI consume para mostrar/ocultar botones.
 *
 * El rol pertenece a la TAREA: un mismo usuario puede ser Apoderado en
 * una propuesta y Liberador en otra, dependiendo del taskDefinitionId
 * que BPA le asignó.
 *
 * @param {string} taskDefinitionId - valor del campo definitionId de la tarea BPA
 * @returns {{
 *   esApoderado1  : boolean,
 *   esApoderado2  : boolean,
 *   esApoderado   : boolean,  // esApoderado1 || esApoderado2
 *   esLiberador   : boolean,
 *   esCoordinador : boolean   // siempre false en el flujo activo
 * }}
 */
function calcularFlagsRol(taskDefinitionId) {
    // Extraer el segmento anterior al '@' que incluye BPA: "form_xxx@definitionId"
    const idNormalizado = (taskDefinitionId || "").split("@")[0];

    const entrada = Object.entries(ROLES_BPA).find(
        ([, rol]) => rol.taskDefinitionId === idNormalizado
    );

    if (!entrada) {
        return {
            esApoderado1  : false,
            esApoderado2  : false,
            esApoderado   : false,
            esLiberador   : false,
            esCoordinador : false,
        };
    }

    const [nombre, rol] = entrada;

    // Coordinador anulado: nunca retorna true aunque se encuentre el ID
    if (!rol.activo) {
        return {
            esApoderado1  : false,
            esApoderado2  : false,
            esApoderado   : false,
            esLiberador   : false,
            esCoordinador : false,
        };
    }

    const esAp1 = nombre === "apoderado1";
    const esAp2 = nombre === "apoderado2";

    return {
        esApoderado1  : esAp1,
        esApoderado2  : esAp2,
        esApoderado   : esAp1 || esAp2,  // flag combinado para botones compartidos
        esLiberador   : nombre === "liberador",
        esCoordinador : false,            // siempre false en flujo activo v1.1.0
    };
}

/**
 * Devuelve el rol BPA completo a partir del taskDefinitionId.
 * Usado internamente por aprobacion.service.js para leer decisiones y ruta.
 *
 * @param {string} taskDefinitionId
 * @returns {{ taskDefinitionId, decisiones, contextPath, perfilCPI, campoPropuesta, activo } | null}
 */
function resolverRolBpa(taskDefinitionId) {
    const idNormalizado = (taskDefinitionId || "").split("@")[0];
    const entrada = Object.entries(ROLES_BPA).find(
        ([, rol]) => rol.taskDefinitionId === idNormalizado
    );
    return entrada ? entrada[1] : null;
}

/**
 * Devuelve la ruta de contexto BPA para leer la PropuestaNomina.
 *
 * Apoderados:  "startEvent.body"     (subproceso paralelo)
 * Liberador:   "startEvent.propuesta" (proceso raíz)
 * Coordinador: "startEvent.body"     (anulado — reservado)
 *
 * @param {string} taskDefinitionId
 * @returns {string} ruta de contexto
 * @throws {Error} si el taskDefinitionId no está registrado
 */
function resolverContextPath(taskDefinitionId) {
    const rol = resolverRolBpa(taskDefinitionId);
    if (!rol) {
        throw new Error(`taskDefinitionId desconocido: "${taskDefinitionId}"`);
    }
    return rol.contextPath;
}

/**
 * Devuelve el literal IpPerfil para el iFlow ZhrfApoReg de CPI.
 * BPA lo pasa directamente via ActionTask; CAP lo usa solo para validación.
 *
 * @param {string} taskDefinitionId
 * @returns {string} "AP" | "LI" | "CO"
 * @throws {Error} si el taskDefinitionId no está registrado
 */
function resolverPerfilCPI(taskDefinitionId) {
    const rol = resolverRolBpa(taskDefinitionId);
    if (!rol) {
        throw new Error(`taskDefinitionId desconocido: "${taskDefinitionId}"`);
    }
    return rol.perfilCPI;
}

/**
 * Valida que la decisión sea válida para el taskDefinitionId dado.
 * Protección anti-tampering: evita que el cliente inyecte decisiones inválidas.
 *
 * @param {string} taskDefinitionId
 * @param {string} decision
 * @returns {boolean}
 */
function esDecisionValida(taskDefinitionId, decision) {
    const rol = resolverRolBpa(taskDefinitionId);
    if (!rol || !rol.activo) return false;
    return rol.decisiones.includes(decision);
}

// ─── EXPORTACIONES ───────────────────────────────────────────────────────────

module.exports = {
    // Tablas (solo lectura)
    PERFILES,
    ROLES_BPA,
    TASK_IDS_OBSOLETOS,

    // Resolución SAP Payroll
    resolverCodigo,
    resolverNombre,

    // Resolución BPA
    calcularFlagsRol,
    resolverRolBpa,
    resolverContextPath,
    resolverPerfilCPI,
    esDecisionValida,
};