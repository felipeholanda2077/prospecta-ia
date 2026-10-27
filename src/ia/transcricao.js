// Transcrição dos áudios recebidos no WhatsApp. O Claude lê texto, não áudio, então o
// áudio vira texto antes: pelo Groq (tem plano grátis) ou pela OpenAI, conforme a chave
// cadastrada nas variáveis de ambiente.
const PROVEDORES = [
  { nome: "Groq", chave: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1/audio/transcriptions", modelo: "whisper-large-v3-turbo" },
  { nome: "OpenAI", chave: "OPENAI_API_KEY", url: "https://api.openai.com/v1/audio/transcriptions", modelo: "gpt-4o-mini-transcribe" },
];

const provedor = () => PROVEDORES.find((p) => process.env[p.chave]);

export function transcricaoConfigurada() {
  return Boolean(provedor());
}

const EXTENSOES = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "m4a", "audio/wav": "wav", "audio/webm": "webm" };

/** Transcreve um áudio (Buffer) em português. Retorna o texto falado. */
export async function transcrever(audio, mimetype = "audio/ogg") {
  const p = provedor();
  if (!p) throw new Error("transcrição de áudio não configurada (cadastre GROQ_API_KEY ou OPENAI_API_KEY na Vercel)");
  const tipo = String(mimetype).split(";")[0].trim().toLowerCase();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: tipo }), `audio.${EXTENSOES[tipo] ?? "ogg"}`);
  form.append("model", p.modelo);
  form.append("language", "pt");
  form.append("response_format", "json");

  const resp = await fetch(p.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env[p.chave]}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${p.nome} não transcreveu o áudio (${resp.status}): ${dados.error?.message ?? "erro"}`);
  const texto = String(dados.text ?? "").trim();
  if (!texto) throw new Error("o áudio não tinha fala reconhecível");
  return texto;
}
