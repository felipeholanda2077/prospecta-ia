import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Publicação no TikTok pela API oficial (Content Posting API). Há dois jeitos de sair:
// "direto" publica sozinho, mas enquanto o TikTok não auditar o app ele só aceita conta privada e vídeo
// que só o dono vê; "rascunho" manda o vídeo para a caixa de entrada do app do TikTok, e o dono toca para publicar.
const API = "https://open.tiktokapis.com/v2";
const ENTRADA = "https://www.tiktok.com/v2/auth/authorize/";
const ESCOPOS = { direto: "user.info.basic,video.publish", rascunho: "user.info.basic,video.upload" };
const ESCOPO_DO_MODO = { direto: "video.publish", rascunho: "video.upload" };
export const MODOS = Object.keys(ESCOPOS);
export const PRIVACIDADES = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
const ESTADO_VALE_MS = 15 * 60_000;
// O acesso vale 24 horas e a renovação, 1 ano. Renova 2 horas antes; avisa 10 dias antes de a renovação vencer.
const RENOVAR_ANTES_MS = 2 * 3_600_000;
const AVISAR_ANTES_MS = 10 * 86_400_000;
const TEMPO_MS = 30_000;
// Limite da legenda no TikTok.
export const MAX_LEGENDA = 2200;

// Erros que não melhoram tentando de novo: o post para de tentar e o motivo aparece nele.
const MENSAGENS = {
  unaudited_client_can_only_post_to_private_accounts: "o TikTok só deixa este app postar em conta privada enquanto a auditoria dele não for aprovada. Deixe a conta privada e escolha \"Só eu\", ou mude para \"Mandar como rascunho\" em Configurações.",
  scope_not_authorized: "o TikTok não deu a permissão de publicar a este acesso. Confira os produtos do app e entre com o TikTok de novo no painel.",
  privacy_level_option_mismatch: "a opção de quem pode ver não vale mais para esta conta. Escolha de novo em Configurações.",
  spam_risk_too_many_posts: "a conta chegou ao limite de posts do dia no TikTok. O próximo horário tenta de novo.",
  spam_risk_user_banned_from_posting: "o TikTok bloqueou esta conta de publicar. Confira as notificações no app do TikTok.",
  spam_risk_too_many_pending_share: "já há 5 rascunhos esperando no app do TikTok, o máximo em 24 horas. Publique ou apague os que estão lá.",
  reached_active_user_cap: "este app chegou ao limite diário de contas publicando no TikTok.",
  url_ownership_unverified: "o TikTok pediu a verificação do endereço do vídeo.",
  auth_removed: "o acesso do sistema foi removido no TikTok. Entre com o TikTok de novo no painel.",
  spam_risk_text: "o TikTok considerou a legenda arriscada e recusou o post.",
  spam_risk: "o TikTok considerou o post arriscado e recusou.",
  file_format_check_failed: "o TikTok não aceitou o formato do vídeo.",
  duration_check_failed: "o TikTok não aceitou a duração do vídeo.",
  frame_rate_check_failed: "o TikTok não aceitou os quadros por segundo do vídeo.",
  picture_size_check_failed: "o TikTok não aceitou o tamanho do vídeo.",
  publish_cancelled: "a publicação foi cancelada.",
};
// Estes valem a pena repetir: passam sozinhos ou a próxima tentativa já pega um acesso novo.
const PASSAGEIROS = { access_token_invalid: "o acesso venceu ou foi revogado. Se continuar, entre com o TikTok de novo no painel.", rate_limit_exceeded: "muitos pedidos ao mesmo tempo.", internal: "problema temporário no próprio TikTok." };

export class ErroDoTiktok extends Error {
  constructor(codigo, detalhe = "") {
    super(MENSAGENS[codigo] ?? PASSAGEIROS[codigo] ?? (detalhe || codigo));
    this.codigo = codigo;
    // Código desconhecido (invalid_param, erro do servidor) tenta de novo até o limite de tentativas.
    this.definitivo = codigo in MENSAGENS;
  }
}

