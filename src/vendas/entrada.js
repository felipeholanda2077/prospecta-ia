import crypto from "node:crypto";
import * as db from "../db.js";
import * as asaas from "../contratos/asaas.js";
import { hojeNoFuso } from "../contratos/cobranca.js";
import { lerValor, reais } from "../contratos/valores.js";

// Oferta de entrada: um serviço pequeno, de preço fixo, pago por PIX na própria conversa, sem contrato. O link é
// do Asaas e é um por empresa, então o pagamento chega sabendo quem pagou; é o cliente quem preenche os dados dele
// na página. Pagou: a empresa vira cliente e o link sai do ar, para ninguém pagar duas vezes.
const CHAVE_OFERTAS = "ofertas_entrada";
const DIAS_DO_LINK = 30;
const DIAS_PARA_PAGAR = 3;
const PAGINAS_DA_CONSULTA = 5;

export const lerOfertas = async () => (await db.lerConfig(CHAVE_OFERTAS))?.lista ?? [];

export async function criarOferta({ nome, descricao, valor } = {}) {
  const limpo = String(nome ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const preco = lerValor(valor);
  if (!limpo) return { erro: "Informe o nome da oferta" };
  if (!preco || preco <= 0) return { erro: "Informe o preço da oferta" };
  const oferta = { id: crypto.randomUUID(), nome: limpo, descricao: String(descricao ?? "").trim().slice(0, 500), valor: preco };
  await db.gravarConfig(CHAVE_OFERTAS, { lista: [...(await lerOfertas()), oferta] });
  return oferta;
}

/** Tira da lista. As vendas já feitas guardam a própria cópia do nome e do preço. */
export async function removerOferta(id) {
  await db.gravarConfig(CHAVE_OFERTAS, { lista: (await lerOfertas()).filter((o) => o.id !== id) });
  return { ok: true };
}

const mensagemDoLink = (v) => `Segue o link para o pagamento de ${v.oferta} (${reais(v.valor)}), por PIX: ${v.link}`;

/** O link de uma oferta para uma empresa. Pedir de novo devolve o mesmo, enquanto não for pago. */
export async function gerarLink({ leadId, ofertaId } = {}, agora = new Date()) {
  if (!(await asaas.situacao()).conectado) return { erro: "Conecte o Asaas antes de gerar o link" };
  const lead = await db.buscarLead(leadId);
  if (!lead) return { erro: "Empresa não encontrada" };
  if (lead.status === "descadastrado") return { erro: "Esta empresa pediu para não receber mais mensagens" };
  const oferta = (await lerOfertas()).find((o) => o.id === ofertaId);
  if (!oferta) return { erro: "Oferta não encontrada" };

  const id = await db.criarVenda({ lead_id: lead.id, oferta: oferta.nome, descricao: oferta.descricao, valor: oferta.valor });
  if (!id) {
    const aberta = await db.vendaAberta(lead.id, oferta.nome);
    if (!aberta?.link) return { erro: "O link desta oferta já está sendo gerado. Tente de novo em instantes." };
    return { venda: aberta, mensagem: mensagemDoLink(aberta) };
  }
  try {
    const link = await asaas.criarLink({
      name: oferta.nome, ...(oferta.descricao ? { description: oferta.descricao } : {}), billingType: "PIX", chargeType: "DETACHED", value: oferta.valor,
      dueDateLimitDays: DIAS_PARA_PAGAR, endDate: new Date(Date.parse(`${hojeNoFuso(agora)}T00:00:00Z`) + DIAS_DO_LINK * 86_400_000).toISOString().slice(0, 10),
      externalReference: `venda-${id}`,
    });
    if (!/^https:\/\//.test(link?.url ?? "")) throw new Error("O Asaas não devolveu o link");
    await db.atualizarVenda(id, { asaas_link: link.id, link: link.url });
  } catch (e) {
    await db.excluirVenda(id);
    return { erro: `O Asaas não gerou o link: ${e.message}` };
  }
  const venda = await db.buscarVenda(id);
  return { venda, mensagem: mensagemDoLink(venda) };
}

/** O pagamento já lido no Asaas. Repetir não muda nada: a empresa só vira cliente na primeira vez. */
async function aplicarPagamento(v, pagamento, hoje) {
  const status = asaas.SITUACOES[pagamento.status];
  if (status === "paga" && v.status === "aguardando") {
    await db.atualizarVenda(v.id, { status: "paga", asaas_cobranca: pagamento.id, pago_em: pagamento.clientPaymentDate ?? pagamento.paymentDate ?? hoje });
    await db.cancelarPendentes(v.lead_id, "cliente pagou a oferta de entrada");
    await db.atualizarLead(v.lead_id, { status: "fechado" });
    await asaas.removerLink(v.asaas_link).catch((e) => console.error("Link do Asaas não removido:", e.message));
  } else if (status === "estornada" && v.status === "paga") {
    await db.atualizarVenda(v.id, { status: "estornada" });
  }
}

/** Um aviso do Asaas sobre pagamento de link. Como nas parcelas, a situação vem de uma leitura na hora. */
export async function processarAvisoDeVenda(corpo, agora = new Date()) {
  const { id, paymentLink } = corpo?.payment ?? {};
  const v = id && paymentLink ? await db.vendaPorLink(paymentLink) : null;
  if (!v || v.status === "cancelada" || (v.asaas_cobranca && v.asaas_cobranca !== id)) return { ignorado: true };
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
    return { vendas: "conferidas" };
  } catch (e) {
    console.error("Erro ao conferir as vendas:", e.message);
    return { vendas: "erro", erro: e.message };
  }
}

export async function cancelarVenda(id) {
  const v = await db.buscarVenda(id);
  if (!v) return { erro: "Venda não encontrada" };
  if (v.status !== "aguardando") return { erro: "Só dá para cancelar o link que ainda não foi pago" };
  try {
    await asaas.removerLink(v.asaas_link);
  } catch (e) {
    return { erro: `O Asaas não removeu o link: ${e.message}` };
  }
  await db.atualizarVenda(v.id, { status: "cancelada" });
  return db.buscarVenda(v.id);
}

/** A parte das vendas na tela de cobranças. */
export async function painelDeVendas(agora = new Date()) {
  const vendas = await db.listarVendas();
  const mes = hojeNoFuso(agora).slice(0, 7);
  return {
    ofertas: await lerOfertas(), vendas,
    recebidoNoMes: vendas.filter((v) => v.status === "paga" && v.pago_em?.startsWith(mes)).reduce((t, v) => t + v.valor, 0),
  };
}
