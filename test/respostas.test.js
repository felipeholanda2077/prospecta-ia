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
const { extrairMensagemUazap, webhookValido, resumirStatus } = await import("../src/envio/uazap.js");

const campanha = { empresa: { nome: "X", responsavel: "Y", telefone: "1" }, servicos: [] };

async function novoLead(nome, email) {
  await db.inserirLead({ place_id: nome, nome, nicho: "pet shop", cidade: "Fortaleza", endereco: null,
                         telefone: null, site: null, maps_url: null, avaliacao: null, total_avaliacoes: null });
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.nome === nome);
  await db.atualizarLead(lead.id, { email, status: "contatado", oportunidades: "[]" });
  return db.buscarLead(lead.id);
}

async function enviada(lead, diasAtras) {
  const id = await db.criarMensagem({ lead_id: lead.id, canal: "email", destino: lead.email, assunto: "Proposta", corpo: "..." });
  await db.atualizarMensagem(id, {
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

test("histórico da conversa junta o que enviamos e o que o lead respondeu, em ordem", async () => {
  const lead = await novoLead("Historico", "historico@pet.com");
  await enviada(lead, 2);
  await db.criarResposta({ lead_id: lead.id, canal: "email", origem_id: "h1", de: lead.email, texto: "Quanto custa?" });
  const h = await db.historicoConversa(lead.id);
  assert.deepEqual(h.map((x) => x.autor), ["nos", "lead"]);
  assert.equal(h[1].texto, "Quanto custa?");
});

test("extrairMensagemUazap lê o evento de mensagem recebida", () => {
  const base = { EventType: "messages", token: "T", message: { messageid: "M1", chatid: "5585988887777@s.whatsapp.net",
    sender: "5585988887777@s.whatsapp.net", fromMe: false, isGroup: false, text: "Tenho interesse" } };
  assert.deepEqual(extrairMensagemUazap(base), { id: "M1", de: "5585988887777", texto: "Tenho interesse", nome: null });
  assert.equal(extrairMensagemUazap({ ...base, message: { ...base.message, fromMe: true } }), null);
  assert.equal(extrairMensagemUazap({ ...base, message: { ...base.message, isGroup: true } }), null);
  assert.equal(extrairMensagemUazap({ ...base, EventType: "connection" }), null);
  assert.equal(extrairMensagemUazap({ ...base, message: { ...base.message, chatid: "123@lid", sender: "123@lid" } }), null);
});

test("webhook da UAZap só é aceito com o segredo certo e o token da instância", async () => {
  await db.gravarConfig("uazap", { url: "https://x.uazapi.com", token: "TOKEN-INST", segredoWebhook: "segredo123" });
  assert.equal(await webhookValido("segredo123", { token: "TOKEN-INST" }), true);
  assert.equal(await webhookValido("errado", { token: "TOKEN-INST" }), false);
  assert.equal(await webhookValido("segredo123", { token: "OUTRO" }), false);
  assert.equal(resumirStatus({ instance: { status: "connecting", qrcode: "data:image/png;base64,AAA" }, status: { connected: false } }).qrcode,
               "data:image/png;base64,AAA");
  assert.equal(resumirStatus({ instance: { status: "connected" }, status: { connected: true, loggedIn: true, jid: "5585999990000:12@s.whatsapp.net" } }).numero,
               "5585999990000");
});

test("resposta 'SAIR' descadastra o lead e cancela o follow-up pendente", async () => {
  const lead = await novoLead("Sair", "sair@pet.com");
  const original = await enviada(lead, 5);
  await db.criarMensagem({ lead_id: lead.id, canal: "email", destino: lead.email, corpo: "lembrete",
                     status: "aprovada", tipo: "followup", responde_a: original });

  assert.equal((await db.mensagemPorMessageIds([`<${original}@teste>`])).id, original);
  const r = await registrarResposta({ lead, canal: "email", origem_id: "<resp1@x>", de: lead.email,
                                      texto: "SAIR", mensagemOriginal: await db.buscarMensagem(original), campanha });
  assert.equal(r.classificacao, "descadastro");
  assert.equal((await db.buscarLead(lead.id)).status, "descadastrado");
  assert.equal(await db.estaDescadastrado("sair@pet.com"), true);
  assert.equal((await db.mensagensPorStatus("aprovada")).filter((m) => m.lead_id === lead.id).length, 0);

  // A mesma resposta lida de novo não é registrada duas vezes.
  assert.equal(await registrarResposta({ lead, canal: "email", origem_id: "<resp1@x>", de: lead.email,
                                         texto: "SAIR", campanha }), null);
});

test("resposta automática não encerra o lead", async () => {
  const lead = await novoLead("Ferias", "ferias@pet.com");
  await enviada(lead, 5);
  const r = await registrarResposta({ lead, canal: "email", origem_id: "<auto1@x>", de: lead.email,
                                      assunto: "Resposta automática", texto: "Estou de férias", campanha });
  assert.equal(r.classificacao, "automatica");
  assert.equal((await db.buscarLead(lead.id)).status, "contatado");
});

test("Calendly: link próprio de cada empresa e assinatura do webhook", async () => {
  const calendly = await import("../src/agenda/calendly.js");
  const link = calendly.linkAgendamento("https://calendly.com/fluxdeck/15min", { token: "abc123", email: "a@b.com" }, "email");
  const u = new URL(link);
  assert.equal(u.searchParams.get("utm_content"), "abc123");
  assert.equal(u.searchParams.get("email"), "a@b.com");
  assert.equal(calendly.linkAgendamento("", { token: "x" }, "email"), "");

  const corpo = '{"event":"invitee.created"}';
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", "chave").update(`${t}.${corpo}`).digest("hex");
  assert.equal(calendly.assinaturaValida(`t=${t},v1=${v1}`, corpo, "chave"), true);
  assert.equal(calendly.assinaturaValida(`t=${t},v1=${v1}`, corpo + " ", "chave"), false);
  assert.equal(calendly.assinaturaValida(`t=${t - 3600},v1=${v1}`, corpo, "chave"), false); // muito antigo

  const lead = await novoLead("Agenda", "agenda@pet.com");
  assert.equal((await calendly.leadDoEvento({ tracking: { utm_content: lead.token } })).id, lead.id);
  assert.equal((await calendly.leadDoEvento({ email: "AGENDA@pet.com" })).id, lead.id);
});

test("resposta automática: quando a IA não consegue ler, passa a conversa para você", async () => {
  const lead = await novoLead("Humano", "humano@pet.com");
  await enviada(lead, 1);
  const camp = { ...campanha, automacao: { respostaAutomatica: true, maxRespostasIA: 6, calendly: "" } };
  const r = await registrarResposta({ lead, canal: "email", origem_id: "<h-1@x>", de: lead.email, texto: "Quanto custa?", campanha: camp });
  assert.equal(r.precisa_humano, true);
  const [registrada] = (await db.listarRespostas()).filter((x) => x.lead_id === lead.id);
  assert.ok(registrada.precisa_humano);
  assert.equal(registrada.mensagem_id, null);
  assert.equal((await db.buscarLead(lead.id)).status, "respondeu");
});

test("teste de e-mail explica os erros comuns do SMTP", async () => {
  const { explicarErroEmail, testarEmail } = await import("../src/envio/email.js");
  assert.match(explicarErroEmail({ code: "EAUTH", message: "535 Invalid login" }), /senha de app/);
  assert.match(explicarErroEmail({ code: "EDNS", message: "getaddrinfo ENOTFOUND smtp.x" }), /Não encontrei o servidor/);
  assert.match(explicarErroEmail({ code: "ETIMEDOUT", message: "timeout" }), /porta/);
  // Sem SMTP configurado (como nos testes), o painel recebe o motivo em vez de um erro.
  const r = await testarEmail("teste@exemplo.com");
  assert.equal(r.smtp.ok, false);
  assert.match(r.smtp.erro, /SMTP não configurado/);
  assert.equal(r.imap.ok, false);
});
