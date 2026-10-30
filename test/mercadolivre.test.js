import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.URL_PUBLICA = "https://painel.exemplo.com";
process.env.PAINEL_SENHA = "senha-de-teste";
process.env.PAINEL_USUARIO = "teste";
for (const k of ["SMTP_HOST", "MODO_TESTE_EMAIL"]) delete process.env[k];
const db = await import("../src/db.js");
const ml = await import("../src/envio/mercadolivre.js");
const vendas = await import("../src/vendas/mercadolivre.js");
const { cifrar, decifrar } = await import("../src/segredos.js");
await db.iniciar();

const AGORA = new Date("2026-11-10T12:00:00Z");
const resposta = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

/** Troca o fetch pelo do teste durante a função. */
async function comFetch(falso, fazer) {
  const original = globalThis.fetch;
  globalThis.fetch = falso;
  try {
    return await fazer();
  } finally {
    globalThis.fetch = original;
  }
}

async function conectar({ expiraEm = new Date(+AGORA + 3600_000).toISOString() } = {}) {
  await db.gravarConfig("mercadolivre", { clientId: "123", clientSecret: cifrar("segredo-do-app"), contas: ["999"] });
  await db.gravarConfig("mercadolivre_conta_999", { token: cifrar("TOKEN-1"), renovacao: cifrar("REFRESH-1"), expiraEm, vendedorId: "999", apelido: "LOJA" });
}

test("segredos: criptografa de verdade, e dado adulterado não abre", () => {
  const c = cifrar("APP_USR-abc");
  assert.doesNotMatch(c, /APP_USR/);
  assert.equal(decifrar(c), "APP_USR-abc");
  assert.notEqual(cifrar("APP_USR-abc"), c);
  assert.equal(decifrar(`${c.slice(0, -4)}AAAA`), null);
  assert.equal(decifrar("lixo"), null);
});

test("mercado livre: login confere o state, guarda os acessos criptografados e nada de segredo vai ao painel", async () => {
  await db.gravarConfig("mercadolivre", {});
  await assert.rejects(() => ml.urlDeEntrada(AGORA), /App ID/);
  await assert.rejects(() => ml.salvarApp({ clientId: "123" }), /Secret Key/);
  await ml.salvarApp({ clientId: "123", clientSecret: "segredo-do-app" });
  const url = new URL(await ml.urlDeEntrada(AGORA));
  assert.equal(url.host, "auth.mercadolivre.com.br");
  assert.equal(url.searchParams.get("redirect_uri"), "https://painel.exemplo.com/api/mercadolivre/retorno");
  const state = url.searchParams.get("state");

  await comFetch(async () => assert.fail("não chama a API com state errado"), async () => {
    await assert.rejects(() => ml.concluirEntrada({ code: "c", state: "errado" }, AGORA), /expirou/);
    await assert.rejects(() => ml.concluirEntrada({ code: "c", state }, new Date(+AGORA + 20 * 60_000)), /expirou/);
  });

  let corpoDoToken = "";
  await comFetch(async (u, o) => {
    if (String(u).endsWith("/oauth/token")) {
      corpoDoToken = String(o.body);
      return resposta({ access_token: "APP_USR-novo", refresh_token: "TG-renova", expires_in: 21600, user_id: 999 });
    }
    assert.equal(o.headers.Authorization, "Bearer APP_USR-novo"); // o acesso vai no cabeçalho, nunca na URL
    return resposta({ id: 999, nickname: "MINHALOJA" });
  }, () => ml.concluirEntrada({ code: "TG-code", state }, AGORA));
  assert.match(corpoDoToken, /grant_type=authorization_code/);
  assert.match(corpoDoToken, /client_secret=segredo-do-app/);

  const salvo = JSON.stringify([await db.lerConfig("mercadolivre"), await db.lerConfig("mercadolivre_conta_999")]);
  assert.doesNotMatch(salvo, /APP_USR-novo|TG-renova|segredo-do-app/);
  const status = await ml.statusDaConexao();
  assert.deepEqual([status.conectado, status.contas[0].apelido, status.contas[0].id], [true, "MINHALOJA", "999"]);
  assert.doesNotMatch(JSON.stringify(status), /segredo|TG-|APP_USR/);
  await assert.rejects(() => ml.concluirEntrada({ code: "x", state }, AGORA), /expirou/); // o state só vale uma vez
});

