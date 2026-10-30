import { z } from "zod";
import { config } from "../config.js";
import { gerarJson } from "./cliente.js";

// Linhas editoriais do perfil da FluxDeck: o assunto do post, em rodízio, para o feed não ficar repetitivo.
export const PILARES = {
  erro: "Erros que fazem empresas perderem clientes no digital (site lento, sem WhatsApp, sem aparecer no Google...)",
  dica: "Uma dica prática que o dono de empresa consegue aplicar hoje mesmo",
  mito: "Mito x verdade sobre sites, sistemas, automação e presença digital",
  teste: "Um teste ou checklist rápido (\"seu site passa nesse teste?\") que faz a pessoa se avaliar",
  tendencia: "Uma tendência (IA, automação no WhatsApp, agendamento online...) explicada de um jeito simples",
  bastidores: "Bastidores de como a FluxDeck pensa e entrega um projeto",
  transformacao: "Antes x depois: o que muda para a empresa quando o digital funciona (sem inventar números)",
  portfolio: "Um projeto do portfólio da FluxDeck: o desafio do cliente e o que foi construído (sem inventar resultados)",
  faq: "Uma das perguntas frequentes dos clientes, respondida de forma simples e honesta",
};

// Estrutura do roteiro: o jeito de contar, em rodízio separado do assunto. A mesma linha editorial
// sai diferente a cada vez (uma lista hoje, um "pare de" amanhã, um POV depois).
export const ESTRUTURAS = {
  lista: "LISTA NUMERADA: \"N sinais/erros/coisas que...\". Uma tela por item, do menos ao mais forte; o último item é o mais surpreendente. Telas dos itens com visual \"lista\".",
  pare_de: "PARE DE: abre com uma ordem forte (\"Pare de ...\"), mostra por que isso custa clientes e o que fazer no lugar. Use \"contraste\" para o errado x certo.",
  pov: "POV: abre com \"POV: você é dono de ... e ...\", conta a situação em cenas curtas e vira o jogo no fim com a solução. Cenas com visual \"texto\" e uma \"impacto\" na virada.",
  pergunta: "PERGUNTA QUE INCOMODA: abre com uma pergunta que a pessoa não sabe responder bem, cria tensão e revela a resposta aos poucos. Use \"pergunta\" na capa ou logo depois.",
  mito_verdade: "MITO x VERDADE: cada tela derruba uma crença comum. Visual \"contraste\": titulo = o mito, texto = a verdade.",
  antes_depois: "ANTES x DEPOIS: telas de contraste mostrando a mesma situação sem e com a solução. Visual \"contraste\": titulo = antes, texto = depois.",
  passo_a_passo: "PASSO A PASSO: como resolver um problema em 3 a 5 passos simples e práticos. Telas dos passos com visual \"lista\".",
  segredo: "O QUE NINGUÉM TE CONTA: uma verdade inesperada sobre o assunto, revelada em partes, com uma tela \"impacto\" na revelação.",
  comparacao: "X vs Y: compara duas escolhas (ex.: só Instagram x site próprio, planilha x sistema). Visual \"contraste\" e um veredito honesto no fim.",
};

// Para quem o post fala: muda o exemplo, a cena e as fotos, e um post não parece o outro.
export const PUBLICOS = {
  clinica: "clínicas e consultórios (dentista, estética, médico): agenda, faltas, confirmação de consulta",
  restaurante: "restaurantes, lanchonetes e delivery: pedidos, cardápio, horário de pico",
  loja: "lojas de roupas e varejo: vitrine, estoque, venda pelo Instagram",
  beleza: "salões de beleza e barbearias: agenda cheia, encaixe, cliente que some",
  oficina: "oficinas mecânicas e autopeças: orçamento, aviso de carro pronto",
  escritorio: "escritórios de advocacia e contabilidade: prazos, documentos, atendimento",
  imobiliaria: "imobiliárias e corretores: visitas, leads, fotos de imóveis",
  academia: "academias e estúdios: matrícula, frequência, renovação",
  petshop: "pet shops e clínicas veterinárias: banho e tosa, vacina, retorno",
  escola: "escolas e cursos: matrícula, comunicado aos pais, inadimplência",
  construtora: "construtoras e prestadores de serviço: obra, orçamento, cronograma",
  startup: "quem tem uma ideia de app ou sistema e não sabe por onde começar",
};

