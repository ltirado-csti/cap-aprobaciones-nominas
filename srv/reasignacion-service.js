"use strict";
/**
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
 * La unidad de trabajo es la propuesta, no la tarea: el administrador abre una
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
const { grupoPersonal } = require("./config/grupos-personal");

const LOG = cds.log("ReasignacionService");

/** Vida del snapshot de tareas en curso (ver _tareasEnCurso). */
const CACHE_TTL_MS = 30_000;

/** Traducción de negocio de los status crudos que devuelve BPA. */
const DESCRIPCION_ESTADO = {
  READY   : "Pendiente",
  RESERVED: "Reservada",
};

/**
 * Color semántico de la columna "Estado", por nivel de aprobación (no por
 * status BPA READY/RESERVED, que es una distinción técnica sin efecto en la
 * decisión del admin). Indexado por la clave del rol; el mapa label→color se
 * deriva de ROLES_BPA.
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
 * `nivel` es la coordenada del diagrama de esta app (analista 1, apoderados 2,
 * liberador 3); no coincide con NIVEL_POR_ROL de historial.service.js, que
 * intercala el paso del coordinador.
 *
 * Los dos roles son pools: los apoderados por el quórum de dos firmas, el
 * liberador porque Payroll puede dejar varios correos en usuarioLiberador.
 * `campoPool`/`campoFirmados` dicen de qué campo de la tarea sale la lista de
 * cada rol — BPA lleva la cuenta del pool de apoderados (recalculado en cada
 * firma) pero no la del liberador. `campoFirmados: null` significa "de este
 * rol no hay firmas registradas" (ver _construirFirmantes y _sinTarea).
 * `label` y `campoPropuesta` salen de config/perfiles.js.
 */
