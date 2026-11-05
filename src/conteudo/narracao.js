// Voz que narra o Reels, cena por cena, pela OpenAI, pela ElevenLabs ou pelo Gemini (o que tiver a
// chave cadastrada nas variáveis de ambiente). Se eles falharem ou não houver chave, entram as vozes
// grátis, que não pedem chave nem crédito: o vídeo não pode deixar de sair por falta de voz.
// Todos devolvem PCM de 16 bits, mono, 24 kHz: dá para medir a duração sem decodificar.
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { telasDoPost } from "../../public/post-desenho.js";
import * as db from "../db.js";

export const TAXA_VOZ = 24000;

const instrucoes = (voz) =>
  `${voz === "feminina" ? "Locutora brasileira" : "Locutor brasileiro"} de Reels de negócios: português do Brasil, sotaque neutro, energia alta, ritmo rápido e ` +
  "confiante, frases curtas com pausas curtas e ênfase nas palavras de impacto. Natural, como quem cria " +
  "conteúdo falando com o dono de uma empresa, nunca como locução de propaganda de rádio.";

const estiloGemini = (voz) => `${voz === "feminina" ? "locutora brasileira" : "locutor brasileiro"} de Reels, energia alta, ritmo rápido e confiante`;

// A voz de cada serviço: a masculina é a do Felipe (o avatar usa a narração); a feminina narra os Reels sem ele.
// Edge: a Thalita é a voz feminina mais natural das grátis; a Francisca fica de reserva.
export const VOZES = {
  masculina: { openai: "ash", gemini: "Puck", edge: ["pt-BR-AntonioNeural"] },
  feminina: { openai: "coral", gemini: "Kore", edge: ["pt-BR-ThalitaMultilingualNeural", "pt-BR-FranciscaNeural"] },
};

/**
 * Feminina ou masculina. Vale a que o post escolheu; nos posts de antes dessa escolha, a masculina
 * quando o Felipe aparece e, sem ele, alternando pelo número do post.
 */
export function vozDoPost(post) {
  const c = post?.conteudo ?? {};
  if (c.voz in VOZES) return c.voz;
  if (c.comFelipe) return "masculina";
  return Math.abs(Number(post?.id) || 0) % 2 ? "feminina" : "masculina";
}

// O Gemini manda o áudio em base64 dentro do JSON; se vier como WAV, tira o cabeçalho.
async function pcmDoGemini(r) {
  const corpo = await r.json();
  const audio = corpo.steps?.find((s) => s.type === "model_output")?.content?.find((c) => c.type === "audio");
  if (!audio?.data) throw new Error("Gemini não devolveu áudio");
  const bytes = Buffer.from(audio.data, "base64");
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return bytes;
  const dados = bytes.indexOf("data", 12, "ascii");
  return dados < 0 ? bytes.subarray(44) : bytes.subarray(dados + 8);
}

const PROVEDORES = [
  {
    nome: "OpenAI",
    chave: "OPENAI_API_KEY",
    falar: (texto, post) => fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: VOZES[vozDoPost(post)].openai,
        input: texto,
        instructions: instrucoes(vozDoPost(post)),
        response_format: "pcm",
      }),
      signal: AbortSignal.timeout(45_000),
    }),
  },
  {
    nome: "ElevenLabs",
    chave: "ELEVENLABS_API_KEY",
    // A voz feminina pode ser trocada em ELEVENLABS_VOICE_ID_FEMININA (a padrão é uma das prontas da ElevenLabs).
    falar: (texto, post) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vozDoPost(post) === "feminina" ? process.env.ELEVENLABS_VOICE_ID_FEMININA || "EXAVITQu4vr4xnSDxMaL" : process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"}?output_format=pcm_24000`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text: texto, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.55 } }),
      signal: AbortSignal.timeout(45_000),
    }),
  },
  {
    nome: "Gemini",
    chave: "GEMINI_API_KEY",
    // O plano grátis aceita poucos pedidos por minuto: uma cena de cada vez, esperando quando ele pede.
    umaPorVez: true,
    falar: (texto, post) => fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts",
        input: [{ type: "user_input", content: [{ type: "text", text: texto, annotations: [{ type: "speech_metadata", style: estiloGemini(vozDoPost(post)) }] }] }],
        response_format: { type: "audio", mime_type: "audio/l16", sample_rate: TAXA_VOZ },
        generation_config: { speech_config: [{ voice: VOZES[vozDoPost(post)].gemini }] },
      }),
      signal: AbortSignal.timeout(60_000),
    }),
    pcm: pcmDoGemini,
  },
];

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

