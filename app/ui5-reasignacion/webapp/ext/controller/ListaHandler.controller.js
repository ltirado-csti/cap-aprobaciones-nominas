/**
 * app/ui5-reasignacion/webapp/ext/controller/ListaHandler.controller.js
 *
 * Controller Extension — ajustes del List Report "Tareas de Aprobacion".
 * Registrado en manifest.json bajo:
 *   sap.ui5 > extends > extensions > sap.ui.controllerExtensions >
 *   sap.fe.templates.ListReport.ListReportController
 *
 * MOTIVO DE ESTE ARCHIVO
 * ----------------------
 * Limpia la barra de filtros y la cabecera de la tabla de los controles que
 * esta app no necesita:
 *
 *   - El boton "Adaptar filtros", para que el admin solo disponga de los
 *     filtros declarados en UI.SelectionFields y no pueda anadir otros.
 *
 *   - El boton "Copiar" (sap-icon://copy), que vuelca al portapapeles las filas
 *     seleccionadas. La tabla no tiene seleccion (selectionMode: None) y para
 *     llevarse los datos ya esta el boton de exportar.
 *   - El grupo "Mostrar / Ocultar detalles" (los dos botones segmentados), que
 *     repliega al area de pop-in las columnas de importancia baja. Con los
 *     anchos fijados en el manifest las 7 columnas entran enteras.
 *
 * El boton de configuracion (rueda dentada) NO se toca aqui: ese si es
 * declarativo y se apaga con tableSettings.personalization = false en el
 * manifest, igual que en ui5-aprobaciones.
 *
 * NINGUNO de los tres se puede apagar desde el manifest. El de "Adaptar
 * filtros" llega escrito a fuego en la plantilla ListReport.view.xml de sap.fe
 * (showAdaptFiltersButton="true"), y los otros dos no estan expuestos en
 * tableSettings. Los tres si son API publica del control ya construido, que es
 * la via que se usa aqui:
 *
 *   sap.ui.mdc.FilterBar#setShowAdaptFiltersButton(false)
 *       Retira el boton de la barra de filtros.
 *
 *   sap.ui.mdc.table.ResponsiveTableType#setShowDetailsButton(false)
 *       Retira el SegmentedButton de la toolbar interna y lo destruye.
 *   sap.m.plugins.CopyProvider#setVisible(false)
 *       Documentado en sap.ui.mdc.Table como LA forma de ocultar el boton
 *       Copiar de la toolbar (la visibilidad del boton la gobierna el plugin,
 *       no el boton). Ojo: es `visible`, no `enabled` — `enabled` solo lo
 *       deshabilitaria dejandolo a la vista en gris.
 *
 * POR QUE viewState.onAfterStateApplied Y NO onPageReady
 * ------------------------------------------------------
 * sap.fe solo permite sobrescribir los metodos marcados publicExtension +
 * extensible. En el template de List Report, onPageReady es privateExtension y
 * el override se descarta EN SILENCIO; onAfterStateApplied si es publico. La
 * explicacion larga esta en el archivo homonimo de ui5-aprobaciones, que usa el
 * mismo enganche.
 *
 * POR QUE ADEMAS UN DELEGADO DE RENDERIZADO
 * -----------------------------------------
 * setShowDetailsButton() solo llega a tocar la toolbar cuando la tabla interna
 * ya existe (ResponsiveTableType.updateTableByProperty sale sin hacer nada si
 * getInnerTable() aun es null). Al aplicarse el estado de la vista eso no esta
 * garantizado, asi que la limpieza se reengancha al onAfterRendering de la
 * tabla. Es idempotente y barata: ambos setters descartan la llamada cuando el
 * valor no cambia.
 */
sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension"
], function (ControllerExtension) {
    "use strict";

    // Marca en la propia tabla para no acumular un delegado por cada pasada.
    var CLAVE_DELEGADO = "__reasignacionLimpiezaToolbar";

    /**
     * Apaga el grupo "Mostrar / Ocultar detalles" por la API del tipo de tabla.
     *
     * getType() devuelve la instancia de ResponsiveTableType cuando sap.fe arma
     * el tipo como control (el caso de esta app), pero puede devolver el nombre
     * del tipo como cadena si se configura en formato corto. Se comprueba antes
     * de llamar para que el barrido de respaldo tenga sentido.
     *
     * @returns {boolean} true si se pudo aplicar la API publica
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
     *
     * @returns {boolean} true si se pudo aplicar la API publica
     */
    function apagarBotonCopiar(oTabla) {
        var oCopyProvider = typeof oTabla.getCopyProvider === "function"
            ? oTabla.getCopyProvider()
            : null;

        if (!oCopyProvider || typeof oCopyProvider.setVisible !== "function") {
            // Sin CopyProvider no hay boton Copiar que ocultar: el objetivo ya
            // esta cumplido y no hace falta barrer nada.
            return true;
        }

        oCopyProvider.setVisible(false);
        return true;
    }

    /**
     * Respaldo para runtimes donde las APIs de arriba no esten disponibles
     * (la app se sirve con la version de UI5 del entorno, no con una fijada).
     *
     * Se identifica por icono y no por ID porque los identificadores de la
     * toolbar los arma sap.ui.mdc internamente y no son contrato publico; los
     * iconos, en cambio, son los que dan sentido al boton en pantalla.
     */
    function ocultarBotonDetallesPorIcono(oTabla) {
        oTabla.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.m.SegmentedButton");
        })
        .filter(function (oGrupo) {
            // El SegmentedButton no tiene icono propio: se reconoce por el de
            // sus items. Se oculta el grupo entero, no el item, para no dejar
            // medio control colgando en la toolbar.
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
     *
     * Se busca por tipo y no por ID: el identificador lo arma sap.fe
     * internamente (StableIdHelper sobre filterBarId) y no es contrato publico.
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
     *
     * Se busca por tipo y no por ID: el identificador lo arma sap.fe
     * internamente (StableIdHelper) y no forma parte de su contrato publico.
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
                // Override anidado sobre la sub-extension viewState del
                // controller. Dentro, "this" es la extension ViewState, no el
                // controller: la vista se alcanza por this.base.
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
