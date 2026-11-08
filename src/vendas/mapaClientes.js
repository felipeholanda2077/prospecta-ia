import * as db from "../db.js";
import { config } from "../config.js";
import { dadosDoCnpj } from "../descoberta/cnpj.js";
import { PAISES } from "../internacional.js";

// Mapa do Dashboard: onde estão os clientes (contratos assinados e empresas fechadas, inclusive as que pagaram
// pelo Stripe) e, numa segunda camada, as cidades onde a prospecção está acontecendo. A cidade de cada um vem
// da empresa no sistema ou, no contrato sem empresa, do CNPJ do contratante; a coordenada da cidade vem do
// Google (Places) e fica guardada, então cada cidade só é consultada uma vez.

const CACHE = "geocodigos";
const NOVAS_POR_VEZ = 20; // cidades novas consultadas por abertura do mapa (as outras ficam para a próxima)

const chave = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** "Osasco - SP" → "Osasco - SP, Brasil"; "Lisboa, Portugal" fica como está. */
export function lugarParaBuscar(cidade, pais) {
  const c = String(cidade ?? "").trim();
  if (!c) return null;
  if (pais && pais !== "BR") return c;
  return /brasil|brazil/i.test(c) ? c : `${c}, Brasil`;
}

/** A cidade do endereço do cadastro do CNPJ ("Rua X, 10, Centro, Curitiba - PR" → "Curitiba - PR"). */
export function cidadeDoEndereco(endereco) {
  const m = String(endereco ?? "").match(/([^,]+?\s-\s[A-Z]{2})\s*$/);
  return m ? m[1].trim() : null;
}

/** O CNPJ escrito no contrato (o primeiro que aparece depois de CONTRATANTE). */
export function cnpjDoContrato(corpo) {
  const texto = String(corpo ?? "");
  const depois = texto.slice(Math.max(0, texto.search(/CONTRATANTE/i)));
  return depois.match(/\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/)?.[1]?.replace(/\D/g, "") ?? null;
}

/** As coordenadas de um lugar, do cache; sem cache, consulta o Google (se ainda houver vez nesta abertura). */
async function coordenadas(lugar, cache, vez, buscar = fetch) {
  const k = chave(lugar);
  if (!k) return null;
  if (cache[k] !== undefined) return cache[k];
  if (vez.restam <= 0 || !config.googlePlacesApiKey) return undefined;
  vez.restam--;
  try {
    const r = await buscar("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": config.googlePlacesApiKey, "X-Goog-FieldMask": "places.location,places.formattedAddress" },
      body: JSON.stringify({ textQuery: lugar, pageSize: 1, languageCode: "pt-BR" }),
      signal: AbortSignal.timeout(8000),
    });
    const p = r.ok ? (await r.json()).places?.[0] : null;
    cache[k] = p?.location ? { lat: p.location.latitude, lng: p.location.longitude } : null;
    vez.mudou = true;
    return cache[k];
  } catch {
    return undefined;
  }
}

/** A cidade de um contrato: a da empresa do sistema ou, sem ela, a do CNPJ do contratante (guardada). */
async function cidadeDoContrato(c) {
  if (c.lead_id) {
    const lead = await db.buscarLead(c.lead_id);
    if (lead?.cidade) return { cidade: lead.cidade, pais: lead.pais || "BR", leadId: lead.id };
  }
  const guardada = await db.lerEstado(`mapa_contrato:${c.id}`);
  if (guardada) return JSON.parse(guardada);
  const cnpj = cnpjDoContrato(c.corpo);
  if (!cnpj) return null;
  try {
    const cidade = cidadeDoEndereco((await dadosDoCnpj(cnpj)).endereco);
    const local = cidade ? { cidade, pais: "BR" } : null;
    if (local) await db.gravarEstado(`mapa_contrato:${c.id}`, JSON.stringify(local));
    return local;
  } catch {
    return null;
  }
}

/** Os pontos do mapa: clientes (um por empresa) e cidades da prospecção, com as coordenadas. */
export async function dadosDoMapa({ buscar = fetch } = {}) {
  const cache = (await db.lerConfig(CACHE)) ?? {};
  const vez = { restam: NOVAS_POR_VEZ, mudou: false };
  const clientes = [];
  const pendentes = [];
  const leadsComContrato = new Set();

  const contratos = await db.consultar("SELECT id, lead_id, contratante, projeto, corpo, valor_total, status FROM contratos WHERE status = 'assinado' ORDER BY id");
  for (const c of contratos) {
    const local = await cidadeDoContrato(c);
    if (local?.leadId) leadsComContrato.add(local.leadId);
    if (!local) { pendentes.push(c.contratante); continue; }
    const ponto = await coordenadas(lugarParaBuscar(local.cidade, local.pais), cache, vez, buscar);
    if (!ponto) { pendentes.push(c.contratante); continue; }
    clientes.push({ nome: c.contratante, projeto: c.projeto, cidade: local.cidade, pais: local.pais, origem: "contrato", ...ponto });
  }

  const fechadas = await db.consultar("SELECT id, nome, cidade, pais, observacao FROM leads WHERE status = 'fechado' ORDER BY atualizado_em DESC LIMIT 200");
  for (const l of fechadas) {
    if (leadsComContrato.has(l.id) || !l.cidade) continue;
    const ponto = await coordenadas(lugarParaBuscar(l.cidade, l.pais), cache, vez, buscar);
    if (!ponto) { pendentes.push(l.nome); continue; }
    clientes.push({ nome: l.nome, cidade: l.cidade, pais: l.pais || "BR", origem: /stripe/i.test(l.observacao ?? "") ? "stripe" : "fechado", ...ponto });
  }

  // Prospecção: as cidades com mais empresas contatadas, e quantas responderam.
  const cidades = await db.consultar(
    `SELECT cidade, COALESCE(pais, 'BR') AS pais, count(*)::int AS empresas,
            count(*) FILTER (WHERE status IN ('respondeu', 'agendado', 'fechado'))::int AS responderam
       FROM leads WHERE cidade IS NOT NULL AND cidade <> '' AND status IN ('contatado', 'respondeu', 'agendado', 'fechado', 'sem_interesse')
      GROUP BY cidade, COALESCE(pais, 'BR') ORDER BY count(*) DESC LIMIT 40`
  );
  const prospeccao = [];
  for (const c of cidades) {
    const ponto = await coordenadas(lugarParaBuscar(c.cidade, c.pais), cache, vez, buscar);
    if (ponto) prospeccao.push({ cidade: c.cidade, pais: c.pais, empresas: c.empresas, responderam: c.responderam, ...ponto });
  }

  if (vez.mudou) await db.gravarConfig(CACHE, cache);
  const paises = [...new Set(clientes.map((c) => c.pais))];
  return {
    clientes, prospeccao, pendentes,
    resumo: {
      clientes: clientes.length, cidades: new Set(clientes.map((c) => chave(c.cidade))).size, paises: paises.length,
      nomesDosPaises: paises.map((p) => PAISES[p]?.nome ?? p),
    },
    incompleto: vez.restam <= 0,
  };
}
