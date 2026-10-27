import { z } from "zod";
import { gerarJson } from "./cliente.js";
import { contextoEmpresa } from "./proposta.js";

export const CLASSIFICACOES = ["interessado", "quer_informacoes", "sem_interesse", "descadastro", "automatica", "outro"];

const ClassificacaoSchema = z.object({
  classificacao: z.enum(CLASSIFICACOES),
  resumo: z.string(),
  sugestao_resposta: z.string(),
  precisa_humano: z.boolean(),
  motivo_humano: z.string(),
});

const CLASSIFICACAO_JSON_SCHEMA = {
  type: "object",
  properties: {
    classificacao: {
      type: "string",
      enum: CLASSIFICACOES,
      description:
        "interessado = quer conversar/orçamento; quer_informacoes = fez perguntas (preço, prazo, exemplos); " +
        "sem_interesse = recusou educadamente; descadastro = pediu para não ser mais contatado; " +
        "automatica = resposta automática (férias, ausência, recebemos seu e-mail); outro = qualquer outra coisa",
    },
    resumo: { type: "string", description: "1 frase com o que a pessoa disse" },
    precisa_humano: {
      type: "boolean",
      description: "true quando a conversa deve passar para o vendedor: pediu ligação ou para falar com uma pessoa, negociação de preço/condições, reclamação, assunto fora do que você sabe responder",
    },
    motivo_humano: { type: "string", description: "por que precisa do vendedor, em poucas palavras; vazio se não precisa" },
    sugestao_resposta: {
      type: "string",
      description: "próxima mensagem da conversa para o vendedor revisar; vazio se for descadastro, sem_interesse ou automatica",
    },
  },
  required: ["classificacao", "resumo", "sugestao_resposta", "precisa_humano", "motivo_humano"],
  additionalProperties: false,
};

const PEDIDO_SAIR = /^\s*(sair|parar|pare|stop|remover|descadastrar|cancelar)\s*[.!]*\s*$/i;
const NAO_QUERO = /n[aã]o (quero|desejo) (mais )?receber|me (tire|remova|exclua) d[ae]|parem de (me )?(mandar|enviar)/i;
const AUTOMATICA = /resposta autom[aá]tica|mensagem autom[aá]tica|estou (de f[eé]rias|ausente|fora do escrit[oó]rio)|out of office|auto-?reply/i;

/** Remove o histórico citado ("Em ... escreveu:", linhas com ">") e deixa só o que a pessoa escreveu. */
export function limparTextoResposta(texto) {
  const linhas = [];
  for (const linha of String(texto ?? "").split(/\r?\n/)) {
    if (/^\s*(em .+ escreveu:|on .+ wrote:|-{2,}\s*mensagem original|de:\s.+@)/i.test(linha)) break;
    if (/^\s*>/.test(linha)) continue;
    linhas.push(linha);
  }
  return linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Casos óbvios resolvidos sem gastar IA. Retorna null quando precisa da IA. */
export function classificarPorRegra(texto, assunto = "") {
  if (PEDIDO_SAIR.test(texto) || NAO_QUERO.test(texto))
    return { classificacao: "descadastro", resumo: "Pediu para não receber mais mensagens.", sugestao_resposta: "", precisa_humano: false, motivo_humano: "" };
  if (AUTOMATICA.test(assunto) || AUTOMATICA.test(texto.slice(0, 300)))
    return { classificacao: "automatica", resumo: "Resposta automática.", sugestao_resposta: "", precisa_humano: false, motivo_humano: "" };
  return null;
}

/** Texto da conversa até aqui, para a IA não repetir o que já foi dito. */
export function formatarHistorico(historico) {
  if (!historico?.length) return "(nenhuma mensagem anterior registrada)";
  return historico
    .map((h) => `${h.autor === "nos" ? "NÓS" : "EMPRESA"} (${h.canal}${h.etapa ? `, etapa ${h.etapa}` : ""}): ${h.texto}`)
    .join("\n\n");
}

/**
 * Classifica a resposta de um lead e sugere o próximo passo da conversa.
 * A sugestão avança aos poucos: responde o que foi perguntado e entrega uma informação nova por vez.
 */
export async function classificarResposta({ texto, assunto, lead, historico, campanha, canal = "email", linkAgendamento = "" }) {
  const porRegra = classificarPorRegra(String(texto ?? "").replace(/^\[áudio\]\s*/, ""), assunto);
  if (porRegra) return porRegra;

  const limite = canal === "whatsapp" ? "no máximo 3 frases curtas (até ~400 caracteres), sem assinatura" : "até 100 palavras, com assinatura curta";
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  return gerarJson({
    system: `${contextoEmpresa(campanha)}

Você conduz, aos poucos e com naturalidade, uma conversa de prospecção que já começou. O objetivo é levar a
empresa a marcar uma conversa rápida de 15 minutos${linkAgendamento ? " pelo link de agendamento" : ""}. Classifique a última resposta
e escreva a PRÓXIMA mensagem da conversa.

Como conduzir (tom humano, como ${quem} escrevendo do próprio celular, em primeira pessoa):
- Responda primeiro, de forma direta e simpática, o que a empresa perguntou ou comentou. Use o nome da pessoa se ela disse.
- Entregue no máximo UMA informação nova por mensagem; não despeje tudo de uma vez.
- Se ainda não houver interesse claro, faça uma pergunta curta de descoberta (como fazem hoje, o que é prioridade).
- Preço: só quando perguntarem ou quando já houver interesse claro, sempre como "a partir de", e diga o que está incluído.
- Interesse claro ou pedido de mais detalhes: convide para a conversa de 15 minutos${linkAgendamento
      ? ` e mande exatamente este link para a pessoa escolher o horário: ${linkAgendamento}`
      : " com duas opções de horário em dias úteis"}.
- Se a pessoa já recebeu o link e disse que vai marcar, agradeça em uma frase, sem insistir.
- Nunca repita frases ou informações que já aparecem no histórico. Não invente fatos, prazos ou descontos.
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.
- Se a pessoa perguntar diretamente se está falando com um robô, uma IA ou uma mensagem automática, não responda essa
  pergunta: marque precisa_humano (motivo: "perguntou se é robô") e deixe a sugestão vazia, para o próprio ${quem} responder.
- Se a mensagem veio de um áudio (o texto começa com "[áudio]"), responda ao que a pessoa falou, por texto, normalmente.
- Marque precisa_humano quando: pedirem ligação, negociarem preço ou condições, reclamarem, ou o assunto sair do que
  está aqui. Mesmo assim escreva uma sugestão curta, em primeira pessoa, para ${quem} revisar.
- Tamanho: ${limite}. Português do Brasil, frases curtas, no máximo 1 emoji.
- Se for descadastro, sem interesse ou resposta automática, deixe a sugestão vazia.`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""}) · canal: ${canal}

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}

Última resposta da empresa${assunto ? ` (assunto: ${assunto})` : ""}:
${texto}`,
    jsonSchema: CLASSIFICACAO_JSON_SCHEMA,
    zodSchema: ClassificacaoSchema,
    effort: "low",
  });
}
