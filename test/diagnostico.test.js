import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
process.env.PAINEL_SENHA ??= "senha-de-teste";
const db = await import("../src/db.js");
const asaas = await import("../src/contratos/asaas.js");
const entrada = await import("../src/vendas/entrada.js");
const diagnostico = await import("../src/vendas/diagnostico.js");
const { lerBlocos } = await import("../src/contratos/documento.js");
const { app } = await import("../src/app.js");
// Nos testes, a IA de verdade nunca é chamada: sem chave, o relatório usa o plano padrão.
delete process.env.ANTHROPIC_API_KEY;

const CHAVE = "$aact_hmlg_chave-falsa";
const AGORA = new Date("2026-11-20T15:00:00Z");
const SITE_RUIM = { temSite: true, url: "http://empresa.exemplo.com/", https: false, responsivo: false, temChat: false, temDescricao: false, lento: true, tempoRespostaMs: 5200, anoCopyright: 2019, poucoConteudo: true, temAgendamento: false, temLoja: false };
const SITE_BOM = { temSite: true, url: "https://bom.exemplo.com/", https: true, responsivo: true, temChat: true, temDescricao: true, tempoRespostaMs: 300, temAgendamento: true, temLoja: true };
const HTML_RUIM = `<html><head><title>Empresa</title></head><body>Empresa © 2019 ${"texto ".repeat(10)}</body></html>`;

