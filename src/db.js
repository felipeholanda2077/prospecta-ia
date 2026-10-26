import crypto from "node:crypto";
import { config } from "./config.js";
import { SCHEMA } from "./schema.js";

// Com DATABASE_URL usa o Postgres do Supabase (produção/Vercel).
// Sem ela, usa o PGlite: um Postgres embutido que grava em data/pglite
// (ou só na memória com DB_PATH=:memory:, usado nos testes).
async function abrir() {
  if (config.databaseUrl) {
    const { default: postgres } = await import("postgres");
    // prepare: false é necessário no pooler do Supabase (modo transaction, porta 6543).
    const sql = postgres(config.databaseUrl, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 15 });
    return { query: (texto, params = []) => sql.unsafe(texto, params), exec: (texto) => sql.unsafe(texto) };
  }
  if (config.naVercel) {
    throw new Error("DATABASE_URL não configurada: na Vercel o banco precisa ser o Postgres do Supabase.");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const local = config.dbPath === ":memory:" ? new PGlite() : new PGlite(config.dbPath);
  return {
    query: async (texto, params = []) => (await local.query(texto, params)).rows,
    exec: (texto) => local.exec(texto),
  };
}

let conexaoPromise;

function conexao() {
  conexaoPromise ??= abrir()
    .then(async (c) => {
      await c.exec(SCHEMA);
      return c;
    })
    .catch((e) => {
      conexaoPromise = null; // permite tentar de novo na próxima chamada
      throw e;
    });
  return conexaoPromise;
}

async function q(texto, params = []) {
  const c = await conexao();
  return c.query(texto, params.map((p) => (p === undefined ? null : p)));
}

async function um(texto, params) {
  return (await q(texto, params))[0] ?? null;
}

/** "$3, $4, $5" para usar em IN (...) */
const marcadores = (n, inicio = 1) => Array.from({ length: n }, (_, i) => `$${inicio + i}`).join(", ");

export async function iniciar() {
  await conexao();
}

// ---------- Estado interno ----------

export async function lerEstado(chave) {
  return (await um("SELECT valor FROM estado WHERE chave = $1", [chave]))?.valor ?? null;
}

export async function gravarEstado(chave, valor) {
  await q(
    "INSERT INTO estado (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor",
    [chave, String(valor)]
  );
}

// ---------- Descadastros ----------

export function normalizarContato(contato) {
  if (!contato) return "";
  return contato.includes("@") ? contato.trim().toLowerCase() : contato.replace(/\D/g, "");
}

export async function estaDescadastrado(contato) {
  const chave = normalizarContato(contato);
  if (!chave) return false;
  return Boolean(await um("SELECT 1 AS x FROM descadastros WHERE contato = $1", [chave]));
}

export async function descadastrar(contato, motivo = "pedido do contato") {
  const chave = normalizarContato(contato);
  if (!chave) return;
  await q("INSERT INTO descadastros (contato, motivo) VALUES ($1, $2) ON CONFLICT DO NOTHING", [chave, motivo]);
}

// ---------- Leads ----------

const COLUNAS_LEAD = new Set([
  "nome", "nicho", "cidade", "endereco", "telefone", "whatsapp", "email", "site", "maps_url",
  "avaliacao", "total_avaliacoes", "analise", "oportunidades", "status", "observacao",
]);

/** Insere a empresa se ainda não existir. Retorna true se for nova. */
export async function inserirLead(lead) {
  const linhas = await q(
    `INSERT INTO leads (place_id, nome, nicho, cidade, endereco, telefone, site, maps_url,
                        avaliacao, total_avaliacoes, origem, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (place_id) DO NOTHING RETURNING id`,
    [
      lead.place_id, lead.nome, lead.nicho, lead.cidade, lead.endereco, lead.telefone, lead.site,
      lead.maps_url, lead.avaliacao, lead.total_avaliacoes, lead.origem ?? "campanha",
      crypto.randomBytes(16).toString("hex"),
    ]
  );
  return linhas.length > 0;
}

export async function atualizarLead(id, campos) {
  const chaves = Object.keys(campos).filter((k) => COLUNAS_LEAD.has(k));
  if (!chaves.length) return;
  const sets = chaves.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`UPDATE leads SET ${sets}, atualizado_em = now() WHERE id = $1`, [id, ...chaves.map((k) => campos[k])]);
}

