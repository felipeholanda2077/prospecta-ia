import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.URL_PUBLICA = "https://painel.exemplo.com";
const db = await import("../src/db.js");
const diario = await import("../src/conteudo/diario.js");
const conteudoTt = await import("../src/conteudo/tiktok.js");
const instagram = await import("../src/conteudo/instagram.js");
const tt = await import("../src/envio/tiktok.js");

const { postarNoTiktok, legendaDoTiktok, chaveDoVideo, MAX_TENTATIVAS } = conteudoTt;
const campanha = { empresa: { nome: "FluxDeck", diferenciais: [] }, servicos: [] };
const conteudo = () => ({
  tema: "Site lento", gancho: "Seu site espanta clientes?", legenda: "Três sinais.\n\nComenta SITE!\n\nFotos: Ana (CC BY 4.0).",
  hashtags: ["fluxdeck", "gestao"], hashtags_extras: [], audio: "", narracao: "",
  slides: [{ titulo: "Seu site espanta clientes?", texto: "", destaque: "", visual: "capa", fala: "Seu site espanta clientes?" }],
});
let n = 0;
const criarPost = async (dia, formato = "reels", horario = null) => {
  const id = await db.criarPost({ dia, formato, pilar: "erro", tema: `Site lento ${++n}`, conteudo: conteudo() });
  if (horario != null) await db.definirHorarioDoPost(id, horario);
  return id;
};
const conexaoPronta = (extra = {}) => ({
  clientKey: "k", clientSecret: "s", token: "tok", refreshToken: "r1", expiraEm: new Date(Date.now() + 86_400_000).toISOString(), refreshExpiraEm: new Date(Date.now() + 300 * 86_400_000).toISOString(),
  escopos: "user.info.basic,video.publish", usuario: "fluxdeck", modo: "direto", privacidade: "PUBLIC_TO_EVERYONE", comentarios: true, automatico: true, ...extra,
});

/**
 * Um TikTok de mentira, no lugar do `fetch`, com o formato de resposta da documentação oficial.
 * Guarda tudo o que recebeu. O id do post vai como número sem aspas, como na API de verdade.
 */
function tiktokFalso({ status = ["PUBLISH_COMPLETE"], postId = "7234567890123456789", init = null, opcoes = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], info = {} } = {}) {
  const pedidos = [];
  const json = (corpo, st = 200) => new Response(JSON.stringify(corpo), { status: st, headers: { "Content-Type": "application/json" } });
  const ok = (data) => json({ data, error: { code: "ok", message: "", log_id: "L" } });
  const original = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => {
    const url = String(u);
    const corpo = o.body && typeof o.body === "string" ? JSON.parse(o.body) : o.body;
    pedidos.push({ url, metodo: o.method, corpo, headers: o.headers });
    if (url.endsWith("/oauth/token/")) {
      const grant = corpo.get("grant_type");
      return json({ access_token: grant === "refresh_token" ? "novo" : "tok", expires_in: 86400, refresh_token: grant === "refresh_token" ? "r2" : "r1", refresh_expires_in: 31536000, open_id: "o1", scope: "user.info.basic,video.publish", token_type: "Bearer" });
    }
    if (url.includes("/user/info/")) return ok({ user: { open_id: "o1", display_name: "FluxDeck" } });
    if (url.endsWith("/creator_info/query/")) return ok({ creator_username: "fluxdeck", creator_nickname: "FluxDeck", privacy_level_options: opcoes, comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 600, ...info });
    if (url.endsWith("/post/publish/video/init/") || url.endsWith("/inbox/video/init/")) return init ?? ok({ publish_id: "pub1", upload_url: "https://up.tiktok.exemplo/video?x=1" });
    if (url.startsWith("https://up.tiktok.exemplo/")) return new Response(null, { status: 201 });
    if (url.endsWith("/status/fetch/")) {
      const s = status.length > 1 ? status.shift() : status[0];
      if (s instanceof Error) throw s;
      const fail = typeof s === "object" ? s.motivo : undefined;
      const codigo = typeof s === "object" ? s.codigo : s;
      const id = codigo === "PUBLISH_COMPLETE" && postId ? `[${postId}]` : "[]";
      return new Response(`{"data":{"status":"${codigo}"${fail ? `,"fail_reason":"${fail}"` : ""},"publicaly_available_post_id":${id},"uploaded_bytes":3},"error":{"code":"ok","message":"","log_id":"L"}}`);
    }
    return new Response("{}", { status: 404 });
  };
  return { pedidos, restaurar: () => (globalThis.fetch = original), de: (trecho) => pedidos.filter((p) => p.url.includes(trecho)) };
}
const gerarFalso = (feitos = []) => async (post) => (feitos.push(post), Buffer.from("mp4-gerado"));
const opcoes = (extra = {}) => ({ gerar: gerarFalso(), esperaMs: 0, avisar: async () => {}, ...extra });

