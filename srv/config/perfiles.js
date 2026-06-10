"use strict";
/**
 * domain/aprobacion.service.js
 *
 * Lógica de dominio del flujo de aprobación.
 *
 * Cubre:
 *   - Enrutamiento por rol y vía de pago (la lógica de los 5 ficheros logica/)
 *   - Construcción del contexto BPA actualizado (tituloTarea, flags, usuarios)
 *   - Orquestación: guardarConfirmacion → updatePropuestaPago → BPA
 *   - Registro de firma Apoderado (F1/F2) vía CPI
 *   - Registro de observación vía CPI
 *   - Envío de correo (fire-and-forget)
 *
 * Depende de (arquitectura H2H BTP — CPI es la ÚNICA fachada de integración):
 *   infrastructure/cpi-client → registrarAprobacionSAP, registrarObservacionSAP,
 *                               getProveedores, getAdjuntos, getAprobadores.
 *                               Toda persistencia y lectura del ECP va por CPI
 *                               (REST→SOAP, endpoints ZfiWs*). No hay HANA Cloud
 *                               ni SAP Gateway directo: CAP nunca los llama.
 *   infrastructure/bpa-client → iniciarInstancia, completarTarea, cerrarFlujo
 *   domain/propuesta.service  → actualizarEstado
 *   config/perfiles           → resolverDecision, esTareaBpa, resolverProceso
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALINEACIÓN BPA (.mtar H2H_Nomina_1_0_12) — cambios de este bloque:
 *   - El antiguo par accion "confirm" | "Reject" se reemplaza por la decision real
 *     del formulario BPA, resuelta en perfiles.resolverDecision(perfil, accion).
 *   - Solo Coordinador, Apoderado y Liberador completan user task en BPA
 *     (perfiles.esTareaBpa). Analista y Caja son 100% CAP.
 *   - El Analista INICIA la instancia (bpa.iniciarInstancia) en lugar de completar
 *     una tarea inexistente.
 *
 * PENDIENTE (no resuelto aquí — ver MAPEO_WORKFLOW_BPA.md y arquitecto):
 *   - MIGRACIÓN A CPI (bloque aparte): este fichero todavía contiene llamadas
 *     legadas a `hana.*` y `gw.*` (guardarConfirmacion, obtenerUsuariosSAP,
 *     checkPerfilSAP, contarFirmasSAP, enviarCorreoAprobadores). En la
 *     arquitectura H2H BTP NO existen hana-client ni sap-gateway-client: esas
 *     operaciones deben exponerse en cpi-client (requieren iFlows CPI nuevos)
 *     o resolverse en BPA (correos). Hasta entonces esas rutas lanzan
 *     ReferenceError — el flujo NO opera end-to-end (estado heredado de dev).
 *   - Nombres de campos del contexto: este fichero aún usa nombres legados
 *     (TaskTitle, bConforme, usrApoderado...) mientras la capa de lectura
 *     (pagos-service) usa camelCase (tituloTarea, estaConforme, usuarioApoderado).
 *     La unificación a la convención PropuestaNomina.json es un bloque aparte.
 *   - ¿LI (liberador) == RV (revisor)? ¿Caja tiene user task BPA?
 *   - Loop de observación del Coordinador: ¿nueva instancia o mismo proceso?
 * ─────────────────────────────────────────────────────────────────────────────
 */

const cpi   = require("../infrastructure/cpi-client");
const bpa   = require("../infrastructure/bpa-client");
const prop  = require("./propuesta.service");
const perfiles = require("../config/perfiles");
const cds   = require("@sap/cds");
const LOG   = cds.log("aprobacion.service");

// Mapeo del nombre de rol legado (RolID en HANA/correo) al perfil funcional de perfiles.js
// TODO(arquitecto): confirmar REVISOR → liberador (¿LI == RV?).
const PERFIL_POR_ROL = {
  ANALISTA_T: "analista",
  SUPERVISOR: "coordinador",
  REVISOR   : "liberador",
  APODERADO : "apoderado",
  CAJA      : "caja",
};

