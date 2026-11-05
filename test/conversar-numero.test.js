import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const { rascunhoParaNumero, enviarParaNumero } = await import("../src/respostas/conversarComNumero.js");

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], canais: ["whatsapp"], limites: {}, automacao: {} };

test("conversar com um número: cria o contato, a IA escreve sem preço e o envio vira o primeiro contato", async () => {
  let pedido;
  const escrever = async (p) => { pedido = p; return "Oi, Ana! Aqui é o Felipe, da FluxDeck. Os planos começam em R$ 497/mês. Como vocês atendem quem chama hoje?"; };
  const r = await rascunhoParaNumero({ numero: "+55 11 94342-7726", nome: "Ana", empresa: "Clínica Sorriso", contexto: "conheci no evento" }, campanha, { escrever });
  assert.equal(r.whatsapp, "5511943427726");
  assert.equal(r.nome, "Clínica Sorriso");
  assert.equal(r.jaConversou, false);
  assert.ok(!/R\$/.test(r.texto), "valor só se a pessoa pedir");
  assert.equal(pedido.nome, "Ana");
  assert.equal(pedido.contexto, "conheci no evento");
  const lead = await db.buscarLead(r.leadId);
  assert.equal(lead.origem, "manual");
  assert.equal(lead.status, "proposta_gerada"); // não entra no funil como "respondeu"

  // O mesmo número escrito de outro jeito acha o mesmo contato.
  for (const numero of ["(11) 94342-7726", "5511943427726"]) {
    assert.equal((await rascunhoParaNumero({ numero }, campanha, { escrever: async () => "Oi" })).leadId, r.leadId);
  }

  const envio = await enviarParaNumero(r.leadId, "Oi, Ana! Como vocês atendem quem chama hoje?", campanha);
  const [m] = await db.consultar("SELECT * FROM mensagens WHERE id = $1", [envio.id]);
  assert.equal(m.destino, "5511943427726");
  assert.equal(m.tipo, "inicial");
  assert.equal(m.etapa, 1);
  assert.ok(["aprovada", "enviada"].includes(m.status));
});

test("conversar com um número: quem já conversou recebe como resposta, e a IA sabe que já houve conversa", async () => {
  await db.inserirLead({ place_id: "ja-conversou", nome: "Loja Já Conversou", nicho: "loja", cidade: "SP" });
  const [lead] = await db.consultar("SELECT id FROM leads WHERE place_id = 'ja-conversou'");
  await db.atualizarLead(lead.id, { whatsapp: "5511955554444", status: "respondeu" });
  await db.criarResposta({ lead_id: lead.id, canal: "whatsapp", origem_id: "jc-1", de: "5511955554444", texto: "Quanto custa?", classificacao: "quer_informacoes", resumo: "preço" });
  let historico;
  const r = await rascunhoParaNumero({ numero: "11955554444" }, campanha, { escrever: async (p) => { historico = p.historico; return "Sobre o valor: R$ 497/mês. O que mais pesa hoje?"; } });
  assert.equal(r.leadId, lead.id);
  assert.equal(r.jaConversou, true);
  assert.equal(historico.length, 1);
  assert.match(r.texto, /R\$ 497/); // a pessoa perguntou o preço: pode falar
  const envio = await enviarParaNumero(lead.id, r.texto, campanha);
  const [m] = await db.consultar("SELECT tipo, etapa FROM mensagens WHERE id = $1", [envio.id]);
  assert.deepEqual({ tipo: m.tipo, etapa: m.etapa }, { tipo: "resposta", etapa: 0 });
});

test("conversar com um número: número inválido, descadastrado ou de agente não recebe", async () => {
  const escrever = async () => "Oi";
  await assert.rejects(rascunhoParaNumero({ numero: "123" }, campanha, { escrever }), /Número inválido/);
  await db.descadastrar("5511966667777");
  await assert.rejects(rascunhoParaNumero({ numero: "(11) 96666-7777" }, campanha, { escrever }), /não receber/);
  await assert.rejects(enviarParaNumero(999999, "Oi", campanha), /não encontrado/);
  const ok = await rascunhoParaNumero({ numero: "11 97777-1111" }, campanha, { escrever });
  await assert.rejects(enviarParaNumero(ok.leadId, "   ", campanha), /Escreva a mensagem/);
});
