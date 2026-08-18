"use strict";
/**
 * srv/domain/reasignacion.service.js
 *
 * Handler de la acción bound reasignar de Firmante (ReasignacionService).
 *
 * Sustituye a una persona en los destinatarios (recipientUsers) de una tarea
 * BPA en curso, para los dos roles activos: Apoderado y Liberador Final.
 * Pensado para cuando el destinatario original no está disponible.
 *
 * ── SUSTITUIR, NO REEMPLAZAR ─────────────────────────────────────────────────
 *
 * Con el quórum de v1.2.0 la tarea de apoderado tiene un POOL de destinatarios.
 * Mandar a BPA el correo del sustituto a secas dejaría la tarea con un único
 * destinatario y expulsaría del flujo a los apoderados que todavía no habían
 * firmado. Por eso se envía la lista COMPLETA con el correo saliente cambiado
 * por el entrante: el pool conserva a los demás.
 *
 * ── DOS ESCRITURAS, NO UNA ───────────────────────────────────────────────────
 *
 * Reasignar de verdad son dos cambios en BPA, y hacen falta los dos:
 *
 *   1. PATCH de la TAREA (recipientUsers) — el sustituto ve la tarea ya mismo.
 *   2. PATCH del CONTEXTO de la instancia — la variable de la que BPA saca los
 *      destinatarios al CREAR la tarea (custom.apoderadospendientes en el pool,
 *      startEvent.propuesta.usuarioLiberador en el liberador).
 *
 * Sin el paso 2 la reasignación es un parche sobre una instancia de tarea: el
 * sustituido reaparece en la pantalla de reasignación y en el diagrama —que se
 * componen desde el contexto, porque la Workflow API no devuelve recipientUsers
 * al leer una tarea— y el flujo lo recupera en cuanto hace loop back por un
 * rechazo de Payroll o por la siguiente firma del quórum.
 *
 * El paso 2 no es crítico: si falla, el 1 ya surtió efecto y se avisa al
 * administrador de que el cambio puede no sobrevivir a un loop back.
 *
 * Principio anti-tampering (igual que aprobacion.service.js):
 *   - instanceID    → siempre de req.params    (nunca del body del cliente)
 *   - taskDefId     → releído de BPA, no del body — evita reasignar tareas
 *                     fuera del alcance de los roles activos
 *   - admin         → siempre de req.user.id   (XSUAA, no modificable)
 *   - nuevoUsuario  → único campo aceptado del cliente, validado
 *
 * IMPORTANTE: bpaClient.reasignarTarea() requiere que la identidad detrás
 * del destino BPA_WORKFLOW (no el destino en sí) tenga el role collection
 * "WorkflowAdmin" en el subaccount de Process Automation — ver notas de
 * verificación pendiente en infrastructure/bpa-client.js.
 */

const cds      = require("@sap/cds");
const perfiles = require("../config/perfiles");
const bpaClient = require("../infrastructure/bpa-client");

const LOG = cds.log("reasignacion-service");

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Escribe la reasignación en el CONTEXTO de la instancia, no solo en la tarea.
 *
 * EL PATCH DE LA TAREA NO BASTA
 * -----------------------------
 * bpaClient.reasignarTarea() cambia recipientUsers de la instancia de tarea que
 * está viva ahora. Eso es lo que hace que el sustituto vea la tarea de inmediato
 * —y funciona—, pero no toca las variables de las que BPA saca los destinatarios
 * cuando CREA la tarea. Mientras esas variables sigan con el sustituido:
 *
 *   · la app de reasignación lo sigue mostrando a él, en la lista y en el
 *     diagrama, porque compone los firmantes desde el contexto y no desde
 *     recipientUsers (que la Workflow API no devuelve al leer una tarea);
 *   · en cuanto el flujo hace loop back, BPA recrea la tarea desde la variable
 *     y la reasignación se deshace sola.
 *
 * Esta función cierra las dos cosas a la vez, que es lo que convierte la
 * reasignación en un cambio duradero en vez de un parche sobre una instancia.
 *
 * Es leer-modificar-escribir CON EL CONTEXTO ENTERO delante: el PATCH de
 * contexto sustituye las ramas de primer nivel que recibe, así que se devuelve
 * la rama completa con una sola hoja cambiada. Ver actualizarContextoInstancia.
 *
 * NO es crítica: si falla, la tarea ya quedó reasignada y el sustituto puede
 * trabajar. Se informa al administrador de que el cambio puede no sobrevivir a
 * un loop back, en vez de fingir un éxito completo o abortar algo ya hecho.
 *
 * @returns {Promise<{ success: boolean, mensaje: string }>}
 */
