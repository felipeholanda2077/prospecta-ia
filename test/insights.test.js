import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const insights = await import("../src/conteudo/insights.js");
const diario = await import("../src/conteudo/diario.js");

const AGORA = new Date("2026-11-20T15:00:00Z");
const diasAtras = (d) => new Date(AGORA - d * 86_400_000).toISOString();

test("insights: engajamento pesa salvar e compartilhar, e a nota compara com a média do perfil", () => {
  assert.equal(insights.taxaDeEngajamento({ alcance: 100, curtidas: 10, comentarios: 1, compartilhamentos: 1, salvamentos: 1 }), 0.18);
  assert.equal(insights.taxaDeEngajamento({ alcance: 0, curtidas: 5 }), 0);
  const [bom, medio, ruim, novo] = insights.pontuarPosts([
    { publicado_em: diasAtras(3), metricas: { alcance: 400, curtidas: 40, salvamentos: 10 } },
    { publicado_em: diasAtras(4), metricas: { alcance: 200, curtidas: 10 } },
    { publicado_em: diasAtras(5), metricas: { alcance: 100, curtidas: 2 } },
    { publicado_em: new Date(AGORA - 3600_000).toISOString(), metricas: { alcance: 50, curtidas: 1 } },
  ], AGORA);
  assert.ok(bom.nota > 1.5 && ruim.nota < 0.6);
  assert.equal(medio.nota, 1);
  assert.equal(novo.nota, null); // menos de 24 h no ar: ainda não entra
});

test("insights: o sorteio dá mais chance ao que performa melhor, sem repetir os últimos", () => {
  const notas = { dica: { media: 2.5 }, erro: { media: 0.4 } };
  const opcoes = ["dica", "erro", "mito"];
  // Pesos: dica 2,5 · erro 0,4 · mito 1 (sem dados = média) → total 3,9.
  assert.equal(insights.escolherPorDesempenho(opcoes, notas, { sorteio: 0.5 }), "dica");
  assert.equal(insights.escolherPorDesempenho(opcoes, notas, { sorteio: 0.7 }), "erro");
  assert.equal(insights.escolherPorDesempenho(opcoes, notas, { sorteio: 0.9 }), "mito");
  assert.equal(insights.escolherPorDesempenho(opcoes, notas, { sorteio: 0.1, evitar: ["dica"] }), "erro");
  // Em mil sorteios, o melhor sai bem mais que o pior.
  const vezes = { dica: 0, erro: 0, mito: 0 };
  for (let i = 0; i < 1000; i++) vezes[insights.escolherPorDesempenho(opcoes, notas, { sorteio: i / 1000 })]++;
  assert.ok(vezes.dica > 5 * vezes.erro);
});

/** API do Instagram de mentira: a conta, os posts e os insights de cada um. */
function apiFalsa(midias) {
  const chamadas = [];
  const ler = async (caminho, params) => {
    chamadas.push(caminho);
    if (caminho === "{conta}") return { username: "fluxdeck_", followers_count: 1234, media_count: midias.length };
    if (caminho === "{conta}/media") return { data: midias.map((m) => ({ id: m.id, caption: m.legenda, media_type: m.tipo, media_product_type: m.produto, timestamp: m.quando, permalink: `https://instagram.com/p/${m.id}`, like_count: m.metricas.likes, comments_count: m.metricas.comments })) };
    const id = caminho.split("/")[0];
    const m = midias.find((x) => x.id === id);
    if (params.metric.includes("ig_reels_avg_watch_time") && m.semMetricaDeReels) throw new Error("Instagram: metric not supported");
    return { data: Object.entries(m.metricas).filter(([k]) => params.metric.split(",").includes(k)).map(([name, value]) => ({ name, values: [{ value }] })) };
  };
  return { ler, chamadas };
}

