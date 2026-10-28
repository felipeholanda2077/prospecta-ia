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

test("agendamento do GitHub: só aceita o workflow de envios deste repositório na main", async () => {
  const { conferirClaims, tokenDoGithubValido } = await import("../src/agendamento/github.js");
  const certo = { repository: "felipeholanda2077/prospecta-ia", ref: "refs/heads/main", event_name: "schedule",
                  workflow_ref: "felipeholanda2077/prospecta-ia/.github/workflows/envios.yml@refs/heads/main" };
  assert.equal(conferirClaims(certo), true);
  assert.equal(conferirClaims({ ...certo, event_name: "workflow_dispatch" }), true);
  assert.equal(conferirClaims({ ...certo, repository: "alguem/prospecta-ia" }), false); // fork
  assert.equal(conferirClaims({ ...certo, ref: "refs/heads/outra" }), false);
  assert.equal(conferirClaims({ ...certo, event_name: "pull_request" }), false);
  assert.equal(conferirClaims({ ...certo, workflow_ref: "felipeholanda2077/prospecta-ia/.github/workflows/outro.yml@refs/heads/main" }), false);
  assert.equal(await tokenDoGithubValido("nao-e-jwt"), false);
});

test("Calendly no plano grátis: conecta sem webhook e confere as reuniões pela API", async () => {
  const calendly = await import("../src/agenda/calendly.js");
  const lead = await novoLead("Consulta", "consulta@pet.com");
  const original = globalThis.fetch;
  let statusDaReuniao = "active";
  const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = String(url);
    if (u.endsWith("/users/me")) return resposta(200, { resource: { uri: "https://api.calendly.com/users/U1", current_organization: "o", name: "FluxDeck" } });
    if (u.includes("/webhook_subscriptions")) return resposta(403, { message: "Please upgrade your Calendly account to Standard" });
    if (u.includes("/scheduled_events?")) return resposta(200, { collection: [{ uri: "https://api.calendly.com/scheduled_events/E1", status: statusDaReuniao, start_time: new Date(Date.now() + 864e5).toISOString() }], pagination: {} });
    if (u.includes("/scheduled_events/E1/invitees")) return resposta(200, { collection: [{ email: "x@y.com", name: "Ana", tracking: { utm_content: lead.token } }] });
    throw new Error(`fetch inesperado: ${opcoes.method ?? "GET"} ${u}`);
  };
  try {
    const r = await calendly.conectar("tok");
    assert.equal(r.modo, "consulta");
    assert.deepEqual(await calendly.status(), { conectado: true, modo: "consulta", conta: "FluxDeck" });

    assert.equal((await calendly.verificarAgendamentos()).novas, 1);
    assert.equal((await db.buscarLead(lead.id)).status, "agendado");
    assert.equal((await calendly.verificarAgendamentos()).novas, 0); // já vista, não avisa de novo

    statusDaReuniao = "canceled";
    assert.equal((await calendly.verificarAgendamentos()).novas, 1);
    assert.equal((await db.buscarLead(lead.id)).status, "respondeu");
  } finally {
    globalThis.fetch = original;
    await db.gravarConfig("calendly", null);
  }
});

test("áudio que não deu para transcrever: registra, para a sequência e passa para você", async () => {
  const lead = await novoLead("Audio", "audio@pet.com");
  await enviada(lead, 0);
  const camp = { ...campanha, automacao: { respostaAutomatica: true, maxRespostasIA: 6, calendly: "" } };
  const r = await registrarResposta({ lead, canal: "whatsapp", origem_id: "AUD-1", de: "5585900001111",
                                      texto: "[áudio] (não foi possível transcrever)", campanha: camp, forcarHumano: "mandou um áudio" });
  assert.equal(r.precisa_humano, true);
  const [registrada] = (await db.listarRespostas()).filter((x) => x.lead_id === lead.id);
  assert.equal(registrada.precisa_humano, "mandou um áudio");
  assert.equal((await db.buscarLead(lead.id)).status, "respondeu");
});

