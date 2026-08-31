"use strict";
/**
 * Handlers de las acciones bound de TareasInbox (aprobación de nómina).
 *
 * Roles activos:
 *   Apoderado: aprobar | rechazar          (contexto: startEvent.body)
 *   Liberador: liberar | rechazar | anular (contexto: startEvent.propuesta)
 * Coordinador: acciones conservadas, no activas en el flujo.
 *
 * La tarea de apoderado tiene un pool de destinatarios (quórum de 2 firmas):
 * este módulo envía el email del firmante en el payload de completarTarea
 * (BPA no expone de forma fiable quién completó la tarea de un pool) y
 * verifica que el firmante siga en el pool de pendientes antes de completar.
 *
 * Principio anti-tampering:
 *   - instanceID  → siempre de req.params    (nunca del body del cliente)
 *   - propuesta   → siempre de leerContexto  (BPA es fuente de verdad)
 *   - usuario     → siempre de req.user.id   (XSUAA, no modificable por el cliente)
 *   - comentario  → único campo aceptado del cliente
 *
 * CAP no llama a CPI para registrar la decisión: BPA ejecuta el ActionTask
 * ZhrfApoReg que llama a CPI directamente.
 */

const cds      = require("@sap/cds");
const perfiles  = require("../config/perfiles");
const bpaClient  = require("../infrastructure/bpa-client");

const LOG = cds.log("aprobacion-service");

/** Antepone el título de la tarea al mensaje de error, para identificarla en un lote. */
function _conEtiqueta(etiqueta, mensaje) {
    return etiqueta ? `${etiqueta}: ${mensaje}` : mensaje;
}

/**
 * Prepara el contexto completo de una acción de aprobación: resuelve la tarea
 * y el contexto en BPA, valida rol y decisión, y autoriza al usuario.
 *
 * @param {import('@sap/cds').Request} req - Request CAP
 * @param {string|Object<string,string>} decision - decisión a aplicar; string en
 *        las acciones por rol, o mapa { rol: decisión } en las acciones masivas.
 * @returns {Promise<{
 *   instanceID  : string,
 *   contexto    : object,
 *   propuesta   : object,
 *   usuario     : string,
 *   comentario  : string,
 *   decision    : string,
 *   taskDefId   : string,
 *   rolBpa      : object,
 *   flags       : object,
 *   etiqueta    : string
 * }>}
 */
