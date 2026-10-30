import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA = "senha-de-teste";
process.env.PAINEL_USUARIO = "teste";
const db = await import("../src/db.js");
const forn = await import("../src/descoberta/fornecedores.js");
await db.iniciar();

const pagina = (texto, extra = {}) => ({ ok: true, url: extra.url ?? "https://site.com.br/", titulo: extra.titulo ?? "Site", texto, emails: extra.emails ?? [], whatsapp: extra.whatsapp ?? null, instagram: null });

test("fornecedores: a lista inicial filtra pelo segmento, sem perder as plataformas", () => {
  const pet = forn.daListaInicial("pet").map((f) => f.nome);
  assert.ok(pet.includes("Mais Que Distribuidora") && pet.includes("Dropi"));
  assert.ok(!pet.includes("Revenda de Calçados"));
  assert.ok(forn.daListaInicial("Calçados").some((f) => f.nome === "Revenda de Calçados"));
  assert.ok(forn.daListaInicial("").length >= 20);
  for (const f of forn.daListaInicial("")) assert.ok(forn.siteValido(f.site), f.nome);
});

test("fornecedores: link perigoso nunca vira endereço, e a chave não repete a mesma empresa", () => {
  assert.equal(forn.siteValido("javascript:alert(1)"), null);
  assert.equal(forn.siteValido("data:text/html,x"), null);
  assert.equal(forn.siteValido("empresa.com.br"), "https://empresa.com.br/");
  assert.equal(forn.chaveDoFornecedor({ site: "https://www.loja.com.br/x", nome: "A" }), "loja.com.br");
  assert.equal(forn.chaveDoFornecedor({ site: "https://instagram.com/loja", instagram: "loja", nome: "A" }), "ig:loja");
  assert.equal(forn.chaveDoFornecedor({ cnpj: "123", nome: "A" }), "cnpj:123");
  assert.equal(forn.chaveDoFornecedor({ nome: "Fábrica São João" }), "nome:fabrica-sao-joao");
});

test("fornecedores: só confirma quando o próprio site comprova, e curso ou blog fica de fora", () => {
  const site = pagina("Somos distribuidores. Oferecemos dropshipping para todo o Brasil, com envio em 2 dias.");
  const trecho = "Oferecemos dropshipping para todo o Brasil";
  assert.deepEqual(forn.veredito(site, { tipo: "fornecedor", faz_dropshipping: "sim", trecho }), { confirmacao: "confirmado", evidencia: trecho });
  // A IA "citou" algo que não está no site: não confirma.
  assert.equal(forn.veredito(site, { tipo: "fornecedor", faz_dropshipping: "sim", trecho: "Dropshipping com 10 mil produtos" }).confirmacao, "possivel");
  // O site nem fala em dropshipping: a palavra da IA não basta.
  const atacado = pagina("Vendemos no atacado para lojistas.");
  assert.equal(forn.veredito(atacado, { tipo: "fornecedor", faz_dropshipping: "sim", trecho: "Vendemos no atacado para lojistas." }).confirmacao, "possivel");
  assert.equal(forn.veredito(pagina("Curso completo de dropshipping"), { tipo: "conteudo", faz_dropshipping: "nao_diz", trecho: "" }).descartar, true);
  assert.equal(forn.veredito(pagina("Moda feminina"), { tipo: "loja_comum", faz_dropshipping: "nao_diz", trecho: "" }).descartar, true);
  // Sem a IA, quem fala em dropshipping fica como possível, com o trecho do site.
  assert.match(forn.veredito(site, undefined).evidencia, /dropshipping/);
  assert.equal(forn.veredito(site, undefined).confirmacao, "possivel");
});

test("fornecedores: tira o texto do HTML e acha os trechos", () => {
  assert.equal(forn.textoDoHtml("<style>a{}</style><script>x()</script><p>Olá&nbsp;<b>mundo</b></p>"), "Olá mundo");
  const trechos = forn.trechosDoDrop(`${"a ".repeat(200)} faça drop shipping aqui ${"b ".repeat(200)} e dropshipping ali`);
  assert.equal(trechos.length, 2);
  assert.match(trechos[0], /drop shipping/);
});

