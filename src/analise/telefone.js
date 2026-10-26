/**
 * Converte um telefone brasileiro para o formato E.164 sem "+" (ex.: 5585999998888).
 * Retorna null se não parecer um número válido.
 */
export function normalizarTelefoneBR(telefone) {
  if (!telefone) return null;
  let d = String(telefone).replace(/\D/g, "");
  if (d.startsWith("0")) d = d.replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!d.startsWith("55") || (d.length !== 12 && d.length !== 13)) return null;
  return d;
}

/**
 * O WhatsApp às vezes identifica celulares brasileiros sem o nono dígito
 * (5585988887777 chega como 558588887777). Retorna as duas formas.
 */
export function variantesWhatsappBR(numero) {
  const d = String(numero ?? "").replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55") && d[4] === "9") return [d, d.slice(0, 4) + d.slice(5)];
  if (d.length === 12 && d.startsWith("55") && /[6-9]/.test(d[4])) return [d, d.slice(0, 4) + "9" + d.slice(4)];
  return [d];
}

/** Celular no Brasil: DDD + 9 dígitos começando com 9. Só celulares têm WhatsApp com segurança. */
export function ehCelularBR(telefone) {
  const d = normalizarTelefoneBR(telefone);
  return Boolean(d && d.length === 13 && d[4] === "9");
}
