import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const { registrarResposta } = await import("../src/respostas/processar.js");
const { pediuApresentacaoComercial, linkDaApresentacao, mensagemDaApresentacao } = await import("../src/vendas/apresentacaoComercial.js");
await db.iniciar();

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], automacao: { respostaAutomatica: false } };
const classificar = async () => ({ classificacao: "quer_informacoes", resumo: "pediu apresentação", sugestao_resposta: "Claro! Os planos são o Starter por R$ 1.500.",
  precisa_humano: false, motivo_humano: "", indicou_contato: false, temperatura: "morna", proximo_passo: "", robo: false, encerrar: false, dor_entendida: false, pediu_conversa: false });

async function conversa(nome) {
  await db.inserirLead({ place_id: nome, nome, nicho: "academia", cidade: "SP" });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = $1", [nome]);
  await db.atualizarLead(lead.id, { whatsapp: "5511900001111", status: "contatado" });
  const m = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511900001111", corpo: "Oi, aqui é o Felipe, da FluxDeck." });
  await db.atualizarMensagem(m, { status: "enviada", enviada_em: new Date(Date.now() - 3600e3).toISOString() });
  return db.buscarLead(lead.id);
}
const sugestao = async (leadId) => (await db.consultar("SELECT sugestao FROM respostas WHERE lead_id = $1 ORDER BY id DESC LIMIT 1", [leadId]))[0].sugestao;

test("apresentação comercial: reconhece o pedido e o link leva o nome da empresa", () => {
  for (const t of ["Tem uma apresentação comercial da empresa?", "Me manda um material de vocês", "vocês têm portfólio?", "Tem algo pra eu dar uma olhada?", "manda os slides", "[áudio] tem catálogo?"]) {
    assert.equal(pediuApresentacaoComercial(t), true, t);
  }
  for (const t of ["Quanto custa?", "Bom dia, tudo bem?", "Pode ser amanhã às 10h"]) assert.equal(pediuApresentacaoComercial(t), false, t);
  assert.equal(linkDaApresentacao({ nome: "Academia Panobianco" }), "https://fluxdeck.com.br/apresentacao?para=Academia%20Panobianco");
  const pronta = mensagemDaApresentacao({ nome: "Padaria" });
  assert.match(pronta, /apresentacao\?para=Padaria/);
  assert.match(pronta, /sob medida/);
  assert.doesNotMatch(pronta, /R\$/);
});

test("apresentação comercial: a IA manda o link dos slides, sem valores, e não repete", async () => {
  const lead = await conversa("Academia Teste");
  const link = linkDaApresentacao(lead);
  // A IA escreveu bem: vai a mensagem dela (mesmo a pessoa perguntando o preço junto).
  const enviarSlides = async (c) => `Tenho sim! Aqui está: ${c.link}\n• Sites\n• Sistema próprio\nTudo sob medida. O que mais pesa hoje?`;
  await registrarResposta({ lead, canal: "whatsapp", origem_id: "a1", de: "5511900001111", texto: "Tem uma apresentação comercial? E quanto custa?", campanha, classificar, enviarSlides });
  let s = await sugestao(lead.id);
  assert.ok(s.includes(link));
  assert.doesNotMatch(s, /R\$/);

  // A IA esqueceu o link ou pôs valor: vai a mensagem pronta.
  const outro = await conversa("Clinica Teste");
  await registrarResposta({ lead: outro, canal: "whatsapp", origem_id: "b1", de: "5511900001111", texto: "Me manda um material de vocês", campanha, classificar,
    enviarSlides: async () => "Claro! O plano sai por R$ 2.000." });
  s = await sugestao(outro.id);
  assert.ok(s.includes(linkDaApresentacao(outro)));
  assert.doesNotMatch(s, /R\$/);

  // Já mandou o link nesta conversa: pedir de novo não repete a apresentação.
  const m = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511900001111", corpo: `Aqui: ${link}`, tipo: "resposta", etapa: 0 });
  await db.atualizarMensagem(m, { status: "enviada", enviada_em: new Date().toISOString() });
  let chamou = false;
  await registrarResposta({ lead, canal: "whatsapp", origem_id: "a2", de: "5511900001111", texto: "Tem portfólio também?", campanha, classificar, enviarSlides: async () => (chamou = true, "") });
  assert.equal(chamou, false);
});
