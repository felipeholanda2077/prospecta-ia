import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import ffmpeg from "ffmpeg-static";
import {
  usarCanvas, TAMANHOS_POST, telasDoPost, duracoesDasCenas, desenharTelaCarrossel, desenharQuadroReels, desenharCapaReels, carregarFotosDoPost, APRESENTADOR, LOGO,
} from "../../public/post-desenho.js";
import * as db from "../db.js";
import { gerarTrilha, wav, TAXA } from "./trilha.js";
import { narrarCenas, faixaDaVoz, TAXA_VOZ } from "./narracao.js";
import { baixarClipes } from "./avatar.js";

// Os arquivos que vão para o Instagram saem do mesmo desenho das prévias do painel,
// agora num canvas do Node com a fonte Inter (a mesma que o painel carrega do Google Fonts).
const FONTES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@fontsource", "inter", "files");
let preparado = false;

function preparar() {
  if (preparado) return;
  for (const peso of [500, 600, 700, 800, 900]) {
    for (const parte of ["latin", "latin-ext"]) GlobalFonts.registerFromPath(path.join(FONTES, `inter-${parte}-${peso}-normal.woff2`), "Inter");
  }
  usarCanvas((w, h) => createCanvas(w, h));
  preparado = true;
}

const PUBLICO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** As fotos do post, do banco (o apresentador e a logo vêm de arquivo). */
const carregarFoto = async (chave) => {
  if (chave === APRESENTADOR) return loadImage(await fs.readFile(path.join(PUBLICO, "felipe-holanda.jpg")));
  if (chave === LOGO) return loadImage(await fs.readFile(path.join(PUBLICO, "fluxdeck-logo.jpg")));
  const midia = await db.lerMidia(chave);
  return midia ? loadImage(Buffer.from(midia.dados)) : null;
};

/** As telas do carrossel em JPEG (o único formato de imagem que o Instagram aceita pela API). */
export async function imagensDoCarrossel(post, empresa) {
  preparar();
  await carregarFotosDoPost(post, carregarFoto);
  const [w, h] = TAMANHOS_POST.carrossel;
  return Promise.all(telasDoPost(post).map((_, i) => {
    const c = createCanvas(w, h);
    desenharTelaCarrossel(c.getContext("2d"), post, i, empresa);
    return c.encode("jpeg", 92);
  }));
}

/** A capa do Reels em JPEG, que vai junto com o vídeo. */
export async function capaDoReels(post, empresa) {
  preparar();
  await carregarFotosDoPost(post, carregarFoto);
  const [w, h] = TAMANHOS_POST.reels;
  const c = createCanvas(w, h);
  desenharCapaReels(c.getContext("2d"), post, empresa);
  return c.encode("jpeg", 92);
}

const QUADROS_POR_SEGUNDO = 30;
// O Instagram baixa o vídeo pelo link do próprio sistema, e a Vercel só entrega respostas de até 4,5 MB.
const TAMANHO_MAXIMO = 4_200_000;
const AUDIO_KBPS = 128;
// Com voz, cada cena dura a fala mais um respiro, mas nunca menos que o mínimo do tipo de cena.
const MINIMO_COM_VOZ = { capa: 1.8, impacto: 1.6, contraste: 3.2, cta: 3.0 };
const RESPIRO = 0.45;
const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Quanto dura cada cena: pela fala, quando há voz; senão, pela quantidade de texto. */
export function duracoesDoVideo(post, falas) {
  const base = duracoesDasCenas(post);
  if (!falas) return base;
  const telas = telasDoPost(post);
  return base.map((d, i) => (falas[i] ? Math.max(MINIMO_COM_VOZ[telas[i].visual] ?? 2, falas[i].duracao + RESPIRO) : d));
}

/**
 * O Reels em MP4 (H.264 + AAC): os quadros animados, a trilha sintetizada no clima do post, os
 * efeitos nas trocas de cena e, com o serviço de voz configurado, a narração de cada cena.
 */
export async function videoDoReels(post, empresa, { narrar = narrarCenas, clipes: baixar = baixarClipes } = {}) {
  preparar();
  await carregarFotosDoPost(post, carregarFoto);
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "reels-"));
  try {
    // Os clipes do avatar, se houver: nas telas com clipe quem fala é ele, então a voz não narra.
    const clipes = await baixar(post, pasta).catch((e) => {
      log(`⚠️  Reels sem o avatar: ${e.message}`);
      return {};
    });
    const semFalaNoClipe = { ...post, conteudo: { ...post.conteudo, slides: (post.conteudo.slides ?? []).map((s, i) => (clipes[i] ? { ...s, fala: "" } : s)) } };
    const falas = await narrar(semFalaNoClipe).catch((e) => {
      log(`⚠️  Reels sem narração: ${e.message}`);
      return null;
    });
    const duracoes = duracoesDoVideo(post, falas);
    for (const [i, c] of Object.entries(clipes)) duracoes[i] = c.duracao + 0.15;
    const inicios = duracoes.map((_, i) => duracoes.slice(0, i).reduce((a, b) => a + b, 0));
    const duracao = duracoes.reduce((a, b) => a + b, 0);
    const trilha = gerarTrilha({ clima: post.conteudo.trilha, duracao: duracao + 0.2, cortes: inicios, semente: Number(post.id) || 1 });
    const audio = { trilha: wav([trilha.esquerda, trilha.direita], TAXA), voz: falas?.some(Boolean) ? wav([faixaDaVoz(falas, inicios.map((t) => t + 0.12), duracao + 0.2)], TAXA_VOZ) : null };
    const comClipe = Object.entries(clipes).map(([i, c]) => ({ i: Number(i), arquivo: c.arquivo, inicio: inicios[i], fim: inicios[i] + duracoes[i] }));
    // O teto de bitrate garante que cabe no limite, mesmo com foto em movimento (que comprime pior).
    let kbps = Math.min(3200, Math.floor((TAMANHO_MAXIMO * 8) / duracao / 1000) - AUDIO_KBPS - 40);
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const video = await gravar(post, empresa, { pasta, duracoes, duracao, kbps, audio, comClipe });
      if (video.length <= TAMANHO_MAXIMO) return video;
      kbps = Math.floor(kbps * 0.7);
    }
    throw new Error("O vídeo do Reels ficou grande demais para enviar ao Instagram.");
  } finally {
    await fs.rm(pasta, { recursive: true, force: true });
  }
}

