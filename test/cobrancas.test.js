import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA ??= "senha-de-teste";
const db = await import("../src/db.js");
const contrato = await import("../src/contratos/contrato.js");
const asaas = await import("../src/contratos/asaas.js");
const cobranca = await import("../src/contratos/cobranca.js");

const CHAVE = "$aact_hmlg_chave-falsa";
const AGORA = new Date("2026-11-20T15:00:00Z");
const campanha = { empresa: { nome: "FluxDeck" }, servicos: [] };
const pedido = (id, extra = {}) => ({ contratoId: id, nome: "Cliente Teste LTDA", documento: "11222333000181", email: "cliente@exemplo.com", celular: "", valor: "500,00", parcelas: "12", vencimento: "2026-12-05", ...extra });

/** Um Asaas falso, em memória, que anota o que recebeu. */
function apiFalsa({ falhar = null } = {}) {
  const estado = { clientes: [], pagamentos: [], chamadas: [], webhooks: [] };
  const fetchFalso = async (url, opcoes = {}) => {
    const u = new URL(url);
    const caminho = u.pathname.replace(/^\/v3/, "");
    const metodo = opcoes.method ?? "GET";
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    estado.chamadas.push({ metodo, caminho, host: u.host, corpo, cabecalhos: opcoes.headers });
    const responde = (dados, status = 200) => new Response(JSON.stringify(dados), { status });
    if (falhar?.(metodo, caminho)) return responde({ errors: [{ description: "Recusado pelo Asaas" }] }, 400);
    if (caminho === "/webhooks" && metodo === "GET") return responde({ data: estado.webhooks.map(({ authToken, ...w }) => ({ ...w, hasAuthToken: Boolean(authToken) })) });
    if (caminho === "/webhooks") {
      const w = { id: `wh_${estado.webhooks.length + 1}`, ...corpo };
      estado.webhooks.push(w);
      return responde(w);
    }
    if (caminho.startsWith("/webhooks/")) {
      const w = estado.webhooks.find((x) => x.id === caminho.split("/")[2]);
      if (!w) return responde({}, 404);
      Object.assign(w, corpo);
      return responde(w);
    }
    const ref = u.searchParams.get("externalReference");
    if (caminho === "/customers" && metodo === "GET") return responde({ data: estado.clientes.filter((c) => !ref || c.externalReference === ref) });
    if (caminho === "/customers") {
      const c = { id: `cus_${estado.clientes.length + 1}`, ...corpo };
      estado.clientes.push(c);
      return responde(c);
    }
    if (caminho === "/payments" && metodo === "GET") return responde({ data: estado.pagamentos.filter((p) => p.externalReference === ref && !p.deleted) });
    if (caminho === "/payments") {
      const p = { id: `pay_${estado.pagamentos.length + 1}`, status: "PENDING", invoiceUrl: `https://sandbox.asaas.com/i/${estado.pagamentos.length + 1}`, ...corpo };
      estado.pagamentos.push(p);
      return responde(p);
    }
    const id = caminho.split("/")[2];
    const p = estado.pagamentos.find((x) => x.id === id);
    if (!p) return responde({}, 404);
    if (metodo === "DELETE") {
      p.deleted = true;
      return responde({ deleted: true, id });
    }
    return responde(p);
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
async function contratoAssinado(extra = {}) {
  n += 1;
  const c = await contrato.criarContrato({
    contratante: "Cliente Teste LTDA", documento: "11222333000181", projeto: `App ${n}`, tipoPagamento: "mensal", valorMensal: "500", meses: "12", primeiroPagamento: "2026-12-05", prazoDias: "7", ...extra,
  }, campanha);
  await db.atualizarContrato(c.id, { status: "assinado" });
  return c.id;
}

beforeEach(async () => {
  await db.consultar("DELETE FROM cobrancas");
  await db.gravarConfig("asaas", {});
  await db.destravar("cobrancas_rodada");
});

test("cobrança: a chave é conferida, fica cifrada e define o ambiente", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    assert.match((await asaas.conectar("chave-qualquer")).erro, /aact/);
    assert.deepEqual(await asaas.conectar(CHAVE), { conectado: true, trancada: false, ambiente: "sandbox" });
  });
  assert.equal(api.estado.chamadas[0].host, "api-sandbox.asaas.com");
  assert.ok(!JSON.stringify(await db.lerConfig("asaas")).includes("chave-falsa"));
  assert.deepEqual(await comApi(api, () => asaas.conectar("")), { conectado: false, trancada: false, ambiente: null });

  const recusa = apiFalsa({ falhar: () => true });
  assert.equal((await comApi(recusa, () => asaas.conectar(CHAVE))).erro, "Recusado pelo Asaas");
  assert.equal((await asaas.situacao()).conectado, false);
  assert.equal(asaas.ambienteDaChave("$aact_prod_x"), "producao");
});

