import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";

// A conta de vendedor no Mercado Livre, pela API oficial. O acesso dura 6 horas e a renovação só pode ser
// usada uma vez: uma trava impede que duas execuções renovem juntas, o que derrubaria a conexão.
const API = "https://api.mercadolibre.com";
const LOGIN = "https://auth.mercadolivre.com.br/authorization";
const CONFIG = "mercadolivre";
const ESTADO_VALE_MS = 15 * 60_000;
const RENOVAR_ANTES_MS = 5 * 60_000;
export const MAX_RESPOSTA = 2000;

const ler = async () => (await db.lerConfig(CONFIG)) ?? {};
const gravar = (c) => db.gravarConfig(CONFIG, c);

export const enderecoDeRetorno = () => `${config.painel.urlPublica}/api/mercadolivre/retorno`;
export const enderecoDeAvisos = () => `${config.painel.urlPublica}/webhooks/mercadolivre`;

/** O que o painel pode ver. Nada de segredo sai daqui. */
export async function statusDaConexao() {
  const c = await ler();
  return {
    appDefinido: Boolean(c.clientId && c.clientSecret),
    clientId: c.clientId ?? "",
    retorno: enderecoDeRetorno(),
    avisos: enderecoDeAvisos(),
    conectado: Boolean(c.token),
    apelido: c.apelido ?? null,
    vendedorId: c.vendedorId ?? null,
    conectadoEm: c.conectadoEm ?? null,
    erro: c.erro ?? null,
  };
}

export async function salvarApp({ clientId, clientSecret }) {
  const c = await ler();
  const id = String(clientId ?? "").trim();
  const segredo = String(clientSecret ?? "").trim();
  if (!id) throw new Error("Cole o App ID do Mercado Livre");
  if (!segredo && !c.clientSecret) throw new Error("Cole a Secret Key do Mercado Livre");
  await gravar({ ...c, clientId: id, clientSecret: segredo ? cifrar(segredo) : c.clientSecret, erro: null });
}

export const desconectar = async () => {
  const { clientId, clientSecret } = await ler();
  await gravar({ clientId, clientSecret });
};

/** O link do login do Mercado Livre. O `state` confere, na volta, que o pedido partiu daqui. */
export async function urlDeEntrada(agora = new Date()) {
  const c = await ler();
  if (!c.clientId || !c.clientSecret) throw new Error("Salve o App ID e a Secret Key primeiro");
  const estado = crypto.randomBytes(24).toString("hex");
  await gravar({ ...c, estado, estadoEm: agora.toISOString(), erro: null });
  const url = new URL(LOGIN);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: c.clientId, redirect_uri: enderecoDeRetorno(), state: estado })) url.searchParams.set(k, v);
  return url.toString();
}

const MENSAGENS_DE_TOKEN = {
  invalid_client: "o App ID ou a Secret Key estão errados",
  invalid_grant: "o acesso venceu ou foi revogado, ou a conta tem dados pendentes de validação",
  invalid_operator_user_id: "entre com a conta principal da loja, não com um colaborador",
};

async function pedirToken(c, campos) {
  const segredo = decifrar(c.clientSecret);
  if (!segredo) throw new Error("Mercado Livre: cole a Secret Key de novo (a senha do painel mudou)");
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: segredo, ...campos }),
    signal: AbortSignal.timeout(20_000),
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || !corpo.access_token) throw new Error(`Mercado Livre: ${MENSAGENS_DE_TOKEN[corpo.error] ?? corpo.message ?? `respondeu ${r.status}`}`);
  return corpo;
}

const camposDoToken = (t, agora) => ({
  token: cifrar(t.access_token),
  renovacao: cifrar(t.refresh_token),
  expiraEm: new Date(+agora + (t.expires_in ?? 21600) * 1000).toISOString(),
});

const iguais = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** A volta do login: confere o `state`, troca o código pelo acesso e descobre qual é a conta. */
export async function concluirEntrada({ code, state, error_description: recusa, error }, agora = new Date()) {
  const c = await ler();
  if (!c.estado || !iguais(state, c.estado) || agora - new Date(c.estadoEm) > ESTADO_VALE_MS) throw new Error("Esse login expirou. Clique em Entrar com o Mercado Livre de novo.");
  const { estado, estadoEm, ...semEstado } = c;
  try {
    if (error || !code) throw new Error(`Mercado Livre: ${recusa || error || "login cancelado"}`);
    const t = await pedirToken(c, { grant_type: "authorization_code", code, redirect_uri: enderecoDeRetorno() });
    const eu = await chamarCom(t.access_token, "GET", "/users/me");
    await gravar({ ...semEstado, ...camposDoToken(t, agora), vendedorId: String(eu.id ?? t.user_id), apelido: eu.nickname ?? null, conectadoEm: agora.toISOString(), erro: null });
  } catch (e) {
    await gravar({ ...semEstado, erro: e.message });
    throw e;
  }
}

