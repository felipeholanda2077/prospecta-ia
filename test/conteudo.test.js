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
  return { tema: `Tema ${escritos.length}`, gancho: "3 sinais de que seu site espanta clientes", slides: [], legenda: "Legenda",
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

test("post do dia: criado uma vez só no horário, e o dia seguinte troca o formato", async () => {
  await db.gravarConfig("conteudo", { ativo: true, horarios: [18] });
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
  assert.equal(ultimo.conteudo.gancho, "3 sinais de que seu site espanta clientes");
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
