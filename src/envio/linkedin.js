import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Publicação na página da empresa no LinkedIn pela API oficial (Community Management API).
// Vídeo vai pela Videos API e carrossel como documento em PDF (a Documents API), que é o formato
// de "passar as páginas" do LinkedIn: o carrossel de verdade da API só existe para anúncios.
const API = "https://api.linkedin.com/rest";
const OAUTH = "https://www.linkedin.com/oauth/v2";
// Publicar na página, e descobrir quais páginas a pessoa administra.
const ESCOPOS = "w_organization_social rw_organization_admin";
const ESTADO_VALE_MS = 15 * 60_000;
// O token vale 60 dias. Renova uma semana antes; sem renovação automática, avisa dez dias antes.
const RENOVAR_ANTES_MS = 7 * 86_400_000;
const AVISAR_ANTES_MS = 10 * 86_400_000;
// Limite do texto do post no LinkedIn.
export const MAX_TEXTO = 3000;

/**
 * Versão da API (AAAAMM): 3 meses atrás, para nunca cair numa que ainda não saiu nem numa aposentada
 * (cada uma dura cerca de 1 ano). O LinkedIn não lança versão em dezembro.
 */
export function versaoDaApi(agora = new Date()) {
  const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 3, 1));
  const mes = d.getUTCMonth() + 1;
  return `${d.getUTCFullYear()}${String(mes === 12 ? 11 : mes).padStart(2, "0")}`;
}

/** Conexão salva (com os segredos) ou null. Os segredos nunca saem do servidor. */
export const lerConexao = async () => (await db.lerConfig("linkedin")) ?? {};

export const enderecoDeRetorno = () => `${config.painel.urlPublica}/api/linkedin/retorno`;

/** O que o painel pode ver da conexão. */
export async function statusDaConexao() {
  const c = await lerConexao();
  return {
    appDefinido: Boolean(c.clientId && c.clientSecret),
    clientId: c.clientId ?? "",
    retorno: enderecoDeRetorno(),
    conectado: Boolean(c.token && c.organizacao),
    entrou: Boolean(c.token),
    pagina: c.pagina ?? null,
    organizacao: c.organizacao ?? null,
    paginas: c.paginas ?? [],
    conectadoEm: c.conectadoEm ?? null,
    expiraEm: c.expiraEm ?? null,
    renovaSozinho: Boolean(c.refreshToken),
    erro: c.erro ?? null,
  };
}

export async function salvarApp({ clientId, clientSecret }) {
  const c = await lerConexao();
  const id = String(clientId ?? "").trim();
  const segredo = String(clientSecret ?? "").trim();
  if (!id) throw new Error("Cole o Client ID do app do LinkedIn");
  if (!segredo && !c.clientSecret) throw new Error("Cole o Client Secret do app do LinkedIn");
  await db.gravarConfig("linkedin", { ...c, clientId: id, clientSecret: segredo || c.clientSecret, erro: null });
}

export const desconectarLinkedin = async () => {
  const { clientId, clientSecret } = await lerConexao();
  await db.gravarConfig("linkedin", { clientId, clientSecret });
};

/** O link que leva para o login do LinkedIn. O `state` confere, na volta, que o pedido partiu daqui. */
export async function urlDeEntrada(agora = new Date()) {
  const c = await lerConexao();
  if (!c.clientId || !c.clientSecret) throw new Error("Salve o Client ID e o Client Secret primeiro");
  const estado = crypto.randomBytes(24).toString("hex");
  await db.gravarConfig("linkedin", { ...c, estado, estadoEm: agora.toISOString(), erro: null });
  const url = new URL(`${OAUTH}/authorization`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: c.clientId, redirect_uri: enderecoDeRetorno(), state: estado, scope: ESCOPOS })) url.searchParams.set(k, v);
  return url.toString();
}

