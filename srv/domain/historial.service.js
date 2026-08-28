"use strict";
/**
 * srv/domain/historial.service.js
 *
 * Construye el HISTORIAL DE APROBACIONES en la forma exacta que consume el
 * control sap.suite.ui.commons.ProcessFlow del Object Page.
 *
 * ── Posición en el diagrama de arquitectura ──────────────────────────────────
 *
 *   HANA / Payroll  →  CPI (iFlow)  →  CAP (este módulo)  →  OData V4  →  Fiori
 *                      ─────────────    ────────────────
 *                      solo transporte   TODA la lógica
 *
 * El principio del proyecto es que CAP procesa y el frontend solo enlaza. Por eso
 * aquí se resuelve absolutamente todo lo que el diagrama necesita:
 *
 *   · normalización de las filas crudas del iFlow (tolerante a camel/PascalCase)
 *   · topología del grafo: qué nodo apunta a cuál (campo `hijos`)
 *   · derivación de los niveles/lanes a partir del campo `nivel` de cada firma
 *   · traducción decisión de negocio → estado visual del nodo
 *   · formato de fechas e iniciales del avatar
 *
 * El fragmento XML no interpreta ninguna regla: enlaza propiedades y ya.
 *
 * ── ESQUELETO + HECHOS: por qué el diagrama se FUSIONA ───────────────────────
 *
 * ECP solo conoce lo que YA ocurrió: devuelve una fila por firma registrada y
 * nada más. Un liberador que aún no ha actuado no existe para ECP. Pintar solo
 * esas filas dejaría un diagrama sin columnas pendientes — es decir, sin flujo.
 *
 * Por eso cada historial se arma en dos capas:
 *
 *   1. ESQUELETO — filasEsperadas(): la forma que el flujo va a tener, derivada
 *      de la propuesta y de qué tarea tiene BPA pendiente. Aporta los nodos que
 *      todavía no han ocurrido (En curso / Pendiente).
 *   2. HECHOS — las filas de ECP, adaptadas por _adaptarFilaEcp(). Sobrescriben
 *      el slot que les corresponde: firmante real, decisión real, fecha real.
 *
 * La fusión (_fusionar) se hace por NIVEL+ORDEN, que es lo que ECP identifica
 * con su campo `Perfil` (el slot de firma). El hecho siempre gana sobre lo
 * esperado; lo esperado solo rellena lo que ECP no puede saber.
 *
 * ── Interruptor de origen ────────────────────────────────────────────────────
 *
 * `cds.historial.origen` en package.json:
 *
 *   "cpi"  (valor actual) → se llama al iFlow y se fusiona. Si no responde, o
 *                           responde sin filas utilizables, se muestra solo el
 *                           esqueleto y esDemo pasa a true (aviso en pantalla).
 *   "demo"                → no se llama a CPI en absoluto. Útil para trabajar el
 *                           diagrama sin destino, con comportamiento determinista.
 */

const cds      = require("@sap/cds");
const cpiInfra = require("../infrastructure/cpi-client");
const perfiles = require("../config/perfiles");

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
 *
 *   estado     : sap.suite.ui.commons.ProcessFlowNodeState
 *                Positive (verde) | Negative (rojo) | Neutral (azul, en curso) |
 *                Planned (gris punteado, aún no llega) | Critical (ámbar)
 *   valueState : sap.ui.core.ValueState del ObjectStatus de la tarjeta
 *   actual     : el nodo es el paso vivo del flujo → highlighted + focused
 */
