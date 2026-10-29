import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const {
  hashtagsDaBusca, perfisCitados, contatosDoPerfil, usuarioDoLink, reservarHashtags, hashtagsRestantes,
  buscarEmpresasNoInstagram, buscaNoInstagram, LIMITE_HASHTAGS,
} = await import("../src/descoberta/instagram.js");
const pipeline = await import("../src/pipeline.js");

const conectar = (host = "graph.facebook.com") =>
  db.gravarConfig("instagram", { token: "EAApagina", host, igId: "17841", usuario: "fluxdeck_" });

const PERFIS = {
  petlegal: {
    username: "petlegal", name: "Pet Legal Fortaleza", followers_count: 4200, media_count: 380,
    biography: "Banho e tosa 🐶\n📲 WhatsApp (85) 99876-5432\npetlegal@gmail.com", website: "https://linktr.ee/petlegal",
    media: { data: [{ timestamp: "2026-10-20T12:00:00+0000" }] },
  },
  vetcenter: {
    username: "vetcenter", name: "Vet Center", followers_count: 900, media_count: 50,
    biography: "Clínica veterinária", website: "https://wa.me/5585988887777",
  },
};

/** Meta de mentira: hashtag → posts com @perfis citados; business discovery só para os perfis comerciais. */
function metaFalsa(pedidos = []) {
  return async (url) => {
    const u = new URL(url);
    pedidos.push(u);
    const responder = (corpo, status = 200) => ({ ok: status === 200, status, json: async () => corpo });
    if (u.pathname.endsWith("/ig_hashtag_search")) return responder({ data: [{ id: "tag1" }] });
    if (u.pathname.endsWith("/tag1/top_media")) {
      return responder({ data: [{ caption: "Dia de spa com @petlegal 🐾 fale com contato@x.com" }, { caption: "Parceria @petlegal e @maria.silva" }] });
    }
    if (u.pathname.endsWith("/tag1/recent_media")) return responder({ data: [{ caption: "Visite a @vetcenter." }] });
    const usuario = u.searchParams.get("fields")?.match(/business_discovery\.username\(([^)]+)\)/)?.[1];
    if (usuario) {
      const perfil = PERFIS[usuario];
      return perfil ? responder({ business_discovery: perfil }) : responder({ error: { code: 110, message: "Invalid user id" } }, 400);
    }
    return responder({ error: { message: `inesperado ${u.pathname}` } }, 400);
  };
}

async function comMeta(fn) {
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = metaFalsa(pedidos);
  try {
    return await fn(pedidos);
  } finally {
    globalThis.fetch = original;
  }
}

test("instagram (captação): hashtag do segmento + cidade, @ citados e contatos da bio", () => {
  assert.deepEqual(hashtagsDaBusca("pet shop", "Fortaleza - CE"), ["petshopfortaleza"]);
  assert.deepEqual(hashtagsDaBusca("Clínica Odontológica", "São Paulo, SP"), ["clinicaodontologicasaopaulo"]);
  assert.deepEqual(perfisCitados("Com @petlegal e @maria.silva. Mande para contato@x.com @petlegal"), ["petlegal", "maria.silva"]);
  assert.deepEqual(contatosDoPerfil("📲 WhatsApp (85) 99876-5432\nPetLegal@Gmail.com"), {
    email: "petlegal@gmail.com", whatsapp: null, telefone: "+55 85 998765432",
  });
  assert.equal(contatosDoPerfil("", "https://wa.me/5585988887777").whatsapp, "5585988887777");
  assert.equal(usuarioDoLink("https://www.instagram.com/petlegal/"), "petlegal");
  assert.equal(usuarioDoLink("https://instagram.com/p/abc123"), null);
});

test("instagram (captação): só com o token da página do Facebook", async () => {
  await db.gravarConfig("instagram", {});
  assert.match((await buscaNoInstagram()).motivo, /Conecte o Instagram/);
  await conectar("graph.instagram.com");
  assert.match((await buscaNoInstagram()).motivo, /página do Facebook/);
  await assert.rejects(buscarEmpresasNoInstagram({ nicho: "pet shop", cidade: "Fortaleza - CE" }), /página do Facebook/);
});

