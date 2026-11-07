import { config } from "../config.js";
import * as db from "../db.js";
import * as asaas from "./asaas.js";
import { documentoFormatado, lerData, lerValor, MESES } from "./valores.js";

// As parcelas de um contrato assinado ficam guardadas aqui e só vão para o Asaas perto do vencimento: emitir
// as 12 de uma vez mandaria 12 avisos de "cobrança criada" ao cliente no mesmo dia. O webhook avisa na hora o
// que mudou, e a consulta de cada hora cobre o aviso que se perder: o Asaas é a fonte da verdade sobre o que foi pago.
const DIAS_ANTES_DE_EMITIR = 15;
const TRAVA = "cobrancas_rodada";
const ESTADO_ULTIMO_AVISO = "asaas_ultimo_aviso";
const MULTA_PADRAO = 2;
const JUROS_PADRAO = 1;

const dataIso = (d) => d.toISOString().slice(0, 10);
export const hojeNoFuso = (agora) => new Date(agora).toLocaleDateString("en-CA", { timeZone: config.timezone });
const referenciaDaParcela = (id) => `parcela-${id}`;

/** A data de cada parcela: mesmo dia todo mês; dia 29 a 31 cai no último dia dos meses mais curtos. */
export function datasDasParcelas({ dia, mes, ano }, quantidade) {
  return Array.from({ length: quantidade }, (_, i) => {
    const ultimoDia = new Date(Date.UTC(ano, mes + i + 1, 0)).getUTCDate();
    return dataIso(new Date(Date.UTC(ano, mes + i, Math.min(dia, ultimoDia))));
  });
}

/** O que dá para tirar do contrato. O painel mostra para conferir: nada vira cobrança sem o clique. */
export async function padroesDaCobranca(contratoId) {
  const c = await db.buscarContrato(contratoId);
  if (!c) return { erro: "Contrato não encontrado" };
  const lead = c.lead_id ? await db.buscarLead(c.lead_id) : null;
  const mensal = String(c.resumo ?? "").match(/^R\$\s*([\d.,]+).*por mês, (\d+) m/);
  const data = c.corpo.match(/\|\s*1ª[^|]*\|[^|]*\|\s*(\d{1,2}) de ([a-zç]+) de (\d{4})\s*\|/);
  const mes = data ? MESES.indexOf(data[2]) : -1;
  const atraso = c.corpo.match(/multa de ([\d,]+)%.*?juros de ([\d,]+)% ao mês/);
  return {
    contratoId: c.id, nome: c.contratante,
    documento: c.corpo.match(/(?:CNPJ|CPF) sob o nº ([\d./-]+\d)/)?.[1] ?? "",
    // Os seus dados no texto ainda são {{campos}}: o e-mail que aparece nele é o do cliente.
    email: lead?.email || (c.corpo.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? ""), celular: lead?.whatsapp || lead?.telefone || "",
    valor: mensal ? lerValor(mensal[1]) : null, parcelas: mensal ? Number(mensal[2]) : 1,
    vencimento: data && mes >= 0 ? dataIso(new Date(Date.UTC(Number(data[3]), mes, Number(data[1])))) : "",
    multa: atraso ? lerValor(atraso[1]) : MULTA_PADRAO, juros: atraso ? lerValor(atraso[2]) : JUROS_PADRAO,
  };
}

const percentual = (v, padrao) => {
  if (v === undefined || v === null || v === "") return padrao;
  const n = lerValor(v);
  return n != null && n >= 0 && n <= 100 ? n : null;
};

