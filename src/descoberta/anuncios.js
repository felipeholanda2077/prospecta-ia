import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";
import { config } from "../config.js";

// Empresas que estão anunciando no Instagram e no Facebook agora (Biblioteca de Anúncios da Meta).
// A API oficial da Meta só mostra anúncios políticos no Brasil; a SerpApi lê a biblioteca pública, que mostra
// todos. Quem anuncia já tem verba e quer cliente: a abordagem cita o anúncio e o que a página dele tem de fraco.
// Cada busca na SerpApi gasta 1 do plano (o grátis tem 250 por mês, com até 30 anúncios em cada).
const CHAVE_CONFIG = "anuncios_meta";
const ENDERECO = "https://serpapi.com";
export const LIMITE_PADRAO = 250;
// Marca nacional (muitas curtidas) não é cliente de agência local: fica de fora.
export const CURTIDAS_MAXIMAS = 100_000;

const mesAtual = (agora = new Date()) => new Date(agora).toLocaleDateString("en-CA", { timeZone: config.timezone }).slice(0, 7);
const chaveDoMes = (agora) => `anuncios_buscas:${mesAtual(agora)}`;
const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");

async function chaveAberta() {
  const c = (await db.lerConfig(CHAVE_CONFIG)) ?? {};
  return { c, chave: c.chave ? decifrar(c.chave) : null };
}

export async function buscasNoMes(agora = new Date()) {
  return Number(await db.lerEstado(chaveDoMes(agora))) || 0;
}

/** Conectado só quando a chave guardada abre (a senha do painel tranca as chaves salvas antes de ser trocada). */
export async function situacao(agora = new Date()) {
  const { c, chave } = await chaveAberta();
  return {
    conectado: Boolean(chave),
    trancada: Boolean(c.chave) && !chave,
    limiteMensal: c.limiteMensal ?? LIMITE_PADRAO,
    buscasNoMes: await buscasNoMes(agora),
  };
}

