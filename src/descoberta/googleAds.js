import { buscarNaSerpApi, cidadeSemUf, cortar, localDaSerpApi } from "./anuncios.js";

// Quem paga para aparecer no topo do Google quando alguém da cidade procura pelo segmento ("dentista em Osasco").
// Já investe em anúncio, então a conversa é sobre o que acontece depois do clique: a página para onde o anúncio
// leva (lenta, sem WhatsApp, sem formulário) e o atendimento de quem chega. Cada busca gasta 1 do plano da SerpApi.

// Portais, marketplaces e redes grandes compram anúncio em todo lugar: não são o negócio local.
const PORTAIS = /(^|\.)(google|youtube|facebook|instagram|doctoralia|boaconsulta|ifood|mercadolivre|olx|webmotors|icarros|mobiauto|zapimoveis|vivareal|imovelweb|quintoandar|booking|trivago|decolar|getninjas|habitissimo|reclameaqui|amazon|magazineluiza|magalu|shopee|americanas|casasbahia|submarino|enjoei|gympass|wellhub|zenklub|vittude|drogasil|drogaraia|paguemenos|indeed|catho|infojobs|vagas|linkedin|wikipedia|gupy|sympla|eventbrite|uber|99app|rappi|zedelivery|uol|globo|terra|tripadvisor|kayak)\.(com|com\.br|net|org)(\.br)?$/i;

/** O domínio de um link ("https://www.clinicax.com.br/promo" vira "clinicax.com.br"). */
export function dominioDoLink(link) {
  try {
    return new URL(String(link)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

/** O nome do anunciante: o que o Google mostra como fonte, ou o começo do título do anúncio. */
const nomeDoAnuncio = (ad) => cortar(String(ad.source || String(ad.title ?? "").split(/\s[-|–:]\s/)[0] || "").trim(), 120);

/** Os anúncios de uma busca, um por site, sem portais e marketplaces. */
export function anunciantesDaBusca(ads, consulta) {
  const porDominio = new Map();
  for (const ad of ads ?? []) {
    const dominio = dominioDoLink(ad.link);
    if (!dominio || PORTAIS.test(dominio) || porDominio.has(dominio)) continue;
    const nome = nomeDoAnuncio(ad);
    if (!nome) continue;
    porDominio.set(dominio, {
      dominio,
      nome,
      site: String(ad.link),
      telefone: ad.phone ? String(ad.phone).replace(/\D/g, "") || null : null,
      anuncio: {
        plataforma: "google",
        consulta,
        texto: cortar([ad.title, ad.description].filter(Boolean).join(" — ").replace(/\s+/g, " "), 400),
        link: String(ad.link),
        posicao: ad.position ?? null,
        topo: ad.block_position === "top",
      },
    });
  }
  return [...porDominio.values()];
}

/** Quem anuncia no Google para o segmento na cidade. Gasta 1 busca. */
export async function buscarAnunciantesNoGoogle({ nicho, cidade, agora = new Date() } = {}) {
  const local = await localDaSerpApi(cidade);
  const consulta = `${String(nicho ?? "").trim()} ${cidadeSemUf(cidade)}`.trim();
  const { dados, aviso } = await buscarNaSerpApi({
    engine: "google", q: consulta, ...(local ? { location: local } : {}), gl: "br", hl: "pt-br", google_domain: "google.com.br",
  }, { fonte: "googleads", agora });
  if (!dados) return { empresas: [], buscas: 0, avisos: [aviso] };
  return { empresas: anunciantesDaBusca(dados.ads, consulta), buscas: 1, avisos: [] };
}
