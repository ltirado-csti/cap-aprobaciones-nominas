"use strict";
/**
 * domain/aprobacion.service.js
 *
 * Lógica de dominio del flujo de aprobación de la Propuesta de Pago.
 * Orquesta las decisiones de cada rol y delega TODA llamada externa en los
 * clientes de infraestructura. CPI es la única fachada de integración (no hay
 * HANA Cloud ni SAP Gateway: el estado, los usuarios por rol y el contador de
 * firmas viajan en el propio objeto PropuestaNomina del contexto BPA).
 *
 * Modelo de datos:
 *   - "propuesta" (tipo PropuestaNomina, camelCase) es a la vez los datos y el
 *     contexto del flujo. El handler de rol modifica propuesta.estadoPP y sus
 *     flags, y al completar/iniciar la tarea BPA se envía como contexto.
 *
 * Depende de (arquitectura H2H BTP):
 *   infrastructure/cpi-client → registrarAprobacionSAP, registrarObservacionSAP
 *   infrastructure/bpa-client → iniciarInstancia, completarTarea, cerrarFlujo
 *   domain/propuesta.service  → actualizarEstado, validarAdelanto
 *   config/perfiles           → resolverDecision, esTareaBpa, resolverProceso
 *
 * Alineación BPA (.mtar H2H_Nomina_1_0_12):
 *   - Cada acción se completa con la "decision" real del formulario BPA
 *     (perfiles.resolverDecision). Solo Coordinador, Apoderado y Liberador
 *     completan user task; Analista y Caja son 100% CAP (el Analista inicia).
 *
 * SUPUESTOS a validar con el arquitecto (marcados TODO):
 *   - usuarioSAP para los payloads CPI (apoReg/obs) = usuario.name autenticado.
 *   - Validación de rol del usuario actual: delegada a XSUAA/@restrict (ya no se
 *     consulta a SAP).
 *   - Flujo CAR (checkPerfilSAP): enrutamiento simplificado pendiente de definir.
 *   - Notificaciones por correo: las gestiona BPA de forma autónoma (no CAP).
 */

const cpi             = require("../infrastructure/cpi-client");
const bpa             = require("../infrastructure/bpa-client");
const propuestaService = require("./propuesta.service");
const perfiles        = require("../config/perfiles");
const cds             = require("@sap/cds");
const LOG             = cds.log("aprobacion.service");

// ─── HELPERS INTERNOS ────────────────────────────────────────────────────────

/**
 * Construye el tituloTarea actualizado.
 * Formato verificado en contexto: "0025-R4603-BCP-20/05/2026-R"
 * El sufijo es la posición [4]: AT|S|R|A|C
 */
function _buildTituloTarea(tituloActual, sufijo) {
  if (!tituloActual) return "";
  const partes = tituloActual.split("-");
  partes[4] = sufijo;
  return partes.join("-");
}

/**
 * Anida la PropuestaNomina bajo el path de contexto que espera el proceso BPA.
 * startEvent.propuesta (principal) vs startEvent.body (subprocesos).
 * Único punto a ajustar si BPA esperara otra forma de contexto.
 */
function _anidarContexto(perfilFuncional, propuesta) {
  const proceso = perfiles.resolverProceso(perfilFuncional);
  const path    = proceso?.contextPath ?? "propuesta";
  return { startEvent: { [path]: propuesta } };
}

/**
 * Ejecuta una acción sobre una tarea BPA existente.
 * Orden: actualizarEstado → completarTarea con la decision real.
 * Solo completa user task si el rol la tiene (perfiles.esTareaBpa);
 * Analista y Caja (100% CAP) omiten el complete.
 *
 * @param {object} opts
 *   propuesta       : PropuestaNomina (con estadoPP/flags ya actualizados)
 *   usuario         : { name }
 *   taskId          : ID de la user task BPA
 *   perfil          : perfil funcional (coordinador|apoderado|liberador|...)
 *   accionFuncional : "aprobar" | "observar" | "anular" | "rechazar"
 */
