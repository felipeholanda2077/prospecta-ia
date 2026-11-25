import { unzipSync, strFromU8 } from "fflate";
import * as db from "../db.js";
import * as ml from "../envio/mercadolivre.js";

// Quantas pessoas viram cada produto anunciado. O Mercado Livre entrega as visitas pela API, com a conta já
// conectada no painel. O TikTok Shop não tem conexão com o sistema: os números vêm do arquivo que a própria
// Central do vendedor exporta (Análise → Análise de produtos → Exportar), ou da tabela colada.
const CHAVE_ML = "visualizacoes_ml";
const CHAVE_TIKTOK = "visualizacoes_tiktok";
const DIAS = 30;
const ATUALIZAR_A_CADA_MS = 6 * 3600_000;
const MAX_ANUNCIOS = 1000;
const MAX_ARQUIVO = 600_000;

const dia = (d) => d.toISOString().slice(0, 10);
const pedacos = (lista, n) => Array.from({ length: Math.ceil(lista.length / n) }, (_, i) => lista.slice(i * n, i * n + n));

/** Roda `fazer` em cada item, no máximo `n` por vez. */
async function emParalelo(lista, n, fazer) {
  const saida = new Array(lista.length);
  let proximo = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
    while (proximo < lista.length) {
      const i = proximo++;
      saida[i] = await fazer(lista[i], i);
    }
  }));
  return saida;
}

/** Os IDs dos anúncios ativos e pausados da conta. Os encerrados ficam de fora. */
async function idsDosAnuncios(conta, agora) {
  const ids = [];
  for (const status of ["active", "paused"]) {
    for (let offset = 0; offset < MAX_ANUNCIOS; offset += 100) {
      const r = await ml.consultar(conta, `/users/${encodeURIComponent(conta)}/items/search?status=${status}&limit=100&offset=${offset}`, agora);
      ids.push(...(r.results ?? []));
      if (!r.results?.length || offset + 100 >= (r.paging?.total ?? 0)) break;
    }
  }
  return [...new Set(ids)];
}

/** Título, preço, status, foto e vendas de cada anúncio, 20 por chamada. */
async function dadosDosAnuncios(conta, ids, agora) {
  const campos = "id,title,price,status,permalink,thumbnail,secure_thumbnail,sold_quantity,available_quantity";
  const lotes = await emParalelo(pedacos(ids, 20), 3, (lote) => ml.consultar(conta, `/items?ids=${lote.map(encodeURIComponent).join(",")}&attributes=${campos}`, agora));
  return lotes.flat().filter((x) => x?.code === 200 && x.body?.id).map((x) => x.body);
}

/** Visitas de toda a vida de cada anúncio (o ML guarda dois anos), 50 por chamada. */
async function visitasTotais(conta, ids, agora) {
  const total = {};
  for (const lote of pedacos(ids, 50)) {
    const r = await ml.consultar(conta, `/visits/items?ids=${lote.map(encodeURIComponent).join(",")}`, agora).catch(() => ({}));
    for (const [id, n] of Object.entries(r ?? {})) if (Number.isFinite(Number(n))) total[id] = Number(n);
  }
  return total;
}

/** Visitas de um anúncio no período. A API responde um objeto, ou uma lista quando recebe vários IDs. */
async function visitasNoPeriodo(conta, id, de, ate, agora) {
  const r = await ml.consultar(conta, `/items/visits?ids=${encodeURIComponent(id)}&date_from=${de}&date_to=${ate}`, agora);
  const achado = Array.isArray(r) ? r.find((x) => x?.item_id === id) ?? r[0] : r;
  return Number(achado?.total_visits ?? 0);
}

