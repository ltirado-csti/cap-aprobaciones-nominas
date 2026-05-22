"use strict";
/**
 * domain/aprobacion.service.js
 *
 * Lógica de dominio del flujo de aprobación.
 *
 * Cubre:
 *   - Enrutamiento por rol y vía de pago (la lógica de los 5 ficheros logica/)
 *   - Construcción del contexto BPA actualizado (TaskTitle, flags, usuarios)
 *   - Orquestación: guardarConfirmacion → updatePropuestaPago → completarTareaWF
 *   - Registro de firma Apoderado (F1/F2) vía CPI
 *   - Registro de observación vía CPI
 *   - Envío de correo (fire-and-forget)
 *
 * Depende de:
 *   infrastructure/hana-client       → guardarConfirmacion, updatePropuestaPago
 *   infrastructure/sap-gateway-client → obtenerUsuariosSAP, checkPerfilSAP,
 *                                       contarFirmasSAP, enviarCorreoAprobadores
 *   infrastructure/cpi-client        → registrarAprobacionSAP, registrarObservacionSAP
 *   infrastructure/bpa-client        → completarTarea, cerrarFlujo
 *   domain/propuesta.service         → actualizarEstado, buildHanaPath
 */

const hana  = require("../infrastructure/hana-client");
const gw    = require("../infrastructure/sap-gateway-client");
const cpi   = require("../infrastructure/cpi-client");
const bpa   = require("../infrastructure/bpa-client");
const prop  = require("./propuesta.service");
const cds   = require("@sap/cds");
const LOG   = cds.log("aprobacion.service");

// ─── HELPERS INTERNOS ────────────────────────────────────────────────────────

/**
 * Construye el TaskTitle actualizado.
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
 * Orquestador principal de cada acción de aprobación.
 * Orden garantizado: guardarConfirmacion → updatePropuestaPago → completarTareaWF
 *
 * @param {object} opts
 *   pp          : propuestaPago (con EstadoPP ya actualizado)
 *   currentUser : { name }
 *   taskId      : InstanceID BPA
 *   accion      : "confirm" | "Reject"
 *   rol         : "SUPERVISOR" | "REVISOR" | "APODERADO" | "CAJA" | "ANALISTA_T"
 *   aprobado    : "1" | "0"
 *   comentario  : string
 *   contexto    : objeto contexto.json completo (ya modificado con nuevos flags/usuarios)
 *   oApoReg     : payload ZfiWsH2hApoReg | null
 *   guardarConf : boolean (default true) — false cuando ya se llamó antes
 */
async function _ejecutar({ pp, currentUser, taskId, accion, rol, aprobado,
                           comentario = "", contexto, oApoReg = null, guardarConf = true }) {
  // 1. Guardar registro de aprobación en HANA
  if (guardarConf) {
    await hana.guardarConfirmacion(pp, currentUser.name, rol, aprobado, comentario);
  }

  // 2. Actualizar EstadoPP en HANA (bug #8 corregido: siempre antes de BPA)
  await prop.actualizarEstado(pp, currentUser);

  // 3. Completar tarea en BPA
  const hanaPath = prop.buildHanaPath(pp);
  const resultado = await bpa.completarTarea(taskId, accion, {
    pp, currentUser, rol, aprobado, comentario, contexto, oApoReg, hanaPath,
  });

  if (!resultado.success) throw new Error(resultado.mensaje);
  return resultado;
}

// ─── ANALISTA TESORERÍA ───────────────────────────────────────────────────────

/**
 * Migrado de: AnalistaTesorería.js → botón ENVIAR_SUPER_CAJA
 *
 * Enrutamiento:
 *   ViaPago W       → EN_CAJA     (TaskTitle sufijo "C")
 *   ViaPago I o Z   → VALIDACION  (TaskTitle sufijo "S")
 */