test("WhatsApp sai sem o rodapé de SAIR, mas quem pede para sair continua sendo descadastrado", async () => {
  const { RODAPE_WHATSAPP, linkWhatsapp } = await import("../src/envio/whatsapp.js");
  assert.equal(RODAPE_WHATSAPP, "");
  assert.doesNotMatch(decodeURIComponent(linkWhatsapp("5585988887777", "Oi, tudo bem?")), /SAIR/);
  assert.equal(classificarPorRegra("sair").classificacao, "descadastro");
});

test("cartão de contato: lê o vCard e a IA escreve para a pessoa indicada", async () => {
  const { extrairContatosVcard, contatarIndicados } = await import("../src/respostas/indicacao.js");
  const { extrairMensagemEvolution } = await import("../src/envio/evolution.js");
  const vcard = "BEGIN:VCARD\nVERSION:3.0\nN:;Numero Recepcao/adm;;;\nFN:Numero Recepcao/adm\nORG:Odonto Company;\n" +
    "item1.TEL;waid=5511965481483:+55 11 96548-1483\nitem1.X-ABLabel:Celular\nEND:VCARD";
  assert.deepEqual(extrairContatosVcard([vcard]), [{ canal: "whatsapp", nome: "Numero Recepcao/adm", empresa: "Odonto Company", numero: "5511965481483" }]);
  assert.deepEqual(extrairContatosVcard(["BEGIN:VCARD\nFN:Helena\nTEL;type=CELL:(11) 98888-7777\nEND:VCARD"])[0].numero, "5511988887777");

  const evento = { event: "messages.upsert", data: { key: { remoteJid: "5511912345678@s.whatsapp.net", fromMe: false, id: "C1" },
    pushName: "Odontocompany", message: { contactMessage: { displayName: "Numero Recepcao/adm", vcard } } } };
  assert.deepEqual(extrairMensagemEvolution(evento).vcards, [vcard]);

  const lead = await novoLead("Indica", "indica@odonto.com");
  const camp = { ...campanha, automacao: { respostaAutomatica: true, maxRespostasIA: 6, calendly: "" } };
  const contatos = extrairContatosVcard([vcard]);
  const escrever = async ({ contato }) => `Oi! A Tatiane me passou seu contato (${contato.nome}).`;
  const feitos = await contatarIndicados({ lead, contatos, de: "5511912345678", nomeDeQuemIndicou: "Odontocompany", campanha: camp, escrever });
  assert.equal(feitos.length, 1);
  const m = await db.buscarMensagem(feitos[0].mensagemId);
  assert.deepEqual([m.destino, m.status, m.tipo], ["5511965481483", "aprovada", "resposta"]);
  assert.ok(new Date(m.agendada_para) > new Date());

  // De novo (ou o próprio número de quem mandou): não escreve duas vezes.
  assert.equal((await contatarIndicados({ lead, contatos, de: "5511912345678", campanha: camp, escrever })).length, 0);
  assert.equal((await contatarIndicados({ lead, contatos: [{ nome: "Eu", numero: "5511912345678" }], de: "5511912345678", campanha: camp, escrever })).length, 0);
});

test("contato indicado informado no painel: escreve mesmo sem resposta automática e explica quando não escreve", async () => {
  const { contatarIndicados, normalizarNumeroIndicado } = await import("../src/respostas/indicacao.js");
  assert.equal(normalizarNumeroIndicado("(11) 97777-1234"), "5511977771234");
  assert.equal(normalizarNumeroIndicado("+55 11 97777-1234"), "5511977771234");

  const lead = await novoLead("Manual", "manual@odonto.com");
  const camp = { ...campanha, automacao: { respostaAutomatica: false, maxRespostasIA: 6, calendly: "" } };
  const escrever = async () => "Oi! A recepção me passou seu contato.";
  const contatos = [{ nome: "Helena", empresa: lead.nome, numero: "5511977771234" }];
  const feitos = await contatarIndicados({ lead, contatos, campanha: camp, escrever, manual: true });
  assert.equal(feitos.length, 1);
  assert.ok(new Date(feitos[0].agendadaPara) - Date.now() <= 61_000);

  const repetido = await contatarIndicados({ lead, contatos, campanha: camp, escrever, manual: true });
  assert.equal(repetido.length, 0);
  assert.match(repetido.ignorados[0].motivo, /já existe conversa/);
});

