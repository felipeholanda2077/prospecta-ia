import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { obterConfig as lerConfigDoWhatsapp } from "./whatsapp.js";

// Publicação no Instagram pela API oficial da Meta. Aceita os tokens dos três jeitos que a Meta
// oferece: o do "Instagram Login" (começa com IG, usa graph.instagram.com), o do login unificado
// (apps novos; a conta do Instagram direto, em graph.facebook.com) e o do Facebook Login
// (página do Facebook ligada à conta profissional do Instagram, também em graph.facebook.com).
const VERSAO = config.instagram.apiVersion;

// Vários perfis: o principal fica em "instagram" (posts, insights, plano e busca de empresas usam ele) e os
// outros em "instagram_contas". Os outros recebem os mesmos posts (quando marcados) e têm direct e comentários.
const CHAVE_OUTRAS = "instagram_contas";
const outrasContas = async () => ((await db.lerConfig(CHAVE_OUTRAS))?.contas ?? []).filter((c) => c?.token && c?.igId);
const gravarOutras = (contas) => db.gravarConfig(CHAVE_OUTRAS, { contas });
// A pessoa tem um id diferente em cada perfil que ela fala: guardar o perfil pelo id dela basta para responder pelo certo.
const chaveDoPerfilDoContato = (pessoaId) => `contato_ig_conta:${pessoaId}`;
export const lembrarPerfilDoContato = (pessoaId, igId) => (pessoaId && igId ? db.gravarEstado(chaveDoPerfilDoContato(pessoaId), String(igId)) : null);

/**
 * Conta conectada (com o token) ou null. Sem `igId`, a principal; com ele, o perfil com esse id (principal ou outro).
 * O token nunca sai do servidor.
 */
export async function lerConexao(igId = null) {
  const principal = await db.lerConfig("instagram");
  if (!igId || String(principal?.igId ?? "") === String(igId)) return principal;
  return (await outrasContas()).find((c) => String(c.igId) === String(igId)) ?? null;
}

/** Todos os perfis conectados: o principal primeiro. */
export async function todasAsConexoes() {
  const principal = await db.lerConfig("instagram");
  return [...(principal?.token ? [{ ...principal, principal: true }] : []), ...(await outrasContas()).map((c) => ({ ...c, principal: false }))];
}

/** Os outros perfis que recebem os posts do dia (o principal sempre recebe). */
export const contasParaPublicar = async () => (await outrasContas()).filter((c) => c.publicar !== false);

