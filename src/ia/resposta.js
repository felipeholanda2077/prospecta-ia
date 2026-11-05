import { z } from "zod";
import { config } from "../config.js";
import { gerarJson } from "./cliente.js";
import { contextoEmpresa, identidade } from "./proposta.js";

/** Data de hoje, para a IA saber se uma promoção (ex.: a de novembro) ainda vai começar, está valendo ou acabou. */
const hoje = () => new Date().toLocaleDateString("pt-BR", { timeZone: config.timezone, day: "numeric", month: "long", year: "numeric" });

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
  robo: z.boolean(),
  encerrar: z.boolean(),
  dor_entendida: z.boolean(),
  pediu_conversa: z.boolean(),
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
    robo: {
      type: "boolean",
      description: "true quando quem responde é um atendimento automático ou outra IA, e não uma pessoa: respostas genéricas " +
        "que não respondem o que você perguntou, sempre agradecendo e se despedindo, \"em que posso ajudar?\" repetido, menus, " +
        "o mesmo texto de novo, ou uma troca de gentilezas que não sai do lugar",
    },
    encerrar: {
      type: "boolean",
      description: "true quando não há nada a responder: a pessoa só agradeceu ou se despediu e você já tinha agradecido " +
        "(responder viraria um vai e volta de obrigados), ou disse que vai repassar e você já agradeceu",
    },
    dor_entendida: {
      type: "boolean",
      description: "true só quando, pela conversa INTEIRA, já está claro o que a empresa precisa e por quê (ex.: \"perde " +
        "cliente porque demora para responder no WhatsApp\", \"não tem site e o estoque não aparece no Google\"); false enquanto ainda é preciso descobrir",
    },
    pediu_conversa: {
      type: "boolean",
      description: "true quando a pessoa pediu ligação, reunião, call, orçamento, valores, ou perguntou como funciona / quais os planos",
    },
    sugestao_resposta: {
      type: "string",
      description: "próxima mensagem da conversa; vazio se robo ou encerrar; em sem_interesse, um agradecimento curto; vazio se for descadastro ou automatica",
    },
  },
  required: ["classificacao", "resumo", "sugestao_resposta", "precisa_humano", "motivo_humano", "indicou_contato", "temperatura", "proximo_passo", "robo", "encerrar", "dor_entendida", "pediu_conversa"],
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
    return { classificacao: "descadastro", resumo: "Pediu para não receber mais mensagens.", sugestao_resposta: "", precisa_humano: false, motivo_humano: "", robo: false, encerrar: false };
  if (AUTOMATICA.test(assunto) || AUTOMATICA.test(texto.slice(0, 300)))
    return { classificacao: "automatica", resumo: "Resposta automática.", sugestao_resposta: "", precisa_humano: false, motivo_humano: "", robo: false, encerrar: false };
  return null;
}

/** Já mandamos alguma mensagem nesta conversa? (Então já cumprimentamos e já nos apresentamos.) */
export const jaConversou = (historico) => (historico ?? []).some((h) => h.autor === "nos");

// "Bom dia!", "Boa tarde, Ana!", "Olá, tudo bem?" no começo da mensagem.
const CUMPRIMENTO_NO_INICIO = /^\s*(bom dia|boa tarde|boa noite|ol[aá])(\s*,?\s*[A-ZÀ-Ú][\wÀ-ú]*)?\s*[!.,]+\s*/i;

/**
 * Tira o cumprimento do começo da mensagem quando a conversa já começou: a IA não diz "Bom dia!" de novo
 * a cada resposta. O resto da mensagem fica como está (com a primeira letra maiúscula).
 */
export function semCumprimentoRepetido(texto, historico) {
  if (!texto || !jaConversou(historico)) return texto;
  const sem = String(texto).replace(CUMPRIMENTO_NO_INICIO, "");
  if (!sem.trim() || sem === texto) return texto;
  return sem.charAt(0).toUpperCase() + sem.slice(1);
}

