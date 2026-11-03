import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const uazap = await import("../src/envio/uazap.js");
const pipeline = await import("../src/pipeline.js");

const URL_UAZAP = "https://fluxdeck.uazapi.com";
// Sempre dentro do horário, sem aquecimento e com 1 empresa nova por número por dia.
const campanha = {
  empresa: { nome: "FluxDeck" },
  limites: { horarioComercial: { inicio: 0, fim: 24 }, somenteDiasUteis: false, envioDiarioMax: 50 },
  automacao: { metaDiaria: { email: 10, whatsapp: 1 }, aquecimentoWhatsapp: false },
};

/** UAZap de mentira: cada instância é reconhecida pelo token; dá para desconectar uma delas. */
function uazapFalsa({ midiaFalha = null, lidRecusado = false } = {}) {
  const desconectados = new Set();
  const envios = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    const token = opcoes.headers?.token;
    if (!["A", "B"].includes(token)) return Response.json({ error: "Invalid token" }, { status: 401 });
    const rota = `${opcoes.method ?? "GET"} ${u.pathname}`;
    if (rota === "GET /instance/status") {
      const ok = !desconectados.has(token);
      return Response.json({ instance: { status: ok ? "connected" : "disconnected" }, status: { connected: ok, loggedIn: ok, jid: `55119000000${token === "A" ? 1 : 2}@s.whatsapp.net` } });
    }
    if (rota === "POST /webhook") return Response.json({ ok: true });
    if (rota === "POST /send/text" || rota === "POST /send/media") {
      if (rota === "POST /send/media" && midiaFalha) return Response.json({ error: midiaFalha }, { status: 400 });
      const para = JSON.parse(opcoes.body).number;
      if (lidRecusado && para.endsWith("@lid")) return Response.json({ error: `the number ${para.split("@")[0]}@s.whatsapp.net is not on WhatsApp` }, { status: 500 });
      envios.push({ token, rota, ...JSON.parse(opcoes.body) });
      return Response.json({ messageid: `msg-${token}-${envios.length}` });
    }
    return Response.json({ error: `sem rota ${rota}` }, { status: 404 });
  };
  return { envios, desconectados, restaurar: () => (globalThis.fetch = original) };
}

async function leadComMensagem(nome, numero, { tipo = "inicial", etapa = 1 } = {}) {
  await db.inserirLead({ place_id: nome, nome, nicho: "clínica", cidade: "Osasco", endereco: null,
                         telefone: null, site: null, maps_url: null, avaliacao: null, total_avaliacoes: null });
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.nome === nome);
  await db.atualizarLead(lead.id, { whatsapp: numero, status: "analisado", oportunidades: "[]" });
  return mensagem(lead.id, numero, { tipo, etapa });
}

async function mensagem(leadId, numero, { tipo = "resposta", etapa = 0 } = {}) {
  const id = await db.criarMensagem({ lead_id: leadId, canal: "whatsapp", destino: numero, corpo: `Oi (${tipo})`, status: "aprovada", tipo, etapa });
  return db.buscarMensagem(id);
}

