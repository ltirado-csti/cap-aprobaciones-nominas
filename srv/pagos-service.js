"use strict";
/**
 * srv/pagos-service.js
 *
 * Implementación del PagosService usando el patrón cds.ApplicationService.
 *
 * Grupos de handlers registrados automáticamente por init():
 *   handle_master()        → obtenerConstantes
 *   handle_inbox()         → READ TareasInbox (List Report + Object Page)
 *   handle_composiciones() → READ Proveedor, Adjunto, Aprobador
 *   handle_analistaT()     → enviarSupervisorOCaja, compensar, cerrarPorObservacion, eliminarDoc
 *   handle_supervisor()    → supervisorAprobar, supervisorTerminarFlujo, supervisorObservar, supervisorAnular
 *   handle_revisor()       → revisorAprobar, revisorObservar
 *   handle_apoderado()     → apoderadoFirmar, apoderadoObservar, redirigirApoderado
 *   handle_caja()          → cajaConfirmarPago, cajaObservar
 */

const cds      = require("@sap/cds");
const aprobSvc = require("./domain/aprobacion.service");
const propSvc  = require("./domain/propuesta.service");
const constSvc = require("./domain/constantes.service");
const cpiInfra = require("./infrastructure/cpi-client");
const bpa      = require("./infrastructure/bpa-client");
const { Readable } = require("stream");

const LOG = cds.log("PagosService");

// ─── Helper de error uniforme ─────────────────────────────────────────────────

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
// CLASE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

class PagosService extends cds.ApplicationService {

  /**
   * Descubre y registra todos los métodos estáticos con prefijo "handle_".
   * Esto evita registrar cada handler manualmente en init().
   */
  init() {
    const handlers = Object.getOwnPropertyNames(PagosService)
      .filter(name => name.startsWith("handle_"));

    for (const handler of handlers) {
      PagosService[handler].call(this);
    }

    LOG.info(`PagosService iniciado | handlers: ${handlers.join(", ")}`);
    return super.init();
  }

  // ─── MASTER ───────────────────────────────────────────────────────────────

  static handle_master() {
    /**
     * GET /nomina/aprobaciones/obtenerConstantes()
     * Carga constantes de negocio desde HANA XSOData /Constantes.
     * Origen legado: onInit() del Master.controller.js
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
  }

  // ─── PDF ──────────────────────────────────────────────────────────────────

  static handle_pdf() {
    /**
     * GET /nomina/aprobaciones/PropuestaPDF('{id}')
     * Sirve el PDF de la propuesta como stream binario.
     * Sin parámetro "contenido" retorna metadatos; con él retorna el buffer.
     * Origen legado: Detail.view.xml → tab PDF → getPropuestaPDFSAP()
     */
    this.on("READ", "PropuestaPDF", async (req) => {
      const id = req.params?.[0]?.id ?? req.params?.[0];
      if (!id) return [];

      const [numeroPropuesta, sociedad, ...fechaParts] = id.split("-");
      const fechaPropuestaPago = fechaParts.join("-");

      const columns    = req.query?.SELECT?.columns ?? [];
      const esContenido = columns.some(c => c?.ref?.[0] === "contenido");

      if (esContenido) {
        return Readable.from(_getMockPDFBuffer(id));
      }

      return {
        id,
        numeroPropuesta,
        sociedad,
        fechaPropuestaPago,
        mimeType     : "application/pdf",
        nombreArchivo: `${id}.pdf`,
      };
    });
  }

  // ─── INBOX (List Report + Object Page) ───────────────────────────────────

