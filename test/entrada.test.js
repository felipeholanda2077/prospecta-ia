import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA ??= "senha-de-teste";
const db = await import("../src/db.js");
const asaas = await import("../src/contratos/asaas.js");
const entrada = await import("../src/vendas/entrada.js");

const CHAVE = "$aact_hmlg_chave-falsa";
const AGORA = new Date("2026-11-20T15:00:00Z");

/** Um Asaas falso, em memória: o teste cria os pagamentos como se o cliente tivesse preenchido o link. */
function apiFalsa({ falhar = null } = {}) {
  const estado = { links: [], pagamentos: [], chamadas: [] };
  const fetchFalso = async (url, opcoes = {}) => {
    const u = new URL(url);
    const caminho = u.pathname.replace(/^\/v3/, "");
    const metodo = opcoes.method ?? "GET";
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    estado.chamadas.push({ metodo, caminho, busca: u.searchParams, corpo });
    const responde = (dados, status = 200) => new Response(JSON.stringify(dados), { status });
    if (falhar?.(metodo, caminho)) return responde({ errors: [{ description: "Recusado pelo Asaas" }] }, 400);
    if (caminho === "/customers") return responde({ data: [] });
    if (caminho === "/paymentLinks") {
      const l = { id: `link_${estado.links.length + 1}`, url: `https://sandbox.asaas.com/c/${estado.links.length + 1}`, active: true, ...corpo };
      estado.links.push(l);
      return responde(l);
    }
    if (caminho.startsWith("/paymentLinks/") && metodo === "DELETE") {
      const l = estado.links.find((x) => x.id === caminho.split("/")[2]);
      if (l) l.deleted = true;
      return responde({ deleted: true });
    }
    if (caminho === "/payments") return responde({ data: estado.pagamentos, hasMore: false });
    const p = estado.pagamentos.find((x) => x.id === caminho.split("/")[2]);
    return p ? responde(p) : responde({}, 404);
  };
  return { estado, fetchFalso };
}

const original = globalThis.fetch;
async function comApi(api, fazer) {
  globalThis.fetch = api.fetchFalso;
  try {
    return await fazer();
  } finally {
    globalThis.fetch = original;
  }
}

let n = 0;
async function preparar() {
  n += 1;
  await asaas.conectar(CHAVE);
  const leadId = await db.criarLeadDeContato({ nome: `Empresa ${n}`, whatsapp: "5511999999999" });
  const oferta = await entrada.criarOferta({ nome: "Diagnóstico", descricao: "Análise do site", valor: "197,00" });
  return { leadId, oferta };
}

beforeEach(async () => {
  await db.consultar("DELETE FROM vendas");
  await db.gravarConfig("ofertas_entrada", {});
  await db.gravarConfig("asaas", {});
});

test("oferta: exige nome e preço, e sai da lista sem apagar a venda", async () => {
  assert.match((await entrada.criarOferta({ valor: "100" })).erro, /nome/);
  assert.match((await entrada.criarOferta({ nome: "X", valor: "0" })).erro, /preço/);
  const o = await entrada.criarOferta({ nome: "  Diagnóstico   completo ", valor: "1.500,50" });
  assert.deepEqual([o.nome, o.valor], ["Diagnóstico completo", 1500.5]);
  await entrada.removerOferta(o.id);
  assert.deepEqual(await entrada.lerOfertas(), []);
});

test("link: PIX de valor fixo, um por empresa, e pedir de novo devolve o mesmo", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    const { leadId, oferta } = await preparar();
    const r = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    assert.equal(r.venda.link, "https://sandbox.asaas.com/c/1");
    assert.match(r.mensagem, /Diagnóstico \(R\$.197,00\), por PIX: https:\/\/sandbox\.asaas\.com\/c\/1$/);
    const l = api.estado.links[0];
    assert.deepEqual([l.billingType, l.chargeType, l.value, l.endDate, l.externalReference], ["PIX", "DETACHED", 197, "2026-12-20", `venda-${r.venda.id}`]);

    const de_novo = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    assert.equal(de_novo.venda.id, r.venda.id);
    assert.equal(api.estado.links.length, 1);
  });
});

test("link: sem Asaas, empresa descadastrada ou recusa do Asaas não deixam venda para trás", async () => {
  const semAsaas = await entrada.gerarLink({ leadId: 1, ofertaId: "x" }, AGORA);
  assert.match(semAsaas.erro, /Conecte o Asaas/);

  const api = apiFalsa({ falhar: (metodo, caminho) => metodo === "POST" && caminho === "/paymentLinks" });
  await comApi(api, async () => {
    const { leadId, oferta } = await preparar();
    assert.match((await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA)).erro, /Recusado pelo Asaas/);
    assert.equal((await db.listarVendas()).length, 0);

    await db.atualizarLead(leadId, { status: "descadastrado" });
    assert.match((await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA)).erro, /não receber/);
    assert.match((await entrada.gerarLink({ leadId: 999999, ofertaId: oferta.id }, AGORA)).erro, /não encontrada/);
  });
});

