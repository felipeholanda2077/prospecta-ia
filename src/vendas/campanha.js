import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import * as db from "../db.js";
import { documentoEmPdf } from "../contratos/documento.js";
import { gravarApresentacao, lerApresentacao } from "../respostas/apresentacao.js";

// Campanha para quem demonstrou interesse: a promoção de Black Friday e, para quem parou de responder, um guia
// gratuito com o nome da empresa na marca-d'água. As mensagens vão para Aprovar mensagens: nada sai sem o seu clique.
const GUIA = new URL("../../config/guia-empresas.md", import.meta.url);
export const FIM_DA_PROMOCAO = "2026-11-30";
export const LINHA_DA_PROMOCAO = "Promoção de Black Friday (só em novembro de 2026): Professional com IA de atendimento no WhatsApp de R$ 4.500/mês por R$ 3.000/mês.";
const DIAS_SEM_RESPOSTA = 2;
// Só estes canais aceitam mensagem iniciada pelo painel; o direct da Meta não.
const CANAIS = ["whatsapp", "email"];

const chaveDaCampanha = (leadId) => `campanha_black_friday:${leadId}`;

/** O guia em PDF, com o nome da empresa na capa, no cabeçalho e na marca-d'água. */
export async function pdfDoGuia(lead, { marca = "", cnpj = "" } = {}) {
  return documentoEmPdf(await readFile(GUIA, "utf8"), { marca, cnpj, projeto: lead.nome, tipo: "Guia prático", marcaDagua: `${marca} · ${lead.nome}` });
}

export const enderecoDoGuia = (lead) => `${config.painel.urlPublica}/guia/${lead.token}`;

/** A IA passa a informar a promoção nas conversas. Repetir não duplica. */
export async function garantirPromocaoNaApresentacao() {
  const texto = await lerApresentacao();
  if (texto.includes("R$ 3.000")) return false;
  const linhas = texto.split("\n");
  const posicao = linhas.findIndex((l) => /^Promoção de Black Friday/i.test(l.trim()));
  linhas.splice(posicao >= 0 ? posicao + 1 : linhas.length, 0, LINHA_DA_PROMOCAO);
  await gravarApresentacao(linhas.join("\n"));
  return true;
}

/** Quem conta como "parou de responder": a última palavra foi nossa, ou a dela já tem alguns dias. */
export function parouDeResponder({ ultima_resposta: resposta, ultimo_envio: envio }, agora = new Date()) {
  if (envio && new Date(envio) > new Date(resposta)) return true;
  return +agora - +new Date(resposta) >= DIAS_SEM_RESPOSTA * 86_400_000;
}

export function mensagemDaCampanha({ lead, comGuia, responsavel = "", empresa = "" }) {
  const quem = responsavel ? `Aqui é o ${responsavel}${empresa ? `, da ${empresa}` : ""}.` : `Aqui é da ${empresa}.`;
  const promocao = "Na Black Friday, só em novembro, o plano Professional com IA de atendimento no WhatsApp sai de R$ 4.500 por R$ 3.000 por mês.";
  const fim = "Se fizer sentido, me responde aqui que eu explico como funciona. Se preferir não receber mais mensagens, é só avisar.";
  return comGuia
    ? `Oi, tudo bem? ${quem} Preparei um guia prático e gratuito para a ${lead.nome}, com passos simples para atrair mais clientes pelo site, pelo Google e pelo WhatsApp: ${enderecoDoGuia(lead)}\n\nE um aviso: ${promocao.charAt(0).toLowerCase()}${promocao.slice(1)}\n\n${fim}`
    : `Oi, tudo bem? ${quem} ${promocao}\n\n${fim}`;
}

/** Cria os rascunhos para quem demonstrou interesse. Quem já entrou na campanha não entra de novo. */
export async function prepararCampanha(campanha, agora = new Date()) {
  const hoje = agora.toLocaleDateString("en-CA", { timeZone: config.timezone });
  if (hoje > FIM_DA_PROMOCAO) return { erro: "A promoção de Black Friday já terminou." };
  const iaAtualizada = await garantirPromocaoNaApresentacao();
  const criadas = [];
  const fora = [];
  for (const i of await db.interessadosDaCampanha()) {
    if (await db.lerEstado(chaveDaCampanha(i.id))) continue;
    if (!CANAIS.includes(i.canal)) {
      fora.push({ empresa: i.nome, motivo: "conversa pelo direct do Instagram, que só aceita resposta em até 24 horas" });
      continue;
    }
    const destino = i.de || (i.canal === "email" ? i.email : i.whatsapp);
    if (!destino) {
      fora.push({ empresa: i.nome, motivo: "sem contato salvo" });
      continue;
    }
    if (await db.estaDescadastrado(destino)) continue;
    const comGuia = parouDeResponder(i, agora);
    await db.criarMensagem({
      lead_id: i.id, canal: i.canal, destino, assunto: i.canal === "email" ? (comGuia ? `Um guia para a ${i.nome}, e a Black Friday` : "Black Friday: Professional com IA por R$ 3.000/mês") : null,
      corpo: mensagemDaCampanha({ lead: i, comGuia, responsavel: campanha.empresa.responsavel, empresa: campanha.empresa.nome }),
      status: "rascunho", tipo: "resposta", etapa: 0,
    });
    await db.gravarEstado(chaveDaCampanha(i.id), agora.toISOString());
    criadas.push({ empresa: i.nome, comGuia });
  }
  return { criadas, fora, iaAtualizada };
}
