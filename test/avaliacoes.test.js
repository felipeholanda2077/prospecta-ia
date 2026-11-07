import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const anuncios = await import("../src/descoberta/anuncios.js");
const av = await import("../src/analise/avaliacoes.js");
await db.iniciar();

const AGORA = new Date("2026-11-07T15:00:00Z");
const dia = (n) => new Date(+AGORA - n * 86_400_000).toISOString();
const avaliacao = (dias, nota, resposta = false) => ({ iso_date: dia(dias), rating: nota, snippet: `Avaliação de ${nota} estrelas`, ...(resposta ? { response: { iso_date: dia(dias - 1), snippet: "Obrigado!" } } : {}) });

test("avaliações: conta as recentes sem resposta e as negativas, e vira oportunidade", () => {
  const r = av.resumoDasAvaliacoes([
    avaliacao(5, 5), avaliacao(10, 2), avaliacao(20, 4, true), avaliacao(30, 5), avaliacao(60, 1), avaliacao(200, 1),
  ], AGORA);
  assert.deepEqual([r.lidas, r.recentes, r.semResposta, r.negativasSemResposta], [6, 5, 4, 2]);
  assert.equal(r.exemploNegativa, "Avaliação de 2 estrelas");
  const o = av.oportunidadeDasAvaliacoes(r);
  assert.equal(o.servico, "automacao");
  assert.match(o.motivo, /das 5 avaliações dos últimos 3 meses no Google, 4 estão sem resposta da empresa \(2 negativas\)/);
  // Empresa que responde tudo não vira oportunidade.
  assert.equal(av.oportunidadeDasAvaliacoes(av.resumoDasAvaliacoes([avaliacao(5, 5, true), avaliacao(9, 4, true)], AGORA)), null);
});

test("avaliações: só empresas do Google com avaliações bastantes, e gastando a cota das avaliações", async () => {
  assert.equal(av.ehLugarDoGoogle("ChIJN1t_tDeuEmsRUsoyG83frY4"), true);
  assert.equal(av.ehLugarDoGoogle("ad:123"), false);
  const chamadas = [];
  const antes = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    chamadas.push(Object.fromEntries(u.searchParams));
    if (u.pathname === "/account.json") return Response.json({ plan_name: "Free" });
    return Response.json({ reviews: [avaliacao(3, 1), avaliacao(4, 5), avaliacao(6, 5)] });
  };
  try {
    await anuncios.conectar({ chave: "chave-boa", limiteMensal: "250" });
    assert.equal(await av.avaliacoesDoGoogle({ place_id: "ad:1", total_avaliacoes: 50 }, { agora: AGORA }), null);
    assert.equal(await av.avaliacoesDoGoogle({ place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4", total_avaliacoes: 2 }, { agora: AGORA }), null);
    const r = await av.avaliacoesDoGoogle({ place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4", total_avaliacoes: 40 }, { agora: AGORA });
    assert.deepEqual([r.recentes, r.semResposta, r.negativasSemResposta], [3, 3, 1]);
    const busca = chamadas.find((c) => c.engine);
    assert.deepEqual([busca.engine, busca.place_id, busca.sort_by], ["google_maps_reviews", "ChIJN1t_tDeuEmsRUsoyG83frY4", "newestFirst"]);
    assert.equal(Number(await db.lerEstado("serpapi:avaliacoes:2026-11")), 1);
  } finally {
    globalThis.fetch = antes;
  }
});

test("avaliações: reclamação de não conseguir falar com a empresa vira a oportunidade mais forte", () => {
  const reclama = { iso_date: dia(400), rating: 1, snippet: "Mandei mensagem no WhatsApp e ninguém respondeu, péssimo" };
  const r = av.resumoDasAvaliacoes([reclama, avaliacao(3, 5, true), { iso_date: dia(20), rating: 2, snippet: "Comida fria" }], AGORA);
  assert.equal(r.reclamamDeAtendimento, 1);
  const o = av.oportunidadeDasAvaliacoes(r);
  assert.equal(o.peso, 11);
  assert.match(o.motivo, /1 avaliação negativa no Google reclama de demora ou de não conseguir falar com a empresa/);
});
