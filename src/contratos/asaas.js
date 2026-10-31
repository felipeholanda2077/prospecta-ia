import crypto from "node:crypto";
import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";

// Asaas: emite PIX e boleto e avisa o cliente (e-mail e SMS, com as notificações padrão de cada cliente).
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

async function chamar(metodo, caminho, corpo) {
  const { chave } = (await db.lerConfig(CHAVE_CONFIG)) ?? {};
  const aberta = chave && decifrar(chave);
  if (!aberta) throw new Error("Cole de novo a chave de API do Asaas");
  return requisitar(aberta, metodo, caminho, corpo);
}

export async function situacao() {
  const c = (await db.lerConfig(CHAVE_CONFIG)) ?? {};
  return { conectado: Boolean(c.chave), ambiente: c.ambiente ?? null };
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
  const guardado = (await db.lerConfig(CHAVE_WEBHOOK))?.token;
  const aberto = guardado && !novo ? decifrar(guardado) : null;
  if (aberto) return aberto;
  const token = crypto.randomBytes(32).toString("hex");
  await db.gravarConfig(CHAVE_WEBHOOK, { token: cifrar(token) });
  return token;
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
export const removerCobranca = (id) => chamar("DELETE", `/payments/${encodeURIComponent(id)}`);
export const pagamentosDesde = (data, offset = 0) => chamar("GET", `/payments?${new URLSearchParams({ "dateCreated[ge]": data, limit: "100", offset: String(offset) })}`);
export const criarLink = (dados) => chamar("POST", "/paymentLinks", dados);
export const removerLink = (id) => chamar("DELETE", `/paymentLinks/${encodeURIComponent(id)}`);