export async function leadsPorStatus(status, limite = 1000) {
  return q("SELECT * FROM leads WHERE status = $1 ORDER BY id LIMIT $2", [status, limite]);
}

export async function contarLeadsPorStatus(status) {
  return (await um("SELECT count(*)::int AS n FROM leads WHERE status = $1", [status])).n;
}

/** Leads em vários status, mais recentes primeiro (abas do painel). */
export async function listarLeads(status, limite = 300) {
  return q(
    `SELECT * FROM leads WHERE status IN (${marcadores(status.length, 2)}) ORDER BY atualizado_em DESC LIMIT $1`,
    [limite, ...status]
  );
}

export async function buscarLead(id) {
  return um("SELECT * FROM leads WHERE id = $1", [id]);
}

export async function buscarLeadPorToken(token) {
  return um("SELECT * FROM leads WHERE token = $1", [token]);
}

/** Quais destes place_ids do Google Maps já foram capturados. */
export async function placeIdsCapturados(ids) {
  if (!ids.length) return new Set();
  const linhas = await q(`SELECT place_id FROM leads WHERE place_id IN (${marcadores(ids.length)})`, ids);
  return new Set(linhas.map((l) => l.place_id));
}

/** Marca todos os contatos do lead como descadastrados e cancela o que ainda não foi enviado. */
export async function descadastrarLead(lead, motivo = "pedido do contato") {
  for (const contato of [lead.email, lead.whatsapp, lead.telefone]) await descadastrar(contato, motivo);
  await cancelarPendentes(lead.id, "contato descadastrado");
  await atualizarLead(lead.id, { status: "descadastrado" });
}

// ---------- Mensagens ----------

const COLUNAS_MENSAGEM = new Set(["assunto", "corpo", "status", "erro", "enviada_em", "message_id"]);

/** Evita contatar o mesmo e-mail/telefone duas vezes, mesmo vindo de empresas diferentes. */
export async function contatoJaUsado(destino, status = ["rascunho", "aprovada", "enviada"]) {
  return Boolean(
    await um(`SELECT 1 AS x FROM mensagens WHERE destino = $1 AND status IN (${marcadores(status.length, 2)}) LIMIT 1`, [
      normalizarContato(destino),
      ...status,
    ])
  );
}