const DECISIONES = {
    APROBADO : { texto: "Aprobado",  estado: "Positive", valueState: "Success", actual: false },
    LIBERADO : { texto: "Liberado",  estado: "Positive", valueState: "Success", actual: false },
    FIRMADO  : { texto: "Firmado",   estado: "Positive", valueState: "Success", actual: false },
    REGISTRADO:{ texto: "Registrado",estado: "Positive", valueState: "Success", actual: false },
    // Paso de revisión del coordinador. Verde como REGISTRADO y por el mismo
    // motivo: ni el analista ni el coordinador aprueban la propuesta —la
    // preparan y la revisan—, así que cuando el flujo llega a los apoderados su
    // parte ya está hecha. Pintarlos "en curso" o "pendiente" sugeriría que
    // falta una decisión suya que nadie va a tomar.
    REVISADO : { texto: "Revisado",   estado: "Positive", valueState: "Success", actual: false },
    OBSERVADO: { texto: "Observado", estado: "Negative", valueState: "Error",   actual: false },
    RECHAZADO: { texto: "Rechazado", estado: "Negative", valueState: "Error",   actual: false },
    ANULADO  : { texto: "Anulado",   estado: "Negative", valueState: "Error",   actual: false },
    EN_CURSO : { texto: "En curso",  estado: "Neutral",  valueState: "Warning", actual: true  },
    PENDIENTE: { texto: "Pendiente", estado: "Planned",  valueState: "None",    actual: false },

    // Firma que BPA ya cuenta para el quórum (apoderadosfirmantes) pero que ECP
    // TODAVÍA no confirmó en su propio historial (EtDetalle). Se pinta distinto
    // de APROBADO a propósito: BPA cuenta la firma en cuanto su ActionTask
    // ZhrfApoReg responde, sin verificar que Payroll la haya aceptado — un gateway
    // mal cableado en el BPMN puede contar una firma que Payroll rechazó (visto en
    // producción: "Correo no existe" seguido de "Registrar firma" igual). Ámbar
    // en vez de verde hasta que _fusionar() la reemplace por el dato real de ECP.
    APROBADO_BPA: { texto: "Aprobado (pendiente Payroll)", estado: "Critical", valueState: "Warning", actual: false },
};

/** Decisión desconocida: no se inventa un resultado, se muestra tal cual en gris. */
const DECISION_DESCONOCIDA = { texto: "", estado: "Neutral", valueState: "None", actual: false };

/**
 * ECP · campo `Perfil` → posición del nodo en el diagrama.
 *
 * `Perfil` es el IpPerfil de Payroll y transporta el SLOT DE FIRMA, no un perfil
 * por usuario (misma semántica que documenta config/perfiles.js):
 *
 *   "1" y "2" → las dos firmas del quórum de apoderados. MISMO nivel (misma
 *               columna del diagrama), distinta tarjeta: en BPA son una sola
 *               tarea con pool, y el orden lo decide quién firma primero.
 *   "3"       → liberador final.
 *
 * Los niveles 1 (analista) y 2 (coordinador) no salen de aquí: ECP registra
 * APROBACIONES, y ni el registro de la propuesta en Payroll ni su revisión lo
 * son. Los aporta el esqueleto, que es además quien conoce a sus usuarios
 * (usuarioCreacion y usuarioRevisor de la propuesta).
 */
const PERFIL_PAYROLL = {
    "1": { nivel: 3, orden: 1, rol: "AP" },
    "2": { nivel: 3, orden: 2, rol: "AP" },
    "3": { nivel: 4, orden: 1, rol: "LI" },
};

