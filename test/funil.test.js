import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const pipeline = await import("../src/pipeline.js");
const { dentroDoHorario } = pipeline;

const LIMITES = { horarioComercial: { inicio: 9, fim: 18 }, somenteDiasUteis: true };
const campanha = { limites: { ...LIMITES, envioDiarioMax: 30, intervaloEntreEnviosSegundos: 0 }, cadencia: { horasEntreEtapas: [2, 2] } };

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

  // Enviada a etapa 1, a etapa 2 é agendada (no mesmo dia, ou no próximo dia útil se não couber); a 3 continua esperando.
  assert.equal(await pipeline.marcarEnviadaManual(ids[0], campanha), true);
  const depois = await db.mensagensDaSequencia(l.id, "whatsapp");
  assert.ok(depois[1].agendada_para > new Date());
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
  assert.equal(await pipeline.limiteDoDia(camp, "whatsapp"), 50); // ainda não começou: 50 no primeiro dia
  await db.gravarEstado("aquecimento_whatsapp_inicio", pipeline.somarDiasUteis(new Date(), -0).toISOString());
  const tresDiasUteisAtras = new Date(Date.now() - 5 * 86400000); // pelo menos 3 dias úteis
  await db.gravarEstado("aquecimento_whatsapp_inicio", tresDiasUteisAtras.toISOString());
  const dias = pipeline.diasUteisEntre(tresDiasUteisAtras);
  assert.equal(await pipeline.limiteDoDia(camp, "whatsapp"), Math.min(100, 50 + 15 * dias));
  assert.equal(await pipeline.limiteDoDia({ ...camp, automacao: { ...camp.automacao, aquecimentoInicial: 30, aquecimentoPasso: 5 } }, "whatsapp"),
               Math.min(100, 30 + 5 * dias));
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

test("as 3 etapas saem no mesmo dia, encaixadas até o fim do expediente", () => {
  const minutos = (a, b) => (b - a) / 60000;
  const c = { limites: LIMITES, cadencia: { horasEntreEtapas: [2, 2] } };
  const as10h = new Date("2026-10-27T13:00:00Z"); // terça 10h em SP
  const etapa2 = pipeline.horarioDaProximaEtapa(1, c, as10h);
  assert.ok(minutos(as10h, etapa2) >= 102 && minutos(as10h, etapa2) <= 120, `etapa 2 em ${minutos(as10h, etapa2)} min`);

  // 16h: faltam 2 etapas e 2 h de expediente; o intervalo encolhe para caber hoje.
  const as16h = new Date("2026-10-27T19:00:00Z");
  assert.equal(Math.round(minutos(as16h, pipeline.horarioDaProximaEtapa(1, c, as16h))), 53);
  // 17h, depois da etapa 2: a etapa 3 ainda cabe às 17h45.
  const as17h = new Date("2026-10-27T20:00:00Z");
  assert.equal(Math.round(minutos(as17h, pipeline.horarioDaProximaEtapa(2, c, as17h))), 45);

  // 17h30 depois da etapa 1: não cabe mais hoje, vai para quarta 9h–9h30.
  const quarta = pipeline.horarioDaProximaEtapa(1, c, new Date("2026-10-27T20:30:00Z"));
  assert.ok(quarta >= new Date("2026-10-28T12:00:00Z") && quarta < new Date("2026-10-28T12:30:00Z"), quarta.toISOString());
  // Sexta 17h30: vai para segunda.
  const segunda = pipeline.horarioDaProximaEtapa(1, c, new Date("2026-10-30T20:30:00Z"));
  assert.ok(segunda >= new Date("2026-11-02T12:00:00Z") && segunda < new Date("2026-11-02T12:30:00Z"), segunda.toISOString());
  // Antes do expediente: hoje mesmo às 9h.
  const hoje = pipeline.inicioDoProximoDiaUtil(LIMITES, new Date("2026-10-27T10:00:00Z")); // 7h
  assert.ok(hoje >= new Date("2026-10-27T12:00:00Z") && hoje < new Date("2026-10-27T12:30:00Z"), hoje.toISOString());

  // Empresa nova só começa se ainda der tempo das 3 etapas hoje.
  assert.equal(pipeline.daTempoDeSequenciaHoje(LIMITES, new Date("2026-10-27T19:15:00Z")), true); // 16h15
  assert.equal(pipeline.daTempoDeSequenciaHoje(LIMITES, new Date("2026-10-27T19:20:00Z")), false); // 16h20
});

