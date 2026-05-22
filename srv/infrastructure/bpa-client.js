"use strict";
/**
 * infrastructure/bpa-client.js
 *
 * Acceso a SAP Build Process Automation (BPA) Workflow REST API.
 * Destino BTP: BPA_WF_DEST
 *
 * Reemplaza COMPLETAMENTE:
 *   oScpPiService.ejecutarLlamada("/http/h2h/workflow/completartarea", oPeticion)
 *
 * El payload oPeticion verificado en Detail.controller.js → completarTareaWF():
 * {
 *   TaskID        : sTaskID,
 *   ApoRegIndicador: "" | "OK",
 *   ApoReg        : "" | { Body: { ZfiWsH2hApoReg: {...} } },
 *   AprobacionPP  : {
 *     Aprobacion  : { FechaAprob, HoraAprob, Fecha, Usuario, NroPP, Sociedad,
 *                     FechaPP, EstadoPP, RolID, Correo, Aprobado, Observacion },
 *     Propuesta   : { NroPP, Sociedad, FechaPP, EstadoPP, FechaPPJS, Importe,
 *                     Moneda, UsrCreacionPP, ModalidadPP, ExisteDoc, ViaPago,
 *                     BancoDescripcion, Banco, Version, IdInstanciaWF, UserCrea,
 *                     UserModif, Analista, CorreoAnalista, IndPAdelanto },
 *     Path        : "/PropuestaPago(NroPP='...',Sociedad='...',FechaPP=datetime'...')"
 *   },
 *   WorkFlowData  : {
 *     status      : "COMPLETED",
 *     stage       : "confirm" | "Reject",
 *     context     : { ...contexto BPA completo }   ← campos del contexto.json
 *   }
 * }
 *
 * En la nueva arquitectura BTP el iFlow "/http/h2h/workflow/completartarea"
 * ya NO existe: CAP llama directamente al BPA Workflow REST API.
 * El context del BPA se actualiza con los mismos campos del contexto.json real.
 */

const cds = require("@sap/cds");
const LOG = cds.log("bpa-client");

let _svc;
const getSvc = async () => (_svc ??= await cds.connect.to("BPA_WORKFLOW"));

// ─── COMPLETAR TAREA ──────────────────────────────────────────────────────────

/**
 * Completa una tarea del Inbox de BPA actualizando su contexto.
 *
 * Reemplaza: oScpPiService.ejecutarLlamada("/http/h2h/workflow/completartarea", oPeticion)
 *
 * @param {string} taskId   - InstanceID del BPA (sTaskID en Detail.controller.js)
 * @param {string} accion   - "confirm" | "Reject"  (igual que el stage original)
 * @param {object} params   - objeto con todos los datos necesarios:
 *   {
 *     pp          : propuestaPago completo (con EstadoPP ya actualizado)
 *     currentUser : { name: "user@mail.com" }
 *     rol         : "SUPERVISOR"|"REVISOR"|"APODERADO"|"CAJA"|"ANALISTA_T"
 *     aprobado    : "1" | "0"
 *     comentario  : string (observación)
 *     contexto    : objeto contexto.json actualizado con los cambios del step
 *     oApoReg     : objeto ZfiWsH2hApoReg | null
 *     hanaPath    : string path HANA de la propuesta (para la clave de HANA)
 *   }
 *
 * @returns {{ success: boolean, mensaje: string }}
 */
async function completarTarea(taskId, accion, {
  pp, currentUser, rol, aprobado, comentario = "",
  contexto, oApoReg = null, hanaPath = ""
}) {
  const svc = await getSvc();
  const now = new Date();

  // Construir el payload exacto que espera el BPA / que antes enviaba el iFlow
  const oPeticion = {
    TaskID         : taskId,
    ApoRegIndicador: oApoReg ? "OK" : "",
    ApoReg         : oApoReg ?? "",
    AprobacionPP: {
      Aprobacion: {
        FechaAprob: now,
        HoraAprob : `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`,
        Fecha     : `${now.getDate()}-${now.getMonth() + 1}-${now.getFullYear()}`,
        Usuario   : currentUser.name,
        NroPP     : pp.NroPP,
        Sociedad  : pp.Sociedad,
        FechaPP   : pp.FechaPP,
        EstadoPP  : pp.EstadoPP,
        RolID     : rol,
        Correo    : currentUser.name,
        Aprobado  : aprobado,
        Observacion: comentario,
      },
      Propuesta: {
        NroPP          : pp.NroPP,
        Sociedad       : pp.Sociedad,
        FechaPP        : pp.FechaPP,
        EstadoPP       : pp.EstadoPP,
        FechaPPJS      : pp.FechaPPJS,
        Importe        : pp.Importe,
        Moneda         : pp.Moneda,
        UsrCreacionPP  : pp.UsrCreacionPP,
        ModalidadPP    : pp.ModalidadPP,
        ExisteDoc      : pp.ExisteDoc,
        ViaPago        : pp.ViaPago,
        BancoDescripcion: pp.BancoDescripcion,
        Banco          : pp.Banco,
        Version        : pp.Version,
        IdInstanciaWF  : taskId,
        UserCrea       : pp.UserCrea,
        UserModif      : currentUser.name,
        Analista       : pp.Analista,
        CorreoAnalista : pp.CorreoAnalista,
        IndPAdelanto   : pp.IndPAdelanto,
      },
      Path: hanaPath,
    },
    WorkFlowData: {
      status : "COMPLETED",
      stage  : accion,
      context: contexto, // campos del contexto.json: TaskTitle, usrRevisor, bRevisor, etc.
    },
  };

  try {
    // BPA Workflow Task Instances API (PATCH completa la tarea)
    await svc.patch(`/task-instances/${taskId}`, {
      status : accion === "confirm" ? "COMPLETED" : "FAILED",
      context: oPeticion,   // BPA almacena el payload completo en el contexto
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
 * Cancela / cierra la instancia de workflow completa.
 * Equivale a: that.cerrarFlujo() en Supervisor.js → TERMINAR_FLUJO
 *
 * @param {string} instanceId - ID de instancia BPA (= sTaskID)
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

// ─── LEER CONTEXTO ────────────────────────────────────────────────────────────

/**
 * Lee el contexto de una tarea BPA.
 * Equivale a: ContextModel.readContext(sTaskID) en Detail.controller.js
 * Retorna el objeto contexto.json (NroPP, Sociedad, FechaPP, TaskTitle, flags...)
 *
 * @param {string} taskId - InstanceID del BPA
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

module.exports = {
  completarTarea,
  cerrarFlujo,
  readContext,
};
