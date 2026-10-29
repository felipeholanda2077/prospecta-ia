import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import ffmpeg from "ffmpeg-static";
import {
  usarCanvas, TAMANHOS_POST, telasDoPost, duracaoReels, desenharTelaCarrossel, desenharQuadroReels,
} from "../../public/post-desenho.js";

// Os arquivos que vão para o Instagram saem do mesmo desenho das prévias do painel,
// agora num canvas do Node com a fonte Inter (a mesma que o painel carrega do Google Fonts).
const FONTES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@fontsource", "inter", "files");
let preparado = false;

function preparar() {
  if (preparado) return;
  for (const peso of [500, 600, 700, 800]) {
    for (const parte of ["latin", "latin-ext"]) GlobalFonts.registerFromPath(path.join(FONTES, `inter-${parte}-${peso}-normal.woff2`), "Inter");
  }
  usarCanvas((w, h) => createCanvas(w, h));
  preparado = true;
}

/** As telas do carrossel em JPEG (o único formato de imagem que o Instagram aceita pela API). */
export async function imagensDoCarrossel(post, empresa) {
  preparar();
  const [w, h] = TAMANHOS_POST.carrossel;
  return Promise.all(telasDoPost(post).map((_, i) => {
    const c = createCanvas(w, h);
    desenharTelaCarrossel(c.getContext("2d"), post, i, empresa);
    return c.encode("jpeg", 92);
  }));
}

const QUADROS_POR_SEGUNDO = 30;
// O Instagram baixa o vídeo pelo link do próprio sistema, e a Vercel só entrega respostas de até 4,5 MB.
const TAMANHO_MAXIMO = 4_200_000;

/** Grava o Reels em MP4 (H.264 + faixa de áudio muda), quadro a quadro, sem precisar do navegador. */
export async function videoDoReels(post, empresa) {
  preparar();
  const duracao = duracaoReels(post);
  // Texto animado sobre fundo escuro comprime bem; o teto de bitrate garante que cabe no limite.
  let kbps = Math.min(3000, Math.floor((TAMANHO_MAXIMO * 8) / duracao / 1000) - 96);
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const video = await gravar(post, empresa, duracao, kbps);
    if (video.length <= TAMANHO_MAXIMO) return video;
    kbps = Math.floor(kbps * 0.7);
  }
  throw new Error("O vídeo do Reels ficou grande demais para enviar ao Instagram.");
}

async function gravar(post, empresa, duracao, kbps) {
  const [w, h] = TAMANHOS_POST.reels;
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), "reels-"));
  const saida = path.join(pasta, "reels.mp4");
  try {
    const processo = spawn(ffmpeg, [
      "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(QUADROS_POR_SEGUNDO), "-i", "-",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-y", saida,
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
    for (let i = 0; i <= total; i++) {
      desenharQuadroReels(ctx, post, Math.min(i / QUADROS_POR_SEGUNDO, duracao), empresa);
      // Respeita o ritmo do ffmpeg: sem isso os quadros se acumulam na memória.
      if (!processo.stdin.write(c.data())) await new Promise((r) => processo.stdin.once("drain", r));
    }
    processo.stdin.end();
    await terminou;
    return await fs.readFile(saida);
  } finally {
    await fs.rm(pasta, { recursive: true, force: true });
  }
}
