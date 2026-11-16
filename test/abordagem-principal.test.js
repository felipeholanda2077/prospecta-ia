import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA ??= "senha-de-teste";
for (const k of ["NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
// A IA "de verdade" responde por um fetch falso (abaixo): dá para ver o que o sistema pediu a ela.
process.env.ANTHROPIC_API_KEY = "chave-de-teste";

const db = await import("../src/db.js");
const { escolherAbordagem, vaiPelaPrevia, ABORDAGEM_PRINCIPAL, ABORDAGENS } = await import("../src/ia/abordagens.js");
const { gerarSequencia, comLinkDaPrevia } = await import("../src/ia/proposta.js");
const { ordenarFilaDeEnvio, propor, abordagemPrincipalLigada } = await import("../src/pipeline.js");
const { prioridadeNaFila } = await import("../src/analise/prioridade.js");
const { semValores, ofertaLiberada, valoresPermitidos, classificarResposta } = await import("../src/ia/resposta.js");
const { ofertaSiteAtiva, blocoDaOferta, OFERTA_SITE } = await import("../src/vendas/ofertaSite.js");
const { planosDaApresentacao } = await import("../src/vendas/stripe.js");
const { cobrancaDoPlano, resumoDoPlano } = await import("../src/vendas/checkoutsAsaas.js");
const { paginaDoCheckout } = await import("../src/vendas/paginaCheckout.js");
const { paginaDaPrevia, origemDaPrevia } = await import("../src/vendas/previa.js");
const { lerApresentacao } = await import("../src/respostas/apresentacao.js");

const DURANTE = new Date("2026-11-20T12:00:00-03:00");
const DEPOIS = new Date("2026-12-01T00:00:01-03:00");
const campanha = {
  empresa: { nome: "FluxDeck", responsavel: "Felipe", telefone: "(11) 98888-7777", site: "https://fluxdeck.com.br", diferenciais: [] },
  servicos: [], canais: ["whatsapp"], limites: { maxPropostasPorCiclo: 10 }, automacao: { ativo: false },
};
const semSite = { nome: "Clínica Sorriso", nicho: "clínica odontológica", cidade: "Osasco - SP", token: "tok-sem-site", origem: "campanha", status: "analisado", site: null, whatsapp: "5511999990000" };

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

test("abordagem principal: só com a chave ligada, e só para empresa do Brasil sem site, com WhatsApp e prévia", () => {
  assert.ok(vaiPelaPrevia(semSite));
  assert.ok(!vaiPelaPrevia({ ...semSite, site: "https://clinicasorriso.com.br" }));
  assert.ok(vaiPelaPrevia({ ...semSite, site: "https://instagram.com/clinicasorriso" })); // só rede social conta como sem site
  assert.ok(!vaiPelaPrevia({ ...semSite, pais: "US" }));
  assert.ok(!vaiPelaPrevia({ ...semSite, whatsapp: null }));
  assert.ok(!vaiPelaPrevia({ ...semSite, origem: "contador" }));
  assert.ok(!vaiPelaPrevia({ ...semSite, origem: "cnpj" })); // o cadastro do CNPJ não diz se tem site

  const contagem = {};
  assert.equal(escolherAbordagem(contagem, () => 0.5, { lead: semSite, principal: true }), ABORDAGEM_PRINCIPAL);
  assert.equal(contagem[ABORDAGEM_PRINCIPAL].contatadas, 1);
  // Desligada, ou empresa com site: segue o teste A/B de sempre.
  assert.ok(ABORDAGENS[escolherAbordagem(contagem, () => 0.5, { lead: semSite, principal: false })]);
  assert.ok(ABORDAGENS[escolherAbordagem(contagem, () => 0.5, { lead: { ...semSite, site: "https://x.com.br" }, principal: true })]);
});

test("fila: entre as empresas novas, as sem site vão primeiro; conversas e etapas seguintes continuam na frente", () => {
  const nova = (id, site, extra = {}) => ({ id, tipo: "inicial", etapa: 1, site, ...extra });
  const fila = ordenarFilaDeEnvio([
    nova(1, "https://comsite.com.br", { total_avaliacoes: 900, avaliacao: 4.9, whatsapp_status: "verificado" }),
    nova(2, null),
    { id: 3, tipo: "sequencia", etapa: 2, site: "https://a.com" },
    { id: 4, tipo: "resposta", etapa: 0, site: "https://a.com" },
    nova(5, "https://facebook.com/loja"),
    nova(6, null, { origem: "cnpj" }), // não sabemos se tem site: fica com as outras, pelo potencial
  ]);
  assert.deepEqual(fila.map((m) => m.id), [4, 3, 2, 5, 1, 6]);

  const comSite = prioridadeNaFila({ site: "https://x.com.br", total_avaliacoes: 900, avaliacao: 4.9, whatsapp_status: "verificado" });
  const sem = prioridadeNaFila({ site: null });
  assert.ok(sem.pontos > comSite.pontos);
  assert.match(sem.rotulo, /^Sem site/);
  assert.ok(sem.pontos < prioridadeNaFila({}, { andamento: { chance: "fria", rotulo: "Fria", proximoPasso: "" } }).pontos);
});

test("sequência principal: a etapa 1 leva o link da prévia (no site da FluxDeck), a 2 a oferta da Black Friday", async () => {
  assert.equal(origemDaPrevia(campanha), "https://fluxdeck.com.br");
  respostaDaIA = {
    servico_principal: "site", resumo_interno: "prévia", assunto_email: "o site da Clínica Sorriso",
    whatsapp: { etapa1: "Oi! Sou o Felipe, da FluxDeck. Montei uma prévia do site da Clínica Sorriso:\n{{PREVIA}}\nO que achou?", etapa2: "Fica de R$ 950 por R$ 500.", etapa3: "Última mensagem {{PREVIA}}" },
    email: { etapa1: "Oi! Fiz uma prévia do site de vocês.", etapa2: "x", etapa3: "y" },
  };
  const s = await gerarSequencia(semSite, [], campanha, { abordagem: ABORDAGEM_PRINCIPAL });
  const link = "https://fluxdeck.com.br/previa/tok-sem-site";
  assert.equal(s.whatsapp[0], `Oi! Sou o Felipe, da FluxDeck. Montei uma prévia do site da Clínica Sorriso:\n${link}\nO que achou?`);
  assert.ok(s.email[0].endsWith(`\n${link}`)); // a IA esqueceu o marcador: o link vai no fim
  assert.equal(s.whatsapp[2], "Última mensagem"); // fora da etapa 1, o marcador só sai
  const sistema = pedidosAIA.at(-1).system;
  assert.match(sistema, /NÃO tem site próprio/);
  assert.match(sistema, /NUNCA diga nem dê a entender que a empresa "não tem site"/);
  if (ofertaSiteAtiva()) assert.match(sistema, /de R\$ 950 por R\$ 500, valor único/);

  assert.equal(comLinkDaPrevia("Oi\n{{PREVIA}}\nE aí?", "", 1), "Oi\nE aí?");
});

test("propor: com a chave ligada, a empresa sem site ganha a sequência da prévia; desligada, o teste A/B", async () => {
  respostaDaIA = {
    servico_principal: "site", resumo_interno: "r", assunto_email: "a",
    whatsapp: { etapa1: "Oi\n{{PREVIA}}", etapa2: "dois", etapa3: "três" }, email: { etapa1: "e1", etapa2: "e2", etapa3: "e3" },
  };
  const criar = async (place, site) => {
    await db.inserirLead({ place_id: place, nome: `Empresa ${place}`, nicho: "pet shop", cidade: "Osasco - SP", site, origem: "campanha" });
    const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [place]);
    await db.atualizarLead(l.id, { status: "analisado", oportunidades: "[]", whatsapp: `55119${place.padStart(8, "0")}` });
    return l.id;
  };
  assert.equal(await abordagemPrincipalLigada(), false); // nasce desligada: só liga depois do seu OK
  const a = await criar("1001", null);
  await db.gravarConfig("abordagem_principal", { ativa: true });
  const b = await criar("1002", null);
  const c = await criar("1003", "https://empresa.com.br");
  await propor(campanha);
  const abordagem = async (id) => (await db.buscarLead(id)).abordagem;
  assert.equal(await abordagem(a), ABORDAGEM_PRINCIPAL);
  assert.equal(await abordagem(b), ABORDAGEM_PRINCIPAL);
  assert.ok(ABORDAGENS[await abordagem(c)]);
  const [primeira] = await db.mensagensDaSequencia(b, "whatsapp");
  assert.match(primeira.corpo, /\/previa\/[\w-]+/);

  // A trava que reescreve sequências com preço não mexe nas da abordagem principal enquanto a oferta vale.
  await db.consultar("UPDATE mensagens SET corpo = 'de R$ 950 por R$ 500' WHERE lead_id = $1 AND etapa = 2", [b]);
  await db.consultar("UPDATE mensagens SET corpo = 'a partir de R$ 450' WHERE lead_id = $1 AND etapa = 2", [c]);
  assert.deepEqual(await db.leadsComPrecoPendente(10), [c]);
  assert.deepEqual((await db.leadsComPrecoPendente(10, { comPrincipal: true })).sort(), [b, c].sort());
  await db.gravarConfig("abordagem_principal", { ativa: false });
});

test("oferta: só os valores dela passam na trava, e só para a abordagem principal enquanto vale", () => {
  const lead = { abordagem: ABORDAGEM_PRINCIPAL, nome: "Clínica" };
  assert.ok(ofertaLiberada(lead, DURANTE));
  assert.ok(!ofertaLiberada(lead, DEPOIS));
  assert.ok(!ofertaLiberada({ abordagem: "dor_custo" }, DURANTE));
  assert.ok(!ofertaLiberada({ ...lead, pais: "PT" }, DURANTE));
  assert.equal(valoresPermitidos({ abordagem: "dor_custo" }), null);

  const t = "Que bom que gostou! Fica de R$ 950 por R$ 500, valor único. O WhatsApp com IA sai R$ 497.\n- Site Essencial: R$ 450";
  const re = /R\$\s?(?:500|950)(?:,00)?(?![\d.,]*\d)|\b(?:500|950)\s?reais\b/gi;
  assert.equal(semValores(t), "Que bom que gostou!");
  assert.equal(semValores(t, { manter: re }), "Que bom que gostou! Fica de R$ 950 por R$ 500, valor único.");
  assert.equal(semValores("Sai por R$ 5000.", { manter: re }), "");
});

test("conversa da abordagem principal: a IA pode citar a oferta sem a pessoa perguntar (e nenhum outro valor)", async () => {
  respostaDaIA = { classificacao: "interessado", resumo: "x", sugestao_resposta: "Que bom!", precisa_humano: false, motivo_humano: "",
    indicou_contato: false, temperatura: "quente", proximo_passo: "", robo: false, encerrar: false, dor_entendida: true, pediu_conversa: false };
  const lead = { ...semSite, abordagem: ABORDAGEM_PRINCIPAL };
  await classificarResposta({ texto: "Gostei muito!", lead, historico: [], campanha, canal: "whatsapp", apresentacao: "Planos: ..." });
  const sistema = pedidosAIA.at(-1).system;
  if (ofertaSiteAtiva()) assert.match(sistema, /EXCEÇÃO: a Clínica Sorriso recebeu a prévia/);
  await classificarResposta({ texto: "Gostei muito!", lead: { ...lead, abordagem: "dor_custo" }, historico: [], campanha, canal: "whatsapp", apresentacao: "Planos: ..." });
  assert.doesNotMatch(pedidosAIA.at(-1).system, /EXCEÇÃO/);
});

test("plano de pagamento único: lido da apresentação, cobrado uma vez e sem mensalidade no checkout", async () => {
  const [p] = planosDaApresentacao(blocoDaOferta({ checkout: "https://fluxdeck.com.br/checkout/site-black-friday" }));
  assert.deepEqual(p, { nome: OFERTA_SITE.plano, reais: 500, intervalo: "once" });
  const c = cobrancaDoPlano(p);
  assert.equal(c.unico, true);
  assert.equal(c.primeiro, 500);
  assert.equal(c.mensal, null);
  assert.equal(c.dados.value, 500);
  const html = paginaDoCheckout(resumoDoPlano({ plano: p.nome, primeiro: 500, mensal: null, unico: true }), { marca: "FluxDeck" });
  assert.match(html, /Pagamento único/);
  assert.match(html, /Valor único: sem mensalidade/);
  assert.doesNotMatch(html, /1ª mensalidade|Sem fidelidade/);

  // Na apresentação usada pela IA, a oferta entra sozinha enquanto vale; no texto salvo (o do painel), não.
  await db.gravarConfig("apresentacao", { texto: "Planos:\n- Site Essencial (R$ 79,90/mês + implantação de R$ 450)" });
  const comOferta = await lerApresentacao();
  assert.equal(comOferta.includes(OFERTA_SITE.plano), ofertaSiteAtiva());
  assert.ok(!(await lerApresentacao(null, { comOferta: false })).includes(OFERTA_SITE.plano));
  assert.ok(!(await lerApresentacao({ pais: "US" })).includes(OFERTA_SITE.plano)); // fora do Brasil, nunca
});

test("página da prévia: mostra a oferta da Black Friday enquanto vale", () => {
  const html = paginaDaPrevia(semSite, { marca: "FluxDeck", agora: DURANTE });
  assert.match(html, /Black Friday: este site no ar de <s>R\$ 950<\/s> por <b>R\$ 500<\/b>, valor único/);
  assert.doesNotMatch(paginaDaPrevia(semSite, { marca: "FluxDeck", agora: DEPOIS }), /Black Friday/);
});
