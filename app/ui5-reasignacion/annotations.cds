// La unidad de trabajo es la propuesta, no la tarea: el List Report lista
// propuestas y el Object Page (columna media del FCL) es donde el
// administrador ve el flujo completo y reasigna el rol que corresponda.

using ReasignacionService from '../../srv/reasignacion-service';

annotate ReasignacionService.PropuestasEnCurso with @(

    Capabilities.DeleteRestrictions: { Deletable: false },
    Capabilities.UpdateRestrictions: { Updatable: false },
    Capabilities.InsertRestrictions: { Insertable: false },

    UI.HeaderInfo: {
        TypeName      : 'Propuesta',
        TypeNamePlural: 'Propuestas',
        Title         : { Value: grupoPropuesta },
        Description   : { Value: tituloTarea },
    },

    // Tres filtros y no cuatro: al pasar de tareas a propuestas, "Rol" y
    // "Estado" se funden (el estado de una propuesta es su punto en el
    // flujo). Se resuelven contra las tareas vivas de cada propuesta.
    // Etiquetas y value helps van en el bloque `annotate ... with { }` del final.
    UI.SelectionFields: [
        sociedad,
        destinatarios,
        estadoPropuesta,
    ],

    // ── Columnas del List Report ──────────────────────────────────────────────
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: grupoPropuesta,   Label: 'Propuesta',    ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: estadoPropuesta,  Label: 'Estado',       ![@UI.Importance]: #High,
          Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
        { $Type: 'UI.DataField', Value: destinatarios,    Label: 'Pendiente en', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: importeTexto,     Label: 'Importe',      ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: bancoDescripcion, Label: 'Banco' },
        { $Type: 'UI.DataField', Value: tituloTarea,      Label: 'Detalle',      ![@UI.Importance]: #Low },

        // Oculto: fuerza a estadoCriticidad al $select para que la columna Estado pinte su color.
        { $Type: 'UI.DataField', Value: estadoCriticidad, ![@UI.Hidden]: true },
    ],

    // ── Cabecera del Object Page ──────────────────────────────────────────────
    UI.HeaderFacets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Cabecera' },
    ],

    UI.FieldGroup#Cabecera: {
        Data: [
            { $Type: 'UI.DataField', Value: estadoPropuesta, Label: 'Estado',
              Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
            { $Type: 'UI.DataField', Value: importeTexto,      Label: 'Importe' },
            // Versiones ...Texto (dd/MM/yyyy): las fechas ISO viajan como
            // String (parte de la clave de la propuesta) y el cliente no las formatea.
            { $Type: 'UI.DataField', Value: fechaPPTexto,      Label: 'Fecha PP' },
            { $Type: 'UI.DataField', Value: fechaPagoTexto,    Label: 'Fecha Pago' },
            { $Type: 'UI.DataField', Value: tareasPendientes,  Label: 'Tareas pendientes' },
            // Quórum de apoderados — "1 de 2 firmas".
            { $Type: 'UI.DataField', Value: firmasTexto,       Label: 'Firmas' },
            { $Type: 'UI.DataField', Value: estadoCriticidad,  ![@UI.Hidden]: true },
        ],
    },

    // ── Secciones del Object Page ─────────────────────────────────────────────
    // El diagrama de flujo (ProcessFlow) no se declara aquí: va como sección
    // personalizada en manifest.json, anclada tras 'Firmantes' (ID no debe renombrarse).
    UI.Facets: [
        { $Type: 'UI.ReferenceFacet', ID: 'DatosGenerales', Label: 'Datos Generales',
          Target: '@UI.FieldGroup#DatosGenerales' },
        { $Type: 'UI.ReferenceFacet', ID: 'Firmantes',      Label: 'Firmantes',
          Target: 'firmantes/@UI.LineItem' },
    ],

    UI.FieldGroup#DatosGenerales: {
        Label: 'Datos Generales',
        Data : [
            { $Type: 'UI.DataField', Value: sociedad,           Label: 'Sociedad' },
            { $Type: 'UI.DataField', Value: numeroPropuesta,    Label: 'N° Propuesta' },
            { $Type: 'UI.DataField', Value: fechaPPTexto,       Label: 'Fecha PP' },
            { $Type: 'UI.DataField', Value: fechaPagoTexto,     Label: 'Fecha Pago' },
            // Grupo de personal: texto de negocio (srv/config/grupos-personal.js).
            { $Type: 'UI.DataField', Value: grupoPersonal,      Label: 'Grupo Pers.' },
            { $Type: 'UI.DataField', Value: bancoDescripcion,   Label: 'Banco' },
            { $Type: 'UI.DataField', Value: importeTexto,       Label: 'Importe' },
            { $Type: 'UI.DataField', Value: tituloTarea,        Label: 'Detalle' },
        ],
    },
);

