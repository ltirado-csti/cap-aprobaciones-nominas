"use strict";
/**
 * Construye el historial de aprobaciones en la forma que consume el control
 * sap.suite.ui.commons.ProcessFlow del Object Page: normaliza las filas del
 * iFlow, arma la topología del grafo (niveles/lanes y aristas), traduce cada
 * decisión de negocio a estado visual y formatea fechas e iniciales.
 *
 * ECP solo conoce las firmas ya registradas; un paso pendiente no existe para
 * ECP. Por eso el historial se arma en dos capas y se fusiona:
 *   1. ESQUELETO — filasEsperadas(): la forma que el flujo va a tener, derivada
 *      de la propuesta y de la tarea BPA pendiente (nodos aún no ocurridos).
 *   2. HECHOS — filas de ECP, adaptadas por _adaptarFilaEcp(). El hecho
 *      siempre reemplaza al esqueleto en su mismo slot (nivel+orden).
 *
 * `cds.historial.origen` en package.json:
 *   "cpi"  → se llama al iFlow y se fusiona; si no responde o no trae filas
 *            utilizables, se muestra solo el esqueleto y esDemo pasa a true.
 *   "demo" → no se llama a CPI, comportamiento determinista.
 */

const cds      = require("@sap/cds");
const cpiInfra = require("../infrastructure/cpi-client");
const perfiles = require("../config/perfiles");
const hora     = require("../config/zona-horaria");

const LOG = cds.log("historial-service");

/** Origen de datos configurado; "cpi" en el flujo normal, "demo" para trabajar sin destino. */
const ORIGEN_DEMO = "demo";
const origenConfigurado = () =>
    String(cds.env.historial?.origen ?? ORIGEN_DEMO).trim().toLowerCase();

// ═══════════════════════════════════════════════════════════════════════════════
// TABLAS DE TRADUCCIÓN — negocio → presentación
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decisión que entrega Payroll/CPI → cómo se pinta el nodo.
 *   estado     : sap.suite.ui.commons.ProcessFlowNodeState
 *   valueState : sap.ui.core.ValueState del ObjectStatus de la tarjeta
 *   actual     : el nodo es el paso vivo del flujo → highlighted + focused
 */
const DECISIONES = {
    APROBADO : { texto: "Aprobado",  estado: "Positive", valueState: "Success", actual: false },
    LIBERADO : { texto: "Liberado",  estado: "Positive", valueState: "Success", actual: false },
    FIRMADO  : { texto: "Firmado",   estado: "Positive", valueState: "Success", actual: false },
    REGISTRADO:{ texto: "Registrado",estado: "Positive", valueState: "Success", actual: false },
    REVISADO : { texto: "Revisado",   estado: "Positive", valueState: "Success", actual: false },
    OBSERVADO: { texto: "Observado", estado: "Negative", valueState: "Error",   actual: false },
    RECHAZADO: { texto: "Rechazado", estado: "Negative", valueState: "Error",   actual: false },
    ANULADO  : { texto: "Anulado",   estado: "Negative", valueState: "Error",   actual: false },
    EN_CURSO : { texto: "En curso",  estado: "Neutral",  valueState: "Warning", actual: true  },
    PENDIENTE: { texto: "Pendiente", estado: "Planned",  valueState: "None",    actual: false },

    // Firma que BPA ya cuenta para el quórum pero que ECP todavía no confirmó
    // en su propio historial. Ámbar hasta que _fusionar() la reemplace por el
    // dato real de ECP.
    APROBADO_BPA: { texto: "Aprobado (pendiente Payroll)", estado: "Critical", valueState: "Warning", actual: false },
};

/** Decisión desconocida: no se inventa un resultado, se muestra tal cual en gris. */
const DECISION_DESCONOCIDA = { texto: "", estado: "Neutral", valueState: "None", actual: false };

/**
 * ECP · campo `Perfil` → posición del nodo en el diagrama.
 * `Perfil` es el IpPerfil de Payroll y transporta el slot de firma:
 *   "1" y "2" → las dos firmas del quórum de apoderados (mismo nivel).
 *   "3"       → liberador final.
 * Los niveles 1 (analista) y 2 (coordinador) no salen de aquí; los aporta el
 * esqueleto, que conoce sus usuarios (usuarioCreacion / usuarioRevisor).
 */
