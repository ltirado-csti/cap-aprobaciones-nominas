"use strict";
/**
 * srv/domain/aprobacion.service.js
 *
 * Handlers de las acciones bound de TareasInbox (aprobación de nómina).
 *
 * Roles activos BPA v1.2.0 (H2H Nomina 1.5.0):
 *   Apoderado: aprobar | rechazar          (contexto: startEvent.body)
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
 *   flags       : object,
 *   etiqueta    : string
 * }>}
 */
/**
 * Antepone el título de la tarea al mensaje de error.
 *
 * POR QUÉ
 * -------
 * En una acción masiva Fiori Elements invoca la acción una vez por fila, así que
 * un lote con varias tareas en el mismo estado producía N errores de texto
 * IDÉNTICO en el diálogo, sin nada que dijera a qué propuesta pertenece cada
 * uno. La lista existía pero no era accionable: el usuario no podía saber cuáles
 * de las que seleccionó se quedaron fuera.
 *
 * La etiqueta es el `subject` de BPA, que es exactamente el texto que la bandeja
 * muestra en la columna "Propuesta" (pagos-service.js lo mapea a tituloTarea),
 * de modo que el error se puede casar con la fila a simple vista.
 *
 * Sin etiqueta —errores anteriores a que BPA conteste— devuelve el mensaje tal
 * cual: en ese punto no hay tarea que nombrar, y anteponer el GUID del
 * instanceID no le diría nada a nadie.
 */
function _conEtiqueta(etiqueta, mensaje) {
    return etiqueta ? `${etiqueta}: ${mensaje}` : mensaje;
}

