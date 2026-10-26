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

/** Envia um e-mail de prospecção com rodapé e cabeçalhos de descadastro (List-Unsubscribe). */
export async function enviarEmail({ para, assunto, corpo, token }) {
  const link = linkDescadastro(token);
  const listUnsubscribe = [
    config.smtp.descadastro ? `<mailto:${config.smtp.descadastro}?subject=descadastrar>` : null,
    `<${link}>`,
  ]
    .filter(Boolean)
    .join(", ");

  const info = await getTransporte().sendMail({
    from: config.smtp.remetente,
    to: para,
    subject: assunto,
    text: corpo + rodapeDescadastro(token),
    headers: {
      "List-Unsubscribe": listUnsubscribe,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  return info.messageId;
}
