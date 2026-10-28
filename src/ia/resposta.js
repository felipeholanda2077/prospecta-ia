import { z } from "zod";
import { gerarJson } from "./cliente.js";
import { contextoEmpresa, identidade } from "./proposta.js";

export const CLASSIFICACOES = ["interessado", "quer_informacoes", "sem_interesse", "descadastro", "automatica", "outro"];
export const TEMPERATURAS = ["quente", "morna", "fria"];

const ClassificacaoSchema = z.object({
  classificacao: z.enum(CLASSIFICACOES),
  resumo: z.string(),
  sugestao_resposta: z.string(),
  precisa_humano: z.boolean(),
  motivo_humano: z.string(),
  indicou_contato: z.boolean(),
  temperatura: z.enum(TEMPERATURAS),
  proximo_passo: z.string(),
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
    temperatura: {
      type: "string",
      enum: TEMPERATURAS,
      description: "chance de fechar, olhando a conversa INTEIRA: quente = interesse claro, pediu valores/horário ou vai marcar; " +
        "morna = conversando, respondendo perguntas, sem compromisso ainda; fria = respostas secas, evasivas, desviou ou recusou",
    },
    proximo_passo: { type: "string", description: "o próximo passo para fechar, em até 10 palavras (ex.: \"esperar ela marcar no Calendly\")" },
    indicou_contato: {
      type: "boolean",
      description: "true só quando a pessoa indicou OUTRA pessoa ou setor para tratar do assunto e passou o e-mail ou telefone dela " +
        "(ex.: \"fale com o comercial: x@empresa.com\"). false para assinaturas de e-mail e contatos da própria pessoa",
    },
    sugestao_resposta: {
      type: "string",
      description: "próxima mensagem da conversa; em sem_interesse, um agradecimento curto; vazio se for descadastro ou automatica",
    },
  },
  required: ["classificacao", "resumo", "sugestao_resposta", "precisa_humano", "motivo_humano", "indicou_contato", "temperatura", "proximo_passo"],
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
export async function classificarResposta({ texto, assunto, lead, historico, campanha, canal = "email", linkAgendamento = "", apresentacao = "" }) {
  const porRegra = classificarPorRegra(String(texto ?? "").replace(/^\[áudio\]\s*/, ""), assunto);
  if (porRegra) return porRegra;

  const limite = canal === "whatsapp" ? "no máximo 3 frases curtas (até ~400 caracteres), sem assinatura" : "até 100 palavras, com assinatura curta";
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  return gerarJson({
    system: `${contextoEmpresa(campanha)}

Você conduz, aos poucos e com naturalidade, uma conversa com uma empresa (de prospecção, ou de alguém que chamou
por conta própria). O objetivo é levar a empresa a marcar um bate-papo${linkAgendamento ? " pelo link de agendamento" : ""}. Classifique a última resposta
e escreva a PRÓXIMA mensagem da conversa.
${apresentacao ? `
Apresentação da ${campanha.empresa.nome} (como funciona, planos e prazos; use só o que está aqui):
<apresentacao>
${apresentacao}
</apresentacao>
` : ""}
Como conduzir (tom humano, como ${quem} escrevendo do próprio celular, em primeira pessoa):
- Responda primeiro, de forma direta e simpática, o que a empresa perguntou ou comentou. Use o nome da pessoa se ela disse.
- Entregue no máximo UMA informação nova por mensagem; não despeje tudo de uma vez.
- Se ainda não houver interesse claro, faça uma pergunta curta de descoberta (como fazem hoje, o que é prioridade).
${apresentacao ? `- Perguntas sobre como funciona, planos ou prazo: responda com o que está na apresentação.
- Valores: use só os da apresentação, como estão escritos. Orçamento exato, desconto ou condição especial: diga que
  isso vocês fecham no bate-papo, conforme o que ela precisa.
- Se pedir algo que não está na apresentação nem no catálogo, não prometa: diga com sinceridade que vocês veem isso
  juntos no bate-papo.
` : `- Preço: não passe valor de cara. Se perguntarem, diga que depende do que eles precisam e convide para o bate-papo
  rápido, onde você mostra exemplos e passa o valor certo. Só se insistirem depois disso, diga o "a partir de" do catálogo.
`}- Interesse claro ou pedido de mais detalhes: convide para o bate-papo${linkAgendamento
      ? ` e mande exatamente este link para a pessoa escolher o horário: ${linkAgendamento}`
      : " com duas opções de horário em dias úteis"}.
- Se a pessoa já recebeu o link e disse que vai marcar, agradeça em uma frase, sem insistir.
- Nunca repita frases ou informações que já aparecem no histórico. Não invente fatos, prazos ou descontos.
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.
- Se a pessoa perguntar diretamente se está falando com um robô, uma IA ou uma mensagem automática, não responda essa
  pergunta: marque precisa_humano (motivo: "perguntou se é robô") e deixe a sugestão vazia, para o próprio ${quem} responder.
- Se a mensagem veio de um áudio (o texto começa com "[áudio]"), responda ao que a pessoa falou, por texto, normalmente.
- Se a pessoa mandou um contato (cartão de contato, "[contato compartilhado]", ou um e-mail/telefone de outra pessoa ou setor
  para tratar do assunto), agradeça em uma frase curta e diga que vai falar com essa pessoa por lá. Não peça mais nada e não
  marque precisa_humano por isso; a mensagem para o contato indicado é escrita e enviada à parte.
- Marque precisa_humano quando: pedirem ligação, negociarem preço ou condições, reclamarem, ou o assunto sair do que
  está aqui. Mesmo assim escreva uma sugestão curta, em primeira pessoa, para ${quem} revisar. Pedir um serviço que
  não está na lista não é motivo para isso: responda e leve para o bate-papo.
- Tamanho: ${limite}. Português do Brasil, frases curtas, no máximo 1 emoji.
- Sem interesse: a sugestão é um agradecimento curto e cordial (1 ou 2 frases), sem pergunta, sem oferta, sem link,
  deixando a porta aberta (ex.: "Imagina, obrigado pelo retorno! Fico à disposição se precisarem no futuro.").
- Se for descadastro ou resposta automática, deixe a sugestão vazia.`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""}) · canal: ${canal}${lead.origem === "whatsapp" ? " · chamou por conta própria" : ""}

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}

Última resposta da empresa${assunto ? ` (assunto: ${assunto})` : ""}:
${texto}`,
    jsonSchema: CLASSIFICACAO_JSON_SCHEMA,
    zodSchema: ClassificacaoSchema,
    effort: "low",
  });
}

const ApresentacaoSchema = z.object({ mensagem: z.string() });
const APRESENTACAO_JSON_SCHEMA = {
  type: "object",
  properties: { mensagem: { type: "string", description: "a mensagem completa, pronta para enviar" } },
  required: ["mensagem"],
  additionalProperties: false,
};

/**
 * Primeira resposta a quem demonstrou interesse: como funciona, os planos e o prazo (da apresentação
 * editável no painel) e o convite para o bate-papo, se a pessoa quiser saber mais.
 */
export async function escreverApresentacao({ texto, lead, historico, campanha, canal = "whatsapp", apresentacao, linkAgendamento = "" }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const r = await gerarJson({
    system: `${contextoEmpresa(campanha)}

A pessoa demonstrou interesse. Escreva a próxima mensagem da conversa${canal === "email" ? " (e-mail)" : " (WhatsApp)"}, como ${quem}, em primeira pessoa:
1. Uma frase respondendo o que ela disse, pelo primeiro nome se ela disse, com o cumprimento certo (bom dia, boa tarde...).
2. Uma apresentação em tópicos curtos, com quebras de linha, tirada SÓ da apresentação abaixo:
   - como funciona (as etapas, resumidas);
   - os planos: nome e uma linha de cada um, com os valores exatamente como estão escritos (não invente nem arredonde),
     começando pelos que combinam com o que ela pediu;
   - em quanto tempo fica pronto.
3. Se ela pediu algo que não está na apresentação, uma frase sincera dizendo que isso vocês veem juntos no bate-papo.
4. Feche dizendo que, se ela quiser saber mais, vocês marcam um bate-papo${linkAgendamento
      ? ` e mande exatamente este link para ela escolher o horário: ${linkAgendamento}`
      : " (ofereça duas opções de horário em dias úteis)"}.
Até ~1.100 caracteres. Português do Brasil, simples e direto, no máximo 1 emoji.${canal === "email" ? "" : ` Negrito no WhatsApp é *assim* (um asterisco), nunca **assim**. Sem assinatura.`}
Nunca mencione assistente, robô, IA respondendo, sistema ou "equipe" respondendo por ${quem}. Não repita o que já está no histórico.

<apresentacao>
${apresentacao}
</apresentacao>`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}

Última mensagem da pessoa:
${texto}`,
    jsonSchema: APRESENTACAO_JSON_SCHEMA,
    zodSchema: ApresentacaoSchema,
    effort: "low",
  });
  return r.mensagem.trim();
}

