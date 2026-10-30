import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import * as ml from "../envio/mercadolivre.js";
import * as shopee from "../envio/shopee.js";
import { linkDaMidia } from "../conteudo/instagram.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// O cadastro único de produtos: cada um pode sair em várias contas do Mercado Livre e lojas da Shopee.
// Por padrão a publicação sai pausada, para o vendedor revisar no marketplace antes de ativar.
export const CANAIS = ["mercadolivre", "shopee"];
const MAX_FOTOS = 9;
const TIPOS_DE_ANUNCIO = ["gold_special", "gold_pro", "free"];

const texto = (v, max) => {
  const t = String(v ?? "").trim();
  return t ? t.slice(0, max) : null;
};
const inteiro = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const soDigitos = (v, max) => texto(String(v ?? "").replace(/\D/g, ""), max);

/** Confere o que veio do painel. Retorna os dados limpos ou lança com o que corrigir. */
export function limparProduto(d = {}) {
  const nome = texto(d.nome, 120);
  const preco = Number(String(d.preco ?? "").replace(",", "."));
  if (!nome || nome.length < 3) throw new Error("Escreva o nome do produto.");
  if (!Number.isFinite(preco) || preco <= 0) throw new Error("Informe um preço maior que zero.");
  const estoque = inteiro(d.estoque);
  if (estoque == null) throw new Error("Informe o estoque.");
  const fotos = (Array.isArray(d.fotos) ? d.fotos : []).filter((f) => /^produto-[0-9a-f-]+\.jpg$/.test(String(f))).slice(0, MAX_FOTOS);
  return {
    nome, preco: Math.round(preco * 100) / 100, estoque, descricao: texto(d.descricao, 5000), sku: texto(d.sku, 60), marca: texto(d.marca, 60), modelo: texto(d.modelo, 60),
    gtin: soDigitos(d.gtin, 14), condicao: d.condicao === "used" ? "used" : "new",
    peso_g: inteiro(d.peso_g), altura_cm: inteiro(d.altura_cm), largura_cm: inteiro(d.largura_cm), comprimento_cm: inteiro(d.comprimento_cm),
    ncm: soDigitos(d.ncm, 8), cfop_mesmo_estado: soDigitos(d.cfop_mesmo_estado, 4), cfop_outro_estado: soDigitos(d.cfop_outro_estado, 4), csosn: soDigitos(d.csosn, 3), origem: soDigitos(d.origem, 1),
    fotos,
  };
}

/** Guarda uma foto enviada pelo painel (JPEG já reduzido no navegador). */
export async function salvarFoto(base64) {
  const dados = Buffer.from(String(base64 ?? "").replace(/^data:image\/jpeg;base64,/, ""), "base64");
  if (dados.length < 500 || dados[0] !== 0xff || dados[1] !== 0xd8) throw new Error("Envie uma imagem JPEG.");
  const chave = `produto-${crypto.randomUUID()}.jpg`;
  await db.gravarMidia(chave, "image/jpeg", dados);
  return chave;
}

/** O que falta para publicar em qualquer canal. */
function exigirBasico(p, canal) {
  if (!p) throw new Error("Produto não encontrado");
  if (!p.fotos.length) throw new Error("Adicione ao menos uma foto ao produto.");
  if (canal === "shopee") {
    if (!p.descricao || p.descricao.length < 20) throw new Error("A Shopee pede uma descrição: escreva pelo menos 20 caracteres.");
    if (!p.peso_g || !p.altura_cm || !p.largura_cm || !p.comprimento_cm) throw new Error("A Shopee pede o peso e as medidas da embalagem.");
  }
}

const preencher = (atributos, p) => atributos.map((a) => ({
  ...a,
  valor: { BRAND: p.marca, MODEL: p.modelo, GTIN: p.gtin, SELLER_SKU: p.sku }[a.id] ?? null,
}));

/** As categorias sugeridas e os campos que a primeira exige. */
export async function prepararPublicacao(id, { canal, conta }, { apis = { mercadolivre: ml, shopee }, agora } = {}) {
  if (!CANAIS.includes(canal)) throw new Error("Escolha onde publicar.");
  const p = await db.buscarProduto(id);
  exigirBasico(p, canal);
  const api = apis[canal];
  const categorias = await api.preverCategorias(conta, p.nome, agora);
  if (!categorias.length) throw new Error("Não veio sugestão de categoria para esse nome. Tente um nome mais descritivo.");
  const atributos = preencher(await api.atributosDaCategoria(conta, categorias[0].id, agora), p);
  return { categorias: categorias.map(({ id: c, nome }) => ({ id: c, nome })), atributos };
}

