# Bloque: Notificación de Resultado de Payroll (BPMN + CAP)

**Proyecto:** H2H Nómina — Centria
**Versión BPA desplegada:** 1.3.1
**Fecha:** 07 de agosto de 2026

---

## 1. Contexto y objetivo

Al aprobar/observar una propuesta de nómina, cada Apoderado (y el Liberador) dispara una notificación síncrona hacia SAP Payroll (ECP) a través de CPI. Payroll puede responder con un flag de error y un mensaje de negocio (no limitado a validación de autorización — cubre múltiples escenarios de negocio). Este resultado debe:

1. Ser **bloqueante**: si Payroll rechaza, el proceso no debe avanzar hacia el Liberador ni finalizar.
2. Ser **visible en Fiori**, informando al usuario el motivo del rechazo.
3. Permitir **reintento**: el usuario puede volver a decidir sobre la misma tarea.

La cadena de datos es:

```
Payroll (ECP) → CPI (iFlow, servicio SOAP ZhrfApoReg) → BPA (contexto del proceso) → CAP (lectura) → Fiori (mensaje)
```

**Principio arquitectónico respetado:** CAP nunca llama a CPI para decisiones. BPA es quien orquesta la notificación; CAP solo lee el resultado del contexto de la instancia.

---

## 2. Ajuste realizado en BPMN (BPA Studio)

### 2.1 Problema de diseño identificado

La API de completar tareas de BPA (`completarTarea`, usada por CAP) es **asíncrona por diseño**: al enviar `status: COMPLETED`, BPA responde con un ACK inmediato, sin esperar a que el resto del proceso (notificación a CPI → Payroll, evaluación del resultado) termine. Esto significa que:

- La tarea del usuario ya queda `COMPLETED` en el momento en que Payroll aún no ha respondido.
- No es posible "revertir" una tarea ya completada en BPA — el concepto de "bloquear" debe interpretarse como **bloquear el avance del proceso**, no deshacer la decisión del usuario.

### 2.2 Decisión de diseño adoptada

Se descartaron dos alternativas:
- **Validación previa** (antes del ActionTask del Apoderado): inviable porque el error de Payroll no se limita a validación de identidad/autorización, sino que cubre múltiples escenarios de negocio que solo se conocen después de la decisión.
- **Terminación del proceso sin reintento**: descartada por UX — el usuario debe poder corregir y reintentar sin reiniciar todo el flujo desde Payroll.

Se adoptó: **Loop back (bucle de reintento) hacia el mismo ActionTask de decisión**, sin contador de intentos (decisión de negocio: el ciclo puede repetirse indefinidamente hasta que Payroll acepte).

### 2.3 Estructura implementada por rama (Apoderado 1, Apoderado 2, Liberador — patrón idéntico)

```
Aprobación del Apoderado N (ActionTask)
        ↓ (Aprobar / Observar)
Decisión de aprobar N / Decisión observar N
        ↓
Notificación aprobador N (Integration Action → CPI → Payroll)
        ↓
Script Task (mapeo de resultado a variables personalizadas)
        ↓
Gateway "¿Todo OK?" (Condition, evalúa out.result.EpFlagError)
        ↓ If (error)                          ↓ Por defecto (OK)
   Ir a Aprobación del Apoderado N        Notificación de observación → Finalizar
   (goto — misma instancia de
    ActionTask, mismo taskDefinitionId)
```

**Confirmado:** el conector "Ir a Aprobación..." es un **goto al mismo ActionTask** (mismo `taskDefinitionId`: `form_aprobacionDelApoderado_1` / `_2` / Liberador). No se genera un nuevo task definition — esto simplifica la lógica de roles en CAP, ya que no hay que distinguir "primer intento" de "reintento".

### 2.4 Escritura del resultado en el contexto — lección aprendida

**Intento fallido:** se intentó escribir el resultado de la notificación directamente en campos del Data Type `PropuestaNomina` (usado como `startEvent.body`), agregando campos como `flagErrorNotifApo1`, `mensajeNotifApo1`, etc.

**Error obtenido:**
```
Cannot assign to 'flagErrorNotifApo1' because it is a read-only property
```