const ROLES_FLUJO = [
  { clave: "apoderado", nivel: 2, campoPool: "poolPendientes", campoFirmados: "poolFirmantes" },
  { clave: "liberador", nivel: 3, campoPool: "poolLiberadores", campoFirmados: null },
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
 * Estados de un firmante sin tarea viva sobre la que actuar. Para el
 * liberador se deduce de la posición en el flujo (ver _sinTarea); para los
 * apoderados, BPA lleva la cuenta exacta de quién firmó. El motivo se
 * muestra en la columna "Observación" y en el tooltip del botón inactivo.
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
        return odata.aplicarConsulta(_filtrarPorClave(propuesta?.[campo] ?? [], req), req);
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
      // BPA no filtra por sociedad/rol/usuario/estado; se resuelve aquí (ver
      // infrastructure/odata-memoria.js).
      return odata.aplicarConsulta(tareas, req);
    });
  }

  // ─── VALUE HELPS DE LA BARRA DE FILTROS ──────────────────────────────────

  /**
   * GET /nomina/reasignacion/{Sociedades|Usuarios|Roles|Estados}
   * Alimentan las ayudas de búsqueda (F4) de los cuatro filtros. Sociedades y
   * Usuarios se derivan del mismo snapshot que la lista; Roles es dominio
   * cerrado (config/perfiles.js); Estados ofrece los de propuesta, no los de tarea.
   */
  static handle_ayudas() {
    this.on("READ", "Sociedades", async (req) => {
      const valores = _distintos(await _tareasEnCurso(), "sociedad");
      return odata.aplicarConsulta(valores.map(sociedad => ({ sociedad })), req);
    });

    // Todos los destinatarios de tareas vivas, no solo el primero de cada una
    // (la tarea de apoderado tiene un pool).
    this.on("READ", "Usuarios", async (req) => {
      const valores = _destinatariosVivos(await _tareasEnCurso());
      return odata.aplicarConsulta(valores.map(usuarioActual => ({ usuarioActual })), req);
    });

    this.on("READ", "Roles", (req) => {
      const roles = Object.values(perfiles.ROLES_BPA)
        .filter(rol => rol.activo)
        .map(rol => ({ rolTarea: rol.label }));
      return odata.aplicarConsulta(roles, req);
    });

    this.on("READ", "Estados", async (req) => {
      const valores = _distintos(await _propuestasEnCurso(), "estadoPropuesta");
      return odata.aplicarConsulta(valores.map(estadoPropuesta => ({ estadoPropuesta })), req);
    });
  }

  // ─── ACCIÓN BOUND DE REASIGNACIÓN ────────────────────────────────────────

  static handle_reasignar() {
    /**
     * Registra el handler de la acción bound reasignar(nuevoUsuario).
     * La lógica vive en domain/reasignacion.service.js; se inyecta el
     * resolutor del firmante porque la agrupación de tareas en propuestas es
     * responsabilidad de este módulo.
     */
    reasigSvc.registrarHandlers(this, { buscarFirmante: _buscarFirmante });

    // Invalida el snapshot para que el refresco posterior traiga ya el usuario nuevo.
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
 * CACHE_TTL_MS. Armar la lista cuesta un readContext de BPA por tarea; el
 * snapshot es seguro de compartir entre peticiones porque TareasEnCurso no
 * depende del usuario autenticado (misma lista para cualquier administrador).
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
 * Lee una clave de la petición, venga como parámetro de ruta o dentro del
 * where que CAP arma para una composición (mismo criterio que
 * _extraerInstanceID en pagos-service.js).
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
 * Recorta una composición a la fila concreta cuando la petición trae su
 * clave. Al pedir una fila, CAP deja la clave en el `where` del segmento de
 * navegación (from.ref[1].where), no en query.SELECT.where que es lo único
 * que mira odata.aplicarConsulta; sin este recorte se devolvía la colección
 * entera y CAP se quedaba con la primera fila. Filtra por los pares
 * clave/valor del último elemento de req.params, válido para Firmante
 * (firmanteID), NivelFlujo (laneId) y NodoFlujo (nodeId) sin conocer ninguna.
 */
function _filtrarPorClave(filas, req) {
  const claves = req.params?.[req.params.length - 1];
  if (!claves || typeof claves !== "object") return filas;

  const pares = Object.entries(claves);
  if (!pares.length) return filas;

  return filas.filter(fila =>
    pares.every(([campo, valor]) => String(fila?.[campo]) === String(valor)));
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
 * "S/ 43,038.69" para PEN, "US$ 1,500.00" para USD. Duplicado de
 * _formatearImporte en pagos-service.js: cada servicio mantiene sus propios
 * helpers de mapeo.
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
 * Pasa una fecha ISO del contexto BPA a dd/MM/yyyy.
 *
 * Se formatea en el servidor y no en la app porque estas fechas viajan como
 * String —son parte de la clave de negocio de la propuesta— y una propiedad
 * String no la formatea el cliente: llegaría "2026-08-07" a la pantalla,
 * mientras el aprobador ve "07/08/2026" para la misma propuesta en PagosService.
 *
 * Lo que no case con el patrón ISO se devuelve vacío en vez de a medias: un
 * formato inesperado de BPA se ve como un hueco, no como una fecha inventada.
 */
function _fechaDdMmAaaa(iso) {
  const partes = String(iso ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : "";
}

/** Añade las fechas ya formateadas a una tarea del List Report. */
function _conFechasFormateadas(tarea) {
  return {
    ...tarea,
    fechaPPTexto  : _fechaDdMmAaaa(tarea.fechaPropuestaPago),
    fechaPagoTexto: _fechaDdMmAaaa(tarea.fechaPago),
  };
}

/**
 * Combina el status de BPA con el nivel de aprobación en una frase de
 * negocio: "Pendiente - Apoderado 1", "Reservada - Liberador Final".
 */
function _formatearEstadoNivel(estadoTarea, rolTarea) {
  const descripcion = DESCRIPCION_ESTADO[estadoTarea] ?? estadoTarea ?? "";
  return rolTarea ? `${descripcion} - ${rolTarea}` : descripcion;
}

/**
 * Clave de negocio de la propuesta, usada para agrupar la lista (no por
 * workflowInstanceId: apoderados y liberador corren en procesos distintos).
 * Texto legible para la cabecera del grupo: "0031 · 3127 · 2026-08-07".
 */
function _clavePropuesta(tarea) {
  const partes = [tarea.sociedad, tarea.numeroPropuesta, tarea.fechaPropuestaPago]
    .map(parte => String(parte ?? "").trim())
    .filter(parte => parte !== "");

  return partes.length ? partes.join(" · ") : `(sin propuesta) ${tarea.instanceID}`;
}

/**
 * La misma clave, en formato seguro para URL: '0031~3127~2026-08-07' (key de
 * PropuestasEnCurso). '~' no aparece en ninguno de los tres campos.
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
// Se deriva del mismo snapshot de tareas (ver _mapearTarea); agrupar no
// cuesta una llamada más a BPA.
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

  // flatMap y no map: los dos roles son POOLES y producen una fila por miembro
  // de su lista, no una sola. Cada fila es una persona con su propio estado
  // —firmó o no— y su propio botón de reasignar.
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
    fechaPPTexto      : referencia.fechaPPTexto,
    fechaPagoTexto    : referencia.fechaPagoTexto,
    tituloTarea       : referencia.tituloTarea,
    banco             : referencia.banco,
    bancoDescripcion  : referencia.bancoDescripcion,
    grupoPersonal     : referencia.grupoPersonal,
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
 * Las filas de firmante que produce un rol del flujo. Devuelve un array
 * porque los dos roles activos son pools: cada miembro de la lista es una
 * persona distinta, con su propio estado y su propio botón.
 *
 * La lista de cada rol sale de `campoPool`/`campoFirmados` (ROLES_FLUJO),
 * que apuntan a lo que _mapearTarea dejó en la fila: apoderados usa
 * poolPendientes/poolFirmantes (recalculados por BPA en cada firma);
 * liberador usa poolLiberadores (la lista de la propuesta, sin firmados
 * porque una sola liberación cierra el paso).
 */
function _construirFirmantes(propuestaID, rol, tarea, referencia, nivelMinVivo) {
  const firmantes  = rol.campoFirmados ? (referencia[rol.campoFirmados] ?? []) : [];
  const pendientes = referencia[rol.campoPool] ?? [];
  const enTarea = tarea ? (tarea.destinatariosTarea ?? []) : [];

  // Las tres listas hacen falta: firmantes (ya firmaron), enTarea (los
  // destinatarios reales de la tarea en BPA, donde se refleja una
  // reasignación) y pendientes (los que el contexto da por pendientes y aún
  // no tienen tarea). normalizarUsuarios deduplica conservando el orden.
  const todos = perfiles.normalizarUsuarios([...firmantes, ...enTarea, ...pendientes]);

  // Sin nadie identificable se conserva una fila sin persona, para que la
  // tabla no pierda el nivel (propuesta sin usuarioLiberador, por ejemplo).
  const personas = todos.length ? todos : [""];

  return personas.map(correo => {
    const yaFirmo = firmantes.includes(correo);

    // Con la tarea del rol viva, todo el que no haya firmado puede
    // reasignarse, sin exigir que esté en enTarea (recipientUsers): esa lista
    // puede quedar desactualizada respecto al contexto, y es precisamente el
    // apoderado ausente de ella quien más necesita el botón.
    const tieneTarea = Boolean(tarea) && !yaFirmo;

    const base = {
      propuestaID,
      // '<rol>#<correo>': el rol dejó de identificar una fila con N personas.
      firmanteID      : correo ? `${rol.clave}#${correo}` : rol.clave,
      rol             : rol.label,
      nivel           : rol.nivel,
      usuario         : correo,
      // No está en la entidad, pero la acción reasignar la necesita para
      // escribir la variable del contexto de la que BPA saca destinatarios.
      workflowInstanceId: tarea?.workflowInstanceId ?? "",
      // Solo el pool con quórum tiene contadores; en el liberador van a cero.
      contadorFirmas  : rol.campoFirmados ? (referencia.contadorFirmas   ?? 0) : 0,
      firmasRequeridas: rol.campoFirmados ? (referencia.firmasRequeridas ?? 0) : 0,
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

    return {
      ...base,
      ..._sinTarea(rol, yaFirmo, nivelMinVivo),
      instanceID         : "",
      estadoTarea        : "",
      reasignable        : false,
    };
  });
}

/**
 * Estado de una fila cuyo rol NO tiene tarea viva. Se deduce distinto según
 * quién lleve la cuenta de las firmas, y por eso no vale una sola regla:
 *
 *   Con registro en BPA (apoderados) — se sabe con exactitud quién firmó:
 *     el que firmó sale "Firmado"; el que no, "No requerido", porque el quórum
 *     se cerró sin él o porque otro administrador ya lo sustituyó.
 *
 *   Sin registro (liberador) — hay que deducirlo de la POSICIÓN en el flujo: si
 *     su nivel no es posterior al nivel más bajo que aún tiene tarea, es que le
 *     tocó y ya no la tiene, luego firmó; si es posterior, aún no le ha llegado.
 *     Aplicarle la regla de los apoderados marcaría "No requerido" al liberador
 *     de una propuesta que todavía está en firma de apoderados.
 */
function _sinTarea(rol, yaFirmo, nivelMinVivo) {
  const estado = rol.campoFirmados
    ? (yaFirmo ? ESTADO_SIN_TAREA.FIRMADO : ESTADO_SIN_TAREA.NO_REQUERIDO)
    : (rol.nivel <= nivelMinVivo ? ESTADO_SIN_TAREA.FIRMADO : ESTADO_SIN_TAREA.NO_INICIADO);

  return {
    estadoFirmante     : estado.texto,
    estadoCriticidad   : estado.criticidad,
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
 * Punto del flujo en el que está la propuesta, según qué niveles siguen
 * vivos. Los textos salen de config/estados.js, la misma tabla que usa la
 * app de aprobaciones.
 */
function _estadoPropuesta(nivelesVivos) {
  if (nivelesVivos.includes(3)) return ESTADOS.LIBERACION;
  if (nivelesVivos.includes(2)) return ESTADOS.APODERADOS;
  return ESTADOS.PENDIENTE;
}

/**
 * Construye lanes y nodes del ProcessFlow para una propuesta, reutilizando
 * domain/historial.service.js. A diferencia de aprobaciones, aquí no se
 * consulta a ECP: el estado se deduce de las tareas BPA vivas, así que los
 * nodos firmados no llevan fecha ni comentario.
 */
function _construirFlujo(propuestaID, referencia, firmantes) {
  const filas = _filasFlujo(referencia, firmantes);
  const { niveles, aprobadores } = histSvc.construirDesdeFilas(filas, propuestaID);

  // construirDesdeFilas rotula la clave como `instanceID` (la tarea); aquí
  // la clave es la propuesta.
  const aPropuesta = ({ instanceID, ...resto }) => ({ propuestaID, ...resto });

  return {
    niveles    : niveles.map(aPropuesta),
    aprobadores: aprobadores.map(aPropuesta),
  };
}

/**
 * Nombre para mostrar en la tarjeta del diagrama: la parte local del correo
 * ("arodas@centria.net" → "arodas"). El correo completo sigue en el tooltip
 * del avatar, enlazado a `usuario`.
 */
function _nombreCorto(correo) {
  return String(correo ?? "").split("@")[0] || String(correo ?? "");
}

/**
 * Filas crudas en el formato del iFlow que espera histSvc.construirDesdeFilas.
 * Se recorren los firmantes, no los roles: con el pool de apoderados hay una
 * tarjeta por persona, y `orden` debe ser correlativo dentro del nivel.
 */
function _filasFlujo(referencia, firmantes) {
  const filas = [];

  // Nivel 1: el analista que registró la propuesta en Payroll.
  const analista = referencia.analista || referencia.usuarioCreacion || "";
  if (analista) {
    filas.push({
      Nivel: 1, Orden: 1,
      Usuario: analista,
      Nombre : _nombreCorto(analista),
      Cargo  : "Analista",
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

/** Versión de texto de las listas del quórum, para las propiedades String de TareasEnCurso. */
function _conListasTexto(tarea) {
  return {
    ...tarea,
    usuariosApoderados  : (tarea.poolApoderados  ?? []).join(", "),
    apoderadosFirmantes : (tarea.poolFirmantes   ?? []).join(", "),
    apoderadosPendientes: (tarea.poolPendientes  ?? []).join(", "),
    usuarioLiberador    : (tarea.poolLiberadores ?? []).join(", "),
    destinatarios       : (tarea.destinatariosTarea ?? []).join(", "),
    firmasTexto         : tarea.firmasRequeridas
      ? `${tarea.contadorFirmas ?? 0} de ${tarea.firmasRequeridas} firmas`
      : "",
  };
}

/**
 * Obtiene y enriquece la lista de tareas BPA en curso, filtrando solo las
 * que corresponden a un rol activo. Si BPA no está disponible, cae a un mock local.
 */
async function _obtenerTareasEnCurso() {
  try {
    const tareasRaw = await bpa.listarTareasEnCurso();
    if (!tareasRaw.length) return [];

    const relevantes = tareasRaw
      .map(tarea => ({ tarea, rol: perfiles.resolverRolBpa(tarea.activityId ?? tarea.definitionId) }))
      .filter(({ rol }) => rol && rol.activo)
      // Reordena por fecha de creación (más reciente primero): al combinar
      // READY + RESERVED, listarTareasEnCurso() pierde el orden global.
      .sort((a, b) => new Date(b.tarea.createdAt ?? 0) - new Date(a.tarea.createdAt ?? 0));

    const tareas = await Promise.all(relevantes.map(({ tarea, rol }) => _mapearTarea(tarea, rol)));
    return tareas.map(_conImporteFormateado).map(_conFechasFormateadas).map(_conEstadoNivel).map(_conListasTexto).map(_conClavePropuesta);

  } catch (error) {
    LOG.warn(`[_obtenerTareasEnCurso] BPA no disponible — usando mock | ${error.message}`);
    return _getMockTareasEnCurso().map(_conImporteFormateado).map(_conFechasFormateadas).map(_conEstadoNivel).map(_conListasTexto).map(_conClavePropuesta);
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

  // Estado del quórum; se calcula siempre aunque solo aplique a apoderado, para
  // que la fila sea homogénea.
  const quorum = perfiles.resolverQuorumApoderados(contexto, propuesta);

  // Lista de liberadores: dato de la propuesta, usado por las filas de
  // firmante del nivel 3 sin importar de qué rol venga esta tarea.
  const liberadores = perfiles.resolverDestinatarios(
    perfiles.ROLES_BPA.liberador, contexto, propuesta).pendientes;

  // Destinatarios reales de la tarea (recipientUsers): refleja una
  // reasignación previa. Sin ellos, se cae al pendientes del contexto.
  const destinatarios = perfiles.normalizarUsuarios(tarea.recipientUsers);
  const enTarea = destinatarios.length
    ? destinatarios
    : perfiles.resolverDestinatarios(rol, contexto, propuesta).pendientes;

  return {
    instanceID         : tarea.id,
    tituloTarea        : tarea.subject ?? propuesta.tituloTarea ?? "",
    numeroPropuesta    : propuesta.numeroPropuesta ?? "",
    sociedad           : propuesta.sociedad ?? "",
    banco              : propuesta.banco            ?? "",
    bancoDescripcion   : propuesta.bancoDescripcion ?? "",
    grupoPersonal      : grupoPersonal(propuesta.tipoTrabajador),
    importe            : propuesta.importe ?? "",
    moneda             : propuesta.moneda ?? "",
    fechaPropuestaPago : propuesta.fechaPropuestaPago ?? "",
    fechaPago          : propuesta.fechaPago ?? "",
    rolTarea           : rol.label,

    // Con pool hay varios destinatarios; el que manda es `destinatariosTarea`.
    usuarioActual      : enTarea[0] ?? "",
    destinatariosTarea : enTarea,

    estadoTarea        : tarea.status ?? "",
    workflowInstanceId : tarea.workflowInstanceId ?? "",

    // Uso interno (filas de Firmante y nodos del diagrama); las versiones de
    // texto las añade _conListasTexto.
    poolApoderados     : quorum.originales,
    poolFirmantes      : quorum.firmantes,
    poolPendientes     : quorum.pendientes,
    contadorFirmas     : quorum.contador,
    firmasRequeridas   : quorum.requeridas,
    poolLiberadores    : liberadores,

    // Quién registró la propuesta en Payroll: primer nodo del diagrama (nivel 1, "Registrado").
    analista           : propuesta.analista        ?? "",
    usuarioCreacion    : propuesta.usuarioCreacion ?? "",
  };
}

/**
 * Normaliza el contexto BPA a la propuesta de negocio. Misma lógica que
 * _extraerPropuesta en pagos-service.js, duplicada como helper privado.
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
 * Cubre los dos roles activos, los dos momentos del quórum de apoderados y
 * dos correos en usuarioLiberador. Fechas en ISO (yyyy-MM-dd), como entrega
 * BPA, parte de la clave de la propuesta.
 */
function _getMockTareasEnCurso() {
  const APODERADOS = [
    "arodas@centria.net",
    "jgonzales@centria.net",
    "mvargas@centria.net",
  ];

  // Ya normalizado, como lo deja _mapearTarea.
  const LIBERADORES = [
    "cpanduro@centria.net",
    "jlicetti@centria.net",
  ];

  /** Completa una fila del mock con la forma que produce _mapearTarea. */
  const tarea = ({ firmantes = [], ...fila }) => {
    const pendientes = APODERADOS.filter(correo => !firmantes.includes(correo));
    const esApoderado = fila.rolTarea === perfiles.ROLES_BPA.apoderado.label;
    const destinatarios = esApoderado ? pendientes : LIBERADORES;
    return {
      poolApoderados      : APODERADOS,
      poolFirmantes       : firmantes,
      poolPendientes      : pendientes,
      poolLiberadores     : LIBERADORES,
      contadorFirmas      : firmantes.length,
      firmasRequeridas    : 2,
      analista            : "mricanqui@centria.net",
      destinatariosTarea  : destinatarios,
      usuarioActual       : destinatarios[0],
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
      sociedad: "0025", banco: "BCP", bancoDescripcion: "001 - BCP Soles",
      grupoPersonal: grupoPersonal("E"),
      importe: "15200.50", moneda: "PEN",
      fechaPropuestaPago: "2026-08-05", fechaPago: "2026-08-05",
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
      sociedad: "0025", banco: "BBVA", bancoDescripcion: "011 - BBVA Soles",
      grupoPersonal: grupoPersonal("P"),
      importe: "77777.77", moneda: "PEN",
      fechaPropuestaPago: "2026-08-06", fechaPago: "2026-08-06",
      rolTarea: "Apoderado",
      estadoTarea: "READY", workflowInstanceId: "wf-mock-105-apo",
      firmantes: ["arodas@centria.net"],
    }),
    // R4703 — quórum alcanzado: el flujo pasó a liberación y la única tarea
    // viva está en el proceso raíz.
    tarea({
      instanceID: "mock-task-103",
      tituloTarea: "0025-R4703-BCP-07/08/2026-L", numeroPropuesta: "R4703",
      sociedad: "0025", banco: "BCP", bancoDescripcion: "001 - BCP Soles",
      grupoPersonal: grupoPersonal("E"),
      importe: "43038.69", moneda: "PEN",
      fechaPropuestaPago: "2026-08-07", fechaPago: "2026-08-07",
      rolTarea: "Liberador Final",
      estadoTarea: "RESERVED", workflowInstanceId: "wf-mock-103-raiz",
      firmantes: ["arodas@centria.net", "jgonzales@centria.net"],
    }),
  ];
}

module.exports = { ReasignacionService };
