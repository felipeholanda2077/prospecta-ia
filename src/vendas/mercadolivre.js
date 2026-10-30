import { config } from "../config.js";
import * as db from "../db.js";
import * as ml from "../envio/mercadolivre.js";
import { enviarNotificacao } from "../envio/email.js";
import { escreverRespostaDoMarketplace } from "../ia/marketplace.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// A IA só sugere: a resposta sai quando o vendedor aprova no painel. Cada passagem escreve poucas sugestões,
// para caber no tempo da execução; as outras ficam para a passagem seguinte.
const SUGESTOES_POR_PASSAGEM = 5;

const TEM_LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|br)\b)/i;
const TEM_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const TEM_TELEFONE = /(\+?\d[\s().-]*){8,}/;
const TEM_REDE = /\b(whats\s?app|zap|wpp|telegram|instagram|facebook|direct|meu\s+insta)\b/i;

/** O que impede a resposta de sair: o Mercado Livre pune contato e link. Retorna o motivo, ou null. */
export function problemaNaResposta(texto) {
  const t = String(texto ?? "").trim();
  if (!t) return "Escreva a resposta.";
  if (t.length > ml.MAX_RESPOSTA) return `A resposta passou de ${ml.MAX_RESPOSTA} caracteres.`;
  if (/\[COMPLETAR\]/i.test(t)) return "Complete o que está marcado com [COMPLETAR] antes de enviar.";
  if (TEM_EMAIL.test(t) || TEM_LINK.test(t)) return "Tire o link ou e-mail: o Mercado Livre pune contato fora da plataforma.";
  if (TEM_TELEFONE.test(t)) return "Tire o telefone ou número longo: o Mercado Livre pune contato fora da plataforma.";
  if (TEM_REDE.test(t)) return "Tire a menção a WhatsApp ou rede social: o Mercado Livre pune contato fora da plataforma.";
  return null;
}

async function sugerir(pergunta, { api, escrever, agora, loja }) {
  const anuncio = await api.dadosDoAnuncio(pergunta.item_id, agora);
  const s = await escrever({ pergunta: pergunta.texto, anuncio, loja });
  await db.atualizarPerguntaML(pergunta.id, {
    item_titulo: anuncio.titulo, item_link: anuncio.link, rascunho: s.texto, precisa_conferir: Boolean(s.precisa_conferir), motivo: s.motivo || null, erro: null,
  });
}

/**
 * Traz as perguntas novas, escreve as sugestões e avisa por e-mail. Pergunta respondida direto no site do
 * Mercado Livre sai da fila sozinha. A cada 10 minutos, e também quando o Mercado Livre avisa.
 */
export async function rodadaDoMercadoLivre(campanha, { api = ml, escrever = escreverRespostaDoMarketplace, avisar = enviarNotificacao, agora = new Date() } = {}) {
  if (!(await api.estaConectado())) return { mercadolivre: "desconectado" };
  if (!(await db.travar("mercadolivre_rodada", 4 * 60_000))) return { mercadolivre: "em andamento" };
  try {
    const abertas = await api.perguntasSemResposta(agora);
    const idsAbertos = new Set(abertas.map((q) => String(q.id)));
    const novas = [];
    for (const q of abertas) {
      const inserida = await db.inserirPerguntaML({ id: String(q.id), item_id: q.item_id, texto: q.text ?? "", criada_em: q.date_created ?? agora.toISOString() });
      if (inserida) novas.push(q);
    }
    const pendentes = await db.perguntasML("pendente");
    for (const p of pendentes) if (!idsAbertos.has(p.id)) await db.atualizarPerguntaML(p.id, { status: "fora" });

    // A loja é a da conta conectada, que pode não ser a empresa dona do painel.
    const loja = await api.apelidoDaLoja();
    let sugeridas = 0;
    for (const p of pendentes.filter((x) => idsAbertos.has(x.id) && !x.rascunho).slice(0, SUGESTOES_POR_PASSAGEM)) {
      try {
        await sugerir(p, { api, escrever, agora, loja });
        sugeridas++;
      } catch (e) {
        await db.atualizarPerguntaML(p.id, { erro: e.message });
        log(`⚠️  Mercado Livre: sem sugestão para a pergunta ${p.id}: ${e.message}`);
      }
    }
    if (novas.length) {
      await avisar(
        novas.length === 1 ? "Pergunta nova no Mercado Livre" : `${novas.length} perguntas novas no Mercado Livre`,
        `${novas.slice(0, 5).map((q) => `- ${q.text}`).join("\n")}\n\nResponder rápido ajuda a vender. A resposta sugerida está em ${config.painel.urlPublica}/#marketplaces.`
      ).catch((e) => log(`⚠️  Não foi possível avisar da pergunta: ${e.message}`));
    }
    return { mercadolivre: "ok", abertas: abertas.length, novas: novas.length, sugeridas };
  } finally {
    await db.destravar("mercadolivre_rodada");
  }
}

/** Refaz a sugestão de uma pergunta. */
export async function refazerSugestao(id, campanha, { api = ml, escrever = escreverRespostaDoMarketplace, agora = new Date() } = {}) {
  const p = await db.perguntaML(id);
  if (!p) throw new Error("Pergunta não encontrada");
  await sugerir(p, { api, escrever, agora, loja: await api.apelidoDaLoja() });
  return db.perguntaML(id);
}

const PERGUNTA_DE_TESTE = "Qual é o prazo de garantia e vocês entregam em todo o Brasil?";

/** Testa a leitura do anúncio e a sugestão com uma pergunta de exemplo. Nada é salvo nem enviado ao Mercado Livre. */
export async function testarSugestao({ api = ml, escrever = escreverRespostaDoMarketplace, agora = new Date() } = {}) {
  const itemId = await api.primeiroAnuncio(agora);
  if (!itemId) throw new Error("A conta não tem anúncio ativo para testar.");
  const anuncio = await api.dadosDoAnuncio(itemId, agora);
  const s = await escrever({ pergunta: PERGUNTA_DE_TESTE, anuncio, loja: await api.apelidoDaLoja() });
  return { anuncio: anuncio.titulo, link: anuncio.link, pergunta: PERGUNTA_DE_TESTE, resposta: s.texto, precisaConferir: Boolean(s.precisa_conferir), motivo: s.motivo || null, barrada: problemaNaResposta(s.texto) };
}

/** Envia ao comprador o texto que o vendedor aprovou. */
export async function enviarResposta(id, texto, { api = ml, agora = new Date() } = {}) {
  const p = await db.perguntaML(id);
  if (!p) throw new Error("Pergunta não encontrada");
  if (p.status !== "pendente") throw new Error("Essa pergunta já saiu da fila");
  const problema = problemaNaResposta(texto);
  if (problema) throw new Error(problema);
  // Dois cliques não mandam a resposta duas vezes.
  if (!(await db.travar(`mercadolivre_resposta_${id}`, 30_000))) throw new Error("Essa resposta já está sendo enviada");
  await api.responderPergunta(id, String(texto).trim(), agora);
  await db.atualizarPerguntaML(id, { status: "respondida", resposta: String(texto).trim(), respondida_em: agora.toISOString(), erro: null });
  log(`🛒 Pergunta ${id} respondida no Mercado Livre`);
}
