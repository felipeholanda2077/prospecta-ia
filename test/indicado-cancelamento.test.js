import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
await db.iniciar();

test("a empresa responde de novo: a mensagem agendada para o contato indicado não é cancelada", async () => {
  await db.inserirLead({ place_id: "ChIJindicado0000000000000001", nome: "Clínica Vet", cidade: "Osasco - SP" });
  const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", ["ChIJindicado0000000000000001"]);
  const paraEmpresa = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5511993566627", corpo: "resposta", tipo: "resposta", etapa: 0, status: "aprovada" });
  const paraDoutora = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: "5511978760521", corpo: "Oi, Dra. Lilia", tipo: "resposta", etapa: 0, status: "aprovada" });
  await db.cancelarPendentes(l.id, "lead respondeu", null, { manterDestinos: ["5511978760521", "551178760521"] });
  const st = Object.fromEntries((await db.consultar("SELECT id, status FROM mensagens WHERE lead_id = $1", [l.id])).map((m) => [m.id, m.status]));
  assert.equal(st[paraEmpresa], "rejeitada");
  assert.equal(st[paraDoutora], "aprovada");
  // Sem a lista, cancela tudo como antes.
  await db.cancelarPendentes(l.id, "x");
  assert.equal((await db.consultar("SELECT status FROM mensagens WHERE id = $1", [paraDoutora]))[0].status, "rejeitada");
});