// A pessoa perguntou de preço? ("quanto custa", "qual o valor", "orçamento", "mensalidade", "quais os planos?"...)
const PERGUNTOU_VALOR = /\b(pre[çc]os?|valor(es)?|custos?|custa|investimento|or[çc]amento|mensalidade|tabela)\b|quanto\s+(custa|cobra|fica|sai|seria|vale|é|e)\b|r\$|\bplanos?\b[^.!\n]*\?/i;

/** Valores só entram na conversa depois que a pessoa pergunta (agora ou antes, na mesma conversa). */
export function pediuValor(texto, historico = []) {
  return [texto, ...(historico ?? []).filter((h) => h.autor === "lead").map((h) => h.texto)]
    .some((t) => PERGUNTOU_VALOR.test(String(t ?? "").replace(/^\[áudio\]\s*/, "")));
}

const TEM_VALOR = /r\$\s*\d|\d+(?:[.,]\d+)?\s*reais\b/i;
const ITEM_DE_LISTA = /^\s*([-•*]|\d+[.)])\s/;

/**
 * Tira os valores de uma mensagem (para quando a pessoa ainda não perguntou): item de lista com valor sai
 * inteiro; num parágrafo, sai só a frase com o valor; um título que ficou sem itens ("Planos:") sai também.
 */
