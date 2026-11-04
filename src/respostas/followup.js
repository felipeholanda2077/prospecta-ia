import { config } from "../config.js";
import * as db from "../db.js";
import { escreverFollowup, pediuValor, semValores } from "../ia/resposta.js";
import { enderecoDoGuia } from "../vendas/campanha.js";
import { lerApresentacao } from "./apresentacao.js";
import { iaPausada } from "./processar.js";

// Follow-up da IA para quem mostrou interesse e parou de responder: 1 dia depois da nossa última mensagem,
// a IA retoma de onde pararam ou oferece um material de graça (o guia em PDF da empresa). No máximo
// MAX_SEGUIDOS seguidos sem resposta; quando a pessoa responde, a conversa volta ao normal e a conta zera.

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

const DIA_MS = 24 * 3600_000;
export const MAX_SEGUIDOS = 2;
// Conversa parada há mais tempo que isso já esfriou: o follow-up não vai (a campanha cuida dela).
const DIAS_MAXIMOS = 14;
const POR_RODADA = 3;
const CANAIS = ["whatsapp", "email"];
const chave = (leadId) => `followup_ia:${leadId}`;

/** Os follow-ups já mandados desde a última mensagem da pessoa: { n, desde, opcoes: ["retomar" | "material"] }. */
async function lerRegistro(leadId) {
  try {
    return JSON.parse((await db.lerEstado(chave(leadId))) || "null");
  } catch {
    return null;
  }
}

/**
 * Esta conversa pede follow-up agora? Retorna { canal, de, numero, opcao } ou null.
 * `historico` = db.historicoConversa(lead.id); `registro` = os follow-ups desde a última resposta dela.
 */
export function precisaDeFollowup({ historico, registro, pausada = "" }, agora = new Date()) {
  if (pausada) return null;
  const ultimaDela = [...historico].reverse().find((h) => h.autor === "lead");
  const ultima = historico.at(-1);
  if (!ultimaDela || !ultima || ultima.autor !== "nos") return null;
  if (!CANAIS.includes(ultima.canal)) return null; // direct do Instagram: a Meta só deixa responder em 24 h
  if (agora - new Date(ultima.quando) < DIA_MS) return null;
  if (agora - new Date(ultimaDela.quando) > DIAS_MAXIMOS * DIA_MS) return null;
  // A conta é por silêncio: se ela respondeu depois do último follow-up, recomeça.
  const valendo = registro && new Date(registro.desde) >= new Date(ultimaDela.quando) ? registro : null;
  const n = valendo?.n ?? 0;
  if (n >= MAX_SEGUIDOS) return null;
  // Alterna: um retoma a conversa, o outro oferece o material (o primeiro é o que a IA achar melhor).
  const usadas = valendo?.opcoes ?? [];
  return { canal: ultima.canal, de: ultimaDela.contato || ultima.contato, numero: n + 1, evitar: usadas.at(-1) ?? null };
}

/**
 * Rodada dos follow-ups (em horário comercial, dentro da rodada do funil): escolhe as conversas com
 * interesse e 1 dia sem resposta, a IA escreve e a mensagem entra na fila de respostas.
 */
export async function followupsDeInteressados(campanha, { limite = POR_RODADA, escrever = escreverFollowup, agora = new Date() } = {}) {
  if (!campanha.automacao?.respostaAutomatica || campanha.automacao?.followupInteressados === false) return { criados: 0 };
  let criados = 0;
  for (const lead of await db.interessadosParaFollowup(agora.toISOString())) {
    if (criados >= limite) break;
    const historico = await db.historicoConversa(lead.id);
    const registro = await lerRegistro(lead.id);
    const plano = precisaDeFollowup({ historico, registro, pausada: await iaPausada(lead.id) }, agora);
    if (!plano) continue;
    try {
      // Responde no mesmo canal e para o mesmo contato da última mensagem dela (no e-mail, na mesma conversa).
      const dela = await db.ultimaRespostaDaConversa(lead.id);
      if (!dela || !CANAIS.includes(dela.canal)) continue;
      const r = await escrever({
        lead, historico, campanha, canal: dela.canal, numero: plano.numero, evitar: plano.evitar,
        apresentacao: await lerApresentacao(), linkMaterial: enderecoDoGuia(lead),
      });
      const corpo = pediuValor(dela.texto, historico) ? r.mensagem : semValores(r.mensagem);
      if (!corpo?.trim()) continue;
      const id = await db.criarMensagem({
        lead_id: lead.id, canal: dela.canal, destino: dela.de || (dela.canal === "email" ? lead.email : lead.whatsapp),
        assunto: dela.canal === "email" ? (/^re:/i.test(dela.assunto ?? "") ? dela.assunto : `Re: ${dela.assunto ?? lead.nome}`) : null,
        corpo: corpo.trim(), status: "aprovada", tipo: "resposta", etapa: 0,
        em_resposta_a: dela.canal === "email" ? dela.origem_id : null,
      });
      // Alguns minutos, como uma pessoa; a fila envia em horário comercial.
      await db.atualizarMensagem(id, { agendada_para: new Date(Date.now() + (2 + Math.random() * 6) * 60_000).toISOString() });
      await db.gravarEstado(chave(lead.id), JSON.stringify({
        n: plano.numero, desde: new Date().toISOString(), opcoes: [...((registro && plano.numero > 1 ? registro.opcoes : []) ?? []), r.opcao],
      }));
      criados++;
      log(`🔔 Follow-up ${plano.numero} de ${MAX_SEGUIDOS} para ${lead.nome} (${r.opcao === "material" ? "com o guia gratuito" : "retomando a conversa"})`);
    } catch (e) {
      log(`⚠️  Follow-up de ${lead.nome} não saiu: ${e.message}`);
    }
  }
  return { criados };
}
