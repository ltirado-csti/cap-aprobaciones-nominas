"use strict";
/**
 * Acceso a SAP Build Process Automation — Workflow Runtime REST API v1.
 * Destino BPA_WORKFLOW, base URL: https://{host}/public/workflow/rest
 */

const cds = require("@sap/cds");
const { conTimeoutBpa } = require("./con-timeout");

const LOG = cds.log("bpa-client");

let _svc;
const getSvc = async () => (_svc ??= await cds.connect.to("BPA_WORKFLOW"));

/**
 * Tareas READY del inbox del usuario. GET /v1/task-instances
 * @param {string} usuario - email del usuario autenticado (req.user.id)
 * @returns {Promise<Array>} tareas BPA sin transformar
 */
async function getInboxTasks(usuario) {
  if (!usuario) {
    LOG.warn("getInboxTasks | usuario no informado — se retorna lista vacía");
    return [];
  }

  const svc = await getSvc();

  const parametros = new URLSearchParams({
    status         : "READY",
    recipientUsers : usuario,
    "$orderby"     : "createdAt desc",
    "$top"         : "100",
  });

  const tareas = await conTimeoutBpa(
    svc.get(`/task-instances?${parametros.toString()}`), "getInboxTasks");

  LOG.info(`getInboxTasks OK | usuario=${usuario} tareas=${tareas?.length ?? 0}`);
  return Array.isArray(tareas) ? tareas : [];
}

/**
 * Tareas de aprobación en curso (READY o RESERVED) de todos los usuarios.
 * Usada por la app de reasignación. Requiere el role collection
 * "WorkflowAdmin" en la identidad del destino BPA_WORKFLOW.
 *
 * @returns {Promise<Array>} tareas BPA sin transformar (READY + RESERVED)
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
      const tareas = await conTimeoutBpa(
        svc.get(`/task-instances?${parametros.toString()}`), `listarTareasEnCurso(${status})`);
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

/**
 * Obtiene una tarea BPA por su ID, incluye activityId (taskDefinitionId).
 * GET /v1/task-instances/{taskInstanceId}
 * @param {string} taskId
 * @returns {Promise<object|null>} TaskInstance completo, o null si falla
 */
async function obtenerTarea(taskId) {
  const svc = await getSvc();
  try {
    const tarea = await conTimeoutBpa(svc.get(`/task-instances/${taskId}`), "obtenerTarea");
    LOG.info(`obtenerTarea OK | taskId=${taskId}`);
    return tarea;
  } catch (error) {
    LOG.error(`obtenerTarea ERROR | taskId=${taskId}`, error.message);
    return null;
  }
}

/**
 * Lee el contexto de una tarea BPA, incluida la rama `custom` (variables
 * personalizadas: notificación a Payroll y quórum de apoderados).
 * GET /v1/task-instances/{taskId}/context
 *
 * @param {string} taskId
 * @returns {Promise<object|null>} contexto de la tarea o null si falla
 */
async function readContext(taskId) {
  const svc = await getSvc();
  try {
    const contexto = await conTimeoutBpa(svc.get(`/task-instances/${taskId}/context`), "readContext");
    LOG.info(`readContext OK | taskId=${taskId}`);
    return contexto;
  } catch (error) {
    LOG.error(`readContext ERROR | taskId=${taskId}`, error.message);
    return null;
  }
}

/**
 * Completa una user task del inbox con su decisión y contexto actualizado.
 * PATCH /v1/task-instances/{taskId}. El `status` de la respuesta se propaga
 * al llamador: 404/409 distingue una carrera de firmas de un fallo técnico.
 *
 * @param {string} taskId
 * @param {object} opciones
 * @param {string} opciones.decision - ID de decisión del formulario BPA
 * @param {object} opciones.contexto - contexto a escribir al completar
 * @returns {Promise<{ success: boolean, mensaje: string, status: number|null }>}
 */
async function completarTarea(taskId, { decision, contexto }) {
  const svc = await getSvc();
  try {
    await conTimeoutBpa(svc.patch(`/task-instances/${taskId}`, {
      status  : "COMPLETED",
      decision,
      context : contexto,
    }), "completarTarea");

    LOG.info(`completarTarea OK | taskId=${taskId} decision=${decision}`);
    return { success: true, mensaje: "Tarea completada correctamente", status: 200 };
  } catch (error) {
    const status = _codigoHttp(error);
    LOG.error(`completarTarea ERROR | taskId=${taskId} status=${status ?? "?"}`, error.message);
    return { success: false, mensaje: error.message, status };
  }
}

/** Extrae el código HTTP de un error de un servicio remoto CAP, o null si no hay uno fiable. */
function _codigoHttp(error) {
  const candidatos = [error?.status, error?.statusCode, error?.response?.status, error?.code];
  for (const candidato of candidatos) {
    const numero = Number(candidato);
    if (Number.isInteger(numero) && numero >= 100 && numero < 600) return numero;
  }
  return null;
}

/**
 * Reemplaza los destinatarios (recipientUsers) de una tarea BPA. Admite
 * varios destinatarios (pool de apoderados/liberador): quien llama compone la
 * lista completa ya sustituida, aquí solo se serializa como CSV. Requiere el
 * role collection "WorkflowAdmin" en la identidad del destino.
 *
 * PATCH /v1/task-instances/{taskInstanceId}
 *
 * @param {string} taskId
 * @param {string|string[]} destinatarios - correo, CSV o array de correos
 * @returns {Promise<{ success: boolean, mensaje: string, status: number|null }>}
 */
