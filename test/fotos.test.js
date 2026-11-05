import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN"]) delete process.env[k];
const db = await import("../src/db.js");
const { fotoDoLead, salvarFotosDasEmpresas } = await import("../src/respostas/fotos.js");

await db.gravarConfig("uazap", { numeros: [{ id: "principal", nome: "Principal", url: "https://x.uazapi.com", token: "A", segredoWebhook: "s1" }] });

async function lead(nome, extra = {}) {
  await db.inserirLead({ place_id: nome, nome, nicho: "loja", cidade: "SP", ...extra });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [nome]);
  if (extra.whatsapp || extra.instagram_dados) await db.atualizarLead(l.id, { whatsapp: extra.whatsapp ?? null, instagram_dados: extra.instagram_dados ?? null });
  return l.id;
}
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const baixar = async (url) => (url.includes("sem-imagem") ? new Response("nao", { headers: { "content-type": "text/html" } }) : new Response(png, { headers: { "content-type": "image/jpeg" } }));

test("foto de perfil: baixada uma vez e salva; a tela nunca busca de novo, mesmo meses depois", async () => {
  const id = await lead("Com Foto", { whatsapp: "5511999990000" });
  let buscas = 0;
  const foto = async (numero) => { buscas++; assert.equal(numero, "5511999990000"); return "https://pps.whatsapp.net/foto.jpg"; };
  const f1 = await fotoDoLead(id, { foto, baixar });
  assert.equal(f1.tipo, "image/jpeg");
  assert.deepEqual([...f1.dados], [...png]);
  await fotoDoLead(id, { foto, baixar });
  assert.equal((await fotoDoLead(id, { foto, baixar, agora: Date.now() + 90 * 864e5 })).tipo, "image/jpeg");
  assert.equal(buscas, 1); // salva: sai do banco, sem ir ao WhatsApp

  // A limpeza das fotos dos posts (prefixo "foto-") não apaga a foto de perfil.
  await db.consultar("UPDATE midias SET criada_em = now() - interval '60 days' WHERE chave = $1", [`foto-lead-${id}`]);
  await db.apagarMidiasAntigas("foto-", 30);
  await db.apagarMidias("post-1-");
  assert.equal((await fotoDoLead(id, { foto, baixar })).tipo, "image/jpeg");
  assert.equal(buscas, 1);
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

test("foto de perfil: a rodada salva as fotos das conversas aos poucos e renova a cada 7 dias sem perder a salva", async () => {
  await db.consultar("DELETE FROM midias WHERE chave LIKE 'foto-lead-%'");
  const conversa = await lead("Conversa", { whatsapp: "5511988880000" });
  await db.criarMensagem({ lead_id: conversa, canal: "whatsapp", destino: "5511988880000", corpo: "Oi", status: "enviada" });
  const respondeu = await lead("Respondeu", { whatsapp: "5511988880001" });
  await db.criarResposta({ lead_id: respondeu, canal: "whatsapp", origem_id: "f-1", de: "5511988880001", texto: "Oi", classificacao: "outro", resumo: "oi" });
  await lead("Nunca Contatada", { whatsapp: "5511988880002" }); // só aparece se alguém abrir: não gasta busca

  const pedidos = [];
  const foto = async (numero) => { pedidos.push(numero); return "https://pps.whatsapp.net/f.jpg"; };
  assert.deepEqual(await salvarFotosDasEmpresas({ foto, baixar, limite: 1 }), { conferidas: 1, salvas: 1 }); // poucas por rodada
  await salvarFotosDasEmpresas({ foto, baixar });
  assert.deepEqual(pedidos.sort(), ["5511988880000", "5511988880001"]);
  assert.deepEqual(await salvarFotosDasEmpresas({ foto, baixar }), { conferidas: 0, salvas: 0 }); // já salvas

  // 7 dias depois procura uma foto nova; se a empresa tirou a foto (ou a UAZap falhou), a salva continua.
  const daqui8 = Date.now() + 8 * 864e5;
  assert.equal((await salvarFotosDasEmpresas({ foto: async () => "", baixar, agora: daqui8 })).salvas, 2);
  assert.equal((await fotoDoLead(conversa, { foto: async () => "", baixar })).tipo, "image/jpeg");
  await salvarFotosDasEmpresas({ foto: async () => { throw new Error("fora do ar"); }, baixar, agora: Date.now() + 16 * 864e5 });
  assert.equal((await fotoDoLead(respondeu, { foto: async () => "", baixar })).tipo, "image/jpeg");
});

test("foto de perfil: quem não tem foto é conferido de novo depois de 3 dias", async () => {
  const id = await lead("Sem Foto Ainda", { whatsapp: "5511977770000" });
  await db.criarMensagem({ lead_id: id, canal: "whatsapp", destino: "5511977770000", corpo: "Oi", status: "enviada" });
  assert.equal(await fotoDoLead(id, { foto: async () => "", baixar }), null);
  assert.equal(await fotoDoLead(id, { foto: async () => "https://pps.whatsapp.net/n.jpg", baixar, agora: Date.now() + 2 * 864e5 }), null); // ainda não
  assert.equal((await fotoDoLead(id, { foto: async () => "https://pps.whatsapp.net/n.jpg", baixar, agora: Date.now() + 4 * 864e5 })).tipo, "image/jpeg");
});
