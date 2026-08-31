// Definición de dominio: entidades, tipos y acciones del servicio H2H Nómina.
// No contiene anotaciones @UI (viven en app/ui5-aprobaciones/annotations.cds)
// ni lógica de negocio (vive en pagos-service.js / domain/aprobacion.service.js).
//
// Roles activos en flujo: Apoderado (pool con quórum de 2), Liberador.
// Coordinador: no activo — acciones conservadas para uso futuro.

// Tipo PropuestaNomina — fuente de verdad: DataType BPA aprobacionDeNomina.
type PropuestaNomina {
    // Identificación del lote
    sociedad               : String;
    numeroPropuesta        : String;
    version                : String;
    modalidadPP            : String;
    tipoNomina             : String;    // PPP en el tituloTarea
    tipoTrabajador         : String;    // E = Empleados, P = Practicantes
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
    fechaPago              : String;    // formato yyyy-MM-dd
    tituloTarea            : String;    // "SSSS – DD/MM/AAAA - PPP - BBBB – X - MMM[ - DDDD]"

    // Control documental
    existeDocumento        : Boolean;
    contadorFirma          : Integer;
    cantidad               : Integer;   // Cant. Registros

    // Usuarios — strings individuales, sin arrays
    analista               : String;    // email consolidado del analista
    usuarioCreacion        : String;
    usuarioRevisor         : String;
    correoAnalista         : String;
    usuarioCoordinador     : String;    // reservado para uso futuro

    // Apoderados habilitados para firmar esta propuesta. CSV de correos en
    // minúsculas; Payroll garantiza que trae al menos 2.
    usuariosApoderados     : String;

    // Legado: dos apoderados fijos, uno por rama paralela. Fuera del flujo
    // activo — no usar para autorizar ni para pintar; usar usuariosApoderados.
    usuarioApoderado1      : String;
    usuarioApoderado2      : String;

    // Uno o varios liberadores, mismo formato CSV que usuariosApoderados;
    // basta una sola liberación para cerrar el paso (ver srv/config/perfiles.js).
    usuarioLiberador       : String;

    usuarioCaja            : String;

    // Flags de estado (legado — no usados para visibilidad en la UI actual)
    tieneAnalista          : Boolean;
    estaConforme           : Boolean;
    estaAprobado           : Boolean;
    esCaja                 : Boolean;
    estaTerminado          : Boolean;
    estaAnulado            : Boolean;

    // Campos escritos por CPI/BPA en el contexto de la tarea. `perfil`
    // transporta el slot de firma ("1"/"2" apoderado, "3" liberador), no un
    // perfil por usuario; CAP no lo envía para apoderados (ver perfiles.js).
    perfil                 : String;
    comentario             : String;    // comentario libre del firmante
    taskInstanceId         : String;    // ID usado por CPI para mapear el proceso
};

/** Resultado estándar de las acciones de aprobación. */
type AccionResult {
    exito   : Boolean;
    mensaje : String;
};

