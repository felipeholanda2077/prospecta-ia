import crypto from "node:crypto";
import * as db from "../db.js";
import * as asaas from "../contratos/asaas.js";
import { hojeNoFuso } from "../contratos/cobranca.js";
import { lerValor, reais } from "../contratos/valores.js";
import { enderecoDaPagina, mensagemDoDiagnostico, previa } from "./diagnostico.js";

// Oferta de entrada: um serviço pequeno, de preço fixo, pago por PIX na própria conversa, sem contrato. O link é
// do Asaas e é um por empresa, então o pagamento chega sabendo quem pagou; é o cliente quem preenche os dados dele
// na página. Pagou: a empresa vira cliente e o link sai do ar, para ninguém pagar duas vezes.
// Oferta mensal: o link cria uma assinatura no cartão, que é como o Asaas cobra sozinho todo mês. Quem prefere
// pagar a mensalidade por PIX ou boleto vai pelo contrato, com as parcelas da aba Cobranças.
const CHAVE_OFERTAS = "ofertas_entrada";
const DIAS_DO_LINK = 30;
const DIAS_PARA_PAGAR = 3;
const PAGINAS_DA_CONSULTA = 5;

export const lerOfertas = async () => (await db.lerConfig(CHAVE_OFERTAS))?.lista ?? [];