/** Conexão salva (com os segredos). Os segredos nunca saem do servidor. */
export const lerConexao = async () => (await db.lerConfig("tiktok")) ?? {};

export const enderecoDeRetorno = () => `${config.painel.urlPublica}/api/tiktok/retorno`;

const modoDe = (c) => (MODOS.includes(c.modo) ? c.modo : "direto");
const temEscopo = (c) => String(c.escopos ?? "").split(/[,\s]+/).includes(ESCOPO_DO_MODO[modoDe(c)]);

/** O que o painel pode ver da conexão. */
export async function statusDaConexao() {
  const c = await lerConexao();
  const modo = modoDe(c);
  return {
    appDefinido: Boolean(c.clientKey && c.clientSecret),
    clientKey: c.clientKey ?? "",
    retorno: enderecoDeRetorno(),
    entrou: Boolean(c.token),
    // Pronto para sair sozinho: no direto o TikTok exige que a pessoa tenha escolhido quem pode ver.
    conectado: Boolean(c.token && temEscopo(c) && (modo === "rascunho" || c.privacidade)),
    faltaPermissao: Boolean(c.token && !temEscopo(c)),
    modo,
    usuario: c.usuario ?? null,
    apelido: c.apelido ?? null,
    privacidade: c.privacidade ?? null,
    comentarios: Boolean(c.comentarios),
    dueto: Boolean(c.dueto),
    costura: Boolean(c.costura),
    automatico: Boolean(c.automatico),
    conectadoEm: c.conectadoEm ?? null,
    renovacaoAte: c.refreshExpiraEm ?? null,
    erro: c.erro ?? null,
  };
}

export async function salvarApp({ clientKey, clientSecret }) {
  const c = await lerConexao();
  const chave = String(clientKey ?? "").trim();
  const segredo = String(clientSecret ?? "").trim();
  if (!chave) throw new Error("Cole o Client Key do app do TikTok");
  if (!segredo && !c.clientSecret) throw new Error("Cole o Client Secret do app do TikTok");
  await db.gravarConfig("tiktok", { ...c, clientKey: chave, clientSecret: segredo || c.clientSecret, erro: null });
}

/** Como os vídeos saem. O TikTok exige escolha da própria pessoa: nada aqui vem marcado por padrão. */
export async function salvarPublicacao({ modo, privacidade, comentarios, dueto, costura, automatico }) {
  const c = await lerConexao();
  if (!MODOS.includes(modo)) throw new Error("Escolha como os vídeos saem no TikTok");
  if (privacidade && !PRIVACIDADES.includes(privacidade)) throw new Error("Escolha quem pode ver os vídeos");
  if (automatico && modo === "direto" && !privacidade) throw new Error("Escolha quem pode ver os vídeos antes de ligar o envio automático");
  await db.gravarConfig("tiktok", { ...c, modo, privacidade: privacidade || null, comentarios: Boolean(comentarios), dueto: Boolean(dueto), costura: Boolean(costura), automatico: Boolean(automatico), erro: null });
}

export const desconectarTiktok = async () => {
  const { clientKey, clientSecret } = await lerConexao();
  await db.gravarConfig("tiktok", { clientKey, clientSecret });
};

/** O link que leva para o login do TikTok. O `state` confere, na volta, que o pedido partiu daqui. */
export async function urlDeEntrada(agora = new Date()) {
  const c = await lerConexao();
  if (!c.clientKey || !c.clientSecret) throw new Error("Salve o Client Key e o Client Secret primeiro");
  const estado = crypto.randomBytes(24).toString("hex");
  await db.gravarConfig("tiktok", { ...c, estado, estadoEm: agora.toISOString(), erro: null });
  const url = new URL(ENTRADA);
  for (const [k, v] of Object.entries({ client_key: c.clientKey, response_type: "code", scope: ESCOPOS[modoDe(c)], redirect_uri: enderecoDeRetorno(), state: estado })) url.searchParams.set(k, v);
  return url.toString();
}