export async function atributosParaCategoria(id, { canal, conta, categoria }, { apis = { mercadolivre: ml, shopee }, agora } = {}) {
  const p = await db.buscarProduto(id);
  if (!p) throw new Error("Produto não encontrado");
  return preencher(await apis[canal].atributosDaCategoria(conta, categoria, agora), p);
}

/** O anúncio no formato do Mercado Livre. */
export function anuncioDoMercadoLivre(p, { categoria, atributos = [], tipoAnuncio, familia = false, fotos }) {
  const lista = atributos.filter((a) => a.id && (a.value_id || a.value_name)).map((a) => ({ id: a.id, ...(a.value_id ? { value_id: String(a.value_id) } : { value_name: String(a.value_name) }) }));
  const usados = new Set(lista.map((a) => a.id));
  for (const [id, valor] of [["BRAND", p.marca], ["MODEL", p.modelo], ["GTIN", p.gtin], ["SELLER_SKU", p.sku]]) if (valor && !usados.has(id)) lista.push({ id, value_name: valor });
  return {
    ...(familia ? { family_name: p.nome.slice(0, 60) } : { title: p.nome.slice(0, 60) }),
    category_id: categoria, price: p.preco, currency_id: "BRL", available_quantity: p.estoque, buying_mode: "buy_it_now",
    listing_type_id: TIPOS_DE_ANUNCIO.includes(tipoAnuncio) ? tipoAnuncio : "gold_special", condition: p.condicao, pictures: fotos.map((source) => ({ source })), attributes: lista,
  };
}

async function publicarNoMercadoLivre(p, { conta, categoria, atributos, tipoAnuncio, pausado, soConferir }, { api, agora, link }) {
  const anuncio = anuncioDoMercadoLivre(p, { categoria, atributos, tipoAnuncio, familia: await api.usaFamilia(conta), fotos: p.fotos.map(link) });
  await api.validarAnuncio(conta, anuncio, agora);
  if (soConferir) return { conferido: true };
  const item = await api.criarAnuncio(conta, anuncio, agora);
  const avisos = [];
  // O anúncio já existe a partir daqui: um erro nestes passos vira aviso, não uma nova tentativa que duplicaria.
  if (p.descricao) await api.salvarDescricao(conta, item.id, p.descricao, agora).catch((e) => avisos.push(`A descrição não foi salva: ${e.message}`));
  let status = item.status === "active" ? "ativo" : "pausado";
  if (pausado && item.status === "active") {
    await api.mudarStatusDoAnuncio(conta, item.id, "paused", agora).then(() => (status = "pausado")).catch((e) => avisos.push(`O anúncio ficou ativo, porque não deu para pausar: ${e.message}`));
  }
  return { externoId: item.id, link: item.permalink ?? null, status, avisos };
}

/** O corpo do item no formato da Shopee. */
export function itemDaShopee(p, { categoria, atributos = [], imagens, canais, marca, pausado }) {
  const fiscais = { ncm: p.ncm, same_state_cfop: p.cfop_mesmo_estado, diff_state_cfop: p.cfop_outro_estado, csosn: p.csosn, origin: p.origem };
  const tax = Object.fromEntries(Object.entries(fiscais).filter(([, v]) => v));
  return {
    item_name: p.nome, description: p.descricao, original_price: p.preco, weight: p.peso_g / 1000, category_id: Number(categoria), condition: p.condicao === "used" ? "USED" : "NEW",
    item_status: pausado ? "UNLIST" : "NORMAL", item_sku: p.sku ?? undefined,
    dimension: { package_height: p.altura_cm, package_length: p.comprimento_cm, package_width: p.largura_cm },
    image: { image_id_list: imagens }, logistic_info: canais.map((logistic_id) => ({ logistic_id, enabled: true })), seller_stock: [{ stock: p.estoque }],
    // A marca 0 é "sem marca" na Shopee.
    brand: marca ? { brand_id: marca.brand_id, original_brand_name: marca.original_brand_name } : { brand_id: 0, original_brand_name: "NoBrand" },
    attribute_list: atributos.filter((a) => a.id && (a.value_id || a.value_name)).map((a) => ({
      attribute_id: Number(a.id), attribute_value_list: [{ value_id: Number(a.value_id) || 0, ...(a.value_id ? {} : { original_value_name: String(a.value_name) }) }],
    })),
    ...(Object.keys(tax).length ? { tax_info: tax } : {}),
  };
}

