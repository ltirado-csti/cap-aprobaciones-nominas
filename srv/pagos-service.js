"use strict";
/**
 * srv/pagos-service.js
 *
 * Implementación del PagosService usando el patrón cds.ApplicationService.
 *
 * Cada grupo de acciones se encapsula en un método estático handle_*
 * El init() los descubre automáticamente por prefijo y los registra.
 *
 * Grupos definidos:
 *   handle_master()        → obtenerConstantes, obtenerDetalle
 *   handle_analistaT()     → enviarSupervisorOCaja, compensar, cerrarPorObservacion, eliminarDoc
 *   handle_supervisor()    → supervisorAprobar, supervisorTerminarFlujo, supervisorObservar
 *   handle_revisor()       → revisorAprobar, revisorObservar
 *   handle_apoderado()     → apoderadoFirmar, apoderadoObservar
 *   handle_caja()          → cajaConfirmarPago, cajaObservar
 */

const cds      = require("@sap/cds");
const aprobSvc = require("./domain/aprobacion.service");
const propSvc  = require("./domain/propuesta.service");
const constSvc = require("./domain/constantes.service");
const cpiInfra = require("./infrastructure/cpi-client");
const bpa      = require("./infrastructure/bpa-client");

const LOG = cds.log("PagosService");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Envuelve una llamada al domain service con manejo de error uniforme.
 * Los errores de negocio se devuelven como 400; los inesperados como 500.
 */