async function enviarSupervisorOCaja({ pp, currentUser, taskId, contexto, constantes }) {
  const { ViaPago, Sociedad } = pp;
  const aValidarViaPago = constantes?.aValidarViaPago ?? [];

  // Validar adelanto primero (bloquea si hay adelanto sin adjunto)
  const errAdelanto = await prop.validarAdelanto(pp);
  if (errAdelanto) throw new Error(errAdelanto);

  if (ViaPago === "W") {
    const usuarios = await gw.obtenerUsuariosSAP("CAJA", Sociedad);
    if (!usuarios) throw new Error("No se pudo obtener la lista de Caja");

    pp.EstadoPP = "EN_CAJA";
    contexto = { ...contexto,
      usrCaja  : usuarios.sUsuarios,
      bCaja    : true,
      TaskTitle: _buildTaskTitle(contexto.TaskTitle, "C"),
    };
    return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                       rol: "ANALISTA_T", aprobado: "1", contexto });
  }

  if (ViaPago === "I" || ViaPago === "Z") {
    const usuarios = await gw.obtenerUsuariosSAP("SUPERVISOR", Sociedad);
    if (!usuarios) throw new Error("No se pudo obtener la lista de Supervisores");

    pp.EstadoPP = "VALIDACION";
    contexto = { ...contexto,
      usrSupervisor: usuarios.sUsuarios,
      bCaja        : false,
      TaskTitle    : _buildTaskTitle(contexto.TaskTitle, "S"),
    };
    // Enviar correo al supervisor (fire-and-forget)
    gw.enviarCorreoAprobadores(pp, "TR",
      constantes?.oTesoreros?.[Sociedad] ?? constantes?.oTesoreros?.default
    );
    return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                       rol: "ANALISTA_T", aprobado: "1", contexto });
  }

  throw new Error(`Vía de pago '${ViaPago}' no tiene enrutamiento definido`);
}

/**
 * Migrado de: AnalistaTesorería.js → botón COMPENSAR
 * Requiere oDocCompensa del servicio SAP (ya resuelto en el handler)
 */
async function compensar({ pp, currentUser, taskId, contexto, oDocCompensa }) {
  const oRpta = oDocCompensa["n0:ZfiWsConsultarPropagoResponse"];
  if (!oRpta || oRpta.EpFlag !== "EXISTE") {
    throw new Error("No existe documento de compensación para esta propuesta");
  }
  pp.NroDocCompensacion = oRpta.EpNrodoccomp;
  pp.FechaCompensacion  = oRpta.EpFecdoccomp;
  pp.EstadoPP           = "COMPENSADO";
  contexto = { ...contexto, bTerminar: true };
  return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                     rol: "ANALISTA_T", aprobado: "1", contexto });
}

/** CERRAR_OBS */
async function cerrarPorObservacion({ pp, currentUser, taskId, contexto }) {
  pp.EstadoPP = "CERRADO_OB";
  contexto = { ...contexto, bTerminar: true };
  return _ejecutar({ pp, currentUser, taskId, accion: "Reject",
                     rol: "ANALISTA_T", aprobado: "0", contexto });
}

/** ELIMINAR_DOC */
async function eliminarDoc({ pp, currentUser, taskId, contexto }) {
  pp.EstadoPP = "ELIMINADO";
  contexto = { ...contexto, bTerminar: true };
  return _ejecutar({ pp, currentUser, taskId, accion: "Reject",
                     rol: "ANALISTA_T", aprobado: "0", contexto });
}

// ─── SUPERVISOR ───────────────────────────────────────────────────────────────

/**
 * Migrado de: Supervisor.js → botón APROBAR_PP
 *
 * Enrutamiento real verificado:
 *   OBS_APODER / OBS_REVISO → CAR o sociedad sin revisión → Apoderado
 *                           → H2H con revisión → Revisor
 *   H2H normal              → igual que arriba
 *   CAR                     → checkPerfilSAP("TR") → Revisor o Apoderado
 *   ViaPago Z o I           → APROBADO → AnalistaTesorería
 */
