import { config } from "../config.js";
import * as db from "../db.js";

// Publicação no Instagram pela API oficial da Meta. Funciona com os dois tipos de token:
// o do "Instagram Login" (começa com IG, usa graph.instagram.com) e o do Facebook Login
// (página do Facebook ligada à conta profissional do Instagram, usa graph.facebook.com).
const VERSAO = config.instagram.apiVersion;
const hostDoToken = (token) => (/^IG/.test(token) ? "graph.instagram.com" : "graph.facebook.com");

/** Conta conectada (com o token) ou null. O token nunca sai do servidor. */
export const lerConexao = () => db.lerConfig("instagram");

/** O que o painel pode ver da conexão. */
export async function statusDaConexao() {
  const c = await lerConexao();
  return c?.token ? { conectado: true, usuario: c.usuario, conectadoEm: c.conectadoEm } : { conectado: false };
}

async function chamar({ host, token }, metodo, caminho, params = {}) {
  const url = new URL(`https://${host}/${VERSAO}/${caminho}`);
  const opcoes = { method: metodo, headers: { Authorization: `Bearer ${token}` } };
  if (metodo === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else {
    opcoes.headers["Content-Type"] = "application/json";
    opcoes.body = JSON.stringify(params);
  }
  const r = await fetch(url, opcoes);
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || corpo.error) {
    const e = corpo.error ?? {};
    throw new Error(`Instagram: ${e.error_user_msg || e.message || `respondeu ${r.status}`}`);
  }
  return corpo;
}

/** Confere o token, descobre a conta do Instagram e guarda a conexão. */
export async function conectarInstagram(token) {
  token = String(token ?? "").trim();
  if (!token) throw new Error("Cole o token de acesso gerado no painel da Meta.");
  const host = hostDoToken(token);
  let conta;
  if (host === "graph.instagram.com") {
    const eu = await chamar({ host, token }, "GET", "me", { fields: "user_id,username" });
    conta = { id: eu.user_id, usuario: eu.username };
  } else {
    // Token de página traz a conta direto; token de usuário lista as páginas dele.
    const daPagina = await chamar({ host, token }, "GET", "me", { fields: "instagram_business_account{id,username}" }).catch(() => null);
    const ig = daPagina?.instagram_business_account
      ?? (await chamar({ host, token }, "GET", "me/accounts", { fields: "instagram_business_account{id,username}" })).data?.find((p) => p.instagram_business_account)?.instagram_business_account;
    if (!ig) throw new Error("Esse token não tem nenhuma página do Facebook ligada a uma conta profissional do Instagram.");
    conta = { id: ig.id, usuario: ig.username };
  }
  const agora = new Date().toISOString();
  await db.gravarConfig("instagram", { token, host, igId: String(conta.id), usuario: conta.usuario, conectadoEm: agora, renovadoEm: agora });
  return { conectado: true, usuario: conta.usuario };
}

export const desconectarInstagram = () => db.gravarConfig("instagram", {});

/**
 * O token do Instagram Login vale 60 dias e pode ser renovado depois de 24h:
 * renova uma vez por semana para nunca vencer. (O de página do Facebook não vence.)
 */
export async function renovarTokenSePreciso(agora = new Date()) {
  const c = await lerConexao();
  if (!c?.token || c.host !== "graph.instagram.com") return false;
  if (agora - new Date(c.renovadoEm) < 7 * 24 * 3600_000) return false;
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", c.token);
  const r = await fetch(url);
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || !corpo.access_token) throw new Error(`Instagram: não foi possível renovar o token (${corpo.error?.message ?? r.status})`);
  await db.gravarConfig("instagram", { ...c, token: corpo.access_token, renovadoEm: agora.toISOString() });
  return true;
}

/**
 * Cria a mídia no Instagram, ainda sem publicar, a partir dos links dos arquivos.
 * Reels: um vídeo. Carrossel: de 2 a 10 imagens (uma só vira post de imagem). Retorna o id do container.
 */
export async function criarContainer(conexao, { formato, urls, legenda }) {
  const midia = `${conexao.igId}/media`;
  if (formato === "reels") {
    return (await chamar(conexao, "POST", midia, { media_type: "REELS", video_url: urls[0], caption: legenda, share_to_feed: true })).id;
  }
  if (urls.length === 1) return (await chamar(conexao, "POST", midia, { image_url: urls[0], caption: legenda })).id;
  const filhos = [];
  for (const url of urls.slice(0, 10)) filhos.push((await chamar(conexao, "POST", midia, { image_url: url, is_carousel_item: true })).id);
  return (await chamar(conexao, "POST", midia, { media_type: "CAROUSEL", children: filhos.join(","), caption: legenda })).id;
}

/** IN_PROGRESS enquanto o Instagram baixa e processa; FINISHED quando dá para publicar; ERROR ou EXPIRED. */
export async function statusDoContainer(conexao, id) {
  const r = await chamar(conexao, "GET", id, { fields: "status_code,status" });
  return { codigo: r.status_code, detalhe: r.status };
}

/** Publica o container no perfil. Retorna o id e o link do post. */
export async function publicarContainer(conexao, id) {
  const { id: midiaId } = await chamar(conexao, "POST", `${conexao.igId}/media_publish`, { creation_id: id });
  const { permalink } = await chamar(conexao, "GET", midiaId, { fields: "permalink" }).catch(() => ({}));
  return { id: midiaId, link: permalink ?? null };
}
