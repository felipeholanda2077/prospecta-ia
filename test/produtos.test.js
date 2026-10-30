import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.URL_PUBLICA = "https://painel.exemplo.com";
process.env.PAINEL_SENHA = "senha-de-teste";
const db = await import("../src/db.js");
const produtos = await import("../src/vendas/produtos.js");
const sp = await import("../src/envio/shopee.js");
await db.iniciar();

const AGORA = new Date("2026-11-10T12:00:00Z");
const resposta = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
async function comFetch(falso, fazer) {
  const original = globalThis.fetch;
  globalThis.fetch = falso;
  try {
    return await fazer();
  } finally {
    globalThis.fetch = original;
  }
}
const FOTO = "produto-11111111-2222-3333-4444-555555555555.jpg";
const base = (extra = {}) => ({ nome: "Máquina de corte profissional", preco: "199,90", estoque: "5", descricao: "Máquina de corte sem fio, com bateria de longa duração e 4 pentes.", marca: "Wahl", modelo: "X1", sku: "MQ-1", peso_g: "500", altura_cm: "10", largura_cm: "15", comprimento_cm: "20", fotos: [FOTO], ...extra });
const criar = async (extra) => db.criarProduto(produtos.limparProduto(base(extra)));

function apiMl({ falhar = null, statusCriado = "active", familia = false } = {}) {
  const chamadas = [];
  return {
    chamadas,
    preverCategorias: async () => [{ id: "MLB1", nome: "Cortadores" }],
    atributosDaCategoria: async () => [{ id: "BRAND", nome: "Marca", valores: [] }, { id: "VOLTAGE", nome: "Voltagem", valores: [{ id: "1", nome: "Bivolt" }] }],
    usaFamilia: async () => familia,
    validarAnuncio: async (c, a) => { chamadas.push(["validar", a]); if (falhar) throw new Error(falhar); },
    criarAnuncio: async (c, a) => { chamadas.push(["criar", c, a]); return { id: "MLB123", permalink: "https://produto.mercadolivre.com.br/MLB123", status: statusCriado }; },
    salvarDescricao: async (c, id, t) => { chamadas.push(["descricao", id, t]); },
    mudarStatusDoAnuncio: async (c, id, s) => { chamadas.push(["status", id, s]); },
  };
}
const link = (f) => `https://painel.exemplo.com/api/midia/${f}`;

test("produtos: confere o cadastro e só aceita foto do próprio sistema", () => {
  assert.throws(() => produtos.limparProduto({ nome: "A", preco: "10", estoque: "1" }), /nome/);
  assert.throws(() => produtos.limparProduto(base({ preco: "0" })), /preço/);
  assert.throws(() => produtos.limparProduto(base({ estoque: "" })), /estoque/);
  const p = produtos.limparProduto(base({ gtin: "78-9123", fotos: [FOTO, "https://malicioso.com/x.jpg", "../segredo"], extra: "x" }));
  assert.deepEqual([p.preco, p.estoque, p.gtin, p.fotos, p.condicao, p.extra], [199.9, 5, "789123", [FOTO], "new", undefined]);
});

test("produtos: a foto precisa ser JPEG, e fotos não somem na limpeza das mídias antigas", async () => {
  await assert.rejects(() => produtos.salvarFoto("nada"), /JPEG/);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(800)]);
  const chave = await produtos.salvarFoto(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
  assert.match(chave, /^produto-[0-9a-f-]+\.jpg$/);
  await db.consultar("UPDATE midias SET criada_em = now() - interval '30 days' WHERE chave = $1", [chave]);
  await db.gravarMidia("post-1-velho.jpg", "image/jpeg", jpeg);
  await db.consultar("UPDATE midias SET criada_em = now() - interval '30 days' WHERE chave = 'post-1-velho.jpg'");
  await db.apagarMidias("post-999-");
  assert.ok(await db.lerMidia(chave));
  assert.equal(await db.lerMidia("post-1-velho.jpg"), null);
});

test("mercado livre: prepara com a categoria sugerida e preenche o que já sabe", async () => {
  const id = await criar();
  const r = await produtos.prepararPublicacao(id, { canal: "mercadolivre", conta: "9" }, { apis: { mercadolivre: apiMl() }, agora: AGORA });
  assert.deepEqual(r.categorias, [{ id: "MLB1", nome: "Cortadores" }]);
  assert.equal(r.atributos.find((a) => a.id === "BRAND").valor, "Wahl");
  const semFoto = await criar({ fotos: [] });
  await assert.rejects(() => produtos.prepararPublicacao(semFoto, { canal: "mercadolivre", conta: "9" }, { apis: { mercadolivre: apiMl() } }), /foto/);
});

