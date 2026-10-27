import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const diario = await import("../src/conteudo/diario.js");
const { PILARES } = await import("../src/ia/conteudo.js");

const campanha = { empresa: { nome: "FluxDeck", diferenciais: [] }, servicos: [] };
const escritos = [];
const escrever = async ({ formato, pilar, recentes }) => {
  escritos.push({ formato, pilar, recentes });
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
});

test("post do dia: criado uma vez só no horário, e o dia seguinte troca o formato", async () => {
  const antes = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-27T15:00:00Z"), escrever });
  assert.equal(antes.conteudo, "antes do horário");

  const criado = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-27T20:45:00Z"), escrever });
  assert.equal(criado.conteudo, "criado");
  const repetido = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-27T21:00:00Z"), escrever });
  assert.equal(repetido.conteudo, "post de hoje já criado");

  await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-28T20:45:00Z"), escrever });
  assert.equal(escritos.length, 2);
  assert.notEqual(escritos[0].formato, escritos[1].formato);
  assert.deepEqual(escritos[1].recentes, ["Tema 1"]); // a IA sabe o que já foi postado

  const [ultimo] = await db.postsRecentes(1);
  assert.equal(ultimo.dia, "2026-10-28");
  assert.equal(ultimo.conteudo.gancho, "3 sinais de que seu site espanta clientes");
  await db.atualizarStatusPost(ultimo.id, "postado");
  assert.ok((await db.buscarPost(ultimo.id)).postado_em);
});

test("post do dia: desligado em Conteúdo, nada é criado", async () => {
  await db.gravarConfig("conteudo", { ativo: false, horario: 18 });
  const r = await diario.rodadaDeConteudo(campanha, { agora: new Date("2026-10-29T21:00:00Z"), escrever });
  assert.equal(r.conteudo, "desligado");
  await db.gravarConfig("conteudo", { ativo: true, horario: 18 });
});
