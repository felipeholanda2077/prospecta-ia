import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[k];
const db = await import("../src/db.js");
const cnpj = await import("../src/descoberta/cnpj.js");
const pipeline = await import("../src/pipeline.js");

/**
 * As três fontes de mentira: a Casa dos Dados devolve até 2 por consulta (sem os excluídos), a Minha
 * Receita tem o cadastro de quase todos e a CNPJá (reserva) tem o CNPJ aberto este mês.
 */
function fontesFalsas() {
  const empresas = [
    { cnpj: "11111111000101", razao_social: "BARBEARIA DO ZE LTDA", nome_fantasia: "BARBEARIA DO ZÉ" },
    { cnpj: "22222222000102", razao_social: "STUDIO BELLA LTDA", nome_fantasia: "" },
    { cnpj: "33333333000103", razao_social: "CORTE FINO LTDA", nome_fantasia: "Corte Fino" },
    { cnpj: "44444444000104", razao_social: "NOVA BARBER LTDA", nome_fantasia: "Nova Barber" },
  ];
  const cadastro = {
    "11111111000101": { ddd_telefone_1: "1193694108", email: "ze@barbeariadoze.com.br", data_inicio_atividade: "2026-05-01", bairro: "Centro", municipio: "OSASCO", uf: "SP" },
    "22222222000102": { ddd_telefone_1: "1136854000", email: "escritorio@contabilidadesilva.com.br", data_inicio_atividade: "2019-01-10", municipio: "OSASCO", uf: "SP" },
    "33333333000103": { ddd_telefone_1: "1136854000", email: null, data_inicio_atividade: "2021-03-02", municipio: "OSASCO", uf: "SP" },
  };
  const pedidos = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = String(url);
    if (u.includes("casadosdados")) {
      const corpo = JSON.parse(opcoes.body);
      pedidos.push(corpo);
      const fora = new Set(corpo.excluir?.cnpj ?? []);
      return Response.json({ total: empresas.length, cnpjs: empresas.filter((e) => !fora.has(e.cnpj)).slice(0, 2) });
    }
    const doCnpj = u.match(/(\d{14})$/)?.[1];
    if (u.includes("minhareceita")) return cadastro[doCnpj] ? Response.json(cadastro[doCnpj]) : new Response("", { status: 404 });
    if (u.includes("open.cnpja.com") && doCnpj === "44444444000104") {
      return Response.json({ founded: "2026-10-20", phones: [{ type: "LANDLINE", area: "11", number: "41475591" }, { type: "MOBILE", area: "11", number: "981094344" }],
        emails: [{ ownership: "PERSONAL", address: "Contato@NovaBarber.com" }], address: { street: "Rua A", number: "10", district: "Vila", city: "Osasco", state: "SP" }, company: { simei: { optant: false } } });
    }
    return new Response("", { status: 404 });
  };
  return { pedidos, restaurar: () => (globalThis.fetch = original) };
}

test("cnpj: cidade, telefone e nome do cadastro no formato certo", () => {
  assert.deepEqual(cnpj.municipioEUf("São Paulo - SP"), { municipio: "sao paulo", uf: "sp" });
  assert.deepEqual(cnpj.municipioEUf("Fortaleza, CE"), { municipio: "fortaleza", uf: "ce" });
  assert.deepEqual(cnpj.municipioEUf("Osasco"), { municipio: "osasco", uf: null });
  assert.equal(cnpj.telefoneDoCnpj("1193694108"), "(11) 99369-4108"); // celular sem o nono dígito
  assert.equal(cnpj.telefoneDoCnpj("1136854000"), "(11) 3685-4000");
  assert.equal(cnpj.telefoneDoCnpj("1111111111"), null);
  assert.equal(cnpj.nomeDaEmpresa({ razao_social: "69.883.642 MICHELE SILVA DOS SANTOS" }), "Michele Silva dos Santos");
  assert.equal(cnpj.nomeDaEmpresa({ nome_fantasia: "Shohair Studio" }), "Shohair Studio");
  assert.equal(cnpj.emailDeContador("linocontfiscal@gmail.com"), true);
  assert.equal(cnpj.emailDeContador("contato@barbearia.com"), false);
});

