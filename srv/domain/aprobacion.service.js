"use strict";
/**
 * srv/domain/aprobacion.service.js
 *
 * Handlers de las acciones bound de TareasInbox (aprobación de nómina).
 *
 * Roles activos BPA v1.1.5:
 *   Apoderado1 / Apoderado2: aprobar | observar   (contexto: startEvent.body)
 *   Liberador:               liberar | rechazar | anular  (contexto: startEvent.propuesta)
 *
 * Coordinador: ANULADO en BPA v1.1.0 — acciones conservadas, nunca invocadas en producción.
 *
 * Principio anti-tampering (CRÍTICO):
 *   - instanceID  → siempre de req.params    (nunca del body del cliente)
 *   - propuesta   → siempre de leerContexto  (BPA es fuente de verdad)
 *   - usuario     → siempre de req.user.id   (XSUAA, no modificable por el cliente)
 *   - comentario  → único campo aceptado del cliente
 *
 * CAP NO llama a CPI para registrar la decisión.
 * BPA ejecuta el ActionTask ZhrfApoReg que llama a CPI directamente.
 */

const cds      = require("@sap/cds");
const perfiles  = require("../config/perfiles");
const bpaClient  = require("../infrastructure/bpa-client");

const LOG = cds.log("aprobacion-service");

// =============================================================================
// FUNCIÓN CENTRAL: _prepararAccion
// Extrae y valida todos los datos necesarios antes de completar una tarea BPA.
// El cliente solo puede enviar el campo "comentario".
// =============================================================================

/**
 * Prepara el contexto completo de una acción de aprobación.
 * Aplica el principio anti-tampering: todos los datos sensibles se derivan
 * del token XSUAA y del contexto BPA, nunca del body del cliente.
 *
 * @param {import('@sap/cds').Request} req - Request CAP
 * @param {string} decision - decisión BPA a aplicar (ej: "aprobar", "liberar")
 * @returns {Promise<{
 *   instanceID  : string,
 *   propuesta   : import('./config/perfiles').PropuestaNomina,
 *   usuario     : string,
 *   comentario  : string,
 *   taskDefId   : string,
 *   rolBpa      : object,
 *   flags       : object
 * }>}
 */
async function _prepararAccion(req, decision) {
    // 1. Clave de la tarea desde los parámetros de ruta OData (nunca del body)
    const instanceID = req.params?.[0]?.instanceID ?? req.params?.[0];
    if (!instanceID) {
        return req.reject(400, "Falta el identificador de tarea (instanceID)");
    }

    // 2. Leer la tarea BPA para obtener el taskDefinitionId real
    let tareaBpa;
    try {
        tareaBpa = await bpaClient.obtenerTarea(instanceID);
    } catch (err) {
        LOG.error(`_prepararAccion | leerTarea falló | instanceID=${instanceID}`, err.message);
        return req.reject(502, "No se pudo consultar la tarea en BPA Workflow");
    }

    // Normalizar el taskDefinitionId (BPA puede devolverlo como "form_xxx@defId")
    const taskDefId = (tareaBpa.definitionId || "").split("@")[0];

    // 3. Resolver el rol a partir del taskDefinitionId (la fuente de verdad)
    const rolBpa = perfiles.resolverRolBpa(taskDefId);
    if (!rolBpa || !rolBpa.activo) {
        LOG.error(`_prepararAccion | rol inactivo o desconocido | taskDefId=${taskDefId}`);
        return req.reject(403, "Esta tarea no corresponde a un rol activo en el flujo de aprobación");
    }

    // 4. Validar que la decisión es válida para este rol (anti-tampering)
    if (!perfiles.esDecisionValida(taskDefId, decision)) {
        LOG.error(`_prepararAccion | decisión inválida | decision=${decision} taskDefId=${taskDefId}`);
        return req.reject(400, `La decisión "${decision}" no es válida para este rol`);
    }

    // 5. Leer el contexto de la propuesta desde BPA (ruta según el rol)
    let propuesta;
    try {
        const contextoCompleto = await bpaClient.readContext(instanceID);
        propuesta = _navegarRuta(contextoCompleto, rolBpa.contextPath);
    } catch (err) {
        LOG.error(`_prepararAccion | leerContexto falló | instanceID=${instanceID}`, err.message);
        return req.reject(502, "No se pudo leer el contexto de la propuesta en BPA");
    }

    if (!propuesta) {
        return req.reject(502, `La propuesta no existe en la ruta de contexto: ${rolBpa.contextPath}`);
    }

    // 6. Usuario autenticado desde XSUAA (única fuente de verdad del firmante)
    const usuario = req.user.id;

    // 7. Comentario: único dato aceptado del cliente
    const comentario = (req.data?.comentario ?? "").trim();

    // 8. Calcular flags de rol (para logs y respuesta)
    const flags = perfiles.calcularFlagsRol(taskDefId);

    LOG.info(
        `_prepararAccion OK | instanceID=${instanceID} usuario=${usuario} ` +
        `rol=${taskDefId} decision=${decision}`
    );

    return { instanceID, propuesta, usuario, comentario, taskDefId, rolBpa, flags };
}