// O avatar vem em close, com a boca bem na altura do texto. Subindo o clipe, o rosto fica acima dele.
const SUBIR_CLIPE = 180;

/** O filtro do ffmpeg: a imagem (com o clipe do avatar por baixo, onde houver) e a mistura do som. */
export function montarFiltro({ w, h, duracao, comClipe, temVoz }) {
  const QPS = QUADROS_POR_SEGUNDO;
  const partes = [];
  let imagem = "[0:v]";
  // Entradas: 0 quadros, 1 trilha, 2 voz (se houver) e depois os clipes.
  const primeiroClipe = temVoz ? 3 : 2;
  if (comClipe.length) {
    partes.push(`color=c=black:s=${w}x${h}:r=${QPS}:d=${(duracao + 0.5).toFixed(2)}[fundo0]`);
    comClipe.forEach((c, n) => {
      partes.push(`[${primeiroClipe + n}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${QPS},setpts=PTS-STARTPTS+${c.inicio.toFixed(3)}/TB[clipe${n}]`);
      partes.push(`[fundo${n}][clipe${n}]overlay=y=-${SUBIR_CLIPE}:eof_action=pass:enable='between(t,${c.inicio.toFixed(3)},${c.fim.toFixed(3)})'[fundo${n + 1}]`);
    });
    partes.push(`[fundo${comClipe.length}][0:v]overlay=format=auto:alpha=premultiplied:shortest=1[v]`);
    imagem = "[v]";
  }
  // Tudo que é fala entra numa faixa só, e a música abaixa sozinha enquanto alguém fala (e volta nas pausas).
  const falas = [];
  if (temVoz) {
    partes.push("[2:a]aresample=44100,pan=stereo|c0=c0|c1=c0,volume=1.15[voz]");
    falas.push("[voz]");
  }
  comClipe.forEach((c, n) => {
    const ms = Math.round(c.inicio * 1000);
    partes.push(`[${primeiroClipe + n}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms},volume=1.15[fala${n}]`);
    falas.push(`[fala${n}]`);
  });
  if (falas.length) {
    partes.push(falas.length > 1 ? `${falas.join("")}amix=inputs=${falas.length}:normalize=0:duration=longest,asplit=2[v1][v2]` : `${falas[0]}asplit=2[v1][v2]`);
    partes.push("[1:a]volume=0.55[m]");
    partes.push("[m][v1]sidechaincompress=threshold=0.03:ratio=8:attack=8:release=280[md]");
    partes.push("[md][v2]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]");
  } else partes.push("[1:a]volume=0.9,alimiter=limit=0.95[a]");
  return { filtro: partes.join(";"), imagem };
}

async function gravar(post, empresa, { pasta, duracoes, duracao, kbps, audio, comClipe = [] }) {
  const [w, h] = TAMANHOS_POST.reels;
  const saida = path.join(pasta, "reels.mp4");
  try {
    await fs.writeFile(path.join(pasta, "trilha.wav"), audio.trilha);
    if (audio.voz) await fs.writeFile(path.join(pasta, "voz.wav"), audio.voz);
    const { filtro, imagem } = montarFiltro({ w, h, duracao, comClipe, temVoz: Boolean(audio.voz) });
    const processo = spawn(ffmpeg, [
      "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(QUADROS_POR_SEGUNDO), "-i", "-",
      "-i", path.join(pasta, "trilha.wav"),
      ...(audio.voz ? ["-i", path.join(pasta, "voz.wav")] : []),
      ...comClipe.flatMap((c) => ["-i", c.arquivo]),
      "-filter_complex", filtro, "-map", imagem === "[0:v]" ? "0:v" : imagem, "-map", "[a]", "-t", duracao.toFixed(2),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-movflags", "+faststart", "-y", saida,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let erros = "";
    processo.stderr.on("data", (d) => (erros += d));
    const terminou = new Promise((ok, falhou) => {
      processo.on("error", falhou);
      processo.on("close", (codigo) => (codigo === 0 ? ok() : falhou(new Error(`ffmpeg: ${erros.trim() || `saiu com ${codigo}`}`))));
    });

    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    const total = Math.ceil(duracao * QUADROS_POR_SEGUNDO);
    const cenasComVideo = new Set(comClipe.map((x) => x.i));
    for (let i = 0; i <= total; i++) {
      // O primeiro quadro é a capa: é ele que aparece onde não dá para escolher a capa do vídeo.
      if (i === 0) desenharCapaReels(ctx, post, empresa, { duracoes, cenasComVideo });
      else desenharQuadroReels(ctx, post, Math.min(i / QUADROS_POR_SEGUNDO, duracao), empresa, { duracoes, cenasComVideo });
      // Respeita o ritmo do ffmpeg: sem isso os quadros se acumulam na memória.
      if (!processo.stdin.write(c.data())) await new Promise((r) => processo.stdin.once("drain", r));
    }
    processo.stdin.end();
    await terminou;
    return await fs.readFile(saida);
  } finally {
    await fs.rm(saida, { force: true });
  }
}
