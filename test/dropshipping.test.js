import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.URL_PUBLICA = "https://painel.exemplo.com";
process.env.PAINEL_SENHA = "senha-de-teste";
const db = await import("../src/db.js");
const drop = await import("../src/vendas/dropshipping.js");
const produtos = await import("../src/vendas/produtos.js");
await db.iniciar();

const AGORA = new Date("2026-11-14T12:00:00Z");
const FOTO = "https://arquivos.c7drop.com.br/uploads/1794689403477-e0c70340.webp";
const item = (extra = {}) => ({ nome: "Power Bank CS-922 20000mah Tipo-c E Lightning Branco", custo: 90, estoque: 50, link: "https://www.c7drop.com.br/produto/power-bank-cs-922", fotos: [FOTO, "https://outro.site/foto.jpg"], ...extra });
const TOPO = `Em estoque\n50 unidades disponívelis\nPower Bank CS-922\nEAN: 7908053606336\nNCM: 8507.60.00\nSKU: POW-5418-2952\nHomologação Anatel: 35794-26-88824\nCompra - Dropshipping\nAtacado\nDropshipping\nGrupo Vip\n\nAtacado a partir de 6 unidades.\n\nR$ 95,00\n\nou em até 12x de R$ 27,19`;
const DESCRICAO = `<h3><strong>Características principais</strong></h3><p><strong>Marca do carregador</strong></p><p>KD</p><p><strong>Modelo do carregador</strong></p><p>CS-922</p><p><strong>Cor</strong></p><p>Branco</p><h3><strong>Outros</strong></h3><p><strong>Capacidade da bateria</strong></p><p>20 Ah</p><p>POWER BANK CS-922 20000MAH</p><p>Nunca mais fique sem bateria! Veja https://youtu.be/abc &amp; chame no WhatsApp.</p>`;

function apiMl({ pedidos = [] } = {}) {
  const chamadas = [];
  return {
    chamadas,
    idsDasContas: async () => ["111"],
    preverCategorias: async () => [{ id: "MLB1055", nome: "Power banks" }],
    atributosDaCategoria: async () => [
      { id: "BRAND", nome: "Marca", livre: true, valores: [] },
      { id: "MODEL", nome: "Modelo", livre: true, valores: [] },
      { id: "COLOR", nome: "Cor", livre: false, valores: [{ id: "52049", nome: "Preto" }, { id: "52055", nome: "Branco" }] },
      { id: "VOLTAGE", nome: "Voltagem", livre: false, valores: [{ id: "1", nome: "110V" }, { id: "2", nome: "220V" }] },
    ],
    usaFamilia: async () => false,
    validarAnuncio: async (c, a) => chamadas.push(["validar", a]),
    criarAnuncio: async (c, a) => (chamadas.push(["criar", c, a]), { id: "MLB900", permalink: "https://produto.mercadolivre.com.br/MLB900", status: "active" }),
    salvarDescricao: async (c, id, t) => chamadas.push(["descricao", id, t]),
    mudarStatusDoAnuncio: async () => {},
    atualizarAnuncio: async (c, id, campos) => chamadas.push(["atualizar", id, campos]),
    pedidosRecentes: async () => pedidos,
  };
}

test("preço de venda: lucro alvo depois de comissão, imposto e custo fixo ou frete", () => {
  assert.deepEqual(drop.precoDeVenda(22), { preco: 55.9, comissao: 7.83, imposto: 3.35, envio: 7, lucro: 15.72, margem: 28.1, viavel: true });
  assert.equal(drop.precoDeVenda(90).preco, 199.9);
  assert.equal(drop.precoDeVenda(90).envio, 30);
  assert.equal(drop.precoDeVenda(325).preco, 614.9);
  assert.equal(drop.precoDeVenda(325).envio, 45);
  assert.equal(drop.precoDeVenda(3.5).viavel, false, "a taxa fixa engole o lucro de produto muito barato");
  assert.equal(drop.precoDeVenda(0), null);
});

test("lê estoque, códigos e o preço do modo dropshipping no topo da página da C7 Drop", () => {
  assert.deepEqual(drop.lerTopoDaC7(TOPO), { estoque: 50, gtin: "7908053606336", ncm: "85076000", sku: "POW-5418-2952", anatel: "35794-26-88824", custo: 95 });
  assert.equal(drop.lerTopoDaC7("Produto esgotado\nR$ 10,00").estoque, 0);
});

test("separa as características da descrição e tira link e contato", () => {
  const d = drop.lerDescricaoDaC7(DESCRICAO);
  assert.deepEqual(d.atributos.slice(0, 2), [{ nome: "Marca do carregador", valor: "KD" }, { nome: "Modelo do carregador", valor: "CS-922" }]);
  assert.equal(d.marca, "KD");
  assert.equal(d.modelo, "CS-922");
  assert.match(d.descricao, /Nunca mais fique sem bateria!/);
  assert.doesNotMatch(d.descricao, /youtu|whats|Características principais|Marca do carregador/i);
});

