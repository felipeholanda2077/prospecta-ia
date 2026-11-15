import { config } from "../config.js";
import * as db from "../db.js";
import * as ml from "../envio/mercadolivre.js";
import { enviarNotificacao } from "../envio/email.js";
import { lerValor } from "../contratos/valores.js";
import { fotoDoFornecedor, publicarProduto } from "./produtos.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Dropshipping com a C7 Drop (o mesmo catálogo da Velo), sem mensalidade e sem API. O navegador onde você está
// logado lê o catálogo e as páginas dos produtos e manda para cá (public/importar-fornecedor.html). Este módulo calcula
// o preço, guarda o produto, publica no Mercado Livre, acerta preço e estoque dos anúncios a cada leitura e transforma
// a venda paga numa compra a fazer na C7 Drop, com o link do produto e a etiqueta do envio.
export const FORNECEDOR = "C7 Drop";
const LINK_DO_PRODUTO = "https://www.c7drop.com.br/produto/";
// O fornecedor posta depois que você compra lá: o anúncio promete um prazo com essa folga.
export const PRAZO_PADRAO_DIAS = 2;
const MAX_FOTOS = 9;

// Taxas do Mercado Livre (anúncio Clássico) e imposto, com folga. Abaixo de R$ 79 o ML cobra um custo fixo por venda;
// a partir dele, o frete grátis é obrigatório e quem paga é o vendedor.
export const REGRA = {
  comissao: 0.14, imposto: 0.06, custoFixo: 7, limiteFreteGratis: 79, frete: 30, freteGrande: 45, custoGrande: 150,
  lucroMinimo: 15, lucroSobreCusto: 0.35, lucroFixo: 8, multiploMaximo: 3,
};

const arredondar90 = (x) => Math.ceil(x + 0.1) - 0.1;
const centavos = (x) => Math.round(x * 100) / 100;

/**
 * O preço de venda no Mercado Livre e a conta dele. Mira o lucro de pelo menos R$ 15 (ou 35% do custo + R$ 8) depois
 * da comissão, do imposto e do custo fixo ou do frete. Acima de 3x o custo o preço não compete: `viavel` fica false.
 */
export function precoDeVenda(custo, r = REGRA) {
  const c = Number(custo);
  if (!Number.isFinite(c) || c <= 0) return null;
  const alvo = Math.max(r.lucroMinimo, r.lucroSobreCusto * c + r.lucroFixo);
  const sobra = 1 - r.comissao - r.imposto;
  let envio = r.custoFixo;
  let preco = arredondar90((c + envio + alvo) / sobra);
  if (preco >= r.limiteFreteGratis) {
    envio = c >= r.custoGrande ? r.freteGrande : r.frete;
    preco = arredondar90((c + envio + alvo) / sobra);
  }
  const comissao = preco * r.comissao;
  const imposto = preco * r.imposto;
  const lucro = preco - c - comissao - imposto - envio;
  return {
    preco: centavos(preco), comissao: centavos(comissao), imposto: centavos(imposto), envio, lucro: centavos(lucro),
    margem: Math.round((lucro / preco) * 1000) / 10, viavel: preco / c <= r.multiploMaximo,
  };
}

const texto = (v, max) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};
const inteiroOuNulo = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** A chave do produto: o endereço dele na C7 Drop. Aceita o link inteiro ou só o final. */
export function chaveDoLink(link) {
  const s = String(link ?? "").trim();
  const m = s.match(/^https:\/\/(?:www\.)?c7drop\.com\.br\/produto\/([a-z0-9-]+)\/?$/i) ?? s.match(/^([a-z0-9-]{3,200})$/i);
  return m ? `c7:${m[1].toLowerCase()}` : null;
}
const linkDaChave = (chave) => `${LINK_DO_PRODUTO}${chave.slice(3)}`;

/** O item do catálogo da Velo como chega do navegador: nome, custo, estoque, fotos e o link na C7 Drop. */
export function limparItemDoCatalogo(d = {}) {
  const chave = chaveDoLink(d.link ?? d.product_url);
  const nome = texto(d.nome, 120);
  const custo = lerValor(d.custo ?? d.preco);
  if (!chave || !nome || custo == null || custo <= 0) return null;
  return {
    chave, nome, custo,
    estoque: inteiroOuNulo(d.estoque ?? d.stockQuantity),
    fotos: [...new Set((Array.isArray(d.fotos ?? d.images) ? d.fotos ?? d.images : []).map(fotoDoFornecedor).filter(Boolean))].slice(0, MAX_FOTOS),
  };
}

