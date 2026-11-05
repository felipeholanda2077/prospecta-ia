import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { enviarNotificacao } from "../envio/email.js";

// Agendamento pelo Calendly. Referência: https://developer.calendly.com
const API = "https://api.calendly.com";
const CHAVE = "calendly";
const TOLERANCIA_ASSINATURA_MS = 5 * 60 * 1000;
// Sem webhook (plano grátis), cada rodada confere as reuniões marcadas a partir de ontem.
const JANELA_CONSULTA_MS = 24 * 60 * 60 * 1000;
const MAX_PAGINAS = 3;

// Marcador que a IA escreve na última etapa; vira o link de agendamento de cada empresa no envio.
export const MARCADOR_LINK = "{{link_agendamento}}";

/**
 * Troca o marcador pelo link de agendamento da empresa. Sem link configurado, a linha
 * do marcador sai e o convite continua fazendo sentido sozinho.
 */
export function aplicarLinkAgendamento(texto, base, lead, canal) {
  const t = String(texto ?? "");
  if (!t.includes(MARCADOR_LINK)) return t;
  const link = linkAgendamento(base, lead, canal);
  if (link) return t.split(MARCADOR_LINK).join(link);
  return t.split("\n").map((l) => l.split(MARCADOR_LINK).join("").trimEnd()).filter((l, i, ls) => l || ls[i - 1]).join("\n").trim();
}

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
  if (!resp.ok && resp.status !== 409) {
    const erro = new Error(`Calendly respondeu ${resp.status}: ${dados.message ?? dados.title ?? "erro"}`);
    erro.status = resp.status;
    throw erro;
  }
  return { status: resp.status, ...dados };
}

/**
 * Conecta a conta do Calendly. Nos planos pagos cria o webhook que avisa na hora quando
 * uma reunião é marcada ou cancelada (se já existir um deste sistema, é recriado com a
 * chave nova). No plano grátis o Calendly não libera webhooks: o token fica salvo e cada
 * rodada automática consulta as reuniões marcadas.
 */
export async function conectar(token) {
  token = String(token ?? "").trim();
  if (!token) throw new Error("Cole o token de acesso pessoal do Calendly");
  const eu = (await chamar(token, "/users/me")).resource;
  if (!eu?.uri) throw new Error("Não foi possível ler a conta do Calendly");
  const conta = eu.name ?? eu.email ?? "";

  const url = `${config.painel.urlPublica}/webhooks/calendly`;
  const signingKey = crypto.randomBytes(24).toString("hex");
  const corpo = { url, events: ["invitee.created", "invitee.canceled"], organization: eu.current_organization, user: eu.uri, scope: "user", signing_key: signingKey };

  let criado;
  try {
    criado = await chamar(token, "/webhook_subscriptions", { method: "POST", corpo });
    if (criado.status === 409) {
      const busca = new URLSearchParams({ organization: eu.current_organization, user: eu.uri, scope: "user" });
      const existentes = (await chamar(token, `/webhook_subscriptions?${busca}`)).collection ?? [];
      for (const w of existentes.filter((w) => w.callback_url === url)) {
        await chamar(token, `/webhook_subscriptions/${w.uri.split("/").pop()}`, { method: "DELETE" });
      }
      criado = await chamar(token, "/webhook_subscriptions", { method: "POST", corpo });
    }
  } catch (e) {
    if (e.status !== 403) throw e;
    // Plano grátis: sem webhook, as reuniões são conferidas a cada rodada.
    await db.gravarConfig(CHAVE, { token, usuario: eu.uri, signingKey: null, webhook: null, conta });
    return { conta, agendamento: eu.scheduling_url ?? "", modo: "consulta" };
  }

  await db.gravarConfig(CHAVE, { token, usuario: eu.uri, signingKey, webhook: criado.resource?.uri ?? null, conta });
  return { conta, agendamento: eu.scheduling_url ?? "", modo: "webhook" };
}

// Horários livres para o convite: a IA oferece dois (em dias diferentes) e o link para confirmar. Lidos do Calendly
// no máximo a cada 30 minutos (o resultado fica guardado), e só com a conta conectada.
const CHAVE_HORARIOS = "calendly_horarios";
const HORARIOS_VALEM_MS = 30 * 60_000;
const ANTECEDENCIA_MS = 3 * 3600_000; // nada para daqui a menos de 3 horas
const JANELA_HORARIOS_MS = 7 * 24 * 3600_000 - 60_000; // a API aceita até 7 dias por consulta

const semBarra = (u) => String(u ?? "").split("?")[0].replace(/\/+$/, "").toLowerCase();

/** "terça (11/11) às 10h" / "quarta (12/11) às 14h30", no fuso da campanha. */
export function horarioPorExtenso(iso, fuso = config.timezone) {
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const dia = p.weekday.replace("-feira", "");
  return `${dia} (${p.day}/${p.month}) às ${Number(p.hour)}h${p.minute === "00" ? "" : p.minute}`;
}

/** Até `quantos` horários, o mais cedo possível e cada um num dia diferente. `livres` = ISO em ordem. */
export function escolherHorarios(livres, { quantos = 2, agora = new Date(), fuso = config.timezone } = {}) {
  const diaDe = (iso) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: fuso });
  const escolhidos = [];
  for (const iso of [...livres].sort()) {
    if (new Date(iso) - agora < ANTECEDENCIA_MS) continue;
    if (escolhidos.some((e) => diaDe(e) === diaDe(iso))) continue;
    escolhidos.push(iso);
    if (escolhidos.length >= quantos) break;
  }
  return escolhidos;
}

