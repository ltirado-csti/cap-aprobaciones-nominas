/**
 * app/ui5-aprobaciones/webapp/ext/util/Historial.js
 *
 * Formatters del ProcessFlow "Historial de Aprobaciones".
 *
 * Deliberadamente MÍNIMO: toda la lógica de negocio (estados, topología del
 * grafo, fechas, iniciales) se resuelve en CAP — srv/domain/historial.service.js.
 * Lo único que queda aquí son dos adaptaciones de tipo que OData V4 no permite
 * hacer del lado del servidor.
 *
 * Se consume desde el fragmento vía core:require, no como formatter del
 * controller: así el fragmento no depende de la extensión de controller.
 */
sap.ui.define([], function () {
    "use strict";

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
        }
    };
});
