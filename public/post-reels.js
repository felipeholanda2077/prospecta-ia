// Os Reels em motion graphics (1080x1920): cada tipo de cena tem várias encenações diferentes, com
// janelas, mouse, digitação e objetos que mudam na frente de quem assiste. A encenação, a posição do
// quadro do avatar e a transição mudam de uma cena para a outra e de um post para o outro.
// Nenhum texto entra no quadro do avatar: o buraco dele é aberto depois de desenhar tudo.

const SERIFA = '"Source Serif 4"';
const FUNDO = "#0b1120";
const CREME = "#f1f5f9";
const CINZA = "#b8c4d6";
const ACENTO = "#00d4ff";
const NASCE = "#7fe9ff";
const CAIXA = "rgba(22,30,48,.94)";
const BORDA = "rgba(255,255,255,.10)";
const CLARO = "#fcfcfb";
const TINTA = "#0b0b0b";
const APOIO = "#52514e";

// Quanto dura a assinatura com a marca, depois da última fala.
export const ASSINATURA = 1.3;

const lim = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const suave = (x) => 1 - (1 - lim(x)) ** 3;
const acelera = (x) => lim(x) ** 3;
const curva = (x) => {
  const p = lim(x);
  return p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
};
const estalo = (x, forca = 1.7) => {
  const p = lim(x) - 1;
  return 1 + (forca + 1) * p ** 3 + forca * p ** 2;
};
const lerp = (a, b, t) => a + (b - a) * t;
const sorteio = (n) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const misturar = (a, b, t) => {
  const canal = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(lerp(canal(a, i), canal(b, i), lim(t)))).join(",")})`;
};
const serifa = (t, peso = 400) => `${peso} ${t}px ${SERIFA}`;
const inter = (t, peso = 500) => `${peso} ${t}px Inter`;

// ---------- O quadro do avatar ----------
// Sempre pequeno e em lugar diferente a cada cena. `lado` diz de onde ele desliza quando a cena começa.
// O quadro tem o formato do clipe (9:16): o Felipe aparece inteiro, com o queixo e os ombros, sem corte.
const JANELAS = [
  { x: 680, y: 130, w: 340, h: 604, lado: 1 },
  { x: 60, y: 130, w: 340, h: 604, lado: -1 },
  { x: 370, y: 130, w: 340, h: 604, lado: 0 },
  { x: 680, y: 900, w: 340, h: 604, lado: 1 },
  { x: 60, y: 900, w: 340, h: 604, lado: -1 },
];
export const ENTRADA_DA_JANELA = 0.35;

/** Onde o avatar fica na cena `i`. A chamada final precisa da parte de baixo livre, então ele fica em cima. */
export function janelaDaCena(post, i, visual) {
  const id = Math.abs(Number(post?.id) || 0);
  const janela = visual === "cta" ? JANELAS[(id % 2) * 1] : JANELAS[(id * 2 + i * 3) % JANELAS.length];
  return { ...janela, dx: janela.lado * 520, dy: janela.lado === 0 ? -760 : 0 };
}

// ---------- Peças ----------

function caixa(ctx, x, y, w, h, r, { cor = CAIXA, borda = BORDA, sombra = 0, largura = 2 } = {}) {
  ctx.save();
  if (sombra) {
    ctx.shadowColor = "rgba(0,0,0,.4)";
    ctx.shadowBlur = sombra;
    ctx.shadowOffsetY = sombra * 0.4;
  }
  ctx.fillStyle = cor;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.restore();
  if (borda) {
    ctx.strokeStyle = borda;
    ctx.lineWidth = largura;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.stroke();
  }
}

const COMPR = [1, 0.88, 0.95, 0.84, 0.99, 0.9, 0.96, 0.86, 1, 0.89, 0.94, 0.85];
const ESPES = [6.4, 5.6, 6.2, 5.4, 6.6, 5.8, 6.2, 5.4, 6.6, 5.6, 6, 5.4];
const DESVIO = [2, -3, 1.5, -2.5, 3.5, -1, 2.5, -3.5, 1, -2, 3, -1.5];

function simbolo(ctx, x, y, tam, rot = 0, cor = ACENTO) {
  if (tam <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.scale(tam / 200, tam / 200);
  ctx.strokeStyle = cor;
  ctx.lineCap = "round";
  COMPR.forEach((c, i) => {
    const a = ((i * 30 + DESVIO[i] - 90) * Math.PI) / 180;
    ctx.lineWidth = ESPES[i];
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * 94 * c, Math.sin(a) * 94 * c);
    ctx.stroke();
  });
  ctx.restore();
}

function botaoEnviar(ctx, x, y, lado, afunda = 1, cor = ACENTO) {
  ctx.save();
  ctx.translate(x + lado / 2, y + lado / 2);
  ctx.scale(afunda, afunda);
  ctx.fillStyle = cor;
  ctx.beginPath();
  ctx.roundRect(-lado / 2, -lado / 2, lado, lado, lado * 0.27);
  ctx.fill();
  ctx.strokeStyle = FUNDO;
  ctx.lineWidth = lado * 0.11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(0, lado * 0.26); ctx.lineTo(0, -lado * 0.24);
  ctx.moveTo(-lado * 0.22, -lado * 0.03); ctx.lineTo(0, -lado * 0.25); ctx.lineTo(lado * 0.22, -lado * 0.03);
  ctx.stroke();
  ctx.restore();
}

function seta(ctx, x, y, alt = 90, escala = 1, alpha = 1) {
  if (alpha <= 0) return;
  const s = (alt / 30) * escala;
  const pts = [[3, 2], [3, 21.5], [7.9, 17.2], [11.2, 24.6], [14.2, 23.3], [10.9, 16], [17.5, 16]];
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.translate(-3, -2);
  ctx.beginPath();
  pts.forEach(([a, b], i) => ctx[i ? "lineTo" : "moveTo"](a, b));
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();
}

function check(ctx, x, y, r, escala = 1, cor = ACENTO) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(escala, escala);
  ctx.fillStyle = cor;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = FUNDO;
  ctx.lineWidth = r * 0.22;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-r * 0.44, r * 0.04); ctx.lineTo(-r * 0.14, r * 0.34); ctx.lineTo(r * 0.46, -r * 0.32);
  ctx.stroke();
  ctx.restore();
}

function anel(ctx, x, y, p, r0, r1, cor = ACENTO) {
  if (p <= 0 || p >= 1) return;
  ctx.save();
  ctx.globalAlpha *= 1 - p;
  ctx.strokeStyle = cor;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(x, y, lerp(r0, r1, suave(p)), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Fagulhas que saltam de um ponto.
function fagulhas(ctx, x, y, p, seed, n = 14, alcance = 300, cor = NASCE) {
  if (p <= 0 || p >= 1) return;
  ctx.save();
  ctx.fillStyle = cor;
  for (let k = 0; k < n; k++) {
    const a = sorteio(seed + k) * Math.PI * 2;
    const d = suave(p) * alcance * (0.45 + sorteio(seed + k + 40) * 0.55);
    ctx.globalAlpha = (1 - p) * 0.9;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d + p * p * 60, 2 + sorteio(seed + k + 80) * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function coracao(ctx, x, y, s, { cor = "#737373", cheio = false } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 24, s / 24);
  ctx.translate(-12, -12);
  ctx.beginPath();
  ctx.moveTo(12, 20.6);
  ctx.bezierCurveTo(9, 18.6, 2.6, 14.4, 2.6, 9.1);
  ctx.bezierCurveTo(2.6, 6.1, 4.9, 4, 7.5, 4);
  ctx.bezierCurveTo(9.4, 4, 11, 5, 12, 6.8);
  ctx.bezierCurveTo(13, 5, 14.6, 4, 16.5, 4);
  ctx.bezierCurveTo(19.1, 4, 21.4, 6.1, 21.4, 9.1);
  ctx.bezierCurveTo(21.4, 14.4, 15, 18.6, 12, 20.6);
  ctx.closePath();
  if (cheio) {
    ctx.fillStyle = cor;
    ctx.fill();
  } else {
    ctx.strokeStyle = cor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- Texto ----------

function quebrar(ctx, texto, largura) {
  const linhas = [];
  let atual = "";
  for (const p of String(texto ?? "").split(/\s+/).filter(Boolean)) {
    const t = atual ? `${atual} ${p}` : p;
    if (ctx.measureText(t).width > largura && atual) {
      linhas.push(atual);
      atual = p;
    } else atual = t;
  }
  if (atual) linhas.push(atual);
  return linhas;
}

/** O maior tamanho de texto que cabe. As palavras em destaque são mais largas: guarda 4% de folga. */
function medir(ctx, texto, { largura, alturaMax, maior, menor, fonte = serifa, entre = 1.16 }) {
  let tamanho = maior;
  let linhas = [];
  for (; tamanho >= menor; tamanho -= 3) {
    ctx.font = fonte(tamanho);
    linhas = quebrar(ctx, texto, largura * 0.96);
    if (linhas.length * tamanho * entre <= alturaMax && linhas.every((l) => ctx.measureText(l).width <= largura * 0.96)) break;
  }
  tamanho = Math.max(tamanho, menor);
  ctx.font = fonte(tamanho);
  linhas = quebrar(ctx, texto, largura * 0.96);
  return { tamanho, linhas, altura: linhas.length * tamanho * entre, entre };
}

/**
 * Escreve palavra por palavra. Cada uma nasce laranja vivo, com brilho, e esfria para a cor normal.
 * Modos: "sobe" (vem de baixo), "bate" (chega grande), "lado" (uma da esquerda, outra da direita).
 */
function escrever(ctx, m, { x, y, largura, realce = "", local, atraso = 0, passo = 0.07, cor = CREME, corRealce = ACENTO, centro = false, modo = "sobe", fonte = serifa, pesoRealce = 600 }) {
  const marcadas = new Set(String(realce).split(/\s+/).map(semAcento).filter(Boolean));
  const fonteDa = (p) => (marcadas.has(semAcento(p)) ? fonte(m.tamanho, pesoRealce) : fonte(m.tamanho));
  const alturaLinha = m.tamanho * m.entre;
  ctx.font = fonte(m.tamanho);
  const espaco = ctx.measureText(" ").width;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let fim = { x, y: y + alturaLinha / 2 };
  let k = 0;
  m.linhas.forEach((linha, li) => {
    const pal = linha.split(" ");
    const larguras = pal.map((p) => {
      ctx.font = fonteDa(p);
      return ctx.measureText(p).width;
    });
    let xx = centro ? x + (largura - larguras.reduce((s, l) => s + l, 0) - espaco * (pal.length - 1)) / 2 : x;
    const cy = y + li * alturaLinha + alturaLinha / 2;
    pal.forEach((palavra, n) => {
      const nasc = atraso + k * passo;
      const q = lim((local - nasc) / 0.26);
      if (q > 0) {
        const frio = lim((local - nasc) / 0.55);
        const marcada = marcadas.has(semAcento(palavra));
        ctx.save();
        ctx.globalAlpha *= lim(q * 2.5);
        ctx.font = fonteDa(palavra);
        ctx.fillStyle = misturar(NASCE, marcada ? corRealce : cor, frio);
        if (frio < 1) {
          ctx.shadowColor = `rgba(0,212,255,${0.7 * (1 - frio)})`;
          ctx.shadowBlur = 26 * (1 - frio);
        }
        const meio = larguras[n] / 2;
        ctx.translate(xx + meio, cy);
        if (modo === "bate") {
          const e = 1 + 0.9 * (1 - suave(q));
          ctx.scale(e, e);
        } else if (modo === "lado") ctx.translate((k % 2 ? 1 : -1) * (1 - suave(q)) * 240, 0);
        else ctx.translate(0, (1 - suave(q)) * m.tamanho * 0.42);
        ctx.fillText(palavra, -meio, 0);
        ctx.restore();
        fim = { x: xx + larguras[n], y: cy };
      }
      xx += larguras[n] + espaco;
      k++;
    });
  });
  return { fimY: y + m.linhas.length * alturaLinha, cursor: fim, duracao: atraso + k * passo };
}

function apoio(ctx, texto, { x, y, largura, tamanho = 46, cor = CINZA, local, inicio = 0, centro = false, escuro = false }) {
  if (!texto) return y;
  ctx.font = inter(tamanho, 500);
  ctx.textBaseline = "top";
  ctx.textAlign = centro ? "center" : "left";
  const linhas = quebrar(ctx, texto, largura);
  linhas.forEach((l, i) => {
    const p = suave((local - inicio - i * 0.1) / 0.3);
    if (p <= 0) return;
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.fillStyle = escuro ? APOIO : cor;
    ctx.fillText(l, centro ? x + largura / 2 : x, y + i * tamanho * 1.34 + (1 - p) * 16);
    ctx.restore();
  });
  ctx.textAlign = "left";
  return y + linhas.length * tamanho * 1.34;
}

const alturaApoio = (ctx, texto, largura, tamanho = 46) => {
  if (!texto) return 0;
  ctx.font = inter(tamanho, 500);
  return quebrar(ctx, texto, largura).length * tamanho * 1.34;
};

// ---------- Fundos ----------

function fundoNoturno(ctx, w, h, t, pulso = 0, lado = 0) {
  ctx.fillStyle = FUNDO;
  ctx.fillRect(0, 0, w, h);
  const forca = 0.44 + 0.05 * Math.sin(t * 0.8) + 0.2 * pulso;
  const alt = 760 + 50 * Math.sin(t * 0.57) + 170 * pulso;
  ctx.save();
  ctx.translate(w / 2 + lado * 220 + Math.sin(t * 0.4) * 60, h + 120);
  ctx.scale(1, (alt + 120) / 1100);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1100);
  for (let k = 0; k <= 16; k++) g.addColorStop(k / 16, `rgba(0,132,214,${(forca * (1 - k / 16) ** 1.9).toFixed(4)})`);
  ctx.fillStyle = g;
  ctx.fillRect(-w * 2, -1100, w * 4, 1100);
  ctx.restore();
  const v = ctx.createRadialGradient(w * (0.85 - lado * 0.5) + Math.sin(t * 0.3) * 80, h * 0.1, 0, w * (0.85 - lado * 0.5), h * 0.1, 900);
  v.addColorStop(0, `rgba(180,77,245,${(0.16 + 0.08 * pulso).toFixed(3)})`);
  v.addColorStop(1, "rgba(180,77,245,0)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

// A tela clara abre como um círculo a partir de um ponto.
function telaClara(ctx, w, h, p, cx = w / 2, cy = h / 2) {
  if (p <= 0) return;
  const r = lerp(40, 1500, curva(p));
  ctx.save();
  if (p < 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.fillStyle = CLARO;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---------- Encenações ----------
// c: { ctx, w, h, t, local, dur, tela, telas, i, area, id, numero, rotulos, empresa, foto, parado }

const hook = (c, opcoes) => medir(c.ctx, c.tela.titulo, opcoes);
const meioV = (a, altura) => Math.max(a.topo, a.topo + (a.base - a.topo - altura) / 2);

const RISCOS = [[-60, 300], [1140, -60], [1140, 1500], [120, 1980]];

function riscos(ctx, cx, cy, local) {
  if (local > 0.62) return;
  RISCOS.forEach(([x0, y0], k) => {
    const p = lim((local - k * 0.025) / 0.38);
    const e = p * p;
    const mx = (x0 + cx) / 2 - (cy - y0) * 0.34;
    const my = (y0 + cy) / 2 + (cx - x0) * 0.34;
    const ponto = (q) => ({ x: (1 - q) ** 2 * x0 + 2 * (1 - q) * q * mx + q * q * cx, y: (1 - q) ** 2 * y0 + 2 * (1 - q) * q * my + q * q * cy });
    const apaga = 1 - lim((local - 0.4) / 0.2);
    for (let n = 0; n < 16; n++) {
      const q0 = Math.max(0, e - n * 0.035);
      const q1 = Math.max(0, e - (n + 1) * 0.035);
      const a = ponto(q0);
      const b = ponto(q1);
      ctx.strokeStyle = n < 2 ? "#bff3ff" : NASCE;
      ctx.globalAlpha = (1 - n / 16) ** 1.5 * apaga;
      ctx.lineWidth = lerp(9, 1, n / 16);
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (p < 1) {
      const c = ponto(e);
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 34);
      g.addColorStop(0, "#f0fcff");
      g.addColorStop(0.4, "rgba(140,230,255,.7)");
      g.addColorStop(1, "rgba(0,212,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, 34, 0, Math.PI * 2); ctx.fill();
    }
  });
  const f = lim((local - 0.34) / 0.26);
  if (f > 0 && f < 1) {
    const r = lerp(90, 460, suave(f));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(240,252,255,${1 - f})`);
    g.addColorStop(0.3, `rgba(140,230,255,${0.7 * (1 - f)})`);
    g.addColorStop(1, "rgba(0,212,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }
}

