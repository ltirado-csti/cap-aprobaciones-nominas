/**
 * Controller Extension — Object Page de la propuesta.
 * Registrado en manifest.json bajo sap.ui5 > extends > extensions >
 * sap.ui.controllerExtensions > sap.fe.templates.ObjectPage.ObjectPageController.
 *
 * Pone el icono en los botones "Reasignar" de la tabla de firmantes por
 * código: IconUrl en un UI.DataFieldForAction con Inline:true haría que
 * Fiori Elements renderice un botón de solo icono, sin la palabra "Reasignar".
 *
 * Usa onPageReady (publicExtension en este template) y no
 * viewState.onAfterStateApplied como ListaHandler, que en List Report es el
 * único hook público disponible.
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
    "use strict";

    var ICONO_REASIGNAR = "sap-icon://user-edit";

    // Marca en la propia tabla para no acumular un delegado por cada pasada.
    var CLAVE_DELEGADO = "__reasignacionIconoFirmantes";

    /**
     * Pone el icono en los botones "Reasignar" bajo el control dado.
     * Se identifican por su texto (Label de la anotación): sap.fe no expone
     * un ID estable para las acciones de línea.
     */
    function ponerIcono(oRaiz) {
        oRaiz.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.m.Button") &&
                   oControl.getText() === "Reasignar" &&
                   oControl.getIcon() !== ICONO_REASIGNAR;
        })
        .forEach(function (oBoton) {
            oBoton.setIcon(ICONO_REASIGNAR);
        });
    }

    /**
     * Engancha la inyección al renderizado de la tabla interna: la MDC se
     * pinta una vez y las filas (con su botón de acción) llegan después, sin
     * que la MDC vuelva a renderizarse.
     */
    function engancharAFilas(oTabla) {
        var oTipo    = typeof oTabla.getType === "function" ? oTabla.getType() : null;
        var oInterna = oTipo && typeof oTipo.getInnerTable === "function"
            ? oTipo.getInnerTable()
            : null;

        if (!oInterna || oInterna[CLAVE_DELEGADO]) {
            return;
        }

        oInterna[CLAVE_DELEGADO] = true;
        oInterna.addEventDelegate({
            onAfterRendering: function () {
                ponerIcono(oTabla);
            }
        });
    }

    return ControllerExtension.extend(
        "centria.h2hpp.aprobaciones.ui5reasignacion.ext.controller.DetalleHandler",
        {
            override: {
                onPageReady: function () {
                    var oVista = this.getView();
                    if (!oVista) {
                        return;
                    }

                    oVista.findAggregatedObjects(true, function (oControl) {
                        return oControl.isA("sap.ui.mdc.Table");
                    })
                    .forEach(function (oTabla) {
                        engancharAFilas(oTabla);
                        ponerIcono(oTabla);
                    });
                }
            }
        }
    );
});
