import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpeg from "ffmpeg-static";
import { config } from "../config.js";
import * as db from "../db.js";
import { FUNDOS } from "../../public/post-desenho.js";
import { narrarCenas, TAXA_VOZ } from "./narracao.js";

// O avatar de IA do Felipe (HeyGen) falando em todas as cenas dos Reels. Os clipes são pedidos
// quando o post é criado (o HeyGen leva alguns minutos) e baixados na hora de gerar o vídeo. Tudo aqui é
// opcional: se o HeyGen falhar ao pedir (como por falta de crédito), a Runway faz os clipes no lugar dele.
// Sem nenhum dos dois, o Reels sai sem avatar, com a voz da narração.
const API = "https://api.heygen.com";
const RUNWAY = "https://api.dev.runwayml.com";
const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);
const TEMPO_MS = 20_000;
const CHAVE = "avatar";

// Vozes masculinas prontas da Runway (ElevenLabs) para as mensagens em áudio; a escolhida fica salva no painel.
export const VOZES_DAS_MENSAGENS = ["Noah", "James", "Mark", "Jack", "Frank", "Martin"];

export async function lerConfigAvatar() {
  const c = (await db.lerConfig(CHAVE)) ?? {};
  return {
    ativo: Boolean(c.ativo), chave: process.env.HEYGEN_API_KEY || c.chave || "", avatarId: c.avatarId ?? "", vozId: c.vozId ?? "",
    runwayChave: process.env.RUNWAY_API_KEY || c.runwayChave || "", runwayAvatarId: c.runwayAvatarId ?? "", vozDasMensagens: c.vozDasMensagens || VOZES_DAS_MENSAGENS[0],
  };
}

/** Salva só o que veio; a chave vazia mantém a que já estava salva. */
export async function salvarConfigAvatar({ ativo, chave, avatarId, vozId, runwayChave, vozDasMensagens } = {}) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const limpo = (v) => String(v ?? "").trim();
  await db.gravarConfig(CHAVE, {
    ...atual,
    ...(ativo !== undefined ? { ativo: Boolean(ativo) } : {}),
    ...(limpo(chave) ? { chave: limpo(chave) } : {}),
    ...(avatarId !== undefined ? { avatarId: limpo(avatarId) } : {}),
    ...(vozId !== undefined ? { vozId: limpo(vozId) } : {}),
    ...(VOZES_DAS_MENSAGENS.includes(vozDasMensagens) ? { vozDasMensagens } : {}),
    // Chave nova pode ser de outra conta da Runway, onde o avatar salvo não existe.
    ...(limpo(runwayChave) ? { runwayChave: limpo(runwayChave), runwayAvatarId: "" } : {}),
  });
  return lerConfigAvatar();
}

