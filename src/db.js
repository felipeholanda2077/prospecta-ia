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

/** SQL direto, para o que não é das tabelas do sistema (ex.: o agendador do banco). */
export async function consultar(texto, params = []) {
  return q(texto, params);
}

/**
 * Trava entre execuções (ex.: o agendador do banco e o do GitHub ao mesmo tempo):
 * retorna true só para quem pegou a trava; ela expira sozinha depois de `duracaoMs`.
 */
export async function travar(chave, duracaoMs) {
  const agora = Date.now();
  const r = await um(
    `INSERT INTO estado (chave, valor) VALUES ($1, $2)
     ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor
       WHERE estado.valor !~ '^[0-9]+$' OR estado.valor::bigint < $3::bigint
     RETURNING chave`,
    [chave, String(agora + duracaoMs), String(agora)]
  );
  return Boolean(r);
}

export async function destravar(chave) {
  await gravarEstado(chave, "0");
}

/** Reserva a mensagem para envio; só uma execução consegue (as outras recebem false). */
export async function reservarParaEnvio(id) {
  return Boolean(
    await um("UPDATE mensagens SET status = 'enviando', reservada_em = now() WHERE id = $1 AND status = 'aprovada' RETURNING id", [id])
  );
}

/** Envio interrompido no meio (ex.: a execução caiu): marca como erro para você conferir. */
export async function liberarEnviosTravados() {
  await q(
    `UPDATE mensagens SET status = 'erro', erro = 'envio interrompido: confira no WhatsApp ou e-mail se saiu antes de reenviar'
      WHERE status = 'enviando' AND reservada_em < now() - interval '10 minutes'`
  );
}

/**
 * Mensagens de WhatsApp que deram erro porque o número estava desconectado voltam para a
 * fila (as dos últimos 3 dias). Retorna quantas voltaram.
 */
export async function devolverErrosDeConexaoWhatsapp() {
  const r = await q(
    `UPDATE mensagens SET status = 'aprovada', erro = NULL
      WHERE status = 'erro' AND canal = 'whatsapp' AND criado_em > now() - interval '3 days'
        AND erro ~* '(connection closed|not connected|disconnected|desconectad|respondeu 50[23]|não foi possível acessar)'
      RETURNING id`
  );
  return r.length;
}

// ---------- Posts de conteúdo ----------

const lerPost = (p) => p && { ...p, dia: p.dia instanceof Date ? p.dia.toISOString().slice(0, 10) : String(p.dia).slice(0, 10), conteudo: JSON.parse(p.conteudo) };

export async function criarPost({ dia, formato, pilar, tema, conteudo }) {
  const r = await um(
    "INSERT INTO posts (dia, formato, pilar, tema, conteudo) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [dia, formato, pilar, tema, JSON.stringify(conteudo)]
  );
  return r.id;
}

export async function buscarPost(id) {
  return lerPost(await um("SELECT * FROM posts WHERE id = $1", [id]));
}

/** Posts mais recentes, do mais novo para o mais antigo (sem os descartados). */
export async function postsRecentes(limite = 20) {
  return (await q("SELECT * FROM posts WHERE status <> 'descartado' ORDER BY dia DESC, id DESC LIMIT $1", [limite])).map(lerPost);
}

/** Posts do dia, inclusive os descartados (o rodízio de linhas editoriais conta com eles). */
export async function postsDoDia(dia) {
  return (await q("SELECT * FROM posts WHERE dia = $1 ORDER BY id", [dia])).map(lerPost);
}

export async function atualizarStatusPost(id, status) {
  await q("UPDATE posts SET status = $2, postado_em = CASE WHEN $2 = 'postado' THEN now() ELSE NULL END WHERE id = $1", [id, status]);
}

const CAMPOS_INSTAGRAM = ["instagram_container", "instagram_id", "instagram_link", "instagram_erro", "instagram_tentativas"];

