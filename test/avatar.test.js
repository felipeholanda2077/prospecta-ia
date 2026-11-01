import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
delete process.env.HEYGEN_API_KEY;
const db = await import("../src/db.js");
const avatar = await import("../src/conteudo/avatar.js");
const { videoDoReels, montarFiltro, exigirNarracao } = await import("../src/conteudo/arquivos.js");
const { legendaDoPost } = await import("../src/conteudo/instagram.js");
await db.iniciar();

const slides = [
  { visual: "capa", titulo: "Sua agenda vive furada?", destaque: "agenda", fala: "Sua agenda vive furada?", texto: "" },
  { visual: "texto", titulo: "O problema é o lembrete", destaque: "", fala: "O problema é o lembrete.", texto: "" },
  { visual: "cta", titulo: "Comenta AGENDA", destaque: "AGENDA", fala: "Comenta agenda aqui embaixo.", texto: "" },
];
const conteudo = { slides, comFelipe: true, legenda: "Legenda", hashtags: ["fluxdeck"], gancho: "G", trilha: "tensa", estrutura: "lista", arte: "cor" };

/** HeyGen de mentira: guarda os pedidos e diz se os vídeos estão prontos. */
function heygenFalso({ status = "completed", falhar = false, clipe = Buffer.from("x") } = {}) {
  const pedidos = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (u.startsWith("https://clipes/")) return new Response(clipe);
    pedidos.push({ u: u.replace("https://api.heygen.com", ""), metodo: op.method, chave: op.headers?.["X-Api-Key"], corpo: op.body ? JSON.parse(op.body) : null });
    if (op.headers?.["X-Api-Key"] !== "chave-certa") return Response.json({ error: { message: "bad" } }, { status: 401 });
    if (falhar) return Response.json({ error: { message: "sem saldo" } }, { status: 402 });
    if (u.endsWith("/v3/videos")) return Response.json({ data: { video_id: `v${pedidos.length}`, status: "waiting" } });
    if (u.includes("/v3/videos/")) return Response.json({ data: { status, video_url: "https://clipes/a.mp4", failure_message: "falhou" } });
    if (u.endsWith("/v3/users/me")) return Response.json({ data: { remaining_credits: 42 } });
    if (u.includes("/v3/avatars/looks/")) return Response.json({ data: { name: "Felipe", status: "completed" } });
    return new Response("{}", { status: 404 });
  };
  return { pedidos, restaurar: () => (globalThis.fetch = original) };
}

test("avatar: fala em até 6 cenas, sempre com a primeira e a última", () => {
  assert.deepEqual(avatar.cenasDoAvatar([1, 2, 3]), [0, 1, 2]);
  assert.deepEqual(avatar.cenasDoAvatar(Array(8).fill(0)), [0, 1, 2, 3, 4, 7]);
  assert.deepEqual(avatar.cenasDoAvatar(undefined), []);
});

test("avatar: pede a cor do fundo do vídeo e, se o HeyGen recusar, o clipe sai sem ela", async () => {
  await avatar.salvarConfigAvatar({ ativo: true, chave: "chave-certa", avatarId: "look1", vozId: "voz1" });
  const original = globalThis.fetch;
  const corpos = [];
  globalThis.fetch = async (url, op = {}) => {
    const corpo = JSON.parse(op.body);
    corpos.push(corpo);
    if (corpo.background && corpo.script === "recusa") return Response.json({ error: { message: "background inválido" } }, { status: 400 });
    return Response.json({ data: { video_id: "v" + corpos.length } });
  };
  try {
    const c = await avatar.pedirClipes({ comFelipe: true, fundo: "noite", slides: [{ visual: "capa", titulo: "A", fala: "aceita" }, { visual: "cta", titulo: "B", fala: "recusa" }] }, { formato: "reels" });
    assert.ok(c.slides.every((s) => s.avatar?.id));
    assert.deepEqual(corpos.find((b) => b.script === "aceita").background, { type: "color", value: "#20345c" });
    assert.equal(corpos.filter((b) => b.script === "recusa").length, 2);
    assert.equal(corpos.filter((b) => b.script === "recusa").at(-1).background, undefined);
  } finally {
    globalThis.fetch = original;
    await db.gravarConfig("avatar", {});
  }
});

