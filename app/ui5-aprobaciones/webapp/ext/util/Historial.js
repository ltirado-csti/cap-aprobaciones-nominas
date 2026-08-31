/**
 * Formatters y handlers del ProcessFlow "Historial de Aprobaciones".
 * La lógica de negocio (estados, topología del grafo, fechas, iniciales) se
 * resuelve en CAP (srv/domain/historial.service.js); aquí solo quedan
 * adaptaciones de tipo que OData V4 no permite del lado del servidor, y el
 * zoom del diagrama (estado de presentación puro).
 *
 * Se consume desde el fragmento vía core:require, no como formatter del
 * controller, para que el fragmento no dependa de la extensión de controller.
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * El ProcessFlow al que pertenece el botón pulsado. Se busca subiendo por
     * los padres y bajando por el subárbol de cada uno, en vez de por ID: el
     * prefijo que Fiori Elements antepone al ID declarado no es estable.
     *
     * @param {sap.ui.core.Control} oOrigen - control que disparó el evento
     * @returns {sap.suite.ui.commons.ProcessFlow|null}
     */
    function _diagrama(oOrigen) {
        var oNodo = oOrigen;
        while (oNodo) {
            var oEncontrado = _buscarEnSubarbol(oNodo);
            if (oEncontrado) {
                return oEncontrado;
            }
            oNodo = oNodo.getParent();
        }
        return null;
    }

    /** Primer ProcessFlow dentro de un control, él incluido. */
    function _buscarEnSubarbol(oControl) {
        if (!oControl || typeof oControl.isA !== "function") {
            return null;
        }
        if (oControl.isA("sap.suite.ui.commons.ProcessFlow")) {
            return oControl;
        }

        var aHijos = (oControl.getItems && oControl.getItems()) ||
                     (oControl.getContent && oControl.getContent()) || [];

        for (var i = 0; i < aHijos.length; i++) {
            var oEncontrado = _buscarEnSubarbol(aHijos[i]);
            if (oEncontrado) {
                return oEncontrado;
            }
        }
        return null;
    }

    /**
     * Apaga el botón de zoom que ya no puede hacer nada. Los niveles van de
     * "One" (máximo detalle) a "Four" (mínimo).
     *
     * @param {sap.ui.core.Control} oBarra - la Toolbar que contiene los botones
     * @param {string} sNivel - nivel de zoom resultante
     */
    function _sincronizarBotones(oBarra, sNivel) {
        var aBotones = (oBarra && oBarra.getContent && oBarra.getContent()) || [];

        for (var i = 0; i < aBotones.length; i++) {
            var oBoton = aBotones[i];
            if (!oBoton.isA || !oBoton.isA("sap.m.Button")) {
                continue;
            }
            if (oBoton.getId().indexOf("historialAcercar") !== -1) {
                oBoton.setEnabled(sNivel !== "One");
            }
            if (oBoton.getId().indexOf("historialAlejar") !== -1) {
                oBoton.setEnabled(sNivel !== "Four");
            }
        }
    }

    /** Aplica un método de zoom del control y refresca el estado de los botones. */
    function _aplicarZoom(oEvent, sMetodo) {
        var oBoton = oEvent.getSource();
        var oDiagrama = _diagrama(oBoton);

        if (!oDiagrama || typeof oDiagrama[sMetodo] !== "function") {
            return;
        }

        _sincronizarBotones(oBoton.getParent(), oDiagrama[sMetodo]());
    }

    return {
        /**
         * CSV de nodeIds → array, para ProcessFlowNode.children. CAP envía las
         * aristas como "N2-1,N2-2" porque ODataPropertyBinding de OData V4
         * solo admite valores primitivos.
         *
         * @param {string} sHijos - nodeIds separados por coma
         * @returns {string[]} siempre un array (vacío si es el último nivel)
         */
        aLista: function (sHijos) {
            if (!sHijos) {
                return [];
            }
            return String(sHijos).split(",").filter(Boolean);
        },

        /**
         * URL de foto → src del Avatar. Devuelve undefined cuando no hay foto,
         * para que caiga a las iniciales (o al fallbackIcon si tampoco hay
         * iniciales) en vez de intentar cargar una imagen inexistente.
         *
         * @param {string} sUrl
         * @returns {string|undefined}
         */
        foto: function (sUrl) {
            return sUrl ? sUrl : undefined;
        },

        /**
         * Acerca un nivel el diagrama (más detalle en cada tarjeta). Un
         * handler y no una propiedad enlazada: el control recalcula el zoom
         * desde su propio ancho en cada resize (_initZoomLevel), así que solo
         * zoomIn()/zoomOut() son la vía soportada.
         *
         * @param {sap.ui.base.Event} oEvent - press del botón
         */
        acercar: function (oEvent) {
            _aplicarZoom(oEvent, "zoomIn");
        },

        /**
         * Aleja un nivel el diagrama (caben más tarjetas, con menos detalle).
         * @param {sap.ui.base.Event} oEvent - press del botón
         */
        alejar: function (oEvent) {
            _aplicarZoom(oEvent, "zoomOut");
        }
    };
});
