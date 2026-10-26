import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const { limparTextoResposta, classificarPorRegra } = await import("../src/ia/resposta.js");
const { variantesWhatsappBR } = await import("../src/analise/telefone.js");
const { assinaturaValida, extrairMensagens } = await import("../src/respostas/whatsapp.js");
const { idsReferenciados } = await import("../src/respostas/email.js");
const { registrarResposta } = await import("../src/respostas/processar.js");

const campanha = { empresa: { nome: "X", responsavel: "Y", telefone: "1" }, servicos: [] };

function novoLead(nome, email) {
  db.inserirLead({ place_id: nome, nome, nicho: "pet shop", cidade: "Fortaleza", endereco: null,
                   telefone: null, site: null, avaliacao: null, total_avaliacoes: null });
  const lead = db.leadsPorStatus("novo").find((l) => l.nome === nome);
  db.atualizarLead(lead.id, { email, status: "contatado", oportunidades: "[]" });
  return db.buscarLead(lead.id);
}

function enviada(lead, diasAtras) {
  const id = db.criarMensagem({ lead_id: lead.id, canal: "email", destino: lead.email, assunto: "Proposta", corpo: "..." });
  db.atualizarMensagem(id, {
    status: "enviada",
    enviada_em: new Date(Date.now() - diasAtras * 86400000).toISOString(),
    message_id: `<${id}@teste>`,
  });
  return id;
}

test("limparTextoResposta remove o histórico citado", () => {
  const texto = "Tenho interesse, pode ligar?\n\nEm seg., 26 de out. de 2026, Fulano escreveu:\n> Olá, tudo bem?\n> Proposta...";
  assert.equal(limparTextoResposta(texto), "Tenho interesse, pode ligar?");
  assert.equal(limparTextoResposta("> só citação\nok"), "ok");
});

test("classificarPorRegra pega pedidos de saída e respostas automáticas sem usar IA", () => {
  assert.equal(classificarPorRegra("SAIR").classificacao, "descadastro");
  assert.equal(classificarPorRegra("Por favor, não quero mais receber essas mensagens").classificacao, "descadastro");
  assert.equal(classificarPorRegra("Estou de férias até dia 10.").classificacao, "automatica");
  assert.equal(classificarPorRegra("ok", "Resposta automática: ausente").classificacao, "automatica");
  assert.equal(classificarPorRegra("Quanto custa a loja virtual?"), null);
  assert.equal(classificarPorRegra("Quero sair do sistema antigo, vocês migram?"), null);
});

test("variantes do número com e sem o nono dígito", () => {
  assert.deepEqual(variantesWhatsappBR("5585988887777"), ["5585988887777", "558588887777"]);
  assert.deepEqual(variantesWhatsappBR("558588887777"), ["558588887777", "5585988887777"]);
  assert.deepEqual(variantesWhatsappBR("558533334444"), ["558533334444"]);
});

test("assinatura do webhook do WhatsApp", () => {
  const corpo = Buffer.from('{"entry":[]}');
  const assinatura = "sha256=" + crypto.createHmac("sha256", "segredo").update(corpo).digest("hex");
  assert.equal(assinaturaValida(corpo, assinatura, "segredo"), true);
  assert.equal(assinaturaValida(corpo, assinatura, "outro"), false);
  assert.equal(assinaturaValida(corpo, undefined, "segredo"), false);
  assert.equal(assinaturaValida(corpo, assinatura, ""), false);
});

test("extrairMensagens lê texto e botões do payload da Meta", () => {
  const payload = { entry: [{ changes: [{ value: { messages: [
    { id: "w1", from: "558588887777", type: "text", text: { body: "Tenho interesse" } },
    { id: "w2", from: "558588887777", type: "button", button: { text: "SAIR" } },
    { id: "w3", from: "558588887777", type: "image", image: {} },
  ] } }] }] };
  assert.deepEqual(extrairMensagens(payload).map((m) => m.texto), ["Tenho interesse", "SAIR"]);
  assert.deepEqual(extrairMensagens({}), []);
});

test("idsReferenciados junta In-Reply-To e References", () => {
  assert.deepEqual(idsReferenciados({ inReplyTo: "<a@x>", references: ["<b@x>", "<a@x>"] }), ["<a@x>", "<b@x>", "<a@x>"]);
  assert.deepEqual(idsReferenciados({ references: "<b@x> <c@x>" }), ["<b@x>", "<c@x>"]);
});

test("follow-up só para quem não respondeu e já passou o prazo", () => {
  const antigo = novoLead("Antigo", "antigo@pet.com");
  const recente = novoLead("Recente", "recente@pet.com");
  const respondeu = novoLead("Respondeu", "respondeu@pet.com");
  const original = enviada(antigo, 5);
  enviada(recente, 1);
  enviada(respondeu, 5);
  db.criarResposta({ lead_id: respondeu.id, canal: "email", origem_id: "r1", de: respondeu.email, texto: "oi" });

  assert.deepEqual(db.candidatosFollowup(4).map((m) => m.empresa), ["Antigo"]);

  // Depois de criado o follow-up, o lead não aparece de novo.
  db.criarMensagem({ lead_id: antigo.id, canal: "email", destino: antigo.email, corpo: "lembrete",
                     tipo: "followup", responde_a: original });
  assert.deepEqual(db.candidatosFollowup(4), []);
});

test("resposta 'SAIR' descadastra o lead e cancela o follow-up pendente", async () => {
  const lead = novoLead("Sair", "sair@pet.com");
  const original = enviada(lead, 5);
  db.criarMensagem({ lead_id: lead.id, canal: "email", destino: lead.email, corpo: "lembrete",
                     status: "aprovada", tipo: "followup", responde_a: original });

  assert.equal(db.mensagemPorMessageIds([`<${original}@teste>`]).id, original);
  const r = await registrarResposta({ lead, canal: "email", origem_id: "<resp1@x>", de: lead.email,
                                      texto: "SAIR", mensagemOriginal: db.buscarMensagem(original), campanha });
  assert.equal(r.classificacao, "descadastro");
  assert.equal(db.buscarLead(lead.id).status, "descadastrado");
  assert.equal(db.estaDescadastrado("sair@pet.com"), true);
  assert.equal(db.mensagensPorStatus("aprovada").filter((m) => m.lead_id === lead.id).length, 0);

  // A mesma resposta lida de novo não é registrada duas vezes.
  assert.equal(await registrarResposta({ lead, canal: "email", origem_id: "<resp1@x>", de: lead.email,
                                         texto: "SAIR", campanha }), null);
});

test("resposta automática não encerra o lead", async () => {
  const lead = novoLead("Ferias", "ferias@pet.com");
  enviada(lead, 5);
  const r = await registrarResposta({ lead, canal: "email", origem_id: "<auto1@x>", de: lead.email,
                                      assunto: "Resposta automática", texto: "Estou de férias", campanha });
  assert.equal(r.classificacao, "automatica");
  assert.equal(db.buscarLead(lead.id).status, "contatado");
});
