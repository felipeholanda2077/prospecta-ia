import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const instagram = await import("../src/envio/instagram.js");
const { processarWebhookInstagram, rodadaDeComentarios } = await import("../src/respostas/instagram.js");
const { rodadaDasOutrasContas } = await import("../src/conteudo/instagram.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

const campanha = {
  empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [],
  limites: { horarioComercial: { inicio: 0, fim: 0 }, somenteDiasUteis: false, envioDiarioMax: 50 },
  automacao: { respostaAutomatica: false, maxRespostasIA: 5 },
};

/** Instagram Login de mentira: cada token é de um perfil; o direct sai por /{perfil}/messages. */
function metaFalsa() {
  const perfis = { IGflux: { user_id: "111", username: "fluxdeck_" }, IGloja: { user_id: "222", username: "loja_flux" }, IGblog: { user_id: "333", username: "blog_flux" } };
  const chamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    const token = String(opcoes.headers?.Authorization ?? "").replace("Bearer ", "");
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    const caminho = u.pathname.replace(/^\/v[\d.]+\//, "");
    chamadas.push({ token, caminho, corpo });
    if (u.host !== "graph.instagram.com" || !perfis[token]) return Response.json({ error: { code: 190, message: "Invalid OAuth access token" } }, { status: 400 });
    if (caminho === "me") return Response.json(perfis[token]);
    if (caminho.endsWith("/messages")) return Response.json({ message_id: `mid.${chamadas.length}` });
    if (caminho === "9001") return Response.json({ name: "Ana", username: "ana.cliente" });
    return Response.json({ error: { code: 100, message: "Unsupported get request" } }, { status: 400 });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = original) };
}

test("instagram: vários perfis, sem tokens no painel, trocar o principal e desconectar", async () => {
  const meta = metaFalsa();
  try {
    // Sem principal, "outro perfil" vira o principal.
    await instagram.conectarInstagram("IGflux", "", { outra: true });
    await instagram.conectarInstagram("IGloja", "", { outra: true });
    await instagram.conectarInstagram("IGblog", "", { outra: true });
    await instagram.conectarInstagram("IGloja", "", { outra: true }); // reconectar não duplica
    let st = await instagram.statusDaConexao();
    assert.equal(st.usuario, "fluxdeck_");
    assert.deepEqual(st.outras.map((o) => [o.usuario, o.publicar]), [["blog_flux", true], ["loja_flux", true]]);
    assert.equal(JSON.stringify(st).includes("IGloja"), false);
    assert.equal((await instagram.lerConexao("222")).usuario, "loja_flux");
    assert.equal((await instagram.lerConexao()).usuario, "fluxdeck_");

    await instagram.definirPublicarNaConta("333", false);
    assert.deepEqual((await instagram.contasParaPublicar()).map((c) => c.usuario), ["loja_flux"]);

    await instagram.tornarPrincipal("222");
    st = await instagram.statusDaConexao();
    assert.equal(st.usuario, "loja_flux");
    assert.deepEqual(st.outras.map((o) => o.usuario).sort(), ["blog_flux", "fluxdeck_"]);
    await instagram.tornarPrincipal("111");

    await instagram.desconectarOutraConta("333");
    assert.deepEqual((await instagram.statusDaConexao()).outras.map((o) => o.usuario), ["loja_flux"]);
  } finally {
    meta.restaurar();
  }
});

