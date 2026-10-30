import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const contrato = await import("../src/contratos/contrato.js");
const { lerBlocos, documentoEmHtml, documentoEmPdf } = await import("../src/contratos/documento.js");
const { reaisComExtenso, numeroPorExtenso, lerValor, documentoFormatado } = await import("../src/contratos/valores.js");

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe", email: "" }, servicos: [] };
const dados = {
  contratante: "Cliente Teste LTDA", documento: "11222333000181", projeto: "AppTeste", objeto: "o desenvolvimento do aplicativo AppTeste",
  documentoEscopo: "AppTeste — Escopo", tipoPagamento: "mensal", valorMensal: "500", meses: "12", prazoDias: "7",
};

test("contrato: valores por extenso, como no documento", () => {
  assert.equal(reaisComExtenso(500), "R$ 500,00 (quinhentos reais)");
  assert.equal(reaisComExtenso(6000), "R$ 6.000,00 (seis mil reais)");
  assert.equal(reaisComExtenso(1500), "R$ 1.500,00 (mil e quinhentos reais)");
  assert.equal(reaisComExtenso(1250.5), "R$ 1.250,50 (mil duzentos e cinquenta reais e cinquenta centavos)");
  assert.equal(numeroPorExtenso(12), "doze");
  assert.equal(numeroPorExtenso(121), "cento e vinte e um");
  assert.deepEqual([lerValor("1.500,50"), lerValor("R$ 500"), lerValor("6.000"), lerValor("abc")], [1500.5, 500, 6000, null]);
  assert.deepEqual(documentoFormatado("11222333000181"), { tipo: "CNPJ", numero: "11.222.333/0001-81" });
  assert.equal(documentoFormatado("123"), null);
});

test("contrato: 500 por mês em 12 meses sai com total, parcelas e rescisão coerentes", async () => {
  const m = contrato.montarCorpo(await contrato.modeloPadrao(), dados);
  assert.equal(m.total, 6000);
  assert.match(m.corpo, /valor total de R\$ 6\.000,00 \(seis mil reais\), em 12 \(doze\) parcelas mensais e consecutivas de R\$ 500,00 \(quinhentos reais\), com período de vigência de 12 \(doze\) meses/);
  assert.match(m.corpo, /\| 2ª a 12ª \| R\$ 500,00 \(quinhentos reais\) cada \| No mesmo dia dos 11 meses seguintes \|/);
  assert.match(m.corpo, /as parcelas já pagas não serão restituídas/);
  assert.match(m.corpo, /inscrita no CNPJ sob o nº 11\.222\.333\/0001-81/);
  assert.match(m.corpo, /7 \(sete\) dias corridos/);
  // Nenhum campo do modelo sem preencher, a não ser os seus dados.
  const sobrando = [...m.corpo.matchAll(/\{\{([a-z_]+)\}\}/g)].map((x) => x[1]);
  assert.ok(sobrando.length && sobrando.every((c) => c.startsWith("contratada_")), sobrando.join());
});

test("contrato: primeiro pagamento com data, vigência e resumo", async () => {
  const m = contrato.montarCorpo(await contrato.modeloPadrao(), { ...dados, primeiroPagamento: "2026-12-05" });
  assert.match(m.corpo, /com período de vigência de 12 \(doze\) meses/);
  assert.match(m.corpo, /\| 1ª \| R\$ 500,00 \(quinhentos reais\) \| 5 de dezembro de 2026 \|/);
  assert.match(m.corpo, /\| 2ª a 12ª \| R\$ 500,00 \(quinhentos reais\) cada \| Todo dia 5, de janeiro de 2027 a novembro de 2027 \|/);
  assert.match(m.corpo, /::resumo\nValor mensal \| R\$ 500,00\nVigência \| 12 meses\n1º pagamento \| 5 de dezembro de 2026\nValor total \| R\$ 6\.000,00\n::/);
  assert.deepEqual(lerBlocos(m.corpo).find((b) => b.tipo === "resumo").linhas[1], ["Vigência", "12 meses"]);
  assert.match(documentoEmHtml(m.corpo), /class="ct-resumo-rotulo">1º pagamento</);
  assert.match(contrato.montarCorpo(await contrato.modeloPadrao(), { ...dados, primeiroPagamento: "2026-02-31" }).erro, /primeiro pagamento/);
  // Dia que não existe em todo mês avisa, e sem data o vencimento continua na assinatura.
  assert.match(contrato.montarPagamento({ valorMensal: 100, meses: 12, primeiroPagamento: "2026-12-31" }).tabela_pagamento, /Todo dia 31 \(ou o último dia do mês\)/);
  assert.match(contrato.montarPagamento({ valorMensal: 100, meses: 12 }).tabela_pagamento, /Na assinatura deste contrato/);
});

