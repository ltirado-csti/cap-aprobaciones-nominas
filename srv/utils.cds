// Servicio de utilitarios técnicos: exportación de PDF/Excel y envío de
// correo. Complementa al PagosService.

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

  // ── CORREO ────────────────────────────────────────────────────

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