**Causa raíz:** en un Script Task de BPA, `startEvent.body` (y todo su árbol de campos) es de **solo lectura** — representa el payload de entrada/disparo del proceso y no puede modificarse durante la ejecución, sin importar cómo esté definido el campo en el Data Type. El editor de scripts tipa este árbol como `readonly` en TypeScript, de ahí el mensaje de error.

**Solución correcta:** el único árbol del contexto en el que un Script Task puede **escribir** es `$.context.custom.*` (**Variables personalizadas**), definidas explícitamente en el panel Variables → Variables personalizadas del proceso — no en el Data Type.

**Acción tomada:**
1. Se eliminaron los campos duplicados del Data Type `PropuestaNomina` (quedó limpio, sin los campos de notificación).
2. Se crearon 6 variables personalizadas a nivel de proceso:
   ```
   flagErrorNotifApo1       (Cadena)
   mensajeNotifApo1         (Cadena)
   flagErrorNotifApo2       (Cadena)
   mensajeNotifApo2         (Cadena)
   flagErrorNotifLiberador  (Cadena)
   mensajeNotifLiberador    (Cadena)
   ```
3. En el Script Task posterior a cada step de notificación, se mapeó el resultado así:
   ```javascript
   $.context.custom.flagErrorNotifApo1 = $.context.action_post_notificationTaskECP_4.result.EpFlagError;
   $.context.custom.mensajeNotifApo1 = $.context.action_post_notificationTaskECP_4.result.EpMensaje;
   ```
   (mismo patrón replicado para Apoderado 2 y Liberador, referenciando el step correspondiente)

**Por qué esto es correcto y suficiente:** las variables personalizadas (`context.custom.*`) forman parte del contexto de la instancia del proceso, que es exactamente lo que expone la Workflow Runtime API de BPA (`GET /workflow-instances/{instanceId}/context`). CAP puede leerlas sin necesidad de que vivan en `PropuestaNomina`.

### 2.5 Contrato final (fuente de verdad para CAP)

| Variable personalizada | Tipo | Valores | Escrita por |
|---|---|---|---|
| `flagErrorNotifApo1` | Cadena | `"X"` (error) \| `""` (OK) | Script Task tras "Notificación aprobador 1" |
| `mensajeNotifApo1` | Cadena | Texto de `EpMensaje` | Script Task tras "Notificación aprobador 1" |
| `flagErrorNotifApo2` | Cadena | `"X"` \| `""` | Script Task tras "Notificación aprobador 2" |
| `mensajeNotifApo2` | Cadena | Texto de `EpMensaje` | Script Task tras "Notificación aprobador 2" |
| `flagErrorNotifLiberador` | Cadena | `"X"` \| `""` | Script Task tras notificación del Liberador |
| `mensajeNotifLiberador` | Cadena | Texto de `EpMensaje` | Script Task tras notificación del Liberador |

El gateway `¿Todo OK?` de cada rama sigue evaluando `out.result.EpFlagError` directamente (no depende de las variables personalizadas), por lo que la lógica de bifurcación del BPMN no cambió — las variables personalizadas son exclusivamente para exponer el dato hacia afuera (CAP).

### 2.6 Estado de despliegue

Versión **H2H Nomina 1.3.1**, **Desplegado / Activo**, aplicado a las tres ramas (Apoderado1, Apoderado2, Liberador).

---

## 3. Punto abierto crítico antes de implementar CAP

Antes de escribir código, se debe resolver la ambigüedad documentada en las notas del proyecto:

> `taskInstanceId`: pending definition of whether it maps to process ID or task instance ID

El endpoint de contexto de BPA es:
```
GET /workflow-instances/{instanceId}/context
```

`{instanceId}` es el **ID de la instancia del proceso** (no el ID de la tarea individual/`taskId`). Si el campo `taskInstanceId` que hoy se guarda en `PropuestaNomina` corresponde al `taskId` (identificador de la tarea de usuario) y no al `instanceId` del proceso, **no servirá para construir esta URL** y habrá que:

- Obtenerlo desde la respuesta de `completarTarea` (si BPA la incluye), o
- Derivarlo consultando el detalle de la tarea (`GET /task-instances/{taskId}`) que normalmente retorna el `processInstanceId` asociado, o
- Asegurar que BPA escriba el `instanceId` correcto (no el `taskId`) en el campo correspondiente vía otro Script Task.