test("avatar: desligado ou fora do Reels com Felipe, não chama o HeyGen", async () => {
  const f = heygenFalso();
  try {
    assert.equal(await avatar.pedirClipes(conteudo, { formato: "reels" }), conteudo); // sem configuração
    await avatar.salvarConfigAvatar({ ativo: true, chave: "chave-certa", avatarId: "look1" });
    assert.equal(await avatar.pedirClipes(conteudo, { formato: "carrossel" }), conteudo);
    const semFelipe = { ...conteudo, comFelipe: false };
    assert.equal(await avatar.pedirClipes(semFelipe, { formato: "reels" }), semFelipe);
    assert.equal(f.pedidos.length, 0);
  } finally {
    f.restaurar();
  }
});

test("avatar: pede clipe de todas as cenas, na vertical, e falha sem derrubar o post", async () => {
  await avatar.salvarConfigAvatar({ ativo: true, chave: "chave-certa", avatarId: "look1", vozId: "voz1" });
  let f = heygenFalso();
  try {
    const c = await avatar.pedirClipes(conteudo, { formato: "reels" });
    assert.equal(f.pedidos.length, 3);
    const corpos = f.pedidos.map((p) => p.corpo);
    assert.deepEqual(corpos.map((b) => b.script).sort(), ["Comenta agenda aqui embaixo.", "O problema é o lembrete.", "Sua agenda vive furada?"]);
    assert.ok(corpos.every((b) => b.type === "avatar" && b.avatar_id === "look1" && b.voice_id === "voz1" && b.aspect_ratio === "9:16" && b.resolution === "720p"));
    assert.ok(f.pedidos.every((p) => p.u === "/v3/videos" && p.metodo === "POST"));
    assert.ok(c.slides.every((s) => s.avatar?.id));
    assert.match(legendaDoPost({ conteudo: c }), /Legenda\n\nAvatar do Felipe gerado com IA\.\n\n#fluxdeck/);
    assert.doesNotMatch(legendaDoPost({ conteudo }), /Avatar/);
  } finally {
    f.restaurar();
  }
  f = heygenFalso({ falhar: true });
  try {
    const c = await avatar.pedirClipes(conteudo, { formato: "reels" });
    assert.ok(c.slides.every((s) => !s.avatar));
  } finally {
    f.restaurar();
  }
});

test("avatar: o teste confere a chave e o avatar, e a chave vazia mantém a salva", async () => {
  const f = heygenFalso();
  try {
    await avatar.salvarConfigAvatar({ chave: "", avatarId: "look1" });
    assert.equal((await avatar.lerConfigAvatar()).chave, "chave-certa");
    assert.deepEqual(await avatar.testarAvatar(), { creditos: 42, avatar: { nome: "Felipe", status: "completed" } });
    await avatar.salvarConfigAvatar({ chave: "errada" });
    await assert.rejects(avatar.testarAvatar(), /recusou a chave/);
    await avatar.salvarConfigAvatar({ chave: "chave-certa" });
  } finally {
    f.restaurar();
  }
});

test("avatar: clipe que falhou ou não ficou pronto fica de fora", async () => {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-"));
  const post = { conteudo: { slides: [{ avatar: { id: "a" } }, {}, { avatar: { id: "b" } }] } };
  for (const status of ["failed", "processing"]) {
    const f = heygenFalso({ status });
    try {
      assert.deepEqual(await avatar.baixarClipes(post, pasta, { esperaMs: 1, tentativas: 2 }), {});
    } finally {
      f.restaurar();
    }
  }
  await fs.rm(pasta, { recursive: true, force: true });
});

/** Runway de mentira junto do HeyGen: guarda os pedidos e responde conforme o caminho. */
function servicosFalsos({ heygen = "failed", heygenAceita = true, runwayRecusa = false, avatarStatus = "READY", tarefa = "SUCCEEDED" } = {}) {
  const pedidos = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op = {}) => {
    const u = String(url);
    if (u.startsWith("https://clipes/")) return new Response(Buffer.from("x"));
    pedidos.push({ u, metodo: op.method ?? "GET", auth: op.headers?.Authorization, versao: op.headers?.["X-Runway-Version"], corpo: op.body ? JSON.parse(op.body) : null });
    if (u.startsWith("https://api.dev.runwayml.com")) {
      if (runwayRecusa) return Response.json({ error: "sem crédito" }, { status: 400 });
      if (u.endsWith("/v1/avatars")) return Response.json({ id: "rw-avatar", status: avatarStatus });
      if (u.includes("/v1/avatars/")) return Response.json({ id: "rw-avatar", status: avatarStatus });
      if (u.endsWith("/v1/avatar_videos")) return Response.json({ id: `tarefa${pedidos.length}` });
      if (u.includes("/v1/tasks/")) return Response.json({ status: tarefa, output: ["https://clipes/r.mp4"], failure: "moderação" });
    }
    if (u.includes("/v3/avatars/looks/")) return Response.json({ data: { preview_image_url: "https://heygen/rosto.jpg" } });
    if (u.endsWith("/v3/videos")) return heygenAceita ? Response.json({ data: { video_id: "h1" } }) : Response.json({ error: { message: "sem saldo" } }, { status: 402 });
    if (u.includes("/v3/videos/")) return Response.json({ data: { status: heygen, failure_message: "Insufficient credit", video_url: "https://clipes/h.mp4" } });
    return new Response("{}", { status: 404 });
  };
  return { pedidos, runway: () => pedidos.filter((p) => p.u.includes("runwayml")), restaurar: () => (globalThis.fetch = original) };
}
const voz = async (p) => p.conteudo.slides.map((s) => (s.fala ? { pcm: Buffer.alloc(4800), duracao: 0.1 } : null));

