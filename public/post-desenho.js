// Desenho das imagens do carrossel e dos quadros do Reels, com as cores da FluxDeck:
// carrossel em 1080x1350 (4:5) e Reels em 1080x1920 (9:16). O mesmo arquivo serve o painel
// (prévias e downloads no navegador) e o servidor (que gera os arquivos para postar no Instagram).

// No navegador o canvas vem do documento; o servidor troca por um canvas do Node.
let novoCanvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });
export function usarCanvas(criar) {
  novoCanvas = criar;
}

export const TAMANHOS_POST = { carrossel: [1080, 1350], reels: [1080, 1920] };
export const MARCA = { fundo: "#0b0c14", roxo: "#5b4cf0", roxoClaro: "#8b7dff", ciano: "#06b6d4", texto: "#ffffff", suave: "rgba(255,255,255,.74)" };

function fundoDaMarca(ctx, w, h, t = 0) {
  ctx.fillStyle = MARCA.fundo;
  ctx.fillRect(0, 0, w, h);
  const brilho = (x, y, r, cor) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, cor);
    g.addColorStop(1, "rgba(11,12,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  brilho(w * (0.12 + 0.06 * Math.sin(t * 0.6)), h * (0.1 + 0.03 * Math.cos(t * 0.5)), w * 0.85, "rgba(91,76,240,.55)");
  brilho(w * (0.95 - 0.05 * Math.cos(t * 0.4)), h * (0.92 - 0.03 * Math.sin(t * 0.7)), w * 0.8, "rgba(6,182,212,.38)");
  ctx.drawImage(gradeDePontos(w, h), 0, 0);
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

function marcaNoTopo(ctx, x, y, nome) {
  const g = ctx.createLinearGradient(x, y, x + 64, y + 64);
  g.addColorStop(0, MARCA.roxo);
  g.addColorStop(1, MARCA.ciano);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, y, 64, 64, 18);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  [[16, 22, 48], [16, 32, 40], [16, 42, 30]].forEach(([x1, yy, x2]) => {
    ctx.beginPath(); ctx.moveTo(x + x1, y + yy); ctx.lineTo(x + x2, y + yy); ctx.stroke();
  });
  ctx.fillStyle = MARCA.texto;
  ctx.font = "800 40px Inter";
  ctx.textBaseline = "middle";
  ctx.fillText(nome, x + 84, y + 33);
}

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

/**
 * Título grande com as palavras do `destaque` em degradê. Diminui a fonte até caber em
 * `alturaMax`. `progresso` (0 a 1) anima a entrada linha a linha, no Reels.
 */
function medirTitulo(ctx, { texto, largura, alturaMax, maior, menor }) {
  let tamanho = maior;
  let linhas;
  for (; tamanho >= menor; tamanho -= 4) {
    ctx.font = `800 ${tamanho}px Inter`;
    linhas = quebrarLinhas(ctx, texto, largura);
    if (linhas.length * tamanho * 1.12 <= alturaMax) break;
  }
  return { tamanho: Math.max(tamanho, menor), linhas, altura: linhas.length * Math.max(tamanho, menor) * 1.12 };
}

function alturaDoParagrafo(ctx, texto, largura, tamanho) {
  if (!texto) return 0;
  ctx.font = `500 ${tamanho}px Inter`;
  return quebrarLinhas(ctx, texto, largura).length * tamanho * 1.4;
}

function tituloComDestaque(ctx, { texto, destaque, x, y, largura, alturaMax, maior, menor, progresso = 1 }) {
  const { tamanho, linhas } = medirTitulo(ctx, { texto, largura, alturaMax, maior, menor });
  ctx.font = `800 ${tamanho}px Inter`;
  const realce = new Set(String(destaque ?? "").split(/\s+/).map(semAcento).filter(Boolean));
  const altura = tamanho * 1.12;
  ctx.textBaseline = "top";
  linhas.forEach((linha, i) => {
    const p = Math.min(1, Math.max(0, progresso * (linhas.length + 1) - i));
    if (p <= 0) return;
    ctx.globalAlpha = p;
    const yy = y + i * altura + (1 - p) * 40;
    let xx = x;
    for (const palavra of linha.split(" ")) {
      const larg = ctx.measureText(palavra).width;
      if (realce.has(semAcento(palavra))) {
        const g = ctx.createLinearGradient(xx, yy, xx + larg, yy + tamanho);
        g.addColorStop(0, "#a99bff");
        g.addColorStop(1, "#22d3ee");
        ctx.fillStyle = g;
      } else ctx.fillStyle = MARCA.texto;
      ctx.fillText(palavra, xx, yy);
      xx += larg + ctx.measureText(" ").width;
    }
  });
  ctx.globalAlpha = 1;
  return y + linhas.length * altura;
}

