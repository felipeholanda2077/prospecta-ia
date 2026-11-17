import { config } from "../config.js";
import * as db from "../db.js";
import { corDaLogo } from "./marcaDaPrevia.js";

// O que deixa a prévia com a cara da empresa, tirado do próprio perfil dela no Google (Places API): as fotos que ela
// mesma publicou (o espaço, a fachada com a logo, os trabalhos), as melhores avaliações e o horário. Busca uma vez
// por empresa e guarda (fotos no banco, em `midias`), para a página abrir rápido e não gastar a API a cada visita.
// Mais: `previa_extra:<id>` (gravado pelo painel) troca serviços, frase e descrição quando sabemos mais da empresa.

const TEMPO_MS = 12_000;
const MAX_FOTOS = 8;
const DIAS_GUARDADO = 30;
const chaveDosDados = (leadId) => `previa_dados:${leadId}`;
export const chaveDaFoto = (leadId, n) => `previa:${leadId}:${n}`;

// Id do Google Places (as empresas do Maps); as de outras fontes têm prefixo (cnpj:, ad:, gads:, ig:...).
const idDoGoogle = (lead) => (/^[A-Za-z0-9_-]{20,}$/.test(String(lead?.place_id ?? "")) ? lead.place_id : null);

async function chamar(caminho, { campos = null, binario = false } = {}) {
  const r = await fetch(`https://places.googleapis.com/v1/${caminho}`, {
    headers: { "X-Goog-Api-Key": config.googlePlacesApiKey, ...(campos ? { "X-Goog-FieldMask": campos } : {}) },
    signal: AbortSignal.timeout(TEMPO_MS),
  });
  if (!r.ok) throw new Error(`o Google respondeu ${r.status}`);
  return binario ? { tipo: r.headers.get("content-type") || "image/jpeg", dados: Buffer.from(await r.arrayBuffer()) } : r.json();
}

const primeiroNome = (nome) => {
  const partes = String(nome ?? "").trim().split(/\s+/).filter(Boolean);
  return partes.length > 1 ? `${partes[0]} ${partes.at(-1)[0]}.` : partes[0] ?? "";
};

/** Busca no Google e guarda: fotos (no banco), as 3 melhores avaliações com texto e o horário. */
async function buscarNoGoogle(lead, { idioma = "pt" } = {}) {
  const id = idDoGoogle(lead);
  if (!id || !config.googlePlacesApiKey) return { fotos: 0, avaliacoes: [], horario: [] };
  const p = await chamar(`places/${encodeURIComponent(id)}?languageCode=${idioma}`, { campos: "photos,reviews,regularOpeningHours,editorialSummary" });
  let fotos = 0;
  for (const f of (p.photos ?? []).slice(0, MAX_FOTOS)) {
    try {
      const img = await chamar(`${f.name}/media?maxWidthPx=1400`, { binario: true });
      if (!/^image\//.test(img.tipo) || img.dados.length < 2000) continue;
      await db.gravarMidia(chaveDaFoto(lead.id, fotos), img.tipo, img.dados);
      fotos++;
    } catch {
      // uma foto que falha não impede as outras
    }
  }
  const avaliacoes = (p.reviews ?? [])
    .filter((r) => r.rating >= 5 && String(r.text?.text ?? r.originalText?.text ?? "").trim().length >= 40)
    .slice(0, 3)
    .map((r) => ({ nome: primeiroNome(r.authorAttribution?.displayName), texto: String(r.text?.text ?? r.originalText?.text).trim().slice(0, 320) }));
  const horario = (p.regularOpeningHours?.weekdayDescriptions ?? []).slice(0, 7);
  return { fotos, avaliacoes, horario, resumo: p.editorialSummary?.text ?? "" };
}

/**
 * Os dados da prévia desta empresa (fotos guardadas, avaliações, horário e o que o painel acrescentou). Na primeira
 * vez (ou depois de 30 dias) busca no Google; se o Google falhar, a prévia abre com o que tiver (sem quebrar).
 */
export async function dadosDaPrevia(lead, { buscar = buscarNoGoogle, agora = Date.now() } = {}) {
  let dados = null;
  try { dados = JSON.parse((await db.lerEstado(chaveDosDados(lead.id))) ?? "null"); } catch {}
  if (!dados || agora - (dados.em ?? 0) > DIAS_GUARDADO * 86_400_000) {
    try {
      dados = { ...(await buscar(lead, { idioma: lead.pais === "PT" ? "pt-PT" : "pt-BR" })), em: agora };
      await db.gravarEstado(chaveDosDados(lead.id), JSON.stringify(dados));
    } catch (e) {
      console.error(`Prévia de ${lead.nome}: ${e.message}`);
      dados ??= { fotos: 0, avaliacoes: [], horario: [] };
    }
  }
  const marca = await marcaDaEmpresa(lead).catch(() => ({}));
  const extra = (await db.lerConfig(`previa_extra:${lead.id}`)) ?? {};
  return { ...dados, temLogo: Boolean(marca.logo), corDaMarca: marca.cor ?? null, ...extra };
}

// ---------- A logo e a cor da marca ----------

export const chaveDaLogo = (leadId) => `previa-logo:${leadId}`;
const chaveDaMarca = (leadId) => `previa_marca_v2:${leadId}`; // v2: a cor viva vale mesmo em pouca área da logo
const DIAS_DA_MARCA = 7;
const MAX_LOGO = 1_500_000;

async function baixar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TEMPO_MS) });
  const tipo = r.headers.get("content-type") ?? "";
  if (!r.ok || !tipo.startsWith("image/")) return null;
  const dados = Buffer.from(await r.arrayBuffer());
  return dados.length > 500 && dados.length <= MAX_LOGO ? { tipo, dados } : null;
}

