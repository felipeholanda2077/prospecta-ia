// Valores do contrato escritos como no documento: "R$ 6.000,00 (seis mil reais)".

const UNIDADES = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const DEZENAS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

function ate999(n) {
  if (n === 100) return "cem";
  const partes = [];
  if (n >= 100) partes.push(CENTENAS[Math.floor(n / 100)]);
  const resto = n % 100;
  if (resto >= 20) {
    partes.push(DEZENAS[Math.floor(resto / 10)]);
    if (resto % 10) partes.push(UNIDADES[resto % 10]);
  } else if (resto) partes.push(UNIDADES[resto]);
  return partes.join(" e ");
}

/** 6000 → "seis mil"; 1250 → "mil duzentos e cinquenta"; 2001000 → "dois milhões e mil". */
export function numeroPorExtenso(n) {
  n = Math.floor(n);
  if (n === 0) return "zero";
  const milhoes = Math.floor(n / 1e6);
  const milhares = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes = [];
  if (milhoes) partes.push(milhoes === 1 ? "um milhão" : `${ate999(milhoes)} milhões`);
  if (milhares) partes.push(milhares === 1 ? "mil" : `${ate999(milhares)} mil`);
  if (resto) partes.push(ate999(resto));
  // O "e" final só entra antes de centena redonda ou de número menor que 100 ("mil e quinhentos", "mil e vinte").
  if (partes.length > 1 && resto && (resto < 100 || resto % 100 === 0)) return `${partes.slice(0, -1).join(" ")} e ${partes.at(-1)}`;
  if (partes.length > 1 && !resto && milhares) return partes.join(" e ");
  return partes.join(" ");
}

/** 500 → "quinhentos reais"; 1500.5 → "mil e quinhentos reais e cinquenta centavos". */
export function reaisPorExtenso(valor) {
  const centavosTotal = Math.round(Number(valor) * 100);
  const reais = Math.floor(centavosTotal / 100);
  const centavos = centavosTotal % 100;
  const partes = [];
  // "um milhão de reais": milhão redondo leva "de".
  if (reais) partes.push(`${numeroPorExtenso(reais)}${reais % 1e6 === 0 ? " de" : ""} ${reais === 1 ? "real" : "reais"}`);
  if (centavos) partes.push(`${numeroPorExtenso(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  return partes.join(" e ") || "zero reais";
}

export const reais = (valor) => Number(valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/\s/g, " ");

/** "R$ 500,00 (quinhentos reais)" */
export const reaisComExtenso = (valor) => `${reais(valor)} (${reaisPorExtenso(valor)})`;

/** Lê o valor digitado no painel: "1.500,50", "1500.50", "R$ 500". Retorna null se não for um número. */
export function lerValor(texto) {
  if (typeof texto === "number") return Number.isFinite(texto) ? texto : null;
  let t = String(texto ?? "").replace(/[^\d.,]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "7 (sete) dias" */
export const diasPorExtenso = (dias) => `${dias} (${numeroPorExtenso(dias)}) ${Number(dias) === 1 ? "dia" : "dias"}`;

/** CNPJ ou CPF com a pontuação. Retorna { tipo, numero } ou null. */
export function documentoFormatado(valor) {
  const d = String(valor ?? "").replace(/\D/g, "");
  if (d.length === 14) return { tipo: "CNPJ", numero: d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") };
  if (d.length === 11) return { tipo: "CPF", numero: d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4") };
  return null;
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "2026-12-05" → { dia: 5, mes: 11, ano: 2026 }, ou null se não for uma data de verdade. */
export function lerData(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const d = new Date(Date.UTC(ano, mes, dia));
  return d.getUTCMonth() === mes && d.getUTCDate() === dia ? { dia, mes, ano } : null;
}

/** "5 de dezembro de 2026" */
export const dataPorExtenso = ({ dia, mes, ano }) => `${dia} de ${MESES[mes]} de ${ano}`;

/** "janeiro de 2027": o mês `n` meses depois da data. */
export function mesDepois({ mes, ano }, n) {
  const total = mes + n;
  return `${MESES[total % 12]} de ${ano + Math.floor(total / 12)}`;
}
