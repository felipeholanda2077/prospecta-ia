import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { config } from "../config.js";

let transporte;

function getTransporte() {
  if (!config.smtp.host || !config.smtp.user) {
    throw new Error("SMTP não configurado no .env (SMTP_HOST, SMTP_USER, SMTP_PASS)");
  }
  transporte ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transporte;
}

export function linkDescadastro(token) {
  return `${config.painel.urlPublica}/descadastrar/${token}`;
}

export function rodapeDescadastro(token) {
  return (
    `\n\n—\nVocê recebeu esta mensagem porque o contato da sua empresa está publicado na internet. ` +
    `Se não quiser receber novos contatos, responda "SAIR" ou acesse: ${linkDescadastro(token)}`
  );
}

function novoMessageId() {
  const dominio = (config.smtp.remetente.match(/@([^>\s]+)/)?.[1] ?? "prospecta.local").toLowerCase();
  return `<${crypto.randomUUID()}@${dominio}>`;
}

/**
 * Envia um e-mail de prospecção com rodapé e cabeçalhos de descadastro (List-Unsubscribe).
 * `respondendoA` (Message-ID) faz o follow-up aparecer na mesma conversa do e-mail original.
 * Retorna o Message-ID gerado, usado depois para reconhecer as respostas.
 */
export async function enviarEmail({ para, assunto, corpo, token, respondendoA = null }) {
  if (config.modoTeste.email) {
    assunto = `[TESTE → ${para}] ${assunto}`;
    para = config.modoTeste.email;
  }

  const link = linkDescadastro(token);
  const messageId = novoMessageId();
  const listUnsubscribe = [
    config.smtp.descadastro ? `<mailto:${config.smtp.descadastro}?subject=descadastrar>` : null,
    `<${link}>`,
  ]
    .filter(Boolean)
    .join(", ");

  await getTransporte().sendMail({
    from: config.smtp.remetente,
    to: para,
    subject: assunto,
    text: corpo + rodapeDescadastro(token),
    messageId,
    ...(respondendoA ? { inReplyTo: respondendoA, references: [respondendoA] } : {}),
    headers: {
      "List-Unsubscribe": listUnsubscribe,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  return messageId;
}

/** Aviso interno para você (ex.: um lead respondeu com interesse). */
export async function enviarNotificacao(assunto, texto) {
  if (!config.notificarEmail) return;
  await getTransporte().sendMail({
    from: config.smtp.remetente,
    to: config.notificarEmail,
    subject: `[Prospecta IA] ${assunto}`,
    text: texto,
  });
}
