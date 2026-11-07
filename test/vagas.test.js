import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.GOOGLE_PLACES_API_KEY = "teste";
const db = await import("../src/db.js");
const anuncios = await import("../src/descoberta/anuncios.js");
const vagas = await import("../src/descoberta/vagas.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

const vaga = (empresa, extra = {}) => ({ title: "Atendente de WhatsApp", company_name: empresa, location: "Osasco, SP", via: "via Indeed", detected_extensions: { posted_at: "há 3 dias" }, share_link: `https://google.com/jobs/${empresa}`, ...extra });

function serpApiFalsa(jobs) {
  const chamadas = [];
  const antes = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    chamadas.push(Object.fromEntries(u.searchParams));
    if (u.pathname === "/account.json") return Response.json({ plan_name: "Free Plan", searches_per_month: 250 });
    if (u.pathname === "/locations.json") return Response.json([
      { canonical_name: "Osasco,Osasco,State of Sao Paulo,Brazil", country_code: "BR", target_type: "City", reach: 1 },
      { canonical_name: "Osasco,State of Sao Paulo,Brazil", country_code: "BR", target_type: "City", reach: 2 },
    ]);
    return Response.json({ jobs_results: jobs });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = antes) };
}

test("vagas: uma empresa por nome, sem agência de emprego, com o cargo e o serviço que resolve", () => {
  const empresas = vagas.empresasDasVagas([
    vaga("Clínica Sorriso"), vaga("Clínica Sorriso", { title: "Recepcionista" }), vaga("RH Recrutamento e Seleção"), vaga("Talent Staffing"), vaga(""),
  ], vagas.FUNCOES[0]);
  assert.deepEqual(empresas.map((e) => e.nome), ["Clínica Sorriso"]);
  assert.deepEqual([empresas[0].vaga.cargo, empresas[0].vaga.servico, empresas[0].vaga.publicada, empresas[0].vaga.onde], ["Atendente de WhatsApp", "automacao", "há 3 dias", "Indeed"]);
});

test("vagas: a busca usa a função na cidade, gasta 1 do limite e só captura quem tem contato pelo Google Maps", async () => {
  const api = serpApiFalsa([vaga("Pet Feliz", { location: "Jundiaí, SP" }), vaga("Clínica Sorriso")]);
  try {
    await anuncios.conectar({ chave: "chave-boa", limiteMensal: "250" });
    const antes = await anuncios.buscasNoMes();
    const r = await vagas.buscarEmpresasContratando({ cidade: "Osasco - SP", funcoes: [1] });
    assert.equal(await anuncios.buscasNoMes(), antes + 1);
    const busca = api.chamadas.find((c) => c.engine);
    assert.deepEqual([busca.engine, busca.q, busca.location, busca.gl], ["google_jobs", "recepcionista", "Osasco,State of Sao Paulo,Brazil", "br"]);
    assert.equal(r.empresas.length, 2);
    // A vaga de outra cidade vai para o fim e fica marcada.
    assert.deepEqual(r.empresas.map((e) => [e.nome, e.naCidade]), [["Clínica Sorriso", true], ["Pet Feliz", false]]);

    const [sorriso, pet] = r.empresas;
    Object.assign(sorriso, { mapsPlaceId: "maps-sorriso", telefone: "+55 11 99999-0000", site: "https://sorriso.com.br" });
    assert.equal((await pipeline.capturarDasVagas([sorriso, pet], "", "Osasco - SP")).novas, 1); // a Pet Feliz não tem contato
    const lead = (await db.leadsPorStatus("novo")).find((l) => l.place_id === "maps-sorriso");
    assert.deepEqual([lead.origem, lead.telefone, JSON.parse(lead.vaga).servico], ["vaga", "5511999990000", "agendamento"]);
    // A mesma empresa (mesmo lugar no Maps) não entra duas vezes.
    assert.equal((await pipeline.capturarDasVagas([sorriso], "", "Osasco - SP")).novas, 0);
  } finally {
    api.restaurar();
  }
});

test("vagas: a busca automática respeita a cota das vagas no limite do mês", async () => {
  await anuncios.conectar({ limiteMensal: "10" }); // a chave já foi salva no teste anterior
  const agora = new Date("2030-04-30T15:00:00Z");
  assert.equal(await anuncios.podeBuscarSozinho(agora, "vagas"), true);
  await db.gravarEstado("serpapi:vagas:2030-04", 3); // 30% de 10
  assert.equal(await anuncios.podeBuscarSozinho(agora, "vagas"), false);
  assert.equal(await anuncios.podeBuscarSozinho(agora, "anuncios"), true);
});

test("contadores: uma vez por dia, entram como parceria (origem contador), sem repetir", async () => {
  const antes = globalThis.fetch;
  const consultas = [];
  globalThis.fetch = async (url, opcoes = {}) => {
    if (String(url).includes("places.googleapis.com")) {
      consultas.push(JSON.parse(opcoes.body).textQuery);
      return Response.json({ places: [{ id: "ChIJcontabil0000000000001", displayName: { text: "Contábil Osasco" }, nationalPhoneNumber: "(11) 3333-4444" }] });
    }
    return Response.json({});
  };
  try {
    const campanha = { automacao: {} };
    const agora = new Date("2030-05-02T15:00:00Z");
    const r = await pipeline.descobrirContadores(campanha, { cidade: "Osasco - SP" }, { agora });
    assert.equal(r.erro, undefined, r.erro);
    assert.equal(r.novas, 1);
    assert.deepEqual(consultas, ["escritório de contabilidade em Osasco - SP"]);
    assert.equal(await pipeline.descobrirContadores(campanha, { cidade: "Osasco - SP" }, { agora }), null); // já rodou hoje
    const lead = (await db.leadsPorStatus("novo")).find((l) => l.place_id === "ChIJcontabil0000000000001");
    assert.deepEqual([lead.origem, lead.nicho], ["contador", "escritório de contabilidade"]);
    assert.equal(await pipeline.descobrirContadores({ automacao: { buscarContadores: false } }, { cidade: "Osasco - SP" }, { agora: new Date("2030-05-03T15:00:00Z") }), null);
  } finally {
    globalThis.fetch = antes;
  }
});
