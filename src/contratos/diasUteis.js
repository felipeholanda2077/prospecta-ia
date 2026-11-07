// Dias úteis para vencimento: segunda a sexta, fora os feriados nacionais e os dias sem expediente bancário
// (Carnaval, Sexta-feira Santa e Corpus Christi). Feriados estaduais e municipais não entram.

const iso = (ano, mes, dia) => new Date(Date.UTC(ano, mes, dia)).toISOString().slice(0, 10);

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano). */
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes, dia);
}

const cache = new Map();
/** Os feriados do ano, em AAAA-MM-DD. */
export function feriados(ano) {
  if (cache.has(ano)) return cache.get(ano);
  const p = pascoa(ano);
  const doPascoa = (dias) => new Date(p + dias * 86_400_000).toISOString().slice(0, 10);
  const lista = new Set([
    iso(ano, 0, 1), doPascoa(-48), doPascoa(-47), doPascoa(-2), iso(ano, 3, 21), iso(ano, 4, 1), doPascoa(60),
    iso(ano, 8, 7), iso(ano, 9, 12), iso(ano, 10, 2), iso(ano, 10, 15), iso(ano, 10, 20), iso(ano, 11, 25),
  ]);
  cache.set(ano, lista);
  return lista;
}

export function ehDiaUtil(data) {
  const d = new Date(`${data}T12:00:00Z`);
  const semana = d.getUTCDay();
  return semana !== 0 && semana !== 6 && !feriados(d.getUTCFullYear()).has(data);
}

/** O N-ésimo dia útil do mês (mês de 0 a 11; aceita passar de 11, que vira o ano seguinte). Null se o mês não tiver tantos. */
export function enesimoDiaUtil(ano, mes, n) {
  const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  let conta = 0;
  for (let dia = 1; dia <= ultimo; dia++) {
    const data = iso(ano, mes, dia);
    if (ehDiaUtil(data) && ++conta === n) return data;
  }
  return null;
}
