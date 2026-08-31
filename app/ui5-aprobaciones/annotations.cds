// Anotaciones @UI de TareasInbox en un único bloque annotate para evitar que
// MDC PropertyHelper genere claves duplicadas al mergear.

using PagosService from '../../srv/pagos-service';

annotate PagosService.TareasInbox with @(

    Capabilities.DeleteRestrictions: { Deletable: false },
    Capabilities.InsertRestrictions: { Insertable: false },

    UI.HeaderInfo: {
        TypeName      : 'Propuesta de Nómina',
        TypeNamePlural: 'Propuestas de Nómina',
        Title         : { Value: tituloTarea },
        Description   : { Value: numeroPropuesta },
    },

    // Filtros de la barra de filtros — el botón "Adaptar filtros" está oculto
    // (ver ext/controller/ListaHandler.controller.js), así que esta lista es
    // lo único con lo que el usuario puede filtrar. Se resuelve en memoria en
    // CAP (ver srv/infrastructure/odata-memoria.js).
    UI.SelectionFields: [
        sociedad,
        bancoDescripcion,
        fechaPropuestaPago,
        fechaPago,
        estadoPP,
    ],

    // ── Columnas del List Report ──────────────────────────────────────────────
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: tituloTarea,        Label: 'Propuesta',  ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: estadoPP,           Label: 'Estado',     ![@UI.Importance]: #High,
          Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
        // Importe ya formateado por CAP con la convención peruana: "S/ 43,038.69".
        { $Type: 'UI.DataField', Value: importeTexto,       Label: 'Importe',    ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: fechaPropuestaPago, Label: 'Fecha PP',   ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: fechaPago,          Label: 'Fecha Pago', ![@UI.Importance]: #High },

        // Rechazo de Payroll del intento anterior; vacío en el caso normal.
        { $Type: 'UI.DataField', Value: notifMensaje, Label: 'Rechazo Payroll', ![@UI.Importance]: #Medium,
          Criticality: notifCriticidad, CriticalityRepresentation: #WithIcon },

        // Estado del quórum de apoderados — "1 de 2 firmas". Vacío en las
        // tareas de liberación, que no tienen quórum.
        { $Type: 'UI.DataField', Value: firmasTexto, Label: 'Firmas', ![@UI.Importance]: #Medium },

        // Acciones masivas de la toolbar — dos botones (aprobar/rechazar) que
        // sirven a los dos roles del flujo, resolviendo la decisión BPA desde
        // el taskDefinitionId de cada tarea (ver domain/aprobacion.service.js).
        // Las acciones por rol viven en UI.Identification (footer del Object
        // Page), donde sí hay una tarea concreta.
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.aprobarMasivo',  Label: 'Aprobar masivo',
          Criticality: #Positive, IconUrl: 'sap-icon://accept' },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.rechazarMasivo', Label: 'Rechazar masivo',
          Criticality: #Negative, IconUrl: 'sap-icon://decline' },

        // Anular no se ofrece en masa: cierra el proceso sin loop back posible.

        // Necesario en $select para que la columna de rechazo pinte su color
        { $Type: 'UI.DataField', Value: notifCriticidad, ![@UI.Hidden]: true },

        // Flags de rol — ocultos, necesarios en $select para visibilidad de botones en Object Page.
        { $Type: 'UI.DataField', Value: esApoderado,   ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: esLiberador,   ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: esCoordinador, ![@UI.Hidden]: true },
    ],

    // ── Botones del footer del Object Page ────────────────────────────────────
    // Visibilidad por rol vía ![@UI.Hidden] dinámico ($edmJson/$Not/$Path):
    //   Apoderado (esApoderado=true): Aprobar y Rechazar.
    //   Liberador (esLiberador=true): Liberar, Rechazar y Anular.
    //   Coordinador: no activo → ![@UI.Hidden]: true (constante).
    // Requiere esApoderado/esLiberador en el $select (ver UI.FieldGroup#DatosGenerales).
    // La autorización real vive en el backend (_prepararAccion valida
    // taskDefinitionId desde BPA).
    UI.Identification: [
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.apoderadoAprobar',  Label: 'Aprobar',  Criticality: #Positive, IconUrl: 'sap-icon://accept', Determining: true,
          ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.apoderadoRechazar', Label: 'Rechazar', Criticality: #Negative, IconUrl: 'sap-icon://decline', Determining: true,
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
            { $Type: 'UI.DataField', Value: estadoPP, Label: 'Estado',
              Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
            { $Type: 'UI.DataField', Value: importeTexto,      Label: 'Importe' },
            { $Type: 'UI.DataField', Value: fechaPropuestaPago,Label: 'Fecha PP' },
            { $Type: 'UI.DataField', Value: fechaPago,         Label: 'Fecha Pago' },

            // Quórum de apoderados — solo en tareas de apoderado (firmasTexto llega vacío si no aplica).
            { $Type: 'UI.DataField', Value: firmasTexto, Label: 'Firmas',
              ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },

            // Motivo del rechazo de Payroll; visible solo si notifTieneError = true.
            { $Type: 'UI.DataField', Value: notifMensaje, Label: 'Rechazo de Payroll',
              Criticality: notifCriticidad, CriticalityRepresentation: #WithIcon,
              ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'notifTieneError' }] } } },

            // Ocultos: fuerzan a estos campos a entrar al $select para que los
            // ![@UI.Hidden] dinámicos de arriba puedan evaluar.
            { $Type: 'UI.DataField', Value: estadoCriticidad, ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: notifTieneError,  ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: notifCriticidad,  ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: esApoderado,      ![@UI.Hidden]: true },
        ],
    },

    // ── Facetas del Object Page ───────────────────────────────────────────────
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'DatosGenerales', Label: 'Datos Generales',         Target: '@UI.FieldGroup#DatosGenerales' },
        // Ocultas temporalmente a pedido de negocio (solo UI). Descomentar
        // para volver a mostrar las secciones en el Object Page.
        // { $Type: 'UI.ReferenceFacet', ID: 'Proveedores', Label: 'Proveedores', Target: 'proveedores/@UI.LineItem' },
        // { $Type: 'UI.ReferenceFacet', ID: 'Adjuntos',    Label: 'Adjuntos',    Target: 'adjuntos/@UI.LineItem' },

        // "Historial de Aprobaciones" no se declara aquí: es un diagrama de
        // flujo (sap.suite.ui.commons.ProcessFlow), que Fiori Elements no sabe
        // generar desde anotaciones. Se declara como sección personalizada en
        // manifest.json → TareasInboxObjectPage, anclada tras 'DatosGenerales'
        // (ID no debe renombrarse), con plantilla en
        // ext/fragment/HistorialProcessFlow.fragment.xml.
    ],

    UI.FieldGroup#DatosGenerales: {
        Label: 'Datos Generales',
        // Modalidad, N° Firmas y Analista salieron del formulario a pedido de
        // negocio; los campos siguen en TareasInbox y en pagos-service.js.
        Data : [
            { $Type: 'UI.DataField',        Value: sociedad,              Label: 'Sociedad' },
            { $Type: 'UI.DataField',        Value: numeroPropuesta,       Label: 'N° Propuesta' },
            { $Type: 'UI.DataField',        Value: version,               Label: 'Versión' },
         // { $Type: 'UI.DataField',        Value: modalidadPP,           Label: 'Modalidad' },
            // Grupo de personal: texto de negocio (ver srv/config/grupos-personal.js).
            { $Type: 'UI.DataField',        Value: grupoPersonal,         Label: 'Grupo Pers.' },
            { $Type: 'UI.DataField',        Value: bancoDescripcion,      Label: 'Banco' },
            { $Type: 'UI.DataField',        Value: existeDocumento,       Label: 'Existe Documento' },
         // { $Type: 'UI.DataField',        Value: contadorFirma,         Label: 'N° Firmas' },

            // Quórum de apoderados — ocultos en la tarea del liberador, donde
            // estos campos no aplican (ver _extraerQuorum en pagos-service.js).
            { $Type: 'UI.DataField',        Value: usuariosApoderados,    Label: 'Apoderados habilitados',
              ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },
            { $Type: 'UI.DataField',        Value: apoderadosFirmantes,   Label: 'Ya firmaron',
              ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },
            { $Type: 'UI.DataField',        Value: apoderadosPendientes,  Label: 'Firmas pendientes de',
              ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },

         // { $Type: 'UI.DataField',        Value: analista,              Label: 'Analista' },
            { $Type: 'UI.DataField',        Value: usuarioCreacion,       Label: 'Creado por' },
            { $Type: 'UI.DataField',        Value: usuarioRevisor,        Label: 'Revisado por' },
            { $Type: 'UI.DataField',        Value: cantidad,              Label: 'Cant. Registros' },
            // urlPDF no se declara aquí: el PDF se abre con sap.m.PDFViewer
            // desde el botón "Ver PDF" (manifest.json, ext/util/VisorPDF.js),
            // que lo pide con Context#requestProperty.
            // Flags de rol ocultos: fuerzan a esApoderado/esLiberador al
            // $select para que los botones del header puedan evaluar.
            { $Type: 'UI.DataField', Value: esApoderado, ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: esLiberador, ![@UI.Hidden]: true },
        ],
    },
);

