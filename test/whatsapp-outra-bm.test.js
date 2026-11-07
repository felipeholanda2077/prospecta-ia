import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
for (const k of ["WHATSAPP_ATIVO", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TEMPLATE", "WHATSAPP_TEMPLATE_IDIOMA", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]) delete process.env[k];
const db = await import("../src/db.js");
const wa = await import("../src/envio/whatsapp.js");
await db.iniciar();

/**
 * Meta de mentira: a BM principal (token EAAprincipal, conta 900, número 5551) e outra BM
 * (token EAAoutra, conta 800 sem fuso, números 7771 e 7772).
 */
function metaFalsa() {
  const chamadas = [];
  const antes = globalThis.fetch;
  const contas = {
    "Bearer EAAprincipal": { 900: { numeros: ["5551"], nome: "FluxDeck", bm: { id: "111", name: "FluxDeck" }, fuso: "25" } },
    "Bearer EAAoutra": { 800: { numeros: ["7771", "7772"], nome: "Kaique WA", bm: { id: "222", name: "Kaique BM" }, fuso: "0" } }, // a Meta devolve "0" sem fuso
  };
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(url);
    const auth = opcoes.headers?.Authorization;
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    const partes = u.pathname.split("/").slice(2);
    chamadas.push({ partes, auth, corpo, metodo: opcoes.method ?? "GET" });
    const minhas = contas[auth] ?? {};
    // A outra BM tem token com acesso a tudo: a Meta não lista os ids, e a conta sai pela BM do token.
    if (partes[0] === "debug_token") {
      const alvo = auth === "Bearer EAAoutra" ? {} : { target_ids: Object.keys(minhas) };
      return Response.json({ data: { granular_scopes: [{ scope: "whatsapp_business_management", ...alvo }] } });
    }
    if (partes[0] === "me" && partes[1] === "businesses") return Response.json({ data: auth === "Bearer EAAoutra" ? [{ id: "222" }] : [] });
    if (partes[0] === "222" && u.searchParams.get("metadata")) return Response.json({ id: "222", metadata: { type: "business" } });
    if (partes[0] === "222" && partes[1] === "phone_numbers") return Response.json({ error: { code: 100, message: "(#100) Tried accessing nonexisting field (phone_numbers) on node type (Business)" } }, { status: 400 });
    if (partes[0] === "333" && u.searchParams.get("metadata")) return Response.json({ id: "333", metadata: { type: "application" } });
    if (partes[0] === "333") return Response.json({ error: { code: 100, message: "(#100) Tried accessing nonexisting field (phone_numbers) on node type (Application)" } }, { status: 400 });
    if (partes[0] === "222") return Response.json({ data: partes[1] === "owned_whatsapp_business_accounts" && auth === "Bearer EAAoutra" ? [{ id: "800" }] : [] });
    const conta = minhas[partes[0]];
    if (conta) {
      if (partes[1] === "phone_numbers") return Response.json({ data: conta.numeros.map((id) => ({ id, display_phone_number: `+55 11 9${id}`, verified_name: `Num ${id}`, status: "DISCONNECTED" })) });
      if (partes[1] === "subscribed_apps") return Response.json({ success: true });
      if (partes[1] === "message_templates") return Response.json({ data: [] });
      if (corpo?.timezone_id) { conta.fuso = corpo.timezone_id; return Response.json({ success: true }); }
      return Response.json({ id: partes[0], name: conta.nome, timezone_id: conta.fuso, owner_business_info: conta.bm });
    }
    const dono = Object.values(minhas).find((c) => c.numeros.includes(partes[0]));
    if (!dono) return Response.json({ error: { code: 100, message: "Unsupported get request" } }, { status: 400 });
    if (partes[1] === "request_code") return Response.json({ success: true });
    if (partes[1] === "verify_code") return corpo.code === "123456" ? Response.json({ success: true }) : Response.json({ error: { code: 136025, message: "bad code" } }, { status: 400 });
    if (partes[1] === "register") return Response.json({ success: true });
    const erros = dono.fuso && dono.fuso !== "0" ? [] : [{ error_code: 141007, error_description: "A timezone must be set before sending out messages." }];
    return Response.json({
      display_phone_number: `+55 11 9${partes[0]}`, verified_name: `Num ${partes[0]}`, status: "DISCONNECTED", code_verification_status: "NOT_VERIFIED",
      health_status: { can_send_message: "BLOCKED", entities: [{ errors: erros }] },
    });
  };
  return { chamadas, restaurar: () => (globalThis.fetch = antes) };
}

test("outra BM (token sem lista de contas): lista os números do token, adiciona já definindo o fuso, e confirma código e registro", async () => {
  const meta = metaFalsa();
  try {
    await wa.salvarConfig({ token: "EAAprincipal", phoneNumberId: "5551", appSecret: "s", ativo: true });

    // Sem token: números da BM principal (o principal já aparece como "no sistema").
    const mesma = await wa.descobrirNumeros("");
    assert.deepEqual(mesma.map((n) => [n.phoneNumberId, n.noSistema, n.empresa]), [["5551", true, "FluxDeck"]]);

    // Com o token da outra BM: os números dela, com a BM e a conta.
    const outra = await wa.descobrirNumeros("EAAoutra");
    assert.deepEqual(outra.map((n) => [n.phoneNumberId, n.contaId, n.empresa, n.noSistema]), [["7771", "800", "Kaique BM", false], ["7772", "800", "Kaique BM", false]]);
    await assert.rejects(wa.descobrirNumeros("EAAnada"), /não conseguiu listar as contas.*Resposta da Meta: 100/);

    // Antes de corrigir, o status mostra a conta sem fuso e os links da BM do número (não da principal).
    await db.gravarConfig("whatsapp_oficial", { ...(await db.lerConfig("whatsapp_oficial")), extras: [{ nome: "Kaique", phoneNumberId: "7772", token: "EAAoutra", ativo: false }] });
    const antes = await wa.statusOficial("meta-7772");
    assert.equal(antes.numero, "+55 11 97772");
    assert.equal(antes.conta.fuso, null);
    assert.equal(antes.conta.empresaNome, "Kaique BM");
    assert.match(antes.conta.links.pagamento, /business_id=222/);
    assert.deepEqual(antes.situacao.erros.map((e) => e.codigo), [141007]);

    // Corrigir define o fuso de São Paulo (25) e liga as respostas, mesmo com o número desligado.
    const r = await wa.corrigirNaMeta("meta-7772");
    assert.deepEqual(r.falhou, []);
    assert.equal(r.feito.length, 2);
    const postFuso = meta.chamadas.find((c) => c.corpo?.timezone_id);
    assert.deepEqual([postFuso.partes[0], postFuso.auth, postFuso.corpo.timezone_id], ["800", "Bearer EAAoutra", wa.FUSO_SAO_PAULO]);
    assert.deepEqual((await wa.statusOficial("meta-7772")).situacao.erros, []);

    // Adicionar outro número da mesma BM: guarda a conta e já corrige (a conta já tem fuso, então só liga as respostas).
    const n = await wa.adicionarNumero({ phoneNumberId: "7771", token: "EAAoutra", contaId: "800", appSecret: "segredo2" });
    assert.deepEqual(n.correcao.falhou, []);
    assert.deepEqual(n.correcao.feito, ["respostas ligadas ao sistema"]);
    const lista = await wa.numerosOficiais();
    assert.equal(lista.find((x) => x.id === "meta-7771").segredoProprio, true);
    assert.equal(JSON.stringify(lista).includes("segredo2"), false);

    // Código de posse e registro vão para o número certo, com o token da BM dele.
    await wa.pedirCodigo("meta-7771", "SMS");
    await assert.rejects(wa.confirmarCodigo("meta-7771", "000000"), /não confere/);
    await assert.rejects(wa.confirmarCodigo("meta-7771", "12"), /6 números/);
    await wa.confirmarCodigo("meta-7771", "123 456");
    await wa.registrarNumero("654321", "meta-7771");
    const doNumero = meta.chamadas.filter((c) => c.partes[0] === "7771" && c.metodo === "POST");
    assert.deepEqual(doNumero.map((c) => [c.partes[1], c.auth]), [
      ["request_code", "Bearer EAAoutra"], ["verify_code", "Bearer EAAoutra"], ["verify_code", "Bearer EAAoutra"], ["register", "Bearer EAAoutra"],
    ]);
    await assert.rejects(wa.pedirCodigo("meta-0000"), /não encontrado/);

    // ID da conta informado à mão: confere na Meta se a conta tem o número antes de guardar.
    await assert.rejects(wa.definirContaDoNumero("meta-7771", "900"), /não achou esse ID com o token deste número/);
    // ID da BM no lugar da conta (o erro "nonexisting field (phone_numbers)"): acha a conta da BM que tem o número.
    assert.deepEqual(await wa.definirContaDoNumero("meta-7771", "222"), { contaId: "800" });
    // Outros IDs explicam o que foi colado.
    await assert.rejects(wa.definirContaDoNumero("meta-7771", "333"), /não é de uma conta do WhatsApp Business \(é o ID de um app\)/);
    await assert.rejects(wa.definirContaDoNumero("meta-7771", "7771"), /ID do número de telefone/);
    await assert.rejects(wa.definirContaDoNumero("meta-7771", "5511987654321"), /número do WhatsApp/);
    await wa.definirContaDoNumero("meta-7771", "800");
    assert.equal((await db.lerConfig("whatsapp_oficial")).extras.find((e) => e.phoneNumberId === "7771").contaId, "800");

    // Trocar o token: recusa token que não enxerga o número; o novo fica guardado e já corrige.
    await assert.rejects(wa.trocarTokenDoNumero("meta-7771", "EAAprincipal"), /não encontrou/);
    const troca = await wa.trocarTokenDoNumero("meta-7771", "EAAoutra");
    assert.deepEqual(troca.falhou, []);
    await assert.rejects(wa.trocarTokenDoNumero("meta-5551", "EAAoutra"), /formulário da conexão/);
  } finally {
    meta.restaurar();
  }
});