// ─── HELPERS INTERNOS ────────────────────────────────────────────────────────

/**
 * Construye el tituloTarea actualizado.
 * Formato real verificado en contexto.json: "0025-R4603-BCP-20/05/2026-R"
 * El sufijo es la posición [4] (índice 0): AT|S|R|A|C
 */
function _buildTaskTitle(taskTitleActual, sufijo) {
  if (!taskTitleActual) return "";
  const p = taskTitleActual.split("-");
  p[4] = sufijo;
  return p.join("-");
}

/**
 * Anida la PropuestaNomina bajo el path de contexto que espera el proceso BPA.
 * Centraliza la diferencia startEvent.propuesta (principal) vs startEvent.body
 * (subprocesos). Único punto a ajustar si BPA esperara otra forma de contexto.
 *
 * @param {string} perfilFuncional - perfil del rol (define el proceso)
 * @param {object} propuestaNomina - objeto de negocio del flujo
 * @returns {object} contexto envuelto: { startEvent: { <path>: propuestaNomina } }
 */
function _anidarContexto(perfilFuncional, propuestaNomina) {
  const proceso = perfiles.resolverProceso(perfilFuncional);
  const path    = proceso?.contextPath ?? "propuesta";
  return { startEvent: { [path]: propuestaNomina } };
}

/**
 * Orquestador de cada acción de aprobación que opera sobre una tarea existente.
 * Orden garantizado: guardarConfirmacion → actualizarEstado → completarTarea BPA.
 *
 * El paso BPA solo se ejecuta si el rol tiene user task (perfiles.esTareaBpa).
 * Para roles 100% CAP (analista, caja) se omite el complete de BPA.
 *
 * @param {object} opts
 *   propuesta       : datos de la propuesta (PropuestaNomina, con EstadoPP ya actualizado)
 *   currentUser     : { name }
 *   taskId          : ID de la user task BPA
 *   perfil          : perfil funcional (coordinador|apoderado|liberador|...)
 *   accionFuncional : "aprobar" | "observar" | "anular" | "rechazar"
 *   rol             : nombre legado para HANA/correo (SUPERVISOR|REVISOR|...)
 *   aprobado        : "1" | "0"
 *   comentario      : string
 *   contexto        : PropuestaNomina actualizada (flags/usuarios del nuevo paso)
 *   guardarConf     : boolean (default true) — false cuando ya se guardó antes
 */
async function _ejecutar({ propuesta, currentUser, taskId, perfil, accionFuncional,
                           rol, aprobado, comentario = "", contexto, guardarConf = true }) {
  // 1. Guardar registro de aprobación en HANA
  if (guardarConf) {
    await hana.guardarConfirmacion(propuesta, currentUser.name, rol, aprobado, comentario);
  }

  // 2. Actualizar EstadoPP en HANA (siempre antes de tocar BPA)
  await prop.actualizarEstado(propuesta, currentUser);

  // 3. Completar la user task BPA — solo si el rol tiene tarea en BPA
  if (perfiles.esTareaBpa(perfil)) {
    const decision    = perfiles.resolverDecision(perfil, accionFuncional);
    const contextoBpa = _anidarContexto(perfil, contexto);
    const resultado   = await bpa.completarTarea(taskId, { decision, contexto: contextoBpa });
    if (!resultado.success) throw new Error(resultado.mensaje);
    return resultado;
  }

  // Rol 100% CAP (analista/caja): no completa user task BPA.
  // TODO(arquitecto): confirmar si requiere iniciarInstancia/cerrarFlujo en su lugar.
  LOG.info(`_ejecutar | rol CAP "${perfil}" sin user task BPA — se omite complete`);
  return { success: true, mensaje: "Acción completada (rol sin user task BPA)" };
}

