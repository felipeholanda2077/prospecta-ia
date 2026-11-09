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
