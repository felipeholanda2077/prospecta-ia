import { z } from "zod";
import { config } from "../config.js";
import { gerarJson } from "./cliente.js";
import { contextoEmpresa, identidade } from "./proposta.js";
import { ABORDAGEM_PRINCIPAL } from "./abordagens.js";
import { OFERTA_SITE, ofertaSiteAtiva, PRECO_DE, PRECO_POR, VALOR_DA_OFERTA, VALOR_DO_SITE_EUROPA } from "../vendas/ofertaSite.js";
import { podeTerPrevia } from "../vendas/previa.js";
import { PAISES } from "../internacional.js";

/** Data de hoje, para a IA saber se uma promoção (ex.: a de novembro) ainda vai começar, está valendo ou acabou. */
const hoje = () => new Date().toLocaleDateString("pt-BR", { timeZone: config.timezone, day: "numeric", month: "long", year: "numeric" });

export const CLASSIFICACOES = ["interessado", "quer_informacoes", "sem_interesse", "descadastro", "automatica", "outro"];
export const TEMPERATURAS = ["quente", "morna", "fria"];

const ClassificacaoSchema = z.object({
  classificacao: z.enum(CLASSIFICACOES),
  resumo: z.string(),
  sugestao_resposta: z.string(),
  precisa_humano: z.boolean(),
  motivo_humano: z.string(),
  indicou_contato: z.boolean(),
  temperatura: z.enum(TEMPERATURAS),
  proximo_passo: z.string(),
  robo: z.boolean(),
  encerrar: z.boolean(),
  dor_entendida: z.boolean(),
  pediu_conversa: z.boolean(),
});

const CLASSIFICACAO_JSON_SCHEMA = {
  type: "object",
  properties: {
    classificacao: {
      type: "string",
      enum: CLASSIFICACOES,
      description:
        "interessado = quer conversar/orçamento; quer_informacoes = fez perguntas (preço, prazo, exemplos); " +
        "sem_interesse = recusou educadamente; descadastro = pediu para não ser mais contatado; " +
        "automatica = resposta automática (férias, ausência, recebemos seu e-mail); outro = qualquer outra coisa",
    },
    resumo: { type: "string", description: "1 frase com o que a pessoa disse" },
    precisa_humano: {
      type: "boolean",
      description: "true quando a conversa deve passar para o vendedor: pediu ligação ou para falar com uma pessoa, negociação de preço/condições, reclamação, assunto fora do que você sabe responder",
    },
    motivo_humano: { type: "string", description: "por que precisa do vendedor, em poucas palavras; vazio se não precisa" },
    temperatura: {
      type: "string",
      enum: TEMPERATURAS,
      description: "chance de fechar, olhando a conversa INTEIRA: quente = interesse claro, pediu valores/horário ou vai marcar; " +
        "morna = conversando, respondendo perguntas, sem compromisso ainda; fria = respostas secas, evasivas, desviou ou recusou",
    },
    proximo_passo: { type: "string", description: "o próximo passo para fechar, em até 10 palavras (ex.: \"esperar ela marcar no Calendly\")" },
    indicou_contato: {
      type: "boolean",
      description: "true só quando a pessoa indicou OUTRA pessoa ou setor para tratar do assunto e passou o e-mail ou telefone dela " +
        "(ex.: \"fale com o comercial: x@empresa.com\"). false para assinaturas de e-mail e contatos da própria pessoa",
    },
    robo: {
      type: "boolean",
      description: "true quando quem responde é um atendimento automático ou outra IA, e não uma pessoa: respostas genéricas " +
        "que não respondem o que você perguntou, sempre agradecendo e se despedindo, \"em que posso ajudar?\" repetido, menus, " +
        "o mesmo texto de novo, ou uma troca de gentilezas que não sai do lugar. NÃO é robo: a saudação automática de " +
        "boas-vindas do WhatsApp Business (é automatica) e uma pergunta curta de pessoa como \"sobre o que seria?\"",
    },
    encerrar: {
      type: "boolean",
      description: "true quando não há nada a responder: a pessoa só agradeceu ou se despediu e você já tinha agradecido " +
        "(responder viraria um vai e volta de obrigados), ou disse que vai repassar e você já agradeceu",
    },
    dor_entendida: {
      type: "boolean",
      description: "true só quando, pela conversa INTEIRA, já está claro o que a empresa precisa e por quê (ex.: \"perde " +
        "cliente porque demora para responder no WhatsApp\", \"não tem site e o estoque não aparece no Google\"); false enquanto ainda é preciso descobrir",
    },
    pediu_conversa: {
      type: "boolean",
      description: "true quando a pessoa pediu ligação, reunião, call, orçamento, valores, ou perguntou como funciona / quais os planos",
    },
    sugestao_resposta: {
      type: "string",
      description: "próxima mensagem da conversa; vazio se encerrar; se robo, a mensagem curta para chegar numa pessoa (vazio se já pediu); " +
        "em sem_interesse, um agradecimento curto; vazio se for descadastro ou automatica",
    },
  },
  required: ["classificacao", "resumo", "sugestao_resposta", "precisa_humano", "motivo_humano", "indicou_contato", "temperatura", "proximo_passo", "robo", "encerrar", "dor_entendida", "pediu_conversa"],
  additionalProperties: false,
};

const PEDIDO_SAIR = /^\s*(sair|parar|pare|stop|remover|descadastrar|cancelar|unsubscribe|remove me|baja|darse de baja|stopp|abmelden|d[ée]sabonner|disiscrivi|afmelden)\s*[.!]*\s*$/i;
const NAO_QUERO = /n[aã]o (quero|desejo) (mais )?receber|me (tire|remova|exclua) d[ae]|parem de (me )?(mandar|enviar)|stop (messaging|texting|contacting) me|do not (contact|message) me|remove me from/i;
const AUTOMATICA = /resposta autom[aá]tica|mensagem autom[aá]tica|estou (de f[eé]rias|ausente|fora do escrit[oó]rio)|out of office|auto-?reply/i;

/** Remove o histórico citado ("Em ... escreveu:", linhas com ">") e deixa só o que a pessoa escreveu. */
export function limparTextoResposta(texto) {
  const linhas = [];
  for (const linha of String(texto ?? "").split(/\r?\n/)) {
    if (/^\s*(em .+ escreveu:|on .+ wrote:|-{2,}\s*mensagem original|de:\s.+@)/i.test(linha)) break;
    if (/^\s*>/.test(linha)) continue;
    linhas.push(linha);
  }
  return linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Recusa clara e curta: "no momento não", "agora não, obrigado", "não tenho interesse", "sem interesse"...
const CUMPRIMENTO_OU_AGRADECIMENTO = /^(?:(?:oi|ola|bom dia|boa tarde|boa noite|tudo bem|td bem|prezados?|ola tudo bem)\s*)+|(?:\s*(?:obrigad[oa]s?|grat[oa]|agradeco|valeu|abs|abracos?|att|atenciosamente|tenha um bom dia|bom dia|boa tarde|boa noite))+$/g;
// "Não" sozinho fica com a IA (pode ser resposta a uma pergunta, como "vocês já têm site?"); com "no momento",
// "agora", "por enquanto" ou "obrigado" junto, é recusa.
const SO_NAO = /^(?:(?:(?:no|neste|nesse) momento|agora|por enquanto|por ora|por agora)\s*(?:nao|n)|(?:nao|n)(?:\s+(?:no momento|agora|por enquanto|por ora|por agora))+)$|^(?:nao|n) obrigad[oa]s?$/;
const RECUSA = /\b(?:nao|n)\s+(?:tenho|temos|ha)\s+interesse\b|\bsem interesse\b|\bnao (?:me|nos) interessa\b|\bnao (?:precis(?:o|amos)|quer(?:o|emos)|vamos querer)\b|\b(?:no|neste|nesse) momento nao\b|\b(?:agora|por enquanto|por ora) nao\b/;
// Sinais de que a conversa continua ("mas", pergunta, um "depois"): aí quem decide é a IA.
const CONTINUA = /\?|\b(?:mas|porem|entretanto|talvez|quem sabe|depois|amanha|semana que vem|mes que vem|ano que vem|mais (?:pra|para) frente|retorn|me (?:liga|chama|manda)|pode (?:mandar|enviar|ligar)|quanto|valor|preco)\b/;

/** A pessoa recusou de um jeito claro e curto (ex.: "Bom dia, no momento não"): a conversa é encerrada sem depender da IA. */
export function recusouClaramente(texto) {
  const t = String(texto ?? "").replace(/^\[áudio\]\s*/, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s?]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 90 || CONTINUA.test(t)) return false;
  const semCumprimento = t.replace(/^(?:(?:oi|ola|bom dia|boa tarde|boa noite|tudo bem|td bem|prezados?)\s*)+/, "").trim();
  if (/^(?:nao|n) obrigad[oa]s?$/.test(semCumprimento)) return true;
  const nucleo = t.replace(CUMPRIMENTO_OU_AGRADECIMENTO, "").trim();
  return SO_NAO.test(nucleo) || RECUSA.test(nucleo);
}

