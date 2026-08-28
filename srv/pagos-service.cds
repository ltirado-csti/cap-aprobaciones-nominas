// =============================================================================
// srv/pagos-service.cds
//
// DEFINICIÓN de dominio: entidades, tipos y acciones del servicio H2H Nómina.
// NO contiene anotaciones @UI (viven en app/ui5-aprobaciones/annotations.cds).
// NO contiene lógica de negocio (vive en pagos-service.js / aprobacion.service.js).
//
// Estado BPA v1.2.0 (H2H Nomina 1.4.0):
//   Roles activos en flujo: Apoderado (pool con quórum de 2), Liberador.
//   Coordinador: anulado en v1.1.0 — acciones conservadas para uso futuro.
// =============================================================================

// =============================================================================
// Tipo: PropuestaNomina (fuente de verdad = DataType BPA aprobacionDeNomina)
// Verificado contra el DataType del despliegue H2H Nomina 1.4.0.
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
    fechaPago              : String;    // formato yyyy-MM-dd — añadido en el DataType 1.4.0
    tituloTarea            : String;    // "SSSS – DD/MM/AAAA - PPP - BBBB – X - MMM[ - DDDD]"

    // Control documental
    existeDocumento        : Boolean;
    contadorFirma          : Integer;
    cantidad               : Integer;   // Cant. Registros — añadido en el DataType 1.4.8

    // Usuarios — strings individuales, sin arrays
    analista               : String;    // email consolidado del analista
    usuarioCreacion        : String;
    usuarioRevisor         : String;    // añadido en el DataType 1.4.8
    correoAnalista         : String;
    usuarioCoordinador     : String;    // reservado para uso futuro

    // Lista de apoderados habilitados para firmar esta propuesta.
    // CSV de correos en minúsculas, sin espacios y sin coma final — el formato
    // que BPA normaliza en el script `inicializarApoderados` y con el que
    // alimenta el pool de destinatarios de la tarea de apoderado.
    // Payroll garantiza que trae al menos 2.
    usuariosApoderados     : String;

    // LEGADO — dos apoderados fijos, uno por rama paralela. Siguen en el
    // DataType de BPA por compatibilidad, pero quedaron FUERA del flujo activo
    // con el quórum de v1.2.0 y CPI ya no debe mapearlos. No usar para
    // autorizar ni para pintar: la lista buena es usuariosApoderados.
    usuarioApoderado1      : String;
    usuarioApoderado2      : String;

    // Uno o VARIOS liberadores, en el mismo formato CSV que usuariosApoderados:
    // BPA reparte esa lista como destinatarios de la tarea de liberación y basta
    // una sola liberación para cerrar el paso (ver srv/config/perfiles.js).
    usuarioLiberador       : String;

    usuarioCaja            : String;

    // Flags de estado (legado — no usados para visibilidad en UI v1.1.0+)
    tieneAnalista          : Boolean;
    estaConforme           : Boolean;
    estaAprobado           : Boolean;
    esCaja                 : Boolean;
    estaTerminado          : Boolean;
    estaAnulado            : Boolean;

    // Campos escritos por CPI/BPA en el contexto de la tarea
    //
    // perfil: literal IpPerfil que Payroll recibe. Transporta el SLOT DE FIRMA
    // ("1" primera de apoderado, "2" segunda, "3" liberador), no un perfil por
    // usuario. Para los apoderados lo calcula BPA en tiempo de ejecución
    // (custom.perfilfirma), así que CAP no lo envía nunca — ver perfiles.js.
    perfil                 : String;
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

        // importe/moneda son los valores crudos del contexto BPA — se conservan
        // para trazabilidad y para cualquier cálculo. Lo que se MUESTRA es
        // importeTexto, ya formateado por CAP con la convención peruana
        // ("S/ 43,038.69"): ver _formatearImporte en pagos-service.js.
        importe                 : String(30);
        moneda                  : String(5);
        importeTexto            : String(30);
        sociedad                : String(10);
        numeroPropuesta         : String(20);
        // Date (no String): así el filtro de Fiori Elements pinta un DatePicker
        // con calendario en vez de un campo de texto libre. El contexto BPA ya
        // entrega estos valores en ISO (yyyy-MM-dd) — ver PropuestaNomina más
        // arriba — que es exactamente el formato de Edm.Date, así que no hace
        // falta convertir nada en _extraerPropuesta.
        fechaPropuestaPago      : Date;
        fechaPago               : Date;
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
        cantidad                : Integer;          // "Cant. Registros" — DataType 1.4.8
        analista                : String(100);
        usuarioCreacion         : String(100);
        usuarioRevisor          : String(100);       // "Revisado por" — DataType 1.4.8
        correoAnalista          : String(100);
        // Lista, no un correo: Payroll puede designar varios liberadores y el
        // servicio la entrega normalizada y separada por ", ". 1000 y no 100 por
        // el mismo motivo que usuariosApoderados — cuatro correos ya se pasan de
        // 100 caracteres, y el recorte silencioso dejaría una lista mentirosa.
        usuarioLiberador        : String(1000);
        usuarioCoordinador      : String(100);      // reservado para uso futuro
        usuarioCaja             : String(100);
        estaAnulado             : Boolean;
        estaTerminado           : Boolean;

        // ── Quórum de apoderados (BPA v1.2.0) ────────────────────────────────
        // Los apoderados son una LISTA de N usuarios equivalentes y bastan DOS
        // firmas cualesquiera para avanzar al Liberador. La tarea es una sola,
        // con pool de destinatarios, y reaparece por loop back hasta el quórum.
        //
        // Origen: usuariosApoderados de la propuesta + context.custom.* que BPA
        // recalcula en cada firma (ver perfiles.resolverQuorumApoderados).

        // Lista completa de apoderados habilitados — CSV de correos.
        usuariosApoderados      : String(1000);

        // Quiénes ya firmaron y quiénes siguen pudiendo hacerlo — CSV.
        apoderadosFirmantes     : String(1000);
        apoderadosPendientes    : String(1000);

        // Estado del quórum. firmasRequeridas viene de BPA (custom.firmasrequeridas)
        // y no se fija en CAP: es el punto de configuración para escalar a "M de N".
        contadorFirmasApoderados: Integer;
        firmasRequeridas        : Integer;

        // "1 de 2 firmas" — ya compuesto por CAP, igual que importeTexto y las
        // fechas del historial: el frontend enlaza, no calcula. Vacío cuando la
        // tarea no es de apoderado, para que la UI pueda ocultarlo sin lógica.
        firmasTexto             : String(40);

        // true cuando ECP no confirmó ninguna firma de esta propuesta y el
        // diagrama muestra solo el flujo PREVISTO — sin firmantes ni fechas
        // reales. Ocurre si el iFlow no responde o si la propuesta aún no tiene
        // firmas. El Object Page lo usa para mostrar un aviso; pasa a false solo
        // en cuanto ECP devuelve una firma utilizable.
        historialEsDemo         : Boolean;

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
        //
        // esApoderado1/esApoderado2 desaparecieron con el quórum de v1.2.0: ya
        // no hay dos tareas de apoderado que distinguir, sino una con pool. Qué
        // slot de firma ocupa cada usuario lo decide BPA al completarla.
        esApoderado             : Boolean;          // taskDefinitionId = form_aprobacionDelApoderado_1
        esLiberador             : Boolean;          // taskDefinitionId = form_aprobacionLiberadorFinal_1
        esCoordinador           : Boolean;          // siempre false en flujo activo

        // Composiciones — cargadas solo al abrir el Object Page
        proveedores             : Composition of many Proveedor
                                    on proveedores.instanceID = instanceID;
        adjuntos                : Composition of many Adjunto
                                    on adjuntos.instanceID = instanceID;

        // Historial de aprobaciones renderizado como sap.suite.ui.commons.ProcessFlow.
        // Son las DOS agregaciones que el control necesita, ya calculadas por CAP:
        //   niveles     → lanes (columnas del diagrama)
        //   aprobadores → nodes (tarjetas de firmante)
        niveles                 : Composition of many NivelAprobacion
                                    on niveles.instanceID = instanceID;
        aprobadores             : Composition of many Aprobador
                                    on aprobadores.instanceID = instanceID;
    };

    // =========================================================================
    // Acciones bound de TareasInbox
    // Sintaxis CDS 9.x: extend entity X with actions { ... }
    // =========================================================================
    extend entity TareasInbox with actions {

        // Apoderado (pool con quórum de 2) — contexto BPA: startEvent.body
        // Visibilidad: esApoderado = true | Decisiones: aprobar | rechazar
        //
        // Un mismo usuario solo puede aprobar UNA vez: al firmar, BPA lo saca
        // del pool y CAP rechaza (403) a quien ya no está en él. Ver
        // perfiles.esApoderadoAutorizado y aprobacion.service._prepararAccion.
        //
        // Regla de negocio BPA: Aprobar/Liberar NO llevan parámetro → Fiori
        // Elements los ejecuta directamente. Rechazar/Anular llevan
        // (comentario: String) → FE genera automáticamente el diálogo de
        // parámetro para capturar el motivo antes de invocar la acción.

        // El apoderado confirma la propuesta de nómina (ejecución directa)
        action apoderadoAprobar()                     returns AccionResult;

        // El apoderado rechaza la propuesta y la devuelve al analista con un motivo.
        // Renombrada desde apoderadoObservar: BPM H2H Nomina 1.5.0 cambió el
        // outcome del formulario de apoderado de "Observar" a "Rechazar"
        // (mismo id "rechazar" que espera BPA al completar la tarea).
        action apoderadoRechazar(comentario: String) returns AccionResult;

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
    // Lista de valores del filtro "Estado" del List Report
    //
    // No es una tabla ni un maestro: es la proyección de config/estados.js, la
    // misma tabla de la que sale el estadoPP de cada tarea. La clave es el
    // TEXTO y no un código porque TareasInbox.estadoPP transporta el texto —
    // el $filter compara sobre él, así que la lista de valores tiene que
    // ofrecer exactamente esa cadena.
    // =========================================================================
    @readonly
    @cds.persistence.skip
    entity EstadosPropuesta {
        key estadoPP    : String(50);       // 'Pendiente de Liberación'
            criticidad  : Integer;          // UI.CriticalityType — color del estado
    };

    // =========================================================================
    // PropuestaPDF — el documento de la propuesta como entidad media
    //
    // Existe para que el frontend tenga una URL que devuelva BYTES: sap.m.PDFViewer
    // monta un <iframe> sobre ella y el visor nativo del navegador la renderiza.
    // Por eso NO se modela como función que devuelva base64 — obligaría a armar un
    // blob en el cliente y a duplicar en memoria un documento que puede pesar MB.
    //
    // La clave es la terna que identifica la propuesta en SAP —
    // '<numeroPropuesta>-<sociedad>-<yyyy-MM-dd>' — y no el instanceID de BPA:
    // son esos tres campos los que identifican el documento en SAP —y los que
    // viajarán al iFlow de CPI que lo entrega—, y la misma terna con la que
    // reasignacion-service.js agrupa tareas (ver _clavePropuesta).
    // TareasInbox.urlPDF la construye ya armada.
    //
    // @Core.MediaType + @Core.ContentDisposition.Type: 'inline' son lo que hace
    // que el navegador MUESTRE el PDF en vez de descargarlo: con el disposition
    // por defecto ('attachment') el iframe del visor dispararía una descarga y
    // quedaría en blanco.
    // =========================================================================
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
    // Composición: NivelAprobacion — lanes del ProcessFlow
    //
    // Un nivel = una columna del diagrama de flujo (Nivel 1 → Nivel 2 → …).
    // NO viene de CPI: CAP lo DERIVA agrupando el historial por el campo `nivel`
    // de cada firmante (ver historial.service.js → _derivarNiveles). El iFlow solo
    // entrega filas planas; la topología del diagrama se calcula en CAP.
    //
    // Mapea 1:1 a sap.suite.ui.commons.ProcessFlowLaneHeader.
    // =========================================================================
    @cds.persistence.skip
    entity NivelAprobacion {
        key instanceID      : String(255);
        key laneId          : String(20);       // 'N1' | 'N2' | … — enlaza con Aprobador.laneId
        posicion            : Integer;          // 0-based y SECUENCIAL — requisito del control
        texto               : String(60);       // etiqueta bajo el ícono: 'Nivel 1'
        descripcion         : String(60);       // rol del nivel: 'Apoderados'
        icono               : String(100);      // sap-icon://employee

        // Estado agregado del nivel, en texto.
        //
        // El ANILLO de color de la cabecera no se transporta: lo calcula el propio
        // ProcessFlow contando el estado de los nodos de cada lane y lo reescribe
        // en cada render, así que enviarlo sería un campo muerto. Como esos estados
        // de nodo los decide CAP, el color del nivel sigue saliendo de la lógica de
        // negocio; el control solo hace el recuento.
        //
        // Lo que el control NO ofrece es el texto, y eso sí lo aporta CAP:
        estadoTexto         : String(120);      // '1 completado, 1 en curso'
        resumen             : String(180);      // 'Apoderados · 1 completado, 1 en curso' (tooltip)
    };

    // =========================================================================
    // Composición: Aprobador — historial de firmas de la propuesta (nodes)
    //
    // Cada fila es un nodo del ProcessFlow. Todos los campos de presentación
    // (estadoNodo, decisionValueState, iniciales, hijos, fechaTexto) los calcula
    // CAP en historial.service.js: el frontend solo enlaza propiedades, no
    // interpreta reglas de negocio.
    //
    // Mapea 1:1 a sap.suite.ui.commons.ProcessFlowNode.
    // =========================================================================
    @cds.persistence.skip
    entity Aprobador {
        key instanceID      : String(255);
        key nodeId          : String(50);       // 'N1-1' — identidad del nodo en el grafo
        laneId              : String(20);       // columna a la que pertenece (→ NivelAprobacion)
        nivel               : Integer;          // 1-based, tal como llega del iFlow
        orden               : Integer;          // orden dentro del nivel (firmas paralelas)

        // Aristas del grafo: nodeIds del/los nodo(s) siguiente(s), separados por coma.
        // Se transporta como CSV y no como `array of String` a propósito: OData V4
        // no permite enlazar una propiedad de colección a una propiedad de control
        // (ODataPropertyBinding exige valores primitivos). El fragmento la convierte
        // en array con un formatter de una línea (ext/util/Historial.js).
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