async function pedirToken(c, campos) {
  const r = await fetch(`${OAUTH}/accessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...campos }),
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || !corpo.access_token) throw new Error(`LinkedIn: ${corpo.error_description || corpo.message || `respondeu ${r.status}`}`);
  return corpo;
}

const camposDoToken = (t, agora) => ({
  token: t.access_token,
  expiraEm: new Date(+agora + (t.expires_in ?? 5_184_000) * 1000).toISOString(),
  // Nem todo app recebe a renovação automática: o LinkedIn libera para alguns.
  ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
});

const iguais = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** A volta do login: troca o código pelo token e escolhe a página (se houver só uma). */
export async function concluirEntrada({ code, state, error_description: recusa, error }, agora = new Date()) {
  const c = await lerConexao();
  // Sem o `state` certo a chamada não partiu do painel: nada do que veio nela é usado nem gravado.
  if (!c.estado || !iguais(state, c.estado) || agora - new Date(c.estadoEm) > ESTADO_VALE_MS) throw new Error("Esse login expirou. Clique em Entrar com o LinkedIn de novo.");
  const { estado, estadoEm, ...semEstado } = c;
  try {
    // O LinkedIn recusa as permissões enquanto não aprovar o produto Community Management API para o app.
    if (error === "unauthorized_scope_error" || /scope/i.test(recusa ?? "")) throw new Error("O LinkedIn ainda não liberou a publicação para este app: falta ele aprovar o pedido do Community Management API. O Client ID e o Client Secret continuam salvos: quando a aprovação chegar por e-mail, é só entrar de novo.");
    if (error || !code) throw new Error(`LinkedIn: ${recusa || error || "login cancelado"}`);
    const t = await pedirToken(c, { grant_type: "authorization_code", code, redirect_uri: enderecoDeRetorno() });
    const novo = { ...semEstado, ...camposDoToken(t, agora), conectadoEm: agora.toISOString(), erro: null };
    const paginas = await paginasAdministradas(novo).catch(() => []);
    const atual = paginas.find((p) => p.urn === c.organizacao) ?? (paginas.length === 1 ? paginas[0] : null);
    await db.gravarConfig("linkedin", { ...novo, paginas, organizacao: atual?.urn ?? null, pagina: atual?.nome ?? null });
  } catch (e) {
    await db.gravarConfig("linkedin", { ...semEstado, erro: e.message });
    throw e;
  }
}

/** Aceita o link da página de administrador, o número ou o URN. Retorna a página escolhida. */
export async function escolherPagina(valor) {
  const c = await lerConexao();
  if (!c.token) throw new Error("Entre com o LinkedIn primeiro");
  const id = String(valor ?? "").match(/(\d{3,})/)?.[1];
  if (!id) throw new Error("Escolha a página ou cole o número dela (o link de administrador da página: linkedin.com/company/NÚMERO/admin)");
  const urn = `urn:li:organization:${id}`;
  const nome = c.paginas?.find((p) => p.urn === urn)?.nome ?? (await nomeDaOrganizacao(c, id)) ?? `Página ${id}`;
  await db.gravarConfig("linkedin", { ...c, organizacao: urn, pagina: nome, erro: null });
  return { urn, nome };
}

async function chamar(conexao, metodo, caminho, corpo, { agora = new Date() } = {}) {
  const r = await fetch(`${API}/${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${conexao.token}`,
      "Linkedin-Version": versaoDaApi(agora),
      "X-Restli-Protocol-Version": "2.0.0",
      ...(corpo ? { "Content-Type": "application/json" } : {}),
    },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) throw new Error("LinkedIn: o acesso venceu ou foi revogado. Entre com o LinkedIn de novo no painel.");
    throw new Error(`LinkedIn: ${dados.message || `respondeu ${r.status}`}`);
  }
  return { dados, id: r.headers.get("x-restli-id") };
}

const nomeDaOrganizacao = async (c, id) => (await chamar(c, "GET", `organizations/${id}`).catch(() => ({ dados: {} }))).dados.localizedName ?? null;

// Papéis que podem publicar na página.
const PAPEIS_QUE_POSTAM = ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"];

/** As páginas de empresa que quem entrou pode publicar: [{ urn, nome }]. */
export async function paginasAdministradas(conexao) {
  const { dados } = await chamar(conexao, "GET", "organizationAcls?q=roleAssignee&state=APPROVED&count=50");
  const urns = [...new Set((dados.elements ?? [])
    .filter((e) => PAPEIS_QUE_POSTAM.includes(e.role))
    .map((e) => e.organization ?? e.organizationTarget)
    .filter((u) => /^urn:li:organization:\d+$/.test(u ?? "")))];
  return Promise.all(urns.map(async (urn) => {
    const id = urn.split(":").at(-1);
    return { urn, nome: (await nomeDaOrganizacao(conexao, id)) ?? `Página ${id}` };
  }));
}

/**
 * Mantém o acesso em dia. Com renovação automática, renova uma semana antes de vencer. Sem ela,
 * retorna { avisar: dias } para o sistema pedir um novo login por e-mail.
 */
export async function renovarTokenSePreciso(agora = new Date()) {
  const c = await lerConexao();
  if (!c.token || !c.expiraEm) return {};
  const falta = new Date(c.expiraEm) - agora;
  if (c.refreshToken && falta < RENOVAR_ANTES_MS) {
    const t = await pedirToken(c, { grant_type: "refresh_token", refresh_token: c.refreshToken });
    await db.gravarConfig("linkedin", { ...c, ...camposDoToken(t, agora) });
    return { renovado: true };
  }
  return falta < AVISAR_ANTES_MS ? { avisar: Math.max(0, Math.ceil(falta / 86_400_000)) } : {};
}

/** Sobe o vídeo em partes, como o LinkedIn pede, e retorna o URN dele. */
export async function enviarVideo(conexao, dados) {
  const { dados: inicio } = await chamar(conexao, "POST", "videos?action=initializeUpload", {
    initializeUploadRequest: { owner: conexao.organizacao, fileSizeBytes: dados.length, uploadCaptions: false, uploadThumbnail: false },
  });
  const { video, uploadInstructions: partes, uploadToken } = inicio.value;
  const etiquetas = [];
  for (const p of partes) {
    const r = await fetch(p.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: dados.subarray(p.firstByte, p.lastByte + 1) });
    if (!r.ok) throw new Error(`LinkedIn: não aceitou o envio do vídeo (respondeu ${r.status})`);
    etiquetas.push(String(r.headers.get("etag") ?? "").replace(/^"|"$/g, ""));
  }
  await chamar(conexao, "POST", "videos?action=finalizeUpload", { finalizeUploadRequest: { video, uploadToken: uploadToken ?? "", uploadedPartIds: etiquetas } });
  return video;
}

/** Sobe o PDF do carrossel e retorna o URN dele. */
export async function enviarDocumento(conexao, dados) {
  const { dados: inicio } = await chamar(conexao, "POST", "documents?action=initializeUpload", { initializeUploadRequest: { owner: conexao.organizacao } });
  const { uploadUrl, document } = inicio.value;
  const r = await fetch(uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${conexao.token}`, "Content-Type": "application/octet-stream" }, body: dados });
  if (!r.ok) throw new Error(`LinkedIn: não aceitou o envio do documento (respondeu ${r.status})`);
  return document;
}