/** A logo da empresa: a foto de perfil do WhatsApp em tamanho cheio, a do Instagram ou, por fim, a miniatura salva. */
async function buscarLogo(lead) {
  const uazap = await import("../envio/uazap.js");
  const telefone = String(lead.whatsapp ?? "").replace(/\D/g, "");
  if (telefone && (await uazap.configurada().catch(() => false))) {
    const url = await uazap.fotoDoContato(telefone, { numeroId: lead.numero_wa || null, grande: true }).catch(() => "");
    const img = url ? await baixar(url).catch(() => null) : null;
    if (img) return img;
  }
  let insta = null;
  try { insta = JSON.parse(lead.instagram_dados || "null")?.foto ?? null; } catch {}
  const doInsta = insta ? await baixar(insta).catch(() => null) : null;
  if (doInsta) return doInsta;
  const salva = await db.lerMidia(`foto-lead-${lead.id}`);
  return salva?.tipo?.startsWith("image/") ? salva : null;
}

/**
 * A marca da empresa para a prévia: { logo: true/false, cor } (a cor principal da logo). Busca uma vez e guarda
 * (a logo no banco); renova a cada 7 dias. Sem logo, a prévia fica com a cor do ramo.
 */
export async function marcaDaEmpresa(lead, { buscar = buscarLogo, agora = Date.now(), cor = corDaLogo } = {}) {
  let marca = null;
  try { marca = JSON.parse((await db.lerEstado(chaveDaMarca(lead.id))) ?? "null"); } catch {}
  if (marca && agora - (marca.em ?? 0) < DIAS_DA_MARCA * 86_400_000) return marca;
  try {
    const logo = await buscar(lead);
    if (logo) await db.gravarMidia(chaveDaLogo(lead.id), logo.tipo, logo.dados);
    marca = { logo: Boolean(logo) || Boolean(marca?.logo), cor: (logo ? await cor(logo.dados) : null) ?? marca?.cor ?? null, em: agora };
  } catch (e) {
    console.error(`Logo de ${lead.nome}: ${e.message}`);
    marca = { logo: Boolean(marca?.logo), cor: marca?.cor ?? null, em: agora };
  }
  await db.gravarEstado(chaveDaMarca(lead.id), JSON.stringify(marca));
  return marca;
}

/** Grava o que sabemos a mais desta empresa (serviços, frase, descrição, logo em texto), para a prévia usar. */
export async function gravarExtraDaPrevia(leadId, extra) {
  const limpo = {};
  const texto = (v, max) => String(v ?? "").trim().slice(0, max);
  if (Array.isArray(extra?.servicos)) limpo.servicos = extra.servicos.slice(0, 9).map(([t, d]) => [texto(t, 40), texto(d, 120)]).filter(([t]) => t);
  for (const [campo, max] of [["titulo", 90], ["frase", 200], ["sobre", 600], ["logo", 40], ["logoDetalhe", 40], ["instagram", 60]]) {
    if (extra?.[campo] !== undefined) limpo[campo] = texto(extra[campo], max);
  }
  if (/^#[0-9a-f]{6}$/i.test(String(extra?.corDaMarca ?? ""))) limpo.corDaMarca = extra.corDaMarca;
  if (Array.isArray(extra?.motivos)) limpo.motivos = extra.motivos.slice(0, 4).map((m) => texto(m, 60)).filter(Boolean);
  await db.gravarConfig(`previa_extra:${leadId}`, limpo);
  return limpo;
}