export async function atualizarInstagramDoPost(id, campos) {
  const chaves = Object.keys(campos).filter((k) => CAMPOS_INSTAGRAM.includes(k));
  if (!chaves.length) return;
  await q(`UPDATE posts SET ${chaves.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...chaves.map((k) => campos[k])]);
}

export async function gravarMidia(chave, tipo, dados) {
  await q(
    "INSERT INTO midias (chave, tipo, dados) VALUES ($1, $2, $3) ON CONFLICT (chave) DO UPDATE SET tipo = excluded.tipo, dados = excluded.dados, criada_em = now()",
    [chave, tipo, Buffer.from(dados).toString("base64")]
  );
}

export async function lerMidia(chave) {
  const m = await um("SELECT tipo, dados FROM midias WHERE chave = $1", [chave]);
  return m && { tipo: m.tipo, dados: Buffer.from(m.dados, "base64") };
}

/** Apaga as mídias de um post (e as esquecidas há mais de 3 dias). */
export async function apagarMidias(prefixo) {
  await q("DELETE FROM midias WHERE starts_with(chave, $1) OR criada_em < now() - interval '3 days'", [prefixo]);
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

/** Configurações salvas pelo painel (perfil da empresa, conexão UAZap), em JSON. */
export async function lerConfig(chave) {
  const valor = await lerEstado(`config:${chave}`);
  try {
    return valor ? JSON.parse(valor) : null;
  } catch {
    return null;
  }
}

export async function gravarConfig(chave, objeto) {
  await gravarEstado(`config:${chave}`, JSON.stringify(objeto));
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
  "nome", "nicho", "cidade", "endereco", "telefone", "whatsapp", "whatsapp_status", "email", "site", "maps_url",
  "avaliacao", "total_avaliacoes", "analise", "oportunidades", "status", "observacao", "instagram", "instagram_dados",
]);

/** Insere a empresa se ainda não existir. Retorna true se for nova. */
export async function inserirLead(lead) {
  const linhas = await q(
    `INSERT INTO leads (place_id, nome, nicho, cidade, endereco, telefone, site, maps_url,
                        avaliacao, total_avaliacoes, origem, token, email, instagram, instagram_dados)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (place_id) DO NOTHING RETURNING id`,
    [
      lead.place_id, lead.nome, lead.nicho, lead.cidade, lead.endereco, lead.telefone, lead.site,
      lead.maps_url, lead.avaliacao, lead.total_avaliacoes, lead.origem ?? "campanha",
      crypto.randomBytes(16).toString("hex"), lead.email ?? null, lead.instagram ?? null,
      lead.instagram_dados ? JSON.stringify(lead.instagram_dados) : null,
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

/** Leads em um status, com as empresas sem site próprio primeiro (são a prioridade). */
export async function leadsPorStatus(status, limite = 1000) {
  return q(
    `SELECT * FROM leads WHERE status = $1
      ORDER BY (site IS NULL OR site = '' OR site ~* 'instagram\\.com|facebook\\.com|linktr\\.ee|wa\\.me|ifood\\.com') DESC, id
      LIMIT $2`,
    [status, limite]
  );
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

/** Quais destes @ do Instagram já viraram empresa (pelo Instagram ou pelo link do perfil no Google). */
export async function instagramsCapturados(usuarios) {
  if (!usuarios.length) return new Set();
  const linhas = await q(
    `SELECT instagram, site, place_id FROM leads
      WHERE instagram IN (${marcadores(usuarios.length)}) OR site ~* 'instagram\\.com/'`,
    usuarios
  );
  const achados = new Set();
  for (const l of linhas) {
    if (l.instagram) achados.add(l.instagram.toLowerCase());
    const doLink = String(l.site ?? "").match(/instagram\.com\/([a-z0-9._]{2,30})/i)?.[1];
    if (doLink) achados.add(doLink.toLowerCase());
  }
  return new Set(usuarios.filter((u) => achados.has(u)));
}

/**
 * Ponto de partida da busca no Instagram: os @ das empresas já capturadas num segmento e cidade
 * e os DDDs dos telefones delas (para reconhecer as da mesma região).
 */
export async function instagramsDaBusca(nicho, cidade, limite = 10) {
  const linhas = await q(
    `SELECT instagram, site, telefone FROM leads WHERE lower(nicho) = lower($1) AND lower(cidade) = lower($2) ORDER BY id DESC LIMIT 300`,
    [nicho, cidade]
  );
  const usuarios = linhas
    .map((l) => l.instagram || String(l.site ?? "").match(/instagram\.com\/([a-z0-9._]{2,30})/i)?.[1]?.toLowerCase())
    .filter((u) => u && !["p", "reel", "reels", "stories", "explore"].includes(u));
  const ddds = linhas
    .map((l) => String(l.telefone ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "").slice(0, 2))
    .filter((d) => /^[1-9][1-9]$/.test(d));
  return { usuarios: [...new Set(usuarios)].slice(0, limite), ddds: [...new Set(ddds)] };
}

/** Marca todos os contatos do lead como descadastrados e cancela o que ainda não foi enviado. */
export async function descadastrarLead(lead, motivo = "pedido do contato") {
  for (const contato of [lead.email, lead.whatsapp, lead.telefone]) await descadastrar(contato, motivo);
  await cancelarPendentes(lead.id, "contato descadastrado");
  await atualizarLead(lead.id, { status: "descadastrado" });
}

// ---------- Mensagens ----------

const COLUNAS_MENSAGEM = new Set(["assunto", "corpo", "status", "erro", "enviada_em", "message_id", "agendada_para"]);

/** Evita contatar o mesmo e-mail/telefone duas vezes, mesmo vindo de empresas diferentes. */
export async function contatoJaUsado(destino, status = ["rascunho", "aprovada", "enviada"]) {
  return Boolean(
    await um(`SELECT 1 AS x FROM mensagens WHERE destino = $1 AND status IN (${marcadores(status.length, 2)}) LIMIT 1`, [
      normalizarContato(destino),
      ...status,
    ])
  );
}

export async function criarMensagem({
  lead_id, canal, destino, assunto, corpo, status = "rascunho", tipo = "inicial", responde_a = null, etapa = 1,
  enviada_em = null, em_resposta_a = null,
}) {
  const linha = await um(
    `INSERT INTO mensagens (lead_id, canal, destino, assunto, corpo, status, tipo, responde_a, etapa, enviada_em, em_resposta_a)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [lead_id, canal, normalizarContato(destino), assunto ?? null, corpo, status, tipo, responde_a, etapa, enviada_em, em_resposta_a]
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
  SELECT m.*, l.nome AS empresa, l.nicho, l.cidade, l.site, l.maps_url, l.token, l.oportunidades, l.whatsapp_status,
         l.avaliacao, l.total_avaliacoes, l.status AS status_lead
    FROM mensagens m JOIN leads l ON l.id = m.lead_id`;

export async function mensagensPorStatus(status, limite = 1000) {
  return q(`${SELECT_MENSAGEM} WHERE m.status = $1 ORDER BY m.lead_id, m.canal, m.etapa, m.id LIMIT $2`, [status, limite]);
}

/** As etapas de um lead em um canal (a sequência inteira). */
export async function mensagensDaSequencia(leadId, canal) {
  return q(`${SELECT_MENSAGEM} WHERE m.lead_id = $1 AND m.canal = $2 AND m.tipo <> 'resposta' ORDER BY m.etapa, m.id`, [leadId, canal]);
}

/**
 * Mensagens aprovadas que já podem sair: a etapa 1 assim que aprovada; as etapas
 * seguintes só quando a data agendada chegou (ela é definida quando a anterior sai).
 */
export async function filaDeEnvio(limite = 100) {
  return q(
    `${SELECT_MENSAGEM}
      WHERE m.status = 'aprovada'
        AND (CASE WHEN m.etapa <= 1 THEN (m.agendada_para IS NULL OR m.agendada_para <= now())
                  ELSE (m.agendada_para IS NOT NULL AND m.agendada_para <= now()) END)
      ORDER BY m.etapa, COALESCE(m.agendada_para, m.criado_em), m.id
      LIMIT $1`,
    [limite]
  );
}

/** Empresas com etapas ainda não enviadas que citam preço (escritas antes da regra do bate-papo). */
export async function leadsComPrecoPendente(limite = 10) {
  return (
    await q(
      `SELECT DISTINCT lead_id FROM mensagens
        WHERE status IN ('rascunho', 'aprovada') AND tipo IN ('inicial', 'sequencia') AND corpo ~ 'R\\$ ?[0-9]'
        LIMIT $1`,
      [limite]
    )
  ).map((r) => r.lead_id);
}

/** Etapas de uma empresa que ainda podem ser reescritas (não enviadas). */
export async function etapasPendentes(leadId) {
  return q(
    `SELECT * FROM mensagens WHERE lead_id = $1 AND status IN ('rascunho', 'aprovada') AND tipo IN ('inicial', 'sequencia')
      ORDER BY canal, etapa`,
    [leadId]
  );
}

/** Próxima etapa ainda não enviada de cada sequência (empresa + canal), para mostrar nas enviadas. */
export async function proximasEtapas(leadIds) {
  if (!leadIds.length) return [];
  return q(
    `SELECT DISTINCT ON (lead_id, canal) lead_id, canal, etapa, agendada_para
       FROM mensagens
      WHERE lead_id IN (${marcadores(leadIds.length)}) AND status = 'aprovada' AND tipo IN ('inicial', 'sequencia')
      ORDER BY lead_id, canal, etapa`,
    leadIds
  );
}

/** Etapas de e-mail agendadas para menos de um dia depois da anterior (regra antiga, de tudo no mesmo dia). */
export async function emailsAgendadosNoMesmoDia() {
  return q(
    `SELECT m.id, m.etapa, a.enviada_em AS anterior_enviada_em
       FROM mensagens m
       JOIN mensagens a ON a.lead_id = m.lead_id AND a.canal = 'email' AND a.etapa = m.etapa - 1 AND a.status = 'enviada'
      WHERE m.canal = 'email' AND m.status = 'aprovada' AND m.tipo = 'sequencia' AND m.etapa > 1
        AND m.agendada_para IS NOT NULL AND m.agendada_para < a.enviada_em + interval '20 hours'`
  );
}

/** Agenda a próxima etapa da sequência (se existir e estiver aprovada). */
export async function agendarProximaEtapa(m, quando) {
  await q(
    `UPDATE mensagens SET agendada_para = $4
      WHERE lead_id = $1 AND canal = $2 AND etapa = $3 AND status = 'aprovada' AND agendada_para IS NULL`,
    [m.lead_id, m.canal, m.etapa + 1, quando]
  );
}

/** Conversa completa com um lead (o que enviamos e o que ele respondeu), em ordem. */
export async function historicoConversa(leadId) {
  return q(
    `SELECT 'nos' AS autor, canal, assunto, corpo AS texto, enviada_em AS quando, etapa, destino AS contato, tipo
       FROM mensagens WHERE lead_id = $1 AND status = 'enviada'
     UNION ALL
     SELECT 'lead' AS autor, canal, assunto, texto, recebida_em AS quando, NULL AS etapa, de AS contato, classificacao AS tipo
       FROM respostas WHERE lead_id = $1 AND classificacao IS DISTINCT FROM 'automatica'
     ORDER BY quando`,
    [leadId]
  );
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

/** Mensagens de prospecção enviadas hoje (respostas de conversa não contam). Sem canal = todos. */
/** Mensagens de prospecção enviadas hoje; com `primeiroContato`, só as etapas 1 (empresas novas). */
export async function enviadasHoje(canal = null, { primeiroContato = false } = {}) {
  return (
    await um(
      `SELECT count(*)::int AS n FROM mensagens
        WHERE status = 'enviada' AND tipo <> 'resposta' AND ($2::text IS NULL OR canal = $2::text)
          AND ($3::boolean IS FALSE OR etapa <= 1)
          AND (enviada_em AT TIME ZONE $1::text)::date = (now() AT TIME ZONE $1::text)::date`,
      [config.timezone, canal, primeiroContato]
    )
  ).n;
}

/** Quantas respostas já mandamos nesta conversa (para a IA passar a vez para você depois de um limite). */
/** Alguma resposta da conversa saiu desde este momento (ISO)? */
export async function respostaDaConversaDesde(leadId, desde) {
  return Boolean(await um(
    `SELECT 1 AS x FROM mensagens WHERE lead_id = $1 AND tipo = 'resposta' AND status IN ('enviando', 'enviada')
        AND criado_em >= $2::timestamptz - interval '1 minute'`,
    [leadId, desde]
  ));
}

export async function respostasEnviadasNaConversa(leadId) {
  return (await um("SELECT count(*)::int AS n FROM mensagens WHERE lead_id = $1 AND tipo = 'resposta' AND status IN ('aprovada', 'enviada')", [leadId])).n;
}

export async function atualizarResposta(id, campos) {
  const permitidos = ["mensagem_id", "precisa_humano", "lida", "classificacao", "resumo", "sugestao", "temperatura", "proximo_passo"];
  const chaves = Object.keys(campos).filter((k) => permitidos.includes(k));
  if (!chaves.length) return;
  await q(`UPDATE respostas SET ${chaves.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...chaves.map((k) => campos[k])]);
}

