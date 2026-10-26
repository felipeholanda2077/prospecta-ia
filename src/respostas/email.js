import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../config.js";
import * as db from "../db.js";
import { normalizarContato } from "../db.js";
import { registrarResposta } from "./processar.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);
const DIAS_INICIAIS = 14; // na primeira execução, olha só os últimos 14 dias

/** Lista de Message-IDs a que um e-mail recebido responde (In-Reply-To + References). */
export function idsReferenciados(email) {
  const refs = Array.isArray(email.references) ? email.references : String(email.references ?? "").split(/\s+/);
  return [email.inReplyTo, ...refs].filter(Boolean).map((s) => s.trim());
}

/** Descobre qual mensagem nossa um e-mail recebido está respondendo. */
export async function encontrarMensagemOriginal(email) {
  const porThread = await db.mensagemPorMessageIds(idsReferenciados(email));
  if (porThread) return porThread;
  const remetente = email.from?.value?.[0]?.address;
  return remetente ? db.ultimaEnviadaPara(remetente) : null;
}

/** Lê a caixa de entrada por IMAP e registra as respostas dos leads. */
export async function verificarRespostasEmail(campanha) {
  const { host, port, secure, user, pass, pasta } = config.imap;
  if (!host || !user) {
    log("📥 IMAP não configurado; verificação de respostas por e-mail ignorada");
    return { lidas: 0, respostas: 0 };
  }

  const cliente = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false });
  const emails = [];

  await cliente.connect();
  try {
    const trava = await cliente.getMailboxLock(pasta);
    try {
      // Se a caixa foi recriada (UIDVALIDITY mudou), os UIDs antigos não valem mais.
      const validade = String(cliente.mailbox.uidValidity);
      let ultimoUid = Number((await db.lerEstado("imap_ultimo_uid")) ?? 0);
      if ((await db.lerEstado("imap_uidvalidity")) !== validade) ultimoUid = 0;

      const criterio = ultimoUid
        ? { uid: `${ultimoUid + 1}:*` }
        : { since: new Date(Date.now() - DIAS_INICIAIS * 86400000) };
      const uids = ((await cliente.search(criterio, { uid: true })) || []).filter((u) => u > ultimoUid);

      if (uids.length) {
        for await (const msg of cliente.fetch(uids, { uid: true, source: true }, { uid: true })) {
          emails.push({ uid: msg.uid, email: await simpleParser(msg.source) });
        }
      }
      const maior = Math.max(ultimoUid, ...uids);
      await db.gravarEstado("imap_ultimo_uid", maior);
      await db.gravarEstado("imap_uidvalidity", validade);
    } finally {
      trava.release();
    }
  } finally {
    await cliente.logout().catch(() => {});
  }

  // A classificação com IA roda depois de soltar a caixa, para não segurar a conexão IMAP.
  const proprioEndereco = normalizarContato(user);
  let respostas = 0;
  for (const { email } of emails) {
    const remetente = email.from?.value?.[0]?.address ?? "";
    if (!remetente) continue;
    // Cópias das nossas próprias propostas (ex.: no modo teste, enviadas para a mesma caixa).
    if (email.messageId && (await db.mensagemPorMessageIds([email.messageId]))) continue;
    // No modo teste você responde do seu próprio e-mail, então ele não pode ser ignorado.
    if (!config.modoTeste.email && normalizarContato(remetente) === proprioEndereco) continue;

    const original = await encontrarMensagemOriginal(email);
    if (!original) continue; // não é resposta a uma proposta nossa

    const lead = await db.buscarLead(original.lead_id);
    const r = await registrarResposta({
      lead,
      canal: "email",
      origem_id: email.messageId ?? `${remetente}:${email.date?.toISOString()}`,
      de: remetente,
      assunto: email.subject ?? null,
      texto: email.text ?? "",
      mensagemOriginal: original,
      campanha,
    });
    if (r) respostas++;
  }

  log(`📥 ${emails.length} e-mails novos lidos, ${respostas} respostas de leads`);
  return { lidas: emails.length, respostas };
}