// O jeito de falar, em rodízio próprio.
export const TONS = {
  provocador: "provocador: contraria o que todo mundo acha, com opinião clara",
  didatico: "didático: ensina como um professor paciente, com um exemplo do dia a dia",
  humor: "bem-humorado: situação engraçada que o dono de empresa reconhece na hora",
  historia: "história curta: começa no meio de uma cena (\"Segunda, 8h. O telefone não para.\") sem inventar cliente real",
  conta: "conta simples: mostra uma conta de cabeça com números hipotéticos, deixando claro que é um exemplo",
  bastidor: "bastidor em primeira pessoa: como eu, Felipe, penso e resolvo isso nos projetos",
  direto: "direto ao ponto: frases curtíssimas, sem rodeio, como um conselho de amigo",
};

export const ELEMENTOS_VISUAIS = ["celular", "navegador", "grafico", "calendario", "estrelas", "notificacao", "nenhum"];

export const FORMATOS = {
  reels: "Reels (vídeo vertical curto com texto animado, trilha e narração por voz)",
  carrossel: "Carrossel de imagens (o formato que mais gera salvamentos e compartilhamentos)",
};

// Como cada tela aparece: o desenho e a animação mudam conforme o tipo.
export const VISUAIS = ["capa", "impacto", "lista", "contraste", "pergunta", "texto", "cta"];
// O clima da trilha do Reels.
export const TRILHAS = ["energica", "tensa", "inspiradora", "groove"];

const PostSchema = z.object({
  tema: z.string(),
  gancho: z.string(),
  trilha: z.enum(TRILHAS),
  slides: z.array(z.object({
    visual: z.enum(VISUAIS), titulo: z.string(), texto: z.string(), destaque: z.string(), fala: z.string(),
    busca_imagem: z.string(), elemento: z.enum(ELEMENTOS_VISUAIS),
  })),
  legenda: z.string(),
  hashtags: z.array(z.string()),
  hashtags_extras: z.array(z.string()),
  audio: z.string(),
});

const POST_JSON_SCHEMA = {
  type: "object",
  properties: {
    tema: { type: "string", description: "o assunto do post em poucas palavras (para não repetir nos próximos dias)" },
    gancho: { type: "string", description: "a frase da capa / primeiro segundo do vídeo: no máximo 8 palavras, que faz parar de rolar o feed" },
    trilha: { type: "string", enum: TRILHAS, description: "clima da trilha do Reels: energica (ritmo, motivação), tensa (erro, alerta, problema), inspiradora (transformação, bastidores), groove (dica leve, leveza)" },
    slides: {
      type: "array",
      description: "de 5 a 7 telas (no Reels, cenas), na ordem. A 1ª é a capa com o gancho; a última é a chamada para a ação",
      items: {
        type: "object",
        properties: {
          visual: { type: "string", enum: VISUAIS, description: "capa (só a 1ª tela), impacto (frase curta e forte, 2 a 5 palavras, letras gigantes), lista (item numerado), contraste (titulo = errado/antes/mito, texto = certo/depois/verdade, sem escrever \"Antes:\" ou \"Mito:\": o rótulo já aparece no cartão), pergunta, texto (frase + explicação), cta (só a última tela). Misture tipos: no máximo 3 telas seguidas do mesmo tipo" },
          titulo: { type: "string", description: "frase grande da tela, no máximo 9 palavras (impacto: até 5)" },
          texto: { type: "string", description: "complemento curto, no máximo 20 palavras (pode ficar vazio na capa e no impacto)" },
          destaque: { type: "string", description: "uma ou duas palavras do título que aparecem coloridas (copiadas exatamente do título)" },
          fala: { type: "string", description: "o que a voz diz nesta cena do Reels: 1 frase falada, natural, que acompanha o que aparece na tela (sem repetir a tela palavra por palavra). Capa e impacto: até 10 palavras; as outras: de 6 a 18. No carrossel: vazio" },
          busca_imagem: { type: "string", description: "em inglês, de 3 a 6 palavras: a foto real que combina com esta tela, descrevendo uma cena concreta com pessoas ou um lugar do público de hoje (ex.: \"dentist talking to patient clinic\", \"busy restaurant kitchen chef\"). Use em pelo menos 3 telas, sempre cenas diferentes; vazio nas outras. Nada de logos, telas de computador genéricas ou texto na imagem" },
          elemento: { type: "string", enum: ELEMENTOS_VISUAIS, description: "ilustração animada na tela, em telas sem foto: celular (conversa), navegador (site), grafico (crescimento), calendario (agenda), estrelas (avaliação), notificacao (avisos). Varie; \"nenhum\" se a tela tem busca_imagem" },
        },
        required: ["visual", "titulo", "texto", "destaque", "fala", "busca_imagem", "elemento"],
        additionalProperties: false,
      },
    },
    legenda: { type: "string", description: "legenda do Instagram, sem as hashtags: gancho forte na 1ª linha (aparece antes do \"mais\"), parágrafos de 1 a 2 linhas, no máximo 3 emojis, e termina com UMA chamada clara" },
    hashtags: { type: "array", description: "as 5 hashtags mais fortes para este post, sem o #", items: { type: "string" } },
    hashtags_extras: { type: "array", description: "mais 10 hashtags relevantes para trocar quando quiser, sem o #", items: { type: "string" } },
    audio: { type: "string", description: "no Reels: estilo de áudio em alta no Instagram que combina, para quem quiser trocar a trilha na mão. No carrossel: vazio" },
  },
  required: ["tema", "gancho", "trilha", "slides", "legenda", "hashtags", "hashtags_extras", "audio"],
  additionalProperties: false,
};

