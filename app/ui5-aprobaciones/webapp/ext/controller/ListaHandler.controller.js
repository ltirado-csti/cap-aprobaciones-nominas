/**
 * app/ui5-aprobaciones/webapp/ext/controller/ListaHandler.controller.js
 *
 * Controller Extension — ajustes del List Report "Propuestas de Nómina".
 * Registrar en manifest.json bajo:
 *   sap.ui5 > extends > extensions > sap.ui.controllerExtensions >
 *   sap.fe.templates.ListReport.ListReportController
 *
 * MOTIVO DE ESTE ARCHIVO
 * ----------------------
 * Oculta el boton "Adaptar filtros" de la barra de filtros, para que el usuario
 * solo disponga de los filtros declarados en UI.SelectionFields y no pueda
 * anadir otros por su cuenta.
 *
 * No hay ajuste de manifest que lo haga: en sap.fe 1.148 la plantilla
 * ListReport.view.xml instancia la macro FilterBar con la propiedad escrita
 * a fuego:
 *
 *     <macro:FilterBar ... showAdaptFiltersButton="true" p13nMode="Item,Value" />
 *
 * Como no es configurable desde fuera, la unica via soportada es apagar la
 * propiedad sobre el control ya construido — showAdaptFiltersButton es API
 * publica de sap.ui.mdc.FilterBar.
 *
 * El boton de configuracion (rueda dentada) de la tabla NO se toca aqui: ese si
 * es declarativo y se apaga con tableSettings.personalization = false en el
 * manifest.
 *
 * POR QUE viewState.onAfterStateApplied Y NO onPageReady
 * ------------------------------------------------------
 * sap.fe clasifica cada metodo con dos decoradores y solo permite sobrescribir
 * los que son publicExtension + extensible. En este template:
 *
 *   ListReportController.onPageReady   → privateExtension  ✘ el override se
 *                                        descarta EN SILENCIO (sin error en
 *                                        consola, el boton seguia apareciendo)
 *   PageController.onInit              → sin extensible    ✘ idem
 *   viewState.onAfterStateApplied      → publicExtension + extensible(After) ✔
 *
 * Ojo con el contraste: en el Object Page onPageReady SI es publicExtension,
 * que es por lo que AccionesHandler puede usarlo. No son intercambiables.
 *
 * Los hooks de ciclo de vida de MVC (onInit / onAfterRendering) declarados
 * directamente en la extension tampoco sirven: sap.fe no los propaga a las
 * extensiones de aplicacion (verificado — el modulo se evalua pero los hooks
 * nunca se invocan).
 *
 * onAfterStateApplied se ejecuta al terminar de aplicar el estado de la vista,
 * en la carga inicial y en cada cambio de variante, con la barra de filtros ya
 * construida. Volver a asignar la propiedad no tiene coste: setProperty de UI5
 * descarta la asignacion cuando el valor no cambia.
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
    "use strict";

    /**
     * Apaga el boton "Adaptar filtros" en todas las barras de filtro de la vista.
     *
     * Se busca por tipo y no por ID: el identificador lo arma sap.fe
     * internamente (StableIdHelper sobre filterBarId) y no forma parte de su
     * contrato publico.
     */
    function ocultarAdaptarFiltros(oVista) {
        if (!oVista) {
            return;
        }

        oVista.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.ui.mdc.FilterBar");
        })
        .forEach(function (oFilterBar) {
            oFilterBar.setShowAdaptFiltersButton(false);
        });
    }

    return ControllerExtension.extend(
        "centria.h2hpp.aprobaciones.ui5aprobaciones.ext.controller.ListaHandler",
        {
            override: {
                // Override anidado sobre la sub-extension viewState del
                // controller. Dentro, "this" es la extension ViewState, no el
                // controller: la vista se alcanza por this.base.
                viewState: {
                    onAfterStateApplied: function () {
                        ocultarAdaptarFiltros(this.base.getView());
                    }
                }
            }
        }
    );
});
