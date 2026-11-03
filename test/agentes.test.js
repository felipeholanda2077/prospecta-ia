import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const agentes = await import("../src/respostas/agentes.js");
const { processarWebhookUazap } = await import("../src/respostas/whatsapp.js");
const { continuarComIA, iaPausada } = await import("../src/respostas/processar.js");
const { avaliarConversa } = await import("../src/respostas/andamento.js");
const { arrumarResposta, paraClassificacao, baseParaOPedido } = await import("../src/ia/agente.js");
const pipeline = await import("../src/pipeline.js");

// Dois números na UAZap: o principal (prospecção da FluxDeck) e o do agente.
await db.gravarConfig("uazap", { numeros: [
  { id: "principal", nome: "Principal", url: "https://x.uazapi.com", token: "A", segredoWebhook: "s1" },
  { id: "rastreio", nome: "Rastreio", url: "https://x.uazapi.com", token: "B", segredoWebhook: "s2" },
] });

const campanha = {
  empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [],
  limites: { horarioComercial: { inicio: 0, fim: 24 }, somenteDiasUteis: false, envioDiarioMax: 50 },
  automacao: { respostaAutomatica: true, maxRespostasIA: 5 },
};
const aviso = (id, de, texto, nome = "Carlos") => ({
  EventType: "messages", message: { messageid: id, chatid: `${de}@s.whatsapp.net`, text: texto, senderName: nome },
});
/** IA do agente de mentira: devolve o que o teste mandar e guarda o que recebeu. */
function iaFalsa(resposta) {
  const pedidos = [];
  const responder = async (ctx) => {
    pedidos.push(ctx);
    return paraClassificacao(arrumarResposta({
      classificacao: "quer_informacoes", resumo: "Perguntou do rastreador", mensagens: [], delegar: false, motivo_delegar: "",
      temperatura: "morna", proximo_passo: "qualificar", robo: false, encerrar: false, ...resposta,
    }));
  };
  return { responder, pedidos };
}
const naoUsar = async () => { throw new Error("não deveria usar a IA da FluxDeck"); };
const respostasDaFila = (leadId) => db.consultar(
  "SELECT corpo, agendada_para FROM mensagens WHERE lead_id = $1 AND tipo = 'resposta' AND status = 'aprovada' ORDER BY agendada_para, id", [leadId]);

let bruno;

test("agentes: nome obrigatório, só liga com prompt e número, e um número é de um agente só", async () => {
  await assert.rejects(agentes.salvarAgente(null, { nome: " " }), /nome/);
  await assert.rejects(agentes.salvarAgente(null, { nome: "X", ligado: true, numeros: ["rastreio"] }), /prompt/);
  await assert.rejects(agentes.salvarAgente(null, { nome: "X", prompt: "p", ligado: true }), /número/);
  await assert.rejects(agentes.salvarAgente(null, { nome: "X", numeros: ["nao-existe"] }), /não existe/);
  bruno = await agentes.salvarAgente(null, { nome: "Bruno", prompt: "# BRUNO\nVocê é Bruno. Use DELEGAR quando...", pendencias: "base oficial" });
  assert.equal(bruno.ligado, false);
  assert.deepEqual(agentes.faltando(bruno), ["a base de conhecimento", "o número de WhatsApp"]);
  bruno = await agentes.salvarAgente(bruno.id, { numeros: ["rastreio"], ligado: true });
  assert.equal(bruno.prompt, "# BRUNO\nVocê é Bruno. Use DELEGAR quando..."); // o resto não muda ao salvar parte dos campos
  const outro = await agentes.salvarAgente(null, { nome: "Outro" });
  await assert.rejects(agentes.salvarAgente(outro.id, { numeros: ["rastreio"] }), /já é atendido pelo agente Bruno/);
  await agentes.excluirAgente(outro.id);
  assert.equal((await agentes.agenteDoNumero("rastreio")).id, bruno.id);
  assert.equal(await agentes.agenteDoNumero("principal"), null);
});

