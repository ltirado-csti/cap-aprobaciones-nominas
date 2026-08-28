"use strict";
/**
 * srv/config/perfiles.js
 *
 * Mapeo centralizado de roles del flujo BPA H2H Nómina.
 *
 * Contiene DOS tablas complementarias:
 *
 *   PERFILES  — perfiles funcionales del flujo y su código de presentación.
 *   ROLES_BPA — IDs de tareas BPA (usados por aprobacion.service.js,
 *               pagos-service.js y reasignacion-service.js).
 *
 * Principio de perfil por tarea (definitivo):
 *   El rol pertenece a la TAREA, no al usuario.
 *   La cadena es: Payroll resuelve emails → BPA asigna destinatario →
 *   CAP filtra inbox por token XSUAA → taskDefinitionId define el rol via
 *   calcularFlagsRol() → UI muestra los botones del rol correspondiente.
 *
 * ── ESTADO BPA v1.2.0 (H2H Nomina 1.4.0) — QUÓRUM DE APODERADOS ──────────────
 *
 * Los apoderados dejaron de ser dos usuarios fijos en dos ramas paralelas. Ahora
 * son una LISTA de N usuarios equivalentes y basta con que DOS cualesquiera
 * aprueben para que el flujo avance al Liberador. BPA lo resuelve con una única
 * user task cuyo destinatario es un pool (context.custom.apoderadospendientes) y
 * un loop-back que la vuelve a crear hasta alcanzar el quórum.
 *
 * Consecuencias directas para CAP —verificadas en el BPMN desplegado, no
 * deducidas del diseño—:
 *
 *   · Existe UN solo taskDefinitionId de apoderado: form_aprobacionDelApoderado_1.
 *     form_aprobacionDelApoderado_2 ya no existe en el proceso.
 *   · El email del firmante NO lo expone BPA de forma fiable con un pool de
 *     destinatarios: CAP debe enviarlo en el payload de completarTarea, derivado
 *     del token XSUAA. Ver aprobacion.service.js → _armarContextoBpa.
 *   · Las variables personalizadas se exponen en context.custom SIEMPRE EN
 *     MINÚSCULAS, por mucho que el canvas de BPA las muestre en camelCase.
 *
 * Roles activos:
 *   AP  →  form_aprobacionDelApoderado_1   (pool de N, quórum de 2)
 *   LI  →  form_aprobacionLiberadorFinal_1 (pool de N, una sola liberación)
 *
 * Roles retenidos fuera del flujo:
 *   CO  →  form_aprobacionDelCoordinador_2 (anulado desde v1.1.0)
 */

// ─── TABLA 1: Perfiles funcionales ───────────────────────────────────────────
//
// `codigoLane` es un código de PRESENTACIÓN: rotula la columna del diagrama de
// flujo (ver PERFILES_LANE en domain/historial.service.js) y viaja en el campo
// `rol` del historial. NO es el IpPerfil de Payroll.
//
// `perfilPayroll` sí es el literal IpPerfil del iFlow ZhrfApoReg, y transporta
// el SLOT DE FIRMA, no un perfil por usuario:
//   "1" primera firma de apoderado | "2" segunda | "3" liberador.
// Para los apoderados es null a propósito: el slot depende de cuántas firmas
// lleve la propuesta, así que lo calcula BPA en el script "Desicion de aprobar 1"
// (custom.perfilfirma) y CAP no lo envía nunca. Está aquí documentado porque es
// la respuesta a "qué código recibe Payroll", que antes esta tabla contestaba mal.

