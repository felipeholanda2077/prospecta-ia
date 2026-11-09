import { z } from "zod";
import { gerarJson } from "./cliente.js";
import { MARCADOR_LINK } from "../agenda/calendly.js";
import { ABORDAGENS, ABORDAGEM_PADRAO } from "./abordagens.js";
import { vendeSemReuniao, linkDosSlides } from "../internacional.js";

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

function montarSistema(campanha, abordagem = ABORDAGEM_PADRAO) {
  if (!ABORDAGENS[abordagem]) abordagem = ABORDAGEM_PADRAO;
  return `${contextoEmpresa(campanha)}

Sua tarefa: escrever uma SEQUÊNCIA de 3 mensagens para iniciar contato com uma empresa que ainda não conhece vocês.
A abordagem é gradual, como uma pessoa de verdade puxando conversa: a informação vai sendo revelada aos poucos.
Cada etapa só é enviada se a anterior não teve resposta; quando a empresa responder, a sequência para.

O objetivo da sequência é elevar o nível de consciência da pessoa sobre uma DOR real da empresa dela: primeiro ela
reconhece a situação ("isso acontece aqui"), depois percebe o que isso custa, depois vê que tem solução e que vocês
entendem do assunto. É isso que gera confiança para ela querer conversar e fechar.
- A dor vem da oportunidade observada na análise e do tipo de negócio (ex.: demora para responder no WhatsApp, cliente
  que pesquisa no Google e não acha a empresa, agenda e pedidos feitos à mão, equipe presa em tarefa repetitiva).
- Fale da dor como algo comum nesse tipo de negócio, que você conhece de perto, nunca como acusação ou defeito da empresa.
- PROIBIDO elogiar ou citar a nota ou a quantidade de avaliações do Google (isso não diz nada para quem lê), e
  PROIBIDO abrir com "vi que vocês..." sobre o perfil ou as avaliações.

Etapa 1 — primeiro contato (curtíssima e leve):
- WhatsApp, abordagem "${ABORDAGENS[abordagem].nome}": ${ABORDAGENS[abordagem].instrucao}
- E-mail: ${ABORDAGENS[ABORDAGEM_PADRAO].instrucao}
- A pessoa precisa entender DE PRIMEIRA quem escreve, o que a empresa faz (meia frase, só o serviço ligado à dor) e por
  que está escrevendo. Frases simples e concretas; nada de pergunta vaga como "isso acontece aí?" sem dizer o que é "isso".
- PROIBIDO na etapa 1: preço, prazo, lista de serviços, link, pedido de reunião, dizer que "falta" algo à empresa.
- WhatsApp: no máximo 3 frases curtas (até ~300 caracteres). E-mail: 40 a 70 palavras.

No WhatsApp as 3 etapas saem no MESMO DIA, com cerca de 2 horas entre elas: escreva como quem volta à conversa
algumas horas depois (nada de "semana passada" ou "dias atrás").
No e-mail cada etapa sai em outro dia (a 2 um dia útil depois da 1, a 3 dois dias úteis depois da 2): escreva como
quem dá sequência ao e-mail anterior, sem citar o dia exato (nada de "ontem" ou "semana passada").

Se os dados trazem o sócio que administra a empresa: use o PRIMEIRO nome dele, com a grafia certa em português (ex.:
JOSE CARLOS DA SILVA → José) e cumprimente pelo nome ("Oi, José, tudo bem?"). Não diga de onde tirou o nome.

Etapa 2 — se não houver resposta (WhatsApp: ~2 horas depois; e-mail: 1 dia útil depois):
- Volte com naturalidade, sem cobrar resposta.
- Aprofunde a MESMA dor: o que ela custa na prática (cliente perdido, tempo da equipe, venda que não volta), ligado a UMA
  observação concreta da análise, sem inventar números.
- Mostre em uma frase que isso tem solução e como empresas parecidas resolvem (ex.: o WhatsApp respondido na hora, a
  qualquer hora, com a equipe entrando só quando precisa), para ela ver que vocês entendem do assunto.
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

// Achada pelo CNPJ: o cadastro não diz se tem site, então a falta de site não é um fato.
const SEM_SITE_CONHECIDO = (lead) => (lead.origem === "cnpj"
  ? "não sabemos (a empresa veio do cadastro do CNPJ, que não informa site). NÃO diga nem dê a entender que ela não tem site; fale do digital de forma geral"
  : "não possui");

/** O anúncio ativo da empresa (achada na Biblioteca de Anúncios da Meta), para a IA citar. */
function linhaDoAnuncio(lead) {
  let a = null;
  try { a = JSON.parse(lead.anuncio ?? "null"); } catch {}
  if (!a) return "";
  const desde = a.desde ? new Date(`${a.desde}T12:00:00Z`).toLocaleDateString("pt-BR", { day: "numeric", month: "long" }) : null;
  if (a.plataforma === "google") {
    return `
- Paga anúncio no Google: aparece patrocinada${a.topo ? " no topo" : ""} quando alguém procura "${a.consulta ?? ""}". Texto do anúncio: "${[...String(a.texto ?? "").toWellFormed()].slice(0, 300).join("")}". O anúncio leva para ${a.link ?? "o site"}.
  Use isto: mostre que viu a empresa no topo do Google (com naturalidade) e ligue a oportunidade ao dinheiro que ela já paga por clique (ex.: quem clica cai numa página lenta, sem botão de WhatsApp, ou numa conversa que demora a ser respondida). Não critique o anúncio em si.`;
  }
  const onde = (a.plataformas ?? []).filter((p) => ["instagram", "facebook"].includes(p)).map((p) => (p === "instagram" ? "Instagram" : "Facebook")).join(" e ") || "Instagram e Facebook";
  const destino = /wa\.me|whatsapp/i.test(a.link ?? "") ? "o WhatsApp da empresa" : /instagram\.com/i.test(a.link ?? "") ? "o perfil do Instagram" : a.link ? `a página ${a.link}` : "não sabemos";
  return `
- Está anunciando agora no ${onde}${desde ? `, desde ${desde}` : ""} (achada na Biblioteca de Anúncios da Meta). Texto do anúncio: "${[...String(a.texto ?? "").toWellFormed()].slice(0, 300).join("")}". O anúncio leva para ${destino}.
  Use isto: abra mostrando que viu o anúncio (com naturalidade, citando algo dele) e ligue a oportunidade ao dinheiro que ela já investe em anúncio (ex.: quem clica cai numa página lenta, sem botão de WhatsApp, ou numa conversa que demora a ser respondida). Não critique o anúncio em si.`;
}

/** As avaliações recentes do Google sem resposta da empresa, para a IA citar. */
function linhaDasAvaliacoes(lead) {
  let a = null;
  try { a = JSON.parse(lead.analise ?? "{}").avaliacoes; } catch {}
  if (!a || !(a.reclamamDeAtendimento >= 1 || (a.recentes && (a.semResposta >= 3 || a.negativasSemResposta >= 1)))) return "";
  return `
- Avaliações no Google: ${a.recentes ? `das ${a.recentes} dos últimos 3 meses, ${a.semResposta} estão sem resposta da empresa${a.negativasSemResposta ? ` (${a.negativasSemResposta} negativas)` : ""}` : "poucas recentes"}.${a.reclamamDeAtendimento ? `
  ${a.reclamamDeAtendimento} ${a.reclamamDeAtendimento === 1 ? "avaliação negativa reclama" : "avaliações negativas reclamam"} de demora ou de não conseguir falar com a empresa: é a dor principal. Fale dela como algo comum em quem está ocupado atendendo, sem citar a avaliação.` : ""}
  Se usar, cite como algo que você notou e que acontece com muita gente ocupada, sem expor nem constranger a empresa e sem citar o texto de nenhuma avaliação.`;
}

/** A vaga aberta da empresa (achada nas vagas do Google), para a IA citar. */
function linhaDaVaga(lead) {
  let v = null;
  try { v = JSON.parse(lead.vaga ?? "null"); } catch {}
  if (!v?.cargo) return "";
  return `
- Está contratando agora: vaga de "${v.cargo}"${v.publicada ? ` (publicada ${v.publicada})` : ""}${v.onde ? `, no ${v.onde}` : ""}. Ela quer ${v.dor}.
  Use isto: mostre que viu a vaga, sem parecer vigilância, e pergunte como está sendo dar conta disso hoje. Ofereça a tecnologia como
  forma de resolver isso (ou de o contratado render mais), sem dizer que ela não precisa contratar ninguém e sem falar mal de contratar.`;
}

// Escritório de contabilidade: a conversa é de parceria de indicação, não de venda para ele.
const PARCERIA_CONTADOR = `ATENÇÃO, ISTO MUDA A ABORDAGEM: este contato é um ESCRITÓRIO DE CONTABILIDADE, e a proposta é de PARCERIA, não de venda para ele.
- O escritório atende empresas que estão abrindo ou se organizando e que muitas vezes precisam de site, sistema ou automação. A ideia:
  ele indica esses clientes para a FluxDeck e recebe uma comissão por cliente que fechar.
- A comissão é de 10% do primeiro pagamento de cada cliente indicado que fechar, mas NÃO cite o percentual nas mensagens da sequência
  (só na conversa, se perguntarem). NÃO ofereça site ou serviço para o próprio escritório.
- Etapa 1: apresente-se em poucas palavras e pergunte se os clientes deles costumam pedir indicação de quem faça site ou sistema.
- Etapas 2 e 3: explique a parceria em 1 ou 2 frases e convide para uma conversa rápida.
- Esta instrução vale acima das outras sobre oportunidades e abordagem.

`;

function montarPedido(lead, oportunidades) {
  return `${lead.origem === "contador" ? PARCERIA_CONTADOR : ""}Dados da empresa prospectada:
- Nome: ${lead.nome}
- Segmento: ${lead.nicho ?? "não informado"}
- Cidade: ${lead.cidade ?? "não informada"}
- Site: ${lead.site ?? SEM_SITE_CONHECIDO(lead)}
- Avaliação no Google (só para você saber; não cite nas mensagens): ${lead.avaliacao ? `${lead.avaliacao} (${lead.total_avaliacoes} avaliações)` : "sem dados"}${linhaDoInstagram(lead)}${linhaDoAnuncio(lead)}${linhaDaVaga(lead)}${linhaDasAvaliacoes(lead)}${lead.responsavel ? `
- Sócio que administra (cadastro do CNPJ, em maiúsculas e sem acento): ${lead.responsavel}` : ""}

Oportunidades encontradas na análise (da mais para a menos relevante):
${oportunidades.map((o) => `- [${o.servico}] ${o.motivo}`).join("\n")}

Escreva a sequência.`;
}

/**
 * Venda sem reunião (fora do Brasil e de Portugal): a última etapa leva os slides de projetos, nunca o link
 * de agendamento (se a IA deixou o marcador, ele vira o link dos slides; se esqueceu o link, ele vai no fim).
 */
export function comSlidesNoLugarDoConvite(texto, lead) {
  if (!vendeSemReuniao(lead)) return texto;
  const slides = linkDosSlides(lead);
  let t = String(texto ?? "").split(MARCADOR_LINK).join(slides);
  if (!t.includes(slides)) t = `${t.trim()}\n${slides}`;
  return t;
}

/**
 * Gera as 3 etapas (e-mail e WhatsApp) da abordagem gradual para um lead.
 * Retorna `email` e `whatsapp` como listas na ordem das etapas.
 */
export async function gerarSequencia(lead, oportunidades, campanha, { abordagem = ABORDAGEM_PADRAO } = {}) {
  const r = await gerarJson({ lead,
    system: montarSistema(campanha, abordagem),
    pedido: montarPedido(lead, oportunidades),
    jsonSchema: SEQUENCIA_JSON_SCHEMA,
    zodSchema: SequenciaSchema,
  });
  const lista = (e) => [e.etapa1, e.etapa2, e.etapa3].map((t, i) => (i === 2 ? comSlidesNoLugarDoConvite(t, lead) : t));
  return { ...r, email: lista(r.email), whatsapp: lista(r.whatsapp) };
}

const DirectSchema = z.object({ servico_principal: z.string(), resumo_interno: z.string(), mensagem: z.string() });
const DIRECT_JSON_SCHEMA = {
  type: "object",
  properties: {
    servico_principal: { type: "string", description: "id do serviço do catálogo mais indicado" },
    resumo_interno: { type: "string", description: "1 frase para o vendedor explicando o ângulo da abordagem" },
    mensagem: { type: "string", description: "o primeiro direct, pronto para colar" },
  },
  required: ["servico_principal", "resumo_interno", "mensagem"],
  additionalProperties: false,
};

/** A bio do perfil, guardada na captura, para a IA citar algo do próprio perfil. */
function bioDoInstagram(lead) {
  try {
    return String(JSON.parse(lead.instagram_dados ?? "{}").bio ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Primeiro direct para uma empresa que só tem o Instagram como contato. Você envia pelo seu
 * Instagram (não existe envio automático para quem nunca falou com a conta); quando a empresa
 * responder, a IA continua a conversa pelo direct.
 */
export async function escreverDirectDeProspeccao(lead, oportunidades, campanha) {
  const bio = bioDoInstagram(lead);
  const r = await gerarJson({ lead,
    system: `${contextoEmpresa(campanha)}

Sua tarefa: escrever o PRIMEIRO direct no Instagram para uma empresa que ainda não conhece vocês. Ele vai ser enviado
pelo perfil da ${campanha.empresa.nome}, por uma pessoa, para o perfil da empresa. Não haverá outra mensagem se ela não responder.
- Cumprimente e cite UMA coisa concreta e positiva do perfil dela (a bio, o tipo de trabalho, o que ela oferece).
- Diga em poucas palavras quem você é.
- Termine com UMA pergunta simples e aberta, ligada à oportunidade observada (ex.: como os clientes costumam agendar hoje).
- PROIBIDO: preço, prazo, lista de serviços, link, pedido de reunião, dizer que "falta" algo à empresa, "vi que vocês não têm site".
- No máximo 3 frases curtas (até ~300 caracteres), tom de quem segue o perfil e puxou conversa, no máximo 1 emoji, sem asteriscos.
- Nada de cara de mensagem em massa: nada de "Olá, tudo bem? Somos uma empresa de...".`,
    pedido: `Perfil prospectado:
- Nome: ${lead.nome}
- Instagram: @${lead.instagram}${linhaDoInstagram(lead).replace(/^\n- Instagram: @\S+/, "")}
- Segmento: ${lead.nicho ?? "não informado"}
- Cidade: ${lead.cidade ?? "não informada"}
- Bio: ${bio || "(sem bio)"}
- Site: ${lead.site && !/instagram\.com/.test(lead.site) ? lead.site : SEM_SITE_CONHECIDO(lead)}

Oportunidades encontradas na análise (da mais para a menos relevante):
${oportunidades.map((o) => `- [${o.servico}] ${o.motivo}`).join("\n")}

Escreva o direct.`,
    jsonSchema: DIRECT_JSON_SCHEMA,
    zodSchema: DirectSchema,
  });
  return { ...r, mensagem: r.mensagem.trim() };
}