/**
 * ECP · campo `Status` → clave de DECISIONES.
 *
 * Un status fuera de esta tabla NO se descarta: _construirNodo lo pinta en gris
 * con su literal a la vista (DECISION_DESCONOCIDA). Es preferible mostrar un
 * código sin traducir que inventar un resultado o esconder la firma.
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
 *
 * `descripcion` es LA ETIQUETA de la cabecera del lane —lo que el usuario lee
 * bajo el ícono— y además el prefijo de su tooltip ("Apoderados · 1 en curso").
 * Se comparte entre las dos apps: cambiar un texto aquí lo cambia en el
 * historial de aprobaciones y en el flujo de reasignación a la vez.
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
 *
 * El anillo semántico de la cabecera del lane (ProcessFlowLaneHeader.state) usa
 * los mismos literales de ProcessFlowNodeState que los nodos, así que el color
 * del nivel es coherente con el de sus tarjetas por construcción: verde si todas
 * sus firmas están resueltas, azul mientras alguna está en curso, rojo si alguna
 * rechazó, gris si el nivel todavía no ha empezado.
 *
 * Las etiquetas son para el tooltip. Singular y plural van explícitos porque
 * añadir una "s" daría "en cursos".
 *
 * El ORDEN de las claves define el orden de los sectores del anillo: se recorre
 * de "más avanzado" a "menos avanzado" para que el gráfico se lea igual siempre,
 * sin depender del orden en que CPI devuelva las filas.
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
 * Punto de entrada usado por pagos-service.js.
 *
 * Arma el esqueleto del flujo, le superpone las firmas reales de ECP y devuelve
 * las dos colecciones que el ProcessFlow necesita. Si CPI no responde o no
 * aporta ni una firma utilizable, se devuelve el esqueleto solo, marcado como
 * demo para que el Object Page avise de que lo que se ve es lo esperado y no lo
 * ocurrido.
 *
 * @param {object} propuesta  - PropuestaNomina extraída del contexto BPA
 * @param {string} instanceID - clave de la tarea; se propaga a ambas colecciones
 * @param {string} [activityId] - taskDefinitionId de la tarea BPA pendiente. Es la
 *        MISMA fuente de la que salen los flags de rol y, por tanto, los botones
 *        del Object Page; se usa para que los estados del esqueleto no
 *        contradigan lo que la pantalla permite hacer. Ver filasEsperadas().
 * @param {object} [contexto] - contexto BPA completo. Aporta el quórum: cuántas
 *        firmas de apoderado hacen falta y, por tanto, cuántas tarjetas tiene el
 *        nivel 2 del diagrama.
 * @returns {Promise<{ niveles: object[], aprobadores: object[], esDemo: boolean }>}
 *          esDemo alimenta el aviso del Object Page.
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
            // Ascendente por fecha: si un mismo slot tuviera más de una fila
            // (una observación y luego la aprobación que la sustituye), la
            // fusión deja arriba la última, que es el estado vigente.
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
 * Fusiona el esqueleto esperado con las firmas que ECP confirma.
 *
 * La clave es NIVEL+ORDEN, que es justo lo que identifica el campo `Perfil` de
 * ECP. Cuando ECP habla de un nodo, su versión REEMPLAZA a la esperada: quién
 * firmó y cuándo lo dice Payroll, y el esqueleto no tiene voto sobre eso. Del
 * esqueleto sobreviven únicamente el rótulo del rol (`Cargo`), que no es un dato
 * de la firma sino de la columna, y los nodos que ECP no puede conocer porque
 * todavía no han ocurrido.
 *
 * Una fila real cuyo slot no esté en el esqueleto se añade igualmente: los datos
 * de ECP son la verdad, y descartarlos por no encajar en lo previsto escondería
 * precisamente el caso que hay que ver.
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
 * Cuántas firmas de apoderado exige el quórum —cuántas tarjetas tiene la columna
 * de apoderados— y quiénes de esas tarjetas ya están firmadas según BPA. Sin
 * contexto (mock local, $select liviano) se cae a las firmas por defecto del rol
 * y a ningún firmante conocido.
 *
 * `firmantes` es lo que permite que el esqueleto ya muestre CON IDENTIDAD al
 * apoderado que firmó vía apoderadoAprobar, en vez de una tarjeta genérica "En
 * curso": BPA sabe quién firmó (es la misma fuente que alimenta el campo "Ya
 * firmaron" del Object Page) aunque ECP todavía no haya confirmado esa firma.
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
 *
 * Función pura: mismas filas → mismo resultado. Es la que conviene ejercitar en
 * pruebas cuando el iFlow entregue datos reales y haya que verificar la topología.
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

    // Los niveles se derivan de los NODOS ya construidos, no de las filas crudas:
    // así el estado agregado de cada lane sale de los mismos `estadoNodo` que
    // pintan las tarjetas y no puede desincronizarse de ellas.
    return {
        niveles    : _derivarNiveles(nodos, instanceID),
        aprobadores: nodos,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NORMALIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lee un campo probando varias grafías.
 * CPI ha entregado históricamente PascalCase (PiBukrs, EpMensaje) mientras que
 * los mocks y HANA usan camelCase; aceptar ambas evita un mapeo frágil el día
 * que el iFlow se publique con una convención u otra.
 */
