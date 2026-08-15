"use strict";
/**
 * srv/infrastructure/odata-memoria.js
 *
 * Aplica en memoria la parte "de consulta" de una petición OData ($filter,
 * $search, $orderby, $top/$skip, $count) sobre un array ya construido.
 *
 * POR QUÉ EXISTE
 * --------------
 * TareasInbox y TareasEnCurso son @cds.persistence.skip: no hay tabla detrás,
 * los datos los arma un handler `.on("READ", ...)` a partir de BPA. Cuando un
 * handler `.on` devuelve un array, CAP lo entrega TAL CUAL al cliente: no le
 * aplica el where, el orderBy ni el limit de la consulta, porque el `.on`
 * REEMPLAZA por completo la implementación por defecto (la que, con una entidad
 * persistida, traduciría el CQN a SQL).
 *
 * Resultado antes de este módulo: la barra de filtros de Fiori Elements enviaba
 * su $filter, el servidor lo ignoraba y devolvía la lista entera. Lo mismo con
 * el campo de búsqueda, el ordenamiento por columna y la paginación.
 *
 * BPA no expone un endpoint para filtrar tareas por estos campos de negocio
 * (viven en el contexto de cada tarea, no en la lista de task-instances), así
 * que el filtrado tiene que ocurrir después de traer y enriquecer las tareas.
 * De ahí que sea en memoria y no delegado al origen.
 *
 * QUÉ SE INTERPRETA
 * -----------------
 * El CQN que CAP construye desde la URL OData, es decir req.query.SELECT:
 *
 *   where   : [{ref:['sociedad']}, '=', {val:'0025'}, 'and', {xpr:[...]}]
 *   search  : [{val:'R4615'}]
 *   orderBy : [{ref:['importe'], sort:'desc'}]
 *   limit   : {rows:{val:20}, offset:{val:40}}
 *
 * Cubre lo que la barra de filtros y la tabla del List Report generan:
 * comparaciones (= != < <= > >=), and/or/not con paréntesis (xpr), in, between,
 * is null, like y las funciones contains/startswith/endswith más las escalares
 * de texto habituales.
 *
 * DECISIONES DELIBERADAS
 * ----------------------
 * - El orderBy `implicit` NO se aplica. Fiori Elements añade siempre un
 *   `orderBy: [{ref:['instanceID'], implicit:true}]` para estabilizar su
 *   paginación. Obedecerlo ordenaría el inbox por el GUID de la tarea y
 *   destruiría el orden en que BPA entrega las tareas (el más reciente
 *   primero), que es el orden que el usuario espera ver por defecto. Solo se
 *   aplica el ordenamiento que el usuario pide explícitamente en una columna.
 *
 * - Las coincidencias de TEXTO PARCIAL (contains/startswith/endswith/like) y la
 *   búsqueda libre son case-insensitive, igual que se comportarían contra
 *   SQLite o HANA. La igualdad (`eq`) sí distingue mayúsculas, como manda OData.
 *
 * - Si evaluar el filtro falla, la fila SE CONSERVA y se registra un warning.
 *   En un inbox de aprobaciones ocultar tareas por un fallo del evaluador es
 *   peor que mostrar alguna de más: el usuario ve el dato y el log delata el
 *   problema, en vez de una pantalla vacía sin explicación.
 */

const cds = require("@sap/cds");

const LOG = cds.log("odata-memoria");

