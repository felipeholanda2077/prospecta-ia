import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA = "senha-de-teste";
process.env.PAINEL_USUARIO = "teste";
process.env.NOTIFICAR_EMAIL = " ";
for (const k of ["MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP", "UAZAP_URL", "UAZAP_TOKEN", "HEYGEN_API_KEY", "RUNWAY_API_KEY"]) delete process.env[k];
const db = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { montarDashboard, dashboardDoPainel, situacaoDosPosts, esquecerGuardados, SETORES } = await import("../src/dashboard.js");
const uazap = await import("../src/envio/uazap.js");
await db.iniciar();

const fetchOriginal = globalThis.fetch;

async function comServidor(fazer) {
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const login = await fetchOriginal(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: "teste", senha: "senha-de-teste" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    return await fazer({ base, ler: () => fetchOriginal(`${base}/api/dashboard`, { headers: { cookie } }) });
  } finally {
    servidor.close();
  }
}

/** Serviços de fora de mentira: responde pelo pedaço do endereço, e o que não estiver na lista nunca responde. */
function servicosDeFora(respostas) {
  const pedidos = [];
  globalThis.fetch = (url, opcoes = {}) => {
    const texto = String(url);
    pedidos.push({ url: texto, metodo: opcoes.method ?? "GET" });
    const chave = Object.keys(respostas).find((k) => texto.includes(k));
    if (chave) return Promise.resolve(Response.json(respostas[chave]));
    return new Promise((_, falhar) => opcoes.signal?.addEventListener("abort", () => falhar(new Error("cancelado"))));
  };
  return pedidos;
}

/** Salvar um número já confere com a UAZap: aqui ela aceita, e o teste liga os serviços de mentira depois. */
async function cadastrarNumero(nome, url, token = `token-${nome}`) {
  globalThis.fetch = async () => Response.json({ instance: { status: "connected" }, status: { connected: true } });
  await uazap.salvarNumero({ nome, url, token });
  globalThis.fetch = fetchOriginal;
}

async function limparServicos() {
  for (const n of await uazap.numeros()) await uazap.removerNumero(n.id);
  await db.gravarConfig("avatar", {});
}

const setor = (d, id) => d.setores.find((s) => s.id === id);
const indicador = (s, rotulo) => s.indicadores.find((i) => i.rotulo === rotulo);

beforeEach(() => esquecerGuardados());
afterEach(() => { globalThis.fetch = fetchOriginal; });

test("dashboard: sem login, não mostra nada", async () => {
  const servidor = app.listen(0);
  try {
    const r = await fetchOriginal(`http://127.0.0.1:${servidor.address().port}/api/dashboard`);
    assert.equal(r.status, 401);
  } finally {
    servidor.close();
  }
});

test("dashboard: traz todos os setores, e cada indicador leva a uma tela que existe no painel", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const views = html.slice(html.indexOf("const VIEWS = {"), html.indexOf("const NAV_INFERIOR"));
  await comServidor(async ({ ler }) => {
    const r = await ler();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const d = await r.json();
    assert.deepEqual(d.setores.map((s) => s.id), SETORES.map((s) => s.id));
    assert.deepEqual(d.setores.filter((s) => s.erro), [], "banco vazio não é erro");
    for (const s of d.setores) {
      assert.match(views, new RegExp(`\\b${s.link}:`), `setor ${s.id}`);
      for (const item of [...(s.indicadores ?? []), ...(s.servicos ?? [])]) assert.match(views, new RegExp(`\\b${item.link}:`), `${s.id}: ${item.rotulo ?? item.nome}`);
    }
    for (const a of d.atencao) assert.match(views, new RegExp(`\\b${a.link}:`), a.titulo);
  });
});

test("dashboard: um setor com erro mostra só ele como não lido, e o resto continua", async () => {
  const setores = SETORES.map((s) => (s.id === "fornecedores" ? { ...s, ler: async () => { throw new Error("banco caiu com a senha-secreta"); } } : s));
  const d = await montarDashboard({ conversasAvaliadas: async () => [], setores });
  assert.equal(setor(d, "fornecedores").erro, "Não foi possível ler");
  assert.deepEqual(setor(d, "fornecedores").indicadores, []);
  assert.ok(setor(d, "prospeccao").indicadores.length > 0);
  assert.equal(setor(d, "prospeccao").erro, undefined);
  assert.doesNotMatch(JSON.stringify(d), /senha-secreta/, "o motivo do erro fica só no registro do servidor");
});