const PERFIL_PAYROLL = {
    "1": { nivel: 3, orden: 1, rol: "AP" },
    "2": { nivel: 3, orden: 2, rol: "AP" },
    "3": { nivel: 4, orden: 1, rol: "LI" },
};

/**
 * ECP · campo `Status` → clave de DECISIONES.
 * Un status fuera de esta tabla se pinta en gris con su literal a la vista
 * (DECISION_DESCONOCIDA) en vez de descartarse.
 */
const STATUS_ECP = {
    AP: "APROBADO",
    LI: "LIBERADO",
    OB: "OBSERVADO",
    RE: "RECHAZADO",
    AN: "ANULADO",
};

/**
 * Perfil SAP (ver config/perfiles.js) → cómo se rotula la columna del diagrama.
 * Se comparte entre las dos apps (historial de aprobaciones y reasignación).
 */
const PERFILES_LANE = {
    AN: { descripcion: "Analista",       icono: "sap-icon://employee" },
    AP: { descripcion: "Apoderados",     icono: "sap-icon://signature" },
    LI: { descripcion: "Liberador",      icono: "sap-icon://accept" },
    CO: { descripcion: "Coordinador",    icono: "sap-icon://employee-approvals" },
};

const LANE_POR_DEFECTO = { descripcion: "Aprobación", icono: "sap-icon://employee" };

/**
 * Estado del nodo → cómo se nombra al resumir un NIVEL completo.
 * El orden de las claves define el orden de los sectores del anillo de la
 * cabecera del lane, de "más avanzado" a "menos avanzado".
 */
const ESTADOS_NIVEL = {
    Positive: { uno: "completado",     varios: "completados" },
    Negative: { uno: "rechazado",      varios: "rechazados" },
    Critical: { uno: "con incidencia", varios: "con incidencias" },
    Neutral : { uno: "en curso",       varios: "en curso" },
    Planned : { uno: "pendiente",      varios: "pendientes" },
};

// ═══════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Punto de entrada usado por pagos-service.js. Arma el esqueleto del flujo, le
 * superpone las firmas reales de ECP y devuelve las colecciones que consume el
 * ProcessFlow. Si CPI no responde o no aporta firmas utilizables, devuelve solo
 * el esqueleto con esDemo=true.
 *
 * @param {object} propuesta  - PropuestaNomina extraída del contexto BPA
 * @param {string} instanceID - clave de la tarea; se propaga a ambas colecciones
 * @param {string} [activityId] - taskDefinitionId de la tarea BPA pendiente
 * @param {object} [contexto] - contexto BPA completo (aporta el quórum de apoderados)
 * @returns {Promise<{ niveles: object[], aprobadores: object[], esDemo: boolean }>}
 */
async function obtenerHistorial(propuesta, instanceID, activityId, contexto) {
    const quorum = _quorumApoderados(contexto, propuesta);
    const esqueleto = filasEsperadas(propuesta, activityId, quorum.requeridas, quorum.firmantes);

    if (origenConfigurado() === ORIGEN_DEMO) {
        LOG.info(`[obtenerHistorial] origen='demo' — no se consulta a CPI | id=${instanceID}`);
        return { ...construirDesdeFilas(esqueleto, instanceID), esDemo: true };
    }

    let reales = [];
    try {
        reales = (await cpiInfra.getHistorialAprobaciones(propuesta ?? {}))
            .map(_adaptarFilaEcp)
            .filter(Boolean)
            .sort((a, b) => String(a.FechaAccion).localeCompare(String(b.FechaAccion)));
    } catch (error) {
        LOG.warn(`[obtenerHistorial] CPI no respondió | id=${instanceID} | ${error.message}`);
    }

    if (reales.length === 0) {
        LOG.info(`[obtenerHistorial] ECP sin firmas utilizables — solo esqueleto | id=${instanceID}`);
        return { ...construirDesdeFilas(esqueleto, instanceID), esDemo: true };
    }

    return {
        ...construirDesdeFilas(_fusionar(esqueleto, reales), instanceID),
        esDemo: false,
    };
}

/**
 * Fusiona el esqueleto esperado con las firmas que ECP confirma, por clave
 * NIVEL+ORDEN (el slot que identifica el campo `Perfil` de ECP). La versión de
 * ECP reemplaza a la esperada; del esqueleto sobreviven el rótulo del rol y los
 * nodos que ECP todavía no puede conocer.
 */
