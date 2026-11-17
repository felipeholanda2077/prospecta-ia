// A marca da empresa na prévia: a logo (a foto de perfil do WhatsApp, em tamanho grande, ou a do Instagram) e as
// cores tiradas dela. Assim o site de exemplo sai com a cara da loja, e não com a cor padrão do ramo.

const hex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const rgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** Luminância relativa (0 = preto, 1 = branco), para saber se o texto em cima vai branco ou escuro. */
export const luminancia = (h) => {
  const c = rgb(h);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const misturar = (a, b, t) => { const x = rgb(a); const y = rgb(b); return hex(...x.map((v, i) => v + (y[i] - v) * t)); };
const saturacao = ([r, g, b]) => { const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

/**
 * A cor principal de uma imagem (a logo): a cor viva que mais aparece, ignorando o fundo branco e o quase preto.
 * Logo só em preto e branco (ou cinza) devolve o tom escuro dela. `pixels` = RGBA (como o getImageData).
 */
export function corPrincipal(pixels) {
  const caixas = new Map();
  let escuros = 0;
  let somaEscuro = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
    if (a < 128) continue;
    total++;
    const mx = Math.max(r, g, b);
    if (mx > 235 && Math.min(r, g, b) > 225) continue; // fundo branco
    const s = saturacao([r, g, b]);
    if (s < 0.25 || mx < 40) {
      if (mx < 110) { escuros++; somaEscuro = [somaEscuro[0] + r, somaEscuro[1] + g, somaEscuro[2] + b]; }
      continue;
    }
    const chave = `${r >> 4},${g >> 4},${b >> 4}`;
    const c = caixas.get(chave) ?? { peso: 0, n: 0, r: 0, g: 0, b: 0 };
    c.peso += 1 + s; c.n++; c.r += r; c.g += g; c.b += b;
    caixas.set(chave, c);
  }
  if (!total) return null;
  const [melhor] = [...caixas.values()].sort((a, b) => b.peso - a.peso);
  if (melhor && melhor.n >= total * 0.03) return hex(melhor.r / melhor.n, melhor.g / melhor.n, melhor.b / melhor.n);
  if (escuros >= total * 0.05) return hex(somaEscuro[0] / escuros, somaEscuro[1] / escuros, somaEscuro[2] / escuros);
  return null;
}

/**
 * As cores da página a partir da cor da marca: botão (`cor` com o texto `tinta` em cima, branco ou escuro), o tom
 * para texto sobre fundo branco (`forte`), o topo (`hero1` e `hero2`, sempre escuros o bastante para o texto branco)
 * e o tom claro dos cartões. Cor clara (amarelo, por exemplo) vira destaque, com o topo escuro.
 */
export function paletaDaMarca(cor) {
  if (!rgb(cor)) return null;
  const lum = luminancia(cor);
  const tinta = lum > 0.42 ? "#111111" : "#ffffff";
  let forte = cor;
  for (let t = 0.15; luminancia(forte) > 0.18 && t <= 0.85; t += 0.1) forte = misturar(cor, "#000000", t);
  const escura = misturar(cor, "#000000", 0.55);
  const hero1 = lum > 0.3 ? misturar(cor, "#111111", 0.72) : cor;
  const hero2 = lum > 0.3 ? "#0e0e12" : escura;
  return { cor, tinta, forte, escura, hero1, hero2, clara: misturar(cor, "#ffffff", 0.88) };
}

/** A cor principal da logo (Buffer de imagem), pelo canvas. Sem conseguir ler a imagem, null. */
export async function corDaLogo(dados) {
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(dados);
    const lado = 64;
    const canvas = createCanvas(lado, lado);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, lado, lado);
    return corPrincipal(ctx.getImageData(0, 0, lado, lado).data);
  } catch {
    return null;
  }
}
