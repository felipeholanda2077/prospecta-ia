import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP", "UAZAP_URL", "UAZAP_TOKEN", "WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[k];
const db = await import("../src/db.js");
const { contatarIndicados } = await import("../src/respostas/indicacao.js");
const { leadDoContato } = await import("../src/respostas/contatoNovo.js");
const pipeline = await import("../src/pipeline.js");
const { followupsDeInteressados } = await import("../src/respostas/followup.js");
await db.iniciar();

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], automacao: { respostaAutomatica: true, maxRespostasIA: 6, calendly: "" },
  limites: { horarioComercial: { inicio: 0, fim: 24 }, somenteDiasUteis: false, envioDiarioMax: 50 } };
const horasAtras = (h) => new Date(Date.now() - h * 3600_000).toISOString();

/** A academia respondeu e passou o contato da Ingrid; a IA escreveu para ela há `h` horas e ela não respondeu. */
async function academiaQueIndicou(h = 30) {
  await db.inserirLead({ place_id: "pano", nome: "Academia Panobianco", nicho: "academia", cidade: "SP" });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = 'pano'");
  await db.atualizarLead(lead.id, { whatsapp: "5511919819127", status: "respondeu" });
  const m1 = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511919819127", corpo: "Oi, aqui é o Felipe." });
  await db.atualizarMensagem(m1, { status: "enviada", enviada_em: horasAtras(h + 2) });
  await db.criarResposta({ lead_id: lead.id, canal: "whatsapp", origem_id: "r1", de: "5511919819127", texto: "Vou te passar o número da Ingrid, nossa administradora.", classificacao: "quer_informacoes", resumo: "passou o contato" });
  await db.consultar("UPDATE respostas SET recebida_em = $2 WHERE lead_id = $1", [lead.id, horasAtras(h + 1)]);
  const feitos = await contatarIndicados({
    lead: await db.buscarLead(lead.id), contatos: [{ canal: "whatsapp", nome: "Ingrid", numero: "5511942117931" }], de: "5511919819127",
    campanha, escrever: async () => "Oi, Ingrid! O pessoal da academia me passou seu contato.",
  });
  await db.atualizarMensagem(feitos[0].mensagemId, { status: "enviada", enviada_em: horasAtras(h) });
  return db.buscarLead(lead.id);
}

test("indicação: a pessoa indicada fica ligada à conversa da empresa, e a resposta vai para quem falou por último", async () => {
  const lead = await academiaQueIndicou();
  // O que a Ingrid escrever cai na conversa da academia, por qualquer jeito do número.
  for (const n of ["5511942117931", "551142117931"]) assert.equal((await leadDoContato(n))?.id, lead.id, n);

  const { contatos, responderPara } = await pipeline.contatosDaConversa(lead);
  assert.deepEqual(contatos.map((c) => [c.numero, c.nome, c.papel]), [["5511919819127", "Academia Panobianco", "empresa"], ["5511942117931", "Ingrid", "indicado"]]);
  assert.equal(responderPara, "5511942117931");

  // No painel: a resposta vai para quem foi escolhido, desde que seja alguém desta conversa.
  const [resposta] = await db.consultar("SELECT id FROM respostas WHERE lead_id = $1", [lead.id]);
  await assert.rejects(pipeline.responderConversa(resposta.id, "Oi", campanha, { destino: "5511900000000" }), /não faz parte desta conversa/);
  const paraIngrid = await pipeline.responderConversa(resposta.id, "Oi, Ingrid!", campanha, { destino: "5511942117931" });
  assert.equal((await db.buscarMensagem(paraIngrid.id)).destino, "5511942117931");
  const semEscolha = await pipeline.responderConversa(resposta.id, "Obrigado!", campanha);
  assert.equal((await db.buscarMensagem(semEscolha.id)).destino, "5511919819127"); // sem escolha: para quem escreveu
  await db.consultar("DELETE FROM mensagens WHERE id IN ($1, $2)", [paraIngrid.id, semEscolha.id]);
});

test("indicação: o follow-up é com a pessoa indicada que não respondeu, escrito para ela", async () => {
  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = 'pano'");
  let pedido = null;
  const escrever = async (p) => { pedido = p; return { mensagem: "Oi, Ingrid! Conseguiu ver?", opcao: "retomar" }; };
  const r = await followupsDeInteressados(campanha, { escrever });
  assert.equal(r.criados, 1);
  assert.equal(pedido.contatoIndicado?.nome, "Ingrid");
  const [m] = await db.consultar("SELECT * FROM mensagens WHERE lead_id = $1 AND followup IS NOT NULL", [lead.id]);
  assert.equal(m.destino, "5511942117931");
});
