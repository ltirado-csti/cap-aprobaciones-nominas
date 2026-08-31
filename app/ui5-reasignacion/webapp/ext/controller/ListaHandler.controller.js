/**
 * Controller Extension — ajustes del List Report "Tareas de Aprobación".
 * Registrado en manifest.json bajo sap.ui5 > extends > extensions >
 * sap.ui.controllerExtensions > sap.fe.templates.ListReport.ListReportController.
 *
 * Limpia controles que esta app no necesita, ninguno apagable desde el
 * manifest, todos vía API pública del control ya construido:
 *   - "Adaptar filtros" (sap.ui.mdc.FilterBar#setShowAdaptFiltersButton(false))
 *   - "Copiar" (sap.m.plugins.CopyProvider#setVisible(false); la tabla no
 *     tiene selección y ya está el botón de exportar)
 *   - "Mostrar / Ocultar detalles" (sap.ui.mdc.table.ResponsiveTableType
 *     #setShowDetailsButton(false); con los anchos del manifest las 7
 *     columnas entran enteras)
 * El botón de configuración (rueda dentada) se apaga declarativamente con
 * tableSettings.personalization = false en el manifest.
 *
 * Usa viewState.onAfterStateApplied porque onPageReady es privateExtension
 * en este template (el override se descartaría en silencio) — ver el mismo
 * enganche en ui5-aprobaciones. Se reengancha además al onAfterRendering de
 * la tabla porque setShowDetailsButton() no hace nada si la tabla interna
 * aún no existe cuando se aplica el estado de la vista.
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
    "use strict";

    // Marca en la propia tabla para no acumular un delegado por cada pasada.
    var CLAVE_DELEGADO = "__reasignacionLimpiezaToolbar";

    /**
     * Apaga el grupo "Mostrar / Ocultar detalles" por la API del tipo de tabla.
     * getType() puede devolver el nombre del tipo como cadena en vez de la
     * instancia; se comprueba antes de llamar.
     * @returns {boolean} true si se pudo aplicar la API pública
     */
    function apagarBotonDetalles(oTabla) {
        var oTipo = typeof oTabla.getType === "function" ? oTabla.getType() : null;

        if (!oTipo || typeof oTipo.setShowDetailsButton !== "function") {
            return false;
        }

        oTipo.setShowDetailsButton(false);
        return true;
    }

    /**
     * Apaga el boton "Copiar" a traves del plugin que lo genera.
     * @returns {boolean} true si se pudo aplicar la API publica
     */
    function apagarBotonCopiar(oTabla) {
        var oCopyProvider = typeof oTabla.getCopyProvider === "function"
            ? oTabla.getCopyProvider()
            : null;

        if (!oCopyProvider || typeof oCopyProvider.setVisible !== "function") {
            return true;
        }

        oCopyProvider.setVisible(false);
        return true;
    }

    /**
     * Respaldo para runtimes donde las APIs de arriba no esten disponibles.
     * Se identifica por icono y no por ID: los identificadores de la toolbar
     * los arma sap.ui.mdc internamente y no son contrato público.
     */
    function ocultarBotonDetallesPorIcono(oTabla) {
        oTabla.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.m.SegmentedButton");
        })
        .filter(function (oGrupo) {
            return (oGrupo.getItems() || []).some(function (oItem) {
                return String(oItem.getIcon() || "").indexOf("sap-icon://detail-") === 0;
            });
        })
        .forEach(function (oGrupo) {
            oGrupo.setVisible(false);
        });
    }

    /** Aplica la limpieza sobre una tabla concreta. */
    function limpiarTabla(oTabla) {
        if (!apagarBotonDetalles(oTabla)) {
            ocultarBotonDetallesPorIcono(oTabla);
        }
        apagarBotonCopiar(oTabla);
    }

    /**
     * Apaga el boton "Adaptar filtros" en las barras de filtro de la vista.
     * Se busca por tipo y no por ID: el ID lo arma sap.fe internamente.
     */
    function ocultarAdaptarFiltros(oVista) {
        oVista.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.ui.mdc.FilterBar");
        })
        .forEach(function (oFilterBar) {
            oFilterBar.setShowAdaptFiltersButton(false);
        });
    }

    /**
     * Limpia todas las tablas MDC de la vista y deja enganchada la limpieza a
     * su renderizado, para que sobreviva a los rebind de la tabla.
     */
    function limpiarCabeceraTablas(oVista) {
        if (!oVista) {
            return;
        }

        oVista.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.ui.mdc.Table");
        })
        .forEach(function (oTabla) {
            limpiarTabla(oTabla);

            if (!oTabla[CLAVE_DELEGADO]) {
                oTabla[CLAVE_DELEGADO] = true;
                oTabla.addEventDelegate({
                    onAfterRendering: function () {
                        limpiarTabla(oTabla);
                    }
                });
            }
        });
    }

    return ControllerExtension.extend(
        "centria.h2hpp.aprobaciones.ui5reasignacion.ext.controller.ListaHandler",
        {
            override: {
                // "this" es la extensión ViewState, no el controller (vista vía this.base).
                viewState: {
                    onAfterStateApplied: function () {
                        var oVista = this.base.getView();
                        if (!oVista) {
                            return;
                        }
                        ocultarAdaptarFiltros(oVista);
                        limpiarCabeceraTablas(oVista);
                    }
                }
            }
        }
    );
});
