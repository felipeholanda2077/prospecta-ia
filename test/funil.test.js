import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const pipeline = await import("../src/pipeline.js");
const { dentroDoHorario } = pipeline;

const LIMITES = { horarioComercial: { inicio: 9, fim: 18 }, somenteDiasUteis: true };
const campanha = { limites: { ...LIMITES, envioDiarioMax: 30, intervaloEntreEnviosSegundos: 0 }, cadencia: { diasUteisEntreEtapas: [2, 3] } };

const lead = (place_id, extra = {}) => ({ place_id, nome: `Empresa ${place_id}`, nicho: "pet shop", cidade: "Fortaleza - CE",
  endereco: null, telefone: null, site: null, maps_url: null, avaliacao: null, total_avaliacoes: null, ...extra });

test("horário comercial em São Paulo", () => {
  assert.equal(dentroDoHorario(LIMITES, new Date("2026-10-27T13:00:00Z")), true); // terça 10h
  assert.equal(dentroDoHorario(LIMITES, new Date("2026-10-27T23:00:00Z")), false); // terça 20h
  assert.equal(dentroDoHorario(LIMITES, new Date("2026-10-25T13:00:00Z")), false); // domingo
});

test("empresa duplicada não é inserida duas vezes", async () => {
  assert.equal(await db.inserirLead(lead("abc")), true);
  assert.equal(await db.inserirLead(lead("abc")), false);
});

test("descadastro é respeitado independente de maiúsculas e formatação", async () => {
  await db.descadastrar("Contato@PetFeliz.com.br");
  await db.descadastrar("(85) 98888-7777");
  assert.equal(await db.estaDescadastrado("contato@petfeliz.com.br"), true);
  assert.equal(await db.estaDescadastrado("85988887777"), true);
  assert.equal(await db.estaDescadastrado("outro@petfeliz.com.br"), false);
});

test("mesmo contato não recebe duas propostas", async () => {
  const [l] = await db.leadsPorStatus("novo");
  assert.equal(await db.contatoJaUsado("vendas@petfeliz.com.br"), false);
  await db.criarMensagem({ lead_id: l.id, canal: "email", destino: "Vendas@PetFeliz.com.br", assunto: "Oi", corpo: "..." });
  assert.equal(await db.contatoJaUsado("vendas@petfeliz.com.br"), true);
  assert.equal(await db.contatoJaUsado("vendas@petfeliz.com.br", ["enviada"]), false);
});

test("captura do Google Maps salva só as novas e marca a origem", async () => {
  const empresas = [lead("maps-1", { maps_url: "https://maps.google.com/?cid=1" }), lead("maps-2"), lead("abc")];
  assert.deepEqual(await pipeline.capturarDoMaps(empresas, "pet shop", "Fortaleza - CE"), { novas: 2 });
  const capturados = await db.placeIdsCapturados(["maps-1", "maps-2", "abc", "nao-existe"]);
  assert.deepEqual([...capturados].sort(), ["abc", "maps-1", "maps-2"]);
  const [m1] = (await db.leadsPorStatus("novo")).filter((l) => l.place_id === "maps-1");
  assert.equal(m1.origem, "maps");
  assert.equal(m1.maps_url, "https://maps.google.com/?cid=1");
});

test("rascunho nunca é enviado sem aprovação", async () => {
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "maps-2");
  const id = await db.criarMensagem({ lead_id: l.id, canal: "email", destino: "dono@maps2.com", assunto: "Oi", corpo: "..." });
  const r = await pipeline.enviarMensagem(await db.buscarMensagem(id), campanha);
  assert.equal(r.enviada, false);
  assert.match(r.motivo, /rascunho/);
  assert.equal((await db.buscarMensagem(id)).status, "rascunho");
});

test("WhatsApp manual: não sai sozinho, só quando você confirma no painel", async () => {
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "maps-1");
  const id = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585977776666", corpo: "Olá!", status: "aprovada" });
  const r = await pipeline.enviarMensagem(await db.buscarMensagem(id), campanha);
  assert.equal(r.enviada, false);
  assert.match(r.motivo, /manual/);

  assert.equal(await pipeline.marcarEnviadaManual(id, campanha), true);
  assert.equal((await db.buscarMensagem(id)).status, "enviada");
  assert.equal((await db.buscarLead(l.id)).status, "contatado");
  assert.equal(await db.enviadasHoje(), 1);
});

