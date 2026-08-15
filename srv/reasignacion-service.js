"use strict";
/**
 * srv/reasignacion-service.js
 *
 * Implementación del ReasignacionService usando el patrón cds.ApplicationService.
 *
 * Grupos de handlers registrados automáticamente por init():
 *   handle_propuestas() → READ PropuestasEnCurso y sus composiciones
 *                          (Firmante / NivelFlujo / NodoFlujo)
 *   handle_tareas()     → READ TareasEnCurso (tareas de todos los usuarios)
 *   handle_ayudas()     → READ Sociedades / Usuarios / Roles / Estados
 *                          (value helps de la barra de filtros)
 *   handle_reasignar()  → acción bound reasignar sobre Firmante (delegada a
 *                          domain/reasignacion.service.js)
 *
 * LA UNIDAD DE TRABAJO ES LA PROPUESTA, no la tarea: el administrador abre una
 * propuesta y desde ahí ve su flujo completo y reasigna el rol que corresponda.
 * TareasEnCurso sigue siendo la verdad de BPA a nivel tarea y es de donde se
 * derivan las propuestas, pero ya no es la raíz de la UI.
 *
 * Acceso restringido a administradores — @requires: 'Administrador' en
 * reasignacion-service.cds.
 */

const cds       = require("@sap/cds");
const reasigSvc = require("./domain/reasignacion.service");
const bpa       = require("./infrastructure/bpa-client");
const odata     = require("./infrastructure/odata-memoria");
const histSvc   = require("./domain/historial.service");
const perfiles  = require("./config/perfiles");
const { CRITICIDAD, ESTADOS } = require("./config/estados");

const LOG = cds.log("ReasignacionService");

/**
 * Vida del snapshot de tareas en curso (ver _tareasEnCurso).
 * 30 s es el compromiso entre no repetir la tormenta de llamadas a BPA y que el
 * admin vea reflejado en menos de medio minuto lo que cambie por fuera de esta
 * app (una tarea completada, una reasignación hecha por otro administrador).
 */
const CACHE_TTL_MS = 30_000;

/** Traducción de negocio de los status crudos que devuelve BPA. */
const DESCRIPCION_ESTADO = {
  READY   : "Pendiente",
  RESERVED: "Reservada",
};

/**
 * Color semántico de la columna "Estado", por nivel de aprobación.
 *
 * Mismo criterio que la app de aprobaciones (ver config/estados.js): el color
 * separa los estados que CONVIVEN en la lista, que es donde hace trabajo.
 * Aquí conviven tareas de los tres roles a la vez, así que el color distingue
 * en qué punto del flujo está cada una:
 *
 *   azul  → en firma de apoderados, curso normal
 *   ámbar → en el liberador, último paso antes del desembolso
 *
 * No se colorea por status BPA (READY vs. RESERVED): esa distinción es técnica
 * —si el destinatario ya abrió la tarea o no— y no cambia lo que el admin
 * decide, que es a quién reasignarla.
 *
 * Se indexa por la CLAVE del rol y no por su label, y el mapa label→color se
 * deriva de ROLES_BPA: así renombrar un label en config/perfiles.js no deja
 * estados sin color en silencio.
 */
const CRITICIDAD_POR_ROL = {
  apoderado  : CRITICIDAD.INFORMATION,
  liberador  : CRITICIDAD.CRITICAL,
  coordinador: CRITICIDAD.INFORMATION,
};

const CRITICIDAD_POR_LABEL = Object.fromEntries(
  Object.entries(perfiles.ROLES_BPA)
    .filter(([clave]) => clave in CRITICIDAD_POR_ROL)
    .map(([clave, rol]) => [rol.label, CRITICIDAD_POR_ROL[clave]])
);

/**
 * Los roles del flujo, en el orden en que firman.
 *
 * `nivel` es la coordenada del diagrama: los apoderados ocupan el nivel 2 y el
 * liberador el 3. Coincide con NIVEL_POR_ROL de domain/historial.service.js —
 * es el mismo flujo visto desde las dos apps.
 *
 * DESDE BPA v1.2.0 SON DOS ENTRADAS, NO TRES. Los apoderados dejaron de ser dos
 * roles con un usuario cada uno para ser UN rol con una lista de N usuarios
 * equivalentes y quórum de dos firmas (ver config/perfiles.js). Por eso el rol
 * de apoderado se marca `esPool`: cada uno de sus miembros produce su propia
 * fila de firmante, mientras que el liberador produce siempre una sola.
 *
 * `label` y `campoPropuesta` NO se repiten aquí: salen de config/perfiles.js,
 * que es la fuente de verdad. `campoPropuesta` es justo lo que hace posible
 * mostrar un firmante SIN tarea viva — es el campo del contexto BPA donde
 * Payroll dejó su correo (o su lista) al arrancar el flujo.
 */
const ROLES_FLUJO = [
  { clave: "apoderado", nivel: 2 },
  { clave: "liberador", nivel: 3 },
].map(entrada => {
  const rol = perfiles.ROLES_BPA[entrada.clave];
  return {
    ...entrada,
    label         : rol.label,
    campoPropuesta: rol.campoPropuesta,
    codigoLane    : rol.codigoLane,
    esPool        : Boolean(rol.esPool),
  };
});

/**
 * Estados de un firmante SIN tarea viva sobre la que actuar.
 *
 * Para el liberador se deduce de la posición: si su nivel ya está alcanzado por
 * el flujo —es decir, no es posterior al nivel más bajo que todavía tiene
 * tarea— entonces le tocó y no tiene tarea, luego firmó. Si es posterior, aún no
 * le ha llegado el turno.
 *
 * Para los apoderados NO hace falta deducir nada desde v1.2.0: BPA lleva la
 * cuenta en context.custom.apoderadosfirmantes, así que se sabe con exactitud
 * quién firmó y quién sigue pendiente.
 *
 * El motivo se muestra en la columna "Observación" y en el tooltip del botón
 * inactivo — que el administrador entienda POR QUÉ no puede reasignar es la
 * mitad del trabajo de esta pantalla.
 */