async function pedirToken(c, campos) {
  const r = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: c.clientKey, client_secret: c.clientSecret, ...campos }),
    signal: AbortSignal.timeout(TEMPO_MS),
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || !corpo.access_token) throw new Error(`TikTok: ${corpo.error_description || corpo.error || `respondeu ${r.status}`}`);
  return corpo;
}

const camposDoToken = (t, agora) => ({
  token: t.access_token,
  expiraEm: new Date(+agora + (t.expires_in ?? 86_400) * 1000).toISOString(),
  refreshToken: t.refresh_token,
  refreshExpiraEm: new Date(+agora + (t.refresh_expires_in ?? 31_536_000) * 1000).toISOString(),
  openId: t.open_id,
  escopos: t.scope ?? "",
});

const iguais = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** A volta do login: troca o código pelo acesso e guarda o nome da conta. */
export async function concluirEntrada({ code, state, error, error_description: recusa }, agora = new Date()) {
  const c = await lerConexao();
  // Sem o `state` certo a chamada não partiu do painel: nada do que veio nela é usado nem gravado.
  if (!c.estado || !iguais(state, c.estado) || agora - new Date(c.estadoEm) > ESTADO_VALE_MS) throw new Error("Esse login expirou. Clique em Entrar com o TikTok de novo.");
  const { estado, estadoEm, ...semEstado } = c;
  try {
    if (error || !code) throw new Error(`TikTok: ${recusa || error || "login cancelado"}`);
    const t = await pedirToken(c, { grant_type: "authorization_code", code, redirect_uri: enderecoDeRetorno() });
    const novo = { ...semEstado, ...camposDoToken(t, agora), conectadoEm: agora.toISOString(), erro: null };
    if (!temEscopo(novo)) novo.erro = `O TikTok não deu a permissão ${ESCOPO_DO_MODO[modoDe(novo)]} a este acesso. Ative o produto Content Posting API no app e entre de novo.`;
    const { apelido, usuario } = await contaDoAcesso(novo).catch(() => ({}));
    await db.gravarConfig("tiktok", { ...novo, apelido: apelido ?? null, usuario: usuario ?? null });
  } catch (e) {
    await db.gravarConfig("tiktok", { ...semEstado, erro: e.message });
    throw e;
  }
}

async function chamar(conexao, metodo, caminho, corpo) {
  const r = await fetch(`${API}/${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${conexao.token}`, ...(metodo === "POST" ? { "Content-Type": "application/json; charset=UTF-8" } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(TEMPO_MS),
  });
  const texto = await r.text();
  let d = {};
  try {
    d = JSON.parse(texto);
  } catch {
    // Resposta que não é JSON cai no erro abaixo.
  }
  const codigo = d.error?.code;
  if (!r.ok || (codigo && codigo !== "ok")) throw new ErroDoTiktok(codigo ?? `http_${r.status}`, d.error?.message || `respondeu ${r.status}`);
  return { dados: d.data ?? {}, texto };
}

/** O nome e o usuário da conta que entrou. O @ só vem junto da permissão de publicar direto. */
async function contaDoAcesso(conexao) {
  const { dados } = await chamar(conexao, "GET", "user/info/?fields=open_id,display_name");
  const apelido = dados.user?.display_name ?? null;
  if (modoDe(conexao) !== "direto") return { apelido };
  const info = await criador(conexao);
  return { apelido: info.creator_nickname ?? apelido, usuario: info.creator_username ?? null };
}

/** O que a conta permite agora: quem pode ver, e se comentários, duetos e costuras estão bloqueados nela. */
export const criador = async (conexao) => (await chamar(conexao, "POST", "post/publish/creator_info/query/")).dados;

/**
 * Mantém o acesso em dia: renova 2 horas antes de vencer. O TikTok pode trocar a chave de renovação
 * a cada uso, e a antiga deixa de valer; por isso a trava impede duas renovações ao mesmo tempo.
 */
