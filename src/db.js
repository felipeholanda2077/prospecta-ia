import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { config } from "./config.js";

// Status do lead ao longo do funil:
// novo -> analisado -> proposta_gerada -> contatado -> respondeu
// (ou descartado / descadastrado)
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

-- Lista de supressão: quem pediu para não ser contatado nunca recebe nada.
CREATE TABLE IF NOT EXISTS descadastros (
  contato   TEXT PRIMARY KEY,           -- e-mail em minúsculas ou telefone só com dígitos
  motivo    TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_mensagens_status ON mensagens(status);
`;

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
  }
  return db;
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

export function criarMensagem({ lead_id, canal, destino, assunto, corpo, status = "rascunho" }) {
  return getDb()
    .prepare(
      `INSERT INTO mensagens (lead_id, canal, destino, assunto, corpo, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(lead_id, canal, normalizarContato(destino), assunto ?? null, corpo, status).lastInsertRowid;
}

export function atualizarMensagem(id, campos) {
  const chaves = Object.keys(campos);
  const sets = chaves.map((k) => `${k} = @${k}`).join(", ");
  getDb().prepare(`UPDATE mensagens SET ${sets} WHERE id = @id`).run({ ...campos, id });
}

export function mensagensPorStatus(status, limite = 1000) {
  return getDb()
    .prepare(
      `SELECT m.*, l.nome AS empresa, l.nicho, l.cidade, l.site, l.token, l.oportunidades
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
  };
}