test("indicação por texto: acha o e-mail do comercial e a IA escreve um e-mail para ele", async () => {
  const { contatosNoTexto, contatarIndicados } = await import("../src/respostas/indicacao.js");
  const texto = "Sr deve tratar diretamente com o setor comercial\nneuroclin@neuroclinosasco.com.br\nresponsável Celso";
  assert.deepEqual(contatosNoTexto(texto, ["5511972049065"]), [{ canal: "email", email: "neuroclin@neuroclinosasco.com.br", nome: "", empresa: "" }]);
  assert.deepEqual(contatosNoTexto("Fala com a Ana no (11) 98888-1234, ou me liga no 11 97204-9065", ["5511972049065"]).map((c) => c.numero),
                   ["5511988881234"]); // o próprio número de quem escreveu fica de fora
  assert.deepEqual(contatosNoTexto("Abs, joao@clinica.com", ["joao@clinica.com"]), []);

  const lead = await novoLead("Neuroclin", null);
  const camp = { ...campanha, automacao: { respostaAutomatica: true, maxRespostasIA: 6, calendly: "" } };
  let pedido;
  const escrever = async (p) => { pedido = p; return { assunto: "Indicação da Yasmin, da Neuroclin", mensagem: "Olá, Celso! A Yasmin me passou seu contato." }; };
  const feitos = await contatarIndicados({ lead, contatos: contatosNoTexto(texto, ["5511972049065"]), de: "5511972049065",
                                           textoDaIndicacao: texto, campanha: camp, escrever });
  assert.equal(feitos.length, 1);
  assert.equal(pedido.canal, "email");
  assert.match(pedido.textoDaIndicacao, /Celso/);
  const m = await db.buscarMensagem(feitos[0].mensagemId);
  assert.deepEqual([m.canal, m.destino, m.assunto, m.tipo], ["email", "neuroclin@neuroclinosasco.com.br", "Indicação da Yasmin, da Neuroclin", "resposta"]);
});

test("sem interesse: encerra a empresa, agradece uma vez e não manda mais nada", async () => {
  const lead = await novoLead("SemInteresse", "nao@spf.com");
  await enviada(lead, 0);
  const etapa3 = await db.criarMensagem({ lead_id: lead.id, canal: "email", destino: lead.email, corpo: "etapa 3", etapa: 3, tipo: "sequencia", status: "aprovada" });
  const camp = { ...campanha, automacao: { respostaAutomatica: true, maxRespostasIA: 6, calendly: "" } };
  const naoQuer = async () => ({ classificacao: "sem_interesse", resumo: "Não tem interesse.", sugestao_resposta: "Imagina, obrigado pelo retorno!",
                                 precisa_humano: false, motivo_humano: "", indicou_contato: false });
  await registrarResposta({ lead, canal: "email", origem_id: "<nao-1@x>", de: lead.email, assunto: "Proposta",
                            texto: "No momento não estamos interessados, agradeço!", campanha: camp, classificar: naoQuer });

  const depois = await db.buscarLead(lead.id);
  assert.equal(depois.status, "sem_interesse");
  assert.equal((await db.buscarMensagem(etapa3)).status, "rejeitada");
  const respostas = (await db.mensagensPorStatus("aprovada")).filter((m) => m.lead_id === lead.id);
  assert.deepEqual(respostas.map((m) => [m.tipo, m.corpo]), [["resposta", "Imagina, obrigado pelo retorno!"]]);

  // Escreveu de novo ("obrigado!"): fica registrado, sem resposta e sem reabrir.
  const outro = async () => ({ classificacao: "outro", resumo: "Agradeceu.", sugestao_resposta: "De nada!", precisa_humano: false, motivo_humano: "", indicou_contato: false });
  await registrarResposta({ lead: depois, canal: "email", origem_id: "<nao-2@x>", de: lead.email, texto: "Obrigado!", campanha: camp, classificar: outro });
  assert.equal((await db.buscarLead(lead.id)).status, "sem_interesse");
  assert.equal((await db.mensagensPorStatus("aprovada")).filter((m) => m.lead_id === lead.id).length, 1);
});

