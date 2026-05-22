"use strict";
/**
 * service/pagos-service.js
 *
 * Implementación del PagosService (pagos-service.cds).
 * Es la capa más delgada: solo recibe el req de CAP,
 * extrae los datos y delega al domain service correcto.
 *
 * Estructura de llamada para cada acción:
 *   req.data → { pp, currentUser, taskId, contexto, constantes, comentario }
 *
 * El UI5 envía en cada llamada:
 *   - pp          : propuestaPago completo (el objeto del contexto BPA + HANA)
 *   - currentUser : { name: "user@mail.com" } (del getCurrentUserApi())
 *   - taskId      : InstanceID del BPA (sTaskID)
 *   - contexto    : objeto contexto.json actual de la tarea BPA
 *   - constantes  : this.oConstantes.rpta (cargado en onInit del Master)
 *   - comentario  : string (para acciones de observación)
 */

const cds      = require("@sap/cds");
const aprobSvc = require("../domain/aprobacion.service");
const propSvc  = require("../domain/propuesta.service");
const constSvc = require("../domain/constantes.service");
const bpa      = require("../infrastructure/bpa-client");
const cpiInfra = require("../infrastructure/cpi-client");

module.exports = cds.service.impl(async function (srv) {

  // ── MASTER ────────────────────────────────────────────────────────────────

  srv.on("obtenerConstantes", async (_req) => {
    const { rpta } = await constSvc.getConstantes();
    return {
      aSociedadesRevision: rpta.aSociedadesRevision,
      aValidarViaPago    : rpta.aValidarViaPago,
      aAprobarViaPago    : rpta.aAprobarViaPago,
      aSociedadesTermina : rpta.aSociedadesTermina,
      oTesoreros         : JSON.stringify(rpta.oTesoreros),
      sDocumentUrl       : rpta.sDocumentUrl,
      sDocumentUrlTasa   : rpta.sDocumentUrlTasa,
    };
  });

  // ── DETAIL — LECTURA ──────────────────────────────────────────────────────

  /**
   * Lectura inicial del Detail.
   * Equivale a: readContext + getPropuestaPago en _onBindingChange
   */
  srv.on("obtenerDetalle", async (req) => {
    const { taskId } = req.data;
    const contexto = await bpa.readContext(taskId);
    if (!contexto) return req.error(404, "No se pudo obtener el contexto de la tarea");

    const pp = await propSvc.obtenerOCrearPropuesta(contexto, taskId);
    if (!pp) return req.error(404, `Propuesta ${contexto.NroPP} no encontrada`);

    const constantes = await constSvc.getConstantes();
    return { pp, contexto, constantes: constantes.rpta };
  });

  // ── ANALISTA TESORERÍA ─────────────────────────────────────────────────────

  srv.on("enviarSupervisorOCaja", async (req) => {
    try {
      return await aprobSvc.enviarSupervisorOCaja(req.data);
    } catch (e) { return req.error(400, e.message); }
  });

  srv.on("compensar", async (req) => {
    // El handler obtiene el doc de compensación desde CPI antes de llamar al service
    const { pp } = req.data;
    try {
      const oDocCompensa = await cpiInfra.registrarAprobacionSAP({ tipo: "consultar", pp });
      return await aprobSvc.compensar({ ...req.data, oDocCompensa });
    } catch (e) { return req.error(400, e.message); }
  });

  srv.on("cerrarPorObservacion", async (req) => {
    try { return await aprobSvc.cerrarPorObservacion(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  srv.on("eliminarDoc", async (req) => {
    try { return await aprobSvc.eliminarDoc(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  // ── SUPERVISOR ────────────────────────────────────────────────────────────

  srv.on("supervisorAprobar", async (req) => {
    try { return await aprobSvc.supervisorAprobar(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  srv.on("supervisorTerminarFlujo", async (req) => {
    try { return await aprobSvc.supervisorTerminarFlujo(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  srv.on("supervisorObservar", async (req) => {
    try { return await aprobSvc.supervisorObservar(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  // ── REVISOR ───────────────────────────────────────────────────────────────

  srv.on("revisorAprobar", async (req) => {
    try { return await aprobSvc.revisorAprobar(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  srv.on("revisorObservar", async (req) => {
    try { return await aprobSvc.revisorObservar(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  // ── APODERADO ─────────────────────────────────────────────────────────────

  srv.on("apoderadoFirmar", async (req) => {
    try { return await aprobSvc.apoderadoFirmar(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  srv.on("apoderadoObservar", async (req) => {
    try { return await aprobSvc.apoderadoObservar(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  // ── CAJA ──────────────────────────────────────────────────────────────────

  srv.on("cajaConfirmarPago", async (req) => {
    try { return await aprobSvc.cajaConfirmarPago(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

  srv.on("cajaObservar", async (req) => {
    try { return await aprobSvc.cajaObservar(req.data); }
    catch (e) { return req.error(400, e.message); }
  });

});