async function _prepararAccion(req, decision) {
    const instanceID = req.params?.[0]?.instanceID ?? req.params?.[0];
    if (!instanceID) {
        return req.reject(400, "Falta el identificador de tarea (instanceID)");
    }

    let tareaBpa;
    let contexto;
    try {
        [tareaBpa, contexto] = await Promise.all([
            bpaClient.obtenerTarea(instanceID),
            bpaClient.readContext(instanceID),
        ]);
    } catch (err) {
        LOG.error(`_prepararAccion | lectura BPA falló | instanceID=${instanceID}`, err.message);
        return req.reject(502, "No se pudo consultar la tarea en BPA Workflow");
    }

    if (!tareaBpa) {
        LOG.error(`_prepararAccion | tarea no legible en BPA | instanceID=${instanceID}`);
        return req.reject(502, "No se pudo consultar la tarea en BPA Workflow");
    }

    let etiqueta = (tareaBpa.subject || "").trim();

    const taskDefId = (tareaBpa.definitionId || "").split("@")[0];

    const rolBpa = perfiles.resolverRolBpa(taskDefId);
    if (!rolBpa || !rolBpa.activo) {
        LOG.error(`_prepararAccion | rol inactivo o desconocido | taskDefId=${taskDefId}`);
        return req.reject(403, _conEtiqueta(etiqueta,
            "Esta tarea no corresponde a un rol activo en el flujo de aprobación"));
    }

    const decisionRol = typeof decision === "string" ? decision : decision?.[rolBpa.nombre];
    if (!decisionRol) {
        LOG.error(`_prepararAccion | acción no aplicable al rol | rol=${rolBpa.nombre} taskDefId=${taskDefId}`);
        return req.reject(400, _conEtiqueta(etiqueta,
            `Esta acción no está disponible para el rol ${rolBpa.label}`));
    }

    if (!perfiles.esDecisionValida(taskDefId, decisionRol)) {
        LOG.error(`_prepararAccion | decisión inválida | decision=${decisionRol} taskDefId=${taskDefId}`);
        return req.reject(400, _conEtiqueta(etiqueta,
            `La decisión "${decisionRol}" no es válida para este rol`));
    }

    if (!contexto) {
        LOG.error(`_prepararAccion | contexto no legible en BPA | instanceID=${instanceID}`);
        return req.reject(502, _conEtiqueta(etiqueta,
            "No se pudo leer el contexto de la propuesta en BPA"));
    }

    const propuesta = _navegarRuta(contexto, rolBpa.contextPath);

    if (!propuesta) {
        return req.reject(502, _conEtiqueta(etiqueta,
            `La propuesta no existe en la ruta de contexto: ${rolBpa.contextPath}`));
    }

    etiqueta = etiqueta || (propuesta.tituloTarea || propuesta.numeroPropuesta || "").trim();

    const usuario = perfiles.normalizarUsuario(req.user.id);
    if (!usuario) {
        LOG.error(`_prepararAccion | identidad no utilizable | instanceID=${instanceID} raw=${req.user.id}`);
        return req.reject(403, _conEtiqueta(etiqueta,
            "No se pudo determinar su identidad de usuario para firmar esta propuesta"));
    }

    if (rolBpa.esPool && !perfiles.esDestinatarioAutorizado(usuario, contexto, propuesta, rolBpa)) {
        const { pendientes } = perfiles.resolverDestinatarios(rolBpa, contexto, propuesta);
        LOG.warn(
            `_prepararAccion | destinatario fuera del pool | instanceID=${instanceID} ` +
            `rol=${rolBpa.label} usuario="${usuario}" pendientes="${pendientes.join(",") || "(vacío)"}"`
        );
        return req.reject(403, _conEtiqueta(etiqueta, _motivoNoAutorizado(rolBpa)));
    }

    const comentario = (req.data?.comentario ?? "").trim();

    const flags = perfiles.calcularFlagsRol(taskDefId);

    LOG.info(
        `_prepararAccion OK | instanceID=${instanceID} usuario=${usuario} ` +
        `rol=${taskDefId} decision=${decisionRol}`
    );

    return {
        instanceID, contexto, propuesta, usuario, comentario,
        decision: decisionRol, taskDefId, rolBpa, flags, etiqueta,
    };
}

/** Mensaje de "no autorizado" en los términos del rol de la tarea. */
function _motivoNoAutorizado(rolBpa) {
    if (rolBpa.campoPendientes) {
        return "Usted no figura entre los apoderados que aún pueden firmar esta propuesta. " +
               "Si ya firmó, la tarea sigue visible hasta que el segundo apoderado la complete.";
    }
    return "Usted no figura entre los destinatarios designados para liberar esta propuesta. " +
           "Si la tarea le fue reasignada hace un momento, vuelva a abrirla desde su bandeja.";
}

/**
 * Navega un objeto JSON siguiendo una ruta con puntos.
 * @param {object} objeto - objeto raíz
 * @param {string} ruta   - ruta separada por puntos (ej: "startEvent.propuesta")
 */
function _navegarRuta(objeto, ruta) {
    return ruta.split(".").reduce(
        (acumulador, clave) => (acumulador != null ? acumulador[clave] : undefined),
        objeto
    );
}

/**
 * Arma el payload de contexto para completar la tarea en BPA.
 * Sus claves son las de salida del formulario de la user task (camelCase).
 *
 * @param {string} usuario    - req.user.id (XSUAA)
 * @param {string} comentario - comentario libre del firmante
 * @returns {{ emailFirmante: string, comentario: string }}
 */
function _armarContextoBpa(usuario, comentario) {
    return {
        emailFirmante: String(usuario ?? "").trim().toLowerCase(),
        comentario   : comentario,
    };
}

