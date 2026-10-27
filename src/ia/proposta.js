import { z } from "zod";
import { gerarJson } from "./cliente.js";

const Etapas = z.object({ etapa1: z.string(), etapa2: z.string(), etapa3: z.string() });

const SequenciaSchema = z.object({
  servico_principal: z.string(),
  resumo_interno: z.string(),
  assunto_email: z.string(),
  email: Etapas,
  whatsapp: Etapas,
});

const etapasJson = (descricao) => ({
  type: "object",
  description: descricao,
  properties: {
    etapa1: { type: "string", description: "primeiro contato" },
    etapa2: { type: "string", description: "se não houver resposta" },
    etapa3: { type: "string", description: "último toque" },
  },
  required: ["etapa1", "etapa2", "etapa3"],
  additionalProperties: false,
});

// JSON Schema equivalente, usado pelo structured output da API.
const SEQUENCIA_JSON_SCHEMA = {
  type: "object",
  properties: {
    servico_principal: { type: "string", description: "id do serviço do catálogo mais indicado" },
    resumo_interno: { type: "string", description: "1 frase para o vendedor explicando o ângulo da abordagem" },
    assunto_email: { type: "string", description: "assunto curto e pessoal, sem caixa alta, sem emojis e sem cara de anúncio" },
    email: etapasJson("corpo das 3 etapas por e-mail, em texto simples"),
    whatsapp: etapasJson("as 3 etapas por WhatsApp"),
  },
  required: ["servico_principal", "resumo_interno", "assunto_email", "email", "whatsapp"],
  additionalProperties: false,
};

/** Como a IA deve se apresentar e assinar, sem inventar dados que a empresa ainda não preencheu. */
export function identidade(empresa) {
  const quem = empresa.responsavel
    ? `${empresa.responsavel}${empresa.cargo ? ` (${empresa.cargo})` : ""}, da ${empresa.nome}`
    : `a equipe da ${empresa.nome}`;
  const assinatura = [empresa.responsavel, empresa.nome, empresa.telefone].filter(Boolean).join(" · ");
  return { quem, assinatura };
}

export function contextoEmpresa(campanha) {
  const { empresa, servicos } = campanha;
  const { quem, assinatura } = identidade(empresa);
  const pessoa = empresa.responsavel
    ? `Você é ${quem}, escrevendo pessoalmente, em primeira pessoa ("eu"), do seu próprio WhatsApp e e-mail.
Fale sempre como ${empresa.responsavel}: nunca se apresente como assistente, robô, IA, sistema ou "equipe".`
    : `Você escreve em nome de ${quem}.`;
  return `${pessoa} A ${empresa.nome} desenvolve sites, lojas virtuais e sistemas.
Assinatura dos e-mails: ${assinatura}
${empresa.site ? `Site: ${empresa.site}\n` : ""}${empresa.portfolio ? `Portfólio: ${empresa.portfolio}\n` : ""}Diferenciais: ${empresa.diferenciais.join("; ")}

Catálogo (use apenas estes serviços e valores, e só quando a etapa permitir):
${servicos.map((s) => `- [${s.id}] ${s.nome}: ${s.descricao} A partir de ${s.aPartirDe}, prazo ${s.prazo}.`).join("\n")}

Nunca invente nomes, telefones, sites, clientes, números ou resultados que não estejam aqui.`;
}

function montarSistema(campanha) {
  return `${contextoEmpresa(campanha)}

Sua tarefa: escrever uma SEQUÊNCIA de 3 mensagens para iniciar contato com uma empresa que ainda não conhece vocês.
A abordagem é gradual, como uma pessoa de verdade puxando conversa: a informação vai sendo revelada aos poucos.
Cada etapa só é enviada se a anterior não teve resposta; quando a empresa responder, a sequência para.

Etapa 1 — primeiro contato (curtíssima e leve):
- Cumprimente, diga quem é em poucas palavras e cite UMA coisa positiva e concreta observada sobre a empresa (ex.: as avaliações no Google).
- Termine com UMA pergunta simples e aberta sobre como eles trabalham hoje, ligada à oportunidade observada (ex.: como os pacientes costumam encontrar vocês).
- PROIBIDO na etapa 1: preço, prazo, lista de serviços, link, pedido de reunião, dizer que "falta" algo à empresa.
- WhatsApp: no máximo 2 frases curtas (até ~240 caracteres). E-mail: 40 a 70 palavras.

As 3 etapas saem no MESMO DIA, com cerca de 2 horas entre elas. Escreva como quem volta à conversa
algumas horas depois (nada de "semana passada", "dias atrás" ou "retomando nosso contato").

Etapa 2 — se não houver resposta (cerca de 2 horas depois):
- Volte com naturalidade, sem cobrar resposta.
- Compartilhe UMA observação concreta da análise e o impacto prático para o negócio (ex.: muita gente pesquisa no Google antes de escolher, e sem site esse cliente vai para quem aparece).
- Ainda sem preço. Pergunte se faz sentido mostrar um exemplo de como ficaria para eles.
- WhatsApp: até ~350 caracteres. E-mail: 60 a 100 palavras.

Etapa 3 — último toque (cerca de 2 horas depois da etapa 2):
- Ofereça algo útil e sem compromisso: enviar 2 ou 3 exemplos parecidos com o negócio deles.
- Pode citar uma única vez o serviço principal com "a partir de" e o prazo do catálogo.
- Deixe claro, com gentileza, que é a última mensagem e que tudo bem se não for o momento.
- WhatsApp: até ~400 caracteres. E-mail: 70 a 110 palavras.

Regras gerais:
- Português do Brasil, tom cordial, simples e humano, como alguém da região escrevendo pessoalmente. Frases curtas.
- Não repita a mesma informação entre as etapas; cada uma acrescenta algo novo.
- Nada de urgência falsa, promessas de resultado, caixa alta, excesso de emojis (no máximo 1 por mensagem no WhatsApp) ou jargão técnico.
- E-mail em texto simples, sem markdown; assine apenas na etapa 1 e de forma curta nas seguintes.
- Não escreva rodapé de descadastro; ele é adicionado automaticamente.`;
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

Escreva a sequência.`;
}

/**
 * Gera as 3 etapas (e-mail e WhatsApp) da abordagem gradual para um lead.
 * Retorna `email` e `whatsapp` como listas na ordem das etapas.
 */
export async function gerarSequencia(lead, oportunidades, campanha) {
  const r = await gerarJson({
    system: montarSistema(campanha),
    pedido: montarPedido(lead, oportunidades),
    jsonSchema: SEQUENCIA_JSON_SCHEMA,
    zodSchema: SequenciaSchema,
  });
  const lista = (e) => [e.etapa1, e.etapa2, e.etapa3];
  return { ...r, email: lista(r.email), whatsapp: lista(r.whatsapp) };
}
