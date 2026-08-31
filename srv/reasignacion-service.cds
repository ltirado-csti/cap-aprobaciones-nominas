// Servicio de administración para reasignar el destinatario de una tarea de
// aprobación en curso (Apoderado o Liberador Final) a otro usuario, cuando el
// destinatario original no está disponible.
//
// Los apoderados son una lista de N usuarios equivalentes sobre una sola
// tarea con pool de destinatarios (quórum de 2 firmas): una tarea BPA puede
// producir varias filas de firmante, y reasignar sustituye a una persona
// dentro de la lista de destinatarios, nunca reemplaza la lista entera.
//
// No contiene anotaciones @UI (viven en app/ui5-reasignacion/annotations.cds)
// ni lógica de negocio (vive en reasignacion-service.js / domain/reasignacion.service.js).
// Acceso restringido a administradores (xs-security.json, scope "Administrador").
//
// La raíz de la UI es PropuestasEnCurso, no TareasEnCurso: el administrador
// gestiona una propuesta, que agrupa hasta tres firmantes (Apoderado 1,
// Apoderado 2, Liberador Final) de los que solo algunos tienen tarea viva.
// TareasEnCurso se conserva expuesta (verdad de BPA a nivel tarea) para diagnóstico.

type AccionReasignacion {
    exito   : Boolean;
    mensaje : String;
};