test("pagamento pelo aviso: empresa vira cliente, a fila é cancelada e o link sai do ar", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    const { leadId, oferta } = await preparar();
    const { venda } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    const pendente = { id: "pay_1", status: "PENDING", paymentLink: venda.asaas_link };
    api.estado.pagamentos.push(pendente);

    // Gerou o QR Code mas não pagou: nada muda.
    await entrada.processarAvisoDeVenda({ event: "PAYMENT_CREATED", payment: pendente }, AGORA);
    assert.equal((await db.buscarVenda(venda.id)).status, "aguardando");
    assert.equal((await db.buscarLead(leadId)).status, "respondeu");

    Object.assign(pendente, { status: "RECEIVED", paymentDate: "2026-11-20" });
    await entrada.processarAvisoDeVenda({ event: "PAYMENT_RECEIVED", payment: { id: "pay_1", paymentLink: venda.asaas_link } }, AGORA);
    const paga = await db.buscarVenda(venda.id);
    assert.deepEqual([paga.status, paga.pago_em, paga.asaas_cobranca], ["paga", "2026-11-20", "pay_1"]);
    assert.equal((await db.buscarLead(leadId)).status, "fechado");
    assert.equal(api.estado.links[0].deleted, true);

    const painel = await entrada.painelDeVendas(AGORA);
    assert.equal(painel.recebidoNoMes, 197);
    assert.equal(painel.vendas[0].empresa, (await db.buscarLead(leadId)).nome);

    // Aviso repetido não remove o link de novo; outro pagamento do mesmo link não troca o registrado.
    const remocoes = () => api.estado.chamadas.filter((c) => c.metodo === "DELETE").length;
    const antes = remocoes();
    await entrada.processarAvisoDeVenda({ payment: { id: "pay_1", paymentLink: venda.asaas_link } }, AGORA);
    assert.equal(remocoes(), antes);
    assert.deepEqual(await entrada.processarAvisoDeVenda({ payment: { id: "pay_2", paymentLink: venda.asaas_link } }, AGORA), { ignorado: true });
  });
});

test("aviso: dados do corpo não valem sem a leitura no Asaas, e cobrança de fora é ignorada", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    const { leadId, oferta } = await preparar();
    const { venda } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    assert.deepEqual(await entrada.processarAvisoDeVenda({ event: "PAYMENT_RECEIVED", payment: { id: "pay_x", status: "RECEIVED" } }, AGORA), { ignorado: true });
    // O corpo diz que pagou, mas o pagamento não existe no Asaas.
    assert.deepEqual(await entrada.processarAvisoDeVenda({ payment: { id: "pay_x", status: "RECEIVED", paymentLink: venda.asaas_link } }, AGORA), { ignorado: true });
    // Existe, mas é de outro link.
    api.estado.pagamentos.push({ id: "pay_y", status: "RECEIVED", paymentLink: "link_outro" });
    assert.deepEqual(await entrada.processarAvisoDeVenda({ payment: { id: "pay_y", paymentLink: venda.asaas_link } }, AGORA), { ignorado: true });
    assert.equal((await db.buscarVenda(venda.id)).status, "aguardando");
  });
});

test("conferência de cada hora: acha o pagamento cujo aviso se perdeu, e depois o estorno", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    const { leadId, oferta } = await preparar();
    const { venda } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    api.estado.pagamentos.push({ id: "pay_outro", status: "RECEIVED", paymentLink: null }, { id: "pay_1", status: "RECEIVED", clientPaymentDate: "2026-11-21", paymentLink: venda.asaas_link });

    assert.deepEqual(await entrada.conferirVendas(AGORA), { vendas: "conferidas" });
    const paga = await db.buscarVenda(venda.id);
    assert.deepEqual([paga.status, paga.pago_em], ["paga", "2026-11-21"]);
    assert.equal((await db.buscarLead(leadId)).status, "fechado");
    const consulta = api.estado.chamadas.find((c) => c.caminho === "/payments");
    assert.match(consulta.busca.get("dateCreated[ge]"), /^\d{4}-\d{2}-\d{2}$/);

    api.estado.pagamentos[1].status = "REFUNDED";
    await entrada.conferirVendas(AGORA);
    assert.equal((await db.buscarVenda(venda.id)).status, "estornada");
  });
});

test("cancelar: remove o link; link pago não cancela; depois dá para gerar outro", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    const { leadId, oferta } = await preparar();
    const { venda } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    assert.equal((await entrada.cancelarVenda(venda.id)).status, "cancelada");
    assert.equal(api.estado.links[0].deleted, true);

    const nova = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    assert.notEqual(nova.venda.id, venda.id);
    await db.atualizarVenda(nova.venda.id, { status: "paga" });
    assert.match((await entrada.cancelarVenda(nova.venda.id)).erro, /ainda não foi pago/);
  });
});

test("rota do webhook: um aviso com token válido confirma a venda", async () => {
  const api = apiFalsa();
  const { app } = await import("../src/app.js");
  const { dadosDoWebhook } = await import("../src/contratos/cobranca.js");
  const servidor = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  try {
    await comApi(api, async () => {
      const { leadId, oferta } = await preparar();
      const { venda } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
      api.estado.pagamentos.push({ id: "pay_1", status: "RECEIVED", paymentDate: "2026-11-20", paymentLink: venda.asaas_link });
      const r = await original(`http://127.0.0.1:${servidor.address().port}/webhooks/asaas`, {
        method: "POST", headers: { "Content-Type": "application/json", "asaas-access-token": (await dadosDoWebhook()).token },
        body: JSON.stringify({ event: "PAYMENT_RECEIVED", payment: { id: "pay_1", paymentLink: venda.asaas_link } }),
      });
      assert.equal(r.status, 200);
      assert.equal((await db.buscarVenda(venda.id)).status, "paga");
    });
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
});

test("sem Asaas conectado, a conferência não chama nada", async () => {
  const api = apiFalsa();
  assert.deepEqual(await comApi(api, () => entrada.conferirVendas(AGORA)), { vendas: "sem Asaas" });
  assert.equal(api.estado.chamadas.length, 0);
});