export function semValores(texto) {
  if (!texto || !TEM_VALOR.test(texto)) return texto;
  const linhas = [];
  for (const linha of String(texto).split("\n")) {
    if (!TEM_VALOR.test(linha)) { linhas.push(linha); continue; }
    if (ITEM_DE_LISTA.test(linha)) continue;
    const frases = linha.split(/(?<=[.!?])\s+/).filter((f) => !TEM_VALOR.test(f));
    if (frases.length) linhas.push(frases.join(" "));
  }
  const limpas = linhas.filter((l, i) => {
    if (!/:\s*$/.test(l)) return true;
    const proxima = linhas.slice(i + 1).find((x) => x.trim());
    return Boolean(proxima && ITEM_DE_LISTA.test(proxima));
  });
  return limpas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const FALA_DE_CONVITE = /\b(bate-papo|bate papo|call|reuni[ãa]o)\b|\bmarcar(mos)? (um|uma) (conversa|liga[çc][ãa]o|videochamada)|calendly/i;

/**
 * Ainda descobrindo a dor (e a pessoa não pediu conversa): tira da mensagem as frases que convidam para
 * bate-papo, call ou reunião (e o link de agendamento). Se a mensagem inteira for o convite, ela fica como está.
 */
export function semConviteCedo(texto) {
  if (!texto || !FALA_DE_CONVITE.test(texto)) return texto;
  const linhas = [];
  for (const linha of String(texto).split("\n")) {
    if (!FALA_DE_CONVITE.test(linha)) { linhas.push(linha); continue; }
    const frases = linha.split(/(?<=[.!?])\s+/).filter((f) => !FALA_DE_CONVITE.test(f));
    if (frases.length) linhas.push(frases.join(" "));
  }
  const limpo = linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return limpo || texto;
}

/** Texto da conversa até aqui, para a IA não repetir o que já foi dito. */
export function formatarHistorico(historico) {
  if (!historico?.length) return "(nenhuma mensagem anterior registrada)";
  return historico
    .map((h) => `${h.autor === "nos" ? "NÓS" : "EMPRESA"} (${h.canal}${h.etapa ? `, etapa ${h.etapa}` : ""}): ${h.texto}`)
    .join("\n\n");
}

// Quem chamou por conta própria, e por onde (a IA não trata como resposta a uma prospecção).
const ORIGEM_PROPRIA = {
  whatsapp: " · chamou por conta própria",
  instagram_direct: " · chamou por conta própria no direct do Instagram (pode ser só uma pessoa, não uma empresa)",
  formulario: " · preencheu o formulário do site pedindo contato: é a PRIMEIRA mensagem para a pessoa; cumprimente pelo nome, diga que viu o pedido e responda ao que ela precisa",
};

/** Como formatar a mensagem em cada canal. */
const FORMATO_DO_CANAL = {
  email: "",
  whatsapp: " Negrito no WhatsApp é *assim* (um asterisco), nunca **assim**. Sem assinatura.",
  instagram: " O direct do Instagram não tem negrito: escreva sem asteriscos. Sem assinatura.",
};
const NOME_DO_CANAL = { email: "e-mail", whatsapp: "WhatsApp", instagram: "direct do Instagram" };

/**
 * Classifica a resposta de um lead e sugere o próximo passo da conversa.
 * A sugestão avança aos poucos: responde o que foi perguntado e entrega uma informação nova por vez.
 */
export async function classificarResposta({ texto, assunto, lead, historico, campanha, canal = "email", linkAgendamento = "", apresentacao = "", nota = "" }) {
  const porRegra = classificarPorRegra(String(texto ?? "").replace(/^\[áudio\]\s*/, ""), assunto);
  if (porRegra) return porRegra;
  const podeValores = pediuValor(texto, historico);

  const limite = canal === "email" ? "até 100 palavras, com assinatura curta" : "no máximo 3 frases curtas (até ~400 caracteres), sem assinatura";
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  return gerarJson({
    system: `${contextoEmpresa(campanha, { semValores: Boolean(apresentacao) })}

Você conduz, aos poucos e com naturalidade, uma conversa com uma empresa (de prospecção, ou de alguém que chamou
por conta própria). O objetivo é levar a empresa a marcar um bate-papo${linkAgendamento ? " pelo link de agendamento" : ""}. Classifique a última resposta
e escreva a PRÓXIMA mensagem da conversa.
${apresentacao ? `
Apresentação da ${campanha.empresa.nome} (como funciona, planos e prazos; use só o que está aqui). Hoje é ${hoje()}:
<apresentacao>
${apresentacao}
</apresentacao>
` : ""}
Como conduzir (tom humano, como ${quem} escrevendo do próprio celular, em primeira pessoa):
- Responda primeiro, de forma direta e simpática, o que a empresa perguntou ou comentou. Use o nome da pessoa se ela disse.
- Entregue no máximo UMA informação nova por mensagem; não despeje tudo de uma vez.
- DESCOBERTA ANTES DE TUDO: antes de oferecer qualquer solução ou bate-papo, entenda a dor da empresa, com UMA pergunta
  por mensagem, aprofundando no que ela respondeu: como atendem e vendem hoje, onde perdem cliente ou tempo, quem responde
  as mensagens, o que mais incomoda. O objetivo é descobrir EXATAMENTE o que ela precisa: atendimento mais rápido (IA no
  WhatsApp), presença online (site), vendas online (loja), gestão (sistema), agenda, ou outra coisa. Não presuma: se
  ela disse que já tem algo (ex.: um CRM, um site), pergunte o que ainda falta nele.
${apresentacao ? `- Perguntas sobre como funciona, planos ou prazo: responda com o que está na apresentação.
${podeValores ? `- Valores: a pessoa perguntou; use só os da apresentação, como estão escritos. Orçamento exato, desconto ou
  condição especial: diga que isso vocês fecham no bate-papo, conforme o que ela precisa.` : `- Valores: a pessoa AINDA NÃO perguntou de preço. NÃO cite nenhum valor, preço ou R$, nem "a partir de". Se falar de
  planos, diga só o que cada um faz. Valor só quando ela perguntar.`}
- Se pedir algo que não está na apresentação nem no catálogo, não prometa: diga com sinceridade que vocês veem isso
  juntos no bate-papo.
` : `- Preço: não passe valor de cara. Se perguntarem, diga que depende do que eles precisam e convide para o bate-papo
  rápido, onde você mostra exemplos e passa o valor certo. Só se insistirem depois disso, diga o "a partir de" do catálogo.
`}- Só convide para o bate-papo quando dor_entendida for true (você já sabe exatamente o que ela precisa e por quê) e
  ela mostrar interesse, OU quando ela mesma pedir (ligação, reunião, call, orçamento, "como funciona"). Fora isso, NÃO
  fale de bate-papo, call, reunião nem agenda: continue descobrindo.
- Na hora de convidar: convide para o bate-papo${linkAgendamento
      ? ` e mande exatamente este link para a pessoa escolher o horário: ${linkAgendamento}`
      : " com duas opções de horário em dias úteis"}.
- Se a pessoa já recebeu o link e disse que vai marcar, agradeça em uma frase, sem insistir.
- Nunca repita frases ou informações que já aparecem no histórico. Não invente fatos, prazos ou descontos.
- Se o histórico já tem mensagem sua, NÃO cumprimente de novo (nada de "Bom dia!", "Boa tarde!", "Olá!") e NÃO se
  apresente de novo (seu nome e a empresa já foram ditos): vá direto ao assunto, como numa conversa que continua.
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.
- Se a pessoa perguntar diretamente se está falando com um robô, uma IA ou uma mensagem automática, não responda essa
  pergunta: marque precisa_humano (motivo: "perguntou se é robô") e deixe a sugestão vazia, para o próprio ${quem} responder.
- Se a mensagem veio de um áudio (o texto começa com "[áudio]"), responda ao que a pessoa falou, por texto, normalmente.
- Se a pessoa mandou um contato (cartão de contato, "[contato compartilhado]", ou um e-mail/telefone de outra pessoa ou setor
  para tratar do assunto), agradeça em uma frase curta e diga que vai falar com essa pessoa por lá. Não peça mais nada e não
  marque precisa_humano por isso; a mensagem para o contato indicado é escrita e enviada à parte.
- Resposta curta, solta ou que parece fora de contexto (um número, uma porcentagem, "ok", uma palavra, a mesma mensagem
  repetida) NÃO é motivo para precisa_humano: entenda pela sua última pergunta e pelo histórico (ex.: perguntou se
  marcam pelo telefone ou WhatsApp e veio "98%" = 98% pelo WhatsApp), siga a conversa e avance um passo. Se não der
  mesmo para entender, faça uma pergunta leve, sem parecer que não entendeu nada.
- Nunca pergunte de novo algo que a pessoa já respondeu no histórico.
- Saiba parar: se a pessoa só agradeceu ou se despediu e você já tinha agradecido, ou disse que vai repassar para a
  equipe e você já agradeceu, marque encerrar e deixe a sugestão vazia. Não entre em vai e volta de "obrigado".
- Se quem responde parece um atendimento automático ou outra IA (não responde o que você perguntou, repete
  cumprimentos, "em que posso ajudar?", menus, agradece e se despede toda vez), marque robo e deixe a sugestão vazia.
- Marque precisa_humano só quando: pedirem ligação, negociarem preço ou condições, reclamarem, ou o assunto não tiver
  nada a ver com o seu trabalho (ex.: currículo, cobrança, fornecedor). Mesmo assim escreva uma sugestão curta, em primeira pessoa, para ${quem} revisar. Pedir um serviço que
  não está na lista não é motivo para isso: responda e leve para o bate-papo.
- Tamanho: ${limite}. Português do Brasil, frases curtas, no máximo 1 emoji.
- Sem interesse: a sugestão é um agradecimento curto e cordial (1 ou 2 frases), sem pergunta, sem oferta, sem link,
  deixando a porta aberta (ex.: "Imagina, obrigado pelo retorno! Fico à disposição se precisarem no futuro.").
- Se for descadastro ou resposta automática, deixe a sugestão vazia.`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""}) · canal: ${canal}${ORIGEM_PROPRIA[lead.origem] ?? ""}${lead.status === "fechado" ? " · JÁ É CLIENTE, fechou contrato: não venda nada; marque precisa_humano (motivo: \"cliente com contrato\") e escreva uma sugestão curta para revisar" : ""}

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}

Última resposta da empresa${assunto ? ` (assunto: ${assunto})` : ""}:
${texto}${nota ? `

Observação de ${quem} sobre esta conversa (use para entender; não cite): ${nota}` : ""}`,
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
  const podeValores = pediuValor(texto, historico);
  const r = await gerarJson({
    system: `${contextoEmpresa(campanha, { semValores: true })}

A pessoa demonstrou interesse. Escreva a próxima mensagem da conversa (${NOME_DO_CANAL[canal] ?? "WhatsApp"}), como ${quem}, em primeira pessoa:
1. Uma frase respondendo o que ela disse, pelo primeiro nome se ela disse. ${jaConversou(historico)
      ? "A conversa já começou: NÃO cumprimente (nada de bom dia, boa tarde ou olá) e NÃO se apresente de novo; seu nome e a empresa já foram ditos."
      : "Comece com o cumprimento certo (bom dia, boa tarde...)."}
2. Uma apresentação em tópicos curtos, com quebras de linha, tirada SÓ da apresentação abaixo:
   - como funciona (as etapas, resumidas);
   - ${podeValores
      ? `os planos: SÓ os planos da apresentação, com o nome e os valores exatamente como estão escritos (não invente
     planos, valores ou "a partir de", nem arredonde), uma linha cada, começando pelos que combinam com o que ela precisa;`
      : `os planos que combinam com o que ela precisa: SÓ o nome e para que serve, SEM NENHUM valor, preço ou R$ (ela ainda
     não perguntou de preço); no fim, uma frase dizendo que você passa os valores se ela quiser;`}
   - em quanto tempo fica pronto.
3. Se ela pediu algo que não está na apresentação, uma frase sincera dizendo que isso vocês veem juntos no bate-papo.
4. Feche dizendo que, se ela quiser saber mais, vocês marcam um bate-papo${linkAgendamento
      ? ` e mande exatamente este link para ela escolher o horário: ${linkAgendamento}`
      : " (ofereça duas opções de horário em dias úteis)"}.
Promoção com data (ex.: só em novembro): hoje é ${hoje()}. Se ainda não começou, conte como novidade que vem aí; se
já acabou, não cite.
Até ~1.200 caracteres. Português do Brasil, simples e direto, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? FORMATO_DO_CANAL.whatsapp}
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