test("instagram: o direct que chegou num perfil é respondido por esse perfil", async () => {
  const meta = metaFalsa();
  try {
    await instagram.salvarConfigDoDirect({ respostas: true, comentarios: true, appSecret: "s" });
    const classificar = async () => ({ classificacao: "quer_informacoes", resumo: "quer saber", sugestao_resposta: "Oi, Ana!", precisa_humano: false, motivo_humano: "", indicou_contato: false, temperatura: "morna", proximo_passo: "", robo: false, encerrar: false });
    const apresentar = async () => "Oi, Ana! Funciona assim.";
    // A entrada do aviso é do perfil 222 (loja_flux).
    const aviso = { object: "instagram", entry: [{ id: "222", time: 1, messaging: [{ sender: { id: "9001" }, recipient: { id: "222" }, timestamp: 1, message: { mid: "m.1", text: "Oi, tem horário?" } }] }] };
    await processarWebhookInstagram(aviso, campanha, { classificar, apresentar });
    const lead = await db.leadPeloInstagram("ana.cliente");
    assert.ok(lead);
    // O perfil da pessoa foi lido com o token da loja.
    assert.equal(meta.chamadas.find((c) => c.caminho === "9001").token, "IGloja");
    const [agendada] = await db.agendadasDaConversa(lead.id);
    await db.atualizarMensagem(agendada.id, { agendada_para: new Date(Date.now() - 1000).toISOString() });
    await pipeline.enviarInstagram(campanha);
    const envio = meta.chamadas.filter((c) => c.caminho.endsWith("/messages")).at(-1);
    assert.deepEqual([envio.token, envio.caminho], ["IGloja", "222/messages"]);

    // Um perfil comentando no post do outro não vira cliente.
    const lidos = [];
    const ler = async ({ conta }) => (lidos.push(conta), conta === "111" ? [{ id: "c1", de: "222", usuario: "loja_flux", texto: "Top!", midiaId: "x", resposta: false, quando: new Date().toISOString() }] : []);
    const r = await rodadaDeComentarios(campanha, { ler });
    assert.deepEqual(lidos, ["111", "222"]);
    assert.equal(r.novos, 0);
  } finally {
    meta.restaurar();
  }
});

test("instagram: o post do dia vai também para os outros perfis marcados, e os arquivos saem depois", async () => {
  const conectadoEm = (await instagram.lerConexao("222")).conectadoEm;
  const id = await db.criarPost({ dia: "2026-11-06", formato: "carrossel", pilar: "dica", tema: "Teste", conteudo: { legenda: "Legenda", hashtags: ["flux"], slides: [{}, {}] } });
  await db.atualizarInstagramDoPost(id, { instagram_id: "ig-principal" });
  await db.atualizarStatusPost(id, "postado");
  assert.ok(new Date((await db.buscarPost(id)).postado_em) >= new Date(conectadoEm));
  for (const k of [`post-${id}-2.jpg`, `post-${id}-1.jpg`]) await db.gravarMidia(k, "image/jpeg", Buffer.from("x"));

  let status = "IN_PROGRESS";
  const feitos = [];
  const api = {
    contasParaPublicar: instagram.contasParaPublicar,
    criarContainer: async (conta, dados) => (feitos.push(["criar", conta.usuario, dados.urls.map((u) => u.split("/").pop().split("?")[0])]), "cont-1"),
    statusDoContainer: async () => ({ codigo: status }),
    publicarContainer: async (conta) => (feitos.push(["publicar", conta.usuario]), { id: "ig-loja", link: "https://instagram.com/p/loja" }),
  };
  // Primeira rodada: cria a mídia (o Instagram ainda está processando) e não apaga nada.
  assert.deepEqual(await rodadaDasOutrasContas(campanha, { api }), { outrasContas: 1, publicados: 0 });
  assert.deepEqual(feitos, [["criar", "loja_flux", [`post-${id}-1.jpg`, `post-${id}-2.jpg`]]]);
  assert.equal((await db.chavesDeMidia(`post-${id}-`)).length, 2);
  // Segunda: publica e apaga os arquivos; terceira: nada mais a fazer.
  status = "FINISHED";
  assert.deepEqual(await rodadaDasOutrasContas(campanha, { api }), { outrasContas: 1, publicados: 1 });
  assert.deepEqual(feitos.at(-1), ["publicar", "loja_flux"]);
  assert.deepEqual(await db.chavesDeMidia(`post-${id}-`), []);
  assert.deepEqual(await rodadaDasOutrasContas(campanha, { api }), { outrasContas: 1, publicados: 0 });
  assert.equal(feitos.length, 2);
});