/**
 * Inicia una nueva instancia de workflow BPA (lo hace el Analista al enviar el lote).
 * Reemplaza el antiguo "completar tarea del analista": el Analista no tiene user task.
 *
 * @param {object} opts
 *   propuesta   : datos de la propuesta (PropuestaNomina, con EstadoPP ya actualizado)
 *   currentUser : { name }
 *   contexto    : PropuestaNomina inicial del flujo
 *   perfil      : perfil que inicia (default "analista")
 */
async function _iniciarFlujo({ propuesta, currentUser, contexto, perfil = "analista" }) {
  // Persistir el estado en HANA antes de arrancar el flujo
  await prop.actualizarEstado(propuesta, currentUser);

  const proceso     = perfiles.resolverProceso(perfil);
  const contextoBpa = _anidarContexto(perfil, contexto);

  const resultado = await bpa.iniciarInstancia(proceso?.definitionId, contextoBpa);
  if (!resultado.success) throw new Error(resultado.mensaje);

  LOG.info(`_iniciarFlujo OK | instanceId=${resultado.instanceId}`);
  return resultado;
}

// ─── ANALISTA TESORERÍA (100% CAP — inicia el flujo) ──────────────────────────

/**
 * Migrado de: AnalistaTesorería.js → botón ENVIAR_SUPER_CAJA
 *
 * El Analista INICIA la instancia BPA (proceso aprobacionDeNomina). El enrutamiento
 * (Caja vs Supervisor) se codifica en los flags del contexto; el flujo BPA decide.
 *
 *   ViaPago W       → EN_CAJA     (tituloTarea sufijo "C", esCaja=true)
 *   ViaPago I o Z   → VALIDACION  (tituloTarea sufijo "S")
 */
async function enviarSupervisorOCaja({ propuesta, currentUser, contexto, constantes }) {
  const { ViaPago, Sociedad } = propuesta;

  // Validar adelanto primero (bloquea si hay adelanto sin adjunto)
  const errAdelanto = await prop.validarAdelanto(propuesta);
  if (errAdelanto) throw new Error(errAdelanto);

  if (ViaPago === "W") {
    const usuarios = await gw.obtenerUsuariosSAP("CAJA", Sociedad);
    if (!usuarios) throw new Error("No se pudo obtener la lista de Caja");

    propuesta.EstadoPP = "EN_CAJA";
    const ctx = { ...contexto,
      usrCaja  : usuarios.sUsuarios,
      bCaja    : true,
      TaskTitle: _buildTaskTitle(contexto.TaskTitle, "C"),
    };
    return _iniciarFlujo({ propuesta, currentUser, contexto: ctx });
  }

  if (ViaPago === "I" || ViaPago === "Z") {
    const usuarios = await gw.obtenerUsuariosSAP("SUPERVISOR", Sociedad);
    if (!usuarios) throw new Error("No se pudo obtener la lista de Supervisores");

    propuesta.EstadoPP = "VALIDACION";
    const ctx = { ...contexto,
      usrSupervisor: usuarios.sUsuarios,
      bCaja        : false,
      TaskTitle    : _buildTaskTitle(contexto.TaskTitle, "S"),
    };
    // Enviar correo al supervisor (fire-and-forget)
    gw.enviarCorreoAprobadores(propuesta, "TR",
      constantes?.oTesoreros?.[Sociedad] ?? constantes?.oTesoreros?.default
    );
    return _iniciarFlujo({ propuesta, currentUser, contexto: ctx });
  }

  throw new Error(`Vía de pago '${ViaPago}' no tiene enrutamiento definido`);
}

/**
 * Migrado de: AnalistaTesorería.js → botón COMPENSAR
 * Acción CAP-only (el Analista no completa user task BPA).
 */
