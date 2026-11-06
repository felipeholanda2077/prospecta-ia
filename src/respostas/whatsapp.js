import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { variantesWhatsappBR } from "../analise/telefone.js";
import { registrarResposta } from "./processar.js";
import { extrairMensagemUazap, buscarMensagens as buscarMensagensUazap, PRINCIPAL } from "../envio/uazap.js";
import { extrairMensagemEvolution, baixarAudio } from "../envio/evolution.js";
import { transcrever } from "../ia/transcricao.js";
import { extrairContatosVcard } from "./indicacao.js";
import { avaliarContato, leadDoContato } from "./contatoNovo.js";
import { agenteDoNumero } from "./agentes.js";

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
      // O número da Meta que recebeu (para a resposta sair por ele, quando há vários números oficiais).
      const recebeu = mudanca.value?.metadata?.phone_number_id;
      for (const m of mudanca.value?.messages ?? []) {
        const texto =
          m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        if (texto) mensagens.push({ id: m.id, de: m.from, texto, numeroId: recebeu ? `meta-${String(recebeu).replace(/\D/g, "")}` : null });
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
    // Conversa que não veio de uma proposta nossa nem de um contato ligado a uma empresa (ex.: alguém indicado) fica de fora.
    const lead = original ? await db.buscarLead(original.lead_id) : await leadDoContato(m.de);
    if (!lead) continue;
    // A conversa segue pelo número oficial em que o cliente escreveu.
    if (lead && m.numeroId && lead.numero_wa !== m.numeroId) {
      await db.atualizarLead(lead.id, { numero_wa: m.numeroId });
      lead.numero_wa = m.numeroId;
    }
    const r = await registrarResposta({
      lead,
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

/**
 * Respostas que chegam pelo webhook da UAZap; `numeroId` é o número que recebeu a mensagem. Como na Evolution,
 * contato novo é avaliado: quem chamou por conta própria e é cliente entra, e conversa pessoal fica de fora.
 */
export function processarWebhookUazap(payload, campanha, numeroId = null, opcoes = {}) {
  return registrarMensagemWhatsappWeb(extrairMensagemUazap(payload), campanha, null, {
    numeroId, avaliarNovo: avaliarContato, buscar: (filtro) => buscarMensagensUazap(numeroId, filtro), ...opcoes,
  });
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

async function registrarMensagemWhatsappWeb(m, campanha, baixar = null, { avaliarNovo = null, numeroId = null, responderAgente, ...opcoesNovo } = {}) {
  if (!m) return 0;
  const original = await mensagemOriginalWhatsapp(m.de);
  let lead = original ? await db.buscarLead(original.lead_id) : await leadDoContato(m.de);
  // Número com agente: só a conversa da prospecção que já acontecia por ele continua com a IA da FluxDeck.
  const agente = await agenteDoNumero(numeroId);
  const conversaDaProspeccao = lead && !lead.agente_id && (lead.numero_wa || PRINCIPAL) === numeroId;
  if (agente && !conversaDaProspeccao) return registrarMensagemDoAgente(m, agente, campanha, baixar, numeroId, responderAgente);
  if (lead?.agente_id) lead = null; // contato de um agente que escreveu em outro número
  // A resposta da IA sai pelo mesmo número em que a empresa escreveu.
  if (lead && numeroId && lead.numero_wa !== numeroId) {
    await db.atualizarLead(lead.id, { numero_wa: numeroId });
    lead.numero_wa = numeroId;
  }
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

/**
 * Mensagem que chegou num número com agente: o contato vira (ou já é) conversa desse agente, separada das
 * dos outros agentes e da prospecção, e o agente responde com o prompt dele. Contato indicado não recebe
 * mensagem da FluxDeck por aqui: fica só registrado na conversa.
 */
async function registrarMensagemDoAgente(m, agente, campanha, baixar, numeroId, responderAgente) {
  const telefones = /^\d+$/.test(m.de) ? variantesWhatsappBR(m.de) : [m.de];
  let lead = await db.leadDoAgente(agente.id, telefones);
  if (!lead) {
    const id = await db.criarLeadDeContato({
      nome: m.nome || "Contato do WhatsApp", whatsapp: m.de, origem: "agente",
      observacao: `Chamou no WhatsApp atendido pelo agente ${agente.nome}`,
    });
    await db.atualizarLead(id, { agente_id: agente.id, numero_wa: numeroId });
    lead = await db.buscarLead(id);
  } else if (lead.numero_wa !== numeroId) {
    await db.atualizarLead(lead.id, { numero_wa: numeroId });
    lead.numero_wa = numeroId;
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
    lead, canal: "whatsapp", origem_id: m.id, de: m.de, texto: m.texto, campanha, forcarHumano,
    nomeRemetente: m.nome, agente, ...(responderAgente ? { responderAgente } : {}),
  });
  return r ? 1 : 0;
}