/** O que o painel pode ver da conexão (sem os tokens). */
export async function statusDaConexao() {
  const c = await db.lerConfig("instagram");
  const outras = (await outrasContas()).map((o) => ({ igId: String(o.igId), usuario: o.usuario, conectadoEm: o.conectadoEm, expiraEm: o.expiraEm ?? null, publicar: o.publicar !== false }));
  // A busca de empresas (hashtags e perfis de outras contas) só existe no token do Facebook.
  return c?.token
    ? { conectado: true, usuario: c.usuario, igId: String(c.igId ?? ""), conectadoEm: c.conectadoEm, expiraEm: c.expiraEm ?? null, buscaEmpresas: c.host === "graph.facebook.com", outras }
    : { conectado: false, outras };
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
    throw Object.assign(new Error(`Instagram: ${e.error_user_msg || e.message || `respondeu ${r.status}`}`), { codigo: e.code, subcodigo: e.error_subcode });
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

/**
 * O token da página do Facebook ligada à conta do Instagram, se o token for de uma pessoa que
 * administra a página. Gerado a partir de um token de pessoa de longa duração, ele não vence.
 */
async function tokenDaPagina(c, igId) {
  const { data } = await chamar(c, "GET", "me/accounts", { fields: "access_token,instagram_business_account{id}" }).catch(() => ({}));
  return (Array.isArray(data) ? data : []).find((p) => String(p.instagram_business_account?.id) === String(igId))?.access_token ?? null;
}

// Token que vence em menos de 2 dias é o de curta duração (1 a 2 horas) que a Meta gera primeiro.
const DURACAO_CURTA_MS = 2 * 24 * 3600_000;

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
export async function conectarInstagram(token, igId = "", { outra = false } = {}) {
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
    // Achou a conta com o token da pessoa: fica com o da página, quando houver, que não vence.
    const doFacebook = jeito.host === "graph.facebook.com";
    const usado = conta.token || (doFacebook && (await tokenDaPagina({ host: jeito.host, token }, conta.id))) || token;
    const expiraEm = await validadeDoToken({ host: jeito.host, token: usado });
    const conexao = { token: usado, host: jeito.host, igId: String(conta.id), usuario: conta.usuario, conectadoEm: agora, renovadoEm: agora, expiraEm };
    const principal = await db.lerConfig("instagram");
    if (outra && principal?.token && String(principal.igId) !== conexao.igId) {
      // Outro perfil: entra (ou é reconectado) na lista, recebendo os posts do dia.
      const lista = await outrasContas();
      const antes = lista.find((c) => String(c.igId) === conexao.igId);
      await gravarOutras([...lista.filter((c) => String(c.igId) !== conexao.igId), { ...conexao, publicar: antes ? antes.publicar !== false : true }]);
    } else {
      await db.gravarConfig("instagram", conexao);
      // O perfil que virou principal não fica repetido na lista dos outros.
      await gravarOutras((await outrasContas()).filter((c) => String(c.igId) !== conexao.igId));
    }
    const curto = doFacebook && expiraEm && new Date(expiraEm) - Date.now() < DURACAO_CURTA_MS;
    return {
      conectado: true,
      usuario: conta.usuario,
      expiraEm,
      ...(curto ? { aviso: "Esse token é o de curta duração e vence em poucas horas. Estenda o token na Meta e conecte de novo com o token estendido: assim o sistema guarda o token da página, que não vence." } : {}),
    };
  }
  // Cada tentativa com o motivo, para dar para ver o que a Meta respondeu.
  throw new Error(`Esse token não deu acesso a nenhuma conta profissional do Instagram. ${erros.length ? `Respostas da Meta: ${erros.join(" | ")}` : "Confira se a conta foi adicionada no app da Meta."}`);
}

/** Desconecta o principal. Se houver outros perfis, o primeiro deles passa a ser o principal. */
export async function desconectarInstagram() {
  const [proximo, ...resto] = await outrasContas();
  await db.gravarConfig("instagram", proximo ? (({ publicar, ...c }) => c)(proximo) : {});
  if (proximo) await gravarOutras(resto);
}

/** Tira um dos outros perfis do sistema. */
export async function desconectarOutraConta(igId) {
  const lista = await outrasContas();
  if (!lista.some((c) => String(c.igId) === String(igId))) throw new Error("Perfil não encontrado");
  await gravarOutras(lista.filter((c) => String(c.igId) !== String(igId)));
}

/** Liga ou desliga os posts do dia num dos outros perfis. */
export async function definirPublicarNaConta(igId, publicar) {
  const lista = await outrasContas();
  const alvo = lista.find((c) => String(c.igId) === String(igId));
  if (!alvo) throw new Error("Perfil não encontrado");
  alvo.publicar = Boolean(publicar);
  await gravarOutras(lista);
}

/** Troca o principal (o dos insights, do plano de horários e da busca de empresas) por um dos outros perfis. */
export async function tornarPrincipal(igId) {
  const lista = await outrasContas();
  const novo = lista.find((c) => String(c.igId) === String(igId));
  if (!novo) throw new Error("Perfil não encontrado");
  const atual = await db.lerConfig("instagram");
  const { publicar, ...conexao } = novo;
  await db.gravarConfig("instagram", conexao);
  await gravarOutras([...lista.filter((c) => String(c.igId) !== String(igId)), ...(atual?.token ? [{ ...atual, publicar: true }] : [])]);
}

/**
 * O token do Instagram Login vale 60 dias e pode ser renovado depois de 24h:
 * renova uma vez por semana para nunca vencer. (O de página do Facebook não vence.)
 */
