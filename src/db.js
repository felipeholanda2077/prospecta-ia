import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { config } from "./config.js";

// Status do lead ao longo do funil:
// novo -> analisado -> proposta_gerada -> contatado -> respondeu
// (ou descartado / sem_interesse / descadastrado)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id      TEXT UNIQUE,
  nome          TEXT NOT NULL,
  nicho         TEXT,
  cidade        TEXT,
  endereco      TEXT,
  telefone      TEXT,
  whatsapp      TEXT,
  email         TEXT,
  site          TEXT,
  avaliacao     REAL,
  total_avaliacoes INTEGER,
  analise       TEXT,          -- JSON com a auditoria do site
  oportunidades TEXT,          -- JSON com os serviços sugeridos
  status        TEXT NOT NULL DEFAULT 'novo',
  token         TEXT NOT NULL UNIQUE, -- usado no link de descadastro
  observacao    TEXT,
  criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mensagens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id),
  canal       TEXT NOT NULL,            -- email | whatsapp
  destino     TEXT NOT NULL,
  assunto     TEXT,
  corpo       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'rascunho', -- rascunho | aprovada | enviada | rejeitada | erro
  erro        TEXT,
  enviada_em  TEXT,
  criado_em   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Respostas recebidas dos leads (e-mail ou WhatsApp), classificadas pela IA.
CREATE TABLE IF NOT EXISTS respostas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id),
  canal         TEXT NOT NULL,
  origem_id     TEXT UNIQUE,          -- Message-ID do e-mail ou id da mensagem do WhatsApp
  de            TEXT,
  assunto       TEXT,
  texto         TEXT NOT NULL,
  classificacao TEXT,                 -- interessado | quer_informacoes | sem_interesse | descadastro | automatica | outro
  resumo        TEXT,
  sugestao      TEXT,                 -- rascunho de resposta sugerido pela IA
  lida          INTEGER NOT NULL DEFAULT 0,
  recebida_em   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pares chave/valor para o estado interno (ex.: último UID lido no IMAP).
CREATE TABLE IF NOT EXISTS estado (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- Lista de supressão: quem pediu para não ser contatado nunca recebe nada.
CREATE TABLE IF NOT EXISTS descadastros (
  contato   TEXT PRIMARY KEY,           -- e-mail em minúsculas ou telefone só com dígitos
  motivo    TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_mensagens_status ON mensagens(status);
`;

// Colunas adicionadas depois da primeira versão; aplicadas em bancos já existentes.
const MIGRACOES = [
  ["mensagens", "tipo", "TEXT NOT NULL DEFAULT 'inicial'"], // inicial | followup
  ["mensagens", "message_id", "TEXT"], // Message-ID do e-mail enviado, para reconhecer respostas
  ["mensagens", "responde_a", "INTEGER REFERENCES mensagens(id)"], // follow-up aponta para a mensagem original
];

function migrar(banco) {
  for (const [tabela, coluna, definicao] of MIGRACOES) {
    const existe = banco.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
    if (!existe) banco.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  }
  banco.exec("CREATE INDEX IF NOT EXISTS idx_mensagens_message_id ON mensagens(message_id)");
}

let db;

export function getDb() {
  if (!db) {
    if (config.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    }
    db = new Database(config.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    migrar(db);
  }
  return db;
}

export function lerEstado(chave) {
  return getDb().prepare("SELECT valor FROM estado WHERE chave = ?").get(chave)?.valor ?? null;
}

export function gravarEstado(chave, valor) {
  getDb()
    .prepare("INSERT INTO estado (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor")
    .run(chave, String(valor));
}

export function normalizarContato(contato) {
  if (!contato) return "";
  return contato.includes("@") ? contato.trim().toLowerCase() : contato.replace(/\D/g, "");
}

export function estaDescadastrado(contato) {
  const chave = normalizarContato(contato);
  if (!chave) return false;
  return Boolean(getDb().prepare("SELECT 1 FROM descadastros WHERE contato = ?").get(chave));
}

export function descadastrar(contato, motivo = "pedido do contato") {
  const chave = normalizarContato(contato);
  if (!chave) return;
  getDb()
    .prepare("INSERT OR IGNORE INTO descadastros (contato, motivo) VALUES (?, ?)")
    .run(chave, motivo);
}

/** Insere a empresa se ainda não existir. Retorna true se for nova. */
export function inserirLead(lead) {
  const r = getDb()
    .prepare(
      `INSERT OR IGNORE INTO leads
        (place_id, nome, nicho, cidade, endereco, telefone, site, avaliacao, total_avaliacoes, token)
       VALUES (@place_id, @nome, @nicho, @cidade, @endereco, @telefone, @site, @avaliacao, @total_avaliacoes, @token)`
    )
    .run({ ...lead, token: crypto.randomBytes(16).toString("hex") });
  return r.changes > 0;
}

export function atualizarLead(id, campos) {
  const chaves = Object.keys(campos);
  if (!chaves.length) return;
  const sets = chaves.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE leads SET ${sets}, atualizado_em = datetime('now') WHERE id = @id`)
    .run({ ...campos, id });
}

