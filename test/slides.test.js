import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.PAINEL_SENHA = "senha-de-teste";
process.env.PAINEL_USUARIO = "teste";
process.env.NOTIFICAR_EMAIL = " ";
const db = await import("../src/db.js");
const { app } = await import("../src/app.js");
const { gerarSlides, editarSlides, arrumarSlides, paginaDosSlides } = await import("../src/vendas/slides.js");

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe", diferenciais: ["sob medida"], telefone: "11953528042", site: "https://fluxdeck.com.br" },
  servicos: [{ id: "ia", nome: "IA no WhatsApp", descricao: "atende 24 h" }] };

/** O que a IA devolveria (com um tipo inválido, sem o próximo passo e um texto com HTML). */
const respostaDaIA = (titulo = "Atendimento 24 h no WhatsApp da Telles Fight Team") => ({
  titulo,
  slides: [
    { tipo: "sobre", titulo: "Quem é a FluxDeck", subtitulo: "Software house de Osasco", itens: [{ titulo: "Sob medida", texto: "Nada de pacote fechado" }] },
    { tipo: "capa", titulo, subtitulo: "", itens: [] },
    { tipo: "inventado", titulo: "x", subtitulo: "", itens: [] },
    { tipo: "conversa", titulo: "Como fica o atendimento", subtitulo: "", itens: [{ titulo: "Cliente", texto: "Tem aula experimental hoje?" }, { titulo: "IA", texto: "Tem sim, às 19h! <b>Quer agendar?</b>" }] },
  ],
});

async function lead(nome) {
  await db.inserirLead({ place_id: nome, nome, nicho: "academia", cidade: "Osasco - SP" });
  const [l] = await db.consultar("SELECT * FROM leads WHERE place_id = $1", [nome]);
  return l;
}

test("slides: a IA monta a apresentação com a conversa, fica pronta no sistema e nada é enviado", async () => {
  const l = await lead("Telles Fight Team");
  await db.criarResposta({ lead_id: l.id, canal: "email", origem_id: "tft-1", de: "x", texto: "Eu tenho interesse apenas no atendimento automatizado do WhatsApp.", classificacao: "interessado", resumo: "x" });
  let pedido;
  const gerar = async (p) => { pedido = p; return respostaDaIA(); };
  const r = await gerarSlides({ leadId: l.id, nota: "só o WhatsApp" }, campanha, { gerar });
  assert.match(pedido.pedido, /apenas no atendimento automatizado do WhatsApp/);
  assert.match(pedido.pedido, /só o WhatsApp/);
  assert.match(pedido.system, /NUNCA cite valores/);
  const dados = JSON.parse(r.dados);
  // Capa primeiro, próximo passo no fim, tipo inválido fora.
  assert.deepEqual(dados.slides.map((s) => s.tipo), ["capa", "sobre", "conversa", "proximo_passo"]);
  assert.equal(dados.slides[0].subtitulo, "Preparada para a Telles Fight Team");
  assert.equal(r.empresa, "Telles Fight Team");
  assert.match(r.codigo, /^[A-Za-z0-9_-]{16}$/);
  // Nada saiu nem entrou na fila.
  assert.equal((await db.consultar("SELECT count(*)::int AS n FROM mensagens WHERE lead_id = $1", [l.id]))[0].n, 0);

  // Refazer mantém o mesmo endereço; editar troca só os textos.
  const refeita = await gerarSlides({ id: r.id, nota: "mais curto" }, campanha, { gerar: async () => respostaDaIA("Outro título") });
  assert.equal(refeita.codigo, r.codigo);
  assert.equal(refeita.titulo, "Outro título");
  assert.equal(refeita.pedido, "mais curto");
  const editada = await editarSlides(r.id, { titulo: "Para o Tiago", slides: JSON.parse(refeita.dados).slides.map((s, i) => (i === 1 ? { ...s, titulo: "Somos a FluxDeck" } : s)) });
  assert.equal(editada.titulo, "Para o Tiago");
  assert.equal(JSON.parse(editada.dados).slides[1].titulo, "Somos a FluxDeck");
  assert.equal((await db.listarSlides()).length, 1);
});

test("slides: no processo, o número que a IA põe no título sai (o círculo já mostra)", () => {
  const d = arrumarSlides({ titulo: "x", slides: [{ tipo: "processo", titulo: "Como", subtitulo: "", itens: [{ titulo: "1. Reunião inicial", texto: "a" }, { titulo: "Etapa 2 - Escopo", texto: "b" }, { titulo: "24 horas", texto: "c" }] }] });
  assert.deepEqual(d.slides[1].itens.map((i) => i.titulo), ["Reunião inicial", "Escopo", "24 horas"]); // número que é parte do texto fica
});