test("fornecedores: junta as fontes, não repete, confirma pelo site, e a falha de uma fonte só avisa", async () => {
  const lidos = [];
  const ler = async (url) => {
    lidos.push(url);
    if (url.includes("dropdistribuidora")) return pagina("Trabalhamos com dropshipping nacional de roupas.", { url, whatsapp: "5585999998888", emails: ["contato@dropdistribuidora.com.br"] });
    if (url.includes("cursodrop")) return pagina("Curso de dropshipping do zero", { url });
    if (url.includes("atacadoze")) return pagina("Atacado de roupas para lojistas", { url });
    if (url.includes("foradoar")) return { ok: false, motivo: "o site não abriu" };
    return pagina("Plataforma", { url });
  };
  const escrever = async (sites) => sites.map((s) => {
    if (s.nome === "Drop Distribuidora") return { indice: s.indice, tipo: "fornecedor", faz_dropshipping: "sim", nichos: ["moda"], trecho: "dropshipping nacional de roupas" };
    if (s.nome === "Curso Drop") return { indice: s.indice, tipo: "conteudo", faz_dropshipping: "nao_diz", nichos: [], trecho: "" };
    return { indice: s.indice, tipo: "fornecedor", faz_dropshipping: "indicios", nichos: ["moda"], trecho: "" };
  });
  const consultas = [];
  const maps = async (consulta) => {
    consultas.push(consulta);
    return [
      { place_id: "1", nome: "Drop Distribuidora", site: "https://dropdistribuidora.com.br", telefone: null, endereco: "Fortaleza" },
      { place_id: "2", nome: "Drop Distribuidora de novo", site: "https://www.dropdistribuidora.com.br/contato", telefone: null, endereco: "Fortaleza" },
      { place_id: "3", nome: "Curso Drop", site: "https://cursodrop.com.br" },
      { place_id: "4", nome: "Atacado do Zé", site: "https://atacadoze.com.br", telefone: "+55 85 98888-7777" },
      { place_id: "5", nome: "Fora do Ar", site: "https://foradoar.com.br" },
    ];
  };
  const cnpj = async () => { throw new Error("Casa dos Dados fora do ar"); };
  const insta = async () => assert.fail("o Instagram só entra se pedir");

  const r = await forn.buscarFornecedores({ nicho: "calçados", cidade: "Fortaleza - CE", quantidade: 8 }, { maps, cnpj, insta, ler, escrever });
  assert.equal(consultas[0], "fornecedor dropshipping calçados em Fortaleza - CE");
  assert.match(r.avisos.join(), /CNPJ: Casa dos Dados fora do ar/);
  assert.equal(r.fornecedores.filter((f) => f.chave === "dropdistribuidora.com.br").length, 1);
  assert.ok(lidos.filter((u) => u.includes("dropdistribuidora")).length === 1);
  const drop = r.fornecedores.find((f) => f.chave === "dropdistribuidora.com.br");
  assert.deepEqual([drop.confirmacao, drop.whatsapp, drop.email, drop.nichos], ["confirmado", "5585999998888", "contato@dropdistribuidora.com.br", "moda"]);
  assert.equal(r.fornecedores[0].confirmacao, "confirmado"); // os confirmados vêm primeiro
  assert.equal(r.fornecedores.some((f) => f.nome === "Curso Drop"), false);
  assert.ok(r.descartados >= 1);
  const ze = r.fornecedores.find((f) => f.nome === "Atacado do Zé");
  assert.deepEqual([ze.confirmacao, ze.whatsapp], ["possivel", "5585988887777"]);
  assert.equal(r.fornecedores.find((f) => f.nome === "Fora do Ar").motivo, "o site não abriu");
  assert.ok(r.fornecedores.length <= 8);
});