/** Operadores binarios que pueden aparecer entre dos operandos del CQN. */
const OPERADORES = new Set([
  "=", "==", "!=", "<>", "<", "<=", ">", ">=", "like", "in", "between", "is",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Aplica $filter, $search, $orderby y $top/$skip de la petición sobre las filas.
 *
 * Devuelve un array NUEVO con la propiedad `$count` fijada al total tras filtrar
 * y buscar pero ANTES de paginar — que es exactamente lo que OData espera en
 * `@odata.count` y lo que la tabla usa para su scroll.
 *
 * @param {object[]} filas - resultado ya construido por el handler
 * @param {object}   req   - request de CAP (se lee req.query.SELECT)
 * @returns {object[]} filas filtradas, ordenadas y paginadas, con `$count`
 */
function aplicarConsulta(filas, req) {
  const select = req?.query?.SELECT ?? {};
  let resultado = Array.isArray(filas) ? filas : [];

  if (Array.isArray(select.where) && select.where.length) {
    resultado = resultado.filter(fila => _cumpleFiltro(select.where, fila));
  }

  const terminos = _terminosBusqueda(select.search);
  if (terminos.length) {
    resultado = resultado.filter(fila => _coincideBusqueda(fila, terminos));
  }

  resultado = _ordenar(resultado, select.orderBy);

  // Total ANTES de paginar: es el que responde "cuántas tareas hay en total".
  const total = resultado.length;
  resultado = _paginar(resultado, select.limit);

  const salida = Array.from(resultado);
  salida.$count = total;
  return salida;
}

module.exports = { aplicarConsulta };

// ═══════════════════════════════════════════════════════════════════════════════
// FILTRO ($filter → CQN where)
// ═══════════════════════════════════════════════════════════════════════════════

/** Evalúa el where del CQN contra una fila. Fail-open si el evaluador rompe. */
function _cumpleFiltro(where, fila) {
  try {
    return new _Evaluador(where, fila).evaluar();
  } catch (error) {
    LOG.warn(`[_cumpleFiltro] no se pudo evaluar el $filter — se conserva la fila | ${error.message}`);
    return true;
  }
}

/**
 * Recorre los tokens del where respetando la precedencia de OData:
 * `or` (más baja) → `and` → unidad (comparación, función o subexpresión).
 *
 * Los tokens son la lista plana que CAP produce; los paréntesis llegan como un
 * nodo `{xpr: [...]}` que se evalúa recursivamente con otro _Evaluador.
 */
class _Evaluador {
  constructor(tokens, fila) {
    this.tokens = Array.isArray(tokens) ? tokens : [tokens];
    this.fila   = fila;
    this.pos    = 0;
  }

  evaluar() {
    return this._or();
  }

  _actual() {
    return this.tokens[this.pos];
  }

  /** true si el token actual es la palabra clave indicada (case-insensitive). */
  _esPalabra(palabra) {
    const token = this._actual();
    return typeof token === "string" && token.toLowerCase() === palabra;
  }

  _or() {
    let valor = this._and();
    while (this._esPalabra("or")) {
      this.pos++;
      // El derecho se evalúa siempre (no hay corto-circuito) porque hay que
      // consumir sus tokens para seguir leyendo la expresión.
      const derecho = this._and();
      valor = valor || derecho;
    }
    return valor;
  }

  _and() {
    let valor = this._unidad();
    while (this._esPalabra("and")) {
      this.pos++;
      const derecho = this._unidad();
      valor = valor && derecho;
    }
    return valor;
  }

  _unidad() {
    if (this._esPalabra("not")) {
      this.pos++;
      return !this._unidad();
    }

    const token = this._actual();

    // Paréntesis: (a eq 1 or a eq 2)
    if (token && Array.isArray(token.xpr)) {
      this.pos++;
      return new _Evaluador(token.xpr, this.fila).evaluar();
    }

    const izquierdo = this._operando();
    const operador  = this._actual();

    if (typeof operador === "string" && OPERADORES.has(operador.toLowerCase())) {
      this.pos++;
      return this._comparar(izquierdo, operador.toLowerCase());
    }

    // Sin operador detrás: es un predicado por sí mismo — contains(...) o un
    // flag booleano usado directamente como condición.
    return izquierdo === true;
  }

  /** Consume un token y lo resuelve a valor escalar contra la fila. */
  _operando() {
    return _resolver(this.tokens[this.pos++], this.fila);
  }

  _comparar(izquierdo, operador) {
    if (operador === "in") {
      const token = this.tokens[this.pos++];
      const lista = Array.isArray(token?.list) ? token.list
                  : Array.isArray(token?.val)  ? token.val.map(val => ({ val }))
                  : [];
      return lista.some(elemento => _iguales(izquierdo, _resolver(elemento, this.fila)));
    }

    if (operador === "between") {
      const desde = this._operando();
      if (this._esPalabra("and")) this.pos++;
      const hasta = this._operando();
      return _comparar(izquierdo, desde) >= 0 && _comparar(izquierdo, hasta) <= 0;
    }

    if (operador === "is") {
      let negado = false;
      if (this._esPalabra("not")) { this.pos++; negado = true; }
      this.pos++;                       // consume el {val:null}
      const esNulo = izquierdo === null || izquierdo === undefined;
      return negado ? !esNulo : esNulo;
    }

    const derecho = this._operando();

    switch (operador) {
      case "=":
      case "==":   return _iguales(izquierdo, derecho);
      case "!=":
      case "<>":   return !_iguales(izquierdo, derecho);
      case "like": return _coincidePatron(izquierdo, derecho);
      default: {
        // <, <=, >, >= — con null en cualquier lado no hay orden definido.
        const orden = _comparar(izquierdo, derecho);
        if (Number.isNaN(orden)) return false;
        if (operador === "<")  return orden <  0;
        if (operador === "<=") return orden <= 0;
        if (operador === ">")  return orden >  0;
        return orden >= 0;
      }
    }
  }
}

/** Resuelve un nodo del CQN al valor escalar que representa para esta fila. */
function _resolver(token, fila) {
  if (token === null || token === undefined) return null;
  if (typeof token !== "object") return token;

  if ("val" in token) return token.val;

  // ref: nombre de campo. Se toma el último segmento porque estas entidades son
  // planas — no hay navegación dentro del filtro.
  if (Array.isArray(token.ref)) {
    const campo = token.ref[token.ref.length - 1];
    return fila?.[campo] ?? null;
  }

  if (token.func) return _funcion(token, fila);
  if (Array.isArray(token.xpr))  return new _Evaluador(token.xpr, fila).evaluar();
  if (Array.isArray(token.list)) return token.list.map(item => _resolver(item, fila));

  return null;
}

/** Funciones OData: las de predicado y las escalares de texto más usadas. */
function _funcion(token, fila) {
  const nombre = String(token.func).toLowerCase();
  const args   = (token.args ?? []).map(arg => _resolver(arg, fila));
  const [a, b, c] = args;

  switch (nombre) {
    // Predicados — comparan en minúsculas, igual que LIKE en SQLite/HANA.
    case "contains":       return _texto(a).toLowerCase().includes(_texto(b).toLowerCase());
    case "startswith":     return _texto(a).toLowerCase().startsWith(_texto(b).toLowerCase());
    case "endswith":       return _texto(a).toLowerCase().endsWith(_texto(b).toLowerCase());
    case "matchespattern": return new RegExp(_texto(b)).test(_texto(a));

    // Escalares de texto
    case "tolower":   return _texto(a).toLowerCase();
    case "toupper":   return _texto(a).toUpperCase();
    case "trim":      return _texto(a).trim();
    case "length":    return _texto(a).length;
    case "concat":    return args.map(_texto).join("");
    case "indexof":   return _texto(a).indexOf(_texto(b));
    case "substring": return c === undefined
      ? _texto(a).substring(Number(b))
      : _texto(a).substring(Number(b), Number(b) + Number(c));

    default:
      LOG.warn(`[_funcion] función OData no soportada en memoria: ${nombre}`);
      return null;
  }
}

/** Traduce un patrón SQL LIKE ('%BCP%', 'BC_') a expresión regular. */
function _coincidePatron(valor, patron) {
  if (valor === null || valor === undefined) return false;
  const escapado = _texto(patron).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex    = `^${escapado.replace(/%/g, ".*").replace(/_/g, ".")}$`;
  return new RegExp(regex, "i").test(_texto(valor));
}

// ═══════════════════════════════════════════════════════════════════════════════
// BÚSQUEDA ($search)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extrae los términos del nodo `search` del CQN, que según la expresión puede
 * llegar como lista plana de {val} o como un xpr con and/or entre términos.
 */
function _terminosBusqueda(search) {
  const terminos = [];

  const recorrer = (nodo) => {
    if (!nodo || typeof nodo === "string") return;   // 'and' / 'or' no son términos
    if (Array.isArray(nodo)) return nodo.forEach(recorrer);
    if (nodo.val !== null && nodo.val !== undefined) terminos.push(String(nodo.val));
    if (nodo.xpr)  recorrer(nodo.xpr);
    if (nodo.args) recorrer(nodo.args);
  };

  recorrer(search);
  return terminos.filter(termino => termino.trim() !== "");
}

/**
 * Una fila coincide si TODOS los términos aparecen en alguno de sus campos de
 * texto o número — el AND es el comportamiento por defecto de $search en OData.
 */
function _coincideBusqueda(fila, terminos) {
  const contenido = Object.values(fila ?? {})
    .filter(valor => typeof valor === "string" || typeof valor === "number")
    .join(" ")
    .toLowerCase();

  return terminos.every(termino => contenido.includes(termino.toLowerCase()));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDEN Y PAGINACIÓN ($orderby, $top/$skip)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ordena por los criterios que el usuario pidió explícitamente.
 * Los `implicit` de Fiori Elements se descartan (ver cabecera del módulo).
 */
function _ordenar(filas, orderBy) {
  const criterios = (orderBy ?? []).filter(c => !c.implicit && Array.isArray(c.ref));
  if (!criterios.length) return filas;

  return Array.from(filas).sort((filaA, filaB) => {
    for (const criterio of criterios) {
      const campo = criterio.ref[criterio.ref.length - 1];
      const orden = _comparar(filaA?.[campo], filaB?.[campo]);
      if (!orden || Number.isNaN(orden)) {
        // NaN = alguno es null: se empuja al final, sin invertir por 'desc'.
        if (Number.isNaN(orden)) {
          const nuloA = filaA?.[campo] === null || filaA?.[campo] === undefined;
          const nuloB = filaB?.[campo] === null || filaB?.[campo] === undefined;
          if (nuloA !== nuloB) return nuloA ? 1 : -1;
        }
        continue;
      }
      return String(criterio.sort ?? "asc").toLowerCase() === "desc" ? -orden : orden;
    }
    return 0;
  });
}

/** Aplica $skip/$top. `limit.rows` ausente = sin tope. */
function _paginar(filas, limit) {
  if (!limit) return filas;
  const desde = Number(limit.offset?.val ?? 0) || 0;
  const filasMax = limit.rows?.val;
  return filasMax === null || filasMax === undefined
    ? filas.slice(desde)
    : filas.slice(desde, desde + Number(filasMax));
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARACIÓN DE VALORES
// ═══════════════════════════════════════════════════════════════════════════════

function _texto(valor) {
  return valor === null || valor === undefined ? "" : String(valor);
}

/** ¿Es un texto que representa un número? Sirve para ordenar importes String. */
function _esNumerico(valor) {
  return typeof valor === "number" ||
         (typeof valor === "string" && valor.trim() !== "" && Number.isFinite(Number(valor)));
}

/**
 * Igualdad de `eq`. Deliberadamente NO normaliza dos textos a número: sociedad
 * '0025' no debe considerarse igual a '25'. La conversión numérica se reserva
 * para cuando uno de los lados ya viene como número desde la URL.
 */
function _iguales(a, b) {
  if (a === b) return true;
  const nuloA = a === null || a === undefined;
  const nuloB = b === null || b === undefined;
  if (nuloA || nuloB) return nuloA && nuloB;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

/**
 * Orden relativo de dos valores: -1 | 0 | 1, o NaN si alguno es null.
 * Compara numéricamente cuando ambos lados son números o texto numérico
 * (para que "8500.00" < "43038.69" en la columna Importe).
 */
function _comparar(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return NaN;

  if (_esNumerico(a) && _esNumerico(b)) {
    const numA = Number(a);
    const numB = Number(b);
    return numA < numB ? -1 : numA > numB ? 1 : 0;
  }

  if (typeof a === "boolean" || typeof b === "boolean") {
    const boolA = a ? 1 : 0;
    const boolB = b ? 1 : 0;
    return boolA - boolB;
  }

  const textoA = String(a);
  const textoB = String(b);
  return textoA < textoB ? -1 : textoA > textoB ? 1 : 0;
}
