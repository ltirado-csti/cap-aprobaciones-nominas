"use strict";
/**
 * srv/pagos-service.js
 *
 * Implementación del PagosService usando el patrón cds.ApplicationService.
 *
 * Grupos de handlers registrados automáticamente por init():
 *   handle_master()         → obtenerConstantes
 *   handle_pdf()            → PropuestaPDF (media entity)
 *   handle_inbox()          → READ TareasInbox (List Report + Object Page)
 *   handle_composiciones()  → READ Proveedor, Adjunto, Aprobador
 *   handle_aprobaciones()   → todas las acciones bound de TareasInbox
 *                             (delegadas a aprobacion.service.registrarHandlers)
 *
 * Roles activos (BPA v1.1.5):
 *   Apoderado1 / Apoderado2 → apoderadoAprobar | apoderadoObservar
 *   Liberador               → liberadorLiberar | liberadorRechazar | liberadorAnular
 *   Coordinador             → ANULADO — retorna 501 si se invoca
 */

const cds      = require("@sap/cds");
const aprobSvc = require("./domain/aprobacion.service");
const constSvc = require("./domain/constantes.service");
const cpiInfra = require("./infrastructure/cpi-client");
const bpa      = require("./infrastructure/bpa-client");
const perfiles = require("./config/perfiles");
const { Readable } = require("stream");

