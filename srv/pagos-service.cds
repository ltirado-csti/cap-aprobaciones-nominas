// =============================================================================
// srv/pagos-service.cds
//
// DEFINICIÓN de dominio: entidades, tipos y acciones del servicio H2H Nómina.
// NO contiene anotaciones @UI (viven en app/ui5-aprobaciones/annotations.cds).
// NO contiene lógica de negocio (vive en pagos-service.js / aprobacion.service.js).
//
// Estado BPA v1.1.5:
//   Roles activos en flujo: Apoderado1, Apoderado2, Liberador.
//   Coordinador: anulado en v1.1.0 — acciones conservadas para uso futuro.
// =============================================================================

// =============================================================================
// Tipo: PropuestaNomina (fuente de verdad = DataType BPA aprobacionDeNomina)
// 35 campos — versión 1.1.5
// =============================================================================
type PropuestaNomina {
    // Identificación del lote
    sociedad               : String;
    numeroPropuesta        : String;
    version                : String;
    modalidadPP            : String;
    tipoNomina             : String;    // PPP en el tituloTarea
    tipoTrabajador         : String;    // E = Empleado, P = Pensionista
    subdivision            : String;    // Aplica solo en AESA

    // Datos de pago
    banco                  : String;
    bancoDescripcion       : String;
    moneda                 : String;
    importe                : String;
    viaPago                : String;
    indicadorPagoAdelanto  : String;

    // Fechas y título
    fechaPropuestaPago     : String;    // formato yyyy-MM-dd
    tituloTarea            : String;    // "SSSS – DD/MM/AAAA - PPP - BBBB – X - MMM[ - DDDD]"

    // Control documental
    existeDocumento        : Boolean;
    contadorFirma          : Integer;

    // Usuarios — strings individuales, sin arrays
    analista               : String;    // email consolidado del analista
    usuarioCreacion        : String;
    usuarioCreacionPP      : String;
    correoAnalista         : String;
    usuarioCoordinador     : String;    // reservado para uso futuro
    usuarioApoderado1      : String;
    usuarioApoderado2      : String;
    usuarioLiberador       : String;
    usuarioCaja            : String;

    // Flags de estado (legado — no usados para visibilidad en UI v1.1.0+)
    tieneAnalista          : Boolean;
    estaConforme           : Boolean;
    estaAprobado           : Boolean;
    esCaja                 : Boolean;
    estaTerminado          : Boolean;
    estaAnulado            : Boolean;

    // Campos BPA v1.1.5 escritos por BPA en el contexto de la tarea
    perfil                 : String;    // "AP" | "LI" | "CO" — literal IpPerfil de CPI
    comentario             : String;    // comentario libre del firmante
    taskInstanceId         : String;    // ID usado por CPI para mapear el proceso
};

// =============================================================================
// Tipo: resultado estándar de las acciones de aprobación
// =============================================================================
type AccionResult {
    exito   : Boolean;
    mensaje : String;
};

