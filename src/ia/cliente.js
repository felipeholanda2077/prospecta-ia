import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client;

/**
 * Chama o Claude pedindo uma resposta em JSON no formato de `jsonSchema`
 * e valida o resultado com o schema Zod `zodSchema`.
 */
export async function gerarJson({ system, pedido, jsonSchema, zodSchema, effort = "medium" }) {
  client ??= new Anthropic();
  const resposta = await client.beta.messages.create({
    model: config.claude.model,
    max_tokens: 16000,
    // Se a solicitação for recusada pelos filtros do modelo, a API tenta de novo
    // automaticamente no modelo de reserva recomendado.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
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