function montarSistema(campanha, base) {
  const { empresa } = campanha;
  return `Você é o social media e roteirista da ${empresa.nome}${empresa.responsavel ? `, empresa de ${empresa.responsavel}` : ""}.
Seus posts param o dedo de quem rola o feed: são diretos, provocam, ensinam algo de verdade e fazem a pessoa salvar,
mandar para alguém e chamar no direct.

Tudo o que você sabe sobre a ${empresa.nome} está na base abaixo, tirada do site dela. Os posts têm que ser sobre esses
serviços, diferenciais, projetos do portfólio, missão e forma de trabalhar. Fatos, números e nomes de clientes: use só os
que estão na base, exatamente como estão.
<base_do_site>
${base}
</base_do_site>

Público: donos de pequenas e médias empresas e empreendedores no Brasil, ocupados, que não entendem de tecnologia.

O gancho (capa e primeiro segundo) decide tudo. Use uma destas armas, variando de um post para o outro:
- dor que a pessoa sente e não sabe nomear ("Seu cliente desiste antes de te chamar");
- contraste ou contradição ("Ter Instagram não é ter presença digital");
- ordem direta ("Pare de responder cliente na mão");
- pergunta que incomoda ("Quanto cliente você perdeu hoje sem saber?");
- número concreto de itens ("3 sinais de que seu site espanta clientes");
- revelação ("O que ninguém te conta sobre site barato").
Proibido gancho morno ("Dicas para sua empresa", "Você sabia?", "Confira").

Roteiro:
- Cada tela traz UMA ideia, com palavras do dia a dia, verbos fortes e frases curtas. Corte o que não for essencial.
- Crie tensão e curiosidade: a pessoa tem que querer ver a próxima tela. Guarde a melhor parte para o fim.
- Fale com "você", com exemplos concretos do dia a dia de uma empresa (WhatsApp lotado, cliente pedindo preço, agenda furada).
- O conteúdo tem valor mesmo para quem nunca contratar a ${empresa.nome}.
- A última tela (visual "cta") convida para agir, variando entre: comentar uma palavra para receber algo no direct
  ("Comenta SITE que eu te mando..."), salvar para não esquecer, mandar para um amigo empresário, chamar no direct.
  Sem cara de anúncio forçado.
- Nunca invente clientes, depoimentos, resultados, estatísticas ou números de pesquisa que não estejam na base. Não cite preços.
- Não use telefone, site ou e-mail no post: a chamada é sempre para o direct, os comentários ou o link na bio.
- Sem emojis nas telas (a legenda pode ter poucos).

Reels: as falas são a narração da voz. Juntas, contam a história em 20 a 35 segundos, com energia de criador de conteúdo,
frases faladas naturais (não leia a tela) e a primeira fala tão forte quanto o gancho.

Hashtags: as de mais alcance no Brasil para o tema, misturando 2 bem amplas (ex.: empreendedorismo, marketingdigital),
2 do nicho do assunto e a da marca (${empresa.nome.toLowerCase().replace(/\W/g, "")}). Sem acentos, sem espaços, sem o #.`;
}

