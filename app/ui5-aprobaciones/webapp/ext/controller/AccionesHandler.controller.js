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
            // ─── PUNTOS DE EXTENSION OFICIALES DE sap.fe ──────────────────────
            // Hooks como onPageReady deben declararse dentro de "override" para
            // que sap.fe.templates.ObjectPage.ObjectPageController los reconozca
            // y los invoque. Declararlos como metodo directo del objeto (fuera de
            // "override") causa un error interno al intentar resolverlos.
            override: {
                /**
                 * Se dispara una vez que la pagina esta totalmente enlazada y renderizada.
                 *
                 * IconUrl en UI.DataFieldForAction NO se pinta en botones de footer
                 * (Determining: true) — es una limitacion del template de Object Page.
                 * Se inyecta el icono por codigo, buscando los botones por su texto
                 * (Label de la anotacion), ya que sap.fe no expone un ID estable
                 * para estas acciones sin declarar un ID explicito en la anotacion.
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

                /**
                 * Al destruirse la vista hay que cortar cualquier espera pendiente:
                 * un setTimeout vivo intentaria navegar sobre un controller ya
                 * destruido si el usuario sale de la pagina por su cuenta.
                 */
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
             * Pone el icono de PDF al boton "Ver PDF" del header.
             *
             * No sale del manifest: las acciones custom (content > header >
             * actions) NO admiten `icon`. El conversor de sap.fe que las traduce
             * a botones —core/converters/controls/Common/Action.js,
             * getActionsFromManifest— copia text, press, visible, enabled,
             * position, menu y demas, pero nunca lee un icono; los unicos iconos
             * que pone son los suyos, escritos a fuego para acciones estandar
             * como exportar o imprimir. De ahi que se asigne aqui, sobre el
             * boton ya construido.
             *
             * Se localiza por ID y no por texto —al contrario que Aprobar y
             * Rechazar, que vienen de anotaciones— porque una accion custom SI
             * tiene ID estable: sap.fe le incrusta su clave del manifest
             * ("...::CustomAction::verPDF"). Es un ancla mejor que el rotulo,
             * que sale de i18n y cambia con el idioma.
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
             * Aprobar/Rechazar/Liberar/Anular tienen Common.SideEffects
             * en la anotacion (ver annotations.cds), que ya refresca la coleccion
             * TareasInbox y hace desaparecer la tarea resuelta de "Propuestas de
             * Nómina". Pero eso solo actualiza la lista: el Object Page (columna
             * media) se queda abierto mostrando la tarea ya resuelta hasta que el
             * usuario lo cierra manualmente.
             *
             * Como los botones ejecutan la accion OData a traves del flujo
             * estandar de sap.fe (no de _ejecutarDirecto/_ejecutarConComentario
             * de este archivo), no hay una promesa propia que avisar cuando la
             * accion termina. En su lugar se observa el campo estadoPP —el
             * "Estado" del header— que BPA cambia como resultado de cada
             * decision; su primer cambio tras el render inicial se interpreta
             * como "accion completada" y dispara el cierre.
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
                // onPageReady se dispara en cada navegacion: cancelar la espera
                // de la tarea anterior evita que un temporizador viejo navegue
                // encima de la pagina recien abierta.
                this._cancelarEsperaMensaje();

                var bPrimerValor = true;
                this._oEstadoPPBinding = oContext.getModel().bindProperty("estadoPP", oContext);
                this._oEstadoPPBinding.attachChange(function () {
                    if (bPrimerValor) {
                        bPrimerValor = false;
                        return;
                    }
                    // No navegar de inmediato: al cerrarse el Object Page se
                    // destruye el diálogo de mensaje que Fiori Elements acaba de
                    // abrir con el resultado (sap-messages), y el usuario nunca
                    // alcanza a leerlo. Se espera a que lo cierre.
                    that._navegarTrasLeerMensaje();
                });
                this._oEstadoPPBinding.initialize();
            },

            // ─── ESPERA AL CIERRE DEL MENSAJE ANTES DE NAVEGAR ────────────────

            /**
             * Difiere la navegacion a la lista hasta que no quede ningun dialogo
             * abierto — en la practica, hasta que el usuario cierre el mensaje de
             * resultado que Fiori Elements muestra a partir de la cabecera
             * sap-messages que emite el backend (req.info en aprobacion.service.js).
             *
             * La gracia inicial es necesaria: el cambio de estadoPP puede llegar
             * ANTES de que FE alcance a abrir el dialogo. Sin ella se consultaria
             * "hay dialogos abiertos?" cuando todavia no hay ninguno y se navegaria
             * igual, reproduciendo el problema.
             */
            _navegarTrasLeerMensaje: function () {
                var that = this;
                this._cancelarEsperaMensaje();
                this._iGraciaMensaje = setTimeout(function () {
                    that._esperarCierreDialogos(0);
                }, 800);
            },

            /**
             * Reintenta hasta que InstanceManager no reporte dialogos abiertos.
             * El tope evita quedar colgado si algun dialogo permanece abierto por
             * otro motivo: pasados ~30 s se navega igual.
             */
            _esperarCierreDialogos: function (iIntento) {
                var that = this;
                var MAX_INTENTOS = 100;   // 100 x 300 ms ≈ 30 s

                sap.ui.require(["sap/m/InstanceManager"], function (InstanceManager) {
                    // La vista pudo destruirse mientras esperabamos (el usuario
                    // navego por su cuenta): abortar sin tocar el router.
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
             * Vuelve a la lista cerrando la columna del Object Page (FCL).
             *
             * Implementacion anterior y por que fallaba:
             *   getView().getController().getOwnerComponent().getRouter()
             *   En sap.fe el componente propietario de la vista es el component
             *   del TEMPLATE (sap.fe.templates.ObjectPage.Component), que NO tiene
             *   router propio: getRouter() devuelve undefined y el .navTo() lanza
             *   TypeError. El catch caia entonces en window.history.back(), que si
             *   la app se abrio directamente (Launchpad o pestaña nueva) NO vuelve
             *   a la lista: SACA AL USUARIO DEL APLICATIVO.
             *
             * Ahora se usa la via soportada por sap.fe —ExtensionAPI.getRouting()—
             * con un respaldo que sube por la jerarquia de componentes hasta
             * encontrar uno con router. Y sobre todo: nunca history.back().
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