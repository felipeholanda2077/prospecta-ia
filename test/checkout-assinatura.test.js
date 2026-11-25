import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.PAINEL_SENHA = "senha-de-teste";
const db = await import("../src/db.js");
const { cifrar } = await import("../src/segredos.js");
const stripe = await import("../src/vendas/stripe.js");
const { paginaDoCheckoutStripe, paginaDoCheckoutStripeFeito } = await import("../src/vendas/paginaCheckoutStripe.js");
await db.iniciar();
await db.gravarConfig("stripe", { chave: cifrar("sk_test_1234567890abcdef"), teste: true, publica: "pk_test_1234567890abcdef" });

// O Stripe de mentira: guarda cada pedido e responde como a API.
const pedidos = [];
let statusDoPi = "requires_payment_method";
globalThis.fetch = async (url, op = {}) => {
  const caminho = String(url).replace("https://api.stripe.com/v1", "");
  const campos = Object.fromEntries(new URLSearchParams(op.body ?? ""));
  pedidos.push({ metodo: op.method, caminho, campos, versao: op.headers?.["Stripe-Version"] ?? null });
  const json = (d) => new Response(JSON.stringify(d));
  if (caminho === "/prices") return json({ id: campos["recurring[interval]"] ? "price_mensal" : "price_criacao" });
  if (caminho === "/customers") return json({ id: "cus_1" });
  if (caminho === "/subscriptions") return json({ id: "sub_1", status: "incomplete", latest_invoice: { confirmation_secret: { client_secret: "pi_123_secret_abc" } } });
  if (caminho.startsWith("/payment_intents/pi_123")) return json({ id: "pi_123", status: statusDoPi, amount: 15000, currency: "eur" });
  return new Response(JSON.stringify({ error: { message: `não esperado: ${caminho}` } }), { status: 400 });
};

test("checkout fixo do site com API: €150 agora e €25 por mês a partir de 1º de janeiro de 2027", async () => {
  const compra = await stripe.compraDoCheckout("site-agendamento");
  assert.equal(compra.implantacao, 150);
  assert.equal(compra.valor, 25);
  assert.equal(compra.moeda, "EUR");
  assert.equal(compra.pais, "PT");
  assert.equal((await stripe.compraDoCheckout("site-agendamento", { lang: "en" })).plano, "Business website with API for other systems");

  await assert.rejects(stripe.intencaoDoCheckout("site-agendamento", { nome: "", email: "x" }), /Preencha o nome/);
  const r = await stripe.intencaoDoCheckout("site-agendamento", { nome: "Ana Costa", email: "Ana@Exemplo.pt" });
  assert.equal(r.clientSecret, "pi_123_secret_abc");

  const [mensal, criacao] = pedidos.filter((p) => p.caminho === "/prices").map((p) => p.campos);
  assert.deepEqual([mensal.currency, mensal.unit_amount, mensal["recurring[interval]"]], ["eur", "2500", "month"]);
  assert.deepEqual([criacao.currency, criacao.unit_amount, criacao["recurring[interval]"]], ["eur", "15000", undefined]);

  const assinatura = pedidos.find((p) => p.caminho === "/subscriptions");
  assert.equal(assinatura.campos["items[0][price]"], "price_mensal");
  assert.equal(assinatura.campos["add_invoice_items[0][price]"], "price_criacao"); // a criação vai na fatura de agora
  assert.equal(assinatura.campos.trial_end, String(Date.UTC(2027, 0, 1) / 1000)); // 1º/01/2027, 00:00 de Lisboa
  assert.equal(assinatura.campos.payment_behavior, "default_incomplete");
  assert.equal(assinatura.campos["payment_settings[save_default_payment_method]"], "on_subscription");
  assert.equal(assinatura.versao, "2025-03-31.basil");
  assert.equal(pedidos.find((p) => p.caminho === "/customers").campos.email, "ana@exemplo.pt");

  // Cartão recusado e nova tentativa com o mesmo e-mail: a mesma assinatura, nada criado de novo.
  const antes = pedidos.length;
  assert.equal((await stripe.intencaoDoCheckout("site-agendamento", { nome: "Ana Costa", email: "ana@exemplo.pt" })).clientSecret, "pi_123_secret_abc");
  assert.equal(pedidos.slice(antes).filter((p) => p.metodo === "POST").length, 0);

  // Volta do pagamento: só conta como pago quando o Stripe diz que entrou.
  assert.equal((await stripe.confirmarCheckout("site-agendamento", "pi_123")).pago, false);
  statusDoPi = "succeeded";
  assert.equal((await stripe.confirmarCheckout("site-agendamento", "pi_outro")).pago, false);
  assert.equal((await stripe.confirmarCheckout("site-agendamento", "pi_123")).pago, true);
  assert.ok(await db.lerEstado("stripe_pago:pi_123"));
  await assert.rejects(stripe.intencaoDoCheckout("site-agendamento", { nome: "Ana", email: "ana@exemplo.pt" }), /já foi feito/);
});

test("a página mostra €150 hoje e a mensalidade de €25 a partir de 1 de janeiro de 2027", async () => {
  const compra = await stripe.compraDoCheckout("site-agendamento");
  const html = paginaDoCheckoutStripe(compra, { publica: "pk_test_x", base: "/checkout/x/site-agendamento" });
  assert.match(html, /Criação do site \(pagamento único\)/);
  assert.match(html, /150,00\s€/);
  assert.match(html, /25,00\s€\/mês/);
  assert.match(html, /1 de janeiro de 2027/);
  assert.match(html, /Pagar 150,00\s€/);
  assert.match(html, /Site institucional com API para outros sistemas/);
  assert.match(html, /mode: "payment", amount: 15000, currency: "eur"/);
  const en = paginaDoCheckoutStripe(await stripe.compraDoCheckout("site-agendamento", { lang: "en" }), { publica: "pk_test_x", base: "/b" });
  assert.match(en, /€25\.00\/mo/);
  assert.match(en, /January 1, 2027/);
  assert.match(paginaDoCheckoutStripeFeito(compra, { pago: true }), /mensalidade de 25,00\s€ fica agendada para 1 de janeiro de 2027/);
});