  static handle_inbox() {
    /**
     * GET /nomina/aprobaciones/TareasInbox
     * Sin clave -> List Report: lista liviana desde BPA sin composiciones.
     * Con clave -> Object Page: detalle completo con composiciones y flags de rol.
     * Origen legado: Master.controller.js + Detail.controller.js → _onBindingChange
     */
    this.on("READ", "TareasInbox", async (req) => {
      const instanceID = req.params?.[0]?.instanceID ?? req.params?.[0];

      // Sin clave → List Report
      if (!instanceID) {
        const tareas = (await _obtenerTareasBpa());
        tareas.$count = tareas.length;
        return tareas;
      }

      // Con clave → verificar si se necesita el detalle completo de CPI.
      // FCL hace $batch con $select reducido al seleccionar filas automáticamente.
      const columnas   = req.query?.SELECT?.columns ?? [];
      const nombres    = columnas.map(c => c?.ref?.[0]).filter(Boolean);

      // Campos que pertenecen SOLO al Object Page (requieren llamada a CPI)
      const camposCPI  = ["proveedores", "adjuntos", "aprobadores",
                          "numeroPropuesta", "estadoPP", "indPAdelanto",
                          "nroDocCompensacion", "fechaCompensacion"];

      const necesitaCPI = nombres.length === 0 ||
                          nombres.some(nombre => camposCPI.includes(nombre));

      if (!necesitaCPI) {
        // FCL pidió solo campos livianos (importe, moneda, fechaPropuestaPago)
        // Retornar solo el contexto BPA sin llamar a CPI
        LOG.info(`[READ TareasInbox] $select liviano — omitiendo CPI | id=${instanceID}`);
        const contexto = await bpa.readContext(instanceID);
        return contexto ? _mapearContextoBpa(instanceID, contexto) : null;
      }

      // $select completo o vacío → detalle completo con CPI
      return await _obtenerDetalleTarea(instanceID);
    });
  }

  // ─── COMPOSICIONES ────────────────────────────────────────────────────────

  static handle_composiciones() {
    /**
     * GET /nomina/aprobaciones/TareasInbox('{id}')/proveedores
     * Retorna la lista de proveedores de la propuesta.
     * Origen legado: fragment/Proveedores.xml
     */
    this.on("READ", "Proveedor", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const oDetalle = await _obtenerDetalleTarea(instanceID);
      return oDetalle.proveedores ?? [];
    });

