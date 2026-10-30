import { z } from "zod";
import { config } from "../config.js";
import * as db from "../db.js";
import { gerarJson } from "../ia/cliente.js";
import { lerConexao, lerDaApi } from "../envio/instagram.js";
import { PILARES, ESTRUTURAS } from "../ia/conteudo.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Os números de um post mudam bastante nos primeiros dias: os insights são lidos de novo a cada
// 6 horas, para os posts dos últimos 60 dias.
const ATUALIZAR_A_CADA_MS = 6 * 3600_000;
const DIAS_DE_HISTORICO = 60;
// Um post só entra na comparação depois de 24 h no ar (antes disso o alcance ainda está subindo).
const MADURO_MS = 24 * 3600_000;
// Com menos posts que isso a IA ainda não tira conclusões (seriam por acaso).
export const MINIMO_PARA_APRENDER = 6;

const METRICAS = {
  reels: ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time"],
  feed: ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"],
};
// Se a conta ou a versão da API não tiver alguma métrica, tenta só o básico.
const METRICAS_BASICAS = ["reach", "likes", "comments", "shares", "saved"];
const NOMES = { reach: "alcance", views: "visualizacoes", likes: "curtidas", comments: "comentarios", shares: "compartilhamentos",
  saved: "salvamentos", total_interactions: "interacoes", ig_reels_avg_watch_time: "tempoMedioMs" };

const formatoDaMidia = (m) => (m.media_product_type === "REELS" ? "reels" : m.media_type === "CAROUSEL_ALBUM" ? "carrossel" : "imagem");

async function insightsDaMidia(m, ler) {
  const tipo = formatoDaMidia(m) === "reels" ? "reels" : "feed";
  let r = await ler(`${m.id}/insights`, { metric: METRICAS[tipo].join(",") }).catch(() => null);
  r ??= await ler(`${m.id}/insights`, { metric: METRICAS_BASICAS.join(",") });
  const valores = {};
  for (const item of r.data ?? []) {
    const valor = item.total_value?.value ?? item.values?.[0]?.value;
    if (typeof valor === "number" && NOMES[item.name]) valores[NOMES[item.name]] = valor;
  }
  // Curtidas e comentários também vêm na própria mídia (para quando o insight não trouxer).
  valores.curtidas ??= m.like_count ?? 0;
  valores.comentarios ??= m.comments_count ?? 0;
  return valores;
}

/**
 * Lê no Instagram os posts recentes do perfil e os insights de cada um, e guarda. Com `forcar`,
 * lê mesmo que a última leitura tenha sido há pouco. Retorna quantos posts foram lidos.
 */
export async function atualizarInsights({ forcar = false, ler = lerDaApi, agora = new Date() } = {}) {
  if (!(await lerConexao())?.token) return { insights: "instagram desconectado" };
  const ultima = Number((await db.lerEstado("insights_lidos_em")) ?? 0);
  if (!forcar && agora - ultima < ATUALIZAR_A_CADA_MS) return { insights: "lidos há pouco" };
  if (!(await db.travar("lendo_insights", 5 * 60_000))) return { insights: "leitura em andamento" };
  try {
    const conta = await ler("{conta}", { fields: "followers_count,media_count,username" });
    const { data: midias = [] } = await ler("{conta}/media", {
      fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count", limit: 40,
    });
    const doSistema = await db.postsPublicados();
    const desde = agora - DIAS_DE_HISTORICO * 86_400_000;
    let lidos = 0;
    const falhas = [];
    for (const m of midias.filter((x) => new Date(x.timestamp) >= desde)) {
      try {
        await db.gravarMetricas({
          midia_id: String(m.id), post_id: doSistema.get(String(m.id)) ?? null, formato: formatoDaMidia(m),
          legenda: String(m.caption ?? "").slice(0, 600), link: m.permalink ?? null, publicado_em: m.timestamp,
          metricas: await insightsDaMidia(m, ler),
        });
        lidos++;
      } catch (e) {
        falhas.push(e.message.replace(/^Instagram: /, ""));
      }
    }
    // Seguidores dia a dia, para mostrar o crescimento.
    const dia = agora.toLocaleDateString("en-CA", { timeZone: config.timezone });
    const historico = ((await db.lerConfig("instagram_seguidores")) ?? []).filter((h) => h.dia !== dia);
    await db.gravarConfig("instagram_seguidores", [...historico, { dia, seguidores: conta.followers_count ?? null }].slice(-90));
    await db.gravarConfig("instagram_conta", { usuario: conta.username, seguidores: conta.followers_count ?? null, posts: conta.media_count ?? null });
    await db.gravarEstado("insights_lidos_em", String(agora.getTime()));
    if (!lidos && falhas.length) throw new Error(`o Instagram não liberou os insights: ${falhas[0]}`);
    log(`📊 Insights do Instagram: ${lidos} posts lidos${falhas.length ? ` (${falhas.length} sem insights: ${falhas[0]})` : ""}`);
    return { insights: "lidos", lidos, falhas: falhas.length };
  } finally {
    await db.destravar("lendo_insights");
  }
}

