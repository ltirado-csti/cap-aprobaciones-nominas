// ─────────────────────────────────────────────────────────────────
// pagos-service.cds
//
// Definición del servicio CAP H2H Aprobaciones Nómina.
// Sin persistencia propia (no hay HANA Cloud / Postgres).
//
// Arquitectura de datos verificada en código fuente:
//   HANA XSOData  → PropuestaPago, Adjuntos, Aprobadores, Constantes
//   SAP Gateway   → Usuarios, Validaciones, Firmas, PDF, Correo
//   CPI           → /apoReg (ZfiWsH2hApoReg), /Obs (ZfiWsH2hObs)
//   BPA           → TaskCollection, completarTarea, readContext
// ─────────────────────────────────────────────────────────────────

// ── Tipos base (verificados en contexto.json y PPOData.js) ────────

type PropuestaPago {
  // Claves (clave compuesta HANA)
  NroPP            : String(20);     // "R4603"
  Sociedad         : String(4);      // "0025"
  FechaPP          : String(10);     // "20-05-2026" (dd-MM-yyyy del contexto BPA)
  // Datos de la propuesta
  EstadoPP         : String(20);     // "PENDIENTE"|"VALIDACION"|"EN_FIRMA"|"FIRMADO"|...
  ViaPago          : String(1);      // "W"|"I"|"Z"|"C"|"N"
  ModalidadPP      : String(10);     // "H2H"|"CAR"
  Version          : String(4);      // "0001"
  Importe          : String(20);     // string porque viene del contexto BPA
  Moneda           : String(5);      // "PEN"
  Banco            : String(10);     // "BCP"
  BancoDescripcion : String(100);    // "001 - BCP Soles"
  UsrCreacionPP    : String(12);     // usuario SAP
  UserCrea         : String(100);    // email
  UserModif        : String(100);
  FechaModif       : DateTime;
  Analista         : String(12);     // usuario SAP del analista
  CorreoAnalista   : String(100);
  IndPAdelanto     : String(1);      // "X" | ""
  ExisteDoc        : String(10);     // "EXISTE" | ""
  IdInstanciaWF    : String(50);     // InstanceID del BPA
  NroDocCompensacion: String(20);
  FechaCompensacion : String(10);
  // FechaPPJS no va en el CDS (es un Date JS interno, no se serializa)
}

type CurrentUser {
  name : String;   // email del usuario autenticado (del getCurrentUserApi())
}

// Contexto BPA completo (campos del contexto.json verificado)
type ContextoBPA {
  NroPP           : String(20);
  Sociedad        : String(4);
  FechaPP         : String(10);
  TaskTitle       : String(100);
  Importe         : String(20);
  Moneda          : String(5);
  ModalidadPP     : String(10);
  ViaPago         : String(1);
  Banco           : String(10);
  BancoDescripcion: String(100);
  Version         : String(4);
  Analista        : String(12);
  CorreoAnalista  : String(100);
  UserCrea        : String(100);
  UsrCreacionPP   : String(12);
  ExisteDoc       : String(10);
  IndPAdelanto    : String(1);
  // Flags de visibilidad de botones UI5
  bRevisor        : Boolean;
  bCaja           : Boolean;
  bAprobado       : Boolean;
  bConforme       : Boolean;
  bConformeTermina: Boolean;
  bTerminar       : Boolean;
  bAnalista       : Boolean;
  bAnulado        : Boolean;
  // Usuarios asignados (CSV)
  usrRevisor      : String(500);
  usrApoderado    : String(500);
  usrSupervisor   : String(500);
  usrCaja         : String(500);
  usrAnalista     : String(500);
  // Contador firmas apoderado
  iContadorFirma  : Integer;
}

type ConstantesRpta {
  aSociedadesRevision : array of String;
  aValidarViaPago     : array of String;
  aAprobarViaPago     : array of String;
  aSociedadesTermina  : array of String;
  oTesoreros          : LargeString;   // JSON map { "sociedad": "email" }
  sDocumentUrl        : String;
  sDocumentUrlTasa    : String;
}

type AccionResult {
  success  : Boolean;
  mensaje  : String;
  estadoPP : String;
  taskId   : String;
}

// ── Servicio principal ─────────────────────────────────────────────

@path: '/nomina/aprobaciones'
service PagosService @(requires: 'authenticated-user') {

  // ── MASTER ────────────────────────────────────────────────────
  // Solo desktop (onInit del Master.controller.js)

  @Common.Label: 'Obtener constantes de negocio'
  function obtenerConstantes() returns ConstantesRpta;

  // ── DETAIL — LECTURA INICIAL ──────────────────────────────────
  // Reemplaza: readContext() + getPropuestaPago() en _onBindingChange

  type DetalleResult {
    pp         : PropuestaPago;
    contexto   : ContextoBPA;
    constantes : ConstantesRpta;
  }

  @Common.Label: 'Obtener detalle de propuesta y contexto BPA'
  function obtenerDetalle(taskId: String) returns DetalleResult;

  // ── ANALISTA TESORERÍA ────────────────────────────────────────

  @(requires: 'ANALISTA_T')
  action enviarSupervisorOCaja(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    constantes  : ConstantesRpta
  ) returns AccionResult;

  @(requires: 'ANALISTA_T')
  action compensar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA
  ) returns AccionResult;

  @(requires: 'ANALISTA_T')
  action cerrarPorObservacion(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA
  ) returns AccionResult;

  @(requires: 'ANALISTA_T')
  action eliminarDoc(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA
  ) returns AccionResult;

  // ── SUPERVISOR ─────────────────────────────────────────────────

  @(requires: 'SUPERVISOR')
  action supervisorAprobar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    constantes  : ConstantesRpta
  ) returns AccionResult;

  @(requires: 'SUPERVISOR')
  action supervisorTerminarFlujo(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    constantes  : ConstantesRpta
  ) returns AccionResult;

  @(requires: 'SUPERVISOR')
  action supervisorObservar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    comentario  : String
  ) returns AccionResult;

  // ── REVISOR ────────────────────────────────────────────────────

  @(requires: 'REVISOR')
  action revisorAprobar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    comentario  : String
  ) returns AccionResult;

  @(requires: 'REVISOR')
  action revisorObservar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    comentario  : String
  ) returns AccionResult;

  // ── APODERADO ──────────────────────────────────────────────────

  @(requires: 'APODERADO')
  action apoderadoFirmar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    constantes  : ConstantesRpta
  ) returns AccionResult;

  @(requires: 'APODERADO')
  action apoderadoObservar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    comentario  : String
  ) returns AccionResult;

  // ── CAJA ───────────────────────────────────────────────────────

  @(requires: 'CAJA')
  action cajaConfirmarPago(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA
  ) returns AccionResult;

  @(requires: 'CAJA')
  action cajaObservar(
    pp          : PropuestaPago,
    currentUser : CurrentUser,
    taskId      : String,
    contexto    : ContextoBPA,
    comentario  : String
  ) returns AccionResult;
}