async function compensar({ propuesta, currentUser, taskId, contexto, docCompensacion }) {
  const respuestaPropago = docCompensacion["n0:ZfiWsConsultarPropagoResponse"];
  if (!respuestaPropago || respuestaPropago.EpFlag !== "EXISTE") {
    throw new Error("No existe documento de compensación para esta propuesta");
  }
  propuesta.NroDocCompensacion = respuestaPropago.EpNrodoccomp;
  propuesta.FechaCompensacion  = respuestaPropago.EpFecdoccomp;
  propuesta.EstadoPP           = "COMPENSADO";
  const ctx = { ...contexto, bTerminar: true };
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "analista",
                     accionFuncional: "aprobar", rol: "ANALISTA_T", aprobado: "1", contexto: ctx });
}

/** CERRAR_OBS — acción CAP-only */
async function cerrarPorObservacion({ propuesta, currentUser, taskId, contexto }) {
  propuesta.EstadoPP = "CERRADO_OB";
  const ctx = { ...contexto, bTerminar: true };
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "analista",
                     accionFuncional: "observar", rol: "ANALISTA_T", aprobado: "0", contexto: ctx });
}

/** ELIMINAR_DOC — acción CAP-only */
async function eliminarDoc({ propuesta, currentUser, taskId, contexto }) {
  propuesta.EstadoPP = "ELIMINADO";
  const ctx = { ...contexto, bTerminar: true };
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "analista",
                     accionFuncional: "observar", rol: "ANALISTA_T", aprobado: "0", contexto: ctx });
}

// ─── SUPERVISOR / COORDINADOR (user task BPA: form_aprobacionDelCoordinador_2) ──

/**
 * Migrado de: Supervisor.js → botón APROBAR_PP
 *
 * El Coordinador completa su tarea con decision "aprobar". El enrutamiento
 * (Revisor/Liberador vs Apoderado vs Analista) se refleja en el contexto.
 */
async function supervisorAprobar({ propuesta, currentUser, taskId, contexto, constantes }) {
  const { EstadoPP, NroPP, ViaPago, Sociedad, ModalidadPP } = propuesta;
  const sociedadesRevision = constantes?.aSociedadesRevision ?? [];

  const necesitaRevisor = !NroPP.includes("CAR") && ViaPago !== "C"
                        && sociedadesRevision.includes(Sociedad);

  // Re-aprobación desde estado observado
  if (EstadoPP === "OBS_APODER" || EstadoPP === "OBS_REVISO") {
    return necesitaRevisor
      ? _enviarRevisor({ propuesta, currentUser, taskId, contexto })
      : _enviarApoderado({ propuesta, currentUser, taskId, contexto });
  }

  if (ModalidadPP?.includes("H2H")) {
    return necesitaRevisor
      ? _enviarRevisor({ propuesta, currentUser, taskId, contexto })
      : _enviarApoderado({ propuesta, currentUser, taskId, contexto });
  }

  if (ModalidadPP === "CAR") {
    const resultadoPerfil = await gw.checkPerfilSAP(propuesta, "TR");
    const esTeso = resultadoPerfil?.Existe === "";
    return (esTeso && sociedadesRevision.includes(Sociedad))
      ? _enviarRevisor({ propuesta, currentUser, taskId, contexto })
      : _enviarApoderado({ propuesta, currentUser, taskId, contexto });
  }

  if (ViaPago === "Z" || ViaPago === "I") {
    const usuarios = await gw.obtenerUsuariosSAP("ANALISTA_T", Sociedad);
    if (!usuarios) throw new Error("No se pudo obtener la lista de analistas");
    propuesta.EstadoPP = "APROBADO";
    const ctx = { ...contexto,
      usrAnalista: usuarios.sUsuarios,
      bRevisor   : false,
      bAnalista  : true,
      TaskTitle  : _buildTaskTitle(contexto.TaskTitle, "AT"),
    };
    gw.enviarCorreoAprobadores(propuesta, "TR",
      constantes?.oTesoreros?.[Sociedad] ?? constantes?.oTesoreros?.default
    );
    return _ejecutar({ propuesta, currentUser, taskId, perfil: "coordinador",
                       accionFuncional: "aprobar", rol: "SUPERVISOR", aprobado: "1", contexto: ctx });
  }

  throw new Error("No se pudo determinar el flujo de aprobación");
}

