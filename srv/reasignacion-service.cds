// =============================================================================
// srv/reasignacion-service.cds
//
// DEFINICIÓN de dominio: servicio de administración para reasignar el
// destinatario de una tarea de aprobación en curso (Apoderado o Liberador
// Final) a otro usuario, cuando el destinatario original no está disponible.
//
// ── QUÓRUM DE APODERADOS (BPA v1.2.0) ────────────────────────────────────────
//
// Los apoderados dejaron de ser dos usuarios fijos: ahora son una lista de N
// usuarios equivalentes sobre UNA SOLA tarea con pool de destinatarios, de la
// que bastan dos firmas cualesquiera. Eso cambia la aritmética de esta app:
// una tarea BPA puede producir VARIAS filas de firmante, una por miembro del
// pool, y reasignar significa sustituir a una persona dentro de la lista de
// destinatarios — nunca reemplazar la lista entera por un solo correo.
//
// NO contiene anotaciones @UI (viven en app/ui5-reasignacion/annotations.cds).
// NO contiene lógica de negocio (vive en reasignacion-service.js /
// domain/reasignacion.service.js).
//
// Acceso restringido a administradores — ver xs-security.json (scope
// "Administrador").
//
// ── LA UNIDAD DE TRABAJO ES LA PROPUESTA ─────────────────────────────────────
//
// La raíz de la UI es PropuestasEnCurso, no TareasEnCurso: el administrador
// gestiona una propuesta, no una tarea suelta. Cada propuesta agrupa hasta tres
// firmantes (Apoderado 1, Apoderado 2, Liberador Final) de los que, en un
// instante dado, solo algunos tienen tarea viva en BPA.
//
// TareasEnCurso se conserva expuesta porque es la verdad de BPA a nivel tarea y
// resulta útil para diagnosticar, pero ya no es el objetivo de la aplicación.
// =============================================================================

type AccionReasignacion {
    exito   : Boolean;
    mensaje : String;
};

