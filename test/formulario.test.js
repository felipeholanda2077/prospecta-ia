import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
process.env.TZ = "America/Sao_Paulo";
for (const k of ["UAZAP_URL", "UAZAP_TOKEN", "SMTP_HOST", "MODO_TESTE_EMAIL", "MODO_TESTE_WHATSAPP"]) delete process.env[k];
const db = await import("../src/db.js");
const { validarFormulario, receberFormulario, salvarConfigFormulario } = await import("../src/respostas/formulario.js");
// Abre o banco antes: com a suíte inteira ele demora, e isso gastaria a trava de 20 s por IP do teste.
await db.iniciar();

const campanha = { empresa: { nome: "FluxDeck", responsavel: "Felipe" }, servicos: [], automacao: { respostaAutomatica: false, maxRespostasIA: 5 } };
const agora = Date.now();
const avisar = async () => {}; // sem e-mail de verdade nos testes
const envio = (extra = {}) => ({ nome: "Patrícia", empresa: "Belieze", whatsapp: "(85) 99876-5432", servico: "Loja virtual (e-commerce)",
  mensagem: "Quero vender online", consentimento: true, t: agora - 10_000, origem: "instagram", ...extra });

test("formulário: confere os campos e barra robô sem avisar", () => {
  assert.equal(validarFormulario(envio({ nome: "P" })).erro, "Conta pra gente o seu nome.");
  assert.match(validarFormulario(envio({ whatsapp: "123" })).erro, /Confira o WhatsApp/);
  assert.match(validarFormulario(envio({ whatsapp: "", email: "" })).erro, /WhatsApp \(ou e-mail\)/);
  assert.match(validarFormulario(envio({ email: "x@" })).erro, /e-mail/);
  assert.match(validarFormulario(envio({ consentimento: false })).erro, /aceita ser contatado/);
  assert.equal(validarFormulario(envio({ site: "http://spam" })).robo, true); // campo escondido
  assert.equal(validarFormulario(envio({ t: agora - 500 }), agora).robo, true); // rápido demais
  const ok = validarFormulario(envio({ origem: "insta<script>" }));
  assert.deepEqual([ok.whatsapp, ok.origem, ok.nome], ["5585998765432", "instascript", "Patrícia"]);
});

test("formulário: vira lead em conversa, a IA responde pelo WhatsApp, e o envio repetido não duplica", async () => {
  let registrado = null;
  const registrar = async (o) => ((registrado = o), { id: 1 });
  const r = await receberFormulario(envio(), campanha, { ip: "1.2.3.4", agora, registrar, avisar });
  assert.equal(r.ok, true);
  const lead = await db.buscarLead(r.leadId);
  assert.deepEqual([lead.nome, lead.origem, lead.status, lead.whatsapp], ["Belieze", "formulario", "respondeu", "5585998765432"]);
  assert.equal(registrado.canal, "whatsapp");
  assert.equal(registrado.de, "5585998765432");
  assert.match(registrado.texto, /\[formulário do site · veio de: instagram\]\nNome: Patrícia\nEmpresa: Belieze\nPrecisa de: Loja virtual/);
  assert.match(registrado.origem_id, /^<formulario-[0-9a-f-]+@prospecta>$/);
  // Ligado no painel (padrão): a IA responde mesmo com a resposta automática desligada.
  assert.equal(registrado.campanha.automacao.respostaAutomatica, true);

  // O mesmo IP logo em seguida: pede para esperar.
  assert.match((await receberFormulario(envio({ whatsapp: "85911112222" }), campanha, { ip: "1.2.3.4", agora, registrar, avisar })).erro, /Aguarde/);
  // A mesma pessoa de novo (outro IP): não abre outra conversa.
  registrado = null;
  assert.equal((await receberFormulario(envio(), campanha, { ip: "5.6.7.8", agora, registrar, avisar })).repetido, true);
  assert.equal(registrado, null);
});

test("formulário: quem já é uma empresa do sistema cai na conversa dela; sem WhatsApp, responde por e-mail", async () => {
  await db.inserirLead({ place_id: "teste-1", nome: "Dental Center", nicho: "clínica", cidade: "Osasco", endereco: null, telefone: null,
                         site: null, maps_url: null, avaliacao: null, total_avaliacoes: null, email: "ana@dentalcenter.com.br" });
  const existente = (await db.leadsPorStatus("novo")).find((l) => l.nome === "Dental Center");
  let registrado = null;
  await salvarConfigFormulario({ iaResponde: false });
  const r = await receberFormulario(envio({ nome: "Ana", empresa: "", whatsapp: "", email: "Ana@DentalCenter.com.br" }), campanha,
    { ip: "9.9.9.9", agora, avisar, registrar: async (o) => ((registrado = o), { id: 2 }) });
  assert.equal(r.leadId, existente.id);
  assert.equal((await db.buscarLead(existente.id)).status, "respondeu");
  assert.deepEqual([registrado.canal, registrado.de, registrado.assunto], ["email", "ana@dentalcenter.com.br", "Seu contato pelo site da FluxDeck"]);
  assert.equal(registrado.campanha.automacao.respostaAutomatica, false); // desligado no painel
});

test("formulário: a página e o envio pelo site (JSON, de outro domínio)", async () => {
  const { app } = await import("../src/app.js");
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    const pagina = await (await fetch(`${base}/contato?origem=instagram&embed=1`)).text();
    assert.match(pagina, /Vamos tirar sua ideia do papel\?/);
    assert.match(pagina, /class="embed"/);
    assert.match(pagina, /name="origem" value="instagram"/);

    const preflight = await fetch(`${base}/contato`, { method: "OPTIONS" });
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    const erro = await fetch(`${base}/contato`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nome: "Jo" }) });
    assert.equal(erro.status, 400);
    assert.match((await erro.json()).erro, /WhatsApp \(ou e-mail\)/);
    // Robô (campo escondido preenchido): responde ok, mas nada entra.
    const antes = (await db.leadsDaOrigem("formulario", 50)).length;
    const robo = await fetch(`${base}/contato`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...envio(), site: "x" }) });
    assert.deepEqual(await robo.json(), { ok: true });
    assert.equal((await db.leadsDaOrigem("formulario", 50)).length, antes);
  } finally {
    servidor.close();
  }
});
