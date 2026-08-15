"use strict";
/**
 * srv/domain/aprobacion.service.js
 *
 * Handlers de las acciones bound de TareasInbox (aprobación de nómina).
 *
 * Roles activos BPA v1.2.0 (H2H Nomina 1.4.0):
 *   Apoderado: aprobar | observar          (contexto: startEvent.body)
 *   Liberador: liberar | rechazar | anular (contexto: startEvent.propuesta)
 *
 * Coordinador: ANULADO en BPA v1.1.0 — acciones conservadas, nunca invocadas en producción.
 *
 * ── QUÓRUM DE APODERADOS ─────────────────────────────────────────────────────
 *
 * La tarea de apoderado es UNA SOLA con un pool de destinatarios: aparece en el
 * inbox de todos los apoderados pendientes y basta con que dos cualesquiera
 * aprueben. Eso obliga a este módulo a hacer dos cosas que antes no hacían falta:
 *
 *   1. Enviar el EMAIL DEL FIRMANTE en el payload de completarTarea. Con un pool,
 *      BPA no expone de forma fiable quién completó la tarea, y sin ese dato el
 *      script `Registrar firma` no incrementa el contador: bucle infinito. El
 *      correo sale SIEMPRE de req.user.id (XSUAA) — nunca del cliente.
 *   2. Verificar que el firmante sigue en el pool de pendientes antes de
 *      completar. BPA ya lo excluye de los destinatarios al firmar, pero la
 *      acción es invocable directamente contra el servicio OData.
 *
 * Además, dos apoderados pueden decidir a la vez: el primero cierra la tarea y
 * el segundo recibe 404/409 de BPA. Eso es un mensaje de negocio, no un 502.
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
 *   contexto    : object,
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

    // 5. Leer el contexto de la propuesta desde BPA (ruta según el rol).
    //    Se conserva el contexto COMPLETO además de la propuesta: la rama
    //    `custom` es la que lleva el estado del quórum, y volver a pedirla sería
    //    una segunda llamada a BPA por el mismo dato.
    let contexto;
    let propuesta;
    try {
        contexto  = await bpaClient.readContext(instanceID);
        propuesta = _navegarRuta(contexto, rolBpa.contextPath);
    } catch (err) {
        LOG.error(`_prepararAccion | leerContexto falló | instanceID=${instanceID}`, err.message);
        return req.reject(502, "No se pudo leer el contexto de la propuesta en BPA");
    }

    if (!propuesta) {
        return req.reject(502, `La propuesta no existe en la ruta de contexto: ${rolBpa.contextPath}`);
    }

    // 6. Usuario autenticado desde XSUAA (única fuente de verdad del firmante)
    const usuario = req.user.id;

    // 7. Autorización por pertenencia — solo para roles de pool.
    //
    //    Con un pool de destinatarios, BPA reparte la tarea entre los apoderados
    //    PENDIENTES y saca del pool a quien ya firmó. Repetir esa comprobación
    //    aquí cierra dos puertas: la de un usuario que invoca la acción OData
    //    directamente sin tener la tarea, y la del apoderado que intenta firmar
    //    dos veces la misma propuesta (que además rompería el quórum, porque el
    //    script `Registrar firma` cuenta firmantes distintos).
    //
    //    Para el liberador no aplica: su destinatario es uno solo y BPA ya no le
    //    entregaría la tarea a nadie más.
    if (rolBpa.esPool && !perfiles.esApoderadoAutorizado(usuario, contexto, propuesta)) {
        const { pendientes } = perfiles.resolverQuorumApoderados(contexto, propuesta);
        LOG.warn(
            `_prepararAccion | firmante fuera del pool | instanceID=${instanceID} ` +
            `usuario=${usuario} pendientes=${pendientes.join(",") || "(vacío)"}`
        );
        return req.reject(403,
            "Usted no figura entre los apoderados que aún pueden firmar esta propuesta. " +
            "Si ya firmó, la tarea sigue visible hasta que el segundo apoderado la complete."
        );
    }

    // 8. Comentario: único dato aceptado del cliente
    const comentario = (req.data?.comentario ?? "").trim();

    // 9. Calcular flags de rol (para logs y respuesta)
    const flags = perfiles.calcularFlagsRol(taskDefId);

    LOG.info(
        `_prepararAccion OK | instanceID=${instanceID} usuario=${usuario} ` +
        `rol=${taskDefId} decision=${decision}`
    );

    return { instanceID, contexto, propuesta, usuario, comentario, taskDefId, rolBpa, flags };
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
// =============================================================================

/**
 * Arma el payload de contexto para completar la tarea en BPA.
 *
 * El payload se mapea a la SALIDA DEL FORMULARIO de la user task, así que sus
 * claves son las del formulario y van en camelCase — la normalización a
 * minúsculas de BPA afecta solo a context.custom.*, no a los campos del form.
 *
 * `emailFirmante` es obligatorio en la tarea de apoderado y es el cambio central
 * del quórum v1.2.0: con un pool de destinatarios BPA no sabe quién completó la
 * tarea, y el script `Registrar firma` lo necesita para incrementar el contador
 * y sacar al firmante de la lista de pendientes. Si llegara vacío, el contador
 * nunca avanzaría y la tarea entraría en bucle. Sale SIEMPRE de req.user.id.
 *
 * Ya NO se envían `perfil` ni `taskInstanceId`:
 *   · perfil (IpPerfil) lo calcula BPA en tiempo de ejecución — es el slot de
 *     firma, no un atributo del usuario, así que CAP no puede conocerlo.
 *   · taskInstanceId era el instanceID de la tarea escrito en un campo del
 *     DataType que ningún binding del BPMN lee.
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

// =============================================================================
// FUNCIÓN INTERNA: _completar
// Envía la decisión a BPA y traduce el fallo al lenguaje del usuario.
// =============================================================================

/**
 * Completa la tarea en BPA y convierte un fallo en el error CAP que corresponda.
 *
 * Antes el resultado de completarTarea se descartaba y todas las acciones
 * respondían "enviado" aunque BPA hubiera rechazado el PATCH. Con el pool de
 * apoderados eso deja de ser un descuido tolerable: dos personas pueden decidir
 * sobre la MISMA tarea a la vez y la segunda tiene que enterarse de que llegó
 * tarde, no recibir una confirmación falsa.
 *
 * 404/409/410 → la tarea ya no está disponible: mensaje de negocio (400), no un
 * fallo de sistema. Cualquier otro código es un problema técnico → 502.
 *
 * @param {import('@sap/cds').Request} req
 * @param {string} instanceID
 * @param {string} decision
 * @param {object} contexto - payload de _armarContextoBpa
 */