// =============================================================================
// Servicio principal
// =============================================================================
service PagosService @(path: '/nomina/aprobaciones') {

    // =========================================================================
    // Entidad principal: TareasInbox
    // Lista y detalle de tareas pendientes del usuario autenticado.
    // Clave: instanceID = campo "id" de la API de tasks de BPA Workflow.
    // =========================================================================
    @cds.persistence.skip
    entity TareasInbox {
        // Clave única de la tarea BPA
        key instanceID          : String(255);

        // Campos del List Report
        tituloTarea             : String(255);
        banco                   : String(50);
        importe                 : String(30);
        moneda                  : String(5);
        sociedad                : String(10);
        numeroPropuesta         : String(20);
        fechaPropuestaPago      : String(10);
        estadoTarea             : String(20);       // READY | RESERVED
        workflowInstanceId      : String(255);      // ID del proceso padre

        // Campos del Object Page — escalares de la propuesta
        estadoPP                : String(50);
        estadoCriticidad        : Integer;    // UI.CriticalityType: 0=Neutral 1=Negative 2=Critical 3=Positive — controla color/ícono de estadoPP
        urlPDF                  : String(500);
        modalidadPP             : String(20);
        viaPago                 : String(5);
        tipoNomina              : String(10);
        tipoTrabajador          : String(5);
        subdivision             : String(20);
        version                 : String(5);
        indicadorPagoAdelanto   : String(5);
        existeDocumento         : Boolean;
        contadorFirma           : Integer;
        analista                : String(100);
        usuarioCreacion         : String(100);
        correoAnalista          : String(100);
        usuarioApoderado1       : String(100);
        usuarioApoderado2       : String(100);
        usuarioLiberador        : String(100);
        usuarioCoordinador      : String(100);      // reservado para uso futuro
        usuarioCaja             : String(100);
        estaAnulado             : Boolean;
        estaTerminado           : Boolean;

        // Resultado de la notificación a Payroll (ECP vía CPI) del intento anterior.
        // BPA notifica a Payroll al decidir; si Payroll rechaza, el flujo hace loop
        // back y la tarea REAPARECE en el inbox. Estos campos explican por qué.
        // Origen: context.custom.* del contexto BPA (ver perfiles.resolverCamposNotificacion).
        // Vacíos en el primer intento — solo se pueblan tras un rechazo de Payroll.
        notifTieneError         : Boolean;          // true si Payroll devolvió EpFlagError = "X"
        notifMensaje            : String(500);      // EpMensaje — texto de negocio de Payroll
        notifCriticidad         : Integer;          // UI.CriticalityType: 1=Negative si hay error, 0=Neutral

        // Flags de visibilidad por rol — calculados por perfiles.calcularFlagsRol()
        // XSUAA + taskDefinitionId son la única fuente de verdad del rol.
        esApoderado1            : Boolean;          // taskDefinitionId = form_aprobacionDelApoderado_1
        esApoderado2            : Boolean;          // taskDefinitionId = form_aprobacionDelApoderado_2
        esApoderado             : Boolean;          // esApoderado1 || esApoderado2
        esLiberador             : Boolean;          // taskDefinitionId = form_aprobacionLiberadorFinal_1
        esCoordinador           : Boolean;          // siempre false en flujo activo v1.1.0

        // Composiciones — cargadas solo al abrir el Object Page
        proveedores             : Composition of many Proveedor
                                    on proveedores.instanceID = instanceID;
        adjuntos                : Composition of many Adjunto
                                    on adjuntos.instanceID = instanceID;
        aprobadores             : Composition of many Aprobador
                                    on aprobadores.instanceID = instanceID;
    };

    // =========================================================================
    // Acciones bound de TareasInbox
    // Sintaxis CDS 9.x: extend entity X with actions { ... }
    // =========================================================================
    extend entity TareasInbox with actions {

        // Apoderado (AP1 y AP2) — contexto BPA: startEvent.body
        // Visibilidad: esApoderado = true | Decisiones: aprobar | observar
        //
        // Regla de negocio BPA: Aprobar/Liberar NO llevan parámetro → Fiori
        // Elements los ejecuta directamente. Observar/Rechazar/Anular llevan
        // (comentario: String) → FE genera automáticamente el diálogo de
        // parámetro para capturar el motivo antes de invocar la acción.

        // El apoderado confirma la propuesta de nómina (ejecución directa)
        action apoderadoAprobar()                     returns AccionResult;

        // El apoderado devuelve la propuesta al analista con una observación
        action apoderadoObservar(comentario: String) returns AccionResult;

        // Liberador Final (LI) — contexto BPA: startEvent.propuesta
        // Visibilidad: esLiberador = true | Decisiones: liberar | rechazar | anular

        // El liberador autoriza el desembolso de la nómina
        action liberadorLiberar()                     returns AccionResult;

        // El liberador rechaza la propuesta (regresa al flujo de apoderados)
        action liberadorRechazar(comentario: String) returns AccionResult;

        // El liberador anula definitivamente la propuesta de nómina
        action liberadorAnular(comentario: String)   returns AccionResult;

        // Coordinador (CO) — ANULADO en BPA v1.1.0, reservado para uso futuro
        // Visibilidad: siempre false (esCoordinador = false en el handler)
        // No mostrar en la UI mientras el flujo activo no incluya CO.

        // [FUTURO] El coordinador valida y envía al flujo de apoderados
        action coordinadorAprobar(comentario: String)  returns AccionResult;

        // [FUTURO] El coordinador rechaza el lote de nómina
        action coordinadorRechazar(comentario: String) returns AccionResult;
    };

    // =========================================================================
    // Composición: Proveedor — beneficiarios del lote de pago
    // =========================================================================
    @cds.persistence.skip
    entity Proveedor {
        key instanceID      : String(255);
        key posicion        : Integer;
        nombreProveedor     : String(200);
        cuentaBancaria      : String(50);
        banco               : String(50);
        moneda              : String(5);
        importe             : String(30);
        viaPago             : String(5);
    };

    // =========================================================================
    // Composición: Adjunto — documentos vinculados a la propuesta
    // =========================================================================
    @cds.persistence.skip
    entity Adjunto {
        key instanceID      : String(255);
        key nombre          : String(255);
        url                 : String(500);
        tipoDocumento       : String(50);
        fechaCarga          : String(20);
    };

    // =========================================================================
    // Composición: Aprobador — historial de firmas de la propuesta
    // =========================================================================
    @cds.persistence.skip
    entity Aprobador {
        key instanceID      : String(255);
        key orden           : Integer;
        usuario             : String(100);
        rol                 : String(30);
        decision            : String(30);
        comentario          : String(500);
        fechaAccion         : String(30);
    };
}