    /**
     * GET /nomina/aprobaciones/TareasInbox('{id}')/adjuntos
     * Retorna la lista de adjuntos de la propuesta.
     * Origen legado: fragment/Adjuntos2.xml
     */
    this.on("READ", "Adjunto", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const oDetalle = await _obtenerDetalleTarea(instanceID);
      return oDetalle.adjuntos ?? [];
    });

    /**
     * GET /nomina/aprobaciones/TareasInbox('{id}')/aprobadores
     * Retorna el historial de aprobaciones de la propuesta.
     * Origen legado: fragment/Aprobadores.xml
     */
    this.on("READ", "Aprobador", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const oDetalle = await _obtenerDetalleTarea(instanceID);
      return oDetalle.aprobadores ?? [];
    });
  }

  // ─── ANALISTA TESORERÍA — Origen: AnalistaTesoreria.js ───────────────────

  static handle_analistaT() {
    /**
     * POST /nomina/aprobaciones/enviarSupervisorOCaja
     * Enruta según viaPago: W → EN_CAJA, resto → VALIDACION
     */
    this.on("enviarSupervisorOCaja", (req) =>
      _handle(req, () => aprobSvc.enviarSupervisorOCaja(req.data))
    );

    /**
     * POST /nomina/aprobaciones/compensar
     * Obtiene documento de compensación desde CPI y actualiza la propuesta.
     */
    this.on("compensar", async (req) =>
      _handle(req, async () => {
        const oDocCompensa = await cpiInfra.consultarCompensacion(req.data.propuesta);
        if (!oDocCompensa) throw Object.assign(
          new Error("No se pudo obtener el documento de compensación desde SAP"),
          { status: 500 }
        );
        return aprobSvc.compensar({ ...req.data, oDocCompensa });
      })
    );

    /**
     * POST /nomina/aprobaciones/cerrarPorObservacion
     * OBS_SUPER → CERRADO_OB
     */
    this.on("cerrarPorObservacion", (req) =>
      _handle(req, () => aprobSvc.cerrarPorObservacion(req.data))
    );

    /**
     * POST /nomina/aprobaciones/eliminarDoc
     * GENERADO → ELIMINADO
     */
    this.on("eliminarDoc", (req) =>
      _handle(req, () => aprobSvc.eliminarDoc(req.data))
    );
  }

  // ─── SUPERVISOR — Origen: Supervisor.js ──────────────────────────────────

  static handle_supervisor() {
    /**
     * POST /nomina/aprobaciones/supervisorAprobar
     * Enruta según modalidadPP, viaPago y sociedades de revisión.
     */
    this.on("supervisorAprobar", (req) =>
      _handle(req, () => aprobSvc.supervisorAprobar(req.data))
    );

    /**
     * POST /nomina/aprobaciones/supervisorTerminarFlujo
     * Cancela la instancia BPA completa. Solo disponible cuando puedeTerminarFlujo = true.
     */
    this.on("supervisorTerminarFlujo", (req) =>
      _handle(req, () => aprobSvc.supervisorTerminarFlujo(req.data))
    );

    /**
     * POST /nomina/aprobaciones/supervisorObservar
     * VALIDACION → OBS_SUPER (CPI: ZfiWsH2hObs, PiEstado=OBTR)
     */
    this.on("supervisorObservar", (req) =>
      _handle(req, () => aprobSvc.supervisorObservar(req.data))
    );

    /**
     * POST /nomina/aprobaciones/supervisorAnular
     * Anula la propuesta. Solo disponible cuando puedeAnular = true.
     */
    this.on("supervisorAnular", (req) =>
      _handle(req, () => aprobSvc.supervisorAnular(req.data))
    );
  }

  // ─── REVISOR — Origen: Revisor.js ────────────────────────────────────────

  static handle_revisor() {
    /**
     * POST /nomina/aprobaciones/revisorAprobar
     * REVISION → EN_FIRMA
     */
    this.on("revisorAprobar", (req) =>
      _handle(req, () => aprobSvc.revisorAprobar(req.data))
    );

    /**
     * POST /nomina/aprobaciones/revisorObservar
     * REVISION → OBS_REVISOR (CPI: ZfiWsH2hObs, PiEstado=OBRA)
     */
    this.on("revisorObservar", (req) =>
      _handle(req, () => aprobSvc.revisorObservar(req.data))
    );
  }

  // ─── APODERADO — Origen: Apoderado.js ────────────────────────────────────

  static handle_apoderado() {
    /**
     * POST /nomina/aprobaciones/apoderadoFirmar
     * Lógica F1/F2: contadorFirma determina si es primera o segunda firma.
     * registrarAprobacionSAP (CPI /apoReg) se llama antes de completar BPA.
     */
    this.on("apoderadoFirmar", (req) =>
      _handle(req, () => aprobSvc.apoderadoFirmar(req.data))
    );

    /**
     * POST /nomina/aprobaciones/apoderadoObservar
     * EN_FIRMA → OBS_APODER (CPI: ZfiWsH2hObs, PiEstado=OBAP)
     */
    this.on("apoderadoObservar", (req) =>
      _handle(req, () => aprobSvc.apoderadoObservar(req.data))
    );

    /**
     * POST /nomina/aprobaciones/redirigirApoderado
     * Redirige la firma a otro apoderado. El comentario contiene el email destino.
     */
    this.on("redirigirApoderado", (req) =>
      _handle(req, () => aprobSvc.redirigirApoderado(req.data))
    );
  }

  // ─── CAJA — Origen: Caja.js ──────────────────────────────────────────────

  static handle_caja() {
    /**
     * POST /nomina/aprobaciones/cajaConfirmarPago
     * EN_CAJA → PAGADO. Cierra el flujo BPA.
     */
    this.on("cajaConfirmarPago", (req) =>
      _handle(req, () => aprobSvc.cajaConfirmarPago(req.data))
    );

    /**
     * POST /nomina/aprobaciones/cajaObservar
     * EN_CAJA → OBS_CAJA (CPI: ZfiWsH2hObs, PiEstado=OBCA)
     */
    this.on("cajaObservar", (req) =>
      _handle(req, () => aprobSvc.cajaObservar(req.data))
    );
  }
}

  // ═══════════════════════════════════════════════════════════════════════════════
  // FUNCIONES PRIVADAS
  // Tienen acceso a bpa, propSvc, constSvc, cpiInfra, LOG.
  // ═══════════════════════════════════════════════════════════════════════════════
  

  /**
   * Obtiene y enriquece la lista de tareas del BPA con su contexto.
   * Origen legado: Master.controller.js → getInboxTasks() + readContext()
   * @returns {Promise<Array>} Lista de TareasInbox enriquecidas con contexto
   */
  async function _obtenerTareasBpa() {
    try {
      const tareas = await bpa.getInboxTasks();
      if (!tareas.length) return [];

      // Enriquecer cada tarea con su contexto en paralelo
      const tareasEnriquecidas = await Promise.all(
        tareas.map(tarea => _enriquecerConContexto(tarea))
      );

      return tareasEnriquecidas;

    } catch (error) {
      LOG.warn(`[_obtenerTareasBpa] BPA no disponible — usando mock | ${error.message}`);
      return _getMockTareas();
    }
  }

  /**
   * Enriquece una tarea BPA con su contexto para el List Report.
   * @param {object} tarea - Tarea raw del BPA (getInboxTasks)
   * @returns {Promise<object>} TareasInbox con campos de negocio completos
   */
  async function _enriquecerConContexto(tarea) {
    try {
      const contexto  = await bpa.readContext(tarea.id);
      const propuesta = contexto?.startEvent?.propuesta ?? {};

      return {
        instanceID         : tarea.id,
        tituloTarea        : tarea.subject              || propuesta.tituloTarea      || "",
        numeroPropuesta    : propuesta.numeroPropuesta   ?? "",
        sociedad           : propuesta.sociedad          ?? "",
        banco              : propuesta.banco             ?? "",
        bancoDescripcion   : propuesta.bancoDescripcion  ?? "",
        importe            : propuesta.importe           ?? "",
        moneda             : propuesta.moneda            ?? "",
        viaPago            : propuesta.viaPago           ?? "",
        modalidadPP        : propuesta.modalidadPP       ?? "",
        version            : propuesta.version           ?? "",
        fechaPropuestaPago : propuesta.fechaPropuestaPago ?? "",
        usuarioCreacion    : propuesta.usuarioCreacion    ?? "",
        correoAnalista     : propuesta.correoAnalista     ?? "",
        // Flags de rol — leídos directamente del contexto BPA
        tieneAnalista      : propuesta.tieneAnalista      ?? false,
        estaConforme       : propuesta.estaConforme       ?? false,
        tieneRevisor       : propuesta.tieneRevisor       ?? false,
        estaAprobado       : propuesta.estaAprobado       ?? false,
        esCaja             : propuesta.esCaja             ?? false,
        estaTerminado      : propuesta.estaTerminado      ?? false,
        estaAnulado        : propuesta.estaAnulado        ?? false,
        puedeTerminarFlujo : (propuesta.estaConforme ?? false) && (propuesta.estaTerminado ?? false),
        puedeAnular        : (propuesta.estaConforme ?? false) && (propuesta.estaAnulado   ?? false),
      };

    } catch (error) {
      // readContext falló para esta tarea — retornar con datos mínimos
      // para no bloquear el resto de la lista
      LOG.warn(`[_enriquecerConContexto] readContext falló | id=${tarea.id} | ${error.message}`);
      return {
        instanceID         : tarea.id,
        tituloTarea        : tarea.subject ?? "",
        numeroPropuesta    : "", sociedad: "", banco: "", bancoDescripcion: "",
        importe            : "", moneda: "", viaPago: "", modalidadPP: "",
        version            : "", fechaPropuestaPago: "", usuarioCreacion: "",
        correoAnalista     : "",
        tieneAnalista      : false, estaConforme: false, tieneRevisor: false,
        estaAprobado       : false, esCaja: false, estaTerminado: false,
        estaAnulado        : false, puedeTerminarFlujo: false, puedeAnular: false,
      };
    }
  }

  /**
   * Obtiene el detalle completo de una tarea para la Object Page.
   * Llama a BPA y composiciones en paralelo para minimizar latencia.
   * Origen legado: Detail.controller.js → _onBindingChange()
   *
   * @param {string} instanceID - ID de la tarea BPA
   * @returns {Promise<object>} Registro completo con shape de TareasInbox
   */
  async function _obtenerDetalleTarea(instanceID) {
    try {
      // Primero obtener el contexto — las composiciones dependen de sus datos
      const contexto = await bpa.readContext(instanceID);

      if (!contexto) {
        throw Object.assign(
          new Error(`Contexto BPA no encontrado para la tarea ${instanceID}`),
          { status: 404 }
        );
      }

      const propuesta = contexto.propuesta ?? contexto;

      // Luego obtener las composiciones en paralelo usando las funciones privadas
      const [proveedores, adjuntos, aprobadores] = await Promise.all([
        _obtenerProveedores(propuesta).catch(() => []),
        _obtenerAdjuntos(propuesta).catch(() => []),
        _obtenerAprobadores(propuesta).catch(() => [])
      ]);

      return _ensamblarDetalle({ instanceID, propuesta, proveedores, adjuntos, aprobadores });

    } catch (error) {
      if (error.status === 404) throw error;
      LOG.warn(`[_obtenerDetalleTarea] BPA no disponible — usando mock | ${error.message}`);
      return _getMockDetalle(instanceID);
    }
  }

  /**
   * Ensambla el objeto final TareasInbox con campos, composiciones y flags de rol.
   *
   * Campos calculados para visibilidad doble del Supervisor
   *   puedeTerminarFlujo = estaConforme AND estaTerminado
   *   puedeAnular        = estaConforme AND estaAnulado
   *
   * @param {object} params - { instanceID, propuesta, proveedores, adjuntos, aprobadores }
   * @returns {object} Registro TareasInbox listo para la Object Page
   */
  function _ensamblarDetalle({ instanceID, propuesta, proveedores, adjuntos, aprobadores }) {
    // Campos base — nombres exactos de PropuestaNomina.json
    const base = {
      instanceID            : instanceID,
      tituloTarea           : propuesta.tituloTarea,
      numeroPropuesta       : propuesta.numeroPropuesta,
      sociedad              : propuesta.sociedad,
      banco                 : propuesta.banco,
      bancoDescripcion      : propuesta.bancoDescripcion,
      importe               : propuesta.importe,
      moneda                : propuesta.moneda,
      viaPago               : propuesta.viaPago,
      modalidadPP           : propuesta.modalidadPP,
      version               : propuesta.version,
      fechaPropuestaPago    : propuesta.fechaPropuestaPago,
      usuarioCreacion       : propuesta.usuarioCreacion,
      usuarioCreacionPP     : propuesta.usuarioCreacionPP,
      analista              : propuesta.analista,
      correoAnalista        : propuesta.correoAnalista,
      existeDocumento       : propuesta.existeDocumento,
      indicadorPagoAdelanto : propuesta.indicadorPagoAdelanto,
      contadorFirma         : propuesta.contadorFirma,
      usuarioApoderado      : propuesta.usuarioApoderado,
      usuarioCaja           : propuesta.usuarioCaja,
      usuariosRevisores     : propuesta.usuariosRevisores,
      usuariosAnalistas     : propuesta.usuariosAnalistas,
      usuariosSupervisores  : propuesta.usuariosSupervisores,
    };

    // Flags de visibilidad por rol (Tareas 3.1 a 3.5)
    // Nombres exactos de PropuestaNomina.json — sin prefijo "b" del legado
    const flagsRol = {
      tieneAnalista : propuesta.tieneAnalista ?? false,
      estaConforme  : propuesta.estaConforme  ?? false,
      tieneRevisor  : propuesta.tieneRevisor  ?? false,
      estaAprobado  : propuesta.estaAprobado  ?? false,
      esCaja        : propuesta.esCaja        ?? false,
      estaTerminado : propuesta.estaTerminado ?? false,
      estaAnulado   : propuesta.estaAnulado   ?? false,
    };

    // Campos calculados para visibilidad doble del Supervisor (Tarea 3.2)
    const flagsCalculados = {
      puedeTerminarFlujo : flagsRol.estaConforme && flagsRol.estaTerminado,
      puedeAnular        : flagsRol.estaConforme && flagsRol.estaAnulado,
    };

    return {
      ...base,
      ...flagsRol,
      ...flagsCalculados,
      proveedores,
      adjuntos,
      aprobadores,
    };
  }

  /**
   * Extrae el instanceID del padre desde el path de una solicitud de composición.
   * El path de CAP viene como: TareasInbox(instanceID='...')/proveedores
   * Origen legado: ninguno — patrón nuevo de CAP para entidades virtuales.
   *
   * @param {object} req - Request CAP de una composición
   * @returns {string|null} instanceID de la tarea padre
   */
  function _extraerInstanceID(req) {
    const aParams = req.params ?? [];

    // Caso 1: params[0] es objeto con propiedad instanceID (navegación OData)
    if (aParams[0]?.instanceID) return aParams[0].instanceID;

    // Caso 2: params[0] es string directo
    if (typeof aParams[0] === "string") return aParams[0];

    // Caso 3: viene como filtro en el query (Fiori Elements en algunos escenarios)
    const sFromQuery = req.query?.SELECT?.from?.ref?.[0]?.where?.find?.(
      w => w?.ref?.[0] === "instanceID"
    )?.val;

    return sFromQuery ?? null;
  }

  /**
   * Obtiene los proveedores beneficiarios de la propuesta desde CPI.
   * Delega a cpi-client para respetar la separación de capas.
   * Origen legado: Detail.controller.js → getProveedoresInfo()
   *
   * @param {object} propuesta - Contexto BPA con numeroPropuesta, sociedad, fechaPropuestaPago
   * @returns {Promise<Array>} Lista de proveedores para la composición Proveedor
   */
  async function _obtenerProveedores(propuesta) {
    return cpiInfra.getProveedores(propuesta);
  }

  /**
   * Obtiene los documentos adjuntos de la propuesta desde HANA vía CPI.
   * Delega a cpi-client para respetar la separación de capas.
   * Origen legado: Detail.controller.js → getPPAdjuntos()
   *
   * @param {object} propuesta - Contexto BPA con numeroPropuesta, sociedad, fechaPropuestaPago
   * @returns {Promise<Array>} Lista de adjuntos para la composición Adjunto
   */
  async function _obtenerAdjuntos(propuesta) {
    return cpiInfra.getAdjuntos(propuesta);
  }

  /**
   * Obtiene el historial de aprobaciones de la propuesta desde HANA vía CPI.
   * Delega a cpi-client para respetar la separación de capas.
   * Origen legado: Detail.controller.js → getPropuestaPago() expand Aprobadores
   *
   * @param {object} propuesta - Contexto BPA con numeroPropuesta, sociedad, fechaPropuestaPago
   * @returns {Promise<Array>} Lista de aprobadores para la composición Aprobador
   */
  async function _obtenerAprobadores(propuesta) {
    return cpiInfra.getAprobadores(propuesta);
  }

  /**
   * Parsea "dd-MM-yyyy" (formato del contexto BPA) a objeto Date JavaScript.
   * Necesaria para claves datetime de SAP Gateway: Laufd=datetime'yyyy-MM-ddT...'
   *
   * @param {string} sFecha - Fecha en formato "dd-MM-yyyy" (ej: "20-05-2026")
   * @returns {Date} Objeto Date en hora cero UTC
   */
  function _parseFechaPP(sFecha) {
    if (!sFecha) return new Date();
    const [dd, mm, yyyy] = sFecha.split("-");
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
  }

