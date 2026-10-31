import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA ??= "senha-de-teste";
const db = await import("../src/db.js");
const campanhaMod = await import("../src/vendas/campanha.js");
const { lerApresentacao, APRESENTACAO_PADRAO, gravarApresentacao } = await import("../src/respostas/apresentacao.js");
const { app } = await import("../src/app.js");

const AGORA = new Date("2026-11-05T15:00:00Z");
const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" } };
let n = 0;

async function interessado({ classificacao = "interessado", canal = "whatsapp", status = "respondeu", dias = 3, contato = "5511999990000" } = {}) {
  n += 1;
  const id = await db.criarLeadDeContato({ nome: `Empresa ${n}`, whatsapp: canal === "whatsapp" ? `${contato}${n}` : null, email: canal === "email" ? `e${n}@exemplo.com` : null });
  await db.atualizarLead(id, { status });
  await db.criarResposta({ lead_id: id, canal, origem_id: `camp-${n}`, de: canal === "email" ? `e${n}@exemplo.com` : `${contato}${n}`, assunto: null, texto: "Quanto custa?", classificacao, resumo: "Perguntou", sugestao: null });
  await db.consultar("UPDATE respostas SET recebida_em = $1 WHERE lead_id = $2", [new Date(+AGORA - dias * 86_400_000).toISOString(), id]);
  return id;
}

const rascunhos = (id) => db.consultar("SELECT * FROM mensagens WHERE lead_id = $1", [id]);

beforeEach(async () => {
  await db.consultar("DELETE FROM mensagens");
  await db.consultar("DELETE FROM respostas");
  await db.consultar("DELETE FROM leads");
  await db.consultar("DELETE FROM estado WHERE chave LIKE 'campanha_black_friday:%'");
  await db.gravarConfig("apresentacao", {});
});

test("campanha: quem parou recebe guia e promoção; quem está falando, só a promoção; nada sai sem aprovar", async () => {
  const parou = await interessado({ dias: 3 });
  const ativo = await interessado({ classificacao: "quer_informacoes", dias: 0.5 });
  const r = await campanhaMod.prepararCampanha(campanha, AGORA);
  assert.equal(r.criadas.length, 2);

  const [a] = await rascunhos(parou);
  assert.deepEqual([a.status, a.tipo, a.etapa], ["rascunho", "resposta", 0]);
  assert.match(a.corpo, /Aqui é o Felipe, da FluxDeck/);
  assert.match(a.corpo, /\/guia\/[0-9a-f]{32}/);
  assert.match(a.corpo, /R\$ 4\.500 por R\$ 3\.000 por mês/);
  assert.match(a.corpo, /é só avisar/);

  const [b] = await rascunhos(ativo);
  assert.ok(!b.corpo.includes("/guia/"));
  assert.match(b.corpo, /R\$ 3\.000/);
});

test("campanha: a resposta nossa depois da dela também conta como parou de responder", () => {
  assert.equal(campanhaMod.parouDeResponder({ ultima_resposta: "2026-11-05T10:00:00Z", ultimo_envio: "2026-11-05T11:00:00Z" }, AGORA), true);
  assert.equal(campanhaMod.parouDeResponder({ ultima_resposta: "2026-11-05T10:00:00Z", ultimo_envio: "2026-11-01T11:00:00Z" }, AGORA), false);
  assert.equal(campanhaMod.parouDeResponder({ ultima_resposta: "2026-11-01T10:00:00Z", ultimo_envio: null }, AGORA), true);
});

