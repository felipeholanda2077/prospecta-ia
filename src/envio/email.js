import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { config } from "../config.js";

let transporte;

function getTransporte() {
  if (!config.smtp.host || !config.smtp.user) {
    throw new Error("SMTP não configurado: cadastre SMTP_HOST, SMTP_USER e SMTP_PASS nas variáveis de ambiente");
  }
  transporte ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
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

/** O que está configurado para e-mail (sem senhas), para o painel mostrar. */
export function statusEmail() {
  const { host, port, user, remetente } = config.smtp;
  return {
    smtp: { configurado: Boolean(host && user && config.smtp.pass), host, porta: port, usuario: user, remetente },
    imap: { configurado: Boolean(config.imap.host && config.imap.user && config.imap.pass), host: config.imap.host, usuario: config.imap.user },
    notificar: config.notificarEmail,
  };
}

/** Traduz os erros mais comuns do SMTP/IMAP para o que você precisa corrigir. */
export function explicarErroEmail(e, servico = "SMTP") {
  const msg = `${e?.message ?? e}${e?.responseText ? ` ${e.responseText}` : ""}`;
  if (/IMAP access is disabled|Web login required|enable IMAP/i.test(msg)) {
    return "O Gmail está bloqueando o acesso IMAP desta conta. Em Gmail → Configurações → Encaminhamento e POP/IMAP, ative o IMAP.";
  }
  if (e?.code === "EAUTH" || e?.authenticationFailed || /auth|credentials|535|534|Invalid login|AUTHENTICATIONFAILED/i.test(msg)) {
    return `O servidor recusou o usuário ou a senha do ${servico}. No Gmail/Google Workspace, use uma senha de app (myaccount.google.com/apppasswords), não a senha normal.`;
  }
  if (e?.code === "EDNS" || /ENOTFOUND|getaddrinfo/i.test(msg)) return `Não encontrei o servidor ${servico}. Confira o endereço (ex.: smtp.gmail.com / imap.gmail.com).`;
  if (["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED"].includes(e?.code) || /timeout|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return `Não consegui conectar no ${servico}. Confira a porta${servico === "SMTP" ? " (587 com SMTP_SECURE=false, ou 465 com SMTP_SECURE=true)" : " (993)"}.`;
  }
  if (/sender|from address|not owned|553|550/i.test(msg)) return "O servidor recusou o remetente. Use em EMAIL_REMETENTE o mesmo e-mail do SMTP_USER (ou um alias autorizado).";
  return msg.startsWith(servico) ? msg : `${servico}: ${msg}`;
}

/**
 * Teste completo pelo painel: envia um e-mail de verdade para `para` e confere se
 * dá para ler a caixa de entrada (IMAP), que é por onde chegam as respostas.
 */
export async function testarEmail(para) {
  const destino = String(para || config.notificarEmail || config.smtp.user || "").trim();
  const resultado = { para: destino, smtp: null, imap: null };

  try {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) throw new Error("Informe um e-mail válido para receber o teste");
    const t = getTransporte();
    await t.verify();
    const info = await t.sendMail({
      from: config.smtp.remetente,
      to: destino,
      subject: "Teste do Prospecta IA: o envio de e-mail está funcionando",
      text: `Se você recebeu esta mensagem, o envio automático de e-mails está configurado.\n\nServidor: ${config.smtp.host}:${config.smtp.port}\nRemetente: ${config.smtp.remetente}\n\nConfira também se ela chegou na caixa de entrada e não no spam.`,
    });
    resultado.smtp = { ok: true, id: info.messageId };
  } catch (e) {
    transporte = undefined; // força recriar com a configuração nova na próxima vez
    resultado.smtp = { ok: false, erro: explicarErroEmail(e, "SMTP") };
  }

  const { host, port, secure, user, pass, pasta } = config.imap;
  if (!host || !user || !pass) {
    resultado.imap = { ok: false, erro: "IMAP não configurado: cadastre IMAP_HOST para o sistema ler as respostas" };
  } else {
    const cliente = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false, socketTimeout: 15_000 });
    cliente.on("error", () => {}); // o erro chega pelo connect(); sem isto ele derrubaria o processo
    try {
      await cliente.connect();
      const caixa = await cliente.status(pasta, { messages: true });
      resultado.imap = { ok: true, mensagens: caixa.messages };
    } catch (e) {
      resultado.imap = { ok: false, erro: explicarErroEmail(e, "IMAP") };
    } finally {
      await cliente.logout().catch(() => {});
    }
  }
  return resultado;
}
