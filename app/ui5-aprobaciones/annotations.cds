// =============================================================================
// app/ui5-aprobaciones/annotations.cds
// NOTA: todas las anotaciones de TareasInbox en un único bloque annotate
// para evitar que MDC PropertyHelper genere claves duplicadas al mergear.
// =============================================================================

using PagosService from '../../srv/pagos-service';

// =============================================================================
// TareasInbox — capabilities + UI en un único bloque
// =============================================================================
annotate PagosService.TareasInbox with @(

    Capabilities.DeleteRestrictions: { Deletable: false },
    // Capabilities.UpdateRestrictions: { Updatable: false },
    Capabilities.InsertRestrictions: { Insertable: false },

    UI.HeaderInfo: {
        TypeName      : 'Propuesta de Nómina',
        TypeNamePlural: 'Propuestas de Nómina',
        Title         : { Value: tituloTarea },
        Description   : { Value: numeroPropuesta },
    },

    UI.SelectionFields: [
        sociedad,
        banco,
        fechaPropuestaPago,
    ],

    // ── Columnas del List Report ──────────────────────────────────────────────
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: tituloTarea,        Label: 'Propuesta',  ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: importe,            Label: 'Importe',    ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: moneda,             Label: 'Moneda',     ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: banco,           Label: 'Banco',      ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: viaPago,         Label: 'Vía Pago',   ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: fechaPropuestaPago, Label: 'Fecha PP',   ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: analista,        Label: 'Analista',   ![@UI.Importance]: #High },

        // Flags de rol — ocultos, necesarios en $select para visibilidad de botones en Object Page
        { $Type: 'UI.DataField', Value: esApoderado1,  ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: esApoderado2,  ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: esApoderado,   ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: esLiberador,   ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: esCoordinador, ![@UI.Hidden]: true },
    ],

    // ── Botones del Object Page ───────────────────────────────────────────────
    // Botones de acción del Object Page.
    // ![@UI.Hidden] con expresiones dinámicas (//) fue eliminado:
    // causaba que Fiori Elements dejara el botón en estado interno bloqueado
    // impidiendo el dispatch aunque el botón fuera visible.
    // La autorización por rol se mantiene en el backend (_prepararAccion valida
    // taskDefinitionId desde BPA — anti-tampering garantizado).
    // TODO: reimplementar visibilidad por rol vía sap.fe Side Effects o
    // UI.Hidden estático una vez validado el flujo completo en QAS.
    UI.Identification: [
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.TareasInbox_apoderadoAprobar',  Label: 'Aprobar',      Criticality: #Positive  },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.TareasInbox_apoderadoObservar', Label: 'Observar',     Criticality: #Critical  },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.TareasInbox_liberadorLiberar',  Label: 'Liberar',      Criticality: #Positive  },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.TareasInbox_liberadorRechazar', Label: 'Rechazar',     Criticality: #Negative  },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.TareasInbox_liberadorAnular',   Label: 'Anular',       Criticality: #Negative  },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.TareasInbox_coordinadorAprobar',  Label: 'Aprobar (CO)',  ![@UI.Hidden]: true },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.TareasInbox_coordinadorRechazar', Label: 'Rechazar (CO)', ![@UI.Hidden]: true },
    ],

    // ── Header del Object Page ────────────────────────────────────────────────
    UI.HeaderFacets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#HeaderKPIs' },
    ],

    UI.FieldGroup#HeaderKPIs: {
        Data: [
            { $Type: 'UI.DataField', Value: estadoPP,          Label: 'Estado' },
            { $Type: 'UI.DataField', Value: importe,           Label: 'Importe' },
            { $Type: 'UI.DataField', Value: moneda,            Label: 'Moneda' },
            { $Type: 'UI.DataField', Value: fechaPropuestaPago,Label: 'Fecha PP' },
        ],
    },

    // ── Facetas del Object Page ───────────────────────────────────────────────
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'DatosGenerales', Label: 'Datos Generales',         Target: '@UI.FieldGroup#DatosGenerales' },
        { $Type: 'UI.ReferenceFacet', ID: 'Proveedores',    Label: 'Proveedores',              Target: 'proveedores/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Adjuntos',       Label: 'Adjuntos',                 Target: 'adjuntos/@UI.LineItem' },
        { $Type: 'UI.ReferenceFacet', ID: 'Aprobadores',    Label: 'Historial de Aprobaciones',Target: 'aprobadores/@UI.LineItem' },
    ],

    UI.FieldGroup#DatosGenerales: {
        Label: 'Datos Generales',
        Data : [
            { $Type: 'UI.DataField',        Value: sociedad,              Label: 'Sociedad' },
            { $Type: 'UI.DataField',        Value: numeroPropuesta,       Label: 'N° Propuesta' },
            { $Type: 'UI.DataField',        Value: version,               Label: 'Versión' },
            { $Type: 'UI.DataField',        Value: modalidadPP,           Label: 'Modalidad' },
            { $Type: 'UI.DataField',        Value: banco,                 Label: 'Banco' },
            { $Type: 'UI.DataField',        Value: viaPago,               Label: 'Vía Pago' },
            { $Type: 'UI.DataField',        Value: indicadorPagoAdelanto, Label: 'Ind. Adelanto' },
            { $Type: 'UI.DataField',        Value: existeDocumento,       Label: 'Existe Documento' },
            { $Type: 'UI.DataField',        Value: contadorFirma,         Label: 'N° Firmas' },
            { $Type: 'UI.DataField',        Value: analista,              Label: 'Analista' },
            { $Type: 'UI.DataField',        Value: usuarioCreacion,       Label: 'Creado por' },
            { $Type: 'UI.DataFieldWithUrl', Value: urlPDF, Url: urlPDF,  Label: 'PDF' },
        ],
    },
);