test("mercado livre: conferir não cria nada; publicar valida antes, sai pausado e não publica duas vezes", async () => {
  const id = await criar();
  const api = apiMl();
  const o = { apis: { mercadolivre: api }, agora: AGORA, link };
  const pedido = { canal: "mercadolivre", conta: "9", categoria: "MLB1", atributos: [{ id: "VOLTAGE", value_id: "1", value_name: "Bivolt" }] };
  assert.deepEqual(await produtos.publicarProduto(id, { ...pedido, soConferir: true }, o), { conferido: true });
  assert.deepEqual(api.chamadas.map((c) => c[0]), ["validar"]);
  assert.equal(await db.publicacaoDoProduto(id, "mercadolivre", "9"), null);

  const r = await produtos.publicarProduto(id, pedido, o);
  assert.deepEqual([r.externoId, r.status], ["MLB123", "pausado"]);
  assert.deepEqual(api.chamadas.map((c) => c[0]), ["validar", "validar", "criar", "descricao", "status"]);
  const anuncio = api.chamadas.find((c) => c[0] === "criar")[2];
  assert.equal(anuncio.title, "Máquina de corte profissional");
  assert.deepEqual(anuncio.pictures, [{ source: link(FOTO) }]);
  assert.deepEqual(anuncio.attributes.find((a) => a.id === "VOLTAGE"), { id: "VOLTAGE", value_id: "1" });
  assert.deepEqual(anuncio.attributes.find((a) => a.id === "BRAND"), { id: "BRAND", value_name: "Wahl" });
  assert.equal(anuncio.price, 199.9);
  assert.equal((await db.publicacaoDoProduto(id, "mercadolivre", "9")).status, "pausado");
  await assert.rejects(() => produtos.publicarProduto(id, pedido, o), /já foi publicado/);
  assert.equal(api.chamadas.filter((c) => c[0] === "criar").length, 1);

  // Na outra conta dá para publicar o mesmo produto.
  const outra = apiMl({ familia: true });
  await produtos.publicarProduto(id, { ...pedido, conta: "10", pausado: false }, { apis: { mercadolivre: outra }, agora: AGORA, link });
  const noNovoModelo = outra.chamadas.find((c) => c[0] === "criar")[2];
  assert.deepEqual([noNovoModelo.family_name, noNovoModelo.title], ["Máquina de corte profissional", undefined]);
  assert.equal(outra.chamadas.some((c) => c[0] === "status"), false); // pediu ativo: não pausa
});

test("mercado livre: recusa na validação guarda o motivo, nada é criado, e dá para tentar de novo", async () => {
  const id = await criar();
  const ruim = apiMl({ falhar: "Mercado Livre: O atributo GTIN é obrigatório." });
  const pedido = { canal: "mercadolivre", conta: "9", categoria: "MLB1" };
  await assert.rejects(() => produtos.publicarProduto(id, pedido, { apis: { mercadolivre: ruim }, link }), /GTIN/);
  assert.equal(ruim.chamadas.some((c) => c[0] === "criar"), false);
  const pub = await db.publicacaoDoProduto(id, "mercadolivre", "9");
  assert.deepEqual([pub.status, pub.externo_id], ["erro", null]);
  const boa = apiMl();
  assert.equal((await produtos.publicarProduto(id, pedido, { apis: { mercadolivre: boa }, link })).externoId, "MLB123");
  assert.equal((await db.publicacaoDoProduto(id, "mercadolivre", "9")).erro, null);
});

test("mercado livre: falha ao pausar depois de criar vira aviso, e o anúncio fica registrado como ativo", async () => {
  const id = await criar();
  const api = { ...apiMl(), mudarStatusDoAnuncio: async () => { throw new Error("sem permissão"); } };
  const r = await produtos.publicarProduto(id, { canal: "mercadolivre", conta: "9", categoria: "MLB1" }, { apis: { mercadolivre: api }, link });
  assert.equal(r.status, "ativo");
  assert.match(r.avisos[0], /ficou ativo/);
  assert.equal((await db.publicacaoDoProduto(id, "mercadolivre", "9")).externo_id, "MLB123");
});