async function _ejecutar({ propuesta, usuario, taskId, perfil, accionFuncional }) {
  // 1. Sellar el estado (vive en el contexto; no se persiste en base local)
  await propuestaService.actualizarEstado(propuesta, usuario);

  // 2. Completar la user task BPA — solo si el rol tiene tarea en BPA
  if (perfiles.esTareaBpa(perfil)) {
    const decision    = perfiles.resolverDecision(perfil, accionFuncional);
    const contextoBpa = _anidarContexto(perfil, propuesta);
    const resultado   = await bpa.completarTarea(taskId, { decision, contexto: contextoBpa });
    if (!resultado.success) throw new Error(resultado.mensaje);
    return resultado;
  }

  // Rol 100% CAP (analista/caja): no completa user task BPA.
  LOG.info(`_ejecutar | rol CAP "${perfil}" sin user task BPA — se omite complete`);
  return { success: true, mensaje: "Acción completada (rol sin user task BPA)" };
}

/**
 * Inicia una nueva instancia de workflow BPA (lo hace el Analista al enviar el lote).
 * El Analista no tiene user task: arranca el proceso aprobacionDeNomina.
 */
async function _iniciarFlujo({ propuesta, usuario, perfil = "analista" }) {
  await propuestaService.actualizarEstado(propuesta, usuario);

  const proceso     = perfiles.resolverProceso(perfil);
  const contextoBpa = _anidarContexto(perfil, propuesta);

  const resultado = await bpa.iniciarInstancia(proceso?.definitionId, contextoBpa);
  if (!resultado.success) throw new Error(resultado.mensaje);

  LOG.info(`_iniciarFlujo OK | instanceId=${resultado.instanceId}`);
  return resultado;
}

// ─── ANALISTA TESORERÍA (100% CAP — inicia el flujo) ──────────────────────────

/**
 * Migrado de: AnalistaTesorería.js → botón ENVIAR_SUPER_CAJA
 * El Analista INICIA la instancia BPA. El enrutamiento (Caja vs Supervisor) se
 * codifica en los flags del contexto; los usuarios por rol ya viajan en la propuesta.
 *   viaPago W      → EN_CAJA     (esCaja=true, sufijo "C")
 *   viaPago I o Z  → VALIDACION  (sufijo "S")
 */
async function enviarSupervisorOCaja({ propuesta, usuario, constantes }) {
  const errAdelanto = await propuestaService.validarAdelanto(propuesta);
  if (errAdelanto) throw new Error(errAdelanto);

  if (propuesta.viaPago === "W") {
    propuesta.estadoPP    = "EN_CAJA";
    propuesta.esCaja      = true;
    propuesta.tituloTarea = _buildTituloTarea(propuesta.tituloTarea, "C");
    return _iniciarFlujo({ propuesta, usuario });
  }

  if (propuesta.viaPago === "I" || propuesta.viaPago === "Z") {
    propuesta.estadoPP    = "VALIDACION";
    propuesta.esCaja      = false;
    propuesta.tituloTarea = _buildTituloTarea(propuesta.tituloTarea, "S");
    return _iniciarFlujo({ propuesta, usuario });
  }

  throw new Error(`Vía de pago '${propuesta.viaPago}' no tiene enrutamiento definido`);
}

/**
 * Migrado de: AnalistaTesorería.js → botón COMPENSAR (acción CAP-only).
 * docCompensacion lo obtiene pagos-service desde CPI antes de invocar.
 */
