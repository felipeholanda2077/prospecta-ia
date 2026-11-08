import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.GOOGLE_PLACES_API_KEY = "teste";
const db = await import("../src/db.js");
const intl = await import("../src/internacional.js");
const pipeline = await import("../src/pipeline.js");
const { normalizarTelefoneBR } = await import("../src/analise/telefone.js");
const { pediuValor, semValores, classificarPorRegra } = await import("../src/ia/resposta.js");
const { rodapeDescadastro } = await import("../src/envio/email.js");
await db.iniciar();

const LIMITES = { horarioComercial: { inicio: 9, fim: 18 }, somenteDiasUteis: true };
const hoje = new Date().toISOString().slice(0, 10);
await db.gravarConfig("cotacao_brl", { dia: hoje, data: hoje, EUR: 0.16, USD: 0.18 });

test("país: cidade com o país no fim; ES e MT continuam estados do Brasil", () => {
  assert.deepEqual(intl.cidadeEPais("Lisboa, Portugal"), { cidade: "Lisboa", pais: "PT" });
  assert.deepEqual(intl.cidadeEPais("Miami, FL, EUA"), { cidade: "Miami, FL", pais: "US" });
  assert.deepEqual(intl.cidadeEPais("Berlim, Alemanha"), { cidade: "Berlim", pais: "DE" });
  assert.equal(intl.cidadeEPais("Vitória, ES").pais, "BR");
  assert.equal(intl.cidadeEPais("Cuiabá, MT").pais, "BR");
  assert.equal(intl.cidadeEPais("Osasco - SP").pais, "BR");
});

test("fuso: o do país; nos EUA, o do estado no endereço", () => {
  assert.equal(intl.fusoDaEmpresa({ pais: "DE" }), "Europe/Berlin");
  assert.equal(intl.fusoDaEmpresa({ pais: "US", endereco: "123 Main St, Los Angeles, CA 90012, USA" }), "America/Los_Angeles");
  assert.equal(intl.fusoDaEmpresa({ pais: "US", endereco: "1 Ocean Dr, Miami, FL 33139, USA" }), "America/New_York");
  assert.equal(intl.fusoDaEmpresa({ pais: "US", cidade: "Austin, Texas" }), "America/Chicago");
  assert.equal(intl.fusoDaEmpresa({ pais: "US" }), "America/New_York");
});

test("telefone: formato internacional e se pode ser celular; +49 não vira número do Brasil", () => {
  assert.equal(intl.telefoneInternacional("+49 151 23456789", "DE"), "4915123456789");
  assert.equal(intl.telefoneInternacional("030 1234567", "DE"), "49301234567");
  assert.equal(intl.podeSerCelular("+49 151 23456789", "DE"), true);
  assert.equal(intl.podeSerCelular("+49 30 1234567", "DE"), false);
  assert.equal(intl.podeSerCelular("+1 305-555-0123", "US"), true);
  assert.equal(normalizarTelefoneBR("+49 30 1234567"), null);
  assert.equal(normalizarTelefoneBR("+55 11 98888-7777"), "5511988887777");
});

test("moeda: os valores em reais viram euro ou dólar, arredondados como numa tabela", () => {
  const texto = "Professional (R$ 2.500/mês). Diagnóstico (R$ 197/mês). Desconto de R$ 1.500 por mês, ou 1.500 reais.";
  const eur = intl.converterValores(texto, { moeda: "EUR", idioma: "de-DE", taxa: 0.16 });
  assert.match(eur, /400 €\/mês/);
  assert.match(eur, /32 €\/mês/);
  assert.doesNotMatch(eur, /R\$|reais/);
  const usd = intl.converterValores("R$ 4.500/mês", { moeda: "USD", idioma: "en-US", taxa: 0.18, ajustePct: 20 });
  assert.equal(usd, "$970/mês"); // 4500 × 0,18 × 1,2 = 972 → 970
  assert.equal(intl.converterValores("R$ 4.500", { moeda: "BRL", taxa: 1 }), "R$ 4.500");
});