function apiFalsa() {
  const estado = { links: [], pagamentos: [], leiturasDoSite: 0 };
  const fetchFalso = async (url, opcoes = {}) => {
    const u = new URL(url);
    const responde = (dados, status = 200) => new Response(JSON.stringify(dados), { status });
    if (u.hostname === "empresa.exemplo.com") {
      if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
      estado.leiturasDoSite += 1;
      if (estado.siteFora) return new Response("erro", { status: 503 });
      const pagina = new Response(HTML_RUIM, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(pagina, "url", { value: url });
      return pagina;
    }
    const caminho = u.pathname.replace(/^\/v3/, "");
    const metodo = opcoes.method ?? "GET";
    if (caminho === "/customers") return responde({ data: [] });
    if (caminho === "/paymentLinks") {
      const l = { id: `link_${estado.links.length + 1}`, url: `https://sandbox.asaas.com/c/${estado.links.length + 1}`, ...JSON.parse(opcoes.body) };
      estado.links.push(l);
      return responde(l);
    }
    if (caminho.startsWith("/paymentLinks/")) return responde({ deleted: true });
    if (caminho === "/payments") return responde({ data: estado.pagamentos, hasMore: false });
    const p = estado.pagamentos.find((x) => x.id === caminho.split("/")[2]);
    return p ? responde(p) : responde({}, 404);
  };
  return { estado, fetchFalso };
}

const original = globalThis.fetch;
/** O sistema fala com o Asaas falso; o teste fala de verdade com o servidor local. */
async function comServidor(api, fazer) {
  const servidor = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  globalThis.fetch = (url, o) => (String(url).startsWith(base) ? original(url, o) : api.fetchFalso(url, o));
  try {
    return await fazer(base);
  } finally {
    globalThis.fetch = original;
    await new Promise((ok) => servidor.close(ok));
  }
}

let n = 0;
async function preparar(analise = SITE_RUIM) {
  n += 1;
  await asaas.conectar(CHAVE);
  const leadId = await db.criarLeadDeContato({ nome: `Clínica ${n}`, whatsapp: "5511999999999" });
  await db.atualizarLead(leadId, { nicho: "clínica odontológica", cidade: "São Paulo - SP", site: analise?.url ?? null, analise: analise ? JSON.stringify(analise) : null });
  const oferta = await entrada.criarOferta({ nome: "Diagnóstico do site", valor: "197,00", diagnostico: "true" });
  return { leadId, oferta };
}

beforeEach(async () => {
  await db.consultar("DELETE FROM vendas");
  await db.gravarConfig("ofertas_entrada", {});
  await db.gravarConfig("asaas", {});
  await db.destravar("diagnostico_conferir");
});

test("achados: só aponta o que a auditoria viu, do mais grave para o mais leve", () => {
  const { problemas, bons } = diagnostico.achados(SITE_RUIM, { nicho: "clínica odontológica", avaliacao: 4.9, totalAvaliacoes: 120 }, 2026);
  assert.deepEqual(problemas.slice(0, 3).map((p) => p.prioridade), ["alta", "alta", "alta"]);
  assert.equal(problemas.at(-1).prioridade, "baixa");
  assert.ok(problemas.some((p) => /5,2 segundos/.test(p.titulo)));
  assert.ok(problemas.some((p) => /agendamento online/.test(p.titulo)));
  assert.ok(!problemas.some((p) => /loja virtual/.test(p.titulo)), "clínica não precisa de loja");
  assert.match(bons[0], /nota 4,9 no Google, com 120/);

  const bom = diagnostico.achados(SITE_BOM, { nicho: "clínica odontológica" }, 2026);
  assert.deepEqual(bom.problemas, []);
  assert.ok(bom.bons.length >= 4);
  assert.match(diagnostico.achados({ temSite: true, fora: true }).problemas[0].titulo, /não abriu/);
});

test("oferta: o relatório pode ser mensal, e só vende quando há site e problema", async () => {
  const o = await entrada.criarOferta({ nome: "D", valor: "197", diagnostico: "true", mensal: "true" });
  assert.deepEqual([o.diagnostico, o.mensal], [true, true]);

  const api = apiFalsa();
  await comServidor(api, async () => {
    const semSite = await preparar(null);
    assert.match((await entrada.gerarLink({ leadId: semSite.leadId, ofertaId: semSite.oferta.id }, AGORA)).erro, /não tem um site/);
    const bom = await preparar(SITE_BOM);
    assert.match((await entrada.gerarLink({ leadId: bom.leadId, ofertaId: bom.oferta.id }, AGORA)).erro, /Não encontrei problemas/);
    const bloqueado = await preparar({ temSite: true, bloqueadoPorRobots: true });
    await db.atualizarLead(bloqueado.leadId, { site: null });
    assert.match((await entrada.gerarLink({ leadId: bloqueado.leadId, ofertaId: bloqueado.oferta.id }, AGORA)).erro, /não tem um site/);
  });
  assert.equal(api.estado.links.length, 0);
  assert.equal((await db.listarVendas()).length, 0);
});

test("venda: a mensagem mostra dois pontos e leva à página, e o relatório só sai depois de pago", async () => {
  const api = apiFalsa();
  await comServidor(api, async (base) => {
    const { leadId, oferta } = await preparar();
    const { venda, mensagem } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    assert.ok(venda.token?.length >= 40);
    assert.match(mensagem, new RegExp(`/diagnostico/${venda.token}$`));
    assert.match(mensagem, /R\$.197,00 por PIX/);
    assert.equal((mensagem.match(/•/g) ?? []).length, 2);
    assert.ok(!mensagem.includes("asaas.com"), "o cliente entra pela página, não direto no pagamento");

    // Antes de pagar: a página vende, e o PDF volta para ela.
    const pagina = await original(`${base}/diagnostico/${venda.token}`).then((r) => r.text());
    assert.match(pagina, /Pagar R\$.197,00 por PIX/);
    assert.match(pagina, /sandbox\.asaas\.com\/c\/1/);
    assert.match(pagina, /noindex/);
    assert.ok(!pagina.includes("Baixar o relatório"));
    const antes = await original(`${base}/diagnostico/${venda.token}/relatorio.pdf`, { redirect: "manual" });
    assert.equal(antes.status, 302);
    assert.equal((await db.lerMidia(`relatorio-${venda.id}.pdf`)), null);

    // Pagou e o aviso se perdeu: a própria página descobre.
    api.estado.pagamentos.push({ id: "pay_1", status: "RECEIVED", paymentDate: "2026-11-20", paymentLink: venda.asaas_link });
    const situacao = await original(`${base}/diagnostico/${venda.token}/situacao`).then((r) => r.json());
    assert.equal(situacao.status, "paga");
    assert.equal((await db.buscarLead(leadId)).status, "fechado");

    const paga = await original(`${base}/diagnostico/${venda.token}`).then((r) => r.text());
    assert.match(paga, /Baixar o relatório em PDF/);
    assert.ok(!paga.includes("asaas.com"));

    const pdf = await original(`${base}/diagnostico/${venda.token}/relatorio.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), "%PDF");

    // Pedir de novo devolve o mesmo documento, sem ler o site de novo.
    const leituras = api.estado.leiturasDoSite;
    assert.equal((await original(`${base}/diagnostico/${venda.token}/relatorio.pdf`)).status, 200);
    assert.equal(api.estado.leiturasDoSite, leituras);
  });
});

test("página: token errado, venda comum e link cancelado não entregam nada", async () => {
  const api = apiFalsa();
  await comServidor(api, async (base) => {
    assert.equal((await original(`${base}/diagnostico/nao-existe`)).status, 404);
    assert.equal((await original(`${base}/diagnostico/nao-existe/relatorio.pdf`)).status, 404);
    assert.equal((await original(`${base}/diagnostico/nao-existe/situacao`)).status, 404);

    const { leadId, oferta } = await preparar();
    const { venda } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    await entrada.cancelarVenda(venda.id);
    assert.match(await original(`${base}/diagnostico/${venda.token}`).then((r) => r.text()), /não está mais ativo/);
    assert.equal((await original(`${base}/diagnostico/${venda.token}/relatorio.pdf`, { redirect: "manual" })).status, 302);
    assert.equal((await original(`${base}/api/vendas/${venda.id}/relatorio`)).status, 401, "no painel, exige login");
  });
});

test("relatório: usa o texto da IA, e sai igual se ela falhar; o que veio dela não quebra o documento", async () => {
  const api = apiFalsa();
  await comServidor(api, async () => {
    const { leadId, oferta } = await preparar();
    const { venda } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    const pedidos = [];
    const pdf = await diagnostico.pdfDoRelatorio(venda, { servicos: [] }, { marca: "FluxDeck" }, {
      agora: AGORA,
      escrever: async (lead, achado) => {
        pedidos.push(achado);
        return { resumo: "Resumo da IA.", plano: [{ quando: "Esta semana", acao: "Ativar o HTTPS", motivo: "Segurança" }] };
      },
    });
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pedidos[0].problemas.length >= 3);

    const outra = await entrada.gerarLink({ leadId: await db.criarLeadDeContato({ nome: "Outra", whatsapp: "5511988888888" }).then(async (id) => { await db.atualizarLead(id, { site: SITE_RUIM.url, analise: JSON.stringify(SITE_RUIM) }); return id; }), ofertaId: oferta.id }, AGORA);
    const semIa = await diagnostico.pdfDoRelatorio(outra.venda, { servicos: [] }, { marca: "FluxDeck" }, { agora: AGORA, escrever: async () => { throw new Error("IA fora do ar"); } });
    assert.equal(semIa.subarray(0, 4).toString(), "%PDF");

    // No mês seguinte sai outro relatório, com leitura nova do site; dentro do mês, o mesmo.
    const leituras = api.estado.leiturasDoSite;
    await diagnostico.pdfDoRelatorio(outra.venda, { servicos: [] }, { marca: "FluxDeck" }, { agora: new Date("2026-11-28T15:00:00Z"), escrever: async () => { throw new Error("guardado"); } });
    assert.equal(api.estado.leiturasDoSite, leituras);
    await diagnostico.pdfDoRelatorio(outra.venda, { servicos: [] }, { marca: "FluxDeck" }, { agora: new Date("2026-12-02T15:00:00Z"), escrever: async () => { throw new Error("novo"); } });
    assert.ok(api.estado.leiturasDoSite > leituras);

    // O site caiu na hora de gerar: quem pagou recebe os pontos vistos antes, não só "o site não abriu".
    api.estado.siteFora = true;
    const terceira = await entrada.gerarLink({ leadId: await db.criarLeadDeContato({ nome: "Terceira", whatsapp: "5511977777777" }).then(async (id) => { await db.atualizarLead(id, { site: SITE_RUIM.url, analise: JSON.stringify(SITE_RUIM) }); return id; }), ofertaId: oferta.id }, AGORA);
    let visto;
    await diagnostico.pdfDoRelatorio(terceira.venda, { servicos: [] }, { marca: "FluxDeck" }, { agora: AGORA, escrever: async (_, a) => { visto = a; return { resumo: "R", plano: [] }; } });
    assert.ok(visto.problemas.length >= 3);
    assert.ok(!visto.problemas.some((p) => /não abriu/.test(p.titulo)));
  });

  const achado = diagnostico.achados(SITE_RUIM, {}, 2026);
  const texto = diagnostico.textoDoRelatorio({
    lead: { nome: "Empresa | Teste\n# título" }, url: "http://empresa.exemplo.com/", data: "20/11/2026", achado,
    escrito: { resumo: "Linha um\n### falso", plano: [{ quando: "Esta semana", acao: "Trocar | isso\nagora", motivo: "Porque" }] },
    servicos: [{ nome: "Modernização", descricao: "Novo layout.", aPartirDe: "R$ 1.500" }],
  });
  const blocos = lerBlocos(texto);
  assert.deepEqual(blocos.filter((b) => b.tipo === "titulo").length, 1);
  assert.equal(blocos.filter((b) => b.texto === "falso").length, 0);
  const tabela = blocos.find((b) => b.tipo === "tabela");
  assert.deepEqual(tabela.cabecalho, ["Quando", "O que fazer", "Por quê"]);
  assert.deepEqual(tabela.linhas[0], ["Esta semana", "Trocar / isso agora", "Porque"]);
  assert.deepEqual(blocos.find((b) => b.tipo === "resumo").linhas[2], ["Pontos a corrigir", String(achado.problemas.length)]);
  assert.match(texto, /não testa compras/);
  assert.ok(!texto.includes("R$ 1.500"), "o relatório não cita preço de serviço");
  assert.match(texto, /Modernização:/);

  // Site sem problemas no mês: sem seções vazias.
  const limpo = lerBlocos(diagnostico.textoDoRelatorio({ lead: { nome: "E" }, url: "https://e.com", data: "01/12/2026", achado: { problemas: [], bons: ["Tudo certo."] }, escrito: { resumo: "Nada a corrigir.", plano: [] } }));
  assert.ok(!limpo.some((b) => b.tipo === "tabela"));
  assert.ok(!limpo.some((b) => b.texto === "O que encontramos" || b.texto === "Plano de ação"));
  assert.ok(!/\d+%/.test(texto), "nenhuma porcentagem inventada");
});

test("assinatura do diagnóstico: mensagem e página falam em mês e cartão; atraso bloqueia, e pagar libera de novo", async () => {
  const api = apiFalsa();
  await comServidor(api, async (base) => {
    const { leadId } = await preparar();
    const oferta = await entrada.criarOferta({ nome: "Diagnóstico mensal", valor: "197,00", diagnostico: "true", mensal: "true" });
    const { venda, mensagem } = await entrada.gerarLink({ leadId, ofertaId: oferta.id }, AGORA);
    assert.match(mensagem, /R\$.197,00 por mês, no cartão, sem fidelidade/);
    assert.match(mensagem, /todo mês tem um relatório novo/);
    const l = api.estado.links.at(-1);
    assert.deepEqual([l.billingType, l.chargeType, l.subscriptionCycle], ["CREDIT_CARD", "RECURRENT", "MONTHLY"]);
    assert.match(await original(`${base}/diagnostico/${venda.token}`).then((r) => r.text()), /Assinar por R\$.197,00 por mês, no cartão/);

    const primeira = { id: "pay_m1", status: "RECEIVED", paymentDate: "2026-11-20", paymentLink: venda.asaas_link, subscription: "sub_d" };
    api.estado.pagamentos.push(primeira);
    await entrada.processarAvisoDeVenda({ payment: primeira }, AGORA);
    assert.match(await original(`${base}/diagnostico/${venda.token}`).then((r) => r.text()), /todo mês tem um relatório novo aqui/);
    assert.equal((await original(`${base}/diagnostico/${venda.token}/relatorio.pdf`)).status, 200);

    await db.atualizarVenda(venda.id, { status: "atrasada" });
    assert.match(await original(`${base}/diagnostico/${venda.token}`).then((r) => r.text()), /Mensalidade em atraso/);
    assert.equal((await original(`${base}/diagnostico/${venda.token}/relatorio.pdf`, { redirect: "manual" })).status, 302);
  });
});
