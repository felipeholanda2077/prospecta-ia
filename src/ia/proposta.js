import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";

let client;

const PropostaSchema = z.object({
  servico_principal: z.string(),
  assunto_email: z.string(),
  corpo_email: z.string(),
  mensagem_whatsapp: z.string(),
  resumo_interno: z.string(),
});

// JSON Schema equivalente, usado pelo structured output da API.
const PROPOSTA_JSON_SCHEMA = {
  type: "object",
  properties: {
    servico_principal: { type: "string", description: "id do serviço do catálogo mais indicado" },
    assunto_email: { type: "string", description: "assunto curto, sem caixa alta nem emojis" },
    corpo_email: { type: "string", description: "corpo do e-mail em texto simples" },
    mensagem_whatsapp: { type: "string", description: "versão curta para WhatsApp, até 500 caracteres" },
    resumo_interno: { type: "string", description: "1 frase para o vendedor explicando o ângulo da proposta" },
  },
  required: ["servico_principal", "assunto_email", "corpo_email", "mensagem_whatsapp", "resumo_interno"],
  additionalProperties: false,
};

function montarSistema(campanha) {
  const { empresa, servicos } = campanha;
  return `Você é um consultor comercial da ${empresa.nome}, empresa que desenvolve sites, lojas virtuais e sistemas.
Sua tarefa é escrever a PRIMEIRA mensagem de contato para uma empresa que ainda não conhece vocês.

Quem assina: ${empresa.responsavel} (${empresa.cargo}) — ${empresa.nome}
Contato: ${empresa.telefone} · ${empresa.email} · ${empresa.site}
Portfólio: ${empresa.portfolio}
Diferenciais: ${empresa.diferenciais.join("; ")}

Catálogo de serviços (use apenas estes, com estes valores):
${servicos.map((s) => `- [${s.id}] ${s.nome}: ${s.descricao} A partir de ${s.aPartirDe}, prazo ${s.prazo}.`).join("\n")}

Regras da mensagem:
- Português do Brasil, tom cordial e direto, como um profissional local escrevendo pessoalmente.
- Cite 1 ou 2 observações concretas que foram encontradas sobre a empresa (as "oportunidades" fornecidas). Nunca invente fatos, números, clientes ou resultados que não foram informados.
- Ofereça UM serviço principal (o mais relevante) e, no máximo, mencione um segundo de passagem.
- Mostre o benefício para o negócio dela (mais clientes, menos trabalho manual, vendas fora do horário), não jargão técnico.
- Termine com uma pergunta simples e de baixo compromisso (ex.: se pode enviar um exemplo ou marcar 15 minutos).
- E-mail: 90 a 160 palavras, texto simples, sem markdown, saudação com o nome da empresa, assinatura com nome, empresa e telefone.
- WhatsApp: até 500 caracteres, sem links encurtados, sem emojis em excesso.
- Proibido: urgência falsa, "promoção só hoje", promessas de resultado garantido, caixa alta, criticar a empresa de forma ofensiva.
- Não escreva o rodapé de descadastro; ele é adicionado automaticamente.`;
}

function montarPedido(lead, oportunidades) {
  return `Dados da empresa prospectada:
- Nome: ${lead.nome}
- Segmento: ${lead.nicho ?? "não informado"}
- Cidade: ${lead.cidade ?? "não informada"}
- Site: ${lead.site ?? "não possui"}
- Avaliação no Google: ${lead.avaliacao ? `${lead.avaliacao} (${lead.total_avaliacoes} avaliações)` : "sem dados"}

Oportunidades encontradas na análise (da mais para a menos relevante):
${oportunidades.map((o) => `- [${o.servico}] ${o.motivo}`).join("\n")}

Escreva a proposta.`;
}

/** Gera assunto, e-mail e mensagem de WhatsApp personalizados para um lead. */
export async function gerarProposta(lead, oportunidades, campanha) {
  client ??= new Anthropic();
  const resposta = await client.beta.messages.create({
    model: config.claude.model,
    max_tokens: 16000,
    // Se a solicitação for recusada pelos filtros do modelo, a API tenta de novo
    // automaticamente no modelo de reserva recomendado.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: PROPOSTA_JSON_SCHEMA },
    },
    system: montarSistema(campanha),
    messages: [{ role: "user", content: montarPedido(lead, oportunidades) }],
  });

  if (resposta.stop_reason === "refusal") {
    throw new Error(`A IA recusou gerar a proposta (${resposta.stop_details?.category ?? "sem categoria"})`);
  }
  if (resposta.stop_reason === "max_tokens") {
    throw new Error("A resposta da IA foi cortada (max_tokens)");
  }

  const texto = resposta.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return PropostaSchema.parse(JSON.parse(texto));
}