/** Casos óbvios resolvidos sem gastar IA. Retorna null quando precisa da IA. */
export function classificarPorRegra(texto, assunto = "") {
  if (PEDIDO_SAIR.test(texto) || NAO_QUERO.test(texto))
    return { classificacao: "descadastro", resumo: "Pediu para não receber mais mensagens.", sugestao_resposta: "", precisa_humano: false, motivo_humano: "", robo: false, encerrar: false };
  if (AUTOMATICA.test(assunto) || AUTOMATICA.test(texto.slice(0, 300)))
    return { classificacao: "automatica", resumo: "Resposta automática.", sugestao_resposta: "", precisa_humano: false, motivo_humano: "", robo: false, encerrar: false };
  if (recusouClaramente(texto))
    return { classificacao: "sem_interesse", resumo: "Disse que não tem interesse no momento.", sugestao_resposta: "", precisa_humano: false, motivo_humano: "", robo: false, encerrar: false, temperatura: "fria" };
  return null;
}

/** Já mandamos alguma mensagem nesta conversa? (Então já cumprimentamos e já nos apresentamos.) */
export const jaConversou = (historico) => (historico ?? []).some((h) => h.autor === "nos");

// "Bom dia!", "Boa tarde, Ana!", "Olá, tudo bem?" no começo da mensagem.
const CUMPRIMENTO_NO_INICIO = /^\s*(?:oi\s*[,!.]?\s*)?(bom dia|boa tarde|boa noite|ol[aá])(\s*,?\s*[A-ZÀ-Ú][\wÀ-ú]*)?\s*[!.,]+\s*/i;

/**
 * Tira o cumprimento do começo da mensagem quando a conversa já começou: a IA não diz "Bom dia!" de novo
 * a cada resposta. O resto da mensagem fica como está (com a primeira letra maiúscula).
 */
export function semCumprimentoRepetido(texto, historico) {
  if (!texto || !jaConversou(historico)) return texto;
  const sem = String(texto).replace(CUMPRIMENTO_NO_INICIO, "");
  if (!sem.trim() || sem === texto) return texto;
  return sem.charAt(0).toUpperCase() + sem.slice(1);
}

// A pessoa perguntou de preço? ("quanto custa", "qual o valor", "orçamento", "mensalidade", "quais os planos?"...)
// (Também em inglês, espanhol, francês, alemão, italiano e holandês, para as empresas de fora do Brasil.)
const PERGUNTOU_VALOR = /\b(pre[çc]os?|valor(es)?|custos?|custa|investimento|or[çc]amento|mensalidade|tabela)\b|quanto\s+(custa|cobra|fica|sai|seria|vale|é|e)\b|r\$|\bplanos?\b[^.!\n]*\?|\b(prices?|pricing|cost|costs|quote|fees?|precio|cu[aá]nto|presupuesto|prix|tarif|combien|devis|preis|kosten|kostet|angebot|prezzo|costo|preventivo|prijs|kost|offerte)\b|how much|\bplans?\b[^.!\n]*\?/i;

/** Valores só entram na conversa depois que a pessoa pergunta (agora ou antes, na mesma conversa). */
export function pediuValor(texto, historico = []) {
  return [texto, ...(historico ?? []).filter((h) => h.autor === "lead").map((h) => h.texto)]
    .some((t) => PERGUNTOU_VALOR.test(String(t ?? "").replace(/^\[áudio\]\s*/, "")));
}

const TEM_VALOR = /r\$\s*\d|\d+(?:[.,]\d+)?\s*reais\b|(?:€|US\$|\$)\s?\d|\d(?:[\d.,\s]*\d)?\s?€|\b\d+(?:[.,]\d+)?\s?(?:eur|euros?|usd|dollars?)\b/i;
const ITEM_DE_LISTA = /^\s*([-•*]|\d+[.)])\s/;

/**
 * Tira os valores de uma mensagem (para quando a pessoa ainda não perguntou): item de lista com valor sai
 * inteiro; num parágrafo, sai só a frase com o valor; um título que ficou sem itens ("Planos:") sai também.
 */