async function supervisorAprobar({ pp, currentUser, taskId, contexto, constantes }) {
  const { EstadoPP, NroPP, ViaPago, Sociedad, ModalidadPP } = pp;
  const aSociedadesRevision = constantes?.aSociedadesRevision ?? [];

  const necesitaRevisor = !NroPP.includes("CAR") && ViaPago !== "C"
                        && aSociedadesRevision.includes(Sociedad);

  // Re-aprobación desde estado observado
  if (EstadoPP === "OBS_APODER" || EstadoPP === "OBS_REVISO") {
    return necesitaRevisor
      ? _enviarRevisor({ pp, currentUser, taskId, contexto, rol: "SUPERVISOR" })
      : _enviarApoderado({ pp, currentUser, taskId, contexto, rol: "SUPERVISOR" });
  }

  if (ModalidadPP?.includes("H2H")) {
    return necesitaRevisor
      ? _enviarRevisor({ pp, currentUser, taskId, contexto, rol: "SUPERVISOR" })
      : _enviarApoderado({ pp, currentUser, taskId, contexto, rol: "SUPERVISOR" });
  }

  if (ModalidadPP === "CAR") {
    const oCheck = await gw.checkPerfilSAP(pp, "TR");
    const esTeso = oCheck?.Existe === "";
    return (esTeso && aSociedadesRevision.includes(Sociedad))
      ? _enviarRevisor({ pp, currentUser, taskId, contexto, rol: "SUPERVISOR" })
      : _enviarApoderado({ pp, currentUser, taskId, contexto, rol: "SUPERVISOR" });
  }

  if (ViaPago === "Z" || ViaPago === "I") {
    const usuarios = await gw.obtenerUsuariosSAP("ANALISTA_T", Sociedad);
    if (!usuarios) throw new Error("No se pudo obtener la lista de analistas");
    pp.EstadoPP = "APROBADO";
    const ctx = { ...contexto,
      usrAnalista: usuarios.sUsuarios,
      bRevisor   : false,
      bAnalista  : true,
      TaskTitle  : _buildTaskTitle(contexto.TaskTitle, "AT"),
    };
    gw.enviarCorreoAprobadores(pp, "TR",
      constantes?.oTesoreros?.[Sociedad] ?? constantes?.oTesoreros?.default
    );
    return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                       rol: "SUPERVISOR", aprobado: "1", contexto: ctx });
  }

  throw new Error("No se pudo determinar el flujo de aprobación");
}

/** TERMINAR_FLUJO (Supervisor) */
async function supervisorTerminarFlujo({ pp, currentUser, taskId, contexto, constantes }) {
  const aValidarViaPago = constantes?.aValidarViaPago ?? [];
  if (aValidarViaPago.includes(pp.ViaPago)) {
    throw new Error("Esta acción no es válida para la vía de pago C, I, W o Z");
  }
  return bpa.cerrarFlujo(taskId);
}

/** OBSERVAR (Supervisor) → ZfiWsH2hObs en SAP vía CPI */
async function supervisorObservar({ pp, currentUser, taskId, contexto, comentario }) {
  // Obtener usuarioSAP del supervisor actual
  const oUser = await gw.obtenerUsuariosSAP("SUPERVISOR", pp.Sociedad, currentUser.name);
  if (!oUser?.sUserSAP) throw new Error("No se pudo validar su usuario de supervisor");

  const oObs = cpi.buildObsPayload(pp, oUser.sUserSAP, comentario, "OBTR");
  await cpi.registrarObservacionSAP(oObs); // si falla, se lanza excepción (sí bloquea)

  pp.EstadoPP = "OBS_SUPER";
  const ctx = { ...contexto, bAnulado: true };
  return _ejecutar({ pp, currentUser, taskId, accion: "Reject",
                     rol: "SUPERVISOR", aprobado: "0", comentario, contexto: ctx });
}

// ─── REVISOR ──────────────────────────────────────────────────────────────────

/**
 * Migrado de: Revisor.js → botón APROBAR_PP
 * Guarda confirmación y envía al Apoderado con payload ApoReg inicial.
 */
async function revisorAprobar({ pp, currentUser, taskId, contexto, comentario }) {
  await hana.guardarConfirmacion(pp, currentUser.name, "REVISOR", "1", comentario);

  const usuarios = await gw.obtenerUsuariosSAP("APODERADO", pp.Sociedad);
  if (!usuarios) throw new Error("No se pudo obtener la lista de apoderados");

  // ApoReg inicial F1 (el revisor prepara la firma para el apoderado)
  const oApoReg = cpi.buildApoRegPayload(pp, "", 0); // userSAP se completará en el step Apoderado

  pp.EstadoPP = "EN_FIRMA";
  const ctx = { ...contexto,
    usrApoderado: usuarios.sUsuarios,
    bAprobado   : true,
    TaskTitle   : _buildTaskTitle(contexto.TaskTitle, "A"),
  };
  gw.enviarCorreoAprobadores(pp, "AP");

  return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                     rol: "REVISOR", aprobado: "1", comentario, contexto: ctx,
                     oApoReg, guardarConf: false }); // ya se guardó arriba
}

