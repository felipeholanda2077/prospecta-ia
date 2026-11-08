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