test("campanha: repetir não duplica, e fica de fora quem encerrou, saiu ou só teve outra classificação", async () => {
  const ok = await interessado();
  const semInteresse = await interessado({ status: "sem_interesse" });
  const fechado = await interessado({ status: "fechado" });
  const outro = await interessado({ classificacao: "outro" });
  const saiu = await interessado({ contato: "5511888880000" });
  const [{ de }] = await db.consultar("SELECT de FROM respostas WHERE lead_id = $1", [saiu]);
  await db.descadastrarLead(await db.buscarLead(saiu), "teste").catch(() => {});
  assert.ok(de);

  await campanhaMod.prepararCampanha(campanha, AGORA);
  assert.equal((await rascunhos(ok)).length, 1);
  for (const id of [semInteresse, fechado, outro, saiu]) assert.equal((await rascunhos(id)).filter((m) => m.status === "rascunho").length, 0, `lead ${id}`);

  const segunda = await campanhaMod.prepararCampanha(campanha, AGORA);
  assert.equal(segunda.criadas.length, 0);
  assert.equal((await rascunhos(ok)).length, 1);
});

test("campanha: direct do Instagram fica de fora com o motivo, e-mail ganha assunto", async () => {
  await interessado({ canal: "instagram" });
  const email = await interessado({ canal: "email" });
  const r = await campanhaMod.prepararCampanha(campanha, AGORA);
  assert.match(r.fora[0].motivo, /direct/);
  const [m] = await rascunhos(email);
  assert.equal(m.canal, "email");
  assert.match(m.assunto, /Black Friday/);
});

test("campanha: acaba com a promoção, e a IA passa a informar o valor sem apagar o que existia", async () => {
  assert.match((await campanhaMod.prepararCampanha(campanha, new Date("2026-12-01T15:00:00Z"))).erro, /terminou/);

  assert.match(APRESENTACAO_PADRAO, /R\$ 4\.500\/mês por R\$ 3\.000\/mês/);
  await gravarApresentacao("Planos: Professional com IA R$ 4.500/mês.\nPromoção de Black Friday (só em novembro de 2026): criação de site por R$ 2.500/mês.\nPrazo: 2 semanas.");
  assert.equal(await campanhaMod.garantirPromocaoNaApresentacao(), true);
  const linhas = (await lerApresentacao()).split("\n");
  assert.equal(linhas[1], "Promoção de Black Friday (só em novembro de 2026): criação de site por R$ 2.500/mês.");
  assert.equal(linhas[2], campanhaMod.LINHA_DA_PROMOCAO);
  assert.equal(linhas[3], "Prazo: 2 semanas.");
  assert.equal(await campanhaMod.garantirPromocaoNaApresentacao(), false);
  assert.equal((await lerApresentacao()).split("R$ 3.000").length, 2);
});

test("guia: o PDF abre pelo link de cada empresa, com marca-d'água, sem login", async () => {
  const id = await interessado();
  const lead = await db.buscarLead(id);
  const servidor = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  try {
    const base = `http://127.0.0.1:${servidor.address().port}`;
    const r = await fetch(`${base}/guia/${lead.token}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    const pdf = Buffer.from(await r.arrayBuffer());
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.length > 5000);
    assert.equal((await fetch(`${base}/guia/nao-existe`)).status, 404);
    assert.equal((await fetch(`${base}/api/campanha/black-friday`, { method: "POST" })).status, 401);
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }
});

test("campanha: a aprovação do painel enxerga a mensagem, e rejeitar impede o envio", async () => {
  const pipeline = await import("../src/pipeline.js");
  const aprovar = await interessado();
  const rejeitar = await interessado();
  await campanhaMod.prepararCampanha(campanha, AGORA);
  const lista = await db.mensagensPorStatus("rascunho", 50);
  assert.deepEqual(lista.map((m) => m.lead_id).sort((a, b) => a - b), [aprovar, rejeitar].sort((a, b) => a - b));

  await pipeline.aprovarSequencia(aprovar, "whatsapp", { limites: { horario: { inicio: "00:00", fim: "00:01" }, diasUteis: [] }, automacao: {}, empresa: campanha.empresa }).catch(() => {});
  const [a] = await rascunhos(aprovar);
  assert.notEqual(a.status, "rascunho");

  await pipeline.rejeitarSequencia(rejeitar, "whatsapp");
  assert.equal((await rascunhos(rejeitar))[0].status, "rejeitada");
});