async function chamar(chave, metodo, caminho, corpo) {
  const r = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { "X-Api-Key": chave, ...(corpo ? { "Content-Type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(TEMPO_MS),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const motivo = d.error?.message ?? d.message ?? (typeof d.error === "string" ? d.error : `respondeu ${r.status}`);
    throw new Error(r.status === 401 ? "o HeyGen recusou a chave da API" : `HeyGen: ${motivo}`);
  }
  return d.data ?? d;
}

async function chamarRunway(chave, metodo, caminho, corpo) {
  const r = await fetch(`${RUNWAY}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${chave}`, "X-Runway-Version": "2024-11-06", ...(corpo ? { "Content-Type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(TEMPO_MS),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? "a Runway recusou a chave da API" : `Runway: ${d.error ?? d.message ?? `respondeu ${r.status}`}`);
  return d;
}

/** Confere a chave e o avatar no HeyGen. Retorna { creditos, avatar }, ou lança com o motivo. */
export async function testarAvatar() {
  const c = await lerConfigAvatar();
  if (!c.chave) throw new Error("Cole a chave da API do HeyGen");
  const eu = await chamar(c.chave, "GET", "/v3/users/me");
  const look = c.avatarId ? await chamar(c.chave, "GET", `/v3/avatars/looks/${encodeURIComponent(c.avatarId)}`) : null;
  return { creditos: eu.remaining_credits ?? null, avatar: look ? { nome: look.name ?? null, status: look.status ?? null } : null };
}

/** Os créditos que restam no HeyGen. Só lê, não gasta nada. */
export async function creditosDoHeygen() {
  const c = await lerConfigAvatar();
  return c.chave ? (await chamar(c.chave, "GET", "/v3/users/me")).remaining_credits ?? null : null;
}

/** Os créditos que restam na Runway. Só lê, não gasta nada. */
export async function creditosDaRunway() {
  const c = await lerConfigAvatar();
  return c.runwayChave ? (await chamarRunway(c.runwayChave, "GET", "/v1/organization")).creditBalance ?? null : null;
}

// Cada clipe pesa na hora de montar o vídeo, e a Vercel corta a execução em 5 minutos.
const MAX_CENAS_COM_AVATAR = 6;

/** O Felipe fala em todas as cenas, até o limite, sempre com a chamada final: o vídeo com o rosto e a voz dele foi o que mais alcançou no perfil. */
export function cenasDoAvatar(slides) {
  const total = slides?.length ?? 0;
  const indices = Array.from({ length: total }, (_, i) => i);
  return total > MAX_CENAS_COM_AVATAR ? [...indices.slice(0, MAX_CENAS_COM_AVATAR - 1), total - 1] : indices;
}

/** O rosto do avatar da Runway: a imagem do look do HeyGen, de frente para a câmera; sem ela, o topo da foto do Felipe. */
async function fotoDeReferencia(c) {
  const look = c.chave && c.avatarId ? await chamar(c.chave, "GET", `/v3/avatars/looks/${encodeURIComponent(c.avatarId)}`).catch(() => null) : null;
  if (look?.preview_image_url) return look.preview_image_url;
  const foto = fileURLToPath(new URL("../../public/felipe-holanda.jpg", import.meta.url));
  const jpeg = await new Promise((ok, falhou) => {
    const p = spawn(ffmpeg, ["-loglevel", "error", "-i", foto, "-vf", "crop=400:259:0:0,scale=1088:704", "-f", "mjpeg", "-q:v", "3", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    const partes = [];
    p.stdout.on("data", (d) => partes.push(d));
    p.on("error", falhou);
    p.on("close", (codigo) => (codigo === 0 ? ok(Buffer.concat(partes)) : falhou(new Error("não deu para preparar a foto do avatar"))));
  });
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/** O avatar do Felipe na Runway, criado na primeira vez. Retorna { id, status, motivo }. */
async function avatarDaRunway(c) {
  if (c.runwayAvatarId) {
    const a = await chamarRunway(c.runwayChave, "GET", `/v1/avatars/${encodeURIComponent(c.runwayAvatarId)}`).catch(() => null);
    if (a && a.status !== "FAILED") return { id: a.id, status: a.status };
  }
  const a = await chamarRunway(c.runwayChave, "POST", "/v1/avatars", {
    name: "Felipe Holanda",
    referenceImage: await fotoDeReferencia(c),
    personality: "Felipe Holanda, fundador da FluxDeck. Fala português do Brasil, de forma direta e natural, com donos de empresa.",
    voice: { type: "runway-live-preset", presetId: "vincent" },
  });
  await db.gravarConfig(CHAVE, { ...((await db.lerConfig(CHAVE)) ?? {}), runwayAvatarId: a.id });
  return { id: a.id, status: a.status, motivo: a.failureReason };
}

function wavDoPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(TAXA_VOZ, 24);
  h.writeUInt32LE(TAXA_VOZ * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const pedirClipeDaRunway = (chave, avatarId, pcm) => chamarRunway(chave, "POST", "/v1/avatar_videos", {
  model: "gwm1_avatars",
  avatar: { type: "custom", avatarId },
  speech: { type: "audio", audio: `data:audio/wav;base64,${wavDoPcm(pcm).toString("base64")}` },
});

/** Pede os clipes de todas as cenas à Runway, com a voz da narração. Lança se faltar algum: o avatar fala o vídeo inteiro ou não aparece. */
async function pedirClipesDaRunway(conteudo, c, narrar) {
  const avatar = await avatarDaRunway(c);
  if (avatar.status !== "READY") throw new Error(`o avatar da Runway ainda não está pronto (${avatar.status ?? "sem status"})`);
  const slides = conteudo.slides.map((s) => ({ ...s, fala: s.fala || s.titulo }));
  const falas = await narrar({ id: 0, formato: "reels", conteudo: { ...conteudo, slides } });
  const cenas = cenasDoAvatar(slides).filter((i) => falas?.[i]);
  const pedidos = await Promise.all(cenas.map((i) => pedirClipeDaRunway(c.runwayChave, avatar.id, falas[i].pcm)));
  const comClipes = conteudo.slides.map(({ avatar: _, ...s }) => s);
  cenas.forEach((i, n) => (comClipes[i].avatar = { id: pedidos[n].id, servico: "runway" }));
  return { ...conteudo, slides: comClipes };
}

/** Um texto falado pela voz mais natural que temos. Retorna o arquivo de áudio, ou lança sem chave ou se a Runway falhar. */
export async function falarPelaRunway(texto, { voz, esperaMs = 3_000, consultas = 30 } = {}) {
  const { runwayChave, vozDasMensagens } = await lerConfigAvatar();
  if (!runwayChave) throw new Error("sem chave da Runway");
  const { id } = await chamarRunway(runwayChave, "POST", "/v1/text_to_speech", {
    model: "eleven_v3", promptText: texto, voice: { type: "runway-preset", presetId: VOZES_DAS_MENSAGENS.includes(voz) ? voz : vozDasMensagens }, languageCode: "pt", stability: 0.5, similarityBoost: 0.75, style: 0.3,
  });
  for (let n = 0; n < consultas; n++) {
    const { falha, url } = await statusDaRunway(runwayChave, id);
    if (falha) throw new Error(falha);
    if (url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`o áudio respondeu ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    }
    await new Promise((res) => setTimeout(res, esperaMs));
  }
  throw new Error("o áudio ainda não ficou pronto");
}

/** Cria o avatar na Runway e faz um clipe curto, para conferir o enquadramento. Retorna { status, video }, ou lança com o motivo. */
export async function testarRunway({ narrar = narrarCenas, esperaMs = 5_000, consultas = 36 } = {}) {
  const c = await lerConfigAvatar();
  if (!c.runwayChave) throw new Error("Cole a chave da API da Runway");
  const avatar = await avatarDaRunway(c);
  if (avatar.status === "FAILED") throw new Error(`a Runway não criou o avatar: ${avatar.motivo ?? "sem motivo informado"}`);
  if (avatar.status !== "READY") return { status: avatar.status };
  const teste = { id: 0, formato: "reels", conteudo: { slides: [{ visual: "capa", titulo: "Teste", texto: "", destaque: "", fala: "Oi, eu sou o Felipe, da FluxDeck." }], gancho: "Teste", legenda: "", hashtags: [] } };
  const [fala] = await narrar(teste);
  const { id } = await pedirClipeDaRunway(c.runwayChave, avatar.id, fala.pcm);
  for (let n = 0; n < consultas; n++) {
    const { falha, url } = await statusDaRunway(c.runwayChave, id);
    if (falha) throw new Error(`a Runway não gerou o clipe: ${falha}`);
    if (url) return { status: "READY", video: url };
    await new Promise((res) => setTimeout(res, esperaMs));
  }
  return { status: "READY", pedido: id };
}

/**
 * Pede os clipes ao HeyGen. Guarda em cada tela `avatar: { id }`. Se um pedido falhar e houver
 * chave da Runway, ela faz todos os clipes no lugar. Retorna o conteúdo.
 */
export async function pedirClipes(conteudo, { formato, narrar = narrarCenas, esperaMs = 5_000 } = {}) {
  if (formato !== "reels" || !conteudo.comFelipe) return conteudo;
  const c = await lerConfigAvatar();
  if (!c.ativo) return conteudo;
  const comHeygen = c.chave && c.avatarId ? await pedirClipesDoHeygen(conteudo, c) : null;
  if (!c.runwayChave) return comHeygen ?? conteudo;
  if (comHeygen && !(await heygenFalhou(comHeygen, c, esperaMs))) return comHeygen;
  try {
    const comRunway = await pedirClipesDaRunway(conteudo, c, narrar);
    log("⚠️  Avatar: os clipes deste Reels foram pedidos à Runway.");
    return comRunway;
  } catch (e) {
    log(`⚠️  Avatar: a Runway não fez os clipes: ${e.message}`);
    return comHeygen ?? conteudo;
  }
}

/**
 * Sem crédito, o HeyGen aceita o pedido e só depois marca o clipe como falho.
 * Por isso, com a Runway de reserva, confere os pedidos antes de confiar neles.
 */
async function heygenFalhou(conteudo, c, esperaMs) {
  const cenas = cenasDoAvatar(conteudo.slides).filter((i) => conteudo.slides[i].fala || conteudo.slides[i].titulo);
  if (cenas.some((i) => !conteudo.slides[i].avatar?.id)) return true;
  for (let n = 0; n < 3; n++) {
    if (n) await new Promise((res) => setTimeout(res, esperaMs));
    const estados = await Promise.all(cenas.map((i) => statusDoHeygen(c.chave, conteudo.slides[i].avatar.id).catch((e) => ({ falha: e.message }))));
    const falha = estados.find((e) => e.falha)?.falha;
    if (falha) {
      log(`⚠️  Avatar: o HeyGen não vai fazer os clipes: ${falha}`);
      return true;
    }
  }
  return false;
}

async function pedirClipesDoHeygen(conteudo, c) {
  const slides = conteudo.slides.map((s) => ({ ...s }));
  const cor = FUNDOS.find((f) => f.nome === conteudo.fundo)?.clipe;
  await Promise.all(cenasDoAvatar(slides).map(async (i) => {
    const script = String(slides[i].fala || slides[i].titulo || "").trim();
    if (!script) return;
    try {
      const pedido = {
        type: "avatar", avatar_id: c.avatarId, script, ...(c.vozId ? { voice_id: c.vozId } : {}),
        resolution: "720p", aspect_ratio: "9:16", title: `FluxDeck: ${script.slice(0, 40)}`,
      };
      // A cor de fundo é um enfeite: se o avatar não aceitar, o clipe sai com o fundo dele.
      const d = await chamar(c.chave, "POST", "/v3/videos", { ...pedido, ...(cor ? { background: { type: "color", value: cor } } : {}) })
        .catch((e) => {
          if (!cor) throw e;
          log(`⚠️  Avatar: sem a cor de fundo no clipe da tela ${i + 1}: ${e.message}`);
          return chamar(c.chave, "POST", "/v3/videos", pedido);
        });
      slides[i].avatar = { id: d.video_id };
    } catch (e) {
      log(`⚠️  Avatar: não foi possível pedir o clipe da tela ${i + 1}: ${e.message}`);
    }
  }));
  return { ...conteudo, slides };
}

/** Quanto dura o arquivo de vídeo, em segundos (lido do próprio arquivo). */
export function duracaoDoClipe(arquivo) {
  return new Promise((ok) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-i", arquivo], { stdio: ["ignore", "ignore", "pipe"] });
    let saida = "";
    p.stderr.on("data", (d) => (saida += d));
    p.on("close", () => {
      const m = saida.match(/Duration: (\d+):(\d+):([\d.]+)/);
      ok(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
    });
    p.on("error", () => ok(null));
  });
}

const AINDA_NAO_FICOU_PRONTO = "o clipe ainda não ficou pronto";

async function statusDoHeygen(chave, id) {
  const d = await chamar(chave, "GET", `/v3/videos/${encodeURIComponent(id)}`);
  if (d.status === "failed") return { falha: d.failure_message || d.failure_code || "o HeyGen não conseguiu gerar o clipe" };
  return { url: d.status === "completed" ? d.video_url : null };
}

async function statusDaRunway(chave, id) {
  const d = await chamarRunway(chave, "GET", `/v1/tasks/${encodeURIComponent(id)}`);
  if (d.status === "FAILED" || d.status === "CANCELLED") return { falha: d.failure || d.failureCode || "a Runway não conseguiu gerar o clipe" };
  return { url: d.status === "SUCCEEDED" ? d.output?.[0] : null };
}

async function baixarClipe(status, chave, id, destino, { esperaMs, tentativas }) {
  for (let n = 0; ; n++) {
    const { falha, url } = await status(chave, id);
    if (falha) throw new Error(falha);
    if (url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`o clipe respondeu ${r.status}`);
      await fs.writeFile(destino, Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (n + 1 >= tentativas) throw new Error(AINDA_NAO_FICOU_PRONTO);
    await new Promise((res) => setTimeout(res, esperaMs));
  }
}

/**
 * Baixa os clipes prontos do post para `pasta`. Retorna { índice da tela: { arquivo, duracao } }.
 * Clipe que falhar ou ainda não estiver pronto fica de fora; os que ainda estão no HeyGen entram em `pendentes`.
 */
export async function baixarClipes(post, pasta, { esperaMs = 10_000, tentativas = 6, pendentes = [] } = {}) {
  const pedidos = (post.conteudo?.slides ?? []).map((s, i) => ({ i, id: s.avatar?.id, runway: s.avatar?.servico === "runway" })).filter((p) => p.id);
  if (!pedidos.length) return {};
  const { chave, runwayChave } = await lerConfigAvatar();
  const clipes = {};
  await Promise.all(pedidos.filter((p) => (p.runway ? runwayChave : chave)).map(async ({ i, id, runway }) => {
    const arquivo = path.join(pasta, `avatar-${i}.mp4`);
    try {
      await baixarClipe(runway ? statusDaRunway : statusDoHeygen, runway ? runwayChave : chave, id, arquivo, { esperaMs, tentativas });
      const duracao = await duracaoDoClipe(arquivo);
      if (duracao) clipes[i] = { arquivo, duracao };
    } catch (e) {
      if (e.message === AINDA_NAO_FICOU_PRONTO) pendentes.push(i);
      log(`⚠️  Avatar: o Reels sai sem o clipe da tela ${i + 1}: ${e.message}`);
    }
  }));
  return clipes;
}
