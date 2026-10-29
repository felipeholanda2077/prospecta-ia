import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TEMPLATE", "WHATSAPP_TEMPLATE_IDIOMA", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "UAZAP_URL", "UAZAP_TOKEN", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const wa = await import("../src/envio/whatsapp.js");
const pipeline = await import("../src/pipeline.js");

/** Graph API de mentira: guarda as chamadas e responde conforme o caminho. */
function metaFalsa({ tokenValido = "EAAtoken", template = { name: "proposta_inicial", status: "APPROVED", language: "pt_BR" } } = {}) {
  const chamadas = [];
  const fetchAntes = globalThis.fetch;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(url);
    chamadas.push({ caminho: u.pathname, busca: u.search, metodo: opcoes.method ?? "GET", corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
    if (opcoes.headers?.Authorization !== `Bearer ${tokenValido}`) {
      return Response.json({ error: { code: 190, message: "Invalid OAuth access token" } }, { status: 401 });
    }
    if (u.pathname.endsWith("/debug_token")) {
      return Response.json({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["waba1"] }] } });
    }
    if (u.pathname.endsWith("/waba1/message_templates")) return Response.json({ data: template ? [template] : [] });
    if (u.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "wamid.1" }] });
    if (u.pathname.endsWith("/5551")) {
      return Response.json({ display_phone_number: "+55 11 99999-0000", verified_name: "FluxDeck", quality_rating: "GREEN" });
    }
    return Response.json({ error: { code: 100, message: "Unsupported get request" } }, { status: 400 });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = fetchAntes) };
}

test("whatsapp oficial: o painel salva token e número depois de conferir com a Meta", async () => {
  const meta = metaFalsa();
  try {
    assert.equal(await pipeline.modoWhatsapp(), "manual");
    await assert.rejects(wa.salvarConfig({ token: "errado", phoneNumberId: "5551" }), /recusou o token/);
    await assert.rejects(wa.salvarConfig({ token: "EAAtoken", phoneNumberId: "999" }), /não encontrou esse ID/);
    await assert.rejects(wa.salvarConfig({ token: "EAAtoken", phoneNumberId: "5551", template: "Proposta Inicial" }), /letras minúsculas/);

    await wa.salvarConfig({ token: " EAAtoken ", phoneNumberId: "55 51", appSecret: "segredo" });
    const c = await wa.obterConfig();
    assert.equal(c.phoneNumberId, "5551");
    assert.equal(c.template, "proposta_inicial");
    assert.equal(c.idioma, "pt_BR");
    assert.match(c.verifyToken, /^[0-9a-f]{32}$/);
    // Salvo, mas ainda desligado: o WhatsApp continua saindo como antes.
    assert.equal(c.ativo, false);
    assert.equal(await pipeline.modoWhatsapp(), "manual");

    const st = await wa.statusOficial();
    assert.deepEqual([st.numero, st.nome, st.qualidade], ["+55 11 99999-0000", "FluxDeck", "GREEN"]);
    assert.equal(st.template.status, "APPROVED");

    // Ligado, passa na frente das outras integrações.
    await wa.definirAtivo(true);
    assert.equal(await pipeline.modoWhatsapp(), "oficial");

    // Trocar só o template não pede o token de novo nem gera outro token de verificação.
    await wa.salvarConfig({ template: "primeiro_contato" });
    const depois = await wa.obterConfig();
    assert.equal(depois.token, "EAAtoken");
    assert.equal(depois.verifyToken, c.verifyToken);
    assert.equal(depois.ativo, true);
  } finally {
    meta.restaurar();
  }
});

test("whatsapp oficial: o primeiro contato sai pelo template salvo e a resposta sai como texto", async () => {
  const meta = metaFalsa();
  try {
    await wa.salvarConfig({ token: "EAAtoken", phoneNumberId: "5551", template: "proposta_inicial", idioma: "pt_BR", ativo: true });
    const id = await wa.enviarWhatsapp({ para: "5511988887777", empresa: "Belieze", corpo: "Oi!\n\nVi o seu Instagram." });
    assert.equal(id, "wamid.1");
    const envio = meta.chamadas.at(-1);
    assert.match(envio.caminho, /\/5551\/messages$/);
    assert.equal(envio.corpo.template.name, "proposta_inicial");
    assert.deepEqual(envio.corpo.template.components[0].parameters.map((p) => p.text), ["Belieze", "Oi! Vi o seu Instagram."]);

    await wa.enviarTextoWhatsappOficial({ para: "5511988887777", corpo: "Claro! Te mando o link." });
    assert.deepEqual(meta.chamadas.at(-1).corpo.text, { body: "Claro! Te mando o link." });

    await wa.definirAtivo(false);
    await assert.rejects(wa.enviarWhatsapp({ para: "55119", empresa: "X", corpo: "Oi" }), /desligada/);
  } finally {
    meta.restaurar();
  }
});

test("whatsapp oficial: o painel avisa quando o template não está aprovado", async () => {
  const meta = metaFalsa({ template: { name: "proposta_inicial", status: "REJECTED", language: "pt_BR" } });
  try {
    await wa.salvarConfig({ token: "EAAtoken", phoneNumberId: "5551", template: "proposta_inicial" });
    assert.equal((await wa.statusOficial()).template.status, "REJECTED");
  } finally {
    meta.restaurar();
  }
  const sem = metaFalsa({ template: null });
  try {
    assert.equal((await wa.statusOficial()).template.status, "NAO_ENCONTRADO");
  } finally {
    sem.restaurar();
  }
});
