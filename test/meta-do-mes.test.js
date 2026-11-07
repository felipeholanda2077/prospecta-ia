import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const { metaDoMes, salvarMetaDoMes, mesDe, contratoRecorrente } = await import("../src/vendas/metaDoMes.js");
const { limparProduto } = await import("../src/vendas/produtos.js");
await db.iniciar();

test("meta do mês: cada tipo de entrada soma no caixa geral, com valores em R$ formatados", async () => {
  const agora = new Date("2026-11-07T15:00:00Z"); // 7 de novembro, 30 dias no mês
  const automatico = async () => ({ contratos_mensais: 2000, contratos_avulsos: 1000, assinaturas: 300, vendas_avulsas: 2000 });
  assert.equal(mesDe(new Date("2026-12-01T01:00:00Z")).mes, "2026-11"); // ainda 30/11 em Brasília

  // Sem meta: o caixa já soma as entradas automáticas.
  let m = await metaDoMes({ agora, automatico });
  assert.equal(m.meta, null);
  assert.equal(m.caixa, 5300);
  assert.deepEqual(m.fontes.map((f) => [f.id, f.valor, f.recorrente]), [["contratos_mensais", 2000, true], ["contratos_avulsos", 1000, false], ["assinaturas", 300, true], ["vendas_avulsas", 2000, false]]);
  assert.deepEqual([m.recorrente, m.avulso], [2300, 3000]);

  // Meta no formato do campo de dinheiro; entradas lançadas por tipo somam no caixa.
  m = await salvarMetaDoMes({
    meta: "R$ 20.000,00",
    entradas: [
      { tipo: "Projeto", descricao: "Site da Padaria", valor: "R$ 1.500,00", recorrente: false },
      { tipo: "Mensalidade", descricao: "Manutenção Academia", valor: "R$ 250,50", recorrente: true },
      { tipo: "", valor: "" }, // linha vazia some
    ],
  }, { agora, automatico });
  assert.equal(m.meta, 20000);
  assert.deepEqual(m.entradas.map((e) => [e.tipo, e.descricao, e.valor, e.recorrente]), [["Projeto", "Site da Padaria", 1500, false], ["Mensalidade", "Manutenção Academia", 250.5, true]]);
  assert.equal(m.caixa, 7050.5);
  assert.deepEqual([m.recorrente, m.avulso], [2550.5, 4500]);
  assert.deepEqual([m.falta, m.porcentagem, m.diasRestantes, m.bateu], [12949.5, 35, 24, false]);
  assert.equal(m.porDia, 539.56);

  // Ajustar uma entrada automática: vale o valor digitado; vazio volta ao automático. Ids das entradas se mantêm.
  const ids = m.entradas.map((e) => e.id);
  m = await salvarMetaDoMes({ fontes: { contratos_avulsos: "R$ 2.000,00" } }, { agora, automatico });
  assert.deepEqual(m.fontes.find((f) => f.id === "contratos_avulsos"), { id: "contratos_avulsos", nome: "Parcelas avulsas de contratos (Asaas)", recorrente: false, automatico: 1000, ajustado: true, valor: 2000 });
  assert.equal(m.caixa, 8050.5);
  assert.deepEqual(m.entradas.map((e) => e.id), ids);
  m = await salvarMetaDoMes({ fontes: { contratos_avulsos: null } }, { agora, automatico });
  assert.equal(m.caixa, 7050.5);

  // Editar e tirar entradas: a lista enviada substitui a anterior.
  m = await salvarMetaDoMes({ entradas: [{ id: ids[0], tipo: "Projeto", descricao: "Site da Padaria", valor: "R$ 15.000,00" }, { id: ids[1], tipo: "Mensalidade", descricao: "Manutenção Academia", valor: "R$ 250,50", recorrente: true }] }, { agora, automatico });
  assert.deepEqual([m.entradas.length, m.entradas[0].id, m.caixa, m.bateu, m.falta], [2, ids[0], 20550.5, true, 0]);

  // Valores inválidos são recusados.
  await assert.rejects(salvarMetaDoMes({ meta: "abc" }, { agora }), /meta do mês/);
  await assert.rejects(salvarMetaDoMes({ meta: "R$ 0,00" }, { agora }), /meta do mês/);
  await assert.rejects(salvarMetaDoMes({ entradas: [{ tipo: "Pix", valor: "xyz" }] }, { agora }), /Valor inválido em o valor de "Pix"/);
  await assert.rejects(salvarMetaDoMes({ entradas: [{ tipo: "", valor: "R$ 10,00" }] }, { agora }), /tipo da entrada 1/);
  await assert.rejects(salvarMetaDoMes({ fontes: { vendas_avulsas: "abc" } }, { agora }), /Vendas avulsas/);

  // No mês seguinte: a meta continua; só as entradas recorrentes se repetem (os ajustes e as avulsas não).
  const dezembro = new Date("2026-12-02T15:00:00Z");
  const zerado = async () => ({ contratos_mensais: 0, contratos_avulsos: 0, assinaturas: 0, vendas_avulsas: 0 });
  m = await metaDoMes({ agora: dezembro, automatico: zerado });
  assert.deepEqual([m.mes, m.meta, m.metaDoMesAnterior, m.diasRestantes], ["2026-12", 20000, true, 30]);
  assert.deepEqual(m.entradas.map((e) => [e.tipo, e.valor, e.recorrente, e.repetida]), [["Mensalidade", 250.5, true, true]]);
  assert.deepEqual([m.caixa, m.recorrente, m.avulso], [250.5, 250.5, 0]);
  // Salvou dezembro sem a recorrente: ela não volta.
  m = await salvarMetaDoMes({ entradas: [] }, { agora: dezembro, automatico: zerado });
  assert.deepEqual([m.entradas.length, m.caixa], [0, 0]);

  // Fonte que não deu para ler fica sem valor automático, mas o resto soma.
  m = await metaDoMes({ agora, automatico: async () => ({ contratos_mensais: null, contratos_avulsos: 0, assinaturas: 100, vendas_avulsas: 0 }) });
  assert.deepEqual(m.fontes.map((f) => f.automatico), [null, 0, 100, 0]);
  assert.equal(m.caixa, 15350.5);
});

test("contrato pago por mês em várias parcelas conta como recorrente", () => {
  assert.equal(contratoRecorrente("R$ 500,00 (quinhentos reais) por mês, 12 meses"), true);
  assert.equal(contratoRecorrente("R$ 3.000,00 (três mil reais) por mês, 1 mês"), false);
  assert.equal(contratoRecorrente("Entrada de R$ 1.000,00 e saldo de R$ 2.000,00"), false);
  assert.equal(contratoRecorrente(null), false);
});

test("produto aceita preço e custo no formato do campo de dinheiro", () => {
  const p = limparProduto({ nome: "Máquina de corte", preco: "R$ 1.299,90", modo: "dropshipping", custo: "R$ 650,00", fornecedor: "X", link_fornecedor: "https://exemplo.com/p" });
  assert.equal(p.preco, 1299.9);
  assert.equal(p.custo, 650);
  assert.equal(limparProduto({ nome: "Outro produto", preco: 199.9, modo: "afiliado", link_afiliado: "https://s.shopee.com.br/abc" }).preco, 199.9);
});
