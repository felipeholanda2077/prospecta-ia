import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.PAINEL_SENHA = "senha-de-teste";
const db = await import("../src/db.js");
await db.iniciar();

async function lead(nome, whatsapp) {
  await db.inserirLead({ place_id: nome, nome, nicho: "salão", cidade: "Osasco - SP" });
  const [l] = await db.consultar("SELECT * FROM leads WHERE place_id = $1", [nome]);
  await db.consultar("UPDATE leads SET whatsapp = $2 WHERE id = $1", [l.id, whatsapp]);
  return { ...l, whatsapp };
}

async function enviada(leadId, destino, corpo, quando) {
  const id = await db.criarMensagem({ lead_id: leadId, canal: "whatsapp", destino, corpo, status: "aprovada", tipo: "resposta", etapa: 0 });
  await db.atualizarMensagem(id, { status: "enviada", enviada_em: quando });
}

test("aguardando pagamento: recebeu link de checkout e não fechou; quem fechou sai da lista", async () => {
  const a = await lead("Salão A", "5511988887777");
  const b = await lead("Salão B", "5511977776666");
  const c = await lead("Salão C", "5511966665555");
  await enviada(a.id, a.whatsapp, "Garanta aqui: https://fluxdeck.com.br/checkout/site-black-friday", "2020-01-17T15:00:00Z");
  await enviada(b.id, b.whatsapp, "Veja o exemplo: https://fluxdeck.com.br/previa/abc", "2020-01-17T15:00:00Z");
  await enviada(c.id, c.whatsapp, "Pague por aqui: https://www.asaas.com/c/xyz", "2020-01-17T15:00:00Z");
  await db.atualizarLead(c.id, { status: "fechado" });
  const m = await db.aguardandoPagamento();
  assert.equal(m.has(a.id), true);
  assert.equal(m.has(b.id), false);
  assert.equal(m.has(c.id), false);
});

test("encaminhamentos: a empresa passou para outra pessoa; bem-sucedido quando ela respondeu", async () => {
  const d = await lead("Clínica D", "5511955554444");
  const e = await lead("Clínica E", "5511944443333");
  await enviada(d.id, d.whatsapp, "Oi, tudo bem?", "2020-01-17T10:00:00Z");
  await enviada(d.id, "5511912345678", "Oi, a Clínica D me passou o seu contato", "2020-01-17T11:00:00Z");
  await db.criarResposta({ lead_id: d.id, canal: "whatsapp", origem_id: "enc-1", de: "11912345678", texto: "Oi, pode falar", classificacao: "interessado", resumo: "x" });
  await enviada(e.id, e.whatsapp, "Oi, tudo bem?", "2020-01-17T10:00:00Z");
  await enviada(e.id, "551144449999", "Oi, a Clínica E me passou o seu contato", "2020-01-17T11:00:00Z");
  // Mesmo número da empresa sem o 9 não conta como encaminhamento.
  await enviada(e.id, "551144443333", "Oi de novo", "2020-01-17T12:00:00Z");
  const { porLead } = await db.encaminhamentos();
  assert.equal(porLead.get(d.id), "sucesso");
  assert.equal(porLead.get(e.id), "aguardando");
});