async function publicarNaShopee(p, { conta, categoria, atributos, pausado, soConferir }, { api, agora }) {
  const canais = await api.canaisDeEnvio(conta, agora);
  if (!canais.length) throw new Error("A loja não tem canal de envio ligado na Shopee. Ligue um em Configurações de envio.");
  // A Shopee não tem um "conferir sem publicar". O máximo aqui é checar o que depende do sistema.
  if (soConferir) return { conferido: true, parcial: true };
  const imagens = [];
  for (const chave of p.fotos) {
    const midia = await db.lerMidia(chave);
    if (midia) imagens.push(await api.subirImagem(midia.dados, midia.tipo, agora));
  }
  if (!imagens.length) throw new Error("As fotos do produto não foram encontradas. Adicione de novo.");
  const marca = await api.acharMarca(conta, categoria, p.marca, agora);
  const r = await api.criarItem(conta, itemDaShopee(p, { categoria, atributos, imagens, canais, marca, pausado }), agora);
  const itemId = r.item_id ?? r.item_id_list?.[0];
  if (!itemId) throw new Error("Shopee: não devolveu o ID do produto");
  return { externoId: String(itemId), link: `https://shopee.com.br/product/${conta}/${itemId}`, status: pausado ? "pausado" : "ativo", avisos: [] };
}

/**
 * Publica (ou só confere) o produto numa conta. Depois de criado, o produto não é criado de novo:
 * uma trava segura o clique duplo e o registro impede a repetição.
 */
export async function publicarProduto(id, { canal, conta, categoria, atributos, tipoAnuncio, pausado = true, soConferir = false }, { apis = { mercadolivre: ml, shopee }, agora, link = linkDaMidia } = {}) {
  if (!CANAIS.includes(canal)) throw new Error("Escolha onde publicar.");
  if (!categoria) throw new Error("Escolha a categoria.");
  const p = await db.buscarProduto(id);
  exigirBasico(p, canal);
  const existente = await db.publicacaoDoProduto(id, canal, conta);
  if (existente?.externo_id) throw new Error("Esse produto já foi publicado nessa conta.");
  const trava = `produto_publicar_${id}_${canal}_${conta}`;
  if (!soConferir && !(await db.travar(trava, 2 * 60_000))) throw new Error("Essa publicação já está em andamento.");
  try {
    const dados = { conta, categoria, atributos: Array.isArray(atributos) ? atributos : [], tipoAnuncio, pausado: pausado !== false, soConferir };
    const r = canal === "mercadolivre"
      ? await publicarNoMercadoLivre(p, dados, { api: apis.mercadolivre, agora, link })
      : await publicarNaShopee(p, dados, { api: apis.shopee, agora });
    if (r.conferido) return r;
    await db.gravarPublicacao({ produto_id: p.id, canal, conta_id: conta, externo_id: r.externoId, link: r.link, status: r.status });
    log(`🛍️  Produto ${p.id} publicado (${canal}, ${r.status}): ${r.externoId}`);
    return r;
  } catch (e) {
    if (!soConferir) await db.gravarPublicacao({ produto_id: p.id, canal, conta_id: conta, status: "erro", erro: e.message });
    throw e;
  } finally {
    if (!soConferir) await db.destravar(trava);
  }
}

/** Ativa ou pausa um produto já publicado. */
export async function mudarStatusDaPublicacao(id, { canal, conta, ativo }, { apis = { mercadolivre: ml, shopee }, agora } = {}) {
  const pub = await db.publicacaoDoProduto(id, canal, conta);
  if (!pub?.externo_id) throw new Error("Esse produto ainda não foi publicado nessa conta.");
  if (canal === "mercadolivre") await apis.mercadolivre.mudarStatusDoAnuncio(conta, pub.externo_id, ativo ? "active" : "paused", agora);
  else await apis.shopee.mudarListagem(conta, pub.externo_id, !ativo, agora);
  await db.gravarPublicacao({ produto_id: Number(id), canal, conta_id: conta, status: ativo ? "ativo" : "pausado" });
}