async function compensar({ propuesta, usuario, taskId, docCompensacion }) {
  const respuesta = docCompensacion["n0:ZfiWsConsultarPropagoResponse"];
  if (!respuesta || respuesta.EpFlag !== "EXISTE") {
    throw new Error("No existe documento de compensación para esta propuesta");
  }
  propuesta.nroDocCompensacion = respuesta.EpNrodoccomp;
  propuesta.fechaCompensacion  = respuesta.EpFecdoccomp;
  propuesta.estadoPP           = "COMPENSADO";
  propuesta.estaTerminado      = true;
  return _ejecutar({ propuesta, usuario, taskId, perfil: "analista", accionFuncional: "aprobar" });
}

/** CERRAR_OBS — acción CAP-only */
async function cerrarPorObservacion({ propuesta, usuario, taskId }) {
  propuesta.estadoPP      = "CERRADO_OB";
  propuesta.estaTerminado = true;
  return _ejecutar({ propuesta, usuario, taskId, perfil: "analista", accionFuncional: "observar" });
}

/** ELIMINAR_DOC — acción CAP-only */
async function eliminarDoc({ propuesta, usuario, taskId }) {
  propuesta.estadoPP      = "ELIMINADO";
  propuesta.estaTerminado = true;
  return _ejecutar({ propuesta, usuario, taskId, perfil: "analista", accionFuncional: "observar" });
}

// ─── SUPERVISOR / COORDINADOR (user task: form_aprobacionDelCoordinador_2) ─────

/**
 * Migrado de: Supervisor.js → botón APROBAR_PP
 * El Coordinador completa con decision "aprobar". El enrutamiento (Revisor/
 * Liberador vs Apoderado vs Analista) se refleja en los flags del contexto.
 */
async function supervisorAprobar({ propuesta, usuario, taskId, constantes }) {
  const sociedadesRevision = constantes?.sociedadesRevision ?? [];

  const necesitaRevisor = !propuesta.numeroPropuesta?.includes("CAR")
                        && propuesta.viaPago !== "C"
                        && sociedadesRevision.includes(propuesta.sociedad);

  // Re-aprobación desde estado observado
  if (propuesta.estadoPP === "OBS_APODER" || propuesta.estadoPP === "OBS_REVISO") {
    return necesitaRevisor
      ? _enviarRevisor({ propuesta, usuario, taskId })
      : _enviarApoderado({ propuesta, usuario, taskId });
  }

  if (propuesta.modalidadPP?.includes("H2H")) {
    return necesitaRevisor
      ? _enviarRevisor({ propuesta, usuario, taskId })
      : _enviarApoderado({ propuesta, usuario, taskId });
  }

  if (propuesta.modalidadPP === "CAR") {
    // TODO(arquitecto): el flujo CAR consultaba perfil de tesorero en SAP.
    // Pendiente de definir cómo se resuelve en BTP (¿XSUAA o flag de contexto?).
    return necesitaRevisor
      ? _enviarRevisor({ propuesta, usuario, taskId })
      : _enviarApoderado({ propuesta, usuario, taskId });
  }

  if (propuesta.viaPago === "Z" || propuesta.viaPago === "I") {
    propuesta.estadoPP    = "APROBADO";
    propuesta.tieneRevisor = false;
    propuesta.tieneAnalista = true;
    propuesta.tituloTarea  = _buildTituloTarea(propuesta.tituloTarea, "AT");
    return _ejecutar({ propuesta, usuario, taskId, perfil: "coordinador", accionFuncional: "aprobar" });
  }

  throw new Error("No se pudo determinar el flujo de aprobación");
}

/** TERMINAR_FLUJO (Supervisor) — cancela la instancia completa (sin decision) */
async function supervisorTerminarFlujo({ propuesta, usuario, taskId, constantes }) {
  const viasPagoValidar = constantes?.validarViaPago ?? [];
  if (viasPagoValidar.includes(propuesta.viaPago)) {
    throw new Error("Esta acción no es válida para la vía de pago C, I, W o Z");
  }
  return bpa.cerrarFlujo(taskId);
}

