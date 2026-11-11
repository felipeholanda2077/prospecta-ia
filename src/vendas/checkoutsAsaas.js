import * as db from "../db.js";
import * as asaas from "../contratos/asaas.js";
import { lerApresentacao } from "../respostas/apresentacao.js";
import { planosDaApresentacao } from "./stripe.js";

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
    assinatura = await asaas.criarAssinatura({
      customer: pagamento.customer, billingType: "UNDEFINED", value: link.mensal, cycle: "MONTHLY",
      nextDueDate: dataMais(agora, 30), description: `${link.plano} · mensalidade (sem fidelidade)`, externalReference: `plano:${link.id}`,
    }).catch((e) => ({ erro: e.message }));
  }
  const telefone = String(cliente?.mobilePhone ?? cliente?.phone ?? "").replace(/\D/g, "");
  const numeros = telefone ? [telefone, `55${telefone}`, `55${telefone}`.replace(/^55(\d{2})9(\d{8})$/, "55$1$2")] : [];
  const lead = await db.leadPorContato({ whatsapps: numeros, email: cliente?.email ?? null });
  const quem = [cliente?.name, cliente?.email, cliente?.mobilePhone ?? cliente?.phone].filter(Boolean).join(" · ");
  const resumo = `Pagou pelo Asaas: ${link.plano} (${reais(pagamento.value ?? link.primeiro)})${quem ? ` · ${quem}` : ""}`;
  const sobreAssinatura = link.anual ? "Plano anual: não tem mensalidade."
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
  if (!p?.id || !p.paymentLink) return null;
  const link = (await checkoutsAsaas()).find((l) => l.id === p.paymentLink);
  if (!link || asaas.SITUACOES[p.status] !== "paga") return null;
  const { enviarNotificacao } = await import("../envio/email.js");
  return registrarPagamentoDoPlano(link, p, agora, { avisar: enviarNotificacao, ...opcoes });
}

/** A conferência de cada hora (reserva do aviso): os pagamentos dos últimos dias pelos checkouts dos planos. */
export async function conferirCheckoutsAsaas(agora = new Date(), opcoes = {}) {
  const links = await checkoutsAsaas();
  if (!links.length || !(await asaas.situacao()).conectado) return { planos: 0 };
  const porId = new Map(links.map((l) => [l.id, l]));
  const { enviarNotificacao } = await import("../envio/email.js");
  const novos = [];
  for (let pagina = 0; pagina < 5; pagina += 1) {
    const r = await asaas.pagamentosDesde(dataMais(agora, -DIAS_DA_CONFERENCIA), pagina * 100);
    for (const p of r?.data ?? []) {
      const link = porId.get(p.paymentLink);
      if (link && asaas.SITUACOES[p.status] === "paga") {
        const feito = await registrarPagamentoDoPlano(link, p, agora, { avisar: enviarNotificacao, ...opcoes });
        if (feito) novos.push(feito);
      }
    }
    if (!r?.hasMore) break;
  }
  return { planos: novos.length };
}
