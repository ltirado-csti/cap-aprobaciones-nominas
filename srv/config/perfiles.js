"use strict";
/**
 * Mapeo centralizado de roles del flujo BPA H2H Nómina.
 *
 * PERFILES  — perfiles funcionales del flujo y su código de presentación.
 * ROLES_BPA — IDs de tareas BPA, usados por aprobacion.service.js,
 *             pagos-service.js y reasignacion-service.js.
 *
 * El rol pertenece a la TAREA, no al usuario: Payroll resuelve emails → BPA
 * asigna destinatario → CAP filtra el inbox por token XSUAA → taskDefinitionId
 * define el rol vía calcularFlagsRol() → la UI muestra los botones del rol.
 *
 * Los apoderados son una lista de N usuarios equivalentes; bastan dos firmas
 * (quórum) para que el flujo avance al Liberador. BPA lo resuelve con una
 * única user task cuyo destinatario es un pool (context.custom.apoderadospendientes)
 * y un loop-back que la recrea hasta alcanzar el quórum. Las variables
 * personalizadas se exponen siempre en minúsculas en context.custom.
 *
 * Roles activos:
 *   AP  →  form_aprobacionDelApoderado_1   (pool de N, quórum de 2)
 *   LI  →  form_aprobacionLiberadorFinal_1 (pool de N, una sola liberación)
 *
 * Rol retenido fuera del flujo:
 *   CO  →  form_aprobacionDelCoordinador_2
 */

// ─── TABLA 1: Perfiles funcionales ───────────────────────────────────────────
//
// `codigoLane` es el código de presentación que rotula la columna del diagrama
// de flujo (ver PERFILES_LANE en domain/historial.service.js) y viaja en el
// campo `rol` del historial. No es el IpPerfil de Payroll.
//
// `perfilPayroll` es el literal IpPerfil del iFlow ZhrfApoReg y transporta el
// slot de firma, no un perfil por usuario: "1" primera firma de apoderado,
// "2" segunda, "3" liberador. Para los apoderados es null porque el slot lo
// calcula BPA en tiempo de ejecución (custom.perfilfirma).

const PERFILES = {
    /** Analista de Nómina — arma el lote y lo envía al flujo. Sin tarea en la Fiori app. */
    analista: {
        codigoLane   : "AN",
        perfilPayroll: null,
        label        : "Analista",
    },

    /** Coordinador — fuera del flujo activo. Reservado para uso futuro. */
    coordinador: {
        codigoLane   : "CO",
        perfilPayroll: null,
        label        : "Coordinador",
        activo       : false,
    },

    /** Apoderado — firma en representación de la sociedad. Pool de N usuarios, quórum de 2. */
    apoderado: {
        codigoLane   : "AP",
        perfilPayroll: null,   // dinámico: custom.perfilfirma
        label        : "Apoderado",
        activo       : true,
    },

    /** Liberador Final — aprobación definitiva sobre el proceso principal. */
    liberador: {
        codigoLane   : "LI",
        perfilPayroll: "3",
        label        : "Liberador Final",
        activo       : true,
    },

    /** Caja — confirma pagos con vía de pago tipo W (ventanilla). Fuera de alcance. */
    caja: {
        codigoLane   : "CA",
        perfilPayroll: null,
        label        : "Caja",
        activo       : false,
    },
};

// ─── TABLA 2: Roles BPA ──────────────────────────────────────────────────────
// Vincula cada taskDefinitionId de BPA al rol funcional y sus reglas.

