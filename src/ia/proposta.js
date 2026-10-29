import { z } from "zod";
import { gerarJson } from "./cliente.js";
import { MARCADOR_LINK } from "../agenda/calendly.js";

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

/** `semValores`: na conversa com a apresentação, os únicos valores e prazos são os dela (não os do catálogo). */
export function contextoEmpresa(campanha, { semValores = false } = {}) {
  const { empresa, servicos } = campanha;
  const { quem, assinatura } = identidade(empresa);
  const pessoa = empresa.responsavel
    ? `Você é ${quem}, escrevendo pessoalmente, em primeira pessoa ("eu"), do seu próprio WhatsApp e e-mail.
Fale sempre como ${empresa.responsavel}: nunca se apresente como assistente, robô, IA, sistema ou "equipe".`
    : `Você escreve em nome de ${quem}.`;
  return `${pessoa} A ${empresa.nome} desenvolve sites, lojas virtuais e sistemas.
Assinatura dos e-mails: ${assinatura}
${empresa.site ? `Site: ${empresa.site}\n` : ""}${empresa.portfolio ? `Portfólio: ${empresa.portfolio}\n` : ""}Diferenciais: ${empresa.diferenciais.join("; ")}

${semValores
    ? `Serviços que a ${empresa.nome} faz (valores, planos e prazos: só os da apresentação):\n${servicos.map((s) => `- ${s.nome}: ${s.descricao}`).join("\n")}`
    : `Catálogo (use apenas estes serviços; valores e prazos são só para você saber, não para citar na prospecção):\n${servicos.map((s) => `- [${s.id}] ${s.nome}: ${s.descricao} A partir de ${s.aPartirDe}, prazo ${s.prazo}.`).join("\n")}`}

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

No WhatsApp as 3 etapas saem no MESMO DIA, com cerca de 2 horas entre elas: escreva como quem volta à conversa
algumas horas depois (nada de "semana passada" ou "dias atrás").
No e-mail cada etapa sai em outro dia (a 2 um dia útil depois da 1, a 3 dois dias úteis depois da 2): escreva como
quem dá sequência ao e-mail anterior, sem citar o dia exato (nada de "ontem" ou "semana passada").

Etapa 2 — se não houver resposta (WhatsApp: ~2 horas depois; e-mail: 1 dia útil depois):
- Volte com naturalidade, sem cobrar resposta.
- Compartilhe UMA observação concreta da análise e o impacto prático para o negócio (ex.: muita gente pesquisa no Google antes de escolher, e sem site esse cliente vai para quem aparece).
- Ainda sem preço. Pergunte se faz sentido mostrar um exemplo de como ficaria para eles.
- WhatsApp: até ~350 caracteres. E-mail: 60 a 100 palavras.

Etapa 3 — último toque (WhatsApp: ~2 horas depois da etapa 2; e-mail: 2 dias úteis depois da etapa 2):
- Convide para um bate-papo rápido de 15 minutos, sem compromisso, para mostrar exemplos parecidos com o negócio deles
  e entender o que precisam.
- Coloque o marcador ${MARCADOR_LINK} SOZINHO na última linha: ele vira o link para a pessoa escolher o horário.
  Escreva o convite de modo que faça sentido mesmo se essa linha for removida.
- Deixe claro, com gentileza, que é a última mensagem e que tudo bem se não for o momento.
- WhatsApp: até ~350 caracteres além do link. E-mail: 60 a 100 palavras além do link.

Regras gerais:
- PROIBIDO em todas as etapas: preço, "a partir de", valores em R$ e prazo de entrega. Isso fica para o bate-papo.
- Português do Brasil, tom cordial, simples e humano, como alguém da região escrevendo pessoalmente. Frases curtas.
- Não repita a mesma informação entre as etapas; cada uma acrescenta algo novo.
- Nada de urgência falsa, promessas de resultado, caixa alta, excesso de emojis (no máximo 1 por mensagem no WhatsApp) ou jargão técnico.
- E-mail em texto simples, sem markdown; assine apenas na etapa 1 e de forma curta nas seguintes.
- Não escreva rodapé de descadastro; ele é adicionado automaticamente.`;
}

/** O Instagram da empresa, guardado na análise, numa linha para a IA. */
function linhaDoInstagram(lead) {
  let insta = null;
  try {
    insta = JSON.parse(lead.analise ?? "{}").instagram;
  } catch {}
  if (!insta?.usuario) return "";
  const partes = [insta.seguidores != null && `${insta.seguidores} seguidores`, insta.posts != null && `${insta.posts} posts`].filter(Boolean);
  return `\n- Instagram: @${insta.usuario}${partes.length ? ` (${partes.join(", ")})` : ""}`;
}

function montarPedido(lead, oportunidades) {
  return `Dados da empresa prospectada:
- Nome: ${lead.nome}
- Segmento: ${lead.nicho ?? "não informado"}
- Cidade: ${lead.cidade ?? "não informada"}
- Site: ${lead.site ?? "não possui"}
- Avaliação no Google: ${lead.avaliacao ? `${lead.avaliacao} (${lead.total_avaliacoes} avaliações)` : "sem dados"}${linhaDoInstagram(lead)}

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