/** Agenda as parcelas de um contrato assinado e já emite as que vencem logo. Retorna as parcelas, ou { erro }. */
export async function gerarCobrancas(dados, agora = new Date()) {
  const contrato = await db.buscarContrato(dados.contratoId);
  if (!contrato) return { erro: "Contrato não encontrado" };
  if (contrato.status !== "assinado") return { erro: "Marque o contrato como assinado antes de cobrar" };
  const conta = await asaas.situacao();
  if (!conta.conectado) return { erro: conta.trancada ? asaas.CHAVE_TRANCADA : "Conecte o Asaas antes de gerar cobranças" };

  const nome = String(dados.nome ?? "").trim();
  const doc = documentoFormatado(dados.documento);
  const email = String(dados.email ?? "").trim();
  const celular = String(dados.celular ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  const valor = lerValor(dados.valor);
  const quantidade = Number.parseInt(dados.parcelas, 10);
  const primeira = lerData(dados.vencimento);
  const multa = percentual(dados.multa, MULTA_PADRAO);
  const juros = percentual(dados.juros, JUROS_PADRAO);
  if (!nome) return { erro: "Informe o nome do cliente" };
  if (!doc) return { erro: "Confira o CNPJ ou CPF do cliente" };
  if (!email && !celular) return { erro: "Informe o e-mail ou o celular do cliente: é por eles que saem os lembretes" };
  if (!valor || valor <= 0) return { erro: "Informe o valor de cada parcela" };
  if (!(quantidade >= 1 && quantidade <= 120)) return { erro: "Informe em quantas parcelas (de 1 a 120)" };
  if (!primeira) return { erro: "Confira a data do primeiro vencimento" };
  if (multa == null || juros == null) return { erro: "Confira a multa e os juros" };
  if (dados.vencimento < hojeNoFuso(agora)) return { erro: "O primeiro vencimento não pode estar no passado" };

  const datas = datasDasParcelas(primeira, quantidade);
  const existentes = await db.listarCobrancas({ contratoId: contrato.id });
  const repetida = datas.find((d) => existentes.some((e) => e.vencimento === d && e.status !== "cancelada"));
  if (repetida) return { erro: `Este contrato já tem cobrança com vencimento em ${repetida.split("-").reverse().join("/")}` };

  let cliente;
  try {
    cliente = await asaas.garantirCliente({ referencia: `contrato-${contrato.id}`, nome, documento: doc.numero.replace(/\D/g, ""), email, celular });
  } catch (e) {
    return { erro: `O Asaas recusou o cliente: ${e.message}` };
  }
  await db.criarCobrancas(datas.map((vencimento, i) => ({
    contrato_id: contrato.id, cliente_asaas: cliente, valor, vencimento, multa, juros,
    descricao: quantidade > 1 ? `${contrato.projeto}: parcela ${i + 1} de ${quantidade}` : contrato.projeto,
  })));
  await rodadaDeCobrancas(agora);
  return { parcelas: await db.listarCobrancas({ contratoId: contrato.id }) };
}

/** Procura pela referência antes de criar: se a resposta de uma emissão se perdeu, o cliente não recebe duas. */
async function emitir(p) {
  const pagamento = await asaas.cobrancaPorReferencia(referenciaDaParcela(p.id)) ?? await asaas.criarCobranca({
    customer: p.cliente_asaas, billingType: "UNDEFINED", value: p.valor, dueDate: p.vencimento, description: p.descricao,
    externalReference: referenciaDaParcela(p.id), fine: { value: p.multa, type: "PERCENTAGE" }, interest: { value: p.juros },
  });
  await db.atualizarCobranca(p.id, { status: "emitida", asaas_id: pagamento.id, link: /^https:\/\//.test(pagamento.invoiceUrl ?? "") ? pagamento.invoiceUrl : null, erro: null });
}

async function conferir(p, hoje) {
  const pagamento = await asaas.lerCobranca(p.asaas_id);
  // Removida no próprio Asaas: aqui também deixa de valer.
  const status = !pagamento || pagamento.deleted ? "cancelada" : asaas.SITUACOES[pagamento.status] ?? p.status;
  const pago_em = status === "paga" ? (pagamento.clientPaymentDate ?? pagamento.paymentDate ?? p.pago_em ?? hoje) : null;
  if (status !== p.status || pago_em !== p.pago_em || p.erro) await db.atualizarCobranca(p.id, { status, pago_em, erro: null });
}

/**
 * Um aviso do Asaas. Ele só diz qual parcela olhar: a situação vem de uma leitura na hora, então aviso repetido
 * ou fora de ordem não atrasa a parcela de novo depois de paga. Cobrança feita fora do sistema é ignorada.
 */
export async function processarAvisoDoAsaas(corpo, agora = new Date()) {
  const { id: asaasId, externalReference } = corpo?.payment ?? {};
  const id = String(externalReference ?? "").match(/^parcela-(\d+)$/)?.[1];
  const p = id && asaasId ? await db.buscarCobranca(id) : null;
  if (!p || p.asaas_id !== asaasId || p.status === "cancelada") return { ignorado: true };
  await conferir(p, hojeNoFuso(agora));
  return { conferida: p.id };
}

/** O que colar no cadastro do webhook do Asaas e quando chegou o último aviso. */
export async function dadosDoWebhook({ novo = false } = {}) {
  const { token, trocadoSozinho, configuradoEm } = await asaas.tokenDoWebhook({ novo });
  const ultimoAviso = await db.lerEstado(ESTADO_ULTIMO_AVISO);
  // Token trocado sozinho, sem o sistema ter cadastrado o novo no Asaas e sem aviso aceito depois: o Asaas ainda tem o antigo.
  const faltaColar = Boolean(trocadoSozinho && !configuradoEm && !(ultimoAviso && ultimoAviso > trocadoSozinho));
  return { url: `${config.painel.urlPublica}/webhooks/asaas`, token, ultimoAviso, faltaColar, configuradoEm };
}

/** Cadastra o webhook no Asaas pela API, com o token de agora (com `novo`, troca o token antes). */
export async function configurarWebhookNoAsaas({ novo = false } = {}) {
  if (novo) await asaas.tokenDoWebhook({ novo: true });
  await asaas.configurarWebhook(`${config.painel.urlPublica}/webhooks/asaas`);
  return dadosDoWebhook();
}

export const registrarAviso = (agora = new Date()) => db.gravarEstado(ESTADO_ULTIMO_AVISO, new Date(agora).toISOString());

/** Emite o que está perto de vencer e atualiza o que já foi emitido. Roda a cada hora; uma parcela com erro não para as outras. */
export async function rodadaDeCobrancas(agora = new Date()) {
  if (!(await asaas.situacao()).conectado) return { cobrancas: "sem Asaas" };
  if (!(await db.travar(TRAVA, 240_000))) return { cobrancas: "já em andamento" };
  try {
    const hoje = hojeNoFuso(agora);
    const limite = dataIso(new Date(Date.parse(`${hoje}T00:00:00Z`) + DIAS_ANTES_DE_EMITIR * 86_400_000));
    let emitidas = 0;
    let erros = 0;
    const aoFalhar = (p) => async (e) => {
      erros += 1;
      await db.atualizarCobranca(p.id, { erro: String(e.message).slice(0, 300) });
    };
    for (const p of await db.cobrancasParaEmitir(limite)) {
      // Atrasou aqui (agendador parado, por exemplo): emitir vencida pegaria o cliente de surpresa com multa.
      if (p.vencimento < hoje) {
        await aoFalhar(p)(new Error("O vencimento passou antes da emissão. Cancele e gere outra data."));
        continue;
      }
      await emitir(p).then(() => { emitidas += 1; }, aoFalhar(p));
    }
    for (const p of await db.cobrancasParaConferir()) await conferir(p, hoje).catch(aoFalhar(p));
    return { emitidas, erros };
  } finally {
    await db.destravar(TRAVA);
  }
}

/** Cancela uma parcela. Paga não se cancela: devolver dinheiro é um reembolso, feito no Asaas. */
export async function cancelarCobranca(id) {
  const p = await db.buscarCobranca(id);
  if (!p) return { erro: "Cobrança não encontrada" };
  if (["paga", "estornada"].includes(p.status)) return { erro: "Esta cobrança já foi paga. Para devolver o valor, faça o reembolso no Asaas." };
  if (p.status === "cancelada") return p;
  if (p.asaas_id) {
    try {
      await asaas.removerCobranca(p.asaas_id);
    } catch (e) {
      return { erro: `O Asaas não cancelou: ${e.message}` };
    }
  }
  await db.atualizarCobranca(p.id, { status: "cancelada", erro: null });
  return db.buscarCobranca(p.id);
}

/** Contrato cancelado para de cobrar. Retorna quantas saíram e quantas o Asaas recusou. */
export async function cancelarCobrancasDoContrato(contratoId) {
  const abertas = (await db.listarCobrancas({ contratoId })).filter((p) => ["agendada", "emitida", "atrasada"].includes(p.status));
  const resultados = await Promise.all(abertas.map((p) => cancelarCobranca(p.id)));
  const falhas = resultados.filter((r) => r.erro).length;
  return { canceladas: resultados.length - falhas, falhas };
}

/** A tela de cobranças: a conexão, os totais e as parcelas. */
export async function painelDeCobrancas(agora = new Date()) {
  const parcelas = await db.listarCobrancas();
  const mes = hojeNoFuso(agora).slice(0, 7);
  const soma = (filtro) => parcelas.filter(filtro).reduce((t, p) => t + p.valor, 0);
  return {
    asaas: await asaas.situacao(),
    resumo: {
      recebidoNoMes: soma((p) => p.status === "paga" && p.pago_em?.startsWith(mes)),
      aReceber: soma((p) => ["agendada", "emitida"].includes(p.status)),
      emAtraso: soma((p) => p.status === "atrasada"),
    },
    parcelas,
    contratos: (await db.listarContratos()).filter((c) => c.status === "assinado").map(({ id, projeto, contratante }) => ({ id, projeto, contratante })),
  };
}