const ROLES_BPA = {
    /**
     * Apoderado — tarea única con pool de destinatarios y quórum de 2 firmas.
     *
     * Contexto: startEvent.body (subproceso aprobacionDeLosApoderados).
     * Decisiones válidas: aprobar | rechazar.
     * Destinatarios en BPA: context.custom.apoderadospendientes (CSV).
     *
     * `campoPropuesta` es la lista original que Payroll dejó en el contexto al
     * arrancar; `campoPendientes` es la que BPA recalcula en cada firma y la
     * que gobierna quién puede firmar ahora.
     */
    apoderado: {
        taskDefinitionId: "form_aprobacionDelApoderado_1",
        decisiones      : ["aprobar", "rechazar"],
        contextPath     : "startEvent.body",
        codigoLane      : "AP",
        perfilPayroll   : null,          // lo calcula BPA (custom.perfilfirma)
        campoPropuesta  : "usuariosApoderados",

        // Variables de context.custom.* (BPA las expone en minúsculas).
        campoPendientes  : "apoderadospendientes",
        campoFirmantes   : "apoderadosfirmantes",
        campoContador    : "contadorfirmasapoderados",
        campoRequeridas  : "firmasrequeridas",

        campoFlagNotif   : "flagerrornotifapo1",
        campoMensajeNotif: "mensajenotifapo1",

        esPool          : true,
        firmasPorDefecto: 2,             // respaldo si custom.firmasrequeridas no llegó

        label           : "Apoderado",
        activo          : true,
    },

    /**
     * Liberador Final — proceso principal (aprobacionDeNomina).
     * Contexto: startEvent.propuesta (proceso raíz).
     * Decisiones válidas: liberar | rechazar | anular.
     * Destinatarios en BPA: startEvent.propuesta.usuarioLiberador (CSV, pool sin quórum).
     *
     * No hay quórum ni registro de firmas: basta una liberación y el flujo
     * avanza, así que el BPMN no recalcula ninguna variable de context.custom.
     * La lista de destinatarios vive siempre en el campo de la propuesta y
     * solo cambia cuando la reasignación la reescribe ahí (ver
     * domain/reasignacion.service.js → _persistirEnContexto).
     *
     * La ausencia de campoPendientes es lo que distingue a los dos pools:
     * resolverDestinatarios() la usa para decidir si la lista buena la lleva
     * BPA o la propuesta.
     */
    liberador: {
        taskDefinitionId: "form_aprobacionLiberadorFinal_1",
        decisiones      : ["liberar", "rechazar", "anular"],
        contextPath     : "startEvent.propuesta",
        codigoLane      : "LI",
        perfilPayroll   : "3",
        campoPropuesta  : "usuarioLiberador",
        campoFlagNotif   : "flagerrornotifliberador",
        campoMensajeNotif: "mensajenotifliberador",
        esPool          : true,
        firmasPorDefecto: 1,
        label           : "Liberador Final",
        activo          : true,
    },

    /** Coordinador — fuera del flujo activo. `activo: false` evita su uso en la UI. */
    coordinador: {
        taskDefinitionId: "form_aprobacionDelCoordinador_2",
        decisiones      : ["aprobar", "rechazar"],
        contextPath     : "startEvent.body",
        codigoLane      : "CO",
        perfilPayroll   : null,
        campoPropuesta  : "usuarioCoordinador",
        esPool          : false,
        activo          : false,
    },
};

// ─── IDs OBSOLETOS (retenidos en BPA Studio, fuera del flujo activo) ────────
// No deben usarse en ningún handler activo.
const TASK_IDS_OBSOLETOS = [
    "form_aprobacionFinalForm_2",
    "form_aprobacionDelCoordinador_2",
    "form_aprobacionDelApoderado_2",
];

// ─── LISTAS DE USUARIOS ──────────────────────────────────────────────────────

/**
 * Normaliza una lista de correos a la misma forma que usa BPA: minúsculas,
 * sin espacios, sin vacíos y sin duplicados.
 *
 * Acepta CSV, array o valor suelto.
 *
 * @param {string|string[]} lista
 * @returns {string[]} correos en minúsculas, sin repetidos, en orden de aparición
 */
function normalizarUsuarios(lista) {
    const crudos = Array.isArray(lista)
        ? lista
        : String(lista ?? "").split(",");

    const vistos = new Set();
    const salida = [];

    for (const entrada of crudos) {
        const correo = String(entrada ?? "").trim().toLowerCase();
        if (!correo || vistos.has(correo)) continue;
        vistos.add(correo);
        salida.push(correo);
    }

    return salida;
}

/**
 * Normaliza la identidad del usuario autenticado a un correo comparable.
 * Reutiliza normalizarUsuarios y devuelve solo la primera entrada.
 *
 * @param {string} usuario - identidad del token (req.user.id)
 * @returns {string} correo normalizado, o "" si no hay ninguno utilizable
 */