test("mercado livre: renova só perto de vencer, guarda a renovação nova e duas execuções não gastam a mesma", async () => {
  await conectar({ expiraEm: new Date(+AGORA + 60_000).toISOString() });
  let renovacoes = 0;
  const corpos = [];
  const falso = async (u, o) => {
    if (String(u).endsWith("/oauth/token")) {
      renovacoes++;
      corpos.push(String(o.body));
      await new Promise((r) => setTimeout(r, 50));
      return resposta({ access_token: "TOKEN-2", refresh_token: "REFRESH-2", expires_in: 21600 });
    }
    assert.equal(o.headers.Authorization, "Bearer TOKEN-2");
    return resposta({ questions: [] });
  };
  await comFetch(falso, () => Promise.all([ml.perguntasSemResposta("999", AGORA), ml.perguntasSemResposta("999", AGORA)]));
  assert.equal(renovacoes, 1);
  assert.match(corpos[0], /refresh_token=REFRESH-1/);
  const c = await db.lerConfig("mercadolivre_conta_999");
  assert.equal(decifrar(c.renovacao), "REFRESH-2");
  // Ainda válido: não renova.
  await comFetch(async (u) => (String(u).endsWith("/oauth/token") ? assert.fail("não renova") : resposta({ questions: [] })), () => ml.perguntasSemResposta("999", AGORA));
});

test("mercado livre: renovação recusada vira aviso claro no painel", async () => {
  await conectar({ expiraEm: new Date(+AGORA - 60_000).toISOString() });
  await comFetch(async () => resposta({ error: "invalid_grant" }, 400), () => assert.rejects(() => ml.perguntasSemResposta("999", AGORA), /venceu ou foi revogado/));
  assert.match((await ml.statusDaConexao()).contas[0].erro, /venceu ou foi revogado/);
});

test("mercado livre: resposta com contato ou lacuna não sai", () => {
  const ok = "Sim, é bivolt e tem garantia de 3 meses, como diz o anúncio.";
  assert.equal(vendas.problemaNaResposta(ok), null);
  assert.match(vendas.problemaNaResposta(""), /Escreva/);
  assert.match(vendas.problemaNaResposta("Chama no WhatsApp"), /WhatsApp/);
  assert.match(vendas.problemaNaResposta("Me liga: (85) 99999-8888"), /telefone/);
  assert.match(vendas.problemaNaResposta("Veja em minhaloja.com.br"), /link/);
  assert.match(vendas.problemaNaResposta("email: a@b.com"), /link ou e-mail/);
  assert.match(vendas.problemaNaResposta("O prazo é [COMPLETAR]"), /COMPLETAR/);
  assert.match(vendas.problemaNaResposta("x".repeat(2001)), /2000/);
  assert.equal(vendas.problemaNaResposta("Temos 20 unidades e 110 volts."), null); // número comum passa
});

function apiFalsa(perguntas) {
  const respondidas = [];
  return {
    respondidas,
    idsDasContas: async () => ["999"],
    apelidoDaLoja: async () => "LOJA DA CONTA",
    primeiroAnuncio: async () => perguntas.semAnuncio ? null : "MLB9",
    perguntasSemResposta: async () => perguntas.lista,
    dadosDoAnuncio: async (conta, id) => ({ id, titulo: `Anúncio ${id}`, link: `https://produto.mercadolivre.com.br/${id}`, preco: 50, moeda: "BRL", atributos: ["Voltagem: bivolt"], descricao: "Bivolt." }),
    responderPergunta: async (conta, id, texto) => respondidas.push([conta, id, texto]),
  };
}

