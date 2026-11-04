import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const diario = await import("../src/conteudo/diario.js");
const { PILARES } = await import("../src/ia/conteudo.js");

const campanha = { empresa: { nome: "FluxDeck", diferenciais: [] }, servicos: [] };
const escritos = [];
const escrever = async ({ formato, pilar, estrutura, recentes }) => {
  escritos.push({ formato, pilar, estrutura, recentes });
  // Cada post com um gancho diferente: gancho repetido faz a IA escrever de novo (há um teste só disso).
  const ganchos = ["3 sinais de que seu site espanta clientes", "Quanto cliente desiste antes de chamar?", "Pare de responder tudo na mão", "Faltou de novo na agenda?", "Planilha não é sistema", "Mito: app custa uma fortuna"];
  return { tema: `Tema ${escritos.length}`, gancho: ganchos[(escritos.length - 1) % ganchos.length], slides: [], legenda: "Legenda",
    hashtags: ["empreendedorismo"], hashtags_extras: [], audio: "", narracao: "" };
};

test("post do dia: horário em Brasília, rodízio de linhas editoriais e formato alternado", () => {
  assert.deepEqual(diario.agoraEmBrasilia(new Date("2026-10-27T20:50:00Z")), { dia: "2026-10-27", minutos: 17 * 60 + 50 });
  assert.equal(diario.horaDoPost(18, new Date("2026-10-27T20:40:00Z")), false); // 17h40
  assert.equal(diario.horaDoPost(18, new Date("2026-10-27T20:45:00Z")), true); // 17h45: pronto às 18h
  assert.notEqual(diario.pilarDoDia("2026-10-27"), diario.pilarDoDia("2026-10-28"));
  assert.notEqual(diario.pilarDoDia("2026-10-27", 0), diario.pilarDoDia("2026-10-27", 1)); // "gerar outro" muda a linha
  assert.ok(Object.keys(PILARES).includes(diario.pilarDoDia("2026-12-31")));
  assert.equal(diario.proximoFormato(null), "reels");
  assert.equal(diario.proximoFormato({ formato: "reels" }), "carrossel");
  assert.equal(diario.proximoFormato({ formato: "carrossel" }), "reels");
  // Estrutura do roteiro: muda a cada post do dia e de um dia para o outro, sem coincidir sempre com o assunto.
  assert.notEqual(diario.estruturaDoPost("2026-10-27", 0), diario.estruturaDoPost("2026-10-27", 1));
  assert.notEqual(diario.estruturaDoPost("2026-10-27", 0), diario.estruturaDoPost("2026-10-28", 0));
  const combinacoes = new Set();
  for (let d = 1; d <= 20; d++) for (const n of [0, 1]) {
    const dia = `2026-11-${String(d).padStart(2, "0")}`;
    combinacoes.add(`${diario.pilarDoDia(dia, n)}:${diario.estruturaDoPost(dia, n)}`);
  }
  assert.ok(combinacoes.size >= 30, `só ${combinacoes.size} combinações em 40 posts`);
});

test("post do dia: criado uma vez só no horário e, sem o apresentador, o dia seguinte troca o formato", async () => {
  await db.gravarConfig("conteudo", { ativo: true, horarios: [18], apresentador: false });
  const antes = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-27T15:00:00Z"), escrever });
  assert.equal(antes.conteudo, "antes do horário");

  const criado = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-27T20:45:00Z"), escrever });
  assert.equal(criado.conteudo, "criado");
  const repetido = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-27T21:00:00Z"), escrever });
  assert.equal(repetido.conteudo, "post das 18h já criado");

  await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-28T20:45:00Z"), escrever });
  assert.equal(escritos.length, 2);
  assert.notEqual(escritos[0].formato, escritos[1].formato);
  assert.notEqual(escritos[0].estrutura, escritos[1].estrutura); // o jeito de contar também muda
  assert.deepEqual(escritos[1].recentes.map((r) => r.tema), ["Tema 1"]); // a IA sabe o que já foi postado
  assert.equal(escritos[1].recentes[0].gancho, "3 sinais de que seu site espanta clientes");

  const [ultimo] = await db.postsRecentes(1);
  assert.equal(ultimo.dia, "2026-10-28");
  assert.equal(ultimo.conteudo.gancho, "Quanto cliente desiste antes de chamar?");
  await db.atualizarStatusPost(ultimo.id, "postado");
  assert.ok((await db.buscarPost(ultimo.id)).postado_em);
});