test("conversas: uma por empresa, com avaliação da IA, última mensagem e funil", async () => {
  const { avaliarConversa, indicadoresDasConversas } = await import("../src/respostas/andamento.js");
  const lead = await novoLead("Conversa", "conversa@clinica.com");
  await enviada(lead, 0);
  await db.criarResposta({ lead_id: lead.id, canal: "email", origem_id: "<conv-1@x>", de: lead.email, texto: "Quanto custa?",
                           classificacao: "quer_informacoes", resumo: "Perguntou o preço", temperatura: "quente", proximo_passo: "mandar o link do Calendly" });
  const c = (await db.conversas()).find((x) => x.id === lead.id);
  assert.equal(c.respostas, 1);
  assert.equal(c.mostrou_interesse, true);
  assert.equal(c.avaliacao.temperatura, "quente");
  assert.equal(c.ultima.autor, "lead");
  const a = avaliarConversa(c);
  assert.deepEqual([a.chance, a.rotulo, a.aguardando, a.proximoPasso], ["quente", "Alta", "nos", "mandar o link do Calendly"]);

  const funil = await db.funilDeConversas();
  assert.ok(funil.contatadas >= 1 && funil.responderam >= 1 && funil.interessadas >= 1);
  const ind = indicadoresDasConversas([{ ...c, andamento: a }], funil);
  assert.equal(ind.quentes, 1);
  assert.equal(ind.ativas, 1);
});

test("andamento: status, tempo sem resposta e pedido de ajuda mudam a chance e o próximo passo", async () => {
  const { avaliarConversa } = await import("../src/respostas/andamento.js");
  const agora = new Date("2026-10-27T15:00:00Z");
  const base = { status: "respondeu", respostas: 2, mostrou_interesse: true, avaliacao: { temperatura: "quente", proximo_passo: "x" },
                 recente: { precisa_humano: null }, ultima: { autor: "nos" }, ultima_resposta: "2026-10-26T15:00:00Z", proxima: null };
  assert.equal(avaliarConversa({ ...base, status: "agendado" }, agora).chance, "agendada");
  assert.equal(avaliarConversa({ ...base, status: "sem_interesse" }, agora).chance, "encerrada");
  // 5 dias sem a empresa responder: quente vira morna.
  const esfriou = avaliarConversa({ ...base, ultima_resposta: "2026-10-22T15:00:00Z" }, agora);
  assert.deepEqual([esfriou.chance, esfriou.esfriou], ["morna", true]);
  // A IA pediu ajuda e a empresa está esperando: precisa de você.
  const ajuda = avaliarConversa({ ...base, recente: { precisa_humano: "pediu ligação" }, ultima: { autor: "lead" } }, agora);
  assert.equal(ajuda.precisaDeVoce, true);
  assert.match(ajuda.proximoPasso, /pediu ligação/);
  // Sem avaliação da IA (respostas antigas): estima pelo que a empresa disse.
  assert.equal(avaliarConversa({ ...base, avaliacao: null, mostrou_interesse: false, respostas: 1 }, agora).chance, "fria");
});

test("funil: quantas empresas contatadas não responderam (a resposta automática não conta)", async () => {
  const { indicadoresDasConversas } = await import("../src/respostas/andamento.js");
  const antes = await db.funilDeConversas();
  const naSequencia = await novoLead("Sem resposta 1", "sem1@clinica.com");
  await enviada(naSequencia, 0);
  await db.criarMensagem({ lead_id: naSequencia.id, canal: "email", destino: naSequencia.email, corpo: "etapa 2", status: "aprovada", tipo: "sequencia", etapa: 2 });
  const encerrada = await novoLead("Sem resposta 2", "sem2@clinica.com");
  await enviada(encerrada, 3);
  await db.criarResposta({ lead_id: encerrada.id, canal: "whatsapp", origem_id: "auto-1", de: "1", texto: "Obrigado pelo contato!", classificacao: "automatica" });
  const respondeu = await novoLead("Respondeu de verdade", "resp@clinica.com");
  await enviada(respondeu, 0);
  await db.criarResposta({ lead_id: respondeu.id, canal: "email", origem_id: "<resp-1@x>", de: respondeu.email, texto: "Agora não", classificacao: "sem_interesse" });

  const depois = await db.funilDeConversas();
  assert.equal(depois.contatadas - antes.contatadas, 3);
  assert.equal(depois.nao_responderam - antes.nao_responderam, 2);
  assert.equal(depois.nao_responderam_na_sequencia - antes.nao_responderam_na_sequencia, 1);
  const ind = indicadoresDasConversas([], depois);
  assert.equal(ind.naoResponderam, depois.nao_responderam);
  assert.equal(ind.naoResponderamNaSequencia + ind.naoResponderamSequenciaEncerrada, ind.naoResponderam);
});