const PERFILES = {
    /**
     * Analista de Nómina — arma el lote y lo envía al flujo.
     * Opera en Payroll; no tiene tarea visible en la Fiori app.
     */
    analista: {
        codigoLane   : "AN",
        perfilPayroll: null,
        label        : "Analista de Nómina",
    },

    /**
     * Coordinador — anulado en BPA v1.1.0. Reservado para uso futuro.
     * Los objetos se conservan; no debe mostrarse en la UI.
     */
    coordinador: {
        codigoLane   : "CO",
        perfilPayroll: null,
        label        : "Coordinador",
        activo       : false,
    },

    /**
     * Apoderado — firma en representación de la sociedad.
     * Lista de N usuarios equivalentes; se requieren 2 firmas (quórum).
     * El slot de firma ("1" o "2") lo decide BPA en tiempo de ejecución.
     */
    apoderado: {
        codigoLane   : "AP",
        perfilPayroll: null,   // dinámico: custom.perfilfirma
        label        : "Apoderado",
        activo       : true,
    },

    /**
     * Liberador Final — aprobación definitiva sobre el proceso principal.
     * Lee su contexto desde startEvent.propuesta (ruta del proceso raíz).
     */
    liberador: {
        codigoLane   : "LI",
        perfilPayroll: "3",    // literal fijo en el ActionTask del proceso raíz
        label        : "Liberador Final",
        activo       : true,
    },

    /**
     * Caja — confirma pagos con vía de pago tipo W (ventanilla).
     * Fuera del alcance de esta entrega.
     */
    caja: {
        codigoLane   : "CA",
        perfilPayroll: null,
        label        : "Caja",
        activo       : false,
    },
};

// ─── TABLA 2: Roles BPA ──────────────────────────────────────────────────────
// Vincula cada taskDefinitionId de BPA al rol funcional y sus reglas.
// Usada por aprobacion.service.js, pagos-service.js y reasignacion-service.js.

