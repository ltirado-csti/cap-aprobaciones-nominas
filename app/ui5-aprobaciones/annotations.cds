// ─────────────────────────────────────────────────────────────────
// app/ui5-aprobaciones/annotations.cds
//
// Anotaciones Fiori Elements para PagosService.
// Solo contiene directivas annotate — sin definiciones de entidades.
// ─────────────────────────────────────────────────────────────────

using PagosService from '../../srv/pagos-service';

// ═══════════════════════════════════════════════════════════════════
// LIST REPORT + OBJECT PAGE: TareasInbox
// ═══════════════════════════════════════════════════════════════════

annotate PagosService.TareasInbox with @(

  // ── Encabezado ───────────────────────────────────────────────────
  UI.HeaderInfo: {
    TypeName      : 'Tarea',
    TypeNamePlural: 'Tareas Pendientes',
    Title         : { $Type: 'UI.DataField', Value: tituloTarea },
    Description   : { $Type: 'UI.DataField', Value: numeroPropuesta }
  },

  // ── Filtros del List Report ───────────────────────────────────────
  // UI.SelectionFields: [
    /*sociedad, fechaPropuestaPago, banco, modalidadPP, viaPago, analista*/
  // ],

  // ── Columnas del List Report ──────────────────────────────────────
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: tituloTarea,        Label: 'Propuesta' , ![@UI.Importance]: #High },
    { $Type: 'UI.DataField', Value: importe,            Label: 'Importe' , ![@UI.Importance]: #High },
    { $Type: 'UI.DataField', Value: moneda,             Label: 'Moneda' , ![@UI.Importance]: #High },
    // { $Type: 'UI.DataField', Value: banco,              Label: 'Banco' ,![@UI.Importance]: #High    },
    // { $Type: 'UI.DataField', Value: viaPago,            Label: 'Vía Pago' ,![@UI.Importance]: #High },
    { $Type: 'UI.DataField', Value: fechaPropuestaPago, Label: 'Fecha PP' , ![@UI.Importance]: #High },
    // { $Type: 'UI.DataField', Value: analista,           Label: 'Analista' , ![@UI.Importance]: #High },
    // Flags de rol — ocultos en la tabla pero incluidos en $select
    { $Type: 'UI.DataField', Value: esAnalista,          ![@UI.Hidden]: true },
    { $Type: 'UI.DataField', Value: esCoordinador,       ![@UI.Hidden]: true },
    { $Type: 'UI.DataField', Value: esLiberador,         ![@UI.Hidden]: true },
    { $Type: 'UI.DataField', Value: esApoderado,         ![@UI.Hidden]: true },
    { $Type: 'UI.DataField', Value: esCaja,              ![@UI.Hidden]: true },
    { $Type: 'UI.DataField', Value: puedeTerminarFlujo,  ![@UI.Hidden]: true },
    { $Type: 'UI.DataField', Value: puedeAnular,         ![@UI.Hidden]: true }
  ],

  // ── Header de la Object Page ──────────────────────────────────────
  UI.HeaderFacets: [{
    $Type : 'UI.ReferenceFacet',
    Target: '@UI.FieldGroup#Resumen'
  }],

  UI.FieldGroup#Resumen: {
    Data: [
      { $Type: 'UI.DataField', Value: sociedad,         Label: 'Sociedad' },
      { $Type: 'UI.DataField', Value: bancoDescripcion, Label: 'Banco'    },
      { $Type: 'UI.DataField', Value: importe,          Label: 'Importe'  },
      { $Type: 'UI.DataField', Value: moneda,           Label: 'Moneda'   },
      { $Type: 'UI.DataField', Value: estadoPP,         Label: 'Estado'   }
    ]
  },

  // ── Información General (Facet 1) ────────────────────────────────
  UI.FieldGroup#DatosGenerales: {
    Label: 'Información General',
    Data : [
      { $Type: 'UI.DataField', Value: numeroPropuesta,       Label: 'Número PP'          },
      { $Type: 'UI.DataField', Value: sociedad,              Label: 'Sociedad'           },
      { $Type: 'UI.DataField', Value: fechaPropuestaPago,    Label: 'Fecha PP'           },
      { $Type: 'UI.DataField', Value: banco,                 Label: 'Banco'              },
      { $Type: 'UI.DataField', Value: bancoDescripcion,      Label: 'Descripción Banco'  },
      { $Type: 'UI.DataField', Value: viaPago,               Label: 'Vía de Pago'        },
      { $Type: 'UI.DataField', Value: modalidadPP,           Label: 'Modalidad'          },
      { $Type: 'UI.DataField', Value: version,               Label: 'Versión'            },
      { $Type: 'UI.DataField', Value: importe,               Label: 'Importe'            },
      { $Type: 'UI.DataField', Value: moneda,                Label: 'Moneda'             },
      { $Type: 'UI.DataField', Value: estadoPP,              Label: 'Estado PP'          },
      { $Type: 'UI.DataField', Value: analista,              Label: 'Analista'           },
      { $Type: 'UI.DataField', Value: correoAnalista,        Label: 'Correo Analista'    },
      { $Type: 'UI.DataField', Value: usuarioCreacion,       Label: 'Creado por (BPA)'   },
      { $Type: 'UI.DataField', Value: usuarioCreacionPP,     Label: 'Creado por (SAP)'   },
      { $Type: 'UI.DataField', Value: indicadorPagoAdelanto, Label: 'Indicador Adelanto' },
      { $Type: 'UI.DataField', Value: existeDocumento,       Label: 'Documento'          },
      { $Type: 'UI.DataFieldWithUrl', Value: numeroPropuesta, Url: urlPDF, Label: 'PDF Propuesta' }
    ]
  },

  // ── Pestañas de la Object Page ────────────────────────────────────
  UI.Facets: [
    {
      $Type : 'UI.CollectionFacet',
      ID    : 'FacetInformacion',
      Label : 'Información',
      Facets: [{ $Type: 'UI.ReferenceFacet', ID: 'RefDatosGenerales', Target: '@UI.FieldGroup#DatosGenerales' }]
    },
    { $Type: 'UI.ReferenceFacet', ID: 'FacetProveedores', Label: 'Proveedores', Target: 'proveedores/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', ID: 'FacetAdjuntos',    Label: 'Adjuntos',    Target: 'adjuntos/@UI.LineItem'    },
    { $Type: 'UI.ReferenceFacet', ID: 'FacetAprobadores', Label: 'Aprobadores', Target: 'aprobadores/@UI.LineItem' }
  ],

  // ── Botones de acción en la barra de la Object Page ───────────────
  //
  // UI.Identification coloca los DataFieldForAction en la toolbar superior
  // de la Object Page (junto al título). Es la ubicación estándar para
  // acciones de negocio en Fiori Elements con unbound actions de servicio CAP.
  //
  // ORDEN DE DECLARACIÓN = orden visual en la toolbar (izquierda → derecha).
  //
  // VISIBILIDAD:
  //   Las unbound actions de servicio CAP no soportan @Core.OperationAvailable
  //   con referencia dinámica a campos de entidad (solo aplica a bound actions).
  //   La visibilidad condicional (esCoordinador, puedeAnular, etc.) se implementa
  //   mediante la propiedad ![@UI.Hidden] con expresión sobre los flags de TareasInbox
  //   que ya están en el $select gracias al UI.LineItem oculto de arriba.
  UI.Identification: [

    // ── Analista Tesorería (esAnalista = true) ─────────────────────
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.enviarSupervisorOCaja',
      Label          : 'Enviar',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esAnalista' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.compensar',
      Label          : 'Compensar',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esAnalista' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.cerrarPorObservacion',
      Label          : 'Cerrar Obs.',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esAnalista' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.eliminarDoc',
      Label          : 'Eliminar Doc.',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esAnalista' } } }
    },

    // ── Coordinador (esCoordinador = true) ────────────────────────
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.supervisorAprobar',
      Label          : 'Aprobar PP',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esCoordinador' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.supervisorObservar',
      Label          : 'Observar',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esCoordinador' } } }
    },
    // Terminar flujo: esCoordinador AND estaTerminado → flag pre-calculado puedeTerminarFlujo
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.supervisorTerminarFlujo',
      Label          : 'Terminar Flujo',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'puedeTerminarFlujo' } } }
    },
    // Anular: esCoordinador AND estaAnulado → flag pre-calculado puedeAnular
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.supervisorAnular',
      Label          : 'Anular',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'puedeAnular' } } }
    },

    // ── Liberador (esLiberador = true) ────────────────────────────
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.revisorAprobar',
      Label          : 'Aprobar PP',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esLiberador' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.revisorObservar',
      Label          : 'Observar',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esLiberador' } } }
    },

    // ── Apoderado (esApoderado = true) ────────────────────────────
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.apoderadoFirmar',
      Label          : 'Firmar',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esApoderado' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.apoderadoObservar',
      Label          : 'Observar',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esApoderado' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.redirigirApoderado',
      Label          : 'Redirigir',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esApoderado' } } }
    },

    // ── Caja (esCaja = true) ──────────────────────────────────────
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.cajaConfirmarPago',
      Label          : 'Confirmar Pago',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esCaja' } } }
    },
    {
      $Type          : 'UI.DataFieldForAction',
      Action         : 'PagosService.cajaObservar',
      Label          : 'Observar',
      ![@UI.Hidden]  : { $edmJson: { $Not: { $Path: 'esCaja' } } }
    }
  ]
);