export function semValores(texto, { manter = null } = {}) {
  // `manter`: valores que podem ficar mesmo assim (a oferta do site da Black Friday na abordagem principal).
  const temValor = (t) => TEM_VALOR.test(manter ? String(t).replace(manter, "") : t);
  if (!texto || !temValor(texto)) return texto;
  const linhas = [];
  for (const linha of String(texto).split("\n")) {
    if (!temValor(linha)) { linhas.push(linha); continue; }
    if (ITEM_DE_LISTA.test(linha)) continue;
    const frases = linha.split(/(?<=[.!?])\s+/).filter((f) => !temValor(f));
    if (frases.length) linhas.push(frases.join(" "));
  }
  const limpas = linhas.filter((l, i) => {
    if (!/:\s*$/.test(l)) return true;
    const proxima = linhas.slice(i + 1).find((x) => x.trim());
    return Boolean(proxima && ITEM_DE_LISTA.test(proxima));
  });
  return limpas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A empresa veio pela abordagem principal (recebeu a prévia do site) e a oferta do site da Black Friday ainda vale:
 * a IA pode citar essa oferta (e só ela) mesmo sem a pessoa ter perguntado de preço.
 */
export const ofertaLiberada = (lead, agora = new Date()) =>
  (!lead?.pais || lead.pais === "BR") && ofertaSiteAtiva(agora) && (lead?.abordagem === ABORDAGEM_PRINCIPAL || podeTerPrevia(lead));

/** Empresa de um país do euro: o site é 150 €, valor fixo (o valor pode sair sem a pessoa perguntar). */
export const siteEmEuro = (lead) => PAISES[lead?.pais]?.moeda === "EUR";

/** O que a trava de valores deixa passar para esta empresa (o valor do site, ou nada). */
export const valoresPermitidos = (lead) => (siteEmEuro(lead) ? VALOR_DO_SITE_EUROPA : ofertaLiberada(lead) ? VALOR_DA_OFERTA : null);

/** A regra da oferta para os prompts das conversas da abordagem principal. */
const REGRA_DA_OFERTA = `EXCEÇÃO: a ${"${empresa}"} tem (ou vai receber) o site de exemplo dela. A oferta de site da Black Friday (${OFERTA_SITE.plano}: de ${PRECO_DE}
  por ${PRECO_POR}, valor único, em até 12x sem juros no cartão, só até ${OFERTA_SITE.ateTexto}) PODE ser citada sem a pessoa perguntar, UMA vez, quando ela gostar da
  prévia, quiser o site ou perguntar como funciona (se o histórico ainda não tem essa oferta). Escreva "de ${PRECO_DE} por ${PRECO_POR}".
  Nenhum outro valor, plano com preço ou desconto. Quando ela gostar do exemplo ou quiser o site: diga o valor e, no fim,
  mande o link de pagamento do ${OFERTA_SITE.plano} que está na apresentação (se houver). Nunca bate-papo nem reunião.`;
/**
 * Plano certo (pedido de 17/11/2026): nunca oferecer mais do que a pessoa pediu. Quem quer só um site recebe o site
 * (R$ 500 em até 12x na Black Friday); quem quer uma IA simples no WhatsApp, o WhatsApp com IA; os valores de
 * fluxdeck.com.br (a apresentação do Brasil). Empresa de fora do Brasil tem a regra dela (internacional.js).
 */
export function regraDoPlanoCerto(lead, agora = new Date()) {
  if (lead?.pais && lead.pais !== "BR") return "";
  const site = ofertaSiteAtiva(agora)
    ? `o ${OFERTA_SITE.plano} (de ${PRECO_DE} por ${PRECO_POR}, valor único, em até 12x sem juros no cartão, até ${OFERTA_SITE.ateTexto})`
    : "o Site Essencial";
  return `- PLANO CERTO (nunca acima do que a pessoa pediu): quer só um site → ${site}; quer uma IA simples para atender o
  WhatsApp → o WhatsApp com IA (R$ 497 de implantação + R$ 129,90 por mês); quer os dois → os dois. Completo, CRM,
  automação, dashboard ou sistema só se ela pedir essas coisas. Nunca cite plano ou valor que não esteja na apresentação,
  e nunca proponha valores de milhares de reais para quem pediu um site ou uma IA básica.
`;
}

const regraDaOferta = (lead) => (ofertaLiberada(lead) ? REGRA_DA_OFERTA.replace("${empresa}", lead.nome) : "");

// A pessoa pediu para conversar (ligação, reunião, chamada): só aí a IA pode convidar e mandar o link de agendamento.
const PEDIU_CONVERSA = /\b(liga[çc][ãa]o|ligar|liga pra|telefonar|reuni[ãa]o|call|chamada|videochamada|bate-?papo|conversar por|falar com (?:voc[eê]|algu[eé]m))\b/i;
export const pediuConversa = (texto, historico = []) => [texto, ...(historico ?? []).filter((h) => h.autor === "lead").map((h) => h.texto)]
  .some((t) => PEDIU_CONVERSA.test(String(t ?? "").replace(/^\[áudio\]\s*/, "")));

// Convite para reunião ou chamada, ou link de agendamento (Calendly), numa frase.
const CONVITE_PARA_AGENDAR = /calendly\.com|\b(?:numa|uma|na|pela|por)\s+(?:chamada|call|videochamada|reuni[ãa]o|liga[çc][ãa]o)\b|\bmarc(?:ar|arem|armos|amos|ue|uem|quem)\b[^.!?\n]{0,40}\b(?:conversa|chamada|call|reuni[ãa]o|bate-?papo|liga[çc][ãa]o|hor[áa]rio)\b|\bbate-?papo\b/i;

/**
 * Sem pedido de conversa, a mensagem não leva convite para reunião/chamada nem link de agendamento (pedido de
 * 17/11/2026: a IA mostra o site de exemplo em vez de agendar). Sai a frase (ou o item) com o convite; se não sobrar
 * nada, a mensagem fica como está.
 */
export function semAgendamento(texto) {
  if (!texto || !CONVITE_PARA_AGENDAR.test(texto)) return texto;
  const linhas = [];
  for (const linha of String(texto).split("\n")) {
    if (!CONVITE_PARA_AGENDAR.test(linha)) { linhas.push(linha); continue; }
    if (ITEM_DE_LISTA.test(linha)) continue;
    const frases = linha.split(/(?<=[.!?])\s+/).filter((f) => !CONVITE_PARA_AGENDAR.test(f));
    if (frases.length) linhas.push(frases.join(" "));
  }
  const limpo = linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return limpo || texto;
}

const FALA_DE_CONVITE = /\b(bate-papo|bate papo|call|reuni[ãa]o)\b|\bmarcar(mos)? (um|uma) (conversa|liga[çc][ãa]o|videochamada)|calendly/i;

/**
 * Ainda descobrindo a dor (e a pessoa não pediu conversa): tira da mensagem as frases que convidam para
 * bate-papo, call ou reunião (e o link de agendamento). Se a mensagem inteira for o convite, ela fica como está.
 */
export function semConviteCedo(texto) {
  if (!texto || !FALA_DE_CONVITE.test(texto)) return texto;
  const linhas = [];
  for (const linha of String(texto).split("\n")) {
    if (!FALA_DE_CONVITE.test(linha)) { linhas.push(linha); continue; }
    const frases = linha.split(/(?<=[.!?])\s+/).filter((f) => !FALA_DE_CONVITE.test(f));
    if (frases.length) linhas.push(frases.join(" "));
  }
  const limpo = linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return limpo || texto;
}

// A pessoa não entendeu, perguntou quem é ou do que se trata, ou cansou das perguntas: hora de explicar, não de perguntar.
const CONFUSA_OU_CANSADA = /n[aã]o entendi|tantas perguntas|quantas perguntas|(j[aá]|vai) acabar (as|com as) perguntas|s[oó] pergunta|quem (é|e|eh) (vc|voc[eê]|o senhor|a senhora)|n[aã]o sei quem|quem fala|do que se trata|sobre o que (é|e|seria)|qual (é |e )?o assunto|o que (vc|voc[eê]) (quer|deseja|vende|faz)|pq (vc|voc[eê]) (est[aá]|t[aá]) perguntando|por ?que (est[aá]|t[aá]) perguntando|fala logo|direto ao (ponto|assunto)|seu trabalho (é|e)|(vc|voc[eê]) trabalha com o qu|n[aã]o sei (pq|por ?que) (estou|t[oô]) (te )?respond/i;

/** A última mensagem mostra que a pessoa não entendeu ou cansou das perguntas. */
export const confusaOuCansada = (texto) => CONFUSA_OU_CANSADA.test(String(texto ?? "").replace(/^\[áudio\]\s*/, ""));

/** Quantas mensagens nossas com pergunta já foram depois que a pessoa respondeu (as de descoberta). */
export function perguntasFeitas(historico = []) {
  const primeira = historico.findIndex((h) => h.autor !== "nos");
  if (primeira < 0) return 0;
  return historico.slice(primeira).filter((h) => h.autor === "nos" && String(h.texto ?? "").includes("?")).length;
}

// No máximo 2 perguntas de descoberta na conversa: depois disso a IA explica o que faz e propõe o próximo passo.
export const MAX_PERGUNTAS = 2;

// "Sou uma IA", "sou um robô": nunca sai assim. Vai para você responder.
const DISSE_QUE_E_IA = /\b(sou|aqui (é|e)|eu sou) (uma? )?(ia|intelig[eê]ncia artificial|rob[oô]|bot|assistente virtual)\b/i;

/** Texto da conversa até aqui, para a IA não repetir o que já foi dito. */
export function formatarHistorico(historico) {
  if (!historico?.length) return "(nenhuma mensagem anterior registrada)";
  return historico
    .map((h) => `${h.autor === "nos" ? "NÓS" : "EMPRESA"} (${h.canal}${h.etapa ? `, etapa ${h.etapa}` : ""}): ${h.texto}`)
    .join("\n\n");
}

// Quem chamou por conta própria, e por onde (a IA não trata como resposta a uma prospecção).
const ORIGEM_PROPRIA = {
  whatsapp: " · chamou por conta própria",
  instagram_direct: " · chamou por conta própria no direct do Instagram (pode ser só uma pessoa, não uma empresa)",
  formulario: " · preencheu o formulário do site pedindo contato: é a PRIMEIRA mensagem para a pessoa; cumprimente pelo nome, diga que viu o pedido e responda ao que ela precisa",
  contador: ` · ESCRITÓRIO DE CONTABILIDADE: a conversa é de PARCERIA DE INDICAÇÃO, não de venda para o escritório. Ele indica clientes que precisam
de site, sistema ou automação e recebe 10% do primeiro pagamento de cada cliente indicado que fechar contrato. Só diga o percentual se a pessoa
perguntar como funciona a comissão ou quanto ganha. Não ofereça serviço para o próprio escritório, a menos que a pessoa peça. O próximo passo é uma
conversa rápida para combinar como as indicações chegam`,
};

/** Como formatar a mensagem em cada canal. */
const FORMATO_DO_CANAL = {
  email: "",
  whatsapp: " Negrito no WhatsApp é *assim* (um asterisco), nunca **assim**. Sem assinatura.",
  instagram: " O direct do Instagram não tem negrito: escreva sem asteriscos. Sem assinatura.",
};
const NOME_DO_CANAL = { email: "e-mail", whatsapp: "WhatsApp", instagram: "direct do Instagram" };

/**
 * Classifica a resposta de um lead e sugere o próximo passo da conversa.
 * A sugestão avança aos poucos: responde o que foi perguntado e entrega uma informação nova por vez.
 */
/** Como convidar: com horários livres do Calendly, oferece dois e o link para confirmar; sem eles, só o link. */
function comoConvidar(linkAgendamento, horarios = [], ela = "a pessoa") {
  if (!linkAgendamento) return " (ofereça duas opções de horário em dias úteis)";
  if (horarios.length >= 2) {
    return ` oferecendo estes dois horários livres: ${horarios[0]} ou ${horarios[1]} (escreva assim, por extenso), e diga que, se
  um deles servir ou se ${ela} preferir outro, é só escolher e confirmar neste link: ${linkAgendamento}`;
  }
  return ` e mande exatamente este link para ${ela} escolher o horário: ${linkAgendamento}`;
}

/**
 * Instrução da prévia do site (o rascunho em /previa/<token>), só quando é a hora (`linkPrevia` vem de
 * momentoDaPrevia: empresa sem site, link ainda não mandado e a conversa tocou em presença online).
 */
function comoOferecerPrevia(linkPrevia, lead) {
  if (!linkPrevia) return "";
  return `- SITE DE EXEMPLO (o próximo passo desta conversa): a ${lead.nome} não tem site próprio, e você já deixou pronto
  um exemplo de como ficaria o site dela, com o nome, os serviços e o WhatsApp dela: ${linkPrevia}
  Mande o link quando a pessoa pedir um exemplo, uma apresentação, "como ficaria", ou mostrar interesse (ou quando você
  iria propor uma reunião: no lugar da reunião, vai o exemplo). UMA vez, numa frase natural (ex.: "Preparei um exemplo
  de como ficaria o site de vocês, dá uma olhada: <link>"), e termine perguntando o que ela achou ou o que mudaria.
  Mande o link exatamente como está. Nunca diga que o exemplo fica para uma reunião ou chamada.
`;
}

export async function classificarResposta({ texto, assunto, lead, historico, campanha, canal = "email", linkAgendamento = "", horarios = [], apresentacao = "", nota = "", linkPrevia = "" }) {
  const porRegra = classificarPorRegra(String(texto ?? "").replace(/^\[áudio\]\s*/, ""), assunto);
  if (porRegra) return porRegra;
  const podeValores = pediuValor(texto, historico);

  const limite = canal === "email" ? "até 100 palavras, com assinatura curta" : "no máximo 3 frases curtas (até ~350 caracteres, NUNCA mensagem longa nem lista de tópicos), sem assinatura";
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const feitas = perguntasFeitas(historico);
  const confusa = confusaOuCansada(texto);
  // Já perguntou o bastante (ou a pessoa não entendeu, ou cansou): nesta mensagem, explicar e propor, não perguntar.
  const chegaDePerguntas = confusa || feitas >= MAX_PERGUNTAS;
  const r = await gerarJson({ lead,
    system: `${contextoEmpresa(campanha, { semValores: Boolean(apresentacao) })}

Você conduz, aos poucos e com naturalidade, uma conversa com uma empresa (de prospecção, ou de alguém que chamou
por conta própria). O objetivo é a empresa ver um exemplo concreto do que vocês fazem${linkPrevia ? " (o site de exemplo dela)" : ""}, gostar e querer
contratar: NÃO puxe para reunião, chamada ou agendamento (só se ela pedir). Classifique a última resposta
e escreva a PRÓXIMA mensagem da conversa.
${apresentacao ? `
Apresentação da ${campanha.empresa.nome} (como funciona, planos e prazos; use só o que está aqui). Hoje é ${hoje()}:
<apresentacao>
${apresentacao}
</apresentacao>
` : ""}
Como conduzir (tom humano, como ${quem} escrevendo do próprio celular, em primeira pessoa):
- Responda primeiro, de forma direta e simpática, o que a empresa perguntou ou comentou. Use o nome da pessoa se ela disse.
- Entregue no máximo UMA informação nova por mensagem; não despeje tudo de uma vez.
- ESCREVA CLARO: frases simples e concretas, como quem conversa no WhatsApp. A pessoa precisa entender de primeira
  quem você é, o que a ${campanha.empresa.nome} faz e por que você está falando com ela. Nada de pergunta vaga ou abstrata.
- DESCOBERTA CURTA: no máximo ${MAX_PERGUNTAS} perguntas de descoberta na conversa INTEIRA (você já fez ${feitas}). Toda pergunta
  vem depois de dar algo (responder, explicar por que pergunta, ou ligar o que ela disse a uma dor real). Nunca faça
  pergunta em cima de pergunta: conversa que vira interrogatório irrita e a pessoa some.
- Use o que ela já contou (e a dor comum desse tipo de negócio) para mostrar que aquilo é um problema real da empresa e
  o que ele custa (cliente que vai para o concorrente, tempo da equipe), e que tem solução. É isso que gera confiança.
${chegaDePerguntas ? `- AGORA PARE DE PERGUNTAR. Esta mensagem NÃO tem pergunta de descoberta e segue esta ordem:
  ${confusa ? `1) desculpa em meia frase; 2) quem você é (seu nome e a ${campanha.empresa.nome}) e o que a ${campanha.empresa.nome} faz, em UMA
  frase ligada ao ramo dela; 3) por que procurou a empresa: a dor comum desse tipo de negócio (nunca as avaliações do
  Google); 4)` : "1)"} em 1 frase, como vocês resolvem o que ela contou (ou essa dor); ${confusa ? "5)" : "2)"} UM próximo passo concreto,
  fácil de responder com sim ou não (ex.: "Posso te mandar uma proposta rapidinha mostrando como ficaria aí?").
  Se a pessoa falou das avaliações do Google, NÃO fale delas: explique o que você faz. Mesmo com a pessoa irritada,
  não termine só com "se não fizer sentido, paro por aqui": junte a explicação, o próximo passo e essa saída educada
  na mesma mensagem (ex.: "Desculpa pelas perguntas! Sou o Felipe, da FluxDeck: a gente faz a IA que responde o WhatsApp
  de lojas de carro na hora, para nenhum cliente esfriar esperando. Posso te mandar uma proposta rápida? Se não fizer
  sentido, paro por aqui.").` : ""}
${apresentacao ? `${regraDoPlanoCerto(lead)}- Perguntas sobre como funciona, planos ou prazo: responda com o que está na apresentação.
${podeValores ? `- Valores: a pessoa perguntou; use só os da apresentação, como estão escritos. Orçamento exato, desconto ou
  condição especial: diga que isso vocês combinam por aqui, conforme o que ela precisa.` : `- Valores: a pessoa AINDA NÃO perguntou de preço. NÃO cite nenhum valor, preço ou R$, nem "a partir de". Se falar de
  planos, diga só o que cada um faz. Valor só quando ela perguntar.${ofertaLiberada(lead) ? `
  ${regraDaOferta(lead)}` : ""}`}
- Se pedir algo que não está na apresentação nem no catálogo, não prometa: diga com sinceridade que vocês veem isso
  juntos por aqui.
` : `- Preço: não passe valor de cara. Se perguntarem, diga que depende do que eles precisam e mostre um exemplo (o site
  de exemplo, se houver). Só se insistirem depois disso, diga o "a partir de" do catálogo.
${ofertaLiberada(lead) ? `  ${regraDaOferta(lead)}
` : ""}`}- Reunião, chamada, bate-papo ou agenda: SÓ se a pessoa pedir (ligação, reunião, falar com alguém). Aí convide${comoConvidar(linkAgendamento, horarios)}.
  Fora isso, NUNCA convide nem mande link de agendamento: quando ela mostrar interesse ou pedir um exemplo, o próximo
  passo é mostrar o exemplo${linkPrevia ? " (o site de exemplo acima)" : ""}${chegaDePerguntas ? "" : ", ou continuar entendendo o que ela precisa"}.
- Se a pessoa já recebeu o link e disse que vai marcar, agradeça em uma frase, sem insistir.
${comoOferecerPrevia(linkPrevia, lead)}- Nunca repita frases ou informações que já aparecem no histórico. Não invente fatos, prazos ou descontos.
- Se o histórico já tem mensagem sua, NÃO cumprimente de novo (nada de "Bom dia!", "Boa tarde!", "Olá!") e NÃO se
  apresente de novo (seu nome e a empresa já foram ditos): vá direto ao assunto, como numa conversa que continua.
- Não traga por conta própria assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}. Nunca diga que entrou
  em contato por causa das avaliações do Google.
- Se a pessoa perguntar diretamente se está falando com um robô, uma IA ou uma mensagem automática (ex.: "IA?", "é robô?",
  "bela propaganda, IA?"), responda com honestidade e leveza, sem negar: a ${campanha.empresa.nome} usa um assistente com
  IA para começar as conversas e ${quem} acompanha tudo e entra quando precisar. Aproveite: é exatamente o tipo de
  atendimento que a ${campanha.empresa.nome} monta para empresas como a dela, e a pessoa acabou de ver funcionando. Depois
  volte para a dor dela com UMA pergunta leve. Escreva "a gente usa um assistente com IA", nunca "sou uma IA" nem "sou um
  robô", e nunca diga que é uma pessoa digitando. Isso NÃO é motivo para precisa_humano.
- Se a mensagem veio de um áudio (o texto começa com "[áudio]"), responda ao que a pessoa falou, por texto, normalmente.
- Se a pessoa mandou um contato (cartão de contato, "[contato compartilhado]", ou um e-mail/telefone de outra pessoa ou setor
  para tratar do assunto), agradeça em uma frase curta e diga que vai falar com essa pessoa por lá. Não peça mais nada e não
  marque precisa_humano por isso; a mensagem para o contato indicado é escrita e enviada à parte.
- Resposta curta, solta ou que parece fora de contexto (um número, uma porcentagem, "ok", uma palavra, a mesma mensagem
  repetida) NÃO é motivo para precisa_humano: entenda pela sua última pergunta e pelo histórico (ex.: perguntou se
  marcam pelo telefone ou WhatsApp e veio "98%" = 98% pelo WhatsApp), siga a conversa e avance um passo. Se não der
  mesmo para entender, faça uma pergunta leve, sem parecer que não entendeu nada.
- Nunca pergunte de novo algo que a pessoa já respondeu no histórico.
- Recepção ou atendente que diz que vai repassar para o dono, o responsável, o gestor ou a equipe (e ainda não deu o
  nome nem o contato dessa pessoa): agradeça em meia frase e pergunte, com leveza, o primeiro nome do responsável e o
  melhor contato ou horário para falar com ele, oferecendo explicar direto para não tomar o tempo dela (ex.: "Combinado,
  obrigado! Qual o nome dele? Se preferir, me passa o contato que eu explico direto, rapidinho."). Só uma vez.
- Saiba parar: se a pessoa só agradeceu ou se despediu e você já tinha agradecido, ou disse que vai repassar e você já
  agradeceu e perguntou pelo responsável, marque encerrar e deixe a sugestão vazia. Não entre em vai e volta de "obrigado".
- Se quem responde parece um atendimento automático ou outra IA (não responde o que você perguntou, repete
  cumprimentos, "em que posso ajudar?", menus, agradece e se despede toda vez), marque robo e, na sugestão, escreva
  UMA mensagem curta (até 2 frases) para chegar numa pessoa: responda em poucas palavras o que o robô perguntou (ex.:
  seu nome), diga em meia frase o assunto (como eles atraem e atendem clientes; sem vender, sem preço, sem link, sem
  pedir reunião) e peça para falar com o dono ou o responsável, ou o contato dele. Só uma vez: se no histórico você
  já pediu para falar com uma pessoa, deixe a sugestão vazia.
- NÃO é robô: a saudação automática do WhatsApp Business que chega logo depois da sua mensagem (boas-vindas, "agradece
  seu contato", "em breve retornaremos", horários, informações da empresa ou perguntas prontas como "qual seu nome?"):
  isso é classificacao automatica, robo false e sugestão vazia, porque uma pessoa costuma ler e responder depois.
  Também NÃO é robô uma pergunta curta de pessoa sobre o assunto ("sobre o que seria?", "quem fala?", "pois não?",
  "do que se trata?"): responda normalmente.
- Marque precisa_humano só quando: pedirem ligação, negociarem preço ou condições, reclamarem, ou o assunto não tiver
  nada a ver com o seu trabalho (ex.: currículo, cobrança, fornecedor). Mesmo assim escreva uma sugestão curta, em primeira pessoa, para ${quem} revisar. Pedir um serviço que
  não está na lista não é motivo para isso: responda e mostre como vocês resolveriam.
- Tamanho: ${limite}. Português do Brasil, frases curtas, no máximo 1 emoji.
- Sem interesse: a sugestão é um agradecimento curto e cordial (1 ou 2 frases), sem pergunta, sem oferta, sem link,
  deixando a porta aberta (ex.: "Imagina, obrigado pelo retorno! Fico à disposição se precisarem no futuro.").
- Se for descadastro ou resposta automática, deixe a sugestão vazia.`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""}) · canal: ${canal}${ORIGEM_PROPRIA[lead.origem] ?? ""}${lead.status === "fechado" ? " · JÁ É CLIENTE, fechou contrato: não venda nada; marque precisa_humano (motivo: \"cliente com contrato\") e escreva uma sugestão curta para revisar" : ""}

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}

Última resposta da empresa${assunto ? ` (assunto: ${assunto})` : ""}:
${texto}${nota ? `

Observação de ${quem} sobre esta conversa (use para entender; não cite): ${nota}` : ""}`,
    jsonSchema: CLASSIFICACAO_JSON_SCHEMA,
    zodSchema: ClassificacaoSchema,
    // Hora de explicar e propor (a conversa está em risco): pensa um pouco mais.
    effort: chegaDePerguntas ? "medium" : "low",
  });
  // Se escapou um "sou uma IA", a mensagem não sai: vai para você responder.
  if (DISSE_QUE_E_IA.test(r.sugestao_resposta ?? "")) {
    return { ...r, sugestao_resposta: "", precisa_humano: true, motivo_humano: "a resposta sugerida dizia ser uma IA", chegaDePerguntas };
  }
  return { ...r, chegaDePerguntas };
}

const ApresentacaoSchema = z.object({ mensagem: z.string() });
const APRESENTACAO_JSON_SCHEMA = {
  type: "object",
  properties: { mensagem: { type: "string", description: "a mensagem completa, pronta para enviar" } },
  required: ["mensagem"],
  additionalProperties: false,
};

/**
 * Primeira resposta a quem demonstrou interesse: como funciona, os planos e o prazo (da apresentação
 * editável no painel) e o convite para o bate-papo, se a pessoa quiser saber mais.
 */
/**
 * A pessoa pediu uma apresentação comercial: a mensagem leva o link dos slides (com o nome da empresa na capa),
 * conta em tópicos o que tem nela e deixa claro que tudo é sob medida. Nunca com valores, mesmo que ela pergunte.
 */
export async function escreverEnvioDaApresentacao({ texto, lead, historico, campanha, canal = "whatsapp", link }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const r = await gerarJson({ lead,
    system: `${contextoEmpresa(campanha, { semValores: true })}

A pessoa pediu uma apresentação comercial (ou um material, portfólio, algo para ver). Escreva a próxima mensagem da
conversa (${NOME_DO_CANAL[canal] ?? "WhatsApp"}), como ${quem}, em primeira pessoa:
1. Uma frase curta respondendo que sim e mandando o link EXATAMENTE como está: ${link}
   ${jaConversou(historico) ? "A conversa já começou: NÃO cumprimente e NÃO se apresente de novo." : "Comece com o cumprimento certo (bom dia, boa tarde...)."}
2. Em tópicos curtos (um por linha), o que ela vai ver nos slides, puxando primeiro o que combina com o que a pessoa contou:
   sites e páginas que trazem cliente; sistema próprio do jeito da operação; aplicativo da empresa (iPhone e Android);
   IA atendendo no WhatsApp 24 horas; automações e integrações; loja virtual e Mercado Livre/Shopee. No máximo 6 tópicos.
3. Uma frase dizendo que tudo é sob medida: não existe pacote fechado, o projeto é montado só com o que a empresa
   precisa, e o investimento é definido depois de entender isso.
4. Termine com UMA pergunta leve sobre o que mais pesa hoje na empresa (atendimento, vendas, gestão...).
Regras: NUNCA cite valores, preços, R$, "a partir de" ou nomes de planos, mesmo que a pessoa tenha perguntado (diga que
o valor sai do que ela precisar). Não invente clientes, números ou prazos. Não fale de bate-papo, call ou reunião.
Nunca mencione assistente, robô, IA respondendo por ${quem}. Português do Brasil, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? FORMATO_DO_CANAL.whatsapp}`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})
Histórico:
${(historico ?? []).slice(-12).map((h) => `${h.autor === "nos" ? quem : lead.nome}: ${h.texto}`).join("\n")}

Última mensagem de ${lead.nome}: ${texto}`,
    jsonSchema: APRESENTACAO_JSON_SCHEMA,
    zodSchema: ApresentacaoSchema,
    effort: "low",
  });
  return String(r?.mensagem ?? "").trim();
}

export async function escreverApresentacao({ texto, lead, historico, campanha, canal = "whatsapp", apresentacao, linkAgendamento = "", horarios = [], linkPrevia = "" }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const podeValores = pediuValor(texto, historico);
  // No WhatsApp a mensagem é CURTA (pedido de 17/11/2026: "nunca passe mensagens longas"): 2 ou 3 frases, sem tópicos.
  if (canal !== "email") {
    const r = await gerarJson({ lead,
      system: `${contextoEmpresa(campanha, { semValores: true })}

A pessoa demonstrou interesse (ou perguntou como funciona). Escreva a próxima mensagem do ${NOME_DO_CANAL[canal] ?? "WhatsApp"}, como ${quem},
em primeira pessoa. MENSAGEM CURTA, como alguém escrevendo do celular: no máximo 3 frases curtas, até ~350 caracteres,
sem tópicos, sem lista de planos e sem explicar etapas.
- ${jaConversou(historico) ? "A conversa já começou: NÃO cumprimente e NÃO se apresente de novo." : "Comece com um cumprimento curto."}
- Em 1 frase, como funciona (ex.: "a gente ajusta o site com as suas fotos e informações e coloca no ar").
- O valor do que ela precisa, só ele, como está na apresentação${ofertaLiberada(lead) ? ` (site: "de ${PRECO_DE} por ${PRECO_POR}, valor único, em até 12x sem juros")` : ""}.
${regraDoPlanoCerto(lead)}${linkPrevia ? `- Se ela ainda não viu, o link do site de exemplo, exatamente assim: ${linkPrevia}
` : ""}- Feche com UMA pergunta curta para avançar (ex.: "Quer que eu já deixe o seu no ar?"). Nunca convide para reunião ou
  chamada${pediuConversa(texto, historico) ? `, a não ser que ela tenha pedido: aí convide${comoConvidar(linkAgendamento, horarios, "ela")}` : ""}.
Promoção com data: hoje é ${hoje()}; se já acabou, não cite. Português do Brasil, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? FORMATO_DO_CANAL.whatsapp}
Nunca mencione assistente, robô, IA respondendo, sistema ou "equipe" respondendo por ${quem}. Não repita o que já está no histórico.

<apresentacao>
${apresentacao}
</apresentacao>`,
      pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})\n\nConversa:\n${formatarHistorico(historico)}\n\nÚltima mensagem dela: ${texto}\n\nEscreva a mensagem.`,
      jsonSchema: APRESENTACAO_JSON_SCHEMA,
      zodSchema: ApresentacaoSchema,
      effort: "low",
    });
    return r.mensagem.trim();
  }
  const r = await gerarJson({ lead,
    system: `${contextoEmpresa(campanha, { semValores: true })}

A pessoa demonstrou interesse. Escreva a próxima mensagem da conversa (${NOME_DO_CANAL[canal] ?? "WhatsApp"}), como ${quem}, em primeira pessoa:
1. Uma frase respondendo o que ela disse, pelo primeiro nome se ela disse. ${jaConversou(historico)
      ? "A conversa já começou: NÃO cumprimente (nada de bom dia, boa tarde ou olá) e NÃO se apresente de novo; seu nome e a empresa já foram ditos."
      : "Comece com o cumprimento certo (bom dia, boa tarde...)."}
2. Uma apresentação em tópicos curtos, com quebras de linha, tirada SÓ da apresentação abaixo:
   - como funciona (as etapas, resumidas);
   - ${podeValores
      ? `os planos: SÓ os planos da apresentação, com o nome e os valores exatamente como estão escritos (não invente
     planos, valores ou "a partir de", nem arredonde), uma linha cada, começando pelos que combinam com o que ela precisa;`
      : `os planos que combinam com o que ela precisa: SÓ o nome e para que serve, SEM NENHUM valor, preço ou R$ (ela ainda
     não perguntou de preço); no fim, uma frase dizendo que você passa os valores se ela quiser;${ofertaLiberada(lead) ? `
     ${regraDaOferta(lead)} Se ela quer site, comece pelo ${OFERTA_SITE.plano}, com "de ${PRECO_DE} por ${PRECO_POR}, valor único".` : ""}`}
   - em quanto tempo fica pronto.
${regraDoPlanoCerto(lead).replace(/^- /, "   ")}
3. Se ela pediu algo que não está na apresentação, uma frase sincera dizendo que isso vocês combinam com ela.${linkPrevia ? `
   E uma linha dizendo que você já fez um rascunho de como ficaria o site da ${lead.nome}, com este link exatamente como
   está: ${linkPrevia}` : ""}
4. Feche com UMA pergunta simples sobre avançar (ex.: o que ela achou do exemplo, ou se quer que você prepare o dela).
   NÃO convide para reunião, chamada ou bate-papo e não mande link de agendamento${pediuConversa(texto, historico) ? `, a não ser que ela tenha pedido: aí convide${comoConvidar(linkAgendamento, horarios, "ela")}` : ""}.
   Nunca diga que o exemplo fica para uma reunião.
Promoção com data (ex.: só em novembro): hoje é ${hoje()}. Se ainda não começou, conte como novidade que vem aí; se
já acabou, não cite.
Até ~1.200 caracteres. Português do Brasil, simples e direto, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? FORMATO_DO_CANAL.whatsapp}
Nunca mencione assistente, robô, IA respondendo, sistema ou "equipe" respondendo por ${quem}. Não repita o que já está no histórico.

<apresentacao>
${apresentacao}
</apresentacao>`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}

Última mensagem da pessoa:
${texto}`,
    jsonSchema: APRESENTACAO_JSON_SCHEMA,
    zodSchema: ApresentacaoSchema,
    effort: "low",
  });
  return r.mensagem.trim();
}

export const OPCOES_DE_FOLLOWUP = ["retomar", "material", "responsavel", "previa", "pagamento"];
const FollowupSchema = z.object({ opcao: z.enum(OPCOES_DE_FOLLOWUP), mensagem: z.string() });
const FOLLOWUP_JSON_SCHEMA = {
  type: "object",
  properties: {
    opcao: { type: "string", enum: OPCOES_DE_FOLLOWUP, description: "retomar = retoma de onde pararam; material = oferece o guia gratuito; responsavel = pergunta se conseguiu falar com o responsável; previa = manda o rascunho do site (só quando há link da prévia); pagamento = retoma o link de pagamento que ela recebeu e não pagou (só quando há esse link)" },
    mensagem: { type: "string", description: "a mensagem de follow-up, pronta para enviar" },
  },
  required: ["opcao", "mensagem"],
  additionalProperties: false,
};

/**
 * Follow-up para quem mostrou interesse e parou de responder há 1 dia: retoma de onde pararam (com o último
 * assunto da conversa) ou oferece um material de graça (o guia em PDF da empresa). `evitar` = a opção do
 * follow-up anterior, para não repetir. Retorna { opcao, mensagem }.
 */
/**
 * O gatilho de escassez do follow-up (pedido de 18/11/2026), sempre verdadeiro: no Brasil, enquanto vale a Black
 * Friday do site para esta empresa, o prazo real dela (até 30/11); fora disso, e em todos os outros países, as vagas
 * limitadas no mês (a FluxDeck pega poucos projetos por mês para entregar no prazo). Sem número de vagas inventado.
 */
export function gatilhoDeEscassez(lead, agora = new Date()) {
  if (ofertaLiberada(lead, agora)) {
    return `a condição de Black Friday do site vale só até ${OFERTA_SITE.ateTexto}; depois disso ela acaba (cite o prazo, sem valor se a regra de valores não deixar)`;
  }
  return "pegamos poucos projetos por mês para conseguir entregar cada um no prazo, e ainda temos vaga este mês (sem dizer quantas vagas restam)";
}

export async function escreverFollowup({ lead, historico, campanha, canal = "whatsapp", numero = 1, evitar = null, apresentacao = "", linkMaterial = "", linkPrevia = "", linkPagamento = "", contatoIndicado = null }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const ultimaDela = [...(historico ?? [])].reverse().find((h) => h.autor === "lead");
  const podeValores = pediuValor(ultimaDela?.texto, historico);
  const r = await gerarJson({ lead,
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você é ${quem}. Esta empresa conversou com você (mostrou interesse, ficou de ver ou de repassar), mas não responde há
1 dia ou mais. Escreva um follow-up (${NOME_DO_CANAL[canal] ?? "WhatsApp"}; é o ${numero}º seguido sem resposta), escolhendo UMA destas opções:
- retomar: continue exatamente de onde a conversa parou, citando o último assunto (o que ela contou, a pergunta que
  ficou sem resposta), de um jeito leve e útil, com UMA pergunta simples no fim.
- material: ofereça de presente um material gratuito: um guia prático em PDF, feito para a ${lead.nome}, com passos
  simples para atrair mais clientes pelo site, pelo Google e pelo WhatsApp. Mande exatamente este link: ${linkMaterial}
  Diga em uma frase por que ele ajuda no que ela contou, e termine com uma pergunta leve.
- responsavel: SÓ se a pessoa disse que ia passar para o dono, o responsável ou a equipe: pergunte com leveza se ela
  conseguiu falar com ele, ou peça o primeiro nome e o melhor contato dele para você mesmo explicar, rapidinho.
${linkPrevia ? `- previa: a conversa tocou em presença online e a ${lead.nome} não tem site próprio: diga que você fez um rascunho
  de como ficaria o site dela e mande exatamente este link: ${linkPrevia}
  Uma frase ligando ao que ela contou, e termine perguntando o que ela achou. É mais concreto que o guia: prefira
  esta opção à de material.
` : "- (NÃO use a opção previa nesta conversa.)\n"}${linkPagamento ? `- pagamento: a ${lead.nome} já recebeu o link de pagamento e ainda não pagou. Retome com leveza, sem cobrar: pergunte se
  ficou alguma dúvida (o prazo de uma semana, as alterações, a forma de pagar) e lembre que dá para pagar ${lead.pais && lead.pais !== "BR" ? "com cartão, Apple Pay ou Google Pay" : "por Pix, boleto ou cartão"}
  e que, se preferirem, fazemos antes um contrato de prestação de serviço. Mande de novo exatamente este link: ${linkPagamento}
  É a opção certa para quem recebeu o link: prefira-a às outras (só não repita se o follow-up anterior já foi pagamento).
` : "- (NÃO use a opção pagamento nesta conversa.)\n"}${evitar ? `O follow-up anterior foi "${evitar}": agora use outra opção.` : "Escolha a que fizer mais sentido para esta conversa (se ela ficou de repassar, comece por responsavel)."}
${contatoIndicado ? `ATENÇÃO: este follow-up vai para ${contatoIndicado.nome || "a pessoa"} que a ${lead.nome} indicou (você escreveu para ela e ela ainda não respondeu). Fale com ela${contatoIndicado.nome ? " pelo primeiro nome" : ""}, lembre de leve que o pessoal da ${lead.nome} passou o contato e não use a opção responsavel: ela já é a pessoa certa.
` : ""}Regras:
- Nada de cobrança ("não sei se viu", "só passando para lembrar", "fico no aguardo") nem de alarme ("últimas horas", "corre", "imperdível").
- Gatilho de escassez, sempre: inclua UMA frase curta e natural, antes da pergunta final, com este fato verdadeiro: ${gatilhoDeEscassez(lead)}.
  Use só esse fato, com suas palavras e no idioma da conversa; não invente outro prazo, desconto ou número de vagas.
- Não cumprimente com "bom dia/boa tarde" nem se apresente de novo: vocês já conversaram. ${lead.pais === "PT" ? 'Um "Olá, [nome]!" leve pode (em Portugal, nunca "Oi").' : 'Um "Oi, [nome]!" leve pode.'}
- ${linkPagamento ? "Não precisa repetir o valor; se citar, só o que já está no histórico, como está escrito." : podeValores ? "Se citar valores, só os da apresentação, como estão escritos." : `Não cite valores, preços ou R$: ela não perguntou de preço.${ofertaLiberada(lead) ? ` ${regraDaOferta(lead)}` : ""}`}
- Não convide para bate-papo, call ou reunião, a menos que ela já tenha pedido isso na conversa.
- Não repita frases que já estão no histórico. Não invente fatos.
- No máximo 3 frases curtas (até ~400 caracteres), Português do Brasil, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? FORMATO_DO_CANAL.whatsapp}
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.
${apresentacao ? `
O que a ${campanha.empresa.nome} faz (para entender; não despeje):
<apresentacao>
${apresentacao}
</apresentacao>` : ""}`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}`,
    jsonSchema: FOLLOWUP_JSON_SCHEMA,
    zodSchema: FollowupSchema,
    effort: "low",
  });
  return { opcao: r.opcao, mensagem: r.mensagem.trim() };
}

const ReativacaoSchema = z.object({ oferta: z.enum(["guia", "diagnostico"]), assunto: z.string(), mensagem: z.string() });
const REATIVACAO_JSON_SCHEMA = {
  type: "object",
  properties: {
    oferta: { type: "string", enum: ["guia", "diagnostico"], description: "guia = o guia gratuito em PDF; diagnostico = os pontos do site" },
    assunto: { type: "string", description: "assunto do e-mail, curto e pessoal (vazio fora do e-mail)" },
    mensagem: { type: "string", description: "a mensagem pronta para enviar" },
  },
  required: ["oferta", "assunto", "mensagem"],
  additionalProperties: false,
};

/**
 * Reativação de quem recebeu a sequência e não respondeu (30 dias depois): uma mensagem só, diferente da primeira
 * abordagem, que dá algo de valor (o guia gratuito ou um mini diagnóstico do site, com os `pontos` reais da análise)
 * e fala da dor do ramo. Sem venda, sem preço e sem cobrar a falta de resposta. Retorna { oferta, assunto, mensagem }.
 */
export async function escreverReativacao({ lead, canal, campanha, historico = [], dor = "", pontos = [], linkGuia = "" }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const r = await gerarJson({ lead,
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você é ${quem}. Há mais de um mês a ${lead.nome} recebeu algumas mensagens suas e não respondeu. Escreva UMA mensagem de
reativação (${NOME_DO_CANAL[canal] ?? canal}), bem diferente da primeira abordagem: em vez de vender, DÊ algo de valor.
Escolha a oferta:
${pontos.length ? `- diagnostico: você olhou o site deles e anotou estes pontos (use SÓ estes, com suas palavras):
${pontos.map((p) => `  • ${p}`).join("\n")}
  Conte 2 ou 3 deles de forma simples, como quem ajuda, e diga que dá para resolver.
