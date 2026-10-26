import crypto from "node:crypto";
import express from "express";
import cron from "node-cron";
import { config, carregarCampanha } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Descadastro (público, sem senha) ----------

function processarDescadastro(lead) {
  for (const contato of [lead.email, lead.whatsapp, lead.telefone]) db.descadastrar(contato, "link de descadastro");
  for (const status of ["rascunho", "aprovada"]) {
    db.getDb()
      .prepare("UPDATE mensagens SET status = 'rejeitada', erro = 'contato descadastrado' WHERE lead_id = ? AND status = ?")
      .run(lead.id, status);
  }
  db.atualizarLead(lead.id, { status: "descadastrado" });
}

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
  if (!lead || !["respondeu", "descartado", "descadastrado"].includes(status))
    return res.status(400).json({ erro: "Status inválido" });
  if (status === "descadastrado") processarDescadastro(lead);
  else db.atualizarLead(lead.id, { status });
  res.json({ ok: true });
});

const ETAPAS = {
  descobrir: (c) => pipeline.descobrir(c),
  analisar: () => pipeline.analisar(),
  propor: (c) => pipeline.propor(c),
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