const ESTADO_SIN_TAREA = {
  FIRMADO: {
    texto     : "Firmado",
    criticidad: CRITICIDAD.POSITIVE,
    motivo    : "Ya firmó: su firma está registrada y no puede reasignarse.",
  },
  NO_INICIADO: {
    texto     : "No iniciado",
    criticidad: CRITICIDAD.NEUTRAL,
    motivo    : "Su tarea aún no existe en BPA: el flujo todavía no ha llegado a este paso.",
  },
  // Exclusivo del pool: apoderado que nunca llegó a firmar porque el quórum se
  // alcanzó sin él. No es "no iniciado" —el paso sí ocurrió— ni "firmado".
  NO_REQUERIDO: {
    texto     : "No requerido",
    criticidad: CRITICIDAD.NEUTRAL,
    motivo    : "El quórum se alcanzó sin su firma: no queda tarea que reasignar.",
  },
};

/** Snapshot compartido por el List Report y sus value helps. Ver _tareasEnCurso. */
let _snapshot = { expira: 0, tareas: [] };

// ═══════════════════════════════════════════════════════════════════════════════
// CLASE PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════

class ReasignacionService extends cds.ApplicationService {

  /**
   * Descubre y registra todos los métodos estáticos con prefijo "handle_".
   */
  init() {
    const handlers = Object.getOwnPropertyNames(ReasignacionService)
      .filter(name => name.startsWith("handle_"));

    for (const handler of handlers) {
      ReasignacionService[handler].call(this);
    }

    LOG.info(`ReasignacionService iniciado | handlers: ${handlers.join(", ")}`);
    return super.init();
  }

  // ─── PROPUESTAS EN CURSO (raíz de la aplicación) ─────────────────────────

  static handle_propuestas() {
    /**
     * GET /nomina/reasignacion/PropuestasEnCurso
     * Sin clave  → List Report: una fila por propuesta con tareas vivas.
     * Con clave  → Object Page: la propuesta con sus firmantes y su diagrama.
     */
    this.on("READ", "PropuestasEnCurso", async (req) => {
      const propuestaID = _clavePeticion(req, "propuestaID");
      const propuestas  = await _propuestasEnCurso();

      if (propuestaID) {
        const propuesta = propuestas.find(p => p.propuestaID === propuestaID);
        // La propuesta pudo completarse entre que se pintó la lista y el usuario
        // abrió la fila: un 404 es más honesto que un Object Page vacío.
        if (!propuesta) return req.reject(404, `La propuesta ${propuestaID} ya no tiene tareas en curso`);
        return propuesta;
      }

      return odata.aplicarConsulta(propuestas, _conFiltroMultivalor(req));
    });

    /**
     * GET /nomina/reasignacion/PropuestasEnCurso('{id}')/{firmantes|niveles|aprobadores}
     *
     * Fiori Elements pide las composiciones por separado cuando no las expande.
     * Las tres salen del mismo cálculo que la propuesta, así que se resuelven
     * localizándola y devolviendo la colección que toque.
     */
    const composicion = (entidad, campo) => {
      this.on("READ", entidad, async (req) => {
        const propuestaID = _clavePeticion(req, "propuestaID");
        if (!propuestaID) return [];

        const propuestas = await _propuestasEnCurso();
        const propuesta  = propuestas.find(p => p.propuestaID === propuestaID);
        return odata.aplicarConsulta(propuesta?.[campo] ?? [], req);
      });
    };

    composicion("Firmante"  , "firmantes");
    composicion("NivelFlujo", "niveles");
    composicion("NodoFlujo" , "aprobadores");
  }

  // ─── TAREAS EN CURSO (todos los usuarios) ────────────────────────────────

  static handle_tareas() {
    /**
     * GET /nomina/reasignacion/TareasEnCurso
     * Lista las tareas en curso (READY/RESERVED) de los 3 roles activos
     * (Apoderado1, Apoderado2, Liberador Final), de todos los usuarios.
     */
    this.on("READ", "TareasEnCurso", async (req) => {
      const tareas = await _tareasEnCurso();
      // La barra de filtros de esta app (sociedad, rol, usuario, estado) es su
      // razón de ser: el admin la usa para ubicar las tareas de una persona.
      // BPA no filtra por estos campos, así que el $filter/$search/$orderby se
      // resuelven aquí. Ver infrastructure/odata-memoria.js.
      return odata.aplicarConsulta(tareas, req);
    });
  }

  // ─── VALUE HELPS DE LA BARRA DE FILTROS ──────────────────────────────────

  /**
   * GET /nomina/reasignacion/{Sociedades|Usuarios|Roles|Estados}
   *
   * Alimentan las ayudas de búsqueda (F4) de los cuatro filtros. Los cuatro
   * pasan por odata.aplicarConsulta porque el diálogo de value help envía sus
   * propios $filter / $search / $top / $count al teclear.
   *
   * Sociedades y Usuarios se derivan del MISMO snapshot que la lista: el
   * desplegable ofrece exactamente los valores que hoy devuelven filas, nunca
   * un código de sociedad que ya no tiene tareas en curso.
   */
  static handle_ayudas() {
    this.on("READ", "Sociedades", async (req) => {
      const valores = _distintos(await _tareasEnCurso(), "sociedad");
      return odata.aplicarConsulta(valores.map(sociedad => ({ sociedad })), req);
    });

    // Todos los destinatarios de tareas vivas, no solo el primero de cada una:
    // la tarea de apoderado tiene un pool y ofrecer únicamente a su primer
    // miembro dejaría fuera del desplegable a los demás, que son exactamente
    // las personas a las que el admin necesita llegar.
    this.on("READ", "Usuarios", async (req) => {
      const valores = _destinatariosVivos(await _tareasEnCurso());
      return odata.aplicarConsulta(valores.map(usuarioActual => ({ usuarioActual })), req);
    });

    // Roles es dominio cerrado: no depende de las tareas, así que no toca BPA.
    // La fuente de verdad es config/perfiles.js — el mismo `label` que
    // _mapearTarea() escribe en la columna Rol, para que el valor elegido en
    // el filtro case exactamente con el de la fila.
    this.on("READ", "Roles", (req) => {
      const roles = Object.values(perfiles.ROLES_BPA)
        .filter(rol => rol.activo)
        .map(rol => ({ rolTarea: rol.label }));
      return odata.aplicarConsulta(roles, req);
    });

    // Estados ofrece los estados de PROPUESTA, que es lo que se filtra en la
    // lista — no los de tarea (estadoNivel), que son un cruce status × rol.
    // Solo se ofrecen los que hoy tienen alguna propuesta detrás.
    this.on("READ", "Estados", async (req) => {
      const valores = _distintos(await _propuestasEnCurso(), "estadoPropuesta");
      return odata.aplicarConsulta(valores.map(estadoPropuesta => ({ estadoPropuesta })), req);
    });
  }