test("ativar e pausar usam a publicação certa", async () => {
  const id = await criar();
  await assert.rejects(() => produtos.mudarStatusDaPublicacao(id, { canal: "shopee", conta: "7", ativo: true }), /ainda não foi publicado/);
  await db.gravarPublicacao({ produto_id: id, canal: "shopee", conta_id: "7", externo_id: "42", status: "pausado" });
  const chamadas = [];
  await produtos.mudarStatusDaPublicacao(id, { canal: "shopee", conta: "7", ativo: true }, { apis: { shopee: { mudarListagem: async (c, item, ocultar) => chamadas.push([c, item, ocultar]) } } });
  assert.deepEqual(chamadas, [["7", "42", false]]);
  const pub = await db.publicacaoDoProduto(id, "shopee", "7");
  assert.deepEqual([pub.status, pub.externo_id], ["ativo", "42"]);
});

function apiSp({ canais = [101], item = { item_id: 777 } } = {}) {
  const chamadas = [];
  return {
    chamadas,
    canaisDeEnvio: async () => canais,
    subirImagem: async () => "img-1",
    acharMarca: async () => null,
    criarItem: async (c, corpo) => { chamadas.push(corpo); return item; },
  };
}

test("shopee: publica oculto por padrão, com medidas, envio e impostos, e exige o que ela pede", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  await db.gravarMidia(FOTO, "image/jpeg", jpeg);
  const sem = await criar({ descricao: "curta" });
  await assert.rejects(() => produtos.publicarProduto(sem, { canal: "shopee", conta: "7", categoria: 5 }, { apis: { shopee: apiSp() } }), /descrição/);
  const semPeso = await criar({ peso_g: "" });
  await assert.rejects(() => produtos.publicarProduto(semPeso, { canal: "shopee", conta: "7", categoria: 5 }, { apis: { shopee: apiSp() } }), /peso/);

  const id = await criar({ ncm: "85102000", origem: "0" });
  await assert.rejects(() => produtos.publicarProduto(id, { canal: "shopee", conta: "7", categoria: 5 }, { apis: { shopee: apiSp({ canais: [] }) } }), /canal de envio/);

  const api = apiSp();
  assert.deepEqual(await produtos.publicarProduto(id, { canal: "shopee", conta: "7", categoria: 5, soConferir: true }, { apis: { shopee: api } }), { conferido: true, parcial: true });
  assert.equal(api.chamadas.length, 0);
  const r = await produtos.publicarProduto(id, { canal: "shopee", conta: "7", categoria: "5", atributos: [{ id: "9", value_id: "3" }, { id: "8", value_name: "Azul" }] }, { apis: { shopee: api } });
  assert.deepEqual([r.externoId, r.status], ["777", "pausado"]);
  const corpo = api.chamadas[0];
  assert.equal(corpo.item_status, "UNLIST");
  assert.equal(corpo.weight, 0.5);
  assert.deepEqual(corpo.dimension, { package_height: 10, package_length: 20, package_width: 15 });
  assert.deepEqual(corpo.image.image_id_list, ["img-1"]);
  assert.deepEqual(corpo.logistic_info, [{ logistic_id: 101, enabled: true }]);
  assert.deepEqual(corpo.brand, { brand_id: 0, original_brand_name: "NoBrand" });
  assert.deepEqual(corpo.tax_info, { ncm: "85102000", origin: "0" });
  assert.deepEqual(corpo.attribute_list, [
    { attribute_id: 9, attribute_value_list: [{ value_id: 3 }] },
    { attribute_id: 8, attribute_value_list: [{ value_id: 0, original_value_name: "Azul" }] },
  ]);
});