/** Quem escreveu no WhatsApp por conta própria e é cliente em potencial vira um lead já em conversa. */
export async function criarLeadDeContato({ nome, whatsapp = null, observacao = null }) {
  const linha = await um(
    `INSERT INTO leads (nome, whatsapp, telefone, origem, status, observacao, token)
     VALUES ($1, $2, $2, 'whatsapp', 'respondeu', $3, $4) RETURNING id`,
    [nome, whatsapp, observacao, crypto.randomBytes(16).toString("hex")]
  );
  return linha.id;
}

/** Empresas que receberam mensagem nossa nos últimos dias (para reconhecer quem responde de outro número). */
export async function empresasContatadasRecentes(dias = 30, limite = 300) {
  return q(
    `SELECT l.id, l.nome FROM leads l
      WHERE EXISTS (SELECT 1 FROM mensagens m WHERE m.lead_id = l.id AND m.status = 'enviada'
                     AND m.enviada_em > now() - make_interval(days => $1))
      ORDER BY l.id DESC LIMIT $2`,
    [dias, limite]
  );
}

export async function buscarLeadPorEmail(email) {
  return um("SELECT * FROM leads WHERE lower(email) = lower($1) ORDER BY id DESC LIMIT 1", [email]);
}

// ---------- Respostas ----------