@requires: 'Administrador'
service ReasignacionService @(path: '/nomina/reasignacion') {

    // Una fila por propuesta con al menos una tarea viva. Se deriva agrupando
    // TareasEnCurso por la clave de negocio (sociedad + nº + fecha de pago) —
    // ver _clavePropuesta en reasignacion-service.js. No se agrupa por
    // workflowInstanceId: apoderados y liberador corren en procesos distintos.
    @readonly
    @cds.persistence.skip
    entity PropuestasEnCurso {
        key propuestaID      : String(60);   // '0031~3127~2026-08-07' (seguro para URL)

        grupoPropuesta       : String(80);   // '0031 · 3127 · 2026-08-07' (legible)

        sociedad             : String(10);
        numeroPropuesta      : String(20);

        // ISO (yyyy-MM-dd), parte de la clave de negocio; lo que se muestra es
        // la versión dd/MM/yyyy en *Texto.
        fechaPropuestaPago   : String(10);
        fechaPago            : String(10);
        fechaPPTexto         : String(10);
        fechaPagoTexto       : String(10);

        tituloTarea          : String(255);
        banco                : String(50);
        bancoDescripcion     : String(100);  // descripción del banco ("001 - BCP Soles")

        // "Grupo Pers." — texto de negocio de tipoTrabajador (E/P), traducido
        // por config/grupos-personal.js.
        grupoPersonal        : String(30);

        importe              : String(30);   // crudo, para ordenar
        moneda               : String(5);
        importeTexto         : String(30);   // formateado, para mostrar

        // Punto del flujo derivado de qué roles tienen tarea viva.
        estadoPropuesta      : String(60);
        estadoCriticidad     : Integer;      // UI.CriticalityType — ver config/estados.js

        // Destinatarios de las tareas vivas, en una línea.
        destinatarios        : String(300);

        // Tareas vivas ahora mismo — no coincide con personas pendientes
        // (la tarea de apoderado es una sola con N destinatarios).
        tareasPendientes     : Integer;

        // Estado del quórum de apoderados.
        contadorFirmas       : Integer;
        firmasRequeridas     : Integer;
        firmasTexto          : String(40);   // '1 de 2 firmas'

        // Los tres firmantes del flujo, tengan o no tarea viva.
        firmantes            : Composition of many Firmante
                                 on firmantes.propuestaID = propuestaID;

        // Las dos agregaciones que necesita sap.suite.ui.commons.ProcessFlow,
        // calculadas por CAP igual que en el Object Page de aprobaciones.
        niveles              : Composition of many NivelFlujo
                                 on niveles.propuestaID = propuestaID;
        aprobadores          : Composition of many NodoFlujo
                                 on aprobadores.propuestaID = propuestaID;
    };

    // Una fila por cada persona designada en el flujo (cada apoderado de la
    // lista, cada liberador de la suya), exista o no su tarea. `reasignable`
    // distingue esos casos: se muestran igual para dar visibilidad del flujo
    // completo, con el botón inactivo y el porqué en motivoNoReasignable.
    @readonly
    @cds.persistence.skip
    entity Firmante {
        key propuestaID          : String(60);

        // '<rol>#<correo>' ('apoderado#a@x.net'): un rol de pool tiene N
        // personas a la vez; identifica a quién sustituye la acción.
        key firmanteID           : String(150);

        rol                      : String(30);       // 'Apoderado' | 'Liberador Final'
        nivel                    : Integer;          // orden en el flujo (2 = apoderados, 3 = liberación)

        // Con tarea viva: recipientUsers de BPA. Sin ella: el contexto de la propuesta.
        usuario                  : String(100);

        estadoFirmante           : String(30);        // 'Pendiente' | 'Reservada' | 'Firmado' | 'No iniciado'
        estadoCriticidad         : Integer;

        // Estado del quórum de esta firma; en el liberador van a cero (una única liberación).
        contadorFirmas           : Integer;
        firmasRequeridas         : Integer;

        // Tarea BPA de este firmante; vacío si no existe o ya se completó. En
        // el pool, la misma tarea aparece en varias filas.
        instanceID               : String(255);
        estadoTarea              : String(20);   // READY | RESERVED

        // Gobierna Core.OperationAvailable: true solo si esta persona aún tiene firma que aportar.
        reasignable              : Boolean;
        motivoNoReasignable      : String(120);
    };

    // NivelFlujo — lanes del ProcessFlow. Mismo shape que NivelAprobacion en
    // pagos-service.cds; lo construye domain/historial.service.js.
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

    // NodoFlujo — nodes del ProcessFlow. Mismo shape que Aprobador en pagos-service.cds.
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
        fechaAccion         : String(30);       // ISO 8601 — trazabilidad y orden
        fechaTexto          : String(30);       // dd/MM/yyyy HH:mm en hora de Perú — presentación
        estadoNodo          : String(20);
        estadoTexto         : String(60);
        decisionValueState  : String(10);
        esActual            : Boolean;
    };

    // Verdad de BPA a nivel tarea. Ya no es la raíz de la UI (lo es
    // PropuestasEnCurso); se conserva expuesta porque de ahí se derivan las
    // propuestas y sirve para diagnóstico. Clave: instanceID (id de BPA).
    @readonly
    @cds.persistence.skip
    entity TareasEnCurso {
        key instanceID          : String(255);

        tituloTarea              : String(255);
        numeroPropuesta          : String(20);
        sociedad                 : String(10);
        banco                    : String(50);
        bancoDescripcion         : String(100);
        grupoPersonal            : String(30);

        importe                  : String(30);   // crudo, para ordenar/filtrar
        moneda                   : String(5);
        importeTexto             : String(30);   // formateado ("S/ 2,290,435.83")

        fechaPropuestaPago       : String(10);

        rolTarea                 : String(30);   // "Apoderado" | "Liberador Final"

        // Primer destinatario; con el pool de apoderados no es el dato
        // completo (para eso está `destinatarios`).
        usuarioActual            : String(100);

        // Todos los destinatarios de la tarea (recipientUsers en BPA), en una línea.
        destinatarios            : String(1000);

        estadoTarea              : String(20);    // status crudo de BPA — READY | RESERVED

        // Status traducido a negocio + nivel de aprobación, ej. "Pendiente -
        // Apoderado 1". Lo que muestra y filtra la columna Estado.
        estadoNivel              : String(60);

        // UI.CriticalityType, derivado del rol de la tarea (ver
        // CRITICIDAD_POR_ROL en reasignacion-service.js).
        estadoCriticidad         : Integer;

        // ID del proceso padre en BPA. No agrupa el flujo (apoderados y
        // liberador corren en procesos distintos); para eso está grupoPropuesta.
        workflowInstanceId       : String(255);

        // Clave de negocio de la propuesta — "0031 · 3127 · 2026-08-07".
        // Ver _clavePropuesta en reasignacion-service.js.
        grupoPropuesta           : String(80);

        // Firmantes de la propuesta según el contexto BPA, para visibilidad
        // del flujo completo (no reasignables mientras su tarea no exista).
        usuariosApoderados       : String(1000);   // lista completa
        apoderadosFirmantes      : String(1000);   // los que ya firmaron
        apoderadosPendientes     : String(1000);   // los que aún pueden firmar
        usuarioLiberador         : String(1000);   // uno o varios liberadores

        contadorFirmas           : Integer;
        firmasRequeridas         : Integer;
        firmasTexto              : String(40);     // '1 de 2 firmas'
    };

    // Entidades de value help para la barra de filtros: sin @Common.ValueList,
    // Fiori Elements solo ofrece el diálogo de "definir condiciones". Sociedades,
    // Usuarios y Estados son dinámicas (valores presentes en las tareas en
    // curso); Roles es dominio cerrado (config/perfiles.js). Todas se resuelven
    // en reasignacion-service.js sobre el mismo snapshot que TareasEnCurso.

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
        // Estados de PROPUESTA ('Pendiente de Apoderados' | 'Pendiente de
        // Liberación'), no los de TAREA de TareasEnCurso.estadoNivel.
        key estadoPropuesta : String(60);
    };

    // Va en Firmante y no en TareasEnCurso porque el administrador razona por
    // persona dentro de una propuesta, no por identificador de tarea.
    extend entity Firmante with actions {

        // Sustituye a la persona de esta fila por otra en los destinatarios
        // de su tarea BPA. En el pool no reemplaza la lista entera: envía la
        // lista completa con este correo sustituido.
        action reasignar(nuevoUsuario: String) returns AccionReasignacion;
    };
}