const mediana = (valores) => {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

/**
 * Engajamento de um post: quanto das pessoas alcançadas interagiu, com peso maior para o que mais
 * pesa no Instagram (salvar e compartilhar mostram que o conteúdo teve valor; comentar, que puxou conversa).
 */
export function taxaDeEngajamento(m) {
  const alcance = m.alcance || m.visualizacoes || 0;
  if (!alcance) return 0;
  return ((m.curtidas ?? 0) + 2 * (m.comentarios ?? 0) + 3 * (m.compartilhamentos ?? 0) + 3 * (m.salvamentos ?? 0)) / alcance;
}

/**
 * Nota de cada post comparada à média do próprio perfil (1 = na média; 2 = o dobro): 60% engajamento
 * e 40% alcance. Só os posts com mais de 24 h entram na média.
 */
export function pontuarPosts(lista, agora = new Date()) {
  const maduros = lista.filter((p) => agora - new Date(p.publicado_em) >= MADURO_MS);
  const medTaxa = mediana(maduros.map((p) => taxaDeEngajamento(p.metricas))) || 1e-9;
  const medAlcance = mediana(maduros.map((p) => p.metricas.alcance ?? 0)) || 1;
  return lista.map((p) => {
    const taxa = taxaDeEngajamento(p.metricas);
    const maduro = agora - new Date(p.publicado_em) >= MADURO_MS;
    const nota = maduro && maduros.length >= 2 ? 0.6 * (taxa / medTaxa) + 0.4 * ((p.metricas.alcance ?? 0) / medAlcance) : null;
    return { ...p, taxa, nota: nota == null ? null : Math.round(nota * 100) / 100, maduro };
  });
}

/** Nota média de cada valor de um atributo (ex.: cada linha editorial), entre os posts do sistema. */
function porAtributo(posts, atributo) {
  const grupos = {};
  for (const p of posts) {
    const valor = atributo(p);
    if (!valor || p.nota == null) continue;
    (grupos[valor] ??= []).push(p.nota);
  }
  return Object.fromEntries(Object.entries(grupos).map(([k, notas]) => [k, { media: Math.round((notas.reduce((a, b) => a + b, 0) / notas.length) * 100) / 100, posts: notas.length }]));
}

/**
 * O desempenho do perfil: os posts com nota, a média por formato, linha editorial, estrutura e trilha
 * (só dos posts criados pelo sistema, que sabem de onde vieram), e os melhores e piores.
 */
export async function desempenho({ agora = new Date() } = {}) {
  const posts = pontuarPosts(await db.listarMetricas(60), agora);
  const comNota = posts.filter((p) => p.nota != null);
  const doSistema = comNota.filter((p) => p.conteudo);
  const ordenados = [...comNota].sort((a, b) => b.nota - a.nota);
  const soma = (campo) => comNota.reduce((t, p) => t + (p.metricas[campo] ?? 0), 0);
  return {
    posts,
    analisados: comNota.length,
    medias: comNota.length ? {
      alcance: Math.round(soma("alcance") / comNota.length),
      curtidas: Math.round(soma("curtidas") / comNota.length),
      comentarios: Math.round((soma("comentarios") / comNota.length) * 10) / 10,
      salvamentos: Math.round((soma("salvamentos") / comNota.length) * 10) / 10,
      compartilhamentos: Math.round((soma("compartilhamentos") / comNota.length) * 10) / 10,
      engajamento: Math.round((comNota.reduce((t, p) => t + p.taxa, 0) / comNota.length) * 1000) / 10,
    } : null,
    porFormato: porAtributo(comNota, (p) => p.formato),
    porPilar: porAtributo(doSistema, (p) => p.pilar),
    porEstrutura: porAtributo(doSistema, (p) => p.conteudo?.estrutura),
    porTrilha: porAtributo(doSistema.filter((p) => p.formato === "reels"), (p) => p.conteudo?.trilha),
    melhores: ordenados.slice(0, 3),
    piores: ordenados.length >= MINIMO_PARA_APRENDER ? ordenados.slice(-3).reverse() : [],
    conta: await db.lerConfig("instagram_conta"),
    seguidores: (await db.lerConfig("instagram_seguidores")) ?? [],
    lidosEm: Number((await db.lerEstado("insights_lidos_em")) ?? 0) || null,
  };
}

/**
 * Sorteia um valor dando mais chance ao que vem performando melhor. Valor sem dados conta como
 * média (1), para continuar sendo testado; nenhum fica com menos de 40% nem mais de 250% da chance
 * normal, e `evitar` (os usados nos últimos posts) fica de fora.
 */
export function escolherPorDesempenho(opcoes, notas, { evitar = [], sorteio = Math.random() } = {}) {
  const candidatas = opcoes.filter((o) => !evitar.includes(o));
  const lista = candidatas.length ? candidatas : opcoes;
  const pesos = lista.map((o) => Math.min(2.5, Math.max(0.4, notas[o]?.media ?? 1)));
  let alvo = sorteio * pesos.reduce((a, b) => a + b, 0);
  for (const [i, o] of lista.entries()) {
    alvo -= pesos[i];
    if (alvo < 0) return o;
  }
  return lista.at(-1);
}

const AprendizadosSchema = z.object({ resumo: z.string(), fazer_mais: z.array(z.string()), evitar: z.array(z.string()) });
const APRENDIZADOS_JSON_SCHEMA = {
  type: "object",
  properties: {
    resumo: { type: "string", description: "2 frases: como o perfil está indo e o principal padrão que os números mostram" },
    fazer_mais: { type: "array", items: { type: "string" }, description: "de 2 a 5 orientações concretas do que repetir (formato, assunto, jeito do gancho, estrutura, chamada)" },
    evitar: { type: "array", items: { type: "string" }, description: "de 1 a 4 orientações concretas do que evitar" },
  },
  required: ["resumo", "fazer_mais", "evitar"],
  additionalProperties: false,
};

const linhaDoPost = (p) => {
  const m = p.metricas;
  const c = p.conteudo;
  return `- nota ${p.nota} · ${p.formato}${p.pilar ? ` · assunto: ${PILARES[p.pilar]?.split(" (")[0] ?? p.pilar}` : ""}${c?.estrutura ? ` · estrutura: ${c.estrutura}` : ""}` +
    `${c?.trilha && p.formato === "reels" ? ` · trilha: ${c.trilha}` : ""}\n  gancho: "${c?.gancho ?? String(p.legenda ?? "").split("\n")[0].slice(0, 120)}"` +
    `\n  alcance ${m.alcance ?? "?"}, curtidas ${m.curtidas ?? 0}, comentários ${m.comentarios ?? 0}, salvamentos ${m.salvamentos ?? "?"}, compartilhamentos ${m.compartilhamentos ?? "?"}` +
    `${m.tempoMedioMs ? `, tempo médio assistido ${Math.round(m.tempoMedioMs / 1000)} s` : ""}`;
};

const listaDeNotas = (grupo, nomes = {}) => Object.entries(grupo).sort((a, b) => b[1].media - a[1].media)
  .map(([k, v]) => `${nomes[k]?.split(":")[0] ?? k}: ${v.media} (${v.posts} posts)`).join("; ") || "(sem dados)";

/**
 * A IA lê os números e escreve o que o perfil deve repetir e o que deve evitar. Fica guardado e vai
 * no pedido de cada post novo. Só com posts suficientes (antes disso seria acaso).
 */
export async function gerarAprendizados({ escrever = gerarJson, agora = new Date() } = {}) {
  const d = await desempenho({ agora });
  if (d.analisados < MINIMO_PARA_APRENDER) {
    return { aprendizados: null, motivo: `a IA começa a aprender com ${MINIMO_PARA_APRENDER} posts com mais de 24 h no ar (agora: ${d.analisados})` };
  }
  const ordenados = d.posts.filter((p) => p.nota != null).sort((a, b) => b.nota - a.nota);
  const r = await escrever({
    system: `Você é o estrategista de conteúdo do Instagram${d.conta?.usuario ? ` @${d.conta.usuario}` : " da empresa"}.
Leia os números dos posts e diga, de forma prática, o que repetir e o que evitar nos próximos posts. A nota de cada
post compara com a média do próprio perfil (1 = na média, 2 = o dobro): 60% engajamento (salvar e compartilhar pesam
mais) e 40% alcance. Baseie-se só nos números; com poucos posts, fale em tendência, não em certeza. Orientações
concretas que um roteirista consegue aplicar (ex.: "ganchos em forma de pergunta que incomoda", "carrossel com
checklist"), nunca genéricas ("faça conteúdo de qualidade").`,
    pedido: `Média por formato: ${listaDeNotas(d.porFormato)}
Média por assunto: ${listaDeNotas(d.porPilar, PILARES)}
Média por estrutura do roteiro: ${listaDeNotas(d.porEstrutura, ESTRUTURAS)}
Média por trilha (Reels): ${listaDeNotas(d.porTrilha)}

Posts do melhor para o pior:
${ordenados.slice(0, 20).map(linhaDoPost).join("\n")}`,
    jsonSchema: APRENDIZADOS_JSON_SCHEMA,
    zodSchema: AprendizadosSchema,
    effort: "low",
  });
  const aprendizados = { ...r, baseadoEm: d.analisados, geradoEm: agora.toISOString() };
  await db.gravarConfig("instagram_aprendizados", aprendizados);
  log(`🧠 Aprendizados do Instagram atualizados (${d.analisados} posts)`);
  return { aprendizados };
}

export const lerAprendizados = () => db.lerConfig("instagram_aprendizados");

/**
 * Rotina do agendador: lê os insights (a cada 6 h) e, uma vez por dia, a IA reescreve os aprendizados.
 */
export async function rotinaDeInsights({ agora = new Date() } = {}) {
  const lidos = await atualizarInsights({ agora });
  if (lidos.insights !== "lidos") return lidos;
  const atual = await lerAprendizados();
  if (atual?.geradoEm && agora - new Date(atual.geradoEm) < 20 * 3600_000) return lidos;
  const r = await gerarAprendizados({ agora }).catch((e) => ({ erro: e.message }));
  return { ...lidos, aprendizados: r.aprendizados ? "atualizados" : r.motivo ?? r.erro };
}