test("IA: empresa de fora recebe a ordem do idioma e os valores na moeda de lá; a do Brasil, nada muda", async () => {
  const system = "Escreva em Português do Brasil. Professional: R$ 2.500/mês.";
  assert.equal(await intl.localizarParaEmpresa(system, { pais: null }), system);
  const de = await intl.localizarParaEmpresa(system, { pais: "DE", idioma: "de-DE", cidade: "Berlim, Alemanha" });
  assert.match(de, /alemão \(Deutsch\)/);
  assert.match(de, /400 €/);
  assert.doesNotMatch(de, /R\$ 2\.500/);
  assert.match(de, /euros/);
  const us = await intl.localizarParaEmpresa(system, { pais: "US", idioma: "en", cidade: "Miami, EUA" });
  assert.match(us, /inglês \(English\)/);
  assert.match(us, /\$450/);
});

test("busca: segmento traduzido e guardado, Google Maps no país, empresa capturada com país, idioma e fuso", async () => {
  let traducoes = 0;
  assert.equal(await intl.segmentoNoIdioma("dentista", "de-DE", { traduzir: async () => { traducoes++; return "Zahnarzt"; } }), "Zahnarzt");
  assert.equal(await intl.segmentoNoIdioma("dentista", "de-AT", { traduzir: async () => { traducoes++; return "outro"; } }), "Zahnarzt");
  assert.equal(traducoes, 1);

  const antes = globalThis.fetch;
  const corpos = [];
  globalThis.fetch = async (url, op) => {
    corpos.push(JSON.parse(op.body));
    return new Response(JSON.stringify({ places: [
      { id: "ChIJberlin000000000000001", displayName: { text: "Zahnarztpraxis Mitte" }, formattedAddress: "Torstraße 1, 10119 Berlin, Deutschland",
        internationalPhoneNumber: "+49 151 23456789", businessStatus: "OPERATIONAL" },
    ] }), { status: 200 });
  };
  try {
    const achadas = await pipeline.buscarNoMaps("dentista", "Berlin", 20, { pais: "DE", idioma: "en" });
    assert.deepEqual([corpos[0].textQuery, corpos[0].regionCode, corpos[0].languageCode], ["Zahnarzt Berlin", "DE", "de"]);
    assert.deepEqual([achadas[0].pais, achadas[0].idioma, achadas[0].fuso, achadas[0].celular], ["DE", "en", "Europe/Berlin", true]);
    await pipeline.capturarDoMaps(achadas, "dentista", "Berlin, Alemanha", { pais: "DE", idioma: "en" });
    const lead = (await db.consultar("SELECT * FROM leads WHERE place_id = $1", ["ChIJberlin000000000000001"]))[0];
    assert.deepEqual([lead.pais, lead.idioma, lead.fuso, lead.cidade], ["DE", "en", "Europe/Berlin", "Berlin, Alemanha"]);
    const wa = await pipeline.descobrirWhatsapp(lead, {});
    assert.deepEqual(wa, { whatsapp: "4915123456789", whatsapp_status: "celular" });

    // Busca automática: "Lisboa, Portugal" na lista de cidades procura em Portugal.
    corpos.length = 0;
    await pipeline.buscarEInserir({ nicho: "pet shop", cidade: "Lisboa, Portugal" }, { automacao: { idiomaExterior: "local" } }, 20);
    assert.deepEqual([corpos[0].textQuery, corpos[0].regionCode], ["pet shop Lisboa", "PT"]);
  } finally {
    globalThis.fetch = antes;
  }
});