test("agentes: contato novo no número do agente vira conversa dele e a resposta sai em até 3 partes", async () => {
  const ia = iaFalsa({ mensagens: ["Olá! Me chamo Bruno.", "Antes de começarmos, poderia me informar seu nome?", "parte 3", "parte 4"] });
  await db.atualizarAgente(bruno.id, { conhecimento: "Plano Básico: R$ 59,90 por mês." });
  bruno = await db.buscarAgente(bruno.id);
  const n = await processarWebhookUazap(aviso("R1", "5511977776666", "Oi, quero rastrear meu carro"), campanha, "rastreio",
    { responderAgente: ia.responder, avaliar: naoUsar });
  assert.equal(n, 1);
  const [lead] = await db.consultar("SELECT * FROM leads WHERE agente_id = $1", [bruno.id]);
  assert.equal(lead.whatsapp, "5511977776666");
  assert.equal(lead.numero_wa, "rastreio");
  assert.equal(lead.nome, "Carlos");
  // A IA recebeu o prompt do agente e a base dele.
  assert.equal(ia.pedidos[0].agente.id, bruno.id);
  assert.match(ia.pedidos[0].fontes.map((f) => f.texto).join(), /R\$ 59,90/);
  const fila = await respostasDaFila(lead.id);
  assert.deepEqual(fila.map((m) => m.corpo), ["Olá! Me chamo Bruno.", "Antes de começarmos, poderia me informar seu nome?", "parte 3\n\nparte 4"]);
  assert.ok(new Date(fila[0].agendada_para) - Date.now() < 3 * 60_000); // agente responde em 1 a 2,5 minutos

  // A próxima mensagem do mesmo telefone (sem o nono dígito) cai na mesma conversa.
  await processarWebhookUazap(aviso("R2", "551177776666", "Meu nome é Carlos"), campanha, "rastreio", { responderAgente: iaFalsa({ mensagens: ["Prazer, Carlos!"] }).responder });
  assert.equal((await db.consultar("SELECT count(*)::int AS n FROM leads WHERE agente_id = $1", [bruno.id]))[0].n, 1);
  assert.deepEqual((await respostasDaFila(lead.id)).map((m) => m.corpo), ["Prazer, Carlos!"]); // a resposta anterior foi trocada
});

test("agentes: DELEGAR nunca vai para o cliente; a conversa passa para você e a IA para", async () => {
  const r = arrumarResposta({ mensagens: ["Perfeito, Carlos! Vou passar para o responsável.\nDELEGAR"], delegar: false, motivo_delegar: "" });
  assert.equal(r.delegar, true);
  assert.deepEqual(r.partes, ["Perfeito, Carlos! Vou passar para o responsável."]);
  assert.deepEqual(arrumarResposta({ mensagens: ["DELEGAR"], delegar: false }).partes, []);

  await db.atualizarAgente(bruno.id, { delegar_modo: "fixa", delegar_mensagem: "Combinado! O responsável segue com você por aqui." });
  bruno = await db.buscarAgente(bruno.id);
  const ia = iaFalsa({ classificacao: "interessado", mensagens: ["Vou passar para o responsável. DELEGAR"], motivo_delegar: "quer contratar" });
  await processarWebhookUazap(aviso("R3", "5511977776666", "Quero contratar"), campanha, "rastreio", { responderAgente: ia.responder });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE agente_id = $1", [bruno.id]);
  assert.deepEqual((await respostasDaFila(lead.id)).map((m) => m.corpo), ["Combinado! O responsável segue com você por aqui."]);
  assert.match(await iaPausada(lead.id), /^delegou para você: quer contratar/);
  assert.ok(lead.agente_delegou_em);
  assert.equal((await db.numerosDoAgente(bruno.id)).delegacoes, 1);

  // Parada: a próxima mensagem fica registrada sem gastar IA, e a conversa continua com você.
  await processarWebhookUazap(aviso("R4", "5511977776666", "Alô?"), campanha, "rastreio", { responderAgente: naoUsar });
  const conversa = (await db.conversas()).find((c) => c.id === lead.id);
  assert.equal(conversa.agente_nome, "Bruno");
  // Mesmo depois da mensagem de transição sair, a conversa aparece como "precisa de você".
  const andamento = avaliarConversa({ ...conversa, ultima: { autor: "nos", quando: new Date().toISOString() } });
  assert.equal(andamento.precisaDeVoce, true);
  assert.match(andamento.proximoPasso, /quer contratar/);
  assert.equal(agentes.andamentoDoAgente(conversa).estado, "delegou");

  // "IA continua": o agente volta, com o prompt dele.
  const [ultima] = await db.consultar("SELECT id FROM respostas WHERE lead_id = $1 ORDER BY id DESC LIMIT 1", [lead.id]);
  const volta = iaFalsa({ mensagens: ["Oi, Carlos! Seguimos por aqui."] });
  await continuarComIA(ultima.id, campanha, { responderAgente: volta.responder, classificar: naoUsar });
  assert.equal(volta.pedidos.length, 1);
  assert.equal(await iaPausada(lead.id), "");
});