const CAPAS = [
  // O gancho digitado numa caixa de pergunta, nascendo de riscos de luz.
  function capaPrompt(c) {
    const { ctx, area: a, local } = c;
    const pad = 46;
    const curto = a.base - a.topo < 900;
    const m = hook(c, { largura: a.largura - pad * 2, alturaMax: curto ? 470 : 720, maior: curto ? 96 : 128, menor: 56 });
    const h = pad + m.altura + 16 + 96;
    const y = meioV(a, h);
    riscos(ctx, a.x + a.largura / 2, y + h / 2, local);
    const p = suave((local - 0.16) / 0.28);
    if (p <= 0) return;
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.translate(0, (1 - p) * 60);
    caixa(ctx, a.x, y, a.largura, h, 34, { sombra: 50 });
    const r = escrever(ctx, m, { x: a.x + pad, y: y + pad, largura: a.largura - pad * 2, realce: c.tela.destaque, local, atraso: 0.26, passo: 0.075 });
    if (!c.parado && (local < r.duracao || Math.floor(local * 2.6) % 2 === 0)) {
      ctx.fillStyle = ACENTO;
      ctx.fillRect(r.cursor.x + 8, r.cursor.y - m.tamanho * 0.5, 4, m.tamanho);
    }
    ctx.strokeStyle = CINZA;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x + pad, y + h - 54); ctx.lineTo(a.x + pad + 34, y + h - 54);
    ctx.moveTo(a.x + pad + 17, y + h - 71); ctx.lineTo(a.x + pad + 17, y + h - 37);
    ctx.stroke();
    const clique = (local - r.duracao - 0.12) / 0.2;
    botaoEnviar(ctx, a.x + a.largura - 96, y + h - 96, 72, 1 - 0.14 * Math.sin(Math.PI * lim(clique)));
    anel(ctx, a.x + a.largura - 60, y + h - 60, (local - r.duracao - 0.2) / 0.5, 36, 220);
    ctx.restore();
  },

  // O gancho como mensagem: três pontinhos, o balão salta, e chega a resposta "pensando".
  function capaBalao(c) {
    const { ctx, area: a, local } = c;
    const pad = 44;
    const larg = a.largura - 60;
    const m = hook(c, { largura: larg - pad * 2, alturaMax: a.base - a.topo < 900 ? 470 : 720, maior: 122, menor: 56 });
    const h = m.altura + pad * 2;
    const y = meioV(a, h + 110);
    const x = a.x + 60;
    if (local < 0.42 && !c.parado) {
      const q = suave(local / 0.14);
      ctx.save();
      ctx.globalAlpha *= q;
      caixa(ctx, x + larg - 180, y + h - 90, 180, 90, 40, { cor: "#1e293b", borda: null });
      [0, 1, 2].forEach((k) => {
        ctx.fillStyle = CINZA;
        ctx.globalAlpha = q * (0.35 + 0.65 * Math.abs(Math.sin(local * 11 + k)));
        ctx.beginPath(); ctx.arc(x + larg - 136 + k * 46, y + h - 45, 10, 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();
      return;
    }
    const p = estalo((local - 0.42) / 0.3);
    ctx.save();
    ctx.translate(x + larg, y + h);
    ctx.scale(p, p);
    ctx.translate(-x - larg, -y - h);
    caixa(ctx, x, y, larg, h, 40, { cor: "#1e293b", borda: null, sombra: 40 });
    ctx.fillStyle = "#1e293b";
    ctx.beginPath(); ctx.moveTo(x + larg - 34, y + h - 6); ctx.lineTo(x + larg + 20, y + h + 22); ctx.lineTo(x + larg - 70, y + h - 2); ctx.fill();
    ctx.restore();
    const r = escrever(ctx, m, { x: x + pad, y: y + pad, largura: larg - pad * 2, realce: c.tela.destaque, local, atraso: 0.46, passo: 0.05 });
    const q = suave((local - r.duracao) / 0.3);
    ctx.save();
    ctx.globalAlpha *= q;
    simbolo(ctx, a.x + 44, y + h + 74, 84 * q, c.parado ? 0 : local * 340);
    ctx.fillStyle = CINZA;
    ctx.font = serifa(40);
    ctx.textBaseline = "middle";
    ctx.fillText("pensando…", a.x + 104, y + h + 74);
    ctx.restore();
  },

  // A tela clara abre, a seta do Mac clica na caixa e o gancho aparece.
  function capaClara(c) {
    const { ctx, w, h: H, area: a, local } = c;
    telaClara(ctx, w, H, (local - 0.02) / 0.34, a.x + a.largura / 2, (a.topo + a.base) / 2);
    const pad = 46;
    const m = hook(c, { largura: a.largura - pad * 2, alturaMax: a.base - a.topo < 900 ? 470 : 720, maior: 122, menor: 56 });
    const h = pad * 2 + m.altura + 40;
    const y = meioV(a, h);
    const p = suave((local - 0.2) / 0.3);
    if (p <= 0) return;
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.translate(0, (1 - p) * 110);
    caixa(ctx, a.x, y, a.largura, h, 34, { cor: "#fff", borda: `rgba(11,11,11,${local > 0.62 ? 0.34 : 0.14})`, sombra: 26 });
    const r = escrever(ctx, m, { x: a.x + pad, y: y + pad, largura: a.largura - pad * 2, realce: c.tela.destaque, local, atraso: 0.62, passo: 0.06, cor: TINTA, corRealce: "#0077c8" });
    ctx.restore();
    const px = lerp(a.x + a.largura + 120, a.x + a.largura * 0.62, curva((local - 0.2) / 0.38));
    const py = lerp(y + h + 340, y + h - 40, curva((local - 0.2) / 0.38));
    const clique = 1 - 0.12 * Math.sin(Math.PI * lim((local - 0.58) / 0.2));
    if (!c.parado) seta(ctx, px, py, 120, clique, 1 - lim((local - r.duracao) / 0.25));
  },
];

const PERGUNTAS = [
  // A pergunta toma a tela, com comentários passando atrás dela.
  function perguntaGigante(c) {
    const { ctx, area: a, local, tela } = c;
    const mt = tela.texto ? alturaApoio(ctx, tela.texto, a.largura) + 34 : 0;
    const m = hook(c, { largura: a.largura, alturaMax: Math.min(620, a.base - a.topo - mt), maior: 170, menor: 60, fonte: (t) => serifa(t, 600), entre: 1.08 });
    const y = meioV(a, m.altura + mt);
    [0, 1, 2].forEach((k) => {
      const e = estalo((local - k * 0.1) / 0.3);
      const yy = a.topo + (a.base - a.topo) * [0.08, 0.42, 0.7][k] - local * 16;
      const xx = a.x + [0, 240, 40][k];
      const larg = a.largura - [120, 240, 200][k];
      ctx.save();
      ctx.globalAlpha *= 0.34 * lim((local - k * 0.1) / 0.15);
      ctx.translate(xx + larg / 2, yy + 74);
      ctx.rotate(([-1.6, 1.2, -0.8][k] * Math.PI) / 180);
      ctx.scale(e, e);
      ctx.translate(-larg / 2, -74);
      caixa(ctx, 0, 0, larg, 148, 34);
      ctx.fillStyle = "#2c3a52";
      ctx.beginPath(); ctx.arc(62, 74, 36, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.roundRect(118, 44, 170, 14, 7); ctx.fill();
      ctx.beginPath(); ctx.roundRect(118, 78, larg - 180, 22, 11); ctx.fill();
      ctx.restore();
    });
    const e = lerp(1.25, 1, suave(local / 0.34)) * (1 + 0.012 * local);
    ctx.save();
    ctx.translate(a.x + a.largura / 2, y + m.altura / 2);
    ctx.scale(e, e);
    ctx.translate(-a.x - a.largura / 2, -y - m.altura / 2);
    ctx.shadowColor = "rgba(0,212,255,.35)";
    ctx.shadowBlur = 50;
    escrever(ctx, m, { x: a.x, y, largura: a.largura, realce: tela.titulo, local, atraso: 0.03, passo: 0.05, centro: true, corRealce: ACENTO, fonte: (t) => serifa(t, 600) });
    ctx.restore();
    apoio(ctx, tela.texto, { x: a.x, y: y + m.altura + 34, largura: a.largura, local, inicio: 0.5, centro: true });
  },

  // A pergunta como balão, e a resposta escrita na hora, com o símbolo pensando.
  function perguntaChat(c) {
    const { ctx, area: a, local, tela } = c;
    const m = medir(ctx, tela.titulo, { largura: a.largura - 160, alturaMax: 400, maior: 88, menor: 50, fonte: (t) => inter(t, 500), entre: 1.24 });
    const altB = m.altura + 72;
    const larB = Math.min(a.largura, Math.max(...m.linhas.map((l) => (ctx.font = inter(m.tamanho, 500), ctx.measureText(l).width))) + 100);
    const mr = tela.texto ? medir(ctx, tela.texto, { largura: a.largura, alturaMax: 340, maior: 70, menor: 44 }) : null;
    const total = altB + 40 + 90 + (mr ? mr.altura + 20 : 0);
    const y = meioV(a, total);
    const x = a.x + a.largura - larB;
    const p = estalo(local / 0.28);
    ctx.save();
    ctx.translate(x + larB, y + altB / 2);
    ctx.scale(p, p);
    ctx.translate(-x - larB, -y - altB / 2);
    caixa(ctx, x, y, larB, altB, 34, { cor: "#1e293b", borda: null, sombra: 34 });
    ctx.restore();
    ctx.globalAlpha *= 1;
    escrever(ctx, m, { x: x + 50, y: y + 36, largura: larB - 100, realce: tela.destaque, local, atraso: 0.08, passo: 0.03, fonte: (t, peso) => inter(t, peso === 600 ? 700 : 500), pesoRealce: 600 });
    const s = suave((local - 0.3) / 0.2);
    const yS = y + altB + 40 + 42;
    simbolo(ctx, a.x + 42, yS, 84 * s, c.parado ? 0 : local * (local < 0.9 ? 620 : 120));
    if (mr) escrever(ctx, mr, { x: a.x, y: yS + 62, largura: a.largura, local, atraso: 0.72, passo: 0.06 });
  },

  // Uma enquete do Instagram: o mouse vota e as barras enchem.
  function perguntaEnquete(c) {
    const { ctx, area: a, local, tela } = c;
    const m = hook(c, { largura: a.largura - 96, alturaMax: 330, maior: 92, menor: 52 });
    const h = 48 + m.altura + 36 + 2 * 108 + 24 + 44;
    const y = meioV(a, h);
    const p = estalo(local / 0.3, 1.2);
    ctx.save();
    ctx.translate(a.x + a.largura / 2, y + h / 2);
    ctx.scale(p, p);
    ctx.rotate((-1 * Math.PI) / 180);
    ctx.translate(-a.x - a.largura / 2, -y - h / 2);
    caixa(ctx, a.x, y, a.largura, h, 40, { sombra: 50 });
    escrever(ctx, m, { x: a.x + 48, y: y + 48, largura: a.largura - 96, realce: tela.destaque, local, atraso: 0.12, passo: 0.05 });
    const yO = y + 48 + m.altura + 36;
    const voto = lim((local - 1) / 0.45);
    [["Sim", 0.78], ["Ainda não", 0.22]].forEach(([nome, v], k) => {
      const yy = yO + k * 120;
      const e = suave((local - 0.34 - k * 0.1) / 0.25);
      ctx.save();
      ctx.globalAlpha *= e;
      caixa(ctx, a.x + 48, yy, a.largura - 96, 96, 28, { cor: "rgba(255,255,255,.06)", borda: BORDA });
      if (voto > 0) {
        ctx.fillStyle = k ? "rgba(255,255,255,.14)" : ACENTO;
        ctx.beginPath();
        ctx.roundRect(a.x + 48, yy, (a.largura - 96) * v * suave(voto), 96, 28);
        ctx.fill();
      }
      ctx.fillStyle = CREME;
      ctx.font = inter(40, 600);
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(nome, a.x + 84, yy + 49);
      if (voto > 0) {
        ctx.textAlign = "right";
        ctx.globalAlpha *= voto;
        ctx.fillText(`${Math.round(v * 100 * suave(voto))}%`, a.x + a.largura - 84, yy + 49);
        ctx.textAlign = "left";
      }
      ctx.restore();
    });
    ctx.restore();
    const px = lerp(a.x + a.largura + 90, a.x + a.largura * 0.3, curva((local - 0.5) / 0.46));
    const py = lerp(y + h + 320, yO + 48, curva((local - 0.5) / 0.46));
    const q = 1 - 0.14 * Math.sin(Math.PI * lim((local - 0.94) / 0.2));
    if (!c.parado) seta(ctx, px, py, 92, q, 1 - lim((local - 1.5) / 0.25));
  },
];

function lixeira(ctx, x, y, { sx = 1, sy = 1 } = {}, parte = "tudo") {
  // (x, y) é o meio da boca; 220 de largura e 260 de altura.
  ctx.save();
  ctx.translate(x, y + 240);
  ctx.scale(sx, sy);
  ctx.translate(-110, -262);
  ctx.strokeStyle = CREME;
  ctx.lineWidth = 4.5;
  ctx.lineCap = "round";
  if (parte !== "frente") {
    ctx.fillStyle = "#060b16";
    ctx.beginPath(); ctx.ellipse(110, 22, 106, 20, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  if (parte !== "fundo") {
    ctx.fillStyle = FUNDO;
    ctx.beginPath();
    ctx.moveTo(4, 22);
    ctx.ellipse(110, 22, 106, 20, 0, Math.PI, 0, true);
    ctx.lineTo(188, 244);
    ctx.quadraticCurveTo(110, 270, 32, 244);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 3.5;
    [-2, -1, 0, 1, 2].forEach((k) => {
      ctx.beginPath(); ctx.moveTo(110 + k * 34, 66 - Math.abs(k) * 4); ctx.lineTo(110 + k * 25, 228 + (2 - Math.abs(k)) * 4); ctx.stroke();
    });
  }
  ctx.restore();
}

// Cartão de um lado do contraste: o rótulo, o ícone e o texto.
function cartaoContraste(ctx, { x, y, w, m, rotulo, certo, local, atraso = 0, risco = 0 }) {
  const pad = 40;
  const h = pad * 2 + 62 + m.altura;
  caixa(ctx, x, y, w, h, 34, { sombra: 34, borda: certo ? `rgba(0,212,255,.7)` : BORDA });
  if (certo) check(ctx, x + pad + 22, y + pad + 22, 22);
  else {
    ctx.fillStyle = "#5b6b84";
    ctx.beginPath(); ctx.arc(x + pad + 22, y + pad + 22, 22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x + pad + 14, y + pad + 14); ctx.lineTo(x + pad + 30, y + pad + 30); ctx.moveTo(x + pad + 30, y + pad + 14); ctx.lineTo(x + pad + 14, y + pad + 30); ctx.stroke();
  }
  ctx.fillStyle = certo ? ACENTO : CINZA;
  ctx.font = inter(30, 700);
  ctx.textBaseline = "middle";
  ctx.fillText(rotulo, x + pad + 62, y + pad + 24);
  escrever(ctx, m, { x: x + pad, y: y + pad + 62, largura: w - pad * 2, local, atraso, passo: 0.04 });
  if (risco > 0) {
    ctx.fillStyle = "#7d8ca3";
    ctx.font = serifa(m.tamanho);
    m.linhas.forEach((l, i) => ctx.fillRect(x + pad, y + pad + 62 + (i + 0.55) * m.tamanho * m.entre, ctx.measureText(l).width * lim(risco * m.linhas.length - i), 5));
  }
  return h;
}

const CONTRASTES = [
  // O jeito errado voa para a lixeira e o certo salta no lugar dele.
  function contrasteLixeira(c) {
    const { ctx, area: a, local, tela, rotulos, dur } = c;
    const larg = a.largura;
    const mA = medir(ctx, tela.titulo, { largura: larg - 80, alturaMax: 300, maior: 76, menor: 44 });
    const mB = medir(ctx, tela.texto || tela.titulo, { largura: larg - 80, alturaMax: 320, maior: 84, menor: 46 });
    const hA = 142 + mA.altura;
    const hB = 142 + mB.altura;
    const y = meioV(a, Math.max(hA, hB) + (a.base - a.topo > 700 ? 120 : 0));
    const voa = Math.min(0.9, dur * 0.28);
    const chega = voa + 0.48;
    const t = lim((local - voa) / (chega - voa));
    const bocaX = a.x + larg - 120;
    const bocaY = Math.min(a.base - 240, y + hA + 90);
    const sobe = estalo((local - voa + 0.3) / 0.3);
    const desce = acelera((local - chega - 0.5) / 0.3);
    const lixoY = bocaY + (1 - sobe) * 520 + desce * 640;
    const pancada = lim((local - chega) / 0.34);
    const onda = local >= chega ? Math.sin(pancada * Math.PI * 2.5) * (1 - pancada) : 0;
    const achata = { sx: 1 + 0.08 * onda, sy: 1 - 0.1 * onda };
    if (local > voa - 0.32 && desce < 1 && !c.parado) lixeira(ctx, bocaX, lixoY, achata, "fundo");
    if (t < 1 && !(c.parado && local > chega)) {
      const e = t * t * (3 - 2 * t);
      const x0 = a.x + larg / 2;
      const y0 = y + hA / 2;
      const cx = lerp(x0, bocaX, 0.4);
      const cy = Math.min(y0, bocaY) - 340;
      const px = (1 - e) ** 2 * x0 + 2 * (1 - e) * e * cx + e * e * bocaX;
      const py = (1 - e) ** 2 * y0 + 2 * (1 - e) * e * cy + e * e * (bocaY + 90);
      const p0 = suave(local / 0.24);
      ctx.save();
      ctx.globalAlpha *= p0;
      ctx.translate(px, py + (1 - p0) * 50);
      ctx.rotate(lerp(0, 5.7, e));
      ctx.scale(lerp(1, 0.16, e), lerp(1, 0.16, e));
      ctx.translate(-a.x - larg / 2, -y - hA / 2);
      cartaoContraste(ctx, { x: a.x, y, w: larg, m: mA, rotulo: rotulos[0], certo: false, local, risco: lim((local - voa + 0.3) / 0.3) });
      ctx.restore();
    }
    if (local > voa - 0.32 && desce < 1 && !c.parado) {
      lixeira(ctx, bocaX, lixoY, achata, "frente");
      fagulhas(ctx, bocaX, lixoY, (local - chega) / 0.4, 7, 10, 170, CREME);
    }
    if (local >= chega) {
      const p = estalo((local - chega - 0.08) / 0.3);
      ctx.save();
      ctx.translate(a.x + larg / 2, y + hB / 2);
      ctx.scale(p, p);
      ctx.translate(-a.x - larg / 2, -y - hB / 2);
      cartaoContraste(ctx, { x: a.x, y, w: larg, m: mB, rotulo: rotulos[1], certo: true, local, atraso: chega + 0.12 });
      ctx.restore();
      anel(ctx, a.x + 62, y + 62, (local - chega - 0.1) / 0.5, 22, 150);
    }
  },

  // Um painel com divisória: o mouse arrasta e o certo aparece por cima do errado.
  function contrasteArrasta(c) {
    const { ctx, area: a, local, tela, rotulos } = c;
    const larg = a.largura;
    const altura = Math.min(a.base - a.topo, 820);
    const y = meioV(a, altura);
    const mA = medir(ctx, tela.titulo, { largura: larg - 120, alturaMax: altura - 190, maior: 100, menor: 46 });
    const mB = medir(ctx, tela.texto || tela.titulo, { largura: larg - 120, alturaMax: altura - 190, maior: 100, menor: 46 });
    const p = suave(local / 0.28);
    const arrasta = curva((local - 0.85) / Math.max(0.5, Math.min(0.9, c.dur * 0.3)));
    const xDiv = a.x + larg * lerp(0.96, 0.04, arrasta);
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.translate(0, (1 - p) * 70);
    caixa(ctx, a.x, y, larg, altura, 36, { sombra: 50, cor: "#111a2c" });
    ctx.fillStyle = CINZA;
    ctx.font = inter(32, 700);
    ctx.textBaseline = "middle";
    ctx.fillText(rotulos[0], a.x + 60, y + 72);
    escrever(ctx, mA, { x: a.x + 60, y: y + (altura - mA.altura) / 2 + 30, largura: larg - 120, local, atraso: 0.1, passo: 0.04, cor: CINZA });
    // O lado certo é o mesmo painel, em laranja, recortado pela divisória.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(xDiv, y, a.x + larg - xDiv, altura, [0, 36, 36, 0]);
    ctx.clip();
    ctx.fillStyle = "#0a7fc4";
    ctx.fillRect(a.x, y, larg, altura);
    ctx.fillStyle = "#fff";
    ctx.font = inter(32, 700);
    ctx.fillText(rotulos[1], a.x + 60, y + 72);
    escrever(ctx, mB, { x: a.x + 60, y: y + (altura - mB.altura) / 2 + 30, largura: larg - 120, local: 99, cor: "#ffffff", corRealce: "#ffffff" });
    ctx.restore();
    ctx.fillStyle = "#fff";
    ctx.fillRect(xDiv - 3, y, 6, altura);
    const yP = y + altura * 0.86;
    ctx.beginPath(); ctx.arc(xDiv, yP, 42, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#0b0a0c";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(xDiv - 12, yP - 14); ctx.lineTo(xDiv - 24, yP); ctx.lineTo(xDiv - 12, yP + 14);
    ctx.moveTo(xDiv + 12, yP - 14); ctx.lineTo(xDiv + 24, yP); ctx.lineTo(xDiv + 12, yP + 14);
    ctx.stroke();
    ctx.restore();
    const chega = curva((local - 0.34) / 0.45);
    const px = local < 0.85 ? lerp(a.x + larg + 90, xDiv, chega) : xDiv;
    const py = local < 0.85 ? lerp(y + altura + 240, y + altura * 0.86 + 6, chega) : y + altura * 0.86 + 6;
    if (!c.parado) seta(ctx, px + 6, py + 6, 96, local > 0.8 && arrasta < 1 ? 0.9 : 1, 1 - lim((arrasta - 0.96) / 0.04));
  },

  // Uma chave liga: o texto troca e a tela acende.
  function contrasteChave(c) {
    const { ctx, area: a, local, tela, rotulos, dur } = c;
    const liga = curva((local - Math.min(1.05, dur * 0.36)) / 0.26);
    const larg = a.largura;
    const mA = medir(ctx, tela.titulo, { largura: larg, alturaMax: 320, maior: 92, menor: 48 });
    const mB = medir(ctx, tela.texto || tela.titulo, { largura: larg, alturaMax: 340, maior: 108, menor: 50 });
    const altura = 170 + 60 + Math.max(mA.altura, mB.altura);
    const y = meioV(a, altura);
    const kw = 300;
    const kh = 150;
    const kx = a.x + (larg - kw) / 2;
    const p = estalo(local / 0.3);
    ctx.save();
    ctx.translate(kx + kw / 2, y + kh / 2);
    ctx.scale(p, p);
    ctx.translate(-kx - kw / 2, -y - kh / 2);
    ctx.fillStyle = misturar("#2c3a52", ACENTO, liga);
    ctx.beginPath(); ctx.roundRect(kx, y, kw, kh, kh / 2); ctx.fill();
    const bx = lerp(kx + kh / 2, kx + kw - kh / 2, liga);
    const esticada = 1 + 0.3 * Math.sin(Math.PI * liga);
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.roundRect(bx - (kh / 2 - 12) * esticada, y + 12, (kh - 24) * esticada, kh - 24, kh / 2 - 12); ctx.fill();
    ctx.restore();
    if (liga > 0) {
      anel(ctx, kx + kw - kh / 2, y + kh / 2, lim(liga * 1.4 - 0.4), 40, 360);
      fagulhas(ctx, kx + kw - kh / 2, y + kh / 2, (local - Math.min(1.05, dur * 0.36) - 0.15) / 0.55, 11, 16, 330);
    }
    const yT = y + kh + 60;
    ctx.font = inter(32, 700);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.globalAlpha *= 1 - lim(liga * 1.6);
    if (liga < 1) {
      ctx.translate(0, -liga * 50);
      escrever(ctx, mA, { x: a.x, y: yT, largura: larg, local, atraso: 0.1, passo: 0.04, centro: true, cor: CINZA });
    }
    ctx.restore();
    if (liga > 0.3) {
      ctx.save();
      ctx.translate(0, (1 - liga) * 50);
      escrever(ctx, mB, { x: a.x, y: yT, largura: larg, realce: tela.texto, local: local - Math.min(1.05, dur * 0.36) - 0.1, passo: 0.04, centro: true });
      ctx.restore();
    }
    ctx.textAlign = "left";
    ctx.font = inter(28, 700);
    ctx.fillStyle = liga > 0.5 ? ACENTO : CINZA;
    ctx.textAlign = "center";
    ctx.fillText(rotulos[liga > 0.5 ? 1 : 0], a.x + larg / 2, y - 34);
    ctx.textAlign = "left";
  },
];

const LISTAS = [
  // A pilha: os itens anteriores sobem já marcados, e o novo entra com estalo.
  function listaPilha(c) {
    const { ctx, area: a, local, tela, telas, i } = c;
    const anteriores = telas.slice(0, i).filter((t) => t.visual === "lista").slice(-2);
    const m = medir(ctx, tela.titulo, { largura: a.largura - 190, alturaMax: 380, maior: 84, menor: 46, fonte: (t) => inter(t, 600), entre: 1.2 });
    const hNovo = Math.max(160, m.altura + 76);
    const altura = anteriores.length * 110 + hNovo + (tela.texto ? 30 + alturaApoio(ctx, tela.texto, a.largura - 40, 44) : 0);
    const y = meioV(a, altura);
    const sobe = (1 - suave((local - 0.05) / 0.3)) * 110;
    anteriores.forEach((t, k) => {
      const yy = y + k * 110 + sobe;
      ctx.save();
      ctx.globalAlpha *= 0.62;
      caixa(ctx, a.x, yy, a.largura, 92, 46);
      check(ctx, a.x + 50, yy + 46, 24);
      ctx.fillStyle = CINZA;
      ctx.font = inter(32, 500);
      ctx.textBaseline = "middle";
      let txt = t.titulo;
      while (ctx.measureText(txt).width > a.largura - 130 && txt.length > 4) txt = `${txt.slice(0, -2).trim()}…`;
      ctx.fillText(txt, a.x + 92, yy + 47);
      ctx.restore();
    });
    const yN = y + anteriores.length * 110;
    const x0 = (1 - estalo(local / 0.34)) * -a.largura * 0.9;
    ctx.save();
    ctx.translate(x0, 0);
    caixa(ctx, a.x, yN, a.largura, hNovo, 44, { sombra: 44 });
    const marca = (local - 0.55) / 0.26;
    ctx.strokeStyle = "rgba(255,255,255,.3)";
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(a.x + 72, yN + hNovo / 2, 42, 0, Math.PI * 2); ctx.stroke();
    if (marca > 0) check(ctx, a.x + 72, yN + hNovo / 2, 42, estalo(marca, 2.2));
    anel(ctx, a.x + 72, yN + hNovo / 2, (local - 0.55) / 0.5, 40, 170);
    escrever(ctx, m, { x: a.x + 146, y: yN + (hNovo - m.altura) / 2, largura: a.largura - 190, realce: tela.destaque, local, atraso: 0.12, passo: 0.04, fonte: (t, peso) => inter(t, peso === 600 ? 700 : 600) });
    ctx.restore();
    apoio(ctx, tela.texto, { x: a.x + 20, y: yN + hNovo + 30, largura: a.largura - 40, tamanho: 44, local, inicio: 0.6 });
  },

  // Uma linha do tempo de editor: a barra é arrastada e vira o título.
  function listaEditor(c) {
    const { ctx, area: a, local, tela, numero } = c;
    const mT = medir(ctx, tela.titulo, { largura: a.largura, alturaMax: 400, maior: 112, menor: 54 });
    const altPainel = Math.min(560, a.base - a.topo - mT.altura - 60);
    const altura = mT.altura + 50 + altPainel;
    const y = meioV(a, altura);
    escrever(ctx, mT, { x: a.x, y, largura: a.largura, realce: tela.destaque, local, passo: 0.05, atraso: 0.08 });
    const yP = y + mT.altura + 50;
    const p = suave((local - 0.05) / 0.3);
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.translate(0, (1 - p) * 90);
    caixa(ctx, a.x, yP, a.largura, altPainel, 24, { cor: "#141d30", sombra: 40 });
    const faixas = 3;
    const altF = (altPainel - 46) / faixas;
    const larg = a.largura - 80;
    const desliza = curva((local - 0.65) / 0.55) * 170;
    const agulha = a.x + 40 + larg * ((local * 0.28) % 1);
    for (let k = 0; k < 41; k++) {
      ctx.fillStyle = "rgba(255,255,255,.28)";
      ctx.fillRect(a.x + 40 + (k / 40) * larg, yP + 36 - (k % 5 ? 8 : 15), 1.5, k % 5 ? 8 : 15);
    }
    [[0.02, 0.32], [0.16, 0.42], [0.38, 0.58]].forEach(([ini, dur], k) => {
      const yy = yP + 46 + k * altF;
      const arrastada = k === 1;
      const ativa = arrastada && local > 0.6 && local < 1.25;
      const x = a.x + 40 + ini * larg + (arrastada ? desliza : 0);
      ctx.fillStyle = ativa ? "#66e3ff" : arrastada ? ACENTO : "#8b5cf6";
      ctx.beginPath(); ctx.roundRect(x, yy + 8, dur * larg, altF - 16, 10); ctx.fill();
      if (ativa) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      if (arrastada) {
        ctx.save();
        ctx.beginPath(); ctx.roundRect(x, yy + 8, dur * larg, altF - 16, 10); ctx.clip();
        ctx.fillStyle = "#fff";
        ctx.font = inter(Math.min(30, altF * 0.42), 600);
        ctx.textBaseline = "middle";
        ctx.fillText(`Passo ${numero}`, x + 24, yy + altF / 2 + 1);
        ctx.restore();
      }
    });
    ctx.fillStyle = "#e5484d";
    ctx.fillRect(agulha, yP + 14, 3, altPainel - 22);
    ctx.restore();
    const yB = yP + 46 + altF * 1.5;
    const xB = a.x + 40 + 0.3 * larg;
    const chega = curva((local - 0.2) / 0.42);
    const px = (local < 0.65 ? lerp(a.x + a.largura + 60, xB, chega) : xB + desliza);
    const py = lerp(yP + altPainel + 260, yB + 8, chega);
    if (!c.parado) seta(ctx, px, py, 92, local > 0.62 && local < 1.2 ? 0.9 : 1, 1 - lim((local - 1.4) / 0.25));
    if (tela.texto && altPainel < 300 === false && a.base - (yP + altPainel) > 90) apoio(ctx, tela.texto, { x: a.x, y: yP + altPainel + 26, largura: a.largura, tamanho: 42, local, inicio: 0.7 });
  },

  // Gráfico de barras que cresce enquanto o número do passo conta.
  function listaGrafico(c) {
    const { ctx, area: a, local, tela, id, i } = c;
    const m = medir(ctx, tela.titulo, { largura: a.largura, alturaMax: 400, maior: 108, menor: 54 });
    const altG = Math.min(640, a.base - a.topo - m.altura - 50);
    const y = meioV(a, m.altura + 50 + altG);
    escrever(ctx, m, { x: a.x, y, largura: a.largura, realce: tela.destaque, local, passo: 0.05, atraso: 0.08 });
    const yG = y + m.altura + 50;
    const p = suave(local / 0.25);
    ctx.save();
    ctx.globalAlpha *= p;
    caixa(ctx, a.x, yG, a.largura, altG, 28, { sombra: 34 });
    const n = 7;
    const vao = (a.largura - 90) / n;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const v = 0.18 + (k / (n - 1)) * 0.68 + (sorteio(id + i + k) - 0.5) * 0.12;
      const q = suave((local - 0.18 - k * 0.07) / 0.4);
      const alt = (altG - 80) * v * q;
      const x = a.x + 45 + k * vao + vao * 0.18;
      ctx.fillStyle = k === n - 1 ? NASCE : "rgba(0,212,255,.42)";
      ctx.beginPath(); ctx.roundRect(x, yG + altG - 36 - alt, vao * 0.64, Math.max(1, alt), 8); ctx.fill();
      pts.push([x + vao * 0.32, yG + altG - 36 - alt]);
    }
    ctx.strokeStyle = CREME;
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(([x, yy], k) => ctx[k ? "lineTo" : "moveTo"](x, yy - 18));
    ctx.stroke();
    const [ux, uy] = pts[n - 1];
    fagulhas(ctx, ux, uy - 18, (local - 0.75) / 0.5, id + i, 12, 170);
    ctx.restore();
  },
];

const IMPACTOS = [
  // Cada palavra numa linha, ocupando a largura inteira e empurrando a anterior.
  function impactoEmpilha(c) {
    const { ctx, area: a, local, tela, id } = c;
    const pal = tela.titulo.split(/\s+/).filter(Boolean);
    const linhas = [];
    pal.forEach((p) => {
      const ult = linhas[linhas.length - 1];
      if (ult && pal.length > 4 && ult.length + p.length < 10) linhas[linhas.length - 1] = `${ult} ${p}`;
      else linhas.push(p);
    });
    const medidas = linhas.map((l) => {
      ctx.font = serifa(100, 600);
      return Math.min(a.base - a.topo > 900 ? 230 : 150, (100 * a.largura * 0.96) / ctx.measureText(l).width);
    });
    const mt = tela.texto ? alturaApoio(ctx, tela.texto, a.largura) + 30 : 0;
    const altura = medidas.reduce((s, t) => s + t * 1.04, 0);
    const y0 = meioV(a, Math.min(altura, a.base - a.topo - mt) + mt);
    const realce = new Set(String(tela.destaque).split(/\s+/).map(semAcento).filter(Boolean));
    const escalaGeral = Math.min(1, (a.base - a.topo - mt) / altura);
    let yy = y0;
    linhas.forEach((l, k) => {
      const tam = medidas[k] * escalaGeral;
      const nasc = 0.04 + k * 0.17;
      const q = (local - nasc) / 0.24;
      if (q > 0) {
        const frio = lim((local - nasc) / 0.5);
        const marcada = l.split(" ").some((p) => realce.has(semAcento(p)));
        ctx.save();
        ctx.translate(a.x + a.largura / 2, yy + (tam * 1.04) / 2);
        const e = lerp(1.7, 1, suave(q));
        ctx.scale(e, e);
        ctx.globalAlpha *= lim(q * 3);
        ctx.font = serifa(tam, 600);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = misturar(NASCE, marcada ? ACENTO : CREME, frio);
        ctx.shadowColor = `rgba(0,212,255,${0.5 * (1 - frio) + (marcada ? 0.25 : 0)})`;
        ctx.shadowBlur = 44;
        ctx.fillText(l, 0, 0);
        ctx.restore();
        ctx.textAlign = "left";
        fagulhas(ctx, a.x + a.largura / 2, yy + (tam * 1.04) / 2, (local - nasc) / 0.5, id + k, 16, 480);
      }
      yy += tam * 1.04;
    });
    apoio(ctx, tela.texto, { x: a.x, y: yy + 30, largura: a.largura, local, inicio: 0.7, centro: true });
  },

  // A tela clara abre, e a frase bate em tinta preta.
  function impactoClaro(c) {
    const { ctx, w, h, area: a, local, tela } = c;
    telaClara(ctx, w, h, local / 0.3, a.x + a.largura / 2, (a.topo + a.base) / 2);
    const mt = tela.texto ? alturaApoio(ctx, tela.texto, a.largura) + 28 : 0;
    const m = hook(c, { largura: a.largura, alturaMax: Math.min(760, a.base - a.topo - mt), maior: 170, menor: 60, fonte: (t, p = 600) => serifa(t, p), entre: 1.06 });
    const y = meioV(a, m.altura + mt);
    const e = 1 + 0.018 * local;
    ctx.save();
    ctx.translate(a.x + a.largura / 2, y + m.altura / 2);
    ctx.scale(e, e);
    ctx.translate(-a.x - a.largura / 2, -y - m.altura / 2);
    escrever(ctx, m, { x: a.x, y, largura: a.largura, realce: tela.destaque, local, atraso: 0.2, passo: 0.11, centro: true, cor: TINTA, corRealce: "#0077c8", modo: "bate", fonte: (t, p = 600) => serifa(t, p), pesoRealce: 600 });
    ctx.restore();
    apoio(ctx, tela.texto, { x: a.x, y: y + m.altura + 28, largura: a.largura, local, inicio: 0.8, centro: true, escuro: true });
  },

  // As palavras vêm dos dois lados, com faixas de luz cruzando a tela.
  function impactoLados(c) {
    const { ctx, w, area: a, local, tela, id } = c;
    for (let k = 0; k < 5; k++) {
      const q = (local * (0.6 + sorteio(id + k) * 0.5) + sorteio(id + k + 9)) % 1;
      const yy = a.topo + (a.base - a.topo) * sorteio(id + k + 20);
      const g = ctx.createLinearGradient(lerp(-400, w, q), 0, lerp(-400, w, q) + 400, 0);
      g.addColorStop(0, "rgba(0,212,255,0)");
      g.addColorStop(0.5, "rgba(0,212,255,.5)");
      g.addColorStop(1, "rgba(0,212,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, yy, w, 3 + sorteio(id + k + 30) * 4);
    }
    const mt = tela.texto ? alturaApoio(ctx, tela.texto, a.largura) + 30 : 0;
    const m = hook(c, { largura: a.largura, alturaMax: Math.min(720, a.base - a.topo - mt), maior: 160, menor: 60, fonte: (t, p = 600) => serifa(t, p), entre: 1.08 });
    const y = meioV(a, m.altura + mt);
    escrever(ctx, m, { x: a.x, y, largura: a.largura, realce: tela.destaque, local, atraso: 0.02, passo: 0.13, centro: true, modo: "lado", fonte: (t, p = 600) => serifa(t, p) });
    apoio(ctx, tela.texto, { x: a.x, y: y + m.altura + 30, largura: a.largura, local, inicio: 0.7, centro: true });
  },
];

const TEXTOS = [
  // A frase sai de dentro do símbolo, que gira e pulsa.
  function textoSimbolo(c) {
    const { ctx, area: a, local, tela } = c;
    const m = hook(c, { largura: a.largura - 130, alturaMax: Math.min(700, a.base - a.topo - 40), maior: 112, menor: 54 });
    const mt = tela.texto ? alturaApoio(ctx, tela.texto, a.largura - 130, 44) + 30 : 0;
    const y = meioV(a, m.altura + mt);
    const p = lim(local / 0.34);
    const pulso = 1 + 0.2 * Math.max(0, 1 - Math.abs(local - 0.3) / 0.16);
    simbolo(ctx, a.x + 48, y + m.tamanho * 0.58, 92 * estalo(local / 0.26) * pulso, local * 70);
    ctx.save();
    ctx.translate(a.x + 48, y + m.tamanho * 0.58);
    const e = 0.3 + 0.7 * estalo(p);
    ctx.scale(e, e);
    ctx.translate(-a.x - 48, -y - m.tamanho * 0.58);
    ctx.translate((1 - suave(p)) * -70 + Math.sin(local * 1.8) * 3, 0);
    ctx.globalAlpha *= lim(p * 3);
    escrever(ctx, m, { x: a.x + 130, y, largura: a.largura - 130, realce: tela.destaque, local: local + 0.5, passo: 0.02 });
    ctx.restore();
    apoio(ctx, tela.texto, { x: a.x + 130, y: y + m.altura + 30, largura: a.largura - 130, tamanho: 44, local, inicio: 0.5 });
  },

  // Uma janela clara flutuando no escuro, com a palavra sendo selecionada pelo mouse.
  function textoJanela(c) {
    const { ctx, area: a, local, tela } = c;
    const pad = 54;
    const m = hook(c, { largura: a.largura - pad * 2, alturaMax: Math.min(600, a.base - a.topo - 200), maior: 102, menor: 50 });
    const mt = alturaApoio(ctx, tela.texto, a.largura - pad * 2, 42);
    const h = 74 + pad + m.altura + (mt ? 24 + mt : 0) + pad;
    const y = meioV(a, h);
    const p = estalo(local / 0.32, 1.1);
    ctx.save();
    ctx.translate(a.x + a.largura / 2, y + h / 2);
    ctx.scale(p, p);
    ctx.rotate(((Math.sin(local * 0.9) * 0.8 - 0.6) * Math.PI) / 180);
    ctx.translate(-a.x - a.largura / 2, -y - h / 2);
    caixa(ctx, a.x, y, a.largura, h, 30, { cor: CLARO, borda: null, sombra: 60 });
    ctx.fillStyle = "#e9e8e4";
    ctx.beginPath(); ctx.roundRect(a.x, y, a.largura, 64, [30, 30, 0, 0]); ctx.fill();
    ["#c9c7c1", "#d6d4ce", "#e0ded8"].forEach((cor, k) => {
      ctx.fillStyle = cor;
      ctx.beginPath(); ctx.arc(a.x + 44 + k * 34, y + 32, 11, 0, Math.PI * 2); ctx.fill();
    });
    const yT = y + 64 + pad;
    // O marca-texto corre pela palavra de destaque, na linha em que ela estiver.
    const alvo = semAcento(tela.destaque.split(/\s+/)[0]);
    const sel = curva((local - 0.75) / 0.34);
    if (alvo && sel > 0) {
      m.linhas.forEach((l, li) => {
        ctx.font = serifa(m.tamanho);
        let xx = a.x + pad;
        for (const pal of l.split(" ")) {
          const lp = ctx.measureText(`${pal} `).width;
          if (semAcento(pal) === alvo) {
            ctx.fillStyle = "rgba(0,212,255,.32)";
            ctx.beginPath();
            ctx.roundRect(xx - 6, yT + li * m.tamanho * m.entre + 4, (ctx.measureText(pal).width * 1.05 + 12) * sel, m.tamanho * 1.08, 8);
            ctx.fill();
          }
          xx += lp;
        }
      });
    }
    const r = escrever(ctx, m, { x: a.x + pad, y: yT, largura: a.largura - pad * 2, realce: tela.destaque, local, atraso: 0.16, passo: 0.05, cor: TINTA, corRealce: "#0077c8" });
    apoio(ctx, tela.texto, { x: a.x + pad, y: r.fimY + 24, largura: a.largura - pad * 2, tamanho: 42, local, inicio: 0.6, escuro: true });
    ctx.restore();
    const q = curva((local - 0.34) / 0.45);
    if (!c.parado) seta(ctx, lerp(a.x + a.largura + 80, a.x + a.largura * 0.6, q), lerp(y + h + 280, yT + m.altura * 0.6, q), 96, 1, 1 - lim((local - 1.5) / 0.3));
  },

  // Notificações que descem uma atrás da outra, e o título embaixo.
  function textoAvisos(c) {
    const { ctx, area: a, local, tela, id, i } = c;
    const m = hook(c, { largura: a.largura, alturaMax: Math.min(480, (a.base - a.topo) * 0.5), maior: 108, menor: 54 });
    const altA = 118;
    const n = a.base - a.topo > 800 ? 3 : 2;
    const y = meioV(a, n * (altA + 16) + 36 + m.altura);
    for (let k = 0; k < n; k++) {
      const q = estalo((local - 0.04 - k * 0.2) / 0.28);
      const yy = y + k * (altA + 16);
      ctx.save();
      ctx.globalAlpha *= lim((local - 0.04 - k * 0.2) / 0.1);
      ctx.translate(0, (1 - q) * -130);
      caixa(ctx, a.x, yy, a.largura, altA, 30, { sombra: 28 });
      ctx.fillStyle = k === n - 1 ? ACENTO : "#2c3a52";
      ctx.beginPath(); ctx.arc(a.x + 60, yy + altA / 2, 34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(239,230,220,.5)";
      ctx.beginPath(); ctx.roundRect(a.x + 118, yy + 34, 190 + sorteio(id + i + k) * 120, 16, 8); ctx.fill();
      ctx.fillStyle = "rgba(239,230,220,.22)";
      ctx.beginPath(); ctx.roundRect(a.x + 118, yy + 66, 320 + sorteio(id + i + k + 5) * 260, 14, 7); ctx.fill();
      ctx.restore();
    }
    const yT = y + n * (altA + 16) + 36;
    const r = escrever(ctx, m, { x: a.x, y: yT, largura: a.largura, realce: tela.destaque, local, atraso: 0.4, passo: 0.05 });
    if (a.base - r.fimY > 80) apoio(ctx, tela.texto, { x: a.x, y: r.fimY + 18, largura: a.largura, tamanho: 42, local, inicio: 0.8 });
  },
];

// A foto do post entra num cartão que se aproxima devagar. O título fica sempre fora dela.
function textoComFoto(c) {
  const { ctx, area: a, local, tela, foto } = c;
  const m = hook(c, { largura: a.largura, alturaMax: 380, maior: 104, menor: 52 });
  const mt = alturaApoio(ctx, tela.texto, a.largura, 42);
  const alt = Math.min(560, a.base - a.topo - m.altura - mt - 90);
  const y = meioV(a, alt + 36 + m.altura + (mt ? 18 + mt : 0));
  const p = suave(local / 0.34);
  if (alt > 160) {
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.translate(0, (1 - p) * 90);
    ctx.beginPath();
    ctx.roundRect(a.x, y, a.largura, alt, 32);
    ctx.clip();
    const zoom = 1.04 + 0.03 * local;
    const e = Math.max(a.largura / foto.width, alt / foto.height) * zoom;
    ctx.drawImage(foto, a.x + (a.largura - foto.width * e) / 2 + Math.sin(local * 0.5) * 14, y + (alt - foto.height * e) / 2, foto.width * e, foto.height * e);
    ctx.restore();
  }
  const r = escrever(ctx, m, { x: a.x, y: y + Math.max(alt, 0) + 36, largura: a.largura, realce: tela.destaque, local, atraso: 0.2, passo: 0.05 });
  apoio(ctx, tela.texto, { x: a.x, y: r.fimY + 18, largura: a.largura, tamanho: 42, local, inicio: 0.7 });
}

// ---------- A chamada final: o comentário sendo digitado de verdade ----------

const TECLADO = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

/** A palavra que aparece sendo comentada: a que a chamada pede ("Comenta OBRA"), para a cena não contradizer a fala. */
export function palavraDaChamada(tela) {
  const pedida = [tela.titulo, tela.texto, tela.fala].map((t) => String(t ?? "").match(/[Cc]omenta\s+["“']?(\p{Lu}[\p{Lu}\p{N}]+)/u)?.[1]).find(Boolean);
  if (pedida) return pedida;
  const destaque = semEmojiPalavra(tela.destaque);
  if (destaque) return destaque.toUpperCase();
  const maiuscula = tela.titulo.split(/\s+/).find((p) => p.length > 2 && p === p.toUpperCase() && /\p{L}/u.test(p));
  return (maiuscula ?? "QUERO").replace(/[^\p{L}\p{N}]/gu, "");
}
const semEmojiPalavra = (d) => String(d ?? "").split(/\s+/).map((p) => p.replace(/[^\p{L}\p{N}]/gu, "")).find(Boolean) ?? "";

function chamadaComentario(c) {
  const { ctx, area: a, local, tela, empresa, dur } = c;
  // Em vídeo curto, a encenação inteira roda mais rápido.
  const v = Math.max(1, 2.9 / Math.max(1.4, dur === Infinity ? 99 : dur));
  const l = c.parado ? 99 : local * v;
  const mT = medir(ctx, tela.titulo, { largura: a.largura, alturaMax: 250, maior: 90, menor: 50 });
  escrever(ctx, mT, { x: a.x, y: a.topo, largura: a.largura, realce: tela.destaque, local, atraso: 0.05, passo: 0.04, centro: true });
  const yF = a.topo + mT.altura + 28;
  const altF = a.base - yF;
  const p = suave(l / 0.3);
  const x = a.x;
  const larg = a.largura;
  ctx.save();
  ctx.translate(0, (1 - p) * 300);
  ctx.globalAlpha *= p;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, yF, larg, altF, 40);
  ctx.clip();
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, yF, larg, altF);
  // Etapas: digita, envia, o teclado desce, o comentário entra, o autor responde, curte.
  const palavra = Array.from(palavraDaChamada(tela));
  const passoL = 0.09;
  const iniDig = 0.3;
  const fimDig = iniDig + palavra.length * passoL;
  const envia = fimDig + 0.1;
  const desce = curva((l - envia) / 0.26);
  const novo = curva((l - envia - 0.05) / 0.26);
  const resp = curva((l - envia - 0.32) / 0.24);
  const curte = (l - envia - 0.75) / 0.2;
  const altCampo = 96;
  const altTeclas = Math.min(270, altF * 0.42);
  const yCampo = yF + altF - altCampo - (1 - desce) * altTeclas;
  const yLista = yF + 28;
  const altC = 158;
  const altR = 176;
  // Comentários de outras pessoas: sem nome nem foto.
  const fila = 1 + (novo > 0 ? novo : 0);
  for (let k = 0; k < 4; k++) {
    const yy = yLista + k * altC + (fila - 1) * altC + resp * altR;
    if (yy > yCampo) break;
    ctx.fillStyle = "#dbdbdb";
    ctx.beginPath(); ctx.arc(x + 66, yy + 70, 40, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.roundRect(x + 128, yy + 34, 170, 18, 9); ctx.fill();
    ctx.fillStyle = "#e7e7e7";
    ctx.beginPath(); ctx.roundRect(x + 128, yy + 72, 300 + sorteio(k + 3) * 300, 26, 13); ctx.fill();
    coracao(ctx, x + larg - 54, yy + 66, 36);
  }
  // A resposta da empresa, recuada.
  if (resp > 0) {
    const yR = yLista + altC + (resp - 1) * altR;
    ctx.save();
    ctx.globalAlpha *= resp;
    c.logo(ctx, x + 128, yR + 14, 72);
    ctx.fillStyle = "#000";
    ctx.font = inter(34, 700);
    ctx.textBaseline = "middle";
    ctx.fillText(empresa, x + 216, yR + 36);
    const nomeL = ctx.measureText(empresa).width;
    ctx.fillStyle = "#737373";
    ctx.font = inter(30, 500);
    ctx.fillText("agora · Autor", x + 230 + nomeL, yR + 36);
    ctx.fillStyle = "#000";
    ctx.font = inter(40, 500);
    ctx.fillText("Te mandei tudo no direct", x + 216, yR + 92);
    ctx.restore();
  }
  // O comentário novo.
  if (novo > 0) {
    const yN = yLista + (novo - 1) * altC;
    ctx.fillStyle = misturar("#eef3ff", "#ffffff", lim((l - envia - 0.3) / 0.8));
    ctx.fillRect(x, yN, larg, altC);
    ctx.fillStyle = "#dbdbdb";
    ctx.beginPath(); ctx.arc(x + 66, yN + 76, 40, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(x + 66, yN + 64, 14, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + 66, yN + 102, 24, 18, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = "#000";
    ctx.font = inter(34, 700);
    ctx.textBaseline = "middle";
    ctx.fillText("voce", x + 128, yN + 46);
    ctx.fillStyle = "#737373";
    ctx.font = inter(30, 500);
    ctx.fillText("agora", x + 222, yN + 46);
    ctx.font = inter(50, 600);
    ctx.fillStyle = misturar(NASCE, "#000000", lim((l - envia - 0.05) / 0.5));
    ctx.fillText(palavra.join(""), x + 128, yN + 104);
    const cheio = curte > 0;
    const e = cheio ? estalo(curte, 2.2) : 1;
    coracao(ctx, x + larg - 54, yN + 70, 38 * e, cheio ? { cor: "#ff3040", cheio: true } : {});
    fagulhas(ctx, x + larg - 54, yN + 70, curte / 2, 21, 10, 110, "#ff3040");
  }
  // O campo de comentário.
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, yCampo, larg, altCampo + altTeclas);
  ctx.strokeStyle = "#efefef";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, yCampo); ctx.lineTo(x + larg, yCampo); ctx.stroke();
  const noCampo = l >= iniDig && l < envia;
  caixa(ctx, x + 22, yCampo + 16, larg - 44, altCampo - 32, 32, { cor: "#fff", borda: "#dbdbdb" });
  ctx.textBaseline = "middle";
  const nL = Math.min(palavra.length, Math.floor((l - iniDig) / passoL) + 1);
  if (noCampo) {
    let xx = x + 54;
    ctx.font = inter(32, 500);
    palavra.slice(0, nL).forEach((letra, k) => {
      ctx.fillStyle = misturar(NASCE, "#000000", lim((l - iniDig - k * passoL) / 0.3));
      ctx.fillText(letra, xx, yCampo + altCampo / 2);
      xx += ctx.measureText(letra).width;
    });
    ctx.fillStyle = "#3478f6";
    ctx.fillRect(xx + 3, yCampo + altCampo / 2 - 19, 3, 38);
  } else {
    ctx.fillStyle = "#737373";
    ctx.font = inter(30, 400);
    ctx.fillText("Adicione um comentário...", x + 54, yCampo + altCampo / 2);
  }
  if (noCampo || (l >= envia && l < envia + 0.14)) {
    const e = estalo((l - iniDig) / 0.2) * (1 - 0.14 * Math.sin(Math.PI * lim((l - fimDig) / 0.14)));
    ctx.save();
    ctx.translate(x + larg - 86, yCampo + altCampo / 2);
    ctx.scale(e, e);
    ctx.fillStyle = "#445ffe";
    ctx.beginPath(); ctx.roundRect(-46, -26, 92, 52, 26); ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(0, 13); ctx.lineTo(0, -12); ctx.moveTo(-11, -2); ctx.lineTo(0, -13); ctx.lineTo(11, -2); ctx.stroke();
    ctx.restore();
    anel(ctx, x + larg - 86, yCampo + altCampo / 2, (l - envia + 0.04) / 0.24, 24, 110, "#445ffe");
  }
  // O teclado.
  if (desce < 1) {
    const yK = yCampo + altCampo;
    ctx.fillStyle = "#d1d3d9";
    ctx.fillRect(x, yK, larg, altTeclas + 300);
    const ativa = noCampo ? palavra[Math.min(palavra.length - 1, Math.max(0, nL - 1))] : "";
    const fileiras = TECLADO.slice(0, Math.max(2, Math.floor(altTeclas / 80)));
    const passoT = (larg - 30) / 10;
    const altT = altTeclas / fileiras.length - 12;
    fileiras.forEach((fileira, f) => {
      const letras = Array.from(fileira);
      const ini = x + (larg - letras.length * passoT) / 2;
      letras.forEach((letra, k) => {
        const on = letra === semAcento(ativa).toUpperCase();
        const xx = ini + k * passoT + 3;
        ctx.save();
        ctx.translate(xx + (passoT - 6) / 2, yK + 10 + f * (altT + 12) + altT / 2);
        if (on) ctx.scale(1.12, 1.12);
        ctx.fillStyle = on ? "#9aa0ac" : "#fff";
        ctx.beginPath(); ctx.roundRect(-(passoT - 6) / 2, -altT / 2, passoT - 6, altT, 8); ctx.fill();
        ctx.fillStyle = "#000";
        ctx.font = inter(Math.min(32, altT * 0.5), 500);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(letra, 0, 1);
        ctx.restore();
      });
    });
    ctx.textAlign = "left";
  }
  ctx.restore();
  ctx.restore();
}

function chamadaDirect(c) {
  const { ctx, area: a, local, tela, empresa } = c;
  const m = hook(c, { largura: a.largura, alturaMax: Math.min(620, a.base - a.topo - 300), maior: 120, menor: 58 });
  const y = meioV(a, m.altura + 260);
  const r = escrever(ctx, m, { x: a.x, y, largura: a.largura, realce: tela.destaque, local, atraso: 0.05, passo: 0.06, centro: true });
  const q = estalo((local - 0.5) / 0.32);
  const yN = r.fimY + 54;
  ctx.save();
  ctx.translate(0, (1 - q) * -260);
  ctx.globalAlpha *= lim((local - 0.5) / 0.14);
  caixa(ctx, a.x, yN, a.largura, 170, 40, { sombra: 50 });
  c.logo(ctx, a.x + 34, yN + 35, 100);
  ctx.fillStyle = CREME;
  ctx.font = inter(36, 700);
  ctx.textBaseline = "middle";
  ctx.fillText(empresa, a.x + 160, yN + 58);
  ctx.fillStyle = CINZA;
  ctx.font = inter(32, 500);
  ctx.fillText("Chama no direct", a.x + 160, yN + 110);
  botaoEnviar(ctx, a.x + a.largura - 114, yN + 46, 78, 1 + 0.05 * Math.sin(local * 6));
  ctx.restore();
}

const CENAS = { capa: CAPAS, pergunta: PERGUNTAS, contraste: CONTRASTES, lista: LISTAS, impacto: IMPACTOS, texto: TEXTOS, cta: [chamadaComentario, chamadaDirect] };

/** Qual encenação a cena usa: gira de post para post, e o mesmo tipo não se repete dentro do vídeo. */
function encenacao(post, telas, i) {
  const lista = CENAS[telas[i].visual] ?? TEXTOS;
  const repeticao = telas.slice(0, i).filter((t) => t.visual === telas[i].visual).length;
  const id = Math.abs(Number(post?.id) || 0);
  return lista[(id + repeticao) % lista.length];
}

// As transições de cena. A cena que sai acelera, e a que entra chega freando, para parecer um movimento só.
const TRANSICOES = [
  (ctx, w, h, e, s) => ctx.translate(0, (1 - e) * 620 - s * 720),
  (ctx, w, h, e, s) => ctx.translate((1 - e) * 820 - s * 900, 0),
  (ctx, w, h, e, s) => {
    const z = (1 + (1 - e) * 0.5) * (1 + s * 0.7);
    ctx.translate(w / 2, h / 2);
    ctx.scale(z, z);
    ctx.translate(-w / 2, -h / 2);
  },
  (ctx, w, h, e, s) => {
    ctx.translate(w / 2, h / 2);
    ctx.rotate(((1 - e) * 0.14) - s * 0.14);
    const z = (1 - (1 - e) * 0.25) * (1 - s * 0.3);
    ctx.scale(z, z);
    ctx.translate(-w / 2, -h / 2 + (1 - e) * 260 - s * 300);
  },
];

// Borrão de movimento barato: desenha pequeno e amplia. Serve no servidor e em todo navegador.
let camada = null;
let miniatura = null;

function comBorrao(ctx, novoCanvas, w, h, nivel, desenhar) {
  if (nivel < 0.04) return desenhar(ctx);
  camada ??= novoCanvas(w, h);
  const c = camada.getContext("2d");
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  desenhar(c);
  const k = Math.max(0.09, 1 - nivel * 0.92);
  miniatura ??= novoCanvas(w, h);
  const m = miniatura.getContext("2d");
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, w, h);
  m.imageSmoothingEnabled = true;
  m.drawImage(camada, 0, 0, w * k, h * k);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(miniatura, 0, 0, w * k, h * k, 0, 0, w, h);
  ctx.restore();
}

/** A assinatura: a marca cresce de dentro de um anel de luz. */
function assinatura(c) {
  const { ctx, w, h, t, local, empresa } = c;
  fundoNoturno(ctx, w, h, t, Math.max(0, 1 - local / 0.6));
  riscos(ctx, w / 2, h * 0.46, local * 1.2);
  const e = estalo((local - 0.2) / 0.34);
  const tam = 190;
  if (local > 0.2) {
    ctx.save();
    ctx.translate(w / 2, h * 0.42);
    ctx.scale(e, e);
    c.logo(ctx, -tam / 2, -tam / 2, tam);
    ctx.restore();
    anel(ctx, w / 2, h * 0.42, (local - 0.22) / 0.7, 100, 560);
    const p = suave((local - 0.42) / 0.3);
    ctx.save();
    ctx.globalAlpha *= p;
    ctx.fillStyle = CREME;
    ctx.font = serifa(112, 600);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(empresa, w / 2, h * 0.42 + 190 + (1 - p) * 30);
    ctx.textAlign = "left";
    ctx.restore();
  }
}

/** Um quadro do Reels no instante `t`. */
export function desenharReels(ctx, { w, h, t, post, telas, duracoes, cenasComVideo, capa, empresa, foto, logo, felipe, novoCanvas, rotulos }) {
  const totalCenas = duracoes.reduce((s, d) => s + d, 0);
  if (!capa && t >= totalCenas) return assinatura({ ctx, w, h, t, local: t - totalCenas, empresa, logo });
  let inicio = 0;
  let i = 0;
  while (i < telas.length - 1 && t >= inicio + duracoes[i]) inicio += duracoes[i++];
  const dur = capa ? Infinity : duracoes[i];
  const local = capa ? 99 : t - inicio;
  const tela = telas[i];
  const id = Math.abs(Number(post?.id) || 0);
  const comVideo = Boolean(cenasComVideo?.has(i));
  const janela = comVideo ? janelaDaCena(post, i, tela.visual) : null;

  // A área livre: fora do quadro do avatar e da faixa de baixo, que o Instagram cobre com a legenda.
  const area = { x: 60, largura: w - 120, topo: 170, base: 1540 };
  if (janela) {
    if (janela.y < 500) area.topo = janela.y + janela.h + 84;
    else area.base = janela.y - 36;
  }
  const comFelipeNaFoto = capa && !comVideo && !post.conteudo.capaSemFelipe;
  if (comFelipeNaFoto) area.base = 1390;

  const pulso = i > 0 && !capa ? Math.max(0, 1 - local / 0.55) : 0;
  fundoNoturno(ctx, w, h, t, pulso, [0, -1, 1][(id + i) % 3]);
  // Fagulhas subindo o tempo todo: a tela nunca fica parada.
  for (let k = 0; k < 26; k++) {
    const yy = (((sorteio(k + id) * h - t * (50 + sorteio(k + 80) * 120)) % h) + h) % h;
    ctx.globalAlpha = (0.12 + sorteio(k + 120) * 0.4) * (yy / h);
    ctx.fillStyle = NASCE;
    ctx.beginPath();
    ctx.arc(sorteio(k + 40) * w + Math.sin(t + k) * 26, yy, 1.5 + sorteio(k + 160) * 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Entrada e saída.
  const e = suave(local / 0.26);
  const s = i === telas.length - 1 ? 0 : acelera((local - (dur - 0.2)) / 0.2);
  const nivel = Math.max(1 - e, s) ** 1.2;
  const transicao = TRANSICOES[(id + i * 3) % TRANSICOES.length];
  const encena = encenacao(post, telas, i);
  const numero = telas.slice(0, i + 1).filter((x) => x.visual === "lista").length;
  const propria = foto(tela.foto?.chave);

  comBorrao(ctx, novoCanvas, w, h, capa ? 0 : nivel, (alvo) => {
    alvo.save();
    if (!capa) {
      alvo.globalAlpha = lim(e * 2) * (1 - s * s);
      transicao(alvo, w, h, e, s);
      // A câmera nunca para: chega perto e passeia, cada cena para um lado.
      const q = lim(local / dur);
      const sentido = (id + i) % 2 ? 1 : -1;
      const z = 1 + 0.075 * q;
      alvo.translate(w / 2 + sentido * lerp(-14, 14, q), h * 0.45 + Math.sin(local * 1.1) * 7);
      alvo.rotate((sentido * lerp(-0.6, 0.6, q) * Math.PI) / 180);
      alvo.scale(z, z);
      alvo.translate(-w / 2, -h * 0.45);
    }
    // A encenação leva cerca de 2,3 s: em cena longa ela anda mais devagar, para durar até a fala acabar.
    const ritmo = capa ? 1 : lim(2.3 / Math.max(0.5, dur - 0.25), 0.5, 1.5);
    const c = { ctx: alvo, w, h, t, local: local * ritmo, dur: dur * ritmo, tela, telas, i, area, id, numero, rotulos, empresa, logo, foto: propria, parado: capa };
    if (propria && (tela.visual === "texto" || tela.visual === "lista")) textoComFoto(c);
    else encena(c);
    alvo.restore();
  });

  if (comFelipeNaFoto) felipe(ctx, { local, tela });

  // O buraco do avatar é o último passo: nada do que foi desenhado fica por cima do rosto.
  if (janela) {
    const resto = capa ? 0 : (1 - lim(local / ENTRADA_DA_JANELA)) ** 3;
    const x = janela.x + janela.dx * resto;
    const y = janela.y + janela.dy * resto;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)";
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 20;
    ctx.fillStyle = FUNDO;
    ctx.beginPath();
    ctx.roundRect(x, y, janela.w, janela.h, 28);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.roundRect(x, y, janela.w, janela.h, 28);
    ctx.fill();
    ctx.restore();
    // O contorno respira como quem fala, e o nome acompanha o quadro.
    const fala = 0.4 + 0.25 * Math.abs(Math.sin(t * 5));
    ctx.strokeStyle = `rgba(0,212,255,${capa ? 0.5 : fala})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, janela.w, janela.h, 28);
    ctx.stroke();
    caixa(ctx, x + janela.w / 2 - 118, y + janela.h + 14, 236, 44, 22, { cor: "rgba(11,17,32,.86)", borda: null });
    ctx.fillStyle = CREME;
    ctx.font = inter(25, 600);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Felipe Holanda", x + janela.w / 2, y + janela.h + 37);
    ctx.textAlign = "left";
  }
}
