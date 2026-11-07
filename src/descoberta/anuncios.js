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
/** Corta o texto sem partir emoji ao meio (meio emoji vira um JSON que a IA recusa). */
export const cortar = (s, n) => [...String(s ?? "").toWellFormed()].slice(0, n).join("");
export const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
/** "Osasco - SP" vira "Osasco". */
export const cidadeSemUf = (cidade) => String(cidade ?? "").split(/\s+-\s+|,|\//)[0].trim();
const chaveDaFonte = (fonte, agora) => `serpapi:${fonte}:${mesAtual(agora)}`;
// A mesma chave da SerpApi serve a três buscas automáticas; cada uma gasta no máximo esta parte do limite do mês
// (a busca feita no painel só respeita o limite total).
export const COTA_AUTOMATICA = { anuncios: 0.4, vagas: 0.3, avaliacoes: 0.3 };

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
    // Busca sem nenhum resultado não é falha: é uma lista vazia.
    if (/hasn't returned any results/i.test(erro)) return { semResultados: true };
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
    pagina: ad.page_profile_link ?? null,
    categorias: ad.page_categories ?? [],
    anuncio: {
      texto: cortar(texto, 400),
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
export async function podeBuscarSozinho(agora = new Date(), fonte = "anuncios") {
  const s = await situacao(agora);
  if (!s.conectado || !s.limiteMensal) return false;
  const [ano, mes, dia] = new Date(agora).toLocaleDateString("en-CA", { timeZone: config.timezone }).split("-").map(Number);
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  if (s.buscasNoMes >= Math.ceil((s.limiteMensal * dia) / diasNoMes)) return false;
  const daFonte = Number(await db.lerEstado(chaveDaFonte(fonte, agora))) || 0;
  return daFonte < Math.ceil(s.limiteMensal * (COTA_AUTOMATICA[fonte] ?? 0.3));
}

/** O nome da página no Facebook (facebook.com/nome): muitas vezes é o mesmo @ do Instagram. */
export function apelidoDaPagina(link) {
  const m = String(link ?? "").match(/facebook\.com\/([a-z0-9._]{2,50})\/?(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return m && !["profile.php", "pages", "people", "groups", "marketplace"].includes(m) ? m.replace(/\.+$/, "") : null;
}

// Palavras que muita empresa do mesmo ramo tem no nome: sozinhas não provam que é a mesma empresa.
const GENERICAS = new Set(["ltda", "eireli", "me", "epp", "sa", "de", "da", "do", "das", "dos", "e", "a", "o", "the",
  "veiculos", "automoveis", "auto", "autos", "carros", "multimarcas", "motors", "clinica", "studio", "store", "loja", "oficial", "brasil", "sp"]);
const palavras = (s) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((p) => p.length >= 3 && !GENERICAS.has(p));

/** O resultado do Google Maps é a mesma empresa do anúncio? Pelo menos uma palavra própria do nome em comum. */
export function mesmoNome(daPagina, doMaps) {
  const doAnuncio = palavras(daPagina);
  const doLugar = new Set(palavras(doMaps));
  return doAnuncio.length > 0 && doAnuncio.some((p) => doLugar.has(p));
}

/**
 * O anúncio que abre uma conversa no WhatsApp não traz o número. Para esses, procura o contato pelo Instagram
 * (o nome da página no Facebook costuma ser o @) e, sem ele, pelo nome da empresa no Google Maps da cidade.
 * Muda as empresas no lugar; `instagram` e `maps` são as consultas (para o teste).
 */
export async function completarContatos(empresas, cidade, { instagram = null, maps = null, maximo = 15 } = {}) {
  const cidadeCurta = cidadeSemUf(cidade);
  let feitas = 0;
  for (const e of empresas) {
    if (e.site || e.telefone || feitas >= maximo) continue;
    feitas++;
    const apelido = e.instagram ?? apelidoDaPagina(e.pagina);
    if (instagram && apelido) {
      const p = await instagram(apelido).catch(() => null);
      if (p) {
        e.instagram = p.usuario;
        e.telefone = p.contatos?.whatsapp ?? p.contatos?.telefone?.replace(/\D/g, "") ?? null;
        e.email ??= p.contatos?.email ?? null;
        if (p.site && !ehDaMeta(p.site)) e.site = p.site;
        e.contatoDe = "instagram";
      }
    }
    if (!e.telefone && !e.site && maps) {
      const achados = await maps(`${e.nome} ${cidadeCurta}`).catch(() => []);
      const lugar = achados.find((l) => mesmoNome(e.nome, l.nome));
      if (lugar) {
        Object.assign(e, {
          telefone: lugar.telefone ? String(lugar.telefone).replace(/\D/g, "") : null, site: lugar.site ?? e.site ?? null,
          endereco: lugar.endereco ?? null, maps_url: lugar.maps_url ?? null, avaliacao: lugar.avaliacao ?? null, total_avaliacoes: lugar.total_avaliacoes ?? null,
          contatoDe: "maps", mapsPlaceId: lugar.place_id ?? null,
        });
      }
    }
  }
  return empresas;
}

/** Reserva uma busca do mês (no banco, para dois agendadores não passarem do limite juntos). */
async function reservarBusca(limite, agora, fonte = "anuncios") {
  const chave = chaveDoMes(agora);
  const feitas = Number(await db.lerEstado(chave)) || 0;
  if (feitas >= limite) return false;
  await db.gravarEstado(chave, feitas + 1);
  const daFonte = chaveDaFonte(fonte, agora);
  await db.gravarEstado(daFonte, (Number(await db.lerEstado(daFonte)) || 0) + 1);
  return true;
}

const locais = new Map();
/** O nome da cidade como a SerpApi entende ("Osasco,State of Sao Paulo,Brazil"); a consulta dos locais não gasta busca. */
export async function localDaSerpApi(cidade) {
  const nome = cidadeSemUf(cidade);
  if (!nome) return null;
  if (locais.has(nome)) return locais.get(nome);
  let local = null;
  try {
    const r = await fetch(`${ENDERECO}/locations.json?${new URLSearchParams({ q: nome, limit: "10" })}`, { signal: AbortSignal.timeout(15_000) });
    const lista = await r.json();
    const cidades = (Array.isArray(lista) ? lista : []).filter((l) => l.country_code === "BR" && l.target_type === "City");
    // O mais curto ("Osasco,State of Sao Paulo,Brazil") é o da própria cidade; o maior alcance desempata.
    local = cidades.sort((a, b) => a.canonical_name.split(",").length - b.canonical_name.split(",").length || (b.reach ?? 0) - (a.reach ?? 0))[0]?.canonical_name ?? null;
  } catch { /* sem o local, a busca vai só com o nome da cidade no texto */ }
  locais.set(nome, local);
  return local;
}

/**
 * Uma busca na SerpApi por outra fonte (vagas, avaliações), gastando 1 do limite do mês. Sem chave, sem limite
 * ou com o limite atingido, devolve null (com o motivo em `aviso`) em vez de falhar.
 */
export async function buscarNaSerpApi(parametros, { fonte, agora = new Date() } = {}) {
  const { c, chave } = await chaveAberta();
  if (!chave) return { dados: null, aviso: "SerpApi não conectada (Configurações → Anúncios da Meta)" };
  const limite = c.limiteMensal ?? LIMITE_PADRAO;
  if (!(await reservarBusca(limite, agora, fonte))) return { dados: null, aviso: `O limite de ${limite} buscas por mês na SerpApi foi atingido` };
  return { dados: await pedir("/search.json", { ...parametros, api_key: chave }) };
}

/**
 * Anunciantes de um segmento numa cidade, com anúncio ativo no Brasil: um por página, sem as marcas grandes,
 * os que citam a cidade primeiro. Gasta 1 busca por página de resultados (até `maxBuscas`).
 */
export async function buscarAnunciantes({ nicho, cidade, quantidade = 20, maxBuscas = 2, agora = new Date() } = {}) {
  const { c, chave } = await chaveAberta();
  if (!chave) throw new Error(c.chave ? "A chave da SerpApi guardada não abre mais (a senha do painel mudou). Cole de novo em Configurações → Anúncios da Meta." : "Conecte a SerpApi para buscar nos anúncios da Meta: cole a chave em Configurações → Anúncios da Meta.");
  const limite = c.limiteMensal ?? LIMITE_PADRAO;
  const cidadeCurta = cidadeSemUf(cidade);
  const q = `${String(nicho ?? "").trim()} ${cidadeCurta}`.trim();
  const porPagina = new Map();
  let token = null;
  let buscas = 0;
  const avisos = [];
  while (buscas < maxBuscas && porPagina.size < quantidade) {
    if (!(await reservarBusca(limite, agora, "anuncios"))) {
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
  const cidadeNormal = semAcento(cidadeCurta).toLowerCase();
  const citaCidade = (e) => cidadeNormal && semAcento(`${e.nome} ${e.anuncio.texto}`).toLowerCase().includes(cidadeNormal);
  const empresas = [...porPagina.values()]
    .map((e) => ({ ...e, citaCidade: Boolean(citaCidade(e)) }))
    .sort((a, b) => Number(b.citaCidade) - Number(a.citaCidade) || Number(Boolean(b.telefone)) - Number(Boolean(a.telefone)))
    .slice(0, quantidade);
  return { empresas, buscas, avisos };
}
