import * as db from "../db.js";
import * as asaas from "../contratos/asaas.js";
import { lerApresentacao } from "../respostas/apresentacao.js";
import { planosDaApresentacao } from "./stripe.js";
import { cifrar, decifrar } from "../segredos.js";

// Checkouts fixos dos planos do Brasil pelo Asaas (taxas menores que o Stripe para vendas nacionais), usados no
// site e nos slides de fechamento. Plano mensal: o link cobra a implantação + a 1ª mensalidade (Pix, boleto ou
// cartão) e, quando o pagamento cai, o sistema cria no Asaas a assinatura da mensalidade a partir do mês seguinte.
// Plano anual: o valor do ano em até 12x no cartão (ou à vista). Quem paga é ligado à empresa da conversa pelo
// e-mail ou telefone do cadastro no Asaas; sem empresa no sistema, você recebe o aviso por e-mail.
const CHAVE = "asaas_planos";
const DIAS_PARA_PAGAR = 3;
const DIAS_DA_CONFERENCIA = 3;

export const checkoutsAsaas = async () => (await db.lerConfig(CHAVE))?.links ?? [];

const reais = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
const centavos = (v) => Math.round(v * 100) / 100;
const simples = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** "WhatsApp com IA" → "whatsapp-com-ia": o endereço do checkout da FluxDeck (/checkout/<slug>) de cada plano. */
export const slugDoPlano = (nome) => simples(nome).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const enderecoDoCheckout = (nome) => `/checkout/${slugDoPlano(nome)}`;
export const planoDoCheckout = async (slug) => (await checkoutsAsaas()).find((l) => slugDoPlano(l.plano) === String(slug ?? "")) ?? null;
// O pagamento é de um plano pelo link do Asaas (paymentLink) ou pelo checkout da FluxDeck (referência "checkout:<id do link>").
const linkDoPagamento = (links, p) => links.find((l) => (p.paymentLink && l.id === p.paymentLink) || p.externalReference === `checkout:${l.id}`) ?? null;

/** O que cada link cobra, a partir de um plano da apresentação do Brasil. */
export function cobrancaDoPlano(p) {
  if (p.intervalo === "year") {
    return {
      anual: true, primeiro: p.reais, mensal: null,
      dados: {
        name: `${p.nome} (12 meses)`, value: p.reais, billingType: "UNDEFINED", chargeType: "INSTALLMENT", maxInstallmentCount: 12,
        description: `${p.nome}: 12 meses, ${reais(p.reais)} à vista ou em até 12x no cartão. Implantação inclusa.`, dueDateLimitDays: DIAS_PARA_PAGAR,
      },
    };
  }
  const primeiro = centavos((p.implantacao ?? 0) + p.reais);
  return {
    anual: false, primeiro, mensal: p.reais,
    dados: {
      name: `${p.nome} · ${p.implantacao ? "implantação + 1º mês" : "1º mês"}`, value: primeiro, billingType: "UNDEFINED", chargeType: "DETACHED",
      description: `${p.implantacao ? `Implantação ${reais(p.implantacao)} + ` : ""}1ª mensalidade ${reais(p.reais)}. Depois, ${reais(p.reais)} por mês, sem fidelidade.`,
      dueDateLimitDays: DIAS_PARA_PAGAR,
    },
  };
}

/**
 * Cria no Asaas um checkout para cada plano do Brasil (o da apresentação daqui). Rodar de novo reaproveita o que
 * não mudou; plano com valor novo ganha link novo e o antigo é desativado.
 */
