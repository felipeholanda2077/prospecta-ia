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
const { videoDoReels, montarFiltro } = await import("../src/conteudo/arquivos.js");
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

test("avatar: pede clipe só da capa e da chamada, na vertical, e falha sem derrubar o post", async () => {
  await avatar.salvarConfigAvatar({ ativo: true, chave: "chave-certa", avatarId: "look1", vozId: "voz1" });
  let f = heygenFalso();
  try {
    const c = await avatar.pedirClipes(conteudo, { formato: "reels" });
    assert.equal(f.pedidos.length, 2);
    const corpos = f.pedidos.map((p) => p.corpo);
    assert.deepEqual(corpos.map((b) => b.script).sort(), ["Comenta agenda aqui embaixo.", "Sua agenda vive furada?"]);
    assert.ok(corpos.every((b) => b.type === "avatar" && b.avatar_id === "look1" && b.voice_id === "voz1" && b.aspect_ratio === "9:16" && b.resolution === "720p"));
    assert.ok(f.pedidos.every((p) => p.u === "/v3/videos" && p.metodo === "POST"));
    assert.ok(c.slides[0].avatar?.id && c.slides[2].avatar?.id && !c.slides[1].avatar);
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

test("avatar: o filtro do vídeo coloca o clipe por baixo e abaixa a música quando ele fala", () => {
  const f = montarFiltro({ w: 1080, h: 1920, duracao: 10, comClipe: [{ inicio: 0, fim: 3 }, { inicio: 7, fim: 10 }], temVoz: false });
  assert.equal(f.imagem, "[v]");
  assert.match(f.filtro, /\[2:v\]scale=640:1138/); // menor, dentro da janela
  assert.match(f.filtro, /overlay=x=220:y=220/);
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
      narrar: async (p) => ((narrou = p), null),
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