const LinkedinSchema = z.object({
  texto: z.string(),
  titulo_documento: z.string(),
  hashtags: z.array(z.string()),
  cta_titulo: z.string(),
  cta_texto: z.string(),
  cta_destaque: z.string(),
  cta_fala: z.string(),
});

const LINKEDIN_JSON_SCHEMA = {
  type: "object",
  properties: {
    texto: { type: "string", description: "o texto do post no LinkedIn, de 700 a 1.500 caracteres, sem as hashtags e sem link. As 2 primeiras linhas (até 200 caracteres) aparecem antes do \"ver mais\" e têm que fazer o gestor querer abrir. Parágrafos de 1 a 3 linhas com linha em branco entre eles" },
    titulo_documento: { type: "string", description: "título curto do vídeo ou do documento, até 60 caracteres, sem nome de arquivo" },
    hashtags: { type: "array", description: "de 3 a 5 hashtags profissionais do assunto, em português, sem o # (inclua a da marca)", items: { type: "string" } },
    cta_titulo: { type: "string", description: "a frase grande da última tela, no máximo 9 palavras. Convida para comentar a opinião ou a experiência da pessoa, marcar um colega ou falar com a empresa" },
    cta_texto: { type: "string", description: "complemento curto da última tela, no máximo 20 palavras" },
    cta_destaque: { type: "string", description: "uma ou duas palavras copiadas exatamente de cta_titulo, que aparecem coloridas" },
    cta_fala: { type: "string", description: "no vídeo: a frase que a voz diz na última tela, de 6 a 18 palavras. No carrossel: vazio" },
  },
  required: ["texto", "titulo_documento", "hashtags", "cta_titulo", "cta_texto", "cta_destaque", "cta_fala"],
  additionalProperties: false,
};

/**
 * Adapta um post do Instagram para a página da empresa no LinkedIn: o mesmo assunto e o mesmo
 * conteúdo, falando com quem decide. Retorna o texto, as hashtags e a chamada da última tela.
 */
