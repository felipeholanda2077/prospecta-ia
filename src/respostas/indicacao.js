import { config } from "../config.js";
import * as db from "../db.js";
import { mensagemParaIndicado } from "../ia/resposta.js";
import { enviarNotificacao } from "../envio/email.js";
import { variantesWhatsappBR } from "../analise/telefone.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// A IA escreve para o contato indicado alguns minutos depois de agradecer quem indicou.
const ESPERA_MIN_MS = 4 * 60 * 1000;
const ESPERA_MAX_MS = 9 * 60 * 1000;
const MAX_CONTATOS_POR_MENSAGEM = 2;

/**
 * Lê os contatos de um ou mais vCards (o "cartão de contato" do WhatsApp).
 * Prefere o número do `waid`, que é o próprio WhatsApp da pessoa.
 * Retorna [{ nome, empresa, numero }].
 */
export function extrairContatosVcard(vcards) {
  const contatos = [];
  for (const vcard of [vcards].flat().filter(Boolean)) {
    const texto = String(vcard).replace(/\r\n[ \t]/g, "");
    const campo = (nome) => texto.match(new RegExp(`^(?:item\\d+\\.)?${nome}[^:\\n]*:(.*)$`, "im"))?.[1]?.trim() ?? "";
    const nome = campo("FN") || campo("N").split(";").filter(Boolean).reverse().join(" ");
    const empresa = campo("X-WA-BIZ-NAME") || campo("ORG").replace(/;+$/, "");
    for (const linha of texto.matchAll(/^(?:item\d+\.)?TEL([^:\n]*):(.*)$/gim)) {
      const numero = (linha[1].match(/waid=(\d+)/i)?.[1] ?? linha[2]).replace(/\D/g, "");
      if (numero.length >= 10) contatos.push({ nome, empresa, numero: numero.length <= 11 ? `55${numero}` : numero });
    }
  }
  return contatos.filter((c, i, lista) => lista.findIndex((x) => x.numero === c.numero) === i);
}

/**
 * Alguém da empresa prospectada mandou o contato de outra pessoa (ex.: "fale com o setor
 * administrativo"). A IA escreve para essa pessoa citando a indicação, e a conversa com
 * ela segue igual às outras (respostas, IA, agendamento).
 */
export async function contatarIndicados({ lead, contatos, de, nomeDeQuemIndicou, campanha, escrever = mensagemParaIndicado }) {
  const feitos = [];
  for (const contato of contatos.slice(0, MAX_CONTATOS_POR_MENSAGEM)) {
    const variantes = variantesWhatsappBR(contato.numero);
    if (variantes.some((v) => variantesWhatsappBR(de).includes(v))) continue; // mandou o próprio número
    if (await db.estaDescadastrado(contato.numero)) continue;
    if ((await Promise.all(variantes.map((v) => db.contatoJaUsado(v)))).some(Boolean)) continue; // já falamos com ele

    if (!campanha.automacao?.respostaAutomatica) {
      await enviarNotificacao(`${lead.nome} indicou um contato`,
        `Indicaram ${contato.nome || "um contato"} (${contato.numero}). Ligue a resposta automática em Automação para a IA escrever sozinha, ou fale você.`)
        .catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
      continue;
    }

    const corpo = await escrever({
      lead, contato, nomeDeQuemIndicou, campanha, historico: await db.historicoConversa(lead.id),
    });
    const id = await db.criarMensagem({
      lead_id: lead.id, canal: "whatsapp", destino: contato.numero, corpo, status: "aprovada", tipo: "resposta", etapa: 0,
    });
    const espera = ESPERA_MIN_MS + Math.random() * (ESPERA_MAX_MS - ESPERA_MIN_MS);
    await db.atualizarMensagem(id, { agendada_para: new Date(Date.now() + espera).toISOString() });
    await db.atualizarLead(lead.id, { observacao: `Indicou ${contato.nome || "um contato"} (${contato.numero}); a IA vai falar com essa pessoa` });
    log(`🤝 ${lead.nome} indicou ${contato.nome || contato.numero}; a IA escreve em ~${Math.round(espera / 60000)} min`);
    feitos.push({ ...contato, mensagemId: id });
  }
  return feitos;
}
