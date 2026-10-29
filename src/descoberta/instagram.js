import { config } from "../config.js";
import * as db from "../db.js";
import { lerConexao } from "../envio/instagram.js";
import { normalizarTelefoneBR } from "../analise/telefone.js";

// Captação pelo Instagram com a API oficial da Meta, usando a conta conectada em Conteúdo:
// - hashtags da região (ex.: #petshopfortaleza): os posts mais vistos e os mais recentes, de onde
//   saem os @perfis citados nas legendas;
// - "business discovery": os dados públicos de cada perfil comercial (nome, bio, site, seguidores),
//   e da bio saem o WhatsApp, o telefone e o e-mail.
// A Meta só libera isso pelo token do Facebook (página ligada ao Instagram), não pelo login do Instagram.
const VERSAO = config.instagram.apiVersion;
const HOST = "graph.facebook.com";
// A Meta deixa consultar até 30 hashtags diferentes a cada 7 dias por conta.
export const LIMITE_HASHTAGS = 30;
const JANELA_HASHTAGS_MS = 7 * 24 * 3600_000;
const ESTADO_HASHTAGS = "instagram_hashtags";

/** A conta conectada serve para buscar empresas? Retorna { conexao } ou { motivo }. */
export async function buscaNoInstagram() {
  const conexao = await lerConexao();
  if (!conexao?.token) return { motivo: "Conecte o Instagram em Conteúdo para buscar empresas por lá." };
  if (conexao.host !== HOST) {
    return { motivo: "A busca de empresas só funciona com o Instagram conectado pela página do Facebook (token do Explorador da API)." };
  }
  return { conexao };
}

async function chamar(conexao, caminho, params = {}) {
  const url = new URL(`https://${HOST}/${VERSAO}/${caminho}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${conexao.token}` } });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || corpo.error) {
    const e = corpo.error ?? {};
    const erro = new Error(`Instagram: ${e.error_user_msg || e.message || `respondeu ${r.status}`}`);
    erro.codigo = e.code;
    throw erro;
  }
  return corpo;
}

const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Hashtag no formato do Instagram: minúsculas, sem acento, espaço nem símbolo. */
export const paraHashtag = (s) => semAcento(s).toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_]/g, "");

/** A hashtag da busca: segmento + cidade (sem o estado), ex.: "pet shop" + "Fortaleza - CE" → petshopfortaleza. */
export function hashtagsDaBusca(nicho, cidade) {
  const local = String(cidade ?? "").split(/\s+-\s+|,|\//)[0];
  const tag = paraHashtag(`${nicho}${local}`);
  return tag ? [tag] : [];
}

/** Os @perfis citados num texto (legendas), sem e-mails nem repetidos. */
export function perfisCitados(texto) {
  const achados = String(texto ?? "").match(/(?<![\w.@])@([a-z0-9._]{2,30})(?![\w@])/gi) ?? [];
  return [...new Set(achados.map((a) => a.slice(1).toLowerCase().replace(/\.+$/, "")))].filter((u) => u.length >= 2);
}

const ehCelular = (d) => d.length === 11 && d[2] === "9";

/** WhatsApp, telefone e e-mail escritos na bio ou no link do perfil. */
export function contatosDoPerfil(bio = "", site = "") {
  const texto = `${bio ?? ""}\n${site ?? ""}`;
  const email = texto.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase() ?? null;
  const wa = texto.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\d{10,13})/i)?.[1] ?? null;
  // Números de telefone do Brasil: (85) 99999-9999, 85 9 9999 9999, +55 85 99999-9999…
  const telefones = [...texto.matchAll(/(?:\+?55[\s.-]?)?\(?\b(\d{2})\)?[\s.-]?(9?[\s.-]?\d{4})[\s.-]?(\d{4})\b/g)]
    .map((m) => `${m[1]}${m[2]}${m[3]}`.replace(/\D/g, ""))
    .filter((d) => d.length >= 10 && d.length <= 11 && Number(d.slice(0, 2)) >= 11);
  const telefone = telefones.find(ehCelular) ?? telefones[0] ?? null;
  return {
    email,
    whatsapp: normalizarTelefoneBR(wa),
    telefone: telefone ? `+55 ${telefone.slice(0, 2)} ${telefone.slice(2)}` : null,
  };
}

/** O @ de um link do Instagram (instagram.com/fulano), ou null. */
export function usuarioDoLink(url) {
  const m = String(url ?? "").match(/instagram\.com\/([a-z0-9._]{2,30})/i);
  const usuario = m?.[1]?.toLowerCase();
  return usuario && !["p", "reel", "reels", "stories", "explore", "accounts", "tv"].includes(usuario) ? usuario : null;
}

const linkDoPerfil = (usuario) => `https://www.instagram.com/${usuario}/`;