test("vários números: as empresas novas se dividem e cada conversa fica no seu número", async () => {
  const falsa = uazapFalsa();
  try {
    const um = await uazap.salvarNumero({ nome: "IA 1", url: URL_UAZAP, token: "A" });
    const dois = await uazap.salvarNumero({ nome: "IA 2", token: "B" }); // a Server URL vem do primeiro
    assert.equal(um.id, uazap.PRINCIPAL);
    assert.notEqual(dois.id, um.id);
    assert.equal(dois.url, URL_UAZAP);
    await assert.rejects(uazap.salvarNumero({ nome: "Repetido", url: URL_UAZAP, token: "A" }), /já está na lista/);
    await assert.rejects(uazap.salvarNumero({ nome: "Errado", url: URL_UAZAP, token: "X" }), /recusou o token/);

    assert.equal(await pipeline.modoWhatsapp(), "uazap");
    // A meta (1 por dia) vale por número: com dois conectados, 2 empresas novas hoje.
    assert.equal(await pipeline.limiteDoDia(campanha, "whatsapp"), 2);

    const r1 = await pipeline.enviarMensagem(await leadComMensagem("Clínica 1", "5511988880001"), campanha);
    const r2 = await pipeline.enviarMensagem(await leadComMensagem("Clínica 2", "5511988880002"), campanha);
    assert.deepEqual([r1.enviada, r2.enviada], [true, true]);
    assert.deepEqual(falsa.envios.map((e) => e.token), ["A", "B"]);
    const [l1, l2] = await Promise.all(["Clínica 1", "Clínica 2"].map(async (n) => (await db.leadsPorStatus("contatado")).find((l) => l.nome === n)));
    assert.deepEqual([l1.numero_wa, l2.numero_wa], [um.id, dois.id]);
    assert.equal(await db.enviadasHoje("whatsapp", { primeiroContato: true, numero: dois.id }), 1);
    assert.deepEqual([await db.conversasDoNumero(um.id), await db.conversasDoNumero(dois.id)], [1, 1]);

    // Os dois números já usaram a meta de hoje: a terceira empresa espera na fila.
    const r3 = await pipeline.enviarMensagem(await leadComMensagem("Clínica 3", "5511988880003"), campanha);
    assert.equal(r3.naFila, true);
    assert.equal(falsa.envios.length, 2);

    // A resposta da conversa sai pelo número que já fala com a empresa (não conta na meta).
    assert.equal((await pipeline.enviarMensagem(await mensagem(l2.id, "5511988880002"), campanha)).enviada, true);
    assert.equal(falsa.envios.at(-1).token, "B");

    // Número da conversa caiu: ela espera por ele em vez de trocar de número.
    falsa.desconectados.add("B");
    uazap.esquecerConexao(dois.id);
    const parada = await pipeline.enviarMensagem(await mensagem(l2.id, "5511988880002"), campanha);
    assert.equal(parada.naFila, true);
    assert.match(parada.motivo, /"IA 2" está desconectado/);
    assert.equal(await pipeline.limiteDoDia(campanha, "whatsapp"), 1);

    // Cada número tem o próprio webhook.
    assert.equal((await uazap.webhookValido(um.segredoWebhook, { token: "A" }))?.id, um.id);
    assert.equal((await uazap.webhookValido(dois.segredoWebhook, { token: "B" }))?.id, dois.id);
    assert.equal(await uazap.webhookValido(dois.segredoWebhook, { token: "A" }), null);

    // Tirar o número da lista: a conversa dele passa a sair por outro conectado.
    await uazap.removerNumero(dois.id);
    assert.deepEqual((await uazap.numeros()).map((n) => n.nome), ["IA 1"]);
    const mudou = await pipeline.numeroParaEnviar(await mensagem(l2.id, "5511988880002"), campanha);
    assert.equal(mudou.numero.id, um.id);
  } finally {
    falsa.restaurar();
  }
});

test("uazap: lê a conversa no formato da avaliação de contato novo, do mais novo para o mais antigo", async () => {
  await db.gravarConfig("uazap", { numeros: [{ id: "n1", nome: "Um", url: "https://x.uazapi.com", token: "tk", segredoWebhook: "s1" }] });
  const agora = Date.now();
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, o = {}) => {
    chamadas.push({ url: String(url), corpo: o.body ? JSON.parse(o.body) : null });
    if (String(url).endsWith("/instance/status")) return new Response(JSON.stringify({ instance: { status: "connected" } }), { status: 200 });
    return new Response(JSON.stringify({ messages: [
      { messageid: "A", fromMe: false, text: "Oi", messageTimestamp: agora - 60_000 },
      { messageid: "B", fromMe: true, text: "Olá", messageTimestamp: agora - 30_000 },
      { messageid: "C", fromMe: false, text: "muito antiga", messageTimestamp: agora - 40 * 86_400_000 },
    ] }), { status: 200 });
  };
  try {
    await uazap.salvarNumero({ id: "n1", nome: "Um", url: "https://x.uazapi.com", token: "tk2" });
    const lista = await uazap.buscarMensagens("n1", { horas: 24, remoteJid: "5511999998888", limite: 60 });
    assert.deepEqual(lista.map((m) => [m.key.id, m.key.fromMe, m.message.conversation]), [["B", true, "Olá"], ["A", false, "Oi"]]);
    const pedido = chamadas.find((c) => c.url.endsWith("/message/find"));
    assert.deepEqual(pedido.corpo, { chatid: "5511999998888@s.whatsapp.net", limit: 60 });
  } finally {
    globalThis.fetch = original;
  }
});

