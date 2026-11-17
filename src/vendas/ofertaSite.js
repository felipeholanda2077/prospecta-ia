// Oferta de site da Black Friday (pedido de 16/11/2026): a criação do site por R$ 500, valor único, "de R$ 950 por
// R$ 500". É a oferta da abordagem principal (empresa sem site recebe a prévia do site dela; ver ia/abordagens.js) e
// entra na apresentação do Brasil enquanto vale, com o checkout da FluxDeck (/checkout/site-black-friday).
// Depois do prazo, a abordagem continua (prévia para quem não tem site), mas sem esse preço: valem os planos da apresentação.
export const OFERTA_SITE = {
  plano: "Site Black Friday",
  de: 950,
  por: 500,
  ate: "2026-11-30T23:59:59-03:00",
  ateTexto: "30/11",
};

export const ofertaSiteAtiva = (agora = new Date()) => +agora <= Date.parse(OFERTA_SITE.ate);

// Site para empresas da Europa (pedido de 17/11/2026): 150 €, valor fixo (sem conversão de reais), pagamento único,
// sem mensalidade. Vale para os países do euro; o link de pagamento é do Stripe, em euro.
export const OFERTA_SITE_EUROPA = { plano: "Criação de site", valor: 150, moeda: "EUR" };
/** Os valores do site da Europa (150 €, € 150, 150 euros), para a trava de valores deixar passar só eles. */
export const VALOR_DO_SITE_EUROPA = /€\s?150(?:,00)?(?![\d.,]*\d)|\b150(?:,00)?\s?(?:€|euros?\b)/gi;

const reais = (v) => `R$ ${Number(v).toLocaleString("pt-BR")}`;
export const PRECO_DE = reais(OFERTA_SITE.de);
export const PRECO_POR = reais(OFERTA_SITE.por);
/** A parcela em 12x no cartão (R$ 41,67). */
export const PARCELA = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Math.ceil((OFERTA_SITE.por / 12) * 100) / 100).replace(/\s/g, " ");
export const PARCELAS_DO_SITE = 12;

/** Os valores da oferta, para a trava de valores deixar passar só eles (R$ 500 e R$ 950, também "500 reais"). */
export const VALOR_DA_OFERTA = new RegExp(
  `R\\$\\s?(?:${OFERTA_SITE.por}|${OFERTA_SITE.de})(?:,00)?(?![\\d.,]*\\d)|\\b(?:${OFERTA_SITE.por}|${OFERTA_SITE.de})\\s?reais\\b`,
  "gi",
);

/** O endereço do site da empresa (fluxdeck.com.br), onde o checkout e a prévia abrem; sem site, o do sistema. */
export function origemDoSite(site, reserva = "") {
  try {
    return new URL(String(site ?? "")).origin;
  } catch {
    return reserva;
  }
}

/**
 * O trecho da apresentação com a oferta (a linha do plano é lida como plano de pagamento único pelo checkout).
 * `checkout` = o endereço do checkout da FluxDeck para fechar, quando já existe.
 */
export function blocoDaOferta({ checkout = "" } = {}) {
  return `Oferta de Black Friday para criação de site (só até ${OFERTA_SITE.ateTexto}; enquanto valer, é ESTA a oferta de site, no lugar do Site Essencial):
- ${OFERTA_SITE.plano} (${PRECO_POR} pagamento único, de ${PRECO_DE}): o site profissional da empresa no ar, feito com a cara do negócio (como a prévia que mostramos): versão para celular, botão do WhatsApp, textos e SEO para aparecer no Google, domínio e publicação. Valor único, sem mensalidade, à vista ou em até 12x de ${PARCELA} no cartão.
Como falar: "de ${PRECO_DE} por ${PRECO_POR}, valor único, em até 12x no cartão, só nesta Black Friday".${checkout ? `
Para fechar o ${OFERTA_SITE.plano}, o pagamento é por este link (Pix, boleto ou cartão): ${checkout}` : ""}`;
}
