import * as db from "../db.js";
import * as cobrancas from "../contratos/cobranca.js";
import * as entrada from "./entrada.js";
import { lerValor, MESES } from "../contratos/valores.js";

// Meta de faturamento do mês, editada na Dashboard. O que entrou em caixa vem sozinho das cobranças
// e vendas pagas no mês; quem quiser pode trocar esse valor à mão (dinheiro que entrou por fora, por exemplo).

const chaveDoMes = (mes) => `meta_mes:${mes}`;
const ULTIMA_META = "meta_mes:ultima";

/** "2026-11" no horário de Brasília. */
export function mesDe(agora = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
  const v = (t) => p.find((x) => x.type === t).value;
  return { mes: `${v("year")}-${v("month")}`, ano: Number(v("year")), numero: Number(v("month")), dia: Number(v("day")) };
}

/** Soma das cobranças (Asaas) e vendas pagas neste mês. Null quando não dá para ler. */
async function recebidoAutomatico() {
  try {
    const [parcelas, vendas] = await Promise.all([cobrancas.painelDeCobrancas(), entrada.painelDeVendas()]);
    return (parcelas.resumo?.recebidoNoMes ?? 0) + (vendas.recebidoNoMes ?? 0);
  } catch {
    return null;
  }
}

async function lerDoMes(mes) {
  try { return JSON.parse((await db.lerEstado(chaveDoMes(mes))) ?? "{}"); } catch { return {}; }
}

/**
 * A meta do mês, quanto entrou em caixa e quanto falta. Sem meta neste mês, usa a última definida.
 * `automatico` existe para os testes.
 */
export async function metaDoMes({ agora = new Date(), automatico = recebidoAutomatico } = {}) {
  const { mes, ano, numero, dia } = mesDe(agora);
  const salvo = await lerDoMes(mes);
  const ultima = lerValor(await db.lerEstado(ULTIMA_META));
  const meta = salvo.meta ?? ultima ?? null;
  const auto = await automatico();
  const manual = typeof salvo.caixa === "number";
  const caixa = manual ? salvo.caixa : auto ?? 0;
  const diasNoMes = new Date(ano, numero, 0).getDate();
  const diasRestantes = diasNoMes - dia + 1;
  const falta = meta == null ? null : Math.max(0, Math.round((meta - caixa) * 100) / 100);
  return {
    mes,
    nomeDoMes: `${MESES[numero - 1]} de ${ano}`,
    meta,
    metaDoMesAnterior: salvo.meta == null && ultima != null,
    caixa,
    caixaManual: manual,
    caixaAutomatico: auto,
    falta,
    porcentagem: meta ? Math.min(999, Math.round((caixa / meta) * 100)) : null,
    bateu: meta != null && caixa >= meta,
    diasRestantes,
    porDia: falta ? Math.round((falta / diasRestantes) * 100) / 100 : 0,
  };
}

/**
 * Salva o que foi editado. `meta`: o valor da meta do mês. `caixa`: o valor que entrou em caixa
 * (vazio ou `null` volta para a soma automática). Campos que não vierem ficam como estão.
 */
export async function salvarMetaDoMes({ meta, caixa } = {}, { agora = new Date(), automatico } = {}) {
  const { mes } = mesDe(agora);
  const salvo = await lerDoMes(mes);
  if (meta !== undefined) {
    const v = lerValor(meta);
    if (v == null || v <= 0) throw new Error("Informe a meta do mês em reais, por exemplo 20.000");
    salvo.meta = Math.round(v * 100) / 100;
    await db.gravarEstado(ULTIMA_META, String(salvo.meta));
  }
  if (caixa !== undefined) {
    if (caixa === null || String(caixa).trim() === "") delete salvo.caixa;
    else {
      const v = lerValor(caixa);
      if (v == null || v < 0) throw new Error("Informe o valor que entrou em caixa em reais, por exemplo 5.300,00");
      salvo.caixa = Math.round(v * 100) / 100;
    }
  }
  salvo.atualizadoEm = agora.toISOString();
  await db.gravarEstado(chaveDoMes(mes), JSON.stringify(salvo));
  return metaDoMes({ agora, ...(automatico ? { automatico } : {}) });
}
