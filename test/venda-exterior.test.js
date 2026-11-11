import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA = "senha-de-teste";
const db = await import("../src/db.js");
const intl = await import("../src/internacional.js");
const stripe = await import("../src/vendas/stripe.js");
const { comSlidesNoLugarDoConvite } = await import("../src/ia/proposta.js");
const { APRESENTACAO_PADRAO } = await import("../src/respostas/apresentacao.js");
await db.iniciar();

const hoje = new Date().toISOString().slice(0, 10);
await db.gravarConfig("cotacao_brl", { dia: hoje, data: hoje, EUR: 0.16274, USD: 0.1817 });
await db.gravarConfig("internacional", { ajustePct: 100 });

const alemanha = { id: 7, nome: "Praxis Mitte", pais: "DE", idioma: "de-DE", cidade: "Berlin, Alemanha" };
const miami = { id: 8, nome: "Ocean Auto Sales", pais: "US", idioma: "en-US", cidade: "Miami, EUA" };
const lisboa = { id: 9, nome: "Estoril Motor", pais: "PT", idioma: "pt-PT", cidade: "Lisboa, Portugal" };

test("venda sem reunião: fora do Brasil e de Portugal; Portugal e Brasil seguem com o agendamento", () => {
  assert.equal(intl.vendeSemReuniao(alemanha), true);
  assert.equal(intl.vendeSemReuniao(miami), true);
  assert.equal(intl.vendeSemReuniao(lisboa), false);
  assert.equal(intl.vendeSemReuniao({ pais: null }), false);
  assert.equal(intl.linkDosSlides(miami), "https://fluxdeck.com.br/apresentacao?lang=en&para=Ocean%20Auto%20Sales");
});

test("etapa 3: o marcador de agendamento vira os slides; sem link, os slides vão no fim; Portugal fica igual", () => {
  const slides = intl.linkDosSlides(miami);
  assert.equal(comSlidesNoLugarDoConvite("Last message.\n{{link_agendamento}}", miami), `Last message.\n${slides}`);
  assert.equal(comSlidesNoLugarDoConvite("Last message.", miami), `Last message.\n${slides}`);
  assert.equal(comSlidesNoLugarDoConvite("Última.\n{{link_agendamento}}", lisboa), "Última.\n{{link_agendamento}}");
});

test("IA: regras da venda sem reunião só para quem é de fora do Brasil e de Portugal", async () => {
  const de = await intl.localizarParaEmpresa("Convide para o bate-papo.", alemanha);
  assert.match(de, /VENDA SEM REUNIÃO/);
  assert.match(de, /apresentacao\?lang=en&para=Praxis%20Mitte/);
  assert.match(de, /vai mandar o link de pagamento em seguida/); // sem Stripe ainda
  const pt = await intl.localizarParaEmpresa("Convide para o bate-papo.", lisboa);
  assert.doesNotMatch(pt, /VENDA SEM REUNIÃO/);
});

test("planos: os valores da apresentação viram a mensalidade na moeda da empresa", async () => {
  const planos = stripe.planosDaApresentacao(APRESENTACAO_PADRAO);
  assert.ok(planos.some((p) => p.nome === "Professional" && p.reais === 2500));
  assert.ok(planos.some((p) => p.nome === "Professional com IA de atendimento no WhatsApp" && p.reais === 3000 && p.promocao));
  assert.deepEqual(await stripe.valorDoPlano({ plano: "Professional", valor: "910", lead: miami, apresentacao: APRESENTACAO_PADRAO }), { nome: "Professional", valor: 910, moeda: "USD" });
  // Valor que não é de nenhum plano não vale: fica o do plano pelo nome.
  assert.deepEqual(await stripe.valorDoPlano({ plano: "Professional", valor: "500", lead: alemanha, apresentacao: APRESENTACAO_PADRAO }), { nome: "Professional", valor: 810, moeda: "EUR" });
  assert.equal(await stripe.valorDoPlano({ plano: "Plano Ouro", lead: miami, apresentacao: APRESENTACAO_PADRAO }), null);
});