@requires: 'Administrador'
service ReasignacionService @(path: '/nomina/reasignacion') {

    // =========================================================================
    // Entidad principal: PropuestasEnCurso
    //
    // Una fila por propuesta con al menos una tarea viva. Se deriva agrupando
    // TareasEnCurso por la clave de negocio (sociedad + nº + fecha de pago) —
    // ver _clavePropuesta en reasignacion-service.js. NO se agrupa por
    // workflowInstanceId: apoderados y liberador corren en procesos BPA
    // distintos y ese ID los separaría.
    // =========================================================================
    @readonly
    @cds.persistence.skip
    entity PropuestasEnCurso {
        // Clave de negocio en formato seguro para URL: '0031~3127~2026-08-07'.
        // El separador '~' no aparece en ninguno de los tres campos y no obliga
        // a escapar nada en la ruta del Object Page.
        key propuestaID      : String(60);

        // La misma clave en formato legible: '0031 · 3127 · 2026-08-07'.
        grupoPropuesta       : String(80);

        sociedad             : String(10);
        numeroPropuesta      : String(20);
        fechaPropuestaPago   : String(10);
        fechaPago            : String(10);
        tituloTarea          : String(255);
        banco                : String(50);

        // importe crudo (ordena numéricamente) + ya formateado (se muestra),
        // misma convención que TareasEnCurso y que TareasInbox en PagosService.
        importe              : String(30);
        moneda               : String(5);
        importeTexto         : String(30);

        // Punto del flujo en el que está la propuesta, derivado de qué roles
        // tienen tarea viva: 'Pendiente de Apoderados' | 'Pendiente de Liberación'.
        estadoPropuesta      : String(60);
        estadoCriticidad     : Integer;      // UI.CriticalityType — ver config/estados.js

        // Destinatarios de las tareas vivas, en una línea, para poder localizar
        // una propuesta por la persona sin abrirla ni cruzar los firmantes.
        destinatarios        : String(300);

        // Cuántas de las tareas de esta propuesta están vivas ahora mismo.
        // OJO: ya no coincide con el número de personas pendientes — la tarea
        // de apoderado es una sola con N destinatarios.
        tareasPendientes     : Integer;

        // Estado del quórum de apoderados, para no tener que contar filas de
        // firmante: cuántas firmas hay, cuántas exige BPA y el texto compuesto.
        contadorFirmas       : Integer;
        firmasRequeridas     : Integer;
        firmasTexto          : String(40);   // '1 de 2 firmas'

        // Los tres firmantes del flujo, tengan o no tarea viva.
        firmantes            : Composition of many Firmante
                                 on firmantes.propuestaID = propuestaID;

        // Las DOS agregaciones que necesita sap.suite.ui.commons.ProcessFlow,
        // ya calculadas por CAP igual que en el Object Page de aprobaciones:
        //   niveles     → lanes (columnas del diagrama)
        //   aprobadores → nodes (tarjeta por firmante)
        niveles              : Composition of many NivelFlujo
                                 on niveles.propuestaID = propuestaID;
        aprobadores          : Composition of many NodoFlujo
                                 on aprobadores.propuestaID = propuestaID;
    };

    // =========================================================================
    // Composición: Firmante — una PERSONA del flujo de la propuesta
    //
    // Una fila por cada apoderado de la lista más una para el liberador, exista
    // o no su tarea. Esa es la razón de `reasignable`: BPA crea la instancia de
    // tarea cuando el token del flujo llega a ella, así que el liberador de una
    // propuesta que está en firma de apoderados TODAVÍA NO TIENE TAREA que
    // reasignar; y un apoderado que ya firmó tampoco, aunque la tarea siga viva
    // para sus compañeros. Se muestran igualmente para que el administrador vea
    // el flujo completo, con el botón inactivo y el porqué en motivoNoReasignable.
    // =========================================================================
    @readonly
    @cds.persistence.skip
    entity Firmante {
        key propuestaID          : String(60);

        // Clave de la fila. El rol dejó de servir como clave con el quórum:
        // un mismo rol ('Apoderado') tiene ahora N personas a la vez. Para el
        // pool es 'apoderado#<correo>'; para el liberador, 'liberador'.
        // Es lo que permite a la acción saber A QUIÉN está sustituyendo.
        key firmanteID           : String(150);

        // Rol para mostrar — 'Apoderado' | 'Liberador Final'. Se repite en
        // varias filas cuando el rol es un pool: es una etiqueta, no una clave.
        rol                      : String(30);

        // Orden en el flujo (2 = apoderados, 3 = liberación).
        // Ordena la tabla sin depender del alfabeto del rol.
        nivel                    : Integer;

        // La persona de esta fila. Con tarea viva de un rol de un solo
        // destinatario manda recipientUsers[0] de BPA —refleja reasignaciones
        // ya hechas—; en el pool, cada fila es un miembro de la lista.
        usuario                  : String(100);

        // 'Pendiente' | 'Reservada' | 'Firmado' | 'No iniciado'
        estadoFirmante           : String(30);
        estadoCriticidad         : Integer;

        // Estado del quórum al que pertenece esta firma. En el liberador van a
        // cero: su paso no tiene quórum, es una única aprobación.
        contadorFirmas           : Integer;
        firmasRequeridas         : Integer;

        // Tarea BPA de este firmante. Vacío si aún no existe o ya se completó.
        // En el pool, la MISMA tarea aparece en varias filas: es una sola tarea
        // con varios destinatarios posibles.
        instanceID               : String(255);
        estadoTarea              : String(20);   // READY | RESERVED

        // Gobierna Core.OperationAvailable de la acción: true solo cuando esta
        // persona concreta tiene todavía una firma que aportar.
        reasignable              : Boolean;
        motivoNoReasignable      : String(120);
    };

    // =========================================================================
    // Composición: NivelFlujo — lanes del ProcessFlow
    // Mismo shape que NivelAprobacion en pagos-service.cds: lo consume el mismo
    // fragmento y lo construye el mismo módulo (domain/historial.service.js).
    // =========================================================================
    @readonly
    @cds.persistence.skip
    entity NivelFlujo {
        key propuestaID     : String(60);
        key laneId          : String(20);
        posicion            : Integer;
        texto               : String(60);
        descripcion         : String(60);
        icono               : String(100);
        estadoTexto         : String(120);
        resumen             : String(180);
    };

    // =========================================================================
    // Composición: NodoFlujo — nodes del ProcessFlow
    // Mismo shape que Aprobador en pagos-service.cds.
    // =========================================================================
    @readonly
    @cds.persistence.skip
    entity NodoFlujo {
        key propuestaID     : String(60);
        key nodeId          : String(50);
        laneId              : String(20);
        nivel               : Integer;
        orden               : Integer;
        hijos               : String(200);      // CSV — ver ext/util/Historial.js
        usuario             : String(100);
        nombre              : String(120);
        cargo               : String(120);
        iniciales           : String(2);
        fotoUrl             : String(500);
        rol                 : String(30);
        decision            : String(30);
        decisionTexto       : String(60);
        comentario          : String(500);
        fechaAccion         : String(30);
        fechaTexto          : String(30);
        estadoNodo          : String(20);
        estadoTexto         : String(60);
        decisionValueState  : String(10);
        esActual            : Boolean;
    };

    // =========================================================================
    // TareasEnCurso — verdad de BPA a nivel tarea
    // Ya no es la raíz de la UI (lo es PropuestasEnCurso); se conserva expuesta
    // porque es de donde se derivan las propuestas y sirve para diagnosticar.
    // Clave: instanceID = campo "id" de la API de tasks de BPA Workflow.
    // =========================================================================
    @readonly
    @cds.persistence.skip
    entity TareasEnCurso {
        // Clave única de la tarea BPA
        key instanceID          : String(255);

        tituloTarea              : String(255);
        numeroPropuesta          : String(20);
        sociedad                 : String(10);
        banco                    : String(50);

        // importe: valor crudo del contexto BPA ("2290435.83"). Se conserva
        // porque es el que permite ordenar y filtrar numéricamente la columna.
        importe                  : String(30);
        moneda                   : String(5);

        // importeTexto: el mismo importe ya formateado por CAP con la moneda de
        // la propuesta ("S/ 2,290,435.83" / "US$ 1,500.00"). Es lo que muestra
        // la tabla — misma convención que TareasInbox en PagosService.
        importeTexto             : String(30);

        fechaPropuestaPago       : String(10);

        // Rol de la tarea — "Apoderado" | "Liberador Final"
        rolTarea                 : String(30);

        // Primer destinatario de la tarea. Se conserva porque la ayuda de
        // búsqueda y el filtro de esta lista siguen siendo por persona, pero
        // con el pool de apoderados NO es el dato completo: para eso está
        // `destinatarios`.
        usuarioActual            : String(100);

        // Todos los destinatarios de la tarea (recipientUsers en BPA), en una
        // línea. Con el pool de apoderados son varios a la vez.
        destinatarios            : String(1000);

        // estadoTarea: status crudo de BPA — READY | RESERVED. Se conserva en
        // el modelo pero ya no se expone en la UI: por sí solo no dice nada
        // sobre el flujo de aprobación (ver estadoNivel).
        estadoTarea              : String(20);

        // estadoNivel: el status traducido a negocio y con el nivel de
        // aprobación en el que está la tarea — "Pendiente - Apoderado 1",
        // "Reservada - Liberador Final". Es lo que muestra la columna Estado
        // y lo que se usa para filtrar, en vez del status crudo de BPA.
        estadoNivel              : String(60);

        // Color de estadoNivel — UI.CriticalityType: 0=Neutral 1=Negative
        // 2=Critical 3=Positive 5=Information. Se deriva del rol de la tarea
        // (ver CRITICIDAD_POR_ROL en reasignacion-service.js).
        estadoCriticidad         : Integer;

        // ID del proceso padre en BPA.
        //
        // NO sirve para agrupar el flujo: los apoderados corren en el subproceso
        // de Apoderados y el liberador en el proceso raíz (ver contextPath en
        // config/perfiles.js), así que sus instancias no tienen por qué
        // coincidir. Para agrupar está grupoPropuesta.
        workflowInstanceId       : String(255);

        // Clave de negocio de la propuesta — "0031 · 3127 · 2026-08-07".
        // Es lo que agrupa la lista: identifica el flujo de punta a punta,
        // independientemente de en qué proceso BPA viva cada tarea.
        // Ver _clavePropuesta en reasignacion-service.js.
        grupoPropuesta           : String(80);

        // Los firmantes de la propuesta según el contexto BPA, en una línea.
        // Se muestran para dar visibilidad del flujo completo: NO son
        // reasignables mientras su tarea no exista en BPA.
        //
        // usuarioApoderado1 / usuarioApoderado2 desaparecieron con el quórum:
        // siguen en el DataType de BPA por compatibilidad pero quedaron fuera
        // del flujo, y mapearlos aquí habría mostrado a dos personas fijas que
        // ya no son necesariamente las que tienen la tarea.
        usuariosApoderados       : String(1000);   // lista completa
        apoderadosFirmantes      : String(1000);   // los que ya firmaron
        apoderadosPendientes     : String(1000);   // los que aún pueden firmar
        usuarioLiberador         : String(100);

        // Estado del quórum de la propuesta a la que pertenece esta tarea.
        contadorFirmas           : Integer;
        firmasRequeridas         : Integer;
        firmasTexto              : String(40);     // '1 de 2 firmas'
    };

    // =========================================================================
    // Entidades de ayuda de búsqueda (value help) de la barra de filtros
    //
    // POR QUÉ EXISTEN
    // ---------------
    // Los cuatro filtros de esta app son campos de texto contra un origen que
    // no es una tabla. Sin @Common.ValueList, Fiori Elements solo ofrece el
    // diálogo de "definir condiciones": el administrador tiene que escribir de
    // memoria el código de sociedad o el correo exacto del destinatario, y un
    // dedazo se traduce en una lista vacía sin explicación.
    //
    // Sociedades, Usuarios y Estados son DINÁMICAS: ofrecen los valores que
    // realmente existen ahora mismo entre las tareas en curso, no un catálogo
    // maestro — Estados en particular, porque es un cruce de status BPA × rol
    // (hasta 3 roles activos × 2 status = 6 combinaciones), y solo tiene
    // sentido ofrecer las que hoy tienen alguna tarea detrás.
    // Roles es DOMINIO CERRADO: sale de config/perfiles.js, no de los datos.
    //
    // Todas son @cds.persistence.skip — se resuelven en reasignacion-service.js
    // sobre el mismo snapshot de tareas que alimenta TareasEnCurso.
    // =========================================================================

    @readonly
    @cds.persistence.skip
    entity Sociedades {
        key sociedad : String(10);
    };

    @readonly
    @cds.persistence.skip
    entity Usuarios {
        key usuarioActual : String(100);
    };

    @readonly
    @cds.persistence.skip
    entity Roles {
        key rolTarea : String(30);
    };

    @readonly
    @cds.persistence.skip
    entity Estados {
        // Estados de PROPUESTA — 'Pendiente de Apoderados' | 'Pendiente de
        // Liberación'. Es la clave y el texto a la vez: no hay un código corto
        // detrás que valga la pena mostrar por separado.
        //
        // Ojo: no son los estados de TAREA de TareasEnCurso.estadoNivel
        // ("Pendiente - Apoderado 1"), que son un cruce status × rol. Lo que se
        // filtra en esta pantalla es el punto del flujo de la propuesta.
        key estadoPropuesta : String(60);
    };

    // =========================================================================
    // Acción bound de Firmante
    //
    // Va en Firmante y no en TareasEnCurso porque el administrador razona por
    // persona dentro de una propuesta, no por identificador de tarea. El
    // handler resuelve el instanceID del firmante y rechaza de entrada los que
    // no tienen firma pendiente (ver domain/reasignacion.service.js).
    // =========================================================================
    extend entity Firmante with actions {

        // Sustituye a la persona de esta fila por otra en los destinatarios de
        // su tarea BPA.
        //
        // En el pool de apoderados NO reemplaza la lista entera: se envía la
        // lista de destinatarios completa con este correo sustituido, de modo
        // que los demás apoderados pendientes conservan su tarea.
        action reasignar(nuevoUsuario: String) returns AccionReasignacion;
    };
}
