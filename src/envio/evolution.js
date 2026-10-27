import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Integração com a Evolution API (v2): conecta um número de WhatsApp por QR code,
// envia texto e recebe as respostas por webhook. É a alternativa à UAZap.
// Referência: https://github.com/EvolutionAPI/evolution-api

const CHAVE = "evolution";
const STATUS_VALIDO_MS = 60_000;
let cache = null;
let cacheAte = 0;
let conectado = { valor: false, ate: 0 };

/**
 * Endereço da API a partir do que foi colado: o painel da Evolution fica em /manager,
 * mas a API responde na raiz do servidor.
 */
export function normalizarUrl(url) {
  return String(url ?? "").trim().replace(/\/manager(\/.*)?$/i, "").replace(/\/+$/, "");
}

/** Server URL, API key e nome da instância. Variáveis de ambiente têm prioridade sobre o painel. */
export async function obterConfig() {
  if (Date.now() < cacheAte) return cache;
  const salvo = (await db.lerConfig(CHAVE)) ?? {};
  cache = {
    url: normalizarUrl(process.env.EVOLUTION_URL || salvo.url),
    apikey: process.env.EVOLUTION_APIKEY || salvo.apikey || "",
    instancia: process.env.EVOLUTION_INSTANCIA || salvo.instancia || "",
    segredoWebhook: salvo.segredoWebhook || "",
  };
  cacheAte = Date.now() + 30_000;
  return cache;
}

export async function configurada() {
  const c = await obterConfig();
  return Boolean(c.url && c.apikey && c.instancia);
}

/**
 * Salva a conexão informada no painel e gera o segredo que protege a URL do webhook.
 * Se a instância ainda não existir no servidor, ela é criada (precisa da API key global).
 */
export async function salvarConfig({ url, apikey, instancia }) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const novo = {
    url: normalizarUrl(url ?? atual.url),
    apikey: String(apikey || atual.apikey || "").trim(),
    instancia: String(instancia ?? atual.instancia ?? "").trim(),
    segredoWebhook: atual.segredoWebhook || crypto.randomBytes(18).toString("hex"),
  };
  if (!/^https?:\/\/[^\s/]+/.test(novo.url)) throw new Error("Informe a Server URL da Evolution API (ex.: https://evolution.suaempresa.com)");
  if (!novo.apikey) throw new Error("Informe a API key da Evolution");
  if (!/^[\w.-]+$/.test(novo.instancia)) throw new Error("Informe o nome da instância (letras, números, - ou _)");

  // Só salva depois de confirmar que a URL, a chave e a instância funcionam.
  try {
    const estado = await chamarCom(novo, `/instance/connectionState/${encodeURIComponent(novo.instancia)}`);
    if (!estado?.instance) throw new Error("Esse endereço não respondeu como a Evolution API. Use a Server URL do servidor, sem /manager no final.");
  } catch (e) {
    if (e.status !== 404) throw e;
    await chamarCom(novo, "/instance/create", {
      method: "POST",
      corpo: { instanceName: novo.instancia, integration: "WHATSAPP-BAILEYS", qrcode: false },
    });
  }
  await db.gravarConfig(CHAVE, novo);
  cacheAte = 0;
  conectado.ate = 0;
  return novo;
}

