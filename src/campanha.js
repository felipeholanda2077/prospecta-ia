import { carregarCampanha } from "./config.js";
import * as db from "./db.js";

export const CAMPOS_EMPRESA = ["nome", "responsavel", "cargo", "telefone", "email", "site", "portfolio"];

// Valores de exemplo do campanha.json que não devem aparecer nas mensagens.
const PLACEHOLDER = /seu nome|seudominio|99999-9999/i;

// Funil automático: começa desligado; você liga e ajusta em Automação.
export const AUTOMACAO_PADRAO = {
  ativo: false, // busca, aprova e envia sozinho
  respostaAutomatica: false, // a IA responde as conversas sozinha
  metaDiaria: { email: 100, whatsapp: 100 },
  aquecimentoWhatsapp: true, // começa com 20/dia e sobe 10 por dia útil
  maxRespostasIA: 6, // depois disso a conversa passa para você
  calendly: "",
  buscas: null, // null = usa as do campanha.json
};

export async function lerAutomacao() {
  const salvo = (await db.lerConfig("automacao")) ?? {};
  return { ...AUTOMACAO_PADRAO, ...salvo, metaDiaria: { ...AUTOMACAO_PADRAO.metaDiaria, ...(salvo.metaDiaria ?? {}) } };
}

/** Campanha do arquivo + perfil da empresa e automação salvos no painel (que têm prioridade). */
export async function carregarCampanhaCompleta() {
  const campanha = carregarCampanha();
  const automacao = await lerAutomacao();
  if (Array.isArray(automacao.buscas) && automacao.buscas.length) campanha.buscas = automacao.buscas;
  campanha.automacao = automacao;
  const salvo = (await db.lerConfig("empresa")) ?? {};
  const empresa = { ...campanha.empresa };
  for (const campo of CAMPOS_EMPRESA) {
    if (typeof salvo[campo] === "string" && salvo[campo].trim()) empresa[campo] = salvo[campo].trim();
  }
  // Campos ainda com o valor de exemplo ficam vazios: a IA não deve citá-los.
  for (const campo of CAMPOS_EMPRESA) if (PLACEHOLDER.test(empresa[campo] ?? "")) empresa[campo] = "";
  return { ...campanha, empresa };
}
