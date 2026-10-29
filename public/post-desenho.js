// Desenho das imagens do carrossel e dos quadros do Reels: carrossel em 1080x1350 (4:5) e Reels em
// 1080x1920 (9:16). O mesmo arquivo serve o painel (prévias e downloads no navegador) e o servidor
// (que gera os arquivos para postar no Instagram).
//
// Cada tela tem um tipo visual (capa, impacto, lista, contraste, pergunta, texto, cta) com desenho e
// animação próprios. No carrossel a tela é o último quadro da animação, já parada.

// No navegador o canvas vem do documento; o servidor troca por um canvas do Node.
let novoCanvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });
export function usarCanvas(criar) {
  novoCanvas = criar;
}

export const TAMANHOS_POST = { carrossel: [1080, 1350], reels: [1080, 1920] };
export const MARCA = { fundo: "#0b0c14", roxo: "#5b4cf0", roxoClaro: "#8b7dff", ciano: "#06b6d4", texto: "#ffffff", suave: "rgba(255,255,255,.78)" };

// Paletas: o feed varia de cor de um post para o outro, sempre no fundo escuro da marca.
export const TEMAS = [
  { nome: "marca", a: "#a99bff", b: "#22d3ee", base: "#0b0c14", luz1: "rgba(91,76,240,.6)", luz2: "rgba(6,182,212,.42)" },
  { nome: "fogo", a: "#fdba74", b: "#f43f5e", base: "#120909", luz1: "rgba(249,115,22,.5)", luz2: "rgba(244,63,94,.4)" },
  { nome: "neon", a: "#86efac", b: "#22d3ee", base: "#06100d", luz1: "rgba(34,197,94,.45)", luz2: "rgba(6,182,212,.38)" },
  { nome: "eletrico", a: "#93c5fd", b: "#c084fc", base: "#070a17", luz1: "rgba(59,130,246,.55)", luz2: "rgba(168,85,247,.42)" },
  { nome: "sol", a: "#fde047", b: "#fb923c", base: "#110f08", luz1: "rgba(234,179,8,.42)", luz2: "rgba(249,115,22,.38)" },
];
export const temaDoPost = (post) => TEMAS[Math.abs(Number(post?.id) || 0) % TEMAS.length];

// ---------- Utilidades ----------

const lim = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const suave = (x) => 1 - (1 - lim(x)) ** 3;
const elastico = (x) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = lim(x) - 1;
  return 1 + c3 * p ** 3 + c1 * p ** 2;
};
// Pseudoaleatório estável (o mesmo quadro sai igual no painel e no servidor).
const sorteio = (n) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function degrade(ctx, x0, y0, x1, y1, tema) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, tema.a);
  g.addColorStop(1, tema.b);
  return g;
}

// ---------- Fundo ----------

