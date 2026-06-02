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

// ── Tipo usuario autenticado ──────────────────────────────────────
type UsuarioActual {
  nombre : String;
}

// ── Tipo constantes de negocio ────────────────────────────────────
type ConstantesRpta {
  aSociedadesRevision : array of String;
  aValidarViaPago     : array of String;
  aAprobarViaPago     : array of String;
  aSociedadesTermina  : array of String;
  oTesoreros          : LargeString;
  sDocumentUrl        : String;
  sDocumentUrlTasa    : String;
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

    // Flags de visibilidad por rol — controlan botones en Bloque 3
    tieneAnalista            : Boolean;
    estaConforme             : Boolean;
    tieneRevisor             : Boolean;
    estaAprobado             : Boolean;
    esCaja                   : Boolean;
    estaTerminado            : Boolean;
    estaAnulado              : Boolean;

    // Campos calculados por el handler — visibilidad doble del Supervisor
    puedeTerminarFlujo : Boolean; // true cuando estaConforme AND estaTerminado
    puedeAnular        : Boolean; // true cuando estaConforme AND estaAnulado

    // Composiciones — Facets 2, 3, 4 de la Object Page
    // Cargadas solo en READ por instanceID (no en el listado)
    proveedores              : Composition of many Proveedor;
    adjuntos                 : Composition of many Adjunto;
    aprobadores              : Composition of many Aprobador;
    

  }

  // ── FUNCIONES Y ACCIONES ───────────────────────────────────────

  @Common.Label: 'Obtener constantes de negocio'
  function obtenerConstantes() returns ConstantesRpta;

 // ── Tipo que representa al usuario autenticado en cada acción ─────────────────
// Reemplaza el type CurrentUser del legado (PPOData.js → getCurrentUserApi())
type UsuarioActual {
  nombre : String; // email del usuario autenticado vía XSUAA
}

// ── Resultado estándar devuelto por todas las acciones ────────────────────────
// Reemplaza AccionResult del legado (Detail.controller.js → _procesarRespuesta)
type ResultadoAccion {
  exitoso  : Boolean; // true si la acción completó sin errores
  mensaje  : String;  // mensaje descriptivo para mostrar al usuario
  estadoPP : String;  // nuevo estado de la propuesta tras la acción
  taskId   : String;  // ID de la tarea BPA procesada
}

// ── ANALISTA TESORERÍA ────────────────────────────────────────────────────────
// Origen legado: AnalistaTesoreria.js → generarBotones()
// Flag de visibilidad: tieneAnalista (PropuestaNomina.json)

  // Tarea 3.1 — Enviar al Supervisor o Caja según ViaPago
  // Legado: botón ENVIAR_SUPER_CAJA
  @Common.Label: 'Enviar Super/Caja'
  action enviarSupervisorOCaja(
    propuesta   : PropuestaNomina, // datos completos de la propuesta
    usuario     : UsuarioActual,   // usuario que ejecuta la acción
    taskId      : String,          // ID de la tarea BPA
    constantes  : ConstantesRpta   // constantes de negocio (rutas, sociedades)
  ) returns ResultadoAccion;

  // Tarea 3.1 — Compensar la propuesta con documento SAP
  // Legado: botón COMPENSAR
  @Common.Label: 'Compensar'
  action compensar(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String
  ) returns ResultadoAccion;

  // Tarea 3.1 — Cerrar la propuesta por observación del supervisor
  // Legado: botón CERRAR_OBS — requiere comentario obligatorio
  @Common.Label: 'Cerrar por obs.'
  action cerrarPorObservacion(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    comentario  : String           // Tarea 3.6: Fiori Elements genera dialog automático
  ) returns ResultadoAccion;

  // Tarea 3.1 — Eliminar el documento generado
  // Legado: botón ELIMINAR_DOC
  @Common.Label: 'Eliminar Doc.'
  action eliminarDoc(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String
  ) returns ResultadoAccion;

