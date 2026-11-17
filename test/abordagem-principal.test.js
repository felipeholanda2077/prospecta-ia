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
const { ordenarFilaDeEnvio, propor, abordagemPrincipalLigada, comAbordagemCerta } = await import("../src/pipeline.js");
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
  assert.ok(!ofertaLiberada({ abordagem: "dor_custo", site: "https://x.com.br" }, DURANTE));
  assert.ok(!ofertaLiberada({ ...lead, pais: "PT" }, DURANTE));
  assert.equal(valoresPermitidos({ abordagem: "dor_custo", site: "https://x.com.br" }), null);
  // Europa: o site é 150 € (só esse valor passa), para qualquer empresa de país do euro.
  assert.equal(semValores("Fica 150 €, pagamento único. O plano mensal sai 400 €.", { manter: valoresPermitidos({ pais: "PT" }) }), "Fica 150 €, pagamento único.");

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
  if (ofertaSiteAtiva()) assert.match(sistema, /EXCEÇÃO: a Clínica Sorriso tem \(ou vai receber\) o site de exemplo/);
  // Empresa com site (sem prévia): nenhuma exceção de valor.
  await classificarResposta({ texto: "Gostei muito!", lead: { ...lead, abordagem: "dor_custo", site: "https://clinica.com.br" }, historico: [], campanha, canal: "whatsapp", apresentacao: "Planos: ..." });
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
  assert.match(html, /Valor único, sem mensalidade: à vista no Pix ou boleto, ou em até 12x de R\$\s?41,67 sem juros no cartão/);
  assert.match(html, /12x de R\$\s?41,67 sem juros<\/option>/);
  assert.match(html, /<select id="parcelas">/); // o site parcela em até 12x no cartão
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

test("fila parada (ex.: número reconectado): a primeira mensagem antiga sai já reescrita na abordagem principal", async () => {
  await db.inserirLead({ place_id: "parada-1", nome: "Barbearia Parada", nicho: "barbearia", cidade: "Osasco - SP", site: null, origem: "maps" });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = 'parada-1'");
  await db.atualizarLead(l.id, { status: "proposta_gerada", abordagem: "dor_custo", oportunidades: "[]", whatsapp: "5511988887777" });
  const ids = [];
  for (const etapa of [1, 2, 3]) {
    ids.push(await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5511988887777", corpo: `antiga ${etapa}`, etapa, tipo: etapa === 1 ? "inicial" : "sequencia", status: "aprovada" }));
  }
  const vez = [{ ...(await db.buscarMensagem(ids[0])), numeroDaVez: { modo: "uazap", numeroId: "n1" } }];

  // Desligada: a dor_custo é do teste A/B, nada muda.
  await db.gravarConfig("abordagem_principal", { ativa: false });
  assert.equal((await comAbordagemCerta(vez, campanha))[0].corpo, "antiga 1");

  await db.gravarConfig("abordagem_principal", { ativa: true });
  respostaDaIA = {
    servico_principal: "site", resumo_interno: "r", assunto_email: "a",
    whatsapp: { etapa1: "Montei uma prévia do site da Barbearia Parada:\n{{PREVIA}}", etapa2: "de R$ 950 por R$ 500", etapa3: "última" }, email: { etapa1: "e1", etapa2: "e2", etapa3: "e3" },
  };
  const [saiu] = await comAbordagemCerta(vez, campanha);
  assert.match(saiu.corpo, /fluxdeck\.com\.br\/previa\/[\w-]+$/);
  assert.deepEqual(saiu.numeroDaVez, { modo: "uazap", numeroId: "n1" }); // continua no número da vez
  assert.equal((await db.buscarLead(l.id)).abordagem, ABORDAGEM_PRINCIPAL);
  assert.equal((await db.buscarMensagem(ids[1])).corpo, "de R$ 950 por R$ 500");
  await db.gravarConfig("abordagem_principal", { ativa: false });
});

test("prévia de Portugal: português de Portugal, WhatsApp com o 351 e sem a oferta em reais", () => {
  const lead = { nome: "Beauty By Ju", nicho: "Salão de beleza", cidade: "Lisboa, Portugal", pais: "PT", place_id: "x", maps_url: "https://maps.google.com/?cid=1",
    endereco: "Av. Exemplo 1, Lisboa", avaliacao: 5, total_avaliacoes: 144, whatsapp: "351912253028", telefone: "+351 912 253 028", token: "t", origem: "campanha" };
  const html = paginaDaPrevia(lead, { marca: "FluxDeck", agora: DURANTE });
  assert.match(html, /lang="pt-PT"/);
  assert.match(html, /wa\.me\/351912253028\?/);
  assert.doesNotMatch(html, /wa\.me\/55351/);
  assert.doesNotMatch(html, /R\$|Black Friday/);
  assert.match(html, /Fale connosco/);
  assert.match(html, /Beleza e autoestima, com marcação em Lisboa/);
  const texto = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "");
  assert.doesNotMatch(texto, /você|a gente|Equipe|Oi!/i);
});

