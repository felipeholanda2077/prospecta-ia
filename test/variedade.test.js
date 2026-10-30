import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
delete process.env.PEXELS_API_KEY;
const db = await import("../src/db.js");
const desenho = await import("../public/post-desenho.js");
const { colocarFotos, variacoesDaBusca } = await import("../src/conteudo/fotos.js");
const diario = await import("../src/conteudo/diario.js");
const { PUBLICOS, TONS } = await import("../src/ia/conteudo.js");
await db.iniciar();
desenho.usarCanvas((w, h) => createCanvas(w, h));

const post = (arte, extra = {}) => ({ conteudo: { arte, gancho: arte, ...extra } });

test("variedade: público, tom e arte não repetem os últimos posts; o Felipe alterna nos Reels", () => {
  const recentes = [
    { formato: "reels", conteudo: { publico: "clinica", tom: "humor", arte: "cor", comFelipe: true } },
    { formato: "carrossel", conteudo: { publico: "loja", tom: "direto", arte: "claro" } },
    { formato: "reels", conteudo: { publico: "beleza", tom: "conta", arte: "escuro" } },
  ];
  for (let i = 0; i < 50; i++) {
    const v = diario.escolherVariedade(recentes, { formato: "carrossel", sorteio: () => i / 50 });
    assert.ok(!["clinica", "loja", "beleza"].includes(v.publico) && v.publico in PUBLICOS);
    assert.ok(!["humor", "direto", "conta"].includes(v.tom) && v.tom in TONS);
    assert.ok(["foto_cheia", "dividido"].includes(v.arte));
    assert.equal(v.comFelipe, false); // só nos vídeos
  }
  assert.equal(diario.escolherVariedade(recentes, { formato: "reels" }).comFelipe, false); // o último Reels já teve
  assert.equal(diario.escolherVariedade(recentes.slice(1), { formato: "reels" }).comFelipe, true);
  assert.equal(diario.escolherVariedade(recentes.slice(1), { formato: "reels", apresentador: false }).comFelipe, false);
  // Sem opção livre, ainda escolhe alguma.
  const todas = desenho.ARTES.map((arte) => ({ formato: "carrossel", conteudo: { arte } }));
  assert.ok(desenho.ARTES.includes(diario.escolherVariedade(todas.slice(0, 3), { formato: "carrossel" }).arte));
});

test("variedade: reconhece gancho parecido com um recente", () => {
  const recentes = [post("x", { gancho: "Seu site espanta clientes todo dia" }), post("y", { gancho: "Software demora anos e custa uma fortuna?" })];
  assert.equal(diario.ganchoParecido("Seu site perde vendas", recentes), "Seu site espanta clientes todo dia"); // mesmo começo
  assert.equal(diario.ganchoParecido("Por que software custa uma fortuna", recentes), "Software demora anos e custa uma fortuna?"); // mesmas palavras
  assert.equal(diario.ganchoParecido("Faltou de novo? A culpa é da agenda", recentes), null);
  assert.equal(diario.ganchoParecido("", recentes), null);
});

const conteudoEscrito = (gancho) => ({
  tema: gancho, gancho, trilha: "tensa", legenda: "Legenda", hashtags: [], hashtags_extras: [], audio: "", estrutura: "lista",
  slides: [{ visual: "capa", titulo: gancho, texto: "", destaque: "", fala: "", busca_imagem: "dentist clinic", elemento: null }],
});

test("variedade: o post nasce com público, tom e arte; gancho repetido faz a IA escrever de novo", async () => {
  await db.criarPost({ dia: "2026-10-01", formato: "reels", pilar: "erro", tema: "Velho", conteudo: { gancho: "Seu site espanta clientes", slides: [], legenda: "", hashtags: [] } });
  const pedidos = [];
  const respostas = ["Seu site perde dinheiro", "Faltou de novo na clínica?"];
  const escrever = async (o) => (pedidos.push(o), conteudoEscrito(respostas.shift()));
  const criado = await diario.criarPostDeHoje({ empresa: { nome: "FluxDeck" } }, { escrever, fotos: async (c) => c, agora: new Date("2026-10-30T15:00:00Z") });
  assert.equal(pedidos.length, 2);
  assert.match(pedidos[1].aviso, /parecido demais com "Seu site espanta clientes"/);
  assert.equal(criado.conteudo.gancho, "Faltou de novo na clínica?");
  assert.ok(criado.conteudo.publico in PUBLICOS && criado.conteudo.tom in TONS && desenho.ARTES.includes(criado.conteudo.arte));
  assert.equal(pedidos[0].publico, criado.conteudo.publico);
});

