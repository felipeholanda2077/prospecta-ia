import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";

// As contas de vendedor no Mercado Livre, pela API oficial. Um app só atende várias contas. O acesso dura 6 horas
// e a renovação só pode ser usada uma vez: uma trava por conta impede que duas execuções renovem juntas, e cada
// conta fica em um registro próprio, para a renovação de uma não sobrescrever a de outra.
const API = "https://api.mercadolibre.com";
const LOGIN = "https://auth.mercadolivre.com.br/authorization";
const CONFIG = "mercadolivre";
const ESTADO_VALE_MS = 15 * 60_000;
const RENOVAR_ANTES_MS = 5 * 60_000;
export const MAX_RESPOSTA = 2000;

const gravar = (c) => db.gravarConfig(CONFIG, c);
const lerConta = async (id) => (await db.lerConfig(`${CONFIG}_conta_${id}`)) ?? {};
const gravarConta = (conta) => db.gravarConfig(`${CONFIG}_conta_${conta.vendedorId}`, conta);

/** A configuração do app. A conexão antiga, de uma conta só, passa para o formato de várias contas. */
async function ler() {
  const c = (await db.lerConfig(CONFIG)) ?? {};
  if (!c.token) return c;
  const { token, renovacao, expiraEm, vendedorId, apelido, conectadoEm, ...app } = c;
  await gravarConta({ token, renovacao, expiraEm, vendedorId, apelido, conectadoEm });
  const novo = { ...app, contas: [...new Set([...(app.contas ?? []), vendedorId])] };
  await gravar(novo);
  return novo;
}

/** Os IDs das contas conectadas. */
export const idsDasContas = async () => (await ler()).contas ?? [];

export const enderecoDeRetorno = () => `${config.painel.urlPublica}/api/mercadolivre/retorno`;
export const enderecoDeAvisos = () => `${config.painel.urlPublica}/webhooks/mercadolivre`;