export async function renovarTokenSePreciso(agora = new Date()) {
  let renovou = false;
  const principal = await db.lerConfig("instagram");
  if (principal?.token) renovou = (await renovarToken(principal, agora, (novo) => db.gravarConfig("instagram", novo))) || renovou;
  for (const c of await outrasContas()) {
    const ok = await renovarToken(c, agora, async (novo) => gravarOutras((await outrasContas()).map((x) => (String(x.igId) === String(c.igId) ? novo : x))))
      .catch((e) => { console.error(`Instagram @${c.usuario}: ${e.message}`); return false; });
    renovou = ok || renovou;
  }
  return renovou;
}

async function renovarToken(c, agora, gravar) {
  if (!c?.token || c.host !== "graph.instagram.com") return false;
  if (agora - new Date(c.renovadoEm) < 7 * 24 * 3600_000) return false;
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", c.token);
  const r = await fetch(url);
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || !corpo.access_token) throw new Error(`Instagram: não foi possível renovar o token (${corpo.error?.message ?? r.status})`);
  await gravar({ ...c, token: corpo.access_token, renovadoEm: agora.toISOString() });
  return true;
}

/**
 * Cria a mídia no Instagram, ainda sem publicar, a partir dos links dos arquivos.
 * Reels: um vídeo. Carrossel: de 2 a 10 imagens (uma só vira post de imagem). Retorna o id do container.
 */
