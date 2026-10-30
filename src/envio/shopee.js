import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";

// As lojas na Shopee, pela Open Platform v2. Toda chamada é assinada com HMAC-SHA256 usando a Partner Key.
// O acesso dura 4 horas e a renovação vale 30 dias e muda a cada uso: há trava por loja, e cada loja fica em
// um registro próprio. O ambiente de teste (sandbox) usa outros endereços e outra chave.
const ENDERECOS = {
  live: { api: "https://openplatform.shopee.com.br", login: "https://open.shopee.com.br/auth" },
  sandbox: { api: "https://openplatform.sandbox.test-stable.shopee.sg", login: "https://open.sandbox.test-stable.shopee.com/auth" },
};
const CONFIG = "shopee";
const ESTADO_VALE_MS = 15 * 60_000;
const RENOVAR_ANTES_MS = 5 * 60_000;

const ler = async () => (await db.lerConfig(CONFIG)) ?? {};
const gravar = (c) => db.gravarConfig(CONFIG, c);
const lerLoja = async (id) => (await db.lerConfig(`${CONFIG}_loja_${id}`)) ?? {};
const gravarLoja = (l) => db.gravarConfig(`${CONFIG}_loja_${l.lojaId}`, l);

export const enderecoDeRetorno = () => `${config.painel.urlPublica}/api/shopee/retorno`;
export const idsDasLojas = async () => (await ler()).lojas ?? [];

export async function statusDaConexao() {
  const c = await ler();
  const lojas = await Promise.all((c.lojas ?? []).map(async (id) => {
    const l = await lerLoja(id);
    return { id, nome: l.nome ?? `Loja ${id}`, conectadoEm: l.conectadoEm ?? null, renovacaoVenceEm: l.renovacaoVenceEm ?? null, erro: l.erro ?? null };
  }));
  return {
    appDefinido: Boolean(c.partnerId && c.partnerKey), partnerId: c.partnerId ?? "", ambiente: c.ambiente ?? "live",
    retorno: enderecoDeRetorno(), conectado: lojas.length > 0, lojas, erro: c.erro ?? null,
  };
}

export async function salvarApp({ partnerId, partnerKey, ambiente }) {
  const c = await ler();
  const id = String(partnerId ?? "").trim();
  const chave = String(partnerKey ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Cole o Partner ID da Shopee (só números)");
  if (!chave && !c.partnerKey) throw new Error("Cole a Partner Key da Shopee");
  await gravar({ ...c, partnerId: id, partnerKey: chave ? cifrar(chave) : c.partnerKey, ambiente: ambiente === "sandbox" ? "sandbox" : "live", erro: null });
}

const assinar = (chave, ...partes) => crypto.createHmac("sha256", chave).update(partes.join("")).digest("hex");

const chaveDoApp = (c) => {
  const chave = decifrar(c.partnerKey);
  if (!chave) throw new Error("Shopee: cole a Partner Key de novo (a senha do painel mudou)");
  return chave;
};

/** O link para o vendedor autorizar a loja. O `state` confere, na volta, que o pedido partiu daqui. */
export async function urlDeEntrada(agora = new Date()) {
  const c = await ler();
  if (!c.partnerId || !c.partnerKey) throw new Error("Salve o Partner ID e a Partner Key primeiro");
  const estado = crypto.randomBytes(24).toString("hex");
  await gravar({ ...c, estado, estadoEm: agora.toISOString(), erro: null });
  const url = new URL(ENDERECOS[c.ambiente ?? "live"].login);
  for (const [k, v] of Object.entries({ partner_id: c.partnerId, auth_type: "seller", redirect_uri: enderecoDeRetorno(), response_type: "code", state: estado })) url.searchParams.set(k, v);
  return url.toString();
}

async function respostaDaShopee(r) {
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok || corpo.error) throw Object.assign(new Error(`Shopee: ${corpo.message || corpo.error || `respondeu ${r.status}`}`), { codigo: corpo.error, status: r.status });
  return corpo;
}

/** Chamada sem acesso de loja (pedir token, subir imagem). */
async function chamarPublica(c, caminho, corpo, agora = new Date()) {
  const timestamp = Math.floor(+agora / 1000);
  const url = new URL(`${ENDERECOS[c.ambiente ?? "live"].api}${caminho}`);
  for (const [k, v] of Object.entries({ partner_id: c.partnerId, timestamp, sign: assinar(chaveDoApp(c), c.partnerId, caminho, timestamp) })) url.searchParams.set(k, v);
  const multipart = corpo instanceof FormData;
  return respostaDaShopee(await fetch(url, {
    method: "POST", headers: multipart ? {} : { "Content-Type": "application/json" }, body: multipart ? corpo : JSON.stringify(corpo), signal: AbortSignal.timeout(30_000),
  }));
}

