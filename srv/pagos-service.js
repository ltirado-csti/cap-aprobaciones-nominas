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
const perfiles = require("./config/perfiles");
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

/**
 * Prepara los datos que el dominio necesita para ejecutar una acción bound.
 *
 * Migración a bound actions: el cliente ya NO envía propuesta/usuario/taskId.
 *   - taskId    : clave instanceID de la instancia bound (req.params)
 *   - propuesta : leída del contexto BPA — fuente autoritativa, el cliente
 *                 no puede manipularla
 *   - usuario   : del contexto de seguridad CAP (XSUAA).
 *                 TODO(arquitecto): validar usuarioSAP si BTP y ECP difieren
 *   - comentario: único dato que sí viene del dialog de Fiori Elements
 *   - constantes: (opcional) constantes de negocio vía constantes.service
 *
 * @param {object}  req - Request CAP de la acción bound sobre TareasInbox
 * @param {object}  [opciones]
 * @param {boolean} [opciones.conConstantes=false] - incluir constantes de negocio
 * @returns {Promise<object>} { propuesta, usuario, taskId, comentario, constantes? }
 */
async function _prepararAccion(req, { conConstantes = false } = {}) {
  const taskId = req.params?.[0]?.instanceID ?? req.params?.[0];
  if (!taskId) throw Object.assign(
    new Error("No se pudo determinar la tarea (instanceID) de la acción"),
    { status: 400 }
  );

  const contexto = await bpa.readContext(taskId);
  if (!contexto) throw Object.assign(
    new Error(`Contexto BPA no encontrado para la tarea ${taskId}`),
    { status: 404 }
  );

  const datos = {
    taskId,
    propuesta : _extraerPropuesta(contexto),
    usuario   : { name: req.user?.id },
    comentario: req.data?.comentario,
  };

  if (conConstantes) datos.constantes = await constSvc.getConstantes();
  return datos;
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
        sociedadesRevision: rpta.sociedadesRevision,
        validarViaPago    : rpta.validarViaPago,
        aprobarViaPago    : rpta.aprobarViaPago,
        sociedadesTermina : rpta.sociedadesTermina,
        tesoreros         : JSON.stringify(rpta.tesoreros),
        documentUrl       : rpta.documentUrl,
        documentUrlTasa   : rpta.documentUrlTasa,
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
      // FCL hace $batch con $select reducido al seleccionar filas, y el modelo
      // V4 emite "late property requests" por los campos que faltan en la caché.
      const columnas   = req.query?.SELECT?.columns ?? [];
      const nombres    = columnas.map(c => c?.ref?.[0]).filter(Boolean);

      // Solo las composiciones provienen de CPI; todos los campos escalares de
      // TareasInbox se derivan del contexto BPA (incluidos estadoPP, urlPDF y
      // numeroPropuesta), así que las late requests toman la ruta liviana.
      const camposCPI  = ["proveedores", "adjuntos", "aprobadores"];

      const necesitaCPI = nombres.length === 0 ||
                          nombres.some(nombre => camposCPI.includes(nombre));

      if (!necesitaCPI) {
        // FCL pidió solo campos livianos (importe, moneda, fechaPropuestaPago)
        // Retornar solo datos BPA sin llamar a CPI. La tarea se obtiene en
        // paralelo al contexto para derivar los flags de rol del activityId.
        LOG.info(`[READ TareasInbox] $select liviano — omitiendo CPI | id=${instanceID}`);
        const [tarea, contexto] = await Promise.all([
          bpa.obtenerTarea(instanceID),
          bpa.readContext(instanceID),
        ]);
        return contexto ? _mapearContextoBpa(instanceID, contexto, tarea?.activityId) : null;
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
      const detalle = await _obtenerDetalleTarea(instanceID);
      return detalle.proveedores ?? [];
    });

    /**
     * GET /nomina/aprobaciones/TareasInbox('{id}')/adjuntos
     * Retorna la lista de adjuntos de la propuesta.
     * Origen legado: fragment/Adjuntos2.xml
     */
    this.on("READ", "Adjunto", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const detalle = await _obtenerDetalleTarea(instanceID);
      return detalle.adjuntos ?? [];
    });

    /**
     * GET /nomina/aprobaciones/TareasInbox('{id}')/aprobadores
     * Retorna el historial de aprobaciones de la propuesta.
     * Origen legado: fragment/Aprobadores.xml
     */
    this.on("READ", "Aprobador", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const detalle = await _obtenerDetalleTarea(instanceID);
      return detalle.aprobadores ?? [];
    });
  }

  // ─── ANALISTA TESORERÍA — Origen: AnalistaTesoreria.js ───────────────────

  static handle_analistaT() {
    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.enviarSupervisorOCaja
     * Enruta según viaPago: W → EN_CAJA, resto → VALIDACION
     */
    this.on("enviarSupervisorOCaja", "TareasInbox", (req) =>
      _handle(req, async () =>
        aprobSvc.enviarSupervisorOCaja(await _prepararAccion(req, { conConstantes: true }))
      )
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.compensar
     * Obtiene documento de compensación desde CPI y actualiza la propuesta.
     */
    this.on("compensar", "TareasInbox", (req) =>
      _handle(req, async () => {
        const datos = await _prepararAccion(req);
        const docCompensacion = await cpiInfra.consultarCompensacion(datos.propuesta);
        if (!docCompensacion) throw Object.assign(
          new Error("No se pudo obtener el documento de compensación desde SAP"),
          { status: 500 }
        );
        return aprobSvc.compensar({ ...datos, docCompensacion });
      })
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.cerrarPorObservacion
     * OBS_SUPER → CERRADO_OB
     */
    this.on("cerrarPorObservacion", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.cerrarPorObservacion(await _prepararAccion(req)))
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.eliminarDoc
     * GENERADO → ELIMINADO
     */
    this.on("eliminarDoc", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.eliminarDoc(await _prepararAccion(req)))
    );
  }

  // ─── SUPERVISOR — Origen: Supervisor.js ──────────────────────────────────

  static handle_supervisor() {
    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.supervisorAprobar
     * Enruta según modalidadPP, viaPago y sociedades de revisión.
     */
    this.on("supervisorAprobar", "TareasInbox", (req) =>
      _handle(req, async () =>
        aprobSvc.supervisorAprobar(await _prepararAccion(req, { conConstantes: true }))
      )
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.supervisorTerminarFlujo
     * Cancela la instancia BPA completa. Solo disponible cuando puedeTerminarFlujo = true.
     */
    this.on("supervisorTerminarFlujo", "TareasInbox", (req) =>
      _handle(req, async () =>
        aprobSvc.supervisorTerminarFlujo(await _prepararAccion(req, { conConstantes: true }))
      )
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.supervisorObservar
     * VALIDACION → OBS_SUPER (CPI: ZfiWsH2hObs, PiEstado=OBTR)
     */
    this.on("supervisorObservar", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.supervisorObservar(await _prepararAccion(req)))
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.supervisorAnular
     * Anula la propuesta. Solo disponible cuando puedeAnular = true.
     */
    this.on("supervisorAnular", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.supervisorAnular(await _prepararAccion(req)))
    );
  }

  // ─── REVISOR — Origen: Revisor.js ────────────────────────────────────────

  static handle_revisor() {
    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.revisorAprobar
     * REVISION → EN_FIRMA
     */
    this.on("revisorAprobar", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.revisorAprobar(await _prepararAccion(req)))
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.revisorObservar
     * REVISION → OBS_REVISOR (CPI: ZfiWsH2hObs, PiEstado=OBRA)
     */
    this.on("revisorObservar", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.revisorObservar(await _prepararAccion(req)))
    );
  }

  // ─── APODERADO — Origen: Apoderado.js ────────────────────────────────────

  static handle_apoderado() {
    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.apoderadoFirmar
     * Lógica F1/F2: contadorFirma determina si es primera o segunda firma.
     * registrarAprobacionSAP (CPI /apoReg) se llama antes de completar BPA.
     */
    this.on("apoderadoFirmar", "TareasInbox", (req) =>
      _handle(req, async () =>
        aprobSvc.apoderadoFirmar(await _prepararAccion(req, { conConstantes: true }))
      )
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.apoderadoObservar
     * EN_FIRMA → OBS_APODER (CPI: ZfiWsH2hObs, PiEstado=OBAP)
     */
    this.on("apoderadoObservar", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.apoderadoObservar(await _prepararAccion(req)))
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.redirigirApoderado
     * Redirige la firma a otro apoderado. El comentario contiene el email destino.
     */
    this.on("redirigirApoderado", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.redirigirApoderado(await _prepararAccion(req)))
    );
  }

  // ─── CAJA — Origen: Caja.js ──────────────────────────────────────────────

  static handle_caja() {
    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.cajaConfirmarPago
     * EN_CAJA → PAGADO. Cierra el flujo BPA.
     */
    this.on("cajaConfirmarPago", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.cajaConfirmarPago(await _prepararAccion(req)))
    );

    /**
     * POST /nomina/aprobaciones/TareasInbox('id')/PagosService.cajaObservar
     * EN_CAJA → OBS_CAJA (CPI: ZfiWsH2hObs, PiEstado=OBCA)
     */
    this.on("cajaObservar", "TareasInbox", (req) =>
      _handle(req, async () => aprobSvc.cajaObservar(await _prepararAccion(req)))
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
   * Normaliza el contexto BPA a la propuesta de negocio, sin importar qué
   * proceso lo haya producido. Los 3 procesos del .mtar anidan distinto:
   *   - aprobacionDeNomina (principal)         → startEvent.propuesta
   *   - aprobacionDeLosApoderados (subproceso) → startEvent.body
   *   - aprobacionFinal (subproceso)           → startEvent.body
   * Se prueban los paths conocidos en orden y se cae a fallbacks planos para
   * tolerar contextos legados o variantes de readContext.
   *
   * @param {object} contexto - Contexto crudo devuelto por bpa.readContext
   * @returns {object} Propuesta de negocio (camelCase de PropuestaNomina.json)
   */
  function _extraerPropuesta(contexto) {
    if (!contexto || typeof contexto !== "object") return {};
    const candidatos = [
      contexto?.startEvent?.propuesta,   // proceso principal
      contexto?.startEvent?.body,        // subprocesos (apoderados / final)
      contexto?.propuesta,               // fallback plano
      contexto?.body,                    // fallback plano
    ];
    const propuesta = candidatos.find(c => c && typeof c === "object");
    return propuesta ?? contexto;
  }

  /**
   * Mapea un contexto BPA al shape de TareasInbox SIN llamar a CPI.
   * Usado por la ruta de $select liviano del READ (FCL pide solo campos de
   * cabecera). Reutiliza _ensamblarDetalle con composiciones vacías para
   * mantener una sola proyección de campos y flags.
   *
   * @param {string} instanceID - ID de la tarea BPA
   * @param {object} contexto   - Contexto crudo de bpa.readContext
   * @param {string} activityId - taskDefinitionId de la tarea (para flags de rol)
   * @returns {object} Registro TareasInbox liviano (sin proveedores/adjuntos)
   */
  function _mapearContextoBpa(instanceID, contexto, activityId) {
    const propuesta = _extraerPropuesta(contexto);
    return _ensamblarDetalle({
      instanceID,
      activityId,
      propuesta,
      proveedores : [],
      adjuntos    : [],
      aprobadores : [],
    });
  }

  /**
   * Enriquece una tarea BPA con su contexto para el List Report.
   * Los flags de rol se calculan desde el activityId (taskDefinitionId) de la
   * tarea vía perfiles.calcularFlagsRol() — ya no se leen del contexto.
   * Los flags de estado (estaTerminado/estaAnulado) sí provienen del contexto.
   *
   * @param {object} tarea - Tarea raw del BPA (getInboxTasks), incluye activityId
   * @returns {Promise<object>} TareasInbox con campos de negocio completos
   */
  async function _enriquecerConContexto(tarea) {
    // Flags de rol derivados del formulario BPA de la tarea
    const flagsRol = perfiles.calcularFlagsRol(tarea.activityId);

    try {
      const contexto  = await bpa.readContext(tarea.id);
      const propuesta = _extraerPropuesta(contexto);

      // Flags de estado de la propuesta — sí se leen del contexto BPA
      const estaTerminado = propuesta.estaTerminado ?? false;
      const estaAnulado   = propuesta.estaAnulado   ?? false;

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
        // Flags de rol — calculados desde el taskDefinitionId, no del contexto
        ...flagsRol,
        estaTerminado,
        estaAnulado,
        // Visibilidad doble del Coordinador
        puedeTerminarFlujo : flagsRol.esCoordinador && estaTerminado,
        puedeAnular        : flagsRol.esCoordinador && estaAnulado,
      };

    } catch (error) {
      // readContext falló para esta tarea — retornar con datos mínimos
      // para no bloquear el resto de la lista. Los flags de rol se conservan
      // porque no dependen del contexto.
      LOG.warn(`[_enriquecerConContexto] readContext falló | id=${tarea.id} | ${error.message}`);
      return {
        instanceID         : tarea.id,
        tituloTarea        : tarea.subject ?? "",
        numeroPropuesta    : "", sociedad: "", banco: "", bancoDescripcion: "",
        importe            : "", moneda: "", viaPago: "", modalidadPP: "",
        version            : "", fechaPropuestaPago: "", usuarioCreacion: "",
        correoAnalista     : "",
        ...flagsRol,
        estaTerminado      : false, estaAnulado: false,
        puedeTerminarFlujo : false, puedeAnular: false,
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
      // Tarea y contexto en paralelo: la tarea aporta el activityId (flags de
      // rol) y el contexto los datos de negocio de los que dependen las composiciones
      const [tarea, contexto] = await Promise.all([
        bpa.obtenerTarea(instanceID),
        bpa.readContext(instanceID),
      ]);

      if (!contexto) {
        throw Object.assign(
          new Error(`Contexto BPA no encontrado para la tarea ${instanceID}`),
          { status: 404 }
        );
      }

      const propuesta = _extraerPropuesta(contexto);

      // Luego obtener las composiciones en paralelo usando las funciones privadas
      const [proveedores, adjuntos, aprobadores] = await Promise.all([
        _obtenerProveedores(propuesta).catch(() => []),
        _obtenerAdjuntos(propuesta).catch(() => []),
        _obtenerAprobadores(propuesta).catch(() => [])
      ]);

      return _ensamblarDetalle({
        instanceID,
        activityId: tarea?.activityId,
        propuesta,
        proveedores,
        adjuntos,
        aprobadores,
      });

    } catch (error) {
      if (error.status === 404) throw error;
      LOG.warn(`[_obtenerDetalleTarea] BPA no disponible — usando mock | ${error.message}`);
      return _getMockDetalle(instanceID);
    }
  }

  /**
   * Ensambla el objeto final TareasInbox con campos, composiciones y flags.
   *
   * Flags de rol (esCoordinador, esApoderado, esLiberador, esAnalista, esCaja):
   *   calculados desde el activityId (taskDefinitionId) vía perfiles.calcularFlagsRol().
   * Flags de estado (estaTerminado, estaAnulado): leídos del contexto BPA.
   * Campos calculados para visibilidad doble del Coordinador:
   *   puedeTerminarFlujo = esCoordinador AND estaTerminado
   *   puedeAnular        = esCoordinador AND estaAnulado
   *
   * @param {object} params - { instanceID, activityId, propuesta, proveedores, adjuntos, aprobadores }
   * @returns {object} Registro TareasInbox listo para la Object Page
   */
  function _ensamblarDetalle({ instanceID, activityId, propuesta, proveedores, adjuntos, aprobadores }) {
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
      // Estado del flujo — lo escribe aprobacion.service en el contexto BPA
      // (VALIDACION, REVISION, EN_FIRMA, EN_CAJA, PAGADO, OBS_*, ...)
      estadoPP              : propuesta.estadoPP ?? "",
      // URL del PDF para descarga — media entity servida por handle_pdf
      urlPDF                : `/nomina/aprobaciones/PropuestaPDF('${instanceID}')/contenido`,
      contadorFirma         : propuesta.contadorFirma,
      usuarioApoderado      : propuesta.usuarioApoderado,
      usuarioCaja           : propuesta.usuarioCaja,
      usuariosRevisores     : propuesta.usuariosRevisores,
      usuariosAnalistas     : propuesta.usuariosAnalistas,
      usuariosSupervisores  : propuesta.usuariosSupervisores,
    };

    // Flags de rol — calculados desde el taskDefinitionId de la tarea BPA
    // (Refactoring Visibilidad: reemplazan a los flags legado del contexto)
    const flagsRol = perfiles.calcularFlagsRol(activityId);

    // Flags de estado de la propuesta — sí provienen del contexto BPA
    const flagsEstado = {
      estaTerminado : propuesta.estaTerminado ?? false,
      estaAnulado   : propuesta.estaAnulado   ?? false,
    };

    // Campos calculados para visibilidad doble del Coordinador
    const flagsCalculados = {
      puedeTerminarFlujo : flagsRol.esCoordinador && flagsEstado.estaTerminado,
      puedeAnular        : flagsRol.esCoordinador && flagsEstado.estaAnulado,
    };

    return {
      ...base,
      ...flagsRol,
      ...flagsEstado,
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
    const parametros = req.params ?? [];

    // Caso 1: params[0] es objeto con propiedad instanceID (navegación OData)
    if (parametros[0]?.instanceID) return parametros[0].instanceID;

    // Caso 2: params[0] es string directo
    if (typeof parametros[0] === "string") return parametros[0];

    // Caso 3: viene como filtro en el query (Fiori Elements en algunos escenarios)
    const instanceIDDesdeQuery = req.query?.SELECT?.from?.ref?.[0]?.where?.find?.(
      w => w?.ref?.[0] === "instanceID"
    )?.val;

    return instanceIDDesdeQuery ?? null;
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
   * @param {string} fecha - Fecha en formato "dd-MM-yyyy" (ej: "20-05-2026")
   * @returns {Date} Objeto Date en hora cero UTC
   */
  function _parseFechaPP(fecha) {
    if (!fecha) return new Date();
    const [dia, mes, anio] = fecha.split("-");
    return new Date(`${anio}-${mes}-${dia}T00:00:00.000Z`);
  }

/**
 * Mock de lista de tareas para el List Report cuando BPA no está disponible.
 * Activo en modo local (cds watch sin --profile hybrid).
 * Los flags de rol se derivan del activityId con el mismo mecanismo real
 * (perfiles.calcularFlagsRol), igual que en _enriquecerConContexto.
 *
 * @returns {Array} 3 tareas representando los casos típicos del negocio
 */
function _getMockTareas() {
  const tareas = [
    {
      instanceID: "mock-task-001",
      // Simula tarea del Liberador (form_aprobacionFinalForm_2)
      activityId: "form_aprobacionFinalForm_2",
      tituloTarea: "0025-R4603-BCP-20/05/2026-L", numeroPropuesta: "R4603",
      sociedad: "0025", fechaPropuestaPago: "20-05-2026", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "N", modalidadPP: "H2H",
      version: "0001", importe: "43038.69", moneda: "PEN",
      usuarioCreacion: "cpanduro@centria.net",
      estaTerminado: false,
      estaAnulado  : false,
    },
    {
      instanceID: "mock-task-002",
      // Simula tarea del Coordinador (form_aprobacionDelCoordinador_2)
      activityId: "form_aprobacionDelCoordinador_2",
      tituloTarea: "0025-R4610-SCO-21/05/2026-S", numeroPropuesta: "R4610",
      sociedad: "0025", fechaPropuestaPago: "21-05-2026", banco: "SCOTIABANK",
      bancoDescripcion: "009 - Scotiabank Soles", viaPago: "I", modalidadPP: "H2H",
      version: "0001", importe: "15200.00", moneda: "PEN",
      usuarioCreacion: "arodas@centria.net",
      estaTerminado: true,   // → puedeTerminarFlujo = true (visibilidad doble)
      estaAnulado  : false,
    },
    {
      instanceID: "mock-task-003",
      // Simula tarea del Apoderado, primera firma (form_aprobacionDelApoderado_1)
      activityId: "form_aprobacionDelApoderado_1",
      tituloTarea: "0025-R4615-BCP-22/05/2026-A", numeroPropuesta: "R4615",
      sociedad: "0025", fechaPropuestaPago: "22-05-2026", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "W", modalidadPP: "H2H",
      version: "0001", importe: "8500.00", moneda: "PEN",
      usuarioCreacion: "arodas@centria.net",
      estaTerminado: false,
      estaAnulado  : false,
    },
  ];

  // Derivar flags de rol y calculados con el mecanismo real de visibilidad
  return tareas.map(tarea => {
    const flagsRol = perfiles.calcularFlagsRol(tarea.activityId);
    return {
      ...tarea,
      ...flagsRol,
      puedeTerminarFlujo: flagsRol.esCoordinador && tarea.estaTerminado,
      puedeAnular       : flagsRol.esCoordinador && tarea.estaAnulado,
    };
  });
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
    estadoPP              : "REVISION",
    urlPDF                : `/nomina/aprobaciones/PropuestaPDF('${instanceID}')/contenido`,
    usuarioApoderado      : "",
    usuarioCaja           : "",
    usuariosRevisores     : ["mminchan@urbanova.com.pe", "evillalobos@urbanova.com.pe"],
    usuariosAnalistas     : ["mricanqui@centria.net", "arodas@centria.net"],
    usuariosSupervisores  : ["cpanduro@centria.net", "ypocco@centria.net"],
    // Flags de rol — derivados del activityId mock (Liberador) con el mecanismo real.
    // Cambiar el activityId para simular otros roles durante el desarrollo.
    ...perfiles.calcularFlagsRol("form_aprobacionFinalForm_2"),
    // Flags de estado de la propuesta
    estaTerminado         : false,
    estaAnulado           : false,
    // Visibilidad doble del Coordinador (false: la tarea mock es del Liberador)
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