function _leer(fila, ...nombres) {
    for (const nombre of nombres) {
        const valor = fila?.[nombre];
        if (valor !== undefined && valor !== null && valor !== "") return valor;
    }
    return undefined;
}

/**
 * Convierte una fila cruda en la estructura interna de trabajo.
 *
 * Una fila vale si identifica a un FIRMANTE o una POSICIÓN. Lo segundo importa:
 * los nodos que todavía no han ocurrido —el liberador de una propuesta que sigue
 * en apoderados— existen en el diagrama sin que se sepa quién los ocupará. Se
 * dibujan con su rol y su estado, y sin persona; inventarles una sería afirmar
 * algo que el flujo aún no ha decidido.
 *
 * Se descarta solo lo que no es ni una cosa ni la otra: eso sí es ruido, y
 * colarlo desplazaría la numeración de los niveles.
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
 * Traduce una fila de EtDetalle (ECP) al MISMO formato crudo que produce
 * filasEsperadas(). Así los datos reales y el esqueleto son intercambiables: se
 * fusionan sin conversiones intermedias y atraviesan la misma normalización.
 *
 * Devuelve null si el `Perfil` no es un slot conocido: sin slot no hay posición
 * en el diagrama, y colocar la firma "donde sea" desplazaría a otra real.
 *
 * @param {object} fila - elemento de EtDetalle.item
 * @returns {object|null} fila cruda equivalente, o null si no es ubicable
 */
function _adaptarFilaEcp(fila) {
    const slot = PERFIL_PAYROLL[String(_leer(fila, "Perfil", "perfil") ?? "").trim()];
    if (!slot) return null;

    // ECP identifica al firmante por su usuario SAP ("ARODAS"), no por el correo
    // con el que trabajan BPA y CAP. Una firma sin firmante sí es ruido —al
    // contrario que un nodo pendiente, que legítimamente no tiene persona— y se
    // descarta: dejaría un slot marcado como firmado por nadie.
    const aprobador = String(_leer(fila, "Aprobador", "aprobador") ?? "").trim();
    if (!aprobador) return null;

    const status = String(_leer(fila, "Status", "status") ?? "").trim().toUpperCase();

    return {
        Nivel  : slot.nivel,
        Orden  : slot.orden,
        Perfil : slot.rol,
        Usuario: aprobador,
        // ECP no envía el nombre de la persona. Se deja vacío y el nodo muestra
        // el usuario SAP: es lo único que sabemos de quien firmó.
        Nombre     : "",
        Decision   : STATUS_ECP[status] ?? status,
        FechaAccion: _fechaEcpAIso(_leer(fila, "Erdat", "erdat"), _leer(fila, "Uzeit", "uzeit")),
        Comentario : "",
        FotoUrl    : "",
    };
}

/**
 * Fecha y hora de ECP → ISO 8601.
 * Llegan en campos separados ("2026-08-07" + "23:40:00") y sin zona horaria.
 * Se fija -05:00 porque Payroll graba en hora de Lima; sin ella, Node
 * interpretaría el valor en la zona del servidor y el nodo mostraría otra hora
 * en Cloud Foundry (UTC) que en un portátil.
 */
