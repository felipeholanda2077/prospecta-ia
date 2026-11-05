import * as db from "../db.js";
import { normalizarTelefoneBR, variantesWhatsappBR } from "../analise/telefone.js";
import { escreverPrimeiroContato, pediuValor, semValores } from "../ia/resposta.js";
import { enviarMensagem, modoWhatsapp } from "../pipeline.js";
import { linkWhatsapp } from "../envio/whatsapp.js";

// "Conversar com um número" (tela Respostas): você passa um WhatsApp, a IA escreve a primeira mensagem, você revisa
// e envia. A partir daí é uma conversa como as da prospecção: quando a pessoa responder, a IA continua.

const limpar = (v, max) => String(v ?? "").trim().slice(0, max);

/** Cria (ou acha) o contato e devolve a mensagem que a IA escreveu, ainda sem enviar. */
export async function rascunhoParaNumero(dados, campanha, { escrever = escreverPrimeiroContato } = {}) {
  const numero = normalizarTelefoneBR(dados?.numero);
  if (!numero) throw new Error("Número inválido: use DDD + número, por exemplo (11) 94342-7726");
  const variantes = variantesWhatsappBR(numero);
  for (const v of variantes) if (await db.estaDescadastrado(v)) throw new Error("Esse número pediu para não receber mensagens");
  const nome = limpar(dados.nome, 80);
  const empresa = limpar(dados.empresa, 120);
  const contexto = limpar(dados.contexto, 1000);

  let lead = await db.leadPorContato({ whatsapps: variantes });
  if (lead?.agente_id) throw new Error("Esse número conversa com um agente: responda pela conversa dele");
  if (!lead) {
    const id = await db.criarLeadDeContato({
      nome: empresa || nome || "Contato do WhatsApp", whatsapp: numero, origem: "manual",
      observacao: `Conversa iniciada pelo painel${nome && empresa ? ` com ${nome}` : ""}${contexto ? `: ${contexto}` : ""}`,
    });
    await db.atualizarLead(id, { status: "proposta_gerada" });
    lead = await db.buscarLead(id);
  }
  const historico = await db.historicoConversa(lead.id);
  const texto = await escrever({ lead, nome, empresa, contexto, historico, campanha });
  return { leadId: lead.id, nome: lead.nome, whatsapp: lead.whatsapp, jaConversou: historico.length > 0, texto: pediuValor("", historico) ? texto : semValores(texto) };
}

/** Envia a mensagem revisada. Contato que já conversou recebe como resposta da conversa (sem contar como empresa nova). */
export async function enviarParaNumero(leadId, texto, campanha) {
  const lead = await db.buscarLead(Number(leadId));
  if (!lead?.whatsapp) throw new Error("Contato não encontrado");
  const corpo = String(texto ?? "").trim();
  if (!corpo) throw new Error("Escreva a mensagem antes de enviar");
  const jaConversou = (await db.historicoConversa(lead.id)).length > 0;
  const id = await db.criarMensagem({
    lead_id: lead.id, canal: "whatsapp", destino: lead.whatsapp, corpo, status: "aprovada",
    tipo: jaConversou ? "resposta" : "inicial", etapa: jaConversou ? 0 : 1,
  });
  if ((await modoWhatsapp()) === "manual") {
    return { enviada: false, manual: true, id, linkWhatsapp: linkWhatsapp(lead.whatsapp, corpo, false), motivo: "envie pelo seu WhatsApp" };
  }
  return { id, ...(await enviarMensagem(await db.buscarMensagem(id), campanha)) };
}