/** OBSERVAR (Revisor) → ZfiWsH2hObs */
async function revisorObservar({ pp, currentUser, taskId, contexto, comentario }) {
  const oUser = await gw.obtenerUsuariosSAP("APODERADO", pp.Sociedad, currentUser.name);
  if (!oUser?.sUserSAP) throw new Error("No se pudo validar su usuario de revisor");

  const oObs = cpi.buildObsPayload(pp, oUser.sUserSAP, comentario, "OBRA");
  await cpi.registrarObservacionSAP(oObs);

  await hana.guardarConfirmacion(pp, currentUser.name, "REVISOR", "0", comentario);
  pp.EstadoPP = "OBS_REVISOR";
  return _ejecutar({ pp, currentUser, taskId, accion: "Reject",
                     rol: "REVISOR", aprobado: "0", comentario,
                     contexto, guardarConf: false });
}

// ─── APODERADO ────────────────────────────────────────────────────────────────

/**
 * Migrado de: Apoderado.js → botón APROBAR_PP (firma)
 *
 * Lógica crítica:
 *   1. obtenerUsuariosSAP(APODERADO) con usuario actual → obtiene sUserSAP
 *   2. contarFirmasSAP → determina F1 (iContadorFirma=0) vs F2 (≥1)
 *   3. buildApoRegPayload → PiEstado F1|F2
 *   4. Registrar en SAP vía CPI /apoReg (ANTES de completar BPA)
 *   5. Si F2 → EstadoPP=FIRMADO, sufijo "S"; si F1 → sigue EN_FIRMA, sufijo "A"
 */
async function apoderadoFirmar({ pp, currentUser, taskId, contexto, constantes }) {
  const Sociedad = pp.Sociedad;
  const aSociedadesTermina = constantes?.aSociedadesTermina ?? [];

  // 1. Validar usuario apoderado actual
  const oUserActual = await gw.obtenerUsuariosSAP("APODERADO", Sociedad, currentUser.name);
  if (!oUserActual?.sUserSAP) throw new Error("No se pudo validar su usuario de apoderado");

  // 2. Lista completa de apoderados (para asignar los restantes en el contexto)
  const oTodos = await gw.obtenerUsuariosSAP("APODERADO", Sociedad);
  const sRestantes = (oTodos?.sUsuarios ?? "")
    .split(",")
    .filter(u => u.trim() !== currentUser.name)
    .join(",");

  // 3. Contar firmas SAP ya registradas
  const oFirmas = await gw.contarFirmasSAP(pp);
  if (!oFirmas) throw new Error("Error al contar firmas. Por favor intente nuevamente");
  const iContadorFirma = oFirmas.Firmas ?? 0;

  // 4. Construir payload ApoReg con F1 o F2
  const oApoReg = cpi.buildApoRegPayload(pp, oUserActual.sUserSAP, iContadorFirma);

  // 5. Registrar firma en SAP vía CPI ANTES de completar BPA
  const oRptaApoReg = await cpi.registrarAprobacionSAP(oApoReg);
  if (oRptaApoReg?.["n0:ZfiWsH2hApoRegResponse"]?.EpMensaje &&
      !oRptaApoReg["n0:ZfiWsH2hApoRegResponse"].EpMensaje.includes("OK")) {
    throw new Error(oRptaApoReg["n0:ZfiWsH2hApoRegResponse"].EpMensaje);
  }

  // 6. Determinar nuevo estado
  const esFirmado = iContadorFirma >= 1;
  pp.EstadoPP = esFirmado ? "FIRMADO" : "EN_FIRMA";

  let usrSupervisor = contexto.usrSupervisor ?? "";
  if (esFirmado) {
    const oSup = await gw.obtenerUsuariosSAP("SUPERVISOR", Sociedad);
    if (oSup) usrSupervisor = oSup.sUsuarios;
  }

  const ctx = { ...contexto,
    iContadorFirma  : iContadorFirma + 1,
    usrApoderado    : sRestantes,
    usrSupervisor,
    bAprobado       : true,
    bConforme       : esFirmado,
    bConformeTermina: esFirmado && aSociedadesTermina.includes(Sociedad),
    TaskTitle       : _buildTaskTitle(contexto.TaskTitle, esFirmado ? "S" : "A"),
  };

  if (!esFirmado) gw.enviarCorreoAprobadores(pp, "AP");

  return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                     rol: "APODERADO", aprobado: "1", contexto: ctx,
                     oApoReg });
}

