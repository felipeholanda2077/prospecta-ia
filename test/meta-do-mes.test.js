import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const { metaDoMes, salvarMetaDoMes, mesDe } = await import("../src/vendas/metaDoMes.js");
await db.iniciar();

test("meta do mês: editar a meta e o caixa, quanto falta, e a meta passa para o mês seguinte", async () => {
  const agora = new Date("2026-11-07T15:00:00Z"); // 7 de novembro, 30 dias no mês
  const automatico = async () => 5300;
  assert.equal(mesDe(new Date("2026-12-01T01:00:00Z")).mes, "2026-11"); // ainda 30/11 em Brasília

  // Sem meta: mostra o caixa automático e nada de "falta".
  let m = await metaDoMes({ agora, automatico });
  assert.equal(m.meta, null);
  assert.equal(m.caixa, 5300);
  assert.equal(m.falta, null);
  assert.equal(m.nomeDoMes, "novembro de 2026");

  // Meta digitada do jeito brasileiro; caixa automático; falta e quanto por dia (24 dias, contando hoje).
  m = await salvarMetaDoMes({ meta: "20.000" }, { agora, automatico });
  assert.deepEqual([m.meta, m.caixa, m.caixaManual, m.falta, m.porcentagem, m.diasRestantes, m.bateu], [20000, 5300, false, 14700, 27, 24, false]);
  assert.equal(m.porDia, 612.5);

  // Caixa ajustado à mão: vale o valor digitado, e a soma automática continua visível.
  m = await salvarMetaDoMes({ caixa: "8.250,50" }, { agora, automatico });
  assert.deepEqual([m.caixa, m.caixaManual, m.caixaAutomatico, m.falta, m.meta], [8250.5, true, 5300, 11749.5, 20000]);

  // Passou da meta.
  m = await salvarMetaDoMes({ caixa: "21000" }, { agora, automatico });
  assert.deepEqual([m.bateu, m.falta, m.porcentagem], [true, 0, 105]);

  // Caixa vazio volta para a soma automática.
  m = await salvarMetaDoMes({ caixa: null }, { agora, automatico });
  assert.deepEqual([m.caixa, m.caixaManual], [5300, false]);

  // Valores inválidos são recusados.
  await assert.rejects(salvarMetaDoMes({ meta: "abc" }, { agora }), /meta do mês/);
  await assert.rejects(salvarMetaDoMes({ meta: "0" }, { agora }), /meta do mês/);
  await assert.rejects(salvarMetaDoMes({ caixa: "xyz" }, { agora }), /entrou em caixa/);

  // No mês seguinte, sem meta nova, usa a última; o caixa manual não passa de um mês para o outro.
  await salvarMetaDoMes({ caixa: "9000" }, { agora, automatico });
  m = await metaDoMes({ agora: new Date("2026-12-02T15:00:00Z"), automatico: async () => 0 });
  assert.deepEqual([m.mes, m.meta, m.metaDoMesAnterior, m.caixa, m.caixaManual, m.diasRestantes], ["2026-12", 20000, true, 0, false, 30]);

  // Sem conseguir ler as cobranças, o caixa fica zero (e não quebra).
  m = await metaDoMes({ agora, automatico: async () => null });
  assert.equal(m.caixa, 9000); // o de novembro foi ajustado à mão
});
