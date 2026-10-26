import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
const db = await import("../src/db.js");
const pipeline = await import("../src/pipeline.js");
const { dentroDoHorario } = pipeline;

const LIMITES = { horarioComercial: { inicio: 9, fim: 18 }, somenteDiasUteis: true };
const campanha = { limites: { ...LIMITES, envioDiarioMax: 30, intervaloEntreEnviosSegundos: 0 } };

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
  const r = await pipeline.enviarMensagem(await db.buscarMensagem(id), campanha, { ignorarHorario: true });
  assert.equal(r.enviada, false);
  assert.match(r.motivo, /rascunho/);
  assert.equal((await db.buscarMensagem(id)).status, "rascunho");
});

test("WhatsApp manual: não sai sozinho, só quando você confirma no painel", async () => {
  const [l] = (await db.leadsPorStatus("novo")).filter((x) => x.place_id === "maps-1");
  const id = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5585977776666", corpo: "Olá!", status: "aprovada" });
  const r = await pipeline.enviarMensagem(await db.buscarMensagem(id), campanha, { ignorarHorario: true });
  assert.equal(r.enviada, false);
  assert.match(r.motivo, /manual/);

  assert.equal(await pipeline.marcarEnviadaManual(id), true);
  assert.equal((await db.buscarMensagem(id)).status, "enviada");
  assert.equal((await db.buscarLead(l.id)).status, "contatado");
  assert.equal(await db.enviadasHoje(), 1);
});

test("mensagem aprovada para contato descadastrado é barrada no envio", async () => {
  const [l] = await db.leadsPorStatus("novo");
  const id = await db.criarMensagem({ lead_id: l.id, canal: "email", destino: "contato@petfeliz.com.br", corpo: "...", status: "aprovada" });
  const r = await pipeline.enviarMensagem(await db.buscarMensagem(id), campanha, { ignorarHorario: true });
  assert.equal(r.enviada, false);
  assert.equal((await db.buscarMensagem(id)).status, "rejeitada");
});
