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
 * Tambien oculta el boton "Copiar" (sap-icon://copy) de la toolbar de la
 * tabla, que vuelca al portapapeles las filas seleccionadas. Igual que el
 * anterior, no es configurable desde tableSettings: la via soportada es
 * sap.m.plugins.CopyProvider#setVisible(false) — documentada en
 * sap.ui.mdc.Table como LA forma de ocultar ese boton (lo gobierna el plugin,
 * no el boton). Ojo: es `visible`, no `enabled` — `enabled` solo lo dejaria
 * deshabilitado a la vista, en gris. Ver el mismo ajuste en
 * ui5-reasignacion/ext/controller/ListaHandler.controller.js, de donde sale
 * esta funcion.
 *
 * Y da acabado a las dos acciones masivas de la toolbar ("Aprobar masivo" /
 * "Rechazar masivo"): boton Accept verde con icono de check y boton Reject rojo
 * con icono de aspa, para que no se lean como dos enlaces identicos uno al lado
 * del otro.
 *
 * Esto tampoco sale de la anotacion. En annotations.cds las dos acciones ya
 * llevan Criticality e IconUrl, pero sap.fe solo los traduce a tipo de boton en
 * las acciones Determining del footer del Object Page; las acciones de la
 * toolbar de una tabla las plantilla SIEMPRE como Transparent y sin icono (es
 * la toolbar de sap.ui.mdc.Table quien manda). De ahi que el tipo y el icono se
 * asignen aqui sobre el boton ya construido — la anotacion se mantiene igual
 * porque es la que declara la intencion y la que gobierna el footer.
 *
 * Los botones se localizan por su ID estable de sap.fe, que incorpora el nombre
 * de la accion ("...apoderadoAprobar"). Es el mismo identificador sobre el que
 * se apoyan las pruebas y la adaptacion de UI de Fiori Elements.
 *
 * El boton de configuracion (rueda dentada) de la tabla NO se toca aqui: ese si
 * es declarativo y se apaga con tableSettings.personalization = false en el
 * manifest.
 *
 * CARGA INICIAL AL VOLVER CON EL BOTON DEL NAVEGADOR
 * ---------------------------------------------------
 * Sintoma: al entrar desde el tile la tabla carga sola (initialLoad: true en el
 * manifest), pero al volver atras o refrescar solo se pide $metadata — ningun
 * $batch — y la tabla se queda con la ilustracion "Consigamos algunos
 * resultados" hasta que el usuario pulsa "Ir".
 *
 * El motivo esta en como sap.fe arranca la lista. La busqueda inicial no se
 * ejecuta directamente: se ENCOLA en la barra de filtros. En
 * sap.ui.mdc.filterbar.FilterBarBase:
 *
 *     triggerSearch()        → si suspendSelection esta activo, solo marca
 *                              _bSearchTriggered = true y resuelve
 *     setSuspendSelection(false) → si _bSearchTriggered, lanza la busqueda
 *
 * Y sap.fe suspende la barra mientras restaura el estado de la vista
 * (ListReport/overrides/ViewState.js → onBeforeStateApplied hace
 * setSuspendSelection(true)), para reanudarla al terminar. En el arranque en
 * frio la busqueda de initialLoad ya esta encolada cuando llega esa
 * reanudacion, asi que se dispara. Al restaurar un estado de aplicacion
 * (NavType iAppState/hybrid, que es lo que produce el boton atras y el F5 en
 * Work Zone) esa cola llega vacia: se reanuda una barra sin nada pendiente y no
 * sale ninguna peticion.
 *
 * El arreglo es encolar nosotros esa busqueda en onBeforeStateApplied, con la
 * barra ya suspendida por sap.fe. Es idempotente por construccion:
 * _bSearchTriggered es un booleano, asi que en el arranque en frio —donde ya
 * estaba a true— no cambia nada y sigue saliendo UNA sola peticion. Y como se
 * encola en vez de ejecutarse, la busqueda ocurre despues de aplicar los
 * filtros restaurados, nunca antes.
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
        { clave: "apoderadoAprobar",  tipo: ButtonType.Accept, icono: "sap-icon://accept" },
        { clave: "apoderadoRechazar", tipo: ButtonType.Reject, icono: "sap-icon://decline" }
    ];

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

    /**
     * Apaga el boton "Copiar" de una tabla a traves del plugin que lo genera.
     */
    function apagarBotonCopiar(oTabla) {
        var oCopyProvider = typeof oTabla.getCopyProvider === "function"
            ? oTabla.getCopyProvider()
            : null;

        if (!oCopyProvider || typeof oCopyProvider.setVisible !== "function") {
            // Sin CopyProvider no hay boton Copiar que ocultar: el objetivo ya
            // esta cumplido y no hace falta barrer nada.
            return;
        }

        oCopyProvider.setVisible(false);
    }

    /**
     * Aplica los ajustes de toolbar a todas las tablas MDC de la vista —apagar
     * "Copiar" y dar acabado a las acciones masivas— y los deja enganchados a su
     * renderizado, para que sobrevivan a los rebind de la tabla (el CopyProvider
     * puede recrearse en ese momento).
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
     * Encola la busqueda inicial en la barra de filtros mientras sap.fe la tiene
     * suspendida, para que la tabla tambien cargue sola al restaurar el estado
     * de la vista (boton atras / refresco). Ver cabecera del modulo.
     */
    function asegurarBusquedaInicial(oVista) {
        if (!oVista) {
            return;
        }

        oVista.findAggregatedObjects(true, function (oControl) {
            return oControl.isA("sap.ui.mdc.FilterBar");
        })
        .forEach(function (oFilterBar) {
            // La guarda es la que hace segura la llamada: solo encolamos. Si la
            // barra NO estuviera suspendida, triggerSearch() lanzaria una
            // busqueda de verdad aqui mismo —antes de aplicar los filtros
            // restaurados— y esa peticion sobraria. En ese caso preferimos no
            // hacer nada y dejar el comportamiento como estaba.
            if (typeof oFilterBar.getSuspendSelection !== "function" ||
                !oFilterBar.getSuspendSelection()) {
                return;
            }

            oFilterBar.triggerSearch();
        });
    }

    /**
     * Pone tipo Accept/Reject e icono a las acciones masivas de la toolbar.
     *
     * Reasignar las mismas propiedades en cada render no cuesta nada: setProperty
     * de UI5 descarta la asignacion cuando el valor no cambia, asi que solo hay
     * invalidacion la primera vez o si sap.fe volviera a construir el boton.
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

    /**
     * Ejecuta un ajuste sin dejar que su fallo contamine el ciclo de arranque de
     * sap.fe. Los hooks de viewState se invocan dentro de un collectResults que
     * ya captura y registra las excepciones, asi que esto no evita una pantalla
     * rota: lo que aporta es que el error salga con el nombre de ESTE fichero y
     * que un ajuste no impida los siguientes.
     */
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
                // Override anidado sobre la sub-extension viewState del
                // controller. Dentro, "this" es la extension ViewState, no el
                // controller: la vista se alcanza por this.base.
                viewState: {
                    // Se ejecuta DESPUES del override de la plantilla, que es
                    // quien acaba de suspender la barra de filtros. Ese orden es
                    // justo el que necesitamos para encolar la busqueda.
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