/** O topo da página do produto na C7 Drop: estoque, códigos e o preço de compra no modo dropshipping. */
export function lerTopoDaC7(topo) {
  const t = String(topo ?? "");
  const estoqueVisto = t.match(/(\d[\d.]*)\s+unidades?\s+dispon/i);
  const esgotado = /esgotad|indispon[ií]vel|sem estoque|fora de estoque/i.test(t) && !estoqueVisto;
  const aposModo = t.slice(Math.max(0, t.search(/Compra\s*-\s*Dropshipping/i)));
  const preco = aposModo.match(/R\$\s*([\d.]+,\d{2})/);
  return {
    estoque: estoqueVisto ? Number(estoqueVisto[1].replace(/\./g, "")) : esgotado ? 0 : null,
    gtin: t.match(/\bEAN:\s*(\d{8,14})\b/i)?.[1] ?? null,
    ncm: t.match(/\bNCM:\s*([\d.]{4,12})/i)?.[1]?.replace(/\D/g, "").slice(0, 8) || null,
    sku: texto(t.match(/\bSKU:\s*([^\s]+)/i)?.[1], 60),
    anatel: t.match(/Homologa[çc][ãa]o\s+Anatel:\s*([\d-]{5,20})/i)?.[1] ?? null,
    custo: preco ? lerValor(preco[1]) : null,
  };
}

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decodificar = (s) => String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (ENTIDADES[e.toLowerCase()] != null) return ENTIDADES[e.toLowerCase()];
  if (/^#x/i.test(e)) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
  if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
  return m;
});
const semTags = (s) => decodificar(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
// O Mercado Livre pune contato e link na descrição.
const TEM_CONTATO = /(https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|(\+?\d[\s().-]*){10,}|whats\s?app|instagram)/gi;

/** A descrição da página da C7 Drop: as características (pares em negrito) separadas, e o texto sem links nem contato. */
export function lerDescricaoDaC7(html) {
  let h = String(html ?? "").slice(0, 60_000);
  const atributos = [];
  const PAR = /<p[^>]*>\s*<strong[^>]*>([^<]{1,80})<\/strong>\s*<\/p>\s*<p[^>]*>([^<]{1,200})<\/p>/gi;
  h = h.replace(PAR, (_, nome, valor) => {
    const n = semTags(nome);
    const v = semTags(valor);
    if (n && v && atributos.length < 60) atributos.push({ nome: n, valor: v });
    return "";
  });
  h = h.replace(/<h\d[^>]*>\s*(<strong[^>]*>)?\s*(Características principais|Outros|Características gerais|Especificações)\s*(<\/strong>)?\s*<\/h\d>/gi, "");
  const linhas = decodificar(h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|h\d|li|div|tr)>/gi, "\n").replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, ""))
    .replace(TEM_CONTATO, "")
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim())
    // Sobras da página do fornecedor que não servem no anúncio: títulos de aba, código e saudação da loja dele.
    .map((l) => l.replace(/^C[óo]digo Universal\s*\/?\s*EAN:?\s*\d*\s*/i, "").replace(/^Descri[çc][ãa]o:?$/i, "").replace(/^bem[- ]vindos?\s+(a|à)\s+nossa\s+loja\s*!?\s*$/i, ""));
  const descricao = linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 5000) || null;
  const valorDe = (re) => atributos.find((a) => re.test(a.nome))?.valor ?? null;
  return { descricao, atributos, marca: texto(valorDe(/^marca/i), 60), modelo: texto(valorDe(/^modelo(?! alfanum)/i), 60) };
}

