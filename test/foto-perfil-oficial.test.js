import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TEMPLATE", "WHATSAPP_TEMPLATE_IDIOMA", "WHATSAPP_APP_SECRET"]) delete process.env[k];
const db = await import("../src/db.js");
const wa = await import("../src/envio/whatsapp.js");
await db.iniciar();

test("foto do perfil: sobe pela API de upload do app e grava o handle no perfil do número", async () => {
  const chamadas = [];
  const buscar = async (url, op = {}) => {
    chamadas.push({ url, metodo: op.method ?? "GET", corpo: op.body, cab: op.headers });
    const json = (d) => ({ ok: true, status: 200, json: async () => d });
    if (url.endsWith("/app")) return json({ id: "777" });
    if (url.includes("/777/uploads")) return json({ id: "upload:abc" });
    if (url.endsWith("/upload:abc")) return json({ h: "HANDLE1" });
    if (url.includes("/5551/whatsapp_business_profile")) return json({ success: true });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "5551", data: [] }) });
  await wa.salvarConfig({ token: "EAAprincipal", phoneNumberId: "5551", template: "proposta_inicial", idioma: "pt_BR", ativo: true });
  globalThis.fetch = real;
  const imagem = Buffer.from("fakejpeg");
  await wa.trocarFotoDoPerfil(null, imagem, "image/jpeg", { buscar });
  assert.match(chamadas[1].url, /\/777\/uploads\?file_length=8&file_type=image%2Fjpeg/);
  assert.equal(chamadas[2].cab.file_offset, "0");
  assert.equal(chamadas[2].corpo, imagem);
  assert.deepEqual(JSON.parse(chamadas[3].corpo), { messaging_product: "whatsapp", profile_picture_handle: "HANDLE1" });
  await assert.rejects(wa.trocarFotoDoPerfil(null, imagem, "image/gif", { buscar }), /JPG ou PNG/);
});