service PagosService @(path: '/nomina/aprobaciones') {

    // Lista y detalle de tareas pendientes del usuario autenticado.
    // Clave: instanceID = campo "id" de la API de tasks de BPA Workflow.
    @cds.persistence.skip
    entity TareasInbox {
        key instanceID          : String(255);

        // Campos del List Report
        tituloTarea             : String(255);
        banco                   : String(50);
        bancoDescripcion        : String(100);  // descripción del banco ("001 - BCP Soles")

        // "Grupo Pers." del formulario, derivado de tipoTrabajador (E/P) por
        // config/grupos-personal.js.
        grupoPersonal           : String(30);

        // importe/moneda son los valores crudos del contexto BPA. Lo que se
        // muestra es importeTexto, formateado por CAP ("S/ 43,038.69").
        importe                 : String(30);
        moneda                  : String(5);
        importeTexto            : String(30);
        sociedad                : String(10);
        numeroPropuesta         : String(20);
        fechaPropuestaPago      : Date;
        fechaPago               : Date;
        estadoTarea             : String(20);       // READY | RESERVED
        workflowInstanceId      : String(255);      // ID del proceso padre

        // Campos del Object Page — escalares de la propuesta
        estadoPP                : String(50);
        estadoCriticidad        : Integer;    // UI.CriticalityType: 0=Neutral 1=Negative 2=Critical 3=Positive
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
        cantidad                : Integer;          // "Cant. Registros"
        analista                : String(100);
        usuarioCreacion         : String(100);
        usuarioRevisor          : String(100);       // "Revisado por"
        correoAnalista          : String(100);
        usuarioLiberador        : String(1000);      // lista de liberadores, separada por ", "
        usuarioCoordinador      : String(100);      // reservado para uso futuro
        usuarioCaja             : String(100);
        estaAnulado             : Boolean;
        estaTerminado           : Boolean;

        // ── Quórum de apoderados ─────────────────────────────────────────────
        // Los apoderados son una lista de N usuarios equivalentes; bastan dos
        // firmas cualesquiera para avanzar al Liberador (tarea única con pool
        // de destinatarios). Origen: usuariosApoderados + context.custom.* que
        // BPA recalcula en cada firma (ver perfiles.resolverQuorumApoderados).

        usuariosApoderados      : String(1000);     // lista completa habilitada
        apoderadosFirmantes     : String(1000);     // quiénes ya firmaron
        apoderadosPendientes    : String(1000);     // quiénes siguen pudiendo firmar

        contadorFirmasApoderados: Integer;
        firmasRequeridas        : Integer;          // viene de BPA (custom.firmasrequeridas)

        firmasTexto             : String(40);       // "1 de 2 firmas", ya compuesto por CAP

        // true cuando ECP no confirmó ninguna firma y el diagrama muestra solo
        // el flujo previsto (sin firmantes ni fechas reales).
        historialEsDemo         : Boolean;

        // Resultado de la notificación a Payroll (ECP vía CPI) del intento
        // anterior; vacíos hasta el primer rechazo (ver
        // perfiles.resolverCamposNotificacion).
        notifTieneError         : Boolean;          // true si Payroll devolvió EpFlagError = "X"
        notifMensaje            : String(500);      // EpMensaje — texto de negocio de Payroll
        notifCriticidad         : Integer;          // UI.CriticalityType: 1=Negative si hay error, 0=Neutral

        // Flags de visibilidad por rol — calculados por perfiles.calcularFlagsRol()
        esApoderado             : Boolean;          // taskDefinitionId = form_aprobacionDelApoderado_1
        esLiberador             : Boolean;          // taskDefinitionId = form_aprobacionLiberadorFinal_1
        esCoordinador           : Boolean;          // siempre false en flujo activo

        // Composiciones — cargadas solo al abrir el Object Page
        proveedores             : Composition of many Proveedor
                                    on proveedores.instanceID = instanceID;
        adjuntos                : Composition of many Adjunto
                                    on adjuntos.instanceID = instanceID;

        // Historial de aprobaciones renderizado como sap.suite.ui.commons.ProcessFlow:
        //   niveles     → lanes (columnas del diagrama)
        //   aprobadores → nodes (tarjetas de firmante)
        niveles                 : Composition of many NivelAprobacion
                                    on niveles.instanceID = instanceID;
        aprobadores             : Composition of many Aprobador
                                    on aprobadores.instanceID = instanceID;
    };

    // Acciones bound de TareasInbox (sintaxis CDS 9.x).
    extend entity TareasInbox with actions {

        // Apoderado (pool con quórum de 2) — contexto BPA: startEvent.body
        // Visibilidad: esApoderado = true | Decisiones: aprobar | rechazar
        // Un usuario que ya firmó sale del pool y CAP rechaza (403) una
        // segunda firma (ver perfiles.esDestinatarioAutorizado).

        /** El apoderado confirma la propuesta de nómina. */
        action apoderadoAprobar()                     returns AccionResult;

        /** El apoderado rechaza la propuesta y la devuelve al analista con un motivo. */
        action apoderadoRechazar(comentario: String) returns AccionResult;

        // Liberador Final (LI) — contexto BPA: startEvent.propuesta
        // Visibilidad: esLiberador = true | Decisiones: liberar | rechazar | anular

        /** El liberador autoriza el desembolso de la nómina. */
        action liberadorLiberar()                     returns AccionResult;

        /** El liberador rechaza la propuesta (regresa al flujo de apoderados). */
        action liberadorRechazar(comentario: String) returns AccionResult;

        /** El liberador anula definitivamente la propuesta de nómina. */
        action liberadorAnular(comentario: String)   returns AccionResult;

        // Acciones masivas del List Report — un solo par de botones para los
        // dos roles, porque la toolbar no puede ocultar botones por fila.
        // Resuelven la decisión BPA a partir del taskDefinitionId de cada
        // tarea y desembocan en el mismo camino que las acciones por rol
        // (_prepararAccion → _completar).
        //   Apoderado → aprobar | rechazar
        //   Liberador → liberar | rechazar
        // Anular no tiene equivalente masivo: cierra el proceso sin vuelta atrás.

        /** Aprueba (apoderado) o libera (liberador) la tarea seleccionada. */
        action aprobarMasivo()                        returns AccionResult;

        /** Rechaza la tarea seleccionada, sea de apoderado o de liberador. */
        action rechazarMasivo(comentario: String)     returns AccionResult;

        // Coordinador (CO) — no activo en el flujo (esCoordinador = false siempre)

        /** [FUTURO] El coordinador valida y envía al flujo de apoderados. */
        action coordinadorAprobar(comentario: String)  returns AccionResult;

        /** [FUTURO] El coordinador rechaza el lote de nómina. */
        action coordinadorRechazar(comentario: String) returns AccionResult;
    };

    // Lista de valores del filtro "Estado" del List Report — proyección de
    // config/estados.js. La clave es el texto porque TareasInbox.estadoPP
    // transporta el texto y el $filter compara sobre él.
    @readonly
    @cds.persistence.skip
    entity EstadosPropuesta {
        key estadoPP    : String(50);       // 'Pendiente de Liberación'
            criticidad  : Integer;          // UI.CriticalityType — color del estado
    };

    // PropuestaPDF — el documento como entidad media: sap.m.PDFViewer monta un
    // <iframe> sobre su URL y el navegador la renderiza (por eso no es una
    // función que devuelva base64). La clave es la terna que identifica la
    // propuesta en SAP ('<numeroPropuesta>-<sociedad>-<yyyy-MM-dd>'), la
    // misma con la que reasignacion-service.js agrupa tareas.
    // @Core.MediaType + ContentDisposition.Type: 'inline' hacen que el
    // navegador muestre el PDF en vez de descargarlo.
    @readonly
    @cds.persistence.skip
    entity PropuestaPDF {
        key id                 : String(120);   // 'R4603-0025-2026-05-20'
            numeroPropuesta    : String(20);
            sociedad           : String(10);
            fechaPropuestaPago : String(10);
            nombreArchivo      : String(150);

            @Core.IsMediaType
            mimeType           : String(50);

            @Core.MediaType                 : mimeType
            @Core.ContentDisposition.Filename: nombreArchivo
            @Core.ContentDisposition.Type   : 'inline'
            contenido          : LargeBinary;
    };

    /** Proveedor — beneficiarios del lote de pago. */
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

    /** Adjunto — documentos vinculados a la propuesta. */
    @cds.persistence.skip
    entity Adjunto {
        key instanceID      : String(255);
        key nombre          : String(255);
        url                 : String(500);
        tipoDocumento       : String(50);
        fechaCarga          : String(20);
    };

    // NivelAprobacion — lanes del ProcessFlow. Un nivel = una columna del
    // diagrama; CAP lo deriva agrupando el historial por el campo `nivel` de
    // cada firmante (ver historial.service.js → _derivarNiveles). Mapea 1:1
    // a sap.suite.ui.commons.ProcessFlowLaneHeader.
    @cds.persistence.skip
    entity NivelAprobacion {
        key instanceID      : String(255);
        key laneId          : String(20);       // 'N1' | 'N2' | … — enlaza con Aprobador.laneId
        posicion            : Integer;          // 0-based y secuencial — requisito del control
        texto               : String(60);       // etiqueta bajo el ícono
        descripcion         : String(60);       // rol del nivel: 'Apoderados'
        icono               : String(100);      // sap-icon://employee

        // El anillo de color de la cabecera lo calcula el propio ProcessFlow
        // contando el estado de los nodos; CAP solo aporta el texto:
        estadoTexto         : String(120);      // '1 completado, 1 en curso'
        resumen             : String(180);      // 'Apoderados · 1 completado, 1 en curso' (tooltip)
    };

    // Aprobador — historial de firmas de la propuesta (nodes). Cada fila es
    // un nodo del ProcessFlow; todos los campos de presentación los calcula
    // CAP en historial.service.js. Mapea 1:1 a sap.suite.ui.commons.ProcessFlowNode.
    @cds.persistence.skip
    entity Aprobador {
        key instanceID      : String(255);
        key nodeId          : String(50);       // 'N1-1' — identidad del nodo en el grafo
        laneId              : String(20);       // columna a la que pertenece (→ NivelAprobacion)
        nivel               : Integer;          // 1-based, tal como llega del iFlow
        orden               : Integer;          // orden dentro del nivel (firmas paralelas)

        // Aristas del grafo: nodeIds del/los nodo(s) siguiente(s), CSV (OData V4
        // no permite enlazar una colección a una propiedad de control; el
        // fragmento la convierte en array con un formatter — ext/util/Historial.js).
        hijos               : String(200);

        // Identidad del firmante
        usuario             : String(100);      // login / email
        nombre              : String(120);      // nombre para mostrar
        cargo               : String(120);      // 'Apoderado 1', 'Liberador Final'
        iniciales           : String(2);        // fallback del Avatar cuando no hay foto
        fotoUrl             : String(500);      // foto desde CPI/SuccessFactors (vacío hoy)

        // Resultado de su intervención
        rol                 : String(30);       // AN | AP | LI | CO — códigos de perfiles.js
        decision            : String(30);       // APROBADO | OBSERVADO | PENDIENTE | …
        decisionTexto       : String(60);       // texto mostrado al usuario
        comentario          : String(500);
        fechaAccion         : String(30);       // ISO 8601 — trazabilidad y orden
        fechaTexto          : String(30);       // dd/MM/yyyy HH:mm en hora de Perú — presentación

        // Estado visual — valores literales de las enumeraciones de UI5
        estadoNodo          : String(20);       // ProcessFlowNodeState: Positive|Negative|Neutral|Planned|Critical
        estadoTexto         : String(60);       // stateText del nodo (accesibilidad + tooltip)
        decisionValueState  : String(10);       // sap.ui.core.ValueState del ObjectStatus
        esActual            : Boolean;          // nodo en curso → highlighted + focused
    };
}
