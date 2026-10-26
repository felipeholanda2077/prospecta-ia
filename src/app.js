import crypto from "node:crypto";
import express from "express";
import { config, carregarCampanha } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";
import { waitUntil } from "@vercel/functions";
import { carregarCampanhaCompleta, CAMPOS_EMPRESA } from "./campanha.js";
import { assinaturaValida, processarWebhookWhatsapp, processarWebhookUazap } from "./respostas/whatsapp.js";
import { rodapeDescadastro } from "./envio/email.js";
import { linkWhatsapp, RODAPE_WHATSAPP } from "./envio/whatsapp.js";
import * as uazap from "./envio/uazap.js";

export const app = express();
app.set("trust proxy", true);
// Guarda o corpo bruto: a assinatura do webhook do WhatsApp é calculada sobre ele.
app.use(express.json({ limit: "1mb", verify: (req, res, buf) => (req.corpoBruto = buf) }));
app.use(express.urlencoded({ extended: false }));

const escapar = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Descadastro (público) ----------

// Página pública (descadastro), com a marca da empresa da campanha.
const paginaSimples = (titulo, conteudo) => {
  const marca = escapar(carregarCampanha().empresa.nome);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} · ${marca}</title>
<style>
  :root{--bg:#f5f6fb;--card:#fff;--text:#14151f;--muted:#5d6275;--accent:#5b4cf0;--border:#e3e5ef}
  @media (prefers-color-scheme:dark){:root{--bg:#0b0c14;--card:#141625;--text:#eceef8;--muted:#9aa0b8;--accent:#8b7dff;--border:#262940}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);
       font:16px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
  main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:32px 28px;
       box-shadow:0 20px 50px -24px rgba(20,21,40,.35)}
  .marca{font-weight:700;letter-spacing:-.01em;color:var(--accent);margin-bottom:18px}
  h2{margin:0 0 8px;font-size:22px;letter-spacing:-.02em}
  p{color:var(--muted);margin:0 0 20px}
  button{font:inherit;font-weight:600;width:100%;padding:12px 18px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
</style>
</head><body><main><div class="marca">${marca}</div>${conteudo}</main></body></html>`;
};

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
    await processarWebhookWhatsapp(req.body, await carregarCampanhaCompleta());
  } catch (e) {
    console.error("Erro no webhook do WhatsApp:", e);
  }
  res.sendStatus(200);
});

// Webhook da UAZap: o segredo na URL e o token da instância no corpo provam a origem.
app.post("/webhooks/uazap/:segredo", async (req, res) => {
  if (!(await uazap.webhookValido(req.params.segredo, req.body))) return res.sendStatus(401);
  // A UAZap espera resposta rápida; a classificação com IA continua depois (waitUntil na Vercel).
  res.sendStatus(200);
  waitUntil(
    carregarCampanhaCompleta()
      .then((campanha) => processarWebhookUazap(req.body, campanha))
      .catch((e) => console.error("Erro no webhook da UAZap:", e))
  );
});

// ---------- Cron da Vercel (protegido pelo CRON_SECRET) ----------

const TAREFAS_CRON = {
  ciclo: (c) => pipeline.executarCiclo(c),
  respostas: (c) => pipeline.verificarRespostas(c),
  // Chamado várias vezes ao dia (GitHub Actions); só envia em horário comercial.
  envios: (c) => pipeline.rodadaDeEnvios(c),
};

app.get("/api/cron/:tarefa", async (req, res) => {
  const tarefa = TAREFAS_CRON[req.params.tarefa];
  if (!tarefa) return res.sendStatus(404);
  if (!config.cronSecret || req.get("authorization") !== `Bearer ${config.cronSecret}`) return res.sendStatus(401);
  res.json((await tarefa(await carregarCampanhaCompleta())) ?? {});
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

// Só o nome da empresa, para a tela de login (sem dados sensíveis).
app.get("/api/marca", async (req, res) => res.json({ empresa: (await carregarCampanhaCompleta()).empresa.nome }));

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (sessaoValida(req)) return next();
  res.status(401).json({ erro: "Faça login para continuar", login: true });
});

// ---------- API do painel (exige login) ----------

app.get("/api/sessao", async (req, res) => {
  const campanha = await carregarCampanhaCompleta();
  const modo = await pipeline.modoWhatsapp();
  res.json({
    empresa: campanha.empresa.nome,
    modoWhatsapp: modo,
    whatsappAutomatico: modo !== "manual",
    perfilIncompleto: !campanha.empresa.responsavel || !campanha.empresa.telefone,
    horario: campanha.limites.horarioComercial,
    cadencia: campanha.cadencia?.diasUteisEntreEtapas ?? [2, 3],
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
function prepararMensagem({ token, ...m }, modo) {
  const automatico = m.canal === "email" || modo !== "manual";
  const rodape = m.tipo === "resposta" ? "" : m.canal === "email" ? rodapeDescadastro(token) : RODAPE_WHATSAPP;
  return {
    ...m,
    oportunidades: JSON.parse(m.oportunidades || "[]"),
    rodape,
    previa: m.corpo + rodape,
    envioManual: !automatico,
    linkWhatsapp: !automatico ? linkWhatsapp(m.destino, m.corpo, m.tipo !== "resposta") : null,
  };
}

app.get("/api/mensagens", async (req, res) => {
  const mensagens = await db.mensagensPorStatus(req.query.status || "rascunho", 300);
  const modo = await pipeline.modoWhatsapp();
  res.json(mensagens.map((m) => prepararMensagem(m, modo)));
});

app.put("/api/mensagens/:id", async (req, res) => {
  const m = await db.buscarMensagem(req.params.id);
  if (!m || m.status === "enviada") return res.status(400).json({ erro: "Mensagem não editável" });
  const { assunto, corpo } = req.body ?? {};
  if (corpo !== undefined && !String(corpo).trim()) return res.status(400).json({ erro: "A mensagem não pode ficar vazia" });
  await db.atualizarMensagem(m.id, { assunto: assunto ?? m.assunto, corpo: corpo ?? m.corpo });
  res.json(prepararMensagem(await db.buscarMensagem(m.id), await pipeline.modoWhatsapp()));
});

// Aprovar = autorizar o envio. Se estiver no horário e dentro do limite, já envia na hora.
app.post("/api/mensagens/:id/aprovar", async (req, res) => {
  const m = await db.buscarMensagem(req.params.id);
  if (!m || !["rascunho", "erro", "aprovada"].includes(m.status)) return res.status(400).json({ erro: "Mensagem não pode ser aprovada" });
  await db.atualizarMensagem(m.id, { status: "aprovada", erro: null });
  const resultado = await pipeline.enviarMensagem({ ...m, status: "aprovada" }, await carregarCampanhaCompleta());
  res.json(resultado);
});

// Sequência gradual: aprova ou descarta as 3 etapas de um lead em um canal de uma vez.
app.post("/api/sequencias/:leadId/:canal/:acao", async (req, res) => {
  const { leadId, canal, acao } = req.params;
  if (!["email", "whatsapp"].includes(canal)) return res.status(400).json({ erro: "Canal inválido" });
  if (acao === "aprovar") return res.json(await pipeline.aprovarSequencia(leadId, canal, await carregarCampanhaCompleta()));
  if (acao === "rejeitar") {
    await pipeline.rejeitarSequencia(leadId, canal);
    return res.json({ ok: true });
  }
  res.status(404).json({ erro: "Ação desconhecida" });
});

app.post("/api/mensagens/:id/rejeitar", async (req, res) => {
  const m = await db.buscarMensagem(req.params.id);
  if (!m || m.status === "enviada") return res.status(400).json({ erro: "Mensagem não pode ser rejeitada" });
  await db.atualizarMensagem(m.id, { status: "rejeitada", erro: "rejeitada no painel" });
  res.json({ ok: true });
});

// WhatsApp manual: você abriu o link e enviou pelo seu WhatsApp.
app.post("/api/mensagens/:id/enviada-manual", async (req, res) => {
  const ok = await pipeline.marcarEnviadaManual(req.params.id, await carregarCampanhaCompleta());
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

// Envia a próxima mensagem da conversa (a sugestão da IA, revisada por você).
app.post("/api/respostas/:id/enviar", async (req, res) => {
  const r = await pipeline.responderConversa(req.params.id, req.body?.texto, await carregarCampanhaCompleta());
  if (r.manual) {
    const m = await db.buscarMensagem(r.id);
    return res.json({ ...r, linkWhatsapp: linkWhatsapp(m.destino, m.corpo, false) });
  }
  res.json(r);
});

app.get("/api/leads/:id/conversa", async (req, res) => {
  res.json(await db.historicoConversa(req.params.id));
});

// ---------- Configurações ----------

app.get("/api/config", async (req, res) => {
  const campanha = await carregarCampanhaCompleta();
  const u = await uazap.obterConfig();
  res.json({
    empresa: Object.fromEntries(CAMPOS_EMPRESA.map((c) => [c, campanha.empresa[c] ?? ""])),
    uazap: {
      url: u.url,
      tokenDefinido: Boolean(u.token),
      webhook: u.segredoWebhook ? `${config.painel.urlPublica}/webhooks/uazap/•••` : null,
    },
  });
});

app.put("/api/config/empresa", async (req, res) => {
  const dados = Object.fromEntries(CAMPOS_EMPRESA.map((c) => [c, String(req.body?.[c] ?? "").trim().slice(0, 200)]));
  if (!dados.nome) return res.status(400).json({ erro: "Informe o nome da empresa" });
  await db.gravarConfig("empresa", dados);
  res.json({ ok: true });
});

// UAZap: salvar a conexão já aponta o webhook da instância para este sistema.
app.post("/api/uazap/config", async (req, res) => {
  try {
    await uazap.salvarConfig({ url: req.body?.url, token: req.body?.token });
    const webhook = await uazap.configurarWebhook();
    res.json({ ok: true, webhook: webhook.replace(/[^/]+$/, "•••"), status: await uazap.status() });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.get("/api/uazap/status", async (req, res) => {
  try {
    res.json(await uazap.status());
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.post("/api/uazap/conectar", async (req, res) => {
  try {
    res.json(await uazap.conectar(req.body?.telefone));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.post("/api/uazap/desconectar", async (req, res) => {
  try {
    await uazap.desconectar();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

const ETAPAS = {
  respostas: (c) => pipeline.verificarRespostas(c),
  descobrir: (c) => pipeline.descobrir(c),
  analisar: () => pipeline.analisar(),
  propor: (c) => pipeline.propor(c),
  enviar: (c) => pipeline.enviar(c),
};

// Roda a etapa e devolve o resultado. Quando sobra trabalho (`restantes`), o painel chama de novo.
app.post("/api/etapas/:etapa", async (req, res) => {
  const etapa = ETAPAS[req.params.etapa];
  if (!etapa) return res.status(404).json({ erro: "Etapa desconhecida" });
  res.json(await etapa(await carregarCampanhaCompleta()));
});

app.use("/api", (req, res) => res.status(404).json({ erro: "Rota não encontrada" }));

// Erros não tratados viram JSON (o Express 5 encaminha as rejeições das rotas async para cá).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: err.message || "Erro interno" });
});

export default app;
