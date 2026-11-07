import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const anuncios = await import("../src/descoberta/anuncios.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

const anuncio = (id, pagina, extra = {}) => ({
  ad_archive_id: id, page_id: pagina, page_name: `Empresa ${pagina}`, page_likes: 1200, start_date: "2026-10-20",
  publisher_platforms: ["facebook", "instagram"], body: "Clareamento dental em Fortaleza com 20% de desconto", link: "https://empresa.com.br/promo", ...extra,
});

/** SerpApi de mentira: a conta e as buscas na Biblioteca de Anúncios, anotando cada chamada. */
function serpApiFalsa({ paginas = [[]], chaveBoa = "chave-boa" } = {}) {
  const chamadas = [];
  const antes = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    chamadas.push({ caminho: u.pathname, params: Object.fromEntries(u.searchParams) });
    if (u.searchParams.get("api_key") !== chaveBoa) return Response.json({ error: "Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key" }, { status: 401 });
    if (u.pathname === "/account.json") return Response.json({ plan_name: "Free Plan", searches_per_month: 250, total_searches_left: 240 });
    const i = Number(u.searchParams.get("next_page_token") ?? 0);
    return Response.json({ ads: paginas[i] ?? [], ...(paginas[i + 1] ? { serpapi_pagination: { next_page_token: String(i + 1) } } : {}) });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = antes) };
}

test("anúncios: a chave é conferida na conta da SerpApi (sem gastar busca) e fica cifrada", async () => {
  const api = serpApiFalsa();
  try {
    assert.match((await anuncios.conectar({ chave: "errada" })).erro, /recusou a chave/);
    const r = await anuncios.conectar({ chave: "chave-boa", limiteMensal: "100" });
    assert.deepEqual([r.conectado, r.limiteMensal, r.plano.porMes], [true, 100, 250]);
    assert.ok(api.chamadas.every((c) => c.caminho === "/account.json"));
    assert.ok(!JSON.stringify(await db.lerConfig("anuncios_meta")).includes("chave-boa"));
    // Só mudar o limite mantém a chave.
    assert.equal((await anuncios.conectar({ limiteMensal: "250" })).conectado, true);
  } finally {
    api.restaurar();
  }
});

test("anúncios: um anunciante por página, sem marca grande, com o WhatsApp do link e os que citam a cidade primeiro", async () => {
  const api = serpApiFalsa({
    paginas: [[
      anuncio("1", "100", { body: "Implante dentário, agende já", link: "https://api.whatsapp.com/send?phone=5585999990001&text=oi" }),
      anuncio("2", "100"), // mesma página: fica só uma
      anuncio("3", "200", { page_likes: 5_000_000 }), // marca nacional
      anuncio("4", "300"),
      anuncio("5", "400", { link: "https://www.instagram.com/clinica.sorriso/", body: "Sorria mais" }),
    ]],
  });
  try {
    await anuncios.conectar({ chave: "chave-boa", limiteMensal: "250" });
    const { empresas, buscas } = await anuncios.buscarAnunciantes({ nicho: "dentista", cidade: "Fortaleza - CE", quantidade: 20 });
    assert.equal(buscas, 1);
    const busca = api.chamadas.find((c) => c.caminho === "/search.json").params;
    assert.deepEqual([busca.engine, busca.q, busca.country, busca.active_status], ["meta_ad_library", "dentista Fortaleza", "BR", "active"]);
    assert.deepEqual(empresas.map((e) => e.page_id), ["300", "100", "400"]); // 300 cita Fortaleza; 100 tem WhatsApp
    assert.equal(empresas.find((e) => e.page_id === "100").telefone, "5585999990001");
    assert.equal(empresas.find((e) => e.page_id === "100").site, null);
    assert.equal(empresas.find((e) => e.page_id === "400").instagram, "clinica.sorriso");
    assert.equal(empresas[0].anuncio.biblioteca, "https://www.facebook.com/ads/library/?id=4");
  } finally {
    api.restaurar();
  }
});

test("anúncios: o limite do mês não deixa passar, e a busca automática gasta aos poucos", async () => {
  const api = serpApiFalsa({ paginas: [[anuncio("1", "500")], [anuncio("2", "600")]] });
  try {
    await anuncios.conectar({ chave: "chave-boa", limiteMensal: "3" });
    const agora = new Date("2030-03-01T15:00:00Z");
    await db.gravarEstado("anuncios_buscas:2030-03", 2);
    const r = await anuncios.buscarAnunciantes({ nicho: "dentista", cidade: "Fortaleza", quantidade: 40, maxBuscas: 2, agora });
    assert.equal(r.buscas, 1);
    assert.match(r.avisos[0], /limite de 3 buscas/);
    // Dia 1 de 31: com 3 por mês, só cabe 1 até hoje.
    await anuncios.conectar({ limiteMensal: "31" });
    await db.gravarEstado("anuncios_buscas:2030-03", 0);
    assert.equal(await anuncios.podeBuscarSozinho(agora), true);
    await db.gravarEstado("anuncios_buscas:2030-03", 1);
    assert.equal(await anuncios.podeBuscarSozinho(agora), false);
    assert.equal(await anuncios.podeBuscarSozinho(new Date("2030-03-15T15:00:00Z")), true);
  } finally {
    api.restaurar();
  }
});