test("fotos: coloca a foto nas telas, não repete a mesma, dá crédito só quando precisa e segue sem foto se falhar", async () => {
  const slides = [
    { titulo: "a", busca_imagem: "dentist clinic" }, { titulo: "b", busca_imagem: "" }, { titulo: "c", busca_imagem: "reception desk" },
    { titulo: "d", busca_imagem: "falha total" }, { titulo: "e", busca_imagem: "sem resultado" },
  ];
  const buscar = async (b) => {
    if (b === "falha total") throw new Error("fora do ar");
    if (b === "sem resultado") return [];
    return [{ url: "http://x/1.jpg", credito: b === "reception desk" ? "Fulano (CC BY 4.0, via Wikimedia Commons)" : null, fonte: "Teste" }, { url: "http://x/2.jpg", credito: "Fulano (CC BY 4.0, via Wikimedia Commons)", fonte: "Teste" }];
  };
  const c = await colocarFotos({ slides, legenda: "Legenda" }, { formato: "carrossel", dia: "2026-10-30", buscar, preparar: async () => Buffer.from("jpg") });
  assert.ok(c.slides[0].foto?.chave.startsWith("foto-2026-10-30-"));
  assert.ok(c.slides[2].foto?.chave);
  assert.notEqual(c.slides[0].foto.chave, c.slides[2].foto.chave);
  assert.deepEqual([c.slides[1].foto, c.slides[3].foto, c.slides[4].foto], [undefined, undefined, undefined]);
  assert.equal((await db.lerMidia(c.slides[0].foto.chave)).tipo, "image/jpeg");
  assert.match(c.legenda, /^Legenda/);
  // Sem nenhuma busca, não mexe em nada.
  const sem = { slides: [{ titulo: "a" }], legenda: "L" };
  assert.deepEqual(await colocarFotos(sem, { formato: "reels", dia: "2026-10-30" }), sem);
});

test("fotos: a busca tenta com menos palavras, e post sem foto não fica no estilo de foto", async () => {
  assert.deepEqual(variacoesDaBusca("Man thinking with notebook startup idea"), ["man thinking notebook startup idea", "man thinking notebook", "man thinking"]);
  assert.deepEqual(variacoesDaBusca("clinic"), ["clinic"]);
  const artes = new Set();
  for (const v of [0.1, 0.9]) {
    const recentes = (await db.postsRecentes(30));
    const criado = await diario.criarPostDeHoje({ empresa: { nome: "FluxDeck" } }, {
      escrever: async () => conteudoEscrito(`Gancho único ${v} ${recentes.length} sem repetir nada`), agora: new Date("2026-10-30T15:00:00Z"), sorteio: () => v,
      fotos: async (c) => ({ ...c, arte: "foto_cheia" }), // nenhuma foto achada
    });
    artes.add(criado.conteudo.arte);
  }
  assert.deepEqual([...artes].sort(), ["claro", "cor"]);
});

test("arte: todos os estilos desenham todas as cenas, com e sem foto, elemento e Felipe", async () => {
  const foto = createCanvas(400, 300);
  foto.getContext("2d").fillRect(0, 0, 400, 300);
  const visuais = ["capa", "impacto", "lista", "contraste", "pergunta", "texto", "cta"];
  const slides = visuais.map((visual, i) => ({
    visual, titulo: `Título da tela ${visual} com algumas palavras`, texto: "Um texto de apoio curto.", destaque: "Título", fala: "Fala",
    foto: i % 2 ? null : { chave: "foto-a" }, elemento: desenho.ELEMENTOS[i % desenho.ELEMENTOS.length],
  }));
  const usadas = [];
  for (const arte of desenho.ARTES) {
    for (const comFelipe of [false, true]) {
      const p = { id: 7, formato: "reels", conteudo: { arte, comFelipe, slides, gancho: "G", estrutura: "lista", trilha: "tensa" } };
      await desenho.carregarFotosDoPost(p, async (c) => (usadas.push(c), foto));
      for (let i = 0; i < slides.length; i++) desenho.desenharTelaCarrossel(createCanvas(1080, 1350).getContext("2d"), p, i);
      const ctx = createCanvas(1080, 1920).getContext("2d");
      for (let t = 0; t < desenho.duracaoReels(p); t += 1.3) desenho.desenharQuadroReels(ctx, p, t);
    }
  }
  assert.ok(usadas.includes("foto-a") && usadas.includes(desenho.APRESENTADOR) && usadas.includes(desenho.LOGO));
  // Post antigo, sem arte nem foto, continua saindo no estilo de antes.
  const antigo = { id: 1, conteudo: { gancho: "G", slides: [{ titulo: "A" }, { titulo: "B" }] } };
  desenho.desenharTelaCarrossel(createCanvas(1080, 1350).getContext("2d"), antigo, 0);
  assert.deepEqual(desenho.fotosDoPost(antigo), [desenho.LOGO, desenho.APRESENTADOR]); // ele entra na capa de todo post
  // Foto que não carrega só fica de fora.
  await desenho.carregarFotosDoPost({ conteudo: { slides: [{ foto: { chave: "foto-quebrada" } }] } }, async () => { throw new Error("404"); });
});
