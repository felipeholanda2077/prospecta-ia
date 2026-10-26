import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const { dentroDoHorario } = await import("../src/pipeline.js");

const LIMITES = { horarioComercial: { inicio: 9, fim: 18 }, somenteDiasUteis: true };

test("horário comercial em São Paulo", () => {
  assert.equal(dentroDoHorario(LIMITES, new Date("2026-10-27T13:00:00Z")), true); // terça 10h
  assert.equal(dentroDoHorario(LIMITES, new Date("2026-10-27T23:00:00Z")), false); // terça 20h
  assert.equal(dentroDoHorario(LIMITES, new Date("2026-10-25T13:00:00Z")), false); // domingo
});

test("empresa duplicada não é inserida duas vezes", () => {
  const lead = { place_id: "abc", nome: "Pet Feliz", nicho: "pet shop", cidade: "Fortaleza - CE",
                 endereco: null, telefone: null, site: null, avaliacao: null, total_avaliacoes: null };
  assert.equal(db.inserirLead(lead), true);
  assert.equal(db.inserirLead(lead), false);
});

test("descadastro é respeitado independente de maiúsculas e formatação", () => {
  db.descadastrar("Contato@PetFeliz.com.br");
  db.descadastrar("(85) 98888-7777");
  assert.equal(db.estaDescadastrado("contato@petfeliz.com.br"), true);
  assert.equal(db.estaDescadastrado("85988887777"), true);
  assert.equal(db.estaDescadastrado("outro@petfeliz.com.br"), false);
});

test("mesmo contato não recebe duas propostas", () => {
  const lead = db.leadsPorStatus("novo")[0];
  assert.equal(db.contatoJaUsado("vendas@petfeliz.com.br"), false);
  db.criarMensagem({ lead_id: lead.id, canal: "email", destino: "Vendas@PetFeliz.com.br", assunto: "Oi", corpo: "..." });
  assert.equal(db.contatoJaUsado("vendas@petfeliz.com.br"), true);
  assert.equal(db.contatoJaUsado("vendas@petfeliz.com.br", ["enviada"]), false);
});
