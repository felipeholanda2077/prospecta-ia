import { config } from "../config.js";
import * as db from "../db.js";
import { buscarMensagens } from "../envio/evolution.js";
import { avaliarContatoNovo } from "../ia/resposta.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// A pessoa costuma mandar várias mensagens seguidas ("Oi" / "Sou a Patrícia" / "Queria falar sobre site"):
// espera um pouco para ler tudo junto antes de decidir.
const AGRUPAR_MS = 25_000;
// Conversa pessoal não é avaliada de novo por uma semana (não gasta IA a cada mensagem de um amigo).
const PESSOAL_MS = 7 * 24 * 3600_000;
const HISTORICO_HORAS = 60 * 24;

const chaveDoLead = (de) => `contato_lead:${de}`;
const chaveDaAvaliacao = (de) => `contato_novo:${de}`;
const deixarDeFora = (de) => db.gravarEstado(chaveDaAvaliacao(de), Date.now() + PESSOAL_MS);

/** Lead ligado a um contato que chamou por conta própria (ou que respondeu de outro número). */
export async function leadDoContato(de) {
  const id = Number(await db.lerEstado(chaveDoLead(de)));
  return id ? db.buscarLead(id) : null;
}

const textoDe = (r) => String(r.message?.conversation ?? r.message?.extendedTextMessage?.text ?? "").trim();

/**
 * Alguém que nunca recebeu mensagem nossa escreveu. Como este WhatsApp também é o pessoal, a IA só entra
 * quando é cliente: conversa em que você já escreveu é de um conhecido e fica de fora; o resto a IA lê
 * e decide. Cliente vira lead (ou é ligado à empresa já prospectada que ele disse ser) e segue para
 * `registrar`, que classifica e responde como em qualquer conversa.
 * Retorna { tipo, lead } ou null quando outra mensagem do mesmo contato já está sendo avaliada.
 */
export async function avaliarContato(m, campanha, {
  registrar, esperar = AGRUPAR_MS, buscar = buscarMensagens, avaliar = avaliarContatoNovo,
} = {}) {
  if (!(await db.travar(chaveDaAvaliacao(m.de), 3 * 60_000))) return null;
  if (esperar) await new Promise((r) => setTimeout(r, esperar));

  const vistos = new Set();
  const conversa = (await buscar({ horas: HISTORICO_HORAS, remoteJid: m.jid ?? m.de, limite: 60 }))
    .filter((r) => !vistos.has(r.key?.id) && vistos.add(r.key?.id))
    .reverse();
  if (conversa.some((r) => r.key?.fromMe)) {
    await deixarDeFora(m.de);
    return { tipo: "conhecido" };
  }
  const recebidas = conversa.filter((r) => textoDe(r));
  const mensagens = recebidas.length ? recebidas.map(textoDe) : [m.texto];

  const a = await avaliar({ mensagens, nomeNoWhatsapp: m.nome, empresasContatadas: await db.empresasContatadasRecentes(), campanha });
  if (a.tipo === "pessoal") {
    await deixarDeFora(m.de);
    return { tipo: a.tipo };
  }
  if (a.tipo !== "cliente") {
    await db.destravar(chaveDaAvaliacao(m.de)); // a próxima mensagem dela é avaliada de novo, com mais contexto
    return { tipo: a.tipo };
  }

  const telefone = /^\d+$/.test(m.de) ? m.de : null;
  let lead = a.lead_id ? await db.buscarLead(a.lead_id) : null;
  if (!lead) {
    const nome = a.empresa || [a.nome_pessoa, m.nome].find(Boolean) || "Contato do WhatsApp";
    lead = await db.buscarLead(await db.criarLeadDeContato({ nome, whatsapp: telefone, observacao: `Chamou no WhatsApp: ${a.resumo}` }));
  }
  // Liga o contato antes de responder: as próximas mensagens dela já caem nesta conversa.
  await db.gravarEstado(chaveDoLead(m.de), lead.id);
  log(`📥 ${m.nome || m.de} chamou no WhatsApp (${lead.nome}): ${a.resumo}`);

  const ultima = recebidas.at(-1);
  await registrar({
    lead,
    origem_id: ultima?.key?.id ? String(ultima.key.id) : m.id,
    texto: mensagens.join("\n"),
  });
  return { tipo: a.tipo, lead };
}
