import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const { followupsDeInteressados, precisaDeFollowup, MAX_SEGUIDOS } = await import("../src/respostas/followup.js");

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], automacao: { respostaAutomatica: true } };
const horasAtras = (h) => new Date(Date.now() - h * 3600_000).toISOString();

/** Empresa que mostrou interesse: nossa mensagem, a resposta dela e a nossa resposta, `h` horas atrás. */
async function conversa(nome, { classificacao = "quer_informacoes", h = 30 } = {}) {
  await db.inserirLead({ place_id: nome, nome, nicho: "loja", cidade: "SP" });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = $1", [nome]);
  await db.atualizarLead(lead.id, { whatsapp: "5511900000000", status: "respondeu" });
  const m1 = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511900000000", corpo: "Oi, aqui é o Felipe." });
  await db.atualizarMensagem(m1, { status: "enviada", enviada_em: horasAtras(h + 2) });
  await db.criarResposta({ lead_id: lead.id, canal: "whatsapp", origem_id: `${nome}-r1`, de: "5511900000000", texto: "Vem de indicação e web.", classificacao, resumo: "x" });
  await db.consultar("UPDATE respostas SET recebida_em = $2 WHERE lead_id = $1", [lead.id, horasAtras(h + 1)]);
  const m2 = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511900000000", corpo: "Onde vocês sentem mais aperto hoje?", tipo: "resposta", etapa: 0 });
  await db.atualizarMensagem(m2, { status: "enviada", enviada_em: horasAtras(h) });
  return db.buscarLead(lead.id);
}
const pendentes = (leadId) => db.consultar("SELECT * FROM mensagens WHERE lead_id = $1 AND status = 'aprovada' ORDER BY id", [leadId]);
const marcarEnviada = async (leadId, h) => {
  for (const m of await pendentes(leadId)) await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: horasAtras(h) });
};

test("follow-up: decide pela conversa (1 dia sem resposta, no máximo 2 seguidos, sem direct do Instagram)", () => {
  const nos = (h, canal = "whatsapp") => ({ autor: "nos", canal, quando: horasAtras(h), contato: "5511" });
  const ela = (h) => ({ autor: "lead", canal: "whatsapp", quando: horasAtras(h), contato: "5511" });
  assert.equal(precisaDeFollowup({ historico: [nos(50), ela(49), nos(30)] }).numero, 1);
  assert.equal(precisaDeFollowup({ historico: [nos(50), ela(49), nos(10)] }), null); // menos de 1 dia
  assert.equal(precisaDeFollowup({ historico: [nos(50), ela(30)] }), null); // a vez é nossa (responder), não follow-up
  assert.equal(precisaDeFollowup({ historico: [nos(50), ela(49), nos(30)], pausada: "você parou a IA" }), null);
  assert.equal(precisaDeFollowup({ historico: [nos(50), ela(49), nos(30, "instagram")] }), null);
  assert.equal(precisaDeFollowup({ historico: [nos(500), ela(499), nos(400)] }), null); // parada há muito tempo
  const registro = { n: MAX_SEGUIDOS, desde: horasAtras(30), opcoes: ["retomar", "material"] };
  assert.equal(precisaDeFollowup({ historico: [nos(80), ela(79), nos(30)], registro }), null);
  // Ela respondeu depois dos follow-ups: a conta recomeça.
  assert.equal(precisaDeFollowup({ historico: [nos(80), ela(35), nos(30)], registro: { ...registro, desde: horasAtras(40) } }).numero, 1);
});