/** OBSERVAR (Apoderado) → ZfiWsH2hObs */
async function apoderadoObservar({ pp, currentUser, taskId, contexto, comentario }) {
  const oUser = await gw.obtenerUsuariosSAP("APODERADO", pp.Sociedad, currentUser.name);
  if (!oUser?.sUserSAP) throw new Error("No se pudo validar su usuario de apoderado");

  const oObs = cpi.buildObsPayload(pp, oUser.sUserSAP, comentario, "OBAP");
  await cpi.registrarObservacionSAP(oObs);

  pp.EstadoPP = "OBS_APODER";
  return _ejecutar({ pp, currentUser, taskId, accion: "Reject",
                     rol: "APODERADO", aprobado: "0", comentario, contexto });
}

// ─── CAJA ─────────────────────────────────────────────────────────────────────

/** CONFIRMAR_PAGO (Caja) */
async function cajaConfirmarPago({ pp, currentUser, taskId, contexto }) {
  pp.EstadoPP = "PAGADO";
  const ctx = { ...contexto, bTerminar: true };
  return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                     rol: "CAJA", aprobado: "1", contexto: ctx });
}

/** OBSERVAR (Caja) → ZfiWsH2hObs */
async function cajaObservar({ pp, currentUser, taskId, contexto, comentario }) {
  const oUser = await gw.obtenerUsuariosSAP("SUPERVISOR", pp.Sociedad);
  const userSAP = oUser?.sUserSAP ?? "";

  const oObs = cpi.buildObsPayload(pp, userSAP, comentario, "OBCA");
  await cpi.registrarObservacionSAP(oObs);

  pp.EstadoPP = "OBS_CAJA";
  return _ejecutar({ pp, currentUser, taskId, accion: "Reject",
                     rol: "CAJA", aprobado: "0", comentario, contexto });
}

// ─── HELPERS COMPARTIDOS ──────────────────────────────────────────────────────

async function _enviarRevisor({ pp, currentUser, taskId, contexto, rol }) {
  const usuarios = await gw.obtenerUsuariosSAP("REVISOR", pp.Sociedad);
  if (!usuarios) throw new Error("No se pudo obtener la lista de revisores");
  pp.EstadoPP = "REVISION";
  gw.enviarCorreoAprobadores(pp, "RV");
  const ctx = { ...contexto,
    usrRevisor: usuarios.sUsuarios,
    bRevisor  : true,
    TaskTitle : _buildTaskTitle(contexto.TaskTitle, "R"),
  };
  return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                     rol, aprobado: "1", contexto: ctx });
}

async function _enviarApoderado({ pp, currentUser, taskId, contexto, rol }) {
  const usuarios = await gw.obtenerUsuariosSAP("APODERADO", pp.Sociedad);
  if (!usuarios) throw new Error("No se pudo obtener la lista de apoderados");
  pp.EstadoPP = "EN_FIRMA";
  gw.enviarCorreoAprobadores(pp, "AP");
  const ctx = { ...contexto,
    usrApoderado: usuarios.sUsuarios,
    bRevisor    : false,
    bAprobado   : true,
    TaskTitle   : _buildTaskTitle(contexto.TaskTitle, "A"),
  };
  return _ejecutar({ pp, currentUser, taskId, accion: "confirm",
                     rol, aprobado: "1", contexto: ctx });
}

module.exports = {
  // Analista Tesorería
  enviarSupervisorOCaja,
  compensar,
  cerrarPorObservacion,
  eliminarDoc,
  // Supervisor
  supervisorAprobar,
  supervisorTerminarFlujo,
  supervisorObservar,
  // Revisor
  revisorAprobar,
  revisorObservar,
  // Apoderado
  apoderadoFirmar,
  apoderadoObservar,
  // Caja
  cajaConfirmarPago,
  cajaObservar,
};