test("cnpj: a IA acha a atividade principal do segmento uma vez, e o código informado vale sem a IA", async () => {
  const fontes = fontesFalsas();
  try {
    let perguntas = 0;
    const escolher = async ({ lista }) => (perguntas++, { codigos: ["8630504", "9999999", lista.find((a) => a.codigo === "4645103").codigo] });
    const achadas = await cnpj.cnaesDoSegmento("Clínica odontológica", { escolher });
    assert.deepEqual(achadas.map((c) => c.codigo), ["8630504"]); // só a atividade principal
    assert.equal(achadas[0].descricao, "ATIVIDADE ODONTOLÓGICA");
    await cnpj.cnaesDoSegmento("clinica odontologica", { escolher });
    assert.equal(perguntas, 1);
    assert.deepEqual((await cnpj.cnaesDoSegmento("qualquer", { cnae: "9602-5/01" })).map((c) => c.codigo), ["9602501"]);
    await assert.rejects(cnpj.cnaesDoSegmento("qualquer", { cnae: "1234567" }), /não encontrado/);
  } finally {
    fontes.restaurar();
  }
});

test("cnpj: busca, completa o contato, tira o do contador e captura só quem tem contato", async () => {
  const fontes = fontesFalsas();
  try {
    const r = await pipeline.buscarNoCnpj("barbearia", "Osasco - SP", { quantidade: 4, cnae: "9602501" });
    // Pediu de novo sem os que já vieram, e com os filtros da busca.
    assert.equal(fontes.pedidos.length, 2);
    assert.deepEqual(fontes.pedidos[1].excluir.cnpj, ["11111111000101", "22222222000102"]);
    assert.deepEqual([fontes.pedidos[0].municipio, fontes.pedidos[0].uf, fontes.pedidos[0].mei], [["osasco"], ["sp"], { excluir_optante: true }]);
    // Sem as abertas nas últimas semanas (ainda sem telefone e e-mail na base).
    assert.equal(fontes.pedidos[0].data_abertura.fim, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    const porCnpj = Object.fromEntries(r.empresas.map((e) => [e.cnpj, e]));

    assert.equal(porCnpj["11111111000101"].nome, "Barbearia do Zé");
    assert.equal(porCnpj["11111111000101"].telefone, "(11) 99369-4108");
    assert.equal(porCnpj["11111111000101"].celular, true);
    // Mesmo telefone em duas empresas diferentes + e-mail de contabilidade: é do contador.
    assert.deepEqual([porCnpj["22222222000102"].telefone, porCnpj["22222222000102"].email], [null, null]);
    assert.deepEqual(porCnpj["22222222000102"].contador.sort(), ["e-mail", "telefone"]);
    assert.equal(porCnpj["33333333000103"].semContato, true);
    // Aberta este mês: a Minha Receita ainda não tem, veio da reserva (o celular primeiro).
    assert.equal(porCnpj["44444444000104"].telefone, "(11) 98109-4344");
    assert.equal(porCnpj["44444444000104"].email, "contato@novabarber.com");
    assert.equal(r.empresas.at(-1).semContato, true); // sem contato vai para o fim

    // Só as que têm contato são capturadas (as do contador ficaram sem nenhum).
    assert.equal((await pipeline.capturarDoCnpj(r.empresas.filter((e) => !e.semContato), "barbearia", "Osasco - SP")).novas, 2);
    const ze = (await db.leadsPorStatus("novo")).find((l) => l.place_id === "cnpj:11111111000101");
    assert.deepEqual([ze.origem, ze.nome, ze.email, ze.telefone], ["cnpj", "Barbearia do Zé", "ze@barbeariadoze.com.br", "(11) 99369-4108"]);

    // A próxima busca não traz de volta os já capturados.
    fontes.pedidos.length = 0;
    await pipeline.buscarNoCnpj("barbearia", "Osasco - SP", { quantidade: 2, cnae: "9602501" });
    assert.deepEqual(fontes.pedidos[0].excluir.cnpj.sort(), ["11111111000101", "44444444000104"]);
  } finally {
    fontes.restaurar();
  }
});

test("cnpj: na análise, a empresa sem contato espera a vez da consulta de reserva", async () => {
  const fontes = fontesFalsas();
  try {
    await db.inserirLead({ place_id: "cnpj:55555555000105", nome: "Sem Contato Ainda", nicho: "barbearia", cidade: "Osasco - SP", endereco: null, telefone: null,
                           site: null, maps_url: null, avaliacao: null, total_avaliacoes: null, origem: "cnpj" });
    // Outra consulta acabou de sair: esta espera (continua para analisar) em vez de ser descartada.
    await db.travar("cnpja_aberta", 60_000);
    await pipeline.analisar({ limite: 50 });
    assert.equal((await db.leadsPorStatus("novo")).some((l) => l.nome === "Sem Contato Ainda"), true);
    // Com a vez, consulta: a reserva também não tem nada, então é descartada por falta de contato.
    await db.destravar("cnpja_aberta");
    await pipeline.analisar({ limite: 50 });
    const lead = (await db.leadsPorStatus("descartado")).find((l) => l.nome === "Sem Contato Ainda");
    assert.ok(lead);
  } finally {
    fontes.restaurar();
  }
});