/**
 * Mock de lista de tareas para el List Report cuando BPA no está disponible.
 * Activo en modo local (cds watch sin --profile hybrid).
 *
 * @returns {Array} 3 tareas representando los casos típicos del negocio
 */
function _getMockTareas() {
  return [
    {
      instanceID: "mock-task-001",
      context: {
        tituloTarea: "0025-R4603-BCP-20/05/2026-R", numeroPropuesta: "R4603",
        sociedad: "0025", fechaPropuestaPago: "20-05-2026", banco: "BCP",
        bancoDescripcion: "001 - BCP Soles", viaPago: "N", modalidadPP: "H2H",
        version: "0001", importe: "43038.69", moneda: "PEN",
        usuarioCreacion: "cpanduro@centria.net",
        tieneAnalista: false,
        estaConforme : false,
        tieneRevisor : true,   // ← simula rol Revisor
        estaAprobado : false,
        esCaja       : false,
        estaTerminado: false,
        estaAnulado  : false,
      }
    },
    {
      instanceID: "mock-task-002",
      context: {
        tituloTarea: "0025-R4610-SCO-21/05/2026-I", numeroPropuesta: "R4610",
        sociedad: "0025", fechaPropuestaPago: "21-05-2026", banco: "SCOTIABANK",
        bancoDescripcion: "009 - Scotiabank Soles", viaPago: "I", modalidadPP: "H2H",
        version: "0001", importe: "15200.00", moneda: "PEN",
        usuarioCreacion: "arodas@centria.net",
      }
    },
    {
      instanceID: "mock-task-003",
      context: {
        tituloTarea: "0025-R4615-BCP-22/05/2026-W", numeroPropuesta: "R4615",
        sociedad: "0025", fechaPropuestaPago: "22-05-2026", banco: "BCP",
        bancoDescripcion: "001 - BCP Soles", viaPago: "W", modalidadPP: "H2H",
        version: "0001", importe: "8500.00", moneda: "PEN",
        usuarioCreacion: "arodas@centria.net",
      }
    },
  ];
}