async function _persistirEnContexto(workflowInstanceId, rolBpa, entrante, destinatarios) {
    if (!workflowInstanceId) {
        return { success: false, mensaje: "no se conoce la instancia de workflow de la tarea" };
    }

    const contexto = await bpaClient.leerContextoInstancia(workflowInstanceId);
    if (!contexto) {
        return { success: false, mensaje: "no se pudo leer el contexto de la instancia" };
    }

    // Dónde vive el destinatario según el rol:
    //   pool      → custom.apoderadospendientes, CSV que el BPMN recalcula en
    //               cada firma y del que salen los destinatarios de la tarea.
    //   liberador → startEvent.propuesta.usuarioLiberador, un único correo.
    const ruta = rolBpa.esPool
        ? _rutaCustom(contexto, rolBpa.campoPendientes)
        : `${rolBpa.contextPath}.${rolBpa.campoPropuesta}`;

    const valor = rolBpa.esPool ? destinatarios.join(",") : entrante;

    const parche = _parcheRuta(contexto, ruta, valor);
    if (!parche) {
        return { success: false, mensaje: `la ruta ${ruta} no existe en el contexto de la instancia` };
    }

    return bpaClient.actualizarContextoInstancia(workflowInstanceId, parche);
}

/**
 * Ruta de una variable personalizada, respetando cómo esté escrita en el
 * contexto real.
 *
 * BPA expone `custom` en minúsculas y config/perfiles.js declara los nombres así,
 * pero se busca la clave por comparación insensible a mayúsculas antes de
 * componer la ruta: escribir "apoderadospendientes" cuando la instancia tiene
 * "apoderadosPendientes" no daría error, crearía una variable NUEVA que nadie
 * lee y dejaría la vieja intacta — un fallo silencioso, que es el peor de todos.
 */
function _rutaCustom(contexto, campo) {
    const custom = contexto?.custom;
    const claves = custom && typeof custom === "object" ? Object.keys(custom) : [];
    const real   = claves.find(clave => clave.toLowerCase() === String(campo).toLowerCase());
    return `custom.${real ?? campo}`;
}

/**
 * Devuelve la rama de PRIMER NIVEL del contexto con una sola hoja cambiada,
 * lista para el PATCH.
 *
 * Se clona antes de tocar nada: el contexto que llega es la respuesta de BPA y
 * mutarlo escondería el cambio en un objeto que otros pasos siguen leyendo.
 *
 * Devuelve null si la ruta no existe en el contexto —rama intermedia ausente o
 * que no es un objeto—. No se crean ramas: si la variable no está donde el rol
 * dice que debería, lo correcto es avisar, no inventarse una estructura que el
 * BPMN no lee.
 *
 * @param {object} contexto - contexto completo de la instancia
 * @param {string} ruta     - ruta con puntos (ej. "custom.apoderadospendientes")
 * @param {any}    valor    - valor de la hoja
 * @returns {object|null} objeto con UNA clave de primer nivel, o null
 */
function _parcheRuta(contexto, ruta, valor) {
    const claves = String(ruta ?? "").split(".").filter(Boolean);
    if (claves.length < 2 || !contexto || typeof contexto !== "object") return null;

    const raiz = claves[0];
    if (!contexto[raiz] || typeof contexto[raiz] !== "object") return null;

    const copia = structuredClone(contexto[raiz]);

    let nodo = copia;
    for (const clave of claves.slice(1, -1)) {
        nodo = nodo[clave];
        if (!nodo || typeof nodo !== "object") return null;
    }

    nodo[claves[claves.length - 1]] = valor;
    return { [raiz]: copia };
}

