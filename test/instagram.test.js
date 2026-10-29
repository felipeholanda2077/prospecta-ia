import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.URL_PUBLICA = "https://painel.exemplo.com";
const db = await import("../src/db.js");
const diario = await import("../src/conteudo/diario.js");
const { postarNoInstagram, assinaturaDaMidia, legendaDoPost, MAX_TENTATIVAS } = await import("../src/conteudo/instagram.js");
const { conectarInstagram, statusDaConexao, renovarTokenSePreciso } = await import("../src/envio/instagram.js");

const campanha = { empresa: { nome: "FluxDeck", diferenciais: [] }, servicos: [] };
const conteudo = {
  tema: "Site lento", gancho: "Seu site espanta clientes?", legenda: "Três sinais.\n\nComenta aqui!",
  hashtags: ["empreendedorismo", "fluxdeck"], hashtags_extras: [], audio: "", narracao: "",
  slides: [{ titulo: "Seu site espanta clientes?", texto: "", destaque: "clientes" }, { titulo: "Chama no direct", texto: "", destaque: "" }],
};
const criarPost = async (dia, formato = "carrossel") => db.criarPost({ dia, formato, pilar: "erro", tema: conteudo.tema, conteudo });

/** API do Instagram de mentira: guarda as chamadas e devolve o status pedido. */
function apiFalsa({ status = ["FINISHED"], falhar = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    lerConexao: async () => ({ token: "IGtoken", host: "graph.instagram.com", igId: "17841" }),
    criarContainer: async (conexao, dados) => {
      chamadas.push(["criar", dados]);
      if (falhar) throw new Error(falhar);
      return `container-${chamadas.length}`;
    },
    statusDoContainer: async (conexao, id) => {
      chamadas.push(["status", id]);
      return { codigo: status.length > 1 ? status.shift() : status[0] };
    },
    publicarContainer: async (conexao, id) => {
      chamadas.push(["publicar", id]);
      return { id: "midia-1", link: "https://www.instagram.com/p/abc/" };
    },
  };
}
const arquivosFalsos = async (post) => post.formato === "reels"
  ? [{ chave: `post-${post.id}-reels.mp4`, tipo: "video/mp4", dados: Buffer.from("video") }]
  : [1, 2].map((i) => ({ chave: `post-${post.id}-${i}.jpg`, tipo: "image/jpeg", dados: Buffer.from(`img${i}`) }));

test("instagram: carrossel publicado com as imagens por link assinado e a legenda com hashtags", async () => {
  const id = await criarPost("2026-11-02");
  const api = apiFalsa();
  let guardadas;
  const arquivos = async (post) => {
    const a = await arquivosFalsos(post);
    guardadas = a.map((x) => x.chave);
    return a;
  };
  const r = await postarNoInstagram(id, campanha, { api, arquivos, esperaMs: 0 });
  assert.equal(r.instagram, "postado");
  assert.equal(r.link, "https://www.instagram.com/p/abc/");

  const [, dados] = api.chamadas[0];
  assert.equal(dados.formato, "carrossel");
  assert.equal(dados.urls.length, 2);
  assert.equal(dados.urls[0], `https://painel.exemplo.com/api/midia/post-${id}-1.jpg?a=${assinaturaDaMidia(`post-${id}-1.jpg`)}`);
  assert.equal(dados.legenda, "Três sinais.\n\nComenta aqui!\n\n#empreendedorismo #fluxdeck");

  const post = await db.buscarPost(id);
  assert.equal(post.status, "postado");
  assert.equal(post.instagram_id, "midia-1");
  assert.equal(post.instagram_container, null);
  // Depois de publicado, os arquivos saem do banco.
  assert.equal(await db.lerMidia(guardadas[0]), null);
  // Rodar de novo não publica duas vezes.
  assert.equal((await postarNoInstagram(id, campanha, { api, arquivos, esperaMs: 0 })).instagram, "postado");
  assert.equal(api.chamadas.filter(([c]) => c === "publicar").length, 1);
});

