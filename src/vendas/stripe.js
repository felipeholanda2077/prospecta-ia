import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";
import { PAISES, arredondarPreco, configInternacional, cotacoes } from "../internacional.js";
import { lerApresentacao } from "../respostas/apresentacao.js";

// Pagamento das empresas de fora do Brasil pelo Stripe: um link de pagamento com a mensalidade na moeda do
// cliente (euro ou dólar), no cartão, recorrente todo mês. Você cria a conta no Stripe e cola a chave secreta
// em Configurações; ela fica criptografada no banco. Cada link é guardado e reaproveitado (mesma empresa,
// mesmo plano e mesmo valor).
const API = "https://api.stripe.com/v1";
const CONFIG = "stripe";
export const MARCADOR_PAGAMENTO = /\{\{\s*pagamento\s*:\s*([^}|]+?)\s*(?:\|\s*([^}]+?)\s*)?\}\}/i;

async function chave() {
  const c = await db.lerConfig(CONFIG);
  return c?.chave ? decifrar(c.chave) : null;
}

async function chamar(caminho, { metodo = "GET", campos = null, segredo } = {}) {
  const r = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${segredo ?? (await chave())}`, ...(campos ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    ...(campos ? { body: new URLSearchParams(campos).toString() } : {}),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe: ${dados.error?.message ?? `erro ${r.status}`}`);
  return dados;
}

/** Conectado? (E se a chave ficou trancada porque a senha do painel mudou.) */
export async function situacao() {
  const c = await db.lerConfig(CONFIG);
  if (!c?.chave) return { conectado: false };
  const aberta = decifrar(c.chave);
  return { conectado: Boolean(aberta), trancada: !aberta, conta: c.conta ?? "", teste: Boolean(c.teste), conectadoEm: c.conectadoEm ?? null };
}

/** Confere a chave no Stripe e guarda criptografada. `chave: null` desconecta. */
export async function conectar({ chave: nova }) {
  if (nova === null) {
    await db.gravarConfig(CONFIG, {});
    return { conectado: false };
  }
  const segredo = String(nova ?? "").trim();
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(segredo)) throw new Error("Cole a chave secreta do Stripe (começa com sk_live_ ou rk_live_)");
  const conta = await chamar("/account", { segredo });
  const info = { chave: cifrar(segredo), conta: conta.settings?.dashboard?.display_name || conta.business_profile?.name || conta.email || conta.id,
    teste: segredo.includes("_test_"), conectadoEm: new Date().toISOString() };
  await db.gravarConfig(CONFIG, info);
  return { conectado: true, conta: info.conta, teste: info.teste, podeCobrar: conta.charges_enabled !== false };
}