function converterAudio(entradas, audio) {
  return new Promise((ok, falhou) => {
    const p = spawn(ffmpeg, ["-loglevel", "error", ...entradas]);
    const partes = [];
    let erros = "";
    p.stdout.on("data", (d) => partes.push(d));
    p.stderr.on("data", (d) => (erros += d));
    p.on("error", falhou);
    p.on("close", (codigo) => {
      const saida = Buffer.concat(partes);
      if (codigo === 0 && saida.length) ok(saida);
      else falhou(new Error(`não deu para converter o áudio: ${erros.trim() || `ffmpeg saiu com ${codigo}`}`));
    });
    p.stdin.on("error", () => {});
    p.stdin.end(audio);
  });
}

const pcmDoMp3 = (mp3) => converterAudio(["-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", String(TAXA_VOZ), "pipe:1"], mp3);

async function mp3DoEdge(texto, post) {
  let erro;
  for (const voz of VOZES[vozDoPost(post)].edge) {
    try {
      const mp3 = await mp3DaVozDoEdge(voz, texto, post);
      if (mp3.length) return mp3;
      erro = new Error(`${voz} não devolveu áudio`);
    } catch (e) {
      erro = e;
    }
  }
  throw erro;
}

async function mp3DaVozDoEdge(voz, texto, post) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  let limite;
  try {
    const gerar = (async () => {
      await tts.setMetadata(voz, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const partes = [];
      for await (const parte of tts.toStream(texto, { rate: post.ritmo ?? "+8%" }).audioStream) partes.push(parte);
      return Buffer.concat(partes);
    })();
    return await Promise.race([gerar, new Promise((_, falhou) => { limite = setTimeout(() => falhou(new Error("sem resposta")), 30_000); })]);
  } finally {
    clearTimeout(limite);
    tts.close();
  }
}

/** O Google só lê até 200 caracteres por pedido: corta a fala nas pausas e, se precisar, nos espaços. */
export function pedacosDaFala(texto, limite = 190) {
  const pedacos = [];
  let atual = "";
  for (const palavra of String(texto).trim().split(/\s+/)) {
    if (atual && (atual.length + palavra.length + 1 > limite || (/[.!?]$/.test(atual) && atual.length > limite / 2))) {
      pedacos.push(atual);
      atual = palavra;
    } else atual = atual ? `${atual} ${palavra}` : palavra;
  }
  return atual ? [...pedacos, atual] : pedacos;
}

async function mp3DoGoogle(texto) {
  const partes = [];
  for (const pedaco of pedacosDaFala(texto)) {
    const r = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&tl=pt-BR&client=tw-ob&q=${encodeURIComponent(pedaco)}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`respondeu ${r.status}`);
    partes.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(partes);
}

// Nenhuma pede chave ou conta. São serviços não oficiais, por isso são duas e vêm depois dos serviços com chave.
// A do Google só tem voz feminina.
const VOZES_GRATIS = [
  { nome: "Edge", umaPorVez: true, gerarPcm: async (texto, post) => pcmDoMp3(await mp3DoEdge(texto, post)) },
  { nome: "Google", umaPorVez: true, gerarPcm: async (texto) => pcmDoMp3(await mp3DoGoogle(texto)) },
];

// Uma fala em PCM. Quando o serviço recusa por limite de pedidos (429), espera e tenta de novo.
async function falarCena(p, texto, post) {
  if (p.gerarPcm) return p.gerarPcm(texto, post);
  for (let tentativa = 0; ; tentativa++) {
    const r = await p.falar(texto, post);
    if (r.ok) return p.pcm ? p.pcm(r) : Buffer.from(await r.arrayBuffer());
    const corpo = await r.text().catch(() => "");
    if (r.status === 429 && tentativa < 3) {
      const segundos = Number(r.headers.get("retry-after")) || Number(corpo.match(/retry in ([\d.]+)s/i)?.[1]) || 15;
      await esperar(Math.min(segundos, 30) * 1000 + 500);
      continue;
    }
    throw new Error(`${p.nome} não gerou a voz (${r.status}): ${corpo.slice(0, 200)}`);
  }
}

