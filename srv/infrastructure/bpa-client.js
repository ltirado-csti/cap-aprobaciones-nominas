"use strict";
/**
 * srv/infrastructure/bpa-client.js
 *
 * Acceso a SAP Build Process Automation — Workflow Runtime REST API v1.
 * Especificación oficial verificada: SPA_Workflow_Runtime.json
 *
 * Base URL del destino BPA_WORKFLOW:
 *   https://{host}/public/workflow/rest
 *
 * Todos los endpoints usan el prefijo /v1 verificado en el JSON oficial.
 *
 * Métodos expuestos:
 *   getInboxTasks()                       → GET   /v1/task-instances
 *   listarTareasEnCurso()                 → GET   /v1/task-instances (todos los usuarios)
 *   obtenerTarea(taskId)                  → GET   /v1/task-instances/{id}
 *   readContext(taskId)                   → GET   /v1/task-instances/{id}/context
 *   completarTarea(taskId, opciones)      → PATCH /v1/task-instances/{id}
 *   reasignarTarea(taskId, nuevoUsuario)  → PATCH /v1/task-instances/{id}
 *   iniciarInstancia(definitionId, ctx)   → POST  /v1/workflow-instances
 *   obtenerEstadoInstancia(instanceId)    → GET   /v1/workflow-instances/{id}
 *   cerrarFlujo(instanceId)               → PATCH /v1/workflow-instances/{id}
 */

const cds = require("@sap/cds");
const LOG = cds.log("bpa-client");

// Singleton de conexión al destino BPA_WORKFLOW
let _svc;
const getSvc = async () => (_svc ??= await cds.connect.to("BPA_WORKFLOW"));

// ─── OBTENER TAREAS DEL INBOX ─────────────────────────────────────────────────

/**
 * Endpoint verificado: GET /public/workflow/rest/v1/task-instances
 *
 * @param {string} usuario - email del usuario autenticado (req.user.id)
 * @returns {Promise<Array>} Lista de tareas BPA sin transformar (máx. 20)
 */
async function getInboxTasks(usuario) {
  // Salvaguarda: sin usuario no se consulta BPA — evita exponer tareas ajenas
  if (!usuario) {
    LOG.warn("getInboxTasks | usuario no informado — se retorna lista vacía");
    return [];
  }
 
  const svc = await getSvc();
 
  // Los parámetros van en la query string: es la forma inequívoca de enviarlos
  // en un servicio remoto REST de CAP (el objeto como segundo argumento no
  // garantiza serialización como query params)
  const parametros = new URLSearchParams({
    status         : "READY",
    recipientUsers : usuario,
    "$orderby"     : "createdAt desc",
    "$top"         : "100",
  });
 
  const tareas = await svc.get(`/task-instances?${parametros.toString()}`);
 
  LOG.info(`getInboxTasks OK | usuario=${usuario} tareas=${tareas?.length ?? 0}`);
  return Array.isArray(tareas) ? tareas : [];
}

// ─── LISTAR TAREAS EN CURSO (TODOS LOS USUARIOS) ──────────────────────────────

/**
 * Lista las tareas de aprobación en curso (READY o RESERVED) de TODOS los
 * usuarios, sin filtrar por recipientUsers. Usada por la app de reasignación
 * para que un administrador pueda ver y reasignar tareas ajenas.
 *
 * IMPORTANTE: a diferencia de getInboxTasks(), esta consulta requiere que la
 * IDENTIDAD detrás del destino BPA_WORKFLOW (no el destino en sí — los role
 * collections se asignan a identidades, nunca a un destino) tenga el role
 * collection "WorkflowAdmin" en el subaccount de Process Automation. Sin él,
 * BPA solo devuelve tareas del propio usuario autenticado.
 * Pendiente de confirmar con el administrador del subaccount de BPA: el
 * destino actual (sap_process_automation_service, vía cds bind) autentica
 * como un cliente OAuth técnico (client credentials) — falta verificar si
 * WorkflowAdmin puede otorgarse a ese principal técnico o si esta llamada
 * exige el token de un usuario de negocio real con el rol asignado.
 *
 * Endpoint verificado: GET /public/workflow/rest/v1/task-instances
 *
 * @returns {Promise<Array>} Lista combinada de tareas BPA sin transformar (READY + RESERVED)
 */