function normalizarUsuario(usuario) {
    return normalizarUsuarios(usuario)[0] ?? "";
}

/**
 * Quién puede actuar todavía en la tarea de un rol, y quién ya actuó.
 *
 * Para el rol de apoderados, la fuente de verdad es context.custom.apoderadospendientes
 * (con startEvent.body.usuariosApoderados como respaldo antes de que BPA
 * inicialice esa variable). Para el liberador, que no lleva registro de
 * firmas, pendientes = la lista completa de la propuesta y firmantes = [].
 *
 * La rama la decide `campoPendientes`: si el rol no lo declara, BPA no lleva
 * el registro y la lista de la propuesta es toda la verdad.
 *
 * @param {object} rolBpa    - entrada de ROLES_BPA (o resolverRolBpa())
 * @param {object} contexto  - contexto BPA completo (con su rama `custom`)
 * @param {object} propuesta - PropuestaNomina ya extraída del contexto
 * @returns {{ originales: string[], pendientes: string[], firmantes: string[],
 *             contador: number, requeridas: number }}
 */
function resolverDestinatarios(rolBpa, contexto, propuesta) {
    const rol = rolBpa ?? ROLES_BPA.apoderado;

    const originales = normalizarUsuarios(propuesta?.[rol.campoPropuesta]);

    if (!rol.campoPendientes) {
        return {
            originales,
            pendientes: originales,
            firmantes : [],
            contador  : 0,
            requeridas: rol.firmasPorDefecto ?? 1,
        };
    }

    const custom    = _customEnMinusculas(contexto);
    const firmantes = normalizarUsuarios(custom[rol.campoFirmantes]);

    const pendientesBpa = normalizarUsuarios(custom[rol.campoPendientes]);
    const pendientes    = pendientesBpa.length
        ? pendientesBpa
        : originales.filter(correo => !firmantes.includes(correo));

    const contador = Number(custom[rol.campoContador] ?? firmantes.length) || firmantes.length;
    const requeridas = Number(custom[rol.campoRequeridas]) || rol.firmasPorDefecto;

    return { pendientes, firmantes, contador, requeridas, originales };
}

/** El quórum de apoderados — resolverDestinatarios() fijado a ese rol. */
function resolverQuorumApoderados(contexto, propuesta) {
    return resolverDestinatarios(ROLES_BPA.apoderado, contexto, propuesta);
}

/**
 * ¿Puede este usuario actuar sobre la tarea de este rol en esta propuesta?
 * Se comprueba contra los pendientes, no contra la lista original: un
 * apoderado que ya firmó sale del pool y no puede firmar de nuevo. Falla
 * cerrado: si la lista no se puede resolver, la respuesta es no.
 *
 * @param {string} usuario   - req.user.id (token XSUAA, nunca del cliente)
 * @param {object} contexto  - contexto BPA completo
 * @param {object} propuesta - PropuestaNomina extraída del contexto
 * @param {object} rolBpa    - rol de la tarea (resolverRolBpa())
 * @returns {boolean}
 */
function esDestinatarioAutorizado(usuario, contexto, propuesta, rolBpa) {
    const correo = normalizarUsuario(usuario);
    if (!correo) return false;
    return resolverDestinatarios(rolBpa, contexto, propuesta).pendientes.includes(correo);
}

/** Índice de context.custom con las claves en minúsculas. */
function _customEnMinusculas(contexto) {
    const custom = contexto?.custom;
    if (!custom || typeof custom !== "object") return {};
    return Object.fromEntries(
        Object.entries(custom).map(([clave, valor]) => [clave.toLowerCase(), valor])
    );
}

// ─── FUNCIONES DE RESOLUCIÓN — PERFILES FUNCIONALES ──────────────────────────

/**
 * Resuelve el código de presentación (lane del diagrama) del perfil funcional.
 * @param {string} nombreFuncional - clave del objeto PERFILES
 * @returns {string} código de dos letras (AN, CO, AP, LI, CA)
 * @throws {Error} si el nombre funcional no existe en PERFILES
 */