export async function escreverParaLinkedin({ campanha, base, formato, tema, gancho, legenda, telas = [], publico = null }) {
  const { empresa } = campanha;
  const system = `Você cuida da página da ${empresa.nome} no LinkedIn. Sua tarefa é adaptar um post que já saiu no Instagram: o assunto e as ideias são os mesmos, mas quem lê é outro.

Quem está no LinkedIn: donos, sócios, diretores e gestores de pequenas e médias empresas no Brasil. Leem no intervalo entre reuniões e pensam em custo, receita perdida, tempo da equipe, processo e risco. Decidem ou influenciam a compra.

Como escrever:
- A voz é a da empresa, profissional e direta, sem ser engessada: nada de gíria de criador de conteúdo, nem "galera" ou "bora".
- Traga o raciocínio de negócio por trás do post: o que isso custa, o que muda na operação, como decidir. Um exemplo concreto vale mais que um adjetivo.
- No máximo 2 emojis, ou nenhum. Sem listas com símbolos decorativos e sem negrito (o LinkedIn não tem).
- Termine com uma pergunta que um gestor queira responder.
- Nada do que só existe no Instagram: "link na bio", "direct", "salva esse post", "arrasta para o lado", "comenta tal palavra que eu te mando". O sistema acrescenta sozinho o link de contato, então não escreva link, site, telefone nem e-mail.
- Nunca invente clientes, depoimentos, resultados, estatísticas ou números de pesquisa. Números hipotéticos, só deixando claro que são um exemplo. Não cite preços.

Tudo o que você sabe sobre a ${empresa.nome}:
<base_do_site>
${base}
</base_do_site>`;
  const pedido = `Formato: ${formato === "reels" ? "vídeo vertical curto (o texto acompanha o vídeo)" : "carrossel em documento, de passar as páginas (o texto convida a passar)"}
Assunto: ${tema}
${publico ? `Tipo de negócio de que o post fala: ${PUBLICOS[publico] ?? publico}\n` : ""}Gancho no Instagram: ${gancho}
Telas do post:
${telas.map((t, i) => `${i + 1}. ${t.titulo}${t.texto ? ` | ${t.texto}` : ""}`).join("\n")}

Legenda no Instagram:
${legenda}

Adapte para o LinkedIn.`;
  const r = await gerarJson({ system, pedido, jsonSchema: LINKEDIN_JSON_SCHEMA, zodSchema: LinkedinSchema, modelo: config.conteudo.model });
  const hashtags = [...new Set(r.hashtags.map((t) => String(t).replace(/^#+/, "").replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean))].slice(0, 5);
  return {
    texto: r.texto.trim(), hashtags, tituloDocumento: r.titulo_documento.slice(0, 100),
    cta: { titulo: r.cta_titulo, texto: r.cta_texto, destaque: r.cta_destaque, fala: formato === "reels" ? r.cta_fala : "" },
  };
}

/**
 * Escreve o post: tema, gancho, telas (do carrossel ou cenas do Reels, com a fala de cada uma),
 * clima da trilha, legenda e hashtags. `recentes` são os posts dos últimos dias, para não repetir.
 */
export async function gerarPost({ campanha, formato, pilar, estrutura = "lista", base, recentes = [], aprendizados = null, publico = null, tom = null, comFelipe = false, aviso = "" }) {
  const usados = recentes.map((r) => (typeof r === "string" ? { tema: r } : r));
  const primeiras = [...new Set(usados.slice(0, 12).map((p) => String(p.gancho ?? "").split(/\s+/)[0]).filter(Boolean))];
  // O que os insights do perfil mostraram: o que repetir e o que evitar.
  const doPerfil = aprendizados ? `O que os números do Instagram do perfil mostram (siga isto):
${aprendizados.fazer_mais.map((x) => `- Faça mais: ${x}`).join("\n")}
${aprendizados.evitar.map((x) => `- Evite: ${x}`).join("\n")}
${aprendizados.ganchosQueFuncionaram?.length ? `Ganchos dos posts que mais deram certo (inspire-se no jeito, sem copiar): ${aprendizados.ganchosQueFuncionaram.map((g) => `"${g}"`).join("; ")}\n` : ""}` : "";
  const pedido = `${doPerfil}Formato: ${FORMATOS[formato]}
Assunto de hoje (linha editorial): ${PILARES[pilar]}
Estrutura do roteiro: ${ESTRUTURAS[estrutura] ?? ESTRUTURAS.lista}
${publico ? `Público deste post: ${PUBLICOS[publico] ?? publico}. Os exemplos, as cenas e as fotos são desse tipo de negócio.\n` : ""}${tom ? `Tom deste post: ${TONS[tom] ?? tom}.\n` : ""}${comFelipe ? "Neste Reels o Felipe aparece na tela como apresentador: as falas são dele, em primeira pessoa, como quem conversa com a câmera.\n" : ""}${usados.length ? `Posts dos últimos dias. Este post tem que parecer de outro assunto e de outro jeito: não repita o tema, o jeito do gancho, a chamada final nem as mesmas frases:\n${usados.map((p) => `- ${p.tema}${p.gancho ? ` | gancho: "${p.gancho}"` : ""}`).join("\n")}\n` : ""}${primeiras.length ? `O gancho não pode começar com: ${primeiras.join(", ")}.\n` : ""}${aviso ? `Atenção: ${aviso}\n` : ""}
Crie o post.`;
  const r = await gerarJson({
    system: montarSistema(campanha, base), pedido, jsonSchema: POST_JSON_SCHEMA, zodSchema: PostSchema, modelo: config.conteudo.model,
  });
  const tag = (t) => String(t).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase();
  const unicas = (lista) => [...new Set(lista.map(tag).filter(Boolean))];
  const hashtags = unicas(r.hashtags).slice(0, 5);
  const slides = r.slides.slice(0, 8).map((s, i, todas) => ({
    ...s,
    // A capa e a chamada ficam sempre no começo e no fim, mesmo se a IA trocar.
    visual: i === 0 ? "capa" : i === todas.length - 1 ? "cta" : ["capa", "cta"].includes(s.visual) ? "texto" : s.visual,
    fala: formato === "reels" ? s.fala : "",
    elemento: s.elemento === "nenhum" || s.busca_imagem ? null : s.elemento,
  }));
  return {
    ...r,
    estrutura,
    slides,
    hashtags,
    hashtags_extras: unicas(r.hashtags_extras).filter((t) => !hashtags.includes(t)).slice(0, 12),
    audio: formato === "reels" ? r.audio : "",
    // O texto narrado inteiro, para o painel mostrar (a voz é gerada cena por cena).
    narracao: formato === "reels" ? slides.map((s) => s.fala).filter(Boolean).join(" ") : "",
  };
}
