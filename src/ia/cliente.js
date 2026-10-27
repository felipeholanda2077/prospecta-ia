import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";

let client;

// O modelo de reserva automático (quando o pedido é recusado pelos filtros) existe no Opus e
// no Sonnet; no Haiku o parâmetro não é aceito.
const temReserva = (modelo) => !/haiku/i.test(modelo);

/**
 * Chama o Claude pedindo uma resposta em JSON no formato de `jsonSchema`
 * e valida o resultado com o schema Zod `zodSchema`.
 */
export async function gerarJson({ system, pedido, jsonSchema, zodSchema, effort = "medium" }) {
  if (!client && config.naVercel && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY não configurada nas variáveis de ambiente da Vercel");
  }
  try {
    client ??= new Anthropic();
  } catch (e) {
    throw new Error(`Chave da IA não configurada (ANTHROPIC_API_KEY): ${e.message}`);
  }
  const modelo = config.claude.model;
  const resposta = await client.beta.messages.create({
    model: modelo,
    max_tokens: 16000,
    // Se a solicitação for recusada pelos filtros do modelo, a API tenta de novo
    // automaticamente no modelo de reserva recomendado.
    ...(temReserva(modelo) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    output_config: {
      effort,
      format: { type: "json_schema", schema: jsonSchema },
    },
    system,
    messages: [{ role: "user", content: pedido }],
  });

  if (resposta.stop_reason === "refusal") {
    throw new Error(`A IA recusou o pedido (${resposta.stop_details?.category ?? "sem categoria"})`);
  }
  if (resposta.stop_reason === "max_tokens") {
    throw new Error("A resposta da IA foi cortada (max_tokens)");
  }

  const texto = resposta.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return zodSchema.parse(JSON.parse(texto));
}

/** Pedido mínimo à IA, para conferir a chave e o modelo em uso (não envia nada a ninguém). */
export async function testarIA() {
  const inicio = Date.now();
  const r = await gerarJson({
    system: "Você escreve mensagens curtas de prospecção em português do Brasil.",
    pedido: "Escreva uma saudação de uma frase para o dono de uma clínica odontológica.",
    jsonSchema: { type: "object", properties: { frase: { type: "string" } }, required: ["frase"], additionalProperties: false },
    zodSchema: z.object({ frase: z.string() }),
    effort: "low",
  });
  return { modelo: config.claude.model, exemplo: r.frase, ms: Date.now() - inicio };
}