test("Europa: site de 150 € com valor fixo, link do Stripe de pagamento único, e a IA não convida para reunião", async () => {
  const { valorDoPlano } = await import("../src/vendas/stripe.js");
  const { localizarParaEmpresa } = await import("../src/internacional.js");
  assert.deepEqual(await valorDoPlano({ plano: "Criação de site", valor: "150", lead: { pais: "PT" } }), { nome: "Criação de site", valor: 150, moeda: "EUR", unico: true });
  assert.deepEqual(await valorDoPlano({ plano: "criacao de site", lead: { pais: "ES" } }), { nome: "Criação de site", valor: 150, moeda: "EUR", unico: true });
  await db.gravarConfig("stripe", { chave: "x" });
  const sistema = await localizarParaEmpresa("Base.", { nome: "Beauty By Ju", pais: "PT", idioma: "pt-PT", cidade: "Lisboa" });
  assert.match(sistema, /150 € \(valor fixo, pagamento único, sem mensalidade\)/);
  assert.match(sistema, /\{\{pagamento:Criação de site\|150\}\}/);
  assert.match(sistema, /Nunca convide para reunião/);
  await db.gravarConfig("stripe", {});
});

test("fila antiga: a etapa 3 que convidava para o bate-papo sai sem o convite e sem o link de agendamento", async () => {
  const { semAgendamento } = await import("../src/ia/resposta.js");
  assert.equal(semAgendamento("Essa é a minha última mensagem. Que tal um bate-papo de 15 minutos para eu mostrar exemplos? Se não for o momento, tudo bem!\n"),
    "Essa é a minha última mensagem. Se não for o momento, tudo bem!");
  assert.equal(semAgendamento("Ficou ótimo! O exemplo visual prefiro mostrá-lo numa chamada. Marque aqui: https://calendly.com/x"), "Ficou ótimo!");
});

