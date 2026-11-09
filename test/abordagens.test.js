import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const { escolherAbordagem, ABORDAGENS, MIN_POR_ABORDAGEM } = await import("../src/ia/abordagens.js");

test("teste A/B: primeiro equilibra as abordagens, depois usa mais a que gera interesse", () => {
  // Começo: uma rodada com várias empresas reparte entre as duas (A e B, pela dor).
  assert.deepEqual(Object.keys(ABORDAGENS), ["dor_na_pratica", "dor_custo"]);
  const contagem = {};
  const escolhidas = Array.from({ length: 6 }, () => escolherAbordagem(contagem, () => 0.5));
  for (const k of Object.keys(ABORDAGENS)) assert.equal(escolhidas.filter((e) => e === k).length, 3, k);

  // Medidas: B gerou mais interesse (mesmo respondendo menos): fica com ela na maioria das vezes...
  const medidas = () => ({
    dor_na_pratica: { contatadas: MIN_POR_ABORDAGEM, responderam: 12, interessadas: 1 },
    dor_custo: { contatadas: MIN_POR_ABORDAGEM, responderam: 8, interessadas: 4 },
    elogio: { contatadas: 200, responderam: 100, interessadas: 50 }, // antiga: fora do teste
  });
  assert.equal(escolherAbordagem(medidas(), () => 0.9), "dor_custo");
  // ...e de vez em quando a outra, para continuar medindo.
  assert.equal(escolherAbordagem(medidas(), () => 0.1), "dor_na_pratica");
});

test("teste A/B: o resultado por abordagem conta contatadas, respostas e interesse", async () => {
  const empresa = async (nome, abordagem, classificacao = null) => {
    await db.inserirLead({ place_id: nome, nome, nicho: "loja", cidade: "SP" });
    const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [nome]);
    await db.atualizarLead(l.id, { abordagem, status: "contatado" });
    const m = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: `5511${String(l.id).padStart(9, "0")}`, corpo: "Oi", tipo: "inicial", etapa: 1 });
    await db.atualizarMensagem(m, { status: "enviada", enviada_em: new Date().toISOString() });
    if (classificacao) await db.criarResposta({ lead_id: l.id, canal: "whatsapp", origem_id: `${nome}-r`, de: "x", texto: "Oi", classificacao, resumo: "x" });
  };
  await empresa("A1", "elogio", "outro");
  await empresa("A2", "elogio");
  await empresa("B1", "pergunta", "interessado");
  await empresa("C1", null, "interessado"); // de antes do teste: fica de fora
  // A primeira saiu pelo número oficial (modelo da Meta, não a mensagem da IA): fica fora do teste.
  await empresa("D1", "pergunta", "interessado");
  await db.consultar("UPDATE mensagens SET numero_wa = 'meta-1' WHERE lead_id = (SELECT id FROM leads WHERE place_id = 'D1')");
  const r = Object.fromEntries((await db.resultadoPorAbordagem()).map((x) => [x.abordagem, x]));
  assert.deepEqual(r.elogio, { abordagem: "elogio", contatadas: 2, responderam: 1, interessadas: 0 });
  assert.deepEqual(r.pergunta, { abordagem: "pergunta", contatadas: 1, responderam: 1, interessadas: 1 });
  assert.equal(Object.keys(r).length, 2);
  assert.equal((await db.funilDeConversas()).por_abordagem.length, 2);
});
