// Apresentação comercial em slides (fluxdeck.com.br/apresentacao): quando a pessoa pede uma apresentação, um
// material ou um portfólio, a IA manda o link com o nome da empresa na capa. Nunca com valores: tudo é sob medida.

const ENDERECO = "https://fluxdeck.com.br/apresentacao";

// "Tem uma apresentação comercial?", "manda um material", "tem portfólio?", "tem algo para eu ver?", "manda os slides"...
const PEDIU_APRESENTACAO = new RegExp([
  "apresenta[çc][aã]o(?! pessoal)",
  "portf[oó]lio",
  "cat[aá]logo",
  "\\bslides?\\b",
  "\\bmateria(l|is)\\b(?! de constru)",
  "folder|pdf (da|de) (empresa|voc[eê]s)",
  "(algo|alguma coisa) (para|pra) (eu |a gente )?(ver|olhar|dar uma olhada|mostrar)",
  "(mostrar?|manda|envia|tem) (o )?(que voc[eê]s fazem|trabalhos? de voc[eê]s|exemplos?)",
].join("|"), "i");

/** A pessoa pediu uma apresentação, um material ou um portfólio da empresa. */
export function pediuApresentacaoComercial(texto) {
  return PEDIU_APRESENTACAO.test(String(texto ?? "").replace(/^\[áudio\]\s*/, ""));
}

/** O link da apresentação, com o nome da empresa na capa ("Preparada para ..."). */
export function linkDaApresentacao(lead) {
  const nome = String(lead?.nome ?? "").trim().slice(0, 80);
  return nome ? `${ENDERECO}?para=${encodeURIComponent(nome)}` : ENDERECO;
}

/** A apresentação já foi mandada nesta conversa (não manda o mesmo link duas vezes seguidas). */
export const apresentacaoJaEnviada = (historico = []) =>
  historico.some((h) => h.autor === "nos" && String(h.texto ?? "").includes(ENDERECO));

/** Mensagem pronta (sem IA): usada quando a IA não escreve uma boa, para a pessoa nunca ficar sem a apresentação. */
export function mensagemDaApresentacao(lead, { canal = "whatsapp" } = {}) {
  const itens = [
    "Sites e páginas que trazem cliente pelo Google",
    "Sistema próprio, do jeito da operação de vocês",
    "Aplicativo da empresa para iPhone e Android",
    "IA atendendo no WhatsApp 24 horas",
    "Automações e integrações entre sistemas",
    "Loja virtual e integração com Mercado Livre e Shopee",
  ];
  const lista = itens.map((i) => (canal === "email" ? `- ${i}` : `• ${i}`)).join("\n");
  return `Tenho sim! Preparei a apresentação comercial da FluxDeck para a ${lead?.nome ?? "sua empresa"}: ${linkDaApresentacao(lead)}

Nela você vê, com exemplos:
${lista}

Tudo é sob medida: não tem pacote fechado, a gente monta só com o que fizer sentido para vocês. O que mais pesa aí hoje?`;
}