test("prévia com a cara da empresa: fotos do Google, avaliações reais, horário e o que o painel acrescentou", async () => {
  const { dadosDaPrevia, gravarExtraDaPrevia } = await import("../src/vendas/dadosDaPrevia.js");
  const lead = { id: 98765, nome: "Beauty By Ju", nicho: "Salão de beleza", cidade: "Lisboa, Portugal", pais: "PT", place_id: "ChIJabcdefghijklmnopqrst",
    maps_url: "https://maps.google.com/?cid=1", endereco: "Av. Exemplo 1", avaliacao: 5, total_avaliacoes: 144, whatsapp: "351912253028", token: "tk", origem: "campanha" };
  let buscas = 0;
  const buscar = async () => { buscas++; return { fotos: 3, avaliacoes: [{ nome: "Ana L.", texto: "Ambiente super tranquilo e saio sempre de lá no meu melhor look!" }], horario: ["segunda-feira: 10:00–19:00"] }; };
  await gravarExtraDaPrevia(lead.id, { logo: "Beauty", logoDetalhe: "by Ju", servicos: [["Unhas de gel", "Manicure com gel que dura."]], sobre: "Um espaço acolhedor." });
  const dados = await dadosDaPrevia(lead, { buscar });
  await dadosDaPrevia(lead, { buscar });
  assert.equal(buscas, 1); // guardado: não busca no Google a cada visita
  const html = paginaDaPrevia(lead, { marca: "FluxDeck", dados, fotoUrl: (n) => `/previa/tk/foto/${n}` });
  assert.match(html, /<img src="\/previa\/tk\/foto\/0"/);
  assert.match(html, /Ambiente super tranquilo/);
  assert.match(html, /segunda-feira: 10:00–19:00/);
  assert.match(html, /Unhas de gel/);
  assert.match(html, /class="logo-texto">Beauty<small>by Ju<\/small>/);
  assert.match(html, /Sobre a Beauty By Ju/);
  assert.match(html, /Cormorant/);
  assert.doesNotMatch(html, /a sua foto aqui/);
  // Mapa de verdade do Google, no endereço do perfil (e nas coordenadas exatas, quando há).
  assert.match(html, /<iframe src="https:\/\/www\.google\.com\/maps\?q=Beauty%20By%20Ju%2C%20Av\.%20Exemplo%201&amp;z=17&amp;hl=pt&amp;output=embed"/);
  assert.match(paginaDaPrevia({ ...lead, lat: 38.738, lng: -9.1497 }, { dados }), /maps\?q=Beauty%20By%20Ju%4038\.738%2C-9\.1497/);
  // Empresa do CNPJ (endereço da Receita): sem mapa.
  assert.doesNotMatch(paginaDaPrevia({ ...lead, place_id: null, maps_url: null, origem: "cnpj" }, { dados: {} }), /<iframe/);
});

test("interessados antigos sem o site de exemplo: recebem a mensagem com o link, uma vez, só se a conversa parou do nosso lado", async () => {
  const { previasParaInteressados, mensagemDaPrevia } = await import("../src/respostas/followup.js");
  assert.match(mensagemDaPrevia({ nome: "Beauty By Ju", pais: "PT" }, "L"), /Diga-me o que acha!/);
  assert.match(mensagemDaPrevia({ nome: "Clínica X" }, "L"), /Me conta o que achou!/);
  const camp = { ...campanha, automacao: { respostaAutomatica: true } };
  const criar = async (place, { site = null, ultimaNossa = true } = {}) => {
    await db.inserirLead({ place_id: place, nome: `Empresa ${place}`, nicho: "salão", cidade: "Osasco - SP", site, origem: "maps" });
    const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [place]);
    await db.atualizarLead(l.id, { status: "respondeu", whatsapp: `5511977${place.slice(-6)}` });
    const m = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: `5511977${place.slice(-6)}`, corpo: "Oi", tipo: "inicial", etapa: 1 });
    await db.atualizarMensagem(m, { status: "enviada", enviada_em: new Date(Date.now() - 50 * 3600_000).toISOString() });
    await db.criarResposta({ lead_id: l.id, canal: "whatsapp", origem_id: `r-${place}`, de: `5511977${place.slice(-6)}`, texto: "Tenho interesse", classificacao: "interessado", resumo: "x" });
    await db.consultar("UPDATE respostas SET recebida_em = $2 WHERE lead_id = $1", [l.id, new Date(Date.now() - 49 * 3600_000).toISOString()]);
    if (ultimaNossa) {
      const m2 = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: `5511977${place.slice(-6)}`, corpo: "Entendi!", tipo: "resposta", etapa: 0 });
      await db.atualizarMensagem(m2, { status: "enviada", enviada_em: new Date(Date.now() - 48 * 3600_000).toISOString() });
    }
    return l.id;
  };
  const vai = await criar("int-000001");
  const comSite = await criar("int-000002", { site: "https://x.com.br" });
  const esperandoResposta = await criar("int-000003", { ultimaNossa: false });
  await previasParaInteressados(camp, { limite: 10 });
  const fila = async (id) => db.consultar("SELECT corpo FROM mensagens WHERE lead_id = $1 AND status = 'aprovada'", [id]);
  assert.match((await fila(vai))[0].corpo, /\/previa\/[\w-]+/);
  assert.equal((await fila(comSite)).length, 0);
  assert.equal((await fila(esperandoResposta)).length, 0); // a resposta dela é a IA da conversa que responde
  await db.consultar("UPDATE mensagens SET status = 'enviada', enviada_em = now() - interval '3 hours' WHERE lead_id = $1", [vai]);
  await previasParaInteressados(camp, { limite: 10 });
  assert.equal((await fila(vai)).length, 0); // uma vez só
});

