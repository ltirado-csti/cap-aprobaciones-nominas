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
 *   getInboxTasks()              → GET  /v1/task-instances
 *   readContext(taskId)          → GET  /v1/task-instances/{id}/context
 *   completarTarea(...)          → PATCH /v1/task-instances/{id}
 *   cerrarFlujo(instanceId)      → PATCH /v1/workflow-instances/{id}
 */

const cds = require("@sap/cds");
const LOG = cds.log("bpa-client");

// Singleton de conexión al destino BPA_WORKFLOW
let _svc;
const getSvc = async () => (_svc ??= await cds.connect.to("BPA_WORKFLOW"));

// ─── OBTENER TAREAS DEL INBOX ─────────────────────────────────────────────────

/**
 * Obtiene las tareas pendientes del Inbox para el usuario autenticado.
 * Máximo 20 tareas — suficiente para una bandeja de aprobación de nómina.
 *
 * Endpoint verificado: GET /public/workflow/rest/v1/task-instances
 *
 * @returns {Promise<Array>} Lista de tareas BPA sin transformar (máx. 20)
 */
async function getInboxTasks() {
  const svc = await getSvc();

  const tareas = await svc.get("/task-instances", {
    "$filter" : "status eq 'READY'",
    "$orderby": "createdAt desc",
    "$top"    : 20
  });

  LOG.info(`getInboxTasks OK | tareas=${tareas?.length ?? 0}`);
  return Array.isArray(tareas) ? tareas : [];
}

// ─── LEER CONTEXTO ────────────────────────────────────────────────────────────

/**
 * Lee el contexto de una tarea BPA.
 * Origen legado: ContextModel.readContext(sTaskID) en Detail.controller.js
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   GET /v1/task-instances/{taskId}/context
 *
 * Retorna el objeto contexto del BPA con los campos de negocio H2H:
 *   tituloTarea, numeroPropuesta, sociedad, banco, importe, flags de rol...
 *
 * @param {string} taskId - ID de la tarea BPA (campo "id" del TaskInstance)
 * @returns {Promise<object|null>} Contexto de la tarea o null si falla
 */
async function readContext(taskId) {
  const svc = await getSvc();
  try {
    const res = await svc.get(`/task-instances/${taskId}/context`);
    LOG.info(`readContext OK | taskId=${taskId}`);
    return res;
  } catch (err) {
    LOG.error(`readContext ERROR | taskId=${taskId}`, err.message);
    return null;
  }
}

// ─── COMPLETAR TAREA ──────────────────────────────────────────────────────────

/**
 * Completa una tarea del Inbox de BPA actualizando su contexto.
 * Origen legado: ContextModel.triggerComplete() en Detail.controller.js
 *
 * Endpoint verificado en SPA_Workflow_Runtime.json:
 *   PATCH /v1/task-instances/{taskId}
 *   Body: { status: "COMPLETED", context: {...} }
 *
 * @param {string} taskId   - ID de la tarea BPA
 * @param {string} accion   - "confirm" | "Reject"
 * @param {object} params   - datos de la aprobación
 * @returns {Promise<{ success: boolean, mensaje: string }>}
 */
async function completarTarea(taskId, accion, {
  pp, currentUser, rol, aprobado, comentario = "",
  contexto, oApoReg = null, hanaPath = ""
}) {
  const svc  = await getSvc();
  const now  = new Date();

  // Payload verificado contra Detail.controller.js → completarTareaWF()
  const oPeticion = {
    TaskID          : taskId,
    ApoRegIndicador : oApoReg ? "OK" : "",
    ApoReg          : oApoReg ?? "",
    AprobacionPP: {
      Aprobacion: {
        FechaAprob  : now,
        HoraAprob   : `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`,
        Fecha       : `${now.getDate()}-${now.getMonth() + 1}-${now.getFullYear()}`,
        Usuario     : currentUser.name,
        NroPP       : pp.NroPP,
        Sociedad    : pp.Sociedad,
        FechaPP     : pp.FechaPP,
        EstadoPP    : pp.EstadoPP,
        RolID       : rol,
        Correo      : currentUser.name,
        Aprobado    : aprobado,
        Observacion : comentario,
      },
      Propuesta: {
        NroPP           : pp.NroPP,
        Sociedad        : pp.Sociedad,
        FechaPP         : pp.FechaPP,
        EstadoPP        : pp.EstadoPP,
        FechaPPJS       : pp.FechaPPJS,
        Importe         : pp.Importe,
        Moneda          : pp.Moneda,
        UsrCreacionPP   : pp.UsrCreacionPP,
        ModalidadPP     : pp.ModalidadPP,
        ExisteDoc       : pp.ExisteDoc,
        ViaPago         : pp.ViaPago,
        BancoDescripcion: pp.BancoDescripcion,
        Banco           : pp.Banco,
        Version         : pp.Version,
        IdInstanciaWF   : taskId,
        UserCrea        : pp.UserCrea,
        UserModif       : currentUser.name,
        Analista        : pp.Analista,
        CorreoAnalista  : pp.CorreoAnalista,
        IndPAdelanto    : pp.IndPAdelanto,
      },
      Path: hanaPath,
    },
    WorkFlowData: {
      status : "COMPLETED",
      stage  : accion,
      context: contexto,
    },
  };

  try {
    // PATCH /v1/task-instances/{taskId} — verificado en SPA_Workflow_Runtime.json
    await svc.patch(`/task-instances/${taskId}`, {
      status : accion === "confirm" ? "COMPLETED" : "FAILED",
      context: oPeticion,
    });

    LOG.info(`completarTarea OK | taskId=${taskId} accion=${accion} rol=${rol}`);
    return { success: true, mensaje: "Tarea completada correctamente" };
  } catch (err) {
    LOG.error(`completarTarea ERROR | taskId=${taskId}`, err.message);
    return { success: false, mensaje: err.message };
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
  } catch (err) {
    LOG.error(`cerrarFlujo ERROR | instanceId=${instanceId}`, err.message);
    return { success: false, mensaje: err.message };
  }
}

module.exports = {
  getInboxTasks,
  readContext,
  completarTarea,
  cerrarFlujo,
};