function resolverCodigo(nombreFuncional) {
    const perfil = PERFILES[nombreFuncional];
    if (!perfil) {
        throw new Error(
            `Perfil desconocido: "${nombreFuncional}". ` +
            `Válidos: ${Object.keys(PERFILES).join(", ")}`
        );
    }
    return perfil.codigoLane;
}

/**
 * Resuelve el nombre funcional a partir del código de presentación.
 * @param {string} codigoLane - código de dos letras (AN, CO, AP, LI, CA)
 * @returns {string|null} nombre funcional o null si no se encuentra
 */
function resolverNombre(codigoLane) {
    const entrada = Object.entries(PERFILES)
        .find(([, perfil]) => perfil.codigoLane === codigoLane);
    return entrada ? entrada[0] : null;
}

// ─── FUNCIONES DE RESOLUCIÓN — ROLES BPA ────────────────────────────────────

/**
 * Calcula los flags de visibilidad de rol a partir del taskDefinitionId.
 * Es la función central que la UI consume para mostrar/ocultar botones.
 *
 * @param {string} taskDefinitionId - valor del campo definitionId de la tarea BPA
 * @returns {{ esApoderado: boolean, esLiberador: boolean, esCoordinador: boolean }}
 */
function calcularFlagsRol(taskDefinitionId) {
    const SIN_ROL = { esApoderado: false, esLiberador: false, esCoordinador: false };

    const rol = resolverRolBpa(taskDefinitionId);
    if (!rol || !rol.activo) return SIN_ROL;

    return {
        esApoderado  : rol.nombre === "apoderado",
        esLiberador  : rol.nombre === "liberador",
        esCoordinador: false,
    };
}

/**
 * Devuelve el rol BPA completo a partir del taskDefinitionId.
 * @param {string} taskDefinitionId
 * @returns {{ nombre, taskDefinitionId, decisiones, contextPath, codigoLane,
 *             perfilPayroll, campoPropuesta, esPool, label, activo } | null}
 */
function resolverRolBpa(taskDefinitionId) {
    const idNormalizado = (taskDefinitionId || "").split("@")[0];
    const entrada = Object.entries(ROLES_BPA).find(
        ([, rol]) => rol.taskDefinitionId === idNormalizado
    );
    return entrada ? { nombre: entrada[0], ...entrada[1] } : null;
}

/**
 * Devuelve la ruta de contexto BPA para leer la PropuestaNomina.
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
 * Devuelve el código de presentación (lane) del rol de una tarea.
 * @param {string} taskDefinitionId
 * @returns {string} "AP" | "LI" | "CO"
 * @throws {Error} si el taskDefinitionId no está registrado
 */
function resolverCodigoLane(taskDefinitionId) {
    const rol = resolverRolBpa(taskDefinitionId);
    if (!rol) {
        throw new Error(`taskDefinitionId desconocido: "${taskDefinitionId}"`);
    }
    return rol.codigoLane;
}

/**
 * Devuelve los nombres de las variables (context.custom.*) donde BPA deja el
 * resultado de la notificación a Payroll para el rol de esta tarea.
 *
 * @param {string} taskDefinitionId
 * @returns {{ campoFlag: string, campoMensaje: string } | null}
 *          null si el rol no participa del ciclo de notificación
 */
function resolverCamposNotificacion(taskDefinitionId) {
    const rol = resolverRolBpa(taskDefinitionId);
    if (!rol || !rol.activo || !rol.campoFlagNotif) return null;
    return {
        campoFlag   : rol.campoFlagNotif,
        campoMensaje: rol.campoMensajeNotif,
    };
}

/**
 * Valida que la decisión sea válida para el taskDefinitionId dado.
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
    PERFILES,
    ROLES_BPA,
    TASK_IDS_OBSOLETOS,

    resolverCodigo,
    resolverNombre,

    calcularFlagsRol,
    resolverRolBpa,
    resolverContextPath,
    resolverCodigoLane,
    resolverCamposNotificacion,
    esDecisionValida,

    normalizarUsuarios,
    normalizarUsuario,
    resolverDestinatarios,
    resolverQuorumApoderados,
    esDestinatarioAutorizado,
};