const IndicadoSchema = z.object({ assunto: z.string(), mensagem: z.string() });
const INDICADO_JSON_SCHEMA = {
  type: "object",
  properties: {
    assunto: { type: "string", description: "assunto do e-mail, curto e pessoal (vazio no WhatsApp)" },
    mensagem: { type: "string", description: "primeira mensagem para o contato indicado" },
  },
  required: ["assunto", "mensagem"],
  additionalProperties: false,
};

/**
 * Primeira mensagem para quem foi indicado pela empresa prospectada (ex.: "fale com o
 * comercial, responsável Celso"). Cita a indicação e puxa conversa, sem preço.
 * Retorna { assunto, mensagem } (assunto só no e-mail).
 */
export async function mensagemParaIndicado({ lead, contato, canal = "whatsapp", nomeDeQuemIndicou, textoDaIndicacao = "", historico, campanha }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const formato = canal === "email"
    ? `E-mail em texto simples, 60 a 110 palavras, com saudação, e assinatura curta (${identidade(campanha.empresa).assinatura}).
- Assunto curto e pessoal citando a indicação (ex.: "Indicação da recepção da ${lead.nome}"), sem caixa alta.`
    : "WhatsApp: no máximo 3 frases curtas (até ~350 caracteres), sem assinatura. Assunto vazio.";
  return gerarJson({
    system: `${contextoEmpresa(campanha)}

Você (${quem}) estava conversando com a ${lead.nome} e eles indicaram outra pessoa para tratar do assunto.
Escreva a PRIMEIRA mensagem para essa pessoa indicada, por ${canal === "email" ? "e-mail" : "WhatsApp"}:
- Cumprimente pelo nome se souber o nome da pessoa (pela indicação ou pelo contato); não use nomes como "Recepção", "Adm", "Setor".
- Diga quem você é em poucas palavras e quem passou o contato: a pessoa da ${lead.nome} que conversou com você. Use o nome
  dela se ela se apresentou na conversa${nomeDeQuemIndicou ? ` (o nome no WhatsApp é "${nomeDeQuemIndicou}", que pode ser só o nome da empresa)` : ""};
  se não souber, diga "o pessoal da ${lead.nome}".
- Em uma frase, o motivo: o que você conversou e como pode ajudar (use a conversa abaixo, sem repetir tudo).
- Termine com UMA pergunta simples e aberta, ou o convite para um bate-papo rápido. Sem preço, sem prazo, sem link.
- ${formato}
- Tom humano, primeira pessoa, no máximo 1 emoji no WhatsApp e nenhum no e-mail. Não escreva rodapé de descadastro.`,
    pedido: `Contato indicado: ${contato.nome || "(sem nome)"}${contato.empresa ? ` · ${contato.empresa}` : ""} · ${contato.email ?? contato.numero}
${textoDaIndicacao ? `\nMensagem em que a ${lead.nome} fez a indicação:\n${textoDaIndicacao}\n` : ""}
Conversa com a ${lead.nome} até aqui:
${formatarHistorico(historico)}`,
    jsonSchema: INDICADO_JSON_SCHEMA,
    zodSchema: IndicadoSchema,
    effort: "low",
  }).then((r) => ({ assunto: r.assunto.trim(), mensagem: r.mensagem.trim() }));
}