test("asaas: chave e token trancados pela troca da senha do painel pedem para colar de novo", async () => {
  // Cifrado com outra senha: não abre com a de agora.
  await db.gravarConfig("asaas", { chave: "AAAA.BBBB.CCCC", ambiente: "producao" });
  assert.deepEqual(await asaas.situacao(), { conectado: false, trancada: true, ambiente: null });
  const r = await cobranca.gerarCobrancas({ contratoId: 999999 });
  assert.equal(r.erro, "Contrato não encontrado"); // o contrato é conferido antes
  await assert.rejects(asaas.garantirCliente({ referencia: "x", nome: "X", documento: "1", email: "a@b.c" }), /senha do painel \(PAINEL_SENHA\) mudou/);

  await db.gravarConfig("asaas_webhook", { token: "AAAA.BBBB.CCCC" });
  const w = await cobranca.dadosDoWebhook();
  assert.equal(w.faltaColar, true);
  assert.match(w.token, /^[0-9a-f]{64}$/);
  // Lido de novo, o token novo continua o mesmo, e o aviso some depois do primeiro aviso aceito.
  assert.equal((await cobranca.dadosDoWebhook()).token, w.token);
  await cobranca.registrarAviso(new Date(Date.now() + 1000));
  assert.equal((await cobranca.dadosDoWebhook()).faltaColar, false);
  assert.equal(await asaas.tokenValido(w.token), true);
  await db.gravarConfig("asaas", {});
});

test("asaas: o sistema cadastra o webhook no Asaas com o próprio token, sem ninguém colar nada", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    // Já existe um "Prospecta IA" com o token antigo e a fila parada: é atualizado, não duplicado.
    api.estado.webhooks.push({ id: "wh_antigo", name: "Prospecta IA", url: "https://velho.example.com/webhooks/asaas", enabled: false, interrupted: true, authToken: "antigo".repeat(6), events: ["PAYMENT_RECEIVED"] });
    const w = await cobranca.configurarWebhookNoAsaas();
    assert.equal(api.estado.webhooks.length, 1);
    const [cadastrado] = api.estado.webhooks;
    assert.equal(cadastrado.authToken, w.token);
    assert.equal(cadastrado.url, w.url);
    assert.deepEqual([cadastrado.enabled, cadastrado.interrupted], [true, false]);
    assert.ok(asaas.EVENTOS_DO_WEBHOOK.every((e) => cadastrado.events.includes(e)));
    assert.ok(w.configuradoEm);
    assert.equal(w.faltaColar, false);

    // Trocar o token grava o novo lá também; sem webhook nenhum, cria um.
    const trocado = await cobranca.configurarWebhookNoAsaas({ novo: true });
    assert.notEqual(trocado.token, w.token);
    assert.equal(api.estado.webhooks[0].authToken, trocado.token);
    api.estado.webhooks.length = 0;
    await cobranca.configurarWebhookNoAsaas();
    assert.equal(api.estado.webhooks[0].name, "Prospecta IA");
    assert.equal(await asaas.tokenValido(api.estado.webhooks[0].authToken), true);
  });
});

