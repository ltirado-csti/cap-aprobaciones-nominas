"use strict";
/**
 * Handler de la acción bound reasignar de Firmante (ReasignacionService).
 *
 * Sustituye a una persona en los destinatarios (recipientUsers) de una tarea
 * BPA en curso, para los dos roles activos: Apoderado y Liberador Final.
 * Los dos roles tienen un pool de destinatarios, así que se envía la lista
 * completa con el correo saliente cambiado por el entrante — nunca el
 * sustituto a secas, que dejaría la tarea con un único destinatario.
 *
 * Una reasignación completa requiere dos escrituras en BPA:
 *   1. PATCH de la TAREA (recipientUsers) — el sustituto ve la tarea ya mismo.
 *   2. PATCH del CONTEXTO de la instancia — la variable de la que BPA saca los
 *      destinatarios al crear la tarea (custom.apoderadospendientes en los
 *      apoderados, startEvent.propuesta.usuarioLiberador en el liberador).
 * Sin el paso 2, el sustituido reaparece en la app de reasignación (que
 * compone los firmantes desde el contexto) y el flujo lo recupera en el
 * siguiente loop back. El paso 2 no es crítico: si falla, el 1 ya surtió
 * efecto y se avisa al administrador.
 *
 * Principio anti-tampering (igual que aprobacion.service.js):
 *   - instanceID    → siempre de req.params    (nunca del body del cliente)
 *   - taskDefId     → releído de BPA, no del body
 *   - admin         → siempre de req.user.id   (XSUAA, no modificable)
 *   - nuevoUsuario  → único campo aceptado del cliente, validado
 *
 * bpaClient.reasignarTarea() requiere que la identidad detrás del destino
 * BPA_WORKFLOW tenga el role collection "WorkflowAdmin" en el subaccount de
 * Process Automation.
 */

const cds      = require("@sap/cds");
const perfiles = require("../config/perfiles");
const bpaClient = require("../infrastructure/bpa-client");

const LOG = cds.log("reasignacion-service");

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Escribe la reasignación en el contexto de la instancia (además de la tarea),
 * para que sea duradera: si el flujo hace loop back, BPA recrea la tarea desde
 * el contexto y una reasignación que solo tocó la tarea se deshace sola.
 *
 * Lee-modifica-escribe con el contexto entero: el PATCH de contexto sustituye
 * las ramas de primer nivel que recibe, así que se devuelve la rama completa
 * con una sola hoja cambiada. No crítica: si falla, la tarea ya quedó
 * reasignada y el sustituto puede trabajar.
 *
 * @param {string} workflowInstanceId - instancia de workflow de la tarea
 * @param {object} rolBpa             - rol de la tarea (resolverRolBpa())
 * @param {string[]} destinatarios    - lista completa ya sustituida
 * @returns {Promise<{ success: boolean, mensaje: string }>}
 */
async function _persistirEnContexto(workflowInstanceId, rolBpa, destinatarios) {
    if (!workflowInstanceId) {
        return { success: false, mensaje: "no se conoce la instancia de workflow de la tarea" };
    }

    const contexto = await bpaClient.leerContextoInstancia(workflowInstanceId);
    if (!contexto) {
        return { success: false, mensaje: "no se pudo leer el contexto de la instancia" };
    }

    // Dónde vive la lista de destinatarios según el rol: apoderados en
    // custom.apoderadospendientes (recalculado por BPA en cada firma);
    // liberador en startEvent.propuesta.usuarioLiberador (el CSV de Payroll,
    // que nadie más recalcula). La rama la decide campoPendientes.
    const ruta = rolBpa.campoPendientes
        ? _rutaCustom(contexto, rolBpa.campoPendientes)
        : `${rolBpa.contextPath}.${rolBpa.campoPropuesta}`;

    const valor = destinatarios.join(",");

    const parche = _parcheRuta(contexto, ruta, valor);
    if (!parche) {
        return { success: false, mensaje: `la ruta ${ruta} no existe en el contexto de la instancia` };
    }

    return bpaClient.actualizarContextoInstancia(workflowInstanceId, parche);
}

/**
 * Ruta de una variable personalizada, respetando cómo esté escrita en el
 * contexto real. Busca por comparación insensible a mayúsculas para no crear
 * una variable nueva si BPA la tiene con otra capitalización.
 */
function _rutaCustom(contexto, campo) {
    const custom = contexto?.custom;
    const claves = custom && typeof custom === "object" ? Object.keys(custom) : [];
    const real   = claves.find(clave => clave.toLowerCase() === String(campo).toLowerCase());
    return `custom.${real ?? campo}`;
}

/**
 * Devuelve la rama de primer nivel del contexto con una sola hoja cambiada,
 * lista para el PATCH. Clona antes de mutar. Devuelve null si la ruta no
 * existe en el contexto (no se crean ramas nuevas).
 *
 * @param {object} contexto - contexto completo de la instancia
 * @param {string} ruta     - ruta con puntos (ej. "custom.apoderadospendientes")
 * @param {any}    valor    - valor de la hoja
 * @returns {object|null} objeto con una clave de primer nivel, o null
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
 * Devuelve dos listas: `enTarea` (recipientUsers de la instancia de tarea —
 * quién la ve) y `pool` (unión con la lista del contexto — quién debería
 * poder firmar). Se usa la unión porque recipientUsers se fija al crear la
 * tarea y la variable del contexto la recalcula el BPMN en cada firma; una
 * reasignación anterior puede dejarlas desincronizadas.
 *
 * `recipientUsers` casi siempre llega vacío: es de filtro/escritura en la
 * Workflow Runtime API, pero el GET de detalle de tarea no lo devuelve.
 *
 * @returns {Promise<{ enTarea: string[], pool: string[] }>}
 */
