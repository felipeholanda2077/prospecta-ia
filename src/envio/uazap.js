import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Integração com a UAZap (uazapi): conecta números de WhatsApp por QR code, envia texto e
// recebe as respostas por webhook. Cada número é uma instância da UAZap, com o próprio token
// e o próprio webhook; a IA prospecta e conversa por todos. Referência: https://docs.uazapi.com

const CHAVE = "uazap";
const STATUS_VALIDO_MS = 60_000;
const NOVA_CONSULTA_MS = 1500;
// O número que já existia antes de dar para ter vários (e o das variáveis UAZAP_URL/UAZAP_TOKEN).
export const PRINCIPAL = "principal";
let cache = null;
let cacheAte = 0;
const conexoes = new Map(); // id do número → { valor, ate }

/** Formato antigo ({ url, token, segredoWebhook }) vira o número "principal" da lista. */
function lista(salvo) {
  if (Array.isArray(salvo?.numeros)) return salvo.numeros;
  return salvo?.token ? [{ id: PRINCIPAL, nome: "Principal", url: salvo.url, token: salvo.token, segredoWebhook: salvo.segredoWebhook }] : [];
}

/** Os números configurados: [{ id, nome, url, token, segredoWebhook }]. UAZAP_URL/UAZAP_TOKEN valem para o principal. */
export async function numeros() {
  if (Date.now() < cacheAte) return cache;
  const salvos = lista(await db.lerConfig(CHAVE));
  if (process.env.UAZAP_URL && process.env.UAZAP_TOKEN && !salvos.some((n) => n.id === PRINCIPAL)) {
    salvos.unshift({ id: PRINCIPAL, nome: "Principal", segredoWebhook: "" });
  }
  cache = salvos.map((n) => ({
    ...n,
    url: ((n.id === PRINCIPAL && process.env.UAZAP_URL) || n.url || "").replace(/\/+$/, ""),
    token: (n.id === PRINCIPAL && process.env.UAZAP_TOKEN) || n.token || "",
    segredoWebhook: n.segredoWebhook || "",
  }));
  cacheAte = Date.now() + 30_000;
  return cache;
}

export async function numero(id) {
  return (await numeros()).find((n) => n.id === id) ?? null;
}

/** O primeiro número (para quem ainda pensa em um só, como a tela antiga). */
export async function obterConfig() {
  return (await numeros())[0] ?? { url: "", token: "", segredoWebhook: "" };
}

export async function configurada() {
  return (await numeros()).some((n) => n.url && n.token);
}

/**
 * Adiciona um número (sem `id`) ou atualiza um que já existe. Só salva depois de confirmar
 * que a URL e o token funcionam; cada número ganha o próprio segredo para o webhook.
 */
export async function salvarNumero({ id, nome, url, token }) {
  const todos = lista(await db.lerConfig(CHAVE));
  const atual = id ? todos.find((n) => n.id === id) : null;
  if (id && !atual) throw new Error("Número não encontrado");
  const novo = {
    id: atual?.id ?? (todos.length ? crypto.randomBytes(4).toString("hex") : PRINCIPAL),
    nome: String(nome ?? "").trim().slice(0, 40) || atual?.nome || `Número ${todos.length + 1}`,
    url: String(url ?? atual?.url ?? todos[0]?.url ?? "").trim().replace(/\/+$/, ""),
    token: String(token || atual?.token || "").trim(),
    segredoWebhook: atual?.segredoWebhook || crypto.randomBytes(18).toString("hex"),
  };
  if (!/^https:\/\/[^\s/]+/.test(novo.url)) throw new Error("Informe a Server URL da UAZap (ex.: https://suaempresa.uazapi.com)");
  if (!novo.token) throw new Error("Informe o token da instância");
  if (todos.some((n) => n.id !== novo.id && n.token === novo.token)) throw new Error("Esta instância (token) já está na lista");
  await chamarCom(novo, "/instance/status");
  await db.gravarConfig(CHAVE, { numeros: atual ? todos.map((n) => (n.id === novo.id ? novo : n)) : [...todos, novo] });
  cacheAte = 0;
  conexoes.delete(novo.id);
  return novo;
}

/** Tira o número da lista (a instância continua existindo na UAZap). As conversas dele passam para os outros. */
export async function removerNumero(id) {
  const todos = lista(await db.lerConfig(CHAVE));
  if (!todos.some((n) => n.id === id)) throw new Error("Número não encontrado");
  await db.gravarConfig(CHAVE, { numeros: todos.filter((n) => n.id !== id) });
  cacheAte = 0;
  conexoes.delete(id);
}