const LOG = cds.log("PagosService");

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
     * Carga constantes de negocio desde el servicio de constantes.
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
     * GET /nomina/aprobaciones/PropuestaPDF('{id}')/contenido
     * Sirve el PDF de la propuesta como stream binario.
     * Origen legado: Detail.view.xml → tab PDF → getPropuestaPDFSAP()
     */
    this.on("READ", "PropuestaPDF", async (req) => {
      const id = req.params?.[0]?.id ?? req.params?.[0];
      if (!id) return [];

      const [numeroPropuesta, sociedad, ...fechaParts] = id.split("-");
      const fechaPropuestaPago = fechaParts.join("-");

      const columns     = req.query?.SELECT?.columns ?? [];
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
     * Sin clave → List Report: lista liviana desde BPA.
     * Con clave → Object Page: detalle completo con composiciones y flags de rol.
     * Origen legado: Master.controller.js + Detail.controller.js → _onBindingChange
     */
    this.on("READ", "TareasInbox", async (req) => {
      const instanceID = req.params?.[0]?.instanceID ?? req.params?.[0];

      // Sin clave → List Report
      if (!instanceID) {
        const tareas = await _obtenerTareasBpa(req.user.id);
        tareas.$count = tareas.length;
        return tareas;
      }

      // Con clave → verificar si se necesita el detalle completo de CPI.
      const columnas  = req.query?.SELECT?.columns ?? [];
      const nombres   = columnas.map(c => c?.ref?.[0]).filter(Boolean);
      const camposCPI = ["proveedores", "adjuntos", "aprobadores"];

      const necesitaCPI = nombres.length === 0 ||
                          nombres.some(nombre => camposCPI.includes(nombre));

      if (!necesitaCPI) {
        // FCL pidió solo campos livianos — omitir CPI
        LOG.info(`[READ TareasInbox] $select liviano — omitiendo CPI | id=${instanceID}`);
        const [tarea, contexto] = await Promise.all([
          bpa.obtenerTarea(instanceID),
          bpa.readContext(instanceID),
        ]);
        return contexto ? _mapearContextoBpa(instanceID, contexto, tarea?.activityId) : null;
      }

      return await _obtenerDetalleTarea(instanceID);
    });
  }

  // ─── COMPOSICIONES ────────────────────────────────────────────────────────

  static handle_composiciones() {
    /**
     * GET /nomina/aprobaciones/TareasInbox('{id}')/proveedores
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
     * Origen legado: fragment/Aprobadores.xml
     */
    this.on("READ", "Aprobador", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const detalle = await _obtenerDetalleTarea(instanceID);
      return detalle.aprobadores ?? [];
    });
  }

  // ─── ACCIONES BOUND DE APROBACIÓN ────────────────────────────────────────

  static handle_aprobaciones() {
    /**
     * Registra todos los handlers de acciones bound de TareasInbox:
     *   apoderadoAprobar  | apoderadoObservar
     *   liberadorLiberar  | liberadorRechazar  | liberadorAnular
     *   coordinadorAprobar (501) | coordinadorRechazar (501)
     *
     * La lógica vive en aprobacion.service.js para separación de capas.
     * Anti-tampering: instanceID de req.params, propuesta de BPA, usuario de XSUAA.
     * El único dato aceptado del cliente es "comentario".
     */
    aprobSvc.registrarHandlers(this);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCIONES PRIVADAS DEL MÓDULO
// Acceso a bpa, constSvc, cpiInfra, perfiles, LOG.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Obtiene y enriquece la lista de tareas BPA con su contexto.
 * Origen legado: Master.controller.js → getInboxTasks() + readContext()
 * @param {string} usuario - Email del usuario autenticado (req.user.id)
 */
async function _obtenerTareasBpa(usuario) {
  try {
    const tareas = await bpa.getInboxTasks(usuario);
    if (!tareas.length) return [];

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
 * Normaliza el contexto BPA a la propuesta de negocio.
 * Prueba paths conocidos en orden: proceso principal → subproceso → fallbacks.
 */
function _extraerPropuesta(contexto) {
  if (!contexto || typeof contexto !== "object") return {};
  const candidatos = [
    contexto?.startEvent?.propuesta,  // proceso principal aprobacionDeNomina
    contexto?.startEvent?.body,       // subproceso apoderados / final
    contexto?.propuesta,              // fallback plano
    contexto?.body,                   // fallback plano
  ];
  const propuesta = candidatos.find(c => c && typeof c === "object");
  return propuesta ?? contexto;
}

/**
 * Extrae el resultado de la notificación a Payroll desde context.custom.*
 *
 * BPA notifica a Payroll (ECP vía CPI) tras cada decisión. Si Payroll rechaza,
 * un Script Task escribe el flag y el mensaje en las variables personalizadas y
 * el flujo hace loop back: la tarea reaparece en el inbox del mismo usuario.
 * Estos campos son lo que le explica al usuario por qué volvió.
 *
 * Los nombres de variable dependen del rol y viven en perfiles.js — están en
 * minúsculas porque así se escribieron en el BPMN 1.3.1.
 *
 * La búsqueda es case-insensitive a propósito: el proyecto ya sufrió un desajuste
 * de mayúsculas entre el diseño documentado y el BPMN desplegado, así que si
 * alguien normaliza los nombres en BPA esto sigue funcionando sin tocar CAP.
 *
 * @param {object} contexto    - contexto BPA completo (incluye la rama `custom`)
 * @param {string} activityId  - taskDefinitionId, determina qué par de campos leer
 * @returns {{ notifTieneError: boolean, notifMensaje: string, notifCriticidad: number }}
 */
function _extraerNotificacion(contexto, activityId) {
  const vacio = { notifTieneError: false, notifMensaje: "", notifCriticidad: 0 };

  const campos = perfiles.resolverCamposNotificacion(activityId);
  const custom = contexto?.custom;
  if (!campos || !custom || typeof custom !== "object") return vacio;

  // Índice en minúsculas para tolerar cualquier variación de capitalización
  const porNombre = new Map(
    Object.entries(custom).map(([clave, valor]) => [clave.toLowerCase(), valor])
  );

  const flag    = porNombre.get(campos.campoFlag.toLowerCase());
  const mensaje = porNombre.get(campos.campoMensaje.toLowerCase());

  // Payroll marca error con "X" (EpFlagError); vacío o ausente significa OK
  const tieneError = String(flag ?? "").trim().toUpperCase() === "X";
  if (!tieneError) return vacio;

  return {
    notifTieneError: true,
    notifMensaje   : String(mensaje ?? "").trim() ||
                     "Payroll rechazó la operación sin detallar el motivo.",
    notifCriticidad: 1,   // UI.CriticalityType.Negative → se pinta en rojo
  };
}

/**
 * Mapea un contexto BPA al shape de TareasInbox SIN llamar a CPI.
 * Usado por la ruta de $select liviano del READ.
 */
function _mapearContextoBpa(instanceID, contexto, activityId) {
  const propuesta = _extraerPropuesta(contexto);
  return _ensamblarDetalle({
    instanceID,
    activityId,
    propuesta,
    notificacion: _extraerNotificacion(contexto, activityId),
    proveedores : [],
    adjuntos    : [],
    aprobadores : [],
  });
}

/**
 * Enriquece una tarea BPA con su contexto para el List Report.
 * Los flags de rol se calculan desde el activityId (taskDefinitionId).
 */
async function _enriquecerConContexto(tarea) {
  const flagsRol = perfiles.calcularFlagsRol(tarea.activityId);

  try {
    const contexto  = await bpa.readContext(tarea.id);
    const propuesta = _extraerPropuesta(contexto);

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
      ...flagsRol,
      // Resultado del intento anterior: si Payroll rechazó, la tarea reapareció
      // por loop back y el usuario debe ver el motivo ya desde la lista.
      ..._extraerNotificacion(contexto, tarea.activityId),
      estaTerminado,
      estaAnulado,
      puedeTerminarFlujo : flagsRol.esCoordinador && estaTerminado,
      puedeAnular        : flagsRol.esCoordinador && estaAnulado,
    };

  } catch (error) {
    LOG.warn(`[_enriquecerConContexto] readContext falló | id=${tarea.id} | ${error.message}`);
    return {
      instanceID         : tarea.id,
      tituloTarea        : tarea.subject ?? "",
      numeroPropuesta    : "", sociedad: "", banco: "", bancoDescripcion: "",
      importe            : "", moneda: "", viaPago: "", modalidadPP: "",
      version            : "", fechaPropuestaPago: "", usuarioCreacion: "",
      correoAnalista     : "",
      ...flagsRol,
      notifTieneError    : false, notifMensaje: "", notifCriticidad: 0,
      estaTerminado      : false, estaAnulado: false,
      puedeTerminarFlujo : false, puedeAnular: false,
    };
  }
}

/**
 * Obtiene el detalle completo de una tarea para el Object Page.
 * BPA + composiciones CPI en paralelo para minimizar latencia.
 * Origen legado: Detail.controller.js → _onBindingChange()
 */
async function _obtenerDetalleTarea(instanceID) {
  try {
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

    const [proveedores, adjuntos, aprobadores] = await Promise.all([
      cpiInfra.getProveedores(propuesta).catch(() => []),
      cpiInfra.getAdjuntos(propuesta).catch(() => []),
      cpiInfra.getAprobadores(propuesta).catch(() => []),
    ]);

    return _ensamblarDetalle({
      instanceID,
      activityId: tarea?.activityId,
      propuesta,
      notificacion: _extraerNotificacion(contexto, tarea?.activityId),
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
 * Flags de rol (esApoderado, esLiberador, etc.): desde activityId vía perfiles.
 * Flags de estado (estaTerminado, estaAnulado): desde contexto BPA.
 * Flags calculados Coordinador: puedeTerminarFlujo, puedeAnular.
 */
function _ensamblarDetalle({ instanceID, activityId, propuesta, notificacion, proveedores, adjuntos, aprobadores }) {
  const flagsRol      = perfiles.calcularFlagsRol(activityId);
  const flagsNotif    = notificacion ??
                        { notifTieneError: false, notifMensaje: "", notifCriticidad: 0 };
  const flagsEstado   = {
    estaTerminado : propuesta.estaTerminado ?? false,
    estaAnulado   : propuesta.estaAnulado   ?? false,
  };
  const flagsCalculados = {
    puedeTerminarFlujo : flagsRol.esCoordinador && flagsEstado.estaTerminado,
    puedeAnular        : flagsRol.esCoordinador && flagsEstado.estaAnulado,
  };
  const estado = _calcularEstado(flagsRol, flagsEstado);

  const base = {
    instanceID,
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
    estadoPP              : estado.texto,
    estadoCriticidad      : estado.criticidad,
    urlPDF                : `/nomina/aprobaciones/PropuestaPDF('${instanceID}')/contenido`,
    contadorFirma         : propuesta.contadorFirma,
    usuarioApoderado      : propuesta.usuarioApoderado,
    usuarioCaja           : propuesta.usuarioCaja,
    usuariosRevisores     : propuesta.usuariosRevisores,
    usuariosAnalistas     : propuesta.usuariosAnalistas,
    usuariosSupervisores  : propuesta.usuariosSupervisores,
  };

  return {
    ...base,
    ...flagsRol,
    ...flagsNotif,
    ...flagsEstado,
    ...flagsCalculados,
    proveedores,
    adjuntos,
    aprobadores,
  };
}

/**
 * Deriva texto + criticidad de "Estado" a partir del rol pendiente (activityId)
 * y los flags de cierre del flujo. No existe un campo "estadoPP" en el
 * contexto BPA (PropuestaNomina) — era un campo de la arquitectura HANA
 * anterior que nunca se migró — así que se calcula en vivo con lo único
 * que BPA sí entrega: quién tiene la tarea pendiente y si el flujo cerró.
 *
 * criticidad sigue com.sap.vocabularies.UI.v1.CriticalityType:
 *   0 Neutral | 1 Negative (rojo) | 2 Critical (ámbar) | 3 Positive (verde)
 */
function _calcularEstado(flagsRol, flagsEstado) {
  if (flagsEstado.estaAnulado)   return { texto: "Anulado",                  criticidad: 1 };
  if (flagsEstado.estaTerminado) return { texto: "Liberado",                 criticidad: 3 };
  if (flagsRol.esLiberador)      return { texto: "Pendiente de Liberación",  criticidad: 2 };
  if (flagsRol.esApoderado1)     return { texto: "Pendiente de Apoderado 1", criticidad: 2 };
  if (flagsRol.esApoderado2)     return { texto: "Pendiente de Apoderado 2", criticidad: 2 };
  if (flagsRol.esCoordinador)    return { texto: "Pendiente de Coordinador", criticidad: 2 };
  return { texto: "Pendiente", criticidad: 0 };
}

/**
 * Extrae el instanceID del padre desde el path de una solicitud de composición.
 */
function _extraerInstanceID(req) {
  const parametros = req.params ?? [];
  if (parametros[0]?.instanceID) return parametros[0].instanceID;
  if (typeof parametros[0] === "string") return parametros[0];
  return req.query?.SELECT?.from?.ref?.[0]?.where?.find?.(
    w => w?.ref?.[0] === "instanceID"
  )?.val ?? null;
}

// ─── MOCKS (desarrollo local sin BPA/CPI disponible) ─────────────────────────

/**
 * Mock de lista de tareas para el List Report cuando BPA no está disponible.
 * Los flags de rol se derivan del activityId con el mecanismo real.
 */
function _getMockTareas() {
  const tareas = [
    {
      instanceID: "mock-task-001",
      activityId: "form_aprobacionLiberadorFinal_1",
      tituloTarea: "0025-R4603-BCP-20/05/2026-L", numeroPropuesta: "R4603",
      sociedad: "0025", fechaPropuestaPago: "20-05-2026", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "N", modalidadPP: "H2H",
      version: "0001", importe: "43038.69", moneda: "PEN",
      usuarioCreacion: "cpanduro@centria.net",
      estaTerminado: false, estaAnulado: false,
    },
    {
      instanceID: "mock-task-002",
      activityId: "form_aprobacionDelApoderado_1",
      tituloTarea: "0025-R4615-BCP-22/05/2026-A", numeroPropuesta: "R4615",
      sociedad: "0025", fechaPropuestaPago: "22-05-2026", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "W", modalidadPP: "H2H",
      version: "0001", importe: "8500.00", moneda: "PEN",
      usuarioCreacion: "arodas@centria.net",
      estaTerminado: false, estaAnulado: false,
      // Simula una tarea devuelta por el loop back de BPA: Payroll rechazó el
      // intento anterior. Reproduce el formato real de EpMensaje observado en QAS.
      notifTieneError: true,
      notifMensaje   : "Correo no existe: usuario.prueba@ejemplo.com",
      notifCriticidad: 1,
    },
    {
      instanceID: "mock-task-003",
      activityId: "form_aprobacionDelApoderado_2",
      tituloTarea: "0025-R4616-BCP-22/05/2026-A", numeroPropuesta: "R4616",
      sociedad: "0025", fechaPropuestaPago: "22-05-2026", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "N", modalidadPP: "H2H",
      version: "0001", importe: "12300.00", moneda: "PEN",
      usuarioCreacion: "arodas@centria.net",
      estaTerminado: false, estaAnulado: false,
    },
  ];

  return tareas.map(tarea => {
    const flagsRol = perfiles.calcularFlagsRol(tarea.activityId);
    return {
      // Defaults sin rechazo: cada tarea puede sobrescribirlos arriba
      notifTieneError   : false,
      notifMensaje      : "",
      notifCriticidad   : 0,
      ...tarea,
      ...flagsRol,
      puedeTerminarFlujo: flagsRol.esCoordinador && tarea.estaTerminado,
      puedeAnular       : flagsRol.esCoordinador && tarea.estaAnulado,
    };
  });
}

/**
 * Mock de detalle completo para el Object Page cuando BPA no está disponible.
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
    estadoPP              : "EN_FIRMA",
    urlPDF                : `/nomina/aprobaciones/PropuestaPDF('${instanceID}')/contenido`,
    usuarioApoderado      : "", usuarioCaja: "",
    usuariosRevisores     : [],
    usuariosAnalistas     : [],
    usuariosSupervisores  : [],
    // Simula rol Liberador para pruebas locales; cambiar activityId para otros roles.
    ...perfiles.calcularFlagsRol("form_aprobacionLiberadorFinal_1"),
    // Sin rechazo de Payroll en el mock. Para probar la UI del error localmente,
    // poner notifTieneError: true, un notifMensaje y notifCriticidad: 1.
    notifTieneError       : false,
    notifMensaje          : "",
    notifCriticidad       : 0,
    estaTerminado         : false,
    estaAnulado           : false,
    puedeTerminarFlujo    : false,
    puedeAnular           : false,
    proveedores: [
      { proveedorId: "001", ruc: "20100070970", nombre: "EMPRESA DE SERVICIOS SAC",
        glosa: "REMUNERACIONES MAYO 2026", monto: 15200.50, facturas: "F001-00123" },
      { proveedorId: "002", ruc: "20512528458", nombre: "CONSORCIO INDUSTRIAL SA",
        glosa: "HONORARIOS MAYO 2026",    monto: 27838.19, facturas: "F002-00987" },
    ],
    adjuntos: [
      { adjuntoId: "adj-001", nombre: "CARGA_BANK_R4603_BCP.txt",
        url: "/dms/adj-001", tipoDocumento: "CARGA_BANK", fechaCarga: new Date() },
    ],
    aprobadores: [
      { aprobadorId: "001", orden: 1, usuario: "CPANDURO", rol: "SUPERVISOR",
        decision: "APROBADO", comentario: "", fechaAccion: new Date("2026-05-20T10:30:00Z") },
    ],
  };
}

/**
 * Genera un buffer PDF mínimo válido para verificación local.
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