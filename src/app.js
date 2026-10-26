import crypto from "node:crypto";
import express from "express";
import { config, carregarCampanha } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";
import { assinaturaValida, processarWebhookWhatsapp } from "./respostas/whatsapp.js";
import { rodapeDescadastro } from "./envio/email.js";
import { linkWhatsapp, RODAPE_WHATSAPP } from "./envio/whatsapp.js";

export const app = express();
app.set("trust proxy", true);
// Guarda o corpo bruto: a assinatura do webhook do WhatsApp é calculada sobre ele.
app.use(express.json({ limit: "1mb", verify: (req, res, buf) => (req.corpoBruto = buf) }));
app.use(express.urlencoded({ extended: false }));

const escapar = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Descadastro (público) ----------

const paginaSimples = (titulo, conteudo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#1f2328;background:#fff}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#1f2328;color:#fff;cursor:pointer}</style>
</head><body>${conteudo}</body></html>`;

const LINK_INVALIDO = paginaSimples("Link inválido", "<h2>Link inválido ou expirado.</h2>");

app.get("/descadastrar/:token", async (req, res) => {
  const lead = await db.buscarLeadPorToken(req.params.token);
  if (!lead) return res.status(404).send(LINK_INVALIDO);
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
app.post("/descadastrar/:token", async (req, res) => {
  const lead = await db.buscarLeadPorToken(req.params.token);
  if (!lead) return res.status(404).send(LINK_INVALIDO);
  await db.descadastrarLead(lead, "link de descadastro");
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

app.post("/webhooks/whatsapp", async (req, res) => {
  if (!assinaturaValida(req.corpoBruto, req.get("x-hub-signature-256"), config.whatsapp.appSecret)) {
    return res.sendStatus(401);
  }
  // Processa antes de responder: em ambiente serverless nada roda depois da resposta.
  try {
    await processarWebhookWhatsapp(req.body, carregarCampanha());
  } catch (e) {
    console.error("Erro no webhook do WhatsApp:", e);
  }
  res.sendStatus(200);
});

// ---------- Cron da Vercel (protegido pelo CRON_SECRET) ----------

const TAREFAS_CRON = {
  ciclo: (c) => pipeline.executarCiclo(c),
  respostas: (c) => pipeline.verificarRespostas(c),
};

app.get("/api/cron/:tarefa", async (req, res) => {
  const tarefa = TAREFAS_CRON[req.params.tarefa];
  if (!tarefa) return res.sendStatus(404);
  if (!config.cronSecret || req.get("authorization") !== `Bearer ${config.cronSecret}`) return res.sendStatus(401);
  res.json((await tarefa(carregarCampanha())) ?? {});
});

// ---------- Login do painel ----------

const COOKIE = "prospecta_sessao";
const DURACAO_SESSAO_MS = 7 * 24 * 3600 * 1000;

// Trocar a senha do painel invalida todas as sessões abertas.
const chaveSessao = () => crypto.createHash("sha256").update(`prospecta:${config.painel.senha}`).digest();
const assinar = (texto) => crypto.createHmac("sha256", chaveSessao()).update(texto).digest("hex");

function iguais(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function lerCookie(req, nome) {
  for (const parte of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nome) return decodeURIComponent(v.join("="));
  }
  return null;
}

function sessaoValida(req) {
  const valor = lerCookie(req, COOKIE);
  if (!valor || !config.painel.senha) return false;
  const [expira, assinatura] = valor.split(".");
  return Number(expira) > Date.now() && iguais(assinatura ?? "", assinar(expira));
}

app.post("/api/login", async (req, res) => {
  if (!config.painel.senha) return res.status(500).json({ erro: "Defina PAINEL_SENHA nas variáveis de ambiente." });
  const { usuario = "", senha = "" } = req.body ?? {};
  if (!iguais(usuario, config.painel.usuario) || !iguais(senha, config.painel.senha)) {
    await new Promise((r) => setTimeout(r, 800)); // freia tentativas em sequência
    return res.status(401).json({ erro: "Usuário ou senha incorretos" });
  }
  const expira = String(Date.now() + DURACAO_SESSAO_MS);
  res.cookie(COOKIE, `${expira}.${assinar(expira)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: DURACAO_SESSAO_MS,
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (sessaoValida(req)) return next();
  res.status(401).json({ erro: "Faça login para continuar", login: true });
});

// ---------- API do painel (exige login) ----------

app.get("/api/sessao", (req, res) => {
  const campanha = carregarCampanha();
  res.json({
    empresa: campanha.empresa.nome,
    whatsappAutomatico: pipeline.whatsappAutomatico(),
    rodapeWhatsapp: RODAPE_WHATSAPP,
    modoTeste: Boolean(config.modoTeste.email || config.modoTeste.whatsapp),
    dentroDoHorario: pipeline.dentroDoHorario(campanha.limites),
    nichosSugeridos: campanha.buscas.map((b) => b.nicho),
    cidadesSugeridas: [...new Set(campanha.buscas.flatMap((b) => b.cidades))],
  });
});

app.get("/api/stats", async (req, res) => res.json(await db.estatisticas()));

// Busca no Google Maps pelo painel: mostra o resultado sem salvar.
app.post("/api/maps/buscar", async (req, res) => {
  const { nicho, cidade, quantidade } = req.body ?? {};
  if (!nicho?.trim() || !cidade?.trim()) return res.status(400).json({ erro: "Informe o segmento e a cidade" });
  try {
    res.json(await pipeline.buscarNoMaps(nicho.trim(), cidade.trim(), quantidade));
  } catch (e) {
    res.status(502).json({ erro: e.message });
  }
});