test("avatar: HeyGen sem crédito, a Runway faz os clipes com a voz da narração", async () => {
  await avatar.salvarConfigAvatar({ ativo: true, chave: "chave-certa", avatarId: "look1", runwayChave: "rw-chave" });
  const f = servicosFalsos();
  try {
    const c = await avatar.pedirClipes(conteudo, { formato: "reels", narrar: voz, esperaMs: 1 });
    assert.ok(c.slides.every((s) => s.avatar?.servico === "runway" && s.avatar.id));
    const criar = f.runway().find((p) => p.u.endsWith("/v1/avatars"));
    assert.equal(criar.corpo.referenceImage, "https://heygen/rosto.jpg");
    assert.equal(criar.auth, "Bearer rw-chave");
    assert.equal(criar.versao, "2024-11-06");
    const videos = f.runway().filter((p) => p.u.endsWith("/v1/avatar_videos"));
    assert.equal(videos.length, 3);
    assert.ok(videos.every((p) => p.corpo.model === "gwm1_avatars" && p.corpo.avatar.avatarId === "rw-avatar" && p.corpo.speech.type === "audio" && p.corpo.speech.audio.startsWith("data:audio/wav;base64,")));
    assert.equal((await avatar.lerConfigAvatar()).runwayAvatarId, "rw-avatar");
    // Na hora do vídeo, os clipes vêm da Runway.
    const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "runway-"));
    const clipes = await avatar.baixarClipes({ conteudo: c }, pasta, { esperaMs: 1, tentativas: 1 });
    assert.equal(Object.keys(clipes).length, 0); // o arquivo de mentira não tem duração, mas o caminho foi este:
    assert.ok(f.pedidos.some((p) => p.u.includes("/v1/tasks/tarefa")));
    await fs.rm(pasta, { recursive: true, force: true });
  } finally {
    f.restaurar();
  }
});

test("avatar: HeyGen funcionando, a Runway nem é chamada", async () => {
  await avatar.salvarConfigAvatar({ ativo: true, chave: "chave-certa", avatarId: "look1", runwayChave: "rw-chave" });
  const f = servicosFalsos({ heygen: "processing" });
  try {
    const c = await avatar.pedirClipes(conteudo, { formato: "reels", narrar: voz, esperaMs: 1 });
    assert.ok(c.slides.every((s) => s.avatar?.id === "h1" && !s.avatar.servico));
    assert.equal(f.runway().length, 0);
  } finally {
    f.restaurar();
  }
});

test("avatar: se a Runway também falhar, o post continua", async () => {
  await avatar.salvarConfigAvatar({ ativo: true, chave: "chave-certa", avatarId: "look1", runwayChave: "rw-chave" });
  const recusou = servicosFalsos({ heygenAceita: false, runwayRecusa: true });
  try {
    const c = await avatar.pedirClipes(conteudo, { formato: "reels", narrar: voz, esperaMs: 1 });
    assert.ok(c.slides.every((s) => !s.avatar));
  } finally {
    recusou.restaurar();
  }
  const criando = servicosFalsos({ heygenAceita: false, avatarStatus: "PROCESSING" });
  try {
    const c = await avatar.pedirClipes(conteudo, { formato: "reels", narrar: voz, esperaMs: 1 });
    assert.ok(c.slides.every((s) => !s.avatar)); // avatar ainda em criação não trava o post
  } finally {
    criando.restaurar();
  }
});

