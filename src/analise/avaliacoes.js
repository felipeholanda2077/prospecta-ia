import { buscarNaSerpApi, podeBuscarSozinho, cortar } from "../descoberta/anuncios.js";

// Avaliações recentes do Google sem resposta da empresa: um problema concreto e visível para abrir a conversa
// ("das 9 avaliações dos últimos 3 meses, 6 estão sem resposta"). A API do Google não mostra a resposta do dono;
// a SerpApi mostra. Gasta 1 busca por empresa, dentro da cota das avaliações no limite do mês.
const DIAS_RECENTES = 90;
// Reclamação de atendimento: o cliente não conseguiu falar com a empresa (WhatsApp, telefone, demora, sem retorno).
// (Só "demora" sozinha não conta: "o prato demorou" é outra coisa.)
const RECLAMA_DE_ATENDIMENTO = /whats|zap\b|telefone|liguei|ligacao|ligação|n[aã]o (me )?(respond|atend|retorn)|sem (resposta|retorno)|demor\w* (pra|para|a|em) (responder|atender|retornar)|v[aá]cuo|ningu[eé]m atend|visualiz/i;
export const MIN_AVALIACOES = 5;

/** O resumo das avaliações mais novas: quantas recentes, quantas sem resposta, quantas negativas sem resposta. */
export function resumoDasAvaliacoes(avaliacoes, agora = new Date()) {
  const desde = +agora - DIAS_RECENTES * 86_400_000;
  const lidas = (avaliacoes ?? []).filter((a) => a?.iso_date);
  const recentes = lidas.filter((a) => Date.parse(a.iso_date) >= desde);
  const semResposta = recentes.filter((a) => !a.response?.snippet);
  const negativas = semResposta.filter((a) => Number(a.rating) <= 3);
  const respostas = lidas.map((a) => a.response?.iso_date).filter(Boolean).sort();
  const reclamacoes = lidas.filter((a) => Number(a.rating) <= 3 && RECLAMA_DE_ATENDIMENTO.test(String(a.snippet ?? "")));
  return {
    lidas: lidas.length,
    recentes: recentes.length,
    semResposta: semResposta.length,
    negativasSemResposta: negativas.length,
    ultimaResposta: respostas.at(-1) ?? null,
    exemploNegativa: negativas[0]?.snippet ? cortar(negativas[0].snippet.replace(/\s+/g, " "), 160) : null,
    reclamamDeAtendimento: reclamacoes.length,
  };
}

/** Só o place_id do Google (as outras fontes usam "ig:", "cnpj:", "ad:"...). */
export const ehLugarDoGoogle = (placeId) => /^[A-Za-z0-9_-]{20,}$/.test(String(placeId ?? ""));

/** As avaliações da empresa no Google, resumidas; null sem SerpApi, sem cota ou sem avaliações bastantes. */
export async function avaliacoesDoGoogle(lead, { agora = new Date() } = {}) {
  if (!ehLugarDoGoogle(lead.place_id) || !(Number(lead.total_avaliacoes) >= MIN_AVALIACOES)) return null;
  if (!(await podeBuscarSozinho(agora, "avaliacoes"))) return null;
  const { dados } = await buscarNaSerpApi({ engine: "google_maps_reviews", place_id: lead.place_id, hl: "pt-br", sort_by: "newestFirst" }, { fonte: "avaliacoes", agora });
  return dados ? resumoDasAvaliacoes(dados.reviews, agora) : null;
}

/** A oportunidade que as avaliações mostram (ou null): várias recentes sem resposta, ou alguma negativa sem resposta. */
export function oportunidadeDasAvaliacoes(r) {
  // Cliente reclamando que não consegue falar com a empresa é a dor mais forte para o atendimento automático.
  if (r?.reclamamDeAtendimento >= 1) {
    return {
      servico: "automacao",
      motivo: `${r.reclamamDeAtendimento} ${r.reclamamDeAtendimento === 1 ? "avaliação negativa no Google reclama" : "avaliações negativas no Google reclamam"} de demora ou de não conseguir falar com a empresa (WhatsApp, telefone, retorno); atendimento automático responde na hora, a qualquer horário`,
      peso: 11,
    };
  }
  if (!r || !(r.semResposta >= 3 || r.negativasSemResposta >= 1)) return null;
  const negativas = r.negativasSemResposta ? ` (${r.negativasSemResposta} ${r.negativasSemResposta === 1 ? "negativa" : "negativas"})` : "";
  return {
    servico: "automacao",
    motivo: `das ${r.recentes} avaliações dos últimos 3 meses no Google, ${r.semResposta} estão sem resposta da empresa${negativas}; dá para responder cada uma com IA e pedir avaliação a cada cliente atendido`,
    peso: r.negativasSemResposta ? 9 : 7,
  };
}
