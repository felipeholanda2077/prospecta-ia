import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const { config } = await import("../src/config.js");
const { escreverComReserva } = await import("../src/ia/conteudo.js");
const { narrarCenas, vozDoPost, VOZES } = await import("../src/conteudo/narracao.js");

test("conteúdo: os Reels são escritos pelo Claude Opus 5.5; se ele falhar, o modelo de reserva escreve", async () => {
  assert.equal(config.conteudo.model, process.env.CONTEUDO_MODEL || "claude-opus-5-5");
  const conf = { model: "claude-opus-5-5", effort: "medium", reserva: "claude-sonnet-5-5" };
  const chamadas = [];
  const r = await escreverComReserva({ system: "s", pedido: "p" }, { conf, gerar: async (o) => (chamadas.push(o), { ok: o.modelo }) });
  assert.deepEqual(r, { ok: "claude-opus-5-5" });
  assert.equal(chamadas[0].effort, "medium");
  assert.ok(chamadas[0].limiteMs < 300_000); // a Vercel corta a função em 5 minutos

  chamadas.length = 0;
  const reserva = await escreverComReserva({ system: "s", pedido: "p" }, {
    conf,
    gerar: async (o) => {
      chamadas.push(o.modelo);
      if (o.modelo === "claude-opus-5-5") throw new Error("demorou demais");
      return { ok: o.modelo };
    },
  });
  assert.deepEqual(chamadas, ["claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.deepEqual(reserva, { ok: "claude-sonnet-5-5" });
  await assert.rejects(escreverComReserva({}, { conf: { ...conf, reserva: "" }, gerar: async () => { throw new Error("caiu"); } }), /caiu/);
});

test("voz: feminina nos Reels sem o Felipe, masculina com ele; posts antigos seguem a regra de antes", () => {
  assert.equal(vozDoPost({ id: 2, conteudo: { voz: "feminina", comFelipe: false } }), "feminina");
  assert.equal(vozDoPost({ id: 1, conteudo: { voz: "masculina", comFelipe: true } }), "masculina");
  assert.equal(vozDoPost({ id: 1, conteudo: { comFelipe: true } }), "masculina"); // o avatar fala com a voz da narração
  assert.equal(vozDoPost({ id: 1, conteudo: {} }), "feminina");
  assert.equal(vozDoPost({ id: 0 }), "masculina"); // mensagens de voz do WhatsApp
  assert.match(VOZES.feminina.edge[0], /^pt-BR-.*Neural$/);
});

test("voz: o serviço de voz usa a voz do post e o jeito de falar dela", async () => {
  const chaves = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "GEMINI_API_KEY"];
  const antes = Object.fromEntries(chaves.map((k) => [k, process.env[k]]));
  const fetchAntes = globalThis.fetch;
  const slides = [{ visual: "capa", titulo: "Um", texto: "", destaque: "", fala: "Um." }, { visual: "cta", titulo: "Dois", texto: "", destaque: "", fala: "Dois." }];
  const post = (voz) => ({ id: 4, formato: "reels", conteudo: { gancho: "G", arte: "cor", trilha: "tensa", estrutura: "lista", hashtags: [], legenda: "", voz, slides } });
  const pedidos = [];
  globalThis.fetch = async (url, opcoes) => {
    pedidos.push(JSON.parse(opcoes.body));
    return new Response(Buffer.alloc(4800));
  };
  try {
    chaves.forEach((k) => delete process.env[k]);
    process.env.OPENAI_API_KEY = "sk-teste";
    await narrarCenas(post("feminina"));
    await narrarCenas(post("masculina"));
    assert.deepEqual(pedidos.map((p) => p.voice), ["coral", "coral", "ash", "ash"]);
    assert.match(pedidos[0].instructions, /Locutora/);
    assert.match(pedidos[2].instructions, /Locutor brasileiro/);
  } finally {
    globalThis.fetch = fetchAntes;
    chaves.forEach((k) => (antes[k] === undefined ? delete process.env[k] : (process.env[k] = antes[k])));
  }
});