/** Os dados públicos de um perfil comercial do Instagram. Perfil pessoal ou que não existe: null. */
export async function perfilDoInstagram(conexao, usuario, recusas = null) {
  usuario = String(usuario ?? "").replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{2,30}$/.test(usuario)) return null;
  const campos = "username,name,biography,website,followers_count,media_count,profile_picture_url,media.limit(12){timestamp,caption}";
  try {
    const { business_discovery: p } = await chamar(conexao, conexao.igId, { fields: `business_discovery.username(${usuario}){${campos}}` });
    if (!p?.username) return null;
    return {
      usuario: p.username,
      nome: p.name || p.username,
      bio: p.biography ?? "",
      site: p.website ?? null,
      seguidores: p.followers_count ?? null,
      posts: p.media_count ?? null,
      ultimoPost: p.media?.data?.[0]?.timestamp ?? null,
      foto: p.profile_picture_url ?? null,
      // Quem a empresa cita nos posts recentes (parceiros, fornecedores, clientes): a próxima leva da busca.
      citados: perfisCitados((p.media?.data ?? []).map((m) => m.caption ?? "").join("\n")).filter((u) => u !== p.username.toLowerCase()),
    };
  } catch (e) {
    // (#110) / (#100): a conta não é comercial, é privada ou não existe. Os outros erros sobem.
    if ([100, 110].includes(e.codigo)) {
      recusas?.push(`@${usuario}: ${e.message.replace(/^Instagram: /, "")}`);
      return null;
    }
    throw e;
  }
}

/**
 * Reserva as hashtags dentro do limite da Meta (30 diferentes a cada 7 dias). Hashtag já
 * consultada na janela não conta de novo. Retorna as que podem ser usadas agora.
 */
export async function reservarHashtags(tags, agora = new Date()) {
  let usadas = {};
  try {
    usadas = JSON.parse((await db.lerEstado(ESTADO_HASHTAGS)) ?? "{}");
  } catch {}
  for (const [tag, quando] of Object.entries(usadas)) if (agora - new Date(quando) > JANELA_HASHTAGS_MS) delete usadas[tag];
  const liberadas = [];
  for (const tag of tags) {
    if (!usadas[tag] && Object.keys(usadas).length >= LIMITE_HASHTAGS) continue;
    usadas[tag] ??= agora.toISOString();
    liberadas.push(tag);
  }
  await db.gravarEstado(ESTADO_HASHTAGS, JSON.stringify(usadas));
  return liberadas;
}

/** Quantas hashtags ainda dá para consultar nesta semana. */
export async function hashtagsRestantes(agora = new Date()) {
  let usadas = {};
  try {
    usadas = JSON.parse((await db.lerEstado(ESTADO_HASHTAGS)) ?? "{}");
  } catch {}
  const ativas = Object.values(usadas).filter((quando) => agora - new Date(quando) <= JANELA_HASHTAGS_MS).length;
  return Math.max(0, LIMITE_HASHTAGS - ativas);
}

/** Os @perfis que aparecem nos posts de uma hashtag (mais vistos e mais recentes), do mais citado ao menos. */
async function perfisDaHashtag(conexao, tag) {
  const { data } = await chamar(conexao, "ig_hashtag_search", { user_id: conexao.igId, q: tag });
  const id = data?.[0]?.id;
  if (!id) return { perfis: [], lidos: 0 };
  const contagem = new Map();
  const erros = [];
  let lidos = 0;
  for (const lista of ["top_media", "recent_media"]) {
    try {
      const posts = await chamar(conexao, `${id}/${lista}`, { user_id: conexao.igId, fields: "caption", limit: 50 });
      for (const p of posts.data ?? []) {
        lidos++;
        for (const u of perfisCitados(p.caption)) contagem.set(u, (contagem.get(u) ?? 0) + 1);
      }
    } catch (e) {
      erros.push(e.message.replace(/^Instagram: /, ""));
    }
  }
  // As duas listas recusadas: o erro sobe (costuma ser o recurso de conteúdo público não liberado).
  if (erros.length === 2) throw new Error(erros[0]);
  return { perfis: [...contagem.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u), lidos };
}

/** Empresa no mesmo formato das do Google Maps, com os dados do Instagram. */
export function empresaDoPerfil(perfil) {
  const contatos = contatosDoPerfil(perfil.bio, perfil.site);
  return {
    place_id: `ig:${perfil.usuario}`,
    nome: perfil.nome,
    endereco: null,
    telefone: contatos.telefone ?? (contatos.whatsapp ? `+${contatos.whatsapp}` : null),
    email: contatos.email,
    site: perfil.site || linkDoPerfil(perfil.usuario),
    maps_url: null,
    avaliacao: null,
    total_avaliacoes: null,
    instagram: perfil.usuario,
    instagram_dados: { seguidores: perfil.seguidores, posts: perfil.posts, ultimoPost: perfil.ultimoPost, bio: perfil.bio.slice(0, 300) },
    origem: "instagram",
  };
}