test("insights: lê os posts e os números, liga aos posts do sistema, e a IA aprende e muda o próximo post", async () => {
  await db.gravarConfig("instagram", { token: "EAApagina", host: "graph.facebook.com", igId: "17841", usuario: "fluxdeck_" });
  // 8 posts do sistema: os de "dica" com pergunta vão muito melhor que os de "erro".
  const midias = [];
  for (let i = 0; i < 8; i++) {
    const dica = i % 2 === 0;
    const postId = await db.criarPost({ dia: `2026-11-${String(10 + i).padStart(2, "0")}`, formato: dica ? "carrossel" : "reels", pilar: dica ? "dica" : "erro", tema: `Tema ${i}`,
      conteudo: { gancho: dica ? `Pergunta ${i}?` : `Erro ${i}`, estrutura: dica ? "pergunta" : "lista", trilha: "tensa", slides: [], legenda: "", hashtags: [] } });
    await db.atualizarInstagramDoPost(postId, { instagram_id: `m${i}` });
    midias.push({ id: `m${i}`, legenda: `Legenda ${i}`, tipo: dica ? "CAROUSEL_ALBUM" : "VIDEO", produto: dica ? "FEED" : "REELS", quando: diasAtras(9 - i),
      semMetricaDeReels: i === 1, metricas: dica ? { reach: 500, likes: 50, comments: 6, shares: 8, saved: 20 } : { reach: 200, likes: 6, comments: 0, shares: 0, saved: 1, ig_reels_avg_watch_time: 4000 } });
  }
  // Um post feito fora do sistema também entra (sem assunto e estrutura).
  midias.push({ id: "fora", legenda: "Post manual", tipo: "IMAGE", produto: "FEED", quando: diasAtras(2), metricas: { reach: 300, likes: 20, comments: 2, shares: 1, saved: 3 } });

  const api = apiFalsa(midias);
  const r = await insights.atualizarInsights({ ler: api.ler, agora: AGORA });
  assert.deepEqual([r.insights, r.lidos], ["lidos", 9]);
  // Leu há pouco: só lê de novo depois de 6 h (ou se pedir).
  assert.equal((await insights.atualizarInsights({ ler: api.ler, agora: new Date(+AGORA + 3600_000) })).insights, "lidos há pouco");

  const d = await insights.desempenho({ agora: AGORA });
  assert.equal(d.analisados, 9);
  assert.equal(d.conta.seguidores, 1234);
  assert.ok(d.porPilar.dica.media > 1.5 && d.porPilar.erro.media < 0.6);
  assert.ok(d.porFormato.carrossel.media > d.porFormato.reels.media);
  const reels = d.posts.find((p) => p.midia_id === "m3");
  assert.deepEqual([reels.formato, reels.metricas.tempoMedioMs, reels.post_id != null], ["reels", 4000, true]);
  assert.equal(d.posts.find((p) => p.midia_id === "m1").metricas.alcance, 200); // sem a métrica de Reels, leu o básico
  assert.equal(d.posts.find((p) => p.midia_id === "fora").post_id, null);
  assert.equal(d.melhores[0].pilar, "dica");

  // A IA escreve os aprendizados com os números.
  let pedido = "";
  const escrever = async (o) => ((pedido = o.pedido), { resumo: "Dicas em carrossel vão melhor.", fazer_mais: ["Carrossel com pergunta no gancho"], evitar: ["Reels de lista de erros"] });
  const { aprendizados } = await insights.gerarAprendizados({ escrever, agora: AGORA });
  assert.equal(aprendizados.baseadoEm, 9);
  assert.match(pedido, /Média por assunto: Uma dica prática/);
  assert.match(pedido, /gancho: "Pergunta 0\?"/);

  // O próximo post: assunto, estrutura e formato pelo desempenho, e os aprendizados no pedido.
  let recebido = null;
  const escreverPost = async (o) => ((recebido = o), { tema: "Novo", gancho: "Novo?", trilha: "tensa", slides: [], legenda: "", hashtags: [], hashtags_extras: [], audio: "", estrutura: o.estrutura });
  const sorteios = [0.9, 0.05, 0.05, 0.1]; // não explora; o primeiro de cada sorteio; formato melhor
  await diario.criarPostDeHoje({ empresa: { nome: "FluxDeck" } }, { escrever: escreverPost, agora: AGORA, sorteio: () => sorteios.shift() ?? 0.1 });
  assert.equal(recebido.formato, "carrossel");
  assert.deepEqual(recebido.aprendizados.fazer_mais, ["Carrossel com pergunta no gancho"]);
  assert.ok(recebido.aprendizados.ganchosQueFuncionaram.includes("Pergunta 6?"));
});

test("insights: com poucos posts, a IA ainda não tira conclusões e o rodízio continua", async () => {
  const r = await insights.gerarAprendizados({ escrever: async () => assert.fail("não chama a IA"), agora: new Date("2020-01-01T00:00:00Z") });
  assert.equal(r.aprendizados, null);
  assert.match(r.motivo, /6 posts/);
});