/**
 * Quién puede firmar todavía esta tarea, según BPA, ahora mismo.
 *
 * Devuelve DOS listas porque BPA tiene dos y no siempre coinciden:
 *
 *   enTarea → recipientUsers de la instancia de tarea. Es quien VE la tarea:
 *             el inbox de la app de aprobaciones filtra por este campo.
 *   pool    → la unión de esa lista con la del contexto
 *             (custom.apoderadospendientes en el pool,
 *             startEvent.propuesta.usuarioLiberador en el liberador). Es quien
 *             DEBERÍA poder firmar.
 *
 * POR QUÉ LA UNIÓN Y NO SOLO recipientUsers
 * -----------------------------------------
 * recipientUsers se fija al crear la tarea; apoderadospendientes lo recalcula el
 * BPMN en cada firma. Una reasignación anterior —o un loop back— deja a gente en
 * la segunda que no está en la primera: no ve la tarea, no puede firmar, y era
 * precisamente a quien había que reasignar. Validar contra recipientUsers a
 * secas le contestaba "ya no es destinatario de esta tarea" y dejaba la
 * propuesta bloqueada esperando a alguien incapaz de actuar.
 *
 * POR QUÉ recipientUsers CASI SIEMPRE LLEGA VACÍO AQUÍ
 * ---------------------------------------------------
 * `recipientUsers` es de FILTRO y de ESCRITURA en la Workflow Runtime API: va
 * como query param del GET de colección y en el cuerpo del PATCH, pero el
 * TaskInstance que devuelve GET /v1/task-instances/{id} no lo trae. Por eso el
 * contexto no es un respaldo excepcional sino la fuente habitual en este punto.
 *
 * @returns {Promise<{ enTarea: string[], pool: string[] }>}
 */
async function _poolDeLaTarea(instanceID, tareaBpa, rolBpa) {
    const enTarea = perfiles.normalizarUsuarios(tareaBpa.recipientUsers);

    const contexto = await bpaClient.readContext(instanceID);
    if (!contexto) return { enTarea, pool: enTarea };

    const propuesta = _navegarRuta(contexto, rolBpa.contextPath) ?? {};

    const delContexto = rolBpa.esPool
        ? perfiles.resolverQuorumApoderados(contexto, propuesta).pendientes
        : perfiles.normalizarUsuarios(propuesta[rolBpa.campoPropuesta]);

    const pool = perfiles.normalizarUsuarios([...enTarea, ...delContexto]);

    LOG.info(
        `_poolDeLaTarea | instanceID=${instanceID} rol=${rolBpa.label} ` +
        `enTarea=${enTarea.join(",") || "(vacío)"} contexto=${delContexto.join(",")}`
    );

    return { enTarea, pool };
}

/**
 * Navega un objeto JSON siguiendo una ruta con puntos ("startEvent.body").
 * Gemela de la de aprobacion.service.js: cada handler de dominio mantiene sus
 * helpers privados en vez de acoplarse al otro.
 */
function _navegarRuta(objeto, ruta) {
    return String(ruta ?? "").split(".").reduce(
        (acumulador, clave) => (acumulador != null ? acumulador[clave] : undefined),
        objeto
    );
}

/**
 * Registra el handler de la acción reasignar en el servicio CAP.
 *
 * @param {import('@sap/cds').ApplicationService} srv - instancia de ReasignacionService
 * @param {object} deps
 * @param {(propuestaID: string, firmanteID: string) => Promise<object|undefined>} deps.buscarFirmante
 *        Resuelve el firmante (y con él su tarea BPA) desde la clave de la
 *        acción. Se inyecta en vez de importarse porque quien sabe agrupar
 *        tareas en propuestas es reasignacion-service.js; este módulo se queda
 *        con la regla de negocio, igual que aprobacion.service.js.
 */
