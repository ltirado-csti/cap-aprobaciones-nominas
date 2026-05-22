"use strict";
/**
 * infrastructure/sap-gateway-client.js
 *
 * Acceso a SAP Gateway (ABAP stack) vía dos servicios OData:
 *
 *  1. ZFISO_PORTAL_H2H_SRV  →  SAP_GATEWAY_DEST
 *     Modelo UI5 original: SAP_GATEWAY  (oSAPModel en PPOData.js)
 *     Entidades:
 *       /ApoderadosSet      → obtenerUsuariosSAP()
 *       /AdelantoSet        → checkAdelanto()
 *       /CheckPerfilSet     → checkPerfilSAP()
 *       /ContarFirmasSet    → contarFirmasSAP()
 *       /WfObtenerPDFH2HSet → getPropuestaPDFSAP()
 *       /InfoPropuestaSet   → getInfoPropuestaSAP()
 *
 *  2. ZFISO_CORREO_ONB_H2H_SRV  →  SAP_CORREO_DEST
 *     Modelo UI5 original: oModelEnviarCorreo  (oCorreoModel en PPOData.js)
 *     Entidades:
 *       /EnviarCorreo_Aprobado → enviarCorreoAprobadores()
 *
 * NOTA: Estas llamadas NO van por CPI. Van directo a SAP ERP vía Gateway.
 */

const cds = require("@sap/cds");
const LOG = cds.log("sap-gateway-client");

let _portalSvc, _correoSvc;

const getPortalSvc = async () => (_portalSvc ??= await cds.connect.to("SAP_GATEWAY"));
const getCorreoSvc = async () => (_correoSvc ??= await cds.connect.to("SAP_CORREO"));

const toArray = (res) => (Array.isArray(res) ? res : (res?.results ?? []));

// ─── USUARIOS SAP ─────────────────────────────────────────────────────────────

/**
 * PPOData.obtenerUsuariosSAP(rol, sociedad, usuario?)
 * GET /ApoderadosSet?$filter=Rol eq '...' and Bukrs eq '...' [and Usuario eq '...']
 *
 * Retorna:
 *   sUsuarios : string CSV con los usuarios destino  "usr1@mail,usr2@mail"
 *   sUserSAP  : usuario SAP del firmante actual (para oApoReg)
 *
 * Usado por: Supervisor, Revisor, Apoderado, AnalistaTesorería
 */
async function obtenerUsuariosSAP(rol, sociedad, usuario = "") {
  const svc = await getPortalSvc();
  const filters = [`Rol eq '${rol}'`, `Bukrs eq '${sociedad}'`];
  if (usuario) filters.push(`Usuario eq '${usuario}'`);

  const res  = await svc.get("/ApoderadosSet", { params: { $filter: filters.join(" and ") } });
  const rows = toArray(res);

  if (!rows.length) {
    LOG.warn(`obtenerUsuariosSAP: sin resultados | rol=${rol} sociedad=${sociedad}`);
    return null;
  }

  LOG.info(`obtenerUsuariosSAP OK | rol=${rol} sociedad=${sociedad}`);
  return {
    sUsuarios: rows[0].Usuarios   ?? "",
    sUserSAP : rows[0].UsuarioSAP ?? "",
  };
}

// ─── VALIDACIONES ─────────────────────────────────────────────────────────────

/**
 * PPOData.checkAdelanto(oPropuestaPago)
 * GET /AdelantoSet?$filter=NroPP eq '...' and Sociedad eq '...'
 *
 * Retorna: { IndAdelanto: "X" | "" }
 * Usado por: AnalistaTesorería (bloquea si hay adelanto sin adjunto)
 */
async function checkAdelanto(pp) {
  const svc  = await getPortalSvc();
  const res  = await svc.get("/AdelantoSet", {
    params: { $filter: `NroPP eq '${pp.NroPP}' and Sociedad eq '${pp.Sociedad}'` },
  });
  const rows = toArray(res);
  LOG.info(`checkAdelanto OK | NroPP=${pp.NroPP} IndAdelanto=${rows[0]?.IndAdelanto}`);
  return rows[0] ?? { IndAdelanto: "" };
}