test("contato novo no WhatsApp: conhecido fica de fora; cliente de empresa já contatada entra na conversa dela", async () => {
  const { avaliarContato, leadDoContato } = await import("../src/respostas/contatoNovo.js");
  const loja = await novoLead("Belieze Loja Roupa Feminina", "belieze@loja.com");
  await enviada(loja, 1);
  const msg = (id, texto, fromMe = false) => ({ key: { id, fromMe, remoteJid: "999@lid" }, messageTimestamp: 1, message: { conversation: texto } });
  let avaliacoes = 0;
  const avaliar = async ({ mensagens, empresasContatadas }) => {
    avaliacoes++;
    assert.ok(empresasContatadas.some((e) => e.id === loja.id));
    return mensagens.some((t) => /site/.test(t))
      ? { tipo: "cliente", lead_id: loja.id, empresa: "Belieze", nome_pessoa: "Patrícia", resumo: "quer site" }
      : { tipo: "incerto", lead_id: 0, empresa: "", nome_pessoa: "", resumo: "" };
  };
  const registradas = [];
  const opcoes = (conversa) => ({ esperar: 0, avaliar, buscar: async () => conversa, registrar: async (r) => registradas.push(r) });

  // Conversa em que você já escreveu é de um conhecido: nem passa pela IA.
  const amigo = { id: "A1", de: "888@lid", jid: "888@lid", texto: "bora?", nome: "Amigo" };
  assert.equal((await avaliarContato(amigo, campanha, opcoes([msg("A0", "e aí", true), msg("A1", "bora?")]))).tipo, "conhecido");
  assert.equal(await avaliarContato(amigo, campanha, opcoes([msg("A1", "bora?")])), null); // fica de fora por uns dias
  assert.equal(avaliacoes, 0);

  // Só "Oi" ainda não diz nada: a próxima mensagem é avaliada de novo.
  const patricia = { id: "P1", de: "999@lid", jid: "999@lid", texto: "Oi", nome: "Patricia" };
  assert.equal((await avaliarContato(patricia, campanha, opcoes([msg("P1", "Oi")]))).tipo, "incerto");
  const conversa = [msg("P3", "Gostaria de falar sobre site"), msg("P2", "Sou a Patrícia da belieze"), msg("P1", "Oi")];
  const r = await avaliarContato({ ...patricia, id: "P3" }, campanha, opcoes(conversa));
  assert.equal(r.lead.id, loja.id);
  assert.deepEqual(registradas, [{ lead: r.lead, origem_id: "P3", texto: "Oi\nSou a Patrícia da belieze\nGostaria de falar sobre site" }]);
  assert.equal((await leadDoContato("999@lid")).id, loja.id);
});

test("contato novo que é cliente e não foi prospectado vira lead do WhatsApp", async () => {
  const { avaliarContato } = await import("../src/respostas/contatoNovo.js");
  const avaliar = async () => ({ tipo: "cliente", lead_id: 0, empresa: "", nome_pessoa: "Joana", resumo: "quer uma loja virtual" });
  const r = await avaliarContato({ id: "J1", de: "5511977776666", jid: "5511977776666@s.whatsapp.net", texto: "Quanto custa uma loja virtual?", nome: "Joana Doces" },
    campanha, { esperar: 0, avaliar, buscar: async () => [], registrar: async () => {} });
  assert.equal(r.lead.nome, "Joana");
  assert.equal(r.lead.origem, "whatsapp");
  assert.equal(r.lead.status, "respondeu");
  assert.equal(r.lead.whatsapp, "5511977776666");
});

