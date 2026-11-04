import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["NOTIFICAR_EMAIL", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const { rodadaDeReativacao, dorDoRamo, pontosDoSite, canalDaReativacao } = await import("../src/respostas/reativacao.js");

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], automacao: { ativo: false } };
const diasAtras = (d) => new Date(Date.now() - d * 864e5).toISOString();

/** Empresa que recebeu a sequência pelo WhatsApp `dias` atrás e não respondeu. */
async function calada(nome, { dias = 31, email = null, instagram = null, nicho = "clínica odontológica", analise = null } = {}) {
  await db.inserirLead({ place_id: nome, nome, nicho, cidade: "SP", email, instagram });
  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = $1", [nome]);
  await db.atualizarLead(lead.id, { whatsapp: "5511988887777", status: "contatado", ...(analise ? { analise: JSON.stringify(analise) } : {}) });
  for (const etapa of [1, 2, 3]) {
    const m = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: "5511988887777", corpo: `etapa ${etapa}`, etapa, tipo: etapa === 1 ? "inicial" : "sequencia" });
    await db.atualizarMensagem(m, { status: "enviada", enviada_em: diasAtras(dias + 3 - etapa) });
  }
  return db.buscarLead(lead.id);
}
const daReativacao = (leadId) => db.consultar("SELECT * FROM mensagens WHERE lead_id = $1 AND tipo = 'reativacao'", [leadId]);
const escrever = async (ctx) => ({ oferta: ctx.pontos.length ? "diagnostico" : "guia", assunto: "Um presente", mensagem: `Olhei o site e anotei: ${ctx.pontos[0] ?? ctx.linkGuia}. Faz sentido eu te mandar mais?` });

test("reativação: dor do ramo, pontos reais do site e outro canal quando der", () => {
  assert.match(dorDoRamo("clínica odontológica"), /fora do horário.*confirmação/);
  assert.match(dorDoRamo("Concessionária Carros"), /estoque.*Google/);
  assert.match(dorDoRamo("loja de roupas"), /Instagram.*loja virtual/);
  const pontos = pontosDoSite({ temSite: true, https: false, responsivo: false, temDescricao: false, temChat: true, temAgendamento: false }, "clínica odontológica");
  assert.equal(pontos.length, 3);
  assert.match(pontos[0], /https/);
  assert.deepEqual(pontosDoSite({ temSite: false }), []);
  assert.deepEqual(pontosDoSite('{"temSite":true,"https":true,"responsivo":true,"temDescricao":true,"temChat":true}'), []);
  const lead = { email: "a@b.com", instagram: "loja", whatsapp: "5511" };
  assert.equal(canalDaReativacao(lead, ["whatsapp"]).canal, "email");
  assert.equal(canalDaReativacao(lead, ["whatsapp", "email"]).destino, "@loja");
  assert.equal(canalDaReativacao({ whatsapp: "5511" }, ["whatsapp"]).canal, "whatsapp");
});

test("reativação: só depois de 30 dias, uma vez só, pelo e-mail, e para aprovar com o funil automático desligado", async () => {
  const pronta = await calada("Clinica Pronta", { email: "contato@clinica.com", analise: { temSite: true, https: false, responsivo: true, temDescricao: false, temChat: true } });
  const cedo = await calada("Clinica Cedo", { dias: 10, email: "cedo@clinica.com" });
  const r = await rodadaDeReativacao(campanha, { escrever });
  assert.equal(r.criadas, 1);
  const [m] = await daReativacao(pronta.id);
  assert.equal(m.canal, "email");
  assert.equal(m.destino, "contato@clinica.com");
  assert.equal(m.status, "rascunho");
  assert.equal(m.etapa, 4);
  assert.match(m.corpo, /cadeado|https/);
  assert.equal((await daReativacao(cedo.id)).length, 0);
  // Uma vez só.
  await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: diasAtras(1) });
  assert.equal((await rodadaDeReativacao(campanha, { escrever })).criadas, 0);

  // Com o funil automático ligado, já vai para a fila (WhatsApp, quando não há outro canal).
  const so = await calada("Loja So Whats", { nicho: "loja de roupas" });
  await rodadaDeReativacao({ ...campanha, automacao: { ativo: true } }, { escrever });
  const [w] = await daReativacao(so.id);
  assert.equal(w.canal, "whatsapp");
  assert.equal(w.status, "aprovada");
  assert.ok(w.agendada_para);
});

test("reativação: sem resposta em 7 dias, a empresa sai do funil com a data para voltar em 6 meses", async () => {
  const lead = await calada("Concessionaria Muda", { nicho: "Concessionária Carros", email: "vendas@carros.com" });
  await rodadaDeReativacao(campanha, { escrever });
  const [m] = await daReativacao(lead.id);
  await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: diasAtras(8) });
  const r = await rodadaDeReativacao(campanha, { escrever });
  assert.ok(r.encerradas >= 1);
  const depois = await db.buscarLead(lead.id);
  assert.equal(depois.status, "descartado");
  assert.match(depois.observacao, /tentar de novo a partir de \d{2}\/\d{2}\/\d{4}/);
  const registro = JSON.parse(await db.lerEstado(`reativacao:${lead.id}`));
  assert.ok(new Date(registro.voltarEm) - Date.now() > 170 * 864e5);

  // Quem respondeu à reativação não é encerrada.
  const respondeu = await calada("Concessionaria Responde", { nicho: "Concessionária Carros", email: "oi@carros.com" });
  await rodadaDeReativacao(campanha, { escrever });
  const [m2] = await daReativacao(respondeu.id);
  await db.atualizarMensagem(m2.id, { status: "enviada", enviada_em: diasAtras(8) });
  await db.criarResposta({ lead_id: respondeu.id, canal: "email", origem_id: "re-1", de: "oi@carros.com", texto: "Manda sim", classificacao: "interessado", resumo: "x" });
  await db.atualizarLead(respondeu.id, { status: "respondeu" });
  await rodadaDeReativacao(campanha, { escrever });
  assert.equal((await db.buscarLead(respondeu.id)).status, "respondeu");
});

test("reativação: no máximo 4 por rodada", async () => {
  for (let i = 0; i < 6; i++) await calada(`Lote ${i}`, { email: `lote${i}@x.com` });
  assert.ok((await rodadaDeReativacao(campanha, { escrever })).criadas <= 4);
});
