import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";

process.env.DB_PATH = ":memory:";
const desenho = await import("../public/post-desenho.js");
const { gerarTrilha, wav, CLIMAS, TAXA } = await import("../src/conteudo/trilha.js");
const { duracoesDoVideo } = await import("../src/conteudo/arquivos.js");
const { faixaDaVoz, narracaoDisponivel, narrarCenas, TAXA_VOZ } = await import("../src/conteudo/narracao.js");

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
  // No contraste, o rótulo escrito pela IA sai do texto (o cartão já mostra).
  const rotulado = { id: 1, conteudo: { slides: [{ visual: "capa", titulo: "C" }, { visual: "contraste", titulo: "Antes: você some", texto: "Depois: entregas" }, { visual: "cta", titulo: "F" }] } };
  assert.deepEqual([desenho.telasDoPost(rotulado)[1].titulo, desenho.telasDoPost(rotulado)[1].texto], ["Você some", "Entregas"]);
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

test("reels: o Gemini narra cena por cena, tira o cabeçalho WAV e espera quando passa do limite", async () => {
  const chaves = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "GEMINI_API_KEY"];
  const antes = Object.fromEntries(chaves.map((k) => [k, process.env[k]]));
  const fetchAntes = globalThis.fetch;
  chaves.forEach((k) => delete process.env[k]);
  process.env.GEMINI_API_KEY = "teste";
  assert.equal(narracaoDisponivel(), "Gemini");
  // 1 segundo de áudio, embrulhado num WAV como o Gemini pode devolver.
  const audio = wav([new Float32Array(TAXA_VOZ).fill(0.25)], TAXA_VOZ).toString("base64");
  const pedidos = [];
  let recusou = false;
  globalThis.fetch = async (url, opcoes) => {
    pedidos.push(JSON.parse(opcoes.body));
    if (!recusou) {
      recusou = true;
      return new Response("Resource exhausted", { status: 429, headers: { "retry-after": "0.01" } });
    }
    return Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", data: audio }] }] });
  };
  try {
    const falas = await narrarCenas(post);
    assert.equal(falas.length, slides.length);
    assert.equal(falas[2], null); // a cena sem fala não vira pedido
    assert.equal(pedidos.length, slides.filter((s) => s.fala).length + 1);
    assert.equal(pedidos[0].input[0].content[0].text, "Para tudo.");
    for (const f of falas.filter(Boolean)) assert.ok(Math.abs(f.duracao - 1) < 0.01);
  } finally {
    globalThis.fetch = fetchAntes;
    chaves.forEach((k) => (antes[k] === undefined ? delete process.env[k] : (process.env[k] = antes[k])));
  }
});

test("reels: a capa traz o gancho inteiro, e não o começo da animação", () => {
  const gancho = "Software demora anos e custa uma fortuna?";
  const post = { id: 7, formato: "reels", conteudo: { gancho, arte: "cor", trilha: "tensa", estrutura: "lista", hashtags: [], legenda: "", slides: [
    { visual: "capa", titulo: gancho, texto: "", destaque: "anos" }, { visual: "cta", titulo: "Fim", texto: "", destaque: "" }] } };
  const [w, h] = desenho.TAMANHOS_POST.reels;
  const desenhar = (f) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    f(ctx);
    return ctx.getImageData(0, 300, w, 1100).data;
  };
  // Os pixels que fogem da cor do fundo são o texto.
  const texto = (d) => {
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 120) n++;
    return n;
  };
  const capa = texto(desenhar((ctx) => desenho.desenharCapaReels(ctx, post, "FluxDeck")));
  const inicio = texto(desenhar((ctx) => desenho.desenharQuadroReels(ctx, post, 0, "FluxDeck")));
  const meioSegundo = texto(desenhar((ctx) => desenho.desenharQuadroReels(ctx, post, 0.6, "FluxDeck")));
  const fimDaCena = texto(desenhar((ctx) => desenho.desenharQuadroReels(ctx, post, 2.1, "FluxDeck")));
  assert.equal(inicio, 0); // o primeiro quadro da animação está vazio
  assert.ok(capa > meioSegundo); // aos 0,6 s ainda faltam palavras
  assert.ok(Math.abs(capa - fimDaCena) / capa < 0.05, `capa ${capa}, fim da cena ${fimDaCena}`); // igual à cena completa
});