test("trava de rodada: só uma execução por vez, e ela expira sozinha", async () => {
  assert.equal(await db.travar("teste_trava", 60_000), true);
  assert.equal(await db.travar("teste_trava", 60_000), false); // o outro agendador chegou junto
  await db.destravar("teste_trava");
  assert.equal(await db.travar("teste_trava", -1), true); // já expirada
  assert.equal(await db.travar("teste_trava", 60_000), true);
});

test("uma mensagem só pode ser reservada para envio uma vez", async () => {
  await db.inserirLead(lead("reserva-1"));
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "reserva-1");
  const id = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585900002222", corpo: "oi", status: "aprovada" });
  assert.equal(await db.reservarParaEnvio(id), true);
  assert.equal(await db.reservarParaEnvio(id), false);
  assert.equal((await db.buscarMensagem(id)).status, "enviando");
});

test("etapas pendentes com preço são encontradas para reescrever; as enviadas não", async () => {
  await db.inserirLead(lead("preco-1"));
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "preco-1");
  await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585900003333", corpo: "Começa a partir de R$ 1.900", etapa: 3, tipo: "sequencia", status: "aprovada" });
  assert.ok((await db.leadsComPrecoPendente()).includes(l.id));
  await db.atualizarMensagem((await db.etapasPendentes(l.id))[0].id, { status: "enviada" });
  assert.ok(!(await db.leadsComPrecoPendente()).includes(l.id));
});

test("o marcador da última etapa vira o link de agendamento da empresa (ou some sem link)", async () => {
  const { aplicarLinkAgendamento } = await import("../src/agenda/calendly.js");
  const texto = "Topa um bate-papo de 15 minutos? Escolha o melhor horário:\n{{link_agendamento}}";
  const comLink = aplicarLinkAgendamento(texto, "https://calendly.com/felipe/15min", { token: "tok1" }, "whatsapp");
  assert.match(comLink, /^Topa um bate-papo.*\nhttps:\/\/calendly\.com\/felipe\/15min\?.*utm_content=tok1/s);
  assert.equal(aplicarLinkAgendamento(texto, "", { token: "tok1" }, "whatsapp"), "Topa um bate-papo de 15 minutos? Escolha o melhor horário:");
  assert.equal(aplicarLinkAgendamento("sem marcador", "https://calendly.com/x", { token: "t" }, "email"), "sem marcador");
});

test("nas enviadas, a próxima etapa pendente de cada sequência aparece com o horário", async () => {
  await db.inserirLead(lead("proxima-1"));
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "proxima-1");
  const quando = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585900004444", corpo: "1", etapa: 1, status: "enviada", enviada_em: new Date().toISOString() });
  const id2 = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585900004444", corpo: "2", etapa: 2, tipo: "sequencia", status: "aprovada" });
  await db.atualizarMensagem(id2, { agendada_para: quando });
  await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585900004444", corpo: "3", etapa: 3, tipo: "sequencia", status: "aprovada" });
  const [p] = await db.proximasEtapas([l.id]);
  assert.equal(p.etapa, 2);
  assert.equal(new Date(p.agendada_para).toISOString(), quando);
});