const FollowupSchema = z.object({ opcao: z.enum(["retomar", "material"]), mensagem: z.string() });
const FOLLOWUP_JSON_SCHEMA = {
  type: "object",
  properties: {
    opcao: { type: "string", enum: ["retomar", "material"], description: "retomar = retoma de onde pararam; material = oferece o guia gratuito" },
    mensagem: { type: "string", description: "a mensagem de follow-up, pronta para enviar" },
  },
  required: ["opcao", "mensagem"],
  additionalProperties: false,
};

/**
 * Follow-up para quem mostrou interesse e parou de responder há 1 dia: retoma de onde pararam (com o último
 * assunto da conversa) ou oferece um material de graça (o guia em PDF da empresa). `evitar` = a opção do
 * follow-up anterior, para não repetir. Retorna { opcao, mensagem }.
 */
export async function escreverFollowup({ lead, historico, campanha, canal = "whatsapp", numero = 1, evitar = null, apresentacao = "", linkMaterial = "" }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const ultimaDela = [...(historico ?? [])].reverse().find((h) => h.autor === "lead");
  const podeValores = pediuValor(ultimaDela?.texto, historico);
  const r = await gerarJson({
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você é ${quem}. Esta empresa mostrou interesse na conversa, mas não responde há 1 dia ou mais. Escreva um follow-up
(${NOME_DO_CANAL[canal] ?? "WhatsApp"}; é o ${numero}º seguido sem resposta), escolhendo UMA destas opções:
- retomar: continue exatamente de onde a conversa parou, citando o último assunto (o que ela contou, a pergunta que
  ficou sem resposta), de um jeito leve e útil, com UMA pergunta simples no fim.
- material: ofereça de presente um material gratuito: um guia prático em PDF, feito para a ${lead.nome}, com passos
  simples para atrair mais clientes pelo site, pelo Google e pelo WhatsApp. Mande exatamente este link: ${linkMaterial}
  Diga em uma frase por que ele ajuda no que ela contou, e termine com uma pergunta leve.
${evitar ? `O follow-up anterior foi "${evitar}": agora use a OUTRA opção.` : "Escolha a que fizer mais sentido para esta conversa."}
Regras:
- Nada de cobrança ("não sei se viu", "só passando para lembrar", "fico no aguardo"), nada de pressão.
- Não cumprimente com "bom dia/boa tarde" nem se apresente de novo: vocês já conversaram. Um "Oi, [nome]!" leve pode.
- ${podeValores ? "Se citar valores, só os da apresentação, como estão escritos." : "Não cite valores, preços ou R$: ela não perguntou de preço."}
- Não convide para bate-papo, call ou reunião, a menos que ela já tenha pedido isso na conversa.
- Não repita frases que já estão no histórico. Não invente fatos.
- No máximo 3 frases curtas (até ~400 caracteres), Português do Brasil, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? FORMATO_DO_CANAL.whatsapp}
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.
${apresentacao ? `
O que a ${campanha.empresa.nome} faz (para entender; não despeje):
<apresentacao>
${apresentacao}
</apresentacao>` : ""}`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})

Histórico da conversa (mais antigo primeiro):
${formatarHistorico(historico)}`,
    jsonSchema: FOLLOWUP_JSON_SCHEMA,
    zodSchema: FollowupSchema,
    effort: "low",
  });
  return { opcao: r.opcao, mensagem: r.mensagem.trim() };
}

