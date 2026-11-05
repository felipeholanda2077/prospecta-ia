import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const db = await import("../src/db.js");
const { rodadaDeRamos, avaliarRamo, lerRamos, MIN_CONTATADAS } = await import("../src/descoberta/ramos.js");
const { combinacoesDeBusca } = await import("../src/pipeline.js");
const { carregarCampanhaCompleta } = await import("../src/campanha.js");

const campanha = {
  empresa: { nome: "FluxDeck" }, servicos: [{ nome: "Agendamento online", descricao: "agenda com lembrete" }],
  buscas: [{ nicho: "clínica odontológica", cidades: ["Fortaleza - CE", "São Paulo - SP"] }], automacao: { ativo: true },
};
const DIA = 864e5;

/** `n` empresas do ramo contatadas, `responderam` delas responderam e `interessadas` mostraram interesse. */
async function contatadas(nicho, n, responderam = 0, interessadas = 0) {
  for (let i = 0; i < n; i++) {
    const place = `${nicho}-${i}-${Math.random()}`;
    await db.inserirLead({ place_id: place, nome: `${nicho} ${i}`, nicho, cidade: "Fortaleza - CE" });
    const [l] = await db.consultar("SELECT id FROM leads WHERE place_id = $1", [place]);
    const m = await db.criarMensagem({ lead_id: l.id, canal: "whatsapp", destino: `55859${String(i).padStart(8, "0")}`, corpo: "Oi" });
    await db.atualizarMensagem(m, { status: "enviada", enviada_em: new Date().toISOString() });
    if (i < responderam) {
      await db.criarResposta({ lead_id: l.id, canal: "whatsapp", origem_id: `${place}-r`, de: "x", texto: "Oi", classificacao: i < interessadas ? "interessado" : "outro", resumo: "x" });
    }
  }
}

test("ramos: a avaliação fica com quem responde bem e pausa quem não responde", () => {
  const desde = new Date().toISOString();
  assert.equal(avaliarRamo({ desde }, { contatadas: 5, responderam: 3 }).status, "testando"); // ainda pouco para decidir
  assert.equal(avaliarRamo({ desde }, { contatadas: MIN_CONTATADAS, responderam: 5 }).status, "aprovado"); // 25%
  assert.equal(avaliarRamo({ desde }, { contatadas: MIN_CONTATADAS, responderam: 1, interessadas: 2 }).status, "aprovado"); // pouco, mas 2 interessadas
  assert.equal(avaliarRamo({ desde }, { contatadas: MIN_CONTATADAS, responderam: 2 }).status, "pausado"); // 10%
  const velho = new Date(Date.now() - 31 * DIA).toISOString();
  assert.match(avaliarRamo({ desde: velho }, { contatadas: 2, capturadas: 4 }).motivo, /poucas empresas/);
  assert.equal(avaliarRamo({ desde: velho }, { contatadas: 10, responderam: 3 }).status, "aprovado");
});

test("ramos: a IA propõe ramos novos (sem repetir), eles entram na busca e saem quando não respondem", async () => {
  await contatadas("clínica odontológica", 10, 4, 1);
  let pedido;
  const sugerir = async (p) => {
    pedido = p;
    return [
      { nicho: "Clinica Odontologica", servico: "x", motivo: "repetido (sem acento)" },
      { nicho: "clínica de estética", servico: "Agendamento online", motivo: "agenda cheia de faltas" },
      { nicho: "salão de beleza", servico: "Agendamento online", motivo: "marca horário pelo WhatsApp" },
      { nicho: "pet shop", servico: "x", motivo: "a mais" },
    ];
  };
  const agora = new Date();
  const r1 = await rodadaDeRamos(campanha, { sugerir, agora });
  assert.deepEqual(r1.novos, ["clínica de estética", "salão de beleza"]); // 2 por vez, sem o repetido
  assert.equal(pedido.quantos, 2);
  assert.ok(pedido.evitar.includes("clínica odontológica"));
  assert.equal(pedido.resultados[0].ramo, "clínica odontológica");

  // Já rodou hoje: não pede de novo.
  assert.equal((await rodadaDeRamos(campanha, { sugerir, agora: new Date(agora.getTime() + 3600_000) })).pulada, "já rodou hoje");

  // Os ramos em teste entram na rotação da busca, nas mesmas cidades.
  const completa = await carregarCampanhaCompleta();
  assert.deepEqual(completa.ramosExtras, ["clínica de estética", "salão de beleza"]);
  const combinacoes = combinacoesDeBusca({ ...campanha, ramosExtras: completa.ramosExtras });
  assert.equal(combinacoes.length, 6);
  assert.deepEqual(combinacoes.at(-1), { nicho: "salão de beleza", cidade: "São Paulo - SP" });

  // Depois de 20 contatadas: estética respondeu bem (fica), salão respondeu pouco (sai) e entra outro no lugar.
  await contatadas("clínica de estética", MIN_CONTATADAS, 6, 2);
  await contatadas("salão de beleza", MIN_CONTATADAS, 1);
  const r2 = await rodadaDeRamos(campanha, { sugerir: async () => [{ nicho: "academia", servico: "CRM", motivo: "matrícula pelo WhatsApp" }], agora: new Date(agora.getTime() + DIA) });
  assert.deepEqual(r2, { novos: ["academia"], aprovados: ["clínica de estética"], pausados: ["salão de beleza"] });
  const ramos = await lerRamos();
  assert.equal(ramos.find((r) => r.nicho === "clínica de estética").resultado.responderam, 6);
  assert.deepEqual((await carregarCampanhaCompleta()).ramosExtras.sort(), ["academia", "clínica de estética"]);

  // Desligado na Automação: não testa e não entra na busca.
  await db.gravarConfig("automacao", { testarRamos: false });
  assert.deepEqual((await carregarCampanhaCompleta()).ramosExtras, []);
  assert.ok((await rodadaDeRamos({ ...campanha, automacao: { testarRamos: false } }, { sugerir })).pulada);
});
