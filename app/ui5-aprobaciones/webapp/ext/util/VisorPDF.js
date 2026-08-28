/**
 * app/ui5-aprobaciones/webapp/ext/util/VisorPDF.js
 *
 * Handler del botón "Ver PDF" de la cabecera del Object Page.
 * Se registra en manifest.json bajo
 *   sap.ui5 > routing > targets > TareasInboxObjectPage > options > settings >
 *   content > header > actions > verPDF > press
 * como "<módulo>.<método>": Fiori Elements carga este módulo y llama a abrir().
 * El botón sale en la toolbar del header title, junto a Pantalla completa y
 * Cerrar. Si la columna media del FCL queda muy angosta, la OverflowToolbar lo
 * repliega al menú "..." — es el comportamiento estándar del control, no hay
 * ajuste de manifest que lo fije fuera del desbordamiento.
 *
 * ── Por qué un diálogo y no una sección embebida ────────────────────────────
 * El Object Page vive en la columna media del FCL (~700 px). Un PDF a ese ancho
 * se lee mal y empujaría al ProcessFlow del historial fuera de vista. El popup
 * de sap.m.PDFViewer ocupa casi toda la ventana, y al cerrarlo el usuario
 * conserva el scroll y los botones de decisión del footer.
 * Además el documento se pide SOLO cuando alguien lo abre: embebido, cada tarea
 * abierta dispararía una llamada a SAP Gateway aunque nadie mire el PDF.
 *
 * ── Cómo llega el binario ───────────────────────────────────────────────────
 * PDFViewer monta un <iframe> sobre la URL de TareasInbox.urlPDF, que apunta a
 * la entidad media PropuestaPDF (ver srv/pagos-service.cds). Al ser mismo origen
 * a través del approuter, la petición viaja con la sesión ya autenticada: no
 * hace falta token ni construir un blob en el cliente.
 */
sap.ui.define([
    "sap/m/PDFViewer",
    "sap/m/MessageBox"
], function (PDFViewer, MessageBox) {
    "use strict";

    /**
     * Instancia única y reutilizada.
     *
     * PDFViewer no expone evento de cierre —solo error, loaded y
     * sourceValidationFailed—, así que crear uno por pulsación dejaría controles
     * huérfanos: no hay momento fiable para destruirlos. Un solo visor al que se
     * le cambia el source en cada apertura evita la fuga sin código de limpieza.
     */
    var oVisor = null;

    /**
     * Resuelve el contexto de la tarea sea cual sea la firma con la que sap.fe
     * invoque el handler: las versiones recientes pasan el evento de pulsación,
     * las anteriores el binding context directamente, y en ambos casos `this`
     * puede ser la ExtensionAPI de la página.
     */
    function _resolverContexto(oParametro, oThis) {
        if (oParametro) {
            // Binding context (firma antigua)
            if (typeof oParametro.getPath === "function") {
                return oParametro;
            }
            // Evento de pulsación del botón
            if (typeof oParametro.getSource === "function") {
                var oFuente = oParametro.getSource();
                if (oFuente && typeof oFuente.getBindingContext === "function") {
                    return oFuente.getBindingContext();
                }
            }
        }
        if (oThis && typeof oThis.getBindingContext === "function") {
            return oThis.getBindingContext();
        }
        return null;
    }

    function _obtenerVisor() {
        if (!oVisor) {
            oVisor = new PDFViewer({
                showDownloadButton: true,
                // El navegador ya avisa a su manera cuando no puede pintar el
                // documento; estos textos son los que ve el usuario dentro del
                // diálogo si la petición falla.
                errorMessage           : "No se pudo abrir el documento de la propuesta.",
                errorPlaceholderMessage: "Verifique que la propuesta tenga documento generado en SAP.",
                error: function () {
                    console.error("[VisorPDF] el navegador no pudo cargar el documento");
                }
            });

            // sourceValidationFailed salta cuando el Content-Type de la
            // respuesta no es application/pdf. El backend lo envía correcto
            // (ver handle_pdf), así que no se pide confirmación al usuario:
            // preventDefault evita el diálogo intermedio de UI5.
            oVisor.attachSourceValidationFailed(function (oEvento) {
                oEvento.preventDefault();
            });
        }
        return oVisor;
    }

    return {

        /**
         * Abre el PDF de la propuesta en curso.
         * @param {sap.ui.base.Event|sap.ui.model.Context} oParametro evento o contexto, según la versión de sap.fe
         */
        abrir: function (oParametro) {
            var oContexto = _resolverContexto(oParametro, this);

            if (!oContexto) {
                MessageBox.error("No se pudo determinar el contexto de la tarea.");
                return;
            }

            var sTitulo = oContexto.getProperty("tituloTarea") || "Documento de la propuesta";

            // requestProperty y NO getProperty.
            //
            // getProperty solo lee lo que ya está en el contexto, y urlPDF no
            // está: Fiori Elements no mete en el $select del Object Page los
            // DataField con ![@UI.Hidden] estático —el mismo comportamiento que
            // ya documenta AccionesHandler para esApoderado—, así que el campo
            // viaja en la entidad pero nunca se pide. El síntoma era un
            // "no tiene documento disponible" en propuestas que sí lo tienen.
            //
            // requestProperty pide la propiedad al servidor cuando falta y
            // devuelve una promesa con el valor.
            oContexto.requestProperty("urlPDF")
                .then(function (sUrl) {
                    if (!sUrl) {
                        // Sin URL de verdad no hay nada que abrir: urlPDF llega
                        // vacío cuando la propuesta no trae la terna completa
                        // (número, sociedad y fecha). Ver _urlPDF en
                        // srv/pagos-service.js.
                        MessageBox.information("Esta propuesta no tiene documento disponible.");
                        return;
                    }

                    var oVisorPDF = _obtenerVisor();
                    oVisorPDF.setTitle(sTitulo);
                    oVisorPDF.setSource(sUrl);
                    oVisorPDF.open();
                })
                .catch(function (oError) {
                    console.error("[VisorPDF] no se pudo leer urlPDF", oError);
                    MessageBox.error("No se pudo obtener el documento de la propuesta.");
                });
        }
    };
});