export function leadsPorStatus(status, limite = 1000) {
  return getDb()
    .prepare("SELECT * FROM leads WHERE status = ? ORDER BY id LIMIT ?")
    .all(status, limite);
}

export function buscarLead(id) {
  return getDb().prepare("SELECT * FROM leads WHERE id = ?").get(id);
}

export function buscarLeadPorToken(token) {
  return getDb().prepare("SELECT * FROM leads WHERE token = ?").get(token);
}

/** Evita contatar o mesmo e-mail/telefone duas vezes, mesmo vindo de empresas diferentes. */
export function contatoJaUsado(destino, status = ["rascunho", "aprovada", "enviada"]) {
  const marcadores = status.map(() => "?").join(", ");
  return Boolean(
    getDb()
      .prepare(`SELECT 1 FROM mensagens WHERE destino = ? AND status IN (${marcadores})`)
      .get(normalizarContato(destino), ...status)
  );
}

export function criarMensagem({ lead_id, canal, destino, assunto, corpo, status = "rascunho", tipo = "inicial", responde_a = null }) {
  return getDb()
    .prepare(
      `INSERT INTO mensagens (lead_id, canal, destino, assunto, corpo, status, tipo, responde_a)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(lead_id, canal, normalizarContato(destino), assunto ?? null, corpo, status, tipo, responde_a).lastInsertRowid;
}

/** Marca todos os contatos do lead como descadastrados e cancela o que ainda não foi enviado. */
export function descadastrarLead(lead, motivo = "pedido do contato") {
  for (const contato of [lead.email, lead.whatsapp, lead.telefone]) descadastrar(contato, motivo);
  getDb()
    .prepare(
      `UPDATE mensagens SET status = 'rejeitada', erro = 'contato descadastrado'
        WHERE lead_id = ? AND status IN ('rascunho', 'aprovada')`
    )
    .run(lead.id);
  atualizarLead(lead.id, { status: "descadastrado" });
}

/** Cancela mensagens ainda não enviadas do lead (ex.: ele respondeu antes do follow-up sair). */
export function cancelarPendentes(leadId, motivo) {
  getDb()
    .prepare(`UPDATE mensagens SET status = 'rejeitada', erro = ? WHERE lead_id = ? AND status IN ('rascunho', 'aprovada')`)
    .run(motivo, leadId);
}

/** Encontra a mensagem enviada a que um e-mail recebido responde (In-Reply-To/References). */
export function mensagemPorMessageIds(ids) {
  const limpos = ids.filter(Boolean);
  if (!limpos.length) return null;
  const marcadores = limpos.map(() => "?").join(", ");
  return getDb()
    .prepare(`SELECT * FROM mensagens WHERE message_id IN (${marcadores}) ORDER BY id DESC LIMIT 1`)
    .get(...limpos);
}

/** Última mensagem enviada para um contato (usado quando a resposta não traz cabeçalhos de thread). */
export function ultimaEnviadaPara(destino) {
  return getDb()
    .prepare("SELECT * FROM mensagens WHERE destino = ? AND status = 'enviada' ORDER BY id DESC LIMIT 1")
    .get(normalizarContato(destino));
}

/** Última mensagem enviada por um canal para qualquer um dos contatos informados. */
export function ultimaEnviadaParaAlgum(destinos, canal) {
  if (!destinos.length) return null;
  const marcadores = destinos.map(() => "?").join(", ");
  return getDb()
    .prepare(
      `SELECT * FROM mensagens WHERE canal = ? AND status = 'enviada' AND destino IN (${marcadores})
        ORDER BY id DESC LIMIT 1`
    )
    .get(canal, ...destinos.map(normalizarContato));
}

/** Última mensagem enviada por um canal, para qualquer destino (usado no modo teste). */
export function ultimaEnviadaNoCanal(canal) {
  return getDb()
    .prepare("SELECT * FROM mensagens WHERE canal = ? AND status = 'enviada' ORDER BY enviada_em DESC LIMIT 1")
    .get(canal);
}

/** Registra uma resposta. Retorna o id, ou null se ela já tinha sido registrada. */
export function criarResposta(r) {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO respostas (lead_id, canal, origem_id, de, assunto, texto, classificacao, resumo, sugestao)
       VALUES (@lead_id, @canal, @origem_id, @de, @assunto, @texto, @classificacao, @resumo, @sugestao)`
    )
    .run({ assunto: null, classificacao: null, resumo: null, sugestao: null, ...r });
  return res.changes ? res.lastInsertRowid : null;
}