// ── Etiquetas individuales ────────────────────────────────────────
annotate PagosService.TareasInbox with {
  instanceID            @title: 'ID Instancia';
  tituloTarea           @title: 'Propuesta';
  numeroPropuesta       @title: 'Número PP';
  sociedad              @title: 'Sociedad';
  fechaPropuestaPago    @title: 'Fecha PP';
  banco                 @title: 'Banco';
  bancoDescripcion      @title: 'Descripción Banco';
  viaPago               @title: 'Vía de Pago';
  modalidadPP           @title: 'Modalidad';
  version               @title: 'Versión';
  importe               @title: 'Importe';
  moneda                @title: 'Moneda';
  analista              @title: 'Analista';
  correoAnalista        @title: 'Correo Analista';
  estadoPP              @title: 'Estado PP';
  usuarioCreacion       @title: 'Creado por (BPA)';
  usuarioCreacionPP     @title: 'Creado por (SAP)';
  existeDocumento       @title: 'Documento';
  indicadorPagoAdelanto @title: 'Indicador Adelanto';
  urlPDF                @Core.IsURL @title: 'URL PDF';
}

// ── Acciones — visibilidad ───────────────────────────────────────
// Migración a bound actions: la visibilidad por rol se controla con
// ![@UI.Hidden] (path sobre los flags de TareasInbox) en UI.Identification.
// Con acciones bound, Fiori Elements V4 sí pasa el contexto de la Object
// Page y las expresiones de path se evalúan por instancia.