test("tiktok: legenda leva o crédito das fotos e as hashtags, sem passar do limite", () => {
  const legenda = legendaDoTiktok({ conteudo: conteudo() });
  assert.match(legenda, /^Três sinais\./);
  assert.match(legenda, /Fotos: Ana/);
  assert.match(legenda, /#fluxdeck #gestao$/);
  assert.ok(legendaDoTiktok({ conteudo: { ...conteudo(), legenda: "x".repeat(5000) } }).length <= tt.MAX_LEGENDA);
});

test("tiktok: publica direto com o que foi escolhido, e o id grande do post não perde dígitos", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  const id = await criarPost("2026-10-01");
  const falso = tiktokFalso({ status: ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"] });
  try {
    const r = await postarNoTiktok(id, campanha, opcoes());
    assert.equal(r.tiktok, "postado");
    assert.equal(r.link, "https://www.tiktok.com/@fluxdeck/video/7234567890123456789");
    const { corpo, headers } = falso.de("/post/publish/video/init/")[0];
    assert.equal(headers.Authorization, "Bearer tok");
    assert.deepEqual(corpo.source_info, { source: "FILE_UPLOAD", video_size: 10, chunk_size: 10, total_chunk_count: 1 });
    assert.equal(corpo.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
    assert.deepEqual([corpo.post_info.disable_comment, corpo.post_info.disable_duet, corpo.post_info.disable_stitch], [false, true, true]);
    assert.deepEqual([corpo.post_info.brand_organic_toggle, corpo.post_info.brand_content_toggle, corpo.post_info.is_aigc], [true, false, true]);
    assert.match(corpo.post_info.title, /#fluxdeck/);
    const envio = falso.de("up.tiktok.exemplo")[0];
    assert.equal(envio.metodo, "PUT");
    assert.equal(envio.headers["Content-Range"], "bytes 0-9/10");
    const salvo = await db.buscarPost(id);
    assert.deepEqual([salvo.tiktok_id, salvo.tiktok_publicacao, salvo.tiktok_erro, salvo.tiktok_privacidade], ["7234567890123456789", null, null, "PUBLIC_TO_EVERYONE"]);
    assert.equal(salvo.instagram_id, null); // nada do Instagram foi tocado
    // Já publicado: não publica de novo.
    assert.equal((await postarNoTiktok(id, campanha, opcoes())).tiktok, "postado");
    assert.equal(falso.de("/post/publish/video/init/").length, 1);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: aproveita o vídeo que o Instagram guardou, sem gerar de novo, e apaga depois que os dois saíram", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  const id = await criarPost("2026-10-02");
  await db.gravarMidia(chaveDoVideo(id), "video/mp4", Buffer.from("mp4-do-instagram"));
  await db.gravarMidia(`post-${id}-capa.jpg`, "image/jpeg", Buffer.from("capa"));
  const api = {
    lerConexao: async () => ({ token: "t" }), criarContainer: async () => "c1", statusDoContainer: async () => ({ codigo: "FINISHED" }),
    publicarContainer: async () => ({ id: "ig1", link: "https://instagram.com/p/1" }),
  };
  // O Instagram publica: a capa sai, o vídeo fica para o TikTok.
  await instagram.postarNoInstagram(id, campanha, { api, arquivos: async () => [{ chave: chaveDoVideo(id), tipo: "video/mp4", dados: Buffer.from("mp4-do-instagram") }, { chave: `post-${id}-capa.jpg`, tipo: "image/jpeg", dados: Buffer.from("capa"), capa: true }], esperaMs: 0 });
  assert.ok(await db.lerMidia(chaveDoVideo(id)));
  assert.equal(await db.lerMidia(`post-${id}-capa.jpg`), null);

  const feitos = [];
  const falso = tiktokFalso();
  try {
    assert.equal((await postarNoTiktok(id, campanha, opcoes({ gerar: gerarFalso(feitos) }))).tiktok, "postado");
    assert.equal(feitos.length, 0);
    assert.equal(falso.de("up.tiktok.exemplo")[0].corpo.toString(), "mp4-do-instagram");
    assert.equal(await db.lerMidia(chaveDoVideo(id)), null);
  } finally {
    falso.restaurar();
  }
  // Sem o TikTok conectado, o Instagram apaga o vídeo como sempre.
  await db.gravarConfig("tiktok", {});
  const outro = await criarPost("2026-10-02");
  await instagram.postarNoInstagram(outro, campanha, { api, arquivos: async () => [{ chave: chaveDoVideo(outro), tipo: "video/mp4", dados: Buffer.from("v") }], esperaMs: 0 });
  assert.equal(await db.lerMidia(chaveDoVideo(outro)), null);
});

test("tiktok: sem vídeo guardado, gera contando as tentativas do TikTok, não as do Instagram", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  const id = await criarPost("2026-10-03");
  await db.atualizarInstagramDoPost(id, { instagram_tentativas: 1, instagram_erro: null, instagram_id: "ig" });
  const feitos = [];
  const falso = tiktokFalso();
  try {
    await postarNoTiktok(id, campanha, opcoes({ gerar: gerarFalso(feitos) }));
    assert.equal(feitos.length, 1);
    assert.equal(feitos[0].instagram_tentativas, 0); // a tentativa do Instagram não faz o vídeo sair sem o avatar
  } finally {
    falso.restaurar();
  }
});

test("tiktok: vídeo processando é conferido na rodada seguinte, sem publicar duas vezes, mesmo se a consulta falhar", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  const id = await criarPost("2026-10-04");
  const falso = tiktokFalso({ status: ["PROCESSING_UPLOAD", new Error("rede fora"), "PUBLISH_COMPLETE"] });
  const o = opcoes({ consultas: 1 });
  try {
    assert.equal((await postarNoTiktok(id, campanha, o)).tiktok, "processando");
    assert.equal((await db.buscarPost(id)).tiktok_publicacao, "pub1");
    assert.equal((await postarNoTiktok(id, campanha, o)).tiktok, "processando"); // a rede caiu, o envio continua guardado
    assert.equal((await db.buscarPost(id)).tiktok_publicacao, "pub1");
    assert.equal((await postarNoTiktok(id, campanha, o)).tiktok, "postado");
    assert.equal(falso.de("/post/publish/video/init/").length, 1);
    assert.equal((await db.buscarPost(id)).tiktok_tentativas, 1);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: envio parado por mais de 1 hora conta como falha, e a tentativa seguinte começa do zero", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  const id = await criarPost("2026-10-05");
  const falso = tiktokFalso({ status: ["PROCESSING_UPLOAD"] });
  const agora = new Date();
  try {
    await postarNoTiktok(id, campanha, opcoes({ consultas: 1, agora }));
    const r = await postarNoTiktok(id, campanha, opcoes({ consultas: 1, agora: new Date(+agora + 2 * 3_600_000) }));
    assert.equal(r.tiktok, "erro");
    const p = await db.buscarPost(id);
    assert.equal(p.tiktok_publicacao, null);
    assert.match(p.tiktok_erro, /parado/);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: app sem auditoria explica o motivo, para na primeira e avisa por e-mail; o Instagram não é tocado", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  await db.destravar("tiktok_aviso_erro");
  const id = await criarPost("2026-10-06");
  const avisos = [];
  const falso = tiktokFalso({ init: new Response(JSON.stringify({ data: {}, error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "x", log_id: "L" } }), { status: 403 }) });
  try {
    const r = await postarNoTiktok(id, campanha, opcoes({ avisar: async (assunto) => avisos.push(assunto) }));
    assert.equal(r.tiktok, "erro");
    assert.match(r.erro, /auditoria/);
    const p = await db.buscarPost(id);
    assert.deepEqual([p.tiktok_tentativas, p.instagram_erro, p.status === "postado"], [MAX_TENTATIVAS, null, false]);
    assert.deepEqual(avisos, ["O vídeo de hoje não saiu no TikTok"]);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: falha passageira conta tentativa e só desiste na 3ª; o e-mail sai uma vez", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  await db.destravar("tiktok_aviso_erro");
  const id = await criarPost("2026-10-07");
  const avisos = [];
  const o = opcoes({ avisar: async (assunto) => avisos.push(assunto), gerar: async () => { throw new Error("O vídeo não foi gerado"); } });
  const falso = tiktokFalso();
  try {
    for (let i = 1; i <= MAX_TENTATIVAS; i++) {
      assert.equal((await postarNoTiktok(id, campanha, o)).tiktok, "erro");
      assert.equal((await db.buscarPost(id)).tiktok_tentativas, i);
      assert.equal(avisos.length, i === MAX_TENTATIVAS ? 1 : 0);
    }
  } finally {
    falso.restaurar();
  }
});

test("tiktok: conta que não aceita mais a privacidade escolhida não recebe o vídeo", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  const id = await criarPost("2026-10-08");
  const falso = tiktokFalso({ opcoes: ["SELF_ONLY"] });
  try {
    const r = await postarNoTiktok(id, campanha, opcoes());
    assert.match(r.erro, /Escolha de novo/);
    assert.equal(falso.de("/post/publish/video/init/").length, 0);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: comentários bloqueados na conta continuam bloqueados, mesmo ligados no painel", async () => {
  await db.gravarConfig("tiktok", conexaoPronta({ dueto: true }));
  const id = await criarPost("2026-10-08");
  const falso = tiktokFalso({ info: { comment_disabled: true } });
  try {
    await postarNoTiktok(id, campanha, opcoes());
    const { post_info: info } = falso.de("/post/publish/video/init/")[0].corpo;
    assert.deepEqual([info.disable_comment, info.disable_duet], [true, false]);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: rascunho vai para o app, sem dados de publicação, e a legenda segue por e-mail", async () => {
  await db.gravarConfig("tiktok", conexaoPronta({ modo: "rascunho", privacidade: null, escopos: "video.upload" }));
  const id = await criarPost("2026-10-09");
  const avisos = [];
  const falso = tiktokFalso({ status: ["SEND_TO_USER_INBOX"] });
  try {
    const r = await postarNoTiktok(id, campanha, opcoes({ avisar: async (assunto, texto) => avisos.push([assunto, texto]) }));
    assert.equal(r.tiktok, "no app");
    const { corpo } = falso.de("/inbox/video/init/")[0];
    assert.equal(corpo.post_info, undefined);
    assert.equal(falso.de("/creator_info/").length, 0);
    assert.equal(avisos[0][0], "Vídeo esperando no app do TikTok");
    assert.match(avisos[0][1], /Três sinais/);
    const p = await db.buscarPost(id);
    assert.deepEqual([p.tiktok_id, p.tiktok_link, p.tiktok_privacidade], ["pub1", null, "RASCUNHO"]);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: conta privada sem auditoria sai como só eu, sem id público, com o link do perfil", async () => {
  await db.gravarConfig("tiktok", conexaoPronta({ privacidade: "SELF_ONLY" }));
  const id = await criarPost("2026-10-10");
  const falso = tiktokFalso({ postId: null, opcoes: ["FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] });
  try {
    const r = await postarNoTiktok(id, campanha, opcoes());
    assert.equal(r.link, "https://www.tiktok.com/@fluxdeck");
    const p = await db.buscarPost(id);
    assert.deepEqual([p.tiktok_id, p.tiktok_privacidade], ["pub1", "SELF_ONLY"]);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: carrossel não vai", async () => {
  await db.gravarConfig("tiktok", conexaoPronta());
  const id = await criarPost("2026-10-11", "carrossel");
  const falso = tiktokFalso();
  try {
    assert.equal((await postarNoTiktok(id, campanha, opcoes())).tiktok, "só vídeo");
    assert.equal(falso.pedidos.length, 0);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: a rodada segue os horários dos posts, espera o vídeo do Instagram e não depende dele", async () => {
  const dia = "2026-11-10";
  await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18], postarSozinho: true });
  const em = (h, m = 0) => new Date(`${dia}T${String(h + 3).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`); // Brasília = UTC-3
  const postados = [];
  const postar = async (id) => (postados.push(id), { tiktok: "postado" });
  const o = (agora, extra = {}) => ({ agora, postar, avisar: async () => {}, ...extra });
  await db.gravarConfig("instagram", { token: "ig" });
  try {
    await db.gravarConfig("tiktok", {});
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(12)))).tiktok, "desconectado");
    await db.gravarConfig("tiktok", conexaoPronta({ automatico: false, expiraEm: new Date(+em(12) + 86_400_000).toISOString(), refreshExpiraEm: new Date(+em(12) + 300 * 86_400_000).toISOString() }));
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(12)))).tiktok, "desligado");
    await db.gravarConfig("tiktok", { ...(await tt.lerConexao()), automatico: true });

    const carrossel = await criarPost(dia, "carrossel", 12);
    const id = await criarPost(dia, "reels", 12);
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(11, 45)))).tiktok, "nada a fazer");
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(14, 5)))).tiktok, "nada a fazer"); // passou da janela
    // Instagram ainda trabalhando: espera o vídeo dele.
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(12, 5)))).tiktok, "nada a fazer");
    assert.equal(postados.length, 0);
    // Passou o tempo de espera, sai mesmo com o Instagram sem publicar.
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(12, 20)))).postId, id);
    assert.deepEqual(postados, [id]);
    assert.ok(!postados.includes(carrossel));
    await db.atualizarTiktokDoPost(id, { tiktok_id: "x" });

    // Com o Instagram já publicado, sai logo.
    const depois = await criarPost(dia, "reels", 18);
    await db.atualizarInstagramDoPost(depois, { instagram_id: "ig" });
    const comErro = async () => ({ tiktok: "erro", erro: "x" });
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(18), { postar: comErro }))).tiktok, "erro");
    // Depois de uma falha, espera 15 minutos antes de tentar de novo.
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(18, 5), { postar: comErro }))).tiktok, "nada a fazer");

    // Vídeo já enviado é conferido mesmo com os posts automáticos desligados e fora da janela.
    await db.atualizarTiktokDoPost(depois, { tiktok_publicacao: "pub9" });
    await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18], postarSozinho: false });
    const conferidos = [];
    const r = await diario.rodadaDoTiktok(campanha, o(em(21), { postar: async (x) => (conferidos.push(x), { tiktok: "postado" }) }));
    assert.equal(r.tiktok, "postado");
    assert.deepEqual(conferidos, [depois]);
    await db.atualizarTiktokDoPost(depois, { tiktok_publicacao: null });
    assert.equal((await diario.rodadaDoTiktok(campanha, o(em(21), { postar }))).tiktok, "desligado");
  } finally {
    await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18], postarSozinho: true });
    await db.gravarConfig("instagram", {});
  }
});

