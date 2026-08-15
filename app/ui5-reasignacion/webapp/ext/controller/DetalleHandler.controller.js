/**
 * app/ui5-reasignacion/webapp/ext/controller/DetalleHandler.controller.js
 *
 * Controller Extension — Object Page de la propuesta.
 * Registrado en manifest.json bajo:
 *   sap.ui5 > extends > extensions > sap.ui.controllerExtensions >
 *   sap.fe.templates.ObjectPage.ObjectPageController
 *
 * MOTIVO DE ESTE ARCHIVO
 * ----------------------
 * Pone el icono en los botones "Reasignar" de la tabla de firmantes.
 *
 * No se puede hacer por anotacion: IconUrl en un UI.DataFieldForAction con
 * Inline:true hace que Fiori Elements renderice un boton de SOLO ICONO y mande
 * el texto al tooltip, con lo que la fila pierde la palabra "Reasignar".
 * Comprobado; de ahi la inyeccion por codigo.
 *
 * POR QUE onPageReady AQUI Y viewState EN LA LISTA
 * ------------------------------------------------
 * sap.fe solo deja sobrescribir los metodos marcados publicExtension +
 * extensible, y los dos templates NO coinciden:
 *
 *   ObjectPageController.onPageReady  → publicExtension  ✔ (este archivo)
 *   ListReportController.onPageReady  → privateExtension ✘ el override se
 *                                       descarta EN SILENCIO
 *
 * Por eso ListaHandler tiene que engancharse a viewState.onAfterStateApplied y
 * aqui basta con onPageReady. No son intercambiables.
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
    "use strict";

    var ICONO_REASIGNAR = "sap-icon://user-edit";

    // Marca en la propia tabla para no acumular un delegado por cada pasada.
    var CLAVE_DELEGADO = "__reasignacionIconoFirmantes";

    /**
     * Pone el icono en los botones "Reasignar" que haya bajo el control dado.
     *
     * Se identifican por su texto —el Label de la anotacion— porque sap.fe no
     * expone un ID estable para las acciones de linea. Mismo criterio que usa
     * AccionesHandler en ui5-aprobaciones para los botones del Object Page.
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
     * Engancha la inyeccion al renderizado de la tabla INTERNA.
     *
     * Hace falta ademas de la pasada inicial porque la tabla MDC y sus filas
     * renderizan en momentos distintos: la MDC se pinta una vez y las filas
     * —con su boton de accion— llegan despues, cuando responde el servicio, sin
     * que la MDC vuelva a renderizarse.
     */
    function engancharAFilas(oTabla) {
        var oTipo    = typeof oTabla.getType === "function" ? oTabla.getType() : null;
        var oInterna = oTipo && typeof oTipo.getInnerTable === "function"
            ? oTipo.getInnerTable()
            : null;

        // Todavia no existe: la siguiente pasada de onPageReady lo reintentara.
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
