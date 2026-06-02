sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"centria/h2hpp/aprobaciones/ui5aprobaciones/test/integration/pages/TareasInboxList",
	"centria/h2hpp/aprobaciones/ui5aprobaciones/test/integration/pages/TareasInboxObjectPage"
], function (JourneyRunner, TareasInboxList, TareasInboxObjectPage) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('centria/h2hpp/aprobaciones/ui5aprobaciones') + '/test/flp.html#app-preview',
        pages: {
			onTheTareasInboxList: TareasInboxList,
			onTheTareasInboxObjectPage: TareasInboxObjectPage
        },
        async: true
    });

    return runner;
});