test("cobrança: dia 31 cai no último dia dos meses curtos", () => {
  assert.deepEqual(cobranca.datasDasParcelas({ dia: 31, mes: 0, ano: 2027 }, 4), ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  assert.deepEqual(cobranca.datasDasParcelas({ dia: 5, mes: 11, ano: 2026 }, 2), ["2026-12-05", "2027-01-05"]);
});

test("cobrança: os campos vêm do texto do contrato", async () => {
  const p = await cobranca.padroesDaCobranca(await contratoAssinado({ email: "cliente@exemplo.com" }));
  assert.equal(p.documento, "11.222.333/0001-81");
  assert.equal(p.email, "cliente@exemplo.com");
  assert.deepEqual([p.valor, p.parcelas, p.vencimento, p.multa, p.juros], [500, 12, "2026-12-05", 2, 1]);
  const semData = await cobranca.padroesDaCobranca(await contratoAssinado({ tipoPagamento: "entrada", entrada: "1000", saldo: "500" }));
  assert.deepEqual([semData.valor, semData.parcelas, semData.vencimento], [null, 1, ""]);
});

test("cobrança: só parcela de contrato assinado, com dados que permitem avisar o cliente", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    const id = await contratoAssinado();
    assert.match((await cobranca.gerarCobrancas(pedido(id), AGORA)).erro, /Conecte o Asaas/);
    await asaas.conectar(CHAVE);
    await db.atualizarContrato(id, { status: "enviado" });
    assert.match((await cobranca.gerarCobrancas(pedido(id), AGORA)).erro, /assinado/);
    await db.atualizarContrato(id, { status: "assinado" });
    assert.match((await cobranca.gerarCobrancas(pedido(id, { email: "", celular: "" }), AGORA)).erro, /e-mail ou o celular/);
    assert.match((await cobranca.gerarCobrancas(pedido(id, { documento: "123" }), AGORA)).erro, /CNPJ ou CPF/);
    assert.match((await cobranca.gerarCobrancas(pedido(id, { vencimento: "2026-11-19" }), AGORA)).erro, /passado/);
  });
  assert.equal(api.estado.pagamentos.length, 0);
  assert.equal((await db.listarCobrancas()).length, 0);
});

test("cobrança: 12 parcelas, e só a que vence em 15 dias vai para o Asaas", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    const { parcelas } = await cobranca.gerarCobrancas(pedido(id), AGORA);
    assert.equal(parcelas.length, 12);
    assert.deepEqual(parcelas.map((p) => p.status), ["emitida", ...Array(11).fill("agendada")]);
    assert.equal(parcelas[0].link, "https://sandbox.asaas.com/i/1");
    assert.equal(parcelas.at(-1).vencimento, "2027-11-05");

    assert.equal(api.estado.pagamentos.length, 1);
    const p = api.estado.pagamentos[0];
    assert.deepEqual([p.billingType, p.value, p.dueDate, p.fine.value, p.fine.type, p.interest.value], ["UNDEFINED", 500, "2026-12-05", 2, "PERCENTAGE", 1]);
    assert.match(p.description, /parcela 1 de 12/);
    assert.equal(api.estado.clientes[0].cpfCnpj, "11222333000181");
    assert.ok(api.estado.chamadas.every((c) => c.cabecalhos["User-Agent"] && c.cabecalhos.access_token === CHAVE));

    // A rodada seguinte não repete; a próxima parcela só sai quando entra na janela.
    await cobranca.rodadaDeCobrancas(AGORA);
    assert.equal(api.estado.pagamentos.length, 1);
    await cobranca.rodadaDeCobrancas(new Date("2026-12-21T15:00:00Z"));
    assert.equal(api.estado.pagamentos.length, 2);
    assert.equal(api.estado.pagamentos[1].dueDate, "2027-01-05");

    // Repetir o pedido não cobra duas vezes.
    assert.match((await cobranca.gerarCobrancas(pedido(id), AGORA)).erro, /05\/12\/2026/);
    assert.equal(api.estado.clientes.length, 1);
  });
});

test("cobrança: se a resposta da emissão se perdeu, não cria outra", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    await cobranca.gerarCobrancas(pedido(id, { parcelas: "1" }), AGORA);
    const [p] = await db.listarCobrancas({ contratoId: id });
    await db.atualizarCobranca(p.id, { status: "agendada", asaas_id: null, link: null });
    await cobranca.rodadaDeCobrancas(AGORA);
    assert.equal(api.estado.pagamentos.length, 1);
    const [depois] = await db.listarCobrancas({ contratoId: id });
    assert.deepEqual([depois.status, depois.asaas_id], ["emitida", "pay_1"]);
  });
});

