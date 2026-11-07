import crypto from "node:crypto";
import * as db from "../db.js";
import * as cobrancas from "../contratos/cobranca.js";
import * as entrada from "./entrada.js";
import { lerValor, MESES } from "../contratos/valores.js";

// Meta de faturamento do mês, editada na Dashboard. O caixa geral é a soma das entradas, cada tipo
// com o seu valor: as que o sistema conhece sozinho (cobranças do Asaas e vendas pagas no mês), que
// podem ser ajustadas, e as que você lança à mão (Pix, dinheiro, projeto avulso...).

const chaveDoMes = (mes) => `meta_mes:${mes}`;
const ULTIMA_META = "meta_mes:ultima";

/** Entradas que o sistema soma sozinho. */
export const FONTES_AUTOMATICAS = [
  { id: "cobrancas", nome: "Cobranças pagas (Asaas)" },
  { id: "vendas", nome: "Vendas pagas" },
];

/** Sugestões de tipo para as entradas lançadas à mão. */
export const TIPOS_DE_ENTRADA = ["Pix", "Dinheiro", "Transferência", "Cartão", "Boleto", "Mensalidade", "Projeto avulso", "Outro"];

/** "2026-11" no horário de Brasília. */
export function mesDe(agora = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
  const v = (t) => p.find((x) => x.type === t).value;
  return { mes: `${v("year")}-${v("month")}`, ano: Number(v("year")), numero: Number(v("month")), dia: Number(v("day")) };
}

/** Quanto cada fonte automática recebeu neste mês. Fonte que não deu para ler fica null. */
async function recebidoAutomatico() {
  const [parcelas, vendas] = await Promise.all([
    cobrancas.painelDeCobrancas().catch(() => null),
    entrada.painelDeVendas().catch(() => null),
  ]);
  return { cobrancas: parcelas ? parcelas.resumo?.recebidoNoMes ?? 0 : null, vendas: vendas ? vendas.recebidoNoMes ?? 0 : null };
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
  const auto = await automatico();
  const ajustes = salvo.fontes ?? {};
  const fontes = FONTES_AUTOMATICAS.map((f) => {
    const ajustado = typeof ajustes[f.id] === "number";
    return { ...f, automatico: auto?.[f.id] ?? null, ajustado, valor: ajustado ? ajustes[f.id] : auto?.[f.id] ?? 0 };
  });
  const entradas = (Array.isArray(salvo.entradas) ? salvo.entradas : []).map((e) => ({ id: e.id, tipo: e.tipo, descricao: e.descricao ?? "", valor: e.valor }));
  const caixa = centavos([...fontes, ...entradas].reduce((t, e) => t + (e.valor || 0), 0));
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
 * - `fontes`: `{ cobrancas, vendas }`, cada uma com um valor ajustado à mão ou vazio para voltar ao automático;
 * - `entradas`: a lista inteira das entradas lançadas à mão, `{ id?, tipo, descricao?, valor }`.
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
        };
      });
  }
  salvo.atualizadoEm = agora.toISOString();
  await db.gravarEstado(chaveDoMes(mes), JSON.stringify(salvo));
  return metaDoMes({ agora, ...(automatico ? { automatico } : {}) });
}
