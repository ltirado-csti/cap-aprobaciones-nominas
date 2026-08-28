// =============================================================================
// app/ui5-reasignacion/annotations.cds
//
// La unidad de trabajo es la PROPUESTA, no la tarea: el List Report lista
// propuestas y el Object Page (columna media del FCL) es donde el administrador
// ve el flujo completo y reasigna el rol que corresponda.
// =============================================================================

using ReasignacionService from '../../srv/reasignacion-service';

// =============================================================================
// PropuestasEnCurso — List Report + Object Page
// =============================================================================
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

    // ── Filtros ───────────────────────────────────────────────────────────────
    // Tres y no cuatro: al pasar de tareas a propuestas, "Rol" y "Estado" se
    // funden. El estado de una propuesta ES el punto del flujo en el que está
    // ("Pendiente de Apoderados" / "Pendiente de Liberación"), así que un filtro
    // de rol aparte no distinguiría nada que este no distinga ya.
    //
    // Se resuelven contra las tareas VIVAS de cada propuesta: filtrar por un
    // destinatario devuelve las propuestas en las que esa persona tiene algo
    // pendiente ahora mismo.
    //
    // Las etiquetas y las ayudas de búsqueda (F4) se declaran en el bloque
    // `annotate ... with { }` del final: la barra de filtros lee @Common.Label y
    // @Common.ValueList del ELEMENTO, no de esta lista.
    UI.SelectionFields: [
        sociedad,
        destinatarios,
        estadoPropuesta,
    ],

    // ── Columnas del List Report ──────────────────────────────────────────────
    // Una fila por propuesta: caben pocas columnas y todas dicen algo. El detalle
    // (firmantes, diagrama) vive en el Object Page, que es justo el motivo de
    // haber dejado de listar tareas.
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: grupoPropuesta,   Label: 'Propuesta',    ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: estadoPropuesta,  Label: 'Estado',       ![@UI.Importance]: #High,
          Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
        { $Type: 'UI.DataField', Value: destinatarios,    Label: 'Pendiente en', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: importeTexto,     Label: 'Importe',      ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: banco,            Label: 'Banco' },
        { $Type: 'UI.DataField', Value: tituloTarea,      Label: 'Detalle',      ![@UI.Importance]: #Low },

        // Oculto: fuerza a estadoCriticidad al $select para que la columna Estado
        // pinte su color. Mismo patrón que notifCriticidad en ui5-aprobaciones.
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
            { $Type: 'UI.DataField', Value: fechaPropuestaPago,Label: 'Fecha PP' },
            { $Type: 'UI.DataField', Value: fechaPago,         Label: 'Fecha Pago' },
            { $Type: 'UI.DataField', Value: tareasPendientes,  Label: 'Tareas pendientes' },
            // Quórum de apoderados — "1 de 2 firmas". Responde de un vistazo
            // por qué la propuesta sigue en el nivel de apoderados: con el pool
            // de v1.2.0, el número de tareas vivas ya no lo dice (una sola tarea
            // puede tener tres destinatarios y ninguna firma).
            { $Type: 'UI.DataField', Value: firmasTexto,       Label: 'Firmas' },
            { $Type: 'UI.DataField', Value: estadoCriticidad,  ![@UI.Hidden]: true },
        ],
    },

    // ── Secciones del Object Page ─────────────────────────────────────────────
    //
    // El diagrama de flujo NO se declara aquí: es un sap.suite.ui.commons.ProcessFlow,
    // que Fiori Elements no sabe generar desde anotaciones. Va como sección
    // personalizada en manifest.json, anclada después de 'Firmantes'.
    // Por eso ese ID es significativo — no renombrarlo.
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
            { $Type: 'UI.DataField', Value: fechaPropuestaPago, Label: 'Fecha PP' },
            { $Type: 'UI.DataField', Value: fechaPago,          Label: 'Fecha Pago' },
            { $Type: 'UI.DataField', Value: banco,              Label: 'Banco' },
            { $Type: 'UI.DataField', Value: importeTexto,       Label: 'Importe' },
            { $Type: 'UI.DataField', Value: tituloTarea,        Label: 'Detalle' },
        ],
    },
);