export async function criarMensagem({ lead_id, canal, destino, assunto, corpo, status = "rascunho", tipo = "inicial", responde_a = null }) {
  const linha = await um(
    `INSERT INTO mensagens (lead_id, canal, destino, assunto, corpo, status, tipo, responde_a)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [lead_id, canal, normalizarContato(destino), assunto ?? null, corpo, status, tipo, responde_a]
  );
  return linha.id;
}

export async function atualizarMensagem(id, campos) {
  const chaves = Object.keys(campos).filter((k) => COLUNAS_MENSAGEM.has(k));
  if (!chaves.length) return;
  const sets = chaves.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await q(`UPDATE mensagens SET ${sets} WHERE id = $1`, [id, ...chaves.map((k) => campos[k])]);
}

/** Cancela mensagens ainda não enviadas do lead (ex.: ele respondeu antes do follow-up sair). */
export async function cancelarPendentes(leadId, motivo) {
  await q(
    "UPDATE mensagens SET status = 'rejeitada', erro = $2 WHERE lead_id = $1 AND status IN ('rascunho', 'aprovada')",
    [leadId, motivo]
  );
}

const SELECT_MENSAGEM = `
  SELECT m.*, l.nome AS empresa, l.nicho, l.cidade, l.site, l.maps_url, l.token, l.oportunidades,
         l.avaliacao, l.total_avaliacoes, l.status AS status_lead
    FROM mensagens m JOIN leads l ON l.id = m.lead_id`;

export async function mensagensPorStatus(status, limite = 1000) {
  return q(`${SELECT_MENSAGEM} WHERE m.status = $1 ORDER BY m.id LIMIT $2`, [status, limite]);
}

export async function buscarMensagem(id) {
  return um(`${SELECT_MENSAGEM} WHERE m.id = $1`, [id]);
}

/** Encontra a mensagem enviada a que um e-mail recebido responde (In-Reply-To/References). */
export async function mensagemPorMessageIds(ids) {
  const limpos = ids.filter(Boolean);
  if (!limpos.length) return null;
  return um(`SELECT * FROM mensagens WHERE message_id IN (${marcadores(limpos.length)}) ORDER BY id DESC LIMIT 1`, limpos);
}

/** Última mensagem enviada para um contato (usado quando a resposta não traz cabeçalhos de thread). */
export async function ultimaEnviadaPara(destino) {
  return um("SELECT * FROM mensagens WHERE destino = $1 AND status = 'enviada' ORDER BY id DESC LIMIT 1", [
    normalizarContato(destino),
  ]);
}

/** Última mensagem enviada por um canal para qualquer um dos contatos informados. */
export async function ultimaEnviadaParaAlgum(destinos, canal) {
  if (!destinos.length) return null;
  return um(
    `SELECT * FROM mensagens WHERE canal = $1 AND status = 'enviada' AND destino IN (${marcadores(destinos.length, 2)})
      ORDER BY id DESC LIMIT 1`,
    [canal, ...destinos.map(normalizarContato)]
  );
}

/** Última mensagem enviada por um canal, para qualquer destino (usado no modo teste). */
export async function ultimaEnviadaNoCanal(canal) {
  return um("SELECT * FROM mensagens WHERE canal = $1 AND status = 'enviada' ORDER BY enviada_em DESC LIMIT 1", [canal]);
}

export async function enviadasHoje() {
  return (
    await um(
      `SELECT count(*)::int AS n FROM mensagens
        WHERE status = 'enviada' AND (enviada_em AT TIME ZONE $1::text)::date = (now() AT TIME ZONE $1::text)::date`,
      [config.timezone]
    )
  ).n;
}

/**
 * E-mails iniciais enviados há pelo menos `dias` dias, de leads que não responderam
 * e que ainda não receberam follow-up.
 */
export async function candidatosFollowup(dias, limite = 100) {
  return q(
    `${SELECT_MENSAGEM}
      WHERE m.canal = 'email' AND m.tipo = 'inicial' AND m.status = 'enviada'
        AND l.status = 'contatado'
        AND m.enviada_em <= now() - make_interval(days => $1::int)
        AND NOT EXISTS (SELECT 1 FROM mensagens f WHERE f.responde_a = m.id)
        AND NOT EXISTS (SELECT 1 FROM respostas r WHERE r.lead_id = l.id)
      ORDER BY m.id LIMIT $2`,
    [dias, limite]
  );
}

// ---------- Respostas ----------

/** Registra uma resposta. Retorna o id, ou null se ela já tinha sido registrada. */
export async function criarResposta(r) {
  const linha = await um(
    `INSERT INTO respostas (lead_id, canal, origem_id, de, assunto, texto, classificacao, resumo, sugestao)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (origem_id) DO NOTHING RETURNING id`,
    [r.lead_id, r.canal, r.origem_id, r.de, r.assunto, r.texto, r.classificacao, r.resumo, r.sugestao]
  );
  return linha?.id ?? null;
}

export async function respostaJaRegistrada(origemId) {
  return Boolean(await um("SELECT 1 AS x FROM respostas WHERE origem_id = $1", [origemId]));
}

export async function listarRespostas({ apenasNaoLidas = false, limite = 200 } = {}) {
  return q(
    `SELECT r.*, l.nome AS empresa, l.nicho, l.cidade, l.status AS status_lead
       FROM respostas r JOIN leads l ON l.id = r.lead_id
      ${apenasNaoLidas ? "WHERE NOT r.lida" : ""}
      ORDER BY r.id DESC LIMIT $1`,
    [limite]
  );
}

export async function marcarRespostaLida(id) {
  await q("UPDATE respostas SET lida = true WHERE id = $1", [id]);
}

// ---------- Painel ----------

async function contagem(sql) {
  return Object.fromEntries((await q(sql)).map((r) => [r.chave, r.n]));
}

export async function estatisticas() {
  return {
    leads: await contagem("SELECT status AS chave, count(*)::int AS n FROM leads GROUP BY status"),
    mensagens: await contagem("SELECT status AS chave, count(*)::int AS n FROM mensagens GROUP BY status"),
    enviadasHoje: await enviadasHoje(),
    descadastros: (await um("SELECT count(*)::int AS n FROM descadastros")).n,
    respostas: await contagem("SELECT classificacao AS chave, count(*)::int AS n FROM respostas GROUP BY classificacao"),
    respostasNaoLidas: (await um("SELECT count(*)::int AS n FROM respostas WHERE NOT lida")).n,
  };
}
