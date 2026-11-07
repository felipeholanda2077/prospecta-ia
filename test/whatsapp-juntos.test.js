import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TEMPLATE", "WHATSAPP_TEMPLATE_IDIOMA", "WHATSAPP_APP_SECRET", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const uazap = await import("../src/envio/uazap.js");
const wa = await import("../src/envio/whatsapp.js");
const pipeline = await import("../src/pipeline.js");
await db.iniciar();

const campanha = {
  empresa: { nome: "FluxDeck" },
  limites: { horarioComercial: { inicio: 0, fim: 24 }, somenteDiasUteis: false, envioDiarioMax: 50 },
  automacao: { metaDiaria: { email: 10 } },
};

/** UAZap (token A) e Meta (token EAAprincipal, número 5551) de mentira, guardando por onde saiu cada envio. */
function ladoALado() {
  const envios = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "graph.facebook.com") {
      const pid = u.pathname.split("/")[2];
      if (opcoes.headers?.Authorization !== "Bearer EAAprincipal" || pid !== "5551") return Response.json({ error: { code: 100, message: "Unsupported get request" } }, { status: 400 });
      if (u.pathname.endsWith("/messages")) {
        const corpo = JSON.parse(opcoes.body);
        envios.push({ por: "oficial", para: corpo.to, tipo: corpo.type });
        return Response.json({ messages: [{ id: `wamid.${envios.length}` }] });
      }
      return Response.json({ display_phone_number: "+55 11 93901-7351", verified_name: "FluxDeck", status: "CONNECTED", health_status: { can_send_message: "LIMITED" } });
    }
    if (opcoes.headers?.token !== "A") return Response.json({ error: "Invalid token" }, { status: 401 });
    const rota = `${opcoes.method ?? "GET"} ${u.pathname}`;
    if (rota === "GET /instance/status") return Response.json({ instance: { status: "connected" }, status: { connected: true, loggedIn: true, jid: "5511953528042@s.whatsapp.net" } });
    if (rota === "POST /webhook") return Response.json({ ok: true });
    if (rota === "POST /send/text") {
      envios.push({ por: "uazap", para: JSON.parse(opcoes.body).number, tipo: "text" });
      return Response.json({ messageid: `msg-${envios.length}` });
    }
    return Response.json({ error: `sem rota ${rota}` }, { status: 404 });
  };
  return { envios, restaurar: () => (globalThis.fetch = original) };
}

async function empresa(nome, numero, { tipo = "inicial", etapa = 1 } = {}) {
  await db.inserirLead({ place_id: nome, nome, nicho: "clínica", cidade: "Osasco", endereco: null,
                         telefone: null, site: null, maps_url: null, avaliacao: null, total_avaliacoes: null });
  const lead = (await db.leadsPorStatus("novo")).find((l) => l.nome === nome);
  await db.atualizarLead(lead.id, { whatsapp: numero, status: "analisado", oportunidades: "[]" });
  const id = await db.criarMensagem({ lead_id: lead.id, canal: "whatsapp", destino: numero, corpo: "Oi", status: "aprovada", tipo, etapa });
  return { lead: lead.id, mensagem: await db.buscarMensagem(id) };
}

const resposta = async (leadId, numero) =>
  db.buscarMensagem(await db.criarMensagem({ lead_id: leadId, canal: "whatsapp", destino: numero, corpo: "Claro!", status: "aprovada", tipo: "resposta", etapa: 0 }));

test("API oficial e UAZap juntas: as empresas se dividem entre os números das duas e cada uma fica no seu", async () => {
  const falsa = ladoALado();
  try {
    await uazap.salvarNumero({ nome: "UAZap 8042", url: "https://fluxdeck.uazapi.com", token: "A" });
    await wa.salvarConfig({ token: "EAAprincipal", phoneNumberId: "5551", template: "proposta_inicial", idioma: "pt_BR", appSecret: "s", ativo: true });
    assert.equal(await pipeline.modoWhatsapp(), "oficial");
    assert.equal(await wa.prontoParaEmpresaNova("meta-5551"), true);
    assert.equal(await wa.prontoParaEmpresaNova("meta-0000"), false); // número que não está no sistema

    // Empresas novas se revezam entre o número oficial e o da UAZap, pelo que cada um mandou hoje.
    const a = await empresa("Clínica A", "5511988880001");
    const b = await empresa("Clínica B", "5511988880002");
    const c = await empresa("Clínica C", "5511988880003");
    for (const x of [a, b, c]) assert.equal((await pipeline.enviarMensagem(x.mensagem, campanha)).enviada, true);
    assert.deepEqual(falsa.envios.map((e) => [e.por, e.tipo]), [["oficial", "template"], ["uazap", "text"], ["oficial", "template"]]);
    const numeroDe = async (id) => (await db.buscarLead(id)).numero_wa;
    assert.deepEqual([await numeroDe(a.lead), await numeroDe(b.lead), await numeroDe(c.lead)], ["meta-5551", uazap.PRINCIPAL, "meta-5551"]);

    // Cada conversa continua pelo número que já fala com a empresa, de um lado ou do outro.
    await pipeline.enviarMensagem(await resposta(b.lead, "5511988880002"), campanha);
    await pipeline.enviarMensagem(await resposta(a.lead, "5511988880001"), campanha);
    assert.deepEqual(falsa.envios.slice(3).map((e) => [e.por, e.para, e.tipo]), [["uazap", "5511988880002", "text"], ["oficial", "5511988880001", "text"]]);

    // Conversa antiga (de antes, sem número guardado) segue pela UAZap, onde começou.
    const antiga = await empresa("Clínica Antiga", "5511988880004");
    await db.atualizarMensagem(antiga.mensagem.id, { status: "enviada", enviada_em: new Date().toISOString() });
    assert.deepEqual(await pipeline.canalDoWhatsapp(await resposta(antiga.lead, "5511988880004")), { modo: "uazap", numeroId: uazap.PRINCIPAL });

    // Número oficial desligado: a empresa dele passa a ser atendida pela UAZap.
    await wa.salvarConfig({ token: "EAAprincipal", phoneNumberId: "5551", ativo: false });
    assert.deepEqual(await pipeline.canalDoWhatsapp(await resposta(a.lead, "5511988880001")), { modo: "uazap", numeroId: uazap.PRINCIPAL });
  } finally {
    falsa.restaurar();
  }
});
