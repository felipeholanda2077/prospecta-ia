import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const anuncios = await import("../src/descoberta/anuncios.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

const lugar = (n) => ({ place_id: `ChIJserpapi${String(n).padStart(12, "0")}`, title: `Pet Shop ${n}`, address: `Rua ${n}, Osasco - SP`,
  phone: "(11) 98765-4321", website: n % 2 ? `https://pet${n}.com.br` : undefined, rating: 4.5, reviews: 30 + n, gps_coordinates: { latitude: -23.5, longitude: -46.7 } });

/** SerpApi de mentira para o Google Maps: 20 por página, `total` empresas no total, anotando cada busca. */
function mapsFalso(total = 50) {
  const chamadas = [];
  const antes = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/account.json") return Response.json({ plan_name: "Free Plan", searches_per_month: 250 });
    const p = Object.fromEntries(u.searchParams);
    chamadas.push(p);
    const start = Number(p.start ?? 0);
    const itens = Array.from({ length: Math.max(0, Math.min(20, total - start)) }, (_, i) => lugar(start + i + 1));
    return Response.json({ local_results: itens, ...(start + 20 < total ? { serpapi_pagination: { next: "x" } } : {}) });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = antes) };
}

test("SerpApi no Google Maps: busca a partir do 61º, no formato das empresas do Maps, gastando 1 busca por página", async () => {
  const api = mapsFalso(100);
  try {
    await anuncios.conectar({ chave: "chave-boa", limiteMensal: "250" });
    const antes = await anuncios.buscasNoMes();
    const r = await pipeline.buscarNoMaps("pet shop", "Osasco - SP", 40, { fonte: "serpapi", inicio: 60 });
    assert.equal(r.length, 40);
    assert.deepEqual(api.chamadas.map((c) => [c.engine, c.start, c.q, c.gl]), [["google_maps", "60", "pet shop em Osasco - SP", "br"], ["google_maps", "80", "pet shop em Osasco - SP", "br"]]);
    assert.equal((await anuncios.buscasNoMes()) - antes, 2);
    const e = r.find((x) => x.nome === "Pet Shop 61");
    assert.equal(e.place_id, "ChIJserpapi000000000061");
    assert.match(e.maps_url, /place_id:ChIJserpapi000000000061/);
    assert.equal(e.lat, -23.5);
  } finally {
    api.restaurar();
  }
});

test("SerpApi na busca automática: 20 empresas novas por rodada, seguindo de onde parou e voltando ao 61º no fim", async () => {
  const api = mapsFalso(95);
  try {
    await anuncios.conectar({ chave: "chave-boa", limiteMensal: "250" });
    const campanha = { automacao: {} };
    const r1 = await pipeline.descobrirNaSerpApi(campanha, { nicho: "banho e tosa", cidade: "Osasco - SP" }, { agora: new Date("2026-11-28T15:00:00Z") });
    assert.equal(r1.inicio, 60);
    assert.equal(r1.novas, 20);
    const r2 = await pipeline.descobrirNaSerpApi(campanha, { nicho: "banho e tosa", cidade: "Osasco - SP" }, { agora: new Date("2026-11-28T15:00:00Z") });
    assert.equal(r2.inicio, 80);
    assert.equal(r2.encontradas, 15); // a última página: na próxima, volta para o 61º
    const r3 = await pipeline.descobrirNaSerpApi(campanha, { nicho: "banho e tosa", cidade: "Osasco - SP" }, { agora: new Date("2026-11-28T15:00:00Z") });
    assert.equal(r3.inicio, 60);
    assert.equal(r3.novas, 0); // as mesmas empresas não entram duas vezes
    // Desligada em Automação, não busca.
    assert.equal(await pipeline.descobrirNaSerpApi({ automacao: { buscarNaSerpApi: false } }, { nicho: "x", cidade: "Osasco - SP" }), null);
  } finally {
    api.restaurar();
  }
});