async function pedir(caminho, parametros) {
  let r;
  try {
    r = await fetch(`${ENDERECO}${caminho}?${new URLSearchParams(parametros)}`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("A SerpApi não respondeu agora. Tente de novo em instantes.");
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok || dados.error) {
    const erro = String(dados.error ?? `erro ${r.status}`);
    if (/invalid api key/i.test(erro)) throw new Error("A SerpApi recusou a chave. Confira em serpapi.com → Api Key e cole de novo.");
    if (/run out of searches|plan.*limit/i.test(erro)) throw new Error("As buscas do mês na SerpApi acabaram. Elas voltam no próximo ciclo do plano.");
    throw new Error(`A SerpApi respondeu: ${erro}`);
  }
  return dados;
}

/**
 * Confere a chave na própria SerpApi (a consulta da conta não gasta busca) antes de guardar. Chave vazia mantém a
 * guardada; `chave: null` desconecta.
 * `limiteMensal` é quantas buscas o sistema pode gastar por mês (a busca automática liga em Automação).
 */
export async function conectar({ chave, limiteMensal } = {}) {
  const atual = (await db.lerConfig(CHAVE_CONFIG)) ?? {};
  const limite = limiteMensal === undefined || limiteMensal === "" ? atual.limiteMensal ?? LIMITE_PADRAO : Number.parseInt(limiteMensal, 10);
  if (!(limite >= 0 && limite <= 100_000)) return { erro: "Informe quantas buscas por mês (0 a 100.000)" };
  const texto = String(chave ?? "").trim();
  let guardada = atual.chave ?? null;
  let plano = null;
  if (chave === null) guardada = null;
  else if (texto) {
    try {
      const conta = await pedir("/account.json", { api_key: texto });
      plano = { nome: conta.plan_name ?? null, porMes: conta.searches_per_month ?? null, restantes: conta.total_searches_left ?? conta.plan_searches_left ?? null };
    } catch (e) {
      return { erro: e.message };
    }
    guardada = cifrar(texto);
  }
  await db.gravarConfig(CHAVE_CONFIG, { chave: guardada, limiteMensal: limite });
  return { ...(await situacao()), plano };
}

/** O número de WhatsApp de um link do anúncio (wa.me/55..., api.whatsapp.com/send?phone=55...). */
export function whatsappDoLink(link) {
  const texto = String(link ?? "");
  if (!/wa\.me|whatsapp\.com/i.test(texto)) return null;
  let numero = texto.match(/wa\.me\/(\d{10,13})/i)?.[1];
  if (!numero) {
    try { numero = new URL(texto).searchParams.get("phone"); } catch { /* link quebrado */ }
  }
  const d = String(numero ?? "").replace(/\D/g, "");
  return d.length >= 12 && d.startsWith("55") ? d : d.length >= 10 && d.length <= 11 ? `55${d}` : null;
}

/** O @ do Instagram de um link do anúncio (instagram.com/usuario). */
export function instagramDoLink(link) {
  const u = String(link ?? "").match(/instagram\.com\/([a-z0-9._]{2,30})\/?(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return u && !["p", "reel", "reels", "explore", "stories", "accounts"].includes(u) ? u : null;
}

/** Link que leva para o próprio Facebook (página, formulário, Messenger) não é o site da empresa. */
const ehDaMeta = (link) => /(^|\/\/|\.)(facebook\.com|fb\.com|fb\.me|m\.me|messenger\.com|instagram\.com|wa\.me|whatsapp\.com)/i.test(String(link ?? ""));

/** A empresa de um anúncio: nome e página, para onde ele leva (site, WhatsApp ou Instagram) e o texto. */
export function empresaDoAnuncio(ad) {
  const links = [ad.link, ...(ad.cards ?? []).map((c) => c.link)].filter(Boolean);
  const whatsapp = links.map(whatsappDoLink).find(Boolean) ?? null;
  const instagram = links.map(instagramDoLink).find(Boolean) ?? null;
  const site = links.find((l) => /^https?:\/\//i.test(l) && !ehDaMeta(l)) ?? null;
  const texto = String(ad.body || ad.cards?.[0]?.body || ad.title || "").replace(/\s+/g, " ").trim();
  return {
    page_id: String(ad.page_id ?? ""),
    nome: String(ad.page_name ?? "").trim(),
    site,
    telefone: whatsapp,
    instagram,
    curtidas: ad.page_likes ?? null,
    categorias: ad.page_categories ?? [],
    anuncio: {
      texto: texto.slice(0, 400),
      desde: ad.start_date ?? null,
      link: links[0] ?? null,
      chamada: ad.call_to_action ?? null,
      plataformas: ad.publisher_platforms ?? [],
      biblioteca: ad.details_link ?? (ad.ad_archive_id ? `https://www.facebook.com/ads/library/?id=${ad.ad_archive_id}` : null),
    },
  };
}

/**
 * A busca automática gasta o limite do mês aos poucos: até hoje, no máximo a parte proporcional dos dias que já
 * passaram (o limite não acaba na primeira semana).
 */
export async function podeBuscarSozinho(agora = new Date()) {
  const s = await situacao(agora);
  if (!s.conectado || !s.limiteMensal) return false;
  const [ano, mes, dia] = new Date(agora).toLocaleDateString("en-CA", { timeZone: config.timezone }).split("-").map(Number);
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return s.buscasNoMes < Math.ceil((s.limiteMensal * dia) / diasNoMes);
}

/** Reserva uma busca do mês (no banco, para dois agendadores não passarem do limite juntos). */
async function reservarBusca(limite, agora) {
  const chave = chaveDoMes(agora);
  const feitas = Number(await db.lerEstado(chave)) || 0;
  if (feitas >= limite) return false;
  await db.gravarEstado(chave, feitas + 1);
  return true;
}

/**
 * Anunciantes de um segmento numa cidade, com anúncio ativo no Brasil: um por página, sem as marcas grandes,
 * os que citam a cidade primeiro. Gasta 1 busca por página de resultados (até `maxBuscas`).
 */
export async function buscarAnunciantes({ nicho, cidade, quantidade = 20, maxBuscas = 2, agora = new Date() } = {}) {
  const { c, chave } = await chaveAberta();
  if (!chave) throw new Error(c.chave ? "A chave da SerpApi guardada não abre mais (a senha do painel mudou). Cole de novo em Buscar empresas → Anúncios da Meta." : "Conecte a SerpApi para buscar nos anúncios da Meta: cole a chave em Buscar empresas → Anúncios da Meta.");
  const limite = c.limiteMensal ?? LIMITE_PADRAO;
  const cidadeSemUf = String(cidade ?? "").split(/\s+-\s+|,|\//)[0].trim();
  const q = `${String(nicho ?? "").trim()} ${cidadeSemUf}`.trim();
  const porPagina = new Map();
  let token = null;
  let buscas = 0;
  const avisos = [];
  while (buscas < maxBuscas && porPagina.size < quantidade) {
    if (!(await reservarBusca(limite, agora))) {
      avisos.push(`O limite de ${limite} buscas por mês nos anúncios foi atingido; ajuste em Anúncios da Meta.`);
      break;
    }
    buscas++;
    const dados = await pedir("/search.json", {
      engine: "meta_ad_library", q, country: "BR", ad_type: "all", active_status: "active", api_key: chave,
      ...(token ? { next_page_token: token } : {}),
    });
    for (const ad of dados.ads ?? []) {
      const e = empresaDoAnuncio(ad);
      if (!e.page_id || !e.nome || porPagina.has(e.page_id)) continue;
      if (e.curtidas != null && e.curtidas > CURTIDAS_MAXIMAS) continue;
      porPagina.set(e.page_id, e);
    }
    token = dados.serpapi_pagination?.next_page_token ?? dados.next_page_token ?? null;
    if (!token) break;
  }
  const cidadeNormal = semAcento(cidadeSemUf).toLowerCase();
  const citaCidade = (e) => cidadeNormal && semAcento(`${e.nome} ${e.anuncio.texto}`).toLowerCase().includes(cidadeNormal);
  const empresas = [...porPagina.values()]
    .map((e) => ({ ...e, citaCidade: Boolean(citaCidade(e)) }))
    .sort((a, b) => Number(b.citaCidade) - Number(a.citaCidade) || Number(Boolean(b.telefone)) - Number(Boolean(a.telefone)))
    .slice(0, quantidade);
  return { empresas, buscas, avisos };
}
