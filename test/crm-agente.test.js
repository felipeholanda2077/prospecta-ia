import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.PAINEL_SENHA = "senha-de-teste";
process.env.PAINEL_USUARIO = "teste";
process.env.NOTIFICAR_EMAIL = " ";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN"]) delete process.env[k];
const db = await import("../src/db.js");
const { app } = await import("../src/app.js");

await db.iniciar();
// Um número na UAZap (gravado antes de o sistema ler a lista, que fica guardada por 30 s).
await db.gravarConfig("uazap", { numeros: [{ id: "rastreio", nome: "Rastreio", url: "https://x.uazapi.com", token: "B", segredoWebhook: "s2" }] });

async function comServidor(fazer) {
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const chamar = (caminho, { cookie, metodo = "GET", corpo } = {}) => fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { ...(cookie ? { cookie } : {}), ...(corpo ? { "Content-Type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const entrar = async (rota, usuario, senha) => {
    const r = await chamar(rota, { metodo: "POST", corpo: { usuario, senha } });
    return r.ok ? r.headers.get("set-cookie").split(";")[0] : null;
  };
  try {
    return await fazer({ chamar, entrar });
  } finally {
    servidor.close();
  }
}

/** Uma conversa de agente com uma mensagem do cliente. */
async function conversa(agenteId, nome, whatsapp) {
  const id = await db.criarLeadDeContato({ nome, whatsapp, origem: "agente" });
  await db.atualizarLead(id, { agente_id: agenteId });
  await db.criarResposta({ lead_id: id, canal: "whatsapp", origem_id: `o-${id}`, de: whatsapp, texto: `Oi, sou ${nome}`, classificacao: "outro", resumo: "oi" });
  return id;
}

test("crm do agente: login próprio, só as conversas do agente, e remover o login derruba a sessão", async () => {
  const bruno = await db.criarAgente({ nome: "Bruno", prompt: "p", conhecimento: "", numeros: [], ligado: false, delegar_modo: "mensagem", max_respostas: 40 });
  const outro = await db.criarAgente({ nome: "Outro", prompt: "p", conhecimento: "", numeros: [], ligado: false, delegar_modo: "mensagem", max_respostas: 40 });
  const doBruno = await conversa(bruno, "Carlos", "5511977776666");
  const doOutro = await conversa(outro, "Dora", "5511955554444");

  await comServidor(async ({ chamar, entrar }) => {
    const admin = await entrar("/api/login", "teste", "senha-de-teste");
    // Sem login, nada do CRM abre.
    assert.equal((await chamar("/api/crm/conversas")).status, 401);
    // O admin cria o login do CRM do Bruno (regras de usuário e senha).
    assert.equal((await chamar(`/api/agentes/${bruno}/acessos`, { cookie: admin, metodo: "POST", corpo: { usuario: "a b", senha: "12345678" } })).status, 400);
    assert.equal((await chamar(`/api/agentes/${bruno}/acessos`, { cookie: admin, metodo: "POST", corpo: { usuario: "ana", senha: "curta" } })).status, 400);
    const criado = await (await chamar(`/api/agentes/${bruno}/acessos`, { cookie: admin, metodo: "POST", corpo: { nome: "Ana", usuario: "Ana.Rastreio", senha: "senha-da-ana" } })).json();
    assert.equal(criado.acessos[0].usuario, "ana.rastreio");
    assert.equal(criado.acessos[0].resumo, undefined); // a senha nunca volta para o painel
    assert.equal((await chamar(`/api/agentes/${outro}/acessos`, { cookie: admin, metodo: "POST", corpo: { usuario: "ana.rastreio", senha: "outra-senha" } })).status, 400);

    // O login do CRM não abre o painel do admin, e a senha errada não entra.
    assert.equal(await entrar("/api/login", "ana.rastreio", "senha-da-ana"), null);
    assert.equal(await entrar("/api/crm/login", "ana.rastreio", "errada"), null);
    const ana = await entrar("/api/crm/login", "ana.rastreio", "senha-da-ana");
    assert.ok(ana);
    assert.equal((await chamar("/api/agentes", { cookie: ana })).status, 401);
    assert.equal((await chamar("/api/conversas", { cookie: ana })).status, 401);

    const eu = await (await chamar("/api/crm/eu", { cookie: ana })).json();
    assert.equal(eu.agente, "Bruno");
    assert.equal(eu.semBase, true);
    const lista = await (await chamar("/api/crm/conversas", { cookie: ana })).json();
    assert.deepEqual(lista.conversas.map((c) => c.id), [doBruno]);
    assert.equal(lista.numeros.conversas, 1);
    assert.equal((await chamar(`/api/crm/conversas/${doOutro}`, { cookie: ana })).status, 400); // conversa de outro agente
    const aberta = await (await chamar(`/api/crm/conversas/${doBruno}`, { cookie: ana })).json();
    assert.equal(aberta.mensagens[0].texto, "Oi, sou Carlos");
    assert.equal(aberta.lead.token, undefined);

    // Assumir para o agente; marcar como fechada; cuidar da base.
    assert.equal((await chamar(`/api/crm/conversas/${doBruno}/assumir`, { cookie: ana, metodo: "POST" })).status, 200);
    assert.match((await db.lerEstado(`ia_pausada:${doBruno}`)) ?? "", /Ana assumiu/);
    assert.equal((await chamar(`/api/crm/conversas/${doOutro}/fechou`, { cookie: ana, metodo: "POST", corpo: { fechou: true } })).status, 400);
    await chamar(`/api/crm/conversas/${doBruno}/fechou`, { cookie: ana, metodo: "POST", corpo: { fechou: true } });
    assert.equal((await db.buscarLead(doBruno)).status, "fechado");
    await chamar("/api/crm/base", { cookie: ana, metodo: "PUT", corpo: { conhecimento: "Plano Básico: R$ 59,90" } });
    assert.equal((await db.buscarAgente(bruno)).conhecimento, "Plano Básico: R$ 59,90");
    assert.equal((await db.buscarAgente(bruno)).ligado, false); // salvar a base não liga o agente

    // Liga e desliga e perfil da IA pelo CRM: sem número, não liga; o perfil salva nome, treinamento e o que fazer ao delegar.
    const ligar = await chamar("/api/crm/ligado", { cookie: ana, metodo: "POST", corpo: { ligado: true } });
    assert.equal(ligar.status, 400);
    assert.match((await ligar.json()).erro, /número de WhatsApp/);
    const perfil = await (await chamar("/api/crm/perfil", { cookie: ana, metodo: "PUT", corpo: { nome: "Bruno", prompt: "Novo treinamento", delegar_modo: "fixa", delegar_mensagem: "Já te passo para o responsável.", max_respostas: 25 } })).json();
    assert.equal(perfil.prompt, "Novo treinamento");
    assert.equal(perfil.max_respostas, 25);
    assert.equal(perfil.avatar, "atendente"); // sem escolha, a atendente
    assert.equal((await (await chamar("/api/crm/perfil", { cookie: ana, metodo: "PUT", corpo: { avatar: "rastreio" } })).json()).avatar, "rastreio");
    assert.equal((await (await chamar("/api/crm/perfil", { cookie: ana, metodo: "PUT", corpo: { avatar: "nao-existe" } })).json()).avatar, "atendente");
    assert.equal((await db.buscarAgente(bruno)).prompt, "Novo treinamento"); // salvar só o desenho não apaga o resto
    assert.equal((await db.buscarAgente(bruno)).delegar_mensagem, "Já te passo para o responsável.");
    assert.deepEqual((await db.buscarAgente(bruno)).numeros, []); // o CRM não muda o número
    await db.atualizarAgente(bruno, { numeros: ["rastreio"] });
    assert.equal((await (await chamar("/api/crm/ligado", { cookie: ana, metodo: "POST", corpo: { ligado: true } })).json()).ligado, true);
    assert.equal((await (await chamar("/api/crm/ligado", { cookie: ana, metodo: "POST", corpo: { ligado: false } })).json()).ligado, false);

    // Cookie adulterado (outro acesso) não vale.
    const [nome, valor] = ana.split("=");
    const partes = decodeURIComponent(valor).split(".");
    partes[1] = String(Number(partes[1]) + 1);
    assert.equal((await chamar("/api/crm/eu", { cookie: `${nome}=${partes.join(".")}` })).status, 401);

    // Removido pelo admin, a sessão cai na hora.
    await chamar(`/api/agentes/${bruno}/acessos/${criado.acessos[0].id}`, { cookie: admin, metodo: "DELETE" });
    assert.equal((await chamar("/api/crm/eu", { cookie: ana })).status, 401);
  });
});

test("crm do agente: o dono cria o número do agente na UAZap, lê o QR code e o número fica com a IA; um número só por agente", async () => {
  const carla = await db.criarAgente({ nome: "Carla", prompt: "p", conhecimento: "", numeros: [], ligado: false, delegar_modo: "mensagem", max_respostas: 40 });
  const original = globalThis.fetch;
  const chamadas = [];
  let webhooks = [];
  // UAZap de mentira (o servidor de teste continua respondendo pelo fetch de verdade).
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "127.0.0.1") return original(url, opcoes);
    const rota = `${opcoes.method ?? "GET"} ${u.pathname}`;
    chamadas.push({ rota, headers: opcoes.headers ?? {}, corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
    if (u.pathname === "/instance/all") return opcoes.headers?.admintoken === "ADM" ? Response.json([]) : Response.json({ error: "x" }, { status: 401 });
    if (rota === "POST /instance/create") return Response.json({ token: "NOVO", instance: { name: "x" } });
    if (rota === "GET /instance/status") return Response.json({ instance: { status: "disconnected" }, status: { connected: false } });
    if (rota === "POST /webhook") { webhooks = [JSON.parse(opcoes.body)]; return Response.json({ ok: true }); }
    if (rota === "GET /webhook") return Response.json(webhooks);
    if (rota === "POST /instance/connect") return Response.json({ instance: { status: "connecting", qrcode: "data:image/png;base64,QR" } });
    return Response.json({ error: "rota desconhecida" }, { status: 404 });
  };
  try {
    await comServidor(async ({ chamar, entrar }) => {
      const admin = await entrar("/api/login", "teste", "senha-de-teste");
      await chamar(`/api/agentes/${carla}/acessos`, { cookie: admin, metodo: "POST", corpo: { nome: "Carla", usuario: "carla", senha: "senha-da-carla" } });
      const dona = await entrar("/api/crm/login", "carla", "senha-da-carla");

      // Sem o admin token, o CRM pede o token de uma instância.
      assert.equal((await (await chamar("/api/crm/whatsapp", { cookie: dona })).json()).criarAutomatico, false);
      // O admin salva o admin token (conferido na UAZap); token errado é recusado e nada volta para o painel.
      assert.equal((await chamar("/api/uazap/admin", { cookie: admin, metodo: "POST", corpo: { url: "https://x.uazapi.com", adminToken: "errado" } })).status, 400);
      assert.equal((await chamar("/api/uazap/admin", { cookie: admin, metodo: "POST", corpo: { url: "https://x.uazapi.com", adminToken: "ADM" } })).status, 200);
      const cfg = await (await chamar("/api/uazap/admin", { cookie: admin })).json();
      assert.deepEqual(cfg, { configurado: true, url: "https://x.uazapi.com" });
      assert.equal((await chamar("/api/uazap/admin", { cookie: dona })).status, 401); // o CRM não mexe nisso

      // A dona cria o número: instância nova, webhook apontado para o sistema, QR code na tela e o número com a IA.
      const criado = await (await chamar("/api/crm/whatsapp", { cookie: dona, metodo: "POST" })).json();
      assert.equal(criado.numero.qrcode, "data:image/png;base64,QR");
      assert.equal(criado.numero.nome, "Carla (agente)");
      assert.equal(JSON.stringify(criado).includes("NOVO"), false); // o token da instância não vai para o navegador
      const criar = chamadas.find((c) => c.rota === "POST /instance/create");
      assert.equal(criar.headers.admintoken, "ADM");
      assert.match(criar.corpo.name, /^agente-\d+-carla$/);
      assert.ok(chamadas.some((c) => c.rota === "POST /webhook" && c.headers.token === "NOVO" && /\/webhooks\/uazap\//.test(c.corpo.url)));
      assert.equal(criado.numero.webhook, true); // webhook configurado e conferido na UAZap
      const agente = await db.buscarAgente(carla);
      assert.equal(agente.numeros.length, 1);
      // Se a UAZap perder o webhook, o sistema confere e aponta de novo sozinho.
      webhooks = [];
      await db.gravarEstado(`uazap_webhook_conferido:${agente.numeros[0]}`, "");
      const antes = chamadas.filter((c) => c.rota === "POST /webhook").length;
      assert.equal((await (await chamar("/api/crm/whatsapp", { cookie: dona })).json()).numero.webhook, true);
      assert.equal(chamadas.filter((c) => c.rota === "POST /webhook").length, antes + 1);
      assert.equal(agente.ligado, false); // conectar não liga a IA sozinho

      // Um número só por agente: criar de novo é recusado, e o painel também não deixa dois números.
      const outra = await chamar("/api/crm/whatsapp", { cookie: dona, metodo: "POST" });
      assert.equal(outra.status, 400);
      assert.match((await outra.json()).erro, /um número só/);
      const doisNumeros = await chamar(`/api/agentes/${carla}`, { cookie: admin, metodo: "PUT", corpo: { numeros: [agente.numeros[0], "rastreio"] } });
      assert.equal(doisNumeros.status, 400);
      assert.equal(chamadas.filter((c) => c.rota === "POST /instance/create").length, 1);
    });
  } finally {
    globalThis.fetch = original;
  }
});