test("capa: o Felipe entra na capa de todo post, a não ser que esteja desligado", async () => {
  const post = (extra = {}) => ({ id: 8, formato: "carrossel", conteudo: { gancho: "Capa", arte: "cor", estrutura: "lista", hashtags: [], legenda: "", ...extra, slides: [
    { visual: "capa", titulo: "Capa", texto: "", destaque: "" }, { visual: "cta", titulo: "Fim", texto: "", destaque: "" }] } });
  assert.ok(desenho.fotosDoPost(post()).includes(desenho.APRESENTADOR));
  assert.ok(!desenho.fotosDoPost(post({ capaSemFelipe: true })).includes(desenho.APRESENTADOR));
  assert.ok(desenho.fotosDoPost(post({ capaSemFelipe: true, comFelipe: true })).includes(desenho.APRESENTADOR));

  // Uma imagem vermelha no lugar da foto dele: ela aparece só na faixa de baixo, sem cobrir o título.
  const foto = createCanvas(400, 400);
  const f = foto.getContext("2d");
  f.fillStyle = "#ff0000";
  f.fillRect(0, 0, 400, 400);
  await desenho.carregarFotosDoPost(post(), async (c) => (c === desenho.APRESENTADOR ? foto : null));
  const vermelhos = (desenhar, w, h, y0, y1) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    desenhar(ctx);
    const { data } = ctx.getImageData(0, y0, w, y1 - y0);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 240 && data[i + 1] < 15 && data[i + 2] < 15) n++;
    return n;
  };
  const reels = { ...post(), formato: "reels" };
  assert.ok(vermelhos((ctx) => desenho.desenharCapaReels(ctx, reels, "FluxDeck"), 1080, 1920, 1400, 1680) > 10_000);
  assert.equal(vermelhos((ctx) => desenho.desenharCapaReels(ctx, reels, "FluxDeck"), 1080, 1920, 200, 1390), 0);
  assert.equal(vermelhos((ctx) => desenho.desenharCapaReels(ctx, { ...reels, conteudo: { ...reels.conteudo, capaSemFelipe: true } }, "FluxDeck"), 1080, 1920, 1400, 1680), 0);
  assert.ok(vermelhos((ctx) => desenho.desenharTelaCarrossel(ctx, post(), 0, "FluxDeck"), 1080, 1350, 1060, 1260) > 10_000);
  assert.equal(vermelhos((ctx) => desenho.desenharTelaCarrossel(ctx, post(), 1, "FluxDeck"), 1080, 1350, 0, 1350), 0); // só na capa
});

test("legenda: nunca fica sobre o rosto, nem do avatar, nem das fotos", async () => {
  const titulo = "Quantos alunos você perdeu esta semana sem nem perceber isso?";
  const slides = [
    { visual: "capa", titulo, texto: "", destaque: "alunos", foto: { chave: "foto-rosto" } },
    { visual: "lista", titulo: "Primeiro erro: responder tarde demais", texto: "Quem espera vai para outra empresa.", destaque: "tarde", foto: { chave: "foto-rosto" } },
    { visual: "texto", titulo: "Segundo erro: não aparecer", texto: "Quem não é achado não é escolhido.", destaque: "achado", foto: { chave: "foto-rosto" } },
    { visual: "cta", titulo: "Comenta ALUNO e eu te respondo no direct", texto: "Te mostro onde sua academia perde matrículas.", destaque: "ALUNO" },
  ];
  // A janela do avatar continua toda transparente: nenhum texto entra nela, em nenhum estilo.
  const j = desenho.JANELA_DO_AVATAR;
  assert.ok(j.w < 1080 * 0.7); // e o Felipe não fica gigante
  for (const arte of ["dividido", "claro", "cor", "escuro", "foto_cheia"]) {
    const post = { id: 3, formato: "reels", conteudo: { gancho: titulo, arte, trilha: "tensa", estrutura: "lista", hashtags: [], legenda: "", comFelipe: true, slides } };
    const duracoes = [4, 3, 3, 4];
    for (const [t, cena] of [[3, 0], [13, 3]]) {
      const c = createCanvas(1080, 1920);
      const ctx = c.getContext("2d");
      desenho.desenharQuadroReels(ctx, post, t, "FluxDeck", { duracoes, cenasComVideo: new Set([0, 3]) });
      const { data } = ctx.getImageData(j.x + 30, j.y + 30, j.w - 60, j.h - 60);
      let opacos = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) opacos++;
      assert.equal(opacos, 0, `${arte}, cena ${cena}: ${opacos} pixels sobre o avatar`);
    }
  }

  // Uma foto toda vermelha: ela só pode aparecer acima de onde o texto começa, e nunca atrás dele.
  const foto = createCanvas(400, 400);
  const f = foto.getContext("2d");
  f.fillStyle = "#ff0000";
  f.fillRect(0, 0, 400, 400);
  await desenho.carregarFotosDoPost({ conteudo: { capaSemFelipe: true, slides } }, async (ch) => (ch === "foto-rosto" ? foto : null));
  const vermelhos = (desenhar, w, h, y0, y1) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    desenhar(ctx);
    const { data } = ctx.getImageData(0, y0, w, y1 - y0);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) n++;
    return n;
  };
  for (const arte of ["dividido", "claro", "cor", "escuro", "foto_cheia"]) {
    const post = { id: 3, formato: "carrossel", conteudo: { gancho: titulo, arte, estrutura: "lista", hashtags: [], legenda: "", capaSemFelipe: true, slides } };
    // A foto fica só na parte de cima da tela (no máximo até y = 596, onde o texto começa).
    assert.equal(vermelhos((ctx) => desenho.desenharTelaCarrossel(ctx, post, 0, "FluxDeck"), 1080, 1350, 600, 1350), 0, `${arte}, capa`);
    // Nas telas de lista não há foto nenhuma atrás do texto.
    assert.equal(vermelhos((ctx) => desenho.desenharTelaCarrossel(ctx, post, 1, "FluxDeck"), 1080, 1350, 0, 1350), 0, `${arte}, lista`);
  }
});
