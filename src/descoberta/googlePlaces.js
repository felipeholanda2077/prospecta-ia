import { config } from "../config.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const CAMPOS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.location",
  "nextPageToken",
].join(",");

/**
 * Busca empresas no Google Maps pela API oficial (Places API "New").
 * Ex.: buscarEmpresas("clínica odontológica em Fortaleza - CE", 20)
 */
export async function buscarEmpresas(consulta, maxResultados = 20, { pais = "BR", idioma = "pt-BR" } = {}) {
  if (!config.googlePlacesApiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY não configurada no .env");
  }

  const empresas = [];
  let pageToken;

  do {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": CAMPOS,
      },
      body: JSON.stringify({
        textQuery: consulta,
        // Fora do Brasil, o Google procura no país escolhido e responde no idioma de lá.
        languageCode: idioma || "pt-BR",
        regionCode: pais || "BR",
        pageSize: Math.min(20, maxResultados - empresas.length),
        ...(pageToken ? { pageToken } : {}),
      }),
    });

    if (!resp.ok) {
      throw new Error(`Google Places respondeu ${resp.status}: ${await resp.text()}`);
    }

    const dados = await resp.json();
    for (const p of dados.places ?? []) {
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
      empresas.push({
        place_id: p.id,
        nome: p.displayName?.text ?? "Sem nome",
        endereco: p.formattedAddress ?? null,
        telefone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
        site: p.websiteUri ?? null,
        maps_url: p.googleMapsUri ?? null,
        avaliacao: p.rating ?? null,
        total_avaliacoes: p.userRatingCount ?? null,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
      });
    }
    pageToken = dados.nextPageToken;
  } while (pageToken && empresas.length < maxResultados);

  return empresas.slice(0, maxResultados);
}