const provedores = () => [...PROVEDORES.filter((p) => process.env[p.chave]), ...VOZES_GRATIS];

/** A chave do Gemini colada no painel vale no lugar da variável de ambiente. */
export async function carregarChaveDaVoz() {
  const salva = (await db.lerConfig("voz"))?.gemini;
  if (salva) process.env.GEMINI_API_KEY = salva;
}

/** Guarda a chave do Gemini e testa com uma frase curta. Retorna { ok } ou { ok: false, erro }. */
export async function salvarChaveDoGemini(chave) {
  await db.gravarConfig("voz", { gemini: String(chave).trim() });
  await carregarChaveDaVoz();
  return falarCena(PROVEDORES.find((p) => p.chave === "GEMINI_API_KEY"), "Teste de voz.", { id: 1 })
    .then(() => ({ ok: true }), (e) => ({ ok: false, erro: e.message }));
}

/** Qual serviço narra os Reels (o nome). Sem chave cadastrada, a narração sai pelas vozes grátis. */
export const narracaoDisponivel = () => PROVEDORES.find((p) => process.env[p.chave])?.nome ?? "voz grátis";

async function narrarCom(p, post) {
  const narrar = async (tela) => {
    if (!tela.fala) return null;
    const pcm = await falarCena(p, tela.fala, post);
    return { pcm, duracao: pcm.length / 2 / TAXA_VOZ };
  };
  const telas = telasDoPost(post);
  if (!p.umaPorVez) return Promise.all(telas.map(narrar));
  const falas = [];
  for (const tela of telas) falas.push(await narrar(tela));
  return falas;
}

/**
 * A fala de cada cena em áudio. Retorna uma lista na ordem das cenas, com { pcm, duracao } (ou null
 * para cena sem fala). Um só serviço narra o vídeo inteiro: se ele falhar, o próximo refaz tudo,
 * para não trocar de voz no meio. Lança só quando nenhum conseguiu.
 */
export async function narrarCenas(post, { servicos = null } = {}) {
  if (post.formato !== "reels") return null;
  await carregarChaveDaVoz();
  let erro;
  for (const p of servicos ?? provedores()) {
    try {
      return await narrarCom(p, post);
    } catch (e) {
      erro = e;
      console.log(new Date().toISOString(), `⚠️  Voz: ${p.nome} falhou (${e.message}). Tentando o próximo serviço.`);
    }
  }
  throw erro;
}

const OPUS = ["-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "ogg", "pipe:1"];

/** Qualquer áudio em OGG Opus: o formato das mensagens de voz do WhatsApp. */
export const oggDoAudio = (audio) => converterAudio(["-i", "pipe:0", ...OPUS], audio);

/** Um texto falado pelas vozes do sistema, em OGG Opus. Lança só quando nenhuma voz conseguiu. */
export async function audioDoTexto(texto) {
  await carregarChaveDaVoz();
  let erro;
  for (const p of provedores()) {
    try {
      // Em ritmo de conversa, mais lento que a narração dos Reels.
      const pcm = await falarCena(p, texto, { id: 0, ritmo: "+0%" });
      return await converterAudio(["-f", "s16le", "-ar", String(TAXA_VOZ), "-ac", "1", "-i", "pipe:0", ...OPUS], pcm);
    } catch (e) {
      erro = e;
      console.log(new Date().toISOString(), `⚠️  Voz: ${p.nome} falhou (${e.message}). Tentando o próximo serviço.`);
    }
  }
  throw erro;
}

/** Junta as falas numa faixa só, cada uma começando em `inicios[i]` segundos. */
export function faixaDaVoz(falas, inicios, duracao) {
  const faixa = new Float32Array(Math.ceil(duracao * TAXA_VOZ));
  falas.forEach((fala, i) => {
    if (!fala) return;
    const i0 = Math.round(inicios[i] * TAXA_VOZ);
    for (let k = 0; k < fala.pcm.length / 2 && i0 + k < faixa.length; k++) faixa[i0 + k] = fala.pcm.readInt16LE(k * 2) / 32768;
  });
  return faixa;
}
