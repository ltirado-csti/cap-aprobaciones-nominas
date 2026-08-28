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
	 *
	 * FORMATO DE FECHA Y HUSO HORARIO
	 * -------------------------------
	 * Las fechas que CAP entrega ya formateadas (el fechaTexto del historial,
	 * "20/08/2026 10:15") no dependen de esto. Sí dependen las que viajan como
	 * Edm.Date y pinta el cliente —Fecha PP y Fecha Pago de la lista y del
	 * Object Page—: sap.ui.model.odata.type.Date las formatea con el estilo
	 * "medium" del idioma del usuario, que en español da "13 ago 2026". No hay
	 * forma de fijarles un patrón desde la anotación ni desde el manifest, y
	 * cambiarlas a String en el servicio costaría el DatePicker del filtro (ver
	 * el comentario de fechaPropuestaPago en srv/pagos-service.cds).
	 *
	 * La vía soportada es esta: fijar el patrón de la app, que es lo que hace
	 * Formatting.setDatePattern. Se fijan los dos estilos NUMÉRICOS —"short" y
	 * "medium"—; "long" y "full" se dejan como están porque son los verbosos
	 * ("13 de agosto de 2026") y nadie los usa aquí.
	 *
	 * El huso horario se fija por el mismo motivo: el navegador del usuario no
	 * tiene por qué estar en Lima, y cualquier fecha-hora que se pinte en
	 * cliente debe leerse en hora de Perú, igual que las que ya formatea CAP.
	 * La documentación de UI5 pide hacerlo lo antes posible en el arranque —una
	 * app ya corriendo puede quedar con fechas de dos husos—, y este es ese
	 * punto.
	 */
	public init(): void {
		super.init();

		Formatting.setDatePattern("short", "dd/MM/yyyy");
		Formatting.setDatePattern("medium", "dd/MM/yyyy");

		Localization.setTimezone("America/Lima");
	}
}
