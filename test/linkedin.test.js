import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.URL_PUBLICA = "https://painel.exemplo.com";
const db = await import("../src/db.js");
const diario = await import("../src/conteudo/diario.js");
const conteudoLi = await import("../src/conteudo/linkedin.js");
const li = await import("../src/envio/linkedin.js");

const { postarNoLinkedin, postParaLinkedin, textoFinal, pdfDoCarrossel, MAX_TENTATIVAS } = conteudoLi;
const campanha = { empresa: { nome: "FluxDeck", diferenciais: [] }, servicos: [] };
const adaptado = {
  texto: "O custo de um site lento não aparece no caixa.\n\nComo a sua empresa mede isso?", hashtags: ["gestao", "fluxdeck"], tituloDocumento: "O custo do site lento",
  cta: { titulo: "Como você mede isso?", texto: "Conte nos comentários.", destaque: "mede", fala: "Conta aqui nos comentários." },
};
const conteudo = (extra = {}) => ({
  tema: "Site lento", gancho: "Seu site espanta clientes?", legenda: "Três sinais.\n\nComenta SITE!\n\nFotos: Ana (CC BY 4.0, via Wikimedia Commons).",
  hashtags: ["fluxdeck"], hashtags_extras: [], audio: "", narracao: "",
  slides: [{ titulo: "Seu site espanta clientes?", texto: "", destaque: "clientes", visual: "capa", avatar: { id: "a1" } }, { titulo: "Comenta SITE", texto: "Te mando no direct", destaque: "", visual: "cta", fala: "Comenta aí", avatar: { id: "a2" } }],
  ...extra,
});
let n = 0;
const criarPost = async (dia, formato = "carrossel", extra = {}) => db.criarPost({ dia, formato, pilar: "erro", tema: `Site lento ${++n}`, conteudo: conteudo(extra) });

function apiFalsa({ status = ["AVAILABLE"], falhar = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    lerConexao: async () => ({ token: "t", organizacao: "urn:li:organization:9" }),
    enviarVideo: async (c, dados) => (chamadas.push(["video", dados]), "urn:li:video:V1"),
    enviarDocumento: async (c, dados) => (chamadas.push(["documento", dados]), "urn:li:document:D1"),
    statusDaMidia: async (c, urn) => (chamadas.push(["status", urn]), { codigo: status.length > 1 ? status.shift() : status[0], detalhe: "" }),
    publicarPost: async (c, dados) => {
      chamadas.push(["publicar", dados]);
      if (falhar) throw new Error(falhar);
      return { id: "urn:li:share:7", link: "https://www.linkedin.com/feed/update/urn:li:share:7/" };
    },
  };
}
// JPEG mínimo de verdade, para o PDF do carrossel.
const { createCanvas } = await import("@napi-rs/canvas");
const jpeg = await createCanvas(108, 135).encode("jpeg", 80);
const arquivosFalsos = (recebidos = []) => async (post) => {
  recebidos.push(post);
  return post.formato === "reels" ? [{ dados: Buffer.from("mp4") }] : post.conteudo.slides.map(() => ({ dados: jpeg }));
};
const opcoes = (api, recebidos) => ({ api, arquivos: arquivosFalsos(recebidos), escrever: async () => adaptado, esperaMs: 0, avisar: async () => {} });

test("linkedin: a versão da API fica sempre numa que existe", () => {
  assert.equal(li.versaoDaApi(new Date("2026-10-30T12:00:00Z")), "202607");
  assert.equal(li.versaoDaApi(new Date("2027-01-15T12:00:00Z")), "202610");
  assert.equal(li.versaoDaApi(new Date("2027-03-15T12:00:00Z")), "202611"); // não há versão de dezembro
});

test("linkedin: caractere reservado é escapado, para o post não ser cortado, e a hashtag continua hashtag", () => {
  assert.equal(li.escaparTexto("Custo (alto) em 2 meses"), "Custo \\(alto\\) em 2 meses");
  assert.equal(li.escaparTexto("a@b *c* _d_ ~e~ [f] {g} <h> |i| \\"), "a\\@b \\*c\\* \\_d\\_ \\~e\\~ \\[f\\] \\{g\\} \\<h\\> \\|i\\| \\\\");
  assert.equal(li.escaparTexto("#gestao fim\n\n#fluxdeck #ti"), "#gestao fim\n\n#fluxdeck #ti");
  assert.equal(li.escaparTexto("item #1 e C# aqui"), "item #1 e C\\# aqui");
});