test("pagamento: sem Stripe o marcador sai e a conversa passa para você; com Stripe vira o link", async () => {
  const c = { sugestao_resposta: "Perfect, Professional at US$910/month.\n{{pagamento:Professional|910}}", precisa_humano: false };
  const sem = await stripe.aplicarLinkDePagamento(c, miami, { apresentacao: APRESENTACAO_PADRAO });
  assert.equal(sem.sugestao_resposta, "Perfect, Professional at US$910/month.");
  assert.equal(sem.precisa_humano, true);
  assert.match(sem.motivo_humano, /Stripe não está conectado/);

  const antes = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, op = {}) => {
    chamadas.push({ url: String(url), corpo: op.body ? Object.fromEntries(new URLSearchParams(op.body)) : null });
    if (String(url).endsWith("/account")) return new Response(JSON.stringify({ id: "acct_1", email: "fluxdeck@example.com", charges_enabled: true }));
    if (String(url).endsWith("/prices")) return new Response(JSON.stringify({ id: "price_1" }));
    if (String(url).endsWith("/payment_links")) return new Response(JSON.stringify({ url: "https://buy.stripe.com/test_abc" }));
    return new Response("{}", { status: 404 });
  };
  try {
    await assert.rejects(stripe.conectar({ chave: "minha-chave" }), /chave secreta/);
    const r = await stripe.conectar({ chave: "sk_test_1234567890abcdef" });
    assert.equal(r.conectado, true);
    const guardada = await db.lerConfig("stripe");
    assert.doesNotMatch(JSON.stringify(guardada), /sk_test_1234567890abcdef/); // criptografada
    const com = await stripe.aplicarLinkDePagamento(c, miami, { apresentacao: APRESENTACAO_PADRAO });
    assert.equal(com.sugestao_resposta, "Perfect, Professional at US$910/month.\nhttps://buy.stripe.com/test_abc");
    assert.notEqual(com.precisa_humano, true);
    const preco = chamadas.find((x) => x.url.endsWith("/prices")).corpo;
    assert.deepEqual([preco.currency, preco.unit_amount, preco["recurring[interval]"]], ["usd", "91000", "month"]);
    // O mesmo plano para a mesma empresa reaproveita o link.
    const n = chamadas.length;
    await stripe.aplicarLinkDePagamento(c, miami, { apresentacao: APRESENTACAO_PADRAO });
    assert.equal(chamadas.length, n);
    // Com o Stripe conectado, a IA recebe a instrução do marcador.
    assert.match(await intl.localizarParaEmpresa("x", alemanha), /\{\{pagamento:NOME EXATO DO PLANO\|VALOR POR MÊS\}\}/);
  } finally {
    globalThis.fetch = antes;
  }
});

const pipeline = await import("../src/pipeline.js");
const crypto = await import("node:crypto");

test("busca: cidades de fora usam os segmentos de fora; as do Brasil, os daqui", () => {
  const campanha = { buscas: [{ nicho: "Concessionária", cidades: ["Osasco - SP", "Lisboa, Portugal", "Miami, EUA"] }],
    automacao: { nichosExterior: ["clínica odontológica", "salão de beleza"] }, ramosExtras: ["pet shop"] };
  const combos = pipeline.combinacoesDeBusca(campanha).map((c) => `${c.nicho} @ ${c.cidade}`);
  assert.deepEqual(combos, [
    "Concessionária @ Osasco - SP",
    "clínica odontológica @ Lisboa, Portugal", "clínica odontológica @ Miami, EUA",
    "salão de beleza @ Lisboa, Portugal", "salão de beleza @ Miami, EUA",
    "pet shop @ Osasco - SP",
  ]);
  // Sem segmentos de fora, as cidades de fora usam os mesmos daqui.
  const iguais = pipeline.combinacoesDeBusca({ ...campanha, automacao: {}, ramosExtras: [] }).map((c) => c.cidade);
  assert.deepEqual(iguais, ["Osasco - SP", "Lisboa, Portugal", "Miami, EUA"]);
});

test("número de fora: com a chave ligada, cada lado tem o seu número", async () => {
  assert.equal(pipeline.numeroServeParaEmpresa("n2", { pais: "US" }, null), true);
  assert.equal(pipeline.numeroServeParaEmpresa("n2", { pais: "US" }, "n2"), true);
  assert.equal(pipeline.numeroServeParaEmpresa("n1", { pais: "US" }, "n2"), false);
  assert.equal(pipeline.numeroServeParaEmpresa("n2", { pais: null }, "n2"), false);
  assert.equal(pipeline.numeroServeParaEmpresa("n1", { pais: "BR" }, "n2"), true);
  assert.equal(await pipeline.numeroDeFora({ numeroExterior: { ativo: false, numeroId: "n2" } }), null);
  assert.equal(await pipeline.numeroDeFora({ numeroExterior: { ativo: true, numeroId: "n2" } }), "n2");
});

