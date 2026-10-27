import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const evolution = await import("../src/envio/evolution.js");
const { modoWhatsapp } = await import("../src/pipeline.js");

const resposta = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

/** Troca o fetch por um servidor falso da Evolution; devolve as chamadas feitas. */
function servidorFalso(rotas) {
  const chamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    const chave = `${opcoes.method ?? "GET"} ${u.pathname}`;
    chamadas.push({ chave, busca: u.search, corpo: opcoes.body ? JSON.parse(opcoes.body) : null, apikey: opcoes.headers?.apikey });
    const rota = rotas[chave];
    if (!rota) return resposta(404, { response: { message: [`sem rota ${chave}`] } });
    return rota(u);
  };
  return { chamadas, restaurar: () => { globalThis.fetch = original; } };
}

test("extrairMensagemEvolution lê o evento messages.upsert", () => {
  const base = { event: "messages.upsert", instance: "fluxdeck", data: { key: { remoteJid: "5585988887777@s.whatsapp.net", fromMe: false, id: "E1" },
    pushName: "Ana", message: { conversation: "Tenho interesse" } } };
  assert.deepEqual(evolution.extrairMensagemEvolution(base), { id: "E1", de: "5585988887777", texto: "Tenho interesse", nome: "Ana" });
  const estendida = { ...base, data: { ...base.data, message: { extendedTextMessage: { text: "Quanto custa?" } } } };
  assert.equal(evolution.extrairMensagemEvolution(estendida).texto, "Quanto custa?");
  // Com @lid, o telefone vem no remoteJidAlt.
  const lid = { ...base, data: { ...base.data, key: { ...base.data.key, remoteJid: "123@lid", remoteJidAlt: "5585911112222@s.whatsapp.net" } } };
  assert.equal(evolution.extrairMensagemEvolution(lid).de, "5585911112222");
  assert.equal(evolution.extrairMensagemEvolution({ ...base, data: { ...base.data, key: { ...base.data.key, fromMe: true } } }), null);
  assert.equal(evolution.extrairMensagemEvolution({ ...base, data: { ...base.data, key: { ...base.data.key, remoteJid: "1203@g.us" } } }), null);
  assert.equal(evolution.extrairMensagemEvolution({ ...base, event: "connection.update" }), null);
});

test("resumirStatus da Evolution: conectado, QR code e código de pareamento", () => {
  assert.equal(evolution.resumirStatus({ instance: { instanceName: "x", state: "open" } }).conectado, true);
  assert.equal(evolution.resumirStatus({ instance: { state: "close" } }).estado, "disconnected");
  const qr = evolution.resumirStatus({ pairingCode: "ABCD1234", code: "2@...", base64: "data:image/png;base64,AAA", count: 1 });
  assert.equal(qr.estado, "connecting");
  assert.equal(qr.qrcode, "data:image/png;base64,AAA");
  assert.equal(qr.paircode, "ABCD1234");
});

test("Evolution: salvar cria a instância que não existe e configura o webhook", async () => {
  const srv = servidorFalso({
    "POST /instance/create": () => resposta(201, { instance: { instanceName: "fluxdeck" } }),
    "POST /webhook/set/fluxdeck": () => resposta(201, {}),
  });
  try {
    await evolution.salvarConfig({ url: "https://evo.exemplo.com/", apikey: "GLOBAL", instancia: "fluxdeck" });
    const destino = await evolution.configurarWebhook();
    assert.match(destino, /\/webhooks\/evolution\/[0-9a-f]{36}$/);
    const criar = srv.chamadas.find((c) => c.chave === "POST /instance/create");
    assert.equal(criar.corpo.instanceName, "fluxdeck");
    assert.equal(criar.apikey, "GLOBAL");
    const webhook = srv.chamadas.find((c) => c.chave === "POST /webhook/set/fluxdeck");
    assert.deepEqual(webhook.corpo.webhook.events, ["MESSAGES_UPSERT"]);

    const segredo = destino.split("/").pop();
    assert.equal(await evolution.webhookValido(segredo, { instance: "fluxdeck" }), true);
    assert.equal(await evolution.webhookValido(segredo, { instance: "outra" }), false);
    assert.equal(await evolution.webhookValido("errado", { instance: "fluxdeck" }), false);
  } finally {
    srv.restaurar();
  }
});

test("com a UAZap desconectada e a Evolution conectada, o WhatsApp sai pela Evolution", async () => {
  await db.gravarConfig("uazap", { url: "https://x.uazapi.com", token: "T", segredoWebhook: "s" });
  const srv = servidorFalso({
    "GET /instance/status": () => resposta(200, { instance: { status: "disconnected" }, status: { connected: false } }),
    "GET /instance/connectionState/fluxdeck": () => resposta(200, { instance: { instanceName: "fluxdeck", state: "open" } }),
    "GET /instance/fetchInstances": () => resposta(200, [{ name: "fluxdeck", ownerJid: "5585900000000@s.whatsapp.net", profileName: "FluxDeck" }]),
    "POST /message/sendText/fluxdeck": () => resposta(201, { key: { id: "MSG-1" } }),
    "POST /chat/whatsappNumbers/fluxdeck": () => resposta(200, [{ exists: true, jid: "558588887777@s.whatsapp.net", number: "5585988887777" }]),
  });
  try {
    assert.equal(await modoWhatsapp(), "evolution");
    assert.equal(await evolution.enviarTexto("+55 (85) 98888-7777", "Oi"), "MSG-1");
    const envio = srv.chamadas.find((c) => c.chave === "POST /message/sendText/fluxdeck");
    assert.deepEqual({ number: envio.corpo.number, text: envio.corpo.text }, { number: "5585988887777", text: "Oi" });
    assert.deepEqual(await evolution.verificarNumeros(["5585988887777"]), [{ consulta: "5585988887777", existe: true, numero: "558588887777" }]);
    assert.equal((await evolution.status()).numero, "5585900000000");
  } finally {
    srv.restaurar();
  }
});

test("Evolution: a URL do /manager vira a da API, e página que não é a API é recusada", async () => {
  assert.equal(evolution.normalizarUrl("https://evo.exemplo.com/manager/"), "https://evo.exemplo.com");
  assert.equal(evolution.normalizarUrl("https://evo.exemplo.com/manager/instance/123"), "https://evo.exemplo.com");
  assert.equal(evolution.normalizarUrl(" https://evo.exemplo.com/ "), "https://evo.exemplo.com");

  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><title>Manager</title>", { status: 200, headers: { "Content-Type": "text/html" } });
  try {
    await assert.rejects(evolution.salvarConfig({ url: "https://evo.exemplo.com", apikey: "K", instancia: "x" }), /sem \/manager/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Evolution: garantirWebhook só configura de novo quando o webhook não aponta para cá", async () => {
  await db.gravarConfig("evolution", { url: "https://evo.exemplo.com", apikey: "K", instancia: "fluxdeck", segredoWebhook: "seg" });
  let atual = null;
  const srv = servidorFalso({
    "GET /webhook/find/fluxdeck": () => resposta(200, atual),
    "POST /webhook/set/fluxdeck": () => resposta(201, {}),
  });
  try {
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(await evolution.garantirWebhook(), true); // nenhum webhook: configura
    const destino = srv.chamadas.find((c) => c.chave === "POST /webhook/set/fluxdeck").corpo.webhook.url;
    atual = { enabled: true, url: destino, events: ["MESSAGES_UPSERT"] };
    assert.equal(await evolution.garantirWebhook(), false); // já certo: não mexe
  } finally {
    srv.restaurar();
  }
});
