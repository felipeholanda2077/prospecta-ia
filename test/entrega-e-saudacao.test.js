import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const pipeline = await import("../src/pipeline.js");
const { extrairEntregas } = await import("../src/respostas/whatsapp.js");
await db.iniciar();

test("saudação pelo horário: o Oi do começo vira bom dia, boa tarde ou boa noite (no fuso da empresa)", () => {
  const sp = "America/Sao_Paulo";
  assert.equal(pipeline.saudacaoDoHorario(new Date("2026-11-09T12:00:00Z"), sp), "Bom dia"); // 9h
  assert.equal(pipeline.saudacaoDoHorario(new Date("2026-11-09T17:00:00Z"), sp), "Boa tarde"); // 14h
  assert.equal(pipeline.saudacaoDoHorario(new Date("2026-11-09T22:30:00Z"), sp), "Boa noite"); // 19h30
  const tarde = new Date("2026-11-09T17:00:00Z");
  assert.equal(pipeline.comSaudacaoDoHorario("Oi, tudo bem? Sou o Felipe.", tarde, sp), "Boa tarde, tudo bem? Sou o Felipe.");
  assert.equal(pipeline.comSaudacaoDoHorario("Olá! Aqui é o Felipe.", tarde, sp), "Boa tarde! Aqui é o Felipe.");
  assert.equal(pipeline.comSaudacaoDoHorario("Oi, Dra. Lilia, tudo bem?", tarde, sp), "Boa tarde, Dra. Lilia, tudo bem?");
  // Sem "Oi" no começo, nada muda (e "Oitava" não é "Oi").
  assert.equal(pipeline.comSaudacaoDoHorario("Bom dia, tudo bem?", tarde, sp), "Bom dia, tudo bem?");
  assert.equal(pipeline.comSaudacaoDoHorario("Oitava clínica", tarde, sp), "Oitava clínica");
  // Lisboa: 17h UTC são 17h lá.
  assert.equal(pipeline.saudacaoDoHorario(new Date("2026-11-09T17:00:00Z"), "Europe/Lisbon"), "Boa tarde");
});

test("janela de 24 h é por número: a recepção escreveu, mas a doutora indicada não (para ela, só o modelo)", async () => {
  await db.inserirLead({ place_id: "ChIJjanelanumero00000000001", nome: "Vet", cidade: "Osasco - SP" });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJjanelanumero00000000001"]);
  await db.consultar("INSERT INTO respostas (lead_id, canal, texto, de, recebida_em, classificacao) VALUES ($1, 'whatsapp', 'Fala com a Dra. Lilia', '5511993566627', now() - interval '1 hour', 'outro')", [l.id]);
  assert.equal(await pipeline.janelaDe24hAberta(l.id), true);
  assert.equal(await pipeline.janelaDe24hAberta(l.id, new Date(), "5511993566627"), true);
  assert.equal(await pipeline.janelaDe24hAberta(l.id, new Date(), "551193566627"), true); // sem o 9
  assert.equal(await pipeline.janelaDe24hAberta(l.id, new Date(), "5511978760521"), false); // a doutora nunca escreveu
});

test("entrega pela Meta: enviada, entregue e lida aparecem; aviso atrasado não volta a situação; falha guarda o motivo", async () => {
  await db.inserirLead({ place_id: "ChIJentrega0000000000000001", nome: "Clínica", cidade: "Osasco - SP" });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJentrega0000000000000001"]);
  const id = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5511999990009", corpo: "Oi", tipo: "inicial", etapa: 1 });
  await db.atualizarMensagem(id, { status: "enviada", message_id: "wamid.ABC", numero_wa: "meta-1", enviada_em: new Date().toISOString() });
  const aviso = (status, extra = {}) => ({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.ABC", status, timestamp: "1794240000", ...extra }] } }] }] });
  const situacao = async () => (await db.consultar("SELECT entrega, erro FROM mensagens WHERE id = $1", [id]))[0];

  for (const a of extrairEntregas(aviso("sent"))) await db.atualizarEntrega(a.id, a.entrega, a.quando, a.erro);
  assert.equal((await situacao()).entrega, "enviada");
  for (const a of extrairEntregas(aviso("read"))) await db.atualizarEntrega(a.id, a.entrega, a.quando, a.erro);
  assert.equal((await situacao()).entrega, "lida");
  // O "entregue" que chega depois do "lida" não volta a situação.
  for (const a of extrairEntregas(aviso("delivered"))) await db.atualizarEntrega(a.id, a.entrega, a.quando, a.erro);
  assert.equal((await situacao()).entrega, "lida");

  const id2 = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5511999990009", corpo: "Etapa 2", tipo: "sequencia", etapa: 2 });
  await db.atualizarMensagem(id2, { status: "enviada", message_id: "wamid.XYZ", numero_wa: "meta-1", enviada_em: new Date().toISOString() });
  const falha = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.XYZ", status: "failed", errors: [{ code: 131049, title: "x", error_data: { details: "limite de marketing" } }] }] } }] }] };
  for (const a of extrairEntregas(falha)) await db.atualizarEntrega(a.id, a.entrega, a.quando, a.erro);
  const [f] = await db.consultar("SELECT entrega, erro FROM mensagens WHERE id = $1", [id2]);
  assert.equal(f.entrega, "falhou");
  assert.match(f.erro, /131049: limite de marketing/);
  // Aparece no histórico da conversa, com o número por onde saiu.
  const h = await db.historicoConversa(l.id);
  assert.deepEqual(h.filter((x) => x.autor === "nos").map((x) => [x.entrega, x.numero_wa]), [["lida", "meta-1"], ["falhou", "meta-1"]]);
});
