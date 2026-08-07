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
        { $Type: 'UI.DataField', Value: estadoPP,           Label: 'Estado',     ![@UI.Importance]: #High,
          Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
        { $Type: 'UI.DataField', Value: importe,            Label: 'Importe',    ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: moneda,             Label: 'Moneda',     ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: banco,           Label: 'Banco',      ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: viaPago,         Label: 'Vía Pago',   ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: fechaPropuestaPago, Label: 'Fecha PP',   ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: analista,        Label: 'Analista',   ![@UI.Importance]: #High },

        // Rechazo de Payroll del intento anterior. Vacío en el caso normal; con
        // texto rojo cuando la tarea reapareció por el loop back de BPA, para
        // distinguirla sin abrir el detalle. Importance #Medium: se repliega
        // antes que las columnas críticas en pantallas angostas.
        { $Type: 'UI.DataField', Value: notifMensaje, Label: 'Rechazo Payroll', ![@UI.Importance]: #Medium,
          Criticality: notifCriticidad, CriticalityRepresentation: #WithIcon },

        // Acción masiva de la toolbar del List Report — reusa la bound action
        // apoderadoAprobar(). FE la invoca una vez por contexto seleccionado en
        // un $batch (selectionMode: Multi en el manifest). Su habilitación la
        // controla Core.OperationAvailable: { $Path: 'esApoderado' } más abajo.
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.apoderadoAprobar', Label: 'Aprobar masivo' },

        // Necesario en $select para que la columna de rechazo pinte su color
        { $Type: 'UI.DataField', Value: notifCriticidad, ![@UI.Hidden]: true },

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
    // Botones de acción del header del Object Page.
    // Referencia oficial SAP para acción bound: '<Servicio>.<NombreAcción>' (sin prefijo de entidad).
    //
    // Visibilidad por rol vía ![@UI.Hidden] dinámico ($edmJson/$Not/$Path):
    //   - Apoderado (esApoderado=true): ve Aprobar y Observar.
    //   - Liberador (esLiberador=true): ve Liberar, Rechazar y Anular.
    //   - Coordinador: anulado en v1.1.0 → ![@UI.Hidden]: true (constante).
    // Requiere que esApoderado/esLiberador estén en el $select del Object Page;
    // por eso se incluyen como campos ocultos en UI.FieldGroup#DatosGenerales.
    UI.Identification: [
        // Determining: true → botón en el footer del Object Page (no en la toolbar del header).
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.apoderadoAprobar',  Label: 'Aprobar',  Criticality: #Positive, IconUrl: 'sap-icon://accept', Determining: true,
          ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.apoderadoObservar', Label: 'Observar', Criticality: #Negative, IconUrl: 'sap-icon://message-warning', Determining: true,
          ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.liberadorLiberar',  Label: 'Liberar',  Criticality: #Positive, IconUrl: 'sap-icon://accept', Determining: true,
          ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esLiberador' }] } } },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.liberadorRechazar', Label: 'Rechazar', Criticality: #Negative, IconUrl: 'sap-icon://decline', Determining: true,
          ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esLiberador' }] } } },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.liberadorAnular',   Label: 'Anular',   Criticality: #Negative, IconUrl: 'sap-icon://cancel', Determining: true,
          ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esLiberador' }] } } },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.coordinadorAprobar',  Label: 'Aprobar (CO)',  ![@UI.Hidden]: true },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.coordinadorRechazar', Label: 'Rechazar (CO)', ![@UI.Hidden]: true },
    ],

    // ── Header del Object Page ────────────────────────────────────────────────
    UI.HeaderFacets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#HeaderKPIs' },
    ],

    UI.FieldGroup#HeaderKPIs: {
        Data: [
            // Criticality + CriticalityRepresentation → FE lo pinta como ObjectStatus
            // (color + ícono automático) en vez de texto plano.
            { $Type: 'UI.DataField', Value: estadoPP, Label: 'Estado',
              Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
            { $Type: 'UI.DataField', Value: importe,           Label: 'Importe' },
            { $Type: 'UI.DataField', Value: moneda,            Label: 'Moneda' },
            { $Type: 'UI.DataField', Value: fechaPropuestaPago,Label: 'Fecha PP' },

            // Motivo por el que Payroll rechazó el intento anterior. Solo aparece
            // cuando notifTieneError = true: si la tarea volvió al inbox por el loop
            // back de BPA, el usuario ve aquí POR QUÉ antes de volver a decidir.
            // ![@UI.Hidden] dinámico es seguro en un DataField — el problema
            // documentado más arriba era exclusivo de DataFieldForAction (botones).
            { $Type: 'UI.DataField', Value: notifMensaje, Label: 'Rechazo de Payroll',
              Criticality: notifCriticidad, CriticalityRepresentation: #WithIcon,
              ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'notifTieneError' }] } } },

            // Ocultos: fuerzan a estadoCriticidad / notifTieneError / notifCriticidad
            // a entrar al $select del Object Page (mismo motivo que esApoderado/
            // esLiberador en DatosGenerales). Sin esto el ![@UI.Hidden] dinámico
            // de arriba evaluaría contra undefined y ocultaría el mensaje siempre.
            { $Type: 'UI.DataField', Value: estadoCriticidad, ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: notifTieneError,  ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: notifCriticidad,  ![@UI.Hidden]: true },
        ],
    },

    // ── Facetas del Object Page ───────────────────────────────────────────────
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'DatosGenerales', Label: 'Datos Generales',         Target: '@UI.FieldGroup#DatosGenerales' },
        // Ocultas temporalmente a pedido de negocio (solo UI — la data y los
        // handlers de Proveedor/Adjunto en srv/ siguen intactos). Descomentar
        // para volver a mostrar las secciones en el Object Page.
        // { $Type: 'UI.ReferenceFacet', ID: 'Proveedores', Label: 'Proveedores', Target: 'proveedores/@UI.LineItem' },
        // { $Type: 'UI.ReferenceFacet', ID: 'Adjuntos',    Label: 'Adjuntos',    Target: 'adjuntos/@UI.LineItem' },
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
            // Flags de rol ocultos: NO se renderizan (![@UI.Hidden]: true) pero
            // fuerzan que esApoderado/esLiberador entren al $select del Object Page,
            // para que el ![@UI.Hidden] dinámico de los botones del header pueda evaluar.
            { $Type: 'UI.DataField', Value: esApoderado, ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: esLiberador, ![@UI.Hidden]: true },
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
    apoderadoAprobar  @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esApoderado' } }, Common.Label: 'Aprobar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    apoderadoObservar @( Core.OperationAvailable: true, Common.Label: 'Observar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    liberadorLiberar  @( Core.OperationAvailable: true, Common.Label: 'Liberar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    liberadorRechazar @( Core.OperationAvailable: true, Common.Label: 'Rechazar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    liberadorAnular   @( Core.OperationAvailable: true, Common.Label: 'Anular',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
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
        // Una sola columna para "nombre": DataFieldWithUrl ya lo muestra como link
        // clicable. Tener dos DataField distintos sobre el mismo Value ("nombre")
        // genera columnas con clave duplicada en el PropertyHelper de la tabla MDC.
        { $Type: 'UI.DataFieldWithUrl', Value: nombre, Url: url, Label: 'Documento' },
        { $Type: 'UI.DataField',        Value: tipoDocumento, Label: 'Tipo' },
        { $Type: 'UI.DataField',        Value: fechaCarga,    Label: 'Fecha' },
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