async function chamarCom(token, metodo, caminho, corpo) {
  const r = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, accept: "application/json", ...(corpo ? { "content-type": "application/json" } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) throw Object.assign(new Error("Mercado Livre: o acesso venceu. Entre com o Mercado Livre de novo."), { status: 401 });
    const causa = Array.isArray(dados.cause) ? dados.cause[0]?.message : null;
    throw Object.assign(new Error(`Mercado Livre: ${causa || dados.message || `respondeu ${r.status}`}`), { status: r.status });
  }
  return dados;
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** A conexão com um acesso que vale agora, renovando se precisar. */
async function conexaoValida(agora = new Date()) {
  let c = await ler();
  if (!c.token) throw new Error("Conecte o Mercado Livre primeiro");
  if (new Date(c.expiraEm) - agora > RENOVAR_ANTES_MS) return c;
  // Outra execução pode estar renovando: espera ela terminar em vez de gastar a renovação de novo.
  for (let i = 0; !(await db.travar("mercadolivre_renovar", 30_000)); i++) {
    if (i >= 8) throw new Error("Mercado Livre: a renovação do acesso está demorando. Tente de novo em instantes.");
    await esperar(1500);
    c = await ler();
    if (new Date(c.expiraEm) - agora > RENOVAR_ANTES_MS) return c;
  }
  try {
    c = await ler();
    if (new Date(c.expiraEm) - agora > RENOVAR_ANTES_MS) return c;
    const renovacao = decifrar(c.renovacao);
    if (!renovacao) throw new Error("Mercado Livre: entre de novo (a senha do painel mudou)");
    const t = await pedirToken(c, { grant_type: "refresh_token", refresh_token: renovacao });
    const novo = { ...c, ...camposDoToken(t, agora), erro: null };
    await gravar(novo);
    return novo;
  } catch (e) {
    await gravar({ ...c, erro: e.message });
    throw e;
  } finally {
    await db.destravar("mercadolivre_renovar");
  }
}

async function chamar(metodo, caminho, corpo, agora) {
  const c = await conexaoValida(agora);
  return chamarCom(decifrar(c.token), metodo, caminho, corpo);
}

export const estaConectado = async () => Boolean((await ler()).token);

/** As perguntas ainda sem resposta na conta. */
export async function perguntasSemResposta(agora) {
  const { vendedorId } = await ler();
  const r = await chamar("GET", `/questions/search?seller_id=${encodeURIComponent(vendedorId)}&status=UNANSWERED&sort_fields=date_created&sort_types=DESC&limit=50&api_version=4`, null, agora);
  return (r.questions ?? []).filter((q) => !q.suspected_spam && !q.deleted_from_listing && q.status === "UNANSWERED");
}

/** O anúncio, com o que a IA precisa para responder: título, preço, estoque, atributos e descrição. */
export async function dadosDoAnuncio(itemId, agora) {
  const id = encodeURIComponent(itemId);
  const [item, descricao] = await Promise.all([
    chamar("GET", `/items/${id}`, null, agora),
    chamar("GET", `/items/${id}/description`, null, agora).catch(() => ({})),
  ]);
  return {
    id: item.id, titulo: item.title ?? "", preco: item.price ?? null, moeda: item.currency_id ?? "BRL", estoque: item.available_quantity ?? null,
    condicao: item.condition ?? null, link: item.permalink ?? null, freteGratis: item.shipping?.free_shipping ?? null,
    atributos: (item.attributes ?? []).filter((a) => a.value_name).slice(0, 40).map((a) => `${a.name}: ${a.value_name}`),
    descricao: String(descricao.plain_text ?? "").slice(0, 4000),
  };
}

/** O primeiro anúncio ativo da conta, ou null. */
export async function primeiroAnuncio(agora) {
  const { vendedorId } = await ler();
  const r = await chamar("GET", `/users/${encodeURIComponent(vendedorId)}/items/search?status=active&limit=1`, null, agora);
  return r.results?.[0] ?? null;
}

export const apelidoDaLoja = async () => (await ler()).apelido ?? "";

export const responderPergunta = (perguntaId, texto, agora) => chamar("POST", "/answers", { question_id: Number(perguntaId), text: texto }, agora);

/** As vendas mais recentes, só com o necessário: nem endereço nem documento do comprador entram aqui. */
export async function pedidosRecentes(agora) {
  const { vendedorId } = await ler();
  const r = await chamar("GET", `/orders/search?seller=${encodeURIComponent(vendedorId)}&sort=date_desc&limit=30`, null, agora);
  return (r.results ?? []).map((o) => ({
    id: String(o.id), criadoEm: o.date_created ?? null, status: o.status ?? null, total: o.total_amount ?? null, moeda: o.currency_id ?? "BRL",
    comprador: o.buyer?.nickname ?? null, envio: o.shipping?.id ? String(o.shipping.id) : null,
    itens: (o.order_items ?? []).map((i) => ({ titulo: i.item?.title ?? "", quantidade: i.quantity ?? 1, preco: i.unit_price ?? null })),
  }));
}
