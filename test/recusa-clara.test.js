import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const { recusouClaramente, classificarPorRegra } = await import("../src/ia/resposta.js");
const { registrarResposta, encerrarRecusasAbertas } = await import("../src/respostas/processar.js");
await db.iniciar();

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], automacao: { respostaAutomatica: false } };

async function conversa(nome) {
  await db.inserirLead({ place_id: nome, nome, nicho: "dentista", cidade: "Osasco" });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = $1", [nome]);
  await db.atualizarLead(lead.id, { whatsapp: "5511921519375", status: "respondeu" });
  const m = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511921519375", corpo: "Oi, Ana! Faz sentido para o seu time?" });
  await db.atualizarMensagem(m, { status: "enviada", enviada_em: new Date(Date.now() - 3600e3).toISOString() });
  return db.buscarLead(lead.id);
}

test("recusa clara: 'no momento não' encerra sem depender da IA; 'não' sozinho e 'mas depois' ficam com a IA", async () => {
  assert.equal(recusouClaramente("Bom dia no momento não"), true);
  assert.equal(recusouClaramente("Não"), false);
  assert.equal(recusouClaramente("No momento não, mas me chama mês que vem"), false);
  assert.equal(classificarPorRegra("Bom dia no momento não").classificacao, "sem_interesse");

  const lead = await conversa("Dental Center Osasco");
  // Com a classificação de verdade (a regra vem antes da IA, então nenhuma chamada à IA acontece aqui).
  const r = await registrarResposta({ lead, canal: "whatsapp", origem_id: "d1", de: "5511921519375", texto: "Bom dia no momento não", campanha });
  assert.equal(r.classificacao, "sem_interesse");
  assert.equal((await db.buscarLead(lead.id)).status, "sem_interesse");
});

test("recusa que ficou aberta: a rodada encerra, cancela o follow-up e corrige a classificação", async () => {
  const lead = await conversa("Clinica Aberta");
  // Como aconteceu: a IA leu como "outro" e um follow-up ficou para sair.
  const r = await db.criarResposta({ lead_id: lead.id, canal: "whatsapp", origem_id: "x1", de: "5511921519375", texto: "Bom dia no momento não", classificacao: "outro", resumo: "?" });
  const f = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511921519375", corpo: "Oi, Ana! Conseguiu ver?", status: "aprovada", tipo: "resposta", etapa: 0, followup: 1 });
  // Outra conversa, ainda aberta de verdade, não muda.
  const outra = await conversa("Clinica Interessada");
  await db.criarResposta({ lead_id: outra.id, canal: "whatsapp", origem_id: "y1", de: "5511921519375", texto: "Quero saber mais, como funciona?", classificacao: "quer_informacoes", resumo: "quer saber" });

  const { encerradas } = await encerrarRecusasAbertas();
  assert.ok(encerradas >= 1);
  assert.equal((await db.buscarLead(lead.id)).status, "sem_interesse");
  assert.equal((await db.buscarResposta(r)).classificacao, "sem_interesse");
  assert.notEqual((await db.buscarMensagem(f)).status, "aprovada");
  assert.equal((await db.buscarLead(outra.id)).status, "respondeu");
  // De novo: nada a fazer.
  assert.equal((await encerrarRecusasAbertas()).encerradas, 0);
});