app.post("/api/maps/capturar", async (req, res) => {
  const { empresas, nicho, cidade } = req.body ?? {};
  if (!Array.isArray(empresas) || !empresas.length) return res.status(400).json({ erro: "Selecione ao menos uma empresa" });
  res.json(await pipeline.capturarDoMaps(empresas.slice(0, 100), String(nicho ?? ""), String(cidade ?? "")));
});

/** O que a empresa vai receber de fato, com o rodapé que é adicionado no envio. */
function prepararMensagem({ token, ...m }) {
  const automatico = m.canal === "email" || pipeline.whatsappAutomatico();
  const rodape = m.canal === "email" ? rodapeDescadastro(token) : RODAPE_WHATSAPP;
  return {
    ...m,
    oportunidades: JSON.parse(m.oportunidades || "[]"),
    rodape,
    previa: m.corpo + rodape,
    envioManual: !automatico,
    linkWhatsapp: !automatico ? linkWhatsapp(m.destino, m.corpo) : null,
  };
}

app.get("/api/mensagens", async (req, res) => {
  const mensagens = await db.mensagensPorStatus(req.query.status || "rascunho", 200);
  res.json(mensagens.map(prepararMensagem));
});

app.put("/api/mensagens/:id", async (req, res) => {
  const m = await db.buscarMensagem(req.params.id);
  if (!m || m.status === "enviada") return res.status(400).json({ erro: "Mensagem não editável" });
  const { assunto, corpo } = req.body ?? {};
  if (corpo !== undefined && !String(corpo).trim()) return res.status(400).json({ erro: "A mensagem não pode ficar vazia" });
  await db.atualizarMensagem(m.id, { assunto: assunto ?? m.assunto, corpo: corpo ?? m.corpo });
  res.json(prepararMensagem(await db.buscarMensagem(m.id)));
});

// Aprovar = autorizar o envio. Se estiver no horário e dentro do limite, já envia na hora.
app.post("/api/mensagens/:id/aprovar", async (req, res) => {
  const m = await db.buscarMensagem(req.params.id);
  if (!m || !["rascunho", "erro", "aprovada"].includes(m.status)) return res.status(400).json({ erro: "Mensagem não pode ser aprovada" });
  await db.atualizarMensagem(m.id, { status: "aprovada", erro: null });
  const resultado = await pipeline.enviarMensagem({ ...m, status: "aprovada" }, carregarCampanha());
  res.json(resultado);
});

app.post("/api/mensagens/:id/rejeitar", async (req, res) => {
  const m = await db.buscarMensagem(req.params.id);
  if (!m || m.status === "enviada") return res.status(400).json({ erro: "Mensagem não pode ser rejeitada" });
  await db.atualizarMensagem(m.id, { status: "rejeitada", erro: "rejeitada no painel" });
  res.json({ ok: true });
});

// WhatsApp manual: você abriu o link e enviou pelo seu WhatsApp.
app.post("/api/mensagens/:id/enviada-manual", async (req, res) => {
  const ok = await pipeline.marcarEnviadaManual(req.params.id);
  ok ? res.json({ ok }) : res.status(400).json({ erro: "Não foi possível registrar o envio" });
});

app.get("/api/leads", async (req, res) => {
  const status = String(req.query.status || "contatado").split(",").filter(Boolean).slice(0, 10);
  const leads = await db.listarLeads(status);
  res.json(leads.map(({ token, analise, ...l }) => ({ ...l, oportunidades: JSON.parse(l.oportunidades || "[]") })));
});

app.post("/api/leads/:id/status", async (req, res) => {
  const lead = await db.buscarLead(req.params.id);
  const { status } = req.body ?? {};
  if (!lead || !["respondeu", "sem_interesse", "descartado", "descadastrado"].includes(status))
    return res.status(400).json({ erro: "Status inválido" });
  if (status === "descadastrado") await db.descadastrarLead(lead, "marcado no painel");
  else {
    await db.cancelarPendentes(lead.id, `lead marcado como ${status}`);
    await db.atualizarLead(lead.id, { status });
  }
  res.json({ ok: true });
});

app.get("/api/respostas", async (req, res) => {
  res.json(await db.listarRespostas({ apenasNaoLidas: req.query.naoLidas === "1" }));
});

app.post("/api/respostas/:id/lida", async (req, res) => {
  await db.marcarRespostaLida(req.params.id);
  res.json({ ok: true });
});

const ETAPAS = {
  respostas: (c) => pipeline.verificarRespostas(c),
  descobrir: (c) => pipeline.descobrir(c),
  analisar: () => pipeline.analisar(),
  propor: (c) => pipeline.propor(c),
  followup: (c) => pipeline.criarFollowups(c),
  enviar: (c) => pipeline.enviar(c),
};

// Roda a etapa e devolve o resultado. Quando sobra trabalho (`restantes`), o painel chama de novo.
app.post("/api/etapas/:etapa", async (req, res) => {
  const etapa = ETAPAS[req.params.etapa];
  if (!etapa) return res.status(404).json({ erro: "Etapa desconhecida" });
  res.json(await etapa(carregarCampanha()));
});

app.use("/api", (req, res) => res.status(404).json({ erro: "Rota não encontrada" }));

// Erros não tratados viram JSON (o Express 5 encaminha as rejeições das rotas async para cá).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: err.message || "Erro interno" });
});

export default app;