` : ""}- guia: um guia prático em PDF, de presente, feito para a ${lead.nome}, com passos simples para atrair mais clientes pelo site,
  pelo Google e pelo WhatsApp. Mande exatamente este link: ${linkGuia}
${pontos.length ? "Prefira o diagnóstico (é mais pessoal) quando os pontos fizerem sentido para o ramo." : "Use o guia."}
Fale da dor mais comum do ramo deles: ${dor}.
Regras:
- Não cobre a falta de resposta ("não sei se viu", "voltando aqui", "só para lembrar") e não repita a primeira mensagem.
- Sem preço, sem planos, sem convite para call. Termine com UMA pergunta leve (ex.: se faz sentido você mandar mais detalhes).
- ${canal === "email" ? "E-mail em texto simples, 60 a 120 palavras, com saudação e assinatura curta; assunto curto, pessoal, sem caixa alta." : "No máximo 4 frases curtas (até ~500 caracteres), sem assinatura; assunto vazio."}
- Português do Brasil, tom humano, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? ""}
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})${lead.site ? ` · site: ${lead.site}` : " · sem site próprio"}

Mensagens que você já mandou (mais antigas primeiro; não repita):
${formatarHistorico(historico)}`,
    jsonSchema: REATIVACAO_JSON_SCHEMA,
    zodSchema: ReativacaoSchema,
    effort: "low",
  });
  return { oferta: r.oferta, assunto: r.assunto.trim(), mensagem: r.mensagem.trim() };
}