function fundo(ctx, w, h, t, tema) {
  ctx.fillStyle = tema.base;
  ctx.fillRect(0, 0, w, h);
  const brilho = (x, y, r, cor) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, cor);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  brilho(w * (0.15 + 0.1 * Math.sin(t * 0.7)), h * (0.12 + 0.05 * Math.cos(t * 0.55)), w * 0.9, tema.luz1);
  brilho(w * (0.9 - 0.08 * Math.cos(t * 0.5)), h * (0.9 - 0.05 * Math.sin(t * 0.8)), w * 0.85, tema.luz2);
  ctx.drawImage(gradeDePontos(w, h), 0, 0);
  // Partículas subindo devagar.
  for (let k = 0; k < 28; k++) {
    const x = sorteio(k) * w + Math.sin(t * 0.8 + k) * 18;
    const y = (((sorteio(k + 40) * h - t * (20 + sorteio(k + 80) * 50)) % h) + h) % h;
    ctx.globalAlpha = 0.12 + sorteio(k + 120) * 0.35;
    ctx.fillStyle = k % 3 ? "#ffffff" : tema.b;
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + sorteio(k + 160) * 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Grade de pontos discreta, desenhada uma vez por tamanho (o vídeo redesenha o fundo a cada quadro).
const grades = new Map();
function gradeDePontos(w, h) {
  if (!grades.has(`${w}x${h}`)) {
    const c = novoCanvas(w, h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "rgba(255,255,255,.05)";
    for (let x = 40; x < w; x += 60) for (let y = 40; y < h; y += 60) ctx.fillRect(x, y, 3, 3);
    grades.set(`${w}x${h}`, c);
  }
  return grades.get(`${w}x${h}`);
}

function logo(ctx, x, y, tamanho = 64) {
  const g = ctx.createLinearGradient(x, y, x + tamanho, y + tamanho);
  g.addColorStop(0, MARCA.roxo);
  g.addColorStop(1, MARCA.ciano);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, y, tamanho, tamanho, tamanho * 0.28);
  ctx.fill();
  const k = tamanho / 64;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 7 * k;
  ctx.lineCap = "round";
  [[16, 22, 48], [16, 32, 40], [16, 42, 30]].forEach(([x1, yy, x2]) => {
    ctx.beginPath(); ctx.moveTo(x + x1 * k, y + yy * k); ctx.lineTo(x + x2 * k, y + yy * k); ctx.stroke();
  });
}

function marcaNoTopo(ctx, x, y, nome) {
  logo(ctx, x, y);
  ctx.fillStyle = MARCA.texto;
  ctx.font = "800 40px Inter";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(nome, x + 84, y + 33);
}

// ---------- Texto ----------

/** Quebra o texto em linhas que cabem na largura (com a fonte já definida no contexto). */
function quebrarLinhas(ctx, texto, largura) {
  const linhas = [];
  let atual = "";
  for (const palavra of String(texto ?? "").split(/\s+/).filter(Boolean)) {
    const teste = atual ? `${atual} ${palavra}` : palavra;
    if (ctx.measureText(teste).width > largura && atual) {
      linhas.push(atual);
      atual = palavra;
    } else atual = teste;
  }
  if (atual) linhas.push(atual);
  return linhas;
}

export const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** O maior tamanho de título que cabe em `alturaMax` (diminuindo de 4 em 4 até `menor`). */
function medirTitulo(ctx, { texto, largura, alturaMax, maior, menor }) {
  let tamanho = maior;
  let linhas;
  for (; tamanho >= menor; tamanho -= 4) {
    ctx.font = `800 ${tamanho}px Inter`;
    linhas = quebrarLinhas(ctx, texto, largura);
    if (linhas.length * tamanho * 1.16 <= alturaMax && linhas.every((l) => ctx.measureText(l).width <= largura)) break;
  }
  tamanho = Math.max(tamanho, menor);
  ctx.font = `800 ${tamanho}px Inter`;
  linhas = quebrarLinhas(ctx, texto, largura);
  return { tamanho, linhas, altura: linhas.length * tamanho * 1.16 };
}

function alturaDoParagrafo(ctx, texto, largura, tamanho) {
  if (!texto) return 0;
  ctx.font = `500 ${tamanho}px Inter`;
  return quebrarLinhas(ctx, texto, largura).length * tamanho * 1.4;
}

/**
 * Título palavra por palavra: cada uma entra com um "pulo" (ou batendo, no estilo "impacto"), e as
 * palavras do destaque ganham um marcador colorido por trás. `local` é o tempo da cena em segundos.
 */
function tituloAnimado(ctx, { texto, destaque, x, y, largura, alturaMax, maior, menor, local = 99, tema, centro = false, estilo = "pulo", atraso = 0.1, passo = 0.07 }) {
  const { tamanho, linhas } = medirTitulo(ctx, { texto, largura, alturaMax, maior, menor });
  const realce = new Set(String(destaque ?? "").split(/\s+/).map(semAcento).filter(Boolean));
  const alturaLinha = tamanho * 1.16;
  const espaco = ctx.measureText(" ").width;
  // O marcador passa um pouco da palavra: as marcadas ganham esse espaço dos dois lados.
  const pad = tamanho * 0.1;
  const folga = (palavra) => (realce.has(semAcento(palavra)) ? pad : 0);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let k = 0;
  linhas.forEach((linha, li) => {
    const palavras = linha.split(" ");
    const larguraLinha = ctx.measureText(linha).width + palavras.reduce((s, p) => s + folga(p) * 2, 0);
    let xx = centro ? x + (largura - larguraLinha) / 2 : x;
    const cy = y + li * alturaLinha + alturaLinha / 2;
    for (const palavra of palavras) {
      const larg = ctx.measureText(palavra).width;
      xx += folga(palavra);
      const p = lim((local - atraso - k * passo) / 0.38);
      k++;
      if (p > 0) {
        const marcada = realce.has(semAcento(palavra));
        const escala = estilo === "batida" ? 1 + 1.2 * (1 - suave(p)) : 0.55 + 0.45 * elastico(p);
        ctx.save();
        ctx.globalAlpha *= lim(p * 3);
        ctx.translate(xx + larg / 2, cy + (estilo === "batida" ? 0 : (1 - suave(p)) * 26));
        ctx.scale(escala, escala);
        if (marcada) {
          // O marcador corre da esquerda para a direita, logo depois da palavra entrar.
          const m = suave((local - atraso - k * passo - 0.12) / 0.3);
          ctx.fillStyle = degrade(ctx, -larg / 2, 0, larg / 2, 0, tema);
          ctx.beginPath();
          ctx.roundRect(-larg / 2 - pad, -tamanho * 0.56, (larg + pad * 2) * m, tamanho * 1.08, tamanho * 0.16);
          ctx.fill();
          ctx.fillStyle = m > 0.4 ? tema.base : "#fff";
        } else ctx.fillStyle = "#fff";
        ctx.font = `800 ${tamanho}px Inter`;
        ctx.fillText(palavra, -larg / 2, tamanho * 0.04);
        ctx.restore();
      }
      xx += larg + folga(palavra) + espaco;
    }
  });
  return y + linhas.length * alturaLinha;
}

function paragrafo(ctx, { texto, x, y, largura, tamanho = 46, cor = MARCA.suave, local = 99, inicio = 0, centro = false }) {
  if (!texto) return y;
  ctx.font = `500 ${tamanho}px Inter`;
  ctx.fillStyle = cor;
  ctx.textBaseline = "top";
  const linhas = quebrarLinhas(ctx, texto, largura);
  linhas.forEach((l, i) => {
    const p = suave((local - inicio - i * 0.12) / 0.4);
    if (p <= 0) return;
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.textAlign = centro ? "center" : "left";
    ctx.fillText(l, centro ? x + largura / 2 : x, y + i * tamanho * 1.4 + (1 - p) * 20);
    ctx.restore();
  });
  return y + linhas.length * tamanho * 1.4;
}

function pilula(ctx, texto, cx, y, tema, { escala = 1, tamanho = 40 } = {}) {
  ctx.font = `800 ${tamanho}px Inter`;
  const w = ctx.measureText(texto).width + tamanho * 2;
  const alt = tamanho * 2.2;
  ctx.save();
  ctx.translate(cx, y + alt / 2);
  ctx.scale(escala, escala);
  ctx.fillStyle = degrade(ctx, -w / 2, 0, w / 2, 0, tema);
  ctx.beginPath();
  ctx.roundRect(-w / 2, -alt / 2, w, alt, alt / 2);
  ctx.fill();
  ctx.fillStyle = tema.base;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(texto, 0, 2);
  ctx.restore();
  ctx.textAlign = "left";
  return alt;
}

// Emojis ficam de fora das telas: a fonte da marca não tem, e no servidor sairiam como quadradinhos.
const semEmoji = (t) => String(t ?? "").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/[→←]/g, "»").replace(/\s{2,}/g, " ").trim();

