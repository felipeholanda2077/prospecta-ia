import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { config } from "../config.js";
import * as db from "../db.js";

// O avatar de IA do Felipe (HeyGen) falando na capa e na chamada final dos Reels. Os clipes são pedidos
// quando o post é criado (o HeyGen leva alguns minutos) e baixados na hora de gerar o vídeo. Tudo aqui é
// opcional: sem configuração, ou se algo falhar, o Reels sai com a foto do Felipe, como sempre.
const API = "https://api.heygen.com";
const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);
const TEMPO_MS = 20_000;
const CHAVE = "avatar";

export async function lerConfigAvatar() {
  const c = (await db.lerConfig(CHAVE)) ?? {};
  return { ativo: Boolean(c.ativo), chave: process.env.HEYGEN_API_KEY || c.chave || "", avatarId: c.avatarId ?? "", vozId: c.vozId ?? "" };
}

/** Salva só o que veio; a chave vazia mantém a que já estava salva. */
export async function salvarConfigAvatar({ ativo, chave, avatarId, vozId } = {}) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const limpo = (v) => String(v ?? "").trim();
  await db.gravarConfig(CHAVE, {
    ...atual,
    ...(ativo !== undefined ? { ativo: Boolean(ativo) } : {}),
    ...(limpo(chave) ? { chave: limpo(chave) } : {}),
    ...(avatarId !== undefined ? { avatarId: limpo(avatarId) } : {}),
    ...(vozId !== undefined ? { vozId: limpo(vozId) } : {}),
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

/** Confere a chave e o avatar no HeyGen. Retorna { creditos, avatar }, ou lança com o motivo. */
export async function testarAvatar() {
  const c = await lerConfigAvatar();
  if (!c.chave) throw new Error("Cole a chave da API do HeyGen");
  const eu = await chamar(c.chave, "GET", "/v3/users/me");
  const look = c.avatarId ? await chamar(c.chave, "GET", `/v3/avatars/looks/${encodeURIComponent(c.avatarId)}`) : null;
  return { creditos: eu.remaining_credits ?? null, avatar: look ? { nome: look.name ?? null, status: look.status ?? null } : null };
}

/** A cena fala na capa e na chamada final: as duas pontas do Reels. */
export const cenasDoAvatar = (slides) => (slides?.length > 1 ? [0, slides.length - 1] : slides?.length ? [0] : []);

/**
 * Pede ao HeyGen os clipes da capa e da chamada. Guarda em cada tela `avatar: { id }`. Se um pedido
 * falhar, aquela tela só fica sem clipe. Retorna o conteúdo.
 */
export async function pedirClipes(conteudo, { formato } = {}) {
  if (formato !== "reels" || !conteudo.comFelipe) return conteudo;
  const c = await lerConfigAvatar();
  if (!c.ativo || !c.chave || !c.avatarId) return conteudo;
  const slides = conteudo.slides.map((s) => ({ ...s }));
  await Promise.all(cenasDoAvatar(slides).map(async (i) => {
    const script = String(slides[i].fala || slides[i].titulo || "").trim();
    if (!script) return;
    try {
      const d = await chamar(c.chave, "POST", "/v3/videos", {
        type: "avatar", avatar_id: c.avatarId, script, ...(c.vozId ? { voice_id: c.vozId } : {}),
        resolution: "720p", aspect_ratio: "9:16", title: `FluxDeck: ${script.slice(0, 40)}`,
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

async function baixarClipe(chave, id, destino, { esperaMs, tentativas }) {
  for (let n = 0; ; n++) {
    const d = await chamar(chave, "GET", `/v3/videos/${encodeURIComponent(id)}`);
    if (d.status === "failed") throw new Error(d.failure_message || d.failure_code || "o HeyGen não conseguiu gerar o clipe");
    if (d.status === "completed" && d.video_url) {
      const r = await fetch(d.video_url, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`o clipe respondeu ${r.status}`);
      await fs.writeFile(destino, Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (n + 1 >= tentativas) throw new Error("o clipe ainda não ficou pronto");
    await new Promise((res) => setTimeout(res, esperaMs));
  }
}

/**
 * Baixa os clipes prontos do post para `pasta`. Retorna { índice da tela: { arquivo, duracao } }.
 * Clipe que falhar ou ainda não estiver pronto fica de fora: aquela tela sai com a foto do Felipe.
 */
export async function baixarClipes(post, pasta, { esperaMs = 10_000, tentativas = 6 } = {}) {
  const pedidos = (post.conteudo?.slides ?? []).map((s, i) => ({ i, id: s.avatar?.id })).filter((p) => p.id);
  if (!pedidos.length) return {};
  const { chave } = await lerConfigAvatar();
  if (!chave) return {};
  const clipes = {};
  await Promise.all(pedidos.map(async ({ i, id }) => {
    const arquivo = path.join(pasta, `avatar-${i}.mp4`);
    try {
      await baixarClipe(chave, id, arquivo, { esperaMs, tentativas });
      const duracao = await duracaoDoClipe(arquivo);
      if (duracao) clipes[i] = { arquivo, duracao };
    } catch (e) {
      log(`⚠️  Avatar: o Reels sai sem o clipe da tela ${i + 1}: ${e.message}`);
    }
  }));
  return clipes;
}