// Etiquetas de los campos de la barra de filtros (annotate ... with { campo
// @anno } no cabe en el bloque UI de arriba). Sin esto la barra de filtros
// muestra el nombre técnico del campo como etiqueta.
annotate PagosService.TareasInbox with {
    sociedad           @Common.Label: 'Sociedad';
    bancoDescripcion   @Common.Label: 'Banco';
    fechaPropuestaPago @Common.Label: 'Fecha PP';
    fechaPago          @Common.Label: 'Fecha Pago';

    // Estado: MultiComboBox de valores fijos (ValueListWithFixedValues) en
    // vez de texto libre, para evitar comparar contra una cadena mal tildeada.
    // LocalDataProperty y ValueListProperty son ambos estadoPP porque la
    // clave de EstadosPropuesta es el texto, no un código.
    estadoPP @(
        Common.Label                   : 'Estado',
        Common.ValueListWithFixedValues: true,
        Common.ValueList               : {
            $Type         : 'Common.ValueListType',
            CollectionPath: 'EstadosPropuesta',
            Parameters    : [
                { $Type            : 'Common.ValueListParameterInOut',
                  LocalDataProperty: estadoPP,
                  ValueListProperty: 'estadoPP' }
            ]
        }
    );
};

// EstadosPropuesta — lista de valores del filtro "Estado". El color
// semántico (config/estados.js) se ve en la columna "Estado" de la lista y
// en la cabecera del Object Page; el MultiComboBox solo pinta texto.
annotate PagosService.EstadosPropuesta with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: estadoPP, Label: 'Estado',
          Criticality: criticidad, CriticalityRepresentation: #WithIcon },
    ],
);