test("marca da empresa: a logo (foto de perfil) aparece na prévia e as cores saem dela, com contraste certo", async () => {
  const { corPrincipal, paletaDaMarca, corDaLogo } = await import("../src/vendas/marcaDaPrevia.js");
  const { marcaDaEmpresa } = await import("../src/vendas/dadosDaPrevia.js");
  const pixels = (cores) => new Uint8ClampedArray(cores.flatMap(([c, n]) => Array.from({ length: n }, () => [...c, 255]).flat()));
  // Logo amarela e preta em fundo branco: vale o amarelo (a cor viva), não o branco do fundo.
  assert.equal(corPrincipal(pixels([[[255, 255, 255], 600], [[240, 190, 20], 300], [[20, 20, 20], 100]])), "#f0be14");
  // Logo só preta: o preto.
  assert.equal(corPrincipal(pixels([[[255, 255, 255], 700], [[15, 15, 15], 300]])), "#0f0f0f");
  // Cor clara: o texto em cima fica escuro e o topo, escuro; cor forte: texto branco.
  assert.equal(paletaDaMarca("#f0be14").tinta, "#111111");
  assert.equal(paletaDaMarca("#c2185b").tinta, "#ffffff");

  // De uma imagem de verdade (PNG feito no canvas): vermelho.
  const { createCanvas } = await import("@napi-rs/canvas");
  const c = createCanvas(40, 40); const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 40, 40); ctx.fillStyle = "#d32f2f"; ctx.fillRect(8, 8, 24, 24);
  const png = c.toBuffer("image/png");
  assert.equal(await corDaLogo(png), "#d32f2f");

  const lead = { id: 55501, nome: "Panobianco Teste" };
  let buscas = 0;
  const marca = await marcaDaEmpresa(lead, { buscar: async () => { buscas++; return { tipo: "image/png", dados: png }; } });
  assert.deepEqual([marca.logo, marca.cor], [true, "#d32f2f"]);
  await marcaDaEmpresa(lead, { buscar: async () => { buscas++; return null; } });
  assert.equal(buscas, 1); // guardada por 7 dias

  const html = paginaDaPrevia({ ...semSite, nicho: "academia" }, { dados: { temLogo: true, corDaMarca: "#f0be14" }, logoUrl: "/previa/x/logo" });
  assert.match(html, /--cor:#f0be14;--tinta:#111111/);
  assert.match(html, /<img class="logo-img" src="\/previa\/x\/logo"/);
  assert.match(html, /<img class="hero-logo sobe" src="\/previa\/x\/logo"/);
  // Sem logo: a cor do ramo e as iniciais.
  assert.doesNotMatch(paginaDaPrevia({ ...semSite, nicho: "academia" }, { dados: {} }), /<img class="(?:logo-img|hero-logo)/);
});

test("logo com margem de fundo liso é recortada (fica grande e legível) e larga vai sem repetir o nome", async () => {
  const { aparaLogo } = await import("../src/vendas/marcaDaPrevia.js");
  const { createCanvas } = await import("@napi-rs/canvas");
  const c = createCanvas(400, 400); const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 400, 400); ctx.fillStyle = "#c9a45c"; ctx.fillRect(60, 170, 280, 60);
  const r = await aparaLogo(c.toBuffer("image/png"));
  assert.ok(r.largura < 330 && r.altura < 100 && r.largura > r.altura * 1.4, JSON.stringify([r.largura, r.altura]));
  assert.equal(r.fundo, "#ffffff");
  // Foto (tudo é conteúdo): fica como está.
  const f = createCanvas(100, 100); const fx = f.getContext("2d");
  for (let i = 0; i < 100; i++) { fx.fillStyle = `hsl(${i * 3.6},70%,50%)`; fx.fillRect(i, 0, 1, 100); }
  assert.equal(await aparaLogo(f.toBuffer("image/png")), null);
  const html = paginaDaPrevia({ ...semSite }, { dados: { temLogo: true, logoLarga: true, fundoDaLogo: "#000000", corDaMarca: "#f88d06" }, logoUrl: "/l" });
  assert.match(html, /<img class="logo-img larga" src="\/l" alt="Logo Clínica Sorriso" style="background:#000000">/);
  assert.doesNotMatch(html, /<img class="logo-img larga"[^>]*><span>Clínica Sorriso<\/span>/);
});

