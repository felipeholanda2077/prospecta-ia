import { config } from "../config.js";
import * as db from "../db.js";

// Publicação no Instagram pela API oficial da Meta. Aceita os tokens dos três jeitos que a Meta
// oferece: o do "Instagram Login" (começa com IG, usa graph.instagram.com), o do login unificado
// (apps novos; a conta do Instagram direto, em graph.facebook.com) e o do Facebook Login
// (página do Facebook ligada à conta profissional do Instagram, também em graph.facebook.com).
const VERSAO = config.instagram.apiVersion;

/** Conta conectada (com o token) ou null. O token nunca sai do servidor. */
export const lerConexao = () => db.lerConfig("instagram");

/** O que o painel pode ver da conexão. */
export async function statusDaConexao() {
  const c = await lerConexao();
  // A busca de empresas (hashtags e perfis de outras contas) só existe no token do Facebook.
  return c?.token
    ? { conectado: true, usuario: c.usuario, conectadoEm: c.conectadoEm, expiraEm: c.expiraEm ?? null, buscaEmpresas: c.host === "graph.facebook.com" }
    : { conectado: false };
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

// Jeitos de achar a conta do Instagram a partir do token, do mais comum ao menos comum para cada tipo.
const PELO_INSTAGRAM_LOGIN = {
  nome: "login do Instagram",
  host: "graph.instagram.com",
  achar: async (c) => {
    const eu = await chamar(c, "GET", "me", { fields: "user_id,username" });
    return eu.user_id && { id: eu.user_id, usuario: eu.username };
  },
};
const PELO_FACEBOOK = [
  {
    // Token de página: a conta ligada à página.
    nome: "como página",
    achar: async (c) => (await chamar(c, "GET", "me", { fields: "instagram_business_account{id,username}" })).instagram_business_account,
  },
  {
    // Login unificado: o /me já é a conta do Instagram (página e pessoa ficam de fora pelo tipo).
    nome: "como conta do Instagram",
    achar: async (c) => {
      const eu = await chamar(c, "GET", "me", { fields: "id,username", metadata: 1 });
      return eu.username && !["page", "user"].includes(eu.metadata?.type) && { id: eu.id, username: eu.username };
    },
  },
  {
    // Token de pessoa ou de usuário do sistema: as páginas que ele administra. Fica com o token da
    // página, que não vence quando o token da pessoa é de longa duração.
    nome: "pelas páginas",
    achar: async (c) => {
      const pagina = (await chamar(c, "GET", "me/accounts", { fields: "access_token,instagram_business_account{id,username}" }))
        .data?.find((p) => p.instagram_business_account);
      return pagina && { ...pagina.instagram_business_account, token: pagina.access_token };
    },
  },
  {
    // Login unificado com token de pessoa: a Meta guarda no próprio token as contas que foram autorizadas.
    nome: "pelas contas autorizadas no token",
    achar: async (c) => {
      const { data } = await chamar(c, "GET", "debug_token", { input_token: c.token });
      const ids = [...new Set((data?.granular_scopes ?? []).filter((x) => /^instagram/.test(x.scope)).flatMap((x) => x.target_ids ?? []))];
      for (const id of ids) {
        // O id pode ser da conta do Instagram ou da página ligada a ela.
        const conta = await chamar(c, "GET", id, { fields: "id,username,ig_id" }).catch(() => null);
        if (conta?.username) return conta;
        const daPagina = await chamar(c, "GET", id, { fields: "instagram_business_account{id,username}" }).catch(() => null);
        if (daPagina?.instagram_business_account) return daPagina.instagram_business_account;
      }
      return null;
    },
  },
].map(({ nome, achar }) => ({
  nome, host: "graph.facebook.com", achar: async (c) => { const ig = await achar(c); return ig && { id: ig.id, usuario: ig.username, token: ig.token }; },
}));

/** Quando o token do Facebook vence (ISO), ou null se não vence ou não deu para saber. */
async function validadeDoToken(c) {
  if (c.host !== "graph.facebook.com") return null;
  const { data } = await chamar(c, "GET", "debug_token", { input_token: c.token }).catch(() => ({}));
  return data?.expires_at ? new Date(data.expires_at * 1000).toISOString() : null;
}

/** A conta pelo ID que a Meta mostra ao gerar o token (o jeito mais direto, quando você informa). */
const PELO_ID = (id) => ["graph.facebook.com", "graph.instagram.com"].map((host) => ({
  nome: `pelo ID ${id} (${host})`,
  host,
  achar: async (c) => {
    const conta = await chamar(c, "GET", id, { fields: "id,username" });
    return conta.username && { id: conta.id, usuario: conta.username };
  },
}));

/** Confere o token, descobre a conta do Instagram e guarda a conexão. */
export async function conectarInstagram(token, igId = "") {
  token = String(token ?? "").replace(/\s+/g, "");
  igId = String(igId ?? "").replace(/\D/g, "");
  if (!token) throw new Error("Cole o token de acesso gerado no painel da Meta.");
  const jeitos = [
    ...(igId ? PELO_ID(igId) : []),
    ...(/^IG/.test(token) ? [PELO_INSTAGRAM_LOGIN, ...PELO_FACEBOOK] : [...PELO_FACEBOOK, PELO_INSTAGRAM_LOGIN]),
  ];
  const erros = [];
  for (const jeito of jeitos) {
    const conta = await jeito.achar({ host: jeito.host, token }).catch((e) => (erros.push(`${jeito.nome}: ${e.message.replace(/^Instagram: /, "")}`), false));
    if (conta === null || conta === undefined) erros.push(`${jeito.nome}: nenhuma conta`);
    if (!conta) continue;
    const agora = new Date().toISOString();
    const usado = conta.token || token;
    const expiraEm = await validadeDoToken({ host: jeito.host, token: usado });
    await db.gravarConfig("instagram", { token: usado, host: jeito.host, igId: String(conta.id), usuario: conta.usuario, conectadoEm: agora, renovadoEm: agora, expiraEm });
    return { conectado: true, usuario: conta.usuario, expiraEm };
  }
  // Cada tentativa com o motivo, para dar para ver o que a Meta respondeu.
  throw new Error(`Esse token não deu acesso a nenhuma conta profissional do Instagram. ${erros.length ? `Respostas da Meta: ${erros.join(" | ")}` : "Confira se a conta foi adicionada no app da Meta."}`);
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
