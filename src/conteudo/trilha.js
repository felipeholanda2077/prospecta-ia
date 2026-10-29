// Trilha sonora do Reels, sintetizada aqui mesmo (sem músicas de terceiros, então sem problema de
// direitos autorais): bateria, baixo, acordes e arpejo num dos 4 climas, mais os efeitos que
// acompanham a edição: impacto no gancho, "whoosh" em cada troca de cena e uma subida antes da
// chamada final. Cada post sai com uma variação diferente (tom e padrões sorteados pelo id do post).

export const TAXA = 44100;

// Acordes em semitons a partir da tônica (MIDI); um acorde por compasso. `baixo`: a nota do baixo.
export const CLIMAS = {
  energica: {
    bpm: 124, tonica: 57,
    acordes: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], baixo: [0, -4, 3, -2],
    bumbo: [0, 4, 8, 12], palma: [4, 12], chimbalAberto: [2, 6, 10, 14], chimbal: "16", linhaBaixo: [2, 6, 10, 14],
    arpejo: "16", timbreBaixo: "serra", corteAcordes: 1800,
  },
  tensa: {
    bpm: 140, tonica: 50,
    acordes: [[0, 3, 7], [-4, 0, 3], [5, 8, 12], [7, 11, 14]], baixo: [0, -4, 5, 7],
    bumbo: [0, 7, 10], palma: [8], chimbalAberto: [], chimbal: "trap", linhaBaixo: [0, 7, 10],
    arpejo: "esparso", timbreBaixo: "808", corteAcordes: 900,
  },
  inspiradora: {
    bpm: 100, tonica: 60,
    acordes: [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]], baixo: [0, -5, -3, -7],
    bumbo: [0, 8, 10], palma: [4, 12], chimbalAberto: [14], chimbal: "chocalho", linhaBaixo: [0, 8],
    arpejo: "8", timbreBaixo: "redondo", corteAcordes: 2600,
  },
  groove: {
    bpm: 112, tonica: 52,
    acordes: [[0, 3, 7, 10], [-4, 0, 3, 7], [3, 7, 10, 12], [-2, 2, 5, 9]], baixo: [0, -4, 3, -2],
    bumbo: [0, 6, 8, 11], palma: [4, 12], chimbalAberto: [14], chimbal: "8swing", linhaBaixo: [0, 3, 6, 8, 10, 13],
    arpejo: "acordes", timbreBaixo: "serra", corteAcordes: 2200,
  },
};

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// Sorteio com semente: o mesmo post gera sempre a mesma trilha.
function gerador(semente) {
  let a = (semente * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const umPolo = (corte) => 1 - Math.exp((-2 * Math.PI * corte) / TAXA);

/**
 * Gera a trilha (estéreo, Float32 de -1 a 1) com `duracao` segundos. `cortes`: os instantes das
 * trocas de cena (o primeiro é 0). Retorna { esquerda, direita, bpm }.
 */
export function gerarTrilha({ clima = "energica", duracao, cortes = [0], semente = 1 }) {
  const c = CLIMAS[clima] ?? CLIMAS.energica;
  const aleatorio = gerador(semente);
  const ruido = () => aleatorio() * 2 - 1;
  const n = Math.ceil(duracao * TAXA);
  const bateria = [new Float32Array(n), new Float32Array(n)];
  const musica = [new Float32Array(n), new Float32Array(n)];
  const efeitos = [new Float32Array(n), new Float32Array(n)];
  // Variação por post: tom (até 3 semitons acima ou abaixo) e um pouco de andamento.
  const transpor = Math.floor(aleatorio() * 7) - 3;
  const bpm = c.bpm + Math.floor(aleatorio() * 5) - 2;
  const passo = 60 / bpm / 4; // semicolcheia
  const compasso = passo * 16;
  const tonica = c.tonica + transpor;

  const somar = (bus, i, valor, pan = 0) => {
    if (i < 0 || i >= n) return;
    bus[0][i] += valor * (1 - Math.max(0, pan));
    bus[1][i] += valor * (1 + Math.min(0, pan));
  };

  // ---------- Bateria ----------
  const bumbos = [];
  const bumbo = (t, vol = 1) => {
    bumbos.push(t);
    const i0 = Math.round(t * TAXA);
    let fase = 0;
    for (let k = 0; k < 0.42 * TAXA; k++) {
      const s = k / TAXA;
      const f = 45 + 110 * Math.exp(-s * 28);
      fase += (2 * Math.PI * f) / TAXA;
      const clique = k < 60 ? ruido() * 0.3 * (1 - k / 60) : 0;
      somar(bateria, i0 + k, (Math.sin(fase) * Math.exp(-s * 8) + clique) * 0.75 * vol);
    }
  };
  const palma = (t, vol = 1) => {
    const i0 = Math.round(t * TAXA);
    let pb = 0;
    let anterior = 0;
    const a = umPolo(1400);
    for (let k = 0; k < 0.3 * TAXA; k++) {
      const s = k / TAXA;
      // Três batidas rápidas e a cauda: o jeito de uma palma.
      const env = Math.max(Math.exp(-s * 30), s > 0.012 ? Math.exp(-(s - 0.012) * 30) : 0, s > 0.024 ? Math.exp(-(s - 0.024) * 13) : 0);
      const x = ruido();
      pb += a * (x - pb);
      const passaAlta = x - pb;
      const corpo = Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s * 40) * 0.4;
      anterior = (passaAlta * 0.8 + corpo) * env;
      somar(bateria, i0 + k, anterior * 0.5 * vol, (aleatorio() - 0.5) * 0.1);
    }
  };
  const chimbal = (t, aberto = false, vol = 1, pan = 0.25) => {
    const i0 = Math.round(t * TAXA);
    const dur = aberto ? 0.22 : 0.05;
    let pb = 0;
    const a = umPolo(7000);
    for (let k = 0; k < dur * TAXA; k++) {
      const s = k / TAXA;
      const x = ruido();
      pb += a * (x - pb);
      somar(bateria, i0 + k, (x - pb) * Math.exp(-s * (aberto ? 14 : 70)) * 0.32 * vol, pan);
    }
  };

  // ---------- Instrumentos ----------
  const nota = (bus, t, midi, dur, { timbre = "serra", vol = 0.2, corte = 1500, ataque = 0.005, pan = 0, envCorte = 0, desafinar = 0 }) => {
    const i0 = Math.round(t * TAXA);
    const f = hz(midi);
    let fase1 = aleatorio();
    let fase2 = aleatorio();
    let lp1 = 0;
    let lp2 = 0;
    const total = Math.round((dur + 0.25) * TAXA);
    for (let k = 0; k < total; k++) {
      const s = k / TAXA;
      const env = Math.min(1, s / ataque) * (s < dur ? 1 : Math.exp(-(s - dur) * 18));
      fase1 = (fase1 + f / TAXA) % 1;
      fase2 = (fase2 + (f * (1 + desafinar)) / TAXA) % 1;
      let x;
      if (timbre === "seno") x = Math.sin(2 * Math.PI * fase1);
      else if (timbre === "rhodes") x = Math.sin(2 * Math.PI * fase1 + 0.8 * Math.sin(2 * Math.PI * fase1 * 2) * Math.exp(-s * 6)) * (1 + 0.15 * Math.sin(2 * Math.PI * 5 * s));
      else x = (2 * fase1 - 1 + (desafinar ? 2 * fase2 - 1 : 0)) * (desafinar ? 0.5 : 1);
      const fc = corte * (1 + envCorte * Math.exp(-s * 12));
      const a = umPolo(Math.min(fc, 16000));
      lp1 += a * (x - lp1);
      lp2 += a * (lp1 - lp2);
      somar(bus, i0 + k, lp2 * env * vol, pan);
    }
  };
  const baixo808 = (t, midi, dur, vol = 0.6) => {
    const i0 = Math.round(t * TAXA);
    let fase = 0;
    const f = hz(midi);
    for (let k = 0; k < (dur + 0.1) * TAXA; k++) {
      const s = k / TAXA;
      const freq = f * (1 + 0.6 * Math.exp(-s * 30));
      fase += (2 * Math.PI * freq) / TAXA;
      const env = Math.min(1, s / 0.004) * Math.exp(-s * 1.6) * (s < dur ? 1 : Math.exp(-(s - dur) * 25));
      somar(musica, i0 + k, Math.tanh(Math.sin(fase) * 1.8) * env * vol);
    }
  };

  // ---------- Sequência ----------
  const compassos = Math.ceil(duracao / compasso) + 1;
  const sorteiaArpejo = Math.floor(aleatorio() * 3);
  for (let b = 0; b < compassos; b++) {
    const t0 = b * compasso;
    const ac = c.acordes[b % c.acordes.length].map((x) => x + tonica);
    const raizBaixo = tonica - 24 + c.baixo[b % c.baixo.length];
    // Acordes de fundo (pad) com duas serras levemente desafinadas, um lado em cada canal.
    if (c.arpejo !== "acordes") {
      ac.forEach((m, j) => nota(musica, t0, m, compasso, { timbre: "serra", vol: 0.075, corte: c.corteAcordes, ataque: 0.25, pan: j % 2 ? 0.5 : -0.5, desafinar: 0.006 }));
    }
    for (let p = 0; p < 16; p++) {
      const t = t0 + p * passo + (c.chimbal === "8swing" && p % 4 === 2 ? passo * 0.18 : 0);
      if (c.bumbo.includes(p)) bumbo(t, p === 0 ? 1 : 0.85);
      if (c.palma.includes(p)) palma(t);
      if (c.chimbalAberto.includes(p)) chimbal(t, true, 0.8);
      if (c.chimbal === "16") chimbal(t, false, p % 2 ? 0.9 : 0.45);
      if (c.chimbal === "8swing" && p % 2 === 0) chimbal(t, false, p % 4 ? 0.9 : 0.5, -0.2);
      if (c.chimbal === "chocalho") chimbal(t, false, p % 2 ? 0.55 : 0.3, 0.35);
      if (c.chimbal === "trap") {
        chimbal(t, false, p % 2 ? 0.6 : 0.9);
        // Rufada de chimbal no fim de compassos alternados, como no trap.
        if (p >= 12 && b % 2 === 1) chimbal(t + passo / 2, false, 0.6);
      }
      if (c.linhaBaixo.includes(p)) {
        const oitava = c.timbreBaixo === "serra" && c.linhaBaixo.length > 4 && p % 8 === 6 ? 12 : 0;
        if (c.timbreBaixo === "808") baixo808(t, raizBaixo, passo * (p === 0 ? 6 : 3));
        else if (c.timbreBaixo === "redondo") nota(musica, t, raizBaixo + 12, passo * 7, { timbre: "seno", vol: 0.32 });
        else nota(musica, t, raizBaixo + 12 + oitava, passo * 1.6, { timbre: "serra", vol: 0.24, corte: 520, envCorte: 2.5 });
      }
      // Arpejo / acordes picados por cima.
      const tons = [...ac, ...ac.map((m) => m + 12)];
      if (c.arpejo === "16") {
        const ordem = [[0, 1, 2, 3], [0, 2, 1, 3], [3, 2, 1, 0]][sorteiaArpejo];
        nota(musica, t, tons[ordem[p % 4] + (p >= 8 ? 1 : 0)] + 12, passo * 0.7, { vol: 0.11, corte: 1100, envCorte: 4, pan: p % 2 ? 0.35 : -0.35 });
      } else if (c.arpejo === "8" && p % 2 === 0) {
        nota(musica, t, tons[(p / 2) % tons.length] + 12, passo * 1.5, { timbre: "rhodes", vol: 0.12, pan: p % 4 ? 0.3 : -0.3 });
      } else if (c.arpejo === "esparso" && [0, 6, 12].includes(p)) {
        nota(musica, t, tons[[0, 2, 1][p / 6]] + 12, passo * 3, { timbre: "rhodes", vol: 0.11, pan: (p / 6 - 1) * 0.4 });
      } else if (c.arpejo === "acordes" && [2, 7, 10, 15].includes(p)) {
        ac.forEach((m, j) => nota(musica, t, m + 12, passo * 0.9, { timbre: "rhodes", vol: 0.06, pan: j % 2 ? 0.3 : -0.3 }));
      }
    }
  }

  // ---------- Efeitos da edição ----------
  const impacto = (t, vol = 1) => {
    const i0 = Math.round(t * TAXA);
    let fase = 0;
    let pb = 0;
    const a = umPolo(5000);
    for (let k = 0; k < 1.6 * TAXA; k++) {
      const s = k / TAXA;
      fase += (2 * Math.PI * (32 + 40 * Math.exp(-s * 8))) / TAXA;
      const grave = Math.sin(fase) * Math.exp(-s * 2.6);
      const x = ruido();
      pb += a * (x - pb);
      const prato = (x - pb) * Math.exp(-s * 3.2) * 0.35;
      const estalo = ruido() * Math.exp(-s * 40) * 0.5;
      somar(efeitos, i0 + k, (grave * 0.9 + prato + estalo) * vol, (aleatorio() - 0.5) * 0.2);
    }
  };
  const whoosh = (corte, vol = 0.5) => {
    const dur = 0.5;
    const i0 = Math.round((corte - dur * 0.7) * TAXA);
    let lp = 0;
    let lp2 = 0;
    for (let k = 0; k < dur * TAXA; k++) {
      const s = k / TAXA;
      const p = s / dur;
      const fc = 300 + 5500 * Math.sin(Math.PI * Math.min(1, p * 1.1)) ** 2;
      const a = umPolo(fc);
      const x = ruido();
      lp += a * (x - lp);
      lp2 += a * (lp - lp2);
      const env = Math.sin(Math.PI * p) ** 2;
      somar(efeitos, i0 + k, lp2 * env * vol * 1.6, p * 1.6 - 0.8);
    }
  };
  const subida = (inicio, fim, vol = 0.35) => {
    const i0 = Math.round(inicio * TAXA);
    const dur = fim - inicio;
    let fase = 0;
    let pb = 0;
    for (let k = 0; k < dur * TAXA; k++) {
      const s = k / TAXA;
      const p = s / dur;
      fase += (2 * Math.PI * (180 + 900 * p * p)) / TAXA;
      const x = ruido();
      pb += umPolo(600 + 6000 * p) * (x - pb);
      somar(efeitos, i0 + k, (pb * 0.8 + Math.sin(fase) * 0.25) * p * p * vol);
    }
  };

  impacto(0, 0.9);
  cortes.slice(1).forEach((t, j) => (j === cortes.length - 2 ? null : whoosh(t)));
  const ultimaCena = cortes.at(-1);
  if (cortes.length > 2 && ultimaCena > 1.5) {
    subida(ultimaCena - 1.3, ultimaCena);
    impacto(ultimaCena, 0.7);
  }

  // ---------- Mixagem ----------
  // A música abaixa um pouco a cada bumbo (o "respiro" das músicas eletrônicas).
  const respiro = new Float32Array(n).fill(1);
  for (const t of bumbos) {
    const i0 = Math.round(t * TAXA);
    for (let k = 0; k < 0.25 * TAXA && i0 + k < n; k++) respiro[i0 + k] = Math.min(respiro[i0 + k], 1 - 0.55 * Math.exp(-k / TAXA / 0.07));
  }
  const esquerda = new Float32Array(n);
  const direita = new Float32Array(n);
  const fadeOut = Math.round(0.9 * TAXA);
  let pico = 0;
  for (let i = 0; i < n; i++) {
    const fim = i > n - fadeOut ? (n - i) / fadeOut : 1;
    const l = Math.tanh((bateria[0][i] + musica[0][i] * respiro[i] + efeitos[0][i]) * 1.1) * fim;
    const r = Math.tanh((bateria[1][i] + musica[1][i] * respiro[i] + efeitos[1][i]) * 1.1) * fim;
    esquerda[i] = l;
    direita[i] = r;
    pico = Math.max(pico, Math.abs(l), Math.abs(r));
  }
  const ganho = pico > 0 ? 0.89 / pico : 1;
  for (let i = 0; i < n; i++) {
    esquerda[i] *= ganho;
    direita[i] *= ganho;
  }
  return { esquerda, direita, bpm };
}

/** WAV de 16 bits a partir de canais Float32 (1 = mono, 2 = estéreo). */
export function wav(canais, taxa = TAXA) {
  const n = canais[0].length;
  const buf = Buffer.alloc(44 + n * canais.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * canais.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(canais.length, 22);
  buf.writeUInt32LE(taxa, 24);
  buf.writeUInt32LE(taxa * canais.length * 2, 28);
  buf.writeUInt16LE(canais.length * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * canais.length * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const canal of canais) {
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, canal[i])) * 32767), o);
      o += 2;
    }
  }
  return buf;
}