test("uazap: contato novo é avaliado; cliente vira lead, e conversa pessoal ou com você fica de fora", async () => {
  const { processarWebhookUazap } = await import("../src/respostas/whatsapp.js");
  const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], limites: {}, automacao: {} };
  const aviso = (id, de, texto) => ({ EventType: "messages", message: { messageid: id, chatid: `${de}@s.whatsapp.net`, sender: "1@lid", text: texto, senderName: "Fulano" } });
  const antes = (await db.consultar("SELECT count(*)::int AS n FROM leads"))[0].n;
  const base = { esperar: 0, buscar: async () => [] };

  assert.equal(await processarWebhookUazap(aviso("U1", "5511900000001", "e aí, bora?"), campanha, "n1", { ...base, avaliar: async () => ({ tipo: "pessoal" }) }), 0);
  const comVoce = [{ key: { id: "X", fromMe: true }, message: { conversation: "oi" }, messageTimestamp: 1 }];
  assert.equal(await processarWebhookUazap(aviso("U2", "5511900000002", "e aí"), campanha, "n1", { esperar: 0, buscar: async () => comVoce, avaliar: async () => { throw new Error("não deveria gastar IA"); } }), 0);
  assert.equal((await db.consultar("SELECT count(*)::int AS n FROM leads"))[0].n, antes);

  await processarWebhookUazap(aviso("U3", "5511900000003", "Quanto custa um site?"), campanha, "n1", { ...base, avaliar: async () => ({ tipo: "cliente", nome_pessoa: "Fulano", resumo: "Quer um site" }) }).catch(() => {});
  const novos = await db.consultar("SELECT nome, whatsapp FROM leads WHERE whatsapp = $1", ["5511900000003"]);
  assert.equal(novos.length, 1);
  assert.equal(novos[0].nome, "Fulano");
});

test("campanha: a arte e o áudio vão juntos, com o link na legenda, e sem eles o texto sai do mesmo jeito", async () => {
  const link = "https://prospecta.exemplo/guia/abc";
  const corpo = `Oi! Preparei um guia para atrair clientes: ${link}\n\nE um aviso: na Black Friday o plano sai por menos.`;
  const { imagemDaMensagem, roteiroDoAudio, legendaDaArte } = await import("../src/vendas/campanha.js");
  const dia = new Date("2026-11-15T12:00:00Z");
  assert.match(imagemDaMensagem({ canal: "whatsapp", etapa: 0, corpo }, dia), /\/whatsapp-black-friday\.jpg$/);
  assert.equal(imagemDaMensagem({ canal: "whatsapp", etapa: 0, corpo }, new Date("2026-12-01T12:00:00Z")), null); // acabou a promoção
  assert.equal(imagemDaMensagem({ canal: "email", etapa: 0, corpo }, dia), null);
  assert.equal(imagemDaMensagem({ canal: "whatsapp", etapa: 1, corpo }, dia), null); // sequência normal
  assert.equal(imagemDaMensagem({ canal: "whatsapp", etapa: 0, corpo: "Claro, te explico." }, dia), null); // resposta comum
  assert.doesNotMatch(roteiroDoAudio(corpo), /https?:|\.\./);
  assert.match(roteiroDoAudio(corpo), /pra atrair clientes\. Deixei o link aqui na conversa, tá\?/);
  const escrita = (await import("../src/vendas/campanha.js")).mensagemDaCampanha({ lead: { nome: "Odontomania", token: "t" }, comGuia: true, responsavel: "Felipe", empresa: "FluxDeck" });
  assert.match(escrita, /R\$ 1\.500 por mês, o equivalente a um funcionário/);
  const falada = roteiroDoAudio(escrita);
  assert.doesNotMatch(falada, /R\$|https?:|\bpara\b/);
  assert.match(falada, /guia gratuito pra Odontomania/);
  assert.match(falada, /quatro mil e quinhentos reais, tá saindo por três mil por mês/);
  assert.match(falada, /equivalente a um funcionário/);
  assert.match(falada, /sistema próprio e também um aplicativo/);
  assert.equal(legendaDaArte(corpo), `Seu guia gratuito: ${link}`);
  assert.equal(legendaDaArte("Sem link."), "");

  // A voz vem do Gemini de mentira; o resto do caminho, inclusive a conversão do áudio, é o de verdade.
  process.env.GEMINI_API_KEY = "teste";
  const comVoz = (falsa) => {
    const anterior = globalThis.fetch;
    falsa.vozes = 0;
    globalThis.fetch = async (url, op) => {
      if (!String(url).includes("generativelanguage")) return anterior(url, op);
      falsa.vozes++;
      return Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", data: Buffer.alloc(9600).toString("base64") }] }] });
    };
    return falsa;
  };
  const criar = async (lead) => db.buscarMensagem(await db.criarMensagem({ lead_id: lead, canal: "whatsapp", destino: "5511988881001", corpo, status: "aprovada", tipo: "resposta", etapa: 0 }));
  let leadId;
  const falsa = comVoz(uazapFalsa());
  try {
    await uazap.salvarNumero({ nome: "IA 1", url: URL_UAZAP, token: "A" }).catch(() => {}); // já pode estar na lista
    uazap.esquecerConexao();
    leadId = (await leadComMensagem("Clínica Arte", "5511988881001", { tipo: "resposta", etapa: 0 })).lead_id;
    falsa.envios.length = 0;
    const r = await pipeline.enviarMensagem(await criar(leadId), campanha);
    assert.equal(r.enviada, true, r.motivo);
    assert.deepEqual(falsa.envios.map((e) => e.type), ["image", "ptt"]);
    assert.equal(falsa.envios[0].text, `Seu guia gratuito: ${link}`);
    assert.match(falsa.envios[1].file, /\/api\/midia\/audio-mensagem-\d+-[0-9a-f]{12}\.ogg\?a=/);
    const chave = falsa.envios[1].file.match(/audio-mensagem-\d+-[0-9a-f]{12}\.ogg/)[0];
    const audio = await db.lerMidia(chave);
    assert.equal(audio.tipo, "audio/ogg");
    assert.equal(Buffer.from(audio.dados).toString("ascii", 0, 4), "OggS");

    // O que se ouve no painel é o que sai: mesmo texto e mesma voz, mesmo áudio, sem gerar de novo.
    const id = Number(chave.match(/mensagem-(\d+)-/)[1]);
    const pedidosDeVoz = () => falsa.vozes;
    const antes = pedidosDeVoz();
    assert.equal((await pipeline.audioDaMensagem(id, corpo)).chave, chave);
    assert.equal(pedidosDeVoz(), antes);
    // Texto editado gera outro áudio, e o antigo sai do banco.
    const outro = await pipeline.audioDaMensagem(id, `${corpo} Valeu!`);
    assert.notEqual(outro.chave, chave);
    assert.equal(pedidosDeVoz(), antes + 1);
    assert.equal(await db.lerMidia(chave), null);
  } finally {
    falsa.restaurar();
  }

  const semMidia = comVoz(uazapFalsa({ midiaFalha: "formato não aceito" }));
  try {
    assert.equal((await pipeline.enviarMensagem(await criar(leadId), campanha)).enviada, true);
    assert.deepEqual(semMidia.envios.map((e) => [e.rota, e.text]), [["POST /send/text", corpo]]);
  } finally {
    semMidia.restaurar();
    delete process.env.GEMINI_API_KEY;
  }
});