/** TERMINAR_FLUJO (Supervisor) — cancela la instancia completa (sin decision) */
async function supervisorTerminarFlujo({ propuesta, currentUser, taskId, contexto, constantes }) {
  const viasPagoValidar = constantes?.aValidarViaPago ?? [];
  if (viasPagoValidar.includes(propuesta.ViaPago)) {
    throw new Error("Esta acción no es válida para la vía de pago C, I, W o Z");
  }
  return bpa.cerrarFlujo(taskId);
}

/** OBSERVAR (Supervisor) → ZfiWsH2hObs vía CPI + decision "observar" del Coordinador */
async function supervisorObservar({ propuesta, currentUser, taskId, contexto, comentario }) {
  const usuario = await gw.obtenerUsuariosSAP("SUPERVISOR", propuesta.Sociedad, currentUser.name);
  if (!usuario?.sUserSAP) throw new Error("No se pudo validar su usuario de supervisor");

  const payloadObservacion = cpi.buildObsPayload(propuesta, usuario.sUserSAP, comentario, "OBTR");
  await cpi.registrarObservacionSAP(payloadObservacion); // si falla, lanza excepción (sí bloquea)

  propuesta.EstadoPP = "OBS_SUPER";
  const ctx = { ...contexto, bAnulado: true };
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "coordinador",
                     accionFuncional: "observar", rol: "SUPERVISOR", aprobado: "0",
                     comentario, contexto: ctx });
}

// ─── REVISOR / LIBERADOR (user task BPA: form_aprobacionFinalForm_2) ───────────
// TODO(arquitecto): confirmar si LI (liberador) == RV (revisor). Las decisions del
//                   Liberador usan IDs en inglés (approve/reject/cancel).

/**
 * Migrado de: Revisor.js → botón APROBAR_PP
 * Guarda confirmación y envía al Apoderado con payload ApoReg inicial.
 */
async function revisorAprobar({ propuesta, currentUser, taskId, contexto, comentario }) {
  await hana.guardarConfirmacion(propuesta, currentUser.name, "REVISOR", "1", comentario);

  const usuarios = await gw.obtenerUsuariosSAP("APODERADO", propuesta.Sociedad);
  if (!usuarios) throw new Error("No se pudo obtener la lista de apoderados");

  propuesta.EstadoPP = "EN_FIRMA";
  const ctx = { ...contexto,
    usrApoderado: usuarios.sUsuarios,
    bAprobado   : true,
    TaskTitle   : _buildTaskTitle(contexto.TaskTitle, "A"),
  };
  gw.enviarCorreoAprobadores(propuesta, "AP");

  return _ejecutar({ propuesta, currentUser, taskId, perfil: "liberador",
                     accionFuncional: "aprobar", rol: "REVISOR", aprobado: "1",
                     comentario, contexto: ctx, guardarConf: false }); // ya se guardó arriba
}

/** OBSERVAR (Revisor) → ZfiWsH2hObs. El Liberador no tiene "observar": se mapea a "rechazar". */
async function revisorObservar({ propuesta, currentUser, taskId, contexto, comentario }) {
  const usuario = await gw.obtenerUsuariosSAP("APODERADO", propuesta.Sociedad, currentUser.name);
  if (!usuario?.sUserSAP) throw new Error("No se pudo validar su usuario de revisor");

  const payloadObservacion = cpi.buildObsPayload(propuesta, usuario.sUserSAP, comentario, "OBRA");
  await cpi.registrarObservacionSAP(payloadObservacion);

  await hana.guardarConfirmacion(propuesta, currentUser.name, "REVISOR", "0", comentario);
  propuesta.EstadoPP = "OBS_REVISOR";
  // TODO(arquitecto): confirmar que "observar" del Revisor mapea a decision "reject" del Liberador.
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "liberador",
                     accionFuncional: "rechazar", rol: "REVISOR", aprobado: "0",
                     comentario, contexto, guardarConf: false });
}