test("linkedin: a última tela vira a chamada do LinkedIn, sem o avatar falando a chamada antiga", () => {
  const post = { formato: "reels", conteudo: { ...conteudo(), linkedin: adaptado } };
  const { slides } = postParaLinkedin(post).conteudo;
  assert.deepEqual([slides.at(-1).titulo, slides.at(-1).texto, slides.at(-1).fala, slides.at(-1).visual], ["Como você mede isso?", "Conte nos comentários.", "Conta aqui nos comentários.", "cta"]);
  assert.equal(slides.at(-1).avatar, undefined);
  assert.deepEqual(slides[0].avatar, { id: "a1" }); // a capa continua
  assert.equal(post.conteudo.slides.at(-1).titulo, "Comenta SITE"); // o do Instagram não muda
});

test("linkedin: o texto final leva o contato, o aviso do avatar, o crédito das fotos e as hashtags", () => {
  const t = textoFinal({ conteudo: { ...conteudo(), linkedin: adaptado } });
  assert.match(t, /^O custo de um site lento/);
  assert.match(t, /Fale com a gente: https:\/\/painel\.exemplo\.com\/contato\?origem=linkedin/);
  assert.match(t, /Avatar do Felipe gerado com IA\./);
  assert.match(t, /Fotos: Ana \(CC BY 4\.0, via Wikimedia Commons\)\./);
  assert.match(t, /#gestao #fluxdeck$/);
  const longo = textoFinal({ conteudo: { ...conteudo(), linkedin: { ...adaptado, texto: "x".repeat(5000) } } });
  assert.ok(longo.length <= li.MAX_TEXTO);
});

test("linkedin: o carrossel vira um PDF com uma página por tela", async () => {
  const pdf = await pdfDoCarrossel([jpeg, jpeg, jpeg], { titulo: "Teste" });
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length, 3);
  assert.match(pdf.toString("latin1"), /MediaBox \[0 0 1080 1350\]/);
});

test("linkedin: publica o carrossel como documento e guarda o texto da IA no post", async () => {
  const id = await criarPost("2026-10-01");
  const api = apiFalsa();
  const recebidos = [];
  const r = await postarNoLinkedin(id, campanha, opcoes(api, recebidos));
  assert.equal(r.linkedin, "postado");
  assert.deepEqual(api.chamadas.map((c) => c[0]), ["documento", "status", "publicar"]);
  assert.equal(recebidos[0].conteudo.slides.at(-1).titulo, "Como você mede isso?");
  const publicado = api.chamadas.at(-1)[1];
  assert.deepEqual(publicado.midia, { id: "urn:li:document:D1", titulo: "O custo do site lento" });
  assert.match(publicado.texto, /^O custo de um site lento/);
  const salvo = await db.buscarPost(id);
  assert.deepEqual([salvo.linkedin_id, salvo.linkedin_midia, salvo.linkedin_erro], ["urn:li:share:7", null, null]);
  assert.equal(salvo.conteudo.linkedin.texto, adaptado.texto);
  assert.equal(salvo.instagram_id, null); // nada do Instagram foi tocado
  // Já publicado: não publica de novo.
  assert.equal((await postarNoLinkedin(id, campanha, opcoes(api, recebidos))).linkedin, "postado");
  assert.equal(api.chamadas.filter((c) => c[0] === "publicar").length, 1);
});

test("linkedin: vídeo processando continua de onde parou, sem subir de novo", async () => {
  const id = await criarPost("2026-10-02", "reels");
  const api = apiFalsa({ status: ["PROCESSING", "PROCESSING", "AVAILABLE"] });
  const o = { ...opcoes(api), consultas: 2 };
  assert.equal((await postarNoLinkedin(id, campanha, o)).linkedin, "processando");
  assert.equal((await db.buscarPost(id)).linkedin_midia, "urn:li:video:V1");
  assert.equal((await postarNoLinkedin(id, campanha, o)).linkedin, "postado");
  assert.equal(api.chamadas.filter((c) => c[0] === "video").length, 1);
});

test("linkedin: erro fica só no LinkedIn e, na 3ª falha, avisa por e-mail", async () => {
  const id = await criarPost("2026-10-03");
  const avisos = [];
  const o = { ...opcoes(apiFalsa({ falhar: "ACCESS_DENIED" })), avisar: async (assunto) => avisos.push(assunto) };
  for (let i = 0; i < MAX_TENTATIVAS; i++) assert.equal((await postarNoLinkedin(id, campanha, o)).linkedin, "erro");
  const p = await db.buscarPost(id);
  assert.deepEqual([p.linkedin_erro, p.linkedin_tentativas, p.instagram_erro, p.status === "postado"], ["ACCESS_DENIED", MAX_TENTATIVAS, null, false]);
  assert.deepEqual(avisos, ["O post de hoje não saiu no LinkedIn"]);
});