// Firmantes — la tabla desde la que se reasigna. Una fila por persona, no
// por rol: 'Apoderado' aparece tantas veces como apoderados tenga la lista,
// cada uno con su estado y su propio botón.
annotate ReasignacionService.Firmante with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: rol,            Label: 'Rol',          ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: usuario,        Label: 'Destinatario', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: estadoFirmante, Label: 'Estado',       ![@UI.Importance]: #High,
          Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },

        // Motivo por el que un firmante no se puede reasignar, a la vista.
        // #High es necesario: sin importancia declarada, la ResponsiveTable
        // repliega la columna y el botón Reasignar deja de existir en el DOM.
        { $Type: 'UI.DataField', Value: motivoNoReasignable, Label: 'Observación',
          ![@UI.Importance]: #High },

        // Core.OperationAvailable la deja activa solo donde hay tarea viva (ver `actions` abajo).
        { $Type: 'UI.DataFieldForAction', Action: 'ReasignacionService.reasignar',
          Label: 'Reasignar', Inline: true, Criticality: #Positive,
          ![@UI.Importance]: #High },

        // Ocultos, necesarios en el $select para color y OperationAvailable por fila.
        { $Type: 'UI.DataField', Value: estadoCriticidad, ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: reasignable,      ![@UI.Hidden]: true },
    ],

    // Orden del flujo (apoderados y luego liberación), no alfabético del rol.
    UI.PresentationVariant: {
        SortOrder     : [
            { Property: nivel,   Descending: false },
            { Property: usuario, Descending: false },
        ],
        Visualizations: ['@UI.LineItem'],
    },
);

annotate ReasignacionService.Firmante with {
    rol                 @Common.Label: 'Rol';
    usuario             @Common.Label: 'Destinatario';
    estadoFirmante      @Common.Label: 'Estado';
    motivoNoReasignable @Common.Label: 'Observación';
    instanceID          @Common.Label: 'Tarea BPA';
    contadorFirmas      @Common.Label: 'Firmas registradas';
    firmasRequeridas    @Common.Label: 'Firmas requeridas';
    firmanteID          @UI.Hidden;
};

// `in/reasignable` evita que el botón se pueda pulsar cuando la persona no
// tiene firma pendiente (el backend igual lo rechaza — ver
// domain/reasignacion.service.js). Es por persona, no por tarea.
annotate ReasignacionService.Firmante actions {
    reasignar @( Core.OperationAvailable: { $edmJson: { $Path: 'in/reasignable' } },
                 Common.Label: 'Reasignar',

                 // La acción devuelve un tipo plano (AccionReasignacion), no
                 // la entidad, así que hace falta declarar qué refrescar.
                 // TargetProperties cubre la propia fila; TargetEntities
                 // cubre Firmante entero (la reasignación cambia la clave de
                 // la fila, que incluye el correo) y el diagrama
                 // (NivelFlujo/NodoFlujo), que se compone de los mismos firmantes.
                 Common.SideEffects: {
                     TargetProperties: [
                         'in/usuario',
                         'in/estadoFirmante',
                         'in/estadoCriticidad',
                         'in/reasignable',
                         'in/motivoNoReasignable',
                         'in/instanceID',
                         'in/estadoTarea',
                     ],
                     TargetEntities  : [
                         '/ReasignacionService.EntityContainer/Firmante',
                         '/ReasignacionService.EntityContainer/NivelFlujo',
                         '/ReasignacionService.EntityContainer/NodoFlujo',
                         '/ReasignacionService.EntityContainer/PropuestasEnCurso',
                     ],
                 } ) (
        nuevoUsuario @( Common.Label: 'Nuevo destinatario' )
    );
};