const ReativacaoSchema = z.object({ oferta: z.enum(["guia", "diagnostico"]), assunto: z.string(), mensagem: z.string() });
const REATIVACAO_JSON_SCHEMA = {
  type: "object",
  properties: {
    oferta: { type: "string", enum: ["guia", "diagnostico"], description: "guia = o guia gratuito em PDF; diagnostico = os pontos do site" },
    assunto: { type: "string", description: "assunto do e-mail, curto e pessoal (vazio fora do e-mail)" },
    mensagem: { type: "string", description: "a mensagem pronta para enviar" },
  },
  required: ["oferta", "assunto", "mensagem"],
  additionalProperties: false,
};

/**
 * Reativação de quem recebeu a sequência e não respondeu (30 dias depois): uma mensagem só, diferente da primeira
 * abordagem, que dá algo de valor (o guia gratuito ou um mini diagnóstico do site, com os `pontos` reais da análise)
 * e fala da dor do ramo. Sem venda, sem preço e sem cobrar a falta de resposta. Retorna { oferta, assunto, mensagem }.
 */
export async function escreverReativacao({ lead, canal, campanha, historico = [], dor = "", pontos = [], linkGuia = "" }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const r = await gerarJson({
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você é ${quem}. Há mais de um mês a ${lead.nome} recebeu algumas mensagens suas e não respondeu. Escreva UMA mensagem de
reativação (${NOME_DO_CANAL[canal] ?? canal}), bem diferente da primeira abordagem: em vez de vender, DÊ algo de valor.
Escolha a oferta:
${pontos.length ? `- diagnostico: você olhou o site deles e anotou estes pontos (use SÓ estes, com suas palavras):
${pontos.map((p) => `  • ${p}`).join("\n")}
  Conte 2 ou 3 deles de forma simples, como quem ajuda, e diga que dá para resolver.
` : ""}- guia: um guia prático em PDF, de presente, feito para a ${lead.nome}, com passos simples para atrair mais clientes pelo site,
  pelo Google e pelo WhatsApp. Mande exatamente este link: ${linkGuia}
${pontos.length ? "Prefira o diagnóstico (é mais pessoal) quando os pontos fizerem sentido para o ramo." : "Use o guia."}
Fale da dor mais comum do ramo deles: ${dor}.
Regras:
- Não cobre a falta de resposta ("não sei se viu", "voltando aqui", "só para lembrar") e não repita a primeira mensagem.
- Sem preço, sem planos, sem convite para call. Termine com UMA pergunta leve (ex.: se faz sentido você mandar mais detalhes).
- ${canal === "email" ? "E-mail em texto simples, 60 a 120 palavras, com saudação e assinatura curta; assunto curto, pessoal, sem caixa alta." : "No máximo 4 frases curtas (até ~500 caracteres), sem assinatura; assunto vazio."}
- Português do Brasil, tom humano, no máximo 1 emoji.${FORMATO_DO_CANAL[canal] ?? ""}
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.`,
    pedido: `Empresa: ${lead.nome} (${lead.nicho ?? ""}, ${lead.cidade ?? ""})${lead.site ? ` · site: ${lead.site}` : " · sem site próprio"}

Mensagens que você já mandou (mais antigas primeiro; não repita):
${formatarHistorico(historico)}`,
    jsonSchema: REATIVACAO_JSON_SCHEMA,
    zodSchema: ReativacaoSchema,
    effort: "low",
  });
  return { oferta: r.oferta, assunto: r.assunto.trim(), mensagem: r.mensagem.trim() };
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

const PrimeiroContatoSchema = z.object({ mensagem: z.string() });
const PRIMEIRO_CONTATO_JSON_SCHEMA = {
  type: "object",
  properties: { mensagem: { type: "string", description: "a mensagem de WhatsApp, pronta para enviar" } },
  required: ["mensagem"],
  additionalProperties: false,
};

/**
 * Primeira mensagem para um número que você passou no painel ("Conversar com um número"). Se já houve conversa,
 * retoma de onde parou, sem se apresentar de novo. Puxa a conversa para a dor do contato: sem preço, sem call.
 */
export async function escreverPrimeiroContato({ lead, nome = "", empresa = "", contexto = "", historico = [], campanha }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const jaConversou = historico.length > 0;
  const r = await gerarJson({
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você é ${quem}. ${jaConversou
    ? "Você já conversou com este contato (histórico abaixo). Escreva a PRÓXIMA mensagem de WhatsApp retomando a conversa de onde parou: não se apresente de novo, não cumprimente como se fosse a primeira vez e não repita o que já foi dito."
    : "Escreva a PRIMEIRA mensagem de WhatsApp para este contato, que ainda não conhece você."}
Regras:
- Cumprimente pelo nome da pessoa se souber (nunca use nome de empresa ou de setor como se fosse o nome dela).
${jaConversou ? "" : "- Diga quem você é e o que faz em uma frase simples.\n"}- Use o que você sabe do contato (abaixo). Não invente nada: se não sabe o ramo ou o site da empresa, não diga que viu o site nem cite problemas dela.
- O objetivo é entender a dor do contato: termine com UMA pergunta aberta e fácil de responder sobre como eles atraem ou atendem clientes hoje (ou sobre o ponto do contexto).
- Sem preço, sem planos, sem convite para call ou reunião, sem link.
- No máximo 3 frases curtas (até ~350 caracteres). Português do Brasil, tom humano, primeira pessoa, no máximo 1 emoji.${FORMATO_DO_CANAL.whatsapp}
- Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.`,
    pedido: `Contato: ${nome || "(nome da pessoa não informado)"}${empresa ? ` · empresa: ${empresa}` : ""}${lead?.nicho ? ` · ramo: ${lead.nicho}` : ""}${lead?.cidade ? ` · ${lead.cidade}` : ""}
O que você sabe dele: ${contexto || "nada além do número"}
${jaConversou ? `\nConversa até aqui (mais antigas primeiro):\n${formatarHistorico(historico)}` : ""}`,
    jsonSchema: PRIMEIRO_CONTATO_JSON_SCHEMA,
    zodSchema: PrimeiroContatoSchema,
    effort: "low",
  });
  return r.mensagem.trim();
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

const DirectDoComentarioSchema = z.object({
  responder: z.boolean(),
  resumo: z.string(),
  mensagem: z.string(),
  resposta_publica: z.string(),
});

const DIRECT_DO_COMENTARIO_JSON_SCHEMA = {
  type: "object",
  properties: {
    responder: {
      type: "boolean",
      description: "true se o comentário pede o que o post prometeu no direct (ex.: comentou a palavra da chamada), faz uma pergunta " +
        "sobre o assunto ou os serviços, ou mostra interesse. false para elogio solto, emoji, marcar amigo, spam, propaganda, crítica ou " +
        "comentário sem relação",
    },
    resumo: { type: "string", description: "1 frase com o que a pessoa quer" },
    mensagem: { type: "string", description: "a mensagem privada para o direct da pessoa; vazia se responder for false" },
    resposta_publica: { type: "string", description: "resposta curta embaixo do comentário, até 10 palavras (ex.: avisando que mandou no direct); vazia se responder for false" },
  },
  required: ["responder", "resumo", "mensagem", "resposta_publica"],
  additionalProperties: false,
};

/**
 * Alguém comentou num post do Instagram. Decide se vale mandar direct e escreve a mensagem privada
 * (entrega o que o post prometeu, com o conteúdo do próprio post, e puxa conversa) e a resposta pública.
 */
export async function escreverDirectDoComentario({ comentario, usuario, post, campanha }) {
  const quem = campanha.empresa.responsavel || `alguém da ${campanha.empresa.nome}`;
  const c = post?.conteudo;
  const telas = (c?.slides ?? []).map((t, i) => `${i + 1}. [${t.visual ?? "texto"}] ${t.titulo}${t.texto ? ` — ${t.texto}` : ""}`).join("\n");
  const r = await gerarJson({
    system: `${contextoEmpresa(campanha, { semValores: true })}

Você cuida do Instagram da ${campanha.empresa.nome}. Uma pessoa comentou num post. Decida se vale mandar uma mensagem privada
no direct dela e, se valer, escreva essa mensagem e uma resposta pública curta para o comentário.

A mensagem privada, como ${quem}, em primeira pessoa:
- Se o post prometia algo no direct ("comenta X que eu te mando..."), entregue isso AGORA, na própria mensagem, usando só o
  conteúdo do post (ex.: o checklist ou os passos em linhas curtas). Nunca diga que mandou PDF, link, material ou arquivo: não há anexo.
- Se a pessoa perguntou algo, responda de forma direta e simpática.
- Termine com UMA pergunta leve que puxe conversa sobre o negócio dela (ex.: se ela quer que você dê uma olhada no site ou no perfil dela).
- Não use o @ como nome. Sem preço. Nunca mencione assistente, robô, IA, sistema ou "equipe" respondendo por ${quem}.
- Até 600 caracteres, Português do Brasil, frases curtas, no máximo 1 emoji, sem asteriscos (o direct não tem negrito).
A resposta pública: curta e natural, variando (ex.: "Te mandei no direct! 📩", "Acabei de te chamar lá no direct 😉").`,
    pedido: `Post${post ? ` (tema: ${post.tema})` : " (não foi possível identificar qual)"}:
${c ? `Gancho: ${c.gancho}
Telas:
${telas}
Legenda: ${c.legenda}` : "(sem o conteúdo do post)"}

Comentário de @${usuario || "alguém"}:
${comentario}`,
    jsonSchema: DIRECT_DO_COMENTARIO_JSON_SCHEMA,
    zodSchema: DirectDoComentarioSchema,
    effort: "low",
  });
  return { ...r, mensagem: r.mensagem.trim(), resposta_publica: r.resposta_publica.trim() };
}