async function listarTareasEnCurso() {
  const svc = await getSvc();
  const estados = ["READY", "RESERVED"];

  const resultados = await Promise.all(estados.map(async (status) => {
    const parametros = new URLSearchParams({
      status,
      "$orderby": "createdAt desc",
      "$top"    : "200",
    });
    try {
      const tareas = await svc.get(`/task-instances?${parametros.toString()}`);
      return Array.isArray(tareas) ? tareas : [];
    } catch (error) {
      LOG.error(`listarTareasEnCurso ERROR | status=${status}`, error.message);
      return [];
    }
  }));

  const todas = resultados.flat();
  LOG.info(`listarTareasEnCurso OK | total=${todas.length}`);
  return todas;
}

// ─── OBTENER TAREA INDIVIDUAL ─────────────────────────────────────────────────

/**
 * Obtiene una tarea individual del BPA por su ID.
 * Necesaria en la ruta Object Page para conocer el activityId (taskDefinitionId)
 * del que se derivan los flags de visibilidad por rol (perfiles.calcularFlagsRol).
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   GET /v1/task-instances/{taskInstanceId}
 *
 * @param {string} taskId - ID de la tarea BPA (campo "id" del TaskInstance)
 * @returns {Promise<object|null>} TaskInstance completo (incluye activityId) o null si falla
 */
async function obtenerTarea(taskId) {
  const svc = await getSvc();
  try {
    const tarea = await svc.get(`/task-instances/${taskId}`);
    LOG.info(`obtenerTarea OK | taskId=${taskId}`);
    return tarea;
  } catch (error) {
    LOG.error(`obtenerTarea ERROR | taskId=${taskId}`, error.message);
    return null;
  }
}

// ─── LEER CONTEXTO ────────────────────────────────────────────────────────────

/**
 * Lee el contexto de una tarea BPA.
 * Origen legado: ContextModel.readContext(taskId) en Detail.controller.js
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   GET /v1/task-instances/{taskId}/context
 *
 * Retorna el objeto contexto del BPA con la PropuestaNomina anidada según el
 * proceso (startEvent.propuesta o startEvent.body — ver perfiles.ROLES_BPA).
 *
 * Incluye también la rama `custom` — las variables personalizadas de la
 * instancia—, que es de donde salen el resultado de la notificación a Payroll y
 * el estado del quórum de apoderados. Por eso NO hace falta un método aparte
 * contra /workflow-instances/{id}/context: el contexto de la tarea ya trae el
 * de su instancia, y este endpoint no necesita resolver ningún processInstanceId.
 *
 * @param {string} taskId - ID de la tarea BPA (campo "id" del TaskInstance)
 * @returns {Promise<object|null>} Contexto de la tarea o null si falla
 */
async function readContext(taskId) {
  const svc = await getSvc();
  try {
    const contexto = await svc.get(`/task-instances/${taskId}/context`);
    LOG.info(`readContext OK | taskId=${taskId}`);
    return contexto;
  } catch (error) {
    LOG.error(`readContext ERROR | taskId=${taskId}`, error.message);
    return null;
  }
}

// ─── COMPLETAR TAREA ──────────────────────────────────────────────────────────

/**
 * Completa una user task del Inbox de BPA con su decision y contexto actualizado.
 *
 * El payload sigue el schema UpdateTaskInstancePayload del API oficial:
 *   - status   : siempre "COMPLETED" (la ruta del flujo la decide la decision,
 *                no el status — "FAILED" del legado era incorrecto)
 *   - decision : ID real del botón del formulario BPA, resuelto por
 *                perfiles.resolverDecision() (ej. "aprobar", "approve", "cancel")
 *   - context  : contexto BPA con la PropuestaNomina anidada según el proceso
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   PATCH /v1/task-instances/{taskId}
 *
 * El `status` de la respuesta de BPA se PROPAGA al llamador. Es lo que permite
 * distinguir un fallo técnico de la carrera entre dos apoderados del pool: con
 * el quórum de v1.2.0 la tarea es una sola y el primero que la completa la cierra
 * para el resto, así que el segundo recibe 404/409 de BPA. Eso no es un error de
 * sistema, es un mensaje de negocio ("otro apoderado se te adelantó") y la capa
 * de dominio necesita el código para decirlo así. Ver aprobacion.service.js.
 *
 * @param {string} taskId            - ID de la user task BPA
 * @param {object} opciones
 * @param {string} opciones.decision - ID de decision del formulario BPA
 * @param {object} opciones.contexto - Contexto a escribir al completar
 * @returns {Promise<{ success: boolean, mensaje: string, status: number|null }>}
 */