const ROLES_BPA = {
    /**
     * Apoderado — tarea única con POOL de destinatarios y quórum de 2 firmas.
     *
     * Contexto: startEvent.body (subproceso aprobacionDeLosApoderados).
     * Decisiones válidas: aprobar | rechazar.
     * Destinatarios en BPA: context.custom.apoderadospendientes (CSV).
     *
     * `campoPropuesta` es la lista ORIGINAL que Payroll dejó en el contexto al
     * arrancar; `campoPendientes` es la que BPA recalcula en cada firma y la que
     * gobierna de verdad quién puede firmar ahora. Los dos hacen falta: la
     * primera para mostrar el flujo completo, la segunda para autorizar.
     */
    apoderado: {
        taskDefinitionId: "form_aprobacionDelApoderado_1",
        decisiones      : ["aprobar", "rechazar"],
        contextPath     : "startEvent.body",
        codigoLane      : "AP",
        perfilPayroll   : null,          // lo calcula BPA (custom.perfilfirma)
        campoPropuesta  : "usuariosApoderados",

        // Variables personalizadas del contexto BPA (context.custom.*).
        // EN MINÚSCULAS: es como BPA las expone, sin importar cómo se vean en el
        // canvas. Verificado en el BPMN desplegado (H2H Nomina 1.4.0).
        campoPendientes  : "apoderadospendientes",
        campoFirmantes   : "apoderadosfirmantes",
        campoContador    : "contadorfirmasapoderados",
        campoRequeridas  : "firmasrequeridas",

        // Escritas por el Script Task "Asigna resp. apo 1" tras la notificación
        // a Payroll. Conservan el sufijo Apo1 del diseño de dos ramas: son las
        // que el BPMN 1.4.0 sigue poblando (flagerrornotifapoderado /
        // mensajenotifapoderado existen en el contexto pero nadie las escribe).
        campoFlagNotif   : "flagerrornotifapo1",
        campoMensajeNotif: "mensajenotifapo1",

        // Los dos roles activos son pools de N destinatarios; lo que distingue a
        // este es el QUÓRUM: M firmas necesarias y un registro en BPA que
        // recalcula la lista en cada una (los campos custom de aquí arriba).
        esPool          : true,
        firmasPorDefecto: 2,             // respaldo si custom.firmasrequeridas no llegó

        label           : "Apoderado",
        activo          : true,
    },

    /**
     * Liberador Final — proceso principal (aprobacionDeNomina).
     * Contexto: startEvent.propuesta (proceso raíz, no subproceso).
     * Decisiones válidas: liberar | rechazar | anular.
     * Destinatarios en BPA: startEvent.propuesta.usuarioLiberador (CSV).
     *
     * TAMBIÉN ES UN POOL, y por eso `esPool` está en true: Payroll puede dejar
     * VARIOS correos separados por comas en ese campo, y BPA los reparte como
     * destinatarios de una sola tarea igual que hace con los apoderados —
     * recipientUsers es un CSV en su API (ver infrastructure/bpa-client.js).
     *
     * EN QUÉ SE DIFERENCIA DEL POOL DE APODERADOS
     * -------------------------------------------
     * En que NO hay quórum ni registro de firmas: basta UNA liberación y el
     * flujo avanza, así que el BPMN no recalcula la lista en ninguna variable
     * de context.custom. De ahí que este rol no declare campoPendientes,
     * campoFirmantes, campoContador ni campoRequeridas: su lista de
     * destinatarios vive SIEMPRE en el campo de la propuesta y solo cambia
     * cuando la reasignación la reescribe ahí (ver
     * domain/reasignacion.service.js → _persistirEnContexto).
     *
     * La ausencia de campoPendientes es justamente lo que distingue a los dos
     * pools en el código: resolverDestinatarios() la usa para decidir si la
     * lista buena la lleva BPA o la propuesta.
     */
    liberador: {
        taskDefinitionId: "form_aprobacionLiberadorFinal_1",
        decisiones      : ["liberar", "rechazar", "anular"],
        contextPath     : "startEvent.propuesta",
        codigoLane      : "LI",
        perfilPayroll   : "3",
        campoPropuesta  : "usuarioLiberador",
        // Escritas por el Script Task "Asigna resp Libera" del proceso RAÍZ
        // (aprobacionDeNomina), no del subproceso de Apoderados.
        campoFlagNotif   : "flagerrornotifliberador",
        campoMensajeNotif: "mensajenotifliberador",
        esPool          : true,
        // Una sola liberación cierra el paso. No hay variable de quórum que
        // consultar: este número no sale del contexto, es la definición del rol.
        firmasPorDefecto: 1,
        label           : "Liberador Final",
        activo          : true,
    },

    /**
     * Coordinador — ANULADO en BPA v1.1.0. Reservado para uso futuro.
     * Los objetos se conservan; activo: false evita que se use en la UI.
     */
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
    "form_aprobacionFinalForm_2",      // aprobacionFinal (proceso eliminado)
    "form_aprobacionDelCoordinador_2", // coordinador (anulado en v1.1.0)
    // Segunda rama de apoderados: existía mientras el flujo tenía dos ramas
    // paralelas con usuarios fijos. El quórum de v1.2.0 la eliminó del BPMN.
    "form_aprobacionDelApoderado_2",
];

// ─── LISTAS DE USUARIOS ──────────────────────────────────────────────────────

