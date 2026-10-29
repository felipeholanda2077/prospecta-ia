// Voz que narra o Reels, cena por cena, pela OpenAI ou pela ElevenLabs (a que tiver a chave
// cadastrada nas variáveis de ambiente). Sem chave, o Reels sai só com a trilha e os efeitos.
// As duas devolvem PCM de 16 bits, mono, 24 kHz: dá para medir a duração sem decodificar.
import { telasDoPost } from "../../public/post-desenho.js";

export const TAXA_VOZ = 24000;

const INSTRUCOES =
  "Locutor brasileiro de Reels de negócios: português do Brasil, sotaque neutro, energia alta, ritmo rápido e " +
  "confiante, frases curtas com pausas curtas e ênfase nas palavras de impacto. Natural, como um criador de " +
  "conteúdo falando com o dono de uma empresa, nunca como locução de propaganda de rádio.";

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
];

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
  const telas = telasDoPost(post);
  return Promise.all(telas.map(async (tela) => {
    const texto = tela.fala;
    if (!texto) return null;
    const r = await p.falar(texto, post);
    if (!r.ok) {
      const corpo = await r.text().catch(() => "");
      throw new Error(`${p.nome} não gerou a voz (${r.status}): ${corpo.slice(0, 200)}`);
    }
    const pcm = Buffer.from(await r.arrayBuffer());
    return { pcm, duracao: pcm.length / 2 / TAXA_VOZ };
  }));
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