test("mensagem aprovada para contato descadastrado é barrada no envio", async () => {
  const [l] = await db.leadsPorStatus("novo");
  const id = await db.criarMensagem({ lead_id: l.id, canal: "email", destino: "contato@petfeliz.com.br", corpo: "...", status: "aprovada" });
  const r = await pipeline.enviarMensagem(await db.buscarMensagem(id), campanha);
  assert.equal(r.enviada, false);
  assert.equal((await db.buscarMensagem(id)).status, "rejeitada");
});

test("somarDiasUteis pula o fim de semana", () => {
  const sexta = new Date("2026-10-30T13:00:00Z"); // sexta, 10h em São Paulo
  assert.equal(pipeline.somarDiasUteis(sexta, 2).toISOString(), "2026-11-03T13:00:00.000Z"); // terça
  assert.equal(pipeline.somarDiasUteis(new Date("2026-10-27T13:00:00Z"), 3).toISOString(), "2026-10-30T13:00:00.000Z");
});

test("sequência gradual: cada etapa só entra na fila depois da anterior e para quando o lead responde", async () => {
  await db.inserirLead(lead("seq-1"));
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "seq-1");
  const ids = [];
  for (const etapa of [1, 2, 3]) {
    ids.push(await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585966665555", corpo: `etapa ${etapa}`,
                                      etapa, tipo: etapa === 1 ? "inicial" : "sequencia" }));
  }

  // Aprovar a sequência aprova as 3 etapas; no modo manual nada sai sozinho.
  const r = await pipeline.aprovarSequencia(l.id, "whatsapp", campanha);
  assert.match(r.motivo, /manual/);
  const etapas = await db.mensagensDaSequencia(l.id, "whatsapp");
  assert.deepEqual(etapas.map((m) => m.status), ["aprovada", "aprovada", "aprovada"]);
  assert.deepEqual((await db.filaDeEnvio()).filter((m) => m.lead_id === l.id).map((m) => m.etapa), [1]);

  // Enviada a etapa 1, a etapa 2 é agendada para 2 dias úteis depois; a 3 continua esperando.
  assert.equal(await pipeline.marcarEnviadaManual(ids[0], campanha), true);
  const depois = await db.mensagensDaSequencia(l.id, "whatsapp");
  assert.ok(depois[1].agendada_para > new Date(Date.now() + 36 * 3600 * 1000));
  assert.equal(depois[2].agendada_para, null);
  assert.deepEqual((await db.filaDeEnvio()).filter((m) => m.lead_id === l.id), []);

  // Chegou o dia: a etapa 2 entra na fila.
  await db.atualizarMensagem(ids[1], { agendada_para: new Date(Date.now() - 60_000).toISOString() });
  assert.deepEqual((await db.filaDeEnvio()).filter((m) => m.lead_id === l.id).map((m) => m.etapa), [2]);

  // O lead respondeu: as etapas que faltavam são canceladas.
  await db.cancelarPendentes(l.id, "lead respondeu");
  const final = await db.mensagensDaSequencia(l.id, "whatsapp");
  assert.deepEqual(final.map((m) => m.status), ["enviada", "rejeitada", "rejeitada"]);
});

test("respostas da conversa não contam no limite diário de prospecção", async () => {
  const antes = await db.enviadasHoje();
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "maps-2");
  await db.criarMensagem({ lead_id: l.id, canal: "email", destino: "dono@maps2.com", corpo: "oi", status: "enviada",
                           tipo: "resposta", etapa: 0, enviada_em: new Date().toISOString() });
  assert.equal(await db.enviadasHoje(), antes);
});

test("busca no Maps: empresas sem site vêm primeiro (e as já capturadas por último)", () => {
  const r = pipeline.ordenarPorPrioridade([
    { nome: "Com site", site: "https://a.com.br", celular: true, total_avaliacoes: 500 },
    { nome: "Capturada sem site", site: null, jaCapturado: true },
    { nome: "Sem site fixo", site: null, celular: false, total_avaliacoes: 10 },
    { nome: "Só Instagram", site: "https://instagram.com/loja", celular: true, total_avaliacoes: 5 },
    { nome: "Sem site celular", site: null, celular: true, total_avaliacoes: 2 },
  ]);
  assert.deepEqual(r.map((e) => e.nome), ["Só Instagram", "Sem site celular", "Sem site fixo", "Com site", "Capturada sem site"]);
});

