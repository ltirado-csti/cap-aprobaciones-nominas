"use strict";
/**
 * srv/domain/reasignacion.service.js
 *
 * Handler de la acción bound reasignar de TareasEnCurso (ReasignacionService).
 *
 * Reemplaza el destinatario (recipientUsers) de una tarea BPA en curso por
 * otro usuario, para los 3 roles activos: Apoderado1, Apoderado2, Liberador
 * Final. Pensado para cuando el destinatario original no está disponible.
 *
 * Principio anti-tampering (igual que aprobacion.service.js):
 *   - instanceID    → siempre de req.params    (nunca del body del cliente)
 *   - taskDefId     → releído de BPA, no del body — evita reasignar tareas
 *                     fuera del alcance de los 3 roles activos
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
 * @param {import('@sap/cds').ApplicationService} srv - instancia de ReasignacionService
 */
function registrarHandlers(srv) {

    srv.on("reasignar", "TareasEnCurso", async (req) => {
        // 1. Clave de la tarea desde los parámetros de ruta OData
        const instanceID = req.params?.[0]?.instanceID ?? req.params?.[0];
        if (!instanceID) {
            return req.reject(400, "Falta el identificador de tarea (instanceID)");
        }

        // 2. Validar el nuevo destinatario — único dato aceptado del cliente
        const nuevoUsuario = (req.data?.nuevoUsuario ?? "").trim();
        if (!nuevoUsuario) {
            return req.reject(400, "El nuevo usuario es obligatorio");
        }
        if (!REGEX_EMAIL.test(nuevoUsuario)) {
            return req.reject(400, `"${nuevoUsuario}" no es un correo válido`);
        }

        // 3. Releer la tarea en BPA y validar que sigue siendo un rol activo
        //    en alcance (Apoderado1, Apoderado2 o Liberador Final)
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
            return req.reject(403, "Esta tarea no corresponde a un rol reasignable (Apoderado 1, Apoderado 2 o Liberador Final)");
        }

        const usuarioAnterior = tareaBpa.recipientUsers?.[0] ?? "(desconocido)";

        if (usuarioAnterior === nuevoUsuario) {
            return req.reject(400, "El nuevo usuario es el mismo destinatario actual de la tarea");
        }

        // 4. Ejecutar la reasignación en BPA
        const resultado = await bpaClient.reasignarTarea(instanceID, nuevoUsuario);

        if (!resultado.success) {
            LOG.error(`reasignar ERROR | instanceID=${instanceID}`, resultado.mensaje);
            return req.reject(502, `No se pudo reasignar la tarea: ${resultado.mensaje}`);
        }

        // 5. Auditoría — quién reasignó qué tarea, de quién a quién
        LOG.info(
            `reasignar OK | admin=${req.user.id} instanceID=${instanceID} ` +
            `rol=${rolBpa.label} usuarioAnterior=${usuarioAnterior} nuevoUsuario=${nuevoUsuario}`
        );

        return { exito: true, mensaje: `Tarea reasignada de ${usuarioAnterior} a ${nuevoUsuario}` };
    });
}

module.exports = { registrarHandlers };