test("mercado livre: pergunta nova ganha sugestão e aviso uma vez só, e nada sai sem aprovação", async () => {
  const perguntas = { lista: [{ id: 111, item_id: "MLB1", text: "É bivolt?", date_created: "2026-11-10T11:00:00Z", status: "UNANSWERED" }] };
  const api = apiFalsa(perguntas);
  const avisos = [];
  const pedidos = [];
  const escrever = async (p) => (pedidos.push(p), { texto: "Sim, é bivolt.", precisa_conferir: false, motivo: "" });
  const o = { api, escrever, avisar: async (assunto) => avisos.push(assunto), agora: AGORA };
  const campanha = { empresa: { nome: "FluxDeck" } };

  const r = await vendas.rodadaDoMercadoLivre(campanha, o);
  assert.deepEqual([r.novas, r.sugeridas], [1, 1]);
  assert.deepEqual(avisos, ["Pergunta nova no Mercado Livre"]);
  assert.equal(pedidos[0].anuncio.descricao, "Bivolt.");
  assert.equal(pedidos[0].loja, "LOJA DA CONTA"); // a loja é a conectada, não a dona do painel
  assert.equal(api.respondidas.length, 0); // a IA nunca responde sozinha
  const p = await db.perguntaML("111");
  assert.deepEqual([p.rascunho, p.status, p.item_titulo], ["Sim, é bivolt.", "pendente", "Anúncio MLB1"]);

  // Segunda passagem: não repete aviso nem sugestão.
  const r2 = await vendas.rodadaDoMercadoLivre(campanha, o);
  assert.deepEqual([r2.novas, r2.sugeridas], [0, 0]);
  assert.equal(avisos.length, 1);

  // Bloqueia envio com problema e só registra o que saiu de verdade.
  await assert.rejects(() => vendas.enviarResposta("111", "Chama no zap", o), /WhatsApp/);
  assert.equal(api.respondidas.length, 0);
  await vendas.enviarResposta("111", " Sim, é bivolt, pode comprar. ", o);
  assert.deepEqual(api.respondidas, [["999", "111", "Sim, é bivolt, pode comprar."]]);
  const enviada = await db.perguntaML("111");
  assert.deepEqual([enviada.status, enviada.resposta], ["respondida", "Sim, é bivolt, pode comprar."]);
  await assert.rejects(() => vendas.enviarResposta("111", "De novo", o), /já saiu da fila/);
  assert.equal(api.respondidas.length, 1);
});

test("mercado livre: se o envio falhar a pergunta continua na fila; respondida no site, ela sai sozinha", async () => {
  const perguntas = { lista: [{ id: 222, item_id: "MLB2", text: "Tem azul?", date_created: "2026-11-10T11:00:00Z", status: "UNANSWERED" }] };
  const api = apiFalsa(perguntas);
  const o = { api, escrever: async () => ({ texto: "O anúncio não diz [COMPLETAR]", precisa_conferir: true, motivo: "cor" }), avisar: async () => {}, agora: AGORA };
  await vendas.rodadaDoMercadoLivre({}, o);
  assert.equal((await db.perguntaML("222")).precisa_conferir, true);
  await assert.rejects(() => vendas.enviarResposta("222", "Temos sim.", { api: { ...api, responderPergunta: async () => { throw new Error("Mercado Livre: fora do ar"); } }, agora: AGORA }), /fora do ar/);
  assert.equal((await db.perguntaML("222")).status, "pendente");

  perguntas.lista = [];
  await vendas.rodadaDoMercadoLivre({}, o);
  assert.equal((await db.perguntaML("222")).status, "fora");
});

