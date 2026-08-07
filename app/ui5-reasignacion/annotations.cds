// =============================================================================
// app/ui5-reasignacion/annotations.cds
// =============================================================================

using ReasignacionService from '../../srv/reasignacion-service';

// =============================================================================
// TareasEnCurso — capabilities + UI en un único bloque
// =============================================================================
annotate ReasignacionService.TareasEnCurso with @(

    Capabilities.DeleteRestrictions: { Deletable: false },
    Capabilities.UpdateRestrictions: { Updatable: false },
    Capabilities.InsertRestrictions: { Insertable: false },

    UI.HeaderInfo: {
        TypeName      : 'Tarea de Aprobación',
        TypeNamePlural: 'Tareas de Aprobación',
        Title         : { Value: tituloTarea },
        Description   : { Value: numeroPropuesta },
    },

    // Filtros — a diferencia de ui5-aprobaciones, aquí sí se muestra la
    // barra de filtros para que el admin pueda ubicar las tareas de un
    // usuario o rol específico.
    UI.SelectionFields: [
        sociedad,
        rolTarea,
        usuarioActual,
        estadoTarea,
    ],

    // ── Columnas del List Report ──────────────────────────────────────────────
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: tituloTarea,        Label: 'Propuesta',    ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: rolTarea,            Label: 'Rol',          ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: usuarioActual,       Label: 'Destinatario actual', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: sociedad,            Label: 'Sociedad' },
        { $Type: 'UI.DataField', Value: importe,             Label: 'Importe',      ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: moneda,              Label: 'Moneda' },
        { $Type: 'UI.DataField', Value: fechaPropuestaPago,  Label: 'Fecha PP' },
        { $Type: 'UI.DataField', Value: estadoTarea,         Label: 'Estado' },

        // Acción por fila (Inline: true la pone como botón dentro de la fila
        // en vez de como acción de toolbar que exige seleccionar filas primero).
        // Abre el diálogo de parámetro para nuevoUsuario, igual patrón que
        // apoderadoObservar(comentario) en ui5-aprobaciones.
        { $Type: 'UI.DataFieldForAction', Action: 'ReasignacionService.reasignar', Label: 'Reasignar', Inline: true },
    ],
);

// =============================================================================
// Disponibilidad de la acción bound (siempre habilitada — el backend ya
// filtra la lista a solo tareas reasignables de los 3 roles activos)
// =============================================================================
annotate ReasignacionService.TareasEnCurso actions {
    reasignar @( Core.OperationAvailable: true, Common.Label: 'Reasignar' );
};