/** Acerta preço e quantidade dos anúncios já publicados quando o produto muda. O erro de um não para os outros. */
async function sincronizarAnuncios(produto, antes, { api, agora }) {
  const quantidade = (p) => (p.estoque_fornecedor == null ? null : Math.max(0, Math.min(10, p.estoque_fornecedor)));
  const campos = {};
  if (Number(antes.preco) !== Number(produto.preco)) campos.price = produto.preco;
  if (quantidade(antes) !== quantidade(produto) && quantidade(produto) != null) campos.available_quantity = quantidade(produto);
  if (!Object.keys(campos).length) return 0;
  let mudados = 0;
  for (const pub of await db.publicacoesDoProduto(produto.id)) {
    if (pub.canal !== "mercadolivre" || !pub.externo_id) continue;
    try {
      await api.atualizarAnuncio(pub.conta_id, pub.externo_id, campos, agora);
      mudados++;
    } catch (e) {
      await db.gravarPublicacao({ produto_id: produto.id, canal: pub.canal, conta_id: pub.conta_id, status: pub.status, erro: `Sincronia: ${e.message}` });
      log(`⚠️  Dropshipping: anúncio ${pub.externo_id} não foi atualizado: ${e.message}`);
    }
  }
  return mudados;
}

/** Junta o que já existe com o que veio do fornecedor, recalcula o preço e grava. Retorna o produto e o de antes. */
async function gravarDoFornecedor(chave, novo, { api, agora }) {
  const antes = await db.produtoDoFornecedor(chave);
  const custo = novo.custo ?? antes?.custo;
  const regra = precoDeVenda(custo);
  if (!regra) return null;
  const base = antes ?? { condicao: "new", fotos: [], atributos: [], prazo_envio_dias: PRAZO_PADRAO_DIAS };
  const produto = {
    ...base,
    nome: base.nome ?? novo.nome,
    descricao: novo.descricao ?? base.descricao ?? null,
    preco: regra.preco, custo, modo: "dropshipping", fornecedor: FORNECEDOR, link_fornecedor: linkDaChave(chave), fornecedor_chave: chave,
    estoque_fornecedor: novo.estoque !== undefined && novo.estoque !== null ? novo.estoque : base.estoque_fornecedor ?? null,
    fotos: base.fotos?.length ? base.fotos : novo.fotos ?? [],
    gtin: novo.gtin ?? base.gtin ?? null, ncm: novo.ncm ?? base.ncm ?? null, sku: novo.sku ?? base.sku ?? null,
    marca: novo.marca ?? base.marca ?? null, modelo: novo.modelo ?? base.modelo ?? null,
    atributos: novo.atributos?.length ? novo.atributos : base.atributos ?? [],
  };
  if (novo.indisponivel) produto.estoque_fornecedor = 0;
  produto.id = await db.gravarProdutoDoFornecedor(produto);
  const sincronizados = antes ? await sincronizarAnuncios(produto, antes, { api, agora }) : 0;
  return { produto, antes, regra, sincronizados };
}

/** Importa a lista escolhida do catálogo (pela Velo): cria os produtos ou atualiza custo, estoque e preço. */
export async function importarCatalogo(itens, { api = ml, agora = new Date() } = {}) {
  const r = { criados: 0, atualizados: 0, ignorados: 0, sincronizados: 0 };
  for (const bruto of (Array.isArray(itens) ? itens : []).slice(0, 1000)) {
    const item = limparItemDoCatalogo(bruto);
    if (!item) {
      r.ignorados++;
      continue;
    }
    const g = await gravarDoFornecedor(item.chave, item, { api, agora });
    if (!g) r.ignorados++;
    else {
      r[g.antes ? "atualizados" : "criados"]++;
      r.sincronizados += g.sincronizados;
    }
  }
  return r;
}

/**
 * O que o navegador leu na página de cada produto da C7 Drop: descrição, características, códigos, estoque e custo.
 * É também a sincronia: custo e estoque novos mudam preço e quantidade dos anúncios. Página que sumiu zera o estoque.
 */
export async function receberPaginas(paginas, { api = ml, agora = new Date() } = {}) {
  const r = { lidos: 0, ignorados: 0, sincronizados: 0, esgotados: 0 };
  for (const p of (Array.isArray(paginas) ? paginas : []).slice(0, 400)) {
    const chave = chaveDoLink(p?.chave?.startsWith?.("c7:") ? p.chave.slice(3) : p?.link ?? p?.chave);
    const existente = chave && (await db.produtoDoFornecedor(chave));
    if (!existente) {
      r.ignorados++;
      continue;
    }
    const novo = p.indisponivel ? { indisponivel: true } : { ...lerTopoDaC7(p.topo), ...lerDescricaoDaC7(p.descricaoHtml) };
    // Página lida sem texto de descrição: o nome serve, e o produto deixa de esperar a leitura para ser publicado.
    if (!p.indisponivel && !novo.descricao) novo.descricao = existente.descricao ?? existente.nome;
    const g = await gravarDoFornecedor(chave, novo, { api, agora });
    if (!g) {
      r.ignorados++;
      continue;
    }
    r.lidos++;
    r.sincronizados += g.sincronizados;
    if (g.produto.estoque_fornecedor === 0) r.esgotados++;
  }
  return r;
}