/** O que o painel pode ver. Nada de segredo sai daqui. */
export async function statusDaConexao() {
  const c = await ler();
  const contas = await Promise.all((c.contas ?? []).map(async (id) => {
    const conta = await lerConta(id);
    return { id, apelido: conta.apelido ?? null, conectadoEm: conta.conectadoEm ?? null, erro: conta.erro ?? null };
  }));
  return {
    appDefinido: Boolean(c.clientId && c.clientSecret),
    clientId: c.clientId ?? "",
    retorno: enderecoDeRetorno(),
    avisos: enderecoDeAvisos(),
    conectado: contas.length > 0,
    contas,
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

/** Tira uma conta do sistema e apaga os acessos dela. */
export async function desconectar(id) {
  const c = await ler();
  await gravar({ ...c, contas: (c.contas ?? []).filter((x) => x !== String(id)) });
  await db.gravarConfig(`${CONFIG}_conta_${id}`, {});
}

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
    const vendedorId = String(eu.id ?? t.user_id);
    await gravarConta({ ...camposDoToken(t, agora), vendedorId, apelido: eu.nickname ?? null, tags: eu.tags ?? [], conectadoEm: agora.toISOString(), erro: null });
    await gravar({ ...semEstado, contas: [...new Set([...(semEstado.contas ?? []), vendedorId])], erro: null });
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
    // O app sem a permissão de escrita, que se marca nas configurações dele.
    if (/policy returned UNAUTHORIZED/i.test(dados.message ?? "")) throw Object.assign(new Error("O app do Mercado Livre não tem permissão para isso. Em Minhas aplicações → Editar, dê leitura e escrita em Publicação e sincronização, salve e entre com a conta de novo."), { status: r.status });
    const causas = Array.isArray(dados.cause) ? dados.cause.filter((x) => x?.type !== "warning" && x?.message).map((x) => x.message) : [];
    throw Object.assign(new Error(`Mercado Livre: ${causas.slice(0, 5).join(" ") || dados.message || `respondeu ${r.status}`}`), { status: r.status });
  }
  return dados;
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** A conta com um acesso que vale agora, renovando se precisar. */
async function contaValida(id, agora = new Date()) {
  const trava = `mercadolivre_renovar_${id}`;
  let c = await lerConta(id);
  if (!c.token) throw new Error("Conecte essa conta do Mercado Livre primeiro");
  if (new Date(c.expiraEm) - agora > RENOVAR_ANTES_MS) return c;
  // Outra execução pode estar renovando: espera ela terminar em vez de gastar a renovação de novo.
  for (let i = 0; !(await db.travar(trava, 30_000)); i++) {
    if (i >= 8) throw new Error("Mercado Livre: a renovação do acesso está demorando. Tente de novo em instantes.");
    await esperar(1500);
    c = await lerConta(id);
    if (new Date(c.expiraEm) - agora > RENOVAR_ANTES_MS) return c;
  }
  try {
    c = await lerConta(id);
    if (new Date(c.expiraEm) - agora > RENOVAR_ANTES_MS) return c;
    const renovacao = decifrar(c.renovacao);
    if (!renovacao) throw new Error("Mercado Livre: entre de novo (a senha do painel mudou)");
    const t = await pedirToken(await ler(), { grant_type: "refresh_token", refresh_token: renovacao });
    const novo = { ...c, ...camposDoToken(t, agora), erro: null };
    await gravarConta(novo);
    return novo;
  } catch (e) {
    await gravarConta({ ...c, erro: e.message });
    throw e;
  } finally {
    await db.destravar(trava);
  }
}

async function chamar(id, metodo, caminho, corpo, agora) {
  const c = await contaValida(id, agora);
  return chamarCom(decifrar(c.token), metodo, caminho, corpo);
}

/** As perguntas ainda sem resposta na conta. */
export async function perguntasSemResposta(id, agora) {
  const r = await chamar(id, "GET", `/questions/search?seller_id=${encodeURIComponent(id)}&status=UNANSWERED&sort_fields=date_created&sort_types=DESC&limit=50&api_version=4`, null, agora);
  return (r.questions ?? []).filter((q) => !q.suspected_spam && !q.deleted_from_listing && q.status === "UNANSWERED");
}

/** O anúncio, com o que a IA precisa para responder: título, preço, estoque, atributos e descrição. */
export async function dadosDoAnuncio(contaId, itemId, agora) {
  const item = encodeURIComponent(itemId);
  const [dados, descricao] = await Promise.all([
    chamar(contaId, "GET", `/items/${item}`, null, agora),
    chamar(contaId, "GET", `/items/${item}/description`, null, agora).catch(() => ({})),
  ]);
  return {
    id: dados.id, titulo: dados.title ?? dados.family_name ?? "", preco: dados.price ?? null, moeda: dados.currency_id ?? "BRL", estoque: dados.available_quantity ?? null,
    condicao: dados.condition ?? null, link: dados.permalink ?? null, freteGratis: dados.shipping?.free_shipping ?? null,
    atributos: (dados.attributes ?? []).filter((a) => a.value_name).slice(0, 40).map((a) => `${a.name}: ${a.value_name}`),
    descricao: String(descricao.plain_text ?? "").slice(0, 4000),
  };
}

/** O primeiro anúncio ativo da conta, ou null. */
export async function primeiroAnuncio(id, agora) {
  const r = await chamar(id, "GET", `/users/${encodeURIComponent(id)}/items/search?status=active&limit=1`, null, agora);
  return r.results?.[0] ?? null;
}

export const apelidoDaLoja = async (id) => (await lerConta(id)).apelido ?? "";

export const responderPergunta = (contaId, perguntaId, texto, agora) => chamar(contaId, "POST", "/answers", { question_id: Number(perguntaId), text: texto }, agora);

/** As vendas mais recentes, só com o necessário: nem endereço nem documento do comprador entram aqui. */
export async function pedidosRecentes(id, agora) {
  const r = await chamar(id, "GET", `/orders/search?seller=${encodeURIComponent(id)}&sort=date_desc&limit=30`, null, agora);
  return (r.results ?? []).map((o) => ({
    id: String(o.id), criadoEm: o.date_created ?? null, status: o.status ?? null, total: o.total_amount ?? null, moeda: o.currency_id ?? "BRL",
    comprador: o.buyer?.nickname ?? null, envio: o.shipping?.id ? String(o.shipping.id) : null,
    itens: (o.order_items ?? []).map((i) => ({ titulo: i.item?.title ?? "", quantidade: i.quantity ?? 1, preco: i.unit_price ?? null })),
  }));
}

// ---------- Publicação de produtos ----------

/** As categorias que o Mercado Livre sugere para o título do produto. */
export async function preverCategorias(id, texto, agora) {
  const r = await chamar(id, "GET", `/sites/MLB/domain_discovery/search?limit=5&q=${encodeURIComponent(texto)}`, null, agora);
  return (Array.isArray(r) ? r : []).map((c) => ({ id: c.category_id, nome: c.category_name, sugestoes: c.attributes ?? [] }));
}

const temTag = (a, tag) => (Array.isArray(a.tags) ? a.tags.includes(tag) : Boolean(a.tags?.[tag]));

/** Os atributos que a categoria exige, com as opções de cada um. */
export async function atributosDaCategoria(id, categoria, agora) {
  const r = await chamar(id, "GET", `/categories/${encodeURIComponent(categoria)}/attributes`, null, agora);
  return (Array.isArray(r) ? r : [])
    .filter((a) => (temTag(a, "required") || temTag(a, "catalog_required")) && !temTag(a, "read_only") && !temTag(a, "hidden"))
    // "list" e "boolean" só aceitam as opções da lista; nos outros dá para digitar, e a lista é só sugestão.
    .map((a) => ({ id: a.id, nome: a.name, obrigatorio: true, livre: !["list", "boolean"].includes(a.value_type), valores: (a.values ?? []).slice(0, 300).map((v) => ({ id: v.id, nome: v.name })) }));
}

/** Contas no novo modelo do Mercado Livre usam o nome da família no lugar do título. */
export const usaFamilia = async (id) => ((await lerConta(id)).tags ?? []).includes("user_product_seller");

/** Confere o anúncio sem publicar nada. O Mercado Livre responde o que precisa mudar. */
export const validarAnuncio = (id, anuncio, agora) => chamar(id, "POST", "/items/validate", anuncio, agora);
export const criarAnuncio = (id, anuncio, agora) => chamar(id, "POST", "/items", anuncio, agora);
export const salvarDescricao = (id, itemId, texto, agora) => chamar(id, "POST", `/items/${encodeURIComponent(itemId)}/description`, { plain_text: texto }, agora);
export const mudarStatusDoAnuncio = (id, itemId, status, agora) => chamar(id, "PUT", `/items/${encodeURIComponent(itemId)}`, { status }, agora);