test("tiktok: o login confere o state, guarda o acesso e nada de segredo vai ao painel", async () => {
  const agora = new Date("2026-11-21T15:00:00Z");
  await db.gravarConfig("tiktok", {});
  await assert.rejects(() => tt.urlDeEntrada(agora), /Client Key/);
  await assert.rejects(() => tt.salvarApp({ clientKey: "k" }), /Client Secret/);
  // Sem escolher nada, entra como rascunho, a permissão que todo app novo recebe.
  await tt.salvarApp({ clientKey: "chave-pub", clientSecret: "segredo-x" });
  assert.equal((await tt.statusDaConexao()).modo, "rascunho");
  assert.match(new URL(await tt.urlDeEntrada(agora)).searchParams.get("scope"), /video\.upload/);
  await tt.salvarApp({ clientKey: "chave-pub", clientSecret: "", modo: "direto" });
  const url = new URL(await tt.urlDeEntrada(agora));
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("client_key"), "chave-pub");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://painel.exemplo.com/api/tiktok/retorno");
  assert.equal(url.searchParams.get("scope"), "user.info.basic,video.publish");
  const state = url.searchParams.get("state");

  const falso = tiktokFalso();
  try {
    await assert.rejects(() => tt.concluirEntrada({ code: "x", state: "errado" }, agora), /expirou/);
    await assert.rejects(() => tt.concluirEntrada({ code: "x", state }, new Date(+agora + 20 * 60_000)), /expirou/);
    assert.equal(falso.pedidos.length, 0); // state errado nem chama o TikTok
    await tt.concluirEntrada({ code: "c1", state }, agora);
    const pedido = falso.de("/oauth/token/")[0].corpo;
    assert.deepEqual([pedido.get("grant_type"), pedido.get("code"), pedido.get("client_key"), pedido.get("client_secret")], ["authorization_code", "c1", "chave-pub", "segredo-x"]);
    const s = await tt.statusDaConexao();
    assert.deepEqual([s.entrou, s.conectado, s.usuario, s.apelido, s.automatico, s.privacidade], [true, false, "fluxdeck", "FluxDeck", false, null]); // nada vem escolhido
    assert.doesNotMatch(JSON.stringify(s), /segredo-x|"tok"|r1/);
    // O state só vale uma vez.
    await assert.rejects(() => tt.concluirEntrada({ code: "c2", state }, agora), /expirou/);
    // Só fica pronto com a escolha de quem pode ver; o envio sozinho exige essa escolha.
    await assert.rejects(() => tt.salvarPublicacao({ modo: "direto", automatico: true }), /quem pode ver/);
    await tt.salvarPublicacao({ modo: "direto", privacidade: "SELF_ONLY", comentarios: true, automatico: true });
    assert.deepEqual([(await tt.statusDaConexao()).conectado, (await tt.statusDaConexao()).comentarios], [true, true]);
    // Trocar para rascunho sem a permissão dele avisa para entrar de novo.
    await tt.salvarPublicacao({ modo: "rascunho" });
    assert.equal((await tt.statusDaConexao()).faltaPermissao, true);
    assert.match(new URL(await tt.urlDeEntrada(agora)).searchParams.get("scope"), /video\.upload/);
    // Login recusado: mostra o motivo, e o app continua salvo.
    const recusado = new URL(await tt.urlDeEntrada(agora)).searchParams.get("state");
    await assert.rejects(() => tt.concluirEntrada({ state: recusado, error: "access_denied", error_description: "negado" }, agora), /negado/);
    assert.equal((await tt.statusDaConexao()).appDefinido, true);
    assert.match((await tt.statusDaConexao()).erro, /negado/);
    // Desconectar apaga o acesso, não o app.
    await tt.desconectarTiktok();
    assert.deepEqual([(await tt.statusDaConexao()).entrou, (await tt.statusDaConexao()).appDefinido], [false, true]);
  } finally {
    falso.restaurar();
  }
});

