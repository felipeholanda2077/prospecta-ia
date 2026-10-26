import { config } from "../config.js";
import * as db from "../db.js";
import { classificarResposta, limparTextoResposta } from "../ia/resposta.js";
import { enviarNotificacao } from "../envio/email.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

/**
 * Registra a resposta de um lead, classifica com a IA e aplica a ação certa:
 * descadastro → lista de supressão; sem interesse → encerra; interesse → avisa você.
 * Em qualquer resposta humana, follow-ups pendentes são cancelados.
 */
export async function registrarResposta({ lead, canal, origem_id, de, assunto = null, texto, mensagemOriginal, campanha }) {
  if (origem_id && (await db.respostaJaRegistrada(origem_id))) return null;

  const limpo = limparTextoResposta(texto) || String(texto ?? "").slice(0, 2000);
  let c;
  try {
    c = await classificarResposta({ texto: limpo, assunto, lead, mensagemOriginal, campanha });
  } catch (e) {
    c = { classificacao: "outro", resumo: `Não foi possível classificar automaticamente: ${e.message}`, sugestao_resposta: "" };
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
      break; // resposta automática não conta como resposta; o follow-up continua valendo
    default:
      await db.cancelarPendentes(lead.id, "lead respondeu");
      await db.atualizarLead(lead.id, { status: "respondeu" });
      if (c.classificacao === "interessado" || c.classificacao === "quer_informacoes") {
        await enviarNotificacao(
          `${lead.nome} respondeu (${c.classificacao.replace("_", " ")})`,
          `${c.resumo}\n\nResposta:\n${limpo}\n\nSugestão de retorno:\n${c.sugestao_resposta}\n\nContato: ${de}`
        ).catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
      }
  }

  log(`💬 Resposta de ${lead.nome} por ${canal}: ${c.classificacao}`);
  return { id, ...c };
}