async function completarTarea(taskId, { decision, contexto }) {
  const svc = await getSvc();
  try {
    await svc.patch(`/task-instances/${taskId}`, {
      status  : "COMPLETED",
      decision,
      context : contexto,
    });

    LOG.info(`completarTarea OK | taskId=${taskId} decision=${decision}`);
    return { success: true, mensaje: "Tarea completada correctamente", status: 200 };
  } catch (error) {
    const status = _codigoHttp(error);
    LOG.error(`completarTarea ERROR | taskId=${taskId} status=${status ?? "?"}`, error.message);
    return { success: false, mensaje: error.message, status };
  }
}

/**
 * Extrae el código HTTP de un error de un servicio remoto de CAP.
 *
 * No hay una sola propiedad fiable: según por dónde falle, el código llega en
 * `status`, en `code` (a veces como texto) o en la respuesta cruda. Se prueban
 * las tres en vez de asumir una, y se devuelve null si ninguna trae un número —
 * mejor "no se sabe" que un 0 que el llamador interpretaría como código real.
 */
function _codigoHttp(error) {
  const candidatos = [error?.status, error?.statusCode, error?.response?.status, error?.code];
  for (const candidato of candidatos) {
    const numero = Number(candidato);
    if (Number.isInteger(numero) && numero >= 100 && numero < 600) return numero;
  }
  return null;
}

// ─── REASIGNAR TAREA A OTRO USUARIO ───────────────────────────────────────────

/**
 * Reemplaza los destinatarios (recipientUsers) de una tarea BPA. Usada por la
 * app de reasignación cuando un destinatario original no está disponible.
 *
 * ADMITE VARIOS DESTINATARIOS, y eso no es un extra: desde el quórum de v1.2.0
 * la tarea de apoderado es una sola con un POOL de N destinatarios. Reasignar
 * enviando un único correo la dejaría con un solo destinatario y expulsaría del
 * flujo a los apoderados que no habían firmado todavía. Quien llama compone la
 * lista completa ya sustituida; aquí solo se serializa.
 *
 * IMPORTANTE: requiere que la IDENTIDAD detrás del destino BPA_WORKFLOW
 * (el role collection se asigna a esa identidad, no al destino) tenga el
 * role collection "WorkflowAdmin" en el subaccount de Process Automation —
 * sin él, BPA rechaza el PATCH con 403. Ver nota de verificación pendiente
 * en listarTareasEnCurso() sobre si esto exige un usuario de negocio real
 * en vez del cliente OAuth técnico del destino actual.
 *
 * Endpoint verificado: PATCH /public/workflow/rest/v1/task-instances/{taskInstanceId}
 *
 * @param {string} taskId              - ID de la tarea BPA
 * @param {string|string[]} destinatarios - correo, CSV o array de correos
 * @returns {Promise<{ success: boolean, mensaje: string, status: number|null }>}
 */
async function reasignarTarea(taskId, destinatarios) {
  const svc = await getSvc();

  // recipientUsers es un string simple en el schema de BPA, NO un array
  // — enviarlo como array dispara "Unable to parse the request content
  // because it has an unexpected format or structure". Varios destinatarios
  // van en ese mismo string separados por coma, igual que hace el binding de
  // BPA con context.custom.apoderadospendientes.
  const lista = (Array.isArray(destinatarios) ? destinatarios : [destinatarios])
    .flatMap(entrada => String(entrada ?? "").split(","))
    .map(correo => correo.trim())
    .filter(Boolean)
    .join(",");

  try {
    await svc.patch(`/task-instances/${taskId}`, {
      recipientUsers: lista,
    });

    LOG.info(`reasignarTarea OK | taskId=${taskId} destinatarios=${lista}`);
    return { success: true, mensaje: "Tarea reasignada correctamente", status: 200 };
  } catch (error) {
    const status = _codigoHttp(error);
    LOG.error(`reasignarTarea ERROR | taskId=${taskId} status=${status ?? "?"}`, error.message);
    return { success: false, mensaje: error.message, status };
  }
}