test("linkedin: a rodada publica no horário do post, independente do Instagram", async () => {
  const dia = "2026-11-10";
  await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18], postarSozinho: true });
  const em = (h, m = 0) => new Date(`${dia}T${String(h + 3).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`); // Brasília = UTC-3
  const postados = [];
  const postar = async (id) => (postados.push(id), { linkedin: "postado" });

  assert.equal((await diario.rodadaDoLinkedin(campanha, { agora: em(12), postar })).linkedin, "desconectado");
  await db.gravarConfig("linkedin", { token: "t", organizacao: "urn:li:organization:9", expiraEm: new Date(em(12).getTime() + 30 * 86_400_000).toISOString() });

  const id = await criarPost(dia);
  await db.definirHorarioDoPost(id, 12);
  // Antes do horário, nada.
  assert.equal((await diario.rodadaDoLinkedin(campanha, { agora: em(11, 45), postar })).linkedin, "nada a fazer");
  // Passou da janela, não sai atrasado.
  assert.equal((await diario.rodadaDoLinkedin(campanha, { agora: em(14, 5), postar })).linkedin, "nada a fazer");
  assert.equal(postados.length, 0);
  // No horário sai, mesmo com o Instagram ainda sem publicar.
  assert.equal((await diario.rodadaDoLinkedin(campanha, { agora: em(12), postar })).postId, id);
  assert.deepEqual(postados, [id]);

  // Depois de uma falha, espera 15 minutos antes de tentar de novo.
  const falho = await criarPost(dia);
  await db.definirHorarioDoPost(falho, 18);
  const comErro = async () => ({ linkedin: "erro", erro: "x" });
  await db.atualizarLinkedinDoPost(id, { linkedin_id: "urn:li:share:1" });
  assert.equal((await diario.rodadaDoLinkedin(campanha, { agora: em(18), postar: comErro })).linkedin, "erro");
  assert.equal((await diario.rodadaDoLinkedin(campanha, { agora: em(18, 5), postar: comErro })).linkedin, "nada a fazer");

  // Desligar os posts automáticos vale também para o LinkedIn.
  await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18], postarSozinho: false });
  assert.equal((await diario.rodadaDoLinkedin(campanha, { agora: em(18, 20), postar })).linkedin, "desligado");
  await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18], postarSozinho: true });
});

