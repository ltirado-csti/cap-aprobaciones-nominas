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
 * LIMITACIÓN CONOCIDA (lado BPA): el PATCH cambia recipientUsers de la
 * INSTANCIA de tarea, no la variable custom.apoderadospendientes de la que BPA
 * saca los destinatarios al recrearla. Si el flujo hace loop back —por un
 * rechazo de Payroll o al registrar la siguiente firma— la tarea se vuelve a
 * crear con la lista original y la reasignación se pierde. Hacerla duradera
 * exige escribir esa variable en la instancia, que la Workflow Runtime API no
 * expone para procesos en curso.
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

        // 5. Componer la nueva lista de destinatarios SUSTITUYENDO al saliente.
        //
        //    Se parte de los destinatarios que BPA tiene ahora mismo —no de los
        //    del snapshot— porque entre la lectura de la lista y esta llamada
        //    pudo firmar alguien y salir del pool. Reenviar una lista vieja le
        //    devolvería la tarea a quien ya firmó.
        const actuales = perfiles.normalizarUsuarios(tareaBpa.recipientUsers);
        const saliente = String(firmante.usuario ?? "").trim().toLowerCase();
        const entrante = nuevoUsuario.toLowerCase();

        if (actuales.includes(entrante)) {
            return req.reject(400, `${nuevoUsuario} ya es destinatario de esta tarea`);
        }
        if (!actuales.includes(saliente)) {
            // El saliente ya no está en la tarea: firmó, o lo reasignó otro
            // administrador mientras esta pantalla mostraba datos del snapshot.
            return req.reject(400,
                `${firmante.usuario} ya no es destinatario de esta tarea. ` +
                "Actualice la lista para ver el estado actual de la propuesta.");
        }

        const destinatarios = actuales.map(correo => (correo === saliente ? entrante : correo));

        // 6. Ejecutar la reasignación en BPA
        const resultado = await bpaClient.reasignarTarea(instanceID, destinatarios);

        if (!resultado.success) {
            LOG.error(`reasignar ERROR | instanceID=${instanceID}`, resultado.mensaje);
            return req.reject(502, `No se pudo reasignar la tarea: ${resultado.mensaje}`);
        }

        // 7. Auditoría — quién reasignó qué, de quién a quién, en qué propuesta
        LOG.info(
            `reasignar OK | admin=${req.user.id} propuesta=${propuestaID} instanceID=${instanceID} ` +
            `rol=${rolBpa.label} usuarioAnterior=${saliente} nuevoUsuario=${entrante} ` +
            `destinatarios=${destinatarios.join(",")}`
        );

        const mensaje = rolBpa.esPool
            ? `${rolBpa.label} reasignado de ${saliente} a ${entrante}. ` +
              `Los demás apoderados pendientes conservan su tarea.`
            : `${rolBpa.label} reasignado de ${saliente} a ${entrante}`;

        return { exito: true, mensaje };
    });
}

module.exports = { registrarHandlers };