test("fornecedores: sem cidade não chama o CNPJ, e sem a IA ainda devolve o resultado", async () => {
  const cnpj = async () => assert.fail("o CNPJ precisa de cidade");
  const r = await forn.buscarFornecedores({ nicho: "pet", quantidade: 5 }, {
    maps: async () => [], cnpj, ler: async (url) => pagina("Fazemos dropshipping", { url }), escrever: async () => { throw new Error("sem créditos"); },
  });
  assert.ok(r.fornecedores.length > 0);
  assert.ok(r.fornecedores.every((f) => f.confirmacao === "possivel"));
  assert.match(r.avisos.join(), /IA não conseguiu/);
  assert.match(r.avisos.join(), /CNPJ: informe/);
});

test("fornecedores: salvar limpa o que vem do navegador, não duplica e guarda a situação", async () => {
  assert.equal(forn.limparParaSalvar({ nome: "Sem chave" }), null);
  const limpo = forn.limparParaSalvar({
    chave: "a.com.br", nome: "A", site: "javascript:alert(1)", whatsapp: "abc", email: "nao-e-email", instagram: "<script>", confirmacao: "hackeado", tipo: "x", evidencia: "Faz drop", extra: 1,
  });
  assert.deepEqual([limpo.site, limpo.whatsapp, limpo.email, limpo.instagram, limpo.confirmacao, limpo.tipo, limpo.extra], [null, null, null, null, "possivel", "fornecedor", undefined]);

  const id = await db.inserirFornecedor(limpo);
  assert.ok(id);
  assert.equal(await db.inserirFornecedor(limpo), null);
  assert.deepEqual(await db.fornecedoresPorChave(["a.com.br", "b.com.br"]), { "a.com.br": id });
  await db.atualizarFornecedor(id, { status: "contatado" });
  await db.atualizarFornecedor(id, { observacao: "Prazo de 3 dias" });
  const [f] = await db.fornecedoresSalvos();
  assert.deepEqual([f.status, f.observacao, f.nome], ["contatado", "Prazo de 3 dias", "A"]);
});

test("fornecedores: ninguém salvo aqui entra no funil de prospecção", async () => {
  await db.inserirFornecedor({ chave: "c.com.br", nome: "C", confirmacao: "confirmado", site: "https://c.com.br/", whatsapp: "5585999990000" });
  assert.equal((await db.leadsPorStatus("novo")).some((l) => l.nome === "C"), false);
});

test("fornecedores: as rotas exigem login", async () => {
  const { app } = await import("../src/app.js");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/fornecedores`)).status, 401);
    assert.equal((await fetch(`${base}/api/fornecedores/buscar`, { method: "POST" })).status, 401);
    // Com login: salva, lista e muda a situação.
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: "teste", senha: "senha-de-teste" }) });
    assert.equal(login.status, 200);
    const cabecalhos = { "Content-Type": "application/json", cookie: login.headers.get("set-cookie").split(";")[0] };
    const salvar = await fetch(`${base}/api/fornecedores`, { method: "POST", headers: cabecalhos, body: JSON.stringify({ fornecedores: [{ chave: "rota.com.br", nome: "Rota", site: "https://rota.com.br/", confirmacao: "confirmado" }, { nome: "Sem chave" }] }) });
    assert.deepEqual(await salvar.json(), { novos: 1 });
    const lista = await (await fetch(`${base}/api/fornecedores`, { headers: cabecalhos })).json();
    const rota = lista.find((f) => f.chave === "rota.com.br");
    assert.equal(rota.status, "novo");
    assert.equal((await fetch(`${base}/api/fornecedores/${rota.id}`, { method: "PUT", headers: cabecalhos, body: JSON.stringify({ status: "qualquer" }) })).status, 400);
    assert.equal((await fetch(`${base}/api/fornecedores/${rota.id}`, { method: "PUT", headers: cabecalhos, body: JSON.stringify({ status: "aprovado" }) })).status, 200);
    assert.equal((await (await fetch(`${base}/api/fornecedores`, { headers: cabecalhos })).json()).find((f) => f.id === rota.id).status, "aprovado");
  } finally {
    servidor.close();
  }
});