test("linkedin: acesso perto de vencer renova sozinho, ou avisa por e-mail uma vez", async () => {
  const agora = new Date("2026-11-20T15:00:00Z");
  const original = globalThis.fetch;
  try {
    await db.gravarConfig("linkedin", { clientId: "id", clientSecret: "s", token: "velho", refreshToken: "r1", organizacao: "urn:li:organization:9", expiraEm: new Date(+agora + 3 * 86_400_000).toISOString() });
    let corpo = "";
    globalThis.fetch = async (url, o) => {
      assert.match(String(url), /oauth\/v2\/accessToken$/);
      corpo = String(o.body);
      return new Response(JSON.stringify({ access_token: "novo", expires_in: 5184000 }));
    };
    assert.deepEqual(await li.renovarTokenSePreciso(agora), { renovado: true });
    assert.match(corpo, /grant_type=refresh_token/);
    const c = await li.lerConexao();
    assert.deepEqual([c.token, c.refreshToken], ["novo", "r1"]);

    await db.gravarConfig("linkedin", { token: "t", organizacao: "urn:li:organization:9", expiraEm: new Date(+agora + 5 * 86_400_000).toISOString() });
    const avisos = [];
    const avisar = async (assunto) => avisos.push(assunto);
    await diario.rodadaDoLinkedin(campanha, { agora, avisar, postar: async () => ({}) });
    await diario.rodadaDoLinkedin(campanha, { agora, avisar, postar: async () => ({}) });
    assert.deepEqual(avisos, ["O acesso ao LinkedIn vence em 5 dias"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("linkedin: o login confere o state, guarda o acesso e escolhe a página única; nada de segredo vai ao painel", async () => {
  const agora = new Date("2026-11-21T15:00:00Z");
  const original = globalThis.fetch;
  try {
    await db.gravarConfig("linkedin", {});
    await assert.rejects(() => li.urlDeEntrada(agora), /Client ID/);
    await li.salvarApp({ clientId: "abc", clientSecret: "segredo" });
    const url = new URL(await li.urlDeEntrada(agora));
    assert.equal(url.searchParams.get("redirect_uri"), "https://painel.exemplo.com/api/linkedin/retorno");
    assert.match(url.searchParams.get("scope"), /w_organization_social/);
    const state = url.searchParams.get("state");

    // State errado: não troca nada, nem chama o LinkedIn.
    globalThis.fetch = async () => assert.fail("não chama o LinkedIn");
    await assert.rejects(() => li.concluirEntrada({ code: "x", state: "errado" }, agora), /expirou/);
    await assert.rejects(() => li.concluirEntrada({ code: "x", state }, new Date(+agora + 20 * 60_000)), /expirou/);

    const pedidos = [];
    globalThis.fetch = async (u, o = {}) => {
      pedidos.push([String(u), o.headers?.["Linkedin-Version"]]);
      if (String(u).endsWith("/accessToken")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 5184000 }));
      if (String(u).includes("organizationAcls")) return new Response(JSON.stringify({ elements: [
        { role: "ADMINISTRATOR", organization: "urn:li:organization:123", state: "APPROVED" },
        { role: "ANALYST", organization: "urn:li:organization:456", state: "APPROVED" },
      ] }));
      if (String(u).endsWith("/organizations/123")) return new Response(JSON.stringify({ localizedName: "FluxDeck" }));
      return new Response("{}", { status: 404 });
    };
    await li.concluirEntrada({ code: "c1", state }, agora);
    assert.ok(pedidos.some(([, v]) => /^\d{6}$/.test(v ?? "")));
    const s = await li.statusDaConexao();
    assert.deepEqual([s.conectado, s.pagina, s.organizacao, s.renovaSozinho], [true, "FluxDeck", "urn:li:organization:123", false]);
    assert.doesNotMatch(JSON.stringify(s), /segredo|tok/);
    // O state só vale uma vez.
    await assert.rejects(() => li.concluirEntrada({ code: "c2", state }, agora), /expirou/);
    // Colar o link de administrador também serve.
    assert.equal((await li.escolherPagina("https://www.linkedin.com/company/987654/admin/")).urn, "urn:li:organization:987654");
  } finally {
    globalThis.fetch = original;
  }
});

test("linkedin: sobe o vídeo em partes, finaliza com as etiquetas e publica com o texto escapado", async () => {
  const original = globalThis.fetch;
  const conexao = { token: "tok", organizacao: "urn:li:organization:9" };
  const log = [];
  try {
    globalThis.fetch = async (u, o = {}) => {
      const url = String(u);
      log.push([o.method, url, o.body]);
      if (url.includes("initializeUpload")) return new Response(JSON.stringify({ value: { video: "urn:li:video:V9", uploadToken: "", uploadInstructions: [
        { uploadUrl: "https://up/1", firstByte: 0, lastByte: 4 }, { uploadUrl: "https://up/2", firstByte: 5, lastByte: 9 },
      ] } }));
      if (url.startsWith("https://up/")) return new Response(null, { status: 200, headers: { etag: url.endsWith("1") ? "\"e1\"" : "e2" } });
      if (url.includes("finalizeUpload")) return new Response(null, { status: 200 });
      if (url.endsWith("/posts")) return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:55" } });
      return new Response("{}", { status: 404 });
    };
    assert.equal(await li.enviarVideo(conexao, Buffer.from("0123456789")), "urn:li:video:V9");
    assert.equal(log[1][2].toString(), "01234");
    assert.equal(log[2][2].toString(), "56789");
    assert.deepEqual(JSON.parse(log[3][2]).finalizeUploadRequest, { video: "urn:li:video:V9", uploadToken: "", uploadedPartIds: ["e1", "e2"] });

    const r = await li.publicarPost(conexao, { texto: "Custo (alto)\n\n#gestao", midia: { id: "urn:li:video:V9", titulo: "T" } });
    assert.deepEqual(r, { id: "urn:li:share:55", link: "https://www.linkedin.com/feed/update/urn:li:share:55/" });
    const corpo = JSON.parse(log.at(-1)[2]);
    assert.deepEqual([corpo.author, corpo.commentary, corpo.content.media.id, corpo.lifecycleState], ["urn:li:organization:9", "Custo \\(alto\\)\n\n#gestao", "urn:li:video:V9", "PUBLISHED"]);
  } finally {
    globalThis.fetch = original;
  }
});
