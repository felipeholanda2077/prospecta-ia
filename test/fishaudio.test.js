import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA ??= "senha-de-teste";
for (const k of ["RUNWAY_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
const db = await import("../src/db.js");
const fish = await import("../src/conteudo/fishaudio.js");
const pipeline = await import("../src/pipeline.js");

const CHAVE = "fish-chave-falsa";

/** Um WAV curto e válido (silêncio), para o ffmpeg converter como se fosse a voz. */
function wav(segundos = 0.3, taxa = 24000) {
  const dados = Buffer.alloc(Math.round(segundos * taxa) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dados.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(taxa, 24);
  h.writeUInt32LE(taxa * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(dados.length, 40);
  return Buffer.concat([h, dados]);
}

/** Fish Audio (e OpenAI, a voz de reserva) de mentira, que anotam o que receberam. */
function servicosFalsos({ ttsFalha = false } = {}) {
  const pedidos = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    pedidos.push({ host: u.host, caminho: u.pathname, busca: u.search, cabecalhos: opcoes.headers ?? {}, corpo });
    if (u.host === "api.openai.com") return new Response(Buffer.alloc(24000));
    if (opcoes.headers?.Authorization !== `Bearer ${CHAVE}`) return Response.json({ status: 401, message: "Invalid token" }, { status: 401 });
    if (u.pathname === "/wallet/self/api-credit") return Response.json({ _id: "w", user_id: "u", credit: "12.3456", has_free_credit: false });
    if (u.pathname === "/model") {
      const self = u.searchParams.get("self") === "true";
      return Response.json({ total: 1, items: [self
        ? { _id: "minha", title: "Felipe clone", languages: ["pt"], author: { nickname: "eu" } }
        : { _id: "publica", title: "Narradora BR", languages: ["pt"], author: { nickname: "x" }, task_count: 9, samples: [{ audio: "https://exemplo/a.mp3" }] }] });
    }
    if (u.pathname === "/v1/tts") return ttsFalha ? Response.json({ status: 402, message: "No credit" }, { status: 402 }) : new Response(wav());
    return Response.json({}, { status: 404 });
  };
  return { pedidos, restaurar: () => (globalThis.fetch = original) };
}

test("Fish Audio: a chave é conferida e guardada cifrada; o saldo aparece", async () => {
  const f = servicosFalsos();
  try {
    assert.match((await fish.salvar({ chave: "chave-errada" })).erro, /recusou a chave/);
    assert.equal((await fish.situacao()).conectado, false);
    const s = await fish.salvar({ chave: ` ${CHAVE} ` });
    assert.equal(s.conectado, true);
    assert.equal(s.modo, "teste");
    const guardado = JSON.stringify(await db.lerConfig("fishaudio"));
    assert.ok(!guardado.includes(CHAVE), "a chave não pode ficar aberta no banco");
    assert.deepEqual(await fish.creditos(), { valor: 12.3456, creditoGratis: false });
    // Produção sem voz escolhida não liga.
    assert.match((await fish.salvar({ modo: "producao" })).erro, /Escolha a voz/);
    const vozes = await fish.vozes();
    assert.deepEqual(vozes.map((v) => [v.id, v.propria]), [["minha", true], ["publica", false]]);
    assert.ok(f.pedidos.some((p) => p.caminho === "/model" && p.busca.includes("language=pt")));
  } finally {
    f.restaurar();
  }
});

test("Fish Audio: o áudio de teste usa a voz e o modelo escolhidos e fica entre os últimos", async () => {
  const f = servicosFalsos();
  try {
    await fish.salvar({ chave: CHAVE, vozId: "minha", vozNome: "Felipe clone", modelo: "s2-pro" });
    await assert.rejects(fish.gerarTeste({ texto: "  " }), /Escreva o texto/);
    await assert.rejects(fish.gerarTeste({ texto: "a".repeat(fish.MAX_TEXTO_TESTE + 1) }), /até/);
    const { teste, dados } = await fish.gerarTeste({ texto: "Oi, tudo bem?", vozId: "publica", vozNome: "Narradora BR", modelo: "s1" });
    assert.ok(dados.length > 44);
    const tts = f.pedidos.find((p) => p.caminho === "/v1/tts");
    assert.equal(tts.cabecalhos.model, "s1");
    assert.deepEqual([tts.corpo.text, tts.corpo.reference_id, tts.corpo.format], ["Oi, tudo bem?", "publica", "mp3"]);
    const lista = await fish.testes();
    assert.equal(lista[0].chave, teste.chave);
    assert.equal(lista[0].vozNome, "Narradora BR");
    assert.ok(await fish.audioDoTeste(teste.chave));
    assert.equal(await fish.audioDoTeste("audio-mensagem-1-x.ogg"), null);
    // Em teste, a Fish Audio não fala nos áudios enviados.
    assert.equal(await fish.emProducao(), false);
  } finally {
    f.restaurar();
  }
});

test("Fish Audio em produção gera o áudio enviado; se falhar, sai pela voz de antes", async () => {
  process.env.OPENAI_API_KEY = "openai-falsa";
  const ok = servicosFalsos();
  try {
    await fish.salvar({ chave: CHAVE, vozId: "minha", vozNome: "Felipe clone", modo: "producao" });
    assert.equal(await fish.emProducao(), true);
    const { dados } = await pipeline.audioDaMensagem(901, "Oi, tudo bem? Aqui é da FluxDeck.");
    assert.equal(dados.toString("ascii", 0, 4), "OggS");
    assert.ok(ok.pedidos.some((p) => p.caminho === "/v1/tts" && p.corpo.reference_id === "minha"));
    assert.ok(!ok.pedidos.some((p) => p.host === "api.openai.com"));
  } finally {
    ok.restaurar();
  }
  const semCredito = servicosFalsos({ ttsFalha: true });
  try {
    const { dados } = await pipeline.audioDaMensagem(902, "Oi, tudo bem? Aqui é da FluxDeck.");
    assert.equal(dados.toString("ascii", 0, 4), "OggS");
    assert.ok(semCredito.pedidos.some((p) => p.host === "api.openai.com"), "a voz de reserva fala no lugar");
  } finally {
    semCredito.restaurar();
    delete process.env.OPENAI_API_KEY;
  }
  // Sem a chave, volta tudo para a voz de antes.
  await fish.desconectar();
  assert.equal(await fish.emProducao(), false);
  assert.equal((await fish.situacao()).vozId, "minha");
});
