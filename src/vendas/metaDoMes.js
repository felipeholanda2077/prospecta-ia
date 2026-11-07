import crypto from "node:crypto";
import * as db from "../db.js";
import { lerValor, MESES } from "../contratos/valores.js";

// Meta de faturamento do mês, editada na Dashboard. O caixa geral é a soma das entradas, cada tipo
// com o seu valor: as que o sistema conhece sozinho (cobranças do Asaas e vendas pagas no mês), que
// podem ser ajustadas, e as que você lança à mão (Pix, dinheiro, projeto avulso...).

const chaveDoMes = (mes) => `meta_mes:${mes}`;
const ULTIMA_META = "meta_mes:ultima";

/** Entradas que o sistema soma sozinho, já separadas em recorrentes (todo mês) e avulsas. */
export const FONTES_AUTOMATICAS = [
  { id: "contratos_mensais", nome: "Mensalidades de contratos (Asaas)", recorrente: true },
  { id: "contratos_avulsos", nome: "Parcelas avulsas de contratos (Asaas)", recorrente: false },
  { id: "assinaturas", nome: "Assinaturas (vendas mensais)", recorrente: true },
  { id: "vendas_avulsas", nome: "Vendas avulsas", recorrente: false },
];

/** Tipos de entrada para lançar à mão (dá para escrever outro). */
export const TIPOS_DE_ENTRADA = ["Venda", "Mensalidade", "Projeto", "Manutenção", "Consultoria", "Pix", "Dinheiro", "Transferência", "Cartão", "Boleto", "Investimento", "Reembolso", "Outro"];

/** "2026-11" no horário de Brasília. */
export function mesDe(agora = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
  const v = (t) => p.find((x) => x.type === t).value;
  return { mes: `${v("year")}-${v("month")}`, ano: Number(v("year")), numero: Number(v("month")), dia: Number(v("day")) };
}

/** Contrato pago por mês em mais de uma parcela ("R$ 500,00 ... por mês, 12 meses") é recorrente. */
export const contratoRecorrente = (resumo) => {
  const m = String(resumo ?? "").match(/por mês, (\d+) m/);
  return Boolean(m && Number(m[1]) > 1);
};

/** Quanto cada fonte automática recebeu no mês. Fonte que não deu para ler fica null. */
async function recebidoAutomatico(mes) {
  const soma = (lista) => Math.round(lista.reduce((t, x) => t + Number(x.valor || 0), 0) * 100) / 100;
  const doMes = (x) => x.status === "paga" && String(x.pago_em ?? "").startsWith(mes);
  let contratosMensais = null, contratosAvulsos = null, assinaturas = null, vendasAvulsas = null;
  try {
    const [parcelas, contratos] = await Promise.all([db.listarCobrancas(), db.listarContratos(1000)]);
    const recorrente = new Map(contratos.map((c) => [c.id, contratoRecorrente(c.resumo)]));
    const pagas = parcelas.filter(doMes);
    contratosMensais = soma(pagas.filter((p) => recorrente.get(p.contrato_id)));
    contratosAvulsos = soma(pagas.filter((p) => !recorrente.get(p.contrato_id)));
  } catch { /* fica sem valor automático */ }
  try {
    const pagas = (await db.listarVendas()).filter(doMes);
    assinaturas = soma(pagas.filter((v) => v.mensal));
    vendasAvulsas = soma(pagas.filter((v) => !v.mensal));
  } catch { /* fica sem valor automático */ }
  return { contratos_mensais: contratosMensais, contratos_avulsos: contratosAvulsos, assinaturas, vendas_avulsas: vendasAvulsas };
}

/** O mês anterior a "2026-11": "2026-10". */
const mesAnterior = (mes) => {
  const [a, m] = mes.split("-").map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
};

/** Entradas recorrentes do último mês que tem entradas salvas (até 12 meses para trás), para repetir neste. */
async function recorrentesAnteriores(mes) {
  let m = mes;
  for (let i = 0; i < 12; i++) {
    m = mesAnterior(m);
    const salvo = await lerDoMes(m);
    if (Array.isArray(salvo.entradas)) return salvo.entradas.filter((e) => e.recorrente);
  }
  return [];
}

async function lerDoMes(mes) {
  try { return JSON.parse((await db.lerEstado(chaveDoMes(mes))) ?? "{}"); } catch { return {}; }
}

const centavos = (v) => Math.round(v * 100) / 100;

/**
 * A meta do mês, cada entrada do caixa e quanto falta. Sem meta neste mês, usa a última definida.
 * `automatico` existe para os testes.
 */
