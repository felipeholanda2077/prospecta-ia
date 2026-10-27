import { config } from "../config.js";
import * as db from "../db.js";
import { classificarResposta, limparTextoResposta } from "../ia/resposta.js";
import { enviarNotificacao } from "../envio/email.js";
import { linkAgendamento } from "../agenda/calendly.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// A IA espera alguns minutos antes de responder, como uma pessoa faria.
const ESPERA_MIN_MS = 2 * 60 * 1000;
const ESPERA_MAX_MS = 6 * 60 * 1000;
const RESPONDE_SOZINHA = ["interessado", "quer_informacoes", "outro"];

/**
 * Com a resposta automática ligada, agenda a próxima mensagem da conversa (sai na
 * próxima rodada em horário comercial) ou marca que a conversa precisa de você.
 */
async function responderSozinha({ respostaId, lead, canal, de, assunto, origem_id, c, campanha }) {
  const auto = campanha.automacao;
  // Pedido de ajuda da IA fica marcado sempre, mesmo com a resposta automática desligada.
  let motivo = c.precisa_humano ? c.motivo_humano || "a IA pediu sua ajuda nesta conversa" : null;
  if (!motivo && (!auto?.respostaAutomatica || !RESPONDE_SOZINHA.includes(c.classificacao) || !c.sugestao_resposta)) return null;

  if (!motivo && (await db.respostasEnviadasNaConversa(lead.id)) >= auto.maxRespostasIA) {
    motivo = `a IA já respondeu ${auto.maxRespostasIA} vezes nesta conversa`;
  }
  if (motivo) {
    await db.atualizarResposta(respostaId, { precisa_humano: motivo });
    await enviarNotificacao(`${lead.nome} precisa de você`, `${motivo}\n\nÚltima mensagem:\n${c.resumo}\n\nSugestão da IA:\n${c.sugestao_resposta}`)
      .catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
    return { precisaHumano: motivo };
  }

  const destino = canal === "email" ? lead.email || de : lead.whatsapp || de;
  const mensagemId = await db.criarMensagem({
    lead_id: lead.id,
    canal,
    destino,
    assunto: canal === "email" ? (/^re:/i.test(assunto ?? "") ? assunto : `Re: ${assunto ?? ""}`) : null,
    corpo: c.sugestao_resposta,
    status: "aprovada",
    tipo: "resposta",
    etapa: 0,
    em_resposta_a: canal === "email" ? origem_id : null,
  });
  const espera = ESPERA_MIN_MS + Math.random() * (ESPERA_MAX_MS - ESPERA_MIN_MS);
  await db.atualizarMensagem(mensagemId, { agendada_para: new Date(Date.now() + espera).toISOString() });
  await db.atualizarResposta(respostaId, { mensagem_id: mensagemId, lida: true });
  log(`🤖 IA respondeu ${lead.nome} (${canal}); sai em ~${Math.round(espera / 60000)} min, em horário comercial`);
  return { mensagemId };
}

/**
 * Registra a resposta de um lead, classifica com a IA e aplica a ação certa:
 * descadastro → lista de supressão; sem interesse → encerra; interesse → avisa você.
 * Em qualquer resposta humana, as etapas pendentes são canceladas e, com a resposta
 * automática ligada, a IA continua a conversa rumo ao agendamento.
 */
export async function registrarResposta({ lead, canal, origem_id, de, assunto = null, texto, campanha, forcarHumano = null }) {
  if (origem_id && (await db.respostaJaRegistrada(origem_id))) return null;

  const limpo = limparTextoResposta(texto) || String(texto ?? "").slice(0, 2000);
  let c;
  try {
    // Ex.: áudio que não deu para transcrever: a sequência para e você responde.
    if (forcarHumano) throw new Error(forcarHumano);
    const historico = await db.historicoConversa(lead.id);
    c = await classificarResposta({
      texto: limpo, assunto, lead, historico, campanha, canal,
      linkAgendamento: linkAgendamento(campanha.automacao?.calendly, lead, canal),
    });
  } catch (e) {
    c = { classificacao: "outro", resumo: forcarHumano ? "Mandou um áudio." : `Não foi possível classificar automaticamente: ${e.message}`,
          sugestao_resposta: "", precisa_humano: true, motivo_humano: forcarHumano || "a IA não conseguiu ler esta resposta" };
  }

  const id = await db.criarResposta({
    lead_id: lead.id,
    canal,
    origem_id,
    de,
    assunto,
    texto: limpo,
    classificacao: c.classificacao,
    resumo: c.resumo,
    sugestao: c.sugestao_resposta || null,
  });
  if (!id) return null;

  switch (c.classificacao) {
    case "descadastro":
      await db.descadastrarLead(lead, `pediu por ${canal}`);
      break;
    case "sem_interesse":
      await db.cancelarPendentes(lead.id, "lead sem interesse");
      await db.atualizarLead(lead.id, { status: "sem_interesse" });
      break;
    case "automatica":
      break; // resposta automática não conta como resposta; a sequência continua valendo
    default:
      await db.cancelarPendentes(lead.id, "lead respondeu");
      if (lead.status !== "agendado") await db.atualizarLead(lead.id, { status: "respondeu" });
      if (c.classificacao === "interessado" || c.classificacao === "quer_informacoes") {
        await enviarNotificacao(
          `${lead.nome} respondeu (${c.classificacao.replace("_", " ")})`,
          `${c.resumo}\n\nResposta:\n${limpo}\n\nPróxima mensagem${campanha.automacao?.respostaAutomatica ? " (a IA vai enviar sozinha)" : " sugerida"}:\n${c.sugestao_resposta}\n\nContato: ${de}`
        ).catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
      }
      await responderSozinha({ respostaId: id, lead, canal, de, assunto, origem_id, c, campanha });
  }

  log(`💬 Resposta de ${lead.nome} por ${canal}: ${c.classificacao}`);
  return { id, ...c };
}