// =============================================================================
// FUNCIÓN INTERNA: _navegarRuta
// Accede a una ruta anidada en el objeto de contexto BPA.
// Ejemplo: "startEvent.body" → contexto.startEvent.body
// =============================================================================

/**
 * Navega un objeto JSON siguiendo una ruta con puntos.
 *
 * @param {object} objeto - objeto raíz
 * @param {string} ruta   - ruta separada por puntos (ej: "startEvent.propuesta")
 * @returns {any}
 */
function _navegarRuta(objeto, ruta) {
    return ruta.split(".").reduce(
        (acumulador, clave) => (acumulador != null ? acumulador[clave] : undefined),
        objeto
    );
}

// =============================================================================
// FUNCIÓN INTERNA: _armarContextoBpa
// Construye el objeto de contexto que CAP envía a BPA al completar la tarea.
// BPA v1.1.5 incluye: perfil, comentario, taskInstanceId.
// =============================================================================

/**
 * Arma el payload de contexto para completar la tarea en BPA.
 * El campo perfil es el literal IpPerfil del iFlow ZhrfApoReg.
 *
 * @param {object} rolBpa     - rol resuelto por resolverRolBpa()
 * @param {string} comentario - comentario libre del firmante
 * @param {string} instanceID - ID de la tarea BPA
 * @returns {{ perfil: string, comentario: string, taskInstanceId: string }}
 */
function _armarContextoBpa(rolBpa, comentario, instanceID) {
    return {
        perfil        : rolBpa.perfilCPI,
        comentario    : comentario,
        // PENDIENTE: confirmar con el arquitecto si es ID de tarea o de proceso.
        // Actualmente se usa el instanceID de la tarea BPA.
        taskInstanceId: instanceID,
    };
}

// =============================================================================
// FUNCIÓN INTERNA: _responder
// Emite el resultado como MENSAJE OData además de devolverlo en el cuerpo.
// =============================================================================

/**
 * Construye la respuesta de una acción de aprobación.
 *
 * Por qué req.info() y no sólo el campo `mensaje` del cuerpo:
 *   Los botones del Object Page provienen de las anotaciones UI.Identification
 *   (DataFieldForAction), así que los ejecuta Fiori Elements de forma nativa —
 *   no el controller de la app. FE NO muestra el cuerpo de respuesta de una
 *   acción, pero SÍ despliega automáticamente los mensajes que llegan en la
 *   cabecera `sap-messages`, que es lo que req.info() alimenta.
 *   Sin esto el usuario no recibe ninguna confirmación visible.
 *
 * Por qué el texto no afirma que Payroll aceptó:
 *   completarTarea sólo obtiene el ACK de BPA. La notificación a Payroll corre
 *   después, de forma asíncrona. Si Payroll rechaza, BPA hace loop back y la
 *   tarea reaparece en el inbox con el motivo visible (notifTieneError /
 *   notifMensaje). Prometer éxito aquí sería mentirle al usuario.
 *
 * @param {import('@sap/cds').Request} req
 * @param {string} accion - texto en pasado, ej. "Aprobación enviada"
 * @returns {{ exito: boolean, mensaje: string }}
 */
function _responder(req, accion) {
    const mensaje = `${accion}. Payroll está validando la operación; ` +
                    `si la rechaza, la tarea volverá a su bandeja con el motivo.`;
    req.info(mensaje);
    return { exito: true, mensaje };
}

// =============================================================================
// EXPORTACIÓN: registrar handlers sobre el servicio PagosService
// Llamado desde pagos-service.js en el bloque handle_aprobaciones()
// =============================================================================

/**
 * Registra todos los handlers de acciones de aprobación en el servicio CAP.
 * Separa la lógica de aprobación del handler principal de pagos-service.js.
 *
 * @param {import('@sap/cds').ApplicationService} srv - instancia del servicio CAP
 */
