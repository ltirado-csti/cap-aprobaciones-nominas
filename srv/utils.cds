// ─────────────────────────────────────────────────────────────────
// srv/utils.cds
//
// Servicio de utilitarios técnicos del proyecto H2H Aprobaciones.
// Complementa al PagosService con capacidades de exportación.
//
// Fuentes de datos reales (verificadas en código fuente):
//
//   PDF de propuesta  → CPI (iFlow pendiente de publicar) → base64 directo
//                       Toda la comunicación con SAP pasa por Cloud Integration;
//                       la app UI5 anterior sí llamaba a /WfObtenerPDFH2HSet de
//                       Gateway, pero ese canal directo NO se usa en este
//                       proyecto. El visor vive en PagosService.PropuestaPDF
//                       (entidad media), no aquí.
//
//   PDF de aprobaciones → se construye server-side con pdfkit
//                         usando datos de HANA /PropuestaPagoAprobadores
//
//   Excel de propuestas → se construye server-side con exceljs
//                         usando datos de HANA /PropuestaPago
//
//   Excel de aprobadores → se construye con datos de HANA /PropuestaPagoAprobadores
//
//   Correo → SAP Gateway ZFISO_CORREO_ONB_H2H_SRV /EnviarCorreo_Aprobado
//             (ya manejado internamente por aprobacion.service.js)
//             Esta función queda como fachada explícita si el UI5
//             necesita dispararlo manualmente.
// ─────────────────────────────────────────────────────────────────

@path: '/nomina/utils'
service UtilsService {

  // ── Tipos ─────────────────────────────────────────────────────

  type FileResult {
    base64   : LargeString;   // contenido del archivo en base64
    filename : String;
    mimeType : String;
  }

  type CorreoResult {
    success : Boolean;
    mensaje : String;
  }

  // ── PDF ───────────────────────────────────────────────────────

  @Common.Label: 'Obtener PDF de propuesta desde SAP (vía CPI)'
  function obtenerPDFPropuesta(
    NroPP    : String,
    Sociedad : String,
    FechaPP  : String,   // "dd-MM-yyyy"
    Banco    : String    // para nombre de archivo
  ) returns FileResult;

  @Common.Label: 'Generar PDF de historial de aprobaciones'
  function generarPDFAprobaciones(
    NroPP    : String,
    Sociedad : String,
    FechaPP  : String
  ) returns FileResult;

  // ── EXCEL ─────────────────────────────────────────────────────

  @Common.Label: 'Exportar propuestas de pago a Excel'
  function exportarExcelPropuestas(
    Sociedad   : String,
    FechaDesde : String,   // "dd-MM-yyyy"
    FechaHasta : String,
    EstadoPP   : String    // "" para todos los estados
  ) returns FileResult;

  @Common.Label: 'Exportar historial de aprobaciones a Excel'
  function exportarExcelAprobaciones(
    NroPP    : String,
    Sociedad : String,
    FechaPP  : String
  ) returns FileResult;

  // ── CORREO (fachada explícita) ────────────────────────────────
  // El correo normalmente se dispara automáticamente desde aprobacion.service.js.
  // Esta acción permite dispararlo manualmente desde UI5 si es necesario.

  @Common.Label: 'Enviar correo a aprobador del siguiente paso'
  action enviarCorreo(
    NroPP    : String,
    Sociedad : String,
    FechaPP  : String,
    Version  : String,
    Profil   : String,   // "AP"|"RV"|"TR"
    Usuario  : String    // email del tesorero (solo para Profil="TR")
  ) returns CorreoResult;
}