test("dashboard: pendências em cada setor sobem para o bloco de atenção, as graves primeiro", async () => {
  const [{ id: leadId }] = await db.consultar("INSERT INTO leads (nome, nicho, cidade, token) VALUES ('Padaria Teste', 'padaria', 'Recife', 'token-padaria') RETURNING id");
  const mensagem = (status) => db.consultar("INSERT INTO mensagens (lead_id, canal, destino, corpo, status) VALUES ($1, 'email', 'a@b.com', 'oi', $2)", [leadId, status]);
  await mensagem("rascunho");
  await mensagem("erro");
  const d = await montarDashboard({ conversasAvaliadas: async () => [] });
  const prospeccao = setor(d, "prospeccao");
  assert.equal(indicador(prospeccao, "Para aprovar").valor, 1);
  assert.equal(indicador(prospeccao, "Para aprovar").tom, "atencao");
  assert.equal(indicador(prospeccao, "Com erro").valor, 1);
  assert.equal(indicador(prospeccao, "Com erro").link, "erro");
  const erro = d.atencao.find((a) => /com erro/.test(a.titulo));
  assert.equal(erro.nivel, "perigo");
  assert.equal(erro.link, "erro");
  assert.equal(d.atencao.find((a) => /para aprovar/.test(a.titulo)).link, "rascunho");
  const ordem = d.atencao.map((a) => a.nivel);
  assert.deepEqual(ordem, [...ordem].sort((a, b) => (a === "perigo" ? 0 : 1) - (b === "perigo" ? 0 : 1)), "perigo antes de atenção");
});

test("dashboard: avisa do e-mail de aviso sem destinatário válido", async () => {
  const d = await montarDashboard({ conversasAvaliadas: async () => [] });
  assert.ok(d.atencao.some((a) => /avisos por e-mail/.test(a.titulo)));
  assert.equal(setor(d, "servicos").servicos.find((s) => s.nome === "Avisos por e-mail").estado, "Sem destinatário");
});

test("dashboard: sem chave, número ou endereço de serviço na resposta", async () => {
  await db.gravarConfig("avatar", { ativo: true, chave: "chave-heygen-secreta", runwayChave: "chave-runway-secreta", avatarId: "a1", vozId: "v1" });
  await cadastrarNumero("Principal", "https://painel-secreto.uazapi.com", "token-uazap-secreto");
  servicosDeFora({ "/v3/users/me": { data: { remaining_credits: 50 } }, "/v1/organization": { creditBalance: 1000 }, "/instance/status": { instance: { status: "connected" }, status: { connected: true, loggedIn: true } } });
  await comServidor(async ({ ler }) => {
    const texto = await (await ler()).text();
    assert.doesNotMatch(texto, /secret[oa]/, "nenhum segredo nem endereço");
  });
  await limparServicos();
});

test("dashboard: serviço de fora que não responde não trava a tela", async () => {
  await db.gravarConfig("avatar", { ativo: true, chave: "h", runwayChave: "r" });
  await cadastrarNumero("Lento", "https://lento.example.com");
  servicosDeFora({});
  const inicio = Date.now();
  const d = await montarDashboard({ conversasAvaliadas: async () => [] });
  assert.ok(Date.now() - inicio < 12_000, `levou ${Date.now() - inicio} ms`);
  const lista = setor(d, "servicos").servicos;
  assert.equal(lista.find((s) => s.nome === "Avatar (HeyGen)").estado, "Não deu para conferir");
  assert.equal(lista.find((s) => s.nome === "UAZap · Lento").estado, "Sem resposta agora");
  assert.ok(!d.atencao.some((a) => /WhatsApp desconectado/.test(a.titulo)), "sem resposta não é o mesmo que desconectado");
  await limparServicos();
});