test("cobrança: erro do Asaas fica na parcela, e ela sai na rodada seguinte", async () => {
  let recusar = true;
  const api = apiFalsa({ falhar: (metodo, caminho) => recusar && metodo === "POST" && caminho === "/payments" });
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    const { parcelas } = await cobranca.gerarCobrancas(pedido(id, { parcelas: "1" }), AGORA);
    assert.deepEqual([parcelas[0].status, parcelas[0].erro], ["agendada", "Recusado pelo Asaas"]);
    recusar = false;
    await cobranca.rodadaDeCobrancas(AGORA);
    const [p] = await db.listarCobrancas({ contratoId: id });
    assert.deepEqual([p.status, p.erro], ["emitida", null]);
  });
});

test("cobrança: não emite vencida nem de contrato que deixou de estar assinado", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    await cobranca.gerarCobrancas(pedido(id, { vencimento: "2027-02-05", parcelas: "2" }), AGORA);
    await db.atualizarContrato(id, { status: "enviado" });
    await cobranca.rodadaDeCobrancas(new Date("2027-02-01T15:00:00Z"));
    assert.equal(api.estado.pagamentos.length, 0);

    await db.atualizarContrato(id, { status: "assinado" });
    await cobranca.rodadaDeCobrancas(new Date("2027-02-18T15:00:00Z"));
    assert.deepEqual(api.estado.pagamentos.map((p) => p.dueDate), ["2027-03-05"]);
    const [vencida] = await db.listarCobrancas({ contratoId: id });
    assert.match(vencida.erro, /vencimento passou/);
    assert.equal(vencida.status, "agendada");
  });
});

test("cobrança: pagamento, atraso, estorno e remoção aparecem no painel", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    await cobranca.gerarCobrancas(pedido(id, { vencimento: "2026-11-25", parcelas: "2" }), AGORA);
    await cobranca.rodadaDeCobrancas(new Date("2026-12-12T15:00:00Z"));
    const [a, b] = api.estado.pagamentos;

    Object.assign(a, { status: "RECEIVED", clientPaymentDate: "2026-12-12" });
    b.status = "OVERDUE";
    await cobranca.rodadaDeCobrancas(new Date("2026-12-27T15:00:00Z"));
    let painel = await cobranca.painelDeCobrancas(new Date("2026-12-27T15:00:00Z"));
    assert.deepEqual(painel.parcelas.map((p) => p.status), ["paga", "atrasada"]);
    assert.deepEqual(painel.resumo, { recebidoNoMes: 500, aReceber: 0, emAtraso: 500 });

    a.status = "REFUNDED";
    b.deleted = true;
    await cobranca.rodadaDeCobrancas(new Date("2026-12-27T16:00:00Z"));
    painel = await cobranca.painelDeCobrancas(new Date("2026-12-27T16:00:00Z"));
    assert.deepEqual(painel.parcelas.map((p) => p.status), ["estornada", "cancelada"]);
    assert.deepEqual(painel.resumo, { recebidoNoMes: 0, aReceber: 0, emAtraso: 0 });
  });
});

test("cobrança: cancelar remove do Asaas; paga não cancela; contrato cancelado limpa o que está aberto", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    await cobranca.gerarCobrancas(pedido(id, { vencimento: "2026-11-25", parcelas: "3" }), AGORA);
    const [paga] = await db.listarCobrancas({ contratoId: id });
    api.estado.pagamentos[0].status = "RECEIVED";
    await cobranca.rodadaDeCobrancas(AGORA);
    assert.match((await cobranca.cancelarCobranca(paga.id)).erro, /reembolso/);

    await cobranca.rodadaDeCobrancas(new Date("2026-12-12T15:00:00Z"));
    assert.deepEqual(await cobranca.cancelarCobrancasDoContrato(id), { canceladas: 2, falhas: 0 });
    assert.deepEqual((await db.listarCobrancas({ contratoId: id })).map((p) => p.status), ["paga", "cancelada", "cancelada"]);
    assert.equal(api.estado.pagamentos[1].deleted, true);
    assert.equal(api.estado.pagamentos.length, 2);
  });
});

/** Sobe o app de verdade e manda um aviso para a rota, com o fetch real para chegar nela. */
async function avisar(corpo, token) {
  const { app } = await import("../src/app.js");
  const servidor = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  try {
    const r = await original(`http://127.0.0.1:${servidor.address().port}/webhooks/asaas`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "asaas-access-token": token } : {}) }, body: JSON.stringify(corpo),
    });
    return r.status;
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
}