async function _prepararAccion(req, decision) {
    // 1. Clave de la tarea desde los parámetros de ruta OData (nunca del body)
    const instanceID = req.params?.[0]?.instanceID ?? req.params?.[0];
    if (!instanceID) {
        return req.reject(400, "Falta el identificador de tarea (instanceID)");
    }

    // 2. Leer de BPA la tarea (para el taskDefinitionId) y el contexto (para la
    //    propuesta y el quórum).
    //
    //    Van EN PARALELO y no encadenadas: son dos GET independientes contra el
    //    mismo destino y ninguna necesita el resultado de la otra. Encadenarlas
    //    añadía un round trip completo a BPA a cada clic del usuario, delante de
    //    un PATCH que ya cuesta otro. Se conserva el contexto ENTERO además de la
    //    propuesta: la rama `custom` lleva el estado del quórum y volver a pedirla
    //    sería una tercera llamada por el mismo dato.
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

    // obtenerTarea DEVUELVE null cuando falla — no lanza. Sin esta comprobación
    // el `.definitionId` de abajo reventaba con un TypeError fuera de cualquier
    // try, y el usuario recibía un 500 crudo en lugar del 502 que este bloque
    // pretendía dar. El mismo trato para readContext, que también degrada a null.
    if (!tareaBpa) {
        LOG.error(`_prepararAccion | tarea no legible en BPA | instanceID=${instanceID}`);
        return req.reject(502, "No se pudo consultar la tarea en BPA Workflow");
    }

    // Título de la tarea, para etiquetar todo error a partir de aquí. Es el
    // mismo texto que el usuario ve en la columna "Propuesta" de la bandeja.
    // Se completa más abajo desde la propuesta si BPA no trae subject.
    let etiqueta = (tareaBpa.subject || "").trim();

    // Normalizar el taskDefinitionId (BPA puede devolverlo como "form_xxx@defId")
    const taskDefId = (tareaBpa.definitionId || "").split("@")[0];

    // 3. Resolver el rol a partir del taskDefinitionId (la fuente de verdad)
    const rolBpa = perfiles.resolverRolBpa(taskDefId);
    if (!rolBpa || !rolBpa.activo) {
        LOG.error(`_prepararAccion | rol inactivo o desconocido | taskDefId=${taskDefId}`);
        return req.reject(403, _conEtiqueta(etiqueta,
            "Esta tarea no corresponde a un rol activo en el flujo de aprobación"));
    }

    // 4. Validar que la decisión es válida para este rol (anti-tampering)
    if (!perfiles.esDecisionValida(taskDefId, decision)) {
        LOG.error(`_prepararAccion | decisión inválida | decision=${decision} taskDefId=${taskDefId}`);
        return req.reject(400, _conEtiqueta(etiqueta,
            `La decisión "${decision}" no es válida para este rol`));
    }

    // 5. Extraer la propuesta del contexto ya leído en el paso 2 (ruta según el
    //    rol). No hay llamada nueva a BPA aquí: navegar la ruta es trabajo local.
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

    // BPA siempre trae subject, pero si faltara la etiqueta se toma de la
    // propuesta — mismo orden de respaldo que usa el mapeo de la bandeja.
    etiqueta = etiqueta || (propuesta.tituloTarea || propuesta.numeroPropuesta || "").trim();

    // 6. Usuario autenticado desde XSUAA (única fuente de verdad del firmante).
    //
    //    Se normaliza aquí, en el punto de entrada, y no en cada consumidor: de
    //    este `usuario` dependen la autorización del paso 7 Y el emailFirmante
    //    que viaja a BPA en _armarContextoBpa. Un id con basura —el caso real
    //    fue una coma arrastrada al copiar un correo de la lista CSV de
    //    apoderados— rompía las dos cosas: 403 al firmante legítimo y, de haber
    //    pasado, un emailFirmante que el script `Registrar firma` no reconoce,
    //    con el contador del quórum congelado. Ver perfiles.normalizarUsuario.
    const usuario = perfiles.normalizarUsuario(req.user.id);
    if (!usuario) {
        LOG.error(`_prepararAccion | identidad no utilizable | instanceID=${instanceID} raw=${req.user.id}`);
        return req.reject(403, _conEtiqueta(etiqueta,
            "No se pudo determinar su identidad de usuario para firmar esta propuesta"));
    }

    // 7. Autorización por pertenencia — para los dos roles de pool.
    //
    //    Con un pool de destinatarios, BPA reparte la tarea entre TODOS los que
    //    aún pueden actuar. Repetir esa comprobación aquí cierra dos puertas: la
    //    de un usuario que invoca la acción OData directamente sin tener la
    //    tarea, y la del apoderado que intenta firmar dos veces la misma
    //    propuesta (que además rompería el quórum, porque el script
    //    `Registrar firma` cuenta firmantes distintos).
    //
    //    EL LIBERADOR TAMBIÉN ENTRA. Antes no: se daba por hecho que su
    //    destinatario era uno solo y que BPA no le entregaría la tarea a nadie
    //    más, así que no había nada que comprobar. Con `usuarioLiberador` como
    //    lista de N correos esa premisa desapareció, y sin esta comprobación
    //    cualquier usuario autenticado con el instanceID a mano podría liberar
    //    una propuesta que no le corresponde. Su lista no tiene firmantes que
    //    descontar —una sola liberación cierra el paso—, así que en la práctica
    //    comprueba "figura en usuarioLiberador".
    if (rolBpa.esPool && !perfiles.esDestinatarioAutorizado(usuario, contexto, propuesta, rolBpa)) {
        const { pendientes } = perfiles.resolverDestinatarios(rolBpa, contexto, propuesta);
        // Los valores van ENTRECOMILLADOS: la lista de pendientes se separa por
        // comas, así que un correo con una coma pegada era indistinguible de dos
        // correos al leer el log — justo el rastro del fallo que introdujo
        // normalizarUsuario, y que tardó en verse por no poder leerlo aquí.
        LOG.warn(
            `_prepararAccion | destinatario fuera del pool | instanceID=${instanceID} ` +
            `rol=${rolBpa.label} usuario="${usuario}" pendientes="${pendientes.join(",") || "(vacío)"}"`
        );
        return req.reject(403, _conEtiqueta(etiqueta, _motivoNoAutorizado(rolBpa)));
    }

    // 8. Comentario: único dato aceptado del cliente
    const comentario = (req.data?.comentario ?? "").trim();

    // 9. Calcular flags de rol (para logs y respuesta)
    const flags = perfiles.calcularFlagsRol(taskDefId);

    LOG.info(
        `_prepararAccion OK | instanceID=${instanceID} usuario=${usuario} ` +
        `rol=${taskDefId} decision=${decision}`
    );

    return { instanceID, contexto, propuesta, usuario, comentario, taskDefId, rolBpa, flags, etiqueta };
}

