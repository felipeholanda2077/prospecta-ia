import * as db from "../db.js";
import { cifrar, decifrar } from "../segredos.js";

// Fish Audio: a voz de IA das mensagens em áudio. A chave de API é colada no painel e fica cifrada no banco.
// Em "teste" ela só gera os áudios de teste do painel (homologação); em "producao" ela gera os áudios enviados,
// e se falhar eles continuam saindo pela voz de antes (Runway e as vozes de reserva).
const API = "https://api.fish.audio";
const CHAVE_CONFIG = "fishaudio";
const CHAVE_TESTES = "fishaudio_testes";
const PREFIXO_TESTE = "audio-teste-fish-";
const MAX_TESTES = 6;
export const MAX_TEXTO_TESTE = 1000;

/** Os modelos de voz da Fish Audio; o primeiro é o padrão. */
export const MODELOS = [
  { id: "s2.1-pro", nome: "S2.1 Pro (mais natural)" },
  { id: "s2-pro", nome: "S2 Pro" },
  { id: "s1", nome: "S1" },
  { id: "s2.1-pro-free", nome: "S2.1 Pro grátis (plano de desenvolvedor)" },
];
export const MODOS = ["teste", "producao"];

export const CHAVE_TRANCADA = "A chave da Fish Audio guardada não abre mais porque a senha do painel (PAINEL_SENHA) mudou depois que ela foi salva. Cole a chave de novo no cartão Vozes com IA (Fish Audio)";

async function lerGuardado() {
  return (await db.lerConfig(CHAVE_CONFIG)) ?? {};
}