export async function criarCheckoutsAsaas() {
  if (!(await asaas.situacao()).conectado) throw new Error("Conecte o Asaas em Contratos → Cobranças primeiro");
  const antigos = await checkoutsAsaas();
  const novos = [];
  const vistos = new Set();
  for (const p of planosDaApresentacao(await lerApresentacao())) {
    if (p.promocao || vistos.has(simples(p.nome)) || /diagn[oó]stico/i.test(p.nome)) continue;
    vistos.add(simples(p.nome));
    const c = cobrancaDoPlano(p);
    const chave = `${simples(p.nome)}|${c.primeiro}|${c.mensal ?? ""}|${c.anual ? "ano" : "mes"}`;
    const igual = antigos.find((a) => a.chave === chave);
    if (igual) { novos.push(igual); continue; }
    const link = await asaas.criarLink(c.dados);
    if (!/^https:\/\//.test(link?.url ?? "")) throw new Error(`O Asaas não devolveu o link do plano ${p.nome}`);
    novos.push({ chave, plano: p.nome, primeiro: c.primeiro, mensal: c.mensal, implantacao: p.implantacao ?? null, anual: c.anual, url: link.url, id: link.id });
  }
  for (const a of antigos) {
    if (!novos.some((n) => n.id === a.id)) await asaas.desativarLink(a.id).catch(() => {});
  }
  await db.gravarConfig(CHAVE, { links: novos, atualizadoEm: new Date().toISOString() });
  return novos;
}

const dataMais = (agora, dias) => new Date(+agora + dias * 86_400_000).toISOString().slice(0, 10);

/**
 * Um pagamento por um checkout de plano: marca a empresa da conversa como fechada, cria a assinatura da
 * mensalidade (plano mensal) e avisa você. Cada pagamento (ou cada parcelamento do anual) conta uma vez só.
 */
async function registrarPagamentoDoPlano(link, pagamento, agora, { avisar } = {}) {
  const marca = `asaas_plano_pago:${pagamento.installment ?? pagamento.id}`;
  if (await db.lerEstado(marca)) return null;
  await db.gravarEstado(marca, new Date().toISOString());
  const cliente = pagamento.customer ? await asaas.lerCliente(pagamento.customer).catch(() => null) : null;
  let assinatura = null;
  if (!link.anual && link.mensal && pagamento.customer) {
    const base = {
      customer: pagamento.customer, value: link.mensal, cycle: "MONTHLY",
      nextDueDate: dataMais(agora, 30), description: `${link.plano} · mensalidade (sem fidelidade)`, externalReference: `plano:${link.id}`,
    };
    // Pagou no cartão pelo checkout da FluxDeck: a mensalidade cai sozinha no mesmo cartão (o token do Asaas).
    const cartao = await cartaoDoPagamento(pagamento.id);
    if (cartao) assinatura = await asaas.criarAssinatura({ ...base, billingType: "CREDIT_CARD", creditCardToken: cartao.token, remoteIp: cartao.ip }).catch(() => null);
    if (!assinatura?.id) assinatura = await asaas.criarAssinatura({ ...base, billingType: "UNDEFINED" }).catch((e) => ({ erro: e.message }));
    if (cartao) await db.gravarEstado(`checkout_cartao:${pagamento.id}`, "");
  }
  const telefone = String(cliente?.mobilePhone ?? cliente?.phone ?? "").replace(/\D/g, "");
  const numeros = telefone ? [telefone, `55${telefone}`, `55${telefone}`.replace(/^55(\d{2})9(\d{8})$/, "55$1$2")] : [];
  const lead = await db.leadPorContato({ whatsapps: numeros, email: cliente?.email ?? null });
  const quem = [cliente?.name, cliente?.email, cliente?.mobilePhone ?? cliente?.phone].filter(Boolean).join(" · ");
  const resumo = `Pagou pelo Asaas: ${link.plano} (${reais(pagamento.value ?? link.primeiro)})${quem ? ` · ${quem}` : ""}`;
  const sobreAssinatura = link.anual ? "Plano anual: não tem mensalidade."
    : assinatura?.billingType === "CREDIT_CARD" ? `A assinatura da mensalidade (${reais(link.mensal)} por mês) foi criada no Asaas, no mesmo cartão, com a 1ª cobrança em 30 dias.`
    : assinatura?.erro ? `ATENÇÃO: não consegui criar a assinatura da mensalidade (${assinatura.erro}). Crie no Asaas: ${reais(link.mensal)} por mês.`
      : `A assinatura da mensalidade (${reais(link.mensal)} por mês) foi criada no Asaas, com a 1ª cobrança em 30 dias.`;
  if (lead) {
    await db.atualizarLead(lead.id, { status: "fechado", observacao: resumo });
    await db.cancelarPendentes(lead.id, "a empresa pagou pelo Asaas");
    const { pausarIA } = await import("../respostas/processar.js");
    await pausarIA(lead.id, `${resumo}: a conversa agora é com você (próximos passos do projeto)`);
  }
  await avisar(lead ? `${lead.nome} pagou: ${link.plano}` : `Nova venda pelo site: ${link.plano}`,
    `${lead ? `${lead.nome} pagou` : "Alguém pagou"} o checkout do plano ${link.plano} pelo Asaas (${reais(pagamento.value ?? link.primeiro)})${quem ? `: ${quem}` : ""}.\n\n${sobreAssinatura}\n\n${lead ? "A empresa foi marcada como fechada e a IA parou de responder: mande os próximos passos." : "Não achei essa empresa no sistema pelo e-mail ou telefone: fale com ela e mande os próximos passos."}`).catch(() => {});
  return { plano: link.plano, leadId: lead?.id ?? null, assinatura: assinatura?.id ?? null };
}

/** O aviso do Asaas (webhook) de um pagamento por checkout de plano. */
export async function processarAvisoDoPlano(corpo, agora = new Date(), opcoes = {}) {
  const p = corpo?.payment;
  if (!p?.id || !(p.paymentLink || String(p.externalReference ?? "").startsWith("checkout:"))) return null;
  const link = linkDoPagamento(await checkoutsAsaas(), p);
  if (!link || asaas.SITUACOES[p.status] !== "paga") return null;
  const { enviarNotificacao } = await import("../envio/email.js");
  return registrarPagamentoDoPlano(link, p, agora, { avisar: enviarNotificacao, ...opcoes });
}

/** A conferência de cada hora (reserva do aviso): os pagamentos dos últimos dias pelos checkouts dos planos. */
export async function conferirCheckoutsAsaas(agora = new Date(), opcoes = {}) {
  const links = await checkoutsAsaas();
  if (!links.length || !(await asaas.situacao()).conectado) return { planos: 0 };
  const { enviarNotificacao } = await import("../envio/email.js");
  const novos = [];
  for (let pagina = 0; pagina < 5; pagina += 1) {
    const r = await asaas.pagamentosDesde(dataMais(agora, -DIAS_DA_CONFERENCIA), pagina * 100);
    for (const p of r?.data ?? []) {
      const link = linkDoPagamento(links, p);
      if (link && asaas.SITUACOES[p.status] === "paga") {
        const feito = await registrarPagamentoDoPlano(link, p, agora, { avisar: enviarNotificacao, ...opcoes });
        if (feito) novos.push(feito);
      }
    }
    if (!r?.hasMore) break;
  }
  return { planos: novos.length };
}

// ---------- Checkout da FluxDeck (transparente): a página é nossa, o pagamento é processado pelo Asaas ----------

/** Erro que a página do checkout pode mostrar para quem está pagando. */
export class ErroDoCheckout extends Error {}

const digitos = (t) => String(t ?? "").replace(/\D/g, "");

/** CPF ou CNPJ com os dígitos verificadores certos. */
export function documentoValido(t) {
  const d = digitos(t);
  if (d.length === 11) {
    if (/^(\d)\1+$/.test(d)) return false;
    const dv = (n) => { let s = 0; for (let i = 0; i < n; i += 1) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }
  if (d.length === 14) {
    if (/^(\d)\1+$/.test(d)) return false;
    const dv = (n) => { const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = pesos.reduce((a, p, i) => a + Number(d[i]) * p, 0); const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
  }
  return false;
}

/** Número de cartão que passa no dígito verificador (Luhn). */
export function cartaoValido(t) {
  const d = digitos(t);
  if (d.length < 13 || d.length > 19) return false;
  let soma = 0;
  for (let i = 0; i < d.length; i += 1) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    soma += n;
  }
  return soma % 10 === 0;
}

const hojeNoBrasil = (agora) => new Date(+agora - 3 * 3_600_000).toISOString().slice(0, 10);
const MAX_POR_IP = 8; // tentativas por hora de cada endereço
const MAX_CARTOES = 40; // tentativas no cartão por hora, somando todos (freia teste de cartões roubados)

async function freio(ip, cartao, agora) {
  const hora = new Date(agora).toISOString().slice(0, 13);
  const limites = [[`checkout_ip:${ip}:${hora}`, MAX_POR_IP], ...(cartao ? [[`checkout_cartoes:${hora}`, MAX_CARTOES]] : [])];
  for (const [chave, max] of limites) {
    const n = Number((await db.lerEstado(chave)) ?? 0);
    if (n >= max) throw new ErroDoCheckout("Muitas tentativas agora. Espere alguns minutos ou fale com a gente pelo WhatsApp.");
    await db.gravarEstado(chave, String(n + 1));
  }
}

async function cartaoDoPagamento(id) {
  const guardado = await db.lerEstado(`checkout_cartao:${id}`);
  if (!guardado) return null;
  try { return JSON.parse(decifrar(guardado) ?? "null"); } catch { return null; }
}

/** O que a página mostra do plano (nada de ids do Asaas). */
export const resumoDoPlano = (link) => ({
  plano: link.plano, slug: slugDoPlano(link.plano), anual: Boolean(link.anual),
  hoje: link.primeiro, mensal: link.mensal ?? null, implantacao: link.implantacao ?? null,
});

/**
 * Cria a cobrança de um plano pelo checkout da FluxDeck: Pix (devolve o QR Code), boleto (o link e a linha) ou
 * cartão (aprovado na hora; o anual em até 12x). Os dados do cartão vão direto para o Asaas e não são guardados.
 */
export async function pagarCheckout(slug, corpo, { ip = "", agora = new Date() } = {}) {
  const link = await planoDoCheckout(slug);
  if (!link) throw new ErroDoCheckout("Plano não encontrado. Fale com a gente pelo WhatsApp.");
  if (corpo?.site) throw new ErroDoCheckout("Não foi possível concluir."); // campo escondido: só robô preenche
  const forma = { pix: "PIX", boleto: "BOLETO", cartao: "CREDIT_CARD" }[corpo?.forma];
  if (!forma) throw new ErroDoCheckout("Escolha como quer pagar.");
  const nome = String(corpo?.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
  const email = String(corpo?.email ?? "").trim().toLowerCase().slice(0, 120);
  const documento = digitos(corpo?.documento);
  const celular = digitos(corpo?.celular).replace(/^55(?=\d{10,11}$)/, "");
  if (nome.split(" ").length < 2) throw new ErroDoCheckout("Informe o nome completo.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroDoCheckout("Confira o e-mail.");
  if (!documentoValido(documento)) throw new ErroDoCheckout("Confira o CPF ou CNPJ.");
  if (celular.length < 10 || celular.length > 11) throw new ErroDoCheckout("Confira o WhatsApp com DDD.");
  const c = corpo?.cartao ?? {};
  let mes; let ano; const parcelas = link.anual && forma === "CREDIT_CARD" ? Math.min(12, Math.max(1, Math.floor(Number(corpo?.parcelas) || 1))) : 1;
  if (forma === "CREDIT_CARD") {
    [mes, ano] = String(c.validade ?? "").split("/").map((x) => digitos(x));
    if (ano?.length === 2) ano = `20${ano}`;
    if (!cartaoValido(c.numero)) throw new ErroDoCheckout("Confira o número do cartão.");
    if (!String(c.nome ?? "").trim()) throw new ErroDoCheckout("Informe o nome impresso no cartão.");
    if (!(Number(mes) >= 1 && Number(mes) <= 12) || !/^20\d\d$/.test(ano ?? "")) throw new ErroDoCheckout("Confira a validade do cartão (MM/AA).");
    if (!/^\d{3,4}$/.test(digitos(c.cvv))) throw new ErroDoCheckout("Confira o código de segurança (CVV).");
    if (digitos(c.cep).length !== 8) throw new ErroDoCheckout("Informe o CEP do titular do cartão.");
    if (!String(c.numeroEndereco ?? "").trim()) throw new ErroDoCheckout("Informe o número do endereço do titular.");
  }
  await freio(ip || "sem-ip", forma === "CREDIT_CARD", agora);

  const cliente = (await asaas.clientePorDocumento(documento)) ?? await asaas.criarCliente({ name: nome, cpfCnpj: documento, email, mobilePhone: celular, notificationDisabled: false });
  const dias = forma === "BOLETO" ? 3 : forma === "PIX" ? 1 : 0;
  const dados = {
    customer: cliente.id, billingType: forma, dueDate: dataMais(new Date(`${hojeNoBrasil(agora)}T12:00:00Z`), dias),
    description: link.anual ? `${link.plano}: 12 meses (implantação inclusa)` : `${link.plano}: ${link.implantacao ? "implantação + " : ""}1ª mensalidade. Depois ${reais(link.mensal)} por mês, sem fidelidade.`,
    externalReference: `checkout:${link.id}`,
    ...(parcelas > 1 ? { installmentCount: parcelas, totalValue: link.primeiro } : { value: link.primeiro }),
  };
  if (forma === "CREDIT_CARD") {
    Object.assign(dados, {
      creditCard: { holderName: String(c.nome).trim().slice(0, 100), number: digitos(c.numero), expiryMonth: mes.padStart(2, "0"), expiryYear: ano, ccv: digitos(c.cvv) },
      creditCardHolderInfo: { name: nome, email, cpfCnpj: documento, postalCode: digitos(c.cep), addressNumber: String(c.numeroEndereco).trim().slice(0, 10), mobilePhone: celular },
      remoteIp: ip,
    });
  }
  const pagamento = await asaas.criarCobranca(dados);

  if (forma === "CREDIT_CARD") {
    if (asaas.SITUACOES[pagamento.status] !== "paga") throw new ErroDoCheckout("O cartão não foi aprovado. Confira os dados ou tente outro cartão ou o Pix.");
    const token = pagamento.creditCard?.creditCardToken;
    if (token && !link.anual) await db.gravarEstado(`checkout_cartao:${pagamento.id}`, cifrar(JSON.stringify({ token, ip })));
    const { enviarNotificacao } = await import("../envio/email.js");
    await registrarPagamentoDoPlano(link, pagamento, agora, { avisar: enviarNotificacao }).catch(() => {});
    return { pago: true, id: pagamento.id };
  }
  if (forma === "PIX") {
    const qr = await asaas.qrCodePix(pagamento.id);
    return { id: pagamento.id, pix: { imagem: qr?.encodedImage ?? null, codigo: qr?.payload ?? "", expira: qr?.expirationDate ?? null } };
  }
  const linha = await asaas.linhaDigitavel(pagamento.id).catch(() => null);
  return { id: pagamento.id, boleto: { url: pagamento.bankSlipUrl ?? null, linha: linha?.identificationField ?? "", vence: pagamento.dueDate } };
}

/** Se o pagamento (Pix ou boleto) do checkout já caiu: a página pergunta de tempos em tempos. */
export async function situacaoDoCheckout(slug, id) {
  const link = await planoDoCheckout(slug);
  if (!link || !/^pay_[A-Za-z0-9]+$/.test(String(id ?? ""))) return null;
  const p = await asaas.lerCobranca(id).catch(() => null);
  if (!p || p.externalReference !== `checkout:${link.id}`) return null;
  return { pago: asaas.SITUACOES[p.status] === "paga" };
}
