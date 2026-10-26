import crypto from "node:crypto";
import express from "express";
import cron from "node-cron";
import { config, carregarCampanha } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";
import { assinaturaValida, processarWebhookWhatsapp } from "./respostas/whatsapp.js";

const app = express();
// Guarda o corpo bruto: a assinatura do webhook do WhatsApp é calculada sobre ele.
app.use(express.json({ verify: (req, res, buf) => (req.corpoBruto = buf) }));
app.use(express.urlencoded({ extended: false }));

// ---------- Descadastro (público, sem senha) ----------

const processarDescadastro = (lead) => db.descadastrarLead(lead, "link de descadastro");

const paginaSimples = (titulo, conteudo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#1f2328}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#1f2328;color:#fff;cursor:pointer}</style>
</head><body>${conteudo}</body></html>`;

app.get("/descadastrar/:token", (req, res) => {
  const lead = db.buscarLeadPorToken(req.params.token);
  if (!lead) return res.status(404).send(paginaSimples("Link inválido", "<h2>Link inválido ou expirado.</h2>"));
  // Confirmação por POST para que antivírus/pré-visualizações de e-mail não descadastrem sozinhos.
  res.send(
    paginaSimples(
      "Descadastrar",
      `<h2>Não receber mais mensagens</h2><p>Confirme para que <b>${escapar(lead.nome)}</b> não receba novos contatos nossos.</p>
       <form method="post"><button type="submit">Confirmar descadastro</button></form>`
    )
  );
});

// Também atende o "one-click" do Gmail/Outlook (List-Unsubscribe-Post).
app.post("/descadastrar/:token", (req, res) => {
  const lead = db.buscarLeadPorToken(req.params.token);
  if (!lead) return res.status(404).send(paginaSimples("Link inválido", "<h2>Link inválido ou expirado.</h2>"));
  processarDescadastro(lead);
  res.send(paginaSimples("Pronto", "<h2>Pronto!</h2><p>Você não receberá mais mensagens nossas.</p>"));
});

// ---------- Webhook do WhatsApp (público, validado pela assinatura da Meta) ----------

// Verificação feita pela Meta ao cadastrar a URL do webhook.
app.get("/webhooks/whatsapp", (req, res) => {
  const ok =
    req.query["hub.mode"] === "subscribe" &&
    config.whatsapp.verifyToken &&
    req.query["hub.verify_token"] === config.whatsapp.verifyToken;
  ok ? res.send(req.query["hub.challenge"]) : res.sendStatus(403);
});

app.post("/webhooks/whatsapp", (req, res) => {
  if (!assinaturaValida(req.corpoBruto, req.get("x-hub-signature-256"), config.whatsapp.appSecret)) {
    return res.sendStatus(401);
  }
  // A Meta espera 200 rápido; a classificação com IA roda depois.
  res.sendStatus(200);
  processarWebhookWhatsapp(req.body, carregarCampanha()).catch((e) => console.error("Erro no webhook do WhatsApp:", e));
});

function escapar(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- Painel (protegido por usuário/senha) ----------

function iguais(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

app.use((req, res, next) => {
  if (!config.painel.senha) return res.status(500).send("Defina PAINEL_SENHA no .env para usar o painel.");
  const [tipo, valor] = (req.headers.authorization ?? "").split(" ");
  if (tipo === "Basic" && valor) {
    const [usuario, ...resto] = Buffer.from(valor, "base64").toString().split(":");
    if (iguais(usuario, config.painel.usuario) && iguais(resto.join(":"), config.painel.senha)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Prospecta IA"').status(401).send("Autenticação necessária");
});

app.use(express.static("public"));

app.get("/api/stats", (req, res) => res.json(db.estatisticas()));

app.get("/api/mensagens", (req, res) => {
  const mensagens = db.mensagensPorStatus(req.query.status || "rascunho", 200);
  res.json(mensagens.map(({ token, ...m }) => ({ ...m, oportunidades: JSON.parse(m.oportunidades || "[]") })));
});

app.put("/api/mensagens/:id", (req, res) => {
  const m = db.buscarMensagem(req.params.id);
  if (!m || m.status === "enviada") return res.status(400).json({ erro: "Mensagem não editável" });
  const { assunto, corpo } = req.body;
  db.atualizarMensagem(m.id, { assunto: assunto ?? m.assunto, corpo: corpo ?? m.corpo });
  res.json({ ok: true });
});

app.post("/api/mensagens/:id/:acao", (req, res) => {
  const novoStatus = { aprovar: "aprovada", rejeitar: "rejeitada" }[req.params.acao];
  const m = db.buscarMensagem(req.params.id);
  if (!novoStatus || !m || m.status === "enviada") return res.status(400).json({ erro: "Ação inválida" });
  db.atualizarMensagem(m.id, { status: novoStatus });
  res.json({ ok: true });
});

app.get("/api/leads", (req, res) => {
  const leads = db.leadsPorStatus(req.query.status || "contatado", 500);
  res.json(leads.map(({ token, analise, ...l }) => ({ ...l, oportunidades: JSON.parse(l.oportunidades || "[]") })));
});

app.post("/api/leads/:id/status", (req, res) => {
  const lead = db.buscarLead(req.params.id);
  const { status } = req.body;
  if (!lead || !["respondeu", "sem_interesse", "descartado", "descadastrado"].includes(status))
    return res.status(400).json({ erro: "Status inválido" });
  if (status === "descadastrado") processarDescadastro(lead);
  else {
    db.cancelarPendentes(lead.id, `lead marcado como ${status}`);
    db.atualizarLead(lead.id, { status });
  }
  res.json({ ok: true });
});

app.get("/api/respostas", (req, res) => {
  res.json(db.listarRespostas({ apenasNaoLidas: req.query.naoLidas === "1" }));
});

app.post("/api/respostas/:id/lida", (req, res) => {
  db.marcarRespostaLida(req.params.id);
  res.json({ ok: true });
});

const ETAPAS = {
  respostas: (c) => pipeline.verificarRespostas(c),
  descobrir: (c) => pipeline.descobrir(c),
  analisar: () => pipeline.analisar(),
  propor: (c) => pipeline.propor(c),
  followup: (c) => pipeline.criarFollowups(c),
  enviar: (c) => pipeline.enviar(c),
  ciclo: (c) => pipeline.executarCiclo(c),
};

// As etapas podem demorar (o envio espera entre mensagens), então rodam em segundo plano.
app.post("/api/etapas/:etapa", (req, res) => {
  const etapa = ETAPAS[req.params.etapa];
  if (!etapa) return res.status(404).json({ erro: "Etapa desconhecida" });
  etapa(carregarCampanha()).catch((e) => console.error(`Erro na etapa ${req.params.etapa}:`, e));
  res.status(202).json({ ok: true, mensagem: `Etapa "${req.params.etapa}" iniciada. Acompanhe pelo terminal.` });
});

// ---------- Inicialização ----------

db.getDb();
app.listen(config.painel.porta, () => {
  console.log(`Painel em http://localhost:${config.painel.porta}`);
});

if (config.cicloCron) {
  cron.schedule(config.cicloCron, () => pipeline.executarCiclo(carregarCampanha()).catch(console.error), {
    timezone: config.timezone,
  });
  console.log(`Ciclo automático agendado: "${config.cicloCron}" (${config.timezone})`);
}

if (config.verificarRespostasCron && config.imap.host) {
  cron.schedule(config.verificarRespostasCron, () => pipeline.verificarRespostas(carregarCampanha()).catch(console.error), {
    timezone: config.timezone,
  });
  console.log(`Verificação de respostas por e-mail agendada: "${config.verificarRespostasCron}"`);
}

if (config.modoTeste.email || config.modoTeste.whatsapp) {
  console.log(`⚠️  MODO TESTE: mensagens vão para ${config.modoTeste.email || "-"} / ${config.modoTeste.whatsapp || "-"}`);
}
