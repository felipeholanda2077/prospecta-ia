import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.GOOGLE_PLACES_API_KEY = "teste";
const db = await import("../src/db.js");
const mapa = await import("../src/vendas/mapaClientes.js");
await db.iniciar();

test("mapa: cidade do endereço do CNPJ, CNPJ do contrato e o lugar para buscar", () => {
  assert.equal(mapa.cidadeDoEndereco("Rua das Flores, 10, Centro, Curitiba - PR"), "Curitiba - PR");
  assert.equal(mapa.cidadeDoEndereco("sem cidade"), null);
  assert.equal(mapa.cnpjDoContrato("CONTRATADA | X, CNPJ 11.111.111/0001-11\nCONTRATANTE | Y LTDA, inscrita no CNPJ sob o nº 12.345.678/0001-90, e-mail"), "12345678000190");
  assert.equal(mapa.lugarParaBuscar("Osasco - SP", "BR"), "Osasco - SP, Brasil");
  assert.equal(mapa.lugarParaBuscar("Lisboa, Portugal", "PT"), "Lisboa, Portugal");
});

test("mapa: clientes (fechados) e cidades da prospecção com coordenadas guardadas", async () => {
  await db.inserirLead({ place_id: "ChIJmapa000000000000000001", nome: "Clínica Sorriso", cidade: "Osasco - SP" });
  await db.inserirLead({ place_id: "ChIJmapa000000000000000002", nome: "Ocean Auto Sales", cidade: "Miami, EUA", pais: "US", idioma: "en-US", fuso: "America/New_York" });
  await db.inserirLead({ place_id: "ChIJmapa000000000000000003", nome: "Pet Osasco", cidade: "Osasco - SP" });
  const [a, b, c] = await db.consultar("SELECT id FROM leads WHERE place_id LIKE 'ChIJmapa%' ORDER BY place_id");
  await db.atualizarLead(a.id, { status: "fechado" });
  await db.atualizarLead(b.id, { status: "fechado", observacao: "Pagou pelo Stripe: Professional" });
  await db.atualizarLead(c.id, { status: "contatado" });
  const consultas = [];
  const detalhes = [];
  const buscar = async (url, op) => {
    // Lugar do Google: a localização exata da empresa (a terceira não é achada).
    if (!op?.body) {
      detalhes.push(url);
      if (/000003$/.test(url)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ location: { latitude: -23.5, longitude: -46.8 } }));
    }
    const q = JSON.parse(op.body).textQuery;
    consultas.push(q);
    const lugar = /Miami/.test(q) ? { latitude: 25.76, longitude: -80.19 } : { latitude: -23.53, longitude: -46.79 };
    return new Response(JSON.stringify({ places: [{ location: lugar }] }));
  };
  const d = await mapa.dadosDoMapa({ buscar });
  assert.deepEqual(d.clientes.map((x) => [x.nome, x.origem, x.lat]).sort(), [["Clínica Sorriso", "fechado", -23.53], ["Ocean Auto Sales", "stripe", 25.76]]);
  assert.deepEqual(d.resumo.nomesDosPaises.sort(), ["Brasil", "Estados Unidos"]);
  const osasco = d.prospeccao.find((p) => p.cidade === "Osasco - SP");
  assert.deepEqual([osasco.empresas, osasco.responderam], [2, 1]);
  // Cada empresa no mapa, com a etapa; a do Google Maps no ponto exato, a sem ponto perto do centro da cidade.
  assert.equal(detalhes.length, 3);
  const pet = d.empresas.find((e) => e.nome === "Pet Osasco");
  assert.equal(pet.etapa, "contatada");
  assert.equal(pet.aproximado, true);
  assert.ok(Math.abs(pet.lat - -23.53) < 0.05);
  assert.deepEqual(d.empresas.find((e) => e.nome === "Clínica Sorriso").lat, -23.5);
  assert.deepEqual(d.etapas, { cliente: 2, contatada: 1 });
  // Cada cidade é consultada uma vez só; na próxima abertura vem do cache.
  const n = consultas.length;
  assert.equal(new Set(consultas).size, n);
  const de2 = await mapa.dadosDoMapa({ buscar, automacao: { buscas: [{ nicho: "x", cidades: ["Osasco - SP", "Lisboa, Portugal"] }] } });
  assert.equal(consultas.length, n + 1); // só Lisboa, a cidade-alvo nova
  assert.equal(detalhes.length, 3); // empresas já localizadas não são consultadas de novo
  assert.deepEqual(de2.alvos.map((a) => a.cidade), ["Lisboa, Portugal"]);
  assert.equal(mapa.etapaNoMapa("agendado"), "negociacao");
});
