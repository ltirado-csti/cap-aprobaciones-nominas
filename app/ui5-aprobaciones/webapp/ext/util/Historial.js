/**
 * app/ui5-aprobaciones/webapp/ext/util/Historial.js
 *
 * Formatters y handlers del ProcessFlow "Historial de Aprobaciones".
 *
 * Deliberadamente MÍNIMO: toda la lógica de negocio (estados, topología del
 * grafo, fechas, iniciales) se resuelve en CAP — srv/domain/historial.service.js.
 * Lo que queda aquí son dos adaptaciones de tipo que OData V4 no permite hacer
 * del lado del servidor, y el zoom del diagrama, que es estado de presentación
 * puro y vive en el control.
 *
 * Se consume desde el fragmento vía core:require, no como formatter del
 * controller: así el fragmento no depende de la extensión de controller.
 */
sap.ui.define([], function () {
    "use strict";

    /**
     * El ProcessFlow al que pertenece el botón pulsado.
     *
     * Se busca subiendo por los padres y bajando por el subárbol de cada uno, en
     * vez de resolverlo por ID. El motivo es que el fragmento se instancia dentro
     * de una sección personalizada de Fiori Elements, que antepone su propio
     * prefijo al ID declarado ("…::TareasInboxObjectPage--fe::CustomSubSection…
     * historialProcessFlow"). Ese prefijo no es estable ni está documentado, así
     * que buscarlo por relación de árbol es lo único que no se rompe si FE
     * cambia cómo compone los IDs.
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
     * Apaga el botón que ya no puede hacer nada.
     *
     * Los niveles del control van de "One" (máximo detalle) a "Four" (mínimo), y
     * zoomIn/zoomOut devuelven el nivel resultante. En los extremos las llamadas
     * no hacen nada, así que esto no evita ningún error: evita que el usuario
     * pulse un botón que no responde y crea que la pantalla se ha colgado.
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

        // Sin diagrama no hay nada que hacer y tampoco nada que romper: la barra
        // podría haberse renderizado sin el ProcessFlow si el modelo aún no ha
        // llegado. Se sale en silencio en vez de lanzar sobre un clic del usuario.
        if (!oDiagrama || typeof oDiagrama[sMetodo] !== "function") {
            return;
        }

        _sincronizarBotones(oBoton.getParent(), oDiagrama[sMetodo]());
    }

    return {
        /**
         * CSV de nodeIds → array, para ProcessFlowNode.children.
         *
         * CAP envía las aristas del grafo como "N2-1,N2-2" en vez de una
         * Collection(Edm.String) porque ODataPropertyBinding de OData V4 solo
         * admite valores primitivos: enlazar una propiedad de colección a una
         * propiedad de control lanza "Accessed value is not primitive".
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
         * URL de foto → src del Avatar.
         *
         * Devuelve undefined cuando no hay foto (hoy: siempre — el iFlow de ECP no
         * devuelve FotoUrl). Con src vacío el Avatar intentaría cargar una imagen
         * inexistente; con undefined cae limpiamente a las iniciales que calcula CAP.
         *
         * En los nodos que aún no tienen persona —un apoderado del pool antes de
         * firmar— CAP manda también las iniciales vacías a propósito, y el Avatar
         * cae un escalón más, al fallbackIcon: la tarjeta muestra el ícono
         * genérico en vez de atribuir el paso a nadie.
         *
         * @param {string} sUrl
         * @returns {string|undefined}
         */
        foto: function (sUrl) {
            return sUrl ? sUrl : undefined;
        },

        /**
         * Acerca un nivel el diagrama (más detalle en cada tarjeta).
         *
         * POR QUÉ UN HANDLER Y NO UNA PROPIEDAD ENLAZADA
         * ----------------------------------------------
         * El zoom del ProcessFlow no es estado de negocio ni se puede enlazar de
         * forma útil: el control lo recalcula desde su PROPIO ancho cada vez que
         * cambia de tamaño (_initZoomLevel), de modo que un valor enlazado se
         * pierde en el primer recálculo. Los métodos zoomIn()/zoomOut() son la
         * única vía soportada, y devuelven el nivel resultante.
         *
         * Efecto secundario que conviene conocer: al redimensionar el control
         * —abrir o cerrar una columna del FCL— el nivel vuelve a decidirse por
         * ancho y el zoom manual se descarta. Es del control, no de la app.
         *
         * @param {sap.ui.base.Event} oEvent - press del botón
         */
        acercar: function (oEvent) {
            _aplicarZoom(oEvent, "zoomIn");
        },

        /**
         * Aleja un nivel el diagrama (caben más tarjetas, con menos detalle).
         * Ver `acercar` para el porqué de hacerlo con un handler.
         *
         * @param {sap.ui.base.Event} oEvent - press del botón
         */
        alejar: function (oEvent) {
            _aplicarZoom(oEvent, "zoomOut");
        }
    };
});
