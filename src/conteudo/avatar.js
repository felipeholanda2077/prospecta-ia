import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpeg from "ffmpeg-static";
import { config } from "../config.js";
import * as db from "../db.js";
import { FUNDOS } from "../../public/post-desenho.js";

// O avatar de IA do Felipe (HeyGen) falando em todas as cenas dos Reels. Os clipes são pedidos
// quando o post é criado (o HeyGen leva alguns minutos) e baixados na hora de gerar o vídeo. Tudo aqui é
// opcional: sem configuração ou sem crédito no HeyGen, o Reels sai sem avatar, com a voz da narração.
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

// Cada clipe pesa na hora de montar o vídeo, e a Vercel corta a execução em 5 minutos.
const MAX_CENAS_COM_AVATAR = 6;

/** O Felipe fala em todas as cenas, até o limite, sempre com a chamada final: o vídeo com o rosto e a voz dele foi o que mais alcançou no perfil. */
export function cenasDoAvatar(slides) {
  const total = slides?.length ?? 0;
  const indices = Array.from({ length: total }, (_, i) => i);
  return total > MAX_CENAS_COM_AVATAR ? [...indices.slice(0, MAX_CENAS_COM_AVATAR - 1), total - 1] : indices;
}

/**
 * Pede ao HeyGen os clipes da capa e da chamada. Guarda em cada tela `avatar: { id }`. Se um pedido
 * falhar, aquela tela só fica sem clipe. Retorna o conteúdo.
 */
export async function pedirClipes(conteudo, { formato } = {}) {
  if (formato !== "reels" || !conteudo.comFelipe) return conteudo;
  const c = await lerConfigAvatar();
  if (!c.ativo || !c.chave || !c.avatarId) return conteudo;
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
    if (n + 1 >= tentativas) throw new Error(AINDA_NAO_FICOU_PRONTO);
    await new Promise((res) => setTimeout(res, esperaMs));
  }
}

/**
 * Baixa os clipes prontos do post para `pasta`. Retorna { índice da tela: { arquivo, duracao } }.
 * Clipe que falhar ou ainda não estiver pronto fica de fora; os que ainda estão no HeyGen entram em `pendentes`.
 */
export async function baixarClipes(post, pasta, { esperaMs = 10_000, tentativas = 6, pendentes = [] } = {}) {
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
      if (e.message === AINDA_NAO_FICOU_PRONTO) pendentes.push(i);
      log(`⚠️  Avatar: o Reels sai sem o clipe da tela ${i + 1}: ${e.message}`);
    }
  }));
  return clipes;
}