test("contrato: entrada e saldo continua funcionando, e faltar dado explica o que falta", async () => {
  const modelo = await contrato.modeloPadrao();
  const e = contrato.montarCorpo(modelo, { ...dados, tipoPagamento: "entrada_saldo", entrada: "500", saldo: "500" });
  assert.equal(e.total, 1000);
  assert.match(e.corpo, /R\$ 1\.000,00 \(mil reais\), dividido da seguinte forma/);
  assert.match(e.corpo, /\| 2ª — saldo \| R\$ 500,00 \(quinhentos reais\) \| Na entrega final dos serviços \|/);
  assert.match(e.corpo, /o valor da 1ª parcela não será restituído/);
  assert.match(contrato.montarCorpo(modelo, { ...dados, valorMensal: "" }).erro, /valor por mês/);
  assert.match(contrato.montarCorpo(modelo, { ...dados, meses: "0" }).erro, /quantos meses/);
  assert.match(contrato.montarCorpo(modelo, { ...dados, contratante: " " }).erro, /nome do cliente/);
  assert.match(contrato.montarCorpo(modelo, { ...dados, documento: "123" }).erro, /CNPJ ou CPF/);
  // Campo vazio vira linha em branco, para preencher depois.
  assert.match(contrato.montarCorpo(modelo, { ...dados, email: "" }).corpo, /e-mail _{10,}, neste ato/);
});

test("contrato: gerar pela conversa fecha o cliente e cancela a prospecção; seus dados entram na hora de mostrar", async () => {
  await db.inserirLead({ place_id: "cnpj:11222333000181", nome: "Clínica Boa", nicho: "clínica", cidade: "Osasco", endereco: null, telefone: null,
                         site: null, maps_url: null, avaliacao: null, total_avaliacoes: null, email: "oi@clinicaboa.com.br" });
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.nome === "Clínica Boa");
  await db.atualizarLead(lead.id, { status: "contatado" });
  const pendente = await db.criarMensagem({ lead_id: lead.id, canal: "email", destino: "oi@clinicaboa.com.br", corpo: "Etapa 2", status: "aprovada", tipo: "sequencia", etapa: 2 });

  const p = await contrato.padroesDoContrato(lead.id, campanha);
  assert.deepEqual([p.contratante, p.email, p.documento], ["Clínica Boa", "oi@clinicaboa.com.br", "11222333000181"]);

  const c = await contrato.criarContrato({ ...dados, ...p }, campanha);
  assert.equal(c.lead_id, lead.id);
  assert.equal(c.status, "rascunho");
  assert.equal((await db.buscarLead(lead.id)).status, "fechado");
  assert.equal((await db.buscarMensagem(pendente)).status, "rejeitada");
  assert.equal((await db.listarContratos())[0].corpo, undefined); // a lista não traz o texto

  // Sem CPF salvo, sai em branco; preenchendo depois, o contrato já criado mostra.
  const antes = contrato.preencherContratada(c.corpo, await contrato.lerContratada(campanha));
  assert.match(antes, /Felipe, inscrito no CPF sob o nº _{10,}/);
  await contrato.salvarContratada({ nome: "Fulano de Tal", marca: "FluxDeck", cpf: "000.000.000-00", email: "a@b.com", pix: "1199 (telefone)" });
  await contrato.salvarContratada({ cnpj: "00.000.000/0001-00" }); // só o que veio: o resto continua
  const depois = contrato.preencherContratada(c.corpo, await contrato.lerContratada(campanha));
  assert.match(depois, /Fulano de Tal, inscrito no CPF sob o nº 000\.000\.000-00/);
  assert.match(depois, /chave 1199 \(telefone\), de titularidade/);
  assert.match(depois, /marca FluxDeck, inscrita no CNPJ sob o nº 00\.000\.000\/0001-00/);
  assert.match(depois, /CNPJ: 00\.000\.000\/0001-00 \|/);
  assert.equal(c.corpo.includes("000.000.000-00"), false);

  // Modelo editado vale para os próximos, não para os já criados; vazio volta ao original.
  await contrato.salvarModelo("# NOVO MODELO\n{{contratante_nome}}");
  assert.match((await contrato.criarContrato(dados, campanha)).corpo, /^# NOVO MODELO\nCliente Teste LTDA$/);
  assert.match((await db.buscarContrato(c.id)).corpo, /CONTRATO DE PRESTAÇÃO/);
  await contrato.salvarModelo("");
  assert.match(await contrato.lerModelo(), /CONTRATO DE PRESTAÇÃO/);
});

