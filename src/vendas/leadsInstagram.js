import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "../db.js";

// Leads prospectados à mão pelo direct do Instagram (@ascenddigitaloficial), registrados em
// config/leads-instagram.json. A sincronização grava cada um no banco como um lead de origem "instagram",
// com as mensagens que mandamos (mensagens, canal instagram, já enviadas) e as respostas dela (respostas,
// já classificadas). Assim entram no funil da tela Respostas e nas métricas como qualquer outro lead.
// Cada evento tem um id fixo no arquivo: rodar de novo só acrescenta o que é novo e atualiza status e notas.

const ARQUIVO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "leads-instagram.json");
const CHAVE_VERSAO = "leads_instagram:versao";
const STATUS = new Set(["contatado", "respondeu", "agendado", "fechado", "sem_interesse", "descartado"]);
const CLASSIFICACOES = new Set(["interessado", "quer_informacoes", "sem_interesse", "outro"]);
const TEMPERATURAS = new Set(["quente", "morna", "fria"]);

const arroba = (handle) => String(handle ?? "").trim().replace(/^@/, "").toLowerCase();
const placeId = (handle) => `ig:${arroba(handle)}`;
const idDoEvento = (handle, id) => `ig:${arroba(handle)}:${id}`;

export function lerArquivo(arquivo = ARQUIVO) {
  const texto = fs.readFileSync(arquivo, "utf8");
  return { texto, dados: JSON.parse(texto) };
}

/** Confere um lead do arquivo e devolve a lista de problemas (vazia quando está certo). */
export function validarLead(l) {
  const erros = [];
  if (!arroba(l?.instagram)) erros.push("sem instagram");
  if (!String(l?.nome ?? "").trim()) erros.push("sem nome");
  if (l?.status && !STATUS.has(l.status)) erros.push(`status inválido: ${l.status}`);
  if (l?.temperatura && !TEMPERATURAS.has(l.temperatura)) erros.push(`temperatura inválida: ${l.temperatura}`);
  const ids = new Set();
  for (const e of l?.eventos ?? []) {
    if (!Number.isInteger(e.id)) erros.push("evento sem id");
    else if (ids.has(e.id)) erros.push(`evento repetido: ${e.id}`);
    ids.add(e.id);
    if (!["nos", "lead"].includes(e.autor)) erros.push(`evento ${e.id}: autor inválido`);
    if (Number.isNaN(new Date(e.quando).getTime())) erros.push(`evento ${e.id}: data inválida`);
    if (e.autor === "lead" && e.classificacao && !CLASSIFICACOES.has(e.classificacao)) erros.push(`evento ${e.id}: classificação inválida`);
  }
  return erros;
}

/** O lead já existente: pelo id do Instagram que esta sincronização usa ou pelo @ guardado (ex.: capturado pelo sistema). */
async function acharLead(handle) {
  const [linha] = await db.consultar(
    `SELECT id FROM leads WHERE place_id = $1 OR lower(regexp_replace(coalesce(instagram, ''), '^@', '')) = $2
      ORDER BY (place_id = $1) DESC, id LIMIT 1`,
    [placeId(handle), arroba(handle)]
  );
  return linha?.id ?? null;
}

async function gravarLead(l) {
  const handle = arroba(l.instagram);
  const notas = [l.previa ? `Prévia: https://fluxdeck.com.br/previa/${l.previa}` : "", l.proximo_passo ?? ""].filter(Boolean).join("\n");
  const pais = l.pais && l.pais !== "BR" ? l.pais : null;
  const campos = [l.nome, l.nicho ?? null, l.cidade ?? null, handle, l.status ?? "contatado", notas || null, pais, pais ? (l.idioma ?? "pt") : null];
  let id = await acharLead(handle);
  if (id) {
    await db.consultar(
      `UPDATE leads SET nome = $2, nicho = coalesce($3, nicho), cidade = coalesce($4, cidade), instagram = $5, status = $6,
              observacao = $7, pais = coalesce($8, pais), idioma = coalesce($9, idioma), atualizado_em = now() WHERE id = $1`,
      [id, ...campos]
    );
    return { id, novo: false };
  }
  const [linha] = await db.consultar(
    `INSERT INTO leads (place_id, nome, nicho, cidade, instagram, status, observacao, pais, idioma, origem, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'instagram', $10) RETURNING id`,
    [placeId(handle), ...campos, crypto.randomBytes(16).toString("hex")]
  );
  id = linha.id;
  return { id, novo: true };
}