async function requisitar(chave, metodo, caminho, { corpo, cabecalhos = {}, tempoMs = 20_000, binario = false } = {}) {
  const r = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${chave}`, ...(corpo ? { "Content-Type": "application/json" } : {}), ...cabecalhos },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(tempoMs),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const motivo = r.status === 401 ? "a Fish Audio recusou a chave de API"
      : r.status === 402 ? "a conta da Fish Audio está sem crédito"
      : `Fish Audio: ${d.message ?? d.detail ?? `respondeu ${r.status}`}`;
    throw new Error(motivo);
  }
  return binario ? Buffer.from(await r.arrayBuffer()) : r.json();
}

/** A chave aberta, ou lança dizendo o que falta. */
async function chaveAberta() {
  const { chave } = await lerGuardado();
  if (!chave) throw new Error("Cole a chave de API da Fish Audio no cartão Vozes com IA");
  const aberta = decifrar(chave);
  if (!aberta) throw new Error(CHAVE_TRANCADA);
  return aberta;
}

/** O que está salvo, sem a chave. */
export async function situacao() {
  const c = await lerGuardado();
  const abre = Boolean(c.chave && decifrar(c.chave));
  return {
    conectado: abre,
    trancada: Boolean(c.chave) && !abre,
    modo: MODOS.includes(c.modo) ? c.modo : "teste",
    vozId: c.vozId ?? "",
    vozNome: c.vozNome ?? "",
    modelo: MODELOS.some((m) => m.id === c.modelo) ? c.modelo : MODELOS[0].id,
    modelos: MODELOS,
  };
}

/** A Fish Audio gera os áudios enviados? Só em produção, com chave que abre e voz escolhida. */
export async function emProducao() {
  const s = await situacao();
  return s.conectado && s.modo === "producao" && Boolean(s.vozId);
}

/** O saldo da API, em dólar (só lê, não gasta nada). */
export async function creditos(chave) {
  const d = await requisitar(chave ?? (await chaveAberta()), "GET", "/wallet/self/api-credit?check_free_credit=true");
  const valor = Number.parseFloat(d.credit);
  return { valor: Number.isFinite(valor) ? valor : null, creditoGratis: d.has_free_credit ?? null };
}

/**
 * Salva só o que veio. A chave nova é conferida na própria Fish Audio (lendo o saldo) antes de ser guardada;
 * a chave vazia mantém a que já estava salva. Retorna a situação ou { erro }.
 */
export async function salvar({ chave, modo, vozId, vozNome, modelo } = {}) {
  const atual = await lerGuardado();
  const texto = String(chave ?? "").trim();
  const novo = { ...atual };
  if (texto) {
    try {
      await creditos(texto);
    } catch (e) {
      return { erro: e.message };
    }
    novo.chave = cifrar(texto);
  }
  if (MODOS.includes(modo)) novo.modo = modo;
  if (vozId !== undefined) {
    novo.vozId = String(vozId ?? "").trim().slice(0, 64);
    novo.vozNome = String(vozNome ?? "").trim().slice(0, 120);
  }
  if (MODELOS.some((m) => m.id === modelo)) novo.modelo = modelo;
  if (novo.modo === "producao" && !novo.vozId) return { erro: "Escolha a voz antes de ligar a Fish Audio nos áudios enviados" };
  await db.gravarConfig(CHAVE_CONFIG, novo);
  return situacao();
}

/** Tira a chave e volta para teste: os áudios enviados voltam para a voz de antes. */
export async function desconectar() {
  const { vozId, vozNome, modelo } = await lerGuardado();
  await db.gravarConfig(CHAVE_CONFIG, { vozId, vozNome, modelo, modo: "teste" });
  return situacao();
}

const vozDaLista = (m) => ({
  id: m._id, nome: m.title, idiomas: m.languages ?? [], autor: m.author?.nickname ?? "",
  usos: m.task_count ?? 0, amostra: m.samples?.[0]?.audio ?? null, propria: false,
});

/** As vozes em português da biblioteca da Fish Audio (as mais usadas), e as da sua conta primeiro. */
export async function vozes({ busca = "" } = {}) {
  const chave = await chaveAberta();
  const filtro = busca ? `&title=${encodeURIComponent(String(busca).slice(0, 60))}` : "";
  const [minhas, publicas] = await Promise.all([
    requisitar(chave, "GET", `/model?self=true&page_size=50${filtro}`).catch(() => ({ items: [] })),
    requisitar(chave, "GET", `/model?language=pt&sort_by=task_count&page_size=40${filtro}`),
  ]);
  const proprias = (minhas.items ?? []).map((m) => ({ ...vozDaLista(m), propria: true }));
  const ids = new Set(proprias.map((v) => v.id));
  return [...proprias, ...(publicas.items ?? []).map(vozDaLista).filter((v) => !ids.has(v.id))];
}

/** Um texto falado pela Fish Audio, em MP3. Sem voz informada, usa a salva. */
export async function falar(texto, { vozId, modelo } = {}) {
  const chave = await chaveAberta();
  const s = await situacao();
  const voz = String(vozId || s.vozId || "").trim();
  if (!voz) throw new Error("Escolha a voz da Fish Audio");
  const corpo = { text: String(texto), reference_id: voz, format: "mp3", mp3_bitrate: 128, normalize: true, latency: "normal" };
  const audio = await requisitar(chave, "POST", "/v1/tts", {
    corpo, cabecalhos: { model: MODELOS.some((m) => m.id === modelo) ? modelo : s.modelo }, tempoMs: 90_000, binario: true,
  });
  if (!audio.length) throw new Error("a Fish Audio não devolveu áudio");
  return audio;
}

// ---------- Homologação: áudios de teste, que tocam no painel e não vão para ninguém ----------

/** Os últimos áudios de teste (os arquivos somem do banco depois de 3 dias). */
export async function testes() {
  const lista = (await db.lerConfig(CHAVE_TESTES)) ?? [];
  const existem = new Set(await db.chavesDeMidia(PREFIXO_TESTE));
  return lista.filter((t) => existem.has(t.chave));
}

/** Gera um áudio de teste, guarda entre os últimos e devolve { teste, dados }. */
export async function gerarTeste({ texto, vozId, vozNome, modelo } = {}) {
  const limpo = String(texto ?? "").trim();
  if (!limpo) throw new Error("Escreva o texto do áudio de teste");
  if (limpo.length > MAX_TEXTO_TESTE) throw new Error(`O texto de teste vai até ${MAX_TEXTO_TESTE} caracteres`);
  const s = await situacao();
  const voz = String(vozId || s.vozId || "").trim();
  const mod = MODELOS.some((m) => m.id === modelo) ? modelo : s.modelo;
  const dados = await falar(limpo, { vozId: voz, modelo: mod });
  const teste = {
    chave: `${PREFIXO_TESTE}${Date.now()}.mp3`, texto: limpo.slice(0, 200), vozId: voz,
    vozNome: String(vozNome ?? "").slice(0, 120) || (voz === s.vozId ? s.vozNome : ""), modelo: mod, criadoEm: new Date().toISOString(),
  };
  await db.gravarMidia(teste.chave, "audio/mpeg", dados);
  const anteriores = (await db.lerConfig(CHAVE_TESTES)) ?? [];
  const ficam = [teste, ...anteriores].slice(0, MAX_TESTES);
  for (const velho of anteriores.slice(MAX_TESTES - 1)) await db.apagarMidias(velho.chave);
  await db.gravarConfig(CHAVE_TESTES, ficam);
  return { teste, dados };
}

export async function audioDoTeste(chave) {
  if (!String(chave).startsWith(PREFIXO_TESTE)) return null;
  return db.lerMidia(chave);
}
