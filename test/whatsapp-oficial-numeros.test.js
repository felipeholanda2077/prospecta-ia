import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TEMPLATE", "WHATSAPP_TEMPLATE_IDIOMA", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "UAZAP_URL", "UAZAP_TOKEN", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const wa = await import("../src/envio/whatsapp.js");
const pipeline = await import("../src/pipeline.js");
const { extrairMensagens } = await import("../src/respostas/whatsapp.js");
await db.iniciar();

/** Meta de mentira com dois tokens: o da conexão (números 5551 e 5552) e o de outra conta (número 7771). */
function metaFalsa() {
  const chamadas = [];
  const antes = globalThis.fetch;
  const doToken = { "Bearer EAAprincipal": ["5551", "5552"], "Bearer EAAoutra": ["7771"] };
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(url);
    const auth = opcoes.headers?.Authorization;
    chamadas.push({ caminho: u.pathname, auth, corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
    const pid = u.pathname.split("/")[2];
    if (!doToken[auth]?.includes(pid)) return Response.json({ error: { code: 100, message: "Unsupported get request" } }, { status: 400 });
    if (u.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: `wamid.${pid}` }] });
    return Response.json({ display_phone_number: `+55 11 9${pid}`, verified_name: `Conta ${pid}` });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = antes) };
}

test("whatsapp oficial: vários números, cada empresa no seu, e a resposta pelo número que recebeu", async () => {
  const meta = metaFalsa();
  try {
    await assert.rejects(wa.adicionarNumero({ phoneNumberId: "5552" }), /conexão principal/);
    await wa.salvarConfig({ token: "EAAprincipal", phoneNumberId: "5551", appSecret: "s", ativo: true });
    assert.deepEqual((await wa.numerosOficiais()).map((n) => n.id), ["meta-5551"]);

    // Mesmo token (mesma conta) e outra conta com token próprio; número inexistente e repetido são recusados.
    const n2 = await wa.adicionarNumero({ nome: "Vendas 2", phoneNumberId: "55 52" });
    assert.equal(n2.id, "meta-5552");
    await assert.rejects(wa.adicionarNumero({ phoneNumberId: "7771" }), /não encontrou esse ID/);
    await wa.adicionarNumero({ phoneNumberId: "7771", token: "EAAoutra", template: "outro_template" });
    await assert.rejects(wa.adicionarNumero({ phoneNumberId: "5551" }), /já está no sistema/);
    const todos = await wa.numerosOficiais();
    assert.deepEqual(todos.map((n) => [n.id, n.nome, n.principal, n.tokenProprio]), [
      ["meta-5551", "Principal", true, false], ["meta-5552", "Vendas 2", false, false], ["meta-7771", "Conta 7771", false, true],
    ]);
    // O token de outra conta nunca volta para o painel.
    assert.equal(JSON.stringify(todos).includes("EAAoutra"), false);

    // Empresa nova vai para o número que mandou menos hoje; conversa em andamento fica no número dela.
    const lead = await db.criarLeadDeContato({ nome: "Padaria", whatsapp: "5511900001111", origem: "site" });
    assert.equal((await pipeline.numeroOficialParaEnviar({ lead_id: lead, etapa: 1, numero_wa_lead: null })).id, "meta-5551");
    assert.equal((await pipeline.numeroOficialParaEnviar({ lead_id: lead, etapa: 2, numero_wa_lead: "meta-7771" })).id, "meta-7771");
    assert.equal((await pipeline.numeroOficialParaEnviar({ lead_id: lead, tipo: "resposta", numero_wa_lead: "uazap-x" })).id, "meta-5551");

    // Cada envio usa o token, o número e o template do número escolhido.
    await wa.enviarWhatsapp({ para: "5511900001111", empresa: "Padaria", corpo: "Oi", numeroId: "meta-7771" });
    await wa.enviarTextoWhatsappOficial({ para: "5511900001111", corpo: "Oi", numeroId: "meta-5552" });
    const envios = meta.chamadas.filter((c) => c.caminho.endsWith("/messages"));
    assert.deepEqual(envios.map((c) => [c.caminho.split("/")[2], c.auth, c.corpo.template?.name ?? c.corpo.type]), [
      ["7771", "Bearer EAAoutra", "outro_template"], ["5552", "Bearer EAAprincipal", "text"],
    ]);

    // Desligado, o número sai da escolha; tirado, some da lista.
    await wa.definirNumeroAtivo("meta-7771", false);
    assert.equal((await pipeline.numeroOficialParaEnviar({ lead_id: lead, etapa: 2, numero_wa_lead: "meta-7771" })).id, "meta-5551");
    await wa.removerNumero("meta-5552");
    assert.deepEqual((await wa.numerosOficiais()).map((n) => n.id), ["meta-5551", "meta-7771"]);
    // Salvar a conexão de novo não apaga os números adicionados.
    await wa.salvarConfig({ token: "EAAprincipal", phoneNumberId: "5551" });
    assert.deepEqual((await wa.numerosOficiais()).map((n) => n.id), ["meta-5551", "meta-7771"]);
  } finally {
    meta.restaurar();
  }
});

test("whatsapp oficial: o webhook diz qual número recebeu a mensagem", () => {
  const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "5552" }, messages: [{ id: "w1", from: "5511900001111", text: { body: "Oi" } }] } }] }] };
  assert.deepEqual(extrairMensagens(payload), [{ id: "w1", de: "5511900001111", texto: "Oi", numeroId: "meta-5552" }]);
});
