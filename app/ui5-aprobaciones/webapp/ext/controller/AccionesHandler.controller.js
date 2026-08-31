/**
 * Controller Extension — acciones BPA del Object Page.
 * Registrado en manifest.json bajo sap.ui5 > extends > extensions >
 * sap.ui.controllerExtensions > sap.fe.templates.ObjectPage.ObjectPageController.
 *
 * Botones con Visible: true (sin binding a esApoderado, que no llega al
 * $select del Object Page); la autorización real la valida el backend
 * (_prepararAccion lee el rol de BPA).
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/core/Component",
    "sap/m/MessageBox",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/TextArea",
    "sap/m/Label",
    "sap/m/VBox"
], function (
    ControllerExtension,
    Component,
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
            // Los hooks deben declararse dentro de "override" para que
            // sap.fe.templates.ObjectPage.ObjectPageController los reconozca.
            override: {
                /**
                 * Se dispara una vez que la pagina esta totalmente enlazada y renderizada.
                 * IconUrl en UI.DataFieldForAction no se pinta en botones de
                 * footer (Determining: true), así que se inyecta el icono por
                 * código, buscando los botones por su Label.
                 */
                onPageReady: function () {
                    var mIconosPorLabel = {
                        "Aprobar" : "sap-icon://accept",
                        "Rechazar": "sap-icon://decline"
                    };

                    this.getView()
                        .findAggregatedObjects(true, function (oControl) {
                            return oControl.isA("sap.m.Button") && !!mIconosPorLabel[oControl.getText()];
                        })
                        .forEach(function (oBoton) {
                            oBoton.setIcon(mIconosPorLabel[oBoton.getText()]);
                        });

                    this._ponerIconoVerPDF();
                    this._observarCierreTrasAccion();
                },

                /** Al destruirse la vista, cancela cualquier espera pendiente. */
                onExit: function () {
                    this._cancelarEsperaMensaje();
                    if (this._oEstadoPPBinding) {
                        this._oEstadoPPBinding.destroy();
                        this._oEstadoPPBinding = null;
                    }
                }
            },

            // ─── ICONO DEL BOTON "VER PDF" ────────────────────────────────────

            /**
             * Pone el icono de PDF al boton "Ver PDF" del header. No sale del
             * manifest: las acciones custom no admiten `icon`. Se localiza por
             * ID (sap.fe le incrusta su clave del manifest, "...::CustomAction::verPDF").
             */
            _ponerIconoVerPDF: function () {
                this.getView()
                    .findAggregatedObjects(true, function (oControl) {
                        return oControl.isA("sap.m.Button") &&
                               oControl.getId().indexOf("verPDF") !== -1;
                    })
                    .forEach(function (oBoton) {
                        oBoton.setIcon("sap-icon://pdf-attachment");
                    });
            },

            // ─── CIERRE AUTOMATICO TRAS UNA ACCION EXITOSA ────────────────────

            /**
             * Common.SideEffects (ver annotations.cds) refresca TareasInbox
             * tras Aprobar/Rechazar/Liberar/Anular, pero el Object Page se
             * queda abierto. Como esos botones ejecutan la acción OData por el
             * flujo estándar de sap.fe, se observa el campo estadoPP: su
             * primer cambio tras el render inicial se interpreta como "acción
             * completada" y dispara el cierre.
             */
            _observarCierreTrasAccion: function () {
                var that     = this;
                var oContext = this.getView().getBindingContext();
                if (!oContext) {
                    return;
                }

                if (this._oEstadoPPBinding) {
                    this._oEstadoPPBinding.destroy();
                }
                this._cancelarEsperaMensaje();

                var bPrimerValor = true;
                this._oEstadoPPBinding = oContext.getModel().bindProperty("estadoPP", oContext);
                this._oEstadoPPBinding.attachChange(function () {
                    if (bPrimerValor) {
                        bPrimerValor = false;
                        return;
                    }
                    that._navegarTrasLeerMensaje();
                });
                this._oEstadoPPBinding.initialize();
            },

            // ─── ESPERA AL CIERRE DEL MENSAJE ANTES DE NAVEGAR ────────────────

            /**
             * Difiere la navegación a la lista hasta que el usuario cierre el
             * diálogo de resultado que Fiori Elements abre (sap-messages). La
             * gracia inicial evita consultar "hay diálogos abiertos" antes de
             * que FE alcance a abrir el suyo.
             */
            _navegarTrasLeerMensaje: function () {
                var that = this;
                this._cancelarEsperaMensaje();
                this._iGraciaMensaje = setTimeout(function () {
                    that._esperarCierreDialogos(0);
                }, 800);
            },

            /**
             * Reintenta hasta que InstanceManager no reporte diálogos abiertos.
             * El tope evita quedar colgado (~30 s) si un diálogo no se cierra.
             */
            _esperarCierreDialogos: function (iIntento) {
                var that = this;
                var MAX_INTENTOS = 100;   // 100 x 300 ms ≈ 30 s

                sap.ui.require(["sap/m/InstanceManager"], function (InstanceManager) {
                    if (!that.getView() || that.getView().bIsDestroyed) {
                        return;
                    }

                    if (InstanceManager.getOpenDialogs().length > 0 && iIntento < MAX_INTENTOS) {
                        that._iGraciaMensaje = setTimeout(function () {
                            that._esperarCierreDialogos(iIntento + 1);
                        }, 300);
                        return;
                    }

                    that._navegarALista();
                });
            },

            /** Cancela cualquier espera pendiente para no navegar dos veces. */
            _cancelarEsperaMensaje: function () {
                if (this._iGraciaMensaje) {
                    clearTimeout(this._iGraciaMensaje);
                    this._iGraciaMensaje = null;
                }
            },

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
                        var oResultado = oActionBinding.getBoundContext().getObject();
                        var sMensaje   = (oResultado && oResultado.mensaje) || (sLabel + " ejecutada correctamente");

                        MessageBox.success(sMensaje, {
                            title: sLabel,
                            onClose: function () { that._navegarALista(); }
                        });
                    })
                    .catch(function (oError) {
                        MessageBox.error(
                            (oError.error && oError.error.message) || oError.message || "Error",
                            { title: "Error en " + sLabel }
                        );
                    });
            },

            // ─── EJECUCION CON DIALOGO (Rechazar / Anular) ───────────────────

            /**
             * Solicita comentario antes de ejecutar la accion.
             * Segun BPA: se requiere justificacion en los casos de rechazo.
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
                                    var oResultado = oActionBinding.getBoundContext().getObject();
                                    var sMensaje   = (oResultado && oResultado.mensaje) || (sLabel + " ejecutada correctamente");

                                    MessageBox.success(sMensaje, {
                                        title: sLabel,
                                        onClose: function () { that._navegarALista(); }
                                    });
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

            /**
             * Vuelve a la lista cerrando la columna del Object Page (FCL), vía
             * ExtensionAPI.getRouting() con respaldo subiendo por la jerarquía
             * de componentes hasta encontrar uno con router. Nunca history.back().
             */
            _navegarALista: function () {
                var RUTA_LISTA = "TareasInboxList";

                // 1) Via oficial de sap.fe (PageController.getExtensionAPI)
                try {
                    var oExtensionAPI = this.base && this.base.getExtensionAPI && this.base.getExtensionAPI();
                    var oRouting      = oExtensionAPI && oExtensionAPI.getRouting && oExtensionAPI.getRouting();
                    if (oRouting && oRouting.navigateToRoute) {
                        oRouting.navigateToRoute(RUTA_LISTA).catch(function (oError) {
                            console.error("[AccionesHandler] navigateToRoute fallo", oError);
                        });
                        return;
                    }
                } catch (e) {
                    console.warn("[AccionesHandler] ExtensionAPI no disponible", e);
                }

                // 2) Respaldo: buscar hacia arriba el componente que si tiene router
                try {
                    var oComponente = Component.getOwnerComponentFor(this.getView());
                    var oRouter;
                    while (oComponente) {
                        if (typeof oComponente.getRouter === "function") {
                            oRouter = oComponente.getRouter();
                            if (oRouter && typeof oRouter.navTo === "function") {
                                oRouter.navTo(RUTA_LISTA);
                                return;
                            }
                        }
                        oComponente = Component.getOwnerComponentFor(oComponente);
                    }
                } catch (e) {
                    console.warn("[AccionesHandler] respaldo de router fallo", e);
                }

                // 3) Sin salida valida: dejar la pagina abierta. Es preferible que
                //    el usuario cierre la columna a mano antes que expulsarlo.
                console.warn("[AccionesHandler] no se pudo volver a la lista; se deja el Object Page abierto");
            },

            // ─── HANDLERS PUBLICOS ────────────────────────────────────────────

            onApoderadoAprobar:  function () { this._ejecutarDirecto("apoderadoAprobar",  "Aprobacion"); },
            onApoderadoRechazar: function () { this._ejecutarConComentario("apoderadoRechazar", "Rechazar"); },
            onLiberadorLiberar:  function () { this._ejecutarDirecto("liberadorLiberar",  "Liberacion"); },
            onLiberadorRechazar: function () { this._ejecutarConComentario("liberadorRechazar", "Rechazar"); },
            onLiberadorAnular:   function () { this._ejecutarConComentario("liberadorAnular",   "Anular");   }
        }
    );
});