test("avatar: o teste da Runway devolve o clipe, e a chave não aparece no que vai para o painel", async () => {
  await avatar.salvarConfigAvatar({ ativo: true, runwayChave: "rw-chave" });
  const f = servicosFalsos();
  try {
    assert.deepEqual(await avatar.testarRunway({ narrar: voz, esperaMs: 1 }), { status: "READY", video: "https://clipes/r.mp4" });
  } finally {
    f.restaurar();
  }
  const falhou = servicosFalsos({ tarefa: "FAILED" });
  try {
    await assert.rejects(avatar.testarRunway({ narrar: voz, esperaMs: 1 }), /moderação/);
  } finally {
    falhou.restaurar();
  }
  // Chave nova pode ser de outra conta: o avatar salvo não vale mais.
  await avatar.salvarConfigAvatar({ runwayChave: "outra" });
  assert.equal((await avatar.lerConfigAvatar()).runwayAvatarId, "");
  await avatar.salvarConfigAvatar({ runwayChave: "rw-chave" });
});

test("avatar: clipe que quebra a montagem não impede o vídeo", async () => {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "clipe-ruim-"));
  try {
    const arquivo = path.join(pasta, "ruim.mp4");
    await fs.writeFile(arquivo, "não é vídeo");
    const post = { id: 7, formato: "reels", conteudo: { ...conteudo, slides: conteudo.slides.map((s) => ({ ...s, avatar: { id: "a" } })) } };
    const video = await videoDoReels(post, "FluxDeck", {
      clipes: async () => ({ 0: { arquivo, duracao: 1 }, 1: { arquivo, duracao: 1 }, 2: { arquivo, duracao: 1 } }),
      narrar: async (p) => p.conteudo.slides.map((s) => (s.fala ? { pcm: Buffer.alloc(24000), duracao: 0.5 } : null)),
    });
    assert.ok(video.length > 1000);
    assert.ok(post.conteudo.slides.every((s) => !s.avatar));
  } finally {
    await fs.rm(pasta, { recursive: true, force: true });
  }
});

test("avatar: sem crédito no HeyGen o vídeo sai com a narração, sem avisar de avatar", async () => {
  const comPedidos = () => ({ id: 6, formato: "reels", conteudo: { ...conteudo, slides: conteudo.slides.map((s) => ({ ...s, avatar: { id: "a" } })) } });
  const narrar = async (p) => p.conteudo.slides.map((s) => (s.fala ? { pcm: Buffer.alloc(24000), duracao: 0.5 } : null));
  const post = comPedidos();
  let narrou = null;
  const video = await videoDoReels(post, "FluxDeck", {
    clipes: async () => ({}),
    narrar: (p) => { narrou = p; return narrar(p); },
  });
  assert.ok(video.length > 1000);
  assert.deepEqual(narrou.conteudo.slides.map((s) => s.fala), conteudo.slides.map((s) => s.fala)); // a voz fala tudo
  assert.ok(post.conteudo.slides.every((s) => !s.avatar));

  // Clipe que chegou não entra sozinho: o avatar fala o vídeo inteiro ou não aparece.
  const parcial = comPedidos();
  await videoDoReels(parcial, "FluxDeck", {
    clipes: async () => ({ 0: { arquivo: "nao-existe.mp4", duracao: 1 } }),
    narrar,
  });
  assert.ok(parcial.conteudo.slides.every((s) => !s.avatar));
});

test("avatar: clipe ainda em produção espera uma rodada e, depois, o vídeo sai sem ele", async () => {
  const clipes = async (_p, _pasta, { pendentes }) => { pendentes.push(0); return {}; };
  const narrar = async (p) => p.conteudo.slides.map((s) => (s.fala ? { pcm: Buffer.alloc(24000), duracao: 0.5 } : null));
  const post = (tentativas) => ({ id: 6, formato: "reels", instagram_tentativas: tentativas, conteudo: { ...conteudo, slides: conteudo.slides.map((s) => ({ ...s, avatar: { id: "a" } })) } });
  await assert.rejects(videoDoReels(post(0), "FluxDeck", { clipes, narrar }), /ainda não ficou pronto/);
  assert.ok((await videoDoReels(post(1), "FluxDeck", { clipes, narrar })).length > 1000);
});

test("avatar: sem nenhuma voz, tenta de novo e só sai sem voz na última tentativa", async () => {
  const narrar = async () => { throw new Error("nenhuma voz"); };
  const post = (tentativas) => ({ id: 6, formato: "reels", instagram_tentativas: tentativas, conteudo });
  await assert.rejects(videoDoReels(post(0), "FluxDeck", { clipes: async () => ({}), narrar }), /sem narração/);
  await assert.rejects(videoDoReels(post(1), "FluxDeck", { clipes: async () => ({}), narrar }), /sem narração/);
  assert.ok((await videoDoReels(post(2), "FluxDeck", { clipes: async () => ({}), narrar })).length > 1000);
});

