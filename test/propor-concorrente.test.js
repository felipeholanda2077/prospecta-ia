import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.ANTHROPIC_API_KEY = "chave-de-teste";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

const etapas = { etapa1: "Oi, tudo bem?", etapa2: "Passando de novo.", etapa3: "Último toque." };
const original = globalThis.fetch;
globalThis.fetch = async (url, opcoes) => {
  if (!String(url).includes("api.anthropic.com")) return original(url, opcoes);
  await new Promise((r) => setTimeout(r, 30)); // a IA demora: as duas rodadas se cruzam
  const texto = JSON.stringify({ servico_principal: "site", resumo_interno: "teste", assunto_email: "oi", email: etapas, whatsapp: etapas });
  return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "t", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: texto }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
};

test("propostas: duas rodadas ao mesmo tempo não escrevem a sequência duas vezes para a mesma empresa", async () => {
  await db.inserirLead({ place_id: "dup-1", nome: "Clínica Dupla", nicho: "clínica", cidade: "Osasco", endereco: null, telefone: null, site: null, maps_url: null, avaliacao: null, total_avaliacoes: null });
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.place_id === "dup-1");
  await db.atualizarLead(lead.id, { status: "analisado", email: "contato@clinicadupla.com.br", oportunidades: JSON.stringify([{ servico: "site", motivo: "sem site", peso: 10 }]) });
  const { readFile } = await import("node:fs/promises");
  const base = JSON.parse(await readFile(new URL("../config/campanha.json", import.meta.url), "utf8"));
  const campanha = { ...base, canais: ["email"], limites: { ...base.limites, maxPropostasPorCiclo: 10 }, automacao: { ...(base.automacao ?? {}), ativo: false } };
  const [a, b] = await Promise.all([pipeline.propor(campanha), pipeline.propor(campanha)]);
  assert.equal(a.geradas + b.geradas, 1);
  const emails = await db.mensagensDaSequencia(lead.id, "email");
  assert.deepEqual(emails.map((m) => m.etapa), [1, 2, 3]);
});