function _fechaEcpAIso(erdat, uzeit) {
    const dia = String(erdat ?? "").trim();
    if (!dia) return "";
    const hora = String(uzeit ?? "").trim() || "00:00:00";
    return `${dia}T${hora}-05:00`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTRUCCIÓN DEL GRAFO
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Arma un nodo del ProcessFlow a partir de una fila normalizada.
 * `hijos` queda vacío aquí: las aristas necesitan ver el conjunto completo y se
 * resuelven después en _enlazarNodos().
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
 * Calcula las aristas del diagrama.
 *
 * Regla: todo nodo de un nivel apunta a TODOS los nodos del siguiente nivel que
 * exista. Es lo que reproduce la forma del flujo real de nómina — los dos
 * apoderados firman en paralelo (dos nodos en la misma columna) y ambos
 * convergen en el liberador — sin que el iFlow tenga que enviar las aristas.
 *
 * El último nivel no tiene hijos y cierra el grafo.
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
 *
 * `posicion` DEBE ser 0-based y sin huecos: ProcessFlowLaneHeader lo exige y, si
 * llega salteada, el control emite onError y no dibuja nada. Por eso se usa el
 * índice del array y no el número de nivel del iFlow — que puede venir 1,2,5.
 */
function _derivarNiveles(nodos, instanceID) {
    const numerosNivel = [...new Set(nodos.map(n => n.nivel))].sort((a, b) => a - b);

    return numerosNivel.map((nivel, posicion) => {
        const delNivel = nodos.filter(n => n.nivel === nivel);

        // El rótulo de la columna lo da el perfil de sus firmantes. Si un nivel
        // mezclara perfiles (no ocurre en el flujo actual) manda el primero.
        const rolDelNivel = delNivel.find(n => n.rol)?.rol;
        const lane        = PERFILES_LANE[rolDelNivel] ?? LANE_POR_DEFECTO;
        const conteos     = _contarEstados(delNivel);

        return {
            instanceID,
            laneId     : `N${nivel}`,
            posicion,
            // El rótulo es el ROL del nivel ("Apoderados", "Liberador"), no un
            // "Nivel N" correlativo. El número no aportaba nada —la posición ya
            // se ve en el diagrama— y además engañaba: al ser la posición y no
            // el nivel del iFlow, un flujo sin nodo de analista rotulaba
            // "Nivel 1" la columna de los apoderados.
            texto      : lane.descripcion,
            descripcion: lane.descripcion,
            icono      : lane.icono,
            estadoTexto: _resumirEstados(conteos),
            resumen    : `${lane.descripcion} · ${_resumirEstados(conteos)}`,
        };
    });
}

/**
 * Cuenta cuántas firmas del nivel hay en cada estado.
 * Recorre ESTADOS_NIVEL —y no los nodos— para fijar el orden de los sectores.
 *
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

/**
 * Rótulo de la tarjeta, en MAYÚSCULAS.
 *
 * Todo el diagrama identifica a las personas por su usuario, no por su nombre:
 * ECP entrega el usuario SAP ya en mayúsculas ("ARODAS") y del lado de BPA lo
 * único disponible es la parte local del correo ("mbeas"). Sin normalizar, la
 * misma persona se veía en mayúsculas o en minúsculas según qué sistema hubiera
 * aportado el dato, y dos tarjetas contiguas del mismo flujo no parecían del
 * mismo tipo. Se unifica aquí, en el único punto por el que pasan todos los
 * nodos —esqueleto y firmas reales—, en vez de en cada origen.
 */
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

/**
 * Fecha de presentación en la convención peruana: dd/MM/yyyy HH:mm.
 *
 * La HORA es siempre la de Lima, no la del servidor. Importa: en Cloud Foundry
 * el proceso corre en UTC, así que sin fijar la zona una firma de las 23:40 de
 * Lima se mostraría como del día siguiente. ECP graba en hora de Perú y
 * _fechaEcpAIso le pone el -05:00 al leerla; aquí se cierra el círculo
 * volviendo a esa misma zona para presentarla.
 *
 * Se formatea en CAP y no en el frontend para que el texto del nodo sea idéntico
 * en la app, en un export y en cualquier consumidor futuro del mismo OData.
 */
function _formatearFecha(valor) {
    if (!valor) return "";
    const fecha = new Date(valor);
    if (Number.isNaN(fecha.getTime())) return "";

    const partes = new Intl.DateTimeFormat("es-PE", {
        timeZone: "America/Lima",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(fecha).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESQUELETO DEL FLUJO — los nodos que ECP no puede conocer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Nivel del diagrama en el que está cada rol del flujo H2H vigente:
 *
 *   1 Analista  →  2 Coordinador  →  3 Apoderados  →  4 Liberador
 *
 * Coincide con PERFIL_PAYROLL: es el mismo diagrama visto desde el otro lado.
 *
 * `coordinador` figura aunque su tarea siga anulada en BPA desde v1.1.0: si el
 * flujo volviera a activarla, su nivel ya está donde le corresponde y el
 * esqueleto no la haría caer en la columna de apoderados por defecto.
 *
 * Todos los apoderados comparten nivel: en BPA son un POOL sobre una única
 * tarea (quórum de 2 firmas desde v1.2.0), así que el diagrama los muestra
 * como columna de N tarjetas que converge en el liberador.
 */
const NIVEL_POR_ROL = { coordinador: 2, apoderado: 3, liberador: 4 };
const NIVEL_POR_DEFECTO = 3;   // sin tarea identificable, se asume en apoderados

/**
 * La forma que el flujo VA a tener, EN EL MISMO FORMATO CRUDO que produce
 * _adaptarFilaEcp. Es la mitad del historial que ECP no puede entregar: la
 * ESTRUCTURA — qué nodos hay, en qué columna y en qué estado —, nunca la
 * identidad de quien todavía no ha actuado.
 *
 * Aporta dos cosas:
 *   · el nivel 1 (registro en Payroll), que no es una aprobación y por tanto no
 *     está en EtDetalle;
 *   · los nodos que aún no han ocurrido — En curso y Pendiente — sin los cuales
 *     el ProcessFlow no sería un flujo sino una lista de firmas.
 *
 * ── Aquí NO se inventa un solo dato ──────────────────────────────────────────
 *
 * Los únicos usuarios que se pintan son los que la propuesta trae de Payroll
 * (quién registró el lote, y el liberador designado cuando es UNO SOLO). Un nodo
 * del que no se sabe la persona sale con su rol y su estado y SIN nombre: la
 * tarjeta muestra el ícono genérico, "Apoderado" y "Pendiente", que es
 * exactamente lo que se sabe de él. Rellenarlo con un candidato del pool o con un
 * nombre de ejemplo haría pasar por dato lo que es una suposición.
 *
 * ── Los estados NO son fijos ─────────────────────────────────────────────────
 *
 * Se derivan del `taskDefinitionId` que BPA tiene pendiente para esta tarea, que
 * es la MISMA fuente de la que salen los flags de rol (esApoderado/esLiberador) y,
 * por tanto, los botones del Object Page. Con estados fijos el diagrama se
 * contradecía con la pantalla: mostraba un apoderado "En curso" mientras los
 * botones de Liberación estaban visibles — cosa imposible, porque BPA solo enruta
 * la tarea del liberador cuando el quórum ya se alcanzó.
 *
 * La regla es la del flujo real:
 *   nivel < pendiente  → ya firmó        (el nivel 1 registra, no aprueba)
 *   nivel = pendiente  → en curso
 *   nivel > pendiente  → aún no le llega
 *
 * ── El nivel 2 son SLOTS, no miembros del pool ───────────────────────────────
 *
 * Se generan tantas tarjetas como firmas exija el quórum, no una por apoderado
 * habilitado. Es lo que hace que la fusión con ECP funcione: `Perfil` "1" y "2"
 * son exactamente esos slots. Con una tarjeta por miembro del pool, la firma del
 * cuarto apoderado de una lista de cinco caería sobre la tarjeta del primero.
 *
 * Y los slots sin firmante conocido van SIEMPRE sin persona. Quién los ocupará
 * no se sabe hasta que BPA registra su firma —y, con más certeza aún, hasta que
 * ECP la confirma—: inventar un nombre haría pasar por dato lo que es una
 * suposición. Los slots CON firmante conocido son la excepción: `firmantes` es
 * la misma lista que ya usa el campo "Ya firmaron" del Object Page (ver
 * perfiles.resolverQuorumApoderados), así que si BPA sabe que alguien firmó, el
 * diagrama lo dice también aunque ECP no lo haya confirmado todavía — pero con
 * Decision: "APROBADO_BPA" (ámbar), NUNCA "APROBADO" (verde): BPA cuenta la
 * firma apenas su ActionTask ZhrfApoReg responde, sin comprobar que Payroll la
 * haya aceptado, así que "BPA ya la contó" no es lo mismo que "Payroll la
 * validó". Cuando ECP sí confirme, _fusionar() reemplaza este dato provisional
 * por el suyo — verde si Payroll aceptó, rojo si la propia ECP la rechaza.
 *
 * @param {object} [propuesta]   - usuarios reales del contexto BPA
 * @param {string} [activityId]  - taskDefinitionId de la tarea BPA pendiente
 * @param {number} [requeridas]  - firmas que exige el quórum = tarjetas del nivel 2
 * @param {string[]} [firmantes] - correos de apoderados que BPA ya registra como firmados,
 *        en el mismo orden que resolverQuorumApoderados().firmantes
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
                // No "APROBADO": este dato viene solo de BPA, no de ECP. Ver el
                // comentario de APROBADO_BPA en DECISIONES.
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

    // El analista SÍ lleva usuario: no es una suposición, es lo que Payroll dejó
    // en la propuesta al arrancar el flujo. Si la propuesta no lo trae, el nodo
    // se queda sin persona en vez de rellenarse con un ejemplo.
    //
    // Es el usuario CREADOR de la propuesta —quien la armó en Payroll—, que es
    // lo que el nivel 1 representa. `analista` queda de respaldo: es el mismo
    // dato en los contextos que lo traen consolidado, y sin él la tarjeta se
    // quedaría sin persona en propuestas antiguas.
    const analista = p.usuarioCreacion || p.analista || p.correoAnalista || "";

    // El coordinador del diagrama es el REVISOR de la propuesta ("Revisado por"
    // en Payroll, DataType 1.4.8). Su paso no es una tarea de BPA —la del
    // coordinador está anulada desde v1.1.0— sino un hecho ya ocurrido cuando el
    // flujo llega a los apoderados, y por eso se pinta siempre resuelto.
    const revisor = p.usuarioRevisor || "";

    // El nivel 3 es UN nodo aunque haya VARIOS liberadores designados —Payroll
    // puede mandar usuarioLiberador como lista separada por comas—. El paso se
    // cierra con una sola liberación y ECP lo confirma en un único slot
    // (Perfil "3" → Nivel 3, Orden 1; ver PERFIL_PAYROLL): una tarjeta por
    // candidato diría que hacen falta N liberaciones, que es falso, y además
    // rompería la fusión, que empareja por Nivel+Orden.
    //
    // Con un solo designado la tarjeta lleva su nombre, que es un dato. Con
    // varios no se elige a ninguno —quién liberará no se sabe hasta que lo
    // haga— y el nodo va sin persona, igual que un slot de apoderado todavía
    // sin firmar. En cuanto ECP confirme la liberación, _fusionar() pone ahí al
    // firmante real.
    const liberadores = perfiles.normalizarUsuarios(p.usuarioLiberador);
    const liberador   = liberadores.length === 1 ? liberadores[0] : "";

    return [
        {
            Nivel: 1, Orden: 1,
            Usuario: analista,
            Nombre : _nombreDesdeCorreo(analista),
            Cargo  : "Analista de Nómina",
            Perfil : "AN",
            // El nivel 1 nunca está pendiente: si hay tarea en el flujo, la
            // propuesta ya fue registrada en Payroll. La FECHA de ese registro no
            // la conocemos —ECP no la devuelve— así que el nodo va sin ella.
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
            // Siempre resuelto, igual que el analista y por el mismo motivo: la
            // revisión ocurre en Payroll ANTES de que la propuesta entre al
            // flujo de firmas, así que si hay tarea que mirar es porque ya pasó.
            // Su FECHA no la conocemos —ECP no devuelve este paso— y el nodo va
            // sin ella, como el del analista.
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

/**
 * Nombre a partir del correo: "jlicetti@centria.net" → "jlicetti".
 *
 * No es un nombre real: el de la persona vive en Payroll y el iFlow del
 * historial NO lo devuelve —EtDetalle solo trae el usuario SAP—, así que en todo
 * el diagrama las tarjetas se rotulan con el identificador de la persona y no
 * con su nombre. La parte local identifica mejor que el correo entero, que la
 * tarjeta del ProcessFlow recorta por el medio.
 */
function _nombreDesdeCorreo(correo) {
    return String(correo ?? "").split("@")[0] || String(correo ?? "");
}

module.exports = {
    obtenerHistorial,
    construirDesdeFilas,
    filasEsperadas,
};