test("webhook do Asaas: o token é recusado se errado, é o mesmo até ser trocado e fica cifrado", async () => {
  const { token, url } = await cobranca.dadosDoWebhook();
  assert.ok(token.length >= 32 && token.length <= 255);
  assert.match(url, /\/webhooks\/asaas$/);
  assert.equal((await cobranca.dadosDoWebhook()).token, token);
  assert.ok(!JSON.stringify(await db.lerConfig("asaas_webhook")).includes(token));

  assert.equal(await avisar({ event: "PAYMENT_RECEIVED" }), 401);
  assert.equal(await avisar({ event: "PAYMENT_RECEIVED" }, "token-errado"), 401);
  assert.equal(await avisar({ event: "PAYMENT_RECEIVED" }, token), 200);

  const novo = (await cobranca.dadosDoWebhook({ novo: true })).token;
  assert.notEqual(novo, token);
  assert.equal(await avisar({ event: "PAYMENT_RECEIVED" }, token), 401);
  assert.ok((await cobranca.dadosDoWebhook()).ultimoAviso);
});

test("webhook do Asaas: o aviso atualiza a parcela pela situação lida na hora", async () => {
  const api = apiFalsa();
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    await cobranca.gerarCobrancas(pedido(id, { vencimento: "2026-11-25", parcelas: "1" }), AGORA);
    const pago = api.estado.pagamentos[0];
    Object.assign(pago, { status: "RECEIVED", clientPaymentDate: "2026-11-21" });
    const token = (await cobranca.dadosDoWebhook()).token;

    assert.equal(await avisar({ id: "evt_1", event: "PAYMENT_RECEIVED", payment: pago }, token), 200);
    const [p] = await db.listarCobrancas({ contratoId: id });
    assert.deepEqual([p.status, p.pago_em], ["paga", "2026-11-21"]);

    // Aviso atrasado de vencimento, com o conteúdo velho: quem vale é o que o Asaas diz agora.
    await avisar({ id: "evt_0", event: "PAYMENT_OVERDUE", payment: { ...pago, status: "OVERDUE" } }, token);
    assert.equal((await db.listarCobrancas({ contratoId: id }))[0].status, "paga");
  });
});

test("webhook do Asaas: cobrança de fora do sistema, id trocado ou Asaas fora do ar não mudam nada", async () => {
  let fora = false;
  const api = apiFalsa({ falhar: (metodo, caminho) => fora && caminho.startsWith("/payments/") });
  await comApi(api, async () => {
    await asaas.conectar(CHAVE);
    const id = await contratoAssinado();
    await cobranca.gerarCobrancas(pedido(id, { vencimento: "2026-11-25", parcelas: "1" }), AGORA);
    const [p] = await db.listarCobrancas({ contratoId: id });
    const antes = api.estado.chamadas.length;
    assert.deepEqual(await cobranca.processarAvisoDoAsaas({ payment: { id: "pay_x" } }), { ignorado: true });
    assert.deepEqual(await cobranca.processarAvisoDoAsaas({ payment: { id: "pay_x", externalReference: `parcela-${p.id}` } }), { ignorado: true });
    assert.deepEqual(await cobranca.processarAvisoDoAsaas({ event: "ACCOUNT_STATUS_UPDATED" }), { ignorado: true });
    assert.equal(api.estado.chamadas.length, antes);

    // Responde 200 para não pausar a fila; a parcela fica como estava até a próxima conferência.
    fora = true;
    const token = (await cobranca.dadosDoWebhook()).token;
    assert.equal(await avisar({ payment: { id: p.asaas_id, externalReference: `parcela-${p.id}` } }, token), 200);
    assert.equal((await db.listarCobrancas({ contratoId: id }))[0].status, "emitida");
  });
});

test("cobrança: sem Asaas conectado, a rodada não faz nada", async () => {
  const api = apiFalsa();
  assert.deepEqual(await comApi(api, () => cobranca.rodadaDeCobrancas(AGORA)), { cobrancas: "sem Asaas" });
  assert.equal(api.estado.chamadas.length, 0);
});