/**
 * Dois horários livres do evento do link de agendamento (`base`), por extenso, para a IA oferecer.
 * Sem o Calendly conectado (ou se a consulta falhar), retorna [] e a IA manda só o link, como antes.
 */
export async function horariosLivres(base, { agora = new Date(), quantos = 2 } = {}) {
  try {
    const c = await db.lerConfig(CHAVE);
    if (!c?.token || !base) return [];
    let guardado = null;
    try { guardado = JSON.parse((await db.lerEstado(CHAVE_HORARIOS)) || "null"); } catch {}
    let livres = guardado && guardado.base === semBarra(base) && agora - new Date(guardado.em) < HORARIOS_VALEM_MS ? guardado.livres : null;
    if (!livres) {
      const usuario = c.usuario ?? (await chamar(c.token, "/users/me")).resource?.uri;
      const tipos = (await chamar(c.token, `/event_types?${new URLSearchParams({ user: usuario, active: "true", count: "100" })}`)).collection ?? [];
      const tipo = tipos.find((t) => semBarra(t.scheduling_url) === semBarra(base)) ?? (tipos.length === 1 ? tipos[0] : null);
      if (!tipo) return [];
      const inicio = new Date(agora.getTime() + 5 * 60_000);
      const busca = new URLSearchParams({ event_type: tipo.uri, start_time: inicio.toISOString(), end_time: new Date(inicio.getTime() + JANELA_HORARIOS_MS).toISOString() });
      livres = ((await chamar(c.token, `/event_type_available_times?${busca}`)).collection ?? [])
        .filter((h) => h.status === "available" && h.start_time).map((h) => h.start_time);
      await db.gravarEstado(CHAVE_HORARIOS, JSON.stringify({ base: semBarra(base), em: agora.toISOString(), livres }));
    }
    return escolherHorarios(livres, { quantos, agora }).map((iso) => horarioPorExtenso(iso));
  } catch (e) {
    console.error("Horários livres do Calendly:", e.message);
    return [];
  }
}

export async function status() {
  const c = await db.lerConfig(CHAVE);
  return { conectado: Boolean(c?.token), modo: c?.signingKey ? "webhook" : "consulta", conta: c?.conta ?? "" };
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

/**
 * Marca a empresa como "Reunião agendada" (para as mensagens e avisa você) ou volta
 * para "Respondeu" se a reunião foi cancelada. Usado pelo webhook e pela consulta.
 */
export async function registrarAgendamento(evento, payload) {
  const lead = await leadDoEvento(payload);
  if (!lead) return null;
  if (evento === "invitee.created") {
    const inicio = payload?.scheduled_event?.start_time;
    const quando = inicio ? new Date(inicio).toLocaleString("pt-BR", { timeZone: config.timezone, dateStyle: "short", timeStyle: "short" }) : "";
    await db.cancelarPendentes(lead.id, "reunião agendada");
    await db.atualizarLead(lead.id, { status: "agendado", observacao: `Reunião agendada${quando ? ` para ${quando}` : ""} pelo Calendly` });
    await enviarNotificacao(`Reunião agendada com ${lead.nome}`, `${payload?.name ?? ""} <${payload?.email ?? ""}> marcou${quando ? ` para ${quando}` : ""}.`)
      .catch((e) => console.error("Aviso de agendamento:", e.message));
    console.log(`📅 Reunião agendada: ${lead.nome}${quando ? ` (${quando})` : ""}`);
  } else if (evento === "invitee.canceled") {
    await db.atualizarLead(lead.id, { status: "respondeu", observacao: "Reunião cancelada pelo Calendly" });
    console.log(`📅 Reunião cancelada: ${lead.nome}`);
  }
  return lead;
}

/**
 * Sem webhook (plano grátis): confere pela API as reuniões a partir de ontem e registra
 * as novas e as canceladas. Guarda o que já viu para não avisar duas vezes.
 */
export async function verificarAgendamentos() {
  const c = await db.lerConfig(CHAVE);
  if (!c?.token || c.signingKey) return { consultadas: 0, novas: 0 };
  if (!c.usuario) c.usuario = (await chamar(c.token, "/users/me")).resource?.uri;

  const vistos = JSON.parse((await db.lerEstado("calendly_vistos")) ?? "{}");
  const desde = new Date(Date.now() - JANELA_CONSULTA_MS).toISOString();
  let caminho = `/scheduled_events?${new URLSearchParams({ user: c.usuario, min_start_time: desde, count: "100", sort: "start_time:asc" })}`;
  const atuais = {};
  let consultadas = 0;
  let novas = 0;

  for (let pagina = 0; caminho && pagina < MAX_PAGINAS; pagina++) {
    const r = await chamar(c.token, caminho);
    for (const ev of r.collection ?? []) {
      consultadas++;
      const id = ev.uri.split("/").pop();
      atuais[id] = ev.status;
      if (vistos[id] === ev.status) continue;
      // Reunião que já estava cancelada quando a vimos pela primeira vez não muda nada.
      if (!vistos[id] && ev.status === "canceled") continue;
      const convidados = (await chamar(c.token, `/scheduled_events/${id}/invitees?count=100`)).collection ?? [];
      for (const convidado of convidados) {
        const lead = await registrarAgendamento(ev.status === "canceled" ? "invitee.canceled" : "invitee.created",
                                                { ...convidado, scheduled_event: ev });
        if (lead) novas++;
      }
    }
    caminho = r.pagination?.next_page ? r.pagination.next_page.replace(API, "") : null;
  }

  // Só guarda as reuniões da janela atual, para o registro não crescer para sempre.
  await db.gravarEstado("calendly_vistos", JSON.stringify(atuais));
  return { consultadas, novas };
}