export async function metaDoMes({ agora = new Date(), automatico = recebidoAutomatico } = {}) {
  const { mes, ano, numero, dia } = mesDe(agora);
  const salvo = await lerDoMes(mes);
  const ultima = lerValor(await db.lerEstado(ULTIMA_META));
  const meta = salvo.meta ?? ultima ?? null;
  const auto = await automatico(mes);
  const ajustes = salvo.fontes ?? {};
  const fontes = FONTES_AUTOMATICAS.map((f) => {
    const ajustado = typeof ajustes[f.id] === "number";
    return { ...f, automatico: auto?.[f.id] ?? null, ajustado, valor: ajustado ? ajustes[f.id] : auto?.[f.id] ?? 0 };
  });
  // Mês ainda sem entradas salvas: as recorrentes do mês anterior já aparecem (dá para editar ou tirar).
  const repetidas = !Array.isArray(salvo.entradas);
  const base = repetidas ? await recorrentesAnteriores(mes) : salvo.entradas;
  const entradas = base.map((e) => ({ id: e.id, tipo: e.tipo, descricao: e.descricao ?? "", valor: e.valor, recorrente: Boolean(e.recorrente), repetida: repetidas }));
  const todas = [...fontes, ...entradas];
  const caixa = centavos(todas.reduce((t, e) => t + (e.valor || 0), 0));
  const recorrente = centavos(todas.filter((e) => e.recorrente).reduce((t, e) => t + (e.valor || 0), 0));
  const diasNoMes = new Date(ano, numero, 0).getDate();
  const diasRestantes = diasNoMes - dia + 1;
  const falta = meta == null ? null : Math.max(0, centavos(meta - caixa));
  return {
    mes,
    nomeDoMes: `${MESES[numero - 1]} de ${ano}`,
    meta,
    metaDoMesAnterior: salvo.meta == null && ultima != null,
    fontes,
    entradas,
    tipos: TIPOS_DE_ENTRADA,
    caixa,
    recorrente,
    avulso: centavos(caixa - recorrente),
    falta,
    porcentagem: meta ? Math.min(999, Math.round((caixa / meta) * 100)) : null,
    bateu: meta != null && caixa >= meta,
    diasRestantes,
    porDia: falta ? centavos(falta / diasRestantes) : 0,
  };
}

/** Valor em reais digitado no painel ("R$ 1.500,00", "1500"). `obrigatorio: false` aceita vazio (null). */
function reais(v, rotulo, { obrigatorio = true, zero = true } = {}) {
  if (v === null || v === undefined || String(v).trim() === "") {
    if (obrigatorio) throw new Error(`Informe ${rotulo}`);
    return null;
  }
  const n = lerValor(v);
  if (n == null || n < 0 || (!zero && n === 0)) throw new Error(`Valor inválido em ${rotulo}. Use reais, por exemplo R$ 1.500,00`);
  return centavos(n);
}

/**
 * Salva o que foi editado. Só muda o que vier:
 * - `meta`: o valor da meta do mês;
 * - `fontes`: `{ contratos_mensais, contratos_avulsos, assinaturas, vendas_avulsas }`, cada uma com um valor ajustado à mão ou vazio para voltar ao automático;
 * - `entradas`: a lista inteira das entradas lançadas à mão, `{ id?, tipo, descricao?, valor, recorrente }`.
 */
export async function salvarMetaDoMes({ meta, fontes, entradas } = {}, { agora = new Date(), automatico } = {}) {
  const { mes } = mesDe(agora);
  const salvo = await lerDoMes(mes);
  delete salvo.caixa; // formato antigo: um valor único de caixa
  if (meta !== undefined) {
    salvo.meta = reais(meta, "a meta do mês", { zero: false });
    await db.gravarEstado(ULTIMA_META, String(salvo.meta));
  }
  if (fontes !== undefined) {
    const novas = { ...(salvo.fontes ?? {}) };
    for (const f of FONTES_AUTOMATICAS) {
      if (!(f.id in (fontes ?? {}))) continue;
      const v = reais(fontes[f.id], f.nome, { obrigatorio: false });
      if (v == null) delete novas[f.id];
      else novas[f.id] = v;
    }
    salvo.fontes = novas;
  }
  if (entradas !== undefined) {
    if (!Array.isArray(entradas)) throw new Error("Lista de entradas inválida");
    if (entradas.length > 100) throw new Error("No máximo 100 entradas por mês");
    salvo.entradas = entradas
      .filter((e) => e && (String(e.tipo ?? "").trim() || String(e.valor ?? "").trim()))
      .map((e, i) => {
        const tipo = String(e.tipo ?? "").trim().slice(0, 40);
        if (!tipo) throw new Error(`Escolha o tipo da entrada ${i + 1}`);
        return {
          id: /^[a-z0-9-]{4,40}$/.test(String(e.id ?? "")) ? e.id : crypto.randomUUID(),
          tipo,
          descricao: String(e.descricao ?? "").trim().slice(0, 80),
          valor: reais(e.valor, `o valor de "${tipo}"`),
          recorrente: e.recorrente === true || e.recorrente === "true",
        };
      });
  }
  salvo.atualizadoEm = agora.toISOString();
  await db.gravarEstado(chaveDoMes(mes), JSON.stringify(salvo));
  return metaDoMes({ agora, ...(automatico ? { automatico } : {}) });
}