  // ─── ACCIÓN BOUND DE REASIGNACIÓN ────────────────────────────────────────

  static handle_reasignar() {
    /**
     * Registra el handler de la acción bound reasignar(nuevoUsuario).
     * La lógica vive en domain/reasignacion.service.js para separación de
     * capas, igual que aprobacion.service.js en PagosService.
     *
     * Se le inyecta el resolutor del firmante porque la agrupación de tareas en
     * propuestas es responsabilidad de este módulo, no de la capa de dominio.
     */
    reasigSvc.registrarHandlers(this, { buscarFirmante: _buscarFirmante });

    // Una reasignación cambia el destinatario de un firmante: invalidar el
    // snapshot hace que el refresco que Fiori Elements dispara justo después
    // traiga ya el usuario nuevo, en vez de repetir el anterior hasta que
    // venza el TTL.
    this.after("reasignar", "Firmante", () => {
      _invalidarSnapshot();
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNCIONES PRIVADAS DEL MÓDULO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Devuelve las tareas en curso, reusando el último resultado durante
 * CACHE_TTL_MS.
 *
 * POR QUÉ HAY CACHÉ AQUÍ Y NO EN TareasInbox
 * ------------------------------------------
 * Armar esta lista cuesta un readContext de BPA POR TAREA (en el entorno actual,
 * del orden de 150 peticiones HTTP). Sin caché eso se repetía en cada pulsación
 * de "Ir", en cada scroll de la tabla y —desde que existen los value helps— cada
 * vez que se abre un desplegable de la barra de filtros, porque el filtrado vive
 * en memoria y obliga a traer la lista entera antes de recortarla.
 *
 * Es seguro compartir el snapshot entre peticiones porque, a diferencia del
 * inbox de PagosService, TareasEnCurso NO depende del usuario autenticado: es la
 * misma lista de tareas de todos los usuarios para cualquier administrador. No
 * hay dato de un usuario que pueda filtrarse al de otro.
 */
async function _tareasEnCurso() {
  if (Date.now() < _snapshot.expira) return _snapshot.tareas;

  const tareas = await _obtenerTareasEnCurso();
  _snapshot = { expira: Date.now() + CACHE_TTL_MS, tareas };
  return tareas;
}

/** Fuerza que la próxima lectura vuelva a consultar BPA. */
function _invalidarSnapshot() {
  _snapshot = { expira: 0, tareas: [] };
}

/**
 * Lee una clave de la petición, venga como parámetro de ruta o dentro del where
 * que CAP arma para una composición.
 *
 * Las dos formas ocurren de verdad: el Object Page llega como
 * PropuestasEnCurso('id') —parámetro— mientras que
 * PropuestasEnCurso('id')/firmantes llega con la clave del padre en el `where`
 * del `from`. Mismo criterio que _extraerInstanceID en pagos-service.js.
 */
function _clavePeticion(req, campo) {
  const parametros = req.params ?? [];
  for (const parametro of parametros) {
    if (parametro && typeof parametro === "object" && parametro[campo]) return parametro[campo];
    if (typeof parametro === "string" && parametros.length === 1) return parametro;
  }

  return req.query?.SELECT?.from?.ref?.[0]?.where?.find?.(
    condicion => condicion?.ref?.[0] === campo
  )?.val ?? null;
}

/**
 * Valores distintos y no vacíos de un campo, ordenados alfabéticamente.
 * Es lo que espera un desplegable de ayuda de búsqueda: sin repetidos, sin
 * huecos y en un orden estable donde el admin pueda buscar con la vista.
 */
function _distintos(filas, campo) {
  const valores = new Set(
    filas
      .map(fila => String(fila?.[campo] ?? "").trim())
      .filter(valor => valor !== "")
  );
  return Array.from(valores).sort((a, b) => a.localeCompare(b, "es"));
}

/**
 * Formatea el importe con el símbolo de su moneda según la convención peruana:
 * "S/ 43,038.69" para PEN, "US$ 1,500.00" para USD.
 *
 * `importe` llega como texto desde el contexto BPA (nunca como número). Si no es
 * convertible se devuelve el valor original: es preferible mostrar el dato crudo
 * antes que un "S/ NaN".
 *
 * Duplicado a propósito de _formatearImporte en pagos-service.js, por la misma
 * razón que _extraerPropuesta más abajo: cada servicio mantiene sus helpers
 * privados de mapeo en vez de acoplarse al otro.
 */
function _formatearImporte(importe, moneda) {
  if (importe === null || importe === undefined || String(importe).trim() === "") return "";

  const valor = Number(String(importe).trim());
  if (!Number.isFinite(valor)) return String(importe);

  const codigo = String(moneda ?? "").trim().toUpperCase() || "PEN";

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
 * Combina el status de BPA con el nivel de aprobación en una sola frase de
 * negocio — "Pendiente - Apoderado 1", "Reservada - Liberador Final" — en vez
 * del literal técnico "READY" / "RESERVED" a secas, que no dice en qué punto
 * del flujo está la tarea.
 *
 * Si el status no está en DESCRIPCION_ESTADO se devuelve tal cual: preferible
 * mostrar el código crudo de BPA a ocultar la fila por un valor no mapeado.
 */
function _formatearEstadoNivel(estadoTarea, rolTarea) {
  const descripcion = DESCRIPCION_ESTADO[estadoTarea] ?? estadoTarea ?? "";
  return rolTarea ? `${descripcion} - ${rolTarea}` : descripcion;
}

/**
 * Clave de negocio de la propuesta, usada para AGRUPAR la lista.
 *
 * Deliberadamente NO se agrupa por workflowInstanceId: los apoderados corren en
 * el subproceso de Apoderados y el liberador en el proceso raíz (ver contextPath
 * en config/perfiles.js), así que sus instancias de workflow no tienen por qué
 * coincidir. La propuesta sí es la misma de punta a punta.
 *
 * Los tres campos hacen falta: numeroPropuesta se repite entre sociedades, y la
 * misma sociedad puede reemitir un número en otra fecha de pago — es la misma
 * terna que identifica la propuesta en el PDF (ver PropuestaPDF en
 * pagos-service.js).
 *
 * El texto es a la vez la etiqueta de la cabecera del grupo, así que se compone
 * para leerse: "0031 · 3127 · 2026-08-07".
 */
function _clavePropuesta(tarea) {
  const partes = [tarea.sociedad, tarea.numeroPropuesta, tarea.fechaPropuestaPago]
    .map(parte => String(parte ?? "").trim())
    .filter(parte => parte !== "");

  // Sin ninguna de las tres no hay propuesta que agrupar: cada tarea va a su
  // propio grupo en vez de caer todas juntas en un cajón vacío.
  return partes.length ? partes.join(" · ") : `(sin propuesta) ${tarea.instanceID}`;
}

/**
 * La misma clave, en formato seguro para una URL: '0031~3127~2026-08-07'.
 *
 * Es el key de PropuestasEnCurso, así que viaja en la ruta del Object Page. El
 * separador ' · ' de grupoPropuesta no sirve ahí: obligaría a escapar espacios y
 * un carácter no ASCII en cada navegación. '~' no aparece en ninguno de los tres
 * campos (código numérico, número de propuesta y fecha), así que la partición es
 * reversible y no hay nada que escapar.
 */
function _idPropuesta(tarea) {
  const partes = [tarea.sociedad, tarea.numeroPropuesta, tarea.fechaPropuestaPago]
    .map(parte => String(parte ?? "").trim())
    .filter(parte => parte !== "");

  return partes.length ? partes.join("~") : `sin-propuesta~${tarea.instanceID}`;
}

/** Añade la clave de agrupación a una tarea del List Report. */
function _conClavePropuesta(tarea) {
  return {
    ...tarea,
    grupoPropuesta: _clavePropuesta(tarea),
    propuestaID   : _idPropuesta(tarea),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPUESTAS — la unidad de trabajo del administrador
//
// Todo lo de aquí abajo se deriva del MISMO snapshot de tareas: agrupar no cuesta
// ni una llamada más a BPA, porque el contexto de cada tarea ya se leyó al
// construirla (ver _mapearTarea).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Agrupa las tareas vivas en propuestas, con sus firmantes y su diagrama.
 * @returns {Promise<object[]>} una fila por propuesta con al menos una tarea viva
 */
async function _propuestasEnCurso() {
  const tareas = await _tareasEnCurso();

  const porPropuesta = new Map();
  for (const tarea of tareas) {
    const id = tarea.propuestaID;
    if (!porPropuesta.has(id)) porPropuesta.set(id, []);
    porPropuesta.get(id).push(tarea);
  }

  return Array.from(porPropuesta, ([propuestaID, suyas]) =>
    _construirPropuesta(propuestaID, suyas));
}

/**
 * Ensambla una propuesta a partir de sus tareas vivas.
 *
 * `referencia` es cualquiera de ellas: los datos de negocio (sociedad, importe,
 * banco, los tres firmantes del contexto) son de la PROPUESTA, así que todas las
 * tareas del grupo los traen idénticos.
 */
function _construirPropuesta(propuestaID, tareas) {
  const referencia  = tareas[0];
  const tareaPorRol = new Map(tareas.map(tarea => [tarea.rolTarea, tarea]));

  // Nivel más bajo que todavía tiene tarea: la frontera entre lo ya firmado y lo
  // que falta. Sin ninguna tarea viva no habría propuesta en esta lista, pero el
  // Infinity deja la función total: todos los roles saldrían como "Firmado".
  const nivelesVivos = ROLES_FLUJO
    .filter(rol => tareaPorRol.has(rol.label))
    .map(rol => rol.nivel);
  const nivelMinVivo = nivelesVivos.length ? Math.min(...nivelesVivos) : Number.POSITIVE_INFINITY;

  // flatMap y no map: el rol de apoderado es un POOL y produce una fila por
  // miembro de la lista, no una sola. Cada fila es una persona con su propio
  // estado —firmó o no— y su propio botón de reasignar.
  const firmantes = ROLES_FLUJO.flatMap(rol =>
    _construirFirmantes(propuestaID, rol, tareaPorRol.get(rol.label), referencia, nivelMinVivo));

  const estado = _estadoPropuesta(nivelesVivos);
  const flujo  = _construirFlujo(propuestaID, referencia, firmantes);

  return {
    propuestaID,
    grupoPropuesta    : referencia.grupoPropuesta,
    sociedad          : referencia.sociedad,
    numeroPropuesta   : referencia.numeroPropuesta,
    fechaPropuestaPago: referencia.fechaPropuestaPago,
    fechaPago         : referencia.fechaPago,
    tituloTarea       : referencia.tituloTarea,
    banco             : referencia.banco,
    importe           : referencia.importe,
    moneda            : referencia.moneda,
    importeTexto      : referencia.importeTexto,
    estadoPropuesta   : estado.texto,
    estadoCriticidad  : estado.criticidad,

    // Solo los destinatarios de tareas VIVAS: es sobre quienes se puede actuar,
    // y es lo que el filtro "Destinatario" tiene que poder encontrar. Con el
    // pool de apoderados una sola tarea aporta varios, así que se aplanan las
    // listas en vez de tomar un destinatario por tarea.
    destinatarios     : _destinatariosVivos(tareas).join(", "),
    tareasPendientes  : tareas.length,

    // Estado del quórum de la propuesta, para la cabecera del Object Page:
    // dice si falta una firma o las dos sin tener que contar filas.
    contadorFirmas    : referencia.contadorFirmas ?? 0,
    firmasRequeridas  : referencia.firmasRequeridas ?? 0,
    firmasTexto       : referencia.firmasRequeridas
      ? `${referencia.contadorFirmas ?? 0} de ${referencia.firmasRequeridas} firmas`
      : "",

    firmantes,
    niveles           : flujo.niveles,
    aprobadores       : flujo.aprobadores,
  };
}

/** Campos de PropuestasEnCurso que contienen VARIOS valores en un solo texto. */
const CAMPOS_MULTIVALOR = new Set(["destinatarios"]);

/**
 * Reescribe la igualdad sobre un campo multivalor como "está entre".
 *
 * `destinatarios` junta en una cadena a todas las personas con tarea viva en la
 * propuesta ("arodas@x, jgonzales@x"). El value help del filtro entrega UN
 * correo y Fiori Elements genera `destinatarios eq 'jgonzales@x'`, que contra esa
 * cadena no casa nunca: la propuesta con dos apoderados pendientes desaparecería
 * justo al filtrar por uno de ellos.
 *
 * Se traduce a `contains(destinatarios, 'jgonzales@x')`, que es lo que el usuario
 * quiere decir al elegir a alguien en ese filtro. Los correos son suficientemente
 * distintivos como para que la coincidencia parcial no produzca falsos positivos.
 *
 * No se muta req.query: se devuelve un objeto con la misma forma que
 * odata.aplicarConsulta espera leer, para no tocar el request de CAP.
 */
function _conFiltroMultivalor(req) {
  const select = req?.query?.SELECT;
  if (!Array.isArray(select?.where)) return req;

  let cambiado = false;
  const where = [];

  for (let i = 0; i < select.where.length; i++) {
    const campo    = select.where[i]?.ref?.[0];
    const operador = select.where[i + 1];
    const valor    = select.where[i + 2];

    if (CAMPOS_MULTIVALOR.has(campo) && operador === "=" && valor?.val !== undefined) {
      where.push({ func: "contains", args: [{ ref: [campo] }, { val: valor.val }] });
      i += 2;
      cambiado = true;
      continue;
    }

    where.push(select.where[i]);
  }

  return cambiado ? { query: { SELECT: { ...select, where } } } : req;
}

/**
 * Localiza un firmante por la clave de su acción.
 *
 * La clave es `firmanteID` y no el rol: desde el quórum de v1.2.0 un mismo rol
 * puede tener varias personas a la vez, así que el rol dejó de identificar una
 * fila. Ver _construirFirmantes.
 *
 * Se inyecta en domain/reasignacion.service.js, que es quien decide si se puede
 * reasignar y ejecuta la llamada a BPA.
 */
async function _buscarFirmante(propuestaID, firmanteID) {
  const propuestas = await _propuestasEnCurso();
  return propuestas
    .find(propuesta => propuesta.propuestaID === propuestaID)
    ?.firmantes.find(firmante => firmante.firmanteID === firmanteID);
}

/**
 * Las filas de firmante que produce un rol del flujo.
 *
 * Devuelve un array porque el rol de apoderado es un POOL: cada miembro de la
 * lista es una persona distinta, con su propio estado y su propio botón. El
 * liberador devuelve siempre una sola fila.
 */
function _construirFirmantes(propuestaID, rol, tarea, referencia, nivelMinVivo) {
  if (!rol.esPool) {
    return [_construirFirmanteUnico(propuestaID, rol, tarea, referencia, nivelMinVivo)];
  }

  // La lista completa: los que ya firmaron y los que aún pueden hacerlo. Se
  // toma del contexto BPA (custom.*) y no de los destinatarios de la tarea,
  // porque los que ya firmaron desaparecen de estos últimos y el admin necesita
  // verlos igualmente para entender por qué la propuesta sigue abierta.
  const firmantes  = referencia.poolFirmantes  ?? [];
  const pendientes = referencia.poolPendientes ?? [];
  const todos      = [...firmantes, ...pendientes.filter(correo => !firmantes.includes(correo))];

  // Sin tarea viva de apoderado el paso ya pasó: nadie de la lista es accionable.
  const enTarea = tarea ? (tarea.destinatariosTarea ?? []) : [];

  return todos.map(correo => {
    const yaFirmo    = firmantes.includes(correo);
    const tieneTarea = Boolean(tarea) && enTarea.includes(correo);

    const base = {
      propuestaID,
      // Clave única de la fila. El rol por sí solo dejó de identificarla en
      // cuanto un rol pasó a tener N personas; el correo es lo que distingue a
      // un apoderado de otro y lo que el handler necesita para saber A QUIÉN
      // está sustituyendo dentro del pool.
      firmanteID      : `${rol.clave}#${correo}`,
      rol             : rol.label,
      nivel           : rol.nivel,
      usuario         : correo,
      contadorFirmas  : referencia.contadorFirmas ?? 0,
      firmasRequeridas: referencia.firmasRequeridas ?? 0,
    };

    if (tieneTarea) {
      return {
        ...base,
        estadoFirmante     : DESCRIPCION_ESTADO[tarea.estadoTarea] ?? tarea.estadoTarea ?? "Pendiente",
        estadoCriticidad   : CRITICIDAD_POR_LABEL[rol.label] ?? CRITICIDAD.NEUTRAL,
        instanceID         : tarea.instanceID,
        estadoTarea        : tarea.estadoTarea,
        reasignable        : true,
        motivoNoReasignable: "",
      };
    }

    // Sin acción posible por una de dos razones: ya firmó, o está en la lista
    // pero no entre los destinatarios de la tarea — porque el quórum se cerró
    // sin él, o porque otro administrador ya lo sustituyó. "No iniciado" sería
    // engañoso: el paso de apoderados sí llegó a ocurrir.
    const estado = yaFirmo ? ESTADO_SIN_TAREA.FIRMADO : ESTADO_SIN_TAREA.NO_REQUERIDO;

    return {
      ...base,
      estadoFirmante     : estado.texto,
      estadoCriticidad   : estado.criticidad,
      instanceID         : "",
      estadoTarea        : "",
      reasignable        : false,
      motivoNoReasignable: estado.motivo,
    };
  });
}

/** Un rol de un solo destinatario (liberador), con o sin tarea viva detrás. */
function _construirFirmanteUnico(propuestaID, rol, tarea, referencia, nivelMinVivo) {
  const base = {
    propuestaID,
    firmanteID      : rol.clave,
    rol             : rol.label,
    nivel           : rol.nivel,
    contadorFirmas  : 0,
    firmasRequeridas: 0,
  };

  if (tarea) {
    return {
      ...base,
      // Con tarea viva manda el destinatario de BPA y no el del contexto: si ya
      // se reasignó antes, el contexto sigue con el firmante original.
      usuario            : tarea.usuarioActual,
      estadoFirmante     : DESCRIPCION_ESTADO[tarea.estadoTarea] ?? tarea.estadoTarea ?? "Pendiente",
      estadoCriticidad   : CRITICIDAD_POR_LABEL[rol.label] ?? CRITICIDAD.NEUTRAL,
      instanceID         : tarea.instanceID,
      estadoTarea        : tarea.estadoTarea,
      reasignable        : true,
      motivoNoReasignable: "",
    };
  }

  // Si su nivel no es posterior al nivel más bajo que aún tiene tarea, es que
  // le tocó y ya no la tiene: firmó. Si es posterior, aún no le ha llegado.
  const estado = rol.nivel <= nivelMinVivo
    ? ESTADO_SIN_TAREA.FIRMADO
    : ESTADO_SIN_TAREA.NO_INICIADO;

  return {
    ...base,
    usuario            : referencia[rol.campoPropuesta] ?? "",
    estadoFirmante     : estado.texto,
    estadoCriticidad   : estado.criticidad,
    instanceID         : "",
    estadoTarea        : "",
    reasignable        : false,
    motivoNoReasignable: estado.motivo,
  };
}

/** Destinatarios distintos de todas las tareas vivas de una propuesta. */
function _destinatariosVivos(tareas) {
  const correos = tareas.flatMap(tarea => tarea.destinatariosTarea ?? []);
  return perfiles.normalizarUsuarios(correos)
    .sort((a, b) => a.localeCompare(b, "es"));
}

/**
 * Punto del flujo en el que está la propuesta, según qué niveles siguen vivos.
 *
 * Los textos salen de config/estados.js —la misma tabla que usa la app de
 * aprobaciones— y no de literales locales: son el valor que compara el $filter
 * del desplegable "Estado", así que una tilde de diferencia entre las dos apps
 * dejaría un filtro sin resultados.
 */
function _estadoPropuesta(nivelesVivos) {
  if (nivelesVivos.includes(3)) return ESTADOS.LIBERACION;
  if (nivelesVivos.includes(2)) return ESTADOS.APODERADOS;
  return ESTADOS.PENDIENTE;
}

/**
 * Construye lanes y nodes del ProcessFlow para una propuesta.
 *
 * Se reutiliza tal cual domain/historial.service.js — la misma función pura que
 * alimenta el diagrama del Object Page de aprobaciones — pasándole filas en su
 * formato crudo. Así los dos diagramas comparten estados, colores, iniciales y
 * topología, y cualquier arreglo en esa normalización llega a los dos.
 *
 * DIFERENCIA CON APROBACIONES: allí el historial se fusiona con las firmas que
 * ECP registra (iFlow HistorialAprobaciones), así que los nodos ya firmados
 * llevan firmante real y fecha. Aquí no se consulta a ECP: el estado se deduce
 * de las tareas BPA vivas de la propuesta — si la de un apoderado ya no está y
 * la del otro sigue, el primero firmó.
 *
 * Lo que NO tenemos por esa vía son fechas ni comentarios de los pasos ya
 * firmados: eso vive en Payroll. Los nodos firmados salen sin fecha y la UI lo
 * advierte. Si algún día se quiere la fecha real aquí, el camino es el mismo que
 * usa aprobaciones: cpi-client.getHistorialAprobaciones + _fusionar.
 */
function _construirFlujo(propuestaID, referencia, firmantes) {
  const filas = _filasFlujo(referencia, firmantes);
  const { niveles, aprobadores } = histSvc.construirDesdeFilas(filas, propuestaID);

  // construirDesdeFilas rotula la clave como `instanceID` porque en aprobaciones
  // es la tarea; aquí la clave es la propuesta. Se renombra al salir en vez de
  // parametrizar el módulo compartido, que no tiene por qué conocer a sus
  // consumidores.
  const aPropuesta = ({ instanceID, ...resto }) => ({ propuestaID, ...resto });

  return {
    niveles    : niveles.map(aPropuesta),
    aprobadores: aprobadores.map(aPropuesta),
  };
}

/**
 * Nombre para mostrar en la tarjeta del diagrama, a partir del correo.
 *
 * Se queda con la parte local ("arodas@centria.net" → "arodas") porque el nodo
 * del ProcessFlow en la columna media del FCL no da para más: con el correo
 * entero las tarjetas mostraban un recorte por el medio ("as@centri"), que no
 * identifica a nadie. El correo completo sigue estando en el tooltip del avatar,
 * que se enlaza a `usuario`.
 *
 * El nombre real de la persona no lo tenemos: vive en Payroll y llegaría con el
 * iFlow del historial (ver domain/historial.service.js).
 */
function _nombreCorto(correo) {
  return String(correo ?? "").split("@")[0] || String(correo ?? "");
}

/**
 * Filas crudas en el formato del iFlow que espera histSvc.construirDesdeFilas.
 *
 * Se recorren los FIRMANTES y no los roles: con el pool de apoderados hay una
 * tarjeta por persona de la lista, no una por rol, y `orden` tiene que ser
 * correlativo dentro del nivel para que el diagrama no apile dos nodos con el
 * mismo nodeId (el `N{nivel}-{orden}` que construye historial.service.js).
 */
function _filasFlujo(referencia, firmantes) {
  const filas = [];

  // Nivel 1 — el analista que registró la propuesta en Payroll. Solo se añade si
  // el contexto BPA lo trae: un nodo sin firmante lo descartaría la normalización
  // igualmente, y el diagrama arrancaría en el nivel 2 sin romperse.
  const analista = referencia.analista || referencia.usuarioCreacion || "";
  if (analista) {
    filas.push({
      Nivel: 1, Orden: 1,
      Usuario: analista,
      Nombre : _nombreCorto(analista),
      Cargo  : "Analista de Nómina",
      Perfil : "AN",
      Decision: "REGISTRADO",
    });
  }

  for (const rol of ROLES_FLUJO) {
    const delRol = firmantes.filter(f => f.rol === rol.label && f.usuario);
    delRol.forEach((firmante, indice) => {
      filas.push({
        Nivel  : rol.nivel,
        Orden  : indice + 1,
        Usuario: firmante.usuario,
        Nombre : _nombreCorto(firmante.usuario),
        Cargo  : rol.label,
        Perfil : rol.codigoLane,
        Decision: _decisionFlujo(firmante, rol),
        // Sin fecha ni comentario a propósito: de los pasos ya firmados solo
        // sabemos QUE ocurrieron, no cuándo ni con qué observación.
      });
    });
  }

  return filas;
}

/** Traduce el estado del firmante a la decisión que entiende el diagrama. */
function _decisionFlujo(firmante, rol) {
  if (firmante.reasignable) return "EN_CURSO";
  if (firmante.estadoFirmante === ESTADO_SIN_TAREA.FIRMADO.texto) {
    return rol.nivel === 3 ? "LIBERADO" : "APROBADO";
  }
  return "PENDIENTE";
}

/**
 * Color del estado a partir del rol de la tarea.
 * Un rol sin entrada en la tabla sale en gris en vez de sin pintar: es visible
 * como "no clasificado" pero no rompe la columna.
 */
function _criticidadEstado(rolTarea) {
  return CRITICIDAD_POR_LABEL[rolTarea] ?? CRITICIDAD.NEUTRAL;
}

/** Añade el estado combinado con nivel, y su color, a una tarea del List Report. */
function _conEstadoNivel(tarea) {
  return {
    ...tarea,
    estadoNivel     : _formatearEstadoNivel(tarea.estadoTarea, tarea.rolTarea),
    estadoCriticidad: _criticidadEstado(tarea.rolTarea),
  };
}

/**
 * Versión de texto de las listas del quórum, para las propiedades String de
 * TareasEnCurso.
 *
 * Las listas se manejan como arrays dentro del servicio porque hay que
 * filtrarlas y compararlas en cada paso, pero OData las expone como cadenas: la
 * entidad no declara colecciones y una propiedad String que recibiera un array
 * se serializaría mal. La conversión se hace una sola vez, al final de la
 * tubería, por el mismo motivo que el formato del importe.
 */
function _conListasTexto(tarea) {
  return {
    ...tarea,
    usuariosApoderados  : (tarea.poolApoderados ?? []).join(", "),
    apoderadosFirmantes : (tarea.poolFirmantes  ?? []).join(", "),
    apoderadosPendientes: (tarea.poolPendientes ?? []).join(", "),
    destinatarios       : (tarea.destinatariosTarea ?? []).join(", "),
    firmasTexto         : tarea.firmasRequeridas
      ? `${tarea.contadorFirmas ?? 0} de ${tarea.firmasRequeridas} firmas`
      : "",
  };
}

/**
 * Obtiene y enriquece la lista de tareas BPA en curso, filtrando solo las
 * que corresponden a un rol activo (apoderado1, apoderado2, liberador).
 * Si BPA no está disponible, cae a un mock local para desarrollo.
 */
async function _obtenerTareasEnCurso() {
  try {
    const tareasRaw = await bpa.listarTareasEnCurso();
    if (!tareasRaw.length) return [];

    const relevantes = tareasRaw
      .map(tarea => ({ tarea, rol: perfiles.resolverRolBpa(tarea.activityId ?? tarea.definitionId) }))
      .filter(({ rol }) => rol && rol.activo)
      // listarTareasEnCurso() combina READY + RESERVED (cada una ya ordenada
      // por BPA), pero al mezclarlas el orden global se pierde — se reordena
      // aquí por fecha de creación de la instancia, más reciente primero.
      .sort((a, b) => new Date(b.tarea.createdAt ?? 0) - new Date(a.tarea.createdAt ?? 0));

    const tareas = await Promise.all(relevantes.map(({ tarea, rol }) => _mapearTarea(tarea, rol)));
    // El formato de importe y estado se aplica en la salida —y no dentro de
    // cada rama— para que las tareas reales y las del mock se muestren igual.
    return tareas.map(_conImporteFormateado).map(_conEstadoNivel).map(_conListasTexto).map(_conClavePropuesta);

  } catch (error) {
    LOG.warn(`[_obtenerTareasEnCurso] BPA no disponible — usando mock | ${error.message}`);
    return _getMockTareasEnCurso().map(_conImporteFormateado).map(_conEstadoNivel).map(_conListasTexto).map(_conClavePropuesta);
  }
}

/**
 * Mapea una tarea BPA cruda + su rol resuelto al shape de TareasEnCurso.
 * El contexto BPA se lee solo para completar los campos de negocio
 * (título, importe, etc.); si falla, la fila igual se muestra con lo que
 * ya trae la lista de task-instances.
 */
async function _mapearTarea(tarea, rol) {
  let contexto  = null;
  let propuesta = {};
  try {
    contexto  = await bpa.readContext(tarea.id);
    propuesta = _extraerPropuesta(contexto);
  } catch (error) {
    LOG.warn(`[_mapearTarea] readContext falló | id=${tarea.id} | ${error.message}`);
  }

  // Estado del quórum. Solo tiene sentido en la tarea de apoderado, pero se
  // calcula siempre porque es barato y deja la fila homogénea.
  const quorum = perfiles.resolverQuorumApoderados(contexto, propuesta);

  // Destinatarios REALES de la tarea en BPA. Con el pool de apoderados son
  // varios; leerlos de recipientUsers y no del contexto es lo que hace que una
  // reasignación previa se vea reflejada. Si BPA no los devolviera, el pool
  // pendiente del contexto es el mejor respaldo disponible.
  const destinatarios = perfiles.normalizarUsuarios(tarea.recipientUsers);
  const enTarea = destinatarios.length
    ? destinatarios
    : (rol.esPool ? quorum.pendientes : perfiles.normalizarUsuarios(propuesta[rol.campoPropuesta]));

  return {
    instanceID         : tarea.id,
    tituloTarea        : tarea.subject ?? propuesta.tituloTarea ?? "",
    numeroPropuesta    : propuesta.numeroPropuesta ?? "",
    sociedad           : propuesta.sociedad ?? "",
    banco              : propuesta.banco ?? "",
    importe            : propuesta.importe ?? "",
    moneda             : propuesta.moneda ?? "",
    fechaPropuestaPago : propuesta.fechaPropuestaPago ?? "",
    fechaPago          : propuesta.fechaPago ?? "",
    rolTarea           : rol.label,

    // usuarioActual se conserva —la columna de TareasEnCurso y su ayuda de
    // búsqueda siguen siendo por persona— pero ya no es LA verdad: con pool hay
    // varios destinatarios y el que manda es `destinatariosTarea`.
    usuarioActual      : enTarea[0] ?? "",
    destinatariosTarea : enTarea,

    estadoTarea        : tarea.status ?? "",
    workflowInstanceId : tarea.workflowInstanceId ?? "",

    // Los firmantes de la propuesta según el contexto BPA. Van como ARRAYS y
    // con prefijo `pool` porque son de uso interno —de aquí salen las filas de
    // Firmante y los nodos del diagrama—; las versiones de texto que sí viajan
    // en TareasEnCurso las añade _conListasTexto al final de la tubería.
    poolApoderados     : quorum.originales,
    poolFirmantes      : quorum.firmantes,
    poolPendientes     : quorum.pendientes,
    contadorFirmas     : quorum.contador,
    firmasRequeridas   : quorum.requeridas,
    usuarioLiberador   : propuesta.usuarioLiberador ?? "",

    // Quién registró la propuesta en Payroll. No se muestra como columna: es el
    // primer nodo del diagrama de flujo (nivel 1, "Registrado"), el punto de
    // partida que explica de dónde viene la propuesta.
    analista           : propuesta.analista        ?? "",
    usuarioCreacion    : propuesta.usuarioCreacion ?? "",
  };
}

/**
 * Normaliza el contexto BPA a la propuesta de negocio.
 * Misma lógica que _extraerPropuesta en pagos-service.js — duplicada aquí
 * porque cada servicio mantiene sus helpers privados de mapeo.
 */
function _extraerPropuesta(contexto) {
  if (!contexto || typeof contexto !== "object") return {};
  const candidatos = [
    contexto?.startEvent?.propuesta,
    contexto?.startEvent?.body,
    contexto?.propuesta,
    contexto?.body,
  ];
  const propuesta = candidatos.find(c => c && typeof c === "object");
  return propuesta ?? contexto;
}

// ─── MOCK (desarrollo local sin BPA disponible) ──────────────────────────────

/**
 * Mock de tareas en curso para poder probar la app de reasignación sin BPA.
 * Cubre los dos roles activos y los dos momentos del quórum de apoderados.
 */
function _getMockTareasEnCurso() {
  const APODERADOS = [
    "arodas@centria.net",
    "jgonzales@centria.net",
    "mvargas@centria.net",
  ];

  /** Completa una fila del mock con la forma que produce _mapearTarea. */
  const tarea = ({ firmantes = [], ...fila }) => {
    const pendientes = APODERADOS.filter(correo => !firmantes.includes(correo));
    const esApoderado = fila.rolTarea === perfiles.ROLES_BPA.apoderado.label;
    return {
      poolApoderados      : APODERADOS,
      poolFirmantes       : firmantes,
      poolPendientes      : pendientes,
      contadorFirmas      : firmantes.length,
      firmasRequeridas    : 2,
      usuarioLiberador    : "cpanduro@centria.net",
      analista            : "mricanqui@centria.net",
      // Con pool, los destinatarios de la tarea son TODOS los pendientes; el
      // liberador tiene uno solo. Es lo que devuelve recipientUsers en BPA.
      destinatariosTarea  : esApoderado ? pendientes : ["cpanduro@centria.net"],
      usuarioActual       : esApoderado ? pendientes[0] : "cpanduro@centria.net",
      ...fila,
    };
  };

  return [
    // R4701 — quórum recién arrancado: una sola tarea viva, con los tres
    // apoderados de la lista como destinatarios. Es el caso que hace visible el
    // pool: tres filas de firmante colgando de una única tarea BPA.
    tarea({
      instanceID: "mock-task-101",
      tituloTarea: "0025-R4701-BCP-05/08/2026-A", numeroPropuesta: "R4701",
      sociedad: "0025", banco: "BCP", importe: "15200.50", moneda: "PEN",
      fechaPropuestaPago: "05-08-2026", fechaPago: "05-08-2026",
      rolTarea: "Apoderado",
      estadoTarea: "READY", workflowInstanceId: "wf-mock-101-apo",
      firmantes: [],
    }),
    // R4705 — una firma registrada y la tarea de vuelta por loop back para los
    // que faltan. El apoderado que ya firmó sale "Firmado" y sin botón, aunque
    // la tarea siga viva: el dato viene de custom.apoderadosfirmantes.
    tarea({
      instanceID: "mock-task-105",
      tituloTarea: "0025-R4705-BBVA-06/08/2026-A", numeroPropuesta: "R4705",
      sociedad: "0025", banco: "BBVA", importe: "77777.77", moneda: "PEN",
      fechaPropuestaPago: "06-08-2026", fechaPago: "06-08-2026",
      rolTarea: "Apoderado",
      estadoTarea: "READY", workflowInstanceId: "wf-mock-105-apo",
      firmantes: ["arodas@centria.net"],
    }),
    // R4703 — quórum alcanzado: el flujo pasó a liberación y la única tarea
    // viva está en el proceso raíz.
    tarea({
      instanceID: "mock-task-103",
      tituloTarea: "0025-R4703-BCP-07/08/2026-L", numeroPropuesta: "R4703",
      sociedad: "0025", banco: "BCP", importe: "43038.69", moneda: "PEN",
      fechaPropuestaPago: "07-08-2026", fechaPago: "07-08-2026",
      rolTarea: "Liberador Final",
      estadoTarea: "RESERVED", workflowInstanceId: "wf-mock-103-raiz",
      firmantes: ["arodas@centria.net", "jgonzales@centria.net"],
    }),
  ];
}

module.exports = { ReasignacionService };