function _fusionar(esperadas, reales) {
    const clave = fila => `${fila.Nivel}-${fila.Orden}`;
    const porSlot = new Map(esperadas.map(fila => [clave(fila), fila]));

    for (const real of reales) {
        const esperada = porSlot.get(clave(real));
        porSlot.set(clave(real), esperada ? { ...esperada, ...real } : real);
    }

    return [...porSlot.values()];
}

/**
 * Cuántas firmas de apoderado exige el quórum y quiénes ya firmaron según BPA.
 * Sin contexto se cae a las firmas por defecto del rol y ningún firmante conocido.
 */
function _quorumApoderados(contexto, propuesta) {
    const porDefecto = perfiles.ROLES_BPA.apoderado.firmasPorDefecto;
    if (!contexto) return { requeridas: porDefecto, firmantes: [] };
    const quorum = perfiles.resolverQuorumApoderados(contexto, propuesta ?? {});
    return {
        requeridas: Number(quorum.requeridas) || porDefecto,
        firmantes : quorum.firmantes ?? [],
    };
}

/**
 * Transforma filas crudas del iFlow en nodos + lanes del ProcessFlow.
 * Función pura: mismas filas → mismo resultado.
 *
 * @param {object[]} filas      - filas crudas: de ECP adaptadas, del esqueleto, o fusionadas
 * @param {string}   instanceID - clave de la tarea BPA
 * @returns {{ niveles: object[], aprobadores: object[] }}
 */
