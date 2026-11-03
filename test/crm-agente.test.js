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