function paragrafo(ctx, { texto, x, y, largura, tamanho = 44, cor = MARCA.suave, alpha = 1 }) {
  if (!texto) return y;
  ctx.font = `500 ${tamanho}px Inter`;
  ctx.fillStyle = cor;
  ctx.globalAlpha = alpha;
  ctx.textBaseline = "top";
  const linhas = quebrarLinhas(ctx, texto, largura);
  linhas.forEach((l, i) => ctx.fillText(l, x, y + i * tamanho * 1.4));
  ctx.globalAlpha = 1;
  return y + linhas.length * tamanho * 1.4;
}

function pilulaCta(ctx, texto, x, y, escala = 1) {
  ctx.font = "700 40px Inter";
  const w = ctx.measureText(texto).width + 80;
  ctx.save();
  ctx.translate(x + w / 2, y + 45);
  ctx.scale(escala, escala);
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  g.addColorStop(0, MARCA.roxo);
  g.addColorStop(1, MARCA.ciano);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -45, w, 90, 45);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(texto, 0, 2);
  ctx.restore();
  ctx.textAlign = "left";
  return w;
}

// Emojis ficam de fora das telas: a fonte da marca não tem, e no servidor sairiam como quadradinhos.
const semEmoji = (t) => String(t ?? "").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/\s{2,}/g, " ").trim();

export const telasDoPost = (post) => {
  const c = post.conteudo;
  const telas = c.slides?.length ? c.slides.map((s) => ({ titulo: semEmoji(s.titulo), texto: semEmoji(s.texto), destaque: semEmoji(s.destaque) }))
    : [{ titulo: semEmoji(c.gancho), texto: "", destaque: "" }];
  telas[0].titulo ||= semEmoji(c.gancho);
  return telas;
};

