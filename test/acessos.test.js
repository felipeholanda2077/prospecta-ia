import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.PAINEL_SENHA = "senha-de-teste";
process.env.PAINEL_USUARIO = "teste";
process.env.NOTIFICAR_EMAIL = " ";
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
  const entrar = async (usuario, senha) => {
    const r = await chamar("/api/login", { metodo: "POST", corpo: { usuario, senha } });
    return r.ok ? r.headers.get("set-cookie").split(";")[0] : null;
  };
  try {
    return await fazer({ chamar, entrar });
  } finally {
    servidor.close();
  }
}

test("acessos: o admin cria outro acesso de admin, que entra com a própria senha e sai quando é removido", async () => {
  await comServidor(async ({ chamar, entrar }) => {
    const admin = await entrar("teste", "senha-de-teste");
    assert.ok(admin);

    // Regras do cadastro: usuário válido, senha com 8 ou mais caracteres e sem repetir o admin principal.
    for (const corpo of [{ nome: "K", usuario: "k k", senha: "12345678" }, { nome: "K", usuario: "kaique", senha: "curta" }, { nome: "K", usuario: "Teste", senha: "12345678" }]) {
      assert.equal((await chamar("/api/acessos", { cookie: admin, metodo: "POST", corpo })).status, 400);
    }
    const criado = await chamar("/api/acessos", { cookie: admin, metodo: "POST", corpo: { nome: "Kaique", usuario: " Kaique ", senha: "senha-do-kaique" } });
    assert.deepEqual((await criado.json()).acesso.usuario, "kaique");
    assert.equal((await chamar("/api/acessos", { cookie: admin, metodo: "POST", corpo: { nome: "Outro", usuario: "kaique", senha: "outra-senha" } })).status, 400);

    // A senha não sai na lista, nem como resumo.
    const lista = await (await chamar("/api/acessos", { cookie: admin })).json();
    assert.deepEqual(lista.acessos.map((a) => Object.keys(a).sort()), [["criado", "nome", "usuario"]]);
    assert.equal(lista.principal, "teste");

    assert.equal(await entrar("kaique", "senha-errada"), null);
    const kaique = await entrar("KAIQUE", "senha-do-kaique");
    assert.ok(kaique);
    assert.equal((await chamar("/api/sessao", { cookie: kaique })).status, 200);
    // Ninguém remove o próprio acesso.
    assert.equal((await chamar("/api/acessos/kaique", { cookie: kaique, metodo: "DELETE" })).status, 400);

    // Removido, a sessão dele para de valer e a senha não entra mais; a do admin continua.
    assert.equal((await chamar("/api/acessos/kaique", { cookie: admin, metodo: "DELETE" })).status, 200);
    assert.equal((await chamar("/api/sessao", { cookie: kaique })).status, 401);
    assert.equal(await entrar("kaique", "senha-do-kaique"), null);
    assert.equal((await chamar("/api/sessao", { cookie: admin })).status, 200);

    // Sessão adulterada (outro usuário no cookie) não passa.
    const [expira, , versao, assinatura] = kaique.split("=")[1].split(".");
    const falsa = `${kaique.split("=")[0]}=${expira}.${Buffer.from("teste").toString("base64url")}.${versao}.${assinatura}`;
    assert.equal((await chamar("/api/sessao", { cookie: falsa })).status, 401);
  });
});