test("post do dia: desligado em Conteúdo, nada é criado", async () => {
  await db.gravarConfig("conteudo", { ativo: false, horarios: [18] });
  const r = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-29T21:00:00Z"), escrever });
  assert.equal(r.conteudo, "desligado");
  await db.gravarConfig("conteudo", { ativo: true, horarios: [18] });
});

test("post do dia: a IA recebe a base de conteúdo do site (editável no painel)", async () => {
  const { BASE_PADRAO, gravarBaseDeConteudo } = await import("../src/conteudo/base.js");
  let recebida;
  await diario.criarPostDeHoje(campanha, { escrever: async (o) => ((recebida = o.base), escrever(o)) });
  assert.equal(recebida, BASE_PADRAO);
  assert.match(recebida, /Amenai/);
  await gravarBaseDeConteudo("FluxDeck: novo texto do site");
  await diario.criarPostDeHoje(campanha, { escrever: async (o) => ((recebida = o.base), escrever(o)) });
  assert.equal(recebida, "FluxDeck: novo texto do site");
  await gravarBaseDeConteudo("");
});

test("post do dia: com o apresentador, todo post é Reels com o Felipe; a Black Friday sai uma vez por dia até 30/11", async () => {
  await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18] });
  await db.consultar("DELETE FROM posts");
  const pedidos = [];
  const escreverAnotando = async (p) => { pedidos.push(p); return escrever(p); };
  const criar = (data, opcoes = {}) => diario.criarPostDeHoje(campanha, { agora: new Date(data), escrever: escreverAnotando, fotos: async (c) => c, clipes: async (c) => c, sorteio: () => 0.5, ...opcoes });

  const primeiro = await criar("2026-11-15T14:45:00Z");
  const segundo = await criar("2026-11-15T20:45:00Z");
  assert.deepEqual([primeiro.formato, segundo.formato], ["reels", "reels"]);
  assert.deepEqual(pedidos.map((p) => p.comFelipe), [true, true]);
  assert.equal(primeiro.pilar, "black_friday");
  assert.notEqual(segundo.pilar, "black_friday");

  // Uma semana inteira: pelo menos 6 posts da campanha, um em cada dia.
  const dias = ["16", "17", "18", "19", "20", "21", "22"];
  for (const d of dias) await criar(`2026-11-${d}T14:45:00Z`);
  const daSemana = (await db.consultar("SELECT count(*)::int AS n FROM posts WHERE pilar = 'black_friday' AND dia >= '2026-11-16' AND dia <= '2026-11-22'"))[0].n;
  assert.ok(daSemana >= 6);

  // Refazer o post da campanha mantém o assunto, e descartado não conta como feito.
  const descartado = await criar("2026-11-23T14:45:00Z");
  await db.atualizarStatusPost(descartado.id, "descartado");
  assert.equal((await criar("2026-11-23T15:00:00Z")).pilar, "black_friday");
  assert.equal((await criar("2026-11-24T15:00:00Z", { pilar: "dica" })).pilar, "dica");

  assert.equal((await criar("2026-11-30T14:45:00Z")).pilar, "black_friday");
  assert.notEqual((await criar("2026-12-01T14:45:00Z")).pilar, "black_friday");
});

test("post: a tela de lista não repete o número que o desenho já mostra", async () => {
  const { tituloSemNumero } = await import("../src/ia/conteudo.js");
  assert.equal(tituloSemNumero("3. Reunião marcada"), "Reunião marcada");
  assert.equal(tituloSemNumero("1) Cliente pergunta"), "Cliente pergunta");
  assert.equal(tituloSemNumero("3 sinais de que algo vai mal"), "3 sinais de que algo vai mal");
});

