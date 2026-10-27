import { z } from "zod";
import { gerarJson } from "./cliente.js";

// Linhas editoriais do perfil da FluxDeck. Uma por dia, em rodízio, para o feed não ficar repetitivo.
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

export const FORMATOS = {
  reels: "Reels (vídeo vertical curto, texto animado na tela)",
  carrossel: "Carrossel de imagens (o formato que mais gera salvamentos e compartilhamentos)",
};

const PostSchema = z.object({
  tema: z.string(),
  gancho: z.string(),
  slides: z.array(z.object({ titulo: z.string(), texto: z.string(), destaque: z.string() })),
  legenda: z.string(),
  hashtags: z.array(z.string()),
  hashtags_extras: z.array(z.string()),
  audio: z.string(),
  narracao: z.string(),
});

const POST_JSON_SCHEMA = {
  type: "object",
  properties: {
    tema: { type: "string", description: "o assunto do post em poucas palavras (para não repetir nos próximos dias)" },
    gancho: { type: "string", description: "frase da capa / primeiro segundo do vídeo: no máximo 8 palavras, curiosa, que faz parar de rolar o feed" },
    slides: {
      type: "array",
      description: "de 5 a 7 telas, na ordem. A 1ª é a capa com o gancho; a última é a chamada para a FluxDeck",
      items: {
        type: "object",
        properties: {
          titulo: { type: "string", description: "frase grande da tela, no máximo 9 palavras" },
          texto: { type: "string", description: "complemento curto, no máximo 22 palavras (pode ficar vazio na capa)" },
          destaque: { type: "string", description: "uma palavra ou expressão do título que aparece colorida (copiada exatamente do título)" },
        },
        required: ["titulo", "texto", "destaque"],
        additionalProperties: false,
      },
    },
    legenda: { type: "string", description: "legenda do Instagram, sem as hashtags: gancho na 1ª linha, parágrafos curtos, poucos emojis, termina com uma pergunta ou chamada (comentar, salvar, compartilhar, chamar no direct)" },
    hashtags: { type: "array", description: "as 5 hashtags mais fortes para este post, sem o #", items: { type: "string" } },
    hashtags_extras: { type: "array", description: "mais 10 hashtags relevantes para trocar quando quiser, sem o #", items: { type: "string" } },
    audio: { type: "string", description: "no Reels: o estilo de áudio em alta para escolher no Instagram (ex.: batida motivacional, trend de humor). No carrossel: vazio" },
    narracao: { type: "string", description: "no Reels: texto para narrar com a sua voz, se quiser (até 40 segundos). No carrossel: vazio" },
  },
  required: ["tema", "gancho", "slides", "legenda", "hashtags", "hashtags_extras", "audio", "narracao"],
  additionalProperties: false,
};

function montarSistema(campanha, base) {
  const { empresa } = campanha;
  return `Você é o social media da ${empresa.nome}${empresa.responsavel ? `, empresa de ${empresa.responsavel}` : ""}.

Tudo o que você sabe sobre a ${empresa.nome} está na base abaixo, tirada do site dela. Os posts têm que ser sobre esses
serviços, diferenciais, projetos do portfólio, missão e forma de trabalhar. Fatos, números e nomes de clientes: use só os
que estão na base, exatamente como estão.
<base_do_site>
${base}
</base_do_site>

Você cria posts para o Instagram da ${empresa.nome}, falando com donos de empresas e empreendedores.
Objetivo: alcance orgânico (salvamentos, compartilhamentos, comentários) e gerar conversas no direct.

Regras:
- Português do Brasil, linguagem simples e direta, frases curtas. Nada de jargão técnico sem explicar.
- O gancho tem que fazer a pessoa parar de rolar: curiosidade, dor real, contraste ou número concreto de passos ("3 sinais de que...").
- Cada tela traz uma ideia só. O conteúdo tem que ter valor de verdade, mesmo para quem nunca contratar a ${empresa.nome}.
- A última tela convida para falar com a ${empresa.nome} (chamar no direct ou link na bio), sem parecer anúncio forçado.
- Nunca invente clientes, depoimentos, resultados, estatísticas ou números de pesquisa que não estejam na base. Não cite preços.
- Não use telefone, site ou e-mail no post: a chamada é sempre para o direct ou o link na bio.
- Hashtags: escolha as que têm mais alcance no Brasil para o tema, misturando 2 bem amplas (ex.: empreendedorismo, marketingdigital), 2 do nicho do assunto e a da marca (${empresa.nome.toLowerCase().replace(/\W/g, "")}). Sem acentos, sem espaços, sem o #.`;
}

/**
 * Escreve o post do dia: tema, gancho, telas (do carrossel ou cenas do Reels), legenda e hashtags.
 * `recentes` são os temas dos últimos dias, para não repetir.
 */
export async function gerarPost({ campanha, formato, pilar, base, recentes = [] }) {
  const pedido = `Formato: ${FORMATOS[formato]}
Linha editorial de hoje: ${PILARES[pilar]}
${recentes.length ? `Temas já usados nos últimos dias (não repita nem faça parecido):\n${recentes.map((t) => `- ${t}`).join("\n")}\n` : ""}
Crie o post.`;
  const r = await gerarJson({ system: montarSistema(campanha, base), pedido, jsonSchema: POST_JSON_SCHEMA, zodSchema: PostSchema });
  const tag = (t) => String(t).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase();
  const unicas = (lista) => [...new Set(lista.map(tag).filter(Boolean))];
  const hashtags = unicas(r.hashtags).slice(0, 5);
  return {
    ...r,
    slides: r.slides.slice(0, 8),
    hashtags,
    hashtags_extras: unicas(r.hashtags_extras).filter((t) => !hashtags.includes(t)).slice(0, 12),
    audio: formato === "reels" ? r.audio : "",
    narracao: formato === "reels" ? r.narracao : "",
  };
}