test("horário: cada empresa no horário comercial do fuso dela", () => {
  const terca6hBrasilia = new Date("2026-11-10T09:00:00Z"); // 10h em Berlim
  assert.equal(pipeline.dentroDoHorario(LIMITES, terca6hBrasilia), false);
  assert.equal(pipeline.dentroDoHorario(LIMITES, terca6hBrasilia, "Europe/Berlin"), true);
  const terca21hBrasilia = new Date("2026-11-11T00:00:00Z"); // 16h em Los Angeles
  assert.equal(pipeline.dentroDoHorario(LIMITES, terca21hBrasilia, "America/Los_Angeles"), true);
  assert.equal(pipeline.fusoDaMensagem({ pais: "DE", fuso: "Europe/Berlin" }), "Europe/Berlin");
  assert.equal(pipeline.fusoDaMensagem({ pais: null, fuso: null }), "America/Sao_Paulo");
  // A próxima etapa do WhatsApp cabe no expediente de lá (às 17h50 em Berlim, vai para o dia seguinte de lá).
  const quaseFimBerlim = new Date("2026-11-10T16:50:00Z");
  const proxima = pipeline.horarioDaProximaEtapa(1, { limites: LIMITES, cadencia: { horasEntreEtapas: [2, 2] } }, quaseFimBerlim, "whatsapp", "Europe/Berlin");
  assert.equal(pipeline.dentroDoHorario(LIMITES, proxima, "Europe/Berlin"), true);
  assert.ok(proxima > quaseFimBerlim);
});

test("envio: fora do horário daqui, sai só a empresa que está no horário dela", async () => {
  await db.inserirLead({ place_id: "ChIJberlinEnvio00000000001", nome: "Praxis Berlin", nicho: "dentista", cidade: "Berlin, Alemanha", pais: "DE", idioma: "de-DE", fuso: "Europe/Berlin" });
  await db.inserirLead({ place_id: "ChIJosascoEnvio00000000001", nome: "Clínica Osasco", nicho: "dentista", cidade: "Osasco - SP" });
  const [de] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJberlinEnvio00000000001"]);
  const [br] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJosascoEnvio00000000001"]);
  const idDe = await db.criarMensagem({ lead_id: de.id, canal: "email", destino: "praxis@example.de", assunto: "Hallo", corpo: "Hallo", status: "aprovada" });
  const idBr = await db.criarMensagem({ lead_id: br.id, canal: "email", destino: "clinica@example.com.br", assunto: "Oi", corpo: "Oi", status: "aprovada" });
  assert.equal(await db.temFilaNoExterior(), true);
  const campanha = { limites: { ...LIMITES, envioDiarioMax: 30, intervaloEntreEnviosSegundos: 0 }, automacao: { metaDiaria: { email: 30 } } };
  const agora = new Date("2026-11-10T09:00:00Z"); // terça, 6h em Brasília, 10h em Berlim
  const r = await pipeline.enviar(campanha, { ate: Date.now() + 60_000, agora });
  assert.notEqual(r.motivo, "fora do horário comercial");
  // Sem SMTP no teste o e-mail dá erro, mas foi tentado; o do Brasil nem foi tentado.
  assert.notEqual((await db.buscarMensagem(idDe)).status, "aprovada");
  assert.equal((await db.buscarMensagem(idBr)).status, "aprovada");
});

test("conversa: pergunta de preço em outros idiomas, valores em euro e pedido para sair", () => {
  assert.equal(pediuValor("How much does it cost?"), true);
  assert.equal(pediuValor("Was kostet das?"), true);
  assert.equal(pediuValor("¿Cuál es el precio?"), true);
  assert.equal(pediuValor("Sounds interesting, tell me more"), false);
  assert.equal(semValores("Great question.\n- Professional: 400 €/month\n- Website: $90/month\nLet's talk."), "Great question.\nLet's talk.");
  assert.equal(classificarPorRegra("unsubscribe").classificacao, "descadastro");
  assert.match(rodapeDescadastro("abc", "de-DE"), /reply "STOP"/);
  assert.match(rodapeDescadastro("abc"), /responda "SAIR"/);
});