function construirDesdeFilas(filas, instanceID) {
    const normalizadas = (filas ?? [])
        .map(_normalizarFila)
        .filter(Boolean)
        .sort((a, b) => (a.nivel - b.nivel) || (a.orden - b.orden));

    if (normalizadas.length === 0) return { niveles: [], aprobadores: [] };

    const nodos = normalizadas.map(fila => _construirNodo(fila, instanceID));

    _enlazarNodos(nodos);

    return {
        niveles    : _derivarNiveles(nodos, instanceID),
        aprobadores: nodos,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NORMALIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

/** Lee un campo probando varias grafías (CPI entrega PascalCase o camelCase). */
function _leer(fila, ...nombres) {
    for (const nombre of nombres) {
        const valor = fila?.[nombre];
        if (valor !== undefined && valor !== null && valor !== "") return valor;
    }
    return undefined;
}

/**
 * Convierte una fila cruda en la estructura interna de trabajo.
 * Una fila vale si identifica a un firmante o una posición del diagrama; se
 * descarta solo lo que no es ni una cosa ni la otra.
 */
function _normalizarFila(fila, indice) {
    if (!fila || typeof fila !== "object") return null;

    const usuario = String(_leer(fila, "usuario", "Usuario", "UserId", "PiUsuario") ?? "").trim();
    const nombre  = String(_leer(fila, "nombre", "Nombre", "NombreCompleto") ?? "").trim();
    const nivelCrudo = _leer(fila, "nivel", "Nivel", "Level");
    if (!usuario && !nombre && nivelCrudo === undefined) return null;

    const nivel = Number(nivelCrudo ?? 0) || (indice + 1);
    const orden = Number(_leer(fila, "orden", "Orden", "Posicion") ?? 0) || (indice + 1);

    return {
        nivel,
        orden,
        usuario,
        nombre     : nombre || usuario,
        cargo      : String(_leer(fila, "cargo", "Cargo", "Puesto", "Descripcion") ?? "").trim(),
        rol        : String(_leer(fila, "perfil", "Perfil", "rol", "Rol", "IpPerfil") ?? "").trim().toUpperCase(),
        decision   : String(_leer(fila, "decision", "Decision", "Estado", "estado") ?? "").trim().toUpperCase(),
        comentario : String(_leer(fila, "comentario", "Comentario", "Observacion", "observacion") ?? "").trim(),
        fechaAccion: _leer(fila, "fechaAccion", "FechaAccion", "fechaAprob", "FechaAprob", "Fecha") ?? "",
        fotoUrl    : String(_leer(fila, "fotoUrl", "FotoUrl", "Foto", "urlFoto") ?? "").trim(),
    };
}

/**
 * Traduce una fila de EtDetalle (ECP) al mismo formato crudo que produce
 * filasEsperadas(), para que se fusionen sin conversiones intermedias.
 * Devuelve null si el `Perfil` no es un slot conocido, o si no hay firmante.
 *
 * @param {object} fila - elemento de EtDetalle.item
 * @returns {object|null}
 */
function _adaptarFilaEcp(fila) {
    const slot = PERFIL_PAYROLL[String(_leer(fila, "Perfil", "perfil") ?? "").trim()];
    if (!slot) return null;

    const aprobador = String(_leer(fila, "Aprobador", "aprobador") ?? "").trim();
    if (!aprobador) return null;

    const status = String(_leer(fila, "Status", "status") ?? "").trim().toUpperCase();

    return {
        Nivel  : slot.nivel,
        Orden  : slot.orden,
        Perfil : slot.rol,
        Usuario: aprobador,
        Nombre     : "",
        Decision   : STATUS_ECP[status] ?? status,
        FechaAccion: _fechaEcpAIso(_leer(fila, "Erdat", "erdat"), _leer(fila, "Uzeit", "uzeit")),
        Comentario : "",
        FotoUrl    : "",
    };
}

/** Fecha y hora de ECP (campos separados, UTC) → ISO 8601. */
function _fechaEcpAIso(erdat, uzeit) {
    return hora.isoDesdeSap(erdat, uzeit);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTRUCCIÓN DEL GRAFO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Arma un nodo del ProcessFlow a partir de una fila normalizada.
 * `hijos` queda vacío aquí; se resuelve en _enlazarNodos().
 */
function _construirNodo(fila, instanceID) {
    const decision = DECISIONES[fila.decision] ?? DECISION_DESCONOCIDA;
    const textoDec = decision.texto || fila.decision || "Sin información";

    return {
        instanceID,
        nodeId            : `N${fila.nivel}-${fila.orden}`,
        laneId            : `N${fila.nivel}`,
        nivel             : fila.nivel,
        orden             : fila.orden,
        hijos             : "",
        usuario           : fila.usuario,
        nombre            : _rotuloPersona(fila.nombre),
        cargo             : fila.cargo || _cargoPorRol(fila.rol),
        iniciales         : _calcularIniciales(fila.nombre || fila.usuario),
        fotoUrl           : fila.fotoUrl,
        rol               : fila.rol,
        decision          : fila.decision,
        decisionTexto     : textoDec,
        comentario        : fila.comentario,
        fechaAccion       : _aIso(fila.fechaAccion),
        fechaTexto        : _formatearFecha(fila.fechaAccion),
        estadoNodo        : decision.estado,
        estadoTexto       : textoDec,
        decisionValueState: decision.valueState,
        esActual          : decision.actual,
    };
}

/**
 * Calcula las aristas del diagrama: todo nodo de un nivel apunta a todos los
 * nodos del siguiente nivel que exista. El último nivel no tiene hijos.
 */
function _enlazarNodos(nodos) {
    const nivelesOrdenados = [...new Set(nodos.map(n => n.nivel))].sort((a, b) => a - b);

    nivelesOrdenados.forEach((nivel, indice) => {
        const siguiente = nivelesOrdenados[indice + 1];
        if (siguiente === undefined) return;

        const idsSiguiente = nodos
            .filter(n => n.nivel === siguiente)
            .map(n => n.nodeId)
            .join(",");

        nodos
            .filter(n => n.nivel === nivel)
            .forEach(n => { n.hijos = idsSiguiente; });
    });
}

/**
 * Deriva los lanes (columnas) agrupando las firmas por nivel.
 * `posicion` es 0-based y sin huecos, como exige ProcessFlowLaneHeader.
 */
function _derivarNiveles(nodos, instanceID) {
    const numerosNivel = [...new Set(nodos.map(n => n.nivel))].sort((a, b) => a - b);

    return numerosNivel.map((nivel, posicion) => {
        const delNivel = nodos.filter(n => n.nivel === nivel);

        const rolDelNivel = delNivel.find(n => n.rol)?.rol;
        const lane        = PERFILES_LANE[rolDelNivel] ?? LANE_POR_DEFECTO;
        const conteos     = _contarEstados(delNivel);

        return {
            instanceID,
            laneId     : `N${nivel}`,
            posicion,
            texto      : lane.descripcion,
            descripcion: lane.descripcion,
            icono      : lane.icono,
            estadoTexto: _resumirEstados(conteos),
            resumen    : `${lane.descripcion} · ${_resumirEstados(conteos)}`,
        };
    });
}

/**
 * Cuenta cuántas firmas del nivel hay en cada estado, en el orden de ESTADOS_NIVEL.
 * @returns {Array<[string, number]>} pares [estado, conteo], solo los > 0
 */
function _contarEstados(nodosDelNivel) {
    return Object.keys(ESTADOS_NIVEL)
        .map(estado => [estado, nodosDelNivel.filter(n => n.estadoNodo === estado).length])
        .filter(([, conteo]) => conteo > 0);
}

/** Texto del tooltip del lane: "1 completado, 1 en curso". */
function _resumirEstados(conteos) {
    if (conteos.length === 0) return "Sin firmas registradas";
    return conteos
        .map(([estado, conteo]) => {
            const etiqueta = ESTADOS_NIVEL[estado];
            return `${conteo} ${conteo === 1 ? etiqueta.uno : etiqueta.varios}`;
        })
        .join(", ");
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILIDADES DE PRESENTACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

/** Etiqueta de respaldo cuando el iFlow no manda `Cargo`. */
function _cargoPorRol(rol) {
    return PERFILES_LANE[rol]?.descripcion ?? "";
}

/** Rótulo de la tarjeta, en mayúsculas (uniforma usuario SAP y correo). */
function _rotuloPersona(nombre) {
    return String(nombre ?? "").toUpperCase();
}

/**
 * Iniciales para el Avatar cuando no hay foto.
 * "María Ricanqui" → "MR" | "mricanqui" → "MR" (dos primeras letras).
 */
function _calcularIniciales(nombre) {
    const partes = String(nombre ?? "").trim().split(/\s+/).filter(Boolean);
    if (partes.length === 0) return "";
    if (partes.length === 1) return partes[0].substring(0, 2).toUpperCase();
    return (partes[0][0] + partes[1][0]).toUpperCase();
}

/** Normaliza a ISO 8601 para trazabilidad; cadena vacía si la fecha no es válida. */
function _aIso(valor) {
    if (!valor) return "";
    const fecha = new Date(valor);
    return Number.isNaN(fecha.getTime()) ? "" : fecha.toISOString();
}

/** Fecha de presentación en la convención peruana (dd/MM/yyyy HH:mm), hora de Lima. */
function _formatearFecha(valor) {
    return hora.formatearFechaHora(valor);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESQUELETO DEL FLUJO — los nodos que ECP no puede conocer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Nivel del diagrama en el que está cada rol del flujo:
 *   1 Analista → 2 Coordinador → 3 Apoderados → 4 Liberador
 * Coincide con PERFIL_PAYROLL. Todos los apoderados comparten nivel: son un
 * pool sobre una única tarea (quórum de 2 firmas).
 */
const NIVEL_POR_ROL = { coordinador: 2, apoderado: 3, liberador: 4 };
const NIVEL_POR_DEFECTO = 3;   // sin tarea identificable, se asume en apoderados

/**
 * La forma que el flujo va a tener, en el mismo formato crudo que produce
 * _adaptarFilaEcp: qué nodos hay, en qué columna y en qué estado. Solo se
 * pintan los usuarios que la propuesta ya trae de Payroll; un nodo sin persona
 * conocida va con su rol y su estado, sin nombre.
 *
 * Los estados se derivan del `taskDefinitionId` que BPA tiene pendiente para
 * esta tarea (misma fuente que los flags de rol y los botones del Object Page):
 *   nivel < pendiente  → ya firmó        (el nivel 1 registra, no aprueba)
 *   nivel = pendiente  → en curso
 *   nivel > pendiente  → aún no le llega
 *
 * El nivel 3 (apoderados) genera tantas tarjetas como firmas exija el quórum,
 * no una por miembro del pool: son los slots que `Perfil` "1"/"2" identifican
 * al fusionar con ECP. Los slots con firmante conocido (`firmantes`) se pintan
 * con Decision "APROBADO_BPA" (BPA ya cuenta la firma, Payroll aún no la
 * confirma); los slots sin firmante van sin persona.
 *
 * El nivel 4 (liberador) es un solo nodo aunque haya varios liberadores
 * designados: el paso se cierra con una sola liberación. Con un único
 * designado la tarjeta lleva su nombre; con varios, va sin persona hasta que
 * ECP confirme quién liberó.
 *
 * @param {object} [propuesta]   - usuarios reales del contexto BPA
 * @param {string} [activityId]  - taskDefinitionId de la tarea BPA pendiente
 * @param {number} [requeridas]  - firmas que exige el quórum = tarjetas del nivel 2
 * @param {string[]} [firmantes] - correos de apoderados que BPA ya registra como firmados
 */
function filasEsperadas(propuesta, activityId, requeridas, firmantes = []) {
    const p = propuesta ?? {};

    const rolPendiente = perfiles.resolverRolBpa(activityId);
    const nivelPendiente = NIVEL_POR_ROL[rolPendiente?.nombre] ?? NIVEL_POR_DEFECTO;

    /** Decisión que corresponde a un nivel según dónde esté el flujo. */
    const decision = (nivel, siFirmado) => {
        if (nivel < nivelPendiente) return siFirmado;
        if (nivel > nivelPendiente) return "PENDIENTE";
        return "EN_CURSO";
    };

    const slots = Number(requeridas) || perfiles.ROLES_BPA.apoderado.firmasPorDefecto;

    const filasApoderados = Array.from({ length: slots }, (_, indice) => {
        const correo = firmantes[indice];
        return correo
            ? {
                Nivel: 3, Orden: indice + 1,
                Usuario: correo,
                Nombre : _nombreDesdeCorreo(correo),
                Cargo  : "Apoderado",
                Perfil : "AP",
                Decision: "APROBADO_BPA",
                Comentario: "",
                FechaAccion: "",
                FotoUrl: "",
            }
            : {
                Nivel: 3, Orden: indice + 1,
                Usuario: "",
                Nombre : "",
                Cargo  : "Apoderado",
                Perfil : "AP",
                Decision: decision(3, "APROBADO"),
                Comentario: "",
                FechaAccion: "",
                FotoUrl: "",
            };
    });

    // Usuario que registró la propuesta en Payroll (nivel 1: Analista).
    const analista = p.usuarioCreacion || p.analista || p.correoAnalista || "";

    // Revisor de la propuesta (nivel 2: Coordinador). Paso ya ocurrido antes
    // de que el flujo llegue a los apoderados; se pinta siempre resuelto.
    const revisor = p.usuarioRevisor || "";

    // Nivel 4 (Liberador): un solo nodo aunque Payroll designe varios
    // liberadores (usuarioLiberador como CSV). Con uno solo se muestra su
    // nombre; con varios, va sin persona hasta que ECP confirme quién liberó.
    const liberadores = perfiles.normalizarUsuarios(p.usuarioLiberador);
    const liberador   = liberadores.length === 1 ? liberadores[0] : "";

    return [
        {
            Nivel: 1, Orden: 1,
            Usuario: analista,
            Nombre : _nombreDesdeCorreo(analista),
            Cargo  : "Analista",
            Perfil : "AN",
            Decision: "REGISTRADO",
            Comentario: "",
            FechaAccion: "",
            FotoUrl: "",
        },
        {
            Nivel: 2, Orden: 1,
            Usuario: revisor,
            Nombre : _nombreDesdeCorreo(revisor),
            Cargo  : "Coordinador",
            Perfil : "CO",
            Decision: "REVISADO",
            Comentario: "",
            FechaAccion: "",
            FotoUrl: "",
        },
        ...filasApoderados,
        {
            Nivel: 4, Orden: 1,
            Usuario: liberador,
            Nombre : _nombreDesdeCorreo(liberador),
            Cargo  : "Liberador Final",
            Perfil : "LI",
            Decision: decision(4, "LIBERADO"),
            Comentario: "",
            FechaAccion: "",
            FotoUrl: "",
        },
    ];
}

/** Nombre a partir del correo: "jlicetti@centria.net" → "jlicetti". */
function _nombreDesdeCorreo(correo) {
    return String(correo ?? "").split("@")[0] || String(correo ?? "");
}

module.exports = {
    obtenerHistorial,
    construirDesdeFilas,
    filasEsperadas,
};
