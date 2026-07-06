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
 *   obtenerTarea(taskId)                  → GET   /v1/task-instances/{id}
 *   readContext(taskId)                   → GET   /v1/task-instances/{id}/context
 *   completarTarea(taskId, opciones)      → PATCH /v1/task-instances/{id}
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
 * @returns {Promise<Array>} Lista de tareas BPA sin transformar (máx. 20)
 */
async function getInboxTasks() {
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
 * proceso (startEvent.propuesta o startEvent.body — ver perfiles.PROCESOS).
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
 * @param {string} taskId            - ID de la user task BPA
 * @param {object} opciones
 * @param {string} opciones.decision - ID de decision del formulario BPA
 * @param {object} opciones.contexto - Contexto a escribir al completar
 * @returns {Promise<{ success: boolean, mensaje: string }>}
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
    return { success: true, mensaje: "Tarea completada correctamente" };
  } catch (error) {
    LOG.error(`completarTarea ERROR | taskId=${taskId}`, error.message);
    return { success: false, mensaje: error.message };
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
  obtenerTarea,
  readContext,
  completarTarea,
  iniciarInstancia,
  obtenerEstadoInstancia,
  cerrarFlujo,
};