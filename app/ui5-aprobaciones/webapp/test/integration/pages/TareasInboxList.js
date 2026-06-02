sap.ui.define(['sap/fe/test/ListReport'], function(ListReport) {
    'use strict';

    var CustomPageDefinitions = {
        actions: {},
        assertions: {}
    };

    return new ListReport(
        {
            appId: 'centria.h2hpp.aprobaciones.ui5aprobaciones',
            componentId: 'TareasInboxList',
            contextPath: '/TareasInbox'
        },
        CustomPageDefinitions
    );
});