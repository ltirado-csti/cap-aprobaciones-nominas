// =============================================================================
// srv/reasignacion-service.cds
//
// DEFINICIÓN de dominio: servicio de administración para reasignar el
// destinatario de una tarea de aprobación en curso (Apoderado1, Apoderado2
// o Liberador Final) a otro usuario, cuando el destinatario original no
// está disponible.
//
// NO contiene anotaciones @UI (viven en app/ui5-reasignacion/annotations.cds).
// NO contiene lógica de negocio (vive en reasignacion-service.js /
// domain/reasignacion.service.js).
//
// Acceso restringido a administradores — ver xs-security.json (scope
// "Administrador").
// =============================================================================

type AccionReasignacion {
    exito   : Boolean;
    mensaje : String;
};

@requires: 'Administrador'
service ReasignacionService @(path: '/nomina/reasignacion') {

    // =========================================================================
    // Entidad principal: TareasEnCurso
    // Tareas de aprobación en curso (READY o RESERVED) de TODOS los usuarios,
    // no solo del usuario autenticado — a diferencia de TareasInbox en
    // PagosService. Solo lectura + acción de reasignación.
    // Clave: instanceID = campo "id" de la API de tasks de BPA Workflow.
    // =========================================================================
    @readonly
    @cds.persistence.skip
    entity TareasEnCurso {
        // Clave única de la tarea BPA
        key instanceID          : String(255);

        tituloTarea              : String(255);
        numeroPropuesta          : String(20);
        sociedad                 : String(10);
        banco                    : String(50);
        importe                  : String(30);
        moneda                   : String(5);
        fechaPropuestaPago       : String(10);

        // Rol de la tarea — "Apoderado 1" | "Apoderado 2" | "Liberador Final"
        rolTarea                 : String(30);

        // Destinatario actual de la tarea (recipientUsers[0] en BPA)
        usuarioActual            : String(100);

        // READY | RESERVED
        estadoTarea              : String(20);

        // ID del proceso padre en BPA
        workflowInstanceId       : String(255);
    };

    // =========================================================================
    // Acción bound de TareasEnCurso
    // =========================================================================
    extend entity TareasEnCurso with actions {

        // Reemplaza el destinatario actual de la tarea por otro usuario.
        action reasignar(nuevoUsuario: String) returns AccionReasignacion;
    };
}