async function _poolDeLaTarea(instanceID, tareaBpa, rolBpa) {
    const enTarea = perfiles.normalizarUsuarios(tareaBpa.recipientUsers);

    const contexto = await bpaClient.readContext(instanceID);
    if (!contexto) return { enTarea, pool: enTarea };

    const propuesta = _navegarRuta(contexto, rolBpa.contextPath) ?? {};

    const delContexto = perfiles.resolverDestinatarios(rolBpa, contexto, propuesta).pendientes;

    const pool = perfiles.normalizarUsuarios([...enTarea, ...delContexto]);

    LOG.info(
        `_poolDeLaTarea | instanceID=${instanceID} rol=${rolBpa.label} ` +
        `enTarea=${enTarea.join(",") || "(vacío)"} contexto=${delContexto.join(",")}`
    );

    return { enTarea, pool };
}

/** Navega un objeto JSON siguiendo una ruta con puntos ("startEvent.body"). */
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
 *        Resuelve el firmante (y con él su tarea BPA) desde la clave de la acción.
 */
function registrarHandlers(srv, { buscarFirmante }) {

    srv.on("reasignar", "Firmante", async (req) => {
        // 1. Clave del firmante (nunca del body); el cliente solo aporta el
        //    nuevo destinatario.
        const { propuestaID, firmanteID } = req.params?.[req.params.length - 1] ?? {};
        if (!propuestaID || !firmanteID) {
            return req.reject(400, "Falta la clave del firmante (propuesta y firmante)");
        }

        // 2. Resolver su tarea. Sin firma pendiente no hay nada que reasignar.
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

        // 4. Releer la tarea en BPA (el snapshot puede estar desactualizado) y
        //    validar que sigue siendo un rol activo en alcance.
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

        // 5. Componer las listas nuevas sustituyendo al saliente por el
        //    entrante, a partir del estado actual en BPA (no del snapshot).
        const { enTarea, pool } = await _poolDeLaTarea(instanceID, tareaBpa, rolBpa);
        const saliente = String(firmante.usuario ?? "").trim().toLowerCase();
        const entrante = nuevoUsuario.toLowerCase();

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
            LOG.warn(
                `reasignar | saliente fuera del pool | instanceID=${instanceID} ` +
                `saliente=${saliente} pool=${pool.join(",")}`
            );
            return req.reject(400,
                `${firmante.usuario} ya no es destinatario de esta tarea. ` +
                "Actualice la lista para ver el estado actual de la propuesta.");
        }

        // Sustituir donde esté, o añadir donde el saliente no figure (está en
        // el pool del contexto pero BPA nunca le dio la tarea).
        const sustituir = lista => lista.includes(saliente)
            ? lista.map(correo => (correo === saliente ? entrante : correo))
            : [...lista, entrante];

        // Dos escrituras, cada una con su lista: destinatarios → recipientUsers
        // de la tarea; pendientes → la variable del contexto.
        const destinatarios = sustituir(enTarea.length ? enTarea : pool);
        const pendientes    = sustituir(pool);

        // 6. Ejecutar la reasignación en BPA
        const resultado = await bpaClient.reasignarTarea(instanceID, destinatarios);

        if (!resultado.success) {
            LOG.error(`reasignar ERROR | instanceID=${instanceID}`, resultado.mensaje);
            return req.reject(502, `No se pudo reasignar la tarea: ${resultado.mensaje}`);
        }

        // 7. Hacer duradera la reasignación escribiendo el contexto de la
        //    instancia. No crítico: si falla, se avisa y se sigue.
        const persistencia = await _persistirEnContexto(
            firmante.workflowInstanceId, rolBpa, pendientes);

        if (!persistencia.success) {
            LOG.error(
                `reasignar | contexto NO actualizado | instanceID=${instanceID} ` +
                `workflowInstanceId=${firmante.workflowInstanceId} | ${persistencia.mensaje}`
            );
        }

        // 8. Auditoría
        LOG.info(
            `reasignar OK | admin=${req.user.id} propuesta=${propuestaID} instanceID=${instanceID} ` +
            `rol=${rolBpa.label} usuarioAnterior=${saliente} nuevoUsuario=${entrante} ` +
            `destinatarios=${destinatarios.join(",")}`
        );

        const base = destinatarios.length > 1
            ? `${rolBpa.label} reasignado de ${saliente} a ${entrante}. ` +
              `Los demás destinatarios de la tarea la conservan.`
            : `${rolBpa.label} reasignado de ${saliente} a ${entrante}`;

        const mensaje = persistencia.success
            ? base
            : `${base} Aviso: no se pudo actualizar el contexto del flujo, así que ` +
              `la reasignación podría perderse si el proceso vuelve a este paso.`;

        return { exito: true, mensaje };
    });
}

module.exports = { registrarHandlers };
