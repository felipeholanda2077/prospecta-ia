import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";

const desenho = await import("../public/post-desenho.js");
const { gerarTrilha, wav, CLIMAS, TAXA } = await import("../src/conteudo/trilha.js");
const { duracoesDoVideo } = await import("../src/conteudo/arquivos.js");
const { faixaDaVoz, narracaoDisponivel, TAXA_VOZ } = await import("../src/conteudo/narracao.js");

desenho.usarCanvas((w, h) => createCanvas(w, h));

const slides = [
  { visual: "capa", titulo: "Pare de responder cliente na mão", texto: "", destaque: "na mão", fala: "Para tudo." },
  { visual: "pergunta", titulo: "Quantos clientes desistiram?", texto: "Quem espera desiste.", destaque: "desistiram", fala: "Quantos clientes desistiram hoje esperando você responder?" },
  { visual: "contraste", titulo: "Responder um por um", texto: "Atendimento automático", destaque: "", fala: "" },
  { visual: "lista", titulo: "Respostas prontas", texto: "Preço e horário na hora.", destaque: "prontas", fala: "Primeiro: respostas prontas." },
  { visual: "impacto", titulo: "Venda dormindo", texto: "", destaque: "dormindo", fala: "Venda até dormindo." },
  { visual: "cta", titulo: "Comenta AUTOMÁTICO", texto: "", destaque: "AUTOMÁTICO", fala: "Comenta automático aqui." },
];
const post = { id: 3, formato: "reels", conteudo: { estrutura: "pare_de", trilha: "tensa", gancho: "Pare", slides, legenda: "", hashtags: [] } };

test("reels: todos os tipos de cena desenham no carrossel e em vários instantes do vídeo", () => {
  assert.deepEqual(desenho.telasDoPost(post).map((t) => t.visual), ["capa", "pergunta", "contraste", "lista", "impacto", "cta"]);
  for (let i = 0; i < slides.length; i++) desenho.desenharTelaCarrossel(createCanvas(1080, 1350).getContext("2d"), post, i);
  const ctx = createCanvas(1080, 1920).getContext("2d");
  const total = desenho.duracaoReels(post);
  for (let t = 0; t <= total; t += 0.37) desenho.desenharQuadroReels(ctx, post, t);
  // Post antigo (sem tipo de cena): capa, itens numerados e a chamada no fim.
  const antigo = { id: 1, conteudo: { gancho: "G", slides: [{ titulo: "A" }, { titulo: "B" }, { titulo: "C" }] } };
  assert.deepEqual(desenho.telasDoPost(antigo).map((t) => t.visual), ["capa", "lista", "cta"]);
  // A paleta muda de um post para o outro.
  assert.notEqual(desenho.temaDoPost({ id: 1 }).nome, desenho.temaDoPost({ id: 2 }).nome);
});

test("reels: com voz, cada cena dura a fala (sem passar do mínimo do tipo de cena)", () => {
  const falas = slides.map((s) => (s.fala ? { duracao: s.fala.split(" ").length / 2.5 } : null));
  const d = duracoesDoVideo(post, falas);
  const semVoz = desenho.duracoesDasCenas(post);
  assert.equal(d[2], semVoz[2]); // cena sem fala: pelo texto
  assert.ok(d[1] >= falas[1].duracao + 0.4);
  assert.ok(d[0] >= 1.8);
  assert.deepEqual(duracoesDoVideo(post, null), semVoz);
});

test("reels: trilha em cada clima, no tamanho certo, sem estourar e diferente por post", () => {
  for (const clima of Object.keys(CLIMAS)) {
    const r = gerarTrilha({ clima, duracao: 6, cortes: [0, 2, 4], semente: 5 });
    assert.equal(r.esquerda.length, Math.ceil(6 * TAXA));
    let pico = 0;
    let energia = 0;
    for (let i = 0; i < r.esquerda.length; i++) {
      pico = Math.max(pico, Math.abs(r.esquerda[i]), Math.abs(r.direita[i]));
      energia += r.esquerda[i] ** 2;
    }
    assert.ok(pico <= 0.9, `${clima}: pico ${pico}`);
    assert.ok(Math.sqrt(energia / r.esquerda.length) > 0.05, `${clima}: quase muda`);
  }
  const a = gerarTrilha({ clima: "energica", duracao: 3, semente: 1 });
  const b = gerarTrilha({ clima: "energica", duracao: 3, semente: 2 });
  const c = gerarTrilha({ clima: "energica", duracao: 3, semente: 1 });
  assert.notDeepEqual(a.esquerda.slice(20000, 20100), b.esquerda.slice(20000, 20100));
  assert.deepEqual(a.esquerda.slice(20000, 20100), c.esquerda.slice(20000, 20100));
  const arquivo = wav([a.esquerda, a.direita]);
  assert.equal(arquivo.toString("ascii", 0, 4), "RIFF");
  assert.equal(arquivo.length, 44 + a.esquerda.length * 4);
});

test("reels: as falas entram na faixa da voz no começo de cada cena", () => {
  const pcm = Buffer.alloc(2 * 100);
  for (let k = 0; k < 100; k++) pcm.writeInt16LE(16384, k * 2);
  const faixa = faixaDaVoz([{ pcm }, null, { pcm }], [0, 1, 2], 3);
  assert.equal(faixa.length, 3 * TAXA_VOZ);
  assert.equal(faixa[50], 0.5);
  assert.equal(faixa[TAXA_VOZ + 50], 0);
  assert.equal(faixa[2 * TAXA_VOZ + 50], 0.5);
  const antes = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  assert.equal(narracaoDisponivel(), null);
  process.env.OPENAI_API_KEY = "sk-teste";
  assert.equal(narracaoDisponivel(), "OpenAI");
  if (antes === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = antes;
});