/** Registra uma resposta. Retorna o id, ou null se ela já tinha sido registrada. */
export async function criarResposta(r) {
  const linha = await um(
    `INSERT INTO respostas (lead_id, canal, origem_id, de, assunto, texto, classificacao, resumo, sugestao, temperatura, proximo_passo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (origem_id) DO NOTHING RETURNING id`,
    [r.lead_id, r.canal, r.origem_id, r.de, r.assunto, r.texto, r.classificacao, r.resumo, r.sugestao, r.temperatura ?? null, r.proximo_passo ?? null]
  );
  return linha?.id ?? null;
}

export async function buscarResposta(id) {
  return um(`SELECT r.*, l.nome AS empresa, l.token, l.email, l.whatsapp FROM respostas r JOIN leads l ON l.id = r.lead_id WHERE r.id = $1`, [id]);
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

// ---------- Conversas (página de Respostas) ----------

/**
 * Uma linha por empresa que respondeu: quantas respostas, não lidas, se precisa de você,
 * a avaliação mais recente da IA, a última mensagem da conversa e a próxima que vai sair.
 */
export async function conversas() {
  const linhas = await q(
    `SELECT l.id, l.nome, l.status, l.nicho, l.cidade, l.whatsapp, l.email,
            count(r.id)::int AS respostas,
            count(r.id) FILTER (WHERE NOT r.lida)::int AS nao_lidas,
            count(r.id) FILTER (WHERE r.precisa_humano IS NOT NULL AND NOT r.lida)::int AS precisa_de_voce,
            coalesce(bool_or(r.classificacao IN ('interessado', 'quer_informacoes')), false) AS mostrou_interesse,
            max(r.recebida_em) AS ultima_resposta
       FROM leads l JOIN respostas r ON r.lead_id = l.id
      WHERE r.classificacao IS DISTINCT FROM 'automatica'
      GROUP BY l.id`
  );
  if (!linhas.length) return [];
  const ids = linhas.map((l) => l.id);
  const porLead = async (sql) => Object.fromEntries((await q(sql, ids)).map((r) => [r.lead_id, r]));
  const lista = marcadores(ids.length);
  const [avaliacao, recente, ultima, proxima] = await Promise.all([
    // Avaliação mais recente da IA (respostas antigas, de antes da avaliação, não têm temperatura).
    porLead(`SELECT DISTINCT ON (lead_id) lead_id, temperatura, proximo_passo
               FROM respostas WHERE lead_id IN (${lista}) AND temperatura IS NOT NULL
              ORDER BY lead_id, recebida_em DESC`),
    porLead(`SELECT DISTINCT ON (lead_id) lead_id, id, classificacao, precisa_humano, resumo
               FROM respostas WHERE lead_id IN (${lista}) AND classificacao IS DISTINCT FROM 'automatica'
              ORDER BY lead_id, recebida_em DESC`),
    porLead(`SELECT DISTINCT ON (lead_id) lead_id, autor, texto, quando, canal FROM (
               SELECT lead_id, 'nos' AS autor, corpo AS texto, enviada_em AS quando, canal FROM mensagens WHERE status = 'enviada'
               UNION ALL
               SELECT lead_id, 'lead', texto, recebida_em, canal FROM respostas WHERE classificacao IS DISTINCT FROM 'automatica'
             ) x WHERE lead_id IN (${lista}) ORDER BY lead_id, quando DESC`),
    porLead(`SELECT DISTINCT ON (lead_id) lead_id, canal, agendada_para, tipo, etapa FROM mensagens
              WHERE lead_id IN (${lista}) AND status = 'aprovada' ORDER BY lead_id, agendada_para NULLS LAST, id`),
  ]);
  return linhas.map((l) => ({
    ...l,
    avaliacao: avaliacao[l.id] ?? null,
    recente: recente[l.id] ?? null,
    ultima: ultima[l.id] ?? null,
    proxima: proxima[l.id] ?? null,
  }));
}

/** Números do funil: empresas contatadas, que responderam, mostraram interesse e agendaram. */
export async function funilDeConversas() {
  // Não responderam: empresas contatadas sem nenhuma resposta de verdade (a automática do
  // WhatsApp Business não conta). "Na sequência" = ainda têm etapas para receber.
  return um(
    `WITH sem_resposta AS (
       SELECT DISTINCT m.lead_id FROM mensagens m
        WHERE m.status = 'enviada' AND m.tipo <> 'resposta'
          AND NOT EXISTS (SELECT 1 FROM respostas r WHERE r.lead_id = m.lead_id AND r.classificacao IS DISTINCT FROM 'automatica')
     )
     SELECT
       (SELECT count(DISTINCT lead_id) FROM mensagens WHERE status = 'enviada' AND tipo <> 'resposta')::int AS contatadas,
       (SELECT count(*) FROM sem_resposta)::int AS nao_responderam,
       (SELECT count(*) FROM sem_resposta s WHERE EXISTS (
          SELECT 1 FROM mensagens p WHERE p.lead_id = s.lead_id AND p.status = 'aprovada' AND p.tipo <> 'resposta'))::int AS nao_responderam_na_sequencia,
       (SELECT count(DISTINCT lead_id) FROM respostas WHERE classificacao IS DISTINCT FROM 'automatica')::int AS responderam,
       (SELECT count(DISTINCT lead_id) FROM respostas WHERE classificacao IN ('interessado', 'quer_informacoes'))::int AS interessadas,
       (SELECT count(*) FROM leads WHERE status = 'agendado')::int AS agendadas`
  );
}

/** Mensagens que ainda vão sair nesta conversa (respostas da IA e etapas agendadas). */
export async function agendadasDaConversa(leadId) {
  return q(
    `SELECT id, canal, corpo AS texto, agendada_para, tipo, etapa, destino AS contato FROM mensagens
      WHERE lead_id = $1 AND status = 'aprovada' ORDER BY agendada_para NULLS LAST, id`,
    [leadId]
  );
}

/** Abriu a conversa no painel: tudo dela conta como lido. */
export async function marcarConversaLida(leadId) {
  await q("UPDATE respostas SET lida = true WHERE lead_id = $1 AND NOT lida", [leadId]);
}

/** Resposta mais recente da empresa (para o painel responder e mostrar a sugestão da IA). */
export async function ultimaRespostaDaConversa(leadId) {
  return um(
    `SELECT * FROM respostas WHERE lead_id = $1 AND classificacao IS DISTINCT FROM 'automatica' ORDER BY recebida_em DESC LIMIT 1`,
    [leadId]
  );
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
    // Conversas (empresas) com mensagem nova; respostas automáticas ("obrigado pelo contato") não contam.
    respostasNaoLidas: (await um(
      "SELECT count(DISTINCT lead_id)::int AS n FROM respostas WHERE NOT lida AND classificacao IS DISTINCT FROM 'automatica'"
    )).n,
    sequenciasPendentes: (await um("SELECT count(DISTINCT (lead_id, canal))::int AS n FROM mensagens WHERE status = 'rascunho'")).n,
    filaEmpresas: (await um("SELECT count(DISTINCT lead_id)::int AS n FROM mensagens WHERE status = 'aprovada'")).n,
    enviadasHojePorCanal: { email: await enviadasHoje("email"), whatsapp: await enviadasHoje("whatsapp") },
    // Mesma regra da página de Respostas: a última resposta pediu você e ninguém respondeu depois dela.
    precisamDeVoce: (await um(
      `SELECT count(*)::int AS n FROM (
         SELECT DISTINCT ON (lead_id) lead_id, precisa_humano, recebida_em FROM respostas
          WHERE classificacao IS DISTINCT FROM 'automatica' ORDER BY lead_id, recebida_em DESC) u
       JOIN leads l ON l.id = u.lead_id
      WHERE u.precisa_humano IS NOT NULL AND l.status NOT IN ('sem_interesse', 'descadastrado', 'descartado')
        AND NOT EXISTS (SELECT 1 FROM mensagens m WHERE m.lead_id = u.lead_id AND m.status = 'enviada' AND m.enviada_em > u.recebida_em)`
    )).n,
  };
}