/** Busca os anúncios de todas as contas do Mercado Livre com as visitas, e guarda o retrato. */
export async function atualizarVisitasDoMercadoLivre({ agora = new Date(), dias = DIAS } = {}) {
  const { contas } = await ml.statusDaConexao();
  if (!contas.length) throw new Error("Conecte uma conta do Mercado Livre na aba Contas para ver as visitas.");
  const de = dia(new Date(+agora - dias * 86_400_000));
  const ate = dia(agora);
  const itens = [];
  const erros = [];
  for (const c of contas) {
    try {
      const ids = await idsDosAnuncios(c.id, agora);
      const [dados, totais] = await Promise.all([dadosDosAnuncios(c.id, ids, agora), visitasTotais(c.id, ids, agora)]);
      const periodo = await emParalelo(dados, 5, (d) => visitasNoPeriodo(c.id, d.id, de, ate, agora).catch(() => null));
      dados.forEach((d, i) => itens.push({
        id: d.id, conta: c.id, loja: c.apelido ?? c.id, titulo: d.title ?? "", preco: d.price ?? null, status: d.status ?? null,
        link: d.permalink ?? null, foto: d.secure_thumbnail ?? d.thumbnail ?? null, vendidos: d.sold_quantity ?? 0, estoque: d.available_quantity ?? null,
        visitasPeriodo: periodo[i], visitasTotal: totais[d.id] ?? null,
      }));
    } catch (e) {
      erros.push(`${c.apelido ?? c.id}: ${e.message}`);
    }
  }
  itens.sort((a, b) => (b.visitasPeriodo ?? -1) - (a.visitasPeriodo ?? -1) || (b.visitasTotal ?? -1) - (a.visitasTotal ?? -1) || b.vendidos - a.vendidos);
  const retrato = { atualizadoEm: agora.toISOString(), dias, de, ate, itens, erros };
  // Se nada veio e já havia um retrato bom, mantém o anterior e só mostra o erro.
  if (!itens.length && erros.length) {
    const anterior = await db.lerConfig(CHAVE_ML);
    if (anterior?.itens?.length) {
      await db.gravarConfig(CHAVE_ML, { ...anterior, erros });
      throw new Error(erros.join(" · "));
    }
  }
  await db.gravarConfig(CHAVE_ML, retrato);
  return retrato;
}

/** Na rodada do Mercado Livre: refaz o retrato quando ele passou de 6 horas. Uma execução por vez. */
export async function atualizarSeVelho({ agora = new Date() } = {}) {
  const atual = await db.lerConfig(CHAVE_ML);
  if (atual && agora - new Date(atual.atualizadoEm) < ATUALIZAR_A_CADA_MS) return { visitas: "em dia" };
  if (!(await ml.statusDaConexao()).contas.length) return { visitas: "sem conta" };
  if (!(await db.travar("visualizacoes_ml", 5 * 60_000))) return { visitas: "outra execução" };
  const r = await atualizarVisitasDoMercadoLivre({ agora });
  return { visitas: `${r.itens.length} anúncios` };
}

// ---------- TikTok Shop: o arquivo exportado ----------

/** O número escrito do jeito brasileiro ("1.234", "R$ 1.234,56", "12,5%") ou do americano ("1,234.56"). */
export function numero(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v ?? "").replace(/[^\d.,-]/g, "");
  if (!/\d/.test(s)) return null;
  const virgula = s.lastIndexOf(",");
  const ponto = s.lastIndexOf(".");
  if (virgula > ponto) s = s.replace(/\./g, "").replace(",", ".");
  else if (ponto > virgula && virgula >= 0) s = s.replace(/,/g, "");
  else if (ponto >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** CSV ou tabela colada (tabulação, ponto e vírgula ou vírgula), com aspas. */
export function lerTexto(texto) {
  const linhas = String(texto ?? "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) return [];
  const amostra = linhas.slice(0, 5).join("\n");
  const sep = amostra.includes("\t") ? "\t" : (amostra.match(/;/g)?.length ?? 0) >= (amostra.match(/,/g)?.length ?? 0) ? ";" : ",";
  return linhas.map((linha) => {
    const celulas = [];
    let atual = "";
    let aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const ch = linha[i];
      if (aspas) {
        if (ch === '"' && linha[i + 1] === '"') { atual += '"'; i++; } else if (ch === '"') aspas = false; else atual += ch;
      } else if (ch === '"') aspas = true;
      else if (ch === sep) { celulas.push(atual.trim()); atual = ""; } else atual += ch;
    }
    celulas.push(atual.trim());
    return celulas;
  });
}

const desescapar = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const textoDosT = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1])).join("");
const coluna = (ref) => [...ref.replace(/\d+/g, "")].reduce((n, l) => n * 26 + l.charCodeAt(0) - 64, 0) - 1;