test("e-mail: cada etapa sai em outro dia (1 dia útil, depois 2), no mesmo horário", () => {
  const c = { limites: LIMITES, cadencia: { horasEntreEtapas: [2, 2], diasEntreEmails: [1, 2] } };
  const terca10h = new Date("2026-10-27T13:00:00Z");
  assert.equal(pipeline.horarioDaProximaEtapa(1, c, terca10h, "email").toISOString(), "2026-10-28T13:00:00.000Z"); // quarta
  assert.equal(pipeline.horarioDaProximaEtapa(2, c, new Date("2026-10-28T13:00:00Z"), "email").toISOString(), "2026-10-30T13:00:00.000Z"); // sexta
  const sexta = new Date("2026-10-30T13:00:00Z");
  assert.equal(pipeline.horarioDaProximaEtapa(1, c, sexta, "email").toISOString(), "2026-11-02T13:00:00.000Z"); // segunda
  // WhatsApp continua no mesmo dia.
  assert.ok(pipeline.horarioDaProximaEtapa(1, c, terca10h, "whatsapp") < new Date("2026-10-27T15:01:00Z"));
});

test("etapas de e-mail que ficaram para o mesmo dia são reagendadas para outro dia", async () => {
  await db.inserirLead(lead("email-dia-1"));
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "email-dia-1");
  const enviadaEm = new Date(Date.now() - 3600_000);
  await db.criarMensagem({ lead_id: l.id, canal: "email", destino: "x@dia.com", corpo: "1", etapa: 1, status: "enviada", enviada_em: enviadaEm.toISOString() });
  const id2 = await db.criarMensagem({ lead_id: l.id, canal: "email", destino: "x@dia.com", corpo: "2", etapa: 2, tipo: "sequencia", status: "aprovada" });
  await db.atualizarMensagem(id2, { agendada_para: new Date(Date.now() + 3600_000).toISOString() }); // regra antiga: daqui a 1 h
  const c = { limites: LIMITES, cadencia: { diasEntreEmails: [1, 2] } };
  assert.ok((await pipeline.reagendarEmailsDoMesmoDia(c)) >= 1);
  const m = await db.buscarMensagem(id2);
  assert.equal(new Date(m.agendada_para).toISOString(), pipeline.somarDiasUteis(enviadaEm, 1).toISOString());
  assert.equal(await pipeline.reagendarEmailsDoMesmoDia(c), 0); // já certo: não mexe de novo
});

test("prioridade: conversa esperando resposta > chance alta > potencial de venda", async () => {
  const { potencialDaEmpresa, prioridadeNaFila } = await import("../src/analise/prioridade.js");
  const grande = { site: null, total_avaliacoes: 900, avaliacao: 4.8, whatsapp_status: "verificado" };
  const pequena = { site: "https://clinica.com.br", total_avaliacoes: 4, avaliacao: 3.9, whatsapp_status: "fixo" };
  assert.equal(potencialDaEmpresa(grande).nivel, "alta");
  assert.equal(potencialDaEmpresa(pequena).nivel, "baixa");
  assert.ok(potencialDaEmpresa({ site: "https://instagram.com/x" }).motivos.includes("sem site próprio"));

  const esperando = prioridadeNaFila(pequena, { temResposta: true });
  const quente = prioridadeNaFila(pequena, { andamento: { chance: "quente", rotulo: "Alta", proximoPasso: "mandar o link" } });
  const nova = prioridadeNaFila(grande);
  assert.ok(esperando.pontos > quente.pontos && quente.pontos > nova.pontos);
  assert.equal(nova.rotulo, "Potencial alto");
});

test("ordem de envio: respostas, etapas seguintes e, entre as novas, as de mais potencial primeiro", () => {
  const nova = (id, extra) => ({ id, etapa: 1, tipo: "inicial", ...extra });
  const fila = [
    nova(1, { site: "https://clinica.com.br", total_avaliacoes: 3 }),
    nova(2, { site: null, total_avaliacoes: 800, avaliacao: 4.9, whatsapp_status: "verificado" }),
    { id: 3, etapa: 2, tipo: "sequencia" },
    { id: 4, etapa: 0, tipo: "resposta" },
    nova(5, { site: null, total_avaliacoes: 60 }),
  ];
  assert.deepEqual(pipeline.ordenarFilaDeEnvio(fila).map((m) => m.id), [4, 3, 2, 5, 1]);
});

