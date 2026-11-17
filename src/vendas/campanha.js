import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import * as db from "../db.js";
import { documentoEmPdf } from "../contratos/documento.js";
import { gravarApresentacao, lerApresentacao } from "../respostas/apresentacao.js";

// Campanha para quem demonstrou interesse: a promoção de Black Friday e, para quem parou de responder, um guia
// gratuito com o nome da empresa na marca-d'água. As mensagens vão para Aprovar mensagens: nada sai sem o seu clique.
const GUIA = new URL("../../config/guia-empresas.md", import.meta.url);
export const FIM_DA_PROMOCAO = "2026-11-30";
// Desde 17/11/2026 (pedido do usuário) a campanha oferece o que está em fluxdeck.com.br, sem o plano de R$ 3.000:
// o site por R$ 500 em até 12x e a IA no WhatsApp por R$ 497 + R$ 129,90/mês.
export const PROMOCAO = "Na Black Friday, só até 30/11, a gente faz o site da sua empresa de R$ 950 por R$ 500, valor único, em até 12x sem juros no cartão, pronto para aparecer no Google e com o botão do WhatsApp. E se quiser uma IA atendendo o seu WhatsApp 24 horas, sai por R$ 497 de implantação e R$ 129,90 por mês.";
// A linha antiga da apresentação (o plano de R$ 3.000), que sai do texto salvo se ainda estiver lá.
const LINHA_ANTIGA = /^.*Professional com IA[^\n]*R\$ ?3\.000.*$\n?/gim;
const DIAS_SEM_RESPOSTA = 2;
// Só estes canais aceitam mensagem iniciada pelo painel; o direct da Meta não.
const CANAIS = ["whatsapp", "email"];

const chaveDaCampanha = (leadId) => `campanha_black_friday:${leadId}`;

/** O guia em PDF, com o nome da empresa na capa, no cabeçalho e na marca-d'água. */
export async function pdfDoGuia(lead, { marca = "", cnpj = "" } = {}) {
  return documentoEmPdf(await readFile(GUIA, "utf8"), { marca, cnpj, projeto: lead.nome, tipo: "Guia prático", marcaDagua: `${marca} · ${lead.nome}` });
}

/**
 * A arte da promoção, enviada com a mensagem da campanha em áudio no WhatsApp até o fim dela.
 * Fora da campanha, ou depois de novembro, a mensagem sai só com o texto.
 */
export function imagemDaMensagem(m, agora = new Date()) {
  if (m.canal !== "whatsapp" || m.etapa !== 0 || !/Black Friday/i.test(m.corpo ?? "")) return null;
  if (agora.toLocaleDateString("en-CA", { timeZone: config.timezone }) > FIM_DA_PROMOCAO) return null;
  return ARTE_DA_OFERTA;
}

// A arte da oferta do site (de R$ 950 por R$ 500, em até 12x sem juros). Os arquivos antigos (a de R$ 3.000) foram
// trocados por esta mesma arte, para nenhum link antigo mostrar o valor errado.
export const ARTE_DA_OFERTA = `${config.painel.urlPublica}/whatsapp-black-friday-500.jpg`;

