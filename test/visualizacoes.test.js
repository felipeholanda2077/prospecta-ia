import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.URL_PUBLICA = "https://painel.exemplo.com";
process.env.PAINEL_SENHA = "senha-de-teste";
process.env.PAINEL_USUARIO = "teste";
const db = await import("../src/db.js");
const vis = await import("../src/vendas/visualizacoes.js");
const { cifrar } = await import("../src/segredos.js");
await db.iniciar();

const AGORA = new Date("2026-11-24T15:00:00Z");
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

test("números escritos do jeito brasileiro e do americano", () => {
  assert.equal(vis.numero("1.234"), 1234);
  assert.equal(vis.numero("R$ 1.234,56"), 1234.56);
  assert.equal(vis.numero("12,5%"), 12.5);
  assert.equal(vis.numero("1,234.5"), 1234.5);
  assert.equal(vis.numero("87"), 87);
  assert.equal(vis.numero(42), 42);
  assert.equal(vis.numero("-"), null);
  assert.equal(vis.numero(""), null);
});

test("TikTok: tabela colada com título antes do cabeçalho, ordenada por visualizações", async () => {
  const texto = [
    "Análise de produtos 2026-10-25 ~ 2026-11-24",
    "ID do produto\tProduto\tGMV\tItens vendidos\tImpressões do produto\tVisualizações da página do produto",
    "111\tSaia Para Box\tR$ 0,00\t0\t1.250\t40",
    "222\tKit 06 Capas\tR$ 129,90\t1\t900\t75",
    "333\tEdredom Casal\tR$ 0,00\t0\t3\t-",
  ].join("\n");
  const r = await vis.importarTiktok({ texto, periodo: "últimos 30 dias" }, { agora: AGORA });
  assert.deepEqual(r.itens.map((x) => x.nome), ["Kit 06 Capas", "Saia Para Box", "Edredom Casal"]);
  assert.equal(r.itens[1].impressoes, 1250);
  assert.equal(r.itens[0].gmv, 129.9);
  assert.equal(r.itens[2].visualizacoes, null);
  assert.ok(r.colunas.includes("visualizacoes"));
  const painel = await vis.painelDeVisualizacoes();
  assert.equal(painel.tiktok.periodo, "últimos 30 dias");
});

test("TikTok: .xlsx exportado, com texto compartilhado e linhas por SKU somadas", async () => {
  const strings = ["Product ID", "Product name", "Product impressions", "Product clicks", "Kit Lençol &amp; Fronha", "Cortina", "SKU A"];
  const sst = `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`;
  const c = (ref, idx) => `<c r="${ref}" t="s"><v>${idx}</v></c>`;
  const n = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
  const sheet = `<worksheet><sheetData>
    <row r="1">${c("A1", 0)}${c("B1", 1)}${c("C1", 2)}${c("D1", 3)}</row>
    <row r="2">${n("A2", 9)}${c("B2", 4)}${n("C2", 100)}${n("D2", 7)}</row>
    <row r="3">${n("A3", 9)}${c("B3", 4)}${n("C3", 50)}${n("D3", 3)}</row>
    <row r="4">${n("A4", 8)}${c("B4", 5)}${n("C4", 500)}<c r="D4" t="inlineStr"><is><t>2</t></is></c></row>
  </sheetData></worksheet>`;
  const zip = zipSync({ "xl/sharedStrings.xml": strToU8(sst), "xl/worksheets/sheet1.xml": strToU8(sheet) });
  const r = await vis.importarTiktok({ arquivo: Buffer.from(zip).toString("base64"), nome: "produtos.xlsx" }, { agora: AGORA });
  assert.equal(r.itens.length, 2);
  assert.deepEqual(r.itens[0], { id: "9", nome: "Kit Lençol & Fronha", impressoes: 150, visualizacoes: 10, clientes: null, vendidos: null, pedidos: null, gmv: null });
  assert.equal(r.itens[1].visualizacoes, 2);
});

test("TikTok: arquivo sem as colunas certas dá um erro que explica o caminho", async () => {
  await assert.rejects(vis.importarTiktok({ texto: "a;b\n1;2" }), /Análise de produtos/);
  await assert.rejects(vis.importarTiktok({}), /arquivo/);
});

test("Mercado Livre: anúncios ativos e pausados com visitas, do mais visto para o menos", async () => {
  await db.gravarConfig("mercadolivre", { clientId: "123", clientSecret: cifrar("s"), contas: ["999"] });
  await db.gravarConfig("mercadolivre_conta_999", { token: cifrar("TOKEN"), renovacao: cifrar("R"), expiraEm: new Date(+AGORA + 3600_000).toISOString(), vendedorId: "999", apelido: "LOJA" });
  const chamadas = [];
  const falso = async (url) => {
    const u = new URL(url);
    chamadas.push(u.pathname + u.search);
    if (u.pathname === "/users/999/items/search") return resposta(u.searchParams.get("status") === "active" ? { results: ["MLB1", "MLB2"], paging: { total: 2 } } : { results: ["MLB3"], paging: { total: 1 } });
    if (u.pathname === "/items") return resposta(u.searchParams.get("ids").split(",").map((id) => ({ code: 200, body: { id, title: `Produto ${id}`, price: 99.9, status: id === "MLB3" ? "paused" : "active", sold_quantity: id === "MLB2" ? 2 : 0, permalink: `https://ml/${id}` } })));
    if (u.pathname === "/visits/items") return resposta({ MLB1: 10, MLB2: 300, MLB3: 50 });
    if (u.pathname === "/items/visits") return resposta({ item_id: u.searchParams.get("ids"), total_visits: { MLB1: 4, MLB2: 120, MLB3: 9 }[u.searchParams.get("ids")] });
    return resposta({}, 404);
  };
  const r = await comFetch(falso, () => vis.atualizarVisitasDoMercadoLivre({ agora: AGORA }));
  assert.deepEqual(r.itens.map((x) => [x.id, x.visitasPeriodo, x.visitasTotal]), [["MLB2", 120, 300], ["MLB3", 9, 50], ["MLB1", 4, 10]]);
  assert.equal(r.itens[1].status, "paused");
  assert.equal(r.de, "2026-10-25");
  assert.ok(chamadas.some((c) => c.includes("date_from=2026-10-25&date_to=2026-11-24")));
  // Recente: a rodada não busca de novo.
  assert.deepEqual(await comFetch(async () => { throw new Error("não devia chamar"); }, () => vis.atualizarSeVelho({ agora: new Date(+AGORA + 3600_000) })), { visitas: "em dia" });
});

test("Mercado Livre: se a busca falha, o retrato anterior fica e o erro aparece", async () => {
  await assert.rejects(comFetch(async () => resposta({ message: "quebrou" }, 500), () => vis.atualizarVisitasDoMercadoLivre({ agora: AGORA })), /LOJA: Mercado Livre: quebrou/);
  const painel = await vis.painelDeVisualizacoes();
  assert.equal(painel.mercadoLivre.itens.length, 3);
  assert.equal(painel.mercadoLivre.erros.length, 1);
});