test("anúncios: a captura guarda o anúncio no lead, e quem não tem por onde ser contatado fica de fora", async () => {
  const e = anuncios.empresaDoAnuncio(anuncio("9", "700", { link: "https://wa.me/5585988887777" }));
  const semNada = anuncios.empresaDoAnuncio(anuncio("10", "800", { link: "https://www.facebook.com/empresa800" }));
  assert.equal(semNada.site, null);
  const { novas } = await pipeline.capturarDosAnuncios([e, semNada], "dentista", "Fortaleza - CE");
  assert.equal(novas, 1);
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.place_id === "ad:700");
  assert.deepEqual([lead.origem, lead.telefone, lead.nome], ["anuncio", "5585988887777", "Empresa 700"]);
  assert.equal(JSON.parse(lead.anuncio).desde, "2026-10-20");
  // Capturar de novo não duplica.
  assert.equal((await pipeline.capturarDosAnuncios([e], "dentista", "Fortaleza - CE")).novas, 0);
  assert.equal(anuncios.whatsappDoLink("https://api.whatsapp.com/send?phone=85999990000"), "5585999990000");
  assert.equal(anuncios.instagramDoLink("https://www.instagram.com/p/abc123/"), null);
});

test("anúncios: quem anuncia só com 'Enviar mensagem no WhatsApp' ganha o contato pelo Instagram ou pelo Google Maps", async () => {
  assert.equal(anuncios.apelidoDaPagina("https://www.facebook.com/jabaautomoveis/"), "jabaautomoveis");
  assert.equal(anuncios.apelidoDaPagina("https://www.facebook.com/profile.php?id=123"), null);
  assert.equal(anuncios.mesmoNome("Jabá Automóveis", "Jaba Automoveis Osasco"), true);
  assert.equal(anuncios.mesmoNome("Criative Veiculos", "Prime Veículos Osasco"), false); // só "veículos" em comum
  const sem = (pagina, nome) => anuncios.empresaDoAnuncio(anuncio(pagina, pagina, { page_name: nome, link: "https://api.whatsapp.com/send", page_profile_link: `https://www.facebook.com/${nome.toLowerCase().replace(/\W/g, "")}/` }));
  const empresas = [sem("1", "Jabá Automóveis"), sem("2", "Tagma Car Service"), sem("3", "Loja Fantasma")];
  assert.ok(empresas.every((e) => !e.telefone && !e.site));
  const consultasMaps = [];
  await anuncios.completarContatos(empresas, "Osasco - SP", {
    instagram: async (u) => (u === "tagmacarservice" ? { usuario: "tagma.car", site: null, contatos: { whatsapp: "5511977776666", email: "contato@tagma.com.br" } } : null),
    maps: async (q) => {
      consultasMaps.push(q);
      return q.startsWith("Jabá") ? [{ nome: "Outra Loja", telefone: "+55 11 1111-1111" }, { nome: "Jaba Automoveis", telefone: "+55 11 3685-0000", site: "https://jaba.com.br", endereco: "Av. dos Autonomistas, Osasco" }] : [];
    },
  });
  assert.deepEqual([empresas[0].telefone, empresas[0].site, empresas[0].contatoDe], ["551136850000", "https://jaba.com.br", "maps"]);
  assert.deepEqual([empresas[1].telefone, empresas[1].instagram, empresas[1].email, empresas[1].contatoDe], ["5511977776666", "tagma.car", "contato@tagma.com.br", "instagram"]);
  assert.equal(empresas[2].telefone, null);
  assert.deepEqual(consultasMaps, ["Jabá Automóveis Osasco", "Loja Fantasma Osasco"]); // a do Instagram não precisou do Maps
});

test("anúncios: cortar o texto não parte emoji ao meio", () => {
  const texto = `${"a".repeat(399)}🚗 depois`;
  const cortado = anuncios.cortar(texto, 400);
  assert.equal(cortado, `${"a".repeat(399)}🚗`);
  assert.equal(cortado.isWellFormed(), true);
  assert.equal(anuncios.cortar("x\uD83D", 10).isWellFormed(), true); // meio emoji que já veio partido
});

test("anúncios: a empresa que já veio pelo Google Maps não entra de novo pelo anúncio", async () => {
  await db.inserirLead({ place_id: "maps-jaba", nome: "Jaba Automoveis", nicho: "concessionária", cidade: "Osasco - SP", endereco: null, telefone: "+55 11 3683-4600", site: null, maps_url: null, avaliacao: null, total_avaliacoes: null });
  const e = { ...anuncios.empresaDoAnuncio(anuncio("50", "5000", { link: "https://api.whatsapp.com/send" })), telefone: "551136834600", contatoDe: "maps", mapsPlaceId: "maps-jaba" };
  assert.equal((await pipeline.capturarDosAnuncios([e], "concessionária", "Osasco - SP")).novas, 0);
});
