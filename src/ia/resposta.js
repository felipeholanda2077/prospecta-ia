import { z } from "zod";
import { gerarJson } from "./cliente.js";
import { contextoEmpresa } from "./proposta.js";

export const CLASSIFICACOES = ["interessado", "quer_informacoes", "sem_interesse", "descadastro", "automatica", "outro"];

const ClassificacaoSchema = z.object({
  classificacao: z.enum(CLASSIFICACOES),
  resumo: z.string(),
  sugestao_resposta: z.string(),
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
    sugestao_resposta: {
      type: "string",
      description: "próxima mensagem da conversa para o vendedor revisar; vazio se for descadastro, sem_interesse ou automatica",
    },
  },
  required: ["classificacao", "resumo", "sugestao_resposta"],
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
    return { classificacao: "descadastro", resumo: "Pediu para não receber mais mensagens.", sugestao_resposta: "" };
  if (AUTOMATICA.test(assunto) || AUTOMATICA.test(texto.slice(0, 300)))
    return { classificacao: "automatica", resumo: "Resposta automática.", sugestao_resposta: "" };
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
export async function classificarResposta({ texto, assunto, lead, historico, campanha, canal = "email" }) {
  const porRegra = classificarPorRegra(texto, assunto);
  if (porRegra) return porRegra;

  const limite = canal === "whatsapp" ? "no máximo 3 frases curtas (até ~400 caracteres), sem assinatura" : "até 100 palavras, com assinatura curta";
  return gerarJson({
    system: `${contextoEmpresa(campanha)}

Você está conduzindo, aos poucos, uma conversa de prospecção que já começou. Classifique a última resposta da empresa
e escreva a PRÓXIMA mensagem da conversa (sugestão que o vendedor vai revisar antes de enviar).

Como conduzir:
- Responda primeiro, de forma direta, o que a empresa perguntou ou comentou.
- Entregue no máximo UMA informação nova por mensagem; não despeje tudo de uma vez.
- Faça uma pergunta curta de descoberta (como fazem hoje, o que é prioridade, quem decide), exceto se já houver interesse claro.
- Preço: só quando perguntarem ou quando já houver interesse claro, sempre como "a partir de", e explique o que está incluído.
- Interesse claro: proponha uma conversa rápida de 15 minutos com duas opções de horário em dias úteis.
- Nunca repita frases ou informações que já aparecem no histórico. Não invente fatos.
- Tamanho: ${limite}. Português do Brasil, tom humano e cordial.
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