async function reasignarTarea(taskId, destinatarios) {
  const svc = await getSvc();

  // recipientUsers es un string en el schema de BPA, no un array; varios
  // destinatarios van separados por coma en ese mismo string.
  const lista = (Array.isArray(destinatarios) ? destinatarios : [destinatarios])
    .flatMap(entrada => String(entrada ?? "").split(","))
    .map(correo => correo.trim())
    .filter(Boolean)
    .join(",");

  try {
    await conTimeoutBpa(svc.patch(`/task-instances/${taskId}`, {
      recipientUsers: lista,
    }), "reasignarTarea");

    LOG.info(`reasignarTarea OK | taskId=${taskId} destinatarios=${lista}`);
    return { success: true, mensaje: "Tarea reasignada correctamente", status: 200 };
  } catch (error) {
    const status = _codigoHttp(error);
    LOG.error(`reasignarTarea ERROR | taskId=${taskId} status=${status ?? "?"}`, error.message);
    return { success: false, mensaje: error.message, status };
  }
}

/**
 * Lee el contexto de una instancia de workflow (no el de una tarea) — el
 * mismo que escribe actualizarContextoInstancia.
 * GET /v1/workflow-instances/{workflowInstanceId}/context
 *
 * @param {string} instanceId - workflowInstanceId del TaskInstance
 * @returns {Promise<object|null>} contexto de la instancia o null si falla
 */
async function leerContextoInstancia(instanceId) {
  const svc = await getSvc();
  try {
    const contexto = await conTimeoutBpa(svc.get(`/workflow-instances/${instanceId}/context`), "leerContextoInstancia");
    LOG.info(`leerContextoInstancia OK | instanceId=${instanceId}`);
    return contexto;
  } catch (error) {
    LOG.error(`leerContextoInstancia ERROR | instanceId=${instanceId}`, error.message);
    return null;
  }
}

/**
 * Actualiza el contexto de una instancia de workflow en curso.
 * PATCH /v1/workflow-instances/{workflowInstanceId}/context — sustituye las
 * claves de primer nivel que recibe, sin merge en profundidad: quien llama
 * debe enviar la rama completa. Requiere "WorkflowAdmin" en el destino.
 *
 * @param {string} instanceId - workflowInstanceId del TaskInstance
 * @param {object} parche     - ramas de primer nivel del contexto, completas
 * @returns {Promise<{ success: boolean, mensaje: string, status: number|null }>}
 */
async function actualizarContextoInstancia(instanceId, parche) {
  const svc = await getSvc();
  try {
    await conTimeoutBpa(svc.patch(`/workflow-instances/${instanceId}/context`, parche), "actualizarContextoInstancia");
    LOG.info(`actualizarContextoInstancia OK | instanceId=${instanceId} claves=${Object.keys(parche).join(",")}`);
    return { success: true, mensaje: "Contexto actualizado correctamente", status: 200 };
  } catch (error) {
    const status = _codigoHttp(error);
    LOG.error(`actualizarContextoInstancia ERROR | instanceId=${instanceId} status=${status ?? "?"}`, error.message);
    return { success: false, mensaje: error.message, status };
  }
}

/**
 * Inicia una nueva instancia de workflow BPA (arranca el proceso al enviar el lote).
 * POST /v1/workflow-instances — Body: { definitionId, context }
 *
 * @param {string} definitionId - ID cualificado del workflow
 * @param {object} contexto     - contexto inicial con la PropuestaNomina anidada
 * @returns {Promise<{ success: boolean, mensaje: string, instanceId: string|null }>}
 */
async function iniciarInstancia(definitionId, contexto) {
  const svc = await getSvc();
  try {
    const instancia = await conTimeoutBpa(svc.post("/workflow-instances", {
      definitionId,
      context: contexto,
    }), "iniciarInstancia");

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

/**
 * Obtiene el estado de una instancia de workflow BPA.
 * GET /v1/workflow-instances/{workflowInstanceId}
 * @param {string} instanceId
 * @returns {Promise<object|null>} WorkflowInstance (incluye status) o null si falla
 */
async function obtenerEstadoInstancia(instanceId) {
  const svc = await getSvc();
  try {
    const instancia = await conTimeoutBpa(svc.get(`/workflow-instances/${instanceId}`), "obtenerEstadoInstancia");
    LOG.info(`obtenerEstadoInstancia OK | instanceId=${instanceId} status=${instancia?.status}`);
    return instancia;
  } catch (error) {
    LOG.error(`obtenerEstadoInstancia ERROR | instanceId=${instanceId}`, error.message);
    return null;
  }
}

/**
 * Cancela la instancia de workflow completa.
 * PATCH /v1/workflow-instances/{instanceId} — Body: { status: "CANCELED" }
 * @param {string} instanceId
 */
async function cerrarFlujo(instanceId) {
  const svc = await getSvc();
  try {
    await conTimeoutBpa(svc.patch(`/workflow-instances/${instanceId}`, { status: "CANCELED" }), "cerrarFlujo");
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
  leerContextoInstancia,
  actualizarContextoInstancia,
  completarTarea,
  reasignarTarea,
  iniciarInstancia,
  obtenerEstadoInstancia,
  cerrarFlujo,
};