async function gravarEventos(leadId, l) {
  const handle = arroba(l.instagram);
  let mensagens = 0;
  let respostas = 0;
  const ordenados = [...(l.eventos ?? [])].sort((a, b) => new Date(a.quando) - new Date(b.quando));
  const ultimaDela = ordenados.filter((e) => e.autor === "lead").at(-1);
  let etapa = 0;
  for (const e of ordenados) {
    const origemId = idDoEvento(handle, e.id);
    const quando = new Date(e.quando).toISOString();
    if (e.autor === "nos") {
      etapa += 1;
      const [ja] = await db.consultar("SELECT id FROM mensagens WHERE message_id = $1 LIMIT 1", [origemId]);
      if (ja) continue;
      const tipo = e.tipo === "inicial" ? "inicial" : "resposta";
      await db.consultar(
        `INSERT INTO mensagens (lead_id, canal, destino, corpo, status, tipo, etapa, message_id, enviada_em, criado_em)
         VALUES ($1, 'instagram', $2, $3, 'enviada', $4, $5, $6, $7, $7)`,
        [leadId, `@${handle}`, String(e.texto ?? ""), tipo, tipo === "inicial" ? 1 : Math.min(etapa, 3), origemId, quando]
      );
      mensagens += 1;
    } else {
      const ehUltima = e === ultimaDela;
      const [nova] = await db.consultar(
        `INSERT INTO respostas (lead_id, canal, origem_id, de, texto, classificacao, resumo, lida, temperatura, proximo_passo, recebida_em)
         VALUES ($1, 'instagram', $2, $3, $4, $5, $6, true, $7, $8, $9)
         ON CONFLICT (origem_id) DO UPDATE SET classificacao = EXCLUDED.classificacao, temperatura = EXCLUDED.temperatura,
                                               proximo_passo = EXCLUDED.proximo_passo
         RETURNING (xmax = 0) AS inserida`,
        [leadId, origemId, `@${handle}`, String(e.texto ?? ""), e.classificacao ?? "outro", String(e.texto ?? "").slice(0, 140),
          ehUltima ? (l.temperatura ?? null) : null, ehUltima ? (l.proximo_passo ?? null) : null, quando]
      );
      if (nova?.inserida) respostas += 1;
    }
  }
  return { mensagens, respostas };
}

/**
 * Grava no banco os leads do arquivo. Só roda quando o arquivo mudou desde a última vez (ou com forcar).
 * Retorna { sincronizados, novos, mensagens, respostas, erros } ou { pulou: true }.
 */
export async function sincronizarLeadsInstagram({ forcar = false, arquivo = ARQUIVO } = {}) {
  const { texto, dados } = lerArquivo(arquivo);
  const versao = crypto.createHash("sha1").update(texto).digest("hex");
  if (!forcar && (await db.lerEstado(CHAVE_VERSAO)) === versao) return { pulou: true };
  const resultado = { sincronizados: 0, novos: 0, mensagens: 0, respostas: 0, erros: [] };
  for (const l of dados.leads ?? []) {
    const problemas = validarLead(l);
    if (problemas.length) {
      resultado.erros.push(`${l?.instagram ?? "?"}: ${problemas.join(", ")}`);
      continue;
    }
    const { id, novo } = await gravarLead(l);
    const ev = await gravarEventos(id, l);
    resultado.sincronizados += 1;
    if (novo) resultado.novos += 1;
    resultado.mensagens += ev.mensagens;
    resultado.respostas += ev.respostas;
  }
  if (!resultado.erros.length) await db.gravarEstado(CHAVE_VERSAO, versao);
  return resultado;
}