// De escrito para falado: como uma pessoa fala num áudio de WhatsApp. O que a pessoa editar no painel e não
// casar com estas frases continua igual, só com os valores por extenso e o "pra".
const JEITO_DE_FALAR = [
  [/:?\s*https?:\/\/\S+/g, ". Deixei o link aqui na conversa, tá?"],
  [/Preparei um guia prático e gratuito para a ([^,]+), com passos simples para atrair mais clientes pelo site, pelo Google e pelo WhatsApp/g, "Olha, eu preparei um guia gratuito pra $1, bem prático, com uns passos simples pra atrair mais clientes, pelo site, pelo Google e pelo WhatsApp"],
  [/E um aviso: na Black Friday, só até 30\/11, a gente faz/g, "E aproveitando: agora na Black Friday, até o dia trinta, a gente tá fazendo"],
  [/Na Black Friday, só até 30\/11, a gente faz/g, "Olha, agora na Black Friday, até o dia trinta, a gente tá fazendo"],
  [/de R\$ 950 por R\$ 500, valor único, em até 12x sem juros no cartão/g, "de novecentos e cinquenta por quinhentos reais, um valor só, e dá pra parcelar em até doze vezes sem juros no cartão"],
  [/sai por R\$ 497 de implantação e R\$ 129,90 por mês\./g, "sai por quatrocentos e noventa e sete reais pra começar e cento e vinte e nove e noventa por mês."],
  [/24 horas/g, "vinte e quatro horas"],
  [/Se fizer sentido, me responde aqui que eu explico como funciona\./g, "Se fizer sentido, me responde aqui que eu te explico direitinho como funciona."],
  [/Se preferir não receber mais mensagens, é só avisar\./g, "E se preferir não receber mais mensagem, é só me avisar, tá bom? Um abraço!"],
  [/R\$ 500/g, "quinhentos reais"],
  [/R\$ 950/g, "novecentos e cinquenta reais"],
  [/\bpara\b/g, "pra"],
  [/\.\s*\./g, "."],
];

/** O que a voz fala: o texto da mensagem no jeito de um áudio, sem o link, que não dá para falar. */
export const roteiroDoAudio = (corpo) => JEITO_DE_FALAR.reduce((t, [de, para]) => t.replace(de, para), corpo);

/** A legenda da arte: só o link, quando a mensagem tem um, porque o resto vai no áudio. */
export function legendaDaArte(corpo) {
  const [link] = corpo.match(/https?:\/\/\S+/) ?? [];
  return link ? `Seu guia gratuito: ${link}` : "";
}

export const enderecoDoGuia = (lead) => `${config.painel.urlPublica}/guia/${lead.token}`;

/**
 * A IA informa a promoção nas conversas pela oferta do site, que entra sozinha na apresentação (vendas/ofertaSite.js).
 * Aqui só sai do texto salvo a linha antiga do plano de R$ 3.000, se ela ainda estiver lá. Retorna se mudou.
 */
export async function garantirPromocaoNaApresentacao() {
  const texto = await lerApresentacao(null, { comOferta: false });
  const limpo = texto.replace(LINHA_ANTIGA, "");
  if (limpo === texto) return false;
  await gravarApresentacao(limpo);
  return true;
}

/** Quem conta como "parou de responder": a última palavra foi nossa, ou a dela já tem alguns dias. */
export function parouDeResponder({ ultima_resposta: resposta, ultimo_envio: envio }, agora = new Date()) {
  if (envio && new Date(envio) > new Date(resposta)) return true;
  return +agora - +new Date(resposta) >= DIAS_SEM_RESPOSTA * 86_400_000;
}

export function mensagemDaCampanha({ lead, comGuia, responsavel = "", empresa = "" }) {
  const quem = responsavel ? `Aqui é o ${responsavel}${empresa ? `, da ${empresa}` : ""}.` : `Aqui é da ${empresa}.`;
  const promocao = PROMOCAO;
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
    if (i.pais && i.pais !== "BR") {
      fora.push({ empresa: i.nome, motivo: "empresa de fora do Brasil (a mensagem da campanha é em português e em reais)" });
      continue;
    }
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
      lead_id: i.id, canal: i.canal, destino, assunto: i.canal === "email" ? (comGuia ? `Um guia para a ${i.nome}, e a Black Friday` : "Black Friday: o site da sua empresa por R$ 500, em até 12x sem juros") : null,
      corpo: mensagemDaCampanha({ lead: i, comGuia, responsavel: campanha.empresa.responsavel, empresa: campanha.empresa.nome }),
      status: "rascunho", tipo: "resposta", etapa: 0,
    });
    await db.gravarEstado(chaveDaCampanha(i.id), agora.toISOString());
    criadas.push({ empresa: i.nome, comGuia });
  }
  return { criadas, fora, iaAtualizada };
}