/**
 * Por qué se le niega la acción, en los términos de SU rol.
 *
 * El mensaje del apoderado habla del quórum —"si ya firmó, la tarea sigue
 * visible"— y ese es justo el caso que más se da. Dárselo al liberador sería
 * mentirle: su paso no tiene quórum ni segunda firma, y solo puede estar aquí
 * por no figurar en la lista de la propuesta.
 */
function _motivoNoAutorizado(rolBpa) {
    if (rolBpa.campoPendientes) {
        return "Usted no figura entre los apoderados que aún pueden firmar esta propuesta. " +
               "Si ya firmó, la tarea sigue visible hasta que el segundo apoderado la complete.";
    }
    return "Usted no figura entre los destinatarios designados para liberar esta propuesta. " +
           "Si la tarea le fue reasignada hace un momento, vuelva a abrirla desde su bandeja.";
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
 * @param {string} [etiqueta] - título de la tarea, para identificarla en el
 *                              diálogo de errores de una acción masiva
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

// =============================================================================
// FUNCIÓN INTERNA: _responder
// Emite el resultado como MENSAJE OData además de devolverlo en el cuerpo.
// =============================================================================

/**
 * Clave del registro de mensajes ya emitidos en la petición HTTP en curso.
 * Símbolo, y no string, para no chocar con nada que CAP guarde en ese objeto.
 */
const MENSAJES_EMITIDOS = Symbol.for("h2h.mensajes-emitidos");

/**
 * ¿Es la primera vez que este texto se emite en la petición HTTP actual?
 * Marca y responde en la misma llamada.
 *
 * El registro se cuelga de la petición EXPRESS (`req.http.req`), no de
 * `cds.context`. Es deliberado: las acciones de un $batch viajan dentro de
 * changesets, cada changeset abre su propia transacción y no está garantizado
 * que el contexto CAP sea el mismo objeto en todas las entradas. El objeto
 * `http` sí lo es —hay una sola petición HTTP— así que es el ancla fiable para
 * "una vez por lote". Se cae a `cds.context` y luego a "sí, es la primera"
 * cuando no hay HTTP detrás (una llamada interna o un test), donde no hay lote
 * que deduplicar y el comportamiento es el de siempre.
 */
function _primeraVezEnLaPeticion(req, mensaje) {
    const ancla = req?.http?.req ?? cds.context?.http?.req ?? cds.context;
    if (!ancla) return true;

    const emitidos = (ancla[MENSAJES_EMITIDOS] ??= new Set());
    if (emitidos.has(mensaje)) return false;

    // Sin await entre la consulta y la marca: aunque CAP procese varias entradas
    // del $batch en paralelo (odata.max_batch_parallelization), este tramo es
    // atómico para el bucle de eventos y no hay carrera posible.
    emitidos.add(mensaje);
    return true;
}

/**
 * Construye la respuesta de una acción de aprobación.
 *
 * Por qué req.info() y no sólo el campo `mensaje` del cuerpo:
 *   Los botones provienen de anotaciones (DataFieldForAction), así que los
 *   ejecuta Fiori Elements de forma nativa — no el controller de la app. FE NO
 *   muestra el cuerpo de respuesta de una acción, pero SÍ despliega
 *   automáticamente los mensajes que llegan en la cabecera `sap-messages`, que
 *   es lo que req.info() alimenta. Sin esto no hay confirmación visible.
 *
 * Por qué el texto no afirma que Payroll aceptó:
 *   completarTarea sólo obtiene el ACK de BPA. La notificación a Payroll corre
 *   después, de forma asíncrona. Si Payroll rechaza, BPA hace loop back y la
 *   tarea reaparece en el inbox con el motivo visible (notifTieneError /
 *   notifMensaje). Prometer éxito aquí sería mentirle al usuario: por eso
 *   "la operación será validada" y no "aprobada".
 *
 * POR QUÉ EL MENSAJE SE EMITE UNA SOLA VEZ
 * ----------------------------------------
 * En las acciones masivas del List Report, Fiori Elements no invoca una acción
 * "de lote": invoca la MISMA acción bound una vez por fila seleccionada, todas
 * dentro de un único $batch. Cada invocación pasaba por aquí y añadía su propio
 * mensaje, así que aprobar 8 propuestas abría un diálogo con 8 confirmaciones
 * idénticas — ruido que además obliga a leerlas todas para descartar que alguna
 * diga otra cosa.
 *
 * El registro de textos ya emitidos se cuelga de la petición HTTP que envuelve
 * al $batch —compartida por todas sus entradas—, de modo que el primer éxito
 * emite el mensaje y los demás lo omiten: una confirmación por lote. Misma idea
 * de "estado con vida útil de una petición" que infrastructure/memo-peticion.js.
 *
 * Los ERRORES no pasan por aquí. Cada fallo sale por req.error/req.reject en su
 * propia entrada del $batch, con su instanceID y su motivo, y FE los lista uno
 * por tarea — que es justo lo que hace falta para saber cuáles no salieron.
 * Un lote parcialmente fallido muestra, por tanto, una confirmación y tantos
 * errores como tareas fallidas.
 *
 * La deduplicación es por TEXTO, no por acción: dos decisiones distintas en el
 * mismo lote conservan cada una su mensaje.
 *
 * @param {import('@sap/cds').Request} req
 * @param {string} accion - texto en pasado, ej. "Aprobación enviada"
 * @returns {{ exito: boolean, mensaje: string }}
 */
function _responder(req, accion) {
    const mensaje = `${accion} correctamente. La operación será validada.`;

    // El cuerpo sí lo lleva siempre: es la respuesta de ESTA invocación y hay
    // consumidores del servicio que no son Fiori Elements.
    if (_primeraVezEnLaPeticion(req, mensaje)) req.info(mensaje);

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

        const { instanceID, usuario, comentario, etiqueta } = accion;

        await _completar(req, instanceID, "aprobar",
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`apoderadoAprobar OK | instanceID=${instanceID} firmante=${usuario}`);
        return _responder(req, "Aprobación enviada");
    });

    /**
     * El apoderado rechaza la propuesta (devuelve con nota al analista).
     *
     * El rechazo NO entra al quórum: cierra el subproceso de apoderados por
     * la vía "Notificación de rechazo", sin loop back. Un solo rechazo
     * basta, no hacen falta dos.
     */
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

        const { instanceID, usuario, comentario, etiqueta } = accion;

        await _completar(req, instanceID, "liberar",
            _armarContextoBpa(usuario, comentario), etiqueta);

        LOG.info(`liberadorLiberar OK | instanceID=${instanceID}`);
        return _responder(req, "Liberación enviada");
    });

    /**
     * El liberador rechaza la propuesta.
     * BPA devuelve el flujo al estado previo (según gateway de BPA).
     */
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

    /**
     * El liberador anula definitivamente la propuesta de nómina.
     * Acción irreversible: BPA cierra el proceso completo.
     */
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