async function _completar(req, instanceID, decision, contexto) {
    const resultado = await bpaClient.completarTarea(instanceID, { decision, contexto });
    if (resultado.success) return;

    const yaNoDisponible = [404, 409, 410].includes(resultado.status);

    LOG.error(
        `_completar ERROR | instanceID=${instanceID} decision=${decision} ` +
        `status=${resultado.status ?? "?"} | ${resultado.mensaje}`
    );

    if (yaNoDisponible) {
        return req.reject(400,
            "Esta tarea ya fue completada por otro aprobador. " +
            "Actualice la bandeja para ver el estado actual de la propuesta."
        );
    }

    return req.reject(502, `No se pudo registrar la decisión en BPA: ${resultado.mensaje}`);
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
    // ACCIONES APODERADO — tarea única con pool y quórum de 2 firmas
    // Contexto BPA: startEvent.body
    // =========================================================================

    /**
     * El apoderado aprueba la propuesta de nómina.
     * BPA ejecuta el ActionTask ZhrfApoReg que registra la firma en CPI/Payroll
     * y, si Payroll acepta, cuenta la firma para el quórum.
     */
    srv.on("apoderadoAprobar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "aprobar");

        const { instanceID, usuario, comentario } = accion;

        await _completar(req, instanceID, "aprobar",
            _armarContextoBpa(usuario, comentario));

        LOG.info(`apoderadoAprobar OK | instanceID=${instanceID} firmante=${usuario}`);
        return _responder(req, "Aprobación enviada");
    });

    /**
     * El apoderado observa la propuesta (devuelve con nota al analista).
     *
     * La observación NO entra al quórum: cierra el subproceso de apoderados por
     * la vía "Notificación de observacion", sin loop back. Una sola observación
     * basta, no hacen falta dos.
     */
    srv.on("apoderadoObservar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "observar");

        const { instanceID, usuario, comentario } = accion;

        if (!comentario) {
            return req.error(400, "El comentario es obligatorio al observar una propuesta");
        }

        await _completar(req, instanceID, "observar",
            _armarContextoBpa(usuario, comentario));

        LOG.info(`apoderadoObservar OK | instanceID=${instanceID} firmante=${usuario}`);
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

        const { instanceID, usuario, comentario } = accion;

        await _completar(req, instanceID, "liberar",
            _armarContextoBpa(usuario, comentario));

        LOG.info(`liberadorLiberar OK | instanceID=${instanceID}`);
        return _responder(req, "Liberación enviada");
    });

    /**
     * El liberador rechaza la propuesta.
     * BPA devuelve el flujo al estado previo (según gateway de BPA).
     */
    srv.on("liberadorRechazar", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "rechazar");

        const { instanceID, usuario, comentario } = accion;

        if (!comentario) {
            return req.error(400, "El comentario es obligatorio al rechazar una propuesta");
        }

        await _completar(req, instanceID, "rechazar",
            _armarContextoBpa(usuario, comentario));

        LOG.info(`liberadorRechazar OK | instanceID=${instanceID}`);
        return _responder(req, "Rechazo enviado");
    });

    /**
     * El liberador anula definitivamente la propuesta de nómina.
     * Acción irreversible: BPA cierra el proceso completo.
     */
    srv.on("liberadorAnular", "TareasInbox", async (req) => {
        const accion = await _prepararAccion(req, "anular");

        const { instanceID, usuario, comentario } = accion;

        if (!comentario) {
            return req.error(400, "El comentario es obligatorio al anular una propuesta");
        }

        await _completar(req, instanceID, "anular",
            _armarContextoBpa(usuario, comentario));

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