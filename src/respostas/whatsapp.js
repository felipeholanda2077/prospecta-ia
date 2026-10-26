import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { variantesWhatsappBR } from "../analise/telefone.js";
import { registrarResposta } from "./processar.js";
import { extrairMensagemUazap } from "../envio/uazap.js";

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
export async function processarWebhookUazap(payload, campanha) {
  const m = extrairMensagemUazap(payload);
  if (!m) return 0;
  const original = await mensagemOriginalWhatsapp(m.de);
  if (!original) return 0; // conversa que não veio de uma prospecção nossa
  const r = await registrarResposta({
    lead: await db.buscarLead(original.lead_id),
    canal: "whatsapp",
    origem_id: m.id,
    de: m.de,
    texto: m.texto,
    mensagemOriginal: original,
    campanha,
  });
  return r ? 1 : 0;
}