function registrarHandlers(srv, { buscarFirmante }) {

    srv.on("reasignar", "Firmante", async (req) => {
        // 1. Clave del firmante desde los parámetros de ruta OData.
        //    NUNCA del body: el cliente solo aporta el nuevo destinatario.
        //    La clave es firmanteID y no el rol: con el pool de apoderados un
        //    mismo rol tiene varias filas y el rol dejó de identificar a nadie.
        const { propuestaID, firmanteID } = req.params?.[req.params.length - 1] ?? {};
        if (!propuestaID || !firmanteID) {
            return req.reject(400, "Falta la clave del firmante (propuesta y firmante)");
        }

        // 2. Resolver su tarea. Un firmante sin firma pendiente no es
        //    reasignable: BPA crea la instancia de tarea cuando el flujo llega a
        //    ese paso, así que el liberador de una propuesta que sigue en
        //    apoderados no tiene nada que parchear; y un apoderado que ya firmó
        //    tampoco, aunque la tarea siga viva para sus compañeros. La UI ya lo
        //    muestra inactivo; esto cierra la puerta por si la acción se invoca
        //    directamente contra el servicio.
        const firmante = await buscarFirmante(propuestaID, firmanteID);
        if (!firmante) {
            return req.reject(404, `No se encontró el firmante ${firmanteID} de la propuesta ${propuestaID}`);
        }
        if (!firmante.reasignable || !firmante.instanceID) {
            return req.reject(400, firmante.motivoNoReasignable ||
                `${firmante.rol} no tiene una tarea en curso que se pueda reasignar`);
        }

        const instanceID = firmante.instanceID;

        // 3. Validar el nuevo destinatario — único dato aceptado del cliente
        const nuevoUsuario = (req.data?.nuevoUsuario ?? "").trim();
        if (!nuevoUsuario) {
            return req.reject(400, "El nuevo usuario es obligatorio");
        }
        if (!REGEX_EMAIL.test(nuevoUsuario)) {
            return req.reject(400, `"${nuevoUsuario}" no es un correo válido`);
        }

        // 4. Releer la tarea en BPA y validar que sigue siendo un rol activo
        //    en alcance (Apoderado1, Apoderado2 o Liberador Final).
        //    El firmante viene de un snapshot con TTL: releer aquí es lo que
        //    evita actuar sobre una tarea que ya se completó mientras tanto.
        let tareaBpa;
        try {
            tareaBpa = await bpaClient.obtenerTarea(instanceID);
        } catch (err) {
            LOG.error(`reasignar | obtenerTarea falló | instanceID=${instanceID}`, err.message);
            return req.reject(502, "No se pudo consultar la tarea en BPA Workflow");
        }

        if (!tareaBpa) {
            return req.reject(404, `No se encontró la tarea ${instanceID} en BPA`);
        }

        const taskDefId = (tareaBpa.definitionId || "").split("@")[0];
        const rolBpa    = perfiles.resolverRolBpa(taskDefId);

        if (!rolBpa || !rolBpa.activo) {
            LOG.error(`reasignar | rol inactivo o desconocido | taskDefId=${taskDefId}`);
            return req.reject(403, "Esta tarea no corresponde a un rol reasignable (Apoderado o Liberador Final)");
        }

        // 5. Componer las listas nuevas SUSTITUYENDO al saliente.
        //
        //    Se parte de lo que BPA tiene ahora mismo —no del snapshot— porque
        //    entre la lectura de la lista y esta llamada pudo firmar alguien y
        //    salir del pool. Reenviar una lista vieja le devolvería la tarea a
        //    quien ya firmó.
        const { enTarea, pool } = await _poolDeLaTarea(instanceID, tareaBpa, rolBpa);
        const saliente = String(firmante.usuario ?? "").trim().toLowerCase();
        const entrante = nuevoUsuario.toLowerCase();

        // Sin lista no hay sustitución posible: mandar solo al entrante dejaría
        // la tarea con un único destinatario y expulsaría al resto del pool.
        // Es un fallo de lectura contra BPA, no un cambio de estado de la tarea,
        // así que NO se puede reportar como "el saliente ya firmó".
        if (!pool.length) {
            LOG.error(`reasignar | destinatarios no resolubles | instanceID=${instanceID} rol=${rolBpa.label}`);
            return req.reject(502,
                "No se pudieron leer los destinatarios actuales de la tarea en BPA. " +
                "Vuelva a intentarlo en unos segundos.");
        }

        if (pool.includes(entrante)) {
            return req.reject(400, `${nuevoUsuario} ya es destinatario de esta tarea`);
        }
        if (!pool.includes(saliente)) {
            // Ni en los destinatarios de la tarea ni en el pool del contexto:
            // firmó, o lo reasignó otro administrador mientras esta pantalla
            // mostraba datos del snapshot. Se registran las dos listas: es la
            // única forma de distinguir en el log ese caso legítimo de un
            // desajuste entre lo que pinta la UI y lo que BPA tiene.
            LOG.warn(
                `reasignar | saliente fuera del pool | instanceID=${instanceID} ` +
                `saliente=${saliente} pool=${pool.join(",")}`
            );
            return req.reject(400,
                `${firmante.usuario} ya no es destinatario de esta tarea. ` +
                "Actualice la lista para ver el estado actual de la propuesta.");
        }

        // Sustituir donde esté, y AÑADIR donde el saliente no figure. El segundo
        // caso es real y es el que desbloquea la propuesta: el saliente está en
        // el pool del contexto pero BPA nunca le dio la tarea, así que en
        // recipientUsers no hay nada que reemplazar — lo que falta es que el
        // entrante entre en la lista de quien sí la ve.
        const sustituir = lista => lista.includes(saliente)
            ? lista.map(correo => (correo === saliente ? entrante : correo))
            : [...lista, entrante];

        // Las dos escrituras del paso 6 y 7, cada una con su lista:
        //   destinatarios → recipientUsers de la tarea (quién la ve)
        //   pendientes    → la variable del contexto  (quién debe firmar)
        // Se parte de `pool` cuando la API no devolvió recipientUsers, que es lo
        // habitual en el GET de detalle; el efecto secundario es deseable: las
        // dos listas quedan CONVERGIDAS después de cada reasignación, y la
        // divergencia que hacía falta arreglar deja de propagarse.
        const destinatarios = sustituir(enTarea.length ? enTarea : pool);
        const pendientes    = sustituir(pool);

        // 6. Ejecutar la reasignación en BPA
        const resultado = await bpaClient.reasignarTarea(instanceID, destinatarios);

        if (!resultado.success) {
            LOG.error(`reasignar ERROR | instanceID=${instanceID}`, resultado.mensaje);
            return req.reject(502, `No se pudo reasignar la tarea: ${resultado.mensaje}`);
        }

        // 7. Hacer duradera la reasignación escribiendo el contexto de la
        //    instancia. El paso 6 solo cambió la tarea viva; sin esto el
        //    sustituido reaparece en la pantalla y vuelve al flujo en el
        //    siguiente loop back. No es crítico: si falla, se avisa y se sigue.
        const persistencia = await _persistirEnContexto(
            firmante.workflowInstanceId, rolBpa, entrante, pendientes);

        if (!persistencia.success) {
            LOG.error(
                `reasignar | contexto NO actualizado | instanceID=${instanceID} ` +
                `workflowInstanceId=${firmante.workflowInstanceId} | ${persistencia.mensaje}`
            );
        }

        // 8. Auditoría — quién reasignó qué, de quién a quién, en qué propuesta
        LOG.info(
            `reasignar OK | admin=${req.user.id} propuesta=${propuestaID} instanceID=${instanceID} ` +
            `rol=${rolBpa.label} usuarioAnterior=${saliente} nuevoUsuario=${entrante} ` +
            `destinatarios=${destinatarios.join(",")}`
        );

        const base = rolBpa.esPool
            ? `${rolBpa.label} reasignado de ${saliente} a ${entrante}. ` +
              `Los demás apoderados pendientes conservan su tarea.`
            : `${rolBpa.label} reasignado de ${saliente} a ${entrante}`;

        // La advertencia va en el mensaje de éxito y no en un error: la tarea SÍ
        // quedó reasignada y el sustituto ya puede trabajar. Lo que el
        // administrador necesita saber es que el cambio puede deshacerse solo si
        // el flujo vuelve atrás, para que lo vigile en vez de darlo por cerrado.
        const mensaje = persistencia.success
            ? base
            : `${base} Aviso: no se pudo actualizar el contexto del flujo, así que ` +
              `la reasignación podría perderse si el proceso vuelve a este paso.`;

        return { exito: true, mensaje };
    });
}

module.exports = { registrarHandlers };
