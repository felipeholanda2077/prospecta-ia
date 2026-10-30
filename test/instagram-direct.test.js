import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const instagram = await import("../src/envio/instagram.js");
const { extrairEventosInstagram, processarWebhookInstagram } = await import("../src/respostas/instagram.js");
const pipeline = await import("../src/pipeline.js");

// Fora do horário comercial o tempo todo: o direct tem que sair mesmo assim.
const campanha = {
  empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [],
  limites: { horarioComercial: { inicio: 0, fim: 0 }, somenteDiasUteis: false, envioDiarioMax: 50 },
  automacao: { respostaAutomatica: false, maxRespostasIA: 5 },
};

/** Graph API de mentira: perfis de quem escreve, envio de direct e resposta a comentário. */
function metaFalsa({ foraDaJanela = false } = {}) {
  const chamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadas.push({ metodo: opcoes.method ?? "GET", caminho: u.pathname.replace(/^\/v[\d.]+\//, ""), corpo });
    if (u.pathname.endsWith("/me/messages")) {
      if (foraDaJanela) return Response.json({ error: { code: 10, error_subcode: 2534022, message: "This message is sent outside of allowed window." } }, { status: 400 });
      return Response.json({ recipient_id: corpo.recipient.id ?? "x", message_id: `mid.${chamadas.length}` });
    }
    if (u.pathname.endsWith("/replies")) return Response.json({ id: "reply-1" });
    if (u.pathname.endsWith("/1784000001")) return Response.json({ name: "Patrícia", username: "belieze" });
    return Response.json({ error: { code: 100, message: "Unsupported get request" } }, { status: 400 });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = original), enviados: () => chamadas.filter((c) => c.caminho === "me/messages") };
}

const direct = (de, texto, mid) => ({ object: "instagram", entry: [{ id: "17841", time: 1, messaging: [{ sender: { id: de }, recipient: { id: "17841" }, timestamp: 1, message: { mid, text: texto } }] }] });
const comentario = (de, usuario, texto, id, midia = "midia-1") => ({ object: "instagram", entry: [{ id: "17841", time: 1, changes: [{ field: "comments", value: { from: { id: de, username: usuario }, media: { id: midia }, id, text: texto } }] }] });

const interessado = async () => ({
  classificacao: "quer_informacoes", resumo: "Quer saber o preço de um site", sugestao_resposta: "Oi, Patrícia! Depende do que você precisa.",
  precisa_humano: false, motivo_humano: "", indicou_contato: false, temperatura: "morna", proximo_passo: "", robo: false, encerrar: false,
});
const apresentar = async () => "Oi, Patrícia! Funciona assim: ...";

test("direct: lê só as mensagens e os comentários de outras pessoas", () => {
  const payload = {
    object: "instagram",
    entry: [{
      id: "17841",
      messaging: [
        { sender: { id: "A" }, message: { mid: "m1", text: "Oi!" } },
        { sender: { id: "17841" }, message: { mid: "m2", text: "eco", is_echo: true } },
        { sender: { id: "B" }, message: { mid: "m3", attachments: [{ type: "audio", payload: { url: "https://cdn/a.mp4" } }] } },
        { sender: { id: "C" }, message: { mid: "m4", attachments: [{ type: "image", payload: { url: "https://cdn/i.jpg" } }] } },
        { sender: { id: "D" }, read: { mid: "m1" } },
      ],
      changes: [
        { field: "comments", value: { from: { id: "E", username: "cliente" }, media: { id: "midia-1" }, id: "c1", text: "SITE" } },
        { field: "comments", value: { from: { id: "17841", username: "fluxdeck_" }, media: { id: "midia-1" }, id: "c2", text: "Te mandei!" } },
      ],
    }],
  };
  const { mensagens, comentarios } = extrairEventosInstagram(payload, { meuId: "17841", meuUsuario: "fluxdeck_" });
  assert.deepEqual(mensagens.map((m) => [m.id, m.texto, Boolean(m.audio)]), [["m1", "Oi!", false], ["m3", "", true], ["m4", "[imagem]", false]]);
  assert.deepEqual(comentarios.map((c) => [c.id, c.usuario, c.midiaId]), [["c1", "cliente", "midia-1"]]);
  assert.deepEqual(extrairEventosInstagram({ object: "page", entry: [] }), { mensagens: [], comentarios: [] });
});

test("direct: texto longo sai em partes que cabem no limite do Instagram", () => {
  const partes = instagram.partesDoDirect(`Oi!\n\n${"Uma frase com acentuação. ".repeat(80)}\n\nAbraço.`);
  assert.ok(partes.length > 1);
  assert.ok(partes.every((p) => Buffer.byteLength(p) <= 950));
  assert.ok(partes[0].startsWith("Oi!\n\nUma frase"));
  assert.ok(partes.at(-1).endsWith("\n\nAbraço."));
});

test("direct: a IA responde o direct a qualquer hora e chama no direct quem comenta pedindo", async () => {
  const meta = metaFalsa();
  try {
    await db.gravarConfig("instagram", { token: "EAApagina", host: "graph.facebook.com", igId: "17841", usuario: "fluxdeck_" });
    // Desligado: o webhook não faz nada com os comentários, mas o direct entra (sem a IA responder).
    const desligado = await instagram.configDoDirect();
    assert.equal(desligado.respostas, false);
    assert.match(desligado.verifyToken, /^[0-9a-f]{32}$/);
    await instagram.salvarConfigDoDirect({ respostas: true, comentarios: true, appSecret: "segredo" });
    await instagram.salvarConfigDoDirect({ respostas: true }); // sem a chave: mantém a salva
    assert.equal((await instagram.configDoDirect()).appSecret, "segredo");

    // 1) Alguém chama no direct: vira um lead com o nome e o @ do perfil, e a IA agenda a resposta.
    await processarWebhookInstagram(direct("1784000001", "Oi! Quanto custa um site?", "mid.a"), campanha, { classificar: interessado, apresentar });
    const lead = await db.leadPeloInstagram("belieze");
    assert.equal(lead.nome, "Patrícia");
    assert.equal(lead.origem, "instagram_direct");
    const [agendada] = await db.agendadasDaConversa(lead.id);
    assert.equal(agendada.contato, "1784000001");
    assert.match(agendada.texto, /Funciona assim/); // primeira demonstração de interesse: a apresentação

    // A mesma mensagem reenviada pela Meta não entra duas vezes.
    await processarWebhookInstagram(direct("1784000001", "Oi! Quanto custa um site?", "mid.a"), campanha, { classificar: interessado, apresentar });
    assert.equal((await db.historicoConversa(lead.id)).filter((h) => h.autor === "lead").length, 1);

    // Sai na hora marcada, mesmo fora do horário comercial.
    await db.atualizarMensagem(agendada.id, { agendada_para: new Date(Date.now() - 1000).toISOString() });
    assert.deepEqual(await pipeline.enviarInstagram(campanha), { enviadas: 1, naFila: 0 });
    assert.deepEqual(meta.enviados().at(-1).corpo.recipient, { id: "1784000001" });

    // 2) Comentário pedindo o que o post prometeu: mensagem privada ao comentário + resposta pública.
    const postId = await db.criarPost({ dia: "2026-10-29", formato: "carrossel", pilar: "erro", tema: "Site lento",
      conteudo: { gancho: "Seu site espanta clientes?", legenda: "Comenta SITE", slides: [{ visual: "cta", titulo: "Comenta SITE", texto: "" }] } });
    await db.atualizarInstagramDoPost(postId, { instagram_id: "midia-1" });
    let viuOPost = null;
    const escrever = async ({ post }) => {
      viuOPost = post?.tema;
      return { responder: true, resumo: "Pediu o checklist", mensagem: "Oi! Aqui vão os 3 sinais: ...", resposta_publica: "Te mandei no direct! 📩" };
    };
    await processarWebhookInstagram(comentario("1784000002", "dentalcenter", "SITE", "com-1"), campanha, { escrever, esperar: [0, 0] });
    assert.equal(viuOPost, "Site lento");
    assert.deepEqual(meta.enviados().at(-1).corpo.recipient, { comment_id: "com-1" });
    assert.deepEqual(meta.chamadas.at(-1), { metodo: "POST", caminho: "com-1/replies", corpo: { message: "Te mandei no direct! 📩" } });
    const daClinica = await db.leadPeloInstagram("dentalcenter");
    assert.equal(daClinica.nome, "@dentalcenter");

    // Quando a pessoa responde no direct, cai na mesma conversa.
    await processarWebhookInstagram(direct("1784000002", "Quero sim!", "mid.b"), campanha, { classificar: interessado, apresentar });
    const conversa = await db.historicoConversa(daClinica.id);
    assert.deepEqual(conversa.map((h) => h.autor), ["lead", "nos", "lead"]);
    assert.match(conversa[0].texto, /\[comentou no post "Site lento"\] SITE/);

    // Comentou de novo em outro post: a conversa já está aberta, não chama de novo.
    const antes = meta.enviados().length;
    await processarWebhookInstagram(comentario("1784000002", "dentalcenter", "SITE", "com-2"), campanha, { escrever, esperar: [0, 0] });
    assert.equal(meta.enviados().length, antes);

    // 3) Elogio solto: sem direct e sem lead.
    const elogio = async () => ({ responder: false, resumo: "Só elogiou", mensagem: "", resposta_publica: "" });
    await processarWebhookInstagram(comentario("1784000003", "fa", "😍😍", "com-3"), campanha, { escrever: elogio, esperar: [0, 0] });
    assert.equal(await db.leadPeloInstagram("fa"), null);
    assert.equal(meta.enviados().length, antes);

    // 4) Comentários desligados: o comentário nem é lido.
    await instagram.salvarConfigDoDirect({ comentarios: false });
    let leu = false;
    await processarWebhookInstagram(comentario("1784000004", "outro", "SITE", "com-4"), campanha, { escrever: async () => ((leu = true), elogio()), esperar: [0, 0] });
    assert.equal(leu, false);
  } finally {
    meta.restaurar();
  }
});

test("direct: passou de 24 h da última mensagem da pessoa, o erro explica", async () => {
  const meta = metaFalsa({ foraDaJanela: true });
  try {
    await db.gravarConfig("instagram", { token: "EAApagina", host: "graph.facebook.com", igId: "17841", usuario: "fluxdeck_" });
    const leadId = await db.criarLeadDeContato({ nome: "Atrasada", instagram: "atrasada", origem: "instagram_direct" });
    const id = await db.criarMensagem({ lead_id: leadId, canal: "instagram", destino: "1784000009", corpo: "Oi!", status: "aprovada", tipo: "resposta", etapa: 0 });
    const r = await pipeline.enviarMensagem(await db.buscarMensagem(id), campanha);
    assert.equal(r.enviada, false);
    assert.match(r.motivo, /24 horas/);
  } finally {
    meta.restaurar();
  }
});

test("direct: o webhook só aceita a verificação e os eventos assinados pela Meta", async () => {
  const crypto = await import("node:crypto");
  const { app } = await import("../src/app.js");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const { verifyToken } = await instagram.salvarConfigDoDirect({ appSecret: "segredo" });
    const verificar = (token) => fetch(`${base}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=123`);
    assert.equal(await (await verificar(verifyToken)).text(), "123");
    assert.equal((await verificar("errado")).status, 403);

    const corpo = JSON.stringify({ object: "instagram", entry: [] });
    const enviar = (assinatura) => fetch(`${base}/webhooks/instagram`, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": assinatura }, body: corpo });
    assert.equal((await enviar("sha256=errada")).status, 401);
    const certa = "sha256=" + crypto.createHmac("sha256", "segredo").update(corpo).digest("hex");
    assert.equal((await enviar(certa)).status, 200);
  } finally {
    servidor.close();
  }
});