test("instagram (captação): limite da Meta de 30 hashtags por semana", async () => {
  await db.gravarEstado("instagram_hashtags", "{}");
  const agora = new Date("2026-10-29T12:00:00Z");
  const tags = Array.from({ length: LIMITE_HASHTAGS + 2 }, (_, i) => `tag${i}`);
  assert.equal((await reservarHashtags(tags, agora)).length, LIMITE_HASHTAGS);
  assert.equal(await hashtagsRestantes(agora), 0);
  // Hashtag já consultada na semana pode repetir; nova não.
  assert.deepEqual(await reservarHashtags(["tag0", "outra"], agora), ["tag0"]);
  // Passados 7 dias, libera de novo.
  assert.deepEqual(await reservarHashtags(["outra"], new Date("2026-11-06T12:00:00Z")), ["outra"]);
  await db.gravarEstado("instagram_hashtags", "{}");
});

test("instagram (captação): busca pela hashtag, fica com os perfis comerciais e captura sem repetir", async () => {
  await conectar();
  await comMeta(async (pedidos) => {
    const r = await pipeline.buscarNoInstagram("pet shop", "Fortaleza - CE");
    assert.deepEqual(r.hashtags, ["petshopfortaleza"]);
    assert.equal(pedidos[0].searchParams.get("q"), "petshopfortaleza");
    assert.equal(pedidos[0].searchParams.get("user_id"), "17841");
    // @maria.silva não é conta comercial: fica de fora.
    assert.deepEqual(r.empresas.map((e) => e.instagram).sort(), ["petlegal", "vetcenter"]);
    const pet = r.empresas.find((e) => e.instagram === "petlegal");
    assert.equal(pet.place_id, "ig:petlegal");
    assert.equal(pet.nome, "Pet Legal Fortaleza");
    assert.equal(pet.telefone, "+55 85 998765432");
    assert.equal(pet.email, "petlegal@gmail.com");
    assert.equal(pet.semSite, true); // linktree não é site próprio
    assert.equal(pet.instagram_dados.seguidores, 4200);

    // Uma empresa do Maps com o link do Instagram no Google já conta como capturada.
    await db.inserirLead({ place_id: "maps-vet", nome: "Vet Center", site: "https://www.instagram.com/vetcenter/", origem: "maps" });
    assert.deepEqual(await pipeline.capturarDoInstagram(r.empresas, "pet shop", "Fortaleza - CE"), { novas: 1 });
    assert.deepEqual(await pipeline.capturarDoInstagram(r.empresas, "pet shop", "Fortaleza - CE"), { novas: 0 });
    const nova = await pipeline.buscarNoInstagram("pet shop", "Fortaleza - CE");
    assert.equal(nova.empresas.every((e) => e.jaCapturado), true);

    // A análise usa a bio: e-mail e WhatsApp, e a oportunidade cita o Instagram.
    const lead = (await db.leadsPorStatus("novo")).find((l) => l.instagram === "petlegal");
    assert.equal(lead.origem, "instagram");
    await pipeline.analisar({ ate: Date.now() + 600_000 });
    const analisado = await db.buscarLead(lead.id);
    assert.equal(analisado.status, "analisado");
    assert.equal(analisado.email, "petlegal@gmail.com");
    assert.equal(analisado.whatsapp, "5585998765432");
    assert.match(JSON.parse(analisado.oportunidades)[0].motivo, /Instagram \(@petlegal, 4\.200 seguidores\)/);

    // A empresa do Maps com o Instagram como site ganha o WhatsApp do link da bio.
    const vet = await db.buscarLead((await db.listarLeads(["analisado", "descartado"])).find((l) => l.place_id === "maps-vet").id);
    assert.equal(vet.instagram, "vetcenter");
    assert.equal(vet.whatsapp, "5585988887777");
  });
});

test("instagram (captação): @perfis informados no painel e erro da hashtag sem o recurso liberado", async () => {
  await conectar();
  const original = globalThis.fetch;
  const meta = metaFalsa();
  globalThis.fetch = async (url) => {
    if (String(url).includes("ig_hashtag_search")) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 10, message: "Application does not have permission for this action" } }) };
    }
    return meta(url);
  };
  try {
    const r = await buscarEmpresasNoInstagram({ nicho: "pet shop", cidade: "Fortaleza - CE", termos: "#banhoetosa @PetLegal" });
    assert.deepEqual(r.empresas.map((e) => e.instagram), ["petlegal"]);
    assert.match(r.avisos.join(" "), /#banhoetosa: Application does not have permission/);
  } finally {
    globalThis.fetch = original;
  }
});