async function chamarCom({ url, apikey }, caminho, { method = "GET", corpo } = {}) {
  let resp;
  try {
    resp = await fetch(`${url}${caminho}`, {
      method,
      headers: { apikey, Accept: "application/json", ...(corpo ? { "Content-Type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error(`Não foi possível acessar a Evolution API em ${url}. Confira a Server URL.`);
  }
  const dados = await resp.json().catch(() => null);
  if (resp.status === 401 || resp.status === 403) throw new Error("A Evolution API recusou a API key. Confira a chave.");
  if (resp.ok && dados === null && /html/i.test(resp.headers.get("content-type") ?? "")) {
    throw new Error("Esse endereço não respondeu como a Evolution API (veio uma página, não a API). Use a Server URL do servidor, sem /manager no final.");
  }
  if (!resp.ok) {
    const detalhe = dados?.response?.message ?? dados?.message ?? dados?.error ?? "erro desconhecido";
    const erro = new Error(`Evolution API respondeu ${resp.status}: ${Array.isArray(detalhe) ? detalhe.join("; ") : detalhe}`);
    erro.status = resp.status;
    throw erro;
  }
  return dados ?? {};
}

async function chamar(caminho, opcoes) {
  const c = await obterConfig();
  if (!c.url || !c.apikey || !c.instancia) throw new Error("Evolution API não configurada: informe a Server URL, a API key e a instância em Configurações");
  return chamarCom(c, caminho.replace(":instancia", encodeURIComponent(c.instancia)), opcoes);
}

const ESTADOS = { open: "connected", connecting: "connecting", close: "disconnected" };

/** Converte as respostas de connectionState e connect no mesmo formato que o painel usa para a UAZap. */
export function resumirStatus(dados) {
  const estado = dados?.instance?.state ?? dados?.instance?.status ?? (dados?.base64 || dados?.pairingCode ? "connecting" : "close");
  const ok = estado === "open";
  return {
    estado: ESTADOS[estado] ?? estado,
    conectado: ok,
    qrcode: ok ? null : dados?.base64 || dados?.qrcode?.base64 || null,
    paircode: ok ? null : dados?.pairingCode || dados?.qrcode?.pairingCode || null,
    perfil: null,
    numero: null,
  };
}

export async function status() {
  const st = resumirStatus(await chamar("/instance/connectionState/:instancia"));
  conectado = { valor: st.conectado, ate: Date.now() + STATUS_VALIDO_MS };
  if (st.conectado) {
    // Nome e número do perfil são só informativos; se falhar, o status continua valendo.
    const { instancia } = await obterConfig();
    const lista = await chamar(`/instance/fetchInstances?instanceName=${encodeURIComponent(instancia)}`).catch(() => []);
    const inst = (Array.isArray(lista) ? lista : [lista]).find((i) => (i?.name ?? i?.instance?.instanceName) === instancia);
    st.perfil = inst?.profileName ?? null;
    st.numero = String(inst?.ownerJid ?? "").split("@")[0] || null;
  }
  return st;
}

/** Status de conexão guardado por 1 minuto, para escolher por onde o WhatsApp sai sem consultar a cada envio. */
export async function conectadoAgora() {
  if (Date.now() < conectado.ate) return conectado.valor;
  return status().then((s) => s.conectado, () => false);
}

/** Inicia o pareamento: sem telefone devolve QR code; com telefone, também o código de pareamento. */
export async function conectar(telefone) {
  const numero = telefone ? `?number=${String(telefone).replace(/\D/g, "")}` : "";
  const dados = await chamar(`/instance/connect/:instancia${numero}`);
  if (dados?.error) throw new Error(`Evolution API: ${dados.message ?? "não foi possível conectar"}`);
  return resumirStatus(dados);
}

export async function desconectar() {
  await chamar("/instance/logout/:instancia", { method: "DELETE" });
  conectado.ate = 0;
}

/** Aponta o webhook da instância para este sistema (só mensagens recebidas). */
export async function configurarWebhook() {
  const { segredoWebhook } = await obterConfig();
  const destino = `${config.painel.urlPublica}/webhooks/evolution/${segredoWebhook}`;
  await chamar("/webhook/set/:instancia", {
    method: "POST",
    corpo: { webhook: { enabled: true, url: destino, byEvents: false, base64: false, events: ["MESSAGES_UPSERT"] } },
  });
  return destino;
}

/** Envia um texto. `delay` mostra "digitando..." antes, como uma pessoa. */
export async function enviarTexto(numero, texto) {
  const dados = await chamar("/message/sendText/:instancia", {
    method: "POST",
    corpo: { number: String(numero).replace(/\D/g, ""), text: texto, delay: 1500 },
  });
  return dados?.key?.id ?? null;
}

/**
 * Pergunta à Evolution quais números estão no WhatsApp (funciona também com fixo).
 * Retorna [{ consulta, existe, numero }], no mesmo formato da UAZap.
 */
export async function verificarNumeros(numeros) {
  const lista = [...new Set(numeros.map((n) => String(n).replace(/\D/g, "")).filter(Boolean))];
  if (!lista.length) return [];
  const dados = await chamar("/chat/whatsappNumbers/:instancia", { method: "POST", corpo: { numbers: lista } });
  return (Array.isArray(dados) ? dados : []).map((r) => ({
    consulta: String(r.number ?? ""),
    existe: Boolean(r.exists),
    numero: String(r.jid ?? r.number ?? "").split("@")[0].split(":")[0] || null,
  }));
}

/** Confere o webhook recebido: segredo na URL e, quando vier, a API key da instância no corpo. */
export async function webhookValido(segredo, payload) {
  const c = await obterConfig();
  if (!c.segredoWebhook || !segredo) return false;
  const a = Buffer.from(String(segredo));
  const b = Buffer.from(c.segredoWebhook);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return !payload?.instance || payload.instance === c.instancia;
}

/**
 * Extrai a mensagem de texto recebida de um evento `messages.upsert` da Evolution.
 * Retorna null para o que não é mensagem de um contato (grupos, enviadas por nós, sem texto).
 */
export function extrairMensagemEvolution(payload) {
  if (!/^messages[._]upsert$/i.test(String(payload?.event ?? ""))) return null;
  const d = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  const k = d?.key;
  if (!k || k.fromMe) return null;
  const msg = d.message ?? {};
  const texto = String(msg.conversation ?? msg.extendedTextMessage?.text ?? msg.buttonsResponseMessage?.selectedDisplayText ??
    msg.listResponseMessage?.title ?? "").trim();
  if (!texto) return null;
  if (String(k.remoteJid ?? "").endsWith("@g.us")) return null;
  // Com o WhatsApp novo o remoteJid pode vir como @lid; o telefone vem em remoteJidAlt/senderPn.
  const jid = [k.remoteJid, k.remoteJidAlt, k.senderPn].find((j) => /@s\.whatsapp\.net$/.test(String(j ?? "")));
  if (!jid) return null;
  return { id: String(k.id), de: jid.split("@")[0].split(":")[0], texto, nome: d.pushName ?? null };
}
