import crypto from "node:crypto";
import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";
import { PAISES, arredondarPreco, configInternacional, cotacoes } from "../internacional.js";
import { lerApresentacao } from "../respostas/apresentacao.js";

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

/** Os planos da apresentação com o valor por mês em reais ("Professional (R$ 2.500/mês, ...)"). */
export function planosDaApresentacao(texto) {
  const planos = [];
  for (const linha of String(texto ?? "").split("\n")) {
    const m = linha.match(/^\s*-\s*([^(:]+?)\s*\(R\$\s?([\d.]+(?:,\d{1,2})?)\s*\/\s*m[eê]s/i);
    if (m) planos.push({ nome: m[1].trim(), reais: Number(m[2].replace(/\./g, "").replace(",", ".")) });
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
  const planos = planosDaApresentacao(apresentacao ?? (await lerApresentacao())).map((p) => ({ ...p, local: local(p.reais) }));
  const pedido = Number(String(valor ?? "").replace(/[^\d.,]/g, "").replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
  const nome = simples(plano);
  const doNome = planos.filter((p) => simples(p.nome) === nome || simples(p.nome).includes(nome) || nome.includes(simples(p.nome)));
  const certo = (pedido && (doNome.find((p) => p.local === pedido) ?? planos.find((p) => p.local === pedido)))
    // Pelo nome: o nome exato primeiro; no mesmo plano, o preço da promoção vale.
    || doNome.sort((a, b) => Number(simples(b.nome) === nome) - Number(simples(a.nome) === nome)
      || Number(Boolean(b.promocao)) - Number(Boolean(a.promocao)) || a.nome.length - b.nome.length)[0];
  return certo ? { nome: certo.nome, valor: certo.local, moeda: pais.moeda } : null;
}

/** O link de pagamento (mensalidade no cartão) para a empresa e o plano. Reaproveita o que já foi criado. */
export async function linkDePagamento({ lead, nome, valor, moeda }) {
  const guarda = `stripe_link:${lead.id}:${simples(nome)}:${valor}${moeda}`;
  const salvo = await db.lerEstado(guarda);
  if (salvo) return salvo;
  const preco = await chamar("/prices", { metodo: "POST", campos: {
    currency: moeda.toLowerCase(), unit_amount: String(Math.round(valor * 100)), "recurring[interval]": "month",
    "product_data[name]": `FluxDeck · ${nome}`, "metadata[lead_id]": String(lead.id),
  } });
  const link = await chamar("/payment_links", { metodo: "POST", campos: {
    "line_items[0][price]": preco.id, "line_items[0][quantity]": "1",
    "metadata[lead_id]": String(lead.id), "metadata[empresa]": String(lead.nome ?? "").slice(0, 200), "metadata[plano]": nome,
    "subscription_data[metadata][lead_id]": String(lead.id), "billing_address_collection": "auto",
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
  if (!salvo) return null;
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
