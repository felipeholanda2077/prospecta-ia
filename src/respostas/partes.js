// Mensagem grande da IA vai separada, não junta (pedido de 18/11/2026: "mantenha esse padrão de mensagens separadas e
// não juntas quando forem muito grandes, sempre"). No WhatsApp (e no direct), o texto comprido vira 2 ou 3 mensagens
// curtas, uma logo depois da outra, cortadas onde a própria mensagem já se divide: parágrafos, depois linhas (listas),
// depois frases. Link nunca é cortado. Mensagem curta continua uma só; e-mail, sempre um só.

/** Até quantos caracteres uma mensagem fica inteira. */
export const TAMANHO_DA_PARTE = 300;
const MAXIMO_DE_PARTES = 3;

/** As frases de um texto (o corte é depois de . ! ? seguido de espaço, nunca dentro de um link). */
function frases(texto) {
  const cortes = [...texto.matchAll(/[.!?](?=\s)/g)].map((m) => m.index + 1)
    .filter((i) => !/https?:\/\/\S*$/.test(texto.slice(0, i)));
  const saida = [];
  let inicio = 0;
  for (const c of cortes) {
    saida.push(texto.slice(inicio, c).trim());
    inicio = c;
  }
  saida.push(texto.slice(inicio).trim());
  return saida.filter(Boolean);
}

/** Junta pedaços em ordem, cada grupo até `tamanho` caracteres (um pedaço maior que isso fica sozinho). */
function agrupar(pedacos, separador, tamanho) {
  const grupos = [];
  for (const p of pedacos) {
    const ultimo = grupos.at(-1);
    if (ultimo && ultimo.length + separador.length + p.length <= tamanho) grupos[grupos.length - 1] = ultimo + separador + p;
    else grupos.push(p);
  }
  return grupos;
}

/** Um bloco comprido em pedaços: pelas linhas (lista) e, se ainda for grande, pelas frases. */
function cortarBloco(bloco, tamanho) {
  if (bloco.length <= tamanho) return [bloco];
  const linhas = bloco.split("\n").map((l) => l.trim()).filter(Boolean);
  if (linhas.length > 1) return agrupar(linhas.flatMap((l) => cortarBloco(l, tamanho)), "\n", tamanho);
  return agrupar(frases(bloco), " ", tamanho);
}

/**
 * As mensagens em que um texto da IA sai: uma só quando é curto (ou no e-mail); comprido, 2 ou 3 mensagens na ordem
 * (se não couber em 3, cada uma cresce um pouco até caber).
 */
export function partesDaMensagem(corpo, canal = "whatsapp", { tamanho = TAMANHO_DA_PARTE, maximo = MAXIMO_DE_PARTES } = {}) {
  const texto = String(corpo ?? "").trim();
  if (!texto) return [];
  if (canal === "email" || texto.length <= tamanho) return [texto];
  const blocos = texto.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  // Mais partes que o máximo: as mensagens crescem um pouco até caber (em vez de uma última enorme).
  for (let t = tamanho; ; t += 50) {
    const partes = agrupar(blocos.flatMap((b) => cortarBloco(b, t)), "\n\n", t);
    if (partes.length <= maximo || t >= texto.length) return partes.length <= maximo ? partes
      : [...partes.slice(0, maximo - 1), partes.slice(maximo - 1).join("\n\n")];
  }
}