// ── SUPERVISOR ────────────────────────────────────────────────────────────────
// Origen legado: Supervisor.js → generarBotones()
// Flag de visibilidad: estaConforme (PropuestaNomina.json)

  // Tarea 3.2 — Aprobar la propuesta y enrutar al siguiente paso
  // Legado: botón APROBAR_PP
  @Common.Label: 'Aprobar PP'
  action supervisorAprobar(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    constantes  : ConstantesRpta
  ) returns ResultadoAccion;

  // Tarea 3.2 — Terminar el flujo completo (cancela la instancia BPA)
  // Legado: botón TERMINAR_FLUJO — visibilidad doble: estaConforme AND estaTerminado
  @Common.Label: 'Terminar flujo'
  action supervisorTerminarFlujo(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    constantes  : ConstantesRpta
  ) returns ResultadoAccion;

  // Tarea 3.2 — Observar la propuesta (devuelve al Analista)
  // Legado: botón OBSERVAR — requiere comentario obligatorio
  @Common.Label: 'Observar'
  action supervisorObservar(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    comentario  : String           // Tarea 3.6: dialog automático de Fiori Elements
  ) returns ResultadoAccion;

  // Tarea 3.2 — Anular la propuesta de pago
  // Legado: botón ANULAR — visibilidad doble: estaConforme AND estaAnulado
  @Common.Label: 'Anular'
  action supervisorAnular(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    comentario  : String           // Tarea 3.6: dialog automático obligatorio
  ) returns ResultadoAccion;

// ── REVISOR ───────────────────────────────────────────────────────────────────
// Origen legado: Revisor.js → generarBotones()
// Flag de visibilidad: tieneRevisor (PropuestaNomina.json)

  // Tarea 3.3 — Aprobar la propuesta en etapa de revisión
  // Legado: botón APROBAR_PP
  @Common.Label: 'Aprobar PP'
  action revisorAprobar(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String
  ) returns ResultadoAccion;

  // Tarea 3.3 — Observar la propuesta en etapa de revisión
  // Legado: botón OBSERVAR — requiere comentario obligatorio
  @Common.Label: 'Observar'
  action revisorObservar(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    comentario  : String           // Tarea 3.6: dialog automático de Fiori Elements
  ) returns ResultadoAccion;

// ── APODERADO ─────────────────────────────────────────────────────────────────
// Origen legado: Apoderado.js → generarBotones()
// Flag de visibilidad: estaAprobado (PropuestaNomina.json)

  // Tarea 3.4 — Firmar la propuesta (F1 o F2 según contadorFirma)
  // Legado: botón APROBAR_PP (firma) — el handler decide F1/F2 internamente
  @Common.Label: 'Firmar'
  action apoderadoFirmar(
    propuesta   : PropuestaNomina, // contiene contadorFirma para F1/F2
    usuario     : UsuarioActual,
    taskId      : String,
    constantes  : ConstantesRpta
  ) returns ResultadoAccion;

  // Tarea 3.4 — Observar la propuesta en etapa de firma
  // Legado: botón OBSERVAR — requiere comentario obligatorio
  @Common.Label: 'Observar'
  action apoderadoObservar(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    comentario  : String           // Tarea 3.6: dialog automático de Fiori Elements
  ) returns ResultadoAccion;

  // Tarea 3.4 — Redirigir a otro apoderado
  // Legado: botón REDIRIGIR_APODERADO
  @Common.Label: 'Redirigir Apoderado'
  action redirigirApoderado(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    comentario  : String           // nuevo apoderado destino
  ) returns ResultadoAccion;

// ── CAJA ──────────────────────────────────────────────────────────────────────
// Origen legado: Caja.js → generarBotones()
// Flag de visibilidad: esCaja (PropuestaNomina.json)
// El estado EN_CAJA es informativo — se muestra como campo estadoPP en el header,
// NO como botón (Tarea 3.5)

  // Tarea 3.5 — Confirmar el pago en caja (cierra el flujo)
  // Legado: botón CONFIRMAR_PAGO
  @Common.Label: 'Confirmar Pago'
  action cajaConfirmarPago(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String
  ) returns ResultadoAccion;

  // Tarea 3.5 — Observar en etapa de caja (devuelve al Analista)
  // Legado: botón OBSERVAR — requiere comentario obligatorio
  @Common.Label: 'Observar'
  action cajaObservar(
    propuesta   : PropuestaNomina,
    usuario     : UsuarioActual,
    taskId      : String,
    comentario  : String           // Tarea 3.6: dialog automático de Fiori Elements
  ) returns ResultadoAccion;


}