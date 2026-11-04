import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN"]) delete process.env[k];
const db = await import("../src/db.js");
const { fotoDoLead } = await import("../src/respostas/fotos.js");

await db.gravarConfig("uazap", { numeros: [{ id: "principal", nome: "Principal", url: "https://x.uazapi.com", token: "A", segredoWebhook: "s1" }] });

async function lead(nome, extra = {}) {
  await db.inserirLead({ place_id: nome, nome, nicho: "loja", cidade: "SP", ...extra });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [nome]);
  if (extra.whatsapp || extra.instagram_dados) await db.atualizarLead(l.id, { whatsapp: extra.whatsapp ?? null, instagram_dados: extra.instagram_dados ?? null });
  return l.id;
}
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const baixar = async (url) => (url.includes("sem-imagem") ? new Response("nao", { headers: { "content-type": "text/html" } }) : new Response(png, { headers: { "content-type": "image/jpeg" } }));

test("foto de perfil: busca no WhatsApp uma vez, guarda e só renova depois de 7 dias", async () => {
  const id = await lead("Com Foto", { whatsapp: "5511999990000" });
  let buscas = 0;
  const foto = async (numero) => { buscas++; assert.equal(numero, "5511999990000"); return "https://pps.whatsapp.net/foto.jpg"; };
  const f1 = await fotoDoLead(id, { foto, baixar });
  assert.equal(f1.tipo, "image/jpeg");
  assert.deepEqual([...f1.dados], [...png]);
  await fotoDoLead(id, { foto, baixar });
  assert.equal(buscas, 1); // a segunda vem guardada
  await fotoDoLead(id, { foto, baixar, agora: Date.now() + 8 * 864e5 });
  assert.equal(buscas, 2); // venceu: busca de novo
});

test("foto de perfil: sem foto no WhatsApp usa a do Instagram; sem nenhuma, fica guardado que não tem", async () => {
  const insta = await lead("So Instagram", { whatsapp: "5511999990001", instagram_dados: JSON.stringify({ foto: "https://cdn.instagram.com/p.jpg" }) });
  assert.equal((await fotoDoLead(insta, { foto: async () => "", baixar })).tipo, "image/jpeg");

  const nada = await lead("Sem Foto", { whatsapp: "5511999990002" });
  let buscas = 0;
  assert.equal(await fotoDoLead(nada, { foto: async () => { buscas++; return ""; }, baixar }), null);
  assert.equal(await fotoDoLead(nada, { foto: async () => { buscas++; return ""; }, baixar }), null);
  assert.equal(buscas, 1); // "sem foto" também fica guardado

  // Link que não é imagem não vira foto; a UAZap fora do ar também não quebra nada.
  const ruim = await lead("Link Ruim", { whatsapp: "5511999990003" });
  assert.equal(await fotoDoLead(ruim, { foto: async () => "https://x/sem-imagem", baixar }), null);
  const fora = await lead("UAZap Fora", { whatsapp: "5511999990004" });
  assert.equal(await fotoDoLead(fora, { foto: async () => { throw new Error("fora do ar"); }, baixar }), null);
  assert.equal(await fotoDoLead(999999, { foto: async () => "x", baixar }), null);
});