annotate PagosService.EstadosPropuesta with {
    estadoPP   @Common.Label: 'Estado';
    criticidad @UI.Hidden;
};

// Disponibilidad de acciones bound (controla si el botón está habilitado).
annotate PagosService.TareasInbox actions {
    apoderadoAprobar  @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esApoderado' } }, Common.Label: 'Aprobar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    apoderadoRechazar @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esApoderado' } }, Common.Label: 'Rechazar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    liberadorLiberar  @( Core.OperationAvailable: true, Common.Label: 'Liberar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    liberadorRechazar @( Core.OperationAvailable: true, Common.Label: 'Rechazar',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    liberadorAnular   @( Core.OperationAvailable: true, Common.Label: 'Anular',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );

    // Acciones masivas: OperationAvailable en `true` porque sirven a los dos
    // roles activos; la autorización real la valida _prepararAccion contra BPA.
    aprobarMasivo     @( Core.OperationAvailable: true, Common.Label: 'Aprobar masivo',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    rechazarMasivo    @( Core.OperationAvailable: true, Common.Label: 'Rechazar masivo',
                          Common.SideEffects: { TargetEntities: ['/PagosService.EntityContainer/TareasInbox'] } );
    coordinadorAprobar  @( Core.OperationAvailable: false, Common.Label: 'Aprobar (CO)'  );
    coordinadorRechazar @( Core.OperationAvailable: false, Common.Label: 'Rechazar (CO)' );
};

// UI.MultiLineText hace que el Action Parameter Dialog estándar de Fiori
// Elements pinte el comentario como <TextArea> en vez de <Input>.
annotate PagosService.TareasInbox actions {
    apoderadoRechazar (
        comentario @( Common.Label: 'Comentario', UI.MultiLineText: true )
    );
};

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

annotate PagosService.Adjunto with @(
    UI.LineItem: [
        // Una sola columna: DataFieldWithUrl ya lo muestra como link clicable.
        { $Type: 'UI.DataFieldWithUrl', Value: nombre, Url: url, Label: 'Documento' },
        { $Type: 'UI.DataField',        Value: tipoDocumento, Label: 'Tipo' },
        { $Type: 'UI.DataField',        Value: fechaCarga,    Label: 'Fecha' },
    ],
);

// El Object Page no consume este LineItem (el historial se muestra como
// ProcessFlow); se conserva como vista tabular útil para depurar el iFlow.
annotate PagosService.Aprobador with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: nivel,         Label: 'Nivel' },
        { $Type: 'UI.DataField', Value: nombre,        Label: 'Aprobador' },
        { $Type: 'UI.DataField', Value: cargo,         Label: 'Cargo' },
        { $Type: 'UI.DataField', Value: usuario,       Label: 'Usuario' },
        { $Type: 'UI.DataField', Value: decisionTexto, Label: 'Decisión' },
        { $Type: 'UI.DataField', Value: comentario,    Label: 'Comentario' },
        { $Type: 'UI.DataField', Value: fechaTexto,    Label: 'Fecha' },
    ],
);
