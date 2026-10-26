import { z } from "zod";
import { gerarJson } from "./cliente.js";

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
      description: "rascunho de resposta para o vendedor revisar; vazio se for descadastro, sem_interesse ou automatica",
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

/** Classifica a resposta de um lead e sugere um rascunho de retorno para o vendedor. */
export async function classificarResposta({ texto, assunto, lead, mensagemOriginal, campanha }) {
  const porRegra = classificarPorRegra(texto, assunto);
  if (porRegra) return porRegra;

  const { empresa } = campanha;
  return gerarJson({
    system: `Você ajuda o time comercial da ${empresa.nome} (sites, lojas virtuais e sistemas) a tratar respostas de prospecção.
Classifique a resposta recebida e, se fizer sentido, escreva um rascunho de retorno em português do Brasil,
cordial e curto (até 120 palavras), assinado por ${empresa.responsavel}. Responda às perguntas usando apenas
informações do catálogo e da mensagem original; quando não souber algo, proponha uma conversa rápida
em vez de inventar. Telefone para contato: ${empresa.telefone}.

Catálogo:
${campanha.servicos.map((s) => `- ${s.nome}: a partir de ${s.aPartirDe}, prazo ${s.prazo}`).join("\n")}`,
    pedido: `Empresa que respondeu: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})

Mensagem que enviamos:
${mensagemOriginal ? `Assunto: ${mensagemOriginal.assunto ?? ""}\n${mensagemOriginal.corpo}` : "(não encontrada)"}

Resposta recebida${assunto ? ` (assunto: ${assunto})` : ""}:
${texto}`,
    jsonSchema: CLASSIFICACAO_JSON_SCHEMA,
    zodSchema: ClassificacaoSchema,
    effort: "low",
  });
}
