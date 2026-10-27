import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { variantesWhatsappBR } from "../analise/telefone.js";
import { registrarResposta } from "./processar.js";
import { extrairMensagemUazap } from "../envio/uazap.js";
import { extrairMensagemEvolution, baixarAudio } from "../envio/evolution.js";
import { transcrever } from "../ia/transcricao.js";

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
  const variantes = variantesWhatsappBR(numero);
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

/** Respostas que chegam pelo webhook da Evolution API (texto ou áudio). */
export function processarWebhookEvolution(payload, campanha) {
  return registrarMensagemWhatsappWeb(extrairMensagemEvolution(payload), campanha, baixarAudio);
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

async function registrarMensagemWhatsappWeb(m, campanha, baixar = null) {
  if (!m) return 0;
  const original = await mensagemOriginalWhatsapp(m.de);
  if (!original) return 0; // conversa que não veio de uma prospecção nossa
  let forcarHumano = null;
  if (m.audio && !m.texto) ({ texto: m.texto, forcarHumano } = await textoDoAudio(m, baixar));
  else if (m.audio) m.texto = `[áudio] ${m.texto}`;
  const r = await registrarResposta({
    lead: await db.buscarLead(original.lead_id),
    canal: "whatsapp",
    origem_id: m.id,
    de: m.de,
    texto: m.texto,
    mensagemOriginal: original,
    campanha,
    forcarHumano,
  });
  return r ? 1 : 0;
}