const IndicadoSchema = z.object({ assunto: z.string(), mensagem: z.string() });
const INDICADO_JSON_SCHEMA = {
  type: "object",
  properties: {
    assunto: { type: "string", description: "assunto do e-mail, curto e pessoal (vazio no WhatsApp)" },
    mensagem: { type: "string", description: "primeira mensagem para o contato indicado" },
  },
  required: ["assunto", "mensagem"],
  additionalProperties: false,
};

/**
 * Primeira mensagem para quem foi indicado pela empresa prospectada (ex.: "fale com o
 * comercial, responsável Celso"). Cita a indicação e puxa conversa, sem preço.
 * Retorna { assunto, mensagem } (assunto só no e-mail).
 */
export async function mensagemParaIndicado({ lead, contato, canal = "whatsapp", nomeDeQuemIndicou, textoDaIndicacao = "", historico, campanha }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const formato = canal === "email"
    ? `E-mail em texto simples, 60 a 110 palavras, com saudação, e assinatura curta (${identidade(campanha.empresa).assinatura}).
- Assunto curto e pessoal citando a indicação (ex.: "Indicação da recepção da ${lead.nome}"), sem caixa alta.`
    : "WhatsApp: no máximo 3 frases curtas (até ~350 caracteres), sem assinatura. Assunto vazio.";
  return gerarJson({ lead,
    system: `${contextoEmpresa(campanha)}

Você (${quem}) estava conversando com a ${lead.nome} e eles indicaram outra pessoa para tratar do assunto.
Escreva a PRIMEIRA mensagem para essa pessoa indicada, por ${canal === "email" ? "e-mail" : "WhatsApp"}:
- Cumprimente pelo nome se souber o nome da pessoa (pela indicação ou pelo contato); não use nomes como "Recepção", "Adm", "Setor".
- Diga quem você é em poucas palavras e quem passou o contato: a pessoa da ${lead.nome} que conversou com você. Use o nome
  dela se ela se apresentou na conversa${nomeDeQuemIndicou ? ` (o nome no WhatsApp é "${nomeDeQuemIndicou}", que pode ser só o nome da empresa)` : ""};
  se não souber, diga "o pessoal da ${lead.nome}".
- Em uma frase, o motivo: o que você conversou e como pode ajudar (use a conversa abaixo, sem repetir tudo).
- Termine com UMA pergunta simples e aberta (sem convite para reunião ou bate-papo). Sem preço, sem prazo, sem link.
- ${formato}
- Tom humano, primeira pessoa, no máximo 1 emoji no WhatsApp e nenhum no e-mail. Não escreva rodapé de descadastro.`,
    pedido: `Contato indicado: ${contato.nome || "(sem nome)"}${contato.empresa ? ` · ${contato.empresa}` : ""} · ${contato.email ?? contato.numero}
${textoDaIndicacao ? `\nMensagem em que a ${lead.nome} fez a indicação:\n${textoDaIndicacao}\n` : ""}
Conversa com a ${lead.nome} até aqui:
${formatarHistorico(historico)}`,
    jsonSchema: INDICADO_JSON_SCHEMA,
    zodSchema: IndicadoSchema,
    effort: "low",
  }).then((r) => ({ assunto: r.assunto.trim(), mensagem: r.mensagem.trim() }));
}