test("contador de Respostas: conversas com mensagem nova, sem as respostas automáticas", async () => {
  await db.inserirLead(lead("contador-1"));
  await db.inserirLead(lead("contador-2"));
  const ls = (await db.leadsPorStatus("novo")).filter((x) => x.place_id.startsWith("contador-"));
  const antes = (await db.estatisticas()).respostasNaoLidas;
  await db.criarResposta({ lead_id: ls[0].id, canal: "whatsapp", origem_id: "c-1", de: "1", texto: "Oi", classificacao: "outro" });
  await db.criarResposta({ lead_id: ls[0].id, canal: "whatsapp", origem_id: "c-2", de: "1", texto: "Tudo bem?", classificacao: "outro" });
  await db.criarResposta({ lead_id: ls[1].id, canal: "whatsapp", origem_id: "c-3", de: "2", texto: "Obrigado pelo contato!", classificacao: "automatica" });
  assert.equal((await db.estatisticas()).respostasNaoLidas, antes + 1); // 1 conversa, mesmo com 2 mensagens
});

test("empresas novas: intervalo sorteado de 5 a 12 minutos entre uma e a próxima", async () => {
  assert.equal(pipeline.intervaloEntreEmpresasMs({}, 0), 5 * 60_000);
  assert.equal(pipeline.intervaloEntreEmpresasMs({}, 1), 12 * 60_000);
  assert.equal(pipeline.intervaloEntreEmpresasMs({ intervaloEmpresasMin: 8, intervaloEmpresasMax: 3 }, 1), 8 * 60_000); // máximo nunca abaixo do mínimo
  assert.equal(await pipeline.proximaEmpresaNovaEm(), null);
  assert.equal(await db.travar("vez_da_empresa_nova", pipeline.intervaloEntreEmpresasMs({}, 0.5)), true);
  assert.equal(await db.travar("vez_da_empresa_nova", 60_000), false); // a próxima espera o intervalo
  const proxima = new Date(await pipeline.proximaEmpresaNovaEm());
  assert.ok(proxima - Date.now() > 8 * 60_000 && proxima - Date.now() <= 8.5 * 60_000);
  await db.destravar("vez_da_empresa_nova");
});

test("WhatsApp desconectado: as mensagens que falharam por isso voltam para a fila", async () => {
  await db.inserirLead(lead("queda-1"));
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "queda-1");
  const criar = async (canal, erro) => {
    const id = await db.criarMensagem({ lead_id: l.id, canal, destino: canal === "email" ? "a@queda.com" : "5511999990000", corpo: "Oi", status: "aprovada" });
    await db.atualizarMensagem(id, { status: "erro", erro });
    return id;
  };
  const caiu = await criar("whatsapp", "UAZap respondeu 503: true");
  const fechou = await criar("whatsapp", "Evolution API respondeu 400: Error: Connection Closed");
  const numeroInvalido = await criar("whatsapp", "Evolution API respondeu 400: número não existe");
  const email = await criar("email", "UAZap respondeu 503: true");
  assert.equal(await db.devolverErrosDeConexaoWhatsapp(), 2);
  assert.equal((await db.buscarMensagem(caiu)).status, "aprovada");
  assert.equal((await db.buscarMensagem(fechou)).erro, null);
  assert.equal((await db.buscarMensagem(numeroInvalido)).status, "erro");
  assert.equal((await db.buscarMensagem(email)).status, "erro");
  assert.equal(await pipeline.whatsappDesconectado("manual"), false);
});