test("mercado livre: o teste lê um anúncio real e sugere, sem salvar nem enviar nada", async () => {
  const perguntas = { lista: [] };
  const api = apiFalsa(perguntas);
  const antes = (await db.perguntasML("pendente")).length;
  const t = await vendas.testarSugestao({ api, escrever: async (p) => ({ texto: `Sim: ${p.anuncio.titulo}`, precisa_conferir: true, motivo: "garantia" }), agora: AGORA });
  assert.deepEqual([t.anuncio, t.resposta, t.precisaConferir, t.barrada], ["Anúncio MLB9", "Sim: Anúncio MLB9", true, null]);
  assert.equal(api.respondidas.length, 0);
  assert.equal((await db.perguntasML("pendente")).length, antes);
  perguntas.semAnuncio = true;
  await assert.rejects(() => vendas.testarSugestao({ api, escrever: async () => assert.fail(), agora: AGORA }), /anúncio ativo/);
});

test("mercado livre: a falha da IA não derruba a rodada, e a sugestão sai na próxima", async () => {
  const perguntas = { lista: [{ id: 333, item_id: "MLB3", text: "Serve?", date_created: "2026-11-10T11:00:00Z", status: "UNANSWERED" }] };
  const api = apiFalsa(perguntas);
  const r = await vendas.rodadaDoMercadoLivre({}, { api, escrever: async () => { throw new Error("sem créditos"); }, avisar: async () => {}, agora: AGORA });
  assert.equal(r.sugeridas, 0);
  assert.equal((await db.perguntaML("333")).erro, "sem créditos");
  const r2 = await vendas.rodadaDoMercadoLivre({}, { api, escrever: async () => ({ texto: "Serve.", precisa_conferir: false, motivo: "" }), avisar: async () => {}, agora: AGORA });
  assert.equal(r2.sugeridas, 1);
  assert.equal((await db.perguntaML("333")).erro, null);
  await db.atualizarPerguntaML("333", { status: "ignorada" });
});

test("mercado livre: spam fica de fora e os pedidos não trazem dados pessoais do comprador", async () => {
  await conectar();
  await comFetch(async (u) => {
    assert.match(String(u), /seller_id=999&status=UNANSWERED/);
    return resposta({ questions: [{ id: 1, status: "UNANSWERED", text: "ok" }, { id: 2, status: "UNANSWERED", suspected_spam: true }, { id: 3, status: "UNANSWERED", deleted_from_listing: true }] });
  }, async () => assert.deepEqual((await ml.perguntasSemResposta("999", AGORA)).map((q) => q.id), [1]));

  const pedidos = await comFetch(async (u) => {
    assert.match(String(u), /orders\/search\?seller=999&sort=date_desc/);
    return resposta({ results: [{ id: 2000003508897196, status: "paid", total_amount: 50, currency_id: "BRL", date_created: "2026-11-09T10:00:00Z",
      buyer: { id: 5, nickname: "COMPRADOR1", email: "pessoa@exemplo.com", phone: { number: "999" }, first_name: "Ana" }, shipping: { id: 7, receiver_address: { street_name: "Rua X" } },
      order_items: [{ item: { id: "MLB1", title: "Camiseta" }, quantity: 2, unit_price: 25 }] }] });
  }, () => ml.pedidosRecentes("999", AGORA));
  assert.equal(pedidos[0].id, "2000003508897196");
  assert.deepEqual(pedidos[0].itens, [{ titulo: "Camiseta", quantidade: 2, preco: 25 }]);
  assert.equal(pedidos[0].comprador, "COMPRADOR1");
  assert.doesNotMatch(JSON.stringify(pedidos), /pessoa@exemplo|Rua X|Ana/);
});