// ---------- Admin do servidor da UAZap: cria instâncias novas (o número de cada agente, pelo CRM dele) ----------

const CHAVE_ADMIN = "uazap_admin";

/** O servidor e o admintoken da UAZap. O token nunca sai do servidor (nem para o painel). */
export async function lerAdmin() {
  const salvo = (await db.lerConfig(CHAVE_ADMIN)) ?? {};
  return {
    url: (process.env.UAZAP_ADMIN_URL || salvo.url || (await numeros())[0]?.url || "").replace(/\/+$/, ""),
    adminToken: process.env.UAZAP_ADMIN_TOKEN || salvo.adminToken || "",
  };
}

async function chamarAdmin({ url, adminToken }, caminho, { method = "GET", corpo } = {}) {
  let resp;
  try {
    resp = await fetch(`${url}${caminho}`, {
      method,
      headers: { admintoken: adminToken, Accept: "application/json", ...(corpo ? { "Content-Type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error(`Não foi possível acessar a UAZap em ${url}. Confira a Server URL.`);
  }
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 401) throw new Error("A UAZap recusou o admin token. Confira o token de administrador do servidor.");
  return { ok: resp.ok, status: resp.status, dados };
}

/** Salva o admintoken (confere com a lista de instâncias do servidor antes). Sem token novo, mantém o salvo. */
export async function salvarAdmin({ url, adminToken }) {
  const atual = (await db.lerConfig(CHAVE_ADMIN)) ?? {};
  const novo = {
    url: String(url ?? atual.url ?? "").trim().replace(/\/+$/, ""),
    adminToken: String(adminToken || atual.adminToken || "").trim(),
  };
  if (!/^https:\/\/[^\s/]+/.test(novo.url)) throw new Error("Informe a Server URL da UAZap (ex.: https://suaempresa.uazapi.com)");
  if (!novo.adminToken) throw new Error("Informe o admin token do servidor da UAZap");
  const r = await chamarAdmin(novo, "/instance/all");
  if (!r.ok && r.status !== 404) throw new Error(`UAZap respondeu ${r.status}: ${r.dados.error ?? r.dados.message ?? "erro desconhecido"}`);
  await db.gravarConfig(CHAVE_ADMIN, novo);
}

/** Cria uma instância nova no servidor da UAZap e devolve { url, token } dela. */
export async function criarInstancia(nome) {
  const admin = await lerAdmin();
  if (!admin.url || !admin.adminToken) throw new Error("A criação de números ainda não foi ativada pela FluxDeck. Peça para ela salvar o admin token da UAZap em Configurações; depois é só clicar em Criar número.");
  let r = await chamarAdmin(admin, "/instance/create", { method: "POST", corpo: { name: nome } });
  // Versões anteriores da UAZap criam a instância em /instance/init.
  if (r.status === 404 || r.status === 405) r = await chamarAdmin(admin, "/instance/init", { method: "POST", corpo: { name: nome } });
  if (!r.ok) throw new Error(`A UAZap não criou o número (${r.status}: ${r.dados.error ?? r.dados.message ?? "erro desconhecido"})`);
  const token = r.dados.token ?? r.dados.instance?.token;
  if (!token) throw new Error("A UAZap criou o número, mas não devolveu o token dele");
  return { url: admin.url, token };
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

/** Chama a UAZap pelo número `id` (sem id, pelo primeiro conectado, ou o primeiro da lista). */
async function chamar(id, caminho, opcoes) {
  const n = id ? await numero(id) : (await primeiroConectado()) ?? (await numeros())[0];
  if (!n?.url || !n?.token) throw new Error("UAZap não configurada: adicione um número em Configurações");
  return chamarCom(n, caminho, opcoes);
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

/** Status de um número (sem id, do primeiro da lista). */
export async function status(id) {
  const n = id ? await numero(id) : (await numeros())[0];
  if (!n) throw new Error("UAZap não configurada: adicione um número em Configurações");
  const st = resumirStatus(await chamarCom(n, "/instance/status"));
  conexoes.set(n.id, { valor: st.conectado, ate: Date.now() + STATUS_VALIDO_MS });
  return st;
}

/** O status de todos os números, para o painel (um número com erro não derruba os outros). */
export async function statusDeTodos() {
  return Promise.all((await numeros()).map(async (n) => {
    const st = await status(n.id).catch((e) => ({ estado: e.message, conectado: false }));
    return { id: n.id, nome: n.nome, url: n.url, webhook: n.segredoWebhook ? `${config.painel.urlPublica}/webhooks/uazap/•••` : null, ...st };
  }));
}

/**
 * Status de conexão guardado por 1 minuto, para escolher por onde o WhatsApp sai sem consultar
 * a cada envio. Com `id`, daquele número; sem, se algum número está conectado.
 */
export async function conectadoAgora(id) {
  if (!id) {
    for (const n of await numeros()) if (await conectadoAgora(n.id)) return true;
    return false;
  }
  const c = conexoes.get(id);
  if (c && Date.now() < c.ate) return c.valor;
  // Consulta que falha (a UAZap às vezes recusa as que chegam juntas, quando vários agendamentos
  // rodam no mesmo minuto) é repetida uma vez antes de o número ser dado como desconectado.
  const consultar = () => status(id).then((s) => s.conectado);
  return consultar()
    .catch(() => new Promise((r) => setTimeout(r, NOVA_CONSULTA_MS)).then(consultar))
    .catch((e) => {
      conexoes.set(id, { valor: false, ate: Date.now() + STATUS_VALIDO_MS, motivo: e.message });
      return false;
    });
}

/** Por que o último status dos números deu desconectado (o erro da consulta, se houve). */
export async function motivoDaQueda() {
  for (const n of await numeros()) {
    const c = conexoes.get(n.id);
    if (c && !c.valor) return c.motivo ?? "a UAZap informou o número como desconectado";
  }
  return null;
}

/** Os números conectados agora, na ordem da lista. */
export async function conectados() {
  const todos = await numeros();
  const ok = await Promise.all(todos.map((n) => conectadoAgora(n.id)));
  return todos.filter((_, i) => ok[i]);
}

async function primeiroConectado() {
  return (await conectados())[0] ?? null;
}

/** Um envio falhou por queda da conexão: a próxima consulta pergunta de novo, sem usar o cache. */
export function esquecerConexao(id) {
  if (id) conexoes.delete(id);
  else conexoes.clear();
}

/** Inicia o pareamento: sem telefone devolve QR code; com telefone, código de pareamento. */
export async function conectar(id, telefone) {
  const corpo = telefone ? { phone: String(telefone).replace(/\D/g, "") } : {};
  return resumirStatus(await chamar(id ?? PRINCIPAL, "/instance/connect", { method: "POST", corpo }));
}

export async function desconectar(id) {
  await chamar(id ?? PRINCIPAL, "/instance/disconnect", { method: "POST", corpo: {} });
  conexoes.delete(id ?? PRINCIPAL);
}

/**
 * As mensagens de uma conversa, da mais nova para a mais antiga, no formato que a avaliação de contato novo lê
 * (o mesmo da Evolution): { key: { id, fromMe }, message: { conversation }, messageTimestamp }.
 */
export async function buscarMensagens(numeroId, { horas = 6, remoteJid, limite = 200 } = {}) {
  const chatid = String(remoteJid).includes("@") ? String(remoteJid) : `${remoteJid}@s.whatsapp.net`;
  const dados = await chamar(numeroId, "/message/find", { method: "POST", corpo: { chatid, limit: limite } });
  const desde = Math.floor(Date.now() / 1000) - horas * 3600;
  return (dados?.messages ?? [])
    .map((m) => ({
      key: { id: String(m.messageid ?? m.id), fromMe: Boolean(m.fromMe) },
      message: { conversation: String(m.text ?? "") },
      // A UAZap manda em milissegundos.
      messageTimestamp: Number(m.messageTimestamp) > 1e11 ? Math.floor(Number(m.messageTimestamp) / 1000) : Number(m.messageTimestamp),
    }))
    .filter((m) => m.messageTimestamp >= desde)
    .sort((a, b) => b.messageTimestamp - a.messageTimestamp);
}

/** Aponta o webhook da instância para este sistema (só mensagens recebidas de contatos). */
export async function configurarWebhook(id) {
  const n = id ? await numero(id) : (await numeros())[0];
  if (!n) throw new Error("Número não encontrado");
  const destino = `${config.painel.urlPublica}/webhooks/uazap/${n.segredoWebhook}`;
  await chamarCom(n, "/webhook", {
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

// Destino: o telefone (só os dígitos) ou, para contato que só tem o identificador do WhatsApp (@lid),
// o identificador inteiro. Sem isso o @lid virava um "telefone" que não existe.
const paraUazap = (destino) => (String(destino).includes("@") ? String(destino) : String(destino).replace(/\D/g, ""));

/** Envia um texto pelo número `numeroId`. `delay` mostra "digitando..." antes, como uma pessoa. */
export async function enviarTexto(destino, texto, { numeroId } = {}) {
  const dados = await chamar(numeroId, "/send/text", {
    method: "POST",
    corpo: { number: paraUazap(destino), text: texto, delay: 1500 },
  });
  return dados.messageid ?? dados.id ?? null;
}

/** Envia uma imagem (pelo link) com a legenda, pelo número `numeroId`. */
export async function enviarImagem(destino, imagem, legenda, { numeroId } = {}) {
  const dados = await chamar(numeroId, "/send/media", {
    method: "POST",
    corpo: { number: paraUazap(destino), type: "image", file: imagem, text: legenda, delay: 1500 },
  });
  return dados.messageid ?? dados.id ?? null;
}

/** Envia uma mensagem de voz (pelo link do áudio), pelo número `numeroId`. */
export async function enviarAudio(destino, audio, { numeroId } = {}) {
  const dados = await chamar(numeroId, "/send/media", {
    method: "POST",
    corpo: { number: paraUazap(destino), type: "ptt", file: audio, delay: 1500 },
  });
  return dados.messageid ?? dados.id ?? null;
}

/**
 * Pergunta à UAZap quais números estão no WhatsApp (funciona também com fixo,
 * já que muita empresa usa WhatsApp Business no número fixo).
 * Retorna [{ consulta, existe, numero }], com o número no formato que o WhatsApp usa.
 */
export async function verificarNumeros(lista) {
  const unicos = [...new Set(lista.map((n) => String(n).replace(/\D/g, "")).filter(Boolean))];
  if (!unicos.length) return [];
  const dados = await chamar(null, "/chat/check", { method: "POST", corpo: { numbers: unicos } });
  return (Array.isArray(dados) ? dados : []).map((r) => ({
    consulta: String(r.query ?? ""),
    existe: Boolean(r.isInWhatsapp),
    numero: String(r.jid ?? r.query ?? "").split("@")[0].split(":")[0] || null,
  }));
}

/**
 * Confere o webhook recebido: o segredo na URL diz qual número recebeu, e o token no corpo
 * tem que ser o da instância dele. Retorna o número (ou null se não for válido).
 */
export async function webhookValido(segredo, payload) {
  if (!segredo) return null;
  const a = Buffer.from(String(segredo));
  for (const n of await numeros()) {
    const b = Buffer.from(n.segredoWebhook);
    if (!n.segredoWebhook || a.length !== b.length || !crypto.timingSafeEqual(a, b)) continue;
    return !payload?.token || payload.token === n.token ? n : null;
  }
  return null;
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
  // Áudio pela UAZap ainda não é transcrito: a conversa passa para você.
  const audio = /audio|ptt/i.test(`${m.messageType ?? ""} ${m.mediaType ?? ""}`);
  // Cartão de contato: o vCard pode vir em campos diferentes conforme a versão da UAZap.
  const vcard = [m.vcard, m.content?.vcard, m.content?.displayName && m.content?.vcard, typeof m.content === "string" ? m.content : null]
    .find((v) => /BEGIN:VCARD/i.test(String(v ?? "")));
  if (!texto && !audio && !vcard) return null;
  // O número vem no JID (5511999999999@s.whatsapp.net). Com o WhatsApp novo a conversa pode vir como @lid,
  // com o telefone em sender_pn; JIDs @lid sem telefone nenhum são ignorados.
  const jid = [m.chatid, m.sender, m.sender_pn, payload.chat?.wa_chatid].find((j) => /@s\.whatsapp\.net$/.test(String(j ?? "")));
  if (!jid) return null;
  const r = { id: String(m.messageid ?? m.id), de: jid.split("@")[0].split(":")[0], texto, nome: m.senderName ?? null };
  if (vcard) return { ...r, texto: /BEGIN:VCARD/i.test(texto) ? "" : texto, vcards: [vcard] };
  return audio && !texto ? { ...r, audio: true } : r;
}
