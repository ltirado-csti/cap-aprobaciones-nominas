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

    // ── Filtros de la barra de filtros ────────────────────────────────────────
    // Solo estos cinco: el botón "Adaptar filtros" está oculto (ver
    // ext/controller/ListaHandler.controller.js), así que esta lista es
    // literalmente lo único con lo que el usuario puede filtrar.
    //
    // El filtrado lo resuelve CAP en memoria — TareasInbox no tiene tabla
    // detrás y BPA no sabe filtrar por estos campos. Ver
    // srv/infrastructure/odata-memoria.js.
    UI.SelectionFields: [
        sociedad,
        banco,
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
        // La columna 'Moneda' se retiró porque el símbolo va dentro del importe y
        // mostrar además "PEN" era información duplicada. El campo `moneda` sigue
        // en el modelo para cálculos y para otros consumidores del servicio.
        { $Type: 'UI.DataField', Value: importeTexto,       Label: 'Importe',    ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: banco,           Label: 'Banco',      ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: viaPago,         Label: 'Vía Pago',   ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: fechaPropuestaPago, Label: 'Fecha PP',   ![@UI.Importance]: #High },
        { $Type: 'UI.DataField', Value: fechaPago,          Label: 'Fecha Pago', ![@UI.Importance]: #High },
        // { $Type: 'UI.DataField', Value: analista,        Label: 'Analista',   ![@UI.Importance]: #High },

        // Rechazo de Payroll del intento anterior. Vacío en el caso normal; con
        // texto rojo cuando la tarea reapareció por el loop back de BPA, para
        // distinguirla sin abrir el detalle. Importance #Medium: se repliega
        // antes que las columnas críticas en pantallas angostas.
        { $Type: 'UI.DataField', Value: notifMensaje, Label: 'Rechazo Payroll', ![@UI.Importance]: #Medium,
          Criticality: notifCriticidad, CriticalityRepresentation: #WithIcon },

        // Estado del quórum de apoderados — "1 de 2 firmas".
        //
        // Desde BPA v1.2.0 una propuesta puede reaparecer en la bandeja porque
        // falta la segunda firma, no solo porque Payroll rechazó. Sin esta
        // columna las dos situaciones son indistinguibles en la lista, y el
        // apoderado no sabe si su firma es la que cierra el paso o no.
        // Vacío en las tareas de liberación, que no tienen quórum.
        { $Type: 'UI.DataField', Value: firmasTexto, Label: 'Firmas', ![@UI.Importance]: #Medium },

        // Acciones masivas de la toolbar del List Report — reusan las bound
        // actions apoderadoAprobar()/apoderadoRechazar(comentario). FE las
        // invoca una vez por contexto seleccionado en un $batch (selectionMode:
        // Multi en el manifest). Su habilitación la controla
        // Core.OperationAvailable: { $Path: 'in/esApoderado' } más abajo.
        //
        // apoderadoRechazar tiene un parámetro obligatorio (comentario): FE
        // abre el diálogo estándar de parámetros de acción UNA sola vez y
        // aplica el mismo comentario a cada tarea seleccionada — no hace
        // falta código de frontend adicional para esto.
        //
        // Criticality/IconUrl declaran la intencion (positivo/negativo) igual que
        // en UI.Identification. En el footer del Object Page sap.fe los traduce a
        // boton Accept/Reject con icono; en la toolbar de la tabla NO lo hace —
        // ahi todas las acciones se plantillan como Transparent sin icono. El
        // acabado visual de estos dos botones lo pone
        // ext/controller/ListaHandler.controller.js sobre el control ya creado.
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.apoderadoAprobar',  Label: 'Aprobar masivo',
          Criticality: #Positive, IconUrl: 'sap-icon://accept' },
        { $Type: 'UI.DataFieldForAction', Action: 'PagosService.apoderadoRechazar', Label: 'Rechazar masivo',
          Criticality: #Negative, IconUrl: 'sap-icon://decline' },

        // Necesario en $select para que la columna de rechazo pinte su color
        { $Type: 'UI.DataField', Value: notifCriticidad, ![@UI.Hidden]: true },

        // Flags de rol — ocultos, necesarios en $select para visibilidad de botones en Object Page.
        // esApoderado1/esApoderado2 se retiraron con el quórum de BPA v1.2.0:
        // ya no hay dos tareas de apoderado, sino una con pool de destinatarios.
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
    //   - Apoderado (esApoderado=true): ve Aprobar y Rechazar.
    //   - Liberador (esLiberador=true): ve Liberar, Rechazar y Anular.
    //   - Coordinador: anulado en v1.1.0 → ![@UI.Hidden]: true (constante).
    // Requiere que esApoderado/esLiberador estén en el $select del Object Page;
    // por eso se incluyen como campos ocultos en UI.FieldGroup#DatosGenerales.
    UI.Identification: [
        // Determining: true → botón en el footer del Object Page (no en la toolbar del header).
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
            // Criticality + CriticalityRepresentation → FE lo pinta como ObjectStatus
            // (color + ícono automático) en vez de texto plano.
            { $Type: 'UI.DataField', Value: estadoPP, Label: 'Estado',
              Criticality: estadoCriticidad, CriticalityRepresentation: #WithIcon },
            { $Type: 'UI.DataField', Value: importeTexto,      Label: 'Importe' },
            { $Type: 'UI.DataField', Value: fechaPropuestaPago,Label: 'Fecha PP' },
            { $Type: 'UI.DataField', Value: fechaPago,         Label: 'Fecha Pago' },

            // Quórum de apoderados — "1 de 2 firmas". Solo se muestra en las
            // tareas de apoderado: en las de liberación firmasTexto llega vacío
            // y el DataField desaparece por sí solo.
            { $Type: 'UI.DataField', Value: firmasTexto, Label: 'Firmas',
              ![@UI.Hidden]: { $edmJson: { $Not: [{ $Path: 'esApoderado' }] } } },

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
            // esApoderado gobierna el ![@UI.Hidden] de "Firmas" en este mismo
            // grupo: sin declararlo aquí el $select podría no traerlo y la
            // expresión evaluaría contra undefined, ocultándolo siempre.
            { $Type: 'UI.DataField', Value: esApoderado,      ![@UI.Hidden]: true },
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

        // "Historial de Aprobaciones" YA NO SE DECLARA AQUÍ.
        // Dejó de ser una tabla para pasar a ser un diagrama de flujo
        // (sap.suite.ui.commons.ProcessFlow), que Fiori Elements no sabe generar
        // desde anotaciones. Se declara como sección personalizada en
        // manifest.json → TareasInboxObjectPage > settings > content > body >
        // sections > HistorialAprobaciones, anclada después de 'DatosGenerales',
        // y su plantilla vive en ext/fragment/HistorialProcessFlow.fragment.xml.
        //
        // Por eso el ID 'DatosGenerales' de la faceta anterior es significativo:
        // el manifest lo usa como ancla de posición. No renombrarlo.
    ],

    UI.FieldGroup#DatosGenerales: {
        Label: 'Datos Generales',
        // Modalidad, N° Firmas y Analista salieron del formulario a pedido de
        // negocio; quedan comentadas abajo, en su sitio. Es solo la UI: los tres
        // campos siguen en TareasInbox y los sigue poblando pagos-service.js.
        Data : [
            { $Type: 'UI.DataField',        Value: sociedad,              Label: 'Sociedad' },
            { $Type: 'UI.DataField',        Value: numeroPropuesta,       Label: 'N° Propuesta' },
            { $Type: 'UI.DataField',        Value: version,               Label: 'Versión' },
         // { $Type: 'UI.DataField',        Value: modalidadPP,           Label: 'Modalidad' },
            { $Type: 'UI.DataField',        Value: banco,                 Label: 'Banco' },
            { $Type: 'UI.DataField',        Value: existeDocumento,       Label: 'Existe Documento' },
         // { $Type: 'UI.DataField',        Value: contadorFirma,         Label: 'N° Firmas' },

            // Quórum de apoderados. La lista completa contesta "¿quién más
            // puede firmar esto?", que es la pregunta que se hace el apoderado
            // al ver una propuesta que sigue pendiente después de su firma.
            //
            // OCULTOS EN LA TAREA DEL LIBERADOR, con el mismo ![@UI.Hidden]
            // dinámico que ya usa firmasTexto en la cabecera. Los tres salen de
            // _extraerQuorum (srv/pagos-service.js), que devuelve el bloque vacío
            // cuando la tarea no es de apoderado, así que en liberación se
            // pintaban con un guion. Ese guion se lee como "falta el dato",
            // cuando lo cierto es que NO APLICA: el quórum pertenece al paso de
            // apoderados y sus variables ni siquiera existen en el contexto del
            // proceso raíz, donde vive la tarea del liberador — el subproceso
            // solo devuelve `resultadoapoderados`.
            //
            // Quién firmó y cuándo se sigue viendo en el diagrama del historial,
            // que lo toma de ECP y además trae las fechas reales.
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
            // urlPDF NO se declara aquí. Antes era un DataFieldWithUrl —un link a
            // una entidad media que no existía en el modelo, o sea un 404— y el
            // PDF pasó a abrirse con sap.m.PDFViewer desde el botón "Ver PDF"
            // (manifest.json → content > header > actions, y ext/util/VisorPDF.js).
            //
            // Tampoco se deja como DataField oculto: al contrario de lo que
            // sugiere el truco de los flags de rol de abajo, un ![@UI.Hidden]
            // ESTÁTICO no entra en el $select del Object Page —lo que allí
            // funciona es que esApoderado/esLiberador se referencian desde
            // expresiones ![@UI.Hidden] dinámicas—, así que el campo llegaba
            // siempre vacío al contexto. VisorPDF.js lo pide con
            // Context#requestProperty, que va al servidor cuando falta.
            // Flags de rol ocultos: NO se renderizan (![@UI.Hidden]: true) pero
            // fuerzan que esApoderado/esLiberador entren al $select del Object Page,
            // para que el ![@UI.Hidden] dinámico de los botones del header pueda evaluar.
            { $Type: 'UI.DataField', Value: esApoderado, ![@UI.Hidden]: true },
            { $Type: 'UI.DataField', Value: esLiberador, ![@UI.Hidden]: true },
        ],
    },
);

// =============================================================================
// Etiquetas de los campos de la barra de filtros
//
// Bloque aparte porque anota ELEMENTOS (annotate ... with { campo @anno })
// y no la entidad: no cabe dentro del `with @( ... )` de arriba. La nota de
// cabecera sobre mantener un único bloque se refiere a las anotaciones @UI de
// la entidad, que son las que el PropertyHelper de MDC mergea; los @Common.Label
// por elemento no entran en ese merge.
//
// Sin esto la barra de filtros muestra el nombre técnico del campo como
// etiqueta ("fechaPropuestaPago:").
// =============================================================================
annotate PagosService.TareasInbox with {
    sociedad           @Common.Label: 'Sociedad';
    banco              @Common.Label: 'Banco';
    fechaPropuestaPago @Common.Label: 'Fecha PP';
    fechaPago          @Common.Label: 'Fecha Pago';

    // Estado: desplegable de valores fijos en vez de texto libre.
    //
    // ValueListWithFixedValues hace que Fiori Elements renderice un
    // MultiComboBox directamente en la barra de filtros, en lugar del diálogo
    // de ayuda de valores. Con seis opciones es lo correcto — y sobre todo
    // evita el problema real del texto libre: estadoPP se compara como cadena,
    // así que escribir "Pendiente de Liberacion" sin tilde no devolvía nada.
    //
    // LocalDataProperty y ValueListProperty son ambos estadoPP porque la lista
    // de valores no tiene código: la clave ES el texto (ver EstadosPropuesta
    // en srv/pagos-service.cds).
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

// =============================================================================
// EstadosPropuesta — lista de valores del filtro "Estado"
//
// El MultiComboBox de valores fijos solo pinta texto: es un control de entrada,
// no una tabla, así que no aplica Criticality. El color semántico de cada estado
// se ve donde hay un DataField que lo represente — la columna "Estado" de la
// lista y la cabecera del Object Page — y sale de la misma criticidad que se
// declara aquí (config/estados.js alimenta las dos cosas).
//
// El UI.LineItem no es decorativo: es lo que dibujaría las columnas si algún día
// se quita ValueListWithFixedValues y la ayuda pasa a ser un diálogo con tabla.
// Ahí sí se veria el estado con su color.
// =============================================================================
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

// =============================================================================
// Disponibilidad de acciones bound (controla si el botón está habilitado)
// =============================================================================
// annotate PagosService.TareasInbox actions {
//     apoderadoAprobar  @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esApoderado' } }, Common.Label: 'Aprobar'      );
//     apoderadoRechazar @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esApoderado' } }, Common.Label: 'Rechazar'     );
//     liberadorLiberar  @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esLiberador' } }, Common.Label: 'Liberar'      );
//     liberadorRechazar @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esLiberador' } }, Common.Label: 'Rechazar'     );
//     liberadorAnular   @( Core.OperationAvailable: { $edmJson: { $Path: 'in/esLiberador' } }, Common.Label: 'Anular'       );
//     coordinadorAprobar  @( Core.OperationAvailable: false, Common.Label: 'Aprobar (CO)'  );
//     coordinadorRechazar @( Core.OperationAvailable: false, Common.Label: 'Rechazar (CO)' );
// };
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
    coordinadorAprobar  @( Core.OperationAvailable: false, Common.Label: 'Aprobar (CO)'  );
    coordinadorRechazar @( Core.OperationAvailable: false, Common.Label: 'Rechazar (CO)' );
};

// =============================================================================
// Diálogo de parámetros de acción — comentario de rechazo del Apoderado
//
// apoderadoRechazar(comentario: String) no tiene botón custom: lo invoca Fiori
// Elements directamente (ver DataFieldForAction en UI.Identification/LineItem
// más arriba), que abre su Action Parameter Dialog estándar generado desde los
// parámetros de la acción. Sin esta anotación ese diálogo pinta el comentario
// como un <Input> de una sola línea; @UI.MultiLineText: true es la anotación
// que FE reconoce para pintar un <TextArea> en su lugar (ver SAPUI5 SDK,
// "Action Parameter Dialog" → Supported Annotations).
// =============================================================================
annotate PagosService.TareasInbox actions {
    apoderadoRechazar (
        comentario @( Common.Label: 'Comentario', UI.MultiLineText: true )
    );
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
//
// El Object Page NO consume este LineItem: el historial se muestra como
// ProcessFlow en una sección personalizada (ver UI.Facets más arriba). Se
// conserva porque sigue siendo la vista tabular del mismo dato — útil para
// depurar el iFlow y disponible si negocio pide recuperar la tabla junto al
// diagrama: basta con volver a añadir la ReferenceFacet a 'aprobadores'.
// =============================================================================
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