// ─── APODERADO (user task BPA: form_aprobacionDelApoderado_1 / _2) ─────────────

/**
 * Migrado de: Apoderado.js → botón APROBAR_PP (firma)
 *
 * Lógica crítica:
 *   1. obtenerUsuariosSAP(APODERADO) con usuario actual → obtiene sUserSAP
 *   2. contarFirmasSAP → determina F1 (contadorFirma=0) vs F2 (≥1)
 *   3. buildApoRegPayload → PiEstado F1|F2
 *   4. Registrar en SAP vía CPI /apoReg (ANTES de completar BPA)
 *   5. Si F2 → EstadoPP=FIRMADO, sufijo "S"; si F1 → sigue EN_FIRMA, sufijo "A"
 *   6. Completar tarea BPA con decision "aprobar"
 */
async function apoderadoFirmar({ propuesta, currentUser, taskId, contexto, constantes }) {
  const Sociedad = propuesta.Sociedad;
  const sociedadesTermina = constantes?.aSociedadesTermina ?? [];

  // 1. Validar usuario apoderado actual
  const usuarioActual = await gw.obtenerUsuariosSAP("APODERADO", Sociedad, currentUser.name);
  if (!usuarioActual?.sUserSAP) throw new Error("No se pudo validar su usuario de apoderado");

  // 2. Lista completa de apoderados (para asignar los restantes en el contexto)
  const todosApoderados = await gw.obtenerUsuariosSAP("APODERADO", Sociedad);
  const apoderadosRestantes = (todosApoderados?.sUsuarios ?? "")
    .split(",")
    .filter(u => u.trim() !== currentUser.name)
    .join(",");

  // 3. Contar firmas SAP ya registradas
  const firmasSap = await gw.contarFirmasSAP(propuesta);
  if (!firmasSap) throw new Error("Error al contar firmas. Por favor intente nuevamente");
  const contadorFirma = firmasSap.Firmas ?? 0;

  // 4. Construir payload ApoReg con F1 o F2
  const payloadApoReg = cpi.buildApoRegPayload(propuesta, usuarioActual.sUserSAP, contadorFirma);

  // 5. Registrar firma en SAP vía CPI ANTES de completar BPA
  //    NOTA(.mtar): el subproceso de apoderados invoca CPI directamente para apoReg/Obs.
  //    TODO(arquitecto): confirmar que CAP no duplique este registro con el BPA.
  const respuestaApoReg = await cpi.registrarAprobacionSAP(payloadApoReg);
  if (respuestaApoReg?.["n0:ZfiWsH2hApoRegResponse"]?.EpMensaje &&
      !respuestaApoReg["n0:ZfiWsH2hApoRegResponse"].EpMensaje.includes("OK")) {
    throw new Error(respuestaApoReg["n0:ZfiWsH2hApoRegResponse"].EpMensaje);
  }

  // 6. Determinar nuevo estado
  const esFirmado = contadorFirma >= 1;
  propuesta.EstadoPP = esFirmado ? "FIRMADO" : "EN_FIRMA";

  let usrSupervisor = contexto.usrSupervisor ?? "";
  if (esFirmado) {
    const respuestaSupervisor = await gw.obtenerUsuariosSAP("SUPERVISOR", Sociedad);
    if (respuestaSupervisor) usrSupervisor = respuestaSupervisor.sUsuarios;
  }

  const ctx = { ...contexto,
    iContadorFirma  : contadorFirma + 1,
    usrApoderado    : apoderadosRestantes,
    usrSupervisor,
    bAprobado       : true,
    bConforme       : esFirmado,
    bConformeTermina: esFirmado && sociedadesTermina.includes(Sociedad),
    TaskTitle       : _buildTaskTitle(contexto.TaskTitle, esFirmado ? "S" : "A"),
  };

  if (!esFirmado) gw.enviarCorreoAprobadores(propuesta, "AP");

  return _ejecutar({ propuesta, currentUser, taskId, perfil: "apoderado",
                     accionFuncional: "aprobar", rol: "APODERADO", aprobado: "1", contexto: ctx });
}