test("contrato: o texto vira blocos, prévia sem HTML solto e PDF de verdade", async () => {
  const b = lerBlocos("# T\n## S\n### C\n1.1. item **forte**\n\nsolto\n| A | B |\n|---|---|\n| 1 | 2 |\n| x | y |\n::assinatura\na | b\n::\n::aviso Olho\ntexto\n::");
  assert.deepEqual(b.map((x) => x.tipo), ["titulo", "subtitulo", "clausula", "item", "paragrafo", "tabela", "assinatura", "aviso"]);
  assert.deepEqual(b[5].cabecalho, ["A", "B"]);
  assert.deepEqual(b[5].linhas, [["1", "2"], ["x", "y"]]);
  assert.equal(lerBlocos("| a | b |")[0].cabecalho, null);
  assert.equal(documentoEmHtml("<script>alert(1)</script>").includes("<script>"), false);
  assert.match(documentoEmHtml("1.1. item **forte**"), /<b>forte<\/b>/);
  // Na folha não aparece marcação: campo vira selo com o valor, ou avisa que falta; linha em branco fica marcada.
  const folha = documentoEmHtml("CPF {{contratada_cpf}} nome {{contratada_nome}} foro {{foro}} data ______", { valores: { contratada_cpf: "", contratada_nome: "Fulano <x>" } });
  assert.match(folha, /class="ct-campo falta"[^>]*data-campo="contratada_cpf"[^>]*>Seu CPF: preencher</);
  assert.match(folha, /data-campo="contratada_nome"[^>]*>Fulano &lt;x&gt;</);
  assert.match(folha, /data-campo="foro"[^>]*>Foro</);
  assert.match(folha, /<span class="ct-branco"[^>]*>______<\/span>/);
  assert.doesNotMatch(folha, /\{\{/);

  const m = contrato.montarCorpo(await contrato.modeloPadrao(), dados);
  const pdf = await documentoEmPdf(contrato.preencherContratada(m.corpo, { nome: "F", marca: "FluxDeck" }), { marca: "FluxDeck", projeto: "AppTeste", cnpj: "00.000.000/0001-00" });
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 5000);
});

test("contrato: o modelo do repositório não leva dados pessoais", async () => {
  const modelo = await contrato.modeloPadrao();
  assert.doesNotMatch(modelo, /\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|@\w+\.\w+|\b\d{10,11}\b/);
});
