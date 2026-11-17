import crypto from "node:crypto";
import { OFERTA_SITE_EUROPA } from "./ofertaSite.js";
import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";
import { PAISES, arredondarPreco, configInternacional, cotacoes } from "../internacional.js";
import { lerApresentacao, lerApresentacaoDeFora } from "../respostas/apresentacao.js";

// Pagamento das empresas de fora do Brasil pelo Stripe: um link de pagamento com a mensalidade na moeda do
// cliente (euro ou dólar), no cartão, recorrente todo mês. Você cria a conta no Stripe e cola a chave secreta
// em Configurações; ela fica criptografada no banco. Cada link é guardado e reaproveitado (mesma empresa,
// mesmo plano e mesmo valor).
const API = "https://api.stripe.com/v1";
const CONFIG = "stripe";
export const MARCADOR_PAGAMENTO = /\{\{\s*pagamento\s*:\s*([^}|]+?)\s*(?:\|\s*([^}]+?)\s*)?\}\}/i;

async function chave() {
  const c = await db.lerConfig(CONFIG);
  return c?.chave ? decifrar(c.chave) : null;
}

async function chamar(caminho, { metodo = "GET", campos = null, segredo } = {}) {
  const r = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${segredo ?? (await chave())}`, ...(campos ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(campos ? { body: new URLSearchParams(campos).toString() } : {}),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe: ${dados.error?.message ?? `erro ${r.status}`}`);
  return dados;
}

/** Conectado? (E se a chave ficou trancada porque a senha do painel mudou.) */
export async function situacao() {
  const c = await db.lerConfig(CONFIG);
  if (!c?.chave) return { conectado: false };
  const aberta = decifrar(c.chave);
  return { conectado: Boolean(aberta), trancada: !aberta, conta: c.conta ?? "", teste: Boolean(c.teste), conectadoEm: c.conectadoEm ?? null,
    avisoDePagamento: Boolean(c.webhookId && c.webhookSegredo), checkoutTransparente: Boolean(c.publica) };
}

/** Confere a chave no Stripe e guarda criptografada. `chave: null` desconecta. */
export async function conectar({ chave: nova }) {
  if (nova === null) {
    await db.gravarConfig(CONFIG, {});
    return { conectado: false };
  }
  const segredo = String(nova ?? "").trim();
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(segredo)) throw new Error("Cole a chave secreta do Stripe (começa com sk_live_ ou rk_live_)");
  const conta = await chamar("/account", { segredo });
  const info = { chave: cifrar(segredo), conta: conta.settings?.dashboard?.display_name || conta.business_profile?.name || conta.email || conta.id,
    teste: segredo.includes("_test_"), conectadoEm: new Date().toISOString() };
  await db.gravarConfig(CONFIG, info);
  const { config } = await import("../config.js");
  const webhook = await configurarWebhook(config.painel.urlPublica).catch((e) => ({ configurado: false, erro: e.message }));
  return { conectado: true, conta: info.conta, teste: info.teste, podeCobrar: conta.charges_enabled !== false, webhook };
}

const valorEmReais = (t) => Number(String(t).replace(/\./g, "").replace(",", "."));

/**
 * Os planos da apresentação com o valor em reais: por mês ("Professional (R$ 2.500/mês, ...)") ou por ano
 * ("Completo Anual (R$ 2.397/ano ..."), e a implantação paga uma vez, quando houver ("... + implantação de R$ 497").
 */
