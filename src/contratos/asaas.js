import crypto from "node:crypto";
import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";

// Asaas: emite PIX (parcelas dos contratos e links) e avisa o cliente (e-mail e SMS, com as notificações padrão de cada cliente).
// A chave de API fica cifrada no banco; o ambiente sai do começo dela, para nunca misturar teste e produção.
const ENDERECOS = { producao: "https://api.asaas.com/v3", sandbox: "https://api-sandbox.asaas.com/v3" };
const CHAVE_CONFIG = "asaas";
const CHAVE_WEBHOOK = "asaas_webhook";

/** O que cada situação do Asaas quer dizer aqui. */
export const SITUACOES = {
  PENDING: "emitida", AWAITING_RISK_ANALYSIS: "emitida",
  OVERDUE: "atrasada", DUNNING_REQUESTED: "atrasada",
  RECEIVED: "paga", CONFIRMED: "paga", RECEIVED_IN_CASH: "paga", DUNNING_RECEIVED: "paga",
  REFUNDED: "estornada", REFUND_REQUESTED: "estornada", REFUND_IN_PROGRESS: "estornada",
  CHARGEBACK_REQUESTED: "estornada", CHARGEBACK_DISPUTE: "estornada", AWAITING_CHARGEBACK_REVERSAL: "estornada",
};

export const ambienteDaChave =(chave) => (chave.startsWith("$aact_prod_") ? "producao" : chave.startsWith("$aact_hmlg_") ? "sandbox" : null);

