import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const { sincronizarLeadsInstagram, validarLead, lerArquivo } = await import("../src/vendas/leadsInstagram.js");

const temp = (dados) => {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ig-")), "leads.json");
  fs.writeFileSync(arq, JSON.stringify(dados));
  return arq;
};

const base = {
  instagram: "@Teste.Pastelaria", nome: "Teste Pastelaria", nicho: "confeitaria", cidade: "Porto", pais: "PT",
  previa: "teste", status: "respondeu", temperatura: "quente", proximo_passo: "Fechar a entrada",
  eventos: [
    { id: 1, quando: "2026-11-25T10:00:00Z", autor: "nos", tipo: "inicial", texto: "Olá" },
    { id: 2, quando: "2026-11-25T11:00:00Z", autor: "lead", classificacao: "interessado", texto: "Sim" },
    { id: 3, quando: "2026-11-25T12:00:00Z", autor: "nos", texto: "Prévia" },
  ],
};

test("o arquivo do repositório é válido", () => {
  const { dados } = lerArquivo();
  assert.ok(dados.leads.length > 0);
  for (const l of dados.leads) assert.deepEqual(validarLead(l), [], l.instagram);
});

test("grava lead, mensagens e respostas uma vez só e entra no funil", async () => {
  const arq = temp({ leads: [base] });
  const r1 = await sincronizarLeadsInstagram({ arquivo: arq });
  assert.deepEqual({ ...r1, erros: r1.erros.length }, { sincronizados: 1, novos: 1, mensagens: 2, respostas: 1, erros: 0 });

  // Mesmo arquivo: pula. Forçando: não duplica nada.
  assert.deepEqual(await sincronizarLeadsInstagram({ arquivo: arq }), { pulou: true });
  const r2 = await sincronizarLeadsInstagram({ arquivo: arq, forcar: true });
  assert.equal(r2.novos + r2.mensagens + r2.respostas, 0);

  const [lead] = await db.consultar("SELECT * FROM leads WHERE place_id = 'ig:teste.pastelaria'");
  assert.equal(lead.origem, "instagram");
  assert.equal(lead.instagram, "teste.pastelaria");
  assert.equal(lead.status, "respondeu");
  assert.match(lead.observacao, /previa\/teste/);
  const msgs = await db.consultar("SELECT * FROM mensagens WHERE lead_id = $1 ORDER BY id", [lead.id]);
  assert.deepEqual(msgs.map((m) => [m.canal, m.status, m.tipo]), [["instagram", "enviada", "inicial"], ["instagram", "enviada", "resposta"]]);
  const [resp] = await db.consultar("SELECT * FROM respostas WHERE lead_id = $1", [lead.id]);
  assert.equal(resp.classificacao, "interessado");
  assert.equal(resp.temperatura, "quente");

  // Evento novo e status novo: só acrescenta e atualiza.
  const mais = { ...base, status: "fechado", eventos: [...base.eventos, { id: 4, quando: "2026-11-26T10:00:00Z", autor: "lead", classificacao: "interessado", texto: "Fechado" }] };
  const r3 = await sincronizarLeadsInstagram({ arquivo: temp({ leads: [mais] }) });
  assert.equal(r3.novos, 0);
  assert.equal(r3.respostas, 1);
  const [depois] = await db.consultar("SELECT status FROM leads WHERE id = $1", [lead.id]);
  assert.equal(depois.status, "fechado");
});

test("usa o lead que o sistema já tinha com o mesmo @", async () => {
  await db.criarLeadDeContato({ nome: "Já Existia", instagram: "@ja.existia", origem: "maps" });
  const r = await sincronizarLeadsInstagram({ arquivo: temp({ leads: [{ ...base, instagram: "ja.existia", nome: "Já Existia" }] }) });
  assert.equal(r.novos, 0);
  const linhas = await db.consultar("SELECT id FROM leads WHERE lower(instagram) LIKE '%ja.existia'");
  assert.equal(linhas.length, 1);
});

test("lead com problema não é gravado e a versão não fica marcada", async () => {
  const r = await sincronizarLeadsInstagram({ arquivo: temp({ leads: [{ ...base, instagram: "outro.lead", status: "ganhou" }] }) });
  assert.equal(r.sincronizados, 0);
  assert.match(r.erros[0], /status inválido/);
});
