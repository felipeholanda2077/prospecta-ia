// Voz que narra o Reels, cena por cena, pela OpenAI, pela ElevenLabs ou pelo Gemini (o que tiver a
// chave cadastrada nas variáveis de ambiente). Sem chave, o Reels sai só com a trilha e os efeitos.
// Os três devolvem PCM de 16 bits, mono, 24 kHz: dá para medir a duração sem decodificar.
import { telasDoPost } from "../../public/post-desenho.js";

export const TAXA_VOZ = 24000;

const INSTRUCOES =
  "Locutor brasileiro de Reels de negócios: português do Brasil, sotaque neutro, energia alta, ritmo rápido e " +
  "confiante, frases curtas com pausas curtas e ênfase nas palavras de impacto. Natural, como um criador de " +
  "conteúdo falando com o dono de uma empresa, nunca como locução de propaganda de rádio.";

const ESTILO_GEMINI = "locutor brasileiro de Reels, energia alta, ritmo rápido e confiante";

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
    // Uma voz masculina e uma feminina, alternando de um post para o outro.
    falar: (texto, post) => fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: ["ash", "coral"][Math.abs(Number(post.id) || 0) % 2],
        input: texto,
        instructions: INSTRUCOES,
        response_format: "pcm",
      }),
      signal: AbortSignal.timeout(45_000),
    }),
  },
  {
    nome: "ElevenLabs",
    chave: "ELEVENLABS_API_KEY",
    falar: (texto) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB"}?output_format=pcm_24000`, {
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
        input: [{ type: "user_input", content: [{ type: "text", text: texto, annotations: [{ type: "speech_metadata", style: ESTILO_GEMINI }] }] }],
        response_format: { type: "audio", mime_type: "audio/l16", sample_rate: TAXA_VOZ },
        generation_config: { speech_config: [{ voice: ["Puck", "Kore"][Math.abs(Number(post.id) || 0) % 2] }] },
      }),
      signal: AbortSignal.timeout(60_000),
    }),
    pcm: pcmDoGemini,
  },
];

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Uma fala em PCM. Quando o serviço recusa por limite de pedidos (429), espera e tenta de novo.
async function falarCena(p, texto, post) {
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

const provedor = () => PROVEDORES.find((p) => process.env[p.chave]);

/** Qual serviço narra os Reels (o nome), ou null se nenhuma chave estiver cadastrada. */
export const narracaoDisponivel = () => provedor()?.nome ?? null;

/**
 * A fala de cada cena em áudio. Retorna uma lista na ordem das cenas, com { pcm, duracao } (ou null
 * para cena sem fala), ou null quando não há serviço de voz configurado.
 */
export async function narrarCenas(post) {
  const p = provedor();
  if (!p || post.formato !== "reels") return null;
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