/** Uma tela do carrossel (1080x1350). */
export function desenharTelaCarrossel(ctx, post, i, empresa = "FluxDeck") {
  const [w, h] = TAMANHOS_POST.carrossel;
  const telas = telasDoPost(post);
  const tela = telas[i];
  const ultima = i === telas.length - 1 && telas.length > 1;
  fundoDaMarca(ctx, w, h, i * 1.7);
  marcaNoTopo(ctx, 80, 80, empresa);
  ctx.font = "600 34px Inter";
  ctx.fillStyle = MARCA.suave;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${i + 1}/${telas.length}`, w - 80, 113);
  ctx.textAlign = "left";

  // O bloco de texto fica centralizado na altura, entre a marca e o rodapé.
  const largura = w - 160;
  const capa = i === 0;
  const opcoes = capa ? { alturaMax: 620, maior: 118, menor: 70 } : { alturaMax: 460, maior: 92, menor: 56 };
  const titulo = medirTitulo(ctx, { texto: tela.titulo, largura, ...opcoes });
  const numero = capa || ultima ? 0 : 190;
  const bloco = numero + titulo.altura + (tela.texto ? 40 + alturaDoParagrafo(ctx, tela.texto, largura, capa ? 46 : 44) : 0) + (capa || ultima ? 130 : 0);
  const topo = Math.max(230, (h - bloco) / 2);
  if (numero) {
    ctx.font = "800 150px Inter";
    const g = ctx.createLinearGradient(80, topo, 330, topo + 150);
    g.addColorStop(0, "#a99bff");
    g.addColorStop(1, "#22d3ee");
    ctx.fillStyle = g;
    ctx.textBaseline = "top";
    ctx.fillText(String(i).padStart(2, "0"), 72, topo - 10);
  }
  const fim = tituloComDestaque(ctx, { texto: tela.titulo, destaque: tela.destaque, x: 80, y: topo + numero, largura, ...opcoes });
  const fimTexto = paragrafo(ctx, { texto: tela.texto, x: 80, y: fim + 40, largura, tamanho: capa ? 46 : 44 });
  if (capa) return pilulaCta(ctx, "Arrasta para o lado  »", 80, fimTexto + 50);
  if (ultima) pilulaCta(ctx, "Chama no direct", 80, fimTexto + 50);
  // Pontinhos de progresso no rodapé.
  telas.forEach((_, j) => {
    ctx.fillStyle = j === i ? "#fff" : "rgba(255,255,255,.28)";
    ctx.beginPath();
    ctx.roundRect(80 + j * 34, h - 90, j === i ? 24 : 12, 12, 6);
    ctx.fill();
  });
}

export const DURACAO_CENA = (i, total) => (i === 0 ? 2.8 : i === total - 1 ? 3.6 : 3.4);
export const duracaoReels = (post) => telasDoPost(post).reduce((s, _, i, t) => s + DURACAO_CENA(i, t.length), 0);

/** Um quadro do Reels (1080x1920) no instante `t` (segundos). */
export function desenharQuadroReels(ctx, post, t, empresa = "FluxDeck") {
  const [w, h] = TAMANHOS_POST.reels;
  const telas = telasDoPost(post);
  let inicio = 0;
  let i = 0;
  while (i < telas.length - 1 && t >= inicio + DURACAO_CENA(i, telas.length)) inicio += DURACAO_CENA(i++, telas.length);
  const dur = DURACAO_CENA(i, telas.length);
  const local = t - inicio;
  const ultima = i === telas.length - 1 && telas.length > 1;
  const tela = telas[i];

  fundoDaMarca(ctx, w, h, t);
  // Barras de progresso, como nos stories.
  const larg = (w - 120 - (telas.length - 1) * 12) / telas.length;
  telas.forEach((_, j) => {
    const x = 60 + j * (larg + 12);
    ctx.fillStyle = "rgba(255,255,255,.25)";
    ctx.fillRect(x, 70, larg, 8);
    ctx.fillStyle = "#fff";
    ctx.fillRect(x, 70, larg * (j < i ? 1 : j > i ? 0 : Math.min(1, local / dur)), 8);
  });
  marcaNoTopo(ctx, 60, 120, empresa);

  const entrada = Math.min(1, local / 0.7);
  const saida = ultima ? 1 : Math.min(1, Math.max(0, (dur - local) / 0.25));
  // Bloco centralizado um pouco acima do meio: a parte de baixo do Reels fica sob a legenda e os botões do Instagram.
  const largura = w - 160;
  const opcoes = { alturaMax: 680, maior: i === 0 ? 128 : 104, menor: 64 };
  const titulo = medirTitulo(ctx, { texto: tela.titulo, largura, ...opcoes });
  const numero = i > 0 && !ultima ? 170 : 0;
  const bloco = numero + titulo.altura + (tela.texto ? 44 + alturaDoParagrafo(ctx, tela.texto, largura, 50) : 0) + (ultima ? 150 : 0);
  const topo = Math.max(300, h * 0.45 - bloco / 2);
  if (numero) {
    ctx.globalAlpha = saida * Math.min(1, local / 0.3);
    ctx.font = "800 130px Inter";
    const g = ctx.createLinearGradient(80, topo, 300, topo + 130);
    g.addColorStop(0, "#a99bff");
    g.addColorStop(1, "#22d3ee");
    ctx.fillStyle = g;
    ctx.textBaseline = "top";
    ctx.fillText(String(i).padStart(2, "0"), 76, topo - 10);
  }
  ctx.save();
  ctx.globalAlpha = saida;
  const fim = tituloComDestaque(ctx, { texto: tela.titulo, destaque: tela.destaque, x: 80, y: topo + numero, largura, ...opcoes, progresso: entrada });
  ctx.restore();
  const fimTexto = paragrafo(ctx, { texto: tela.texto, x: 80, y: fim + 44, largura, tamanho: 50, alpha: saida * Math.min(1, Math.max(0, (local - 0.6) / 0.5)) });
  if (ultima) pilulaCta(ctx, "Chama no direct", 80, fimTexto + 60, 1 + 0.04 * Math.sin(local * 6));
  ctx.globalAlpha = 1;
}
