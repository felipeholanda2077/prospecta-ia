import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Fotos reais para os posts. A IA descreve a cena de cada tela (`busca_imagem`, em inglês) e o sistema
// procura: no Pexels, quando há chave (fotos profissionais, sem exigir crédito), ou no Wikimedia Commons
// (grátis e sem chave, só com licença que permite o uso, e o crédito vai na legenda).
const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);
const AGENTE = "ProspectaIA/1.0 (https://prospecta-ia-three.vercel.app)";
const TEMPO_MS = 10_000;
const MAX_FOTOS = 5;
// Fotos antigas saem do banco: as dos posts publicados já estão no Instagram.
const DIAS_GUARDANDO = 30;

const chaveEnv = () => process.env.PEXELS_API_KEY || "";
export const lerChavePexels = async () => chaveEnv() || (await db.lerConfig("fotos"))?.pexels || "";
export const salvarChavePexels = (chave) => db.gravarConfig("fotos", { pexels: String(chave ?? "").trim() });

async function buscarNoPexels(busca, chave, orientacao) {
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", busca);
  url.searchParams.set("per_page", "6");
  url.searchParams.set("orientation", orientacao);
  const r = await fetch(url, { headers: { Authorization: chave }, signal: AbortSignal.timeout(TEMPO_MS) });
  if (!r.ok) throw new Error(`o Pexels respondeu ${r.status}`);
  const { photos = [] } = await r.json();
  return photos.map((f) => ({ url: f.src?.large2x ?? f.src?.large, credito: null, fonte: "Pexels" })).filter((f) => f.url);
}

// Só licenças que permitem usar em post comercial sem compartilhar o resultado igual.
const LICENCA_LIVRE = /^(cc0|public domain|pd\b|cc by \d)/i;
const textoLimpo = (t) => String(t ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

async function buscarNoCommons(busca) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  for (const [k, v] of Object.entries({
    action: "query", format: "json", generator: "search", gsrsearch: `${busca} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "12",
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1200",
  })) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "User-Agent": AGENTE }, signal: AbortSignal.timeout(TEMPO_MS) });
  if (!r.ok) throw new Error(`o Wikimedia respondeu ${r.status}`);
  const paginas = Object.values((await r.json()).query?.pages ?? {}).sort((a, b) => a.index - b.index);
  return paginas.flatMap((p) => {
    const i = p.imageinfo?.[0];
    const licenca = textoLimpo(i?.extmetadata?.LicenseShortName?.value);
    if (!i?.thumburl || i.mime !== "image/jpeg" || i.width < 1000 || !LICENCA_LIVRE.test(licenca)) return [];
    const autor = textoLimpo(i.extmetadata?.Artist?.value).slice(0, 60);
    const precisaCredito = !/^(cc0|public domain|pd\b)/i.test(licenca);
    return [{ url: i.thumburl, credito: precisaCredito ? `${autor || "Autor no Wikimedia Commons"} (${licenca}, via Wikimedia Commons)` : null, fonte: "Wikimedia Commons" }];
  });
}

/** Baixa e recorta a foto no tamanho do post, para o banco guardar pouco. Retorna JPEG. */
async function prepararFoto(url, largura, altura) {
  const r = await fetch(url, { headers: { "User-Agent": AGENTE }, signal: AbortSignal.timeout(TEMPO_MS) });
  if (!r.ok) throw new Error(`a foto respondeu ${r.status}`);
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(Buffer.from(await r.arrayBuffer()));
  const c = createCanvas(largura, altura);
  const e = Math.max(largura / img.width, altura / img.height);
  c.getContext("2d").drawImage(img, (largura - img.width * e) / 2, (altura - img.height * e) / 2, img.width * e, img.height * e);
  return c.encode("jpeg", 78);
}

/**
 * Coloca fotos reais nas telas do post (`foto: { chave, credito }`). Se uma busca não achar nada, a tela
 * fica sem foto e o post sai igual. O crédito exigido pela licença entra no fim da legenda. Retorna o conteúdo.
 */
export async function colocarFotos(conteudo, { formato, dia, buscar = null, preparar = prepararFoto } = {}) {
  const pedidos = (conteudo.slides ?? []).map((s, i) => ({ i, busca: String(s.busca_imagem ?? "").trim() })).filter((p) => p.busca).slice(0, MAX_FOTOS);
  if (!pedidos.length) return conteudo;
  const chave = await lerChavePexels();
  const procurar = buscar ?? ((busca) => (chave ? buscarNoPexels(busca, chave, "portrait") : buscarNoCommons(busca)));
  const [largura, altura] = formato === "reels" ? [1080, 1920] : [1080, 1350];
  const usadas = new Set();
  const slides = conteudo.slides.map((s) => ({ ...s }));
  const creditos = [];
  await Promise.all(pedidos.map(async ({ i, busca }) => {
    try {
      const achadas = await procurar(busca);
      const foto = achadas.find((f) => !usadas.has(f.url));
      if (!foto) return;
      usadas.add(foto.url);
      const nome = `foto-${dia}-${crypto.randomBytes(5).toString("hex")}.jpg`;
      await db.gravarMidia(nome, "image/jpeg", await preparar(foto.url, largura, altura));
      slides[i].foto = { chave: nome, fonte: foto.fonte };
      if (foto.credito) creditos.push(foto.credito);
    } catch (e) {
      log(`⚠️  Foto não encontrada para "${busca}": ${e.message}`);
    }
  }));
  const creditoNaLegenda = creditos.length ? `\n\nFotos: ${[...new Set(creditos)].join("; ")}.` : "";
  await db.apagarMidiasAntigas("foto-", DIAS_GUARDANDO).catch(() => {});
  return { ...conteudo, slides, legenda: `${conteudo.legenda}${creditoNaLegenda}` };
}