const VISUAIS = new Set(["capa", "impacto", "lista", "contraste", "pergunta", "texto", "cta"]);

export const telasDoPost = (post) => {
  const c = post.conteudo;
  const fonte = c.slides?.length ? c.slides : [{ titulo: c.gancho, texto: "", destaque: "" }];
  return fonte.map((s, i) => ({
    titulo: semEmoji(s.titulo) || (i === 0 ? semEmoji(c.gancho) : ""),
    texto: semEmoji(s.texto),
    destaque: semEmoji(s.destaque),
    fala: String(s.fala ?? "").trim(),
    // Posts antigos não têm o tipo: capa, itens numerados e a chamada no fim.
    visual: i === 0 ? "capa" : i === fonte.length - 1 && fonte.length > 1 ? "cta" : VISUAIS.has(s.visual) ? s.visual : "lista",
  }));
};

/** Rótulos dos dois lados do contraste, conforme a estrutura do roteiro. */
function rotulosDoContraste(estrutura) {
  return { mito_verdade: ["MITO", "VERDADE"], antes_depois: ["ANTES", "DEPOIS"], comparacao: ["NÃO", "SIM"] }[estrutura] ?? ["ERRADO", "CERTO"];
}

// ---------- Cenas ----------
// Cada cena desenha dentro da área útil { x, topo, base, largura } e usa `local` (segundos desde o
// começo da cena) para animar. No carrossel, `local` é grande: tudo já no lugar.