test("pagamento confirmado: a empresa vira fechada, a fila é cancelada e a IA para; repetir não duplica", async () => {
  await db.inserirLead({ place_id: "ChIJmiamiPago000000000001", nome: "Ocean Auto Sales", cidade: "Miami, EUA", pais: "US", idioma: "en-US", fuso: "America/New_York" });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = $1", ["ChIJmiamiPago000000000001"]);
  const pendente = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "13055550123", corpo: "Hi", status: "aprovada", etapa: 2 });
  await db.gravarEstado("stripe_link_lead:plink_1", JSON.stringify({ leadId: lead.id, nome: "Professional", valor: 910, moeda: "USD" }));
  const sessao = { id: "cs_1", status: "complete", payment_link: "plink_1", customer_details: { email: "owner@ocean.example" } };
  const r = await stripe.registrarPagamento(sessao);
  assert.deepEqual([r.empresa, r.plano, r.valor], ["Ocean Auto Sales", "Professional", 910]);
  const depois = await db.buscarLead(lead.id);
  assert.equal(depois.status, "fechado");
  assert.match(depois.observacao, /Pagou pelo Stripe: Professional, US\$\s?910,00 por mês \(owner@ocean.example\)/);
  assert.equal((await db.buscarMensagem(pendente)).status, "rejeitada");
  const { iaPausada } = await import("../src/respostas/processar.js");
  assert.ok(await iaPausada(lead.id));
  assert.equal(await stripe.registrarPagamento(sessao), null);
  // Link que não é do sistema não muda nada.
  assert.equal(await stripe.registrarPagamento({ id: "cs_2", status: "complete", payment_link: "plink_outro" }), null);
});