/** A primeira planilha de um .xlsx, como lista de linhas. */
export function lerXlsx(bytes) {
  const arquivos = unzipSync(bytes, { filter: (f) => /^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)$/.test(f.name) });
  const compartilhados = arquivos["xl/sharedStrings.xml"] ? [...strFromU8(arquivos["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDosT(m[1])) : [];
  const nomes = Object.keys(arquivos).filter((n) => /worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!nomes.length) throw new Error("A planilha veio vazia.");
  const xml = strFromU8(arquivos[nomes[0]]);
  const linhas = [];
  for (const [, corpo] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const linha = [];
    for (const m of corpo.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1];
      const conteudo = m[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const tipo = attrs.match(/\bt="(\w+)"/)?.[1];
      const v = conteudo.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const valor = tipo === "s" ? compartilhados[Number(v)] ?? "" : tipo === "inlineStr" ? textoDosT(conteudo) : tipo === "str" || tipo === "b" ? desescapar(v ?? "") : v != null ? Number(v) : "";
      linha[ref ? coluna(ref) : linha.length] = valor;
    }
    linhas.push(Array.from(linha, (x) => x ?? ""));
  }
  return linhas;
}

// Cada coluna que interessa, pelo nome do cabeçalho do TikTok (em português ou inglês). A ordem conta: o primeiro
// que casa vence, por isso "visualizações da página" vem antes de "cliques".
const COLUNAS = {
  nome: [/^nome do produto$/i, /^produto$/i, /^product( name)?$/i, /nome do produto/i, /^produto\b/i, /product name/i],
  id: [/^id do produto$/i, /^product id$/i, /^id$/i, /\bid do produto\b/i, /product id/i],
  impressoes: [/impress[õo]es do produto/i, /product impressions/i, /impress/i],
  visualizacoes: [/visualiza[çc][õo]es da p[áa]gina/i, /page views/i, /visualiza[çc][õo]es/i, /cliques no produto/i, /product clicks/i, /cliques/i, /clicks/i],
  clientes: [/clientes estimados/i, /visitantes/i, /visitors/i],
  vendidos: [/itens vendidos/i, /unidades vendidas/i, /items sold/i, /units sold/i],
  pedidos: [/^pedidos/i, /orders/i],
  gmv: [/^gmv$/i, /^gmv\b(?!.*atribu)/i],
};
const METRICAS = ["impressoes", "visualizacoes", "clientes", "vendidos", "pedidos", "gmv"];

function mapearCabecalho(celulas) {
  const textos = celulas.map((c) => String(c ?? "").trim());
  const achado = {};
  const usadas = new Set();
  for (const [campo, padroes] of Object.entries(COLUNAS)) {
    for (const p of padroes) {
      const i = textos.findIndex((t, j) => t && !usadas.has(j) && p.test(t));
      if (i >= 0) { achado[campo] = i; usadas.add(i); break; }
    }
  }
  return achado;
}

/** Acha o cabeçalho (pode haver linhas de título antes) e lê um produto por linha. */
export function produtosDaTabela(linhas) {
  for (let h = 0; h < Math.min(linhas.length, 15); h++) {
    const mapa = mapearCabecalho(linhas[h]);
    if (mapa.nome == null && mapa.id == null) continue;
    if (!METRICAS.some((m) => mapa[m] != null)) continue;
    const itens = [];
    for (const linha of linhas.slice(h + 1)) {
      const nome = mapa.nome != null ? String(linha[mapa.nome] ?? "").trim() : "";
      const id = mapa.id != null ? String(linha[mapa.id] ?? "").trim() : "";
      if (!nome && !id) continue;
      if (/^(total|soma|sum)\b/i.test(nome)) continue;
      const item = { id: id || null, nome: nome || id };
      for (const m of METRICAS) item[m] = mapa[m] != null ? numero(linha[mapa[m]]) : null;
      itens.push(item);
    }
    return { itens, colunas: METRICAS.filter((m) => mapa[m] != null) };
  }
  throw new Error("Não achei as colunas do produto e das visualizações. Exporte em Análise → Análise de produtos → Detalhes → Exportar, ou cole a tabela com o cabeçalho.");
}

/** Junta linhas do mesmo produto (o arquivo por SKU repete o produto em cada variação). */
function juntarPorProduto(itens) {
  const porChave = new Map();
  for (const x of itens) {
    const chave = x.id || x.nome.toLowerCase();
    const atual = porChave.get(chave);
    if (!atual) { porChave.set(chave, { ...x }); continue; }
    for (const m of METRICAS) if (x[m] != null) atual[m] = (atual[m] ?? 0) + x[m];
  }
  return [...porChave.values()];
}

const pontuacao = (x) => [x.visualizacoes, x.impressoes, x.clientes, x.vendidos].map((n) => n ?? -1);

/** Lê o arquivo (base64 de .xlsx ou .csv) ou o texto colado do TikTok Shop, e guarda o retrato. */
export async function importarTiktok({ arquivo, nome = "", texto, periodo = "" } = {}, { agora = new Date() } = {}) {
  let linhas;
  if (arquivo) {
    const bytes = Buffer.from(String(arquivo).replace(/^data:[^,]*,/, ""), "base64");
    if (!bytes.length) throw new Error("O arquivo veio vazio.");
    if (bytes.length > MAX_ARQUIVO) throw new Error("Arquivo grande demais. Exporte só a lista de produtos.");
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (!zip && /\.xls$/i.test(nome)) throw new Error("O formato .xls antigo não é aceito. Exporte em .xlsx ou .csv.");
    linhas = zip ? lerXlsx(new Uint8Array(bytes)) : lerTexto(bytes.toString("utf8"));
  } else if (texto && String(texto).trim()) {
    linhas = lerTexto(String(texto).slice(0, MAX_ARQUIVO));
  } else {
    throw new Error("Envie o arquivo exportado do TikTok Shop ou cole a tabela.");
  }
  const { itens, colunas } = produtosDaTabela(linhas);
  if (!itens.length) throw new Error("A tabela não tem nenhum produto.");
  const juntos = juntarPorProduto(itens).sort((a, b) => {
    const [pa, pb] = [pontuacao(a), pontuacao(b)];
    for (let i = 0; i < pa.length; i++) if (pb[i] !== pa[i]) return pb[i] - pa[i];
    return 0;
  });
  const retrato = { importadoEm: agora.toISOString(), arquivo: String(nome || "").slice(0, 120) || null, periodo: String(periodo || "").slice(0, 60) || null, colunas, itens: juntos.slice(0, 500) };
  await db.gravarConfig(CHAVE_TIKTOK, retrato);
  return retrato;
}

/** O que a aba "Mais vistos" mostra. */
export async function painelDeVisualizacoes() {
  const [mercadoLivre, tiktok, conexao] = await Promise.all([db.lerConfig(CHAVE_ML), db.lerConfig(CHAVE_TIKTOK), ml.statusDaConexao()]);
  return { mercadoLivre, tiktok, mlConectado: conexao.contas.length > 0 };
}