async function requisitar(chave, metodo, caminho, corpo) {
  const r = await fetch(`${ENDERECOS[ambienteDaChave(chave)]}${caminho}`, {
    method: metodo,
    headers: { access_token: chave, "User-Agent": "FluxDeck-Prospecta", ...(corpo ? { "Content-Type": "application/json" } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 404) return null;
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.errors?.[0]?.description || `O Asaas respondeu com erro ${r.status}`);
  return dados;
}

/** A chave guardada só abre com a senha do painel de quando foi salva: trocar a senha na Vercel tranca ela. */
export const CHAVE_TRANCADA = "A chave do Asaas guardada não abre mais porque a senha do painel (PAINEL_SENHA) mudou depois que ela foi salva. Cole a chave de API de novo em Contratos → Cobranças → Conta do Asaas";

async function chamar(metodo, caminho, corpo) {
  const { chave } = (await db.lerConfig(CHAVE_CONFIG)) ?? {};
  if (!chave) throw new Error("Conecte o Asaas: cole a chave de API em Contratos → Cobranças → Conta do Asaas");
  const aberta = decifrar(chave);
  if (!aberta) throw new Error(CHAVE_TRANCADA);
  return requisitar(aberta, metodo, caminho, corpo);
}

/** Conectado só quando a chave guardada abre; `trancada` diz que ela existe, mas precisa ser colada de novo. */
export async function situacao() {
  const c = (await db.lerConfig(CHAVE_CONFIG)) ?? {};
  const abre = Boolean(c.chave && decifrar(c.chave));
  return { conectado: abre, trancada: Boolean(c.chave) && !abre, ambiente: abre ? c.ambiente ?? null : null };
}

/** Confere a chave no próprio Asaas antes de guardar. Sem chave, desconecta. */
export async function conectar(chave) {
  const texto = String(chave ?? "").trim();
  if (!texto) {
    await db.gravarConfig(CHAVE_CONFIG, {});
    return situacao();
  }
  const ambiente = ambienteDaChave(texto);
  if (!ambiente) return { erro: "Cole a chave de API do Asaas: ela começa com $aact_prod_ ou $aact_hmlg_" };
  try {
    await requisitar(texto, "GET", "/customers?limit=1");
  } catch (e) {
    return { erro: e.message };
  }
  await db.gravarConfig(CHAVE_CONFIG, { chave: cifrar(texto), ambiente });
  return situacao();
}

/** O token que o Asaas manda em cada aviso. Criado aqui e colado lá, no cadastro do webhook. */
export async function tokenDoWebhook({ novo = false } = {}) {
  const guardado = (await db.lerConfig(CHAVE_WEBHOOK)) ?? {};
  const aberto = guardado.token && !novo ? decifrar(guardado.token) : null;
  if (aberto) return { token: aberto, trocadoSozinho: guardado.trocadoSozinho ?? null, configuradoEm: guardado.configuradoEm ?? null };
  // O token antigo não abre (a senha do painel mudou): o novo só vale depois de colado no Asaas.
  const trocadoSozinho = guardado.token && !novo ? new Date().toISOString() : null;
  const token = crypto.randomBytes(32).toString("hex");
  await db.gravarConfig(CHAVE_WEBHOOK, { token: cifrar(token), trocadoSozinho });
  return { token, trocadoSozinho, configuradoEm: null };
}

/** Os avisos que o sistema usa (pagamento criado, pago, atrasado, apagado, estornado). */
export const EVENTOS_DO_WEBHOOK = ["PAYMENT_CREATED", "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_DELETED", "PAYMENT_REFUNDED", "PAYMENT_REFUND_IN_PROGRESS", "PAYMENT_CHARGEBACK_REQUESTED"];
const NOME_DO_WEBHOOK = "Prospecta IA";

/**
 * Cadastra o webhook no próprio Asaas, pela API, com o token de agora: atualiza o que já aponta para o sistema
 * (ou se chama "Prospecta IA") e, sem nenhum, cria. Liga o webhook e destrava a fila de avisos. Ninguém precisa colar nada.
 */
export async function configurarWebhook(url) {
  const { token } = await tokenDoWebhook();
  const lista = (await chamar("GET", "/webhooks?limit=100"))?.data ?? [];
  const nossos = lista.filter((w) => w.url === url || w.name === NOME_DO_WEBHOOK);
  const corpo = { url, enabled: true, interrupted: false, authToken: token, sendType: "NON_SEQUENTIALLY" };
  for (const w of nossos) {
    await chamar("PUT", `/webhooks/${w.id}`, { ...corpo, name: w.name || NOME_DO_WEBHOOK, events: [...new Set([...(w.events ?? []), ...EVENTOS_DO_WEBHOOK])] });
  }
  if (!nossos.length) await chamar("POST", "/webhooks", { ...corpo, name: NOME_DO_WEBHOOK, apiVersion: 3, events: EVENTOS_DO_WEBHOOK });
  // Avisos que falharam com o token antigo ficam penalizados (o Asaas espera cada vez mais para tentar de novo).
  // Corrigido o token, tira a penalidade uma vez, e eles são reenviados logo. O Asaas limita essa chamada: só aqui.
  let semPenalidade = 0;
  for (const w of nossos.filter((x) => x.penalizedRequestsCount > 0)) {
    try { await chamar("POST", `/webhooks/${w.id}/removeBackoff`, {}); semPenalidade += w.penalizedRequestsCount; } catch { /* o Asaas tenta de novo sozinho */ }
  }
  const guardado = (await db.lerConfig(CHAVE_WEBHOOK)) ?? {};
  const configuradoEm = new Date().toISOString();
  await db.gravarConfig(CHAVE_WEBHOOK, { ...guardado, configuradoEm });
  return { configuradoEm, criado: !nossos.length, atualizados: nossos.length, semPenalidade };
}

/** Como o webhook do sistema está no Asaas agora: ligado, fila parada, avisos penalizados, com token. Null se não houver. */
export async function webhookNoAsaas(url) {
  const lista = (await chamar("GET", "/webhooks?limit=100"))?.data ?? [];
  const w = lista.find((x) => x.url === url) ?? lista.find((x) => x.name === NOME_DO_WEBHOOK);
  return w ? { ligado: w.enabled !== false, filaParada: Boolean(w.interrupted), penalizados: w.penalizedRequestsCount ?? 0, temToken: w.hasAuthToken !== false, urlCerta: w.url === url } : null;
}

export async function tokenValido(recebido) {
  const guardado = (await db.lerConfig(CHAVE_WEBHOOK))?.token;
  const aberto = guardado && decifrar(guardado);
  if (!aberto || !recebido) return false;
  const [a, b] = [aberto, String(recebido)].map((t) => crypto.createHash("sha256").update(t).digest());
  return crypto.timingSafeEqual(a, b);
}

/** O cliente de um contrato no Asaas: reaproveita o que já existe, para repetir o pedido sem criar outro. */
export async function garantirCliente({ referencia, nome, documento, email, celular }) {
  const achados = await chamar("GET", `/customers?externalReference=${encodeURIComponent(referencia)}&limit=1`);
  if (achados?.data?.[0]) return achados.data[0].id;
  const novo = await chamar("POST", "/customers", {
    name: nome, cpfCnpj: documento, externalReference: referencia,
    ...(email ? { email } : {}), ...(celular ? { mobilePhone: celular } : {}),
  });
  return novo.id;
}

export const cobrancaPorReferencia = async (referencia) => (await chamar("GET", `/payments?externalReference=${encodeURIComponent(referencia)}&limit=1`))?.data?.[0] ?? null;
export const criarCobranca = (dados) => chamar("POST", "/payments", dados);
export const lerCobranca = (id) => chamar("GET", `/payments/${encodeURIComponent(id)}`);
export const mudarVencimento = (id, dueDate) => chamar("PUT", `/payments/${encodeURIComponent(id)}`, { dueDate });
export const removerCobranca = (id) => chamar("DELETE", `/payments/${encodeURIComponent(id)}`);
export const pagamentosDesde = (data, offset = 0) => chamar("GET", `/payments?${new URLSearchParams({ "dateCreated[ge]": data, limit: "100", offset: String(offset) })}`);
export const criarLink = (dados) => chamar("POST", "/paymentLinks", dados);
export const removerLink = (id) => chamar("DELETE", `/paymentLinks/${encodeURIComponent(id)}`);
export const desativarLink = (id) => chamar("PUT", `/paymentLinks/${encodeURIComponent(id)}`, { active: false });
export const pagamentosDaAssinatura = (id) => chamar("GET", `/payments?${new URLSearchParams({ subscription: id, limit: "100" })}`);
export const removerAssinatura = (id) => chamar("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