/**
 * Mock de detalle completo para la Object Page cuando BPA no está disponible.
 * Basado en PropuestaNomina.json real del proyecto.
 *
 * @param {string} instanceID - ID de la instancia solicitada
 * @returns {object} TareasInbox mock con composiciones y flags
 */
function _getMockDetalle(instanceID) {
  return {
    instanceID,
    tituloTarea           : "0025-R4603-BCP-20/05/2026-R",
    numeroPropuesta       : "R4603",
    sociedad              : "0025",
    fechaPropuestaPago    : "20-05-2026",
    banco                 : "BCP",
    bancoDescripcion      : "001 - BCP Soles",
    viaPago               : "N",
    modalidadPP           : "H2H",
    version               : "0001",
    importe               : "43038.69",
    moneda                : "PEN",
    analista              : "MRICANQUI",
    correoAnalista        : "mricanqui@centria.net",
    existeDocumento       : "EXISTE",
    indicadorPagoAdelanto : "",
    contadorFirma         : 0,
    usuarioCreacion       : "cpanduro@centria.net",
    usuarioCreacionPP     : "MRICANQUI",
    usuarioApoderado      : "",
    usuarioCaja           : "",
    usuariosRevisores     : ["mminchan@urbanova.com.pe", "evillalobos@urbanova.com.pe"],
    usuariosAnalistas     : ["mricanqui@centria.net", "arodas@centria.net"],
    usuariosSupervisores  : ["cpanduro@centria.net", "ypocco@centria.net"],
    // Flags de rol — ajustar para simular distintos roles durante desarrollo
    tieneAnalista         : false,
    estaConforme          : false,
    tieneRevisor          : true,
    estaAprobado          : false,
    esCaja                : false,
    estaTerminado         : false,
    estaAnulado           : false,
    puedeTerminarFlujo    : false,
    puedeAnular           : false,
    // Composiciones mock
    proveedores: [
      { proveedorId: "001", ruc: "20100070970", nombre: "EMPRESA DE SERVICIOS SAC",
        glosa: "REMUNERACIONES MAYO 2026", monto: 15200.50, facturas: "F001-00123" },
      { proveedorId: "002", ruc: "20512528458", nombre: "CONSORCIO INDUSTRIAL SA",
        glosa: "HONORARIOS MAYO 2026",    monto: 27838.19, facturas: "F002-00987" },
    ],
    adjuntos: [
      { adjuntoId: "adj-001", nombre: "CARGA_BANK_R4603_BCP.txt",
        tipoAdjunto: "CARGA_BANK",  activo: true, docServiceObjectID: "dms-obj-001" },
      { adjuntoId: "adj-002", nombre: "PAGO_TRANS_R4603_BCP.pdf",
        tipoAdjunto: "PAGO_TRANS", activo: true, docServiceObjectID: "dms-obj-002" },
    ],
    aprobadores: [
      { aprobadorId: "001", usuario: "CPANDURO", rol: "SUPERVISOR",
        fechaAprob: new Date("2026-05-20T10:30:00Z"), aprobado: true,  observacion: "" },
      { aprobadorId: "002", usuario: "MMINCHAN", rol: "REVISOR",
        fechaAprob: null, aprobado: false, observacion: "Pendiente de revisión" },
    ],
  };
}

/**
 * Genera un buffer PDF mínimo válido para verificación local.
 * Permite verificar el streaming de CAP sin necesidad de SAP Gateway.
 *
 * @param {string} id - ID compuesto (ej: "R4603-0025-20-05-2026")
 * @returns {Buffer} Buffer con PDF mínimo válido
 */
function _getMockPDFBuffer(id) {
  const content = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    `4 0 obj<</Length 44>>\nstream\nBT /F1 12 Tf 100 700 Td (${id}) Tj ET\nendstream\nendobj`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n",
    "trailer<</Size 6/Root 1 0 R>>",
    "startxref\n441",
    "%%EOF",
  ].join("\n");
  return Buffer.from(content, "latin1");
}

module.exports = { PagosService };