test("aviso do Stripe: só vale com a assinatura certa", async () => {
  const c = await db.lerConfig("stripe");
  const { cifrar } = await import("../src/segredos.js");
  await db.gravarConfig("stripe", { ...c, webhookId: "we_1", webhookSegredo: cifrar("whsec_teste") });
  const corpo = Buffer.from(JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_9", status: "complete", payment_link: "plink_nenhum" } } }));
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", "whsec_teste").update(`${t}.${corpo.toString("utf8")}`).digest("hex");
  assert.equal(await stripe.assinaturaValida(corpo, `t=${t},v1=${v1}`), true);
  assert.equal(await stripe.assinaturaValida(corpo, `t=${t},v1=${"0".repeat(64)}`), false);
  assert.equal(await stripe.assinaturaValida(corpo, `t=${t - 1000},v1=${v1}`), false);
  assert.deepEqual(await stripe.processarAviso(corpo, `t=${t},v1=${v1}`), { aceito: true, pagamento: null });
  assert.deepEqual(await stripe.processarAviso(corpo, "t=1,v1=x"), { aceito: false });
});

test("botão Link de pagamento para empresa de fora: Stripe em euro ou dólar, nunca Asaas em reais", async () => {
  const antes = globalThis.fetch;
  const moedas = [];
  globalThis.fetch = async (url, op = {}) => {
    const corpo = op.body ? Object.fromEntries(new URLSearchParams(op.body)) : {};
    if (String(url).endsWith("/prices")) { moedas.push(corpo.currency); return new Response(JSON.stringify({ id: `price_${moedas.length}` })); }
    if (String(url).endsWith("/payment_links")) return new Response(JSON.stringify({ id: `plink_${moedas.length}`, url: `https://buy.stripe.com/test_${moedas.length}` }));
    if (String(url).endsWith("/account")) return new Response(JSON.stringify({ id: "acct_1", charges_enabled: true }));
    return new Response("{}", { status: 404 });
  };
  try {
    const site = { id: "o1", nome: "Site", valor: 570, mensal: true };
    const pt = await stripe.linkDoStripeParaOferta({ ...lisboa, id: 91 }, site);
    assert.equal(pt.venda.moeda, "EUR");
    assert.match(pt.mensagem, /^Segue o link para subscrever Site \(.*€ por mês\), com cartão: https:\/\/buy\.stripe\.com\/test_1$/);
    const us = await stripe.linkDoStripeParaOferta({ ...miami, id: 92 }, site);
    assert.equal(us.venda.moeda, "USD");
    assert.match(us.mensagem, /^Here is the link to subscribe to Site \(\$\d+ per month\), by card:/);
    assert.deepEqual(moedas, ["eur", "usd"]);
    // Pagamento único (PIX) e diagnóstico não existem para fora; Brasil continua no Asaas.
    assert.match((await stripe.linkDoStripeParaOferta(miami, { ...site, mensal: false })).erro, /só ofertas mensais/);
    assert.match((await stripe.linkDoStripeParaOferta({ id: 1, pais: "BR" }, site)).erro, /Asaas/);
  } finally {
    globalThis.fetch = antes;
  }
});

test("página em inglês: os planos em dólar e em euro, sem a promoção repetida; outra moeda não", async () => {
  const usd = await stripe.precosPublicos("usd");
  assert.equal(usd.moeda, "USD");
  assert.ok(usd.planos.length >= 1 && usd.planos.every((p) => p.nome && p.porMes > 0));
  assert.equal(new Set(usd.planos.map((p) => p.nome)).size, usd.planos.length);
  assert.equal((await stripe.precosPublicos("EUR")).moeda, "EUR");
  assert.equal((await stripe.precosPublicos("BRL")).moeda, "BRL"); // os planos do Brasil, para o site
  assert.equal(await stripe.precosPublicos("GBP"), null);
});

test("planos em inglês na página e no Stripe; o diagnóstico (em reais) não aparece", async () => {
  assert.equal(stripe.nomeEmIngles("Loja virtual"), "Online store");
  assert.equal(stripe.nomeEmIngles("Professional"), "Professional");
  const usd = await stripe.precosPublicos("USD");
  assert.ok(!usd.planos.some((p) => /diagn|loja|site profissional/i.test(p.nome)));
  assert.deepEqual(usd.planos.map((p) => p.porMes), [...usd.planos.map((p) => p.porMes)].sort((a, b) => a - b));
});

test("checkouts dos planos: um por plano em reais e em dólar; rodar de novo reaproveita; quem paga é achado pelo telefone", async () => {
  const antes = globalThis.fetch;
  const criados = [];
  const desativados = [];
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    const corpo = op.body ? Object.fromEntries(new URLSearchParams(op.body)) : {};
    if (u.endsWith("/prices")) return new Response(JSON.stringify({ id: `price_${criados.length}` }));
    if (u.endsWith("/payment_links")) { criados.push(corpo); return new Response(JSON.stringify({ id: `plink_p${criados.length}`, url: `https://buy.stripe.com/p${criados.length}` })); }
    if (/\/payment_links\/plink_/.test(u)) { desativados.push(u); return new Response("{}"); }
    if (u.endsWith("/account")) return new Response(JSON.stringify({ id: "acct_1", charges_enabled: true }));
    return new Response("{}", { status: 404 });
  };
  try {
    const links = await stripe.criarCheckoutsDosPlanos({ moedas: ["BRL", "USD"] });
    const planos = new Set(links.map((l) => l.plano));
    assert.equal(links.length, planos.size * 2);
    assert.ok(links.some((l) => l.moeda === "BRL") && links.some((l) => l.moeda === "USD"));
    assert.ok(![...planos].some((p) => /diagn/i.test(p)));
    assert.ok(criados.every((c) => c["phone_number_collection[enabled]"] === "true"));
    assert.match(criados.find((c) => /Termos de Uso/.test(c["custom_text[submit][message]"]))["custom_text[submit][message]"], /fluxdeck\.com\.br\/termos/);
    // De novo, sem mudar nada: nada novo no Stripe.
    const n = criados.length;
    await stripe.criarCheckoutsDosPlanos({ moedas: ["BRL", "USD"] });
    assert.equal(criados.length, n);
    assert.equal(desativados.length, 0);
    // A página em inglês já leva o botão para o checkout em dólar.
    assert.ok((await stripe.precosPublicos("USD")).planos.every((p) => /^https:\/\/buy\.stripe\.com\//.test(p.checkout)));

    // Pagou pelo checkout do plano: a empresa da conversa é achada pelo telefone e fecha.
    await db.inserirLead({ place_id: "ChIJcheckout0000000000000001", nome: "Clínica Paga", cidade: "Osasco - SP", whatsapp: "5511987654321" });
    const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJcheckout0000000000000001"]);
    await db.atualizarLead(l.id, { whatsapp: "5511987654321" });
    const brl = links.find((x) => x.moeda === "BRL");
    const r = await stripe.registrarPagamento({ id: "cs_plano_1", status: "complete", payment_link: brl.id, customer_details: { phone: "+55 11 98765-4321", email: "dono@clinica.com" } });
    assert.equal(r.leadId, l.id);
    assert.equal((await db.buscarLead(l.id)).status, "fechado");
    // Quem não é de nenhuma empresa: registrado e avisado, sem empresa.
    const outro = await stripe.registrarPagamento({ id: "cs_plano_2", status: "complete", payment_link: brl.id, customer_details: { email: "novo@x.com", name: "Nova" } });
    assert.equal(outro.leadId, null);
    assert.match(outro.contato, /novo@x\.com/);
  } finally {
    globalThis.fetch = antes;
  }
});

test("planos do Brasil com implantação e anual; apresentação de fora separada (os preços em dólar não mudam)", async () => {
  const texto = `Planos:
- WhatsApp com IA (R$ 129,90/mês + implantação de R$ 497): atendente de IA.
- Completo Anual (R$ 2.397/ano, ou 12x de R$ 199,75; implantação grátis): tudo integrado.
- Completo Bônus (R$ 2.000/ano): tudo, implantação de R$ 1.950 grátis.
- Automação sob medida (a partir de R$ 900, valor único): processos.`;
  const p = stripe.planosDaApresentacao(texto);
  assert.deepEqual(p.map((x) => [x.nome, x.reais, x.intervalo, x.implantacao ?? null]), [
    ["WhatsApp com IA", 129.9, "month", 497], ["Completo Anual", 2397, "year", null], ["Completo Bônus", 2000, "year", null],
  ]);

  const { lerApresentacao, gravarApresentacao, lerApresentacaoDeFora } = await import("../src/respostas/apresentacao.js");
  const antes = await lerApresentacao();
  const usdAntes = (await stripe.precosPublicos("USD")).planos.map((x) => x.porMes);
  await gravarApresentacao(texto);
  assert.equal(await lerApresentacao(), texto.trim());
  assert.equal(await lerApresentacao({ pais: "BR" }), texto.trim());
  // A primeira troca guarda os planos de antes para fora do Brasil.
  assert.equal(await lerApresentacaoDeFora(), antes);
  assert.equal(await lerApresentacao({ pais: "US" }), antes);
  assert.deepEqual((await stripe.precosPublicos("USD")).planos.map((x) => x.porMes), usdAntes);
});

test("checkouts do Asaas: mensal cobra implantação + 1º mês; anual em até 12x; slides de fechamento terminam no pagamento", async () => {
  const { cobrancaDoPlano } = await import("../src/vendas/checkoutsAsaas.js");
  const mensal = cobrancaDoPlano({ nome: "WhatsApp com IA", reais: 129.9, intervalo: "month", implantacao: 497 });
  assert.equal(mensal.primeiro, 626.9);
  assert.equal(mensal.mensal, 129.9);
  assert.equal(mensal.dados.chargeType, "DETACHED");
  assert.equal(mensal.dados.billingType, "UNDEFINED");
  assert.match(mensal.dados.description, /Depois, R\$\s?129,90 por mês/);
  const anual = cobrancaDoPlano({ nome: "Completo Anual", reais: 2397, intervalo: "year" });
  assert.deepEqual([anual.primeiro, anual.mensal, anual.dados.chargeType, anual.dados.maxInstallmentCount], [2397, null, "INSTALLMENT", 12]);

  const { arrumarSlides, paginaDosSlides } = await import("../src/vendas/slides.js");
  const dados = arrumarSlides({ titulo: "Proposta", slides: [
    { tipo: "capa", titulo: "Capa", subtitulo: "", itens: [] },
    { tipo: "investimento", titulo: "Investimento", subtitulo: "", itens: [{ titulo: "WhatsApp com IA", texto: "R$ 497 + R$ 129,90/mês" }, { titulo: "Completo Anual", texto: "R$ 2.397/ano" }] },
    { tipo: "fechamento", titulo: "Vamos começar?", subtitulo: "", itens: [{ titulo: "Escolha", texto: "o plano" }] },
    { tipo: "proximo_passo", titulo: "Bate-papo", subtitulo: "", itens: [] },
  ] }, { empresa: "Telles", modo: "fechamento" });
  assert.equal(dados.slides.at(-1).tipo, "fechamento");
  assert.ok(!dados.slides.some((s) => s.tipo === "proximo_passo"));
  const html = paginaDosSlides({ dados: { ...dados, checkout: { plano: "WhatsApp com IA", url: "https://www.asaas.com/c/abc" } }, empresa: "Telles" });
  assert.match(html, /Contratar WhatsApp com IA agora/);
  assert.match(html, /Recomendado/);
});