test("shopee: assina cada chamada, confere o state, guarda os acessos criptografados e usa o endereço do Brasil", async () => {
  await assert.rejects(() => sp.salvarApp({ partnerId: "abc", partnerKey: "k" }), /Partner ID/);
  await assert.rejects(() => sp.salvarApp({ partnerId: "123" }), /Partner Key/);
  await sp.salvarApp({ partnerId: "123", partnerKey: "chave-secreta" });
  const entrada = new URL(await sp.urlDeEntrada(AGORA));
  assert.equal(entrada.host, "open.shopee.com.br");
  assert.equal(entrada.searchParams.get("redirect_uri"), "https://painel.exemplo.com/api/shopee/retorno");
  const state = entrada.searchParams.get("state");
  await comFetch(async () => assert.fail("não chama com state errado"), () => assert.rejects(() => sp.concluirEntrada({ code: "c", shop_id: "7", state: "errado" }, AGORA), /expirou/));

  const urls = [];
  await comFetch(async (u, o) => {
    urls.push(new URL(u));
    if (String(u).includes("/auth/token/get")) {
      assert.deepEqual(JSON.parse(o.body), { code: "c1", shop_id: 7, partner_id: 123 });
      return resposta({ access_token: "AT-1", refresh_token: "RT-1", expire_in: 14400, error: "" });
    }
    return resposta({ shop_name: "Minha Loja", error: "" });
  }, () => sp.concluirEntrada({ code: "c1", shop_id: "7", state }, AGORA));
  assert.equal(urls[0].host, "openplatform.shopee.com.br");
  const ts = Math.floor(+AGORA / 1000);
  assert.equal(urls[0].searchParams.get("sign"), crypto.createHmac("sha256", "chave-secreta").update(`123/api/v2/auth/token/get${ts}`).digest("hex"));
  assert.equal(urls[1].searchParams.get("sign"), crypto.createHmac("sha256", "chave-secreta").update(`123/api/v2/shop/get_shop_info${ts}AT-1${7}`).digest("hex"));

  const s = await sp.statusDaConexao();
  assert.deepEqual(s.lojas.map((l) => [l.id, l.nome]), [["7", "Minha Loja"]]);
  assert.doesNotMatch(JSON.stringify(s), /chave-secreta|AT-1|RT-1/);
  assert.doesNotMatch(JSON.stringify([await db.lerConfig("shopee"), await db.lerConfig("shopee_loja_7")]), /chave-secreta|AT-1|RT-1/);

  // A renovação: só perto de vencer, e a nova fica guardada.
  const depois = new Date(+AGORA + 4 * 3600_000);
  const pedidos = [];
  await comFetch(async (u, o) => {
    pedidos.push(String(u));
    if (String(u).includes("/auth/access_token/get")) {
      assert.deepEqual(JSON.parse(o.body), { refresh_token: "RT-1", partner_id: 123, shop_id: 7 });
      return resposta({ access_token: "AT-2", refresh_token: "RT-2", expire_in: 14400, error: "" });
    }
    assert.equal(new URL(u).searchParams.get("access_token"), "AT-2");
    return resposta({ error: "", response: { order_list: [{ order_sn: "A1", order_status: "READY_TO_SHIP" }] } });
  }, async () => assert.deepEqual(await sp.pedidosRecentes("7", depois), [{ id: "A1", status: "READY_TO_SHIP" }]));
  assert.equal(pedidos.filter((u) => u.includes("access_token/get")).length, 1);

  // A Shopee devolve erro com status 200: precisa virar erro aqui também.
  await comFetch(async () => resposta({ error: "error_auth", message: "Invalid access_token." }), () => assert.rejects(() => sp.pedidosRecentes("7", depois), /Invalid access_token/));
});

test("shopee: duas lojas, cada uma no próprio registro, e desconectar uma não mexe na outra", async () => {
  await sp.salvarApp({ partnerId: "123", partnerKey: "chave-secreta", ambiente: "sandbox" });
  assert.equal(new URL(await sp.urlDeEntrada(AGORA)).host, "open.sandbox.test-stable.shopee.com");
  const state = new URL(await sp.urlDeEntrada(AGORA)).searchParams.get("state");
  await comFetch(async (u) => (String(u).includes("/auth/token/get") ? resposta({ access_token: "AT-8", refresh_token: "RT-8", expire_in: 14400 }) : resposta({ shop_name: "Outra Loja" })), () => sp.concluirEntrada({ code: "c", shop_id: "8", state }, AGORA));
  assert.deepEqual((await sp.statusDaConexao()).lojas.map((l) => l.nome), ["Minha Loja", "Outra Loja"]);
  await sp.desconectar("7");
  assert.deepEqual((await sp.statusDaConexao()).lojas.map((l) => l.nome), ["Outra Loja"]);
});

test("as rotas de produtos e da Shopee exigem login", async () => {
  const { app } = await import("../src/app.js");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    for (const [m, u] of [["GET", "/api/produtos"], ["POST", "/api/produtos"], ["POST", "/api/produtos/1/publicar"], ["GET", "/api/shopee"], ["GET", "/api/marketplaces/pedidos"]]) {
      assert.equal((await fetch(`${base}${u}`, { method: m })).status, 401, u);
    }
    assert.equal((await fetch(`${base}/api/produtos/foto/qualquer.jpg`)).status, 401);
    assert.equal((await fetch(`${base}/api/shopee/retorno?code=x&shop_id=1&state=y`, { redirect: "manual" })).status, 302);
  } finally {
    servidor.close();
  }
});