export function planosDaApresentacao(texto) {
  const planos = [];
  for (const linha of String(texto ?? "").split("\n")) {
    // "(R$ 500 pagamento único" (ou "valor único"): plano pago uma vez só, sem mensalidade (intervalo "once").
    const m = linha.match(/^\s*-\s*([^(:]+?)\s*\(R\$\s?([\d.]+(?:,\d{1,2})?)\s*(?:\/\s*(m[eê]s|ano)|(?:pagamento|valor)\s+[uú]nico)/i);
    if (m) {
      // "implantação de R$ 1.950 grátis" não é cobrança: a implantação só vale sem "grátis" logo depois do valor.
      const implantacao = linha.match(/implanta[çc][aã]o\s+(?:de\s+)?R\$\s?([\d.]+(?:,\d{1,2})?)(?![\d.,])(?!\s*gr[aá]tis)/i);
      planos.push({ nome: m[1].trim(), reais: valorEmReais(m[2]), intervalo: !m[3] ? "once" : /ano/i.test(m[3]) ? "year" : "month",
        ...(implantacao ? { implantacao: valorEmReais(implantacao[1]) } : {}) });
    }
    // Promoção ("... de R$ 4.500/mês por R$ 3.000/mês"): o valor promocional também vale para o mesmo plano.
    const p = linha.match(/:\s*([^:]+?)\s+de\s+R\$\s?[\d.]+\/m[eê]s\s+por\s+R\$\s?([\d.]+)\/m[eê]s/i);
    if (p) planos.push({ nome: p[1].trim(), reais: Number(p[2].replace(/\./g, "")), promocao: true });
  }
  return planos;
}

const simples = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * O valor por mês, na moeda da empresa, do plano citado pela IA. O valor que a IA escreveu só vale se for o de
 * algum plano (ela não inventa desconto); sem valor, vale o do plano pelo nome.
 */
export async function valorDoPlano({ plano, valor, lead, apresentacao }) {
  const pais = PAISES[lead?.pais];
  if (!pais || lead.pais === "BR") return null;
  // O site da Europa tem valor fixo em euro (sem conversão) e é pago uma vez só.
  if (pais.moeda === "EUR" && simples(plano) === simples(OFERTA_SITE_EUROPA.plano)) {
    return { nome: OFERTA_SITE_EUROPA.plano, valor: OFERTA_SITE_EUROPA.valor, moeda: "EUR", unico: true };
  }
  const [cot, conf] = await Promise.all([cotacoes(), configInternacional()]);
  const local = (reais) => arredondarPreco(reais * cot[pais.moeda] * (1 + conf.ajustePct / 100));
  const planos = planosDaApresentacao(apresentacao ?? (await lerApresentacao(lead))).map((p) => ({ ...p, local: local(p.reais) }));
  const pedido = Number(String(valor ?? "").replace(/[^\d.,]/g, "").replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
  const nome = simples(plano);
  const doNome = planos.filter((p) => simples(p.nome) === nome || simples(p.nome).includes(nome) || nome.includes(simples(p.nome)));
  const certo = (pedido && (doNome.find((p) => p.local === pedido) ?? planos.find((p) => p.local === pedido)))
    // Pelo nome: o nome exato primeiro; no mesmo plano, o preço da promoção vale.
    || doNome.sort((a, b) => Number(simples(b.nome) === nome) - Number(simples(a.nome) === nome)
      || Number(Boolean(b.promocao)) - Number(Boolean(a.promocao)) || a.nome.length - b.nome.length)[0];
  return certo ? { nome: certo.nome, valor: certo.local, moeda: pais.moeda } : null;
}

// O contrato de serviço em inglês (site): aparece na página de pagamento do Stripe, e a IA cita junto do link.
export const CONTRATO_EN = "https://fluxdeck.com.br/en/terms";

/**
 * Os planos da apresentação em dólar ou euro (cotação do dia com o ajuste de fora), para a página em inglês do
 * site mostrar os mesmos valores que a IA cobra. Público: só nome e valor por mês, nada de cliente.
 */
export async function precosPublicos(moeda) {
  const m = String(moeda ?? "").toUpperCase();
  // Em reais: os planos do Brasil, como estão na apresentação daqui, com o checkout de cada um (para o site).
  if (m === "BRL") {
    // O checkout do Brasil é o do Asaas (taxas menores); sem ele, nenhum (o botão do site leva ao contato).
    const { checkoutsAsaas, enderecoDoCheckout } = await import("./checkoutsAsaas.js");
    const doAsaas = await checkoutsAsaas();
    const planos = planosDaApresentacao(await lerApresentacao()).filter((p) => !p.promocao).map((p) => ({
      nome: p.nome, valor: p.reais, intervalo: p.intervalo, implantacao: p.implantacao ?? null,
      // O checkout da FluxDeck (página nossa, pagamento pelo Asaas): no site, /checkout/<plano> no próprio endereço.
      checkout: doAsaas.some((c) => c.plano === p.nome) ? enderecoDoCheckout(p.nome) : null,
    }));
    return { moeda: m, planos };
  }
  if (!["USD", "EUR"].includes(m)) return null;
  const [cot, conf] = await Promise.all([cotacoes(), configInternacional()]);
  const vistos = new Set();
  const planos = [];
  const checkouts = await checkoutsDosPlanos();
  for (const p of planosDaApresentacao(await lerApresentacaoDeFora())) {
    // O diagnóstico do site é um relatório em português, pago em reais: não é vendido fora.
    if (p.promocao || vistos.has(simples(p.nome)) || /diagn[oó]stico/i.test(p.nome)) continue;
    vistos.add(simples(p.nome));
    // Com checkout do plano no Stripe, a página mostra o valor dele (é o que o cliente paga) e o botão vai direto
    // para ele; sem checkout, o valor do dia (a cotação muda todo dia, então não dá para exigir o mesmo valor).
    const ck = checkouts.find((c) => c.plano === p.nome && c.moeda === m);
    const porMes = ck?.valor ?? arredondarPreco(p.reais * cot[m] * (1 + conf.ajustePct / 100));
    planos.push({ nome: nomeEmIngles(p.nome), porMes, checkout: ck?.url ?? null });
  }
  return { moeda: m, planos: planos.sort((a, b) => a.porMes - b.porMes) };
}

// O nome de cada plano em inglês, para a página em inglês e para a página de pagamento do Stripe.
const NOMES_EM_INGLES = {
  "professional com ia de atendimento no whatsapp": "Professional + WhatsApp AI assistant",
  "app mobile": "Mobile App",
  "correcoes avulsas": "On-demand fixes",
  "modernizacao de site": "Website modernization",
  "site profissional": "Professional website",
  "automacao de atendimento e crm": "Customer service automation & CRM",
  "sistema de agendamento online": "Online booking system",
  "loja virtual": "Online store",
  "sistema de gestao sob medida": "Custom management system",
};
/** "Loja virtual" → "Online store"; nome que não está na lista fica como está. */
export const nomeEmIngles = (nome) => NOMES_EM_INGLES[simples(nome)] ?? nome;

// ---------- Checkouts fixos dos planos (Brasil em reais, EUA em dólar) ----------

const CHAVE_PLANOS = "stripe_planos";
const TERMOS_BR = "https://fluxdeck.com.br/termos";

/** Os checkouts dos planos já criados: [{ plano, moeda, valor, url, id }]. */
export const checkoutsDosPlanos = async () => (await db.lerConfig(CHAVE_PLANOS))?.links ?? [];

/**
 * Cria no Stripe um checkout (link de pagamento, mensalidade no cartão) para cada plano da apresentação: em reais
 * para o Brasil (o valor da apresentação) e em dólar para os EUA (a cotação do dia com o ajuste de fora, igual à
 * página em inglês). Rodar de novo reaproveita o que não mudou; plano com valor novo ganha um link novo e o antigo
 * é desativado. O diagnóstico do site fica de fora (tem página e relatório próprios, pelo Asaas).
 */
// Só dólar: as vendas do Brasil vão pelo Asaas (taxas menores, ver checkoutsAsaas.js). Rodar de novo desativa os em reais.
export async function criarCheckoutsDosPlanos({ moedas = ["USD"] } = {}) {
  if (!(await situacao()).conectado) throw new Error("Conecte o Stripe em Configurações primeiro");
  const [cot, conf] = await Promise.all([cotacoes(), configInternacional()]);
  const antigos = await checkoutsDosPlanos();
  const novos = [];
  // Brasil: os planos da apresentação daqui (implantação + mensalidade ou anuidade). Fora: os da apresentação de
  // fora, só a mensalidade convertida (a mesma conta da página em inglês).
  const fontes = { BRL: planosDaApresentacao(await lerApresentacao()), USD: planosDaApresentacao(await lerApresentacaoDeFora()) };
  for (const moeda of moedas) {
    const vistos = new Set();
    for (const p of fontes[moeda] ?? fontes.USD) {
      // Pagamento único (a oferta do site da Black Friday) é só do Brasil, pelo Asaas.
      if (p.promocao || p.intervalo === "once" || vistos.has(simples(p.nome)) || /diagn[oó]stico/i.test(p.nome)) continue;
      vistos.add(simples(p.nome));
      const emPortugues = moeda === "BRL";
      const valor = emPortugues ? p.reais : arredondarPreco(p.reais * cot[moeda] * (1 + conf.ajustePct / 100));
      const intervalo = emPortugues ? p.intervalo ?? "month" : "month";
      const implantacao = emPortugues ? p.implantacao ?? null : null;
      const igual = antigos.find((a) => a.plano === p.nome && a.moeda === moeda && a.valor === valor
        && (a.intervalo ?? "month") === intervalo && (a.implantacao ?? null) === implantacao);
      if (igual) { novos.push(igual); continue; }
      const nome = emPortugues ? p.nome : nomeEmIngles(p.nome);
      const preco = await chamar("/prices", { metodo: "POST", campos: {
        currency: moeda.toLowerCase(), unit_amount: String(Math.round(valor * 100)), "recurring[interval]": intervalo,
        "product_data[name]": `FluxDeck · ${nome}`, "metadata[plano]": p.nome,
      } });
      // A implantação é cobrada uma vez, junto com o primeiro pagamento.
      const taxa = implantacao ? await chamar("/prices", { metodo: "POST", campos: {
        currency: moeda.toLowerCase(), unit_amount: String(Math.round(implantacao * 100)),
        "product_data[name]": `Implantação · ${nome}`, "metadata[plano]": p.nome,
      } }) : null;
      const link = await chamar("/payment_links", { metodo: "POST", campos: {
        "line_items[0][price]": preco.id, "line_items[0][quantity]": "1",
        ...(taxa ? { "line_items[1][price]": taxa.id, "line_items[1][quantity]": "1" } : {}),
        "metadata[plano]": p.nome, "metadata[checkout]": "plano", "billing_address_collection": "auto",
        // O telefone liga o pagamento à empresa da conversa (quem pagou pelo link do plano, sem link próprio).
        "phone_number_collection[enabled]": "true",
        "custom_text[submit][message]": emPortugues
          ? `Ao assinar, você concorda com os Termos de Uso da FluxDeck: ${TERMOS_BR}`
          : `By subscribing, you agree to the FluxDeck Service Agreement: ${CONTRATO_EN}`,
      } });
      await db.gravarEstado(`stripe_link_plano:${link.id}`, JSON.stringify({ plano: p.nome, valor, moeda }));
      novos.push({ plano: p.nome, nome, moeda, valor, intervalo, implantacao, url: link.url, id: link.id });
    }
  }
  // Os que saíram (plano removido ou valor mudou) param de aceitar pagamento.
  for (const a of antigos) {
    if (novos.some((n) => n.id === a.id)) continue;
    await chamar(`/payment_links/${a.id}`, { metodo: "POST", campos: { active: "false" } }).catch(() => {});
  }
  await db.gravarConfig(CHAVE_PLANOS, { links: novos, atualizadoEm: new Date().toISOString() });
  return novos;
}

/** O link de pagamento (mensalidade no cartão) para a empresa e o plano. Reaproveita o que já foi criado. */
export async function linkDePagamento({ lead, nome, valor, moeda, unico = false }) {
  // Pagamento único (o site) com a chave publicável salva: o checkout transparente da FluxDeck, no lugar do link do Stripe.
  if (unico && (await chavePublica())) return checkoutTransparente({ lead, nome, valor, moeda, unico });
  const guarda = `stripe_link:${lead.id}:${simples(nome)}:${valor}${moeda}${unico ? ":unico" : ""}`;
  const salvo = await db.lerEstado(guarda);
  if (salvo) return salvo;
  // Pagamento único (o site da Europa): sem "recurring", e o link não cria assinatura.
  const preco = await chamar("/prices", { metodo: "POST", campos: {
    currency: moeda.toLowerCase(), unit_amount: String(Math.round(valor * 100)), ...(unico ? {} : { "recurring[interval]": "month" }),
    "product_data[name]": `FluxDeck · ${lead.pais === "PT" || unico ? nome : nomeEmIngles(nome)}`, "metadata[lead_id]": String(lead.id),
  } });
  const link = await chamar("/payment_links", { metodo: "POST", campos: {
    "line_items[0][price]": preco.id, "line_items[0][quantity]": "1",
    "metadata[lead_id]": String(lead.id), "metadata[empresa]": String(lead.nome ?? "").slice(0, 200), "metadata[plano]": nome,
    ...(unico ? { "payment_intent_data[metadata][lead_id]": String(lead.id) } : { "subscription_data[metadata][lead_id]": String(lead.id) }),
    "billing_address_collection": "auto",
    // O contrato de serviço aparece logo acima do botão de pagar.
    "custom_text[submit][message]": lead.pais === "PT"
      ? `${unico ? "Ao pagar" : "Ao subscrever"}, aceita o contrato de serviço da FluxDeck (Service Agreement): ${CONTRATO_EN}`
      : `${unico ? "By paying" : "By subscribing"}, you agree to the FluxDeck Service Agreement: ${CONTRATO_EN}`,
  } });
  await db.gravarEstado(guarda, link.url);
  // Para reconhecer o pagamento: o link aponta para a empresa, o plano e o valor.
  await db.gravarEstado(`stripe_link_lead:${link.id}`, JSON.stringify({ leadId: lead.id, nome, valor, moeda, unico }));
  return link.url;
}

// ---------- Pagamento confirmado ----------

const EVENTO_PAGO = "checkout.session.completed";
const EVENTO_INTENCAO = "payment_intent.succeeded";

// ---------- Checkout transparente (a página da FluxDeck, com o cartão no campo seguro do Stripe) ----------

/** A chave publicável do Stripe (pk_live_...), que a página usa para mostrar o campo do cartão. Você cola no painel. */
export const chavePublica = async () => (await db.lerConfig(CONFIG))?.publica ?? null;

export async function salvarChavePublica(nova) {
  const c = (await db.lerConfig(CONFIG)) ?? {};
  if (nova === null) {
    const { publica, ...resto } = c;
    await db.gravarConfig(CONFIG, resto);
    return { checkoutTransparente: false };
  }
  const pk = String(nova ?? "").trim();
  if (!/^pk_(live|test)_[A-Za-z0-9]{10,}$/.test(pk)) throw new Error("Cole a chave publicável do Stripe (começa com pk_live_)");
  if (c.chave && Boolean(c.teste) !== pk.includes("_test_")) throw new Error("A chave publicável e a secreta precisam ser do mesmo modo (as duas de produção, live)");
  await db.gravarConfig(CONFIG, { ...c, publica: pk });
  // O aviso de pagamento passa a incluir o pagamento pelo checkout transparente.
  const { config } = await import("../config.js");
  const webhook = c.chave ? await configurarWebhook(config.painel.urlPublica).catch((e) => ({ configurado: false, erro: e.message })) : null;
  return { checkoutTransparente: true, webhook };
}

// ---------- Meios de pagamento da conta (o que aparece no checkout transparente) ----------

const CAMPOS_DA_CONFIG = new Set(["id", "object", "active", "application", "is_default", "livemode", "name", "parent"]);

/** A configuração padrão de meios de pagamento da conta: cada meio, se a conta pode usar e se está ligado. */
export async function meiosDePagamento() {
  const lista = (await chamar("/payment_method_configurations?limit=20")).data ?? [];
  const padrao = lista.find((c) => c.is_default && !c.application) ?? lista.find((c) => !c.application) ?? null;
  if (!padrao) return { id: null, meios: [] };
  const meios = Object.entries(padrao)
    .filter(([k, v]) => !CAMPOS_DA_CONFIG.has(k) && v && typeof v === "object" && "available" in v)
    .map(([tipo, v]) => ({ tipo, disponivel: Boolean(v.available), ligado: v.display_preference?.value === "on" }));
  return { id: padrao.id, meios };
}

/** Liga, na configuração padrão, os meios que a conta pode usar (todos os disponíveis, ou só os de `tipos`). */
export async function ligarMeiosDePagamento(tipos = null) {
  const { id, meios } = await meiosDePagamento();
  if (!id) throw new Error("A conta do Stripe não tem configuração de meios de pagamento");
  const alvo = meios.filter((m) => m.disponivel && !m.ligado && (!tipos || tipos.includes(m.tipo)));
  if (!alvo.length) return { ligados: [], ...(await meiosDePagamento()) };
  await chamar(`/payment_method_configurations/${encodeURIComponent(id)}`, { metodo: "POST",
    campos: Object.fromEntries(alvo.map((m) => [`${m.tipo}[display_preference][preference]`, "on"])) });
  return { ligados: alvo.map((m) => m.tipo), ...(await meiosDePagamento()) };
}

/** Registra o domínio do checkout (fluxdeck.com.br) no Stripe, para Apple Pay, Google Pay e Link aparecerem nele. */
export async function registrarDominio(dominio) {
  const existentes = (await chamar("/payment_method_domains?limit=100")).data ?? [];
  const ja = existentes.find((d) => d.domain_name === dominio);
  const d = ja ?? (await chamar("/payment_method_domains", { metodo: "POST", campos: { domain_name: dominio } }));
  return { dominio: d.domain_name, applePay: d.apple_pay?.status ?? null, googlePay: d.google_pay?.status ?? null, link: d.link?.status ?? null, id: d.id };
}

const chaveDoCheckout = (codigo) => `checkout_x:${codigo}`;

/** Cria (ou reaproveita) o checkout transparente desta empresa e deste valor. Retorna o endereço da página. */
export async function checkoutTransparente({ lead, nome, valor, moeda, unico = true }) {
  const { origemDaPrevia } = await import("./previa.js");
  const { carregarCampanhaCompleta } = await import("../campanha.js");
  const guarda = `checkout_x_lead:${lead.id}:${simples(nome)}:${valor}${moeda}`;
  let codigo = await db.lerEstado(guarda);
  if (!codigo) {
    codigo = crypto.randomBytes(12).toString("base64url");
    await db.gravarEstado(chaveDoCheckout(codigo), JSON.stringify({ leadId: lead.id, nome, valor, moeda, unico }));
    await db.gravarEstado(guarda, codigo);
  }
  return `${origemDaPrevia(await carregarCampanhaCompleta())}/checkout/x/${codigo}`;
}

/** O que o checkout cobra (sem nada do Stripe). Código que não existe: null. */
export async function compraDoCheckout(codigo) {
  if (!/^[A-Za-z0-9_-]{12,40}$/.test(String(codigo ?? ""))) return null;
  const salvo = await db.lerEstado(chaveDoCheckout(codigo));
  if (!salvo) return null;
  const compra = JSON.parse(salvo);
  const lead = await db.buscarLead(compra.leadId);
  return lead ? { ...compra, codigo, plano: compra.nome, empresa: lead.nome, pais: lead.pais, lead } : null;
}

/** A intenção de pagamento do checkout (cria uma vez; reaproveita enquanto não foi paga). Retorna o client secret. */
export async function intencaoDoCheckout(codigo) {
  const compra = await compraDoCheckout(codigo);
  if (!compra) throw new Error("Checkout não encontrado");
  const salvo = await db.lerEstado(`checkout_x_pi:${codigo}`);
  if (salvo) {
    const pi = await chamar(`/payment_intents/${encodeURIComponent(salvo)}`);
    if (pi.status === "succeeded") throw new Error(compra.pais === "PT" ? "Este pagamento já foi feito." : "This payment was already made.");
    // Intenção antiga sem o Link (criada antes de ele entrar): cancela e cria outra, com o Link.
    const semLink = pi.status === "requires_payment_method" && !(pi.payment_method_types ?? []).includes("link");
    if (semLink) await chamar(`/payment_intents/${encodeURIComponent(pi.id)}/cancel`, { metodo: "POST", campos: {} }).catch(() => null);
    else if (pi.status !== "canceled") return { clientSecret: pi.client_secret };
  }
  const base = {
    amount: String(Math.round(compra.valor * 100)), currency: compra.moeda.toLowerCase(),
    description: `FluxDeck · ${compra.nome} · ${compra.empresa}`.slice(0, 300),
    "metadata[lead_id]": String(compra.leadId), "metadata[plano]": compra.nome, "metadata[checkout]": codigo,
  };
  // Cartão (com Apple Pay e Google Pay) e Link, sempre. Se a conta não aceitar o Link, ficam os meios automáticos da conta.
  const pi = await chamar("/payment_intents", { metodo: "POST", campos: { ...base, "payment_method_types[0]": "card", "payment_method_types[1]": "link" } })
    .catch(() => chamar("/payment_intents", { metodo: "POST", campos: { ...base, "automatic_payment_methods[enabled]": "true" } }));
  await db.gravarEstado(`checkout_x_pi:${codigo}`, pi.id);
  return { clientSecret: pi.client_secret };
}

/** Confere no Stripe se o pagamento do checkout entrou e, se entrou, registra (fecha a empresa e avisa você). */
export async function confirmarCheckout(codigo, idDaIntencao = null) {
  const compra = await compraDoCheckout(codigo);
  if (!compra) return { compra: null, pago: false };
  const id = idDaIntencao || (await db.lerEstado(`checkout_x_pi:${codigo}`));
  if (!id) return { compra, pago: false };
  const pi = await chamar(`/payment_intents/${encodeURIComponent(id)}`);
  if (pi.metadata?.checkout !== codigo) return { compra, pago: false };
  if (pi.status !== "succeeded") return { compra, pago: false };
  await registrarPagamentoDoCheckout(compra, pi);
  return { compra, pago: true };
}

async function registrarPagamentoDoCheckout(compra, pi) {
  if (await db.lerEstado(`stripe_pago:${pi.id}`)) return null;
  await db.gravarEstado(`stripe_pago:${pi.id}`, new Date().toISOString());
  const { lead, nome, valor, moeda, unico } = compra;
  const preco = new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(valor);
  const email = pi.receipt_email ? ` (${pi.receipt_email})` : "";
  const resumo = `Pagou pelo checkout da FluxDeck (Stripe): ${nome}, ${preco}${unico ? " (pagamento único)" : ""}${email}`;
  await db.atualizarLead(lead.id, { status: "fechado", observacao: resumo });
  await db.cancelarPendentes(lead.id, "a empresa pagou pelo checkout");
  const { pausarIA } = await import("../respostas/processar.js");
  await pausarIA(lead.id, `${resumo}: a conversa agora é com você (próximos passos do projeto)`);
  const { enviarNotificacao } = await import("../envio/email.js");
  await enviarNotificacao(`${lead.nome} pagou: ${nome} (${preco})`,
    `${lead.nome}${lead.cidade ? `, de ${lead.cidade}` : ""}, pagou ${nome} (${preco}) pelo checkout da FluxDeck, pelo Stripe${email}.\n\nA empresa foi marcada como fechada, as mensagens de venda foram canceladas e a IA parou de responder: mande os próximos passos.`).catch(() => {});
  return { leadId: lead.id };
}
const enderecoDoWebhook = (base) => `${String(base).replace(/\/$/, "")}/webhooks/stripe`;

/**
 * Cadastra no Stripe o aviso de pagamento (webhook) para o endereço do sistema e guarda o segredo dele
 * criptografado. Se já existe um para o mesmo endereço e o segredo está guardado, não faz nada.
 */
export async function configurarWebhook(base) {
  const url = enderecoDoWebhook(base);
  const c = (await db.lerConfig(CONFIG)) ?? {};
  const existentes = (await chamar("/webhook_endpoints?limit=100")).data ?? [];
  const nosso = existentes.find((w) => w.url === url);
  if (nosso && c.webhookSegredo && decifrar(c.webhookSegredo) && c.webhookId === nosso.id) {
    if (nosso.status !== "enabled") await chamar(`/webhook_endpoints/${nosso.id}`, { metodo: "POST", campos: { disabled: "false" } });
    // O pagamento pelo checkout transparente também avisa (aviso criado antes dele só tinha o da página do Stripe).
    if (!(nosso.enabled_events ?? []).includes(EVENTO_INTENCAO)) {
      await chamar(`/webhook_endpoints/${nosso.id}`, { metodo: "POST", campos: { "enabled_events[0]": EVENTO_PAGO, "enabled_events[1]": EVENTO_INTENCAO } });
    }
    return { configurado: true, novo: false };
  }
  // Sem o segredo guardado não dá para conferir a assinatura: troca por um novo.
  if (nosso) await chamar(`/webhook_endpoints/${nosso.id}`, { metodo: "DELETE" });
  const novo = await chamar("/webhook_endpoints", { metodo: "POST", campos: {
    url, "enabled_events[0]": EVENTO_PAGO, "enabled_events[1]": EVENTO_INTENCAO, description: "Prospecta IA: pagamento das empresas de fora do Brasil",
  } });
  await db.gravarConfig(CONFIG, { ...c, webhookId: novo.id, webhookSegredo: cifrar(novo.secret) });
  return { configurado: true, novo: true };
}

/** A assinatura do aviso (cabeçalho Stripe-Signature: t=...,v1=...) confere com o segredo guardado? */
export async function assinaturaValida(corpoBruto, cabecalho, agora = Date.now()) {
  const c = await db.lerConfig(CONFIG);
  const segredo = c?.webhookSegredo ? decifrar(c.webhookSegredo) : null;
  if (!segredo || !corpoBruto || !cabecalho) return false;
  const pares = String(cabecalho).split(",").map((p) => p.trim().split("="));
  const t = pares.find(([k]) => k === "t")?.[1];
  const v1 = pares.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !v1.length || Math.abs(agora / 1000 - Number(t)) > 300) return false;
  const esperado = crypto.createHmac("sha256", segredo).update(`${t}.${Buffer.from(corpoBruto).toString("utf8")}`).digest("hex");
  return v1.some((v) => v.length === esperado.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(esperado)));
}

/**
 * Pagamento confirmado: a empresa vira "fechado", as mensagens de venda que ainda iam sair são canceladas, a IA
 * para de responder (a conversa fica com você) e chega o aviso por e-mail. Repetir o mesmo pagamento não duplica.
 */
export async function registrarPagamento(sessao) {
  if (!sessao?.id || sessao.status !== "complete" || !sessao.payment_link) return null;
  if (await db.lerEstado(`stripe_pago:${sessao.id}`)) return null;
  const salvo = await db.lerEstado(`stripe_link_lead:${sessao.payment_link}`);
  if (!salvo) return registrarPagamentoDoPlano(sessao);
  const { leadId, nome, valor, moeda, unico = false } = JSON.parse(salvo);
  const lead = await db.buscarLead(leadId);
  if (!lead) return null;
  await db.gravarEstado(`stripe_pago:${sessao.id}`, new Date().toISOString());
  const preco = new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(valor);
  const quem = sessao.customer_details?.email ? ` (${sessao.customer_details.email})` : "";
  const resumo = `Pagou pelo Stripe: ${nome}, ${preco}${unico ? " (pagamento único)" : " por mês"}${quem}`;
  await db.atualizarLead(lead.id, { status: "fechado", observacao: resumo });
  await db.cancelarPendentes(lead.id, "a empresa pagou pelo Stripe");
  const { pausarIA } = await import("../respostas/processar.js");
  await pausarIA(lead.id, `${resumo}: a conversa agora é com você (próximos passos do projeto)`);
  const { enviarNotificacao } = await import("../envio/email.js");
  await enviarNotificacao(`${lead.nome} pagou: ${nome} (${preco}${unico ? "" : "/mês"})`,
    `${lead.nome}${lead.cidade ? `, de ${lead.cidade}` : ""}, pagou ${unico ? `${nome} (${preco}, pagamento único)` : `o primeiro mês do plano ${nome} (${preco} por mês)`} pelo Stripe${quem}.\n\nA empresa foi marcada como fechada no painel, as mensagens de venda foram canceladas e a IA parou de responder: mande os próximos passos.`).catch(() => {});
  return { leadId: lead.id, empresa: lead.nome, plano: nome, valor, moeda };
}

/**
 * Pagamento pelo checkout fixo de um plano (sem empresa no link): acha a empresa pelo e-mail ou telefone de quem
 * pagou e fecha como no link próprio; sem empresa no sistema, só avisa você com os dados de quem assinou.
 */
async function registrarPagamentoDoPlano(sessao) {
  const doPlano = await db.lerEstado(`stripe_link_plano:${sessao.payment_link}`);
  if (!doPlano) return null;
  const { plano, valor, moeda } = JSON.parse(doPlano);
  await db.gravarEstado(`stripe_pago:${sessao.id}`, new Date().toISOString());
  const c = sessao.customer_details ?? {};
  const telefone = String(c.phone ?? "").replace(/\D/g, "");
  const lead = await db.leadPorContato({ whatsapps: telefone ? [telefone, telefone.replace(/^55(\d{2})9(\d{8})$/, "55$1$2")] : [], email: c.email ?? null });
  const preco = new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(valor);
  const quem = [c.name, c.email, c.phone].filter(Boolean).join(" · ");
  const resumo = `Pagou pelo Stripe: ${plano}, ${preco} por mês${quem ? ` (${quem})` : ""}`;
  const { enviarNotificacao } = await import("../envio/email.js");
  if (!lead) {
    await enviarNotificacao(`Nova assinatura: ${plano} (${preco}/mês)`,
      `Alguém assinou o plano ${plano} (${preco} por mês) pelo checkout do Stripe: ${quem || "sem dados de contato"}.\n\nNão achei essa empresa no sistema pelo e-mail ou telefone: fale com ela e mande os próximos passos.`).catch(() => {});
    return { leadId: null, plano, valor, moeda, contato: quem };
  }
  await db.atualizarLead(lead.id, { status: "fechado", observacao: resumo });
  await db.cancelarPendentes(lead.id, "a empresa pagou pelo Stripe");
  const { pausarIA } = await import("../respostas/processar.js");
  await pausarIA(lead.id, `${resumo}: a conversa agora é com você (próximos passos do projeto)`);
  await enviarNotificacao(`${lead.nome} pagou: ${plano} (${preco}/mês)`,
    `${lead.nome} assinou o plano ${plano} (${preco} por mês) pelo checkout do Stripe${quem ? ` (${quem})` : ""}.\n\nA empresa foi marcada como fechada, as mensagens de venda foram canceladas e a IA parou de responder: mande os próximos passos.`).catch(() => {});
  return { leadId: lead.id, empresa: lead.nome, plano, valor, moeda };
}

/** O aviso do Stripe (webhook): só aceita com a assinatura certa. */
export async function processarAviso(corpoBruto, cabecalho) {
  if (!(await assinaturaValida(corpoBruto, cabecalho))) return { aceito: false };
  const evento = JSON.parse(Buffer.from(corpoBruto).toString("utf8"));
  if (evento.type === EVENTO_INTENCAO) {
    const pi = evento.data?.object;
    return { aceito: true, pagamento: pi?.metadata?.checkout ? (await confirmarCheckout(pi.metadata.checkout, pi.id)).pago : null };
  }
  if (evento.type !== EVENTO_PAGO) return { aceito: true };
  return { aceito: true, pagamento: await registrarPagamento(evento.data?.object) };
}

/** Conferência de cada hora (reserva do aviso): os pagamentos dos últimos dias pelos links do sistema. */
export async function conferirPagamentos(agora = new Date()) {
  if (!(await situacao()).conectado) return { conferidos: 0 };
  const desde = Math.floor(+agora / 1000) - 3 * 86_400;
  const sessoes = (await chamar(`/checkout/sessions?status=complete&limit=100&created[gte]=${desde}`)).data ?? [];
  const novos = [];
  for (const s of sessoes) {
    const r = await registrarPagamento(s);
    if (r) novos.push(r);
  }
  return { conferidos: sessoes.length, novos };
}

/**
 * O botão "Link de pagamento" da conversa, para empresa de fora do Brasil: a oferta (cadastrada em reais) vira a
 * mensalidade na moeda dela (euro ou dólar), pela cotação do dia com o ajuste de fora, num link do Stripe. Nunca
 * PIX, boleto nem reais. A mensagem sai no idioma dela (português de Portugal ou inglês).
 */
export async function linkDoStripeParaOferta(lead, oferta) {
  const pais = PAISES[lead?.pais];
  if (!pais || lead.pais === "BR") return { erro: "Esta empresa é do Brasil: o link é do Asaas" };
  if (!oferta) return { erro: "Oferta não encontrada" };
  if (!oferta.mensal || oferta.diagnostico) return { erro: "Para empresa de fora, só ofertas mensais: a assinatura no cartão, em euro ou dólar, pelo Stripe" };
  if (!(await situacao()).conectado) return { erro: "Conecte o Stripe em Configurações para cobrar empresas de fora (euro e dólar)" };
  const [cot, conf] = await Promise.all([cotacoes(), configInternacional()]);
  const valor = arredondarPreco(Number(oferta.valor) * cot[pais.moeda] * (1 + conf.ajustePct / 100));
  const url = await linkDePagamento({ lead, nome: oferta.nome, valor, moeda: pais.moeda });
  const preco = new Intl.NumberFormat(lead.pais === "PT" ? "pt-PT" : "en-US", { style: "currency", currency: pais.moeda, maximumFractionDigits: 0 }).format(valor);
  const mensagem = lead.pais === "PT"
    ? `Segue o link para subscrever ${oferta.nome} (${preco} por mês), com cartão: ${url}`
    : `Here is the link to subscribe to ${oferta.nome} (${preco} per month), by card: ${url}`;
  return { venda: { oferta: oferta.nome, valor, moeda: pais.moeda, link: url, mensal: true }, mensagem };
}

/**
 * Troca o marcador {{pagamento:Plano|valor}} da resposta da IA pelo link de pagamento. Sem Stripe, sem plano
 * reconhecido ou com erro, tira o marcador e a conversa passa para você (`precisa_humano`).
 */
export async function aplicarLinkDePagamento(c, lead, { apresentacao } = {}) {
  const textos = [c?.sugestao_resposta, ...(c?.partes ?? [])].filter(Boolean);
  if (!textos.some((t) => MARCADOR_PAGAMENTO.test(t))) return c;
  let url = null;
  let motivo = null;
  try {
    const m = textos.map((t) => t.match(MARCADOR_PAGAMENTO)).find(Boolean);
    const plano = await valorDoPlano({ plano: m[1], valor: m[2], lead, apresentacao });
    if (!plano) motivo = `a IA quis mandar o pagamento de "${m[1]}", plano que não está na apresentação`;
    else if (!(await situacao()).conectado) motivo = "a empresa quer pagar, mas o Stripe não está conectado em Configurações";
    else url = await linkDePagamento({ lead, ...plano });
  } catch (e) {
    motivo = `não deu para criar o link de pagamento: ${e.message}`;
  }
  const trocar = (t) => String(t).replace(new RegExp(MARCADOR_PAGAMENTO.source, "gi"), url ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const novo = { ...c, sugestao_resposta: c.sugestao_resposta ? trocar(c.sugestao_resposta) : c.sugestao_resposta };
  if (c.partes) novo.partes = c.partes.map(trocar).filter((p) => p.trim());
  if (url) novo.linkDePagamento = url;
  if (motivo) Object.assign(novo, { precisa_humano: true, motivo_humano: motivo });
  return novo;
}

/**
 * Teste da conexão sem cobrar ninguém: a conta pode cobrar? E cria um link de exemplo (Professional, em dólar)
 * para conferir a página de pagamento. Com `desativar`, desliga o link de exemplo (ninguém consegue pagar).
 */
export async function testar({ desativar = null } = {}) {
  if (desativar) {
    await chamar(`/payment_links/${encodeURIComponent(desativar)}`, { metodo: "POST", campos: { active: "false" } });
    return { desativado: desativar };
  }
  const conta = await chamar("/account");
  const plano = await valorDoPlano({ plano: "Professional", lead: { pais: "US" } });
  const preco = await chamar("/prices", { metodo: "POST", campos: {
    currency: "usd", unit_amount: String(Math.round(plano.valor * 100)), "recurring[interval]": "month", "product_data[name]": "FluxDeck · Professional (exemplo)",
  } });
  const link = await chamar("/payment_links", { metodo: "POST", campos: { "line_items[0][price]": preco.id, "line_items[0][quantity]": "1", "metadata[teste]": "sim" } });
  return { podeCobrar: conta.charges_enabled !== false, podeReceber: conta.payouts_enabled !== false, pendencias: conta.requirements?.currently_due ?? [], plano, link: link.url, id: link.id };
}