// =============================================================================
// Firmantes — la tabla desde la que se reasigna
//
// Desde el quórum de BPA v1.2.0 hay UNA FILA POR PERSONA, no por rol: el rol
// 'Apoderado' aparece repetido tantas veces como apoderados tenga la lista, cada
// uno con su estado (firmó / pendiente) y su propio botón. Reasignar una de esas
// filas sustituye a esa persona dentro del pool de destinatarios de la tarea,
// sin tocar a las demás.
// =============================================================================
annotate ReasignacionService.Firmante with @(
    UI.LineItem: [
        { $Type: 'UI.DataField', Value: rol,            Label: 'Rol',          ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: usuario,        Label: 'Destinatario', ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: estadoFirmante, Label: 'Estado',       ![@UI.Importance]: #High,
          Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },

        // El motivo por el que un firmante NO se puede reasignar, a la vista y no
        // solo en el tooltip: es la pregunta que se hace el administrador al ver
        // el botón apagado.
        //
        // #High en esta columna y en la acción NO es decorativo: sin importancia
        // declarada la ResponsiveTable las repliega al área de pop-in, y el
        // Object Page arranca con "Ocultar detalles" activo — el resultado era
        // una tabla que llegaba hasta Estado y ningún botón Reasignar en el DOM,
        // aunque los controles existieran con su `enabled` correcto.
        { $Type: 'UI.DataField', Value: motivoNoReasignable, Label: 'Observación',
          ![@UI.Importance]: #High },

        // Acción por fila. Core.OperationAvailable la deja activa solo donde hay
        // tarea viva en BPA — ver el bloque `actions` de más abajo.
        { $Type: 'UI.DataFieldForAction', Action: 'ReasignacionService.reasignar',
          Label: 'Reasignar', Inline: true, Criticality: #Positive,
          ![@UI.Importance]: #High },

        // Ocultos, necesarios en el $select: estadoCriticidad para el color y
        // reasignable para que OperationAvailable pueda evaluarse por fila.
        { $Type: 'UI.DataField', Value: estadoCriticidad, ![@UI.Hidden]: true },
        { $Type: 'UI.DataField', Value: reasignable,      ![@UI.Hidden]: true },
    ],

    // Orden del flujo (apoderados y luego liberación), no alfabético del rol.
    // El segundo criterio importa desde que un rol tiene varias filas: sin él,
    // los apoderados salían en un orden que cambiaba entre refrescos.
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

// =============================================================================
// Disponibilidad de la acción
//
// `in/reasignable` es la clave: el backend ya rechaza los firmantes sin firma
// pendiente (ver domain/reasignacion.service.js), pero esto evita que el botón
// siquiera se pueda pulsar. El motivo se ve en la columna Observación.
//
// En el pool de apoderados `reasignable` es por PERSONA, no por tarea: los que
// ya firmaron salen con el botón apagado aunque la tarea siga viva para el resto.
// =============================================================================
annotate ReasignacionService.Firmante actions {
    reasignar @( Core.OperationAvailable: { $edmJson: { $Path: 'in/reasignable' } },
                 Common.Label: 'Reasignar',

                 // ── QUÉ REFRESCAR AL TERMINAR ────────────────────────────────
                 //
                 // Sin esto la pantalla se queda con el destinatario anterior
                 // hasta que el usuario recarga a mano: la acción devuelve un
                 // tipo plano (AccionReasignacion), no la entidad, así que Fiori
                 // Elements no tiene nada que volver a leer por su cuenta.
                 //
                 // El prefijo es `in` —el nombre del parámetro de enlace que CAP
                 // genera para las acciones bound, el mismo que ya usa
                 // OperationAvailable aquí arriba—. Con `_it` la anotación
                 // compila igual y no refresca nada.
                 //
                 // TargetProperties cubre las columnas de la propia fila, que es
                 // lo que basta cuando la reasignación no cambia su clave.
                 //
                 // TargetEntities cubre lo que TargetProperties no puede: en los
                 // dos roles la clave de la fila incluye el correo
                 // ('apoderado#<correo>', 'liberador#<correo>'), así que
                 // reasignar no modifica una fila sino que borra una y crea otra
                 // — hay que releer la colección entera. Y NivelFlujo/NodoFlujo
                 // son el diagrama de flujo, que se compone de los mismos
                 // firmantes y quedaba igual de obsoleto.
                 // PropuestasEnCurso entra porque su columna "Destinatario" es la
                 // lista de destinatarios vivos de la propuesta.
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

// =============================================================================
// Etiquetas y ayudas de búsqueda de los campos de la barra de filtros
//
// SIN @Common.Label la barra muestra el nombre técnico del campo.
//
// SIN @Common.ValueList el único auxilio de Fiori Elements es el diálogo de
// "definir condiciones": el admin tendría que escribir de memoria el código de
// sociedad o el correo exacto, y una letra de más devuelve una lista vacía sin
// decir por qué. Las cuatro colecciones se resuelven en
// srv/reasignacion-service.js sobre el mismo snapshot que la lista.
//
// Dos sabores, según el tamaño del dominio:
//   - Roles es lista cerrada y corta (config/perfiles.js) →
//     ValueListWithFixedValues, que se renderiza como desplegable múltiple.
//   - Sociedades, Usuarios y Estados crecen con los datos → value help con
//     diálogo y búsqueda.
// =============================================================================
annotate ReasignacionService.PropuestasEnCurso with {

    grupoPropuesta  @Common.Label: 'Propuesta';
    tituloTarea     @Common.Label: 'Detalle';
    numeroPropuesta @Common.Label: 'N° Propuesta';
    banco           @Common.Label: 'Banco';
    importe         @Common.Label: 'Importe';
    importeTexto    @Common.Label: 'Importe';
    moneda          @Common.Label: 'Moneda';
    fechaPropuestaPago @Common.Label: 'Fecha PP';
    fechaPago          @Common.Label: 'Fecha Pago';
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

    // destinatarios es MULTIVALOR: una propuesta en firma de apoderados tiene
    // dos personas pendientes a la vez. El value help entrega un correo suelto y
    // Fiori genera `eq`, que contra "a@x, b@x" no casaría nunca — por eso el
    // servicio trata la igualdad sobre este campo como "está entre".
    // Ver _filtroMultivalor en srv/reasignacion-service.js.
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

// =============================================================================
// Entidades de ayuda de búsqueda
// =============================================================================
annotate ReasignacionService.Sociedades with {
    sociedad @Common.Label: 'Sociedad';
};

annotate ReasignacionService.Usuarios with {
    usuarioActual @Common.Label: 'Destinatario';
};

// Estados ofrece ahora los estados de PROPUESTA ('Pendiente de Apoderados' /
// 'Pendiente de Liberación'), no los de tarea: es lo que se filtra en esta
// pantalla. Se renderiza como desplegable de valores fijos — son dos.
annotate ReasignacionService.Estados with {
    estadoPropuesta @Common.Label: 'Estado';
};