function _handle(req, fn) {
  return fn().catch(e => {
    LOG.error(`[${req.event}] ERROR`, e.message);
    return req.error(e.status ?? 400, e.message);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICIO
// ═══════════════════════════════════════════════════════════════════════════════

class PagosService extends cds.ApplicationService {

  // ─── Bootstrap ─────────────────────────────────────────────────────────────

  /**
   * init() descubre todos los métodos estáticos con prefijo "handle_"
   * y los ejecuta en el contexto de esta instancia para registrar
   * los listeners srv.on(...) de cada grupo.
   */
  init() {
    const handlers = Object.getOwnPropertyNames(PagosService)
      .filter(name => name.startsWith("handle_"));

    for (const handler of handlers) {
      PagosService[handler].call(this);
    }

    LOG.info(`PagosService iniciado | handlers registrados: ${handlers.join(", ")}`);
    return super.init();
  }

  // ─── MASTER ────────────────────────────────────────────────────────────────
  // Acciones del Master.controller.js: constantes y lectura inicial del Detail

  static handle_master() {
    /**
     * GET /api/v1/obtenerConstantes()
     * Carga las constantes de negocio desde HANA XSOData /Constantes.
     * Usado en onInit() del Master.controller.js (solo desktop).
     * Resultado cacheado en memoria durante la vida del proceso CAP.
     */
    this.on("obtenerConstantes", async (_req) => {
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

    /**
     * GET /api/v1/obtenerDetalle(taskId=...)
     * Lectura inicial del Detail.controller.js al abrir una tarea del Inbox.
     * Reemplaza: readContext(sTaskID) + getPropuestaPago() + getConstantes()
     * en _onBindingChange() del Detail.controller.js original.
     *
     * Flujo:
     *   1. Lee el contexto BPA (NroPP, Sociedad, flags, usuarios asignados...)
     *   2. Lee o crea la PropuestaPago en HANA XSOData
     *   3. Retorna pp + contexto + constantes en un solo round-trip
     */
    this.on("obtenerDetalle", async (req) => {
      const { taskId } = req.data;

      const contexto = await bpa.readContext(taskId);
      if (!contexto) return req.error(404, "No se pudo obtener el contexto de la tarea BPA");

      const pp = await propSvc.obtenerOCrearPropuesta(contexto, taskId);
      if (!pp) return req.error(404, `Propuesta ${contexto.NroPP} no encontrada`);

      const { rpta: constantes } = await constSvc.getConstantes();
      return { pp, contexto, constantes };
    });
  }

  // ─── ANALISTA TESORERÍA ────────────────────────────────────────────────────
  // Acciones del AnalistaTesoreria.js: enviar, compensar, cerrar, eliminar

  static handle_analistaT() {
    /**
     * POST /api/v1/enviarSupervisorOCaja
     * Enruta según ViaPago:
     *   W → EN_CAJA     (asigna usuarios Caja)
     *   I / Z → VALIDACION (asigna usuarios Supervisor)
     * Valida adelanto (checkAdelanto + evaluarDocumentoAdjunto) antes de enrutar.
     */
    this.on("enviarSupervisorOCaja", (req) =>
      _handle(req, () => aprobSvc.enviarSupervisorOCaja(req.data))
    );

    /**
     * POST /api/v1/compensar
     * Obtiene el documento de compensación desde CPI (/compensacion/consultar)
     * y actualiza NroDocCompensacion + FechaCompensacion en HANA.
     */
    this.on("compensar", async (req) => {
      return _handle(req, async () => {
        const oDocCompensa = await cpiInfra.consultarCompensacion(req.data.pp);
        if (!oDocCompensa) throw Object.assign(
          new Error("No se pudo obtener el documento de compensación desde SAP"),
          { status: 500 }
        );
        return aprobSvc.compensar({ ...req.data, oDocCompensa });
      });
    });

    /**
     * POST /api/v1/cerrarPorObservacion
     * Cierra la propuesta observada por el Supervisor (OBS_SUPER → CERRADO_OB).
     */
    this.on("cerrarPorObservacion", (req) =>
      _handle(req, () => aprobSvc.cerrarPorObservacion(req.data))
    );

    /**
     * POST /api/v1/eliminarDoc
     * Elimina el documento generado (GENERADO → ELIMINADO).
     */
    this.on("eliminarDoc", (req) =>
      _handle(req, () => aprobSvc.eliminarDoc(req.data))
    );
  }

  // ─── SUPERVISOR ────────────────────────────────────────────────────────────
  // Acciones del Supervisor.js: aprobar, terminar flujo, observar

  static handle_supervisor() {
    /**
     * POST /api/v1/supervisorAprobar
     * Enrutamiento según ModalidadPP, NroPP, ViaPago y aSociedadesRevision:
     *   H2H + sociedad con revisión + no CAR + no via C → Revisor
     *   H2H resto → Apoderado
     *   CAR + checkPerfilSAP(TR) → Revisor o Apoderado
     *   ViaPago Z o I → AnalistaTesorería (APROBADO)
     */
    this.on("supervisorAprobar", (req) =>
      _handle(req, () => aprobSvc.supervisorAprobar(req.data))
    );

    /**
     * POST /api/v1/supervisorTerminarFlujo
     * Cancela la instancia BPA completa (cerrarFlujo).
     * Bloqueado para vías de pago C, I, W, Z (aValidarViaPago).
     */
    this.on("supervisorTerminarFlujo", (req) =>
      _handle(req, () => aprobSvc.supervisorTerminarFlujo(req.data))
    );

    /**
     * POST /api/v1/supervisorObservar
     * VALIDACION → OBS_SUPER.
     * Registra observación en SAP vía CPI (/Obs → ZfiWsH2hObs PiEstado=OBTR).
     */
    this.on("supervisorObservar", (req) =>
      _handle(req, () => aprobSvc.supervisorObservar(req.data))
    );
  }

  // ─── REVISOR ───────────────────────────────────────────────────────────────
  // Acciones del Revisor.js: aprobar, observar

  static handle_revisor() {
    /**
     * POST /api/v1/revisorAprobar
     * Guarda confirmación en HANA + envía al Apoderado con ApoReg F1 inicial.
     * REVISION → EN_FIRMA.
     */
    this.on("revisorAprobar", (req) =>
      _handle(req, () => aprobSvc.revisorAprobar(req.data))
    );

    /**
     * POST /api/v1/revisorObservar
     * REVISION → OBS_REVISOR.
     * Registra observación vía CPI (ZfiWsH2hObs PiEstado=OBRA).
     */
    this.on("revisorObservar", (req) =>
      _handle(req, () => aprobSvc.revisorObservar(req.data))
    );
  }

  // ─── APODERADO ─────────────────────────────────────────────────────────────
  // Acciones del Apoderado.js: firmar (F1/F2), observar

  static handle_apoderado() {
    /**
     * POST /api/v1/apoderadoFirmar
     * Lógica crítica de firma F1/F2:
     *   1. obtenerUsuariosSAP(APODERADO) → obtiene sUserSAP del firmante actual
     *   2. contarFirmasSAP(pp) → determina si es primera (F1) o segunda firma (F2)
     *   3. buildApoRegPayload → construye ZfiWsH2hApoReg
     *   4. registrarAprobacionSAP → llama CPI /apoReg ANTES de completar BPA
     *   5. F1: sigue EN_FIRMA | F2: FIRMADO
     */
    this.on("apoderadoFirmar", (req) =>
      _handle(req, () => aprobSvc.apoderadoFirmar(req.data))
    );

    /**
     * POST /api/v1/apoderadoObservar
     * EN_FIRMA → OBS_APODER.
     * Registra observación vía CPI (ZfiWsH2hObs PiEstado=OBAP).
     */
    this.on("apoderadoObservar", (req) =>
      _handle(req, () => aprobSvc.apoderadoObservar(req.data))
    );
  }

  // ─── CAJA ──────────────────────────────────────────────────────────────────
  // Acciones del Caja.js: confirmar pago, observar

  static handle_caja() {
    /**
     * POST /api/v1/cajaConfirmarPago
     * EN_CAJA → PAGADO. Completa el flujo BPA con bTerminar=true.
     */
    this.on("cajaConfirmarPago", (req) =>
      _handle(req, () => aprobSvc.cajaConfirmarPago(req.data))
    );

    /**
     * POST /api/v1/cajaObservar
     * EN_CAJA → OBS_CAJA.
     * Registra observación vía CPI (ZfiWsH2hObs PiEstado=OBCA).
     */
    this.on("cajaObservar", (req) =>
      _handle(req, () => aprobSvc.cajaObservar(req.data))
    );
  }
}

module.exports = { PagosService };