test("avatar: o filtro do vídeo coloca o clipe por baixo e abaixa a música quando ele fala", () => {
  const f = montarFiltro({ w: 1080, h: 1920, duracao: 10, comClipe: [{ inicio: 0, fim: 3, janela: { x: 620, y: 130, w: 400, h: 500, dx: 520, dy: 0 } }, { inicio: 7, fim: 10, janela: { x: 60, y: 130, w: 400, h: 500, dx: -520, dy: 0 } }], temVoz: false });
  assert.equal(f.imagem, "[v]");
  assert.match(f.filtro, /\[2:v\]scale=400:712/); // menor, dentro da janela
  assert.match(f.filtro, /overlay=x='\d+\+-?\d+\*pow/);
  assert.match(f.filtro, /\[3:a\].*adelay=7000\|7000/);
  assert.match(f.filtro, /sidechaincompress/);
  const semClipe = montarFiltro({ w: 1080, h: 1920, duracao: 10, comClipe: [], temVoz: false });
  assert.equal(semClipe.imagem, "[0:v]");
  assert.doesNotMatch(semClipe.filtro, /sidechain/);
});

test("avatar: o vídeo sai de verdade com os clipes na capa e na chamada", async () => {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-video-"));
  try {
    // Dois clipes de teste: imagem colorida com som.
    const clipe = (nome, cor, seg) => {
      const arquivo = path.join(pasta, nome);
      const r = spawnSync(ffmpeg, ["-loglevel", "error", "-f", "lavfi", "-i", `color=c=${cor}:s=720x1280:r=25:d=${seg}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seg}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", arquivo]);
      assert.equal(r.status, 0, String(r.stderr));
      return arquivo;
    };
    const clipes = { 0: { arquivo: clipe("a.mp4", "red", 1.5), duracao: 1.5 }, 2: { arquivo: clipe("b.mp4", "green", 1.5), duracao: 1.5 } };
    let narrou = null;
    const video = await videoDoReels({ id: 5, formato: "reels", conteudo }, "FluxDeck", {
      clipes: async () => clipes,
      narrar: async (p) => {
        narrou = p;
        return p.conteudo.slides.map((s) => (s.fala ? { pcm: Buffer.alloc(24000), duracao: 0.5 } : null));
      },
    });
    assert.ok(video.length > 1000);
    // Nas telas com clipe, a voz sintética não narra.
    assert.deepEqual(narrou.conteudo.slides.map((s) => Boolean(s.fala)), [false, true, false]);
    const saida = path.join(pasta, "saida.mp4");
    await fs.writeFile(saida, video);
    const info = spawnSync(ffmpeg, ["-hide_banner", "-i", saida], { encoding: "utf8" }).stderr;
    assert.match(info, /Video: h264/);
    assert.match(info, /1080x1920/);
    assert.match(info, /Audio: aac/);
    const d = await avatar.duracaoDoClipe(saida);
    assert.ok(d > 3 && d < 12, `duração ${d}`);
  } finally {
    await fs.rm(pasta, { recursive: true, force: true });
  }
});

test("narração: vídeo nunca sai sem voz, nem se só uma fala ficar de fora", () => {
  const telas = [{ fala: "Um" }, { fala: "" }, { fala: "Dois" }];
  const voz = { pcm: Buffer.alloc(2), duracao: 1 };
  const clipe = { arquivo: "a.mp4", duracao: 1 };
  assert.doesNotThrow(() => exigirNarracao(telas, {}, [voz, null, voz]));
  assert.doesNotThrow(() => exigirNarracao(telas, { 0: clipe, 2: clipe }, null)); // o avatar fala tudo
  assert.doesNotThrow(() => exigirNarracao(telas, { 0: clipe }, [null, null, voz]));
  assert.throws(() => exigirNarracao(telas, {}, null), /sem narração/); // sem serviço de voz
  assert.throws(() => exigirNarracao(telas, {}, [voz, null, null]), /sem narração/); // faltou uma fala
  assert.throws(() => exigirNarracao(telas, { 0: clipe }, null), /sem narração/); // o clipe de uma cena falhou
  assert.throws(() => exigirNarracao([{ fala: "" }], {}, [null]), /sem narração/); // roteiro sem nenhuma fala
  assert.throws(() => exigirNarracao(telas, {}, null, "Gemini recusou"), /Gemini recusou/);
});