function blocoCentralizado(area, altura) {
  return Math.max(area.topo, area.topo + (area.base - area.topo - altura) / 2);
}

const CENAS = {
  capa(ctx, c) {
    const reels = c.modo === "reels";
    const opcoes = { largura: c.area.largura, alturaMax: reels ? 760 : 640, maior: reels ? 150 : 124, menor: 72 };
    const t = medirTitulo(ctx, { texto: c.tela.titulo, ...opcoes });
    const extra = (c.tela.texto ? 40 + alturaDoParagrafo(ctx, c.tela.texto, c.area.largura, 48) : 0) + (reels ? 0 : 150);
    const y = blocoCentralizado(c.area, t.altura + extra);
    const fim = tituloAnimado(ctx, { texto: c.tela.titulo, destaque: c.tela.destaque, x: c.area.x, y, ...opcoes, local: c.local, tema: c.tema, centro: true, estilo: "batida", passo: 0.09 });
    const fimTexto = paragrafo(ctx, { texto: c.tela.texto, x: c.area.x, y: fim + 40, largura: c.area.largura, tamanho: 48, local: c.local, inicio: 0.6, centro: true });
    if (!reels) pilula(ctx, "Arrasta para o lado  »", c.w / 2, fimTexto + 56, c.tema);
  },

  impacto(ctx, c) {
    const opcoes = { largura: c.area.largura, alturaMax: c.modo === "reels" ? 820 : 680, maior: c.modo === "reels" ? 176 : 150, menor: 80 };
    const t = medirTitulo(ctx, { texto: c.tela.titulo, ...opcoes });
    const extra = c.tela.texto ? 40 + alturaDoParagrafo(ctx, c.tela.texto, c.area.largura, 48) : 0;
    const y = blocoCentralizado(c.area, t.altura + extra);
    const fim = tituloAnimado(ctx, { texto: c.tela.titulo, destaque: c.tela.destaque, x: c.area.x, y, ...opcoes, local: c.local, tema: c.tema, centro: true, estilo: "batida", atraso: 0.02, passo: 0.12 });
    paragrafo(ctx, { texto: c.tela.texto, x: c.area.x, y: fim + 40, largura: c.area.largura, tamanho: 48, local: c.local, inicio: 0.7, centro: true });
  },

  lista(ctx, c) {
    const opcoes = { largura: c.area.largura, alturaMax: c.modo === "reels" ? 560 : 440, maior: c.modo === "reels" ? 112 : 92, menor: 58 };
    const t = medirTitulo(ctx, { texto: c.tela.titulo, ...opcoes });
    const numero = 200;
    const altura = numero + t.altura + (c.tela.texto ? 40 + alturaDoParagrafo(ctx, c.tela.texto, c.area.largura, 46) : 0);
    const y = blocoCentralizado(c.area, altura);
    // O número entra deslizando e "acende".
    const p = suave(c.local / 0.35);
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.font = "900 190px Inter";
    ctx.textBaseline = "top";
    ctx.fillStyle = degrade(ctx, c.area.x, y, c.area.x + 300, y + 190, c.tema);
    ctx.fillText(String(c.numero).padStart(2, "0"), c.area.x - 8 - (1 - p) * 120, y - 20);
    ctx.restore();
    const fim = tituloAnimado(ctx, { texto: c.tela.titulo, destaque: c.tela.destaque, x: c.area.x, y: y + numero, ...opcoes, local: c.local, tema: c.tema, atraso: 0.2 });
    paragrafo(ctx, { texto: c.tela.texto, x: c.area.x, y: fim + 40, largura: c.area.largura, tamanho: 46, local: c.local, inicio: 0.8 });
  },

  contraste(ctx, c) {
    const [rotA, rotB] = rotulosDoContraste(c.estrutura);
    const reels = c.modo === "reels";
    const tamanho = reels ? 60 : 52;
    const pad = 44;
    const larguraTexto = c.area.largura - pad * 2;
    const alturaCartao = (texto) => 70 + alturaDoTitulo(ctx, texto, larguraTexto, tamanho) + pad * 2;
    const hA = alturaCartao(c.tela.titulo);
    const hB = alturaCartao(c.tela.texto || c.tela.titulo);
    const vao = 40;
    const y = blocoCentralizado(c.area, hA + vao + hB);
    const virada = Math.min(1.4, c.dur * 0.42);
    const pA = suave(c.local / 0.4);
    const pB = suave((c.local - virada) / 0.4);
    const riscado = suave((c.local - virada + 0.15) / 0.35);
    cartao(ctx, { x: c.area.x - (1 - pA) * 160, y, w: c.area.largura, h: hA, alpha: pA * (1 - 0.35 * riscado), cor: "244,63,94", rotulo: rotA, icone: "x", texto: c.tela.titulo, tamanho, pad, risco: riscado });
    if (c.tela.texto) cartao(ctx, { x: c.area.x + (1 - pB) * 160, y: y + hA + vao, w: c.area.largura, h: hB, alpha: pB, cor: "34,197,94", rotulo: rotB, icone: "v", texto: c.tela.texto, tamanho, pad, escala: 1 + 0.06 * (1 - pB) });
  },

  pergunta(ctx, c) {
    const reels = c.modo === "reels";
    const opcoes = { largura: c.area.largura, alturaMax: reels ? 520 : 420, maior: reels ? 112 : 92, menor: 60 };
    const t = medirTitulo(ctx, { texto: c.tela.titulo, ...opcoes });
    const raio = reels ? 120 : 96;
    const altura = raio * 2 + 60 + t.altura + (c.tela.texto ? 40 + alturaDoParagrafo(ctx, c.tela.texto, c.area.largura, 46) : 0);
    const y = blocoCentralizado(c.area, altura);
    const p = elastico(c.local / 0.5);
    const pulso = 1 + 0.05 * Math.sin(c.local * 5);
    ctx.save();
    ctx.translate(c.w / 2, y + raio);
    ctx.scale(p * pulso, p * pulso);
    ctx.fillStyle = degrade(ctx, -raio, -raio, raio, raio, c.tema);
    ctx.beginPath();
    ctx.arc(0, 0, raio, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.tema.base;
    ctx.font = `900 ${raio * 1.3}px Inter`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", 0, raio * 0.06);
    ctx.restore();
    const fim = tituloAnimado(ctx, { texto: c.tela.titulo, destaque: c.tela.destaque, x: c.area.x, y: y + raio * 2 + 60, ...opcoes, local: c.local, tema: c.tema, centro: true, atraso: 0.35 });
    paragrafo(ctx, { texto: c.tela.texto, x: c.area.x, y: fim + 40, largura: c.area.largura, tamanho: 46, local: c.local, inicio: 0.9, centro: true });
  },

  texto(ctx, c) {
    const opcoes = { largura: c.area.largura, alturaMax: c.modo === "reels" ? 640 : 500, maior: c.modo === "reels" ? 116 : 96, menor: 58 };
    const t = medirTitulo(ctx, { texto: c.tela.titulo, ...opcoes });
    const altura = 24 + t.altura + (c.tela.texto ? 44 + alturaDoParagrafo(ctx, c.tela.texto, c.area.largura, 48) : 0);
    const y = blocoCentralizado(c.area, altura);
    // Barrinha colorida que cresce antes do título.
    ctx.fillStyle = degrade(ctx, c.area.x, 0, c.area.x + 160, 0, c.tema);
    ctx.fillRect(c.area.x, y, 160 * suave(c.local / 0.4), 12);
    const fim = tituloAnimado(ctx, { texto: c.tela.titulo, destaque: c.tela.destaque, x: c.area.x, y: y + 36, ...opcoes, local: c.local, tema: c.tema, atraso: 0.15 });
    paragrafo(ctx, { texto: c.tela.texto, x: c.area.x, y: fim + 44, largura: c.area.largura, tamanho: 48, local: c.local, inicio: 0.7 });
  },

  cta(ctx, c) {
    const reels = c.modo === "reels";
    const opcoes = { largura: c.area.largura, alturaMax: reels ? 480 : 380, maior: reels ? 104 : 88, menor: 56 };
    const t = medirTitulo(ctx, { texto: c.tela.titulo, ...opcoes });
    const tamLogo = reels ? 150 : 120;
    const altura = tamLogo + 60 + t.altura + (c.tela.texto ? 40 + alturaDoParagrafo(ctx, c.tela.texto, c.area.largura, 46) : 0) + 170;
    const y = blocoCentralizado(c.area, altura);
    const p = elastico(c.local / 0.5);
    ctx.save();
    ctx.translate(c.w / 2, y + tamLogo / 2);
    ctx.scale(p, p);
    logo(ctx, -tamLogo / 2, -tamLogo / 2, tamLogo);
    ctx.restore();
    const fim = tituloAnimado(ctx, { texto: c.tela.titulo, destaque: c.tela.destaque, x: c.area.x, y: y + tamLogo + 60, ...opcoes, local: c.local, tema: c.tema, centro: true, atraso: 0.3 });
    const fimTexto = paragrafo(ctx, { texto: c.tela.texto, x: c.area.x, y: fim + 40, largura: c.area.largura, tamanho: 46, local: c.local, inicio: 0.8, centro: true });
    const pb = suave((c.local - 1) / 0.4);
    if (pb > 0) {
      ctx.save();
      ctx.globalAlpha *= pb;
      pilula(ctx, "Chama no direct", c.w / 2, fimTexto + 60, c.tema, { escala: (reels ? 1 + 0.05 * Math.sin(c.local * 7) : 1) * (0.8 + 0.2 * pb), tamanho: 44 });
      ctx.restore();
    }
  },
};

function alturaDoTitulo(ctx, texto, largura, tamanho) {
  ctx.font = `800 ${tamanho}px Inter`;
  return quebrarLinhas(ctx, texto, largura).length * tamanho * 1.18;
}

function cartao(ctx, { x, y, w, h, alpha, cor, rotulo, icone, texto, tamanho, pad, risco = 0, escala = 1 }) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(escala, escala);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = `rgba(${cor},.13)`;
  ctx.strokeStyle = `rgba(${cor},.7)`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 36);
  ctx.fill();
  ctx.stroke();
  // Ícone: X ou visto, desenhado (sem emoji).
  ctx.fillStyle = `rgb(${cor})`;
  ctx.beginPath();
  ctx.arc(pad + 26, pad + 26, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  if (icone === "x") {
    ctx.moveTo(pad + 16, pad + 16); ctx.lineTo(pad + 36, pad + 36);
    ctx.moveTo(pad + 36, pad + 16); ctx.lineTo(pad + 16, pad + 36);
  } else {
    ctx.moveTo(pad + 14, pad + 27); ctx.lineTo(pad + 23, pad + 36); ctx.lineTo(pad + 39, pad + 17);
  }
  ctx.stroke();
  ctx.fillStyle = `rgb(${cor})`;
  ctx.font = "800 34px Inter";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(rotulo, pad + 70, pad + 28);
  ctx.font = `800 ${tamanho}px Inter`;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  const linhas = quebrarLinhas(ctx, texto, w - pad * 2);
  linhas.forEach((l, i) => {
    const yy = pad + 70 + i * tamanho * 1.18;
    ctx.fillText(l, pad, yy);
    if (risco > 0) {
      const lw = ctx.measureText(l).width;
      ctx.fillStyle = `rgb(${cor})`;
      ctx.fillRect(pad, yy + tamanho * 0.52, lw * lim(risco * linhas.length - i), 6);
      ctx.fillStyle = "#fff";
    }
  });
  ctx.restore();
}