export const TIPOS_DE_CONTATO = ["cliente", "pessoal", "incerto"];

const ContatoNovoSchema = z.object({
  tipo: z.enum(TIPOS_DE_CONTATO),
  lead_id: z.number().int(),
  empresa: z.string(),
  nome_pessoa: z.string(),
  resumo: z.string(),
});

const CONTATO_NOVO_JSON_SCHEMA = {
  type: "object",
  properties: {
    tipo: {
      type: "string",
      enum: TIPOS_DE_CONTATO,
      description: "cliente = quer falar sobre um serviço (site, loja virtual, sistema, app, automação, IA, redes sociais, orçamento) " +
        "ou está respondendo a uma prospecção; pessoal = amigos, família, trabalho, parceiros, fornecedores, clientes atuais " +
        "pedindo suporte, cobranças, promoções; incerto = ainda não dá para saber (só cumprimentos, sem assunto)",
    },
    lead_id: { type: "integer", description: "id da empresa da lista que a pessoa disse ser (pelo nome da empresa); 0 se nenhuma" },
    empresa: { type: "string", description: "nome da empresa da pessoa, se ela disse; vazio se não" },
    nome_pessoa: { type: "string", description: "primeiro nome da pessoa, se ela disse; vazio se não" },
    resumo: { type: "string", description: "1 frase com o que a pessoa quer" },
  },
  required: ["tipo", "lead_id", "empresa", "nome_pessoa", "resumo"],
  additionalProperties: false,
};