test("slides: a página escapa o texto e tem um slide por seção; o endereço público só abre com o código", async () => {
  const dados = arrumarSlides(respostaDaIA(), { empresa: "Telles <Fight>" });
  const html = paginaDosSlides({ titulo: "x", dados, empresa: "Telles <Fight>" }, { marca: "FluxDeck", telefone: "11953528042" });
  assert.equal((html.match(/<section class="slide/g) ?? []).length, dados.slides.length);
  assert.ok(!html.includes("<b>Quer agendar?</b>"));
  assert.ok(html.includes("&lt;b&gt;Quer agendar?&lt;/b&gt;"));
  assert.ok(html.includes("Telles &lt;Fight&gt;"));
  assert.ok(!/R\$/.test(html));
  assert.ok(html.includes("WhatsApp (11) 95352-8042"));

  const l = await lead("Academia Rota");
  const r = await gerarSlides({ leadId: l.id }, campanha, { gerar: async () => respostaDaIA() });
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const ok = await fetch(`${base}/slides/${r.codigo}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.match(await ok.text(), /Atendimento 24 h no WhatsApp/);
    assert.equal((await fetch(`${base}/slides/naoexiste123`)).status, 404);
    // A API do painel pede login.
    assert.equal((await fetch(`${base}/api/slides`)).status, 401);
  } finally {
    servidor.close();
  }
});

test("precoDoPlano lê os valores do plano para o cartão de preço", async () => {
  const { precoDoPlano } = await import("../src/vendas/slides.js");
  const p = precoDoPlano("Recomendado. Implantação R$ 497 (lançamento até 30/11/2026; depois R$ 900) + R$ 129,90/mês. IA 24h no WhatsApp oficial, com 15 dias de ajustes.");
  assert.equal(p.mensal, 129.9);
  assert.equal(p.implantacao, 497);
  assert.equal(p.depois, 900);
  assert.equal(p.ate, "30/11");
  assert.equal(p.hoje, 626.9);
  assert.deepEqual(p.inclui, ["IA 24h no WhatsApp oficial", "15 dias de ajustes"]);
  const anual = precoDoPlano("R$ 2.397/ano (12x R$ 199,75, implantação grátis). Site, CRM e IA");
  assert.equal(anual.anual, 2397);
  assert.equal(anual.implantacao, 0);
  assert.deepEqual(anual.parcelas, { vezes: 12, valor: 199.75 });
  assert.equal(precoDoPlano("Sob consulta"), null);
  const outroJeito = precoDoPlano("Implantação R$ 997 (lançamento até 30/11/2026, depois R$ 1.950) e mensalidade de R$ 249,90. Inclui IA no WhatsApp, CRM e site.");
  assert.equal(outroJeito.mensal, 249.9);
  assert.equal(outroJeito.depois, 1950);
  assert.deepEqual(outroJeito.inclui, ["IA no WhatsApp", "CRM e site"]);
});

test("a página dos slides tem a logo, a capa animada e o slide de quem é a FluxDeck", async () => {
  const { paginaDosSlides } = await import("../src/vendas/slides.js");
  const dados = { titulo: "T", modo: "fechamento", slides: [
    { tipo: "capa", titulo: "Capa", subtitulo: "", itens: [] },
    { tipo: "conversa", titulo: "C", subtitulo: "", itens: [{ titulo: "Cliente", texto: "Oi" }, { titulo: "IA", texto: "Olá" }] },
    { tipo: "fechamento", titulo: "Vamos?", subtitulo: "", itens: [] },
  ] };
  const html = paginaDosSlides({ empresa: "Academia X", dados }, { marca: "FluxDeck", responsavel: "Felipe", cargo: "Fundador", diferenciais: ["Prazo fechado"], servicos: ["Site"] });
  assert.match(html, /src="\/fluxdeck-logo\.jpg"/);
  assert.match(html, /class="fundo-anim"/);
  assert.match(html, /class="celular mini"/);
  assert.match(html, /QUEM SOMOS/);
  assert.match(html, /Prazo fechado/);
  assert.match(html, /src="\/felipe-holanda\.jpg"/);
  assert.equal((html.match(/<section class="slide/g) ?? []).length, 4);
  // Com o "sobre" escrito pela IA, não entra outro.
  const comSobre = { ...dados, slides: [dados.slides[0], { tipo: "sobre", titulo: "Sobre", subtitulo: "", itens: [{ titulo: "A", texto: "B" }] }, dados.slides[2]] };
  assert.equal((paginaDosSlides({ empresa: "X", dados: comSobre }).match(/QUEM SOMOS/g) ?? []).length, 1);
});