// =============================================================================
// Disponibilidad de acciones bound (controla si el botón está habilitado)
// =============================================================================
// annotate PagosService.TareasInbox actions {
//     apoderadoAprobar  @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esApoderado' } }, Common.Label: 'Aprobar'      );
//     apoderadoObservar @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esApoderado' } }, Common.Label: 'Observar'     );
//     liberadorLiberar  @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esLiberador' } }, Common.Label: 'Liberar'      );
//     liberadorRechazar @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esLiberador' } }, Common.Label: 'Rechazar'     );
//     liberadorAnular   @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esLiberador' } }, Common.Label: 'Anular'       );
//     coordinadorAprobar  @( Core.OperationAvailable: false, Common.Label: 'Aprobar (CO)'  );
//     coordinadorRechazar @( Core.OperationAvailable: false, Common.Label: 'Rechazar (CO)' );
// };
annotate PagosService.TareasInbox actions {
    apoderadoAprobar  @( Core.OperationAvailable: true, Common.Label: 'Aprobar'  );
    apoderadoObservar @( Core.OperationAvailable: true, Common.Label: 'Observar' );
    liberadorLiberar  @( Core.OperationAvailable: true, Common.Label: 'Liberar'  );
    liberadorRechazar @( Core.OperationAvailable: true, Common.Label: 'Rechazar' );
    liberadorAnular   @( Core.OperationAvailable: true, Common.Label: 'Anular'   );
    coordinadorAprobar  @( Core.OperationAvailable: false, Common.Label: 'Aprobar (CO)'  );
    coordinadorRechazar @( Core.OperationAvailable: false, Common.Label: 'Rechazar (CO)' );
};

// =============================================================================
// Proveedor
// =============================================================================
annotate PagosService.Proveedor with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: posicion,        Label: '#' },
        { $Type: 'UI.DataField', Value: nombreProveedor, Label: 'Proveedor' },
        { $Type: 'UI.DataField', Value: banco,           Label: 'Banco' },
        { $Type: 'UI.DataField', Value: cuentaBancaria,  Label: 'Cuenta' },
        { $Type: 'UI.DataField', Value: moneda,          Label: 'Moneda' },
        { $Type: 'UI.DataField', Value: importe,         Label: 'Importe' },
        { $Type: 'UI.DataField', Value: viaPago,         Label: 'Vía Pago' },
    ],
);

// =============================================================================
// Adjunto
// =============================================================================
annotate PagosService.Adjunto with @(
    UI.LineItem: [
        { $Type: 'UI.DataField',        Value: nombre,        Label: 'Documento' },
        { $Type: 'UI.DataField',        Value: tipoDocumento, Label: 'Tipo' },
        { $Type: 'UI.DataField',        Value: fechaCarga,    Label: 'Fecha' },
        { $Type: 'UI.DataFieldWithUrl', Value: nombre, Url: url, Label: 'Descargar' },
    ],
);

// =============================================================================
// Aprobador
// =============================================================================
annotate PagosService.Aprobador with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: orden,       Label: '#' },
        { $Type: 'UI.DataField', Value: usuario,     Label: 'Usuario' },
        { $Type: 'UI.DataField', Value: rol,         Label: 'Rol' },
        { $Type: 'UI.DataField', Value: decision,    Label: 'Decisión' },
        { $Type: 'UI.DataField', Value: comentario,  Label: 'Comentario' },
        { $Type: 'UI.DataField', Value: fechaAccion, Label: 'Fecha' },
    ],
);