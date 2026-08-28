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
 *   handle_composiciones()  → READ Proveedor, Adjunto, Aprobador, NivelAprobacion
 *   handle_aprobaciones()   → todas las acciones bound de TareasInbox
 *                             (delegadas a aprobacion.service.registrarHandlers)
 *
 * Roles activos (BPA v1.2.0 — H2H Nomina 1.5.0):
 *   Apoderado (pool, quórum de 2) → apoderadoAprobar | apoderadoRechazar
 *   Liberador                     → liberadorLiberar | liberadorRechazar | liberadorAnular
 *   Coordinador                   → ANULADO — retorna 501 si se invoca
 */

const cds      = require("@sap/cds");
const aprobSvc = require("./domain/aprobacion.service");
const constSvc = require("./domain/constantes.service");
const histSvc  = require("./domain/historial.service");
const cpiInfra = require("./infrastructure/cpi-client");
const bpa      = require("./infrastructure/bpa-client");
const odata    = require("./infrastructure/odata-memoria");
const { memoPorPeticion } = require("./infrastructure/memo-peticion");
const perfiles = require("./config/perfiles");
const estados  = require("./config/estados");
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
     * Sirve el PDF de la propuesta como stream binario — es la URL que consume
     * sap.m.PDFViewer desde el botón "Ver PDF" del Object Page
     * (app/ui5-aprobaciones/webapp/ext/util/VisorPDF.js).
     *
     * La clave `id` es la terna '<numeroPropuesta>-<sociedad>-<yyyy-MM-dd>' que
     * arma _urlPDF(): la fecha aporta sus propios guiones, por eso se reconstruye
     * uniendo todo lo que sigue a los dos primeros segmentos.
     *
     * ⚠ ORIGEN REAL PENDIENTE: se sirve un documento preliminar hasta que el
     * iFlow que lo entrega esté disponible. El visor ya funciona de punta a
     * punta contra este handler, así que conectar el origen real es cambiar
     * únicamente lo que devuelve el bloque `esContenido` de abajo.
     *
     * POR DÓNDE ENTRA EL PDF DEFINITIVO
     * ---------------------------------
     * Por CPI, como TODO lo que este servicio necesita de SAP: el historial de
     * aprobaciones, los proveedores, los adjuntos y el registro de firmas ya van
     * por ahí (infrastructure/cpi-client.js, destination Cloud_Integration ya
     * bindeada). El documento lo produce SAP y CPI lo expone; CAP no habla con
     * SAP por ningún otro canal. Falta únicamente la ruta del iFlow y el formato
     * de su respuesta para añadir el método al cliente de CPI.
     *
     * Lo que hay en el proyecto de la app UI5 anterior NO sirve:
     * domain/propuesta.service.js → getPDFSAP() y utils.js →
     * obtenerPDFPropuesta() invocan ambos un cliente `gw` que no existe en
     * ningún módulo, así que revientan con ReferenceError si se los llama.
     *
     * Mientras tanto se sirve un PDF de una página con la terna impresa y
     * marcado como preliminar: valida el flujo completo sin fingir en ningún
     * momento que el documento es el de SAP.
     */
    this.on("READ", "PropuestaPDF", async (req) => {
      const id = req.params?.[0]?.id ?? req.params?.[0];
      if (!id) return [];

      const [numeroPropuesta, sociedad, ...fechaParts] = String(id).split("-");
      const fechaPropuestaPago = fechaParts.join("-");
      const nombreArchivo      = `${id}.pdf`;

      const columns     = req.query?.SELECT?.columns ?? [];
      const esContenido = columns.some(c => c?.ref?.[0] === "contenido");

      if (esContenido) {
        // Readable.from(buffer) NO sirve: un Buffer es iterable de NÚMEROS, así
        // que el stream emitiría bytes sueltos en object mode y el request
        // fallaría. Envolverlo en un array lo entrega como un único chunk.
        const contenido = _construirPDFPreliminar({ id, numeroPropuesta, sociedad, fechaPropuestaPago });

        // Content-Type y Content-Disposition inline: sin ellos el navegador
        // descarga el archivo en vez de pintarlo, y el iframe del PDFViewer
        // queda en blanco. Ver capire → Serving Media Data.
        return {
          value                            : Readable.from([contenido]),
          $mediaContentType                : "application/pdf",
          $mediaContentDispositionFilename : nombreArchivo,
          $mediaContentDispositionType     : "inline",
        };
      }

      return {
        id,
        numeroPropuesta,
        sociedad,
        fechaPropuestaPago,
        mimeType     : "application/pdf",
        nombreArchivo,
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
        // Normalizado antes de llegar a BPA: getInboxTasks lo envía como
        // recipientUsers, que es un parámetro SEPARADO POR COMAS. Un id con una
        // coma arrastrada ("arodas@centria.net,") añade un destinatario vacío y
        // BPA deja de filtrar: la bandeja pasa a mostrar tareas de todo el
        // mundo. Ver perfiles.normalizarUsuario.
        const tareas = await _obtenerTareasBpa(perfiles.normalizarUsuario(req.user.id));
        // BPA no sabe filtrar por sociedad/banco/fecha (viven en el contexto de
        // cada tarea, no en la lista de task-instances), así que el $filter, el
        // $search, el orden y la paginación se aplican aquí sobre la lista ya
        // enriquecida. Sin esto la barra de filtros no tiene ningún efecto:
        // un handler .on reemplaza la implementación por defecto de CAP y el
        // array se devuelve tal cual. Ver infrastructure/odata-memoria.js.
        return odata.aplicarConsulta(tareas, req);
      }

      // Con clave → verificar si se necesita el detalle completo de CPI.
      const columnas  = req.query?.SELECT?.columns ?? [];
      const nombres   = columnas.map(c => c?.ref?.[0]).filter(Boolean);
      const camposCPI = ["proveedores", "adjuntos", "aprobadores", "niveles"];

      const necesitaCPI = nombres.length === 0 ||
                          nombres.some(nombre => camposCPI.includes(nombre));

      if (!necesitaCPI) {
        // FCL pidió solo campos livianos — omitir CPI
        LOG.info(`[READ TareasInbox] $select liviano — omitiendo CPI | id=${instanceID}`);
        try {
          const [tarea, contexto] = await Promise.all([
            bpa.obtenerTarea(instanceID),
            bpa.readContext(instanceID),
          ]);
          if (contexto) return _mapearContextoBpa(instanceID, contexto, tarea?.activityId, tarea?.subject);
        } catch (error) {
          // Mismo fallback que _obtenerTareasBpa y _obtenerDetalleTarea: sin él,
          // esta rama devolvía 500 en cuanto BPA no estaba disponible. Fiori
          // Elements la usa para los $select pequeños que resuelven la visibilidad
          // de los botones (esApoderado/esLiberador), así que ese 500 rompía el
          // enlace del Object Page entero — y con él las secciones que cuelgan de
          // su contexto, incluido el ProcessFlow del historial.
          LOG.warn(`[READ TareasInbox] BPA no disponible en $select liviano — usando mock | ${error.message}`);
        }
        return _getMockDetalle(instanceID);
      }

      return await _obtenerDetalleTarea(instanceID);
    });
  }

  // ─── LISTA DE VALORES DEL FILTRO "ESTADO" ────────────────────────────────

  static handle_estados() {
    /**
     * GET /nomina/aprobaciones/EstadosPropuesta
     * Alimenta el desplegable del filtro "Estado" del List Report.
     *
     * Sale de la MISMA tabla que calcula el estado de cada tarea
     * (config/estados.js), así que el texto ofrecido en el desplegable es
     * exactamente el que llevan las filas — que es lo que exige el $filter,
     * porque compara sobre el texto y no sobre un código.
     */
    this.on("READ", "EstadosPropuesta", (req) =>
      odata.aplicarConsulta(estados.listar(), req));
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
     * Nodos del ProcessFlow "Historial de Aprobaciones" del Object Page.
     * Origen legado: fragment/Aprobadores.xml
     */
    this.on("READ", "Aprobador", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const detalle = await _obtenerDetalleTarea(instanceID);
      return detalle.aprobadores ?? [];
    });

    /**
     * GET /nomina/aprobaciones/TareasInbox('{id}')/niveles
     * Lanes (columnas) del mismo ProcessFlow. CAP las deriva del historial;
     * no son una fuente de datos independiente — ver historial.service.js.
     */
    this.on("READ", "NivelAprobacion", async (req) => {
      const instanceID = _extraerInstanceID(req);
      if (!instanceID) return [];
      const detalle = await _obtenerDetalleTarea(instanceID);
      return detalle.niveles ?? [];
    });
  }

  // ─── ACCIONES BOUND DE APROBACIÓN ────────────────────────────────────────

  static handle_aprobaciones() {
    /**
     * Registra todos los handlers de acciones bound de TareasInbox:
     *   apoderadoAprobar  | apoderadoRechazar
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
 * Formatea el importe con la convención monetaria peruana: "S/ 43,038.69".
 * Coma para los miles, punto para los decimales y siempre dos decimales.
 *
 * Se formatea en CAP —no en la vista— por el mismo motivo que las fechas del
 * historial (historial.service.js → _formatearFecha): así el importe se lee igual
 * en la app, en un export y en cualquier consumidor futuro del mismo OData, sin
 * depender del locale del navegador. Con `@Measures.ISOCurrency` la agrupación la
 * elegiría el idioma del usuario y un navegador en es-ES mostraría "43.038,69",
 * que no es la convención de Perú.
 *
 * `importe` llega como texto desde el contexto BPA (nunca como número), así que
 * se convierte aquí. Si no es convertible se devuelve el valor original tal cual:
 * es preferible mostrar el dato crudo antes que un "S/ NaN".
 *
 * @param {string} importe - importe en texto, con punto decimal ("43038.69")
 * @param {string} moneda  - código ISO de la propuesta; PEN por defecto
 * @returns {string} importe formateado, o "" si no hay importe
 */
function _formatearImporte(importe, moneda) {
  if (importe === null || importe === undefined || String(importe).trim() === "") return "";

  const valor = Number(String(importe).trim());
  if (!Number.isFinite(valor)) return String(importe);

  const codigo = String(moneda ?? "").trim().toUpperCase() || "PEN";

  // "$" en vez del "US$" que da Intl para dólares — pedido de negocio.
  if (codigo === "USD") {
    const numero = new Intl.NumberFormat("es-PE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(valor);
    return `$ ${numero}`;
  }

  try {
    return new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency: codigo,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
      .format(valor)
      // Intl separa símbolo e importe con un espacio duro; se normaliza a espacio
      // normal para que las búsquedas y los exports no traigan un carácter raro.
      .replace(/ /g, " ");
  } catch (error) {
    // Código de moneda inválido en el contexto BPA: no se pierde el importe.
    LOG.warn(`[_formatearImporte] moneda no reconocida | moneda=${codigo} | ${error.message}`);
    return `${codigo} ${valor.toFixed(2)}`;
  }
}

/** Añade el importe ya formateado a una tarea del List Report. */
function _conImporteFormateado(tarea) {
  return { ...tarea, importeTexto: _formatearImporte(tarea.importe, tarea.moneda) };
}

/**
 * Obtiene y enriquece la lista de tareas BPA con su contexto.
 *
 * Memoizado por petición igual que el detalle: el $batch que manda Fiori
 * Elements tras una acción puede pedir la colección más de una vez (el refresco
 * del SideEffects y el propio rebinding de la tabla), y cada reconstrucción
 * cuesta una llamada de lista más un readContext POR TAREA. Ver infrastructure/memo-peticion.
 *
 * @param {string} usuario - Email del usuario autenticado (req.user.id)
 */
function _obtenerTareasBpa(usuario) {
  return memoPorPeticion(`tareas:${usuario}`, () => _cargarTareasBpa(usuario));
}

/**
 * Carga real de la bandeja. No llamar directamente: usar _obtenerTareasBpa.
 * Origen legado: Master.controller.js → getInboxTasks() + readContext()
 */
async function _cargarTareasBpa(usuario) {
  try {
    const tareas = await bpa.getInboxTasks(usuario);
    if (!tareas.length) return [];

    const tareasEnriquecidas = await Promise.all(
      tareas.map(tarea => _enriquecerConContexto(tarea))
    );
    // El formato del importe se aplica en la salida —y no dentro de cada rama—
    // para que las tareas reales y las de respaldo se muestren igual.
    return tareasEnriquecidas.map(_conImporteFormateado);

  } catch (error) {
    LOG.warn(`[_cargarTareasBpa] BPA no disponible — usando mock | ${error.message}`);
    return _getMockTareas().map(_conImporteFormateado);
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
    notifMensaje   : _mensajeLegible(mensaje) ||
                     "Payroll rechazó la operación sin detallar el motivo.",
    notifCriticidad: 1,   // UI.CriticalityType.Negative → se pinta en rojo
  };
}

/**
 * Limpia el mensaje de rechazo antes de mostrarlo en el Object Page.
 *
 * El script de BPA que escribe la variable de mensaje a veces vuelca ahí el
 * resultado CRUDO del Action Task en vez del texto de negocio — por ejemplo
 * `{"result":{"n0:ZhrfApoRegResponse":{"EpMensaje":"Correo no existe: x","EpFlagError":"X"}}}`
 * en vez de solo "Correo no existe: x". Es una variación del script del BPMN,
 * no algo que CAP controle, así que en vez de mostrarle JSON crudo al usuario
 * se busca el texto legible dentro de la estructura si hace falta.
 *
 * El campo se busca por SUFIJO "epmensaje" (case-insensitive) para tolerar el
 * prefijo de namespace ("n0:") que agrega CPI, igual que _extraerDetalle en
 * cpi-client.js. Si el valor no es JSON, o no aparece ese campo, se devuelve
 * el texto tal cual — así un mensaje ya limpio nunca se altera.
 *
 * @param {*} bruto - valor crudo de la variable de mensaje en context.custom
 * @returns {string}
 */
function _mensajeLegible(bruto) {
  const texto = String(bruto ?? "").trim();
  if (!texto.startsWith("{") && !texto.startsWith("[")) return texto;

  let parseado;
  try {
    parseado = JSON.parse(texto);
  } catch {
    return texto;
  }

  return _buscarEpMensaje(parseado) ?? texto;
}

/** Busca recursivamente una clave que termine en "epmensaje" con valor no vacío. */
function _buscarEpMensaje(nodo, profundidad = 0) {
  if (!nodo || typeof nodo !== "object" || profundidad > 6) return undefined;

  for (const [clave, valor] of Object.entries(nodo)) {
    if (typeof valor === "string" && valor.trim() && clave.toLowerCase().endsWith("epmensaje")) {
      return valor.trim();
    }
  }
  for (const valor of Object.values(nodo)) {
    if (valor && typeof valor === "object") {
      const encontrado = _buscarEpMensaje(valor, profundidad + 1);
      if (encontrado) return encontrado;
    }
  }
  return undefined;
}

/**
 * Extrae el estado del QUÓRUM DE APODERADOS del contexto BPA.
 *
 * Desde v1.2.0 los apoderados son una lista de N usuarios equivalentes y bastan
 * dos firmas cualesquiera. La tarea es una sola, con pool de destinatarios, y
 * reaparece en el inbox de los que faltan hasta alcanzar el quórum. Sin estos
 * campos el usuario no tiene forma de saber si su firma es la primera o la que
 * cierra, ni por qué la propuesta sigue apareciéndole a un compañero.
 *
 * Se calcula SOLO para tareas de apoderado: en la del liberador no hay pool que
 * describir, y devolver "0 de 2" ahí sería ruido que la UI tendría que filtrar.
 *
 * @param {object} contexto   - contexto BPA completo (con su rama `custom`)
 * @param {object} propuesta  - PropuestaNomina ya extraída
 * @param {object} flagsRol   - resultado de perfiles.calcularFlagsRol()
 */
function _extraerQuorum(contexto, propuesta, flagsRol) {
  const vacio = {
    usuariosApoderados      : "",
    apoderadosFirmantes     : "",
    apoderadosPendientes    : "",
    contadorFirmasApoderados: 0,
    firmasRequeridas        : 0,
    firmasTexto             : "",
  };

  if (!flagsRol?.esApoderado) return vacio;

  const quorum = perfiles.resolverQuorumApoderados(contexto, propuesta ?? {});

  return {
    usuariosApoderados      : quorum.originales.join(", "),
    apoderadosFirmantes     : quorum.firmantes.join(", "),
    apoderadosPendientes    : quorum.pendientes.join(", "),
    contadorFirmasApoderados: quorum.contador,
    firmasRequeridas        : quorum.requeridas,
    firmasTexto             : `${quorum.contador} de ${quorum.requeridas} firmas`,
  };
}

/**
 * Mapea un contexto BPA al shape de TareasInbox SIN llamar a CPI.
 * Usado por la ruta de $select liviano del READ.
 */
function _mapearContextoBpa(instanceID, contexto, activityId, subject) {
  const propuesta = _extraerPropuesta(contexto);
  return _ensamblarDetalle({
    instanceID,
    activityId,
    subject,
    propuesta,
    notificacion: _extraerNotificacion(contexto, activityId),
    quorum      : _extraerQuorum(contexto, propuesta, perfiles.calcularFlagsRol(activityId)),
    proveedores : [],
    adjuntos    : [],
    aprobadores : [],
    niveles     : [],
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
      fechaPropuestaPago : _fecha(propuesta.fechaPropuestaPago),
      fechaPago          : _fecha(propuesta.fechaPago),
      usuarioCreacion    : propuesta.usuarioCreacion    ?? "",
      correoAnalista     : propuesta.correoAnalista     ?? "",
      ..._camposEstado(flagsRol, { estaTerminado, estaAnulado }),
      ...flagsRol,
      // Resultado del intento anterior: si Payroll rechazó, la tarea reapareció
      // por loop back y el usuario debe ver el motivo ya desde la lista.
      ..._extraerNotificacion(contexto, tarea.activityId),
      // Estado del quórum: la tarea de apoderado también reaparece cuando falta
      // la segunda firma, y "1 de 2 firmas" es lo que distingue ese caso de un
      // rechazo de Payroll sin abrir el detalle.
      ..._extraerQuorum(contexto, propuesta, flagsRol),
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
      version            : "", fechaPropuestaPago: null, fechaPago: null, usuarioCreacion: "",
      correoAnalista     : "",
      // Sin contexto no hay flags de cierre, pero el rol de la tarea sí se
      // conoce (viene del activityId), así que el estado sigue siendo el real.
      ..._camposEstado(flagsRol, { estaTerminado: false, estaAnulado: false }),
      ...flagsRol,
      notifTieneError    : false, notifMensaje: "", notifCriticidad: 0,
      // Sin contexto no hay quórum que leer: los campos van vacíos en vez de
      // inventar un "0 de 2" que la UI mostraría como si fuera un dato real.
      ..._extraerQuorum(null, {}, { esApoderado: false }),
      estaTerminado      : false, estaAnulado: false,
      puedeTerminarFlujo : false, puedeAnular: false,
    };
  }
}

/**
 * Obtiene el detalle completo de una tarea para el Object Page.
 *
 * Memoizado por petición: el Object Page lo pide una vez para la entidad y otra
 * por cada tabla de sección, y las cinco lecturas son el mismo dato. Ver
 * memo-peticion.js para el alcance y por qué no es una caché con TTL.
 *
 * @param {string} instanceID
 */
function _obtenerDetalleTarea(instanceID) {
  return memoPorPeticion(`detalle:${instanceID}`, () => _cargarDetalleTarea(instanceID));
}

/**
 * Carga real del detalle. No llamar directamente desde los handlers: usar
 * _obtenerDetalleTarea, que evita repetir el trabajo dentro de la misma petición.
 *
 * BPA + composiciones CPI en paralelo para minimizar latencia.
 * Origen legado: Detail.controller.js → _onBindingChange()
 */
async function _cargarDetalleTarea(instanceID) {
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

    // historial.service ya resuelve internamente su propio fallback (si ECP no
    // responde, muestra el esqueleto del flujo), por eso no lleva .catch().
    const [proveedores, adjuntos, historial] = await Promise.all([
      cpiInfra.getProveedores(propuesta).catch(() => []),
      cpiInfra.getAdjuntos(propuesta).catch(() => []),
      // activityId: la misma fuente que decide los flags de rol y los botones.
      // Se pasa para que los estados del esqueleto no puedan contradecir lo que
      // la pantalla permite hacer (ver filasEsperadas).
      // contexto: aporta el quórum — cuántas tarjetas tiene el nivel de
      // apoderados y quiénes de ellos ya firmaron según BPA.
      histSvc.obtenerHistorial(propuesta, instanceID, tarea?.activityId, contexto),
    ]);

    return _ensamblarDetalle({
      instanceID,
      activityId: tarea?.activityId,
      subject   : tarea?.subject,
      propuesta,
      notificacion: _extraerNotificacion(contexto, tarea?.activityId),
      quorum      : _extraerQuorum(contexto, propuesta,
                                   perfiles.calcularFlagsRol(tarea?.activityId)),
      proveedores,
      adjuntos,
      aprobadores: historial.aprobadores,
      niveles    : historial.niveles,
      historialEsDemo: historial.esDemo,
    });

  } catch (error) {
    if (error.status === 404) throw error;
    LOG.warn(`[_cargarDetalleTarea] BPA no disponible — usando mock | ${error.message}`);
    return _getMockDetalle(instanceID);
  }
}

/**
 * Normalizadores de salida.
 *
 * Un campo con valor `undefined` NO se serializa en JSON: desaparece de la
 * respuesta OData aunque el $select lo pida. En el cliente eso se ve como
 * "Failed to drill-down into (...)/campo, invalid segment: campo" y el control
 * enlazado se queda vacío. Como el contexto BPA no garantiza que la propuesta
 * traiga todos los campos del DataType, cada valor se normaliza aquí antes de
 * salir: texto vacío, 0, false o null, pero nunca `undefined`.
 */
function _texto(valor)   { return valor === null || valor === undefined ? "" : String(valor); }
function _entero(valor)  { const n = Number(valor); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function _booleano(valor) {
  if (typeof valor === "boolean") return valor;
  const texto = String(valor ?? "").trim().toUpperCase();
  return texto === "X" || texto === "TRUE" || texto === "1" || texto === "EXISTE";
}

/**
 * Normaliza una fecha para una propiedad Edm.Date.
 *
 * Solo yyyy-MM-dd es un valor válido; el "" que se usaba como valor por defecto
 * no lo es y llega al cliente como una fecha corrupta. Cualquier otra cosa
 * (vacío, undefined, formato inesperado) se envía como null, que es lo que
 * OData define para "sin valor".
 */
function _fecha(valor) {
  const texto = String(valor ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

/**
 * URL de la entidad media PropuestaPDF para esta propuesta.
 *
 * La clave es la terna '<numeroPropuesta>-<sociedad>-<yyyy-MM-dd>' y NO el
 * instanceID de BPA, que es lo que se construía antes: el instanceID es un UUID
 * del workflow, no identifica el documento en SAP, y encima handle_pdf lo
 * troceaba por guiones esperando justamente esta terna — la URL nunca resolvía.
 *
 * Devuelve null si falta cualquiera de los tres campos: sin terna completa no hay
 * documento que pedir, y un urlPDF vacío hace que el botón "Ver PDF" avise en vez
 * de abrir un visor roto.
 */
function _urlPDF(propuesta) {
  const partes = [propuesta?.numeroPropuesta, propuesta?.sociedad, propuesta?.fechaPropuestaPago]
    .map(parte => String(parte ?? "").trim());

  if (partes.some(parte => parte === "")) return null;

  const clave = encodeURIComponent(partes.join("-"));
  return `/nomina/aprobaciones/PropuestaPDF('${clave}')/contenido`;
}

/**
 * Ensambla el objeto final TareasInbox con campos, composiciones y flags.
 *
 * Flags de rol (esApoderado, esLiberador, etc.): desde activityId vía perfiles.
 * Flags de estado (estaTerminado, estaAnulado): desde contexto BPA.
 * Flags calculados Coordinador: puedeTerminarFlujo, puedeAnular.
 */
function _ensamblarDetalle({ instanceID, activityId, subject, propuesta, notificacion, quorum, proveedores, adjuntos, aprobadores, niveles, historialEsDemo }) {
  const flagsRol      = perfiles.calcularFlagsRol(activityId);
  const flagsNotif    = notificacion ??
                        { notifTieneError: false, notifMensaje: "", notifCriticidad: 0 };
  const flagsQuorum   = quorum ?? _extraerQuorum(null, {}, { esApoderado: false });
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
    // El título lo pone BPA en el subject de la tarea; la propuesta solo lo
    // trae en algunos contextos. Mismo orden de preferencia que el List Report
    // (_enriquecerConContexto), para que la lista y el detalle no muestren
    // títulos distintos de la misma tarea.
    tituloTarea           : _texto(subject || propuesta.tituloTarea),
    numeroPropuesta       : _texto(propuesta.numeroPropuesta),
    sociedad              : _texto(propuesta.sociedad),
    banco                 : _texto(propuesta.banco),
    bancoDescripcion      : _texto(propuesta.bancoDescripcion),
    importe               : _texto(propuesta.importe),
    moneda                : _texto(propuesta.moneda),
    importeTexto          : _formatearImporte(propuesta.importe, propuesta.moneda),
    viaPago               : _texto(propuesta.viaPago),
    modalidadPP           : _texto(propuesta.modalidadPP),
    version               : _texto(propuesta.version),
    fechaPropuestaPago    : _fecha(propuesta.fechaPropuestaPago),
    fechaPago             : _fecha(propuesta.fechaPago),
    usuarioCreacion       : _texto(propuesta.usuarioCreacion),
    usuarioRevisor        : _texto(propuesta.usuarioRevisor),
    analista              : _texto(propuesta.analista),
    correoAnalista        : _texto(propuesta.correoAnalista),
    existeDocumento       : _booleano(propuesta.existeDocumento),
    indicadorPagoAdelanto : _texto(propuesta.indicadorPagoAdelanto),
    tipoNomina            : _texto(propuesta.tipoNomina),
    tipoTrabajador        : _texto(propuesta.tipoTrabajador),
    subdivision           : _texto(propuesta.subdivision),
    estadoPP              : estado.texto,
    estadoCriticidad      : estado.criticidad,
    urlPDF                : _urlPDF(propuesta),
    contadorFirma         : _entero(propuesta.contadorFirma),
    cantidad              : _entero(propuesta.cantidad),
    // Lista, no un correo suelto: Payroll puede designar varios liberadores en
    // este campo y BPA reparte esa lista como destinatarios de la tarea. Se
    // normaliza igual que las de apoderados —minúsculas, sin duplicados,
    // separadas por ", "— para que un CSV crudo no llegue a la UI tal cual.
    usuarioLiberador      : perfiles.normalizarUsuarios(propuesta.usuarioLiberador).join(", "),
    usuarioCoordinador    : _texto(propuesta.usuarioCoordinador),
    usuarioCaja           : _texto(propuesta.usuarioCaja),
    // usuarioApoderado, usuariosRevisores y usuariosSupervisores se mapeaban
    // aquí sin existir en TareasInbox: los dos primeros salieron del DataType
    // de BPA hace versiones y el tercero nunca llegó a la entidad. Se retiran
    // en vez de arrastrar campos que ningún consumidor puede leer.
  };

  return {
    ...base,
    ...flagsRol,
    ...flagsNotif,
    ...flagsQuorum,
    ...flagsEstado,
    ...flagsCalculados,
    proveedores,
    adjuntos,
    aprobadores,
    niveles: niveles ?? [],
    historialEsDemo: historialEsDemo ?? false,
  };
}

/**
 * Deriva texto + criticidad de "Estado" a partir del rol pendiente (activityId)
 * y los flags de cierre del flujo. No existe un campo "estadoPP" en el
 * contexto BPA (PropuestaNomina) — era un campo de la arquitectura HANA
 * anterior que nunca se migró — así que se calcula en vivo con lo único
 * que BPA sí entrega: quién tiene la tarea pendiente y si el flujo cerró.
 *
 * Aquí vive el ORDEN de precedencia; los textos y los colores viven en
 * config/estados.js, que es la misma tabla que alimenta el desplegable del
 * filtro "Estado". Separarlos evita que la lista de valores y la columna se
 * desincronicen — la comparación del $filter es sobre el texto.
 */
function _calcularEstado(flagsRol, flagsEstado) {
  const E = estados.ESTADOS;
  if (flagsEstado.estaAnulado)   return E.ANULADO;
  if (flagsEstado.estaTerminado) return E.LIBERADO;
  if (flagsRol.esLiberador)      return E.LIBERACION;
  // Un único estado para los apoderados: con el pool del quórum ya no hay un
  // "Apoderado 1" y un "Apoderado 2" que separar — la tarea es la misma para
  // todos y el orden de firma lo decide quién llegue primero.
  if (flagsRol.esApoderado)      return E.APODERADOS;
  if (flagsRol.esCoordinador)    return E.COORDINADOR;
  return E.PENDIENTE;
}

/**
 * Los dos campos de estado listos para mezclar en una fila del List Report.
 *
 * El List Report los necesita en la COLECCIÓN, no solo en el detalle: la
 * columna "Estado" y su filtro se resuelven sobre lo que devuelve
 * GET /TareasInbox. Mientras estadoPP solo se calculaba en _ensamblarDetalle,
 * las filas de la lista llegaban sin él y un $filter sobre estadoPP no
 * encontraba nada, porque comparaba contra un campo vacío.
 */
function _camposEstado(flagsRol, flagsEstado) {
  const estado = _calcularEstado(flagsRol, flagsEstado);
  return { estadoPP: estado.texto, estadoCriticidad: estado.criticidad };
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
      sociedad: "0025", fechaPropuestaPago: "2026-05-20", fechaPago: "2026-05-20", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "N", modalidadPP: "H2H",
      version: "0001", importe: "43038.69", moneda: "PEN",
      usuarioCreacion: "cpanduro@centria.net",
      estaTerminado: false, estaAnulado: false,
    },
    {
      instanceID: "mock-task-002",
      activityId: "form_aprobacionDelApoderado_1",
      tituloTarea: "0025-R4615-BCP-22/05/2026-A", numeroPropuesta: "R4615",
      sociedad: "0025", fechaPropuestaPago: "2026-05-22", fechaPago: "2026-05-22", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "W", modalidadPP: "H2H",
      version: "0001", importe: "8500.00", moneda: "PEN",
      usuarioCreacion: "arodas@centria.net",
      estaTerminado: false, estaAnulado: false,
      // Simula una tarea devuelta por el loop back de BPA: Payroll rechazó el
      // intento anterior. Reproduce el formato real de EpMensaje observado en QAS.
      notifTieneError: true,
      notifMensaje   : "Correo no existe: usuario.prueba@ejemplo.com",
      notifCriticidad: 1,
      // Quórum sin arrancar: nadie ha firmado todavía, los cuatro apoderados
      // de la lista siguen pendientes.
      quorum: {
        usuarios : ["jlicetti@centria.net", "lqcastro@centria.net",
                    "arodas@centria.net", "cpanduro@centria.net"],
        firmantes: [],
      },
    },
    {
      instanceID: "mock-task-003",
      activityId: "form_aprobacionDelApoderado_1",
      tituloTarea: "0025-R4616-BCP-22/05/2026-A", numeroPropuesta: "R4616",
      sociedad: "0025", fechaPropuestaPago: "2026-05-22", fechaPago: "2026-05-22", banco: "BCP",
      bancoDescripcion: "001 - BCP Soles", viaPago: "N", modalidadPP: "H2H",
      version: "0001", importe: "12300.00", moneda: "PEN",
      usuarioCreacion: "arodas@centria.net",
      estaTerminado: false, estaAnulado: false,
      // El caso que solo existe desde v1.2.0: la tarea reapareció en el inbox
      // no por un rechazo de Payroll, sino porque falta la segunda firma. Sin
      // el texto del quórum las dos situaciones son indistinguibles en pantalla.
      quorum: {
        usuarios : ["jlicetti@centria.net", "lqcastro@centria.net",
                    "arodas@centria.net"],
        firmantes: ["jlicetti@centria.net"],
      },
    },
  ];

  return tareas.map(({ quorum, ...tarea }) => {
    const flagsRol = perfiles.calcularFlagsRol(tarea.activityId);
    return {
      // Defaults sin rechazo: cada tarea puede sobrescribirlos arriba
      notifTieneError   : false,
      notifMensaje      : "",
      notifCriticidad   : 0,
      ...tarea,
      ...flagsRol,
      ..._camposEstado(flagsRol, tarea),
      // El quórum se arma con la MISMA función que los datos reales, alimentada
      // con un contexto BPA simulado: así el mock ejercita la normalización de
      // perfiles.js en vez de esquivarla escribiendo los textos a mano.
      ..._extraerQuorum(
        _contextoQuorumMock(quorum),
        { usuariosApoderados: (quorum?.usuarios ?? []).join(",") },
        flagsRol),
      puedeTerminarFlujo: flagsRol.esCoordinador && tarea.estaTerminado,
      puedeAnular       : flagsRol.esCoordinador && tarea.estaAnulado,
    };
  });
}

/**
 * Contexto BPA simulado con la rama `custom` del quórum, tal como la escriben
 * los scripts `inicializarApoderados` y `Registrar firma` — nombres de variable
 * en minúsculas incluidos, que es como BPA las expone de verdad.
 */
function _contextoQuorumMock(quorum) {
  if (!quorum) return null;
  const firmantes  = quorum.firmantes ?? [];
  const pendientes = (quorum.usuarios ?? []).filter(correo => !firmantes.includes(correo));

  return {
    custom: {
      apoderadospendientes    : pendientes.join(","),
      apoderadosfirmantes     : firmantes.join(","),
      contadorfirmasapoderados: firmantes.length,
      firmasrequeridas        : 2,
    },
  };
}

/**
 * Mock de detalle completo para el Object Page cuando BPA no está disponible.
 */
function _getMockDetalle(instanceID) {
  // Rol simulado para pruebas locales; cambiarlo aquí cambia a la vez los botones
  // visibles y los estados del historial, que es justo lo que evita que el
  // diagrama muestre un apoderado pendiente junto a los botones de Liberación.
  const ACTIVITY_ID_SIMULADO = "form_aprobacionLiberadorFinal_1";

  // Propuesta simulada: la lista de apoderados va como CSV, igual que la
  // entrega Payroll desde el DataType 1.4.0.
  const PROPUESTA_SIMULADA = {
    usuariosApoderados: "jlicetti@centria.net,lqcastro@centria.net,arodas@centria.net",
    usuarioLiberador  : "bmendoza@centria.net",
    analista          : "MRICANQUI",
  };

  // Sin BPA no hay a quién preguntar por las firmas, así que el diagrama del
  // mock es solo el esqueleto: los slots de apoderado salen aprobados —la tarea
  // viva es la del liberador— pero SIN firmante, porque quién firmó lo dice ECP
  // y aquí no se le ha preguntado. El aviso de historialEsDemo lo explica.
  const FIRMAS_REQUERIDAS = 2;

  // El historial pasa por el MISMO constructor que usarán los datos de ECP:
  // así el mock ejercita la normalización real en vez de esquivarla.
  const historial = histSvc.construirDesdeFilas(
    histSvc.filasEsperadas(PROPUESTA_SIMULADA, ACTIVITY_ID_SIMULADO, FIRMAS_REQUERIDAS),
    instanceID);

  return {
    instanceID,
    tituloTarea           : "0025-R4603-BCP-20/05/2026-R",
    numeroPropuesta       : "R4603",
    sociedad              : "0025",
    fechaPropuestaPago    : "2026-05-20",
    fechaPago             : "2026-05-20",
    banco                 : "BCP",
    bancoDescripcion      : "001 - BCP Soles",
    viaPago               : "N",
    modalidadPP           : "H2H",
    version               : "0001",
    importe               : "43038.69",
    moneda                : "PEN",
    importeTexto          : _formatearImporte("43038.69", "PEN"),
    analista              : "MRICANQUI",
    correoAnalista        : "mricanqui@centria.net",
    existeDocumento       : true,
    indicadorPagoAdelanto : "",
    contadorFirma         : 0,
    cantidad              : 1,
    usuarioCreacion       : "cpanduro@centria.net",
    usuarioRevisor        : "",
    estadoPP              : "EN_FIRMA",
    urlPDF                : _urlPDF({ numeroPropuesta: "R4603", sociedad: "0025",
                                     fechaPropuestaPago: "2026-05-20" }),
    usuarioLiberador      : PROPUESTA_SIMULADA.usuarioLiberador,
    usuarioCoordinador    : "",
    usuarioCaja           : "",
    // Flags de rol y estados del historial salen del MISMO activityId simulado.
    ...perfiles.calcularFlagsRol(ACTIVITY_ID_SIMULADO),
    // Rol simulado = liberador, así que el quórum va vacío: es exactamente lo
    // que devuelve _extraerQuorum para una tarea que no es de apoderado.
    ..._extraerQuorum(null, PROPUESTA_SIMULADA,
                      perfiles.calcularFlagsRol(ACTIVITY_ID_SIMULADO)),
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
    aprobadores    : historial.aprobadores,
    niveles        : historial.niveles,
    historialEsDemo: true,
  };
}

/**
 * PDF PRELIMINAR de la propuesta.
 *
 * Provisional: sustituye al documento real mientras el iFlow de CPI que lo
 * entrega no esté disponible (ver el aviso en handle_pdf). Muestra la terna que
 * identifica a la propuesta y se declara preliminar de forma inequívoca —marca
 * de agua y aviso al pie— para que nadie firme creyendo que está viendo el
 * detalle real del lote de pago.
 *
 * Se escribe a mano en lugar de usar pdfkit a propósito: pdfkit NO está en las
 * dependencias del proyecto (utils.js lo requiere y por eso también falla), y no
 * vale la pena sumar una dependencia para un artefacto que se va a borrar en
 * cuanto el iFlow entregue el PDF verdadero.
 */
function _construirPDFPreliminar({ id, numeroPropuesta, sociedad, fechaPropuestaPago }) {
  const filas = [
    ["N\u00b0 de propuesta",           numeroPropuesta    || "\u2014"],
    ["Sociedad",                       sociedad           || "\u2014"],
    ["Fecha de propuesta de pago",     _fechaDdMmAaaa(fechaPropuestaPago) || "\u2014"],
    ["Clave del documento",            id],
  ];

  const flujo = _flujoPaginaPreliminar(filas);

  // Fuentes con WinAnsiEncoding: sin ella los acentos y el símbolo de grado se
  // pintan como caracteres sueltos. El buffer se escribe en latin1, que es
  // justamente la codificación que WinAnsi espera byte a byte.
  const objetos = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/MediaBox[0 0 595 842]/Parent 2 0 R/Contents 4 0 R" +
      "/Resources<</Font<</F1 5 0 R/F2 6 0 R>>>>>>",
    `<</Length ${Buffer.byteLength(flujo, "latin1")}>>\nstream\n${flujo}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold/Encoding/WinAnsiEncoding>>",
  ];

  return _ensamblarPDF(objetos);
}

/**
 * yyyy-MM-dd → dd/MM/yyyy, la convención con la que se leen las fechas aquí.
 *
 * Se parte la cadena en vez de construir un Date a propósito: una fecha SIN hora
 * la interpreta JavaScript como UTC, y al presentarla en hora de Perú (-05:00)
 * retrocedería al día anterior. Aquí no hay hora que ajustar —es una fecha de
 * calendario, no un instante—, así que no hay nada que convertir.
 */
function _fechaDdMmAaaa(iso) {
  const partes = String(iso ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : "";
}

/** Escapa los caracteres que delimitan una cadena literal en PDF. */
function _txt(valor) {
  return String(valor ?? "").replace(/([\()])/g, "\$1");
}

/** Una línea de texto: fuente, tamaño, color RGB (0-1), posición y contenido. */
function _linea({ fuente = "F1", tam = 10, rgb = "0 0 0", x, y, texto }) {
  return `BT /${fuente} ${tam} Tf ${rgb} rg ${x} ${y} Td (${_txt(texto)}) Tj ET`;
}

/**
 * Content stream de la página. Coordenadas en puntos sobre A4 (595 x 842) con
 * el origen abajo a la izquierda, que es el sistema nativo del formato.
 */
function _flujoPaginaPreliminar(filas) {
  const AZUL   = "0.078 0.208 0.361";
  const GRIS   = "0.45 0.45 0.45";
  const NEGRO  = "0.13 0.13 0.13";
  const BLANCO = "1 1 1";

  const ops = [
    // ── Banda de cabecera ────────────────────────────────────────────────
    `${AZUL} rg 0 772 595 70 re f`,
    _linea({ fuente: "F2", tam: 22, rgb: BLANCO, x: 48, y: 803, texto: "Propuesta de Pago" }),
    _linea({ tam: 10, rgb: BLANCO, x: 48, y: 785, texto: "N\u00f3mina H2H \u2014 Aprobaci\u00f3n de propuestas" }),

    // ── Marca de agua diagonal ───────────────────────────────────────────
    // q/Q aísla la rotación: sin ellos todo lo dibujado después heredaría la
    // matriz girada.
    "q 0.90 0.90 0.90 rg 0.7071 0.7071 -0.7071 0.7071 105 210 cm",
    _linea({ fuente: "F2", tam: 62, rgb: "0.90 0.90 0.90", x: 0, y: 0, texto: "PRELIMINAR" }),
    "Q",

    // ── Aviso ────────────────────────────────────────────────────────────
    "0.99 0.95 0.80 rg 48 690 499 52 re f",
    "0.85 0.60 0.10 rg 48 690 4 52 re f",
    _linea({ fuente: "F2", tam: 11, rgb: "0.45 0.32 0.02", x: 66, y: 722,
             texto: "Documento preliminar" }),
    _linea({ tam: 9, rgb: "0.45 0.32 0.02", x: 66, y: 708,
             texto: "Este NO es el detalle real del lote de pago. El documento definitivo lo emite SAP y" }),
    _linea({ tam: 9, rgb: "0.45 0.32 0.02", x: 66, y: 697,
             texto: "llega por Cloud Integration; se mostrar\u00e1 aqu\u00ed en cuanto el iFlow est\u00e9 disponible." }),

    // ── Título del bloque de datos ───────────────────────────────────────
    _linea({ fuente: "F2", tam: 12, rgb: NEGRO, x: 48, y: 650, texto: "Datos de la propuesta" }),
    `${AZUL} rg 48 644 60 2 re f`,
  ];

  // ── Filas de datos ─────────────────────────────────────────────────────
  let y = 612;
  for (const [etiqueta, valor] of filas) {
    ops.push(_linea({ tam: 9,  rgb: GRIS,  x: 48, y: y,      texto: etiqueta }));
    ops.push(_linea({ fuente: "F2", tam: 13, rgb: NEGRO, x: 48, y: y - 18, texto: valor }));
    ops.push(`0.88 0.88 0.88 rg 48 ${y - 30} 499 0.8 re f`);
    y -= 52;
  }

  // ── Pie ────────────────────────────────────────────────────────────────
  ops.push(`0.88 0.88 0.88 rg 48 70 499 0.8 re f`);
  ops.push(_linea({ tam: 8, rgb: GRIS, x: 48, y: 56,
                    texto: "Generado por CAP \u2014 PagosService.PropuestaPDF \u2014 documento preliminar" }));

  return ops.join("\n");
}

/**
 * Envuelve los objetos en un PDF válido con su tabla xref.
 *
 * Los offsets se calculan sobre los bytes ya escritos: escribirlos a mano
 * —como hacía el mock anterior, con posiciones fijas que no correspondían a
 * nada— produce un archivo que solo abre gracias a que los visores reconstruyen
 * la tabla por su cuenta.
 */
function _ensamblarPDF(objetos) {
  let pdf = "%PDF-1.4\n";
  const offsets = [];

  objetos.forEach((cuerpo, indice) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${indice + 1} 0 obj\n${cuerpo}\nendobj\n`;
  });

  const inicioXref = Buffer.byteLength(pdf, "latin1");
  const total      = objetos.length + 1;   // +1 por la entrada libre obligatoria

  pdf += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${total}/Root 1 0 R>>\nstartxref\n${inicioXref}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

module.exports = { PagosService };