/**
 * Normaliza una lista de correos a la MISMA forma que usa BPA.
 *
 * El script `inicializarApoderados` del BPMN normaliza la lista que llega de CPI
 * a minúsculas, sin espacios, sin vacíos y sin duplicados. CAP tiene que comparar
 * exactamente contra eso: si aquí se comparara con otra convención, un correo con
 * una mayúscula bastaría para que un apoderado legítimo recibiera un 403.
 *
 * Acepta CSV, array o valor suelto — el contexto BPA entrega CSV, pero los mocks
 * y el detalle de tarea pueden traer arrays.
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
 * Normaliza la identidad del usuario autenticado a UN correo comparable.
 *
 * POR QUÉ NO BASTA CON trim().toLowerCase()
 * -----------------------------------------
 * El id del usuario llega del proveedor de identidad y puede traer restos que
 * no son parte del correo. El caso real que motivó esto: las listas de
 * apoderados viajan como CSV desde BPA ("a@x,b@x,c@x"), y al copiar un correo
 * de esa lista para iniciar sesión se arrastra la coma separadora. El id queda
 * como "arodas@centria.net," y deja de coincidir con "arodas@centria.net" de la
 * lista de pendientes: el apoderado recibe un 403 pese a estar autorizado.
 *
 * Se reutiliza normalizarUsuarios porque aplica EXACTAMENTE la misma convención
 * con la que se normalizan las listas contra las que hay que comparar (partir
 * por comas, recortar, minúsculas, descartar vacíos). Cualquier otra limpieza
 * volvería a abrir la puerta a que las dos partes de la comparación se
 * normalicen distinto, que es de donde salió este fallo.
 *
 * Se devuelve SOLO la primera entrada, nunca la lista: un id de usuario
 * identifica a UNA persona. Si llegara con varios correos, aceptar cualquiera
 * de ellos convertiría un dato sucio en una vía para firmar en nombre de otro.
 *
 * @param {string} usuario - identidad del token (req.user.id)
 * @returns {string} correo normalizado, o "" si no hay ninguno utilizable
 */
function normalizarUsuario(usuario) {
    return normalizarUsuarios(usuario)[0] ?? "";
}

/**
 * Quién puede actuar TODAVÍA en la tarea de un rol, y quién ya actuó.
 *
 * Sirve para los dos pools del flujo, que se leen de sitios distintos:
 *
 *   APODERADOS (BPA lleva la cuenta) — fuente de verdad, en orden:
 *     1. context.custom.apoderadospendientes — lo que BPA usa como destinatarios.
 *     2. startEvent.body.usuariosApoderados  — la lista original de Payroll, que
 *        es lo único que hay antes de que el script de inicialización corra.
 *
 *     El respaldo importa: entre que el proceso arranca y el Script Task
 *     `inicializarApoderados` escribe la variable hay una ventana en la que el
 *     contexto solo tiene la lista original. Sin el respaldo, una lectura en esa
 *     ventana dejaría el pool vacío y nadie podría firmar.
 *
 *   LIBERADOR (nadie lleva la cuenta) — la lista de la propuesta es TODA la
 *     verdad: el paso se cierra con una sola liberación, así que el BPMN no
 *     recalcula nada y no hay variable de pendientes que consultar. Pendientes =
 *     la lista completa; firmantes = ninguno, porque si alguien hubiera liberado
 *     el paso habría terminado y esta tarea ya no existiría.
 *
 * La rama la decide `campoPendientes`: si el rol no declara esa variable, es que
 * BPA no lleva el registro. Se mira eso y no `esPool` porque los dos roles SON
 * pools; lo que los diferencia es quién mantiene la lista.
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

/**
 * El quórum de apoderados — resolverDestinatarios() fijado a ese rol.
 *
 * Se conserva con nombre propio porque hay tres consumidores que hablan
 * específicamente del quórum (el diagrama de aprobaciones, los campos "Ya
 * firmaron / Pendientes" del Object Page y la cabecera de la propuesta en
 * reasignación) y leerían peor con el rol como argumento.
 */
function resolverQuorumApoderados(contexto, propuesta) {
    return resolverDestinatarios(ROLES_BPA.apoderado, contexto, propuesta);
}

/**
 * ¿Puede este usuario actuar sobre la tarea de este rol en esta propuesta?
 *
 * Se comprueba contra los PENDIENTES y no contra la lista original: un apoderado
 * que ya firmó sale del pool en BPA, y CAP no puede permitirle una segunda firma
 * aunque su correo siga en `usuariosApoderados`. En el liberador las dos listas
 * coinciden —nadie ha liberado mientras la tarea siga viva— y la comprobación
 * equivale a "estar en usuarioLiberador".
 *
 * FALLA CERRADO: si la lista no se puede resolver, la respuesta es NO. Es la
 * postura que ya tenía el pool de apoderados y el motivo por el que la
 * reasignación escribe SIEMPRE la lista nueva en el contexto — si solo tocara
 * los destinatarios de la tarea, el sustituto vería la tarea y aquí se llevaría
 * un 403 (ver domain/reasignacion.service.js → _persistirEnContexto).
 *
 * @param {string} usuario   - req.user.id (token XSUAA, nunca del cliente)
 * @param {object} contexto  - contexto BPA completo
 * @param {object} propuesta - PropuestaNomina extraída del contexto
 * @param {object} rolBpa    - rol de la tarea (resolverRolBpa())
 * @returns {boolean}
 */
