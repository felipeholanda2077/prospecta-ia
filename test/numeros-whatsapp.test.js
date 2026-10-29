import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const uazap = await import("../src/envio/uazap.js");
const pipeline = await import("../src/pipeline.js");

const URL_UAZAP = "https://fluxdeck.uazapi.com";
// Sempre dentro do horário, sem aquecimento e com 1 empresa nova por número por dia.
const campanha = {
  empresa: { nome: "FluxDeck" },
  limites: { horarioComercial: { inicio: 0, fim: 24 }, somenteDiasUteis: false, envioDiarioMax: 50 },
  automacao: { metaDiaria: { email: 10, whatsapp: 1 }, aquecimentoWhatsapp: false },
};

/** UAZap de mentira: cada instância é reconhecida pelo token; dá para desconectar uma delas. */
function uazapFalsa() {
  const desconectados = new Set();
  const envios = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    const token = opcoes.headers?.token;
    if (!["A", "B"].includes(token)) return Response.json({ error: "Invalid token" }, { status: 401 });
    const rota = `${opcoes.method ?? "GET"} ${u.pathname}`;
    if (rota === "GET /instance/status") {
      const ok = !desconectados.has(token);
      return Response.json({ instance: { status: ok ? "connected" : "disconnected" }, status: { connected: ok, loggedIn: ok, jid: `55119000000${token === "A" ? 1 : 2}@s.whatsapp.net` } });
    }
    if (rota === "POST /webhook") return Response.json({ ok: true });
    if (rota === "POST /send/text") {
      envios.push({ token, ...JSON.parse(opcoes.body) });
      return Response.json({ messageid: `msg-${token}-${envios.length}` });
    }
    return Response.json({ error: `sem rota ${rota}` }, { status: 404 });
  };
  return { envios, desconectados, restaurar: () => (globalThis.fetch = original) };
}

async function leadComMensagem(nome, numero, { tipo = "inicial", etapa = 1 } = {}) {
  await db.inserirLead({ place_id: nome, nome, nicho: "clínica", cidade: "Osasco", endereco: null,
                         telefone: null, site: null, maps_url: null, avaliacao: null, total_avaliacoes: null });
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.nome === nome);
  await db.atualizarLead(lead.id, { whatsapp: numero, status: "analisado", oportunidades: "[]" });
  return mensagem(lead.id, numero, { tipo, etapa });
}

async function mensagem(leadId, numero, { tipo = "resposta", etapa = 0 } = {}) {
  const id = await db.criarMensagem({ lead_id: leadId, canal: "whatsapp", destino: numero, corpo: `Oi (${tipo})`, status: "aprovada", tipo, etapa });
  return db.buscarMensagem(id);
}

test("vários números: as empresas novas se dividem e cada conversa fica no seu número", async () => {
  const falsa = uazapFalsa();
  try {
    const um = await uazap.salvarNumero({ nome: "IA 1", url: URL_UAZAP, token: "A" });
    const dois = await uazap.salvarNumero({ nome: "IA 2", token: "B" }); // a Server URL vem do primeiro
    assert.equal(um.id, uazap.PRINCIPAL);
    assert.notEqual(dois.id, um.id);
    assert.equal(dois.url, URL_UAZAP);
    await assert.rejects(uazap.salvarNumero({ nome: "Repetido", url: URL_UAZAP, token: "A" }), /já está na lista/);
    await assert.rejects(uazap.salvarNumero({ nome: "Errado", url: URL_UAZAP, token: "X" }), /recusou o token/);

    assert.equal(await pipeline.modoWhatsapp(), "uazap");
    // A meta (1 por dia) vale por número: com dois conectados, 2 empresas novas hoje.
    assert.equal(await pipeline.limiteDoDia(campanha, "whatsapp"), 2);

    const r1 = await pipeline.enviarMensagem(await leadComMensagem("Clínica 1", "5511988880001"), campanha);
    const r2 = await pipeline.enviarMensagem(await leadComMensagem("Clínica 2", "5511988880002"), campanha);
    assert.deepEqual([r1.enviada, r2.enviada], [true, true]);
    assert.deepEqual(falsa.envios.map((e) => e.token), ["A", "B"]);
    const [l1, l2] = await Promise.all(["Clínica 1", "Clínica 2"].map(async (n) => (await db.leadsPorStatus("contatado")).find((l) => l.nome === n)));
    assert.deepEqual([l1.numero_wa, l2.numero_wa], [um.id, dois.id]);
    assert.equal(await db.enviadasHoje("whatsapp", { primeiroContato: true, numero: dois.id }), 1);

    // Os dois números já usaram a meta de hoje: a terceira empresa espera na fila.
    const r3 = await pipeline.enviarMensagem(await leadComMensagem("Clínica 3", "5511988880003"), campanha);
    assert.equal(r3.naFila, true);
    assert.equal(falsa.envios.length, 2);

    // A resposta da conversa sai pelo número que já fala com a empresa (não conta na meta).
    assert.equal((await pipeline.enviarMensagem(await mensagem(l2.id, "5511988880002"), campanha)).enviada, true);
    assert.equal(falsa.envios.at(-1).token, "B");

    // Número da conversa caiu: ela espera por ele em vez de trocar de número.
    falsa.desconectados.add("B");
    uazap.esquecerConexao(dois.id);
    const parada = await pipeline.enviarMensagem(await mensagem(l2.id, "5511988880002"), campanha);
    assert.equal(parada.naFila, true);
    assert.match(parada.motivo, /"IA 2" está desconectado/);
    assert.equal(await pipeline.limiteDoDia(campanha, "whatsapp"), 1);

    // Cada número tem o próprio webhook.
    assert.equal((await uazap.webhookValido(um.segredoWebhook, { token: "A" }))?.id, um.id);
    assert.equal((await uazap.webhookValido(dois.segredoWebhook, { token: "B" }))?.id, dois.id);
    assert.equal(await uazap.webhookValido(dois.segredoWebhook, { token: "A" }), null);

    // Tirar o número da lista: a conversa dele passa a sair por outro conectado.
    await uazap.removerNumero(dois.id);
    assert.deepEqual((await uazap.numeros()).map((n) => n.nome), ["IA 1"]);
    const mudou = await pipeline.numeroParaEnviar(await mensagem(l2.id, "5511988880002"), campanha);
    assert.equal(mudou.numero.id, um.id);
  } finally {
    falsa.restaurar();
  }
});