export async function criarOferta({ nome, descricao, valor, mensal, diagnostico } = {}) {
  const limpo = String(nome ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const preco = lerValor(valor);
  if (!limpo) return { erro: "Informe o nome da oferta" };
  if (!preco || preco <= 0) return { erro: "Informe o preço da oferta" };
  const oferta = { id: crypto.randomUUID(), nome: limpo, descricao: String(descricao ?? "").trim().slice(0, 500), valor: preco, mensal: mensal === true || mensal === "true", diagnostico: diagnostico === true || diagnostico === "true" };
  await db.gravarConfig(CHAVE_OFERTAS, { lista: [...(await lerOfertas()), oferta] });
  return oferta;
}

/** Tira da lista. As vendas já feitas guardam a própria cópia do nome e do preço. */
export async function removerOferta(id) {
  await db.gravarConfig(CHAVE_OFERTAS, { lista: (await lerOfertas()).filter((o) => o.id !== id) });
  return { ok: true };
}

const mensagemDoLink = (v) => (v.mensal
  ? `Segue o link para assinar ${v.oferta} (${reais(v.valor)} por mês), no cartão: ${v.link}`
  : `Segue o link para o pagamento de ${v.oferta} (${reais(v.valor)}), por PIX: ${v.link}`);

/** O link de uma oferta para uma empresa. Pedir de novo devolve o mesmo, enquanto não for pago. */
export async function gerarLink({ leadId, ofertaId } = {}, agora = new Date()) {
  const conta = await asaas.situacao();
  if (!conta.conectado) return { erro: conta.trancada ? asaas.CHAVE_TRANCADA : "Conecte o Asaas antes de gerar o link" };
  const lead = await db.buscarLead(leadId);
  if (!lead) return { erro: "Empresa não encontrada" };
  if (lead.status === "descadastrado") return { erro: "Esta empresa pediu para não receber mais mensagens" };
  const oferta = (await lerOfertas()).find((o) => o.id === ofertaId);
  if (!oferta) return { erro: "Oferta não encontrada" };

  const pontos = oferta.diagnostico ? await previa(lead) : null;
  if (pontos?.erro) return pontos;
  const mensagem = (v) => (oferta.diagnostico ? mensagemDoDiagnostico(lead, v, pontos.problemas) : mensagemDoLink(v));
  const id = await db.criarVenda({
    lead_id: lead.id, oferta: oferta.nome, descricao: oferta.descricao, valor: oferta.valor, mensal: Boolean(oferta.mensal),
    diagnostico: Boolean(oferta.diagnostico), token: oferta.diagnostico ? crypto.randomBytes(24).toString("hex") : null,
  });
  if (!id) {
    const aberta = await db.vendaAberta(lead.id, oferta.nome);
    if (!aberta?.link) return { erro: "O link desta oferta já está sendo gerado. Tente de novo em instantes." };
    return { venda: aberta, mensagem: mensagem(aberta) };
  }
  try {
    const link = await asaas.criarLink({
      name: oferta.nome, ...(oferta.descricao ? { description: oferta.descricao } : {}), value: oferta.valor,
      ...(oferta.mensal ? { billingType: "CREDIT_CARD", chargeType: "RECURRENT", subscriptionCycle: "MONTHLY" } : { billingType: "PIX", chargeType: "DETACHED", dueDateLimitDays: DIAS_PARA_PAGAR }),
      endDate: new Date(Date.parse(`${hojeNoFuso(agora)}T00:00:00Z`) + DIAS_DO_LINK * 86_400_000).toISOString().slice(0, 10),
      externalReference: `venda-${id}`,
    });
    if (!/^https:\/\//.test(link?.url ?? "")) throw new Error("O Asaas não devolveu o link");
    await db.atualizarVenda(id, { asaas_link: link.id, link: link.url });
  } catch (e) {
    await db.excluirVenda(id);
    return { erro: `O Asaas não gerou o link: ${e.message}` };
  }
  const venda = await db.buscarVenda(id);
  return { venda, mensagem: mensagem(venda) };
}

const dataDoPagamento = (p, hoje) => p.clientPaymentDate ?? p.paymentDate ?? hoje;

/** O pagamento já lido no Asaas. Repetir não muda nada: a empresa só vira cliente na primeira vez. */
async function aplicarPagamento(v, pagamento, hoje) {
  const status = asaas.SITUACOES[pagamento.status];
  if (status === "paga" && v.status === "aguardando") {
    await db.atualizarVenda(v.id, { status: "paga", asaas_cobranca: pagamento.id, asaas_assinatura: pagamento.subscription ?? null, pago_em: dataDoPagamento(pagamento, hoje) });
    await db.cancelarPendentes(v.lead_id, "cliente pagou a oferta de entrada");
    await db.atualizarLead(v.lead_id, { status: "fechado" });
    // Na assinatura o link só é desativado: remover poderia mexer no que já foi contratado.
    await (v.mensal ? asaas.desativarLink(v.asaas_link) : asaas.removerLink(v.asaas_link)).catch((e) => console.error("Link do Asaas não saiu do ar:", e.message));
  } else if (status === "estornada" && v.status === "paga") {
    await db.atualizarVenda(v.id, { status: "estornada" });
  }
}

/** A situação de uma assinatura, pelas cobranças dela: atrasada se alguma venceu, e a data do último pagamento. */
async function conferirAssinatura(v, hoje) {
  const cobrancas = (await asaas.pagamentosDaAssinatura(v.asaas_assinatura))?.data ?? [];
  const pagas = cobrancas.filter((p) => asaas.SITUACOES[p.status] === "paga").map((p) => dataDoPagamento(p, hoje)).sort();
  const status = cobrancas.some((p) => asaas.SITUACOES[p.status] === "atrasada") ? "atrasada" : "paga";
  const pago_em = pagas.at(-1) ?? v.pago_em;
  if (status !== v.status || pago_em !== v.pago_em) await db.atualizarVenda(v.id, { status, pago_em });
}

/** Um aviso do Asaas sobre pagamento de link ou de assinatura. Como nas parcelas, a situação vem de uma leitura na hora. */
export async function processarAvisoDeVenda(corpo, agora = new Date()) {
  const { id, paymentLink, subscription } = corpo?.payment ?? {};
  if (!id) return { ignorado: true };
  const v = (paymentLink && await db.vendaPorLink(paymentLink)) || (subscription && await db.vendaPorAssinatura(subscription)) || null;
  if (!v || v.status === "cancelada") return { ignorado: true };
  if (v.mensal && v.asaas_assinatura) {
    await conferirAssinatura(v, hojeNoFuso(agora));
    return { conferida: v.id };
  }
  if (v.asaas_cobranca && v.asaas_cobranca !== id) return { ignorado: true };
  const pagamento = await asaas.lerCobranca(id);
  if (pagamento?.paymentLink !== paymentLink || pagamento.deleted) return { ignorado: true };
  await aplicarPagamento(v, pagamento, hojeNoFuso(agora));
  return { conferida: v.id };
}

/** A conferência de cada hora, para o aviso que se perder. O Asaas não filtra por link, então olha os pagamentos desde a venda mais antiga em aberto. */
export async function conferirVendas(agora = new Date()) {
  if (!(await asaas.situacao()).conectado) return { vendas: "sem Asaas" };
  const hoje = hojeNoFuso(agora);
  try {
    const abertas = await db.vendasAguardando();
    if (abertas.length) {
      const desde = new Date(abertas[0].criado_em).toISOString().slice(0, 10);
      const porLink = new Map(abertas.map((v) => [v.asaas_link, v]));
      for (let pagina = 0; pagina < PAGINAS_DA_CONSULTA; pagina += 1) {
        const r = await asaas.pagamentosDesde(desde, pagina * 100);
        for (const pagamento of r?.data ?? []) {
          const v = porLink.get(pagamento.paymentLink);
          if (v && asaas.SITUACOES[pagamento.status] === "paga") {
            await aplicarPagamento(v, pagamento, hoje);
            porLink.delete(pagamento.paymentLink);
          }
        }
        if (!r?.hasMore) break;
      }
    }
    for (const v of await db.vendasPagasRecentes()) {
      const pagamento = await asaas.lerCobranca(v.asaas_cobranca);
      if (pagamento) await aplicarPagamento(v, pagamento, hoje);
    }
    for (const v of await db.assinaturasAtivas()) await conferirAssinatura(v, hoje);
    return { vendas: "conferidas" };
  } catch (e) {
    console.error("Erro ao conferir as vendas:", e.message);
    return { vendas: "erro", erro: e.message };
  }
}

export async function cancelarVenda(id) {
  const v = await db.buscarVenda(id);
  if (!v) return { erro: "Venda não encontrada" };
  const assinatura = v.mensal && v.asaas_assinatura && ["paga", "atrasada"].includes(v.status);
  if (v.status !== "aguardando" && !assinatura) return { erro: "Só dá para cancelar o link que ainda não foi pago" };
  try {
    // A assinatura sai com as cobranças em aberto; as já pagas continuam registradas no Asaas.
    await (assinatura ? asaas.removerAssinatura(v.asaas_assinatura) : asaas.removerLink(v.asaas_link));
  } catch (e) {
    return { erro: `O Asaas não cancelou: ${e.message}` };
  }
  await db.atualizarVenda(v.id, { status: "cancelada" });
  return db.buscarVenda(v.id);
}

/** A parte das vendas na tela de cobranças. */
export async function painelDeVendas(agora = new Date()) {
  const vendas = await db.listarVendas();
  const mes = hojeNoFuso(agora).slice(0, 7);
  return {
    ofertas: await lerOfertas(), vendas: vendas.map((v) => ({ ...v, pagina: v.token ? enderecoDaPagina(v.token) : null })),
    recebidoNoMes: vendas.filter((v) => v.status === "paga" && v.pago_em?.startsWith(mes)).reduce((t, v) => t + v.valor, 0),
    mensalidades: vendas.filter((v) => v.mensal && ["paga", "atrasada"].includes(v.status)).reduce((t, v) => t + v.valor, 0),
  };
}