function esDestinatarioAutorizado(usuario, contexto, propuesta, rolBpa) {
    // normalizarUsuario y no trim(): el id puede arrastrar la coma separadora
    // de la lista CSV de destinatarios. Ver normalizarUsuario.
    const correo = normalizarUsuario(usuario);
    if (!correo) return false;
    return resolverDestinatarios(rolBpa, contexto, propuesta).pendientes.includes(correo);
}

/**
 * Índice de context.custom con las claves en minúsculas.
 *
 * BPA ya las expone así, pero la normalización es barata y deja el código a
 * salvo del día que alguien "arregle" los nombres en el canvas: el proyecto ya
 * perdió una tarde por un desajuste de mayúsculas entre diseño y BPMN.
 */
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
 *
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
 *
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
 * El rol pertenece a la TAREA: un mismo usuario puede ser Apoderado en
 * una propuesta y Liberador en otra, dependiendo del taskDefinitionId
 * que BPA le asignó.
 *
 * `esApoderado1` / `esApoderado2` desaparecieron con el quórum de v1.2.0: ya no
 * hay dos tareas de apoderado que distinguir, sino una sola con pool. Quién
 * ocupa el primer o el segundo slot de firma lo decide BPA al completarse la
 * tarea, no CAP al pintarla.
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
        esCoordinador: false,   // anulado: nunca true en el flujo activo
    };
}

/**
 * Devuelve el rol BPA completo a partir del taskDefinitionId.
 * Usado por aprobacion.service.js para leer decisiones y ruta, y por
 * reasignacion.service.js para saber si la tarea es de pool o de un solo usuario.
 *
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
 *
 * Apoderados:  "startEvent.body"      (subproceso aprobacionDeLosApoderados)
 * Liberador:   "startEvent.propuesta" (proceso raíz)
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
 * Devuelve el código de presentación (lane) del rol de una tarea.
 * Es el que viaja en el campo `rol` del historial y rotula la columna del
 * diagrama de flujo — NO es el IpPerfil de Payroll (ver PERFILES).
 *
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
 * Devuelve los nombres de las variables personalizadas (context.custom.*) donde
 * BPA deja el resultado de la notificación a Payroll para el rol de esta tarea.
 *
 * Contexto: al decidir, BPA notifica a Payroll vía CPI (iFlow ZhrfApoReg). Si
 * Payroll rechaza, un Script Task escribe el flag y el mensaje en el contexto y
 * el flujo hace loop back a la misma tarea, que reaparece en el inbox. CAP lee
 * esas variables para mostrarle al usuario POR QUÉ volvió la tarea.
 *
 * @param {string} taskDefinitionId
 * @returns {{ campoFlag: string, campoMensaje: string } | null}
 *          null si el rol no participa del ciclo de notificación (ej. Coordinador)
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

    // Resolución de perfiles funcionales
    resolverCodigo,
    resolverNombre,

    // Resolución BPA
    calcularFlagsRol,
    resolverRolBpa,
    resolverContextPath,
    resolverCodigoLane,
    resolverCamposNotificacion,
    esDecisionValida,

    // Destinatarios de un rol (los dos pools) y quórum de apoderados
    normalizarUsuarios,
    normalizarUsuario,
    resolverDestinatarios,
    resolverQuorumApoderados,
    esDestinatarioAutorizado,
};