const PrimeiroContatoSchema = z.object({ mensagem: z.string() });
const PRIMEIRO_CONTATO_JSON_SCHEMA = {
  type: "object",
  properties: { mensagem: { type: "string", description: "a mensagem de WhatsApp, pronta para enviar" } },
  required: ["mensagem"],
  additionalProperties: false,
};

/**
 * Primeira mensagem para um número que você passou no painel ("Conversar com um número"). Se já houve conversa,
 * retoma de onde parou, sem se apresentar de novo. Puxa a conversa para a dor do contato: sem preço, sem call.
 */
export async function escreverPrimeiroContato({ lead, nome = "", empresa = "", contexto = "", historico = [], campanha }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const jaConversou = historico.length > 0;
  const r = await gerarJson({ lead,
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você é ${quem}. ${jaConversou
    ? "Você já conversou com este contato (histórico abaixo). Escreva a PRÓXIMA mensagem de WhatsApp retomando a conversa de onde parou: não se apresente de novo, não cumprimente como se fosse a primeira vez e não repita o que já foi dito."
    : "Escreva a PRIMEIRA mensagem de WhatsApp para este contato, que ainda não conhece você."}
Regras:
- Cumprimente pelo nome da pessoa se souber (nunca use nome de empresa ou de setor como se fosse o nome dela).
${jaConversou ? "" : "- Diga quem você é e o que faz em uma frase simples.\n"}- Use o que você sabe do contato (abaixo). Não invente nada: se não sabe o ramo ou o site da empresa, não diga que viu o site nem cite problemas dela.
- O objetivo é entender a dor do contato: termine com UMA pergunta aberta e fácil de responder sobre como eles atraem ou atendem clientes hoje (ou sobre o ponto do contexto).
- Sem preço, sem planos, sem convite para call ou reunião, sem link.
- No máximo 3 frases curtas (até ~350 caracteres). Português do Brasil, tom humano, primeira pessoa, no máximo 1 emoji.${FORMATO_DO_CANAL.whatsapp}
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.`,
    pedido: `Contato: ${nome || "(nome da pessoa não informado)"}${empresa ? ` · empresa: ${empresa}` : ""}${lead?.nicho ? ` · ramo: ${lead.nicho}` : ""}${lead?.cidade ? ` · ${lead.cidade}` : ""}
O que você sabe dele: ${contexto || "nada além do número"}
${jaConversou ? `\nConversa até aqui (mais antigas primeiro):\n${formatarHistorico(historico)}` : ""}`,
    jsonSchema: PRIMEIRO_CONTATO_JSON_SCHEMA,
    zodSchema: PrimeiroContatoSchema,
    effort: "low",
  });
  return r.mensagem.trim();
}

export const TIPOS_DE_CONTATO = ["cliente", "pessoal", "incerto"];

const ContatoNovoSchema = z.object({
  tipo: z.enum(TIPOS_DE_CONTATO),
  lead_id: z.number().int(),
  empresa: z.string(),
  nome_pessoa: z.string(),
  resumo: z.string(),
});

const CONTATO_NOVO_JSON_SCHEMA = {
  type: "object",
  properties: {
    tipo: {
      type: "string",
      enum: TIPOS_DE_CONTATO,
      description: "cliente = quer falar sobre um serviço (site, loja virtual, sistema, app, automação, IA, redes sociais, orçamento) " +
        "ou está respondendo a uma prospecção; pessoal = amigos, família, trabalho, parceiros, fornecedores, clientes atuais " +
        "pedindo suporte, cobranças, promoções; incerto = ainda não dá para saber (só cumprimentos, sem assunto)",
    },
    lead_id: { type: "integer", description: "id da empresa da lista que a pessoa disse ser (pelo nome da empresa); 0 se nenhuma" },
    empresa: { type: "string", description: "nome da empresa da pessoa, se ela disse; vazio se não" },
    nome_pessoa: { type: "string", description: "primeiro nome da pessoa, se ela disse; vazio se não" },
    resumo: { type: "string", description: "1 frase com o que a pessoa quer" },
  },
  required: ["tipo", "lead_id", "empresa", "nome_pessoa", "resumo"],
  additionalProperties: false,
};

/**
 * Alguém que nunca recebeu mensagem nossa escreveu no WhatsApp, que também é o número pessoal.
 * Decide se é um possível cliente (aí a IA conversa) e se é uma das empresas já prospectadas
 * (ex.: a dona da loja escrevendo do celular dela). Na dúvida, fica como "incerto".
 */
export async function avaliarContatoNovo({ mensagens, nomeNoWhatsapp, empresasContatadas = [], campanha }) {
  const { empresa } = campanha;
  return gerarJson({
    system: `Este WhatsApp é de ${empresa.responsavel || "o dono"} da ${empresa.nome}, que faz sites, lojas virtuais, sistemas,
apps e automações com IA. É também o número pessoal dele: amigos, família e parceiros escrevem aqui.
Uma pessoa que não está nos contatos com quem ele já conversou mandou as mensagens abaixo. Decida se é um possível
cliente da ${empresa.nome}. Só marque "cliente" quando a mensagem deixar claro que a pessoa quer falar sobre um
serviço, um orçamento, ou que está respondendo a um contato da ${empresa.nome}. Na dúvida, "incerto".
Se a pessoa disser de qual empresa é, e essa empresa estiver na lista das que a ${empresa.nome} contatou, informe o id.`,
    pedido: `Nome no WhatsApp: ${nomeNoWhatsapp || "(sem nome)"}

Empresas contatadas recentemente:
${empresasContatadas.map((e) => `[${e.id}] ${e.nome}`).join("\n") || "(nenhuma)"}

Mensagens da pessoa (mais antiga primeiro):
${mensagens.join("\n")}`,
    jsonSchema: CONTATO_NOVO_JSON_SCHEMA,
    zodSchema: ContatoNovoSchema,
    effort: "low",
  });
}

const DirectDoComentarioSchema = z.object({
  responder: z.boolean(),
  resumo: z.string(),
  mensagem: z.string(),
  resposta_publica: z.string(),
});

const DIRECT_DO_COMENTARIO_JSON_SCHEMA = {
  type: "object",
  properties: {
    responder: {
      type: "boolean",
      description: "true se o comentário pede o que o post prometeu no direct (ex.: comentou a palavra da chamada), faz uma pergunta " +
        "sobre o assunto ou os serviços, ou mostra interesse. false para elogio solto, emoji, marcar amigo, spam, propaganda, crítica ou " +
        "comentário sem relação",
    },
    resumo: { type: "string", description: "1 frase com o que a pessoa quer" },
    mensagem: { type: "string", description: "a mensagem privada para o direct da pessoa; vazia se responder for false" },
    resposta_publica: { type: "string", description: "resposta curta embaixo do comentário, até 10 palavras (ex.: avisando que mandou no direct); vazia se responder for false" },
  },
  required: ["responder", "resumo", "mensagem", "resposta_publica"],
  additionalProperties: false,
};

/**
 * Alguém comentou num post do Instagram. Decide se vale mandar direct e escreve a mensagem privada
 * (entrega o que o post prometeu, com o conteúdo do próprio post, e puxa conversa) e a resposta pública.
 */
export async function escreverDirectDoComentario({ comentario, usuario, post, campanha }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const c = post?.conteudo;
  const telas = (c?.slides ?? []).map((t, i) => `${i + 1}. [${t.visual ?? "texto"}] ${t.titulo}${t.texto ? ` — ${t.texto}` : ""}`).join("\n");
  const r = await gerarJson({
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você cuida do Instagram da ${campanha.empresa.nome}. Uma pessoa comentou num post. Decida se vale mandar uma mensagem privada
no direct dela e, se valer, escreva essa mensagem e uma resposta pública curta para o comentário.

A mensagem privada, como ${quem}, em primeira pessoa:
- Se o post prometia algo no direct ("comenta X que eu te mando..."), entregue isso AGORA, na própria mensagem, usando só o
  conteúdo do post (ex.: o checklist ou os passos em linhas curtas). Nunca diga que mandou PDF, link, material ou arquivo: não há anexo.
- Se a pessoa perguntou algo, responda de forma direta e simpática.
- Termine com UMA pergunta leve que puxe conversa sobre o negócio dela (ex.: se ela quer que você dê uma olhada no site ou no perfil dela).
- Não use o @ como nome. Sem preço. Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.
- Até 600 caracteres, Português do Brasil, frases curtas, no máximo 1 emoji, sem asteriscos (o direct não tem negrito).
A resposta pública: curta e natural, variando (ex.: "Te mandei no direct! 📩", "Acabei de te chamar lá no direct 😉").`,
    pedido: `Post${post ? ` (tema: ${post.tema})` : " (não foi possível identificar qual)"}:
${c ? `Gancho: ${c.gancho}
Telas:
${telas}
Legenda: ${c.legenda}` : "(sem o conteúdo do post)"}

Comentário de @${usuario || "alguém"}:
${comentario}`,
    jsonSchema: DIRECT_DO_COMENTARIO_JSON_SCHEMA,
    zodSchema: DirectDoComentarioSchema,
    effort: "low",
  });
  return { ...r, mensagem: r.mensagem.trim(), resposta_publica: r.resposta_publica.trim() };
}
