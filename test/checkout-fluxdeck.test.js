import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.PAINEL_SENHA = "senha-de-teste";
const db = await import("../src/db.js");
const { cifrar } = await import("../src/segredos.js");
const ck = await import("../src/vendas/checkoutsAsaas.js");
const { paginaDoCheckout } = await import("../src/vendas/paginaCheckout.js");
await db.iniciar();

await db.gravarConfig("asaas", { chave: cifrar("$aact_hmlg_teste"), ambiente: "sandbox" });
await db.gravarConfig("asaas_planos", { links: [
  { chave: "a", plano: "WhatsApp com IA", primeiro: 626.9, mensal: 129.9, implantacao: 497, anual: false, url: "https://www.asaas.com/c/a", id: "lnk_mensal" },
  { chave: "b", plano: "Completo Anual", primeiro: 2397, mensal: null, implantacao: null, anual: true, url: "https://www.asaas.com/c/b", id: "lnk_anual" },
] });

// O Asaas de mentira: guarda o que foi pedido e responde como a API.
const pedidos = [];
let respostaCobranca = (corpo) => ({ id: "pay_1", status: "PENDING", dueDate: corpo.dueDate, bankSlipUrl: "https://boleto", customer: corpo.customer });
globalThis.fetch = async (url, opcoes = {}) => {
  const caminho = new URL(url).pathname.replace(/^\/v3/, "") + new URL(url).search;
  const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
  pedidos.push({ metodo: opcoes.method, caminho, corpo });
  const json = (d) => ({ ok: true, status: 200, json: async () => d });
  if (caminho.startsWith("/customers?")) return json({ data: [] });
  if (caminho === "/customers") return json({ id: "cus_1", ...corpo });
  if (caminho === "/payments") return json(respostaCobranca(corpo));
  if (caminho.endsWith("/pixQrCode")) return json({ encodedImage: "QR", payload: "000201pix", expirationDate: "2026-11-13" });
  if (caminho.endsWith("/identificationField")) return json({ identificationField: "34191.79001" });
  if (caminho.startsWith("/customers/")) return json({ id: "cus_1", name: "Ana Souza", email: "ana@exemplo.com.br", mobilePhone: "11988887777" });
  if (caminho === "/subscriptions") return json({ id: "sub_1", ...corpo });
  if (caminho.startsWith("/payments/pay_1")) return json({ id: "pay_1", status: "RECEIVED", externalReference: "checkout:lnk_mensal" });
  return { ok: false, status: 404, json: async () => ({}) };
};

const dados = { forma: "pix", nome: "Ana Souza", email: "ana@exemplo.com.br", celular: "(11) 98888-7777", documento: "529.982.247-25" };

test("checkout: endereço de cada plano e a página com os valores", async () => {
  assert.equal(ck.enderecoDoCheckout("WhatsApp com IA"), "/checkout/whatsapp-com-ia");
  const link = await ck.planoDoCheckout("whatsapp-com-ia");
  const html = paginaDoCheckout(ck.resumoDoPlano(link), { marca: "FluxDeck", telefone: "11953528042" });
  assert.match(html, /R\$\s626,90/);
  assert.match(html, /Implantação \(uma vez\)/);
  assert.match(html, /Sem fidelidade/);
  assert.doesNotMatch(html, /lnk_mensal|asaas\.com\/c/);
  const anual = paginaDoCheckout(ck.resumoDoPlano(await ck.planoDoCheckout("completo-anual")));
  assert.match(anual, /12x de R\$\s199,75/);
});

test("checkout: Pix cria o cliente e a cobrança com a referência do plano e devolve o QR Code", async () => {
  pedidos.length = 0;
  const r = await ck.pagarCheckout("whatsapp-com-ia", dados, { ip: "1.2.3.4", agora: new Date("2026-11-11T15:00:00Z") });
  assert.deepEqual(r.pix, { imagem: "QR", codigo: "000201pix", expira: "2026-11-13" });
  const cobranca = pedidos.find((p) => p.caminho === "/payments").corpo;
  assert.equal(cobranca.billingType, "PIX");
  assert.equal(cobranca.value, 626.9);
  assert.equal(cobranca.externalReference, "checkout:lnk_mensal");
  assert.equal(cobranca.dueDate, "2026-11-12");
  assert.equal(pedidos.find((p) => p.caminho === "/customers").corpo.cpfCnpj, "52998224725");
  assert.deepEqual(await ck.situacaoDoCheckout("whatsapp-com-ia", "pay_1"), { pago: true });
  assert.equal(await ck.situacaoDoCheckout("completo-anual", "pay_1"), null); // pagamento de outro plano
});