/** OBSERVAR (Supervisor) → ZfiWsH2hObs vía CPI + decision "observar" del Coordinador */
async function supervisorObservar({ propuesta, usuario, taskId, comentario }) {
  // TODO(arquitecto): usuarioSAP del payload CPI = usuario.name autenticado.
  const payloadObservacion = cpi.buildObsPayload(propuesta, usuario.name, comentario, "OBTR");
  await cpi.registrarObservacionSAP(payloadObservacion); // si falla, lanza excepción

  propuesta.estadoPP    = "OBS_SUPER";
  propuesta.estaAnulado = true;
  return _ejecutar({ propuesta, usuario, taskId, perfil: "coordinador", accionFuncional: "observar" });
}

// ─── REVISOR / LIBERADOR (user task: form_aprobacionFinalForm_2) ───────────────
// TODO(arquitecto): confirmar si LI (liberador) == RV (revisor). El Liberador usa
//                   IDs de decision en inglés (approve/reject/cancel).

/**
 * Migrado de: Revisor.js → botón APROBAR_PP
 * Envía al Apoderado. La confirmación se materializa en la decision BPA "aprobar".
 */
async function revisorAprobar({ propuesta, usuario, taskId, comentario }) {
  propuesta.estadoPP     = "EN_FIRMA";
  propuesta.estaAprobado = true;
  propuesta.tituloTarea  = _buildTituloTarea(propuesta.tituloTarea, "A");
  return _ejecutar({ propuesta, usuario, taskId, perfil: "liberador", accionFuncional: "aprobar" });
}

/** OBSERVAR (Revisor) → ZfiWsH2hObs. El Liberador no tiene "observar": se mapea a "rechazar". */
async function revisorObservar({ propuesta, usuario, taskId, comentario }) {
  const payloadObservacion = cpi.buildObsPayload(propuesta, usuario.name, comentario, "OBRA");
  await cpi.registrarObservacionSAP(payloadObservacion);

  propuesta.estadoPP = "OBS_REVISOR";
  // TODO(arquitecto): confirmar que "observar" del Revisor mapea a decision "reject" del Liberador.
  return _ejecutar({ propuesta, usuario, taskId, perfil: "liberador", accionFuncional: "rechazar" });
}

// ─── APODERADO (user task: form_aprobacionDelApoderado_1 / _2) ─────────────────

/**
 * Migrado de: Apoderado.js → botón APROBAR_PP (firma)
 *   1. Determina F1 (contadorFirma=0) vs F2 (≥1) desde el contexto
 *   2. buildApoRegPayload → PiEstado F1|F2
 *   3. Registra firma en SAP vía CPI /apoReg (ANTES de completar BPA)
 *   4. Si F2 → estadoPP=FIRMADO, sufijo "S"; si F1 → sigue EN_FIRMA, sufijo "A"
 *   5. Completa tarea BPA con decision "aprobar"
 */
async function apoderadoFirmar({ propuesta, usuario, taskId, constantes }) {
  const sociedadesTermina = constantes?.sociedadesTermina ?? [];

  // 1. Contador de firmas: viaja en el contexto (no se consulta a SAP)
  const contadorFirma = propuesta.contadorFirma ?? 0;

  // 2-3. Registrar firma en SAP vía CPI ANTES de completar BPA
  //      TODO(arquitecto): usuarioSAP = usuario.name; confirmar mapeo si aplica.
  //      NOTA(.mtar): el subproceso de apoderados invoca CPI directamente para apoReg.
  //      TODO(arquitecto): confirmar que CAP no duplique este registro con el BPA.
  const payloadApoReg = cpi.buildApoRegPayload(propuesta, usuario.name, contadorFirma);
  const respuestaApoReg = await cpi.registrarAprobacionSAP(payloadApoReg);
  if (respuestaApoReg?.["n0:ZfiWsH2hApoRegResponse"]?.EpMensaje &&
      !respuestaApoReg["n0:ZfiWsH2hApoRegResponse"].EpMensaje.includes("OK")) {
    throw new Error(respuestaApoReg["n0:ZfiWsH2hApoRegResponse"].EpMensaje);
  }

  // 4. Determinar nuevo estado
  const esFirmado = contadorFirma >= 1;
  propuesta.estadoPP      = esFirmado ? "FIRMADO" : "EN_FIRMA";
  propuesta.contadorFirma = contadorFirma + 1;
  propuesta.estaAprobado  = true;
  propuesta.estaConforme  = esFirmado && sociedadesTermina.includes(propuesta.sociedad);
  propuesta.tituloTarea   = _buildTituloTarea(propuesta.tituloTarea, esFirmado ? "S" : "A");

  return _ejecutar({ propuesta, usuario, taskId, perfil: "apoderado", accionFuncional: "aprobar" });
}

