/**
 * Handler del botón "Ver PDF" de la cabecera del Object Page.
 * Registrado en manifest.json (routing > targets > TareasInboxObjectPage >
 * options > settings > content > header > actions > verPDF > press).
 *
 * Se muestra en un diálogo (sap.m.PDFViewer) y no embebido: el Object Page
 * vive en la columna media del FCL (~700 px), donde un PDF se leería mal, y
 * el documento se pide solo cuando alguien lo abre. PDFViewer monta un
 * <iframe> sobre TareasInbox.urlPDF (entidad media PropuestaPDF, ver
 * srv/pagos-service.cds); al ser mismo origen vía el approuter, la petición
 * ya viaja autenticada.
 */
sap.ui.define([
    "sap/m/PDFViewer",
    "sap/m/MessageBox"
], function (PDFViewer, MessageBox) {
    "use strict";

    /**
     * Instancia única y reutilizada: PDFViewer no expone evento de cierre, así
     * que crear uno por pulsación dejaría controles huérfanos.
     */
    var oVisor = null;

    /**
     * Resuelve el contexto de la tarea sea cual sea la firma con la que sap.fe
     * invoque el handler (evento de pulsación o binding context directo).
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
                errorMessage           : "No se pudo abrir el documento de la propuesta.",
                errorPlaceholderMessage: "Verifique que la propuesta tenga documento generado en SAP.",
                error: function () {
                    console.error("[VisorPDF] el navegador no pudo cargar el documento");
                }
            });

            // El backend siempre envía application/pdf (ver handle_pdf), así
            // que se evita el diálogo intermedio de confirmación de UI5.
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

            // requestProperty y no getProperty: urlPDF tiene ![@UI.Hidden]
            // estático y Fiori Elements no lo mete en el $select del Object
            // Page, así que hay que pedirlo al servidor cuando falta.
            oContexto.requestProperty("urlPDF")
                .then(function (sUrl) {
                    if (!sUrl) {
                        // urlPDF llega vacío si la propuesta no trae la terna
                        // completa (número, sociedad, fecha) — ver _urlPDF en
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