test("checkout: dados errados param antes de chegar no Asaas", async () => {
  pedidos.length = 0;
  await assert.rejects(ck.pagarCheckout("whatsapp-com-ia", { ...dados, documento: "123.456.789-00" }, { ip: "5.5.5.5" }), /CPF ou CNPJ/);
  await assert.rejects(ck.pagarCheckout("whatsapp-com-ia", { ...dados, nome: "Ana" }, { ip: "5.5.5.5" }), /nome completo/);
  await assert.rejects(ck.pagarCheckout("whatsapp-com-ia", { ...dados, forma: "cartao", cartao: { numero: "4111 1111 1111 1112" } }, { ip: "5.5.5.5" }), /número do cartão/);
  await assert.rejects(ck.pagarCheckout("nao-existe", dados, { ip: "5.5.5.5" }), /Plano não encontrado/);
  await assert.rejects(ck.pagarCheckout("whatsapp-com-ia", { ...dados, site: "robo" }, { ip: "5.5.5.5" }), ck.ErroDoCheckout);
  assert.equal(pedidos.length, 0);
});

test("checkout: cartão aprovado fecha na hora e a mensalidade fica no mesmo cartão", async () => {
  pedidos.length = 0;
  respostaCobranca = (corpo) => ({ id: "pay_2", status: "CONFIRMED", value: corpo.value, customer: corpo.customer, creditCard: { creditCardToken: "tok_123" } });
  const cartao = { numero: "4111 1111 1111 1111", nome: "ANA SOUZA", validade: "12/30", cvv: "123", cep: "01310-100", numeroEndereco: "100" };
  const r = await ck.pagarCheckout("whatsapp-com-ia", { ...dados, forma: "cartao", cartao }, { ip: "9.9.9.9", agora: new Date("2026-11-11T15:00:00Z") });
  assert.equal(r.pago, true);
  const cobranca = pedidos.find((p) => p.caminho === "/payments").corpo;
  assert.deepEqual(cobranca.creditCard, { holderName: "ANA SOUZA", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", ccv: "123" });
  assert.equal(cobranca.remoteIp, "9.9.9.9");
  const assinatura = pedidos.find((p) => p.caminho === "/subscriptions").corpo;
  assert.equal(assinatura.billingType, "CREDIT_CARD");
  assert.equal(assinatura.creditCardToken, "tok_123");
  assert.equal(assinatura.value, 129.9);
  assert.equal(await db.lerEstado("checkout_cartao:pay_2"), ""); // o token não fica guardado depois
});

test("checkout: o anual no cartão vai parcelado", async () => {
  pedidos.length = 0;
  respostaCobranca = (corpo) => ({ id: "pay_3", installment: "ins_1", status: "CONFIRMED", customer: corpo.customer });
  const cartao = { numero: "4111111111111111", nome: "ANA", validade: "01/31", cvv: "321", cep: "01310100", numeroEndereco: "1" };
  await ck.pagarCheckout("completo-anual", { ...dados, forma: "cartao", cartao, parcelas: "12" }, { ip: "8.8.8.8" });
  const cobranca = pedidos.find((p) => p.caminho === "/payments").corpo;
  assert.equal(cobranca.installmentCount, 12);
  assert.equal(cobranca.totalValue, 2397);
  assert.equal(pedidos.some((p) => p.caminho === "/subscriptions"), false);
});

test("checkout: muitas tentativas do mesmo endereço são freadas", async () => {
  respostaCobranca = (corpo) => ({ id: "pay_9", status: "PENDING", customer: corpo.customer });
  const agora = new Date("2026-11-11T18:00:00Z");
  for (let i = 0; i < 8; i += 1) await ck.pagarCheckout("whatsapp-com-ia", { ...dados, forma: "boleto" }, { ip: "7.7.7.7", agora });
  await assert.rejects(ck.pagarCheckout("whatsapp-com-ia", { ...dados, forma: "boleto" }, { ip: "7.7.7.7", agora }), /Muitas tentativas/);
});
