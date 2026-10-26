import { z } from "zod";
import { gerarJson } from "./cliente.js";

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
  return gerarJson({
    system: montarSistema(campanha),
    pedido: montarPedido(lead, oportunidades),
    jsonSchema: PROPOSTA_JSON_SCHEMA,
    zodSchema: PropostaSchema,
  });
}

const FollowupSchema = z.object({ corpo_email: z.string() });

const FOLLOWUP_JSON_SCHEMA = {
  type: "object",
  properties: {
    corpo_email: { type: "string", description: "corpo do e-mail de follow-up em texto simples" },
  },
  required: ["corpo_email"],
  additionalProperties: false,
};

/** Gera um lembrete curto para quem não respondeu. `original` é a mensagem enviada, com os dados da empresa. */
export async function gerarFollowup(original, campanha) {
  const { empresa } = campanha;
  const { corpo_email } = await gerarJson({
    system: `${montarSistema(campanha)}

Agora você vai escrever um FOLLOW-UP: a empresa recebeu o e-mail abaixo há alguns dias e não respondeu.
Regras do follow-up:
- 40 a 80 palavras, respondendo na mesma conversa (não repita a proposta inteira).
- Traga UM elemento novo e útil: um exemplo concreto do benefício, ou uma pergunta sobre como eles fazem hoje.
- Deixe claro que é o último contato se não houver interesse, sem tom de cobrança.
- Assine como ${empresa.responsavel}, ${empresa.nome}.`,
    pedido: `Empresa: ${original.empresa} (${original.nicho ?? "segmento não informado"}, ${original.cidade ?? ""})

E-mail enviado anteriormente:
Assunto: ${original.assunto}
${original.corpo}

Escreva o follow-up.`,
    jsonSchema: FOLLOWUP_JSON_SCHEMA,
    zodSchema: FollowupSchema,
    effort: "low",
  });
  return corpo_email;
}
