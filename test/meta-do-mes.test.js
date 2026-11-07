import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const { metaDoMes, salvarMetaDoMes, mesDe } = await import("../src/vendas/metaDoMes.js");
const { limparProduto } = await import("../src/vendas/produtos.js");
await db.iniciar();

test("meta do mês: cada tipo de entrada soma no caixa geral, com valores em R$ formatados", async () => {
  const agora = new Date("2026-11-07T15:00:00Z"); // 7 de novembro, 30 dias no mês
  const automatico = async () => ({ cobrancas: 3000, vendas: 2300 });
  assert.equal(mesDe(new Date("2026-12-01T01:00:00Z")).mes, "2026-11"); // ainda 30/11 em Brasília

  // Sem meta: o caixa já soma as entradas automáticas.
  let m = await metaDoMes({ agora, automatico });
  assert.equal(m.meta, null);
  assert.equal(m.caixa, 5300);
  assert.deepEqual(m.fontes.map((f) => [f.id, f.valor, f.ajustado]), [["cobrancas", 3000, false], ["vendas", 2300, false]]);

  // Meta no formato do campo de dinheiro; entradas lançadas por tipo somam no caixa.
  m = await salvarMetaDoMes({
    meta: "R$ 20.000,00",
    entradas: [
      { tipo: "Pix", descricao: "Site da Padaria", valor: "R$ 1.500,00" },
      { tipo: "Dinheiro", valor: "R$ 250,50" },
      { tipo: "", valor: "" }, // linha vazia some
    ],
  }, { agora, automatico });
  assert.equal(m.meta, 20000);
  assert.deepEqual(m.entradas.map((e) => [e.tipo, e.descricao, e.valor]), [["Pix", "Site da Padaria", 1500], ["Dinheiro", "", 250.5]]);
  assert.equal(m.caixa, 7050.5);
  assert.deepEqual([m.falta, m.porcentagem, m.diasRestantes, m.bateu], [12949.5, 35, 24, false]);
  assert.equal(m.porDia, 539.56);

  // Ajustar uma entrada automática: vale o valor digitado; vazio volta ao automático. Ids das entradas se mantêm.
  const ids = m.entradas.map((e) => e.id);
  m = await salvarMetaDoMes({ fontes: { cobrancas: "R$ 4.000,00" } }, { agora, automatico });
  assert.deepEqual(m.fontes.map((f) => [f.id, f.valor, f.ajustado, f.automatico]), [["cobrancas", 4000, true, 3000], ["vendas", 2300, false, 2300]]);
  assert.equal(m.caixa, 8050.5);
  assert.deepEqual(m.entradas.map((e) => e.id), ids);
  m = await salvarMetaDoMes({ fontes: { cobrancas: null } }, { agora, automatico });
  assert.equal(m.caixa, 7050.5);

  // Editar e tirar entradas: a lista enviada substitui a anterior.
  m = await salvarMetaDoMes({ entradas: [{ id: ids[0], tipo: "Pix", descricao: "Site da Padaria", valor: "R$ 15.000,00" }] }, { agora, automatico });
  assert.deepEqual([m.entradas.length, m.entradas[0].id, m.caixa, m.bateu, m.falta], [1, ids[0], 20300, true, 0]);

  // Valores inválidos são recusados.
  await assert.rejects(salvarMetaDoMes({ meta: "abc" }, { agora }), /meta do mês/);
  await assert.rejects(salvarMetaDoMes({ meta: "R$ 0,00" }, { agora }), /meta do mês/);
  await assert.rejects(salvarMetaDoMes({ entradas: [{ tipo: "Pix", valor: "xyz" }] }, { agora }), /Valor inválido em o valor de "Pix"/);
  await assert.rejects(salvarMetaDoMes({ entradas: [{ tipo: "", valor: "R$ 10,00" }] }, { agora }), /tipo da entrada 1/);
  await assert.rejects(salvarMetaDoMes({ fontes: { vendas: "abc" } }, { agora }), /Vendas pagas/);

  // No mês seguinte: a meta continua; entradas e ajustes não passam de um mês para o outro.
  m = await metaDoMes({ agora: new Date("2026-12-02T15:00:00Z"), automatico: async () => ({ cobrancas: 0, vendas: 0 }) });
  assert.deepEqual([m.mes, m.meta, m.metaDoMesAnterior, m.caixa, m.entradas.length, m.diasRestantes], ["2026-12", 20000, true, 0, 0, 30]);

  // Fonte que não deu para ler fica sem valor automático, mas o resto soma.
  m = await metaDoMes({ agora, automatico: async () => ({ cobrancas: null, vendas: 100 }) });
  assert.deepEqual(m.fontes.map((f) => f.automatico), [null, 100]);
  assert.equal(m.caixa, 15100);
});

test("produto aceita preço e custo no formato do campo de dinheiro", () => {
  const p = limparProduto({ nome: "Máquina de corte", preco: "R$ 1.299,90", modo: "dropshipping", custo: "R$ 650,00", fornecedor: "X", link_fornecedor: "https://exemplo.com/p" });
  assert.equal(p.preco, 1299.9);
  assert.equal(p.custo, 650);
  assert.equal(limparProduto({ nome: "Outro produto", preco: 199.9, modo: "afiliado", link_afiliado: "https://s.shopee.com.br/abc" }).preco, 199.9);
});