/** OBSERVAR (Apoderado) → ZfiWsH2hObs + decision "observar" */
async function apoderadoObservar({ propuesta, currentUser, taskId, contexto, comentario }) {
  const usuario = await gw.obtenerUsuariosSAP("APODERADO", propuesta.Sociedad, currentUser.name);
  if (!usuario?.sUserSAP) throw new Error("No se pudo validar su usuario de apoderado");

  const payloadObservacion = cpi.buildObsPayload(propuesta, usuario.sUserSAP, comentario, "OBAP");
  await cpi.registrarObservacionSAP(payloadObservacion);

  propuesta.EstadoPP = "OBS_APODER";
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "apoderado",
                     accionFuncional: "observar", rol: "APODERADO", aprobado: "0",
                     comentario, contexto });
}

// ─── CAJA (100% CAP — sin user task BPA) ──────────────────────────────────────

/** CONFIRMAR_PAGO (Caja) — acción CAP-only */
async function cajaConfirmarPago({ propuesta, currentUser, taskId, contexto }) {
  propuesta.EstadoPP = "PAGADO";
  const ctx = { ...contexto, bTerminar: true };
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "caja",
                     accionFuncional: "aprobar", rol: "CAJA", aprobado: "1", contexto: ctx });
}

/** OBSERVAR (Caja) → ZfiWsH2hObs — acción CAP-only (registro CPI + estado) */
async function cajaObservar({ propuesta, currentUser, taskId, contexto, comentario }) {
  const usuario = await gw.obtenerUsuariosSAP("SUPERVISOR", propuesta.Sociedad);
  const userSAP = usuario?.sUserSAP ?? "";

  const payloadObservacion = cpi.buildObsPayload(propuesta, userSAP, comentario, "OBCA");
  await cpi.registrarObservacionSAP(payloadObservacion);

  propuesta.EstadoPP = "OBS_CAJA";
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "caja",
                     accionFuncional: "observar", rol: "CAJA", aprobado: "0",
                     comentario, contexto });
}

// ─── HELPERS COMPARTIDOS (rutas del Coordinador) ──────────────────────────────

/** Enruta al Revisor/Liberador. El Coordinador completa con decision "aprobar". */
async function _enviarRevisor({ propuesta, currentUser, taskId, contexto }) {
  const usuarios = await gw.obtenerUsuariosSAP("REVISOR", propuesta.Sociedad);
  if (!usuarios) throw new Error("No se pudo obtener la lista de revisores");
  propuesta.EstadoPP = "REVISION";
  gw.enviarCorreoAprobadores(propuesta, "RV");
  const ctx = { ...contexto,
    usrRevisor: usuarios.sUsuarios,
    bRevisor  : true,
    TaskTitle : _buildTaskTitle(contexto.TaskTitle, "R"),
  };
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "coordinador",
                     accionFuncional: "aprobar", rol: "SUPERVISOR", aprobado: "1", contexto: ctx });
}

/** Enruta al Apoderado. El Coordinador completa con decision "aprobar". */
async function _enviarApoderado({ propuesta, currentUser, taskId, contexto }) {
  const usuarios = await gw.obtenerUsuariosSAP("APODERADO", propuesta.Sociedad);
  if (!usuarios) throw new Error("No se pudo obtener la lista de apoderados");
  propuesta.EstadoPP = "EN_FIRMA";
  gw.enviarCorreoAprobadores(propuesta, "AP");
  const ctx = { ...contexto,
    usrApoderado: usuarios.sUsuarios,
    bRevisor    : false,
    bAprobado   : true,
    TaskTitle   : _buildTaskTitle(contexto.TaskTitle, "A"),
  };
  return _ejecutar({ propuesta, currentUser, taskId, perfil: "coordinador",
                     accionFuncional: "aprobar", rol: "SUPERVISOR", aprobado: "1", contexto: ctx });
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