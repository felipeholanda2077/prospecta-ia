import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

test("janela de 24 h da Meta: aberta só se a pessoa escreveu no WhatsApp há menos de 24 h", async () => {
  await db.inserirLead({ place_id: "ChIJjanela00000000000000001", nome: "Clínica Janela", cidade: "Osasco - SP" });
  const [lead] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJjanela00000000000000001"]);
  assert.equal(await pipeline.janelaDe24hAberta(lead.id), false);
  await db.consultar("INSERT INTO respostas (lead_id, canal, texto, recebida_em, classificacao) VALUES ($1, 'whatsapp', 'Oi', now() - interval '2 hours', 'interessado')", [lead.id]);
  assert.equal(await pipeline.janelaDe24hAberta(lead.id), true);
  assert.equal(await pipeline.janelaDe24hAberta(lead.id, new Date(Date.now() + 30 * 3600_000)), false);
  // Número que não está ligado em Configurações não pode ser escolhido.
  await assert.rejects(pipeline.trocarNumeroDaConversa(lead.id, "meta-999"), /não está ligado/);
});

test("cada conversa sabe por qual número sai (para ver as mensagens de cada número separadas)", async () => {
  const criar = async (place, nome) => {
    await db.inserirLead({ place_id: place, nome, cidade: "Osasco - SP" });
    const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [place]);
    await db.consultar("INSERT INTO respostas (lead_id, canal, texto, recebida_em, classificacao) VALUES ($1, 'whatsapp', 'Oi', now(), 'interessado')", [l.id]);
    return l.id;
  };
  const meta = await criar("ChIJnumero000000000000000001", "Pela Meta");
  await db.atualizarLead(meta, { numero_wa: "meta-123" });
  const antiga = await criar("ChIJnumero000000000000000002", "Conversa Antiga");
  await db.consultar("INSERT INTO mensagens (lead_id, canal, etapa, destino, corpo, status, enviada_em) VALUES ($1, 'whatsapp', 1, '5511999990000', 'Olá', 'enviada', now())", [antiga]);
  const soEmail = await criar("ChIJnumero000000000000000003", "Só E-mail");
  const lista = await db.conversas();
  const de = (id) => lista.find((c) => c.id === id)?.numero_conversa;
  assert.equal(de(meta), "meta-123");
  assert.equal(de(antiga), "principal"); // de antes de existirem vários números: o principal da UAZap
  assert.equal(de(soEmail), null);
});

test("enviadas: as mais recentes primeiro (as de hoje não somem atrás das antigas)", async () => {
  await db.inserirLead({ place_id: "ChIJordem0000000000000000001", nome: "Ordem", cidade: "Osasco - SP" });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJordem0000000000000000001"]);
  await db.consultar(`INSERT INTO mensagens (lead_id, canal, etapa, destino, corpo, status, enviada_em, numero_wa) VALUES
    ($1, 'whatsapp', 1, '5511999990001', 'antiga', 'enviada', now() - interval '3 days', 'principal'),
    ($1, 'whatsapp', 2, '5511999990001', 'nova', 'enviada', now(), 'meta-123')`, [l.id]);
  const lista = await db.mensagensPorStatus("enviada", 10);
  const minhas = lista.filter((m) => m.lead_id === l.id).map((m) => m.corpo);
  assert.deepEqual(minhas, ["nova", "antiga"]);
  assert.equal(lista[0].corpo, "nova");
});

test("intervalo: o número oficial da Meta tem o próprio (2 a 4 min por padrão), mais curto que o da UAZap", async () => {
  assert.equal(pipeline.intervaloDoOficialMs({}, 0), 2 * 60_000);
  assert.equal(pipeline.intervaloDoOficialMs({}, 1), 4 * 60_000);
  assert.equal(pipeline.intervaloDoOficialMs({ intervaloOficialMin: 1, intervaloOficialMax: 1 }, 0.7), 60_000);
  assert.equal(pipeline.intervaloEntreEmpresasMs({}, 0), 5 * 60_000);
});