test("análise e propostas começam pelas empresas sem site", async () => {
  await db.inserirLead(lead("prio-com", { site: "https://tem.com.br" }));
  await db.inserirLead(lead("prio-sem"));
  await db.inserirLead(lead("prio-insta", { site: "https://www.instagram.com/x" }));
  const ordem = (await db.leadsPorStatus("novo")).map((l) => l.place_id).filter((p) => p.startsWith("prio-"));
  assert.deepEqual(ordem.slice(-1), ["prio-com"]);
  assert.deepEqual(ordem.slice(0, 2).sort(), ["prio-insta", "prio-sem"]);
  // Tira da fila de análise para os próximos testes não acessarem a internet.
  for (const l of await db.leadsPorStatus("novo")) await db.atualizarLead(l.id, { status: "descartado" });
});

test("WhatsApp: usa o link do site, depois celular e até o número fixo", async () => {
  const fixo = await pipeline.descobrirWhatsapp({ nome: "A", telefone: "+55 11 4552-7446" }, {});
  assert.deepEqual(fixo, { whatsapp: "551145527446", whatsapp_status: "fixo" });
  const cel = await pipeline.descobrirWhatsapp({ nome: "B", telefone: "(11) 95669-9774" }, {});
  assert.deepEqual(cel, { whatsapp: "5511956699774", whatsapp_status: "celular" });
  const site = await pipeline.descobrirWhatsapp({ nome: "C", telefone: "+55 11 4552-7446" }, { whatsapp: "5511988887777" });
  assert.deepEqual(site, { whatsapp: "5511988887777", whatsapp_status: "site" });
  assert.deepEqual(await pipeline.descobrirWhatsapp({ nome: "D", telefone: null }, {}), { whatsapp: null, whatsapp_status: null });
});

test("empresa capturada no Maps sem site e só com telefone fixo não é descartada", async () => {
  await db.inserirLead(lead("fixo-1", { telefone: "+55 11 4195-4898", origem: "maps" }));
  await pipeline.analisar();
  const [l] = (await db.leadsPorStatus("analisado")).filter((x) => x.place_id === "fixo-1");
  assert.equal(l.whatsapp, "551141954898");
  assert.equal(l.whatsapp_status, "fixo");

  // Reanalisar volta para a fila de análise; empresa já em contato não pode.
  await pipeline.reanalisar(l.id);
  assert.equal((await db.buscarLead(l.id)).status, "novo");
  await db.atualizarLead(l.id, { status: "contatado" });
  await assert.rejects(pipeline.reanalisar(l.id), /já está em contato/);
});

test("meta diária por canal com aquecimento do WhatsApp", async () => {
  const camp = { ...campanha, automacao: { metaDiaria: { email: 100, whatsapp: 100 }, aquecimentoWhatsapp: true } };
  assert.equal(await pipeline.limiteDoDia(camp, "email"), 100);
  assert.equal(await pipeline.limiteDoDia(camp, "whatsapp"), 20); // ainda não começou: 20 no primeiro dia
  await db.gravarEstado("aquecimento_whatsapp_inicio", pipeline.somarDiasUteis(new Date(), -0).toISOString());
  const tresDiasUteisAtras = new Date(Date.now() - 5 * 86400000); // pelo menos 3 dias úteis
  await db.gravarEstado("aquecimento_whatsapp_inicio", tresDiasUteisAtras.toISOString());
  const dias = pipeline.diasUteisEntre(tresDiasUteisAtras);
  assert.equal(await pipeline.limiteDoDia(camp, "whatsapp"), Math.min(100, 20 + 10 * dias));
  assert.equal(await pipeline.limiteDoDia({ ...camp, automacao: { ...camp.automacao, aquecimentoWhatsapp: false } }, "whatsapp"), 100);
});

test("cota espalhada: rodadas de 10 minutos que faltam até as 18h", () => {
  assert.equal(pipeline.rodadasRestantesHoje(LIMITES, new Date("2026-10-27T20:30:00Z")), 3); // 17h30 em SP
  assert.equal(pipeline.rodadasRestantesHoje(LIMITES, new Date("2026-10-27T12:00:00Z")), 54); // 9h
  assert.equal(pipeline.rodadasRestantesHoje(LIMITES, new Date("2026-10-27T22:00:00Z")), 1); // depois do expediente
});

test("busca automática em rotação percorre segmento × cidade", () => {
  const c = pipeline.combinacoesDeBusca({ buscas: [{ nicho: "pet shop", cidades: ["Barueri", "Osasco"] }, { nicho: "construtora", cidades: ["Barueri"] }] });
  assert.deepEqual(c.map((x) => `${x.nicho}/${x.cidade}`), ["pet shop/Barueri", "pet shop/Osasco", "construtora/Barueri"]);
});