test("importa o catálogo, publica, e a nova leitura acerta preço e estoque do anúncio", async () => {
  const api = apiMl();
  const r = await drop.importarCatalogo([item(), { nome: "sem link", custo: 10 }], { api, agora: AGORA });
  assert.deepEqual(r, { criados: 1, atualizados: 0, ignorados: 1, sincronizados: 0 });
  const p = await db.produtoDoFornecedor("c7:power-bank-cs-922");
  assert.equal(p.preco, 199.9);
  assert.equal(p.custo, 90);
  assert.equal(p.estoque_fornecedor, 50);
  assert.equal(p.prazo_envio_dias, drop.PRAZO_PADRAO_DIAS);
  assert.deepEqual(p.fotos, [FOTO], "só as fotos do endereço do fornecedor");
  assert.equal(p.link_fornecedor, "https://www.c7drop.com.br/produto/power-bank-cs-922");

  // Antes de ler a página (sem descrição), o produto não é publicado.
  assert.equal((await drop.publicarEmLote({}, { api, agora: AGORA })).publicados.length, 0);
  assert.deepEqual(await drop.paginasParaLer(), [{ chave: "c7:power-bank-cs-922", link: "https://www.c7drop.com.br/produto/power-bank-cs-922" }]);

  const lidas = await drop.receberPaginas([{ chave: "c7:power-bank-cs-922", topo: TOPO, descricaoHtml: DESCRICAO }, { chave: "c7:nao-existe", topo: TOPO }], { api, agora: AGORA });
  assert.deepEqual(lidas, { lidos: 1, ignorados: 1, sincronizados: 0, esgotados: 0 });
  const lido = await db.produtoDoFornecedor("c7:power-bank-cs-922");
  assert.equal(lido.custo, 95, "o custo novo da página");
  assert.equal(lido.preco, drop.precoDeVenda(95).preco);
  assert.equal(lido.gtin, "7908053606336");
  assert.equal(lido.marca, "KD");
  assert.deepEqual(await drop.paginasParaLer(), []);

  const lote = await drop.publicarEmLote({}, { api, agora: AGORA });
  assert.equal(lote.publicados.length, 1);
  const [, conta, anuncio] = api.chamadas.find((c) => c[0] === "criar");
  assert.equal(conta, "111");
  assert.equal(anuncio.price, lido.preco);
  assert.equal(anuncio.listing_type_id, "gold_special");
  assert.equal(anuncio.available_quantity, 10, "o estoque do fornecedor até o limite de 10");
  assert.deepEqual(anuncio.sale_terms, [{ id: "MANUFACTURING_TIME", value_name: "2 dias" }]);
  assert.match(anuncio.pictures[0].source, /^https:\/\/painel\.exemplo\.com\/api\/produtos\/foto-externa\?u=https%3A%2F%2Farquivos\.c7drop\.com\.br/);
  assert.deepEqual(anuncio.attributes.find((a) => a.id === "COLOR"), { id: "COLOR", value_id: "52055" }, "a cor lida na página");
  assert.equal(anuncio.attributes.find((a) => a.id === "BRAND").value_name, "KD");
  assert.equal(anuncio.attributes.find((a) => a.id === "VOLTAGE"), undefined, "sem como saber, fica de fora");
  const pub = await db.publicacaoDoProduto(lido.id, "mercadolivre", "111");
  assert.equal(pub.status, "ativo");

  // Esgotou: o anúncio fica com 0. Depois volta com custo maior: preço e quantidade mudam.
  await drop.receberPaginas([{ chave: "c7:power-bank-cs-922", indisponivel: true }], { api, agora: AGORA });
  assert.deepEqual(api.chamadas.at(-1), ["atualizar", "MLB900", { available_quantity: 0 }]);
  const volta = await drop.importarCatalogo([item({ custo: 120, estoque: 4 })], { api, agora: AGORA });
  assert.equal(volta.sincronizados, 1);
  assert.deepEqual(api.chamadas.at(-1), ["atualizar", "MLB900", { price: drop.precoDeVenda(120).preco, available_quantity: 4 }]);
  assert.equal((await drop.publicarEmLote({}, { api, agora: AGORA })).publicados.length, 0, "não publica de novo");
});

test("venda paga vira compra na C7 Drop com aviso uma vez só; cancelada sai da lista", async () => {
  const pedido = (status) => ({ id: "2000001", status, total: 199.9, envio: "4400", itens: [{ itemId: "MLB900", titulo: "Power Bank CS-922", quantidade: 2 }, { itemId: "MLB-OUTRO", titulo: "Outro", quantidade: 1 }] });
  const avisos = [];
  const avisar = async (assunto, texto) => avisos.push({ assunto, texto });
  const r = await drop.conferirVendas({ api: apiMl({ pedidos: [pedido("paid")] }), avisar, agora: AGORA });
  assert.equal(r.novas, 1);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].texto, /2x Power Bank CS-922/);
  assert.match(avisos[0].texto, /https:\/\/www\.c7drop\.com\.br\/produto\/power-bank-cs-922/);
  const [c] = await db.comprasFornecedor("comprar");
  assert.equal(c.id, "2000001:MLB900");
  assert.equal(c.envio_id, "4400");
  assert.equal(c.quantidade, 2);

  await drop.conferirVendas({ api: apiMl({ pedidos: [pedido("paid")] }), avisar, agora: AGORA });
  assert.equal(avisos.length, 1, "o mesmo pedido não avisa de novo");
  await drop.conferirVendas({ api: apiMl({ pedidos: [pedido("cancelled")] }), avisar, agora: AGORA });
  assert.equal((await db.compraFornecedor("2000001:MLB900")).status, "cancelado");
});

test("o formulário do painel aceita a foto do fornecedor e não apaga os dados da C7 Drop", async () => {
  const limpo = produtos.limparProduto({ nome: "Produto", preco: "50", fornecedor: "C7 Drop", fotos: [FOTO, "https://outro.site/x.jpg"] });
  assert.deepEqual(limpo.fotos, [FOTO]);
  const p = await db.produtoDoFornecedor("c7:power-bank-cs-922");
  await db.atualizarProduto(p.id, produtos.limparProduto({ ...p, preco: "250" }));
  const depois = await db.produtoDoFornecedor("c7:power-bank-cs-922");
  assert.equal(depois.preco, 250);
  assert.equal(depois.estoque_fornecedor, 4);
  assert.equal(depois.fornecedor_chave, "c7:power-bank-cs-922");
});