test("instagram: Reels ainda processando continua na próxima rodada sem criar outro vídeo", async () => {
  const id = await criarPost("2026-11-03", "reels");
  const api = apiFalsa({ status: ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"] });
  const primeira = await postarNoInstagram(id, campanha, { api, arquivos: arquivosFalsos, esperaMs: 0, consultas: 2 });
  assert.equal(primeira.instagram, "processando");
  const guardado = await db.buscarPost(id);
  assert.ok(guardado.instagram_container);
  assert.deepEqual((await db.lerMidia(`post-${id}-reels.mp4`)).dados, Buffer.from("video")); // o Instagram ainda vai baixar

  const segunda = await postarNoInstagram(id, campanha, { api, arquivos: arquivosFalsos, esperaMs: 0 });
  assert.equal(segunda.instagram, "postado");
  assert.equal(api.chamadas.filter(([c]) => c === "criar").length, 1);
  assert.deepEqual(api.chamadas.at(-1), ["publicar", guardado.instagram_container]);
});

test("instagram: erro fica no post, conta as tentativas e a rodada desiste depois do limite", async () => {
  await db.gravarConfig("conteudo", { ativo: true, horario: 18, postarSozinho: true });
  const id = await criarPost("2026-11-04");
  const api = apiFalsa({ falhar: "Media download has failed" });
  const r = await postarNoInstagram(id, campanha, { api, arquivos: arquivosFalsos, esperaMs: 0 });
  assert.equal(r.instagram, "erro");
  const post = await db.buscarPost(id);
  assert.match(post.instagram_erro, /download has failed/);
  assert.equal(post.instagram_tentativas, 1);
  assert.equal(post.status, "pronto");

  await db.atualizarInstagramDoPost(id, { instagram_tentativas: MAX_TENTATIVAS });
  await db.gravarConfig("instagram", { token: "IGtoken", host: "graph.instagram.com", igId: "1", renovadoEm: new Date().toISOString() });
  const rodada = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-11-04T21:00:00Z"), postar: () => assert.fail("não tenta de novo") });
  assert.equal(rodada.conteudo, "post de hoje não foi aceito pelo Instagram");
  await db.gravarConfig("instagram", {});
});

test("instagram: a rodada cria o post antes do horário e publica no horário, uma vez por dia", async () => {
  await db.gravarConfig("conteudo", { ativo: true, horario: 18, postarSozinho: true });
  await db.gravarConfig("instagram", { token: "IGtoken", host: "graph.instagram.com", igId: "1", renovadoEm: new Date().toISOString() });
  const escrever = async () => conteudo;
  const postados = [];
  const postar = async (id) => {
    postados.push(id);
    await db.atualizarStatusPost(id, "postado");
    return { instagram: "postado" };
  };
  const criado = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-11-05T20:45:00Z"), escrever, postar }); // 17h45
  assert.equal(criado.conteudo, "criado");
  assert.deepEqual(postados, []);

  const publicado = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-11-05T21:00:00Z"), escrever, postar }); // 18h
  assert.equal(publicado.instagram, "postado");
  assert.deepEqual(postados, [criado.postId]);

  // Um extra criado pelo botão no mesmo dia não vai para o perfil sozinho.
  await diario.criarPostDeHoje(campanha, { agora: new Date("2026-11-05T21:10:00Z"), escrever });
  const depois = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-11-05T21:15:00Z"), escrever, postar });
  assert.equal(depois.conteudo, "post de hoje já publicado");
  assert.equal(postados.length, 1);

  // Com "postar sozinho" desligado, o post só fica pronto.
  await db.gravarConfig("conteudo", { ativo: true, horario: 18, postarSozinho: false });
  await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-11-06T20:45:00Z"), escrever, postar });
  const r = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-11-06T21:00:00Z"), escrever, postar });
  assert.equal(r.conteudo, "post de hoje já criado");
  assert.equal(postados.length, 1);
  await db.gravarConfig("instagram", {});
});

test("instagram: conectar confere o token na Meta e o painel nunca recebe o token", async () => {
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url, opcoes = {}) => {
    pedidos.push({ url: String(url), auth: opcoes.headers?.Authorization });
    if (String(url).includes("refresh_access_token")) return Response.json({ access_token: "IGnovo", expires_in: 5_184_000 });
    return Response.json({ user_id: "17841", username: "fluxdeck" });
  };
  try {
    const r = await conectarInstagram("  IGtoken123 \n");
    assert.deepEqual(r, { conectado: true, usuario: "fluxdeck", expiraEm: null });
    assert.match(pedidos[0].url, /^https:\/\/graph\.instagram\.com\/v\d+\.0\/me\?fields=user_id%2Cusername$/);
    assert.equal(pedidos[0].auth, "Bearer IGtoken123");
    const status = await statusDaConexao();
    assert.equal(status.usuario, "fluxdeck");
    assert.equal(JSON.stringify(status).includes("IGtoken"), false);

    // Renova uma vez por semana.
    assert.equal(await renovarTokenSePreciso(new Date(Date.now() + 3 * 24 * 3600_000)), false);
    assert.equal(await renovarTokenSePreciso(new Date(Date.now() + 8 * 24 * 3600_000)), true);
    assert.equal((await db.lerConfig("instagram")).token, "IGnovo");
  } finally {
    globalThis.fetch = original;
    await db.gravarConfig("instagram", {});
  }
  await assert.rejects(conectarInstagram(""), /Cole o token/);
});

test("instagram: token do login unificado (apps novos da Meta) acha a conta do Instagram direto", async () => {
  const original = globalThis.fetch;
  const pedidos = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    pedidos.push(`${u.host}${u.pathname}?${u.searchParams.get("fields")}`);
    if (u.host !== "graph.facebook.com") return Response.json({ error: { message: "Invalid OAuth access token" } }, { status: 400 });
    if (u.searchParams.get("fields").startsWith("instagram_business_account")) {
      return Response.json({ error: { message: "(#100) Tried accessing nonexisting field (instagram_business_account)" } }, { status: 400 });
    }
    return Response.json({ id: "17841400", username: "fluxdeck", metadata: { type: "instagram_user" } });
  };
  try {
    assert.deepEqual(await conectarInstagram("EAAG token"), { conectado: true, usuario: "fluxdeck", expiraEm: null });
    const salvo = await db.lerConfig("instagram");
    assert.deepEqual([salvo.host, salvo.igId, salvo.token], ["graph.facebook.com", "17841400", "EAAGtoken"]);
    assert.equal(pedidos.length, 3); // e confere a validade do token

    // Token de pessoa sem página ligada: acha a conta pelas permissões guardadas no token.
    pedidos.length = 0;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      pedidos.push(u.pathname);
      if (u.pathname.endsWith("/me/accounts")) return Response.json({ data: [] });
      if (u.pathname.endsWith("/debug_token")) {
        return Response.json({ data: { expires_at: 1798761600, granular_scopes: [{ scope: "business_management" }, { scope: "instagram_content_publish", target_ids: ["17841499"] }] } });
      }
      if (u.pathname.endsWith("/17841499")) return Response.json({ id: "17841499", username: "fluxdeck.oficial", ig_id: 55 });
      return Response.json({ error: { message: "(#12) username field is deprecated" } }, { status: 400 });
    };
    assert.deepEqual(await conectarInstagram("EAApessoa"), { conectado: true, usuario: "fluxdeck.oficial", expiraEm: "2027-01-01T00:00:00.000Z" });
    assert.equal((await db.lerConfig("instagram")).igId, "17841499");

    // Token sem conta nenhuma: explica em vez de conectar.
    globalThis.fetch = async () => Response.json({ error: { message: "Invalid OAuth access token" } }, { status: 400 });
    await assert.rejects(conectarInstagram("EAAerrado"), /Respostas da Meta: como página: Invalid OAuth access token \| como conta do Instagram:/);
  } finally {
    globalThis.fetch = original;
    await db.gravarConfig("instagram", {});
  }
});

test("instagram: legenda respeita o limite de 2.200 caracteres sem perder as hashtags", () => {
  const legenda = legendaDoPost({ conteudo: { ...conteudo, legenda: "a".repeat(5000) } });
  assert.ok(legenda.length <= 2200);
  assert.ok(legenda.endsWith("#empreendedorismo #fluxdeck"));
});
