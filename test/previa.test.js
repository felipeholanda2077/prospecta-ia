import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA ??= "senha-de-teste";
for (const k of ["NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
// A IA "de verdade" responde por um fetch falso (abaixo): dá para ver o que o sistema pediu a ela.
process.env.ANTHROPIC_API_KEY = "chave-de-teste";

const db = await import("../src/db.js");
const previa = await import("../src/vendas/previa.js");
const { registrarResposta } = await import("../src/respostas/processar.js");
const { followupsDeInteressados } = await import("../src/respostas/followup.js");
const { classificarResposta, escreverFollowup } = await import("../src/ia/resposta.js");
const { app } = await import("../src/app.js");
const { podeTerPrevia, momentoDaPrevia, previaSoNaHora, semLinkDaPrevia, paginaDaPrevia, enderecoDaPrevia } = previa;

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe", telefone: "(85) 98888-7777", diferenciais: [] }, servicos: [], automacao: { respostaAutomatica: true, maxRespostasIA: 6 } };
const horasAtras = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const ela = (texto) => ({ autor: "lead", canal: "whatsapp", texto, quando: horasAtras(2) });
const nos = (texto) => ({ autor: "nos", canal: "whatsapp", texto, quando: horasAtras(3) });

let n = 0;
/** Empresa do Google Maps, sem site próprio (ou com o `site` dado). */
async function empresa({ nome, site = null, nicho = "clínica odontológica", origem, avaliacao = 4.8, total = 230 } = {}) {
  n += 1;
  nome ??= `Clínica Sorriso ${n}`;
  await db.inserirLead({ place_id: `previa-${n}`, nome, nicho, cidade: "Fortaleza - CE", endereco: `Rua das Flores, ${n}0 - Aldeota, Fortaleza - CE`,
    telefone: "(85) 3333-4444", site, maps_url: `https://maps.google.com/?cid=${n}`, avaliacao, total_avaliacoes: total, origem });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [`previa-${n}`]);
  await db.atualizarLead(l.id, { whatsapp: `558599990000${n % 10}`, status: "contatado", email: `contato${n}@exemplo.com`, observacao: `nota interna ${n}` });
  return db.buscarLead(l.id);
}

test("prévia: só para empresa sem site próprio, prospectada por nós, nem cliente nem descadastrada", () => {
  const base = { nome: "Clínica X", token: "abc", origem: "campanha", status: "contatado", site: null };
  assert.equal(podeTerPrevia(base), true);
  assert.equal(podeTerPrevia({ ...base, site: "https://instagram.com/clinicax" }), true); // só rede social
  assert.equal(podeTerPrevia({ ...base, origem: "cnpj" }), true);
  assert.equal(podeTerPrevia({ ...base, site: "https://clinicax.com.br" }), false);
  assert.equal(podeTerPrevia({ ...base, origem: "formulario" }), false); // pode ter site, nós só não sabemos
  assert.equal(podeTerPrevia({ ...base, origem: "whatsapp" }), false);
  assert.equal(podeTerPrevia({ ...base, origem: "instagram_direct" }), false);
  assert.equal(podeTerPrevia({ ...base, status: "descadastrado" }), false);
  assert.equal(podeTerPrevia({ ...base, status: "fechado" }), false);
  assert.equal(podeTerPrevia({ ...base, agente_id: 3 }), false);
  assert.equal(podeTerPrevia(null), false);
  assert.match(enderecoDaPrevia(base), /\/previa\/abc$/);
  assert.equal(enderecoDaPrevia({ ...base, site: "https://clinicax.com.br" }), "");
});

test("prévia: a hora de oferecer é quando a conversa toca em presença online, uma vez só", () => {
  const lead = { nome: "Clínica X", token: "tok123", origem: "campanha", status: "respondeu", site: null };
  const link = enderecoDaPrevia(lead);
  // O caso real: pediu "uma apresentação ou um site para dar uma olhada".
  assert.equal(momentoDaPrevia({ lead, texto: "Vocês têm uma apresentação ou um site para dar uma olhada?" }), link);
  assert.equal(momentoDaPrevia({ lead, texto: "A gente não aparece no Google, só tem Instagram" }), link);
  assert.equal(momentoDaPrevia({ lead, texto: "Queria mais clientes novos" }), link);
  // O assunto pode ter vindo antes, no histórico dela.
  assert.equal(momentoDaPrevia({ lead, historico: [nos("Como vocês atraem clientes?"), ela("Hoje só pelo Instagram")], texto: "Isso" }), link);
  // Dor que não é presença online: nada de prévia.
  assert.equal(momentoDaPrevia({ lead, texto: "Nosso problema é demorar para responder no WhatsApp" }), "");
  assert.equal(momentoDaPrevia({ lead, texto: "Quero organizar a agenda dos pacientes" }), "");
  // Já tem site, ou não quer.
  assert.equal(momentoDaPrevia({ lead, texto: "Já temos site, obrigado" }), "");
  assert.equal(momentoDaPrevia({ lead, texto: "Não precisamos de site" }), "");
  // Só uma vez: se o link já foi, não vai de novo.
  assert.equal(momentoDaPrevia({ lead, historico: [nos(`Fiz um rascunho: ${link}`)], texto: "E o Google?" }), "");
  // Empresa com site próprio: nunca.
  assert.equal(momentoDaPrevia({ lead: { ...lead, site: "https://x.com.br" }, texto: "Queria aparecer no Google" }), "");
});

test("prévia: o link só fica na resposta se era a hora e a conversa segue", () => {
  const link = "https://app.exemplo/previa/tok";
  const sugestao = `Entendi! Fiz um rascunho de como ficaria o site de vocês, dá uma olhada: ${link} O que achou?`;
  const c = { classificacao: "interessado", sugestao_resposta: sugestao, precisa_humano: false };
  assert.equal(previaSoNaHora(c, link).sugestao_resposta, sugestao);
  assert.equal(previaSoNaHora({ ...c, classificacao: "sem_interesse" }, link).sugestao_resposta, "Entendi! O que achou?");
  assert.equal(previaSoNaHora({ ...c, precisa_humano: true }, link).sugestao_resposta, "Entendi! O que achou?");
  assert.equal(previaSoNaHora({ ...c, robo: true }, link).sugestao_resposta, "Entendi! O que achou?");
  assert.equal(previaSoNaHora(c, "").sugestao_resposta, "Entendi! O que achou?"); // não era a hora
  assert.equal(previaSoNaHora(c, "https://app.exemplo/previa/outro").sugestao_resposta, "Entendi! O que achou?"); // link de outra empresa
  assert.equal(semLinkDaPrevia(`Oi!\n${link}\nAbraço`), "Oi!\nAbraço");
});

/** Sobe o app numa porta livre e devolve a base. */
async function comServidor(fazer) {
  const servidor = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  try {
    return await fazer(`http://127.0.0.1:${servidor.address().port}`);
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
}

test("rota /previa/<token>: página da empresa, pronta para celular, sem dados de outros leads", async () => {
  const a = await empresa({ nome: "Clínica Sorriso <Aldeota>" });
  const b = await empresa({ nome: "Odonto Vizinha Concorrente" });
  const comSite = await empresa({ nome: "Clínica Com Site", site: "https://comsite.com.br" });
  const doFormulario = await empresa({ nome: "Veio Pelo Formulário", origem: "formulario" });
  await db.gravarConfig("empresa", { telefone: "(85) 98888-7777" }); // o WhatsApp da FluxDeck, salvo no painel

  await comServidor(async (base) => {
    const r = await fetch(`${base}/previa/${a.token}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(r.headers.get("cache-control"), /no-store/);
    assert.match(r.headers.get("x-robots-tag"), /noindex/);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer"); // o token não vaza para o WhatsApp ou o Maps
    const html = await r.text();
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(html, /@media \(max-width:520px\)/);
    assert.match(html, /Clínica Sorriso &lt;Aldeota&gt;/); // nome escapado
    assert.doesNotMatch(html, /<Aldeota>/);
    assert.match(html, /Seu sorriso em boas mãos em Fortaleza/); // ramo + cidade
    assert.match(html, /Implantes/); // serviço típico do ramo
    assert.match(html, /4,8/);
    assert.match(html, /230 avaliações no Google/);
    assert.match(html, /https:\/\/wa\.me\/558599990000\d\?text=/); // botão de WhatsApp da própria empresa
    assert.match(html, /wa\.me\/5585988887777/); // "gostou?" leva para o WhatsApp da FluxDeck
    assert.match(html, /Rua das Flores/);
    // Visual: conversa animada no celular, faixa de serviços, galeria (sem fotos inventadas), passo a passo e FAQ.
    assert.match(html, /class="celular"/);
    assert.match(html, /Queria saber sobre limpeza e prevenção/);
    assert.match(html, /class="corre"/);
    assert.match(html, /sua foto aqui/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /Como funciona/);
    assert.match(html, /<details/);
    assert.match(html, /data-conta="230"/);
    // Quem pede menos movimento vê tudo parado; sem JavaScript, nada fica escondido (o "aparecer ao rolar" só vale com .js).
    assert.match(html, /@media \(prefers-reduced-motion:reduce\)/);
    assert.match(html, /\.js \.rv\{opacity:0/);
    assert.equal(html.split(".rv{opacity:0").length, html.split(".js .rv{opacity:0").length);
    // Nada de outros leads, nem dados internos desta empresa.
    assert.doesNotMatch(html, /Vizinha Concorrente/);
    assert.doesNotMatch(html, new RegExp(b.token));
    assert.doesNotMatch(html, /contato\d+@exemplo\.com/);
    assert.doesNotMatch(html, /nota interna/);

    // Empresa com site próprio, que chegou pelo formulário, ou token que não existe: link inválido.
    assert.equal((await fetch(`${base}/previa/${comSite.token}`)).status, 404);
    assert.equal((await fetch(`${base}/previa/${doFormulario.token}`)).status, 404);
    const invalido = await fetch(`${base}/previa/nao-existe`);
    assert.equal(invalido.status, 404);
    assert.match(await invalido.text(), /Link inválido/);
  });
});

test("página da prévia: sem nota no Google não inventa avaliação, e lead do CNPJ não mostra endereço", () => {
  const html = paginaDaPrevia({ nome: "Bar do Zé", nicho: "bar", cidade: "Recife - PE", endereco: "Rua da Casa do Zé, 1", origem: "cnpj",
    telefone: "81 3333-2222", avaliacao: null, total_avaliacoes: null, token: "x" }, { marca: "FluxDeck" });
  assert.doesNotMatch(html, /avaliações no Google/);
  assert.doesNotMatch(html, /O que os clientes dizem/);
  assert.doesNotMatch(html, /Rua da Casa do Zé/); // dado da Receita, pode ser a casa da pessoa
  assert.match(html, /Sabor que faz voltar em Recife/);
  assert.match(html, /tel:\+558133332222/);
  assert.match(html, /responder a nossa conversa/); // sem WhatsApp da FluxDeck cadastrado
});

// ---------- A IA (classificação e follow-up) com uma API falsa ----------

const pedidosAIA = [];
let respostaDaIA = {};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, opcoes) => {
  if (!String(url).includes("api.anthropic.com")) return fetchOriginal(url, opcoes);
  pedidosAIA.push(JSON.parse(opcoes.body));
  const corpo = { id: "msg_teste", type: "message", role: "assistant", model: "teste", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(respostaDaIA) }], usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(corpo), { status: 200, headers: { "content-type": "application/json" } });
};

const CLASSIFICACAO = { classificacao: "quer_informacoes", resumo: "x", sugestao_resposta: "Claro!", precisa_humano: false, motivo_humano: "",
  indicou_contato: false, temperatura: "morna", proximo_passo: "", robo: false, encerrar: false, dor_entendida: false, pediu_conversa: false };

test("IA da conversa: o pedido leva o link da prévia só quando é a hora", async () => {
  const lead = { nome: "Clínica X", nicho: "odonto", cidade: "Fortaleza", token: "tokIA", origem: "campanha", status: "respondeu", site: null };
  const link = enderecoDaPrevia(lead);
  respostaDaIA = CLASSIFICACAO;
  await classificarResposta({ texto: "Tem um site para dar uma olhada?", lead, historico: [], campanha, canal: "whatsapp", linkPrevia: link });
  const comLink = pedidosAIA.at(-1).system;
  assert.match(comLink, /PRÉVIA DO SITE/);
  assert.ok(comLink.includes(link));
  assert.match(comLink, /sem preço e sem convite/);
  await classificarResposta({ texto: "Demoramos a responder no WhatsApp", lead, historico: [], campanha, canal: "whatsapp", linkPrevia: "" });
  assert.doesNotMatch(pedidosAIA.at(-1).system, /PRÉVIA DO SITE|\/previa\//);

  respostaDaIA = { opcao: "previa", mensagem: `Fiz um rascunho do site de vocês: ${link} O que achou?` };
  const f = await escreverFollowup({ lead, historico: [nos("Oi"), ela("Queria aparecer no Google")], campanha, linkMaterial: "https://g/guia/x", linkPrevia: link });
  assert.equal(f.opcao, "previa");
  assert.ok(pedidosAIA.at(-1).system.includes(link));
  respostaDaIA = { opcao: "responsavel", mensagem: "Conseguiu falar com o Dr. João?" };
  const g = await escreverFollowup({ lead, historico: [nos("Oi"), ela("Vou passar pro dono")], campanha, linkMaterial: "https://g/guia/x" });
  assert.equal(g.opcao, "responsavel"); // antes essa opção quebrava a validação
  assert.match(pedidosAIA.at(-1).system, /NÃO use a opção previa/);
});

test("conversa: quem pergunta de site recebe o link da prévia; outra dor não recebe; recusa tira o link", async () => {
  const lead = await empresa();
  const link = enderecoDaPrevia(lead);
  const vistos = [];
  const classificar = async (ctx) => {
    vistos.push(ctx.linkPrevia);
    return { ...CLASSIFICACAO, sugestao_resposta: ctx.linkPrevia ? `Fiz um rascunho de como ficaria o site de vocês: ${ctx.linkPrevia} O que acharam?` : "Entendi. E hoje quem responde?" };
  };
  const r1 = await registrarResposta({ lead, canal: "whatsapp", origem_id: "PV1", de: lead.whatsapp,
    texto: "Vocês têm uma apresentação ou um site para dar uma olhada?", campanha, classificar });
  assert.equal(vistos.at(-1), link);
  assert.ok((await db.buscarResposta(r1.id)).sugestao.includes(link));

  const outra = await empresa();
  await registrarResposta({ lead: outra, canal: "whatsapp", origem_id: "PV2", de: outra.whatsapp,
    texto: "Nosso problema é a demora para responder os pacientes", campanha, classificar });
  assert.equal(vistos.at(-1), "");

  const recusou = await empresa();
  const r3 = await registrarResposta({ lead: recusou, canal: "whatsapp", origem_id: "PV3", de: recusou.whatsapp, texto: "Sobre o site, agora não", campanha,
    classificar: async (ctx) => ({ ...CLASSIFICACAO, classificacao: "sem_interesse", sugestao_resposta: `Imagina, obrigado! Se quiser ver: ${ctx.linkPrevia}` }) });
  assert.equal((await db.buscarResposta(r3.id)).sugestao, "Imagina, obrigado!");
});

/** Conversa parada há `h` horas: nossa mensagem, a dela (`texto`) e a nossa resposta. */
async function conversaParada(texto, h = 30) {
  const lead = await empresa();
  await db.atualizarLead(lead.id, { status: "respondeu" });
  const m1 = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: lead.whatsapp, corpo: "Oi, aqui é o Felipe." });
  await db.atualizarMensagem(m1, { status: "enviada", enviada_em: horasAtras(h + 2) });
  await db.criarResposta({ lead_id: lead.id, canal: "whatsapp", origem_id: `fu-${lead.id}`, de: lead.whatsapp, texto, classificacao: "interessado", resumo: "x" });
  await db.consultar("UPDATE respostas SET recebida_em = $2 WHERE lead_id = $1", [lead.id, horasAtras(h + 1)]);
  const m2 = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: lead.whatsapp, corpo: "Entendi! E hoje como chegam os clientes?", tipo: "resposta", etapa: 0 });
  await db.atualizarMensagem(m2, { status: "enviada", enviada_em: horasAtras(h) });
  return db.buscarLead(lead.id);
}

test("follow-up: oferece a prévia quando a conversa falou de site, e o link nunca sai fora de hora", async () => {
  await db.consultar("UPDATE mensagens SET status = 'enviada' WHERE status = 'aprovada'");
  const site = await conversaParada("Queria muito aparecer no Google, só temos Instagram");
  const atendimento = await conversaParada("O problema é responder rápido no WhatsApp");
  const links = new Map();
  const escrever = async (ctx) => {
    links.set(ctx.lead.id, ctx.linkPrevia);
    // A IA "erra" de propósito e põe o link nas duas: a trava tira onde não era a hora.
    return { opcao: "previa", mensagem: `Fiz um rascunho do site: ${enderecoDaPrevia(ctx.lead)} O que achou?` };
  };
  await followupsDeInteressados(campanha, { escrever, limite: 10 });
  assert.equal(links.get(site.id), enderecoDaPrevia(site));
  assert.equal(links.get(atendimento.id), "");
  const corpo = async (id) => (await db.consultar("SELECT corpo FROM mensagens WHERE lead_id = $1 AND status = 'aprovada'", [id]))[0]?.corpo;
  assert.ok((await corpo(site.id)).includes(enderecoDaPrevia(site)));
  assert.equal(await corpo(atendimento.id), "O que achou?");
});