// Etiquetas y value helps de la barra de filtros. Sociedades/Usuarios/Estados
// se resuelven en srv/reasignacion-service.js sobre el mismo snapshot que la
// lista; Roles es dominio cerrado y se renderiza como desplegable fijo.
annotate ReasignacionService.PropuestasEnCurso with {

    grupoPropuesta  @Common.Label: 'Propuesta';
    tituloTarea     @Common.Label: 'Detalle';
    numeroPropuesta @Common.Label: 'N° Propuesta';
    banco            @Common.Label: 'Banco';
    bancoDescripcion @Common.Label: 'Banco';
    grupoPersonal    @Common.Label: 'Grupo Pers.';
    importe         @Common.Label: 'Importe';
    importeTexto    @Common.Label: 'Importe';
    moneda          @Common.Label: 'Moneda';
    fechaPropuestaPago @Common.Label: 'Fecha PP';
    fechaPago          @Common.Label: 'Fecha Pago';
    fechaPPTexto       @Common.Label: 'Fecha PP';
    fechaPagoTexto     @Common.Label: 'Fecha Pago';
    tareasPendientes   @Common.Label: 'Tareas pendientes';
    firmasTexto        @Common.Label: 'Firmas';
    contadorFirmas     @Common.Label: 'Firmas registradas';
    firmasRequeridas   @Common.Label: 'Firmas requeridas';

    sociedad @(
        Common.Label    : 'Sociedad',
        Common.ValueList: {
            $Type          : 'Common.ValueListType',
            CollectionPath : 'Sociedades',
            Label          : 'Sociedades con tareas en curso',
            SearchSupported: true,
            Parameters     : [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: sociedad, ValueListProperty: 'sociedad' },
            ],
        }
    );

    // destinatarios es multivalor (varias personas pendientes a la vez); el
    // servicio trata la igualdad sobre este campo como "está entre" (ver
    // _conFiltroMultivalor en srv/reasignacion-service.js).
    destinatarios @(
        Common.Label    : 'Destinatario',
        Common.ValueList: {
            $Type          : 'Common.ValueListType',
            CollectionPath : 'Usuarios',
            Label          : 'Destinatarios con tareas en curso',
            SearchSupported: true,
            Parameters     : [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: destinatarios, ValueListProperty: 'usuarioActual' },
            ],
        }
    );

    estadoPropuesta @(
        Common.Label    : 'Estado',
        Common.ValueListWithFixedValues: true,
        Common.ValueList: {
            $Type         : 'Common.ValueListType',
            CollectionPath: 'Estados',
            Label         : 'Estado de la propuesta',
            Parameters    : [
                { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: estadoPropuesta, ValueListProperty: 'estadoPropuesta' },
            ],
        }
    );
};

annotate ReasignacionService.Sociedades with {
    sociedad @Common.Label: 'Sociedad';
};

annotate ReasignacionService.Usuarios with {
    usuarioActual @Common.Label: 'Destinatario';
};

// Estados de PROPUESTA ('Pendiente de Apoderados' / 'Pendiente de
// Liberación'), no los de tarea: es lo que se filtra en esta pantalla.
annotate ReasignacionService.Estados with {
    estadoPropuesta @Common.Label: 'Estado';
};
