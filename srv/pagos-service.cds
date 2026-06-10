// ─────────────────────────────────────────────────────────────────
// srv/pagos-service.cds
//
// Servicio principal de aprobaciones H2H Nómina.
// Path: /nomina/aprobaciones
//
// Sin persistencia propia (sin HANA Cloud).
// Fuentes de datos en runtime:
//   BPA  → TareasInbox, contexto del flujo (PropuestaNomina.json)
//   CPI  → Proveedores, validaciones, firmas, correo
//   HANA → Adjuntos, Aprobadores (via CPI como fachada)
//
// DECISIÓN DE DISEÑO — Object Page sobre TareasInbox:
//   La Object Page se monta directamente sobre TareasInbox.
//   Las composiciones viven en TareasInbox y se cargan solo
//   en el READ por instanceID (clave específica).
//   Evita el problema de resolución de asociaciones entre
//   entidades virtuales (@cds.persistence.skip).
//
// CONVENCIÓN DE NOMBRES (Opción A):
//   Nombres exactos del objeto PropuestaNomina.json del BPA.
// ─────────────────────────────────────────────────────────────────

// ── Tipo de entrada para acciones por rol ─────────────────────────
// Objeto PropuestaNomina que circula en el flujo BPA.
type PropuestaNomina {
  numeroPropuesta       : String(20);
  sociedad              : String(4);
  fechaPropuestaPago    : String(10);
  banco                 : String(10);
  bancoDescripcion      : String(100);
  viaPago               : String(1);
  modalidadPP           : String(10);
  version               : String(4);
  importe               : String(20);
  moneda                : String(5);
  estadoPP              : String(20);
  analista              : String(12);
  correoAnalista        : String(100);
  usuarioCreacion       : String(100);
  usuarioCreacionPP     : String(12);
  tituloTarea           : String(100);
  existeDocumento       : String(10);
  indicadorPagoAdelanto : String(1);
  idInstanciaWF         : String(50);
  nroDocCompensacion    : String(20);
  fechaCompensacion     : String(10);
  tieneAnalista         : Boolean;
  estaConforme          : Boolean;
  tieneRevisor          : Boolean;
  estaAprobado          : Boolean;
  esCaja                : Boolean;
  estaTerminado         : Boolean;
  estaAnulado           : Boolean;
  usuariosRevisores     : array of String;
  usuariosSupervisores  : array of String;
  usuariosAnalistas     : array of String;
  usuarioApoderado      : String(100);
  usuarioCaja           : String(100);
  contadorFirma         : Integer;
}

// ── Tipo constantes de negocio ────────────────────────────────────
type ConstantesRpta {
  sociedadesRevision : array of String;
  validarViaPago     : array of String;
  aprobarViaPago     : array of String;
  sociedadesTermina  : array of String;
  tesoreros          : LargeString;
  documentUrl        : String;
  documentUrlTasa    : String;
}

// ── Tipo resultado de acción ──────────────────────────────────────
type AccionResult {
  success  : Boolean;
  mensaje  : String;
  estadoPP : String;
  taskId   : String;
}

// ── Servicio principal ────────────────────────────────────────────