export async function renovarTokenSePreciso(agora = new Date()) {
  const inicio = await lerConexao();
  if (!inicio.token || !inicio.refreshToken) return {};
  const fimDaRenovacao = inicio.refreshExpiraEm ? new Date(inicio.refreshExpiraEm) - agora : Infinity;
  const avisar = fimDaRenovacao < AVISAR_ANTES_MS ? { avisar: Math.max(0, Math.ceil(fimDaRenovacao / 86_400_000)) } : {};
  if (new Date(inicio.expiraEm) - agora >= RENOVAR_ANTES_MS) return avisar;
  if (!(await db.travar("tiktok_token", 60_000))) return avisar;
  try {
    const c = await lerConexao();
    if (new Date(c.expiraEm) - agora >= RENOVAR_ANTES_MS) return avisar;
    const t = await pedirToken(c, { grant_type: "refresh_token", refresh_token: c.refreshToken }).catch(async (e) => {
      await db.gravarConfig("tiktok", { ...c, erro: `Não foi possível renovar o acesso. Entre com o TikTok de novo. (${e.message})` });
      throw e;
    });
    await db.gravarConfig("tiktok", { ...c, ...camposDoToken(t, agora), refreshToken: t.refresh_token ?? c.refreshToken, escopos: t.scope ?? c.escopos, erro: null });
    return { renovado: true };
  } finally {
    await db.destravar("tiktok_token");
  }
}

/**
 * Abre a publicação e devolve { publishId, uploadUrl }. O vídeo do Reels tem menos de 5 MB, e nesse
 * tamanho o TikTok exige o arquivo inteiro numa parte só.
 */
export async function iniciarPublicacao(conexao, { tamanho, legenda, info }) {
  const origem = { source: "FILE_UPLOAD", video_size: tamanho, chunk_size: tamanho, total_chunk_count: 1 };
  const { dados } = modoDe(conexao) === "rascunho"
    ? await chamar(conexao, "POST", "post/publish/inbox/video/init/", { source_info: origem })
    : await chamar(conexao, "POST", "post/publish/video/init/", {
      post_info: {
        title: legenda.slice(0, MAX_LEGENDA),
        privacy_level: conexao.privacidade,
        disable_comment: !conexao.comentarios || Boolean(info?.comment_disabled),
        disable_duet: !conexao.dueto || Boolean(info?.duet_disabled),
        disable_stitch: !conexao.costura || Boolean(info?.stitch_disabled),
        // Os vídeos divulgam a própria FluxDeck ("sua marca") e têm voz e, às vezes, avatar feitos com IA.
        brand_organic_toggle: true,
        brand_content_toggle: false,
        is_aigc: true,
      },
      source_info: origem,
    });
  if (!dados.publish_id || !dados.upload_url) throw new ErroDoTiktok("sem_upload", "não devolveu o endereço para enviar o vídeo");
  return { publishId: dados.publish_id, uploadUrl: dados.upload_url };
}

/** Sobe o vídeo inteiro no endereço que o TikTok devolveu. */
export async function enviarVideo(uploadUrl, dados) {
  const r = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${dados.length - 1}/${dados.length}` },
    body: dados,
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new ErroDoTiktok(`envio_${r.status}`, `não aceitou o envio do vídeo (respondeu ${r.status})`);
}

/**
 * Em que pé está a publicação: { codigo, motivo, postId }. O id do post é um número grande demais
 * para o JSON do JavaScript, então é lido direto do texto da resposta. Ele só vem com o post público e aprovado.
 */
export async function statusDaPublicacao(conexao, publishId) {
  const { dados, texto } = await chamar(conexao, "POST", "post/publish/status/fetch/", { publish_id: publishId });
  return { codigo: dados.status, motivo: dados.fail_reason ?? "", postId: texto.match(/"public\w*available_post_id"\s*:\s*\[\s*"?(\d+)/)?.[1] ?? null };
}

export const linkDoPost = (usuario, postId) => (usuario ? (postId ? `https://www.tiktok.com/@${usuario}/video/${postId}` : `https://www.tiktok.com/@${usuario}`) : null);