test("mercado livre: as rotas exigem login, o retorno sem state não conecta e o aviso público não usa nada do corpo", async () => {
  const { app } = await import("../src/app.js");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/mercadolivre`)).status, 401);
    assert.equal((await fetch(`${base}/api/mercadolivre/perguntas/1/responder`, { method: "POST" })).status, 401);
    await db.gravarConfig("mercadolivre", { clientId: "1" });
    const volta = await fetch(`${base}/api/mercadolivre/retorno?code=x&state=y`, { redirect: "manual" });
    assert.equal(volta.status, 302);
    assert.equal((await ml.statusDaConexao()).conectado, false);
    const aviso = await fetch(`${base}/webhooks/mercadolivre`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: "orders_v2", user_id: 1 }) });
    assert.equal(aviso.status, 200);
  } finally {
    servidor.close();
  }
});

test("mercado livre: duas contas no mesmo app, cada uma com o próprio acesso, e a conexão antiga migra sozinha", async () => {
  // O formato antigo, de uma conta só.
  await db.gravarConfig("mercadolivre", { clientId: "123", clientSecret: cifrar("segredo-do-app"), token: cifrar("TOKEN-A"), renovacao: cifrar("R-A"), expiraEm: new Date(+AGORA + 3600_000).toISOString(), vendedorId: "111", apelido: "LOJA A" });
  let s = await ml.statusDaConexao();
  assert.deepEqual(s.contas.map((c) => [c.id, c.apelido]), [["111", "LOJA A"]]);
  assert.equal((await db.lerConfig("mercadolivre")).token, undefined);

  // A segunda conta entra pelo mesmo login, sem derrubar a primeira.
  const state = new URL(await ml.urlDeEntrada(AGORA)).searchParams.get("state");
  await comFetch(async (u) => (String(u).endsWith("/oauth/token")
    ? resposta({ access_token: "TOKEN-B", refresh_token: "R-B", expires_in: 21600, user_id: 222 })
    : resposta({ id: 222, nickname: "LOJA B", tags: ["user_product_seller"] })), () => ml.concluirEntrada({ code: "c", state }, AGORA));
  s = await ml.statusDaConexao();
  assert.deepEqual(s.contas.map((c) => c.apelido), ["LOJA A", "LOJA B"]);
  assert.equal(await ml.usaFamilia("222"), true);
  assert.equal(await ml.usaFamilia("111"), false);

  // Cada chamada usa o acesso da conta certa.
  const usados = {};
  await comFetch(async (u, o) => {
    usados[String(u).match(/seller_id=(\d+)/)[1]] = o.headers.Authorization;
    return resposta({ questions: [] });
  }, async () => {
    await ml.perguntasSemResposta("111", AGORA);
    await ml.perguntasSemResposta("222", AGORA);
  });
  assert.deepEqual(usados, { 111: "Bearer TOKEN-A", 222: "Bearer TOKEN-B" });

  // Desconectar uma não mexe na outra.
  await ml.desconectar("111");
  s = await ml.statusDaConexao();
  assert.deepEqual(s.contas.map((c) => c.apelido), ["LOJA B"]);
  await assert.rejects(() => ml.perguntasSemResposta("111", AGORA), /Conecte essa conta/);
});

test("mercado livre: o erro de uma conta não impede as perguntas da outra", async () => {
  const api = {
    idsDasContas: async () => ["1", "2"],
    apelidoDaLoja: async (c) => `LOJA ${c}`,
    perguntasSemResposta: async (c) => { if (c === "1") throw new Error("acesso vencido"); return [{ id: 555, item_id: "MLB5", text: "Oi?", date_created: "2026-11-10T11:00:00Z", status: "UNANSWERED" }]; },
    dadosDoAnuncio: async (c, id) => ({ id, titulo: "A", link: null, atributos: [] }),
  };
  const lojas = [];
  const r = await vendas.rodadaDoMercadoLivre({}, { api, escrever: async (p) => (lojas.push(p.loja), { texto: "Olá.", precisa_conferir: false, motivo: "" }), avisar: async () => {}, agora: AGORA });
  assert.deepEqual([r.novas, r.sugeridas, r.erros], [1, 1, ["acesso vencido"]]);
  assert.equal((await db.perguntaML("555")).conta_id, "2");
  assert.deepEqual(lojas, ["LOJA 2"]);
  await db.atualizarPerguntaML("555", { status: "ignorada" });
});