/** Os planos da apresentação com o valor por mês em reais ("Professional (R$ 2.500/mês, ...)"). */
export function planosDaApresentacao(texto) {
  const planos = [];
  for (const linha of String(texto ?? "").split("\n")) {
    const m = linha.match(/^\s*-\s*([^(:]+?)\s*\(R\$\s?([\d.]+(?:,\d{1,2})?)\s*\/\s*m[eê]s/i);
    if (m) planos.push({ nome: m[1].trim(), reais: Number(m[2].replace(/\./g, "").replace(",", ".")) });
    // Promoção ("... de R$ 4.500/mês por R$ 3.000/mês"): o valor promocional também vale para o mesmo plano.
    const p = linha.match(/:\s*([^:]+?)\s+de\s+R\$\s?[\d.]+\/m[eê]s\s+por\s+R\$\s?([\d.]+)\/m[eê]s/i);
    if (p) planos.push({ nome: p[1].trim(), reais: Number(p[2].replace(/\./g, "")), promocao: true });
  }
  return planos;
}

const simples = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * O valor por mês, na moeda da empresa, do plano citado pela IA. O valor que a IA escreveu só vale se for o de
 * algum plano (ela não inventa desconto); sem valor, vale o do plano pelo nome.
 */
export async function valorDoPlano({ plano, valor, lead, apresentacao }) {
  const pais = PAISES[lead?.pais];
  if (!pais || lead.pais === "BR") return null;
  const [cot, conf] = await Promise.all([cotacoes(), configInternacional()]);
  const local = (reais) => arredondarPreco(reais * cot[pais.moeda] * (1 + conf.ajustePct / 100));
  const planos = planosDaApresentacao(apresentacao ?? (await lerApresentacao())).map((p) => ({ ...p, local: local(p.reais) }));
  const pedido = Number(String(valor ?? "").replace(/[^\d.,]/g, "").replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
  const nome = simples(plano);
  const doNome = planos.filter((p) => simples(p.nome) === nome || simples(p.nome).includes(nome) || nome.includes(simples(p.nome)));
  const certo = (pedido && (doNome.find((p) => p.local === pedido) ?? planos.find((p) => p.local === pedido)))
    // Pelo nome: o nome exato primeiro; no mesmo plano, o preço da promoção vale.
    || doNome.sort((a, b) => Number(simples(b.nome) === nome) - Number(simples(a.nome) === nome)
      || Number(Boolean(b.promocao)) - Number(Boolean(a.promocao)) || a.nome.length - b.nome.length)[0];
  return certo ? { nome: certo.nome, valor: certo.local, moeda: pais.moeda } : null;
}

/** O link de pagamento (mensalidade no cartão) para a empresa e o plano. Reaproveita o que já foi criado. */
export async function linkDePagamento({ lead, nome, valor, moeda }) {
  const guarda = `stripe_link:${lead.id}:${simples(nome)}:${valor}${moeda}`;
  const salvo = await db.lerEstado(guarda);
  if (salvo) return salvo;
  const preco = await chamar("/prices", { metodo: "POST", campos: {
    currency: moeda.toLowerCase(), unit_amount: String(Math.round(valor * 100)), "recurring[interval]": "month",
    "product_data[name]": `FluxDeck · ${nome}`, "metadata[lead_id]": String(lead.id),
  } });
  const link = await chamar("/payment_links", { metodo: "POST", campos: {
    "line_items[0][price]": preco.id, "line_items[0][quantity]": "1",
    "metadata[lead_id]": String(lead.id), "metadata[empresa]": String(lead.nome ?? "").slice(0, 200), "metadata[plano]": nome,
    "subscription_data[metadata][lead_id]": String(lead.id), "billing_address_collection": "auto",
  } });
  await db.gravarEstado(guarda, link.url);
  return link.url;
}

/**
 * Troca o marcador {{pagamento:Plano|valor}} da resposta da IA pelo link de pagamento. Sem Stripe, sem plano
 * reconhecido ou com erro, tira o marcador e a conversa passa para você (`precisa_humano`).
 */
export async function aplicarLinkDePagamento(c, lead, { apresentacao } = {}) {
  const textos = [c?.sugestao_resposta, ...(c?.partes ?? [])].filter(Boolean);
  if (!textos.some((t) => MARCADOR_PAGAMENTO.test(t))) return c;
  let url = null;
  let motivo = null;
  try {
    const m = textos.map((t) => t.match(MARCADOR_PAGAMENTO)).find(Boolean);
    const plano = await valorDoPlano({ plano: m[1], valor: m[2], lead, apresentacao });
    if (!plano) motivo = `a IA quis mandar o pagamento de "${m[1]}", plano que não está na apresentação`;
    else if (!(await situacao()).conectado) motivo = "a empresa quer pagar, mas o Stripe não está conectado em Configurações";
    else url = await linkDePagamento({ lead, ...plano });
  } catch (e) {
    motivo = `não deu para criar o link de pagamento: ${e.message}`;
  }
  const trocar = (t) => String(t).replace(new RegExp(MARCADOR_PAGAMENTO.source, "gi"), url ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const novo = { ...c, sugestao_resposta: c.sugestao_resposta ? trocar(c.sugestao_resposta) : c.sugestao_resposta };
  if (c.partes) novo.partes = c.partes.map(trocar).filter((p) => p.trim());
  if (url) novo.linkDePagamento = url;
  if (motivo) Object.assign(novo, { precisa_humano: true, motivo_humano: motivo });
  return novo;
}

/**
 * Teste da conexão sem cobrar ninguém: a conta pode cobrar? E cria um link de exemplo (Professional, em dólar)
 * para conferir a página de pagamento. Com `desativar`, desliga o link de exemplo (ninguém consegue pagar).
 */
export async function testar({ desativar = null } = {}) {
  if (desativar) {
    await chamar(`/payment_links/${encodeURIComponent(desativar)}`, { metodo: "POST", campos: { active: "false" } });
    return { desativado: desativar };
  }
  const conta = await chamar("/account");
  const plano = await valorDoPlano({ plano: "Professional", lead: { pais: "US" } });
  const preco = await chamar("/prices", { metodo: "POST", campos: {
    currency: "usd", unit_amount: String(Math.round(plano.valor * 100)), "recurring[interval]": "month", "product_data[name]": "FluxDeck · Professional (exemplo)",
  } });
  const link = await chamar("/payment_links", { metodo: "POST", campos: { "line_items[0][price]": preco.id, "line_items[0][quantity]": "1", "metadata[teste]": "sim" } });
  return { podeCobrar: conta.charges_enabled !== false, podeReceber: conta.payouts_enabled !== false, pendencias: conta.requirements?.currently_due ?? [], plano, link: link.url, id: link.id };
}
