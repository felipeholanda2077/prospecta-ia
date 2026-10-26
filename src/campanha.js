import { carregarCampanha } from "./config.js";
import * as db from "./db.js";

export const CAMPOS_EMPRESA = ["nome", "responsavel", "cargo", "telefone", "email", "site", "portfolio"];

// Valores de exemplo do campanha.json que não devem aparecer nas mensagens.
const PLACEHOLDER = /seu nome|seudominio|99999-9999/i;

/** Campanha do arquivo + perfil da empresa salvo no painel (que tem prioridade). */
export async function carregarCampanhaCompleta() {
  const campanha = carregarCampanha();
  const salvo = (await db.lerConfig("empresa")) ?? {};
  const empresa = { ...campanha.empresa };
  for (const campo of CAMPOS_EMPRESA) {
    if (typeof salvo[campo] === "string" && salvo[campo].trim()) empresa[campo] = salvo[campo].trim();
  }
  // Campos ainda com o valor de exemplo ficam vazios: a IA não deve citá-los.
  for (const campo of CAMPOS_EMPRESA) if (PLACEHOLDER.test(empresa[campo] ?? "")) empresa[campo] = "";
  return { ...campanha, empresa };
}