/** OBSERVAR (Apoderado) → ZfiWsH2hObs + decision "observar" */
async function apoderadoObservar({ propuesta, usuario, taskId, comentario }) {
  const payloadObservacion = cpi.buildObsPayload(propuesta, usuario.name, comentario, "OBAP");
  await cpi.registrarObservacionSAP(payloadObservacion);

  propuesta.estadoPP = "OBS_APODER";
  return _ejecutar({ propuesta, usuario, taskId, perfil: "apoderado", accionFuncional: "observar" });
}

// ─── CAJA (100% CAP — sin user task BPA) ──────────────────────────────────────

/** CONFIRMAR_PAGO (Caja) — acción CAP-only */
async function cajaConfirmarPago({ propuesta, usuario, taskId }) {
  propuesta.estadoPP      = "PAGADO";
  propuesta.estaTerminado = true;
  return _ejecutar({ propuesta, usuario, taskId, perfil: "caja", accionFuncional: "aprobar" });
}

/** OBSERVAR (Caja) → ZfiWsH2hObs — acción CAP-only (registro CPI + estado) */
async function cajaObservar({ propuesta, usuario, taskId, comentario }) {
  const payloadObservacion = cpi.buildObsPayload(propuesta, usuario.name, comentario, "OBCA");
  await cpi.registrarObservacionSAP(payloadObservacion);

  propuesta.estadoPP = "OBS_CAJA";
  return _ejecutar({ propuesta, usuario, taskId, perfil: "caja", accionFuncional: "observar" });
}

// ─── HELPERS COMPARTIDOS (rutas del Coordinador) ──────────────────────────────

/** Enruta al Revisor/Liberador. El Coordinador completa con decision "aprobar". */
async function _enviarRevisor({ propuesta, usuario, taskId }) {
  propuesta.estadoPP    = "REVISION";
  propuesta.tieneRevisor = true;
  propuesta.tituloTarea = _buildTituloTarea(propuesta.tituloTarea, "R");
  return _ejecutar({ propuesta, usuario, taskId, perfil: "coordinador", accionFuncional: "aprobar" });
}

/** Enruta al Apoderado. El Coordinador completa con decision "aprobar". */
async function _enviarApoderado({ propuesta, usuario, taskId }) {
  propuesta.estadoPP     = "EN_FIRMA";
  propuesta.tieneRevisor = false;
  propuesta.estaAprobado = true;
  propuesta.tituloTarea  = _buildTituloTarea(propuesta.tituloTarea, "A");
  return _ejecutar({ propuesta, usuario, taskId, perfil: "coordinador", accionFuncional: "aprobar" });
}

module.exports = {
  // Analista Tesorería
  enviarSupervisorOCaja,
  compensar,
  cerrarPorObservacion,
  eliminarDoc,
  // Supervisor / Coordinador
  supervisorAprobar,
  supervisorTerminarFlujo,
  supervisorObservar,
  // Revisor / Liberador
  revisorAprobar,
  revisorObservar,
  // Apoderado
  apoderadoFirmar,
  apoderadoObservar,
  // Caja
  cajaConfirmarPago,
  cajaObservar,
};