test("dashboard: número caído e crédito acabando viram aviso; os créditos ficam guardados e só leem", async () => {
  await db.gravarConfig("avatar", { ativo: true, chave: "h", runwayChave: "r" });
  await cadastrarNumero("Vendas", "https://vendas.example.com");
  const pedidos = servicosDeFora({ "/v3/users/me": { data: { billing_type: "wallet", wallet: { currency: "usd", remaining_balance: 0 } } }, "/v1/organization": { creditBalance: 150 }, "/instance/status": { instance: { status: "disconnected" }, status: { connected: false, loggedIn: false } } });
  const d = await montarDashboard({ conversasAvaliadas: async () => [] });
  const whatsapp = d.atencao.find((a) => /WhatsApp desconectado: Vendas/.test(a.titulo));
  assert.equal(whatsapp.nivel, "perigo");
  assert.equal(whatsapp.link, "automacao");
  const heygen = d.atencao.find((a) => /HeyGen sem saldo/.test(a.titulo));
  assert.match(heygen.detalhe, /Runway/);
  assert.ok(d.atencao.some((a) => /Runway com pouco saldo \(150 créditos\)/.test(a.titulo)));
  assert.ok(pedidos.filter((p) => /users\/me|organization/.test(p.url)).every((p) => p.metodo === "GET"), "conferir crédito não pode gastar crédito");

  const antes = pedidos.filter((p) => /users\/me|organization/.test(p.url)).length;
  await montarDashboard({ conversasAvaliadas: async () => [] });
  assert.equal(pedidos.filter((p) => /users\/me|organization/.test(p.url)).length, antes, "lê de novo só depois de um tempo");
  await limparServicos();
});

test("dashboard: lê um setor de cada vez (vários juntos travaram as conexões do banco em produção)", async () => {
  let lendo = 0;
  let maximo = 0;
  const setor = (id) => ({ id, nome: id, icone: "box", link: "maps", ler: async () => {
    maximo = Math.max(maximo, ++lendo);
    await new Promise((ok) => setTimeout(ok, 5));
    lendo--;
    return { indicadores: [] };
  } });
  await montarDashboard({ conversasAvaliadas: async () => [], setores: ["a", "b", "c"].map(setor) });
  assert.equal(maximo, 1);
});

test("dashboard: lê o saldo do HeyGen em cada tipo de conta", async () => {
  await db.gravarConfig("avatar", { ativo: true, chave: "h" });
  const estado = async (data) => {
    esquecerGuardados();
    servicosDeFora({ "/v3/users/me": { data } });
    const d = await montarDashboard({ conversasAvaliadas: async () => [], setores: SETORES.filter((s) => s.id === "servicos") });
    return { estado: setor(d, "servicos").servicos.find((s) => s.nome === "Avatar (HeyGen)").estado, aviso: d.atencao.find((a) => /HeyGen/.test(a.titulo))?.titulo };
  };
  assert.match((await estado({ wallet: { currency: "usd", remaining_balance: 42.5 } })).estado, /US\$\s*42,50/);
  assert.match((await estado({ wallet: { currency: "usd", remaining_balance: 1.5 } })).aviso, /pouco saldo/);
  assert.equal((await estado({ wallet: { currency: "credits", remaining_balance: 30 } })).estado, "30 créditos");
  assert.equal((await estado({ subscription: { credits: { premium_credits: { remaining: 4 }, add_on_credits: { remaining: 6 } } } })).estado, "10 créditos");
  assert.equal((await estado({ usage_based: { remaining_credits: 7 } })).estado, "7 créditos");
  assert.deepEqual(await estado({ wallet: { currency: "usd", remaining_balance: 0 } }), { estado: "Sem saldo", aviso: "HeyGen sem saldo" });
  assert.deepEqual(await estado({ email: "x" }), { estado: "Não deu para conferir", aviso: undefined }, "sem saldo informado não é o mesmo que zerado");
  await limparServicos();
});