/** Os links que o navegador deve ler na C7 Drop: todos, ou só os que ainda não têm descrição. */
export async function paginasParaLer({ todos = false } = {}) {
  return (await db.produtosDoFornecedor(FORNECEDOR)).filter((p) => todos || !p.descricao).map((p) => ({ chave: p.fornecedor_chave, link: p.link_fornecedor }));
}

// Erros da conta, não do produto: acesso vencido, senha do painel trocada, app sem permissão de escrita.
const ERRO_DE_CONEXAO = /entre de novo|Entre com o Mercado Livre|Conecte essa conta|Secret Key|acesso venceu|não tem permissão para isso|renovação do acesso/i;

const normalizar = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const OUTRO = /^(outro|outros|outra|outras|nao se aplica|generico|generica)$/;

/** Preenche os atributos que a categoria exige com o que se sabe do produto. O que não der fica de fora. */
export function preencherAtributos(exigidos, p) {
  const lista = [];
  const lidos = (p.atributos ?? []).map((a) => ({ nome: normalizar(a.nome), valor: a.valor }));
  const nome = ` ${normalizar(p.nome)} `;
  for (const a of exigidos ?? []) {
    let valor = { BRAND: p.marca || "Genérica", MODEL: p.modelo || p.sku || "Padrão", GTIN: p.gtin, SELLER_SKU: p.sku }[a.id] ?? null;
    if (!valor) valor = lidos.find((l) => l.nome === normalizar(a.nome))?.valor ?? null;
    if (a.livre !== false || !(a.valores ?? []).length) {
      if (valor) lista.push({ id: a.id, value_name: String(valor).slice(0, 255) });
      continue;
    }
    const opcoes = a.valores ?? [];
    const igual = valor && opcoes.find((o) => normalizar(o.nome) === normalizar(valor));
    const noNome = !igual && opcoes.find((o) => normalizar(o.nome).length > 1 && nome.includes(` ${normalizar(o.nome)} `));
    const outro = !igual && !noNome && opcoes.find((o) => OUTRO.test(normalizar(o.nome)));
    const escolhido = igual || noNome || outro;
    if (escolhido) lista.push({ id: a.id, value_id: String(escolhido.id) });
  }
  return lista;
}

/**
 * Publica no Mercado Livre os produtos da C7 Drop que ainda não estão naquela conta: categoria sugerida pelo ML,
 * atributos preenchidos, anúncio Clássico ativo. Para no limite ou perto do tempo da execução; chame de novo
 * para seguir. Produto sem descrição (página ainda não lida), sem estoque ou com preço que não compete fica para depois.
 */