/**
 * Alguém que nunca recebeu mensagem nossa escreveu no WhatsApp, que também é o número pessoal.
 * Decide se é um possível cliente (aí a IA conversa) e se é uma das empresas já prospectadas
 * (ex.: a dona da loja escrevendo do celular dela). Na dúvida, fica como "incerto".
 */
export async function avaliarContatoNovo({ mensagens, nomeNoWhatsapp, empresasContatadas = [], campanha }) {
  const { empresa } = campanha;
  return gerarJson({
    system: `Este WhatsApp é de ${empresa.responsavel || "o dono"} da ${empresa.nome}, que faz sites, lojas virtuais, sistemas,
apps e automações com IA. É também o número pessoal dele: amigos, família e parceiros escrevem aqui.
Uma pessoa que não está nos contatos com quem ele já conversou mandou as mensagens abaixo. Decida se é um possível
cliente da ${empresa.nome}. Só marque "cliente" quando a mensagem deixar claro que a pessoa quer falar sobre um
serviço, um orçamento, ou que está respondendo a um contato da ${empresa.nome}. Na dúvida, "incerto".
Se a pessoa disser de qual empresa é, e essa empresa estiver na lista das que a ${empresa.nome} contatou, informe o id.`,
    pedido: `Nome no WhatsApp: ${nomeNoWhatsapp || "(sem nome)"}

Empresas contatadas recentemente:
${empresasContatadas.map((e) => `[${e.id}] ${e.nome}`).join("\n") || "(nenhuma)"}

Mensagens da pessoa (mais antiga primeiro):
${mensagens.join("\n")}`,
    jsonSchema: CONTATO_NOVO_JSON_SCHEMA,
    zodSchema: ContatoNovoSchema,
    effort: "low",
  });
}
