/**
 * app/ui5-aprobaciones/webapp/ext/controller/AccionesHandler.js
 *
 * Controller Extension — acciones BPA del Object Page.
 * Registrar en manifest.json bajo:
 *   sap.ui5 > extends > extensions > sap.ui.controllerExtensions >
 *   sap.fe.templates.ObjectPage.ObjectPageController
 *
 * Visible: true en todos los botones (sin expression binding que dependa de
 * esApoderado). El field esApoderado no llega al $select del Object Page en
 * esta version de FE, lo que causaria que el binding evaluara false (oculto).
 * La autorizacion real la valida el backend (_prepararAccion lee el rol de BPA).
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/TextArea",
    "sap/m/Label",
    "sap/m/VBox"
], function (
    ControllerExtension,
    MessageToast,
    MessageBox,
    Dialog,
    Button,
    TextArea,
    Label,
    VBox
) {
    "use strict";

    // Confirmacion de carga — visible en consola del browser
    console.log("[AccionesHandler] Controller extension cargado OK");

    return ControllerExtension.extend(
        "centria.h2hpp.aprobaciones.ui5aprobaciones.ext.controller.AccionesHandler",
        {
            // ─── EJECUCION DIRECTA (Aprobar / Liberar) ───────────────────────

            /**
             * Ejecuta la accion sin solicitar comentario.
             * Segun BPA: Aprobar y Liberar no requieren justificacion.
             */
            _ejecutarDirecto: function (sActionName, sLabel) {
                var that     = this;
                var oContext = this.getView().getBindingContext();
                if (!oContext) {
                    MessageBox.error("No se pudo determinar el contexto de la tarea.");
                    return;
                }

                var oActionBinding = oContext.getModel().bindContext(
                    "PagosService." + sActionName + "(...)",
                    oContext,
                    { $$inheritExpandSelect: false }
                );
                oActionBinding.setParameter("comentario", "");

                oActionBinding.execute("$auto")
                    .then(function () {
                        MessageToast.show(sLabel + " ejecutada correctamente");
                        that._navegarALista();
                    })
                    .catch(function (oError) {
                        MessageBox.error(
                            (oError.error && oError.error.message) || oError.message || "Error",
                            { title: "Error en " + sLabel }
                        );
                    });
            },

            // ─── EJECUCION CON DIALOGO (Observar / Rechazar / Anular) ────────

            /**
             * Solicita comentario antes de ejecutar la accion.
             * Segun BPA: se requiere justificacion en los casos de observacion / rechazo.
             */
            _ejecutarConComentario: function (sActionName, sLabel) {
                var that     = this;
                var oContext = this.getView().getBindingContext();
                if (!oContext) {
                    MessageBox.error("No se pudo determinar el contexto de la tarea.");
                    return;
                }

                var oTextArea = new TextArea({
                    rows: 4, width: "100%",
                    placeholder: "Ingrese el motivo o comentario"
                });

                var oDialog = new Dialog({
                    title: sLabel, contentWidth: "420px",
                    content: [
                        new VBox({
                            renderType: "Bare",
                            items: [new Label({ text: "Comentario:" }), oTextArea]
                        }).addStyleClass("sapUiTinyMarginTop sapUiTinyMarginBottom")
                    ],
                    beginButton: new Button({
                        text: "Confirmar", type: "Emphasized",
                        press: function () {
                            oDialog.setBusy(true);
                            var oActionBinding = oContext.getModel().bindContext(
                                "PagosService." + sActionName + "(...)",
                                oContext,
                                { $$inheritExpandSelect: false }
                            );
                            oActionBinding.setParameter("comentario", oTextArea.getValue() || "");
                            oActionBinding.execute("$auto")
                                .then(function () {
                                    oDialog.close();
                                    MessageToast.show(sLabel + " ejecutada correctamente");
                                    that._navegarALista();
                                })
                                .catch(function (oError) {
                                    oDialog.setBusy(false);
                                    MessageBox.error(
                                        (oError.error && oError.error.message) || oError.message || "Error",
                                        { title: "Error en " + sLabel }
                                    );
                                });
                        }
                    }),
                    endButton: new Button({
                        text: "Cancelar",
                        press: function () { oDialog.close(); }
                    }),
                    afterClose: function () { oDialog.destroy(); }
                });

                this.getView().addDependent(oDialog);
                oDialog.open();
            },

            // ─── NAVEGACION ──────────────────────────────────────────────────

            _navegarALista: function () {
                try {
                    this.getView().getController().getOwnerComponent()
                        .getRouter().navTo("TareasInboxList");
                } catch (e) {
                    window.history.back();
                }
            },

            // ─── HANDLERS PUBLICOS ────────────────────────────────────────────

            onApoderadoAprobar:  function () { this._ejecutarDirecto("apoderadoAprobar",  "Aprobacion"); },
            onApoderadoObservar: function () { this._ejecutarConComentario("apoderadoObservar", "Observar"); },
            onLiberadorLiberar:  function () { this._ejecutarDirecto("liberadorLiberar",  "Liberacion"); },
            onLiberadorRechazar: function () { this._ejecutarConComentario("liberadorRechazar", "Rechazar"); },
            onLiberadorAnular:   function () { this._ejecutarConComentario("liberadorAnular",   "Anular");   }
        }
    );
});