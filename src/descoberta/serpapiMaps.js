import { buscarNaSerpApi } from "./anuncios.js";

// Empresas do Google Maps pela SerpApi: a mesma lista do Google Maps, com o mesmo place_id da API do Google (as
// empresas já capturadas pelo Places não entram de novo). A API do Google para em 60 resultados por busca; pela
// SerpApi dá para seguir para os resultados seguintes (61 a 120), onde estão empresas que a outra busca não traz.
// Cada página (até 20 empresas) gasta 1 busca do plano da SerpApi.
export const POR_PAGINA = 20;

const FECHADA = /permanent|definitiv|fechad[oa] permanente/i;

/** Uma empresa da SerpApi no formato das do Google Maps (Places). */
export function empresaDaSerpApi(l) {
  if (!l?.place_id || !l?.title || FECHADA.test(String(l.open_state ?? ""))) return null;
  return {
    place_id: String(l.place_id),
    nome: String(l.title).slice(0, 120),
    endereco: l.address ?? null,
    telefone: l.phone ?? null,
    site: l.website ?? null,
    maps_url: `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(l.place_id)}`,
    avaliacao: Number.isFinite(l.rating) ? l.rating : null,
    total_avaliacoes: Number.isFinite(l.reviews) ? l.reviews : null,
    lat: l.gps_coordinates?.latitude ?? null,
    lng: l.gps_coordinates?.longitude ?? null,
  };
}

/**
 * Busca empresas no Google Maps pela SerpApi a partir do resultado `inicio` (0 = do primeiro). `fonte` separa a
 * cota da busca automática ("maps") da busca do painel. Sem chave ou sem cota, devolve o motivo em `aviso`.
 */
export async function buscarEmpresasNaSerpApi(consulta, { quantidade = 20, inicio = 0, pais = "BR", idioma = "pt-BR", fonte = "maps_painel", agora = new Date() } = {}) {
  const empresas = [];
  const vistas = new Set();
  let aviso = null;
  let buscas = 0;
  for (let start = Math.max(0, Number(inicio) || 0); empresas.length < quantidade && start < 200; start += POR_PAGINA) {
    const r = await buscarNaSerpApi({
      engine: "google_maps", type: "search", q: consulta, start: String(start),
      hl: String(idioma || "pt-BR").toLowerCase(), gl: String(pais || "BR").toLowerCase(),
    }, { fonte, agora });
    if (!r.dados) { aviso = r.aviso; break; }
    buscas++;
    const pagina = (r.dados.local_results ?? []).map(empresaDaSerpApi).filter(Boolean);
    for (const e of pagina) if (!vistas.has(e.place_id)) { vistas.add(e.place_id); empresas.push(e); }
    if (r.dados.semResultados || (r.dados.local_results ?? []).length < POR_PAGINA || !r.dados.serpapi_pagination?.next) break;
  }
  return { empresas: empresas.slice(0, quantidade), aviso, buscas };
}