// ─── INICIAR INSTANCIA ────────────────────────────────────────────────────────

/**
 * Inicia una nueva instancia de workflow BPA.
 * La usa el Analista al enviar el lote: arranca el proceso aprobacionDeNomina
 * (perfiles.PROCESOS.aprobacionDeNomina.definitionId).
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   POST /v1/workflow-instances
 *   Body: { definitionId, context }
 *
 * @param {string} definitionId - ID cualificado del workflow (perfiles.PROCESOS)
 * @param {object} contexto     - Contexto inicial con la PropuestaNomina anidada
 * @returns {Promise<{ success: boolean, mensaje: string, instanceId: string|null }>}
 */
async function iniciarInstancia(definitionId, contexto) {
  const svc = await getSvc();
  try {
    const instancia = await svc.post("/workflow-instances", {
      definitionId,
      context: contexto,
    });

    LOG.info(`iniciarInstancia OK | definitionId=${definitionId} instanceId=${instancia?.id}`);
    return {
      success   : true,
      mensaje   : "Instancia de workflow iniciada correctamente",
      instanceId: instancia?.id ?? null,
    };
  } catch (error) {
    LOG.error(`iniciarInstancia ERROR | definitionId=${definitionId}`, error.message);
    return { success: false, mensaje: error.message, instanceId: null };
  }
}

// ─── OBTENER ESTADO DE INSTANCIA ──────────────────────────────────────────────

/**
 * Obtiene el estado de una instancia de workflow BPA.
 * Útil para encadenar aprobacionFinal tras el fin de aprobacionDeNomina y
 * para diagnosticar instancias ERRONEOUS durante el desarrollo.
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   GET /v1/workflow-instances/{workflowInstanceId}
 *
 * @param {string} instanceId - ID de la instancia de workflow
 * @returns {Promise<object|null>} WorkflowInstance (incluye status) o null si falla
 */
async function obtenerEstadoInstancia(instanceId) {
  const svc = await getSvc();
  try {
    const instancia = await svc.get(`/workflow-instances/${instanceId}`);
    LOG.info(`obtenerEstadoInstancia OK | instanceId=${instanceId} status=${instancia?.status}`);
    return instancia;
  } catch (error) {
    LOG.error(`obtenerEstadoInstancia ERROR | instanceId=${instanceId}`, error.message);
    return null;
  }
}

// ─── CERRAR FLUJO ─────────────────────────────────────────────────────────────

/**
 * Cancela la instancia de workflow completa.
 * Origen legado: Supervisor.js → cerrarFlujo()
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   PATCH /v1/workflow-instances/{instanceId}
 *   Body: { status: "CANCELED" }
 *
 * @param {string} instanceId - workflowInstanceId del TaskInstance
 * @returns {Promise<{ success: boolean, mensaje: string }>}
 */
async function cerrarFlujo(instanceId) {
  const svc = await getSvc();
  try {
    await svc.patch(`/workflow-instances/${instanceId}`, { status: "CANCELED" });
    LOG.info(`cerrarFlujo OK | instanceId=${instanceId}`);
    return { success: true, mensaje: "Flujo cerrado correctamente" };
  } catch (error) {
    LOG.error(`cerrarFlujo ERROR | instanceId=${instanceId}`, error.message);
    return { success: false, mensaje: error.message };
  }
}

module.exports = {
  getInboxTasks,
  listarTareasEnCurso,
  obtenerTarea,
  readContext,
  completarTarea,
  reasignarTarea,
  iniciarInstancia,
  obtenerEstadoInstancia,
  cerrarFlujo,
};