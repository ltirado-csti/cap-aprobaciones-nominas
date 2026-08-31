"use strict";
/**
 * Aplica en memoria la parte "de consulta" de una petición OData ($filter,
 * $search, $orderby, $top/$skip, $count) sobre un array ya construido.
 *
 * Necesario para entidades @cds.persistence.skip (TareasInbox, TareasEnCurso):
 * un handler `.on("READ", ...)` que devuelve un array reemplaza la
 * implementación por defecto, así que CAP no le aplica where/orderBy/limit.
 *
 * El orderBy `implicit` que añade Fiori Elements para estabilizar su
 * paginación no se aplica: solo se ordena por lo que el usuario pide en una
 * columna. Las coincidencias de texto parcial (contains/startswith/endswith/
 * like) y la búsqueda libre son case-insensitive; `eq` distingue mayúsculas.
 * Si evaluar un filtro falla, la fila se conserva (fail-open) y se registra
 * un warning.
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
 * Devuelve un array nuevo con `$count` fijado al total tras filtrar/buscar
 * pero antes de paginar.
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
 * Los paréntesis llegan como `{xpr: [...]}` y se evalúan recursivamente.
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

    // Sin operador detrás: predicado por sí mismo (contains(...), flag booleano).
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
    case "contains":       return _texto(a).toLowerCase().includes(_texto(b).toLowerCase());
    case "startswith":     return _texto(a).toLowerCase().startsWith(_texto(b).toLowerCase());
    case "endswith":       return _texto(a).toLowerCase().endsWith(_texto(b).toLowerCase());
    case "matchespattern": return new RegExp(_texto(b)).test(_texto(a));

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

/** Extrae los términos del nodo `search` del CQN (lista plana o xpr con and/or). */
function _terminosBusqueda(search) {
  const terminos = [];

  const recorrer = (nodo) => {
    if (!nodo || typeof nodo === "string") return;
    if (Array.isArray(nodo)) return nodo.forEach(recorrer);
    if (nodo.val !== null && nodo.val !== undefined) terminos.push(String(nodo.val));
    if (nodo.xpr)  recorrer(nodo.xpr);
    if (nodo.args) recorrer(nodo.args);
  };

  recorrer(search);
  return terminos.filter(termino => termino.trim() !== "");
}

/** Una fila coincide si todos los términos aparecen en alguno de sus campos (AND). */
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

/** Ordena por los criterios explícitos del usuario; descarta los `implicit`. */
function _ordenar(filas, orderBy) {
  const criterios = (orderBy ?? []).filter(c => !c.implicit && Array.isArray(c.ref));
  if (!criterios.length) return filas;

  return Array.from(filas).sort((filaA, filaB) => {
    for (const criterio of criterios) {
      const campo = criterio.ref[criterio.ref.length - 1];
      const orden = _comparar(filaA?.[campo], filaB?.[campo]);
      if (!orden || Number.isNaN(orden)) {
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

/** Igualdad de `eq`. No normaliza texto a número: '0025' no es igual a '25'. */
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
 * Compara numéricamente cuando ambos lados son números o texto numérico.
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