test("cena 3D: os objetos saem do que a empresa oferece (salão: esmalte; academia: haltere; dentista: dente)", async () => {
  const { objetosDaEmpresa } = await import("../src/vendas/previa.js");
  assert.deepEqual(objetosDaEmpresa({ servicos: [["Unhas de gel", "Manicure"], ["Cabelo", "Corte"], ["Depilação a laser", ""]], nicho: "Salão de beleza", icone: "✨" }), ["💅", "💇‍♀️", "✨"]);
  assert.equal(objetosDaEmpresa({ servicos: [["Musculação", ""], ["Aulas coletivas", ""]], nicho: "academia", icone: "💪" })[0], "🏋️");
  assert.ok(objetosDaEmpresa({ servicos: [["Implantes", ""]], nicho: "clínica odontológica", icone: "🦷" }).includes("🦷"));
  const html = paginaDaPrevia({ ...semSite, nicho: "Salão de beleza" }, { dados: { servicos: [["Unhas de gel", "Manicure com gel"], ["Cabelo", "Corte"]] } });
  assert.match(html, /<div class="obj3d"><span style="transform:translateZ\(0\.0px\)">💅<\/span>/);
  assert.match(html, /class="sat"[^>]*><i>💇‍♀️<\/i>/);
});

test("arte da oferta: vai junto da primeira mensagem que oferece o site de R$ 500 (uma vez só), nunca a de R$ 3.000", async () => {
  const { arteDaOferta } = await import("../src/pipeline.js");
  const { ARTE_DA_OFERTA } = await import("../src/vendas/campanha.js");
  const { readFileSync } = await import("node:fs");
  assert.match(ARTE_DA_OFERTA, /whatsapp-black-friday-500\.jpg$/);
  // Os arquivos antigos da arte (o de R$ 3.000) são a mesma arte nova: nenhum link antigo mostra o valor errado.
  const nova = readFileSync(new URL("../public/whatsapp-black-friday-500.jpg", import.meta.url));
  assert.ok(nova.equals(readFileSync(new URL("../public/whatsapp-black-friday.jpg", import.meta.url))));
  assert.ok(nova.equals(readFileSync(new URL("../public/whatsapp-black-friday-site.jpg", import.meta.url))));

  const m = { canal: "whatsapp", tipo: "resposta", lead_id: 424242, corpo: "Fica de R$ 950 por R$ 500, em até 12x sem juros." };
  assert.equal(await arteDaOferta(m, DURANTE), ARTE_DA_OFERTA);
  assert.equal(await arteDaOferta({ ...m, corpo: "Entendi! Me conta mais." }, DURANTE), null);
  assert.equal(await arteDaOferta({ ...m, pais: "PT" }, DURANTE), null);
  assert.equal(await arteDaOferta({ ...m, canal: "email" }, DURANTE), null);
  assert.equal(await arteDaOferta(m, DEPOIS), null);
  await db.gravarEstado("arte_oferta:424242", new Date().toISOString());
  assert.equal(await arteDaOferta(m, DURANTE), null); // a conversa já recebeu a arte
});