test("contato @lid: vai para a UAZap como veio e, se ela recusar, sai pelo telefone da empresa", async () => {
  if (!(await uazap.numeros()).length) await uazap.salvarNumero({ nome: "IA 1", url: URL_UAZAP, token: "A" });
  await db.inserirLead({ place_id: "lid-1", nome: "Loja Lid", nicho: "loja", cidade: "Osasco", endereco: null,
                         telefone: "(11) 90000-1234", site: null, maps_url: null, avaliacao: null, total_avaliacoes: null });
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.nome === "Loja Lid");
  await db.atualizarLead(lead.id, { whatsapp: "123456789012345@lid", status: "analisado", oportunidades: "[]" });

  const aceita = uazapFalsa();
  try {
    assert.equal((await pipeline.enviarMensagem(await mensagem(lead.id, "123456789012345@lid"), campanha)).enviada, true);
    assert.equal(aceita.envios.at(-1).number, "123456789012345@lid");
  } finally {
    aceita.restaurar();
  }

  const recusa = uazapFalsa({ lidRecusado: true });
  try {
    assert.equal((await pipeline.enviarMensagem(await mensagem(lead.id, "123456789012345@lid"), campanha)).enviada, true);
    assert.deepEqual(recusa.envios.map((e) => e.number), ["5511900001234"]);
  } finally {
    recusa.restaurar();
  }
});

test("dashboard: quando sai a próxima mensagem do WhatsApp, respeitando o horário comercial", async () => {
  const falsa = uazapFalsa();
  try {
    if (!(await uazap.numeros()).length) await uazap.salvarNumero({ nome: "IA 1", url: URL_UAZAP, token: "A" });
    await leadComMensagem("Clínica Contagem", "5511988880099", { tipo: "resposta", etapa: 0 });
    const comercial = { ...campanha, limites: { ...campanha.limites, horarioComercial: { inicio: 9, fim: 18 }, somenteDiasUteis: true } };
    // Quarta, 10:00 em São Paulo: a resposta da conversa sai no próximo minuto.
    const quarta = new Date("2030-01-09T13:00:00Z");
    const r = await pipeline.proximoEnvioWhatsapp(comercial, quarta);
    assert.equal(r.quando, "2030-01-09T13:01:00.000Z");
    assert.equal(r.oQue, "Resposta da conversa");
    // Sábado: fica para segunda, no começo do expediente.
    const sabado = await pipeline.proximoEnvioWhatsapp(comercial, new Date("2030-01-12T13:00:00Z"));
    assert.equal(sabado.quando, "2030-01-14T12:00:00.000Z");
    // Sem número conectado, não promete horário.
    falsa.desconectados.add("A");
    falsa.desconectados.add("B");
    for (const n of await uazap.numeros()) uazap.esquecerConexao(n.id);
    assert.match((await pipeline.proximoEnvioWhatsapp(comercial, quarta)).motivo, /desconectado/);
  } finally {
    falsa.restaurar();
  }
});