export async function publicarEmLote({ conta, limite = 20, repetirErros = false, ids = null } = {}, { api = ml, agora = new Date(), tempoMs = 240_000 } = {}) {
  const contas = await api.idsDasContas();
  const alvo = conta ? String(conta) : contas[0];
  if (!alvo || !contas.includes(alvo)) throw new Error("Conecte a conta do Mercado Livre primeiro.");
  const inicio = Date.now();
  const r = { publicados: [], erros: [], restantes: 0 };
  const candidatos = [];
  for (const p of await db.produtosDoFornecedor(FORNECEDOR)) {
    if (ids && !ids.includes(p.id)) continue;
    const pub = await db.publicacaoDoProduto(p.id, "mercadolivre", alvo);
    if (pub?.externo_id || (pub?.status === "erro" && !repetirErros && !ERRO_DE_CONEXAO.test(pub.erro ?? ""))) continue;
    if (!p.descricao || !p.fotos.length || !(p.estoque_fornecedor > 0) || !precoDeVenda(p.custo)?.viavel) continue;
    candidatos.push(p);
  }
  for (const p of candidatos) {
    if (r.publicados.length + r.erros.length >= limite || Date.now() - inicio > tempoMs) {
      r.restantes++;
      continue;
    }
    try {
      const categorias = await api.preverCategorias(alvo, p.nome, agora);
      if (!categorias.length) throw new Error("O Mercado Livre não sugeriu categoria para esse nome.");
      const atributos = preencherAtributos(await api.atributosDaCategoria(alvo, categorias[0].id, agora), p);
      const pub = await publicarProduto(p.id, { canal: "mercadolivre", conta: alvo, categoria: categorias[0].id, atributos, tipoAnuncio: "gold_special", pausado: false }, { apis: { mercadolivre: api }, agora });
      r.publicados.push({ id: p.id, nome: p.nome, anuncio: pub.externoId, link: pub.link });
    } catch (e) {
      // publicarProduto já gravou o erro; categoria e atributos falham antes, então grava aqui.
      await db.gravarPublicacao({ produto_id: p.id, canal: "mercadolivre", conta_id: alvo, status: "erro", erro: e.message });
      // Sem acesso à conta, nenhum outro vai sair: para aqui. Esse erro não impede a próxima tentativa.
      if (e.status === 401 || ERRO_DE_CONEXAO.test(e.message)) {
        r.conexao = e.message;
        r.restantes = candidatos.length - r.publicados.length;
        break;
      }
      r.erros.push({ id: p.id, nome: p.nome, erro: e.message });
    }
  }
  log(`🛍️  Dropshipping: ${r.publicados.length} publicados, ${r.erros.length} com erro, ${r.restantes} para a próxima`);
  return r;
}

/**
 * As vendas pagas de anúncios da C7 Drop viram compras a fazer lá, e chega um e-mail com o link e a quantidade.
 * Pedido cancelado antes da compra sai da lista. A cada 10 minutos e quando o Mercado Livre avisa de pedido.
 */
export async function conferirVendas({ api = ml, avisar = enviarNotificacao, agora = new Date() } = {}) {
  const contas = await api.idsDasContas();
  if (!contas.length) return { compras: "desconectado" };
  const anuncios = new Map((await db.fornecedoresDosAnuncios()).filter((f) => f.fornecedor === FORNECEDOR).map((f) => [f.externo_id, f]));
  if (!anuncios.size) return { compras: "sem anúncios da C7 Drop" };
  const novas = [];
  const erros = [];
  for (const conta of contas) {
    try {
      for (const o of await api.pedidosRecentes(conta, agora)) {
        for (const i of o.itens ?? []) {
          const f = anuncios.get(i.itemId);
          if (!f) continue;
          const id = `${o.id}:${i.itemId}`;
          if (o.status === "cancelled") {
            const c = await db.compraFornecedor(id);
            if (c?.status === "comprar") await db.mudarCompraFornecedor(id, "cancelado", agora);
            continue;
          }
          if (o.status !== "paid") continue;
          const compra = { id, conta_id: conta, pedido_id: o.id, item_id: i.itemId, produto_id: f.produto_id, titulo: i.titulo, quantidade: i.quantidade, total: o.total, envio_id: o.envio };
          if (await db.inserirCompraFornecedor(compra)) novas.push({ ...compra, link: f.link_fornecedor, custo: f.custo });
        }
      }
    } catch (e) {
      erros.push(e.message);
    }
  }
  if (novas.length) {
    const linhas = novas.map((c) => `- ${c.quantidade}x ${c.titulo} (pedido ${c.pedido_id}, R$ ${Number(c.total ?? 0).toFixed(2).replace(".", ",")})\n  Compre na C7 Drop, modo Dropshipping: ${c.link}`);
    await avisar(
      novas.length === 1 ? "Venda no Mercado Livre: compre na C7 Drop" : `${novas.length} vendas no Mercado Livre: compre na C7 Drop`,
      `${linhas.join("\n")}\n\nNa C7 Drop, escolha Dropshipping e envie a etiqueta do Mercado Livre. A etiqueta e o botão "Já comprei" estão em ${config.painel.urlPublica}/#marketplaces.`
    ).catch((e) => log(`⚠️  Não foi possível avisar da venda: ${e.message}`));
  }
  return { compras: "ok", novas: novas.length, erros };
}
