import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Integração com a UAZap (uazapi): conecta um número de WhatsApp por QR code,
// envia texto e recebe as respostas por webhook. Referência: https://docs.uazapi.com

const CHAVE = "uazap";
const STATUS_VALIDO_MS = 60_000;
let cache = null;
let cacheAte = 0;
let conectado = { valor: false, ate: 0 };

/** Server URL + token da instância. Variáveis de ambiente têm prioridade sobre o que foi salvo no painel. */
export async function obterConfig() {
  if (Date.now() < cacheAte) return cache;
  const salvo = (await db.lerConfig(CHAVE)) ?? {};
  cache = {
    url: (process.env.UAZAP_URL || salvo.url || "").replace(/\/+$/, ""),
    token: process.env.UAZAP_TOKEN || salvo.token || "",
    segredoWebhook: salvo.segredoWebhook || "",
  };
  cacheAte = Date.now() + 30_000;
  return cache;
}

export async function configurada() {
  const c = await obterConfig();
  return Boolean(c.url && c.token);
}

/** Salva a conexão informada no painel e gera o segredo que protege a URL do webhook. */
export async function salvarConfig({ url, token }) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const novo = {
    url: String(url ?? atual.url ?? "").trim().replace(/\/+$/, ""),
    token: String(token || atual.token || "").trim(),
    segredoWebhook: atual.segredoWebhook || crypto.randomBytes(18).toString("hex"),
  };
  if (!/^https:\/\/[^\s/]+/.test(novo.url)) throw new Error("Informe a Server URL da UAZap (ex.: https://suaempresa.uazapi.com)");
  if (!novo.token) throw new Error("Informe o token da instância");
  // Só salva depois de confirmar que a URL e o token funcionam.
  await chamarCom(novo, "/instance/status");
  await db.gravarConfig(CHAVE, novo);
  cacheAte = 0;
  conectado.ate = 0;
  return novo;
}

async function chamarCom({ url, token }, caminho, { method = "GET", corpo } = {}) {
  let resp;
  try {
    resp = await fetch(`${url}${caminho}`, {
      method,
      headers: { token, Accept: "application/json", ...(corpo ? { "Content-Type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error(`Não foi possível acessar a UAZap em ${url}. Confira a Server URL.`);
  }
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 401) throw new Error("A UAZap recusou o token da instância. Confira o token.");
  if (!resp.ok) throw new Error(`UAZap respondeu ${resp.status}: ${dados.error ?? dados.message ?? "erro desconhecido"}`);
  return dados;
}

async function chamar(caminho, opcoes) {
  const c = await obterConfig();
  if (!c.url || !c.token) throw new Error("UAZap não configurada: informe a Server URL e o token em Configurações");
  return chamarCom(c, caminho, opcoes);
}

/** Converte a resposta de /instance/status e /instance/connect em algo simples para o painel. */
export function resumirStatus(dados) {
  const inst = dados?.instance ?? {};
  const st = dados?.status ?? {};
  const conectado = Boolean(st.connected && st.loggedIn) || inst.status === "connected";
  const jid = typeof st.jid === "string" ? st.jid : st.jid?.user ?? "";
  return {
    estado: conectado ? "connected" : inst.status ?? "disconnected",
    conectado,
    qrcode: conectado ? null : inst.qrcode || null,
    paircode: conectado ? null : inst.paircode || null,
    perfil: inst.profileName || null,
    numero: String(jid).split(/[@:]/)[0] || null,
  };
}

export async function status() {
  const st = resumirStatus(await chamar("/instance/status"));
  conectado = { valor: st.conectado, ate: Date.now() + STATUS_VALIDO_MS };
  return st;
}

/** Status de conexão guardado por 1 minuto, para escolher por onde o WhatsApp sai sem consultar a cada envio. */
export async function conectadoAgora() {
  if (Date.now() < conectado.ate) return conectado.valor;
  return status().then((s) => s.conectado, () => false);
}

/** Inicia o pareamento: sem telefone devolve QR code; com telefone, código de pareamento. */
export async function conectar(telefone) {
  const corpo = telefone ? { phone: String(telefone).replace(/\D/g, "") } : {};
  return resumirStatus(await chamar("/instance/connect", { method: "POST", corpo }));
}

export async function desconectar() {
  await chamar("/instance/disconnect", { method: "POST", corpo: {} });
  conectado.ate = 0;
}

/** Aponta o webhook da instância para este sistema (só mensagens recebidas de contatos). */
export async function configurarWebhook() {
  const { segredoWebhook } = await obterConfig();
  const destino = `${config.painel.urlPublica}/webhooks/uazap/${segredoWebhook}`;
  await chamar("/webhook", {
    method: "POST",
    corpo: {
      enabled: true,
      url: destino,
      events: ["messages"],
      // wasSentByApi evita loop com as nossas próprias mensagens.
      excludeMessages: ["wasSentByApi", "fromMeYes", "isGroupYes"],
    },
  });
  return destino;
}

/** Envia um texto. `delay` mostra "digitando..." antes, como uma pessoa. */
export async function enviarTexto(numero, texto) {
  const dados = await chamar("/send/text", {
    method: "POST",
    corpo: { number: String(numero).replace(/\D/g, ""), text: texto, delay: 1500 },
  });
  return dados.messageid ?? dados.id ?? null;
}

/**
 * Pergunta à UAZap quais números estão no WhatsApp (funciona também com fixo,
 * já que muita empresa usa WhatsApp Business no número fixo).
 * Retorna [{ consulta, existe, numero }], com o número no formato que o WhatsApp usa.
 */
export async function verificarNumeros(numeros) {
  const lista = [...new Set(numeros.map((n) => String(n).replace(/\D/g, "")).filter(Boolean))];
  if (!lista.length) return [];
  const dados = await chamar("/chat/check", { method: "POST", corpo: { numbers: lista } });
  return (Array.isArray(dados) ? dados : []).map((r) => ({
    consulta: String(r.query ?? ""),
    existe: Boolean(r.isInWhatsapp),
    numero: String(r.jid ?? r.query ?? "").split("@")[0].split(":")[0] || null,
  }));
}

/** Confere o webhook recebido: segredo na URL e token da instância no corpo. */
export async function webhookValido(segredo, payload) {
  const c = await obterConfig();
  if (!c.segredoWebhook || !segredo) return false;
  const a = Buffer.from(String(segredo));
  const b = Buffer.from(c.segredoWebhook);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return !payload?.token || payload.token === c.token;
}

/**
 * Extrai a mensagem de texto recebida de um evento `messages` da UAZap.
 * Retorna null para o que não é mensagem de um contato (grupos, enviadas por nós, sem texto).
 */
export function extrairMensagemUazap(payload) {
  if (payload?.EventType !== "messages") return null;
  const m = payload.message;
  if (!m || m.fromMe || m.isGroup || m.wasSentByApi) return null;
  const texto = String(m.text ?? "").trim();
  if (!texto) return null;
  // O número vem no JID (5511999999999@s.whatsapp.net); JIDs @lid não trazem o telefone.
  const jid = [m.chatid, m.sender, payload.chat?.wa_chatid].find((j) => /@s\.whatsapp\.net$/.test(String(j ?? "")));
  if (!jid) return null;
  return { id: String(m.messageid ?? m.id), de: jid.split("@")[0].split(":")[0], texto, nome: m.senderName ?? null };
}