test("checkout transparente (Stripe): página da FluxDeck com o campo do cartão, intenção de pagamento e confirmação fecham a empresa", async () => {
  const stripe = await import("../src/vendas/stripe.js");
  const { paginaDoCheckoutStripe } = await import("../src/vendas/paginaCheckoutStripe.js");
  const { cifrar } = await import("../src/segredos.js");
  await db.inserirLead({ place_id: "pilates-1", nome: "Authentico Pilates", nicho: "pilates", cidade: "Lisboa, Portugal", origem: "campanha", pais: "PT", idioma: "pt-PT", fuso: "Europe/Lisbon" });
  const [l] = await db.consultar("SELECT * FROM leads WHERE place_id = 'pilates-1'");
  await db.gravarConfig("stripe", { chave: cifrar("sk_live_teste1234567890"), conta: "FluxDeck", teste: false });
  await assert.rejects(stripe.salvarChavePublica("sk_live_errada123456"), /pk_live_/);

  const antes = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.stripe.com")) return antes(url, op);
    chamadas.push({ u, corpo: op.body ? Object.fromEntries(new URLSearchParams(op.body)) : null });
    if (u.includes("/webhook_endpoints")) return Response.json({ data: [] , id: "we_1", secret: "whsec_1" });
    if (u.endsWith("/payment_intents") && op.method === "POST") return Response.json({ id: "pi_1", client_secret: "pi_1_secret_x", status: "requires_payment_method" });
    if (u.includes("/payment_intents/pi_1")) return Response.json({ id: "pi_1", client_secret: "pi_1_secret_x", status: "succeeded", metadata: { checkout: chamadas.find((c) => c.corpo?.["metadata[checkout]"])?.corpo["metadata[checkout]"] }, receipt_email: "ana@exemplo.pt" });
    return Response.json({});
  };
  try {
    await stripe.salvarChavePublica("pk_live_publica1234567890");
    assert.equal((await stripe.situacao()).checkoutTransparente, true);
    // O site da Europa (pagamento único) sai pelo checkout transparente, no endereço da FluxDeck.
    const url = await stripe.linkDePagamento({ lead: l, nome: "Criação de site", valor: 150, moeda: "EUR", unico: true });
    const codigo = url.match(/\/checkout\/x\/([\w-]+)$/)[1];
    assert.equal(await stripe.linkDePagamento({ lead: l, nome: "Criação de site", valor: 150, moeda: "EUR", unico: true }), url); // o mesmo link
    const compra = await stripe.compraDoCheckout(codigo);
    assert.deepEqual([compra.plano, compra.valor, compra.moeda, compra.empresa], ["Criação de site", 150, "EUR", "Authentico Pilates"]);

    const html = paginaDoCheckoutStripe(compra, { publica: "pk_live_publica1234567890", base: `/checkout/x/${codigo}` });
    assert.match(html, /js\.stripe\.com\/v3/);
    assert.match(html, /Stripe\("pk_live_publica1234567890"/);
    assert.match(html, /\/checkout\/_\/logo\.jpg/); // a logo da FluxDeck
    assert.match(html, /€\s?150,00|150,00\s?€/);
    assert.match(html, /Pagamento único, sem mensalidade/); // em português de Portugal
    // Credibilidade: o que está incluído, os próximos passos, quem recebe (com o CNPJ) e os meios aceitos, mais o Apple/Google Pay num toque.
    assert.match(html, /O que está incluído/);
    assert.match(html, /O seu site fica no ar no prazo de uma semana/);
    assert.match(html, /CNPJ 57\.167\.092\/0001-16/);
    assert.match(html, /expressCheckout/);
    assert.match(html, /Apple Pay<\/span><span>Google Pay/);
    assert.match(paginaDoCheckoutStripe(compra, { publica: "pk_live_publica1234567890", base: "/x", previa: "https://fluxdeck.com.br/previa/abc" }), /href="https:\/\/fluxdeck\.com\.br\/previa\/abc"[^>]*>👀 Ver o exemplo do seu site/);

    assert.deepEqual(await stripe.intencaoDoCheckout(codigo), { clientSecret: "pi_1_secret_x" });
    const pi = chamadas.find((c) => c.u.endsWith("/payment_intents") && c.corpo);
    assert.deepEqual([pi.corpo.amount, pi.corpo.currency, pi.corpo["metadata[lead_id]"]], ["15000", "eur", String(l.id)]);

    const r = await stripe.confirmarCheckout(codigo, "pi_1");
    assert.equal(r.pago, true);
    assert.equal((await db.buscarLead(l.id)).status, "fechado");
  } finally {
    globalThis.fetch = antes;
    await db.gravarConfig("stripe", {});
  }
});