test("follow-up: só para interessados, entra na fila de respostas, alterna retomar e material e para em 2", async () => {
  const interessado = await conversa("Loja Interessada");
  const frio = await conversa("Loja Sem Interesse", { classificacao: "outro" });
  const pedidos = [];
  const escrever = async (ctx) => {
    pedidos.push(ctx);
    return ctx.evitar === "retomar"
      ? { opcao: "material", mensagem: `Preparei um guia gratuito pra vocês: ${ctx.linkMaterial}` }
      : { opcao: "retomar", mensagem: "Fiquei pensando no que você contou da indicação. Hoje quem responde quem chega pela web?" };
  };
  assert.equal((await followupsDeInteressados(campanha, { escrever })).criados, 1);
  const [f1] = await pendentes(interessado.id);
  assert.equal(f1.tipo, "resposta");
  assert.match(f1.corpo, /Fiquei pensando/);
  assert.equal((await pendentes(frio.id)).length, 0); // sem interesse: nada
  assert.match(pedidos[0].linkMaterial, /\/guia\//);

  // Ainda na fila: não cria outro.
  assert.equal((await followupsDeInteressados(campanha, { escrever })).criados, 0);
  // Saiu ontem e ela não respondeu: o 2º oferece o material.
  await marcarEnviada(interessado.id, 25);
  assert.equal((await followupsDeInteressados(campanha, { escrever })).criados, 1);
  assert.match((await pendentes(interessado.id))[0].corpo, /guia gratuito/);
  assert.equal(pedidos[1].evitar, "retomar");
  // Depois de 2 seguidos sem resposta, para.
  await marcarEnviada(interessado.id, 25);
  assert.equal((await followupsDeInteressados(campanha, { escrever })).criados, 0);

  // Com a resposta automática desligada, nada de follow-up.
  const outro = await conversa("Loja Desligada");
  assert.equal((await followupsDeInteressados({ ...campanha, automacao: { respostaAutomatica: false } }, { escrever })).criados, 0);
  assert.equal((await pendentes(outro.id)).length, 0);
});

test("follow-up: sem pergunta de preço, valor que a IA escreveu sai antes de ir para a fila", async () => {
  const lead = await conversa("Loja Preco");
  const escrever = async () => ({ opcao: "retomar", mensagem: "Lembrei de vocês. O site sai R$ 570 por mês. Hoje vocês divulgam o estoque onde?" });
  await followupsDeInteressados(campanha, { escrever });
  const [m] = await pendentes(lead.id);
  assert.equal(m.corpo, "Lembrei de vocês. Hoje vocês divulgam o estoque onde?");
});

test("follow-up no painel: a mensagem fica marcada e a previsão diz quando sai o próximo", async () => {
  const { previsaoDoFollowup } = await import("../src/respostas/followup.js");
  const base = { interessado: true, status: "respondeu", ultimaDela: horasAtras(10) };
  const p = previsaoDoFollowup({ ...base, ultima: { autor: "nos", canal: "whatsapp", quando: horasAtras(6) } });
  assert.equal(p.numero, 1);
  assert.ok(Math.abs(new Date(p.quando) - (Date.now() + 18 * 3600_000)) < 60_000); // 1 dia depois da nossa última mensagem
  assert.equal(previsaoDoFollowup({ ...base, interessado: false, ultima: { autor: "nos", canal: "whatsapp", quando: horasAtras(6) } }), null);
  assert.equal(previsaoDoFollowup({ ...base, ultima: { autor: "lead", canal: "whatsapp", quando: horasAtras(1) } }), null); // a vez é sua
  assert.equal(previsaoDoFollowup({ ...base, temFila: true, ultima: { autor: "nos", canal: "whatsapp", quando: horasAtras(6) } }), null);
  assert.equal(previsaoDoFollowup({ ...base, ultima: { autor: "nos", canal: "whatsapp", quando: horasAtras(6) }, registro: { n: 2, desde: horasAtras(7) } }).fim, true);

  const lead = await conversa("Loja Painel");
  await followupsDeInteressados(campanha, { escrever: async () => ({ opcao: "retomar", mensagem: "E aí, conseguiram pensar no atendimento da web?" }) });
  const [agendada] = await db.agendadasDaConversa(lead.id);
  assert.equal(agendada.followup, 1);
  await marcarEnviada(lead.id, 0);
  const historico = await db.historicoConversa(lead.id);
  assert.equal(historico.at(-1).followup, 1);
  assert.equal(historico.find((h) => h.autor === "lead").followup, null);
});