/** O LinkedIn ainda está processando a mídia? { codigo: AVAILABLE | PROCESSING | ..., detalhe }. */
export async function statusDaMidia(conexao, urn) {
  const tipo = urn.startsWith("urn:li:video:") ? "videos" : "documents";
  const { dados } = await chamar(conexao, "GET", `${tipo}/${encodeURIComponent(urn)}`);
  return { codigo: dados.status, detalhe: dados.processingFailureReason ?? "" };
}

/**
 * O texto do post vai no formato "little" do LinkedIn: caractere reservado sem barra corta o post
 * ali mesmo (um parêntese basta). Só a hashtag de verdade fica como está.
 */
export const escaparTexto = (texto) => String(texto).replace(/(^|\s)#[\p{L}\p{N}]+|[|{}@[\]()<>#\\*_~]/gu, (m) => (/#[\p{L}\p{N}]+$/u.test(m) ? m : `\\${m}`));

/** Publica na página. `midia` é { id, titulo }. Retorna { id, link }. */
export async function publicarPost(conexao, { texto, midia }) {
  const { id } = await chamar(conexao, "POST", "posts", {
    author: conexao.organizacao,
    commentary: escaparTexto(texto),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media: { title: midia.titulo, id: midia.id } },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  });
  if (!id) throw new Error("LinkedIn: publicou, mas não devolveu o endereço do post");
  return { id, link: `https://www.linkedin.com/feed/update/${id}/` };
}