export async function criarContainer(conexao, { formato, urls, capaUrl = null, legenda }) {
  const midia = `${conexao.igId}/media`;
  if (formato === "reels") {
    return (await chamar(conexao, "POST", midia, { media_type: "REELS", video_url: urls[0], caption: legenda, share_to_feed: true, ...(capaUrl ? { cover_url: capaUrl } : {}) })).id;
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

// ---------- Direct ----------
// A API oficial só deixa responder quem escreveu primeiro (até 24 h depois da última mensagem da pessoa)
// e mandar UMA mensagem privada para quem comentou num post (até 7 dias depois do comentário).

const CHAVE_DIRECT = "instagram_direct";
// O direct aceita até 1.000 bytes por mensagem: texto maior sai em partes, quebrado nos parágrafos.
const MAX_BYTES_DIRECT = 950;

/** O que a IA faz sozinha no direct e as chaves do webhook. O token de verificação é criado na primeira leitura. */
export async function configDoDirect() {
  let c = (await db.lerConfig(CHAVE_DIRECT)) ?? {};
  if (!c.verifyToken) {
    c = { ...c, verifyToken: crypto.randomBytes(16).toString("hex") };
    await db.gravarConfig(CHAVE_DIRECT, c);
  }
  // O app da Meta é um só: sem chave própria, vale a que já foi salva para o WhatsApp oficial.
  const appSecret = c.appSecret || (await lerConfigDoWhatsapp()).appSecret || "";
  return { respostas: Boolean(c.respostas), comentarios: Boolean(c.comentarios), appSecret, verifyToken: c.verifyToken };
}

/** Salva só o que veio: a chave secreta vazia mantém a que já estava salva. */
export async function salvarConfigDoDirect({ respostas, comentarios, appSecret } = {}) {
  const atual = await configDoDirect();
  const segredo = String(appSecret ?? "").trim();
  await db.gravarConfig(CHAVE_DIRECT, {
    ...atual,
    ...(respostas !== undefined ? { respostas: Boolean(respostas) } : {}),
    ...(comentarios !== undefined ? { comentarios: Boolean(comentarios) } : {}),
    ...(segredo ? { appSecret: segredo } : {}),
  });
  return configDoDirect();
}

/** Divide o texto em partes que cabem num direct, sem cortar no meio de uma frase quando dá. */
export function partesDoDirect(texto, max = MAX_BYTES_DIRECT) {
  const cabe = (t) => Buffer.byteLength(t) <= max;
  const partes = [];
  let atual = "";
  const juntar = (pedaco, sep) => {
    const junto = atual ? `${atual}${sep}${pedaco}` : pedaco;
    if (cabe(junto)) return (atual = junto);
    if (atual) partes.push(atual);
    atual = pedaco;
  };
  for (const paragrafo of String(texto ?? "").trim().split(/\n{2,}/)) {
    if (cabe(paragrafo)) { juntar(paragrafo, "\n\n"); continue; }
    let sep = "\n\n"; // a primeira frase do parágrafo fica separada do parágrafo anterior
    for (const frase of paragrafo.split(/(?<=[.!?])\s+|\n/)) {
      let resto = frase;
      // Frase sozinha maior que o limite (raro): corta nas palavras.
      while (!cabe(resto)) {
        let corte = resto.length;
        while (!cabe(resto.slice(0, corte))) corte = resto.lastIndexOf(" ", corte - 1) > 0 ? resto.lastIndexOf(" ", corte - 1) : corte - 1;
        juntar(resto.slice(0, corte).trim(), sep);
        resto = resto.slice(corte).trim();
        sep = " ";
      }
      if (resto) juntar(resto, sep);
      sep = " ";
    }
  }
  if (atual) partes.push(atual);
  return partes;
}

// Pela conta do Instagram (Instagram Login) ou pela página ligada a ela (token do Facebook).
const caminhoDasMensagens = (c) => (c.host === "graph.instagram.com" ? `${c.igId}/messages` : "me/messages");

/** Explica os erros mais comuns do direct em português. */
function explicarErroDoDirect(e) {
  if (e.subcodigo === 2534022 || /outside of allowed window/i.test(e.message)) {
    return new Error("A Meta só deixa responder no direct até 24 horas depois da última mensagem da pessoa.");
  }
  if ([3, 10, 200, 230].includes(e.codigo) || /permission|capability/i.test(e.message)) {
    return new Error("O Instagram recusou o envio por falta de permissão: gere o token com instagram_manage_messages e confira se o app já foi aprovado pela Meta para mensagens.");
  }
  if (e.codigo === 100 && /comment/i.test(e.message)) return new Error("Esse comentário já recebeu a mensagem privada, ou passou de 7 dias.");
  return e;
}

/**
 * Manda um direct. Com `comentarioId` vai como mensagem privada ao comentário (só uma é permitida,
 * então texto longo vai só a primeira parte). Retorna o id da primeira mensagem.
 */
export async function enviarDirect({ para, comentarioId = null, texto, conta = null }) {
  const c = await lerConexao(conta ?? (await db.lerEstado(chaveDoPerfilDoContato(para))));
  if (!c?.token) throw new Error("Instagram desconectado: conecte a conta em Conteúdo");
  const partes = partesDoDirect(texto);
  if (!partes.length) throw new Error("Mensagem vazia");
  let primeiro = null;
  for (const [i, parte] of (comentarioId ? partes.slice(0, 1) : partes).entries()) {
    const recipient = comentarioId && i === 0 ? { comment_id: comentarioId } : { id: para };
    const r = await chamar(c, "POST", caminhoDasMensagens(c), { recipient, message: { text: parte } }).catch((e) => {
      throw explicarErroDoDirect(e);
    });
    primeiro ??= r.message_id ?? null;
  }
  return primeiro;
}

/** Nome e @ de quem escreveu no direct (a Meta só mostra de quem já falou com a conta). */
export async function perfilDoContato(id, conta = null) {
  const c = await lerConexao(conta);
  if (!c?.token) return null;
  const p = await chamar(c, "GET", id, { fields: "name,username" }).catch(() => null);
  return p && { nome: p.name ?? "", usuario: p.username ?? "" };
}

/** Resposta pública ao comentário (ex.: "Te mandei no direct!"). */
export async function responderComentario(comentarioId, texto, conta = null) {
  const c = await lerConexao(conta);
  if (!c?.token) throw new Error("Instagram desconectado");
  return (await chamar(c, "POST", `${comentarioId}/replies`, { message: texto })).id;
}

/**
 * Os comentários recentes nos posts da conta, lidos direto da API. Serve enquanto a Meta não entrega
 * os comentários pelo webhook, o que exige a empresa verificada e a aprovação do app.
 */
export async function comentariosRecentes({ posts = 12, conta = null } = {}) {
  const c = await lerConexao(conta);
  if (!c?.token) return [];
  const { data: midias = [] } = await chamar(c, "GET", `${c.igId}/media`, {
    fields: "id,comments_count,comments{id,text,username,timestamp,from,parent_id}", limit: posts,
  });
  return midias.flatMap((m) => (m.comments?.data ?? []).map((x) => ({
    id: String(x.id), de: String(x.from?.id ?? ""), usuario: x.from?.username ?? x.username ?? "", texto: x.text ?? "",
    midiaId: String(m.id), resposta: Boolean(x.parent_id), quando: x.timestamp, conta: String(c.igId),
  })));
}

/** Baixa um anexo do direct (ex.: áudio, para transcrever). */
export async function baixarAnexo(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`não foi possível baixar o anexo (${r.status})`);
  return { audio: Buffer.from(await r.arrayBuffer()), mimetype: r.headers.get("content-type") || "audio/mp4" };
}

/**
 * O token consegue ler o direct? Lê a última conversa: sem a permissão de mensagens (ou sem a
 * aprovação da Meta), a Meta recusa e o painel mostra o motivo.
 */
export async function statusDoDirect() {
  const c = await lerConexao();
  if (!c?.token) return { conectado: false };
  try {
    await chamar(c, "GET", "me/conversations", { platform: "instagram", limit: 1 });
    return { conectado: true, usuario: c.usuario, permissao: true };
  } catch (e) {
    return { conectado: true, usuario: c.usuario, permissao: false, erro: explicarErroDoDirect(e).message.replace(/^Instagram: /, "") };
  }
}

/**
 * Pede para a Meta mandar os eventos desta conta para o webhook do app. Pelo Instagram Login é a
 * própria conta que assina; pelo Facebook, a página ligada a ela (qualquer campo serve).
 */
/** Cadastra o webhook do Instagram no próprio app da Meta: sem isso, a Meta não sabe para onde mandar os eventos. */
export async function assinarWebhookDoApp(callbackUrl) {
  const c = await lerConexao();
  if (!c?.token) throw new Error("Instagram desconectado");
  const { appSecret, verifyToken } = await configDoDirect();
  if (!appSecret) throw new Error("Falta a chave secreta do app");
  const { id } = await chamar(c, "GET", "app");
  await chamar({ host: "graph.facebook.com", token: `${id}|${appSecret}` }, "POST", `${id}/subscriptions`, {
    object: "instagram", callback_url: callbackUrl, fields: "comments,messages", verify_token: verifyToken, include_values: true,
  });
  return true;
}

export async function assinarWebhookDoDirect() {
  const [principal, ...outras] = await todasAsConexoes();
  if (!principal) throw new Error("Instagram desconectado");
  // Os outros perfis tentam também; um que falhe não impede o principal.
  for (const c of outras) await assinarUmPerfil(c).catch((e) => console.error(`Instagram @${c.usuario}: ${e.message}`));
  return assinarUmPerfil(principal);
}

async function assinarUmPerfil(c) {
  const campos = c.host === "graph.instagram.com" ? ["messages,comments"] : ["messages", "feed"];
  let ultimoErro;
  for (const subscribed_fields of campos) {
    try {
      await chamar(c, "POST", "me/subscribed_apps", { subscribed_fields });
      return true;
    } catch (e) {
      ultimoErro = e;
    }
  }
  throw ultimoErro;
}

// ---------- Insights ----------

/** Leitura na API do Instagram com a conta conectada (ex.: os posts e os insights). */
export async function lerDaApi(caminho, params = {}) {
  const c = await lerConexao();
  if (!c?.token) throw new Error("Instagram desconectado");
  return chamar(c, "GET", caminho.replace("{conta}", c.igId), params);
}