**Acción previa recomendada:** verificar en BPA Studio o en un log de ejecución real cuál es el valor exacto que trae `taskInstanceId` hoy, comparándolo con el `instanceId` visible en el monitor de Workflow Runtime para la misma ejecución.

---

## 4. Guía paso a paso — Implementación en CAP

### Paso 1 — Confirmar y, si es necesario, corregir la fuente del `instanceId`

**Fundamento:** sin el `instanceId` correcto, ninguna llamada al endpoint de contexto funcionará. Este paso bloquea todos los siguientes.

- Ejecutar una aprobación de prueba en QAS.
- En el Monitor de Workflow Runtime (BPA), localizar la instancia y anotar su `instanceId` real.
- Comparar contra el valor que llega a `taskInstanceId` en el contexto que CAP ya recibe hoy (vía `completarTarea` o el detalle de tarea).
- Si no coinciden: ajustar la fuente (opción más simple — agregar una variable personalizada adicional, ej. `processInstanceId`, poblada por BPA con el ID correcto, siguiendo el mismo patrón de Script Task ya usado en este bloque).

### Paso 2 — Extender `bpa-client.js` con el método de lectura de contexto

**Fundamento:** siguiendo el principio de separación de infraestructura ya establecido en el proyecto (`pagos-service.js` nunca llama `cds.connect.to()` directamente — todo pasa por los clientes de infraestructura), la llamada HTTP a BPA debe vivir exclusivamente en `bpa-client.js`.

- Agregar una función, por ejemplo `obtenerContextoInstancia(instanceId)`.
- Debe reutilizar la misma configuración de destino (`BPA_WF_DEST`) y los mismos headers ya usados en el resto del cliente: `Authorization: Bearer <token>` + `irpa-api-key: <valor>`.
- Debe invocar `GET /workflow-instances/{instanceId}/context`.
- Debe devolver únicamente el sub-objeto `custom` del contexto (o el contexto completo, dejando que la capa de dominio filtre) — evaluar cuál conviene según la respuesta real de la API (validar con una llamada de prueba antes de fijar el contrato de retorno).
- Manejo de errores: igual criterio que el resto del cliente (`req.reject()` en la capa de servicio, no aquí — este módulo solo debe propagar o transformar errores técnicos, no tomar decisiones de negocio).

### Paso 3 — Extender `perfiles.js` con la resolución de campos por rol

**Fundamento:** el proyecto ya centraliza en `perfiles.js` el mapeo entre rol (`activityId`/`taskDefinitionId`) y comportamiento (`calcularFlagsRol`, `ROLES_BPA`). La resolución de qué par de campos leer (`Apo1` / `Apo2` / `Liberador`) debe seguir ese mismo patrón, no dispersarse en el service.

- Agregar una función, por ejemplo `resolverCamposNotificacion(perfil)`, que dado el perfil de la tarea (`AP` + identificación de cuál apoderado, o `LI`) devuelva los nombres exactos de las variables a leer:
  ```
  { campoFlag: 'flagErrorNotifApo1', campoMensaje: 'mensajeNotifApo1' }
  ```
- Si el perfil `AP` no distingue hoy entre Apoderado 1 y 2 (revisar `resolverPerfilDesdeScopes` existente), puede ser necesario apoyarse en el `taskDefinitionId` (`form_aprobacionDelApoderado_1` vs `_2`) en lugar del `perfil` genérico para esta resolución específica.

### Paso 4 — Definir el nuevo endpoint en `pagos-service.cds`

**Fundamento:** siguiendo el patrón ya usado para las 15 acciones bound migradas (Bloque Migración Bound Actions), el nuevo endpoint debe ser una **bound function** (no action, ya que es de solo lectura) sobre `TareasInbox`, usando la sintaxis CDS 9.x (`extend entity X with actions { }` fuera del cuerpo de la entidad, aplicable también a functions).

- Definir la función, por ejemplo:
  ```
  function resultadoNotificacion() returns {
    pendiente : Boolean;
    flagError : String;
    mensaje   : String;
  };
  ```
- Anotar visibilidad/disponibilidad según corresponda (consistente con el resto de acciones bound ya existentes en el proyecto).

### Paso 5 — Implementar el handler en la capa de dominio