/**
 * PPOData.checkPerfilSAP(oPropuestaPago, pProfil)
 * GET /CheckPerfilSet(Zbukr='...',Uname='...',Profil='...')
 *
 * Clave compuesta SAP: Zbukr + Uname (en MAYÚSCULAS) + Profil
 * Retorna: { Existe: "X" | "" }
 * Usado por: Supervisor (CAR — verifica si el iniciador es tesorero)
 */
async function checkPerfilSAP(pp, perfil) {
  const svc = await getPortalSvc();
  const uname = (pp.Analista ?? "").toUpperCase();

  try {
    const res = await svc.get(
      `/CheckPerfilSet(Zbukr='${pp.Sociedad}',Uname='${uname}',Profil='${perfil}')`
    );
    LOG.info(`checkPerfilSAP OK | perfil=${perfil} Existe=${res?.Existe}`);
    return res ?? { Existe: "" };
  } catch (err) {
    if (err.statusCode === 404 || String(err.code) === "404") {
      LOG.info(`checkPerfilSAP: perfil no existe | perfil=${perfil}`);
      return { Existe: "" };
    }
    throw err;
  }
}

/**
 * PPOData.contarFirmasSAP(oPropuestaPago)
 * GET /ContarFirmasSet(Versn='...',Laufi='...',Laufd=datetime'...',Bukrs='...',Tipos='...')
 *
 * CLAVE EXACTA SAP (verificada en código): Versn, Laufi, Laufd, Bukrs, Tipos
 *   Laufi  = NroPP
 *   Laufd  = FechaPPJS  (objeto Date JavaScript)
 *   Tipos  = ModalidadPP
 *
 * Retorna: { Firmas: number }
 * Usado por: Apoderado (determina F1 vs F2)
 */
async function contarFirmasSAP(pp) {
  const svc = await getPortalSvc();

  // Formatear fecha como SAP Gateway espera: datetime'2026-05-20T00:00:00'
  const fechaJS = pp.FechaPPJS instanceof Date
    ? pp.FechaPPJS
    : _parseFechaPP(pp.FechaPP); // fallback: parsear "dd-MM-yyyy"

  const sPath = `/ContarFirmasSet(`
    + `Versn='${pp.Version}'`
    + `,Laufi='${pp.NroPP}'`
    + `,Laufd=datetime'${fechaJS.toISOString().split("T")[0]}T00:00:00'`
    + `,Bukrs='${pp.Sociedad}'`
    + `,Tipos='${pp.ModalidadPP}'`
    + `)`;

  const res = await svc.get(sPath);
  const firmas = Number(res?.Firmas ?? 0);
  LOG.info(`contarFirmasSAP OK | NroPP=${pp.NroPP} Firmas=${firmas}`);
  return { Firmas: firmas };
}

// ─── PDF Y CÓDIGOS DE BARRA ───────────────────────────────────────────────────

/**
 * PPOData.getPropuestaPDFSAP(oPropuestaPago)
 * GET /WfObtenerPDFH2HSet?$filter=Bukrs eq '...' and Laufi eq '...' and Laufd eq datetime'...'
 *
 * Retorna: { results: [{ Docum: "<base64 PDF>" }] }
 * Usado por: Detail → showPDF()
 */
async function getPropuestaPDFSAP(pp) {
  const svc    = await getPortalSvc();
  const fechaJS = pp.FechaPPJS instanceof Date ? pp.FechaPPJS : _parseFechaPP(pp.FechaPP);

  const res = await svc.get("/WfObtenerPDFH2HSet", {
    params: {
      $filter: [
        `Bukrs eq '${pp.Sociedad}'`,
        `Laufi eq '${pp.NroPP}'`,
        `Laufd eq datetime'${fechaJS.toISOString().split("T")[0]}T00:00:00'`,
      ].join(" and "),
    },
  });
  LOG.info(`getPropuestaPDFSAP OK | NroPP=${pp.NroPP}`);
  return res;
}