// ── Composiciones ─────────────────────────────────────────────────
annotate PagosService.Proveedor with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: ruc,      Label: 'RUC'      },
    { $Type: 'UI.DataField', Value: nombre,   Label: 'Nombre'   },
    { $Type: 'UI.DataField', Value: glosa,    Label: 'Glosa'    },
    { $Type: 'UI.DataField', Value: monto,    Label: 'Monto'    },
    { $Type: 'UI.DataField', Value: facturas, Label: 'Facturas' }
  ]
);

annotate PagosService.Adjunto with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: nombre,            Label: 'Nombre'           },
    { $Type: 'UI.DataField', Value: tipoAdjunto,       Label: 'Tipo'             },
    { $Type: 'UI.DataField', Value: activo,            Label: 'Activo'           },
    { $Type: 'UI.DataField', Value: docServiceObjectID,Label: 'ID Documento DMS' }
  ]
);

annotate PagosService.Aprobador with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: usuario,    Label: 'Usuario'     },
    { $Type: 'UI.DataField', Value: rol,        Label: 'Rol'         },
    { $Type: 'UI.DataField', Value: fechaAprob, Label: 'Fecha'       },
    { $Type: 'UI.DataField', Value: aprobado,   Label: 'Aprobado'    },
    { $Type: 'UI.DataField', Value: observacion,Label: 'Observación' }
  ]
);