/** Registro de mensajes ya emitidos en la petición HTTP en curso. */
const MENSAJES_EMITIDOS = Symbol.for("h2h.mensajes-emitidos");

/**
 * ¿Es la primera vez que este texto se emite en la petición HTTP actual?
 * Marca y responde en la misma llamada.
 */
function _primeraVezEnLaPeticion(req, mensaje) {
    const ancla = req?.http?.req ?? cds.context?.http?.req ?? cds.context;
    if (!ancla) return true;

    const emitidos = (ancla[MENSAJES_EMITIDOS] ??= new Set());
    if (emitidos.has(mensaje)) return false;

    emitidos.add(mensaje);
    return true;
}

/**
 * Completa la tarea en BPA y convierte un fallo en el error CAP que corresponda.
 * 404/409/410 → la tarea ya no está disponible: mensaje de negocio (400).
 * Cualquier otro código es un problema técnico → 502.
 *
 * @param {import('@sap/cds').Request} req
 * @param {string} instanceID
 * @param {string} decision
 * @param {object} contexto - payload de _armarContextoBpa
 * @param {string} [etiqueta] - título de la tarea, para identificarla en un lote
 */
async function _completar(req, instanceID, decision, contexto, etiqueta) {
    const resultado = await bpaClient.completarTarea(instanceID, { decision, contexto });
    if (resultado.success) return;

    const yaNoDisponible = [404, 409, 410].includes(resultado.status);

    LOG.error(
        `_completar ERROR | instanceID=${instanceID} decision=${decision} ` +
        `status=${resultado.status ?? "?"} | ${resultado.mensaje}`
    );

    if (yaNoDisponible) {
        return req.reject(400, _conEtiqueta(etiqueta,
            "Esta tarea ya fue completada por otro aprobador. " +
            "Actualice la bandeja para ver el estado actual de la propuesta."
        ));
    }

    return req.reject(502, _conEtiqueta(etiqueta,
        `No se pudo registrar la decisión en BPA: ${resultado.mensaje}`));
}

/**
 * Construye la respuesta de una acción de aprobación y emite el mensaje OData
 * (req.info, para que Fiori Elements lo muestre) una sola vez por petición HTTP,
 * de modo que una acción masiva no repita la misma confirmación por cada fila.
 *
 * @param {import('@sap/cds').Request} req
 * @param {string} accion - texto en pasado, ej. "Aprobación enviada"
 * @returns {{ exito: boolean, mensaje: string }}
 */
function _responder(req, accion) {
    const mensaje = `${accion} correctamente. La operación será validada.`;

    if (_primeraVezEnLaPeticion(req, mensaje)) req.info(mensaje);

    return { exito: true, mensaje };
}

/**
 * Registra todos los handlers de acciones de aprobación en el servicio CAP.
 * @param {import('@sap/cds').ApplicationService} srv - instancia del servicio CAP
 */
