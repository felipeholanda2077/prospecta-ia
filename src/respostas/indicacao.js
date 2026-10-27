import { config } from "../config.js";
import * as db from "../db.js";
import { mensagemParaIndicado } from "../ia/resposta.js";
import { enviarNotificacao } from "../envio/email.js";
import { variantesWhatsappBR } from "../analise/telefone.js";
import { normalizarContato } from "../db.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// A IA escreve para o contato indicado alguns minutos depois de agradecer quem indicou.
const ESPERA_MIN_MS = 4 * 60 * 1000;
const ESPERA_MAX_MS = 9 * 60 * 1000;
const MAX_CONTATOS_POR_MENSAGEM = 2;

/** Número de WhatsApp com DDI: "(11) 96548-1483" vira 5511965481483. */
export function normalizarNumeroIndicado(valor) {
  const d = String(valor ?? "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 11 ? `55${d}` : d;
}

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
      const numero = normalizarNumeroIndicado(linha[1].match(/waid=(\d+)/i)?.[1] ?? linha[2]);
      if (numero.length >= 12) contatos.push({ canal: "whatsapp", nome, empresa, numero });
    }
  }
  return contatos.filter((c, i, lista) => lista.findIndex((x) => x.numero === c.numero) === i);
}

const EMAIL_NO_TEXTO = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Celular ou fixo com DDD: "11 97204-9065", "(11) 3456-7890", "+55 11 972049065".
const TELEFONE_NO_TEXTO = /(?:\+?55[\s.-]?)?\(?\b[1-9]{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g;

/**
 * Contatos que a pessoa escreveu na mensagem para tratar do assunto (ex.: "fale com o
 * comercial: contato@empresa.com.br, responsável Celso"). Ignora os endereços de quem escreveu.
 * Retorna [{ canal: "email", email } | { canal: "whatsapp", numero }].
 */
export function contatosNoTexto(texto, ignorar = []) {
  const t = String(texto ?? "").replace(/^>.*$/gm, ""); // sem o histórico citado
  const ja = new Set(ignorar.filter(Boolean).flatMap((c) => [normalizarContato(c), ...variantesWhatsappBR(c)]));
  const contatos = [];
  for (const [email] of t.matchAll(EMAIL_NO_TEXTO)) {
    const e = email.toLowerCase();
    if (!ja.has(e) && !contatos.some((c) => c.email === e)) contatos.push({ canal: "email", email: e, nome: "", empresa: "" });
  }
  for (const [tel] of t.replace(EMAIL_NO_TEXTO, " ").matchAll(TELEFONE_NO_TEXTO)) {
    const numero = normalizarNumeroIndicado(tel);
    if (numero.length < 12 || variantesWhatsappBR(numero).some((v) => ja.has(v))) continue;
    if (!contatos.some((c) => c.numero === numero)) contatos.push({ canal: "whatsapp", numero, nome: "", empresa: "" });
  }
  return contatos;
}

/**
 * Alguém da empresa prospectada mandou o contato de outra pessoa (ex.: "fale com o setor
 * administrativo"). A IA escreve para essa pessoa citando a indicação, e a conversa com
 * ela segue igual às outras (respostas, IA, agendamento).
 */
export async function contatarIndicados({
  lead, contatos, de = "", nomeDeQuemIndicou = null, textoDaIndicacao = "", campanha, escrever = mensagemParaIndicado,
  manual = false, // informado por você no painel: escreve mesmo com a resposta automática desligada, e mais rápido
}) {
  const feitos = [];
  const ignorados = [];
  for (const contato of contatos.slice(0, MAX_CONTATOS_POR_MENSAGEM)) {
    const canal = contato.canal ?? "whatsapp";
    const destino = canal === "email" ? contato.email : contato.numero;
    const variantes = canal === "email" ? [normalizarContato(destino)] : variantesWhatsappBR(destino);
    const pular = (motivo) => ignorados.push({ ...contato, motivo });
    if (de && variantes.some((v) => [normalizarContato(de), ...variantesWhatsappBR(de)].includes(v))) { pular("é o próprio contato de quem indicou"); continue; }
    if (await db.estaDescadastrado(destino)) { pular("esse contato pediu para não receber mensagens"); continue; }
    if ((await Promise.all(variantes.map((v) => db.contatoJaUsado(v)))).some(Boolean)) { pular("já existe conversa com esse contato"); continue; }

    if (!manual && !campanha.automacao?.respostaAutomatica) {
      await enviarNotificacao(`${lead.nome} indicou um contato`,
        `Indicaram ${contato.nome || "um contato"} (${destino}). Ligue a resposta automática em Automação para a IA escrever sozinha, ou fale você.`)
        .catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
      continue;
    }

    const escrita = await escrever({
      lead, contato, canal, nomeDeQuemIndicou, textoDaIndicacao, campanha, historico: await db.historicoConversa(lead.id),
    });
    const { assunto = null, mensagem: corpo } = typeof escrita === "string" ? { mensagem: escrita } : escrita;
    const id = await db.criarMensagem({
      lead_id: lead.id, canal, destino, assunto: canal === "email" ? assunto || `Indicação da ${lead.nome}` : null,
      corpo, status: "aprovada", tipo: "resposta", etapa: 0,
    });
    const espera = manual ? 60_000 : ESPERA_MIN_MS + Math.random() * (ESPERA_MAX_MS - ESPERA_MIN_MS);
    await db.atualizarMensagem(id, { agendada_para: new Date(Date.now() + espera).toISOString() });
    await db.atualizarLead(lead.id, { observacao: `Indicou ${contato.nome || "um contato"} (${destino}); a IA vai falar com essa pessoa` });
    log(`🤝 ${lead.nome} indicou ${contato.nome || destino} (${canal}); a IA escreve em ~${Math.round(espera / 60000)} min`);
    feitos.push({ ...contato, mensagemId: id, corpo, agendadaPara: new Date(Date.now() + espera).toISOString() });
  }
  // Chamadas antigas esperam só a lista dos feitos; o painel lê também os ignorados.
  return Object.assign(feitos, { ignorados });
}
