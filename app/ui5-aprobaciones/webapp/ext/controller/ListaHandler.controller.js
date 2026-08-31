/**
 * Controller Extension — ajustes del List Report "Propuestas de Nómina".
 * Registrado en manifest.json bajo sap.ui5 > extends > extensions >
 * sap.ui.controllerExtensions > sap.fe.templates.ListReport.ListReportController.
 *
 * Oculta el botón "Adaptar filtros" (showAdaptFiltersButton de
 * sap.ui.mdc.FilterBar, no configurable desde el manifest) para que el
 * usuario solo use los filtros de UI.SelectionFields.
 *
 * Oculta el botón "Copiar" de la toolbar de la tabla vía
 * sap.m.plugins.CopyProvider#setVisible(false) (no `enabled`, que solo lo
 * deshabilita en gris).
 *
 * Da acabado (tipo Accept/Reject + icono) a los botones "Aprobar masivo" /
 * "Rechazar masivo": sap.fe solo traduce Criticality/IconUrl a tipo de botón
 * en las acciones Determining del footer del Object Page, no en la toolbar
 * de una tabla mdc, así que se asigna aquí sobre el botón ya construido. Se
 * localizan por su ID estable de sap.fe (incorpora el nombre de la acción).
 *
 * El botón de configuración (rueda dentada) no se toca aquí: se apaga
 * declarativamente con tableSettings.personalization = false en el manifest.
 *
 * Carga inicial al volver con el botón del navegador: sap.fe encola la
 * búsqueda inicial en la barra de filtros mientras esta permanece suspendida
 * durante la restauración de estado (ViewState.onBeforeStateApplied). En un
 * NavType iAppState/hybrid (botón atrás, F5 en Work Zone) esa cola llega
 * vacía y la tabla no dispara ninguna petición. El arreglo es encolar
 * nosotros la búsqueda en onBeforeStateApplied, con la barra ya suspendida
 * por sap.fe; es idempotente porque _bSearchTriggered es un booleano.
 *
 * Se usa viewState.onAfterStateApplied y no onPageReady/onInit porque son los
 * únicos hooks de este template marcados publicExtension + extensible; los
 * demás se descartan en silencio (a diferencia del Object Page, donde
 * onPageReady sí es publicExtension — ver AccionesHandler).
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/m/library",
    "sap/base/Log"
], function (ControllerExtension, mLibrary, Log) {
    "use strict";

    var ButtonType = mLibrary.ButtonType;

    // Marca en la propia tabla para no acumular un delegado por cada pasada.
    var CLAVE_DELEGADO = "__aprobacionesAjustesToolbar";

    // Acabado de las acciones masivas. La clave es el fragmento que sap.fe
    // incrusta en el ID del boton a partir del nombre de la accion bound.
    var ACCIONES_MASIVAS = [
        { clave: "aprobarMasivo",  tipo: ButtonType.Accept, icono: "sap-icon://accept" },
        { clave: "rechazarMasivo", tipo: ButtonType.Reject, icono: "sap-icon://decline" }
    ];

    /**
     * Apaga el boton "Adaptar filtros" en todas las barras de filtro de la
     * vista. Se busca por tipo y no por ID: el ID lo arma sap.fe internamente
     * y no forma parte de su contrato público.
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

    /**
     * Apaga el boton "Copiar" de una tabla a traves del plugin que lo genera.
     */
    function apagarBotonCopiar(oTabla) {
        var oCopyProvider = typeof oTabla.getCopyProvider === "function"
            ? oTabla.getCopyProvider()
            : null;

        if (!oCopyProvider || typeof oCopyProvider.setVisible !== "function") {
            return;
        }

        oCopyProvider.setVisible(false);
    }

    /**
     * Aplica los ajustes de toolbar a todas las tablas MDC de la vista y los
     * engancha a su renderizado, para que sobrevivan a los rebind (el
     * CopyProvider puede recrearse en ese momento).
     */
    function ajustarToolbarTabla(oVista) {
        if (!oVista) {
            return;
        }

        oVista.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.ui.mdc.Table");
        })
        .forEach(function (oTabla) {
            apagarBotonCopiar(oTabla);
            estilizarAccionesMasivas(oTabla);

            if (!oTabla[CLAVE_DELEGADO]) {
                oTabla[CLAVE_DELEGADO] = true;
                oTabla.addEventDelegate({
                    onAfterRendering: function () {
                        apagarBotonCopiar(oTabla);
                        estilizarAccionesMasivas(oTabla);
                    }
                });
            }
        });
    }

    /**
     * Encola la busqueda inicial en la barra de filtros mientras sap.fe la
     * tiene suspendida, para que la tabla cargue sola al restaurar el estado
     * de la vista (botón atrás / refresco). Ver cabecera del módulo.
     */
    function asegurarBusquedaInicial(oVista) {
        if (!oVista) {
            return;
        }

        oVista.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.ui.mdc.FilterBar");
        })
        .forEach(function (oFilterBar) {
            // Solo encolamos si la barra ya está suspendida; si no lo estuviera,
            // triggerSearch() lanzaría una búsqueda real antes de tiempo.
            if (typeof oFilterBar.getSuspendSelection !== "function" ||
                !oFilterBar.getSuspendSelection()) {
                return;
            }

            oFilterBar.triggerSearch();
        });
    }

    /**
     * Pone tipo Accept/Reject e icono a las acciones masivas de la toolbar.
     * Reasignar en cada render no cuesta nada: setProperty descarta la
     * asignación cuando el valor no cambia.
     */
    function estilizarAccionesMasivas(oContenedor) {
        if (!oContenedor) {
            return;
        }

        oContenedor.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.m.Button");
        })
        .forEach(function (oBoton) {
            var sId = oBoton.getId();

            ACCIONES_MASIVAS.forEach(function (oAccion) {
                if (sId.indexOf(oAccion.clave) === -1) {
                    return;
                }
                oBoton.setType(oAccion.tipo);
                oBoton.setIcon(oAccion.icono);
            });
        });
    }

    /** Ejecuta un ajuste sin que su fallo impida los siguientes ni rompa el arranque de sap.fe. */
    function proteger(fnAjuste, oVista) {
        try {
            fnAjuste(oVista);
        } catch (oError) {
            Log.error(
                "Fallo un ajuste de la lista: " + fnAjuste.name,
                oError,
                "centria.h2hpp.aprobaciones.ui5aprobaciones.ext.controller.ListaHandler"
            );
        }
    }

    return ControllerExtension.extend(
        "centria.h2hpp.aprobaciones.ui5aprobaciones.ext.controller.ListaHandler",
        {
            override: {
                // Override anidado sobre la sub-extensión viewState; "this" es
                // la extensión ViewState, no el controller (vista vía this.base).
                viewState: {
                    onBeforeStateApplied: function () {
                        proteger(asegurarBusquedaInicial, this.base.getView());
                    },

                    onAfterStateApplied: function () {
                        var oVista = this.base.getView();
                        proteger(ocultarAdaptarFiltros, oVista);
                        proteger(ajustarToolbarTabla, oVista);
                    }
                }
            }
        }
    );
});