/**
 * Busca empresas no Instagram: pelos @perfis informados e pelos que aparecem nas hashtags
 * (as informadas ou a do segmento + cidade). Retorna até `quantidade` perfis comerciais.
 */
export async function buscarEmpresasNoInstagram({ nicho = "", cidade = "", termos = "", quantidade = 20 } = {}) {
  const { conexao, motivo } = await buscaNoInstagram();
  if (!conexao) throw new Error(motivo);
  const partes = String(termos ?? "").split(/[\s,;]+/).filter(Boolean);
  const perfis = partes.filter((t) => t.startsWith("@")).map((t) => t.slice(1).toLowerCase());
  const pedidas = partes.filter((t) => !t.startsWith("@")).map(paraHashtag).filter(Boolean);
  const tags = pedidas.length ? pedidas : hashtagsDaBusca(nicho, cidade);
  const liberadas = await reservarHashtags(tags.slice(0, 5));
  const avisos = [];
  if (liberadas.length < tags.slice(0, 5).length) {
    avisos.push(`A Meta só deixa consultar ${LIMITE_HASHTAGS} hashtags diferentes por semana; algumas ficaram para depois.`);
  }
  let postsLidos = 0;
  for (const tag of liberadas) {
    try {
      const r = await perfisDaHashtag(conexao, tag);
      perfis.push(...r.perfis);
      postsLidos += r.lidos;
    } catch (e) {
      // Sem o recurso de conteúdo público liberado, a Meta recusa a busca por hashtag.
      avisos.push(`#${tag}: ${e.message.replace(/^Instagram: /, "")}`);
    }
  }
  // Em cadeia: de cada perfil, segue os @ citados nos posts dele. Os achados assim só entram se
  // forem da cidade (no nome ou na bio). As empresas já capturadas da mesma busca servem de ponto
  // de partida (já são da região), mas não voltam como resultado.
  const local = semAcento(String(cidade ?? "").split(/\s+-\s+|,|\//)[0]).toLowerCase().trim();
  const daCidade = (perfil) => !local || semAcento(`${perfil.nome} ${perfil.bio}`).toLowerCase().includes(local);
  const sementes = nicho && cidade ? await db.instagramsDaBusca(nicho, cidade) : [];
  const fila = [
    ...perfis.map((usuario) => ({ usuario, de: "busca" })),
    ...sementes.map((usuario) => ({ usuario, de: "semente" })),
  ];
  const empresas = [];
  const vistos = new Set([String(conexao.usuario ?? "").toLowerCase()]);
  // Cada perfil é uma consulta à Meta: para quando passar de 3 por empresa pedida.
  let consultas = 0;
  const limite = quantidade * 3 + sementes.length;
  const recusas = [];
  for (let i = 0; i < fila.length; i++) {
    const { usuario, de } = fila[i];
    if (empresas.length >= quantidade || consultas >= limite) break;
    if (vistos.has(usuario)) continue;
    consultas++;
    vistos.add(usuario);
    const perfil = await perfilDoInstagram(conexao, usuario, recusas);
    if (!perfil) continue;
    if (de === "busca" || (de === "citado" && daCidade(perfil))) empresas.push(empresaDoPerfil(perfil));
    for (const citado of perfil.citados) if (!vistos.has(citado)) fila.push({ usuario: citado, de: "citado" });
  }
  // Nenhum perfil aceito: mostra o que a Meta respondeu, para dar para saber se é permissão.
  if (!empresas.length && recusas.length) {
    avisos.push(`Os ${consultas} perfis citados nos posts não vieram como conta comercial. Exemplos da resposta da Meta: ${recusas.slice(0, 3).join(" | ")}`);
  }
  if (!empresas.length && !perfis.length && !sementes.length && liberadas.length && !avisos.length) avisos.push(postsLidos
    ? `Li ${postsLidos} posts dessas hashtags e nenhum cita um @perfil. Informe @perfis de empresas da região: a busca segue quem elas citam nos posts.`
    : "A Meta não devolveu nenhum post dessas hashtags. Tente outras hashtags ou informe @perfis.");
  return { empresas, hashtags: liberadas, avisos };
}

/**
 * Para a análise: os dados do Instagram da empresa (o @ guardado ou o do link no Google),
 * quando a conta conectada permite. Sem conexão ou sem perfil comercial: null.
 */
export async function instagramDaEmpresa(lead, analise = {}) {
  const usuario = lead.instagram || usuarioDoLink(lead.site) || usuarioDoLink(analise.urlRedeSocial) || usuarioDoLink(analise.linkInstagram);
  if (!usuario) return null;
  const { conexao } = await buscaNoInstagram();
  if (!conexao) return null;
  const perfil = await perfilDoInstagram(conexao, usuario).catch(() => null);
  if (!perfil) return null;
  return { ...perfil, bio: perfil.bio.slice(0, 300), contatos: contatosDoPerfil(perfil.bio, perfil.site) };
}
