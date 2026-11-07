import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const anuncios = await import("../src/descoberta/anuncios.js");
const gads = await import("../src/descoberta/googleAds.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

const ad = (link, extra = {}) => ({ position: 1, block_position: "top", title: "Clínica Sorriso - Implante em Osasco", link, description: "Agende sua avaliação", ...extra });

test("Google Ads: um anunciante por site, sem portais, com o nome da fonte ou do título", () => {
  const lista = gads.anunciantesDaBusca([
    ad("https://www.clinicasorriso.com.br/implante", { source: "Clínica Sorriso" }),
    ad("https://clinicasorriso.com.br/outra"),
    ad("https://www.doctoralia.com.br/dentista/osasco"),
    ad("https://odontomais.com.br/", { title: "OdontoMais | Dentista 24h", source: "odontomais.com.br" }),
  ], "dentista Osasco");
  assert.deepEqual(lista.map((e) => [e.dominio, e.nome]), [["clinicasorriso.com.br", "Clínica Sorriso"], ["odontomais.com.br", "OdontoMais"]]);
  assert.deepEqual([lista[0].anuncio.plataforma, lista[0].anuncio.topo, lista[0].anuncio.consulta], ["google", true, "dentista Osasco"]);
});

test("Google Ads: busca com o local da cidade e não captura quem já está no funil pelo site", async () => {
  const antes = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    chamadas.push(Object.fromEntries(u.searchParams));
    if (u.pathname === "/account.json") return Response.json({ plan_name: "Free" });
    if (u.pathname === "/locations.json") return Response.json([{ canonical_name: "Osasco,State of Sao Paulo,Brazil", country_code: "BR", target_type: "City" }]);
    return Response.json({ ads: [ad("https://www.clinicasorriso.com.br/", { source: "Clínica Sorriso" }), ad("https://www.jacapturada.com.br/", { source: "Já Capturada" })] });
  };
  try {
    await anuncios.conectar({ chave: "chave-boa", limiteMensal: "250" });
    await db.inserirLead({ place_id: "maps-x", nome: "Já Capturada", nicho: "dentista", cidade: "Osasco", endereco: null, telefone: null, site: "https://jacapturada.com.br/contato", maps_url: null, avaliacao: null, total_avaliacoes: null });
    const r = await pipeline.buscarNoGoogleAds("dentista", "Osasco - SP");
    const busca = chamadas.find((c) => c.engine);
    assert.deepEqual([busca.engine, busca.q, busca.location, busca.google_domain], ["google", "dentista Osasco", "Osasco,State of Sao Paulo,Brazil", "google.com.br"]);
    assert.deepEqual(r.empresas.map((e) => [e.nome, e.jaCapturado]), [["Clínica Sorriso", false], ["Já Capturada", true]]);
    assert.equal((await pipeline.capturarDoGoogleAds(r.empresas, "dentista", "Osasco - SP")).novas, 1);
    const lead = (await db.leadsPorStatus("novo")).find((l) => l.place_id === "gads:clinicasorriso.com.br");
    assert.deepEqual([lead.origem, JSON.parse(lead.anuncio).plataforma], ["google_ads", "google"]);
  } finally {
    globalThis.fetch = antes;
  }
});
