import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { variantesWhatsappBR } from "../analise/telefone.js";
import { registrarResposta } from "./processar.js";
import { extrairMensagemUazap } from "../envio/uazap.js";
import { extrairMensagemEvolution, baixarAudio } from "../envio/evolution.js";
import { transcrever } from "../ia/transcricao.js";
import { extrairContatosVcard } from "./indicacao.js";
import { avaliarContato, leadDoContato } from "./contatoNovo.js";

/** Confere o cabeçalho X-Hub-Signature-256 enviado pela Meta. */
export function assinaturaValida(corpoBruto, cabecalho, segredo) {
  if (!segredo || !cabecalho || !corpoBruto) return false;
  const esperado = "sha256=" + crypto.createHmac("sha256", segredo).update(corpoBruto).digest("hex");
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(cabecalho));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extrai as mensagens recebidas do payload do webhook da WhatsApp Cloud API. */
export function extrairMensagens(payload) {
  const mensagens = [];
  for (const entrada of payload?.entry ?? []) {
    for (const mudanca of entrada.changes ?? []) {
      for (const m of mudanca.value?.messages ?? []) {
        const texto =
          m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        if (texto) mensagens.push({ id: m.id, de: m.from, texto });
      }
    }
  }
  return mensagens;
}

/** Encontra a última proposta nossa enviada para esse número. */
export async function mensagemOriginalWhatsapp(numero) {
  // Contato @lid (sem telefone) é procurado como veio.
  const variantes = String(numero).includes("@") ? [String(numero)] : variantesWhatsappBR(numero);
  const teste = config.modoTeste.whatsapp;
  if (teste && variantes.some((v) => variantesWhatsappBR(teste).includes(v))) {
    return db.ultimaEnviadaNoCanal("whatsapp");
  }
  return db.ultimaEnviadaParaAlgum(variantes, "whatsapp");
}

export async function processarWebhookWhatsapp(payload, campanha) {
  let registradas = 0;
  for (const m of extrairMensagens(payload)) {
    const original = await mensagemOriginalWhatsapp(m.de);
    if (!original) continue; // conversa que não veio de uma proposta nossa
    const r = await registrarResposta({
      lead: await db.buscarLead(original.lead_id),
      canal: "whatsapp",
      origem_id: m.id,
      de: m.de,
      texto: m.texto,
      mensagemOriginal: original,
      campanha,
    });
    if (r) registradas++;
  }
  return registradas;
}

/** Respostas que chegam pelo webhook da UAZap. */
export function processarWebhookUazap(payload, campanha) {
  return registrarMensagemWhatsappWeb(extrairMensagemUazap(payload), campanha);
}

/**
 * Respostas que chegam pelo webhook da Evolution API (texto ou áudio). Pela Evolution também
 * dá para ler a conversa de quem chamou por conta própria, então contato novo é avaliado.
 */
export function processarWebhookEvolution(payload, campanha, opcoes = {}) {
  return registrarMensagemWhatsappWeb(extrairMensagemEvolution(payload), campanha, baixarAudio, { avaliarNovo: avaliarContato, ...opcoes });
}

/**
 * Áudio vira texto para a IA ler e responder. Se não der para transcrever, a mensagem
 * fica registrada e a conversa passa para você. Retorna { texto, forcarHumano }.
 */
export async function textoDoAudio(m, baixar) {
  try {
    if (!baixar && !m.base64) throw new Error("esta integração ainda não transcreve áudios");
    const { audio, mimetype } = m.base64 ? { audio: Buffer.from(m.base64, "base64"), mimetype: m.mimetype } : await baixar(m);
    return { texto: `[áudio] ${await transcrever(audio, mimetype)}`, forcarHumano: null };
  } catch (e) {
    return { texto: "[áudio] (não foi possível transcrever)", forcarHumano: `mandou um áudio que não deu para transcrever: ${e.message}` };
  }
}

async function registrarMensagemWhatsappWeb(m, campanha, baixar = null, { avaliarNovo = null, ...opcoesNovo } = {}) {
  if (!m) return 0;
  const original = await mensagemOriginalWhatsapp(m.de);
  const lead = original ? await db.buscarLead(original.lead_id) : await leadDoContato(m.de);
  if (!lead) {
    // Conversa que não veio de uma prospecção nossa: só entra se a IA vir que é cliente.
    if (!avaliarNovo || !m.texto) return 0;
    const r = await avaliarNovo(m, campanha, {
      ...opcoesNovo,
      registrar: ({ lead: novo, origem_id, texto }) =>
        registrarResposta({ lead: novo, canal: "whatsapp", origem_id, de: m.de, texto, campanha, nomeRemetente: m.nome }),
    });
    return r?.lead ? 1 : 0;
  }
  let forcarHumano = null;
  if (m.audio && !m.texto) ({ texto: m.texto, forcarHumano } = await textoDoAudio(m, baixar));
  else if (m.audio) m.texto = `[áudio] ${m.texto}`;
  const contatos = extrairContatosVcard(m.vcards ?? []);
  if (contatos.length) {
    const lista = contatos.map((c) => `${c.nome || "sem nome"}${c.empresa ? ` (${c.empresa})` : ""}: +${c.numero}`).join("; ");
    m.texto = `[contato compartilhado] ${lista}${m.texto ? `\n${m.texto}` : ""}`;
  }
  const r = await registrarResposta({
    lead,
    canal: "whatsapp",
    origem_id: m.id,
    de: m.de,
    texto: m.texto,
    mensagemOriginal: original,
    campanha,
    forcarHumano,
    contatosIndicados: contatos,
    nomeRemetente: m.nome,
  });
  return r ? 1 : 0;
}