test("tiktok: renova o acesso perto de vencer, guarda a chave nova e avisa se a renovação falhar", async () => {
  const agora = new Date("2026-11-20T15:00:00Z");
  const base = { clientKey: "k", clientSecret: "s", token: "velho", refreshToken: "r1", refreshExpiraEm: new Date(+agora + 300 * 86_400_000).toISOString() };
  const falso = tiktokFalso();
  try {
    await db.gravarConfig("tiktok", { ...base, expiraEm: new Date(+agora + 5 * 3_600_000).toISOString() });
    assert.deepEqual(await tt.renovarTokenSePreciso(agora), {});
    assert.equal(falso.pedidos.length, 0);
    await db.gravarConfig("tiktok", { ...base, expiraEm: new Date(+agora + 3_600_000).toISOString() });
    assert.deepEqual(await tt.renovarTokenSePreciso(agora), { renovado: true });
    assert.equal(falso.de("/oauth/token/")[0].corpo.get("refresh_token"), "r1");
    const c = await tt.lerConexao();
    assert.deepEqual([c.token, c.refreshToken], ["novo", "r2"]); // a chave de renovação troca a cada uso
  } finally {
    falso.restaurar();
  }
  const original = globalThis.fetch;
  try {
    await db.gravarConfig("tiktok", { ...base, expiraEm: new Date(+agora + 3_600_000).toISOString() });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "chave vencida" }), { status: 400 });
    const avisos = [];
    await db.destravar("tiktok_aviso_token");
    await diario.rodadaDoTiktok(campanha, { agora, avisar: async (assunto) => avisos.push(assunto), postar: async () => ({}) });
    await diario.rodadaDoTiktok(campanha, { agora, avisar: async (assunto) => avisos.push(assunto), postar: async () => ({}) });
    assert.deepEqual(avisos, ["O acesso ao TikTok parou de renovar"]);
    assert.match((await tt.statusDaConexao()).erro, /Entre com o TikTok de novo/);
  } finally {
    globalThis.fetch = original;
  }
});

test("tiktok: o agendador e o painel conhecem o TikTok", async () => {
  const banco = await readFile(new URL("../src/agendamento/banco.js", import.meta.url), "utf8");
  assert.match(banco, /prospecta-ia-tiktok/);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="form-tiktok"/);
  assert.match(html, /music-usage-confirmation/);
  assert.match(html, /data-post-acao="tiktok"/);
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  // A volta do login vem de fora, sem a sessão do painel: a rota tem que estar antes da checagem de login.
  assert.ok(app.indexOf('"/api/tiktok/retorno"') < app.indexOf("if (sessaoValida(req)) return next()"));
});