function registrarHandlers(srv) {

    // ── Acciones Apoderado — contexto BPA: startEvent.body ──────────────────

    /** El apoderado aprueba la propuesta de nómina. */
    srv.on("apoderadoAprobar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "aprobar");

        const { instanceID, usuario, comentario, etiqueta } = accion;

        await _completar(req, instanceID, "aprobar",
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`apoderadoAprobar OK | instanceID=${instanceID} firmante=${usuario}`);
        return _responder(req, "Aprobación enviada");
    });

    /** El apoderado rechaza la propuesta (devuelve con nota al analista). */
    srv.on("apoderadoRechazar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "rechazar");

        const { instanceID, usuario, comentario, etiqueta } = accion;

        if (!comentario) {
            return req.error(400, _conEtiqueta(etiqueta,
                "El comentario es obligatorio al rechazar una propuesta"));
        }

        await _completar(req, instanceID, "rechazar",
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`apoderadoRechazar OK | instanceID=${instanceID} firmante=${usuario}`);
        return _responder(req, "Rechazo enviado");
    });

    // ── Acciones Liberador Final — contexto BPA: startEvent.propuesta ───────

    /** El liberador autoriza el desembolso de la nómina. */
    srv.on("liberadorLiberar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "liberar");

        const { instanceID, usuario, comentario, etiqueta } = accion;

        await _completar(req, instanceID, "liberar",
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`liberadorLiberar OK | instanceID=${instanceID}`);
        return _responder(req, "Liberación enviada");
    });

    /** El liberador rechaza la propuesta. */
    srv.on("liberadorRechazar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "rechazar");

        const { instanceID, usuario, comentario, etiqueta } = accion;

        if (!comentario) {
            return req.error(400, _conEtiqueta(etiqueta,
                "El comentario es obligatorio al rechazar una propuesta"));
        }

        await _completar(req, instanceID, "rechazar",
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`liberadorRechazar OK | instanceID=${instanceID}`);
        return _responder(req, "Rechazo enviado");
    });

    /** El liberador anula definitivamente la propuesta de nómina. Acción irreversible. */
    srv.on("liberadorAnular", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "anular");

        const { instanceID, usuario, comentario, etiqueta } = accion;

        if (!comentario) {
            return req.error(400, _conEtiqueta(etiqueta,
                "El comentario es obligatorio al anular una propuesta"));
        }

        await _completar(req, instanceID, "anular",
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`liberadorAnular OK | instanceID=${instanceID}`);
        const mensaje = "Propuesta anulada. El flujo de aprobación queda cerrado.";
        req.info(mensaje);
        return { exito: true, mensaje };
    });

    // ── Acciones masivas — un solo botón para los dos roles ─────────────────
    // La bandeja puede mezclar tareas de apoderado y de liberador; _prepararAccion
    // elige la decisión BPA que corresponde al rol de cada tarea.

    /** Decisión BPA de "aprobar" según el rol de la tarea. */
    const APROBAR_POR_ROL  = { apoderado: "aprobar",  liberador: "liberar"  };

    /** Decisión BPA de "rechazar" — misma en los dos roles, distinto contexto. */
    const RECHAZAR_POR_ROL = { apoderado: "rechazar", liberador: "rechazar" };

    /** Aprueba (apoderado) o libera (liberador) la tarea, según su rol. */
    srv.on("aprobarMasivo", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, APROBAR_POR_ROL);

        const { instanceID, usuario, comentario, decision, etiqueta } = accion;

        await _completar(req, instanceID, decision,
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`aprobarMasivo OK | instanceID=${instanceID} decision=${decision} firmante=${usuario}`);
        return _responder(req, decision === "liberar" ? "Liberación enviada" : "Aprobación enviada");
    });

    /** Rechaza la tarea, sea de apoderado o de liberador. */
    srv.on("rechazarMasivo", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, RECHAZAR_POR_ROL);

        const { instanceID, usuario, comentario, decision, etiqueta } = accion;

        if (!comentario) {
            return req.error(400, _conEtiqueta(etiqueta,
                "El comentario es obligatorio al rechazar una propuesta"));
        }

        await _completar(req, instanceID, decision,
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`rechazarMasivo OK | instanceID=${instanceID} rol=${accion.rolBpa.nombre} firmante=${usuario}`);
        return _responder(req, "Rechazo enviado");
    });

    // ── Acciones Coordinador — rol no activo en el flujo ────────────────────

    /** El coordinador valida y envía al flujo de apoderados. No disponible. */
    srv.on("coordinadorAprobar", "TareasInbox", async (req) => {
        LOG.warn(`coordinadorAprobar invocado | instanceID=${req.params?.[0]?.instanceID} | ROL ANULADO`);
        return req.error(501, "La etapa de Coordinador no está activa en el flujo actual (BPA v1.1.0)");
    });

    /** El coordinador rechaza el lote de nómina. No disponible. */
    srv.on("coordinadorRechazar", "TareasInbox", async (req) => {
        LOG.warn(`coordinadorRechazar invocado | instanceID=${req.params?.[0]?.instanceID} | ROL ANULADO`);
        return req.error(501, "La etapa de Coordinador no está activa en el flujo actual (BPA v1.1.0)");
    });
}

module.exports = { registrarHandlers };
