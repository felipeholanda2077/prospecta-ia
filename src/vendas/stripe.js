import crypto from "node:crypto";
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
    avisoDePagamento: Boolean(c.webhookId && c.webhookSegredo) };
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
    const m = linha.match(/^\s*-\s*([^(:]+?)\s*\(R\$\s?([\d.]+(?:,\d{1,2})?)\s*\/\s*(m[eê]s|ano)/i);
    if (m) {
      const implantacao = linha.match(/implanta[çc][aã]o\s+(?:de\s+)?R\$\s?([\d.]+(?:,\d{1,2})?)/i);
      planos.push({ nome: m[1].trim(), reais: valorEmReais(m[2]), intervalo: /ano/i.test(m[3]) ? "year" : "month",
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
    const checkouts = await checkoutsDosPlanos();
    const planos = planosDaApresentacao(await lerApresentacao()).filter((p) => !p.promocao).map((p) => ({
      nome: p.nome, valor: p.reais, intervalo: p.intervalo, implantacao: p.implantacao ?? null,
      checkout: checkouts.find((c) => c.plano === p.nome && c.moeda === "BRL")?.url ?? null,
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
export async function criarCheckoutsDosPlanos({ moedas = ["BRL", "USD"] } = {}) {
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
      if (p.promocao || vistos.has(simples(p.nome)) || /diagn[oó]stico/i.test(p.nome)) continue;
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
export async function linkDePagamento({ lead, nome, valor, moeda }) {
  const guarda = `stripe_link:${lead.id}:${simples(nome)}:${valor}${moeda}`;
  const salvo = await db.lerEstado(guarda);
  if (salvo) return salvo;
  const preco = await chamar("/prices", { metodo: "POST", campos: {
    currency: moeda.toLowerCase(), unit_amount: String(Math.round(valor * 100)), "recurring[interval]": "month",
    "product_data[name]": `FluxDeck · ${lead.pais === "PT" ? nome : nomeEmIngles(nome)}`, "metadata[lead_id]": String(lead.id),
  } });
  const link = await chamar("/payment_links", { metodo: "POST", campos: {
    "line_items[0][price]": preco.id, "line_items[0][quantity]": "1",
    "metadata[lead_id]": String(lead.id), "metadata[empresa]": String(lead.nome ?? "").slice(0, 200), "metadata[plano]": nome,
    "subscription_data[metadata][lead_id]": String(lead.id), "billing_address_collection": "auto",
    // O contrato de serviço aparece logo acima do botão de pagar.
    "custom_text[submit][message]": lead.pais === "PT"
      ? `Ao subscrever, aceita o contrato de serviço da FluxDeck (Service Agreement): ${CONTRATO_EN}`
      : `By subscribing, you agree to the FluxDeck Service Agreement: ${CONTRATO_EN}`,
  } });
  await db.gravarEstado(guarda, link.url);
  // Para reconhecer o pagamento: o link aponta para a empresa, o plano e o valor.
  await db.gravarEstado(`stripe_link_lead:${link.id}`, JSON.stringify({ leadId: lead.id, nome, valor, moeda }));
  return link.url;
}

// ---------- Pagamento confirmado ----------

const EVENTO_PAGO = "checkout.session.completed";
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
    return { configurado: true, novo: false };
  }
  // Sem o segredo guardado não dá para conferir a assinatura: troca por um novo.
  if (nosso) await chamar(`/webhook_endpoints/${nosso.id}`, { metodo: "DELETE" });
  const novo = await chamar("/webhook_endpoints", { metodo: "POST", campos: {
    url, "enabled_events[0]": EVENTO_PAGO, description: "Prospecta IA: pagamento das empresas de fora do Brasil",
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
  const { leadId, nome, valor, moeda } = JSON.parse(salvo);
  const lead = await db.buscarLead(leadId);
  if (!lead) return null;
  await db.gravarEstado(`stripe_pago:${sessao.id}`, new Date().toISOString());
  const preco = new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(valor);
  const quem = sessao.customer_details?.email ? ` (${sessao.customer_details.email})` : "";
  const resumo = `Pagou pelo Stripe: ${nome}, ${preco} por mês${quem}`;
  await db.atualizarLead(lead.id, { status: "fechado", observacao: resumo });
  await db.cancelarPendentes(lead.id, "a empresa pagou pelo Stripe");
  const { pausarIA } = await import("../respostas/processar.js");
  await pausarIA(lead.id, `${resumo}: a conversa agora é com você (próximos passos do projeto)`);
  const { enviarNotificacao } = await import("../envio/email.js");
  await enviarNotificacao(`${lead.nome} pagou: ${nome} (${preco}/mês)`,
    `${lead.nome}${lead.cidade ? `, de ${lead.cidade}` : ""}, pagou o primeiro mês do plano ${nome} (${preco} por mês) pelo Stripe${quem}.\n\nA empresa foi marcada como fechada no painel, as mensagens de venda foram canceladas e a IA parou de responder: mande os próximos passos.`).catch(() => {});
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