**Fundamento:** respetar la separación ya establecida (`aprobacion.service.js` para handlers de acciones/decisiones de aprobación).

- El handler de `resultadoNotificacion`:
  1. Deriva `taskId` desde `req.params` (mismo patrón anti-tampering ya usado en `_prepararAccion`, nunca confiar en datos del cliente para esto).
  2. Obtiene `instanceId` (resultado del Paso 1) y `perfil`/`taskDefinitionId` desde el contexto ya conocido de la tarea.
  3. Resuelve los nombres de campo vía `perfiles.resolverCamposNotificacion()`.
  4. Llama `bpaClient.obtenerContextoInstancia(instanceId)`.
  5. Si los campos aún no están poblados (proceso todavía ejecutando la notificación) → responde `{ pendiente: true }`.
  6. Si están poblados → responde `{ pendiente: false, flagError, mensaje }`.
  7. Usar `async/await`, sin construcción manual de Promises, consistente con el resto del código.

### Paso 6 — Implementar el polling en el controller Fiori

**Fundamento:** decisión ya tomada en este bloque — Opción B (polling desde el frontend con spinner), evitando bloquear el hilo HTTP de CAP.

- Tras completar la acción bound "Aprobar"/"Observar" desde la UI:
  1. Mostrar `BusyIndicator` o estado de carga.
  2. Iniciar polling al nuevo endpoint (`resultadoNotificacion`) cada ~1.5 segundos.
  3. Definir un timeout máximo (recomendado: 10 segundos) para no dejar al usuario esperando indefinidamente si algo falla técnicamente.
  4. Al recibir `pendiente: false`:
     - Si `flagError === "X"` → `MessageBox.error(mensaje)`.
     - Si no → `MessageBox.success` o `MessageToast`, según el estándar de UX ya usado en el proyecto.
  5. Si se agota el timeout sin respuesta → mensaje de advertencia no bloqueante (ej. "no se pudo confirmar con Payroll, verifique el estado más tarde").
  6. Tras conocer el resultado (con o sin error), refrescar el inbox (reutilizar el mecanismo de `@Common.SideEffects` sobre `TareasInbox`, ya identificado como ítem pendiente en el proyecto) — esto es indispensable en caso de error, porque el loop back en BPA hace reaparecer la tarea en el inbox del usuario.

### Paso 7 — Validación técnica antes de entrega

Siguiendo el estándar ya establecido en el proyecto:
- `node --check` sobre cada archivo `.js` modificado.
- `cds compile srv/pagos-service.cds app/ui5-aprobaciones/annotations.cds --to edmx` (stderr redirigido aparte) para validar que la nueva function no introduce warnings de anotación.
- Prueba manual end-to-end en QAS: forzar un caso de error real desde Payroll (ej. usuario no aprobador) y confirmar que: (a) el mensaje aparece correctamente en Fiori, (b) la tarea reaparece en el inbox, (c) un segundo intento exitoso limpia el estado de error visible.

---

## 5. Resumen de archivos a modificar

| Archivo | Cambio |
|---|---|
| `srv/infrastructure/bpa-client.js` | Nuevo método `obtenerContextoInstancia(instanceId)` |
| `srv/config/perfiles.js` | Nueva función `resolverCamposNotificacion(perfil)` |
| `srv/pagos-service.cds` | Nueva bound function `resultadoNotificacion()` sobre `TareasInbox` |
| `srv/domain/aprobacion.service.js` (o `pagos-service.js`, según dónde se registre el handler) | Handler de la nueva function |
| Controller Fiori (`app/ui5-aprobaciones/...`) | Lógica de polling + `MessageBox` tras acción de aprobar/observar |

---

## 6. Punto no resuelto para el siguiente bloque

- Confirmar valor real de `taskInstanceId` vs `instanceId` de proceso (Paso 1) — condiciona si se necesita agregar una variable personalizada adicional en BPA antes de continuar con CAP.
- Definir si el mensaje de error debe mostrarse también cuando la tarea reaparece en el inbox (antes de que el usuario decida de nuevo), no solo como resultado del polling inmediato — pendiente de validar con negocio si el reintento indefinido requiere alguna señal adicional de "cuántas veces ha fallado" a nivel de UX, aunque BPA no lo cuente internamente.