test("agentes: desligado, a mensagem fica registrada para você e a IA não é chamada", async () => {
  await db.atualizarAgente(bruno.id, { ligado: false });
  await processarWebhookUazap(aviso("R5", "5511955554444", "Bom dia", "Ana"), campanha, "rastreio", { responderAgente: naoUsar, avaliar: naoUsar });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE agente_id = $1 AND whatsapp = $2", [bruno.id, "5511955554444"]);
  const [r] = await db.consultar("SELECT * FROM respostas WHERE lead_id = $1", [lead.id]);
  assert.match(r.precisa_humano, /desligado/);
  assert.equal((await respostasDaFila(lead.id)).length, 0);
  await db.atualizarAgente(bruno.id, { ligado: true });
});

test("agentes: a conversa da prospecção que já acontecia no número continua com a IA da FluxDeck", async () => {
  await db.inserirLead({ place_id: "p1", nome: "Pet Feliz", nicho: "pet", cidade: "SP" });
  const [pet] = await db.consultar("SELECT * FROM leads WHERE place_id = 'p1'");
  await db.atualizarLead(pet.id, { whatsapp: "5511933332222", status: "contatado", numero_wa: "rastreio" });
  const m = await db.criarMensagem({ lead_id: pet.id, canal: "whatsapp", destino: "5511933332222", corpo: "Proposta" });
  await db.atualizarMensagem(m, { status: "enviada", enviada_em: new Date().toISOString() });
  // (Sem chave da IA no teste, a IA da FluxDeck falha e a conversa fica para você; o agente não é chamado.)
  await processarWebhookUazap(aviso("R6", "5511933332222", "Quanto custa?"), campanha, "rastreio", { responderAgente: naoUsar });
  const doAgente = await db.consultar("SELECT count(*)::int AS n FROM leads WHERE agente_id IS NOT NULL AND whatsapp = '5511933332222'");
  assert.equal(doAgente[0].n, 0);
  assert.equal((await db.consultar("SELECT count(*)::int AS n FROM respostas WHERE lead_id = $1", [pet.id]))[0].n, 1);
});

test("agentes: número com agente não manda prospecção para empresas novas", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ instance: { status: "connected" }, status: { connected: true, loggedIn: true } });
  try {
    const nova = { lead_id: 999999, numero_wa_lead: null, tipo: "inicial", etapa: 1 };
    assert.equal((await pipeline.numeroParaEnviar(nova)).numero.id, "principal");
    await db.atualizarAgente(bruno.id, { numeros: ["rastreio", "principal"] });
    assert.match((await pipeline.numeroParaEnviar(nova)).motivo, /agente de atendimento/);
    await db.atualizarAgente(bruno.id, { numeros: ["rastreio"] });
  } finally {
    globalThis.fetch = original;
  }
});

test("agentes: base de conhecimento grande vai em trechos, pelo assunto da conversa e dentro do limite", () => {
  assert.equal(baseParaOPedido([{ nome: "Base", texto: "Plano A: R$ 50" }], "preço"), "### Base\nPlano A: R$ 50");
  assert.equal(baseParaOPedido([], "x"), "");
  const enchimento = Array.from({ length: 60 }, (_, i) => `Assunto ${i}: informação institucional da empresa sobre a história número ${i}.`.repeat(8));
  const fontes = [{ nome: "Manual", texto: [...enchimento.slice(0, 30), "Cobertura: atendemos Fortaleza e Caucaia com instalação em domicílio.", ...enchimento.slice(30)].join("\n\n") }];
  const base = baseParaOPedido(fontes, "Vocês têm cobertura em Caucaia?", 3000);
  assert.ok(base.length <= 3000);
  assert.match(base, /Caucaia com instalação/);
});