function registrarHandlers(srv) {

    // =========================================================================
    // ACCIONES APODERADO — Apoderado1 y Apoderado2 (mismo handler, rol por tarea)
    // Contexto BPA: startEvent.body
    // =========================================================================

    /**
     * El apoderado aprueba la propuesta de nómina.
     * BPA ejecuta el ActionTask apoReg que registra la firma en CPI/Payroll.
     */
    srv.on("apoderadoAprobar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "aprobar");

        const { instanceID, rolBpa, comentario } = accion;

        await bpaClient.completarTarea(
            instanceID,
            {
                decision: "aprobar",
                contexto: _armarContextoBpa(rolBpa, comentario, instanceID),
            }
        );

        LOG.info(`apoderadoAprobar OK | instanceID=${instanceID}`);
        return _responder(req, "Aprobación enviada");
    });

    /**
     * El apoderado observa la propuesta (devuelve con nota al analista).
     * BPA ejecuta el ActionTask Obs que registra la observación en CPI/Payroll.
     */
    srv.on("apoderadoObservar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "observar");

        const { instanceID, rolBpa, comentario } = accion;

        if (!comentario) {
            return req.error(400, "El comentario es obligatorio al observar una propuesta");
        }

        await bpaClient.completarTarea(
            instanceID,
            {
                decision: "observar",
                contexto: _armarContextoBpa(rolBpa, comentario, instanceID),
            }
        );

        LOG.info(`apoderadoObservar OK | instanceID=${instanceID}`);
        return _responder(req, "Observación enviada");
    });

    // =========================================================================
    // ACCIONES LIBERADOR FINAL
    // Contexto BPA: startEvent.propuesta (proceso raíz)
    // =========================================================================

    /**
     * El liberador autoriza el desembolso de la nómina.
     * BPA ejecuta el ActionTask apoReg con decisión "liberar".
     */
    srv.on("liberadorLiberar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "liberar");

        const { instanceID, rolBpa, comentario } = accion;

        await bpaClient.completarTarea(
            instanceID,
            {
                decision: "liberar",
                contexto: _armarContextoBpa(rolBpa, comentario, instanceID),
            }
        );

        LOG.info(`liberadorLiberar OK | instanceID=${instanceID}`);
        return _responder(req, "Liberación enviada");
    });

    /**
     * El liberador rechaza la propuesta.
     * BPA devuelve el flujo al estado previo (según gateway de BPA).
     */
    srv.on("liberadorRechazar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "rechazar");

        const { instanceID, rolBpa, comentario } = accion;

        if (!comentario) {
            return req.error(400, "El comentario es obligatorio al rechazar una propuesta");
        }

        await bpaClient.completarTarea(
            instanceID,
            {
                decision: "rechazar",
                contexto: _armarContextoBpa(rolBpa, comentario, instanceID),
            }
        );

        LOG.info(`liberadorRechazar OK | instanceID=${instanceID}`);
        return _responder(req, "Rechazo enviado");
    });

    /**
     * El liberador anula definitivamente la propuesta de nómina.
     * Acción irreversible: BPA cierra el proceso completo.
     */
    srv.on("liberadorAnular", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "anular");

        const { instanceID, rolBpa, comentario } = accion;

        if (!comentario) {
            return req.error(400, "El comentario es obligatorio al anular una propuesta");
        }

        await bpaClient.completarTarea(
            instanceID,
            {
                decision: "anular",
                contexto: _armarContextoBpa(rolBpa, comentario, instanceID),
            }
        );

        LOG.info(`liberadorAnular OK | instanceID=${instanceID}`);
        // La anulación cierra el proceso: no hay loop back posible, así que aquí
        // sí es correcto afirmar el resultado sin condicionarlo a Payroll.
        const mensaje = "Propuesta anulada. El flujo de aprobación queda cerrado.";
        req.info(mensaje);
        return { exito: true, mensaje };
    });

    // =========================================================================
    // ACCIONES COORDINADOR — ANULADAS en BPA v1.1.0
    // Conservadas para uso futuro. Retornan error controlado si son invocadas.
    // La UI no las mostrará porque esCoordinador = false siempre.
    // =========================================================================

    /**
     * [FUTURO] El coordinador valida y envía al flujo de apoderados.
     * ANULADO en BPA v1.1.0 — no disponible en el flujo activo.
     */
    srv.on("coordinadorAprobar", "TareasInbox", async (req) => {
        LOG.warn(`coordinadorAprobar invocado | instanceID=${req.params?.[0]?.instanceID} | ROL ANULADO`);
        return req.error(501, "La etapa de Coordinador no está activa en el flujo actual (BPA v1.1.0)");
    });

    /**
     * [FUTURO] El coordinador rechaza el lote de nómina.
     * ANULADO en BPA v1.1.0 — no disponible en el flujo activo.
     */
    srv.on("coordinadorRechazar", "TareasInbox", async (req) => {
        LOG.warn(`coordinadorRechazar invocado | instanceID=${req.params?.[0]?.instanceID} | ROL ANULADO`);
        return req.error(501, "La etapa de Coordinador no está activa en el flujo actual (BPA v1.1.0)");
    });
}

module.exports = { registrarHandlers };