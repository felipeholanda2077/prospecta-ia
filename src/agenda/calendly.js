import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Agendamento pelo Calendly. Referência: https://developer.calendly.com
const API = "https://api.calendly.com";
const CHAVE = "calendly";
const TOLERANCIA_ASSINATURA_MS = 5 * 60 * 1000;

/**
 * Link de agendamento próprio de cada empresa: o utm_content identifica quem marcou
 * quando o Calendly avisa do agendamento.
 */
export function linkAgendamento(base, lead, canal) {
  if (!base) return "";
  try {
    const url = new URL(base);
    url.searchParams.set("utm_source", "prospecta");
    url.searchParams.set("utm_medium", canal);
    url.searchParams.set("utm_content", lead.token);
    if (lead.email && canal === "email") url.searchParams.set("email", lead.email);
    return url.toString();
  } catch {
    return "";
  }
}

async function chamar(token, caminho, { method = "GET", corpo } = {}) {
  const resp = await fetch(`${API}${caminho}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 204) return {};
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 401) throw new Error("O Calendly recusou o token. Gere um novo em Integrações → API e Webhooks.");
  if (resp.status === 403) throw new Error("O Calendly só permite webhooks nos planos pagos (Standard ou superior).");
  if (!resp.ok && resp.status !== 409) throw new Error(`Calendly respondeu ${resp.status}: ${dados.message ?? dados.title ?? "erro"}`);
  return { status: resp.status, ...dados };
}

/**
 * Conecta a conta do Calendly: cria o webhook que avisa quando uma reunião é marcada
 * ou cancelada. Se já existir um webhook para este sistema, ele é recriado com a chave nova.
 */
export async function conectar(token) {
  token = String(token ?? "").trim();
  if (!token) throw new Error("Cole o token de acesso pessoal do Calendly");
  const eu = (await chamar(token, "/users/me")).resource;
  if (!eu?.uri) throw new Error("Não foi possível ler a conta do Calendly");

  const url = `${config.painel.urlPublica}/webhooks/calendly`;
  const signingKey = crypto.randomBytes(24).toString("hex");
  const corpo = { url, events: ["invitee.created", "invitee.canceled"], organization: eu.current_organization, user: eu.uri, scope: "user", signing_key: signingKey };

  let criado = await chamar(token, "/webhook_subscriptions", { method: "POST", corpo });
  if (criado.status === 409) {
    const busca = new URLSearchParams({ organization: eu.current_organization, user: eu.uri, scope: "user" });
    const existentes = (await chamar(token, `/webhook_subscriptions?${busca}`)).collection ?? [];
    for (const w of existentes.filter((w) => w.callback_url === url)) {
      await chamar(token, `/webhook_subscriptions/${w.uri.split("/").pop()}`, { method: "DELETE" });
    }
    criado = await chamar(token, "/webhook_subscriptions", { method: "POST", corpo });
  }

  await db.gravarConfig(CHAVE, { token, signingKey, webhook: criado.resource?.uri ?? null, conta: eu.name ?? eu.email ?? "" });
  return { conta: eu.name ?? eu.email ?? "", agendamento: eu.scheduling_url ?? "" };
}

export async function status() {
  const c = await db.lerConfig(CHAVE);
  return { conectado: Boolean(c?.signingKey), conta: c?.conta ?? "" };
}

/** Confere o cabeçalho Calendly-Webhook-Signature (t=...,v1=...) sobre o corpo bruto. */
export function assinaturaValida(cabecalho, corpoBruto, signingKey, agora = Date.now()) {
  if (!cabecalho || !corpoBruto || !signingKey) return false;
  const partes = Object.fromEntries(String(cabecalho).split(",").map((p) => p.trim().split("=")));
  if (!partes.t || !partes.v1) return false;
  if (Math.abs(agora - Number(partes.t) * 1000) > TOLERANCIA_ASSINATURA_MS) return false;
  const esperado = crypto.createHmac("sha256", signingKey).update(`${partes.t}.${corpoBruto}`).digest("hex");
  const a = Buffer.from(esperado);
  const b = Buffer.from(partes.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function chaveDoWebhook() {
  return (await db.lerConfig(CHAVE))?.signingKey ?? null;
}

/** Encontra a empresa do agendamento: pelo utm_content do link ou, se não tiver, pelo e-mail. */
export async function leadDoEvento(payload) {
  const token = payload?.tracking?.utm_content;
  if (token) {
    const lead = await db.buscarLeadPorToken(token);
    if (lead) return lead;
  }
  return payload?.email ? db.buscarLeadPorEmail(payload.email) : null;
}