test("dashboard: nenhuma consulta fica abandonada: um setor lento termina antes de a rota responder", async () => {
  let terminou = false;
  const lento = { id: "lento", nome: "Lento", icone: "box", link: "maps", ler: async () => {
    await new Promise((ok) => setTimeout(ok, 60));
    terminou = true;
    return { indicadores: [] };
  } };
  const depois = { id: "depois", nome: "Depois", icone: "box", link: "maps", ler: async () => ({ indicadores: [] }) };
  const d = await montarDashboard({ conversasAvaliadas: async () => [], setores: [lento, depois], orcamentoMs: 10 });
  assert.ok(terminou);
  assert.equal(setor(d, "lento").erro, undefined);
  assert.equal(setor(d, "depois").erro, "Não foi possível ler", "passou do orçamento: o que falta fica para a próxima rodada");
});

test("dashboard: várias abas abertas dividem a mesma leitura", async () => {
  let leituras = 0;
  const conversasAvaliadas = async () => { leituras++; return []; };
  const setores = [{ id: "x", nome: "X", icone: "box", link: "leads", ler: async (c) => { await c.conversas(); return { indicadores: [] }; } }];
  const [a, b] = await Promise.all([dashboardDoPainel({ conversasAvaliadas, setores }), dashboardDoPainel({ conversasAvaliadas, setores })]);
  assert.equal(a, b);
  await dashboardDoPainel({ conversasAvaliadas, setores });
  assert.equal(leituras, 1, "e quem chega logo depois recebe a mesma");
  esquecerGuardados();
  await dashboardDoPainel({ conversasAvaliadas, setores });
  assert.equal(leituras, 2);
});

test("painel: setor sem leitura não vira Tudo em dia", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /dashAtencao\(d\.atencao, d\.setores\.filter\(\(s\) => s\.erro\)\.length\)/);
});

test("posts: próximo horário, atrasados, falhos e os que não saíram", () => {
  const conf = { ativo: true, postarSozinho: true, horarios: [9, 12, 18] };
  const agora = new Date("2026-11-02T14:30:00-03:00");
  const posts = [
    { id: 1, dia: "2026-11-02", horario: 9, status: "postado", instagram_id: "m1" },
    { id: 2, dia: "2026-11-02", horario: 12, status: "pronto", instagram_erro: "A Meta recusou o vídeo", tiktok_erro: "O TikTok recusou" },
    { id: 3, dia: "2026-11-01", horario: 18, status: "pronto", instagram_erro: "Falhou" },
    { id: 4, dia: "2026-10-20", horario: 18, status: "pronto", instagram_erro: "Muito antigo" },
    { id: 5, dia: "2026-11-01", horario: 12, status: "postado", instagram_id: "m2" },
  ];
  const p = situacaoDosPosts(posts, conf, agora);
  assert.equal(p.proximo.quando, "Hoje às 18h");
  assert.equal(p.saiuHoje, 1);
  assert.deepEqual(p.atrasados, [12]);
  assert.deepEqual(p.falhosHoje.map((x) => x.id), [2]);
  assert.deepEqual(p.falhosNoTiktok.map((x) => x.id), [2]);
  assert.deepEqual(p.naoSairam.map((x) => x.id), [3, 4]);
  assert.deepEqual(p.falhosRecentes.map((x) => x.id), [3], "aviso só dos últimos dias");

  assert.equal(situacaoDosPosts([], conf, new Date("2026-11-02T20:00:00-03:00")).proximo.quando, "Amanhã às 9h");
  assert.equal(situacaoDosPosts([], { ...conf, ativo: false }, agora).proximo, null);
  assert.deepEqual(situacaoDosPosts([], { ...conf, ativo: false }, agora).atrasados, [], "desligado não atrasa");
  assert.deepEqual(situacaoDosPosts([], conf, new Date("2026-11-02T09:30:00-03:00")).atrasados, [], "ainda dentro da folga do horário");
});

test("painel: a dashboard é a primeira do menu e a tela inicial", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /const VIEWS = \{\s*dashboard:/);
  assert.match(html, /viewAtual = VIEWS\[id\] \? id : "dashboard"/);
  assert.match(html, /id="view-dashboard"/);
  // A barra de baixo do celular mostra o nome curto: sem ele, aparece "undefined".
  const nav = html.match(/const NAV_INFERIOR = \[(.*?)\]/)[1].match(/\w+/g);
  for (const id of nav) assert.match(html, new RegExp(`^\\s*${id}:\\s*\\{[^\\n]*curto:`, "m"), id);
});
