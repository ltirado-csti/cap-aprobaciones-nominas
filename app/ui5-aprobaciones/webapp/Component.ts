import BaseComponent from "sap/fe/core/AppComponent";
import Formatting from "sap/base/i18n/Formatting";
import Localization from "sap/base/i18n/Localization";

/**
 * @namespace centria.h2hpp.aprobaciones.ui5aprobaciones
 */
export default class Component extends BaseComponent {

	public static metadata = {
		manifest: "json"
	};

	/**
	 * UI5 llama a init() una sola vez, al arrancar la app.
	 * Fija el patrón de fecha (dd/MM/yyyy en los estilos short/medium) para las
	 * propiedades Edm.Date que pinta el cliente, y el huso horario a Lima para
	 * que toda fecha-hora se lea en hora de Perú, igual que la que formatea CAP.
	 */
	public init(): void {
		super.init();

		Formatting.setDatePattern("short", "dd/MM/yyyy");
		Formatting.setDatePattern("medium", "dd/MM/yyyy");

		Localization.setTimezone("America/Lima");
	}
}