/** Desenha a cena `i` (sem o fundo), com `local` segundos desde o começo dela. */
function desenharCena(ctx, { w, h, telas, i, local, dur, tema, modo, estrutura }) {
  const tela = telas[i];
  const area = modo === "reels" ? { x: 80, topo: 300, base: 1440, largura: w - 160 } : { x: 80, topo: 210, base: h - 140, largura: w - 160 };
  const numero = telas.slice(0, i + 1).filter((t) => t.visual === "lista").length;
  (CENAS[tela.visual] ?? CENAS.texto)(ctx, { w, h, tela, i, local, dur, tema, modo, estrutura, area, numero });
}

// ---------- Carrossel ----------

/** Uma tela do carrossel (1080x1350). */
export function desenharTelaCarrossel(ctx, post, i, empresa = "FluxDeck") {
  const [w, h] = TAMANHOS_POST.carrossel;
  const telas = telasDoPost(post);
  const tema = temaDoPost(post);
  fundo(ctx, w, h, i * 1.7, tema);
  marcaNoTopo(ctx, 80, 80, empresa);
  ctx.font = "600 34px Inter";
  ctx.fillStyle = MARCA.suave;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${i + 1}/${telas.length}`, w - 80, 113);
  ctx.textAlign = "left";
  desenharCena(ctx, { w, h, telas, i, local: 99, dur: 99, tema, modo: "carrossel", estrutura: post.conteudo.estrutura });
  // Pontinhos de progresso no rodapé.
  telas.forEach((_, j) => {
    ctx.fillStyle = j === i ? "#fff" : "rgba(255,255,255,.28)";
    ctx.beginPath();
    ctx.roundRect(80 + j * 34, h - 80, j === i ? 24 : 12, 12, 6);
    ctx.fill();
  });
}

// ---------- Reels ----------

/** Quanto tempo cada cena fica na tela, pelo tipo e pela quantidade de texto (sem narração). */
export function duracoesDasCenas(post) {
  return telasDoPost(post).map((tela) => {
    const palavras = `${tela.titulo} ${tela.texto}`.split(/\s+/).filter(Boolean).length;
    if (tela.visual === "capa") return 2.4;
    if (tela.visual === "cta") return 3.6;
    if (tela.visual === "impacto") return lim(1.8 + palavras * 0.15, 2, 2.8);
    if (tela.visual === "contraste") return lim(2.6 + palavras * 0.2, 3.4, 5.4);
    return lim(1.6 + palavras * 0.2, 2.4, 4.4);
  });
}

export const DURACAO_CENA = (i, total, post) => duracoesDasCenas(post)[i];
export const duracaoReels = (post, duracoes = duracoesDasCenas(post)) => duracoes.reduce((s, d) => s + d, 0);

/**
 * Um quadro do Reels (1080x1920) no instante `t` (segundos). `duracoes` vem da narração, quando
 * há voz (cada cena dura o tempo da fala); sem ela, sai pela quantidade de texto.
 */
export function desenharQuadroReels(ctx, post, t, empresa = "FluxDeck", { duracoes = duracoesDasCenas(post) } = {}) {
  const [w, h] = TAMANHOS_POST.reels;
  const telas = telasDoPost(post);
  const tema = temaDoPost(post);
  let inicio = 0;
  let i = 0;
  while (i < telas.length - 1 && t >= inicio + duracoes[i]) inicio += duracoes[i++];
  const dur = duracoes[i];
  const local = t - inicio;
  const ultima = i === telas.length - 1;
  const visual = telas[i].visual;

  fundo(ctx, w, h, t, tema);

  // Entrada e saída de cada cena: chega com zoom e sai encolhendo (a última fica).
  const entra = suave(local / 0.22);
  const sai = ultima ? 0 : suave((local - (dur - 0.18)) / 0.18);
  const forte = visual === "capa" || visual === "impacto";
  // Tremida curta nas cenas de impacto, logo que entram.
  const tremida = forte ? Math.max(0, 1 - local / 0.4) * 14 : 0;
  const dx = (sorteio(Math.floor(local * 60) + i * 100) - 0.5) * tremida;
  const dy = (sorteio(Math.floor(local * 60) + i * 100 + 50) - 0.5) * tremida;
  const escala = (1 + (forte ? 0.14 : 0.06) * (1 - entra)) * (1 - 0.06 * sai);
  ctx.save();
  ctx.globalAlpha = lim(entra * 1.5) * (1 - sai);
  ctx.translate(w / 2 + dx, h * 0.45 + dy);
  ctx.scale(escala, escala);
  ctx.translate(-w / 2, -h * 0.45);
  desenharCena(ctx, { w, h, telas, i, local, dur, tema, modo: "reels", estrutura: post.conteudo.estrutura });
  ctx.restore();
  ctx.globalAlpha = 1;

  // Clarão na troca para as cenas fortes.
  if (forte && local < 0.25) {
    ctx.fillStyle = `rgba(255,255,255,${0.45 * (1 - local / 0.25)})`;
    ctx.fillRect(0, 0, w, h);
  }

  // Barras de progresso, como nos stories, e a marca no topo.
  const larg = (w - 120 - (telas.length - 1) * 12) / telas.length;
  telas.forEach((_, j) => {
    const x = 60 + j * (larg + 12);
    ctx.fillStyle = "rgba(255,255,255,.25)";
    ctx.fillRect(x, 70, larg, 8);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x, 70, larg * (j < i ? 1 : j > i ? 0 : lim(local / dur)), 8);
  });
  marcaNoTopo(ctx, 60, 120, empresa);
}
