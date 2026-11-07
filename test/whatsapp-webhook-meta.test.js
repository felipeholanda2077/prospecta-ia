import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "UAZAP_URL", "UAZAP_TOKEN"]) delete process.env[k];
const { config } = await import("../src/config.js");
const wa = await import("../src/envio/whatsapp.js");

/** Meta de mentira: app 77 com o webhook pedido, e a conta waba1 com (ou sem) o app ligado. */
function meta({ callback, campos = ["messages"], appLigado = true }) {
  const antes = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(url);
    const auth = opcoes.headers?.Authorization;
    if (u.pathname.endsWith("/77/subscriptions")) {
      if (auth !== "Bearer 77|segredo") return Response.json({ error: { code: 190, message: "bad" } }, { status: 401 });
      return Response.json({ data: callback ? [{ object: "whatsapp_business_account", callback_url: callback, active: true, fields: campos.map((name) => ({ name, version: "v21.0" })) }] : [] });
    }
    if (auth !== "Bearer EAAtoken") return Response.json({ error: { code: 190, message: "bad" } }, { status: 401 });
    if (u.pathname.endsWith("/app")) return Response.json({ id: "77" });
    if (u.pathname.endsWith("/debug_token")) return Response.json({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["waba1"] }] } });
    if (u.pathname.endsWith("/waba1/phone_numbers")) return Response.json({ data: [{ id: "5551" }] });
    if (u.pathname.endsWith("/waba1/subscribed_apps")) return Response.json({ data: appLigado ? [{ whatsapp_business_api_data: { id: "77", name: "Prospecta" } }] : [] });
    if (u.pathname.endsWith("/5551")) return Response.json({ display_phone_number: "+55 11 93901-7351", verified_name: "FluxDeck" });
    return Response.json({ error: { code: 100, message: "Unsupported get request" } }, { status: 400 });
  };
  return () => (globalThis.fetch = antes);
}

const c = { apiVersion: "v21.0", token: "EAAtoken", phoneNumberId: "5551", appSecret: "segredo" };

test("webhook da API oficial: o painel confere na Meta se as respostas já chegam ao sistema", async () => {
  const certo = `${config.painel.urlPublica}/webhooks/whatsapp`;
  let fim = meta({ callback: certo });
  try { assert.equal((await wa.situacaoDoWebhook(c)).pronto, true); } finally { fim(); }

  fim = meta({ callback: "https://outro-sistema.com/hook" });
  try {
    const w = await wa.situacaoDoWebhook(c);
    assert.deepEqual([w.pronto, w.urlCerta, w.url], [false, false, "https://outro-sistema.com/hook"]);
  } finally { fim(); }

  fim = meta({ callback: certo, campos: ["account_update"] });
  try { assert.deepEqual([(await wa.situacaoDoWebhook(c)).pronto, (await wa.situacaoDoWebhook(c)).messages], [false, false]); } finally { fim(); }

  fim = meta({ callback: certo, appLigado: false });
  try { assert.deepEqual([(await wa.situacaoDoWebhook(c)).pronto, (await wa.situacaoDoWebhook(c)).contaLigada], [false, false]); } finally { fim(); }

  fim = meta({ callback: null });
  try { const w = await wa.situacaoDoWebhook(c); assert.deepEqual([w.pronto, w.url], [false, null]); } finally { fim(); }

  // Sem a chave secreta não dá para ler o webhook do app: não afirma nada sobre ele.
  fim = meta({ callback: certo });
  try { const w = await wa.situacaoDoWebhook({ ...c, appSecret: "" }); assert.deepEqual([w.pronto, w.urlCerta], [false, null]); } finally { fim(); }
});
