"use strict";
/**
 * srv/reasignacion-service.js
 *
 * Implementación del ReasignacionService usando el patrón cds.ApplicationService.
 *
 * Grupos de handlers registrados automáticamente por init():
 *   handle_tareas()     → READ TareasEnCurso (tareas de todos los usuarios)
 *   handle_reasignar()  → acción bound reasignar (delegada a
 *                          domain/reasignacion.service.js)
 *
 * Acceso restringido a administradores — @requires: 'Administrador' en
 * reasignacion-service.cds.
 */

const cds       = require("@sap/cds");
const reasigSvc = require("./domain/reasignacion.service");
const bpa       = require("./infrastructure/bpa-client");
const perfiles  = require("./config/perfiles");

const LOG = cds.log("ReasignacionService");

// ═══════════════════════════════════════════════════════════════════════════════
// CLASE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

class ReasignacionService extends cds.ApplicationService {

  /**
   * Descubre y registra todos los métodos estáticos con prefijo "handle_".
   */
  init() {
    const handlers = Object.getOwnPropertyNames(ReasignacionService)
      .filter(name => name.startsWith("handle_"));

    for (const handler of handlers) {
      ReasignacionService[handler].call(this);
    }

    LOG.info(`ReasignacionService iniciado | handlers: ${handlers.join(", ")}`);
    return super.init();
  }

  // ─── TAREAS EN CURSO (todos los usuarios) ────────────────────────────────

  static handle_tareas() {
    /**
     * GET /nomina/reasignacion/TareasEnCurso
     * Lista las tareas en curso (READY/RESERVED) de los 3 roles activos
     * (Apoderado1, Apoderado2, Liberador Final), de todos los usuarios.
     */
    this.on("READ", "TareasEnCurso", async (_req) => {
      const tareas = await _obtenerTareasEnCurso();
      tareas.$count = tareas.length;
      return tareas;
    });
  }

  // ─── ACCIÓN BOUND DE REASIGNACIÓN ────────────────────────────────────────

  static handle_reasignar() {
    /**
     * Registra el handler de la acción bound reasignar(nuevoUsuario).
     * La lógica vive en domain/reasignacion.service.js para separación de
     * capas, igual que aprobacion.service.js en PagosService.
     */
    reasigSvc.registrarHandlers(this);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCIONES PRIVADAS DEL MÓDULO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Obtiene y enriquece la lista de tareas BPA en curso, filtrando solo las
 * que corresponden a un rol activo (apoderado1, apoderado2, liberador).
 * Si BPA no está disponible, cae a un mock local para desarrollo.
 */
async function _obtenerTareasEnCurso() {
  try {
    const tareasRaw = await bpa.listarTareasEnCurso();
    if (!tareasRaw.length) return [];

    const relevantes = tareasRaw
      .map(tarea => ({ tarea, rol: perfiles.resolverRolBpa(tarea.activityId ?? tarea.definitionId) }))
      .filter(({ rol }) => rol && rol.activo)
      // listarTareasEnCurso() combina READY + RESERVED (cada una ya ordenada
      // por BPA), pero al mezclarlas el orden global se pierde — se reordena
      // aquí por fecha de creación de la instancia, más reciente primero.
      .sort((a, b) => new Date(b.tarea.createdAt ?? 0) - new Date(a.tarea.createdAt ?? 0));

    return await Promise.all(relevantes.map(({ tarea, rol }) => _mapearTarea(tarea, rol)));

  } catch (error) {
    LOG.warn(`[_obtenerTareasEnCurso] BPA no disponible — usando mock | ${error.message}`);
    return _getMockTareasEnCurso();
  }
}

/**
 * Mapea una tarea BPA cruda + su rol resuelto al shape de TareasEnCurso.
 * El contexto BPA se lee solo para completar los campos de negocio
 * (título, importe, etc.); si falla, la fila igual se muestra con lo que
 * ya trae la lista de task-instances.
 */
async function _mapearTarea(tarea, rol) {
  let propuesta = {};
  try {
    const contexto = await bpa.readContext(tarea.id);
    propuesta = _extraerPropuesta(contexto);
  } catch (error) {
    LOG.warn(`[_mapearTarea] readContext falló | id=${tarea.id} | ${error.message}`);
  }

  return {
    instanceID        : tarea.id,
    tituloTarea        : tarea.subject ?? propuesta.tituloTarea ?? "",
    numeroPropuesta    : propuesta.numeroPropuesta ?? "",
    sociedad           : propuesta.sociedad ?? "",
    banco              : propuesta.banco ?? "",
    importe            : propuesta.importe ?? "",
    moneda             : propuesta.moneda ?? "",
    fechaPropuestaPago : propuesta.fechaPropuestaPago ?? "",
    rolTarea           : rol.label,
    usuarioActual      : tarea.recipientUsers?.[0] ?? "",
    estadoTarea        : tarea.status ?? "",
    workflowInstanceId : tarea.workflowInstanceId ?? "",
  };
}

/**
 * Normaliza el contexto BPA a la propuesta de negocio.
 * Misma lógica que _extraerPropuesta en pagos-service.js — duplicada aquí
 * porque cada servicio mantiene sus helpers privados de mapeo.
 */
function _extraerPropuesta(contexto) {
  if (!contexto || typeof contexto !== "object") return {};
  const candidatos = [
    contexto?.startEvent?.propuesta,
    contexto?.startEvent?.body,
    contexto?.propuesta,
    contexto?.body,
  ];
  const propuesta = candidatos.find(c => c && typeof c === "object");
  return propuesta ?? contexto;
}

// ─── MOCK (desarrollo local sin BPA disponible) ──────────────────────────────

/**
 * Mock de tareas en curso para poder probar la app de reasignación sin BPA.
 * Cubre los 3 roles activos con destinatarios distintos.
 */
function _getMockTareasEnCurso() {
  return [
    {
      instanceID: "mock-task-101",
      tituloTarea: "0025-R4701-BCP-05/08/2026-A", numeroPropuesta: "R4701",
      sociedad: "0025", banco: "BCP", importe: "15200.50", moneda: "PEN",
      fechaPropuestaPago: "05-08-2026",
      rolTarea: "Apoderado 1", usuarioActual: "arodas@centria.net",
      estadoTarea: "READY", workflowInstanceId: "wf-mock-101",
    },
    {
      instanceID: "mock-task-102",
      tituloTarea: "0025-R4702-BCP-06/08/2026-A", numeroPropuesta: "R4702",
      sociedad: "0025", banco: "BCP", importe: "8300.00", moneda: "PEN",
      fechaPropuestaPago: "06-08-2026",
      rolTarea: "Apoderado 2", usuarioActual: "jgonzales@centria.net",
      estadoTarea: "READY", workflowInstanceId: "wf-mock-102",
    },
    {
      instanceID: "mock-task-103",
      tituloTarea: "0025-R4703-BCP-07/08/2026-L", numeroPropuesta: "R4703",
      sociedad: "0025", banco: "BCP", importe: "43038.69", moneda: "PEN",
      fechaPropuestaPago: "07-08-2026",
      rolTarea: "Liberador Final", usuarioActual: "cpanduro@centria.net",
      estadoTarea: "RESERVED", workflowInstanceId: "wf-mock-103",
    },
  ];
}

module.exports = { ReasignacionService };