test("post: valor não aparece no vídeo nem nas telas; a IA reescreve e, se insistir, ele sai", async () => {
  const { temValor, valoresNasTelas, tirarValoresDasTelas } = await import("../src/ia/conteudo.js");
  for (const t of ["de R$ 4.500 por R$ 3.000", "R$3000 por mês", "só 3.000 por mês", "três mil, 3 mil por mês", "500 reais"]) assert.ok(temValor(t), t);
  for (const t of ["3 sinais de que seu site espanta clientes", "até 30 de novembro", "em 15 dias", "24 horas por dia"]) assert.ok(!temValor(t), t);

  const comValor = { gancho: "R$ 3.000 por mês", legenda: "De R$ 4.500 por R$ 3.000 por mês.", slides: [
    { visual: "capa", titulo: "De R$ 4.500 por R$ 3.000", texto: "", destaque: "R$ 3.000", fala: "Olha só. Agora custa R$ 3.000 por mês. Vale até dia 30." },
    { visual: "cta", titulo: "Comenta BLACK", texto: "", destaque: "BLACK", fala: "Comenta BLACK." },
  ] };
  assert.ok(valoresNasTelas(comValor).length >= 3);
  const limpo = tirarValoresDasTelas(comValor);
  assert.deepEqual(valoresNasTelas(limpo), []);
  assert.match(limpo.slides[0].fala, /^Olha só\..*Vale até dia 30\.$/);
  assert.equal(limpo.slides[1].titulo, "Comenta BLACK");
  assert.match(limpo.legenda, /R\$ 3\.000/, "a legenda continua com o valor");

  await db.consultar("DELETE FROM posts");
  await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18] });
  const criar = (escrever) => diario.criarPostDeHoje(campanha, { agora: new Date("2026-11-12T14:45:00Z"), escrever, fotos: async (c) => c, clipes: async (c) => c, sorteio: () => 0.5 });
  const pedidos = [];
  const post = await criar(async (p) => {
    pedidos.push(p);
    return { ...(await escrever(p)), ...(pedidos.length === 1 ? { gancho: "Só R$ 3.000 por mês" } : {}) };
  });
  assert.equal(pedidos.length, 2);
  assert.match(pedidos[1].aviso, /sem nenhum valor/);
  assert.deepEqual(valoresNasTelas(post.conteudo), []);

  const teimosa = await criar(async (p) => ({ ...(await escrever(p)), gancho: "Só R$ 3.000 por mês" }));
  assert.deepEqual(valoresNasTelas(teimosa.conteudo), []);
});

test("post: o fundo não repete os últimos vídeos", async () => {
  const { FUNDOS, fundoDoPost } = await import("../public/post-desenho.js");
  const recentes = FUNDOS.slice(0, 5).map((f) => ({ formato: "reels", conteudo: { fundo: f.nome } }));
  for (let i = 0; i < 20; i++) {
    const { fundo } = diario.escolherVariedade(recentes, { formato: "reels", sorteio: () => i / 20 });
    assert.ok(FUNDOS.slice(5).some((f) => f.nome === fundo), fundo);
  }
  assert.equal(fundoDoPost({ conteudo: { fundo: "areia" } }).nome, "areia");
  assert.ok(fundoDoPost({ id: 13, conteudo: {} }).nome); // post antigo, sem fundo escolhido
});

test("post do dia: os memes descontraídos ganham a maior parte dos posts, com tom de meme e sem repetir o último", async () => {
  await db.gravarConfig("conteudo", { ativo: true, horarios: [12, 18] });
  await db.consultar("DELETE FROM posts");
  const pedidos = [];
  const escreverAnotando = async (p) => { pedidos.push(p); return escrever(p); };
  const criar = (data, sorteio) => diario.criarPostDeHoje(campanha, { agora: new Date(data), escrever: escreverAnotando, fotos: async (c) => c, clipes: async (c) => c, sorteio });
  await criar("2026-12-10T14:45:00Z", () => 0.1);
  await criar("2026-12-10T20:45:00Z", () => 0.1);
  const [um, dois] = pedidos;
  assert.ok(um.estrutura.startsWith("meme_") && dois.estrutura.startsWith("meme_"));
  assert.notEqual(um.estrutura, dois.estrutura);
  assert.deepEqual([um.tom, dois.tom], ["meme", "meme"]);
  await criar("2026-12-11T14:45:00Z", () => 0.9);
  assert.ok(!pedidos[2].estrutura.startsWith("meme_"));
  assert.notEqual(pedidos[2].tom, "meme");
});