test("quem demonstra interesse recebe a apresentação uma vez; depois a conversa segue normal", async () => {
  const lead = await novoLead("Loja Apresentacao", "apresenta@loja.com");
  await enviada(lead, 1);
  const camp = { ...campanha, automacao: { respostaAutomatica: true, maxRespostasIA: 6 } };
  const classificar = async () => ({ classificacao: "interessado", resumo: "quer site", sugestao_resposta: "Bora marcar?",
    precisa_humano: false, motivo_humano: "", indicou_contato: false, temperatura: "quente", proximo_passo: "" });
  const apresentar = async ({ apresentacao }) => {
    assert.match(apresentacao, /Professional/);
    return "Apresentação completa";
  };
  const corpos = async () => (await db.mensagensPorStatus("aprovada")).filter((m) => m.lead_id === lead.id).map((m) => m.corpo);

  await registrarResposta({ lead, canal: "whatsapp", origem_id: "AP1", de: "999@lid", texto: "Quero falar sobre site", campanha: camp, classificar, apresentar });
  assert.deepEqual(await corpos(), ["Apresentação completa"]);
  // Ela escreveu de novo antes de a apresentação sair: a que estava na fila é trocada, e a nova ainda é a apresentação.
  await registrarResposta({ lead: await db.buscarLead(lead.id), canal: "whatsapp", origem_id: "AP2", de: "999@lid",
    texto: "É para minha loja", campanha: camp, classificar, apresentar });
  assert.deepEqual(await corpos(), ["Apresentação completa"]);
  // Depois que ela saiu, a conversa segue sem repetir.
  for (const m of (await db.mensagensPorStatus("aprovada")).filter((x) => x.lead_id === lead.id)) {
    await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: new Date().toISOString() });
  }
  await registrarResposta({ lead: await db.buscarLead(lead.id), canal: "whatsapp", origem_id: "AP3", de: "999@lid",
    texto: "Legal, e o prazo?", campanha: camp, classificar, apresentar });
  assert.deepEqual(await corpos(), ["Bora marcar?"]);
});

test("IA continua: conversa que tinha passado para você volta para a IA, com a sua dica", async () => {
  const { continuarComIA } = await import("../src/respostas/processar.js");
  const lead = await novoLead("Clinica Ambigua", "ambigua@clinica.com");
  await enviada(lead, 1);
  const camp = { ...campanha, automacao: { respostaAutomatica: true, maxRespostasIA: 6 } };
  const humano = async () => ({ classificacao: "outro", resumo: "98%", sugestao_resposta: "Só para confirmar?", precisa_humano: true,
    motivo_humano: "resposta ambígua", indicou_contato: false, temperatura: "fria", proximo_passo: "" });
  const r = await registrarResposta({ lead, canal: "whatsapp", origem_id: "AMB1", de: "5511900000000", texto: "98%", campanha: camp, classificar: humano });

  let notaRecebida;
  const segue = async ({ nota }) => {
    notaRecebida = nota;
    return { classificacao: "outro", resumo: "98% pelo WhatsApp", sugestao_resposta: "Que legal, 98% pelo WhatsApp!", precisa_humano: false,
      motivo_humano: "", indicou_contato: false, temperatura: "morna", proximo_passo: "" };
  };
  const c = await continuarComIA(r.id, camp, { nota: "é sobre o WhatsApp", classificar: segue });
  assert.equal(notaRecebida, "é sobre o WhatsApp");
  assert.equal(c.sugestao, "Que legal, 98% pelo WhatsApp!");
  const resp = await db.buscarResposta(r.id);
  assert.equal(resp.precisa_humano, null);
  assert.equal(resp.mensagem_id, c.mensagemId);
  assert.deepEqual((await db.mensagensPorStatus("aprovada")).filter((m) => m.lead_id === lead.id).map((m) => m.corpo), ["Que legal, 98% pelo WhatsApp!"]);
});
