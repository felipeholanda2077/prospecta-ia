import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const ps = await import("../src/vendas/propostaSlides.js");
await db.iniciar();

test("proposta em slides: escrita pela conversa, com código próprio, link do site e a mensagem com o link", async () => {
  await db.inserirLead({ place_id: "ChIJproposta000000000000001", nome: "Hospital Vet 24H", cidade: "Osasco - SP" });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJproposta000000000000001"]);
  await assert.rejects(ps.gerarPropostaSlides(l.id, { gerar: async () => ({}) }), /ainda não tem conversa/);
  await db.consultar("INSERT INTO respostas (lead_id, canal, texto, recebida_em, classificacao) VALUES ($1, 'whatsapp', 'Teria alguma proposta?', now(), 'quer_informacoes')", [l.id]);
  let pedido = "";
  const gerar = async (o) => {
    pedido = o.pedido;
    return { titulo: "WhatsApp cheio no pico", resumo: "r", dores: [{ titulo: "a", texto: "b" }, { titulo: "c", texto: "d" }], solucao: { titulo: "IA 24 h", itens: [] },
      passos: ["1", "2", "3"], resultados: ["x", "y", "z"], proximoPasso: "conversar", mensagem: "Tenho sim, Anna! {{link}} Pode encaminhar?" };
  };
  const r = await ps.gerarPropostaSlides(l.id, { gerar });
  assert.match(pedido, /Teria alguma proposta\?/);
  assert.match(r.link, /^https:\/\/fluxdeck\.com\.br\/apresentacao\?para=Hospital%20Vet%2024H&proposta=[A-Za-z0-9_-]{16}$/);
  assert.equal(r.mensagem, `Tenho sim, Anna! ${r.link} Pode encaminhar?`);
  const publica = await ps.propostaPublica(r.codigo);
  assert.equal(publica.empresa, "Hospital Vet 24H");
  assert.equal(publica.mensagem, undefined);
  // Refazer mantém o mesmo link.
  assert.equal((await ps.gerarPropostaSlides(l.id, { gerar })).codigo, r.codigo);
  assert.equal(await ps.propostaPublica("../x"), null);
});