@path: '/nomina/aprobaciones'
service PagosService {

  // ── Entidades de composición de TareasInbox ─────────────────────

  // Proveedores beneficiarios — Origen: fragment/Proveedores.xml
  @cds.persistence.skip
  entity Proveedor {
    key proveedorId : String(10);
        ruc         : String(11);
        nombre      : String(80);
        glosa       : String(100);
        monto       : Decimal(13,2);
        facturas    : String(200);
  }

  // Documentos adjuntos — Origen: fragment/Adjuntos2.xml
  @cds.persistence.skip
  entity Adjunto {
    key adjuntoId          : String(36);
        nombre             : String(100);
        tipoAdjunto        : String(20);
        activo             : Boolean;
        docServiceObjectID : String(36);
  }

  // Historial de aprobaciones — Origen: fragment/Aprobadores.xml
  @cds.persistence.skip
  entity Aprobador {
    key aprobadorId : String(10);
        usuario     : String(50);
        rol         : String(30);
        fechaAprob  : DateTime;
        aprobado    : Boolean;
        observacion : String(255);
  }

  // ── Entidad Media para descarga del PDF de la propuesta ─────────────────────
  // Patrón estándar CAP: @Core.MediaType en campo LargeBinary.
  // CAP sirve GET /PropuestaPDF(id)/contenido con Content-Disposition: attachment.
  // Fuente oficial: cap.cloud.sap/docs/guides/services/media-data
  // Origen legado: Detail.controller.js → getPropuestaPDFSAP() → Docum base64
  @cds.persistence.skip
  entity PropuestaPDF {
    key id                 : String(50);
        numeroPropuesta    : String(20);
        sociedad           : String(4);
        fechaPropuestaPago : String(10);
        mimeType           : String @Core.IsMediaType;
        nombreArchivo      : String;
        contenido          : LargeBinary @Core.MediaType: mimeType
                                        @Core.ContentDisposition.Filename: nombreArchivo
                                        @Core.ContentDisposition.Type: 'attachment';
  }

  // ── BANDEJA DE TAREAS + DETALLE ─────────────────────────────────
  // Sirve al List Report (READ sin clave) y a la Object Page (READ con clave).
  // Origen legado:
  //   List Report : Master.view.xml
  //   Object Page : Detail.view.xml (IconTabBar 4 pestañas)
  @readonly
  @cds.persistence.skip
  entity TareasInbox {

    // Clave técnica BPA
    key instanceID           : String(50);

    // Metadatos de auditoría BPA
    SAP__Origin              : String(100);
    creadoPor                : String(100);
    creadoEn                 : DateTime;

    // Campos del List Report (del PropuestaNomina.json)
    tituloTarea              : String(100);
    numeroPropuesta          : String(20);
    sociedad                 : String(4);
    fechaPropuestaPago       : String(10);
    banco                    : String(10);
    bancoDescripcion         : String(100);
    viaPago                  : String(1);
    modalidadPP              : String(10);
    version                  : String(4);
    importe                  : String(20);
    moneda                   : String(5);
    analista                 : String(12);
    correoAnalista           : String(100);

    // URL del PDF para descarga desde la Object Page (Tarea 2.3)
    //     // Calculada en el handler READ por instanceID: /PropuestaPDF('id')/contenido
    urlPDF               : String;

    // Campos adicionales del Facet 1 — Información (Object Page)
    estadoPP                 : String(20);
    usuarioCreacion          : String(100);
    usuarioCreacionPP        : String(12);
    existeDocumento          : String(10);
    indicadorPagoAdelanto    : String(1);

    // Flags de visibilidad por rol — calculados desde el taskDefinitionId (activityId)
    // de la tarea BPA vía perfiles.calcularFlagsRol(). Reemplazan a los flags
    // legado del contexto (tieneAnalista/estaConforme/tieneRevisor/estaAprobado/esCaja).
    // esAnalista y esCaja son siempre false: esos roles no tienen user task en BPA.
    esAnalista               : Boolean;
    esCoordinador            : Boolean;
    esApoderado              : Boolean;
    esLiberador              : Boolean;
    esCaja                   : Boolean;

    // Flags de estado de la propuesta — sí provienen del contexto BPA
    estaTerminado            : Boolean;
    estaAnulado              : Boolean;

    // Campos calculados por el handler — visibilidad doble del Coordinador
    puedeTerminarFlujo : Boolean; // true cuando esCoordinador AND estaTerminado
    puedeAnular        : Boolean; // true cuando esCoordinador AND estaAnulado

    // Composiciones — Facets 2, 3, 4 de la Object Page
    // Cargadas solo en READ por instanceID (no en el listado)
    proveedores              : Composition of many Proveedor;
    adjuntos                 : Composition of many Adjunto;
    aprobadores              : Composition of many Aprobador;


  }
  // ── BOUND ACTIONS DE TareasInbox ────────────────────────────────
  //
  // Migración a bound actions (bloque Migración Bound Actions):
  //   - En Fiori Elements V4 el contexto de la Object Page solo se pasa a
  //     las acciones BOUND; por eso la visibilidad dinámica (UI.Hidden con
  //     path sobre los flags de rol) requiere que las acciones sean bound.
  //   - El cliente ya NO envía propuesta/usuario/taskId: el handler los
  //     deriva del instanceID de la instancia (clave bound), del contexto
  //     BPA (fuente autoritativa) y de XSUAA (req.user). Esto además evita
  //     manipulación de datos desde el cliente.
  //   - Los parámetros restantes (comentario) generan el dialog automático
  //     de Fiori Elements (Tarea 3.6).
  actions {

    // ── Analista Tesorería (esAnalista) ──────────────────────────
    // Tarea 3.1 — Enviar al Supervisor o Caja según viaPago (W → EN_CAJA)
    @Common.Label: 'Enviar Super/Caja'
    action enviarSupervisorOCaja() returns ResultadoAccion;

    // Tarea 3.1 — Compensar la propuesta con documento SAP
    @Common.Label: 'Compensar'
    action compensar() returns ResultadoAccion;

    // Tarea 3.1 — Cerrar la propuesta por observación del supervisor
    @Common.Label: 'Cerrar por obs.'
    action cerrarPorObservacion(
      @Common.Label: 'Comentario'
      comentario : String @mandatory  // dialog automático de Fiori Elements
    ) returns ResultadoAccion;

    // Tarea 3.1 — Eliminar el documento generado
    @Common.Label: 'Eliminar Doc.'
    action eliminarDoc() returns ResultadoAccion;

    // ── Coordinador (esCoordinador) ──────────────────────────────
    // Tarea 3.2 — Aprobar la propuesta y enrutar al siguiente paso
    @Common.Label: 'Aprobar PP'
    action supervisorAprobar() returns ResultadoAccion;

    // Tarea 3.2 — Terminar el flujo completo (visibilidad: puedeTerminarFlujo)
    @Common.Label: 'Terminar flujo'
    action supervisorTerminarFlujo() returns ResultadoAccion;

    // Tarea 3.2 — Observar la propuesta (devuelve al Analista)
    @Common.Label: 'Observar'
    action supervisorObservar(
      @Common.Label: 'Comentario'
      comentario : String @mandatory
    ) returns ResultadoAccion;

    // Tarea 3.2 — Anular la propuesta (visibilidad: puedeAnular)
    @Common.Label: 'Anular'
    action supervisorAnular(
      @Common.Label: 'Comentario'
      comentario : String @mandatory
    ) returns ResultadoAccion;

    // ── Revisor/Liberador (esLiberador) ──────────────────────────
    // Tarea 3.3 — Aprobar en etapa de revisión (REVISION → EN_FIRMA)
    @Common.Label: 'Aprobar PP'
    action revisorAprobar() returns ResultadoAccion;

    // Tarea 3.3 — Observar en etapa de revisión
    @Common.Label: 'Observar'
    action revisorObservar(
      @Common.Label: 'Comentario'
      comentario : String @mandatory
    ) returns ResultadoAccion;

    // ── Apoderado (esApoderado) ──────────────────────────────────
    // Tarea 3.4 — Firmar (F1/F2 según contadorFirma del contexto)
    @Common.Label: 'Firmar'
    action apoderadoFirmar() returns ResultadoAccion;

    // Tarea 3.4 — Observar en etapa de firma
    @Common.Label: 'Observar'
    action apoderadoObservar(
      @Common.Label: 'Comentario'
      comentario : String @mandatory
    ) returns ResultadoAccion;

    // Tarea 3.4 — Redirigir a otro apoderado
    // TODO(arquitecto): redirigirApoderado pendiente en el dominio
    @Common.Label: 'Redirigir Apoderado'
    action redirigirApoderado(
      @Common.Label: 'Apoderado destino (email)'
      comentario : String @mandatory  // email del nuevo apoderado
    ) returns ResultadoAccion;

    // ── Caja (esCaja) ────────────────────────────────────────────
    // Tarea 3.5 — Confirmar el pago en caja (EN_CAJA → PAGADO)
    @Common.Label: 'Confirmar Pago'
    action cajaConfirmarPago() returns ResultadoAccion;

    // Tarea 3.5 — Observar en etapa de caja
    @Common.Label: 'Observar'
    action cajaObservar(
      @Common.Label: 'Comentario'
      comentario : String @mandatory
    ) returns ResultadoAccion;
  }

  // ── FUNCIONES Y ACCIONES ───────────────────────────────────────

  @Common.Label: 'Obtener constantes de negocio'
  function obtenerConstantes() returns ConstantesRpta;

  // ── Resultado estándar devuelto por todas las acciones ────────────────────────
  // Reemplaza AccionResult del legado (Detail.controller.js → _procesarRespuesta)
  type ResultadoAccion {
    exitoso  : Boolean; // true si la acción completó sin errores
    mensaje  : String;  // mensaje descriptivo para mostrar al usuario
    estadoPP : String;  // nuevo estado de la propuesta tras la acción
    taskId   : String;  // ID de la tarea BPA procesada
  }

}