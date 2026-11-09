import crypto from "node:crypto";
import * as db from "../db.js";
import { gerarJson } from "../ia/cliente.js";
import { lerApresentacao } from "../respostas/apresentacao.js";

// Proposta em slides personalizada: a IA lê a conversa e escreve a dor da empresa e a solução para ela; os slides
// ficam na apresentação do site (fluxdeck.com.br/apresentacao?proposta=código), logo depois da capa. O código é
// aleatório (não é o do descadastro) e o site lê os dados por GET /proposta-slides/:codigo. Nunca com valores.
const SITE = "https://fluxdeck.com.br/apresentacao";
const chaveDoCodigo = (codigo) => `proposta_slides:${codigo}`;
const chaveDoLead = (leadId) => `proposta_slides_lead:${leadId}`;

const texto = (max) => ({ type: "string", description: `até ${max} caracteres` });
const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titulo", "resumo", "dores", "solucao", "passos", "resultados", "proximoPasso", "mensagem"],
  properties: {
    titulo: { ...texto(90), description: "Título do slide da dor: a dor principal da empresa numa frase forte (até 90 caracteres)" },
    resumo: { ...texto(280), description: "O que entendemos da operação deles, com os fatos ditos na conversa (até 280 caracteres)" },
    dores: { type: "array", description: "2 ou 3 dores", items: { type: "object", additionalProperties: false, required: ["titulo", "texto"], properties: { titulo: texto(50), texto: texto(180) } } },
    solucao: {
      type: "object", additionalProperties: false, required: ["titulo", "itens"],
      properties: {
        titulo: texto(90),
        itens: { type: "array", description: "3 a 5 partes da solução", items: { type: "object", additionalProperties: false, required: ["titulo", "texto"], properties: { titulo: texto(50), texto: texto(180) } } },
      },
    },
    passos: { type: "array", description: "3 a 5 passos", items: texto(160) },
    resultados: { type: "array", description: "exatamente 3 resultados", items: texto(120) },
    proximoPasso: texto(140),
    mensagem: { type: "string", description: "A mensagem de WhatsApp que leva o link, como Felipe; use {{link}} onde vai o link (até 500 caracteres)" },
  },
};

const SISTEMA = `Você é o Felipe, da FluxDeck (software house de Osasco: sites, sistemas, apps, automações e IA no WhatsApp).
Escreva uma proposta comercial em slides para a empresa da conversa, personalizada para a dor que ela mostrou.
Regras:
- Português do Brasil, direto, sem jargão técnico e sem exagero.
- Use só fatos da conversa e do cadastro. Não invente números, clientes, prazos nem resultados com percentuais.
- Nunca cite valores, preços nem planos: tudo é sob medida e o valor vem depois de entender o volume.
- A solução usa os serviços da FluxDeck que resolvem a dor (ex.: IA atendendo no WhatsApp 24 h, respondendo dúvidas, valores que a própria empresa divulga, horários e encaminhando para a recepção quando precisa de uma pessoa).
- "passos" descreve, na prática, como fica o atendimento de um cliente deles com a solução.
- "mensagem": curta, responde ao que a pessoa disse por último, chama a pessoa pelo nome se ela se identificou, leva {{link}} e pede para encaminhar ao setor ou à pessoa certa, se for o caso. Sem "bom dia".`;

/** Gera (ou refaz) a proposta em slides de uma empresa, a partir da conversa. Não envia nada. */
export async function gerarPropostaSlides(leadId, { gerar = gerarJson } = {}) {
  const lead = await db.buscarLead(leadId);
  if (!lead) throw new Error("Empresa não encontrada");
  const historico = await db.historicoConversa(lead.id);
  if (!historico.length) throw new Error("Esta empresa ainda não tem conversa para a proposta");
  const conversa = historico.map((h) => `${h.autor === "nos" ? "Felipe" : lead.nome}: ${String(h.texto ?? "").replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  const dados = await gerar({
    system: SISTEMA,
    pedido: `Empresa: ${lead.nome}\nSegmento: ${lead.nicho ?? "-"}\nCidade: ${lead.cidade ?? "-"}\nAvaliações no Google: ${lead.avaliacao ?? "-"} (${lead.total_avaliacoes ?? 0})\n\nServiços da FluxDeck:\n${(await lerApresentacao()).slice(0, 2500)}\n\nConversa:\n${conversa}`,
    jsonSchema: ESQUEMA,
    effort: "medium",
    maxTokens: 4000,
  });
  const codigo = (await db.lerEstado(chaveDoLead(lead.id))) || crypto.randomBytes(12).toString("base64url");
  const proposta = {
    empresa: lead.nome, ...dados,
    dores: (dados.dores ?? []).slice(0, 3), passos: (dados.passos ?? []).slice(0, 5), resultados: (dados.resultados ?? []).slice(0, 3),
    solucao: { titulo: dados.solucao?.titulo ?? "", itens: (dados.solucao?.itens ?? []).slice(0, 5) },
  };
  delete proposta.mensagem;
  await db.gravarConfig(chaveDoCodigo(codigo), { leadId: lead.id, proposta, criadaEm: new Date().toISOString() });
  await db.gravarEstado(chaveDoLead(lead.id), codigo);
  const link = `${SITE}?para=${encodeURIComponent(lead.nome.slice(0, 80))}&proposta=${codigo}`;
  const mensagem = String(dados.mensagem ?? "").includes("{{link}}") ? dados.mensagem.replace("{{link}}", link) : `${dados.mensagem}\n\n${link}`;
  return { codigo, link, mensagem, proposta };
}

/** Os dados públicos da proposta (o que o site mostra), ou null. */
export async function propostaPublica(codigo) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(codigo ?? ""))) return null;
  return (await db.lerConfig(chaveDoCodigo(codigo)))?.proposta ?? null;
}