/**
 * PPOData.getInfoPropuestaSAP(oPropuestaPago) → /InfoPropuestaSet
 * Retorna códigos de barra, proveedores, IndAdelanto por propuesta.
 * Usado por: Detail → definirAdjuntos() / aInfoPropuesta.results[0].Adelanto
 */
async function getInfoPropuestaSAP(pp) {
  const svc    = await getPortalSvc();
  const fechaJS = pp.FechaPPJS instanceof Date ? pp.FechaPPJS : _parseFechaPP(pp.FechaPP);

  const res = await svc.get("/InfoPropuestaSet", {
    params: {
      $filter: [
        `Bukrs eq '${pp.Sociedad}'`,
        `Laufi eq '${pp.NroPP}'`,
        `Laufd eq datetime'${fechaJS.toISOString().split("T")[0]}T00:00:00'`,
      ].join(" and "),
    },
  });
  LOG.info(`getInfoPropuestaSAP OK | NroPP=${pp.NroPP}`);
  return res;
}

// ─── CORREO ───────────────────────────────────────────────────────────────────

/**
 * PPOData.enviarCorreoAprobadores(oPropuestaPago, sProfil, sUsuario)
 *
 * Servicio: ZFISO_CORREO_ONB_H2H_SRV
 * Entidad : /EnviarCorreo_Aprobado  (es un GET con filtros, no un POST)
 *
 * Clave / filtros según metadata.xml:
 *   Bukrs   = Sociedad
 *   Laufi   = NroPP
 *   Laufd   = FechaPPJS  (datetime)
 *   Versn   = Version
 *   Profil  = "AP" | "RV" | "TR"
 *   Usuario = email del tesorero (solo para Profil="TR")
 *
 * Fire-and-forget: no bloquea el flujo de aprobación si falla.
 */
async function enviarCorreoAprobadores(pp, profil, usuario) {
  try {
    const svc    = await getCorreoSvc();
    const fechaJS = pp.FechaPPJS instanceof Date ? pp.FechaPPJS : _parseFechaPP(pp.FechaPP);

    const filters = [
      `Bukrs  eq '${pp.Sociedad}'`,
      `Laufi  eq '${pp.NroPP}'`,
      `Laufd  eq datetime'${fechaJS.toISOString().split("T")[0]}T00:00:00'`,
      `Versn  eq '${pp.Version}'`,
      `Profil eq '${profil}'`,
    ];
    if (usuario) filters.push(`Usuario eq '${usuario}'`);

    await svc.get("/EnviarCorreo_Aprobado", { params: { $filter: filters.join(" and ") } });
    LOG.info(`enviarCorreoAprobadores OK | NroPP=${pp.NroPP} profil=${profil}`);
  } catch (err) {
    // No relanzar: el correo es informativo, nunca bloquea el flujo
    LOG.error(`enviarCorreoAprobadores ERROR (non-blocking) | profil=${profil}`, err.message);
  }
}

// ─── UTILS INTERNAS ───────────────────────────────────────────────────────────

/**
 * Parsea "dd-MM-yyyy" (formato del contexto BPA) a objeto Date.
 * Usado cuando FechaPPJS no está disponible.
 */
function _parseFechaPP(sFechaPP) {
  if (!sFechaPP) return new Date();
  const [d, m, y] = sFechaPP.split("-");
  return new Date(`${y}-${m}-${d}T00:00:00`);
}

module.exports = {
  obtenerUsuariosSAP,
  checkAdelanto,
  checkPerfilSAP,
  contarFirmasSAP,
  getPropuestaPDFSAP,
  getInfoPropuestaSAP,
  enviarCorreoAprobadores,
};
