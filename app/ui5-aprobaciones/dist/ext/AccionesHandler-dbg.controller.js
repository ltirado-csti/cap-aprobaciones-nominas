sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/m/MessageBox",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/TextArea",
  "sap/m/VBox",
  "sap/m/Label"
], function (ControllerExtension, MessageBox, Dialog, Button, TextArea, VBox, Label) {
  "use strict";

  /**
   * AccionesHandler.controller.js
   * Extensión de controller para la Object Page de TareasInbox.
   * Archivo: webapp/ext/AccionesHandler.controller.js
   *
   * Patrón oficial SAP Fiori Elements V4:
   *   - Registrado en manifest.json → sap.ui5.extends.extensions.sap.ui.controllerExtensions
   *   - Los métodos se declaran directamente en el objeto (NO dentro de override)
   *   - El press en content.header.actions usa: .extension.{controllerName}.{metodo}
   */
  return ControllerExtension.extend(
    "centria.h2hpp.aprobaciones.ui5aprobaciones.ext.AccionesHandler",
    {
      // ─── Helpers privados ───────────────────────────────────────────

      /**
       * Obtiene los datos del contexto OData actual de la Object Page.
       * @returns {object} Datos de la propuesta del binding activo
       */
      _getPropuesta: function () {
        const oContext = this.base.getView().getBindingContext();
        return oContext ? oContext.getObject() : {};
      },

      /**
       * Obtiene el modelo OData v4 de la vista.
       * @returns {sap.ui.model.odata.v4.ODataModel}
       */
      _getModel: function () {
        return this.base.getView().getModel();
      },

      /**
       * Construye el payload base con propuesta y usuario para todas las acciones.
       * @returns {object} Payload base
       */
      _buildPayload: function () {
        const oPropuesta = this._getPropuesta();
        return {
          propuesta: oPropuesta,
          usuario  : { nombre: sap.ushell?.Container?.getUser?.()?.getEmail?.() ?? "usuario@local" },
          taskId   : oPropuesta.instanceID
        };
      },

      /**
       * Invoca una unbound action de CAP con los parámetros dados.
       * Refresca el binding de la Object Page al completar.
       * @param {string} nombreAccion - Nombre de la acción en PagosService
       * @param {object} payload      - Parámetros de la acción
       */
      _ejecutar: function (nombreAccion, payload) {
        const oAction = this._getModel().bindContext(`/PagosService.${nombreAccion}(...)`);
        Object.entries(payload).forEach(([k, v]) => oAction.setParameter(k, v));

        oAction.execute()
          .then(() => {
            const oRpta = oAction.getBoundContext()?.getObject();
            if (oRpta?.exitoso === false) {
              MessageBox.error(oRpta.mensaje ?? "La acción no pudo completarse.");
            } else {
              MessageBox.success(
                oRpta?.mensaje ?? "Acción ejecutada correctamente.",
                { onClose: () => this.base.getView().getBindingContext().refresh() }
              );
            }
          })
          .catch((oError) => {
            MessageBox.error(`Error: ${oError?.message ?? oError}`);
          });
      },

      /**
       * Abre un Dialog con TextArea para el comentario obligatorio.
       * Al confirmar ejecuta la acción con el comentario incluido.
       * @param {string} titulo       - Título del dialog
       * @param {string} nombreAccion - Acción a ejecutar
       * @param {object} payloadBase  - Payload sin comentario
       */
      _abrirDialogComentario: function (titulo, nombreAccion, payloadBase) {
        const oTextArea = new TextArea({ width: "100%", rows: 4, placeholder: "Ingrese su observación..." });

        const oDialog = new Dialog({
          title      : titulo,
          contentWidth: "400px",
          content    : new VBox({ items: [new Label({ text: "Observación", required: true }), oTextArea] })
                         .addStyleClass("sapUiSmallMargin"),
          beginButton: new Button({
            type : "Emphasized",
            text : "Confirmar",
            press: () => {
              const sComentario = oTextArea.getValue().trim();
              if (!sComentario) {
                oTextArea.setValueState("Error");
                oTextArea.setValueStateText("La observación es obligatoria");
                return;
              }
              oDialog.close();
              this._ejecutar(nombreAccion, { ...payloadBase, comentario: sComentario });
            }
          }),
          endButton  : new Button({ text: "Cancelar", press: () => oDialog.close() }),
          afterClose : () => oDialog.destroy()
        });

        this.base.getView().addDependent(oDialog);
        oDialog.open();
      },

      // ─── ANALISTA TESORERÍA ─────────────────────────────────────────

      /** Botón: Enviar Supervisor/Caja — Origen: AnalistaTesoreria.js */
      onEnviarSupervisorOCaja: function () {
        MessageBox.confirm("¿Desea enviar la propuesta al Supervisor o Caja?", {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("enviarSupervisorOCaja", this._buildPayload())
        });
      },

      /** Botón: Compensar — Origen: AnalistaTesoreria.js */
      onCompensar: function () {
        MessageBox.confirm("¿Desea compensar la propuesta?", {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("compensar", this._buildPayload())
        });
      },

      /** Botón: Cerrar por Observación — abre dialog con comentario obligatorio */
      onCerrarPorObservacion: function () {
        this._abrirDialogComentario("Cerrar por Observación", "cerrarPorObservacion", this._buildPayload());
      },

      /** Botón: Eliminar Documento — Origen: AnalistaTesoreria.js */
      onEliminarDoc: function () {
        MessageBox.confirm("¿Desea eliminar el documento generado?", {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("eliminarDoc", this._buildPayload())
        });
      },

      // ─── SUPERVISOR ────────────────────────────────────────────────

      /** Botón: Aprobar PP — Origen: Supervisor.js */
      onSupervisorAprobar: function () {
        MessageBox.confirm("¿Desea aprobar la propuesta?", {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("supervisorAprobar", this._buildPayload())
        });
      },

      /** Botón: Terminar Flujo — visible solo cuando puedeTerminarFlujo = true */
      onSupervisorTerminarFlujo: function () {
        MessageBox.confirm("¿Desea terminar el flujo? Esta acción cancela la instancia BPA.", {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("supervisorTerminarFlujo", this._buildPayload())
        });
      },

      /** Botón: Observar — abre dialog con comentario obligatorio */
      onSupervisorObservar: function () {
        this._abrirDialogComentario("Observar Propuesta", "supervisorObservar", this._buildPayload());
      },

      /** Botón: Anular — visible solo cuando puedeAnular = true */
      onSupervisorAnular: function () {
        this._abrirDialogComentario("Anular Propuesta", "supervisorAnular", this._buildPayload());
      },

      // ─── REVISOR ───────────────────────────────────────────────────

      /** Botón: Aprobar PP — Origen: Revisor.js */
      onRevisorAprobar: function () {
        MessageBox.confirm("¿Desea aprobar la propuesta en etapa de revisión?", {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("revisorAprobar", this._buildPayload())
        });
      },

      /** Botón: Observar — abre dialog con comentario obligatorio */
      onRevisorObservar: function () {
        this._abrirDialogComentario("Observar en Revisión", "revisorObservar", this._buildPayload());
      },

      // ─── APODERADO ─────────────────────────────────────────────────

      /** Botón: Firmar (F1/F2 según contadorFirma) — Origen: Apoderado.js */
      onApoderadoFirmar: function () {
        const nFirma = this._getPropuesta().contadorFirma ?? 0;
        const sTipo  = nFirma === 0 ? "Primera Firma (F1)" : "Segunda Firma (F2)";
        MessageBox.confirm(`¿Desea firmar la propuesta? ${sTipo}`, {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("apoderadoFirmar", this._buildPayload())
        });
      },

      /** Botón: Observar Apoderado — abre dialog con comentario obligatorio */
      onApoderadoObservar: function () {
        this._abrirDialogComentario("Observar en Firma", "apoderadoObservar", this._buildPayload());
      },

      /** Botón: Redirigir — el comentario contiene el email del nuevo apoderado */
      onRedirigirApoderado: function () {
        this._abrirDialogComentario("Redirigir Apoderado", "redirigirApoderado", this._buildPayload());
      },

      // ─── CAJA ──────────────────────────────────────────────────────

      /** Botón: Confirmar Pago — Origen: Caja.js */
      onCajaConfirmarPago: function () {
        MessageBox.confirm("¿Desea confirmar el pago? Esta acción cierra el flujo.", {
          onClose: (a) => a === MessageBox.Action.OK && this._ejecutar("cajaConfirmarPago", this._buildPayload())
        });
      },

      /** Botón: Observar Caja — abre dialog con comentario obligatorio */
      onCajaObservar: function () {
        this._abrirDialogComentario("Observar en Caja", "cajaObservar", this._buildPayload());
      }
    }
  );
});