const camposDoToken = (t, agora) => ({
  token: cifrar(t.access_token), renovacao: cifrar(t.refresh_token),
  expiraEm: new Date(+agora + (t.expire_in ?? 14400) * 1000).toISOString(),
  renovacaoVenceEm: new Date(+agora + 30 * 86_400_000).toISOString(),
});

const iguais = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** A volta da autorização: confere o `state`, troca o código pelo acesso e descobre o nome da loja. */
export async function concluirEntrada({ code, shop_id: lojaId, state, main_account_id: contaPrincipal }, agora = new Date()) {
  const c = await ler();
  if (!c.estado || !iguais(state, c.estado) || agora - new Date(c.estadoEm) > ESTADO_VALE_MS) throw new Error("Esse login expirou. Clique em Entrar com a Shopee de novo.");
  const { estado, estadoEm, ...semEstado } = c;
  try {
    if (contaPrincipal && !lojaId) throw new Error("Shopee: autorize com a conta da loja, não com a conta principal.");
    if (!code || !/^\d+$/.test(String(lojaId ?? ""))) throw new Error("Shopee: a autorização não trouxe a loja. Tente de novo.");
    const t = await chamarPublica(c, "/api/v2/auth/token/get", { code, shop_id: Number(lojaId), partner_id: Number(c.partnerId) }, agora);
    const loja = { ...camposDoToken(t, agora), lojaId: String(lojaId), conectadoEm: agora.toISOString(), erro: null };
    await gravarLoja(loja);
    await gravar({ ...semEstado, lojas: [...new Set([...(semEstado.lojas ?? []), String(lojaId)])], erro: null });
    const info = await chamar(lojaId, "GET", "/api/v2/shop/get_shop_info", {}, null, agora).catch(() => ({}));
    if (info.shop_name) await gravarLoja({ ...(await lerLoja(lojaId)), nome: info.shop_name });
  } catch (e) {
    await gravar({ ...semEstado, erro: e.message });
    throw e;
  }
}

export async function desconectar(id) {
  const c = await ler();
  await gravar({ ...c, lojas: (c.lojas ?? []).filter((x) => x !== String(id)) });
  await db.gravarConfig(`${CONFIG}_loja_${id}`, {});
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function lojaValida(id, agora = new Date()) {
  const trava = `shopee_renovar_${id}`;
  let l = await lerLoja(id);
  if (!l.token) throw new Error("Conecte essa loja da Shopee primeiro");
  if (new Date(l.expiraEm) - agora > RENOVAR_ANTES_MS) return l;
  for (let i = 0; !(await db.travar(trava, 30_000)); i++) {
    if (i >= 8) throw new Error("Shopee: a renovação do acesso está demorando. Tente de novo em instantes.");
    await esperar(1500);
    l = await lerLoja(id);
    if (new Date(l.expiraEm) - agora > RENOVAR_ANTES_MS) return l;
  }
  try {
    l = await lerLoja(id);
    if (new Date(l.expiraEm) - agora > RENOVAR_ANTES_MS) return l;
    const renovacao = decifrar(l.renovacao);
    if (!renovacao) throw new Error("Shopee: entre de novo (a senha do painel mudou)");
    const c = await ler();
    const t = await chamarPublica(c, "/api/v2/auth/access_token/get", { refresh_token: renovacao, partner_id: Number(c.partnerId), shop_id: Number(id) }, agora);
    const novo = { ...l, ...camposDoToken(t, agora), erro: null };
    await gravarLoja(novo);
    return novo;
  } catch (e) {
    await gravarLoja({ ...l, erro: `${e.message} Se continuar, entre com a Shopee de novo.` });
    throw e;
  } finally {
    await db.destravar(trava);
  }
}

async function chamar(id, metodo, caminho, params = {}, corpo = null, agora = new Date()) {
  const l = await lojaValida(id, agora);
  const c = await ler();
  const token = decifrar(l.token);
  const timestamp = Math.floor(+agora / 1000);
  const url = new URL(`${ENDERECOS[c.ambiente ?? "live"].api}${caminho}`);
  const comuns = { partner_id: c.partnerId, timestamp, access_token: token, shop_id: id, sign: assinar(chaveDoApp(c), c.partnerId, caminho, timestamp, token, id) };
  for (const [k, v] of Object.entries({ ...comuns, ...params })) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {}, ...(corpo ? { body: JSON.stringify(corpo) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const dados = await respostaDaShopee(r);
  return dados.response ?? dados;
}

/** Sobe uma imagem para a Shopee e devolve o ID dela. */
export async function subirImagem(dados, tipo = "image/jpeg", agora) {
  const c = await ler();
  const form = new FormData();
  form.append("image", new Blob([dados], { type: tipo }), "produto.jpg");
  const r = await chamarPublica(c, "/api/v2/media_space/upload_image", form, agora);
  const id = r.response?.image_info?.image_id ?? r.response?.image_info_list?.[0]?.image_info?.image_id;
  if (!id) throw new Error("Shopee: não devolveu o ID da imagem");
  return id;
}

const nomeEmPortugues = (a) => a.multi_lang?.find((x) => /^pt/i.test(x.language ?? ""))?.value || a.name || a.display_attribute_name || a.original_attribute_name;

/** As categorias sugeridas para o nome do produto, com o nome de cada uma. */
export async function preverCategorias(id, nome, agora) {
  const r = await chamar(id, "GET", "/api/v2/product/category_recommend", { item_name: nome }, null, agora);
  const ids = r.category_id ?? [];
  const todas = await chamar(id, "GET", "/api/v2/product/get_category", { language: "pt-br" }, null, agora).catch(() => ({}));
  const lista = todas.category_list ?? [];
  return ids.map((c) => {
    const achada = lista.find((x) => x.category_id === c);
    return { id: c, nome: achada?.display_category_name || achada?.original_category_name || `Categoria ${c}` };
  });
}

/** Os atributos obrigatórios da categoria. */
export async function atributosDaCategoria(id, categoria, agora) {
  const r = await chamar(id, "GET", "/api/v2/product/get_attribute_tree", { category_id_list: categoria, language: "pt-br" }, null, agora);
  const arvore = r.list?.[0]?.attribute_tree ?? [];
  return arvore.filter((a) => a.mandatory).map((a) => ({
    // Sem lista de opções, o campo é digitado; com lista, só os tipos "combobox" aceitam outro valor.
    id: a.attribute_id, nome: nomeEmPortugues(a), obrigatorio: true, livre: !a.attribute_value_list?.length || [2, 4].includes(a.attribute_info?.input_type),
    valores: (a.attribute_value_list ?? []).slice(0, 300).map((v) => ({ id: v.value_id, nome: nomeEmPortugues(v) })),
  }));
}

/** A marca da categoria com esse nome, se a Shopee conhecer. */
export async function acharMarca(id, categoria, nome, agora) {
  if (!nome) return null;
  const r = await chamar(id, "GET", "/api/v2/product/get_brand_list", { category_id: categoria, status: 1, offset: 0, page_size: 100, language: "pt-br" }, null, agora).catch(() => ({}));
  const alvo = String(nome).trim().toLowerCase();
  return (r.brand_list ?? []).find((b) => [b.original_brand_name, b.display_brand_name].some((n) => String(n ?? "").toLowerCase() === alvo)) ?? null;
}

/** Os canais de envio que a loja deixou ligados e que não pedem preço ou tamanho por item. */
export async function canaisDeEnvio(id, agora) {
  const r = await chamar(id, "GET", "/api/v2/logistics/get_channel_list", {}, null, agora);
  return (r.logistics_channel_list ?? []).filter((c) => c.enabled && !["SIZE_SELECTION", "CUSTOM_PRICE"].includes(c.fee_type)).map((c) => c.logistics_channel_id);
}

export const criarItem = (id, corpo, agora) => chamar(id, "POST", "/api/v2/product/add_item", {}, corpo, agora);
export const mudarListagem = (id, itemId, ocultar, agora) => chamar(id, "POST", "/api/v2/product/unlist_item", {}, { item_list: [{ item_id: Number(itemId), unlist: ocultar }] }, agora);

/** Os pedidos dos últimos 15 dias (o máximo que a Shopee aceita de uma vez): só número e situação. */
export async function pedidosRecentes(id, agora = new Date()) {
  const fim = Math.floor(+agora / 1000);
  const r = await chamar(id, "GET", "/api/v2/order/get_order_list", { time_range_field: "create_time", time_from: fim - 15 * 86_400, time_to: fim, page_size: 50 }, null, agora);
  return (r.order_list ?? []).map((o) => ({ id: String(o.order_sn), status: o.order_status ?? null }));
}