export function respostaJaRegistrada(origemId) {
  return Boolean(getDb().prepare("SELECT 1 FROM respostas WHERE origem_id = ?").get(origemId));
}

export function listarRespostas({ apenasNaoLidas = false, limite = 200 } = {}) {
  return getDb()
    .prepare(
      `SELECT r.*, l.nome AS empresa, l.nicho, l.cidade, l.status AS status_lead
         FROM respostas r JOIN leads l ON l.id = r.lead_id
        ${apenasNaoLidas ? "WHERE r.lida = 0" : ""}
        ORDER BY r.id DESC LIMIT ?`
    )
    .all(limite);
}

export function marcarRespostaLida(id) {
  getDb().prepare("UPDATE respostas SET lida = 1 WHERE id = ?").run(id);
}

/**
 * E-mails iniciais enviados há pelo menos `dias` dias, de leads que não responderam
 * e que ainda não receberam follow-up.
 */
export function candidatosFollowup(dias, limite = 100) {
  return getDb()
    .prepare(
      `SELECT m.*, l.nome AS empresa, l.nicho, l.cidade, l.site, l.avaliacao, l.total_avaliacoes, l.oportunidades
         FROM mensagens m JOIN leads l ON l.id = m.lead_id
        WHERE m.canal = 'email' AND m.tipo = 'inicial' AND m.status = 'enviada'
          AND l.status = 'contatado'
          AND julianday(m.enviada_em) <= julianday('now') - ?
          AND NOT EXISTS (SELECT 1 FROM mensagens f WHERE f.responde_a = m.id)
          AND NOT EXISTS (SELECT 1 FROM respostas r WHERE r.lead_id = l.id)
        ORDER BY m.id LIMIT ?`
    )
    .all(dias, limite);
}

export function atualizarMensagem(id, campos) {
  const chaves = Object.keys(campos);
  const sets = chaves.map((k) => `${k} = @${k}`).join(", ");
  getDb().prepare(`UPDATE mensagens SET ${sets} WHERE id = @id`).run({ ...campos, id });
}

export function mensagensPorStatus(status, limite = 1000) {
  return getDb()
    .prepare(
      `SELECT m.*, l.nome AS empresa, l.nicho, l.cidade, l.site, l.token, l.oportunidades, l.status AS status_lead
         FROM mensagens m JOIN leads l ON l.id = m.lead_id
        WHERE m.status = ? ORDER BY m.id LIMIT ?`
    )
    .all(status, limite);
}

export function buscarMensagem(id) {
  return getDb()
    .prepare(
      `SELECT m.*, l.nome AS empresa, l.token FROM mensagens m JOIN leads l ON l.id = m.lead_id WHERE m.id = ?`
    )
    .get(id);
}

export function enviadasHoje() {
  return getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM mensagens WHERE status = 'enviada' AND date(enviada_em, 'localtime') = date('now', 'localtime')"
    )
    .get().n;
}

export function estatisticas() {
  const d = getDb();
  return {
    leads: Object.fromEntries(
      d.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all().map((r) => [r.status, r.n])
    ),
    mensagens: Object.fromEntries(
      d.prepare("SELECT status, COUNT(*) AS n FROM mensagens GROUP BY status").all().map((r) => [r.status, r.n])
    ),
    enviadasHoje: enviadasHoje(),
    descadastros: d.prepare("SELECT COUNT(*) AS n FROM descadastros").get().n,
    respostas: Object.fromEntries(
      d.prepare("SELECT classificacao, COUNT(*) AS n FROM respostas GROUP BY classificacao").all().map((r) => [r.classificacao, r.n])
    ),
    respostasNaoLidas: d.prepare("SELECT COUNT(*) AS n FROM respostas WHERE lida = 0").get().n,
  };
}
