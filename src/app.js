import crypto from "node:crypto";
import express from "express";
import { config, carregarCampanha } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";
import { waitUntil } from "@vercel/functions";
import { carregarCampanhaCompleta, CAMPOS_EMPRESA, lerAutomacao, AUTOMACAO_PADRAO } from "./campanha.js";
import { contatarIndicados, normalizarNumeroIndicado } from "./respostas/indicacao.js";
import { avaliarConversa, indicadoresDasConversas } from "./respostas/andamento.js";
import { prioridadeNaFila } from "./analise/prioridade.js";
import * as calendly from "./agenda/calendly.js";
import { tokenDoGithubValido } from "./agendamento/github.js";
import { garantirAgendamentoNoBanco, chaveDoBancoValida, statusDoBanco } from "./agendamento/banco.js";
import { enviarNotificacao, statusEmail, testarEmail } from "./envio/email.js";
import { assinaturaValida, processarWebhookWhatsapp, processarWebhookUazap, processarWebhookEvolution } from "./respostas/whatsapp.js";
import { rodapeDescadastro } from "./envio/email.js";
import { linkWhatsapp, RODAPE_WHATSAPP } from "./envio/whatsapp.js";
import * as uazap from "./envio/uazap.js";
import * as evolution from "./envio/evolution.js";
import { testarIA } from "./ia/cliente.js";
import { rodadaDeConteudo, criarPostDeHoje, lerConfigConteudo, agoraEmBrasilia } from "./conteudo/diario.js";
import { lerBaseDeConteudo, gravarBaseDeConteudo } from "./conteudo/base.js";

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

// Webhook da Evolution API: o segredo na URL e o nome da instância no corpo provam a origem.
app.post("/webhooks/evolution/:segredo", async (req, res) => {
  if (!(await evolution.webhookValido(req.params.segredo, req.body))) return res.sendStatus(401);
  res.sendStatus(200);
  waitUntil(
    carregarCampanhaCompleta()
      .then((campanha) => processarWebhookEvolution(req.body, campanha))
      .catch((e) => console.error("Erro no webhook da Evolution:", e))
  );
});

// ---------- Webhook do Calendly (público, validado pela assinatura) ----------

app.post("/webhooks/calendly", async (req, res) => {
  const chave = await calendly.chaveDoWebhook();
  if (!calendly.assinaturaValida(req.get("calendly-webhook-signature"), req.corpoBruto?.toString("utf8"), chave)) {
    return res.sendStatus(401);
  }
  const { event: evento, payload } = req.body ?? {};
  await calendly.registrarAgendamento(evento, payload);
  res.sendStatus(200);
});

// ---------- Cron da Vercel (protegido pelo CRON_SECRET) ----------

const TAREFAS_CRON = {
  // O agendamento diário da Vercel é só uma rodada extra (a cota continua espalhada pelo dia).
  ciclo: (c) => pipeline.rodadaAutomatica(c),
  respostas: (c) => pipeline.verificarRespostas(c),
  // Chamado a cada 10 minutos (GitHub Actions); só envia em horário comercial.
  envios: (c) => pipeline.rodadaAutomatica(c),
  // Chamado a cada minuto pelo agendador do banco: só a próxima empresa nova, quando acabar
  // o intervalo de 5 a 12 minutos desde a anterior.
  novas: (c) => pipeline.enviar(c, { somenteNovas: true, distribuir: Boolean(c.automacao?.ativo) }),
  // A cada 15 minutos: no horário escolhido em Conteúdo, cria o post do dia para o Instagram.
  conteudo: (c) => rodadaDeConteudo(c),
};

const resumoChave = (v) => crypto.createHash("sha256").update(`prospecta-cron:${v}`).digest("hex");

/**
 * Aceita a chave do agendamento de dois jeitos: a CRON_SECRET da Vercel (usada pelo
 * agendamento diário da própria Vercel) ou a chave gerada no painel, que fica só no
 * banco (como resumo) e é a que vai no segredo do GitHub.
 */
async function chaveDoCronValida(recebido) {
  if (!recebido) return false;
  // O agendamento do GitHub manda um token assinado pelo próprio GitHub (sem segredo para copiar).
  if (await tokenDoGithubValido(recebido)) return true;
  // O agendador do banco (pg_cron do Supabase) usa a chave que o próprio sistema gerou.
  if (await chaveDoBancoValida(recebido)) return true;
  if (config.cronSecret && iguais(recebido, config.cronSecret)) return true;
  const salvo = (await db.lerConfig("cron"))?.resumo;
  return Boolean(salvo) && iguais(resumoChave(recebido), salvo);
}

app.get("/api/cron/:tarefa", async (req, res) => {
  const tarefa = TAREFAS_CRON[req.params.tarefa];
  if (!tarefa) return res.sendStatus(404);
  const recebido = String(req.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!(await chaveDoCronValida(recebido))) return res.sendStatus(401);
  if (!["novas", "conteudo"].includes(req.params.tarefa)) await db.gravarEstado("ultima_rodada", new Date().toISOString());
  // Se o agendador do banco ainda não estiver ligado, liga (na primeira rodada que chegar).
  const agendador = await garantirAgendamentoNoBanco().catch((e) => {
    console.error("⚠️  Agendador do banco:", e.message);
    return { ativo: false, erro: e.message };
  });
  const resultado = (await tarefa(await carregarCampanhaCompleta())) ?? {};
  res.json({ ...resultado, agendador: agendador.ativo ? { ...agendador, ...(await statusDoBanco()) } : agendador });
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

// Versão publicada: o painel compara com a que abriu e avisa quando sai uma nova.
const VERSAO = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || String(Date.now());
app.get("/api/versao", (req, res) => res.set("Cache-Control", "no-store").json({ versao: VERSAO }));

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
    automacao: { ativo: campanha.automacao.ativo, respostaAutomatica: campanha.automacao.respostaAutomatica },
    whatsappAutomatico: modo !== "manual",
    whatsappDesconectado: await pipeline.whatsappDesconectado(modo),
    perfilIncompleto: !campanha.empresa.responsavel || !campanha.empresa.telefone,
    horario: campanha.limites.horarioComercial,
    cadencia: campanha.cadencia?.horasEntreEtapas ?? [2, 2],
    diasEntreEmails: campanha.cadencia?.diasEntreEmails ?? [1, 2],
    intervaloEmpresas: [campanha.automacao.intervaloEmpresasMin, campanha.automacao.intervaloEmpresasMax],
    calendly: campanha.automacao.calendly || "",
    rodapeWhatsapp: RODAPE_WHATSAPP,
    modoTeste: Boolean(config.modoTeste.email || config.modoTeste.whatsapp),
    dentroDoHorario: pipeline.dentroDoHorario(campanha.limites),
    nichosSugeridos: campanha.buscas.map((b) => b.nicho),
    cidadesSugeridas: [...new Set(campanha.buscas.flatMap((b) => b.cidades))],
  });
});

app.get("/api/stats", async (req, res) => res.json(await db.estatisticas()));

// Falhas de conexão vistas pelo navegador (o painel envia na próxima chamada que funciona).
app.post("/api/diagnostico", (req, res) => {
  const falhas = Array.isArray(req.body?.falhas) ? req.body.falhas.slice(0, 10) : [];
  for (const f of falhas) {
    const campo = (v) => String(v ?? "").slice(0, 200);
    console.warn(`⚠️  Falha no navegador: ${campo(f.metodo)} ${campo(f.caminho)} · ${campo(f.mensagem)} · ${campo(f.quando)} · online=${f.online}`);
  }
  res.json({ ok: true });
});

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
  const status = req.query.status || "rascunho";
  const mensagens = await db.mensagensPorStatus(status, 300);
  const modo = await pipeline.modoWhatsapp();
  // Nas enviadas, mostra qual etapa vem depois e quando (se a empresa não responder).
  const proximas = status === "enviada" ? await db.proximasEtapas([...new Set(mensagens.map((m) => m.lead_id))]) : [];
  const proximaDe = (m) => proximas.find((p) => p.lead_id === m.lead_id && p.canal === m.canal && p.etapa > m.etapa) ?? null;
  // Na fila, a prioridade de cada empresa: conversas pela chance de fechar, as novas pelo potencial.
  let prioridadeDe = () => undefined;
  if (status === "aprovada") {
    const andamentos = new Map((await conversasAvaliadas()).map((c) => [c.id, c.andamento]));
    const porLead = new Map();
    for (const m of mensagens) porLead.set(m.lead_id, [...(porLead.get(m.lead_id) ?? []), m]);
    const calculada = new Map([...porLead].map(([id, ms]) => [id, prioridadeNaFila(ms[0], {
      andamento: andamentos.get(id) ?? null,
      temResposta: ms.some((x) => x.tipo === "resposta"),
      canais: [...new Set(ms.map((x) => x.canal))],
    })]));
    prioridadeDe = (m) => calculada.get(m.lead_id);
  }
  res.json(mensagens.map((m) => ({
    ...prepararMensagem(m, modo),
    proxima: status === "enviada" ? proximaDe(m) : undefined,
    prioridade: prioridadeDe(m),
  })));
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

// Volta a empresa para a análise; o painel roda a análise e as propostas em seguida.
app.post("/api/leads/:id/reanalisar", async (req, res) => {
  try {
    await pipeline.reanalisar(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// "Não enviar nada para esta empresa" na fila: cancela tudo o que estava para sair.
app.post("/api/leads/:id/cancelar-fila", async (req, res) => {
  await db.cancelarPendentes(req.params.id, "cancelado por você na fila de envio");
  res.json({ ok: true });
});

// Contato indicado informado por você (ex.: passaram o número por ligação ou o cartão chegou antes):
// a IA escreve para ele citando a indicação, e a conversa segue sozinha.
app.post("/api/leads/:id/indicado", async (req, res) => {
  try {
    const lead = await db.buscarLead(req.params.id);
    if (!lead) return res.status(404).json({ erro: "Empresa não encontrada" });
    const informado = String(req.body?.contato ?? req.body?.telefone ?? "").trim();
    const nome = String(req.body?.nome ?? "").trim().slice(0, 80);
    let contato;
    if (informado.includes("@")) {
      const email = informado.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return res.status(400).json({ erro: "E-mail inválido" });
      contato = { canal: "email", nome, empresa: lead.nome, email };
    } else {
      const numero = normalizarNumeroIndicado(informado);
      if (numero.length < 12) return res.status(400).json({ erro: "Informe o WhatsApp com DDD (ex.: 11 96548-1483) ou um e-mail" });
      contato = { canal: "whatsapp", nome, empresa: lead.nome, numero };
    }
    const quem = String(req.body?.quemIndicou ?? "").trim().slice(0, 80) || null;
    const feitos = await contatarIndicados({ lead, contatos: [contato], nomeDeQuemIndicou: quem, campanha: await carregarCampanhaCompleta(), manual: true });
    if (!feitos.length) return res.status(400).json({ erro: `Não vou escrever para esse contato: ${feitos.ignorados[0]?.motivo ?? "número inválido"}` });
    res.json({ ok: true, mensagem: feitos[0].corpo, agendadaPara: feitos[0].agendadaPara });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// ---------- Conversas (página de Respostas em formato de chat) ----------

/** Conversas com a avaliação de andamento, das mais importantes para as menos. */
async function conversasAvaliadas() {
  const lista = (await db.conversas()).map((c) => ({ ...c, andamento: avaliarConversa(c) }));
  const quando = (c) => new Date(c.ultima?.quando ?? 0).getTime();
  // Quem precisa de você primeiro; depois quem tem mais chance de fechar; depois as mais recentes.
  const chance = (c) => ({ agendada: 4, quente: 3, morna: 2, fria: 1, encerrada: 0 })[c.andamento.chance] ?? 0;
  return lista.sort((a, b) => Number(b.andamento.precisaDeVoce) - Number(a.andamento.precisaDeVoce)
    || chance(b) - chance(a) || quando(b) - quando(a));
}

app.get("/api/conversas", async (req, res) => {
  const conversas = await conversasAvaliadas();
  res.json({ indicadores: indicadoresDasConversas(conversas, await db.funilDeConversas()), conversas });
});

app.get("/api/conversas/:leadId", async (req, res) => {
  const lead = await db.buscarLead(req.params.leadId);
  if (!lead) return res.status(404).json({ erro: "Empresa não encontrada" });
  const conversa = (await conversasAvaliadas()).find((c) => c.id === lead.id) ?? null;
  const resposta = await db.ultimaRespostaDaConversa(lead.id);
  const { token, analise, ...dados } = lead;
  res.json({
    lead: { ...dados, oportunidades: JSON.parse(dados.oportunidades || "[]") },
    andamento: conversa?.andamento ?? null,
    mensagens: await db.historicoConversa(lead.id),
    agendadas: await db.agendadasDaConversa(lead.id),
    // A sugestão da IA vai para a caixa de resposta quando ninguém respondeu ainda a última mensagem.
    resposta: resposta && {
      id: resposta.id, canal: resposta.canal, de: resposta.de, precisa_humano: resposta.precisa_humano,
      sugestao: conversa?.andamento?.aguardando === "nos" && !resposta.mensagem_id ? resposta.sugestao : null,
      resumo: resposta.resumo,
    },
  });
});

app.post("/api/conversas/:leadId/lida", async (req, res) => {
  await db.marcarConversaLida(req.params.leadId);
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
  const ev = await evolution.obterConfig();
  res.json({
    empresa: Object.fromEntries(CAMPOS_EMPRESA.map((c) => [c, campanha.empresa[c] ?? ""])),
    uazap: {
      url: u.url,
      tokenDefinido: Boolean(u.token),
      webhook: u.segredoWebhook ? `${config.painel.urlPublica}/webhooks/uazap/•••` : null,
    },
    evolution: {
      url: ev.url,
      instancia: ev.instancia,
      apikeyDefinida: Boolean(ev.apikey),
      webhook: ev.segredoWebhook ? `${config.painel.urlPublica}/webhooks/evolution/•••` : null,
    },
  });
});

// Funil automático: liga/desliga, metas por canal, buscas e resposta automática da IA.
app.get("/api/config/automacao", async (req, res) => {
  const campanha = await carregarCampanhaCompleta();
  const auto = await lerAutomacao();
  res.json({
    ...auto,
    buscas: campanha.buscas,
    hoje: {
      email: { enviadas: await db.enviadasHoje("email", { primeiroContato: true }), limite: await pipeline.limiteDoDia(campanha, "email") },
      whatsapp: { enviadas: await db.enviadasHoje("whatsapp", { primeiroContato: true }), limite: await pipeline.limiteDoDia(campanha, "whatsapp") },
    },
    calendlyConectado: (await calendly.status()).conectado,
    proximaEmpresaNova: await pipeline.proximaEmpresaNovaEm(),
  });
});

app.put("/api/config/automacao", async (req, res) => {
  const b = req.body ?? {};
  const inteiro = (v, min, max, padrao) => Math.min(max, Math.max(min, Number.parseInt(v, 10) || padrao));
  const lista = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/\n|,/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  const nichos = lista(b.nichos);
  const cidades = lista(b.cidades);
  const calendlyLink = String(b.calendly ?? "").trim();
  if (calendlyLink && !/^https:\/\/(www\.)?calendly\.com\//i.test(calendlyLink)) {
    return res.status(400).json({ erro: "O link do Calendly deve começar com https://calendly.com/" });
  }
  if (b.ativo && (!nichos.length || !cidades.length)) {
    return res.status(400).json({ erro: "Para ligar o modo automático, informe ao menos um segmento e uma cidade" });
  }
  const intervaloMin = inteiro(b.intervaloEmpresasMin, 1, 60, AUTOMACAO_PADRAO.intervaloEmpresasMin);
  const novo = {
    ativo: Boolean(b.ativo),
    respostaAutomatica: Boolean(b.respostaAutomatica),
    metaDiaria: { email: inteiro(b.metaEmail, 0, 500, AUTOMACAO_PADRAO.metaDiaria.email), whatsapp: inteiro(b.metaWhatsapp, 0, 300, AUTOMACAO_PADRAO.metaDiaria.whatsapp) },
    aquecimentoWhatsapp: b.aquecimentoWhatsapp !== false,
    aquecimentoInicial: inteiro(b.aquecimentoInicial, 5, 300, AUTOMACAO_PADRAO.aquecimentoInicial),
    aquecimentoPasso: inteiro(b.aquecimentoPasso, 0, 100, AUTOMACAO_PADRAO.aquecimentoPasso),
    intervaloEmpresasMin: intervaloMin,
    intervaloEmpresasMax: Math.max(intervaloMin, inteiro(b.intervaloEmpresasMax, 1, 120, AUTOMACAO_PADRAO.intervaloEmpresasMax)),
    maxRespostasIA: inteiro(b.maxRespostasIA, 1, 20, AUTOMACAO_PADRAO.maxRespostasIA),
    calendly: calendlyLink,
    buscas: nichos.length && cidades.length ? nichos.map((nicho) => ({ nicho, cidades })) : null,
  };
  await db.gravarConfig("automacao", novo);
  res.json({ ok: true });
});

app.get("/api/email/status", (req, res) => res.json(statusEmail()));

// ---------- Conteúdo para o Instagram ----------

app.get("/api/conteudo", async (req, res) => {
  const conf = await lerConfigConteudo();
  res.json({ config: conf, base: await lerBaseDeConteudo(), hoje: agoraEmBrasilia().dia, posts: await db.postsRecentes(14) });
});

app.put("/api/conteudo/config", async (req, res) => {
  const horario = Number.parseInt(req.body?.horario, 10);
  if (!(horario >= 6 && horario <= 23)) return res.status(400).json({ erro: "Escolha um horário entre 6h e 23h" });
  await db.gravarConfig("conteudo", { ativo: req.body?.ativo !== false, horario });
  if (typeof req.body?.base === "string") await gravarBaseDeConteudo(req.body.base);
  res.json({ ok: true });
});

// Cria agora um post para hoje (além do que já existir).
app.post("/api/conteudo/gerar", async (req, res) => {
  const formato = ["reels", "carrossel"].includes(req.body?.formato) ? req.body.formato : undefined;
  res.json(await criarPostDeHoje(await carregarCampanhaCompleta(), { formato }));
});

// Descarta o post e cria outro do mesmo formato no lugar.
app.post("/api/conteudo/:id/refazer", async (req, res) => {
  const post = await db.buscarPost(req.params.id);
  if (!post) return res.status(404).json({ erro: "Post não encontrado" });
  const novo = await criarPostDeHoje(await carregarCampanhaCompleta(), { formato: post.formato });
  await db.atualizarStatusPost(post.id, "descartado");
  res.json(novo);
});

app.post("/api/conteudo/:id/status", async (req, res) => {
  const status = req.body?.status;
  if (!["pronto", "postado", "descartado"].includes(status)) return res.status(400).json({ erro: "Status inválido" });
  if (!(await db.buscarPost(req.params.id))) return res.status(404).json({ erro: "Post não encontrado" });
  await db.atualizarStatusPost(req.params.id, status);
  res.json({ ok: true });
});

app.post("/api/ia/teste", async (req, res) => {
  try {
    res.json({ ok: true, ...(await testarIA()) });
  } catch (e) {
    res.status(502).json({ ok: false, modelo: config.claude.model, erro: e.message });
  }
});

// Envia um e-mail de teste e confere a leitura da caixa de entrada.
app.post("/api/email/teste", async (req, res) => res.json(await testarEmail(req.body?.para)));

// Gera a chave do agendamento (mostrada uma única vez) para colar no segredo CRON_SECRET do GitHub.
app.post("/api/agendamento/chave", async (req, res) => {
  const chave = crypto.randomBytes(32).toString("hex");
  await db.gravarConfig("cron", { resumo: resumoChave(chave), criada: new Date().toISOString() });
  res.json({ chave });
});

app.get("/api/agendamento/status", async (req, res) => {
  const c = await db.lerConfig("cron");
  res.json({
    chaveGerada: Boolean(c?.resumo),
    criada: c?.criada ?? null,
    ultimaRodada: await db.lerEstado("ultima_rodada"),
    banco: await statusDoBanco(),
  });
});

// Liga (ou refaz) o agendador do banco pelo painel.
app.post("/api/agendamento/banco", async (req, res) => {
  try {
    res.json({ ...(await garantirAgendamentoNoBanco({ forcar: true })), banco: await statusDoBanco() });
  } catch (e) {
    res.status(400).json({ erro: `Não foi possível ligar o agendador do banco: ${e.message}` });
  }
});

app.get("/api/calendly/status", async (req, res) => res.json(await calendly.status()));

app.post("/api/calendly/conectar", async (req, res) => {
  try {
    res.json(await calendly.conectar(req.body?.token));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
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

// Evolution API: alternativa à UAZap, com as mesmas ações no painel.
app.post("/api/evolution/config", async (req, res) => {
  try {
    await evolution.salvarConfig({ url: req.body?.url, apikey: req.body?.apikey, instancia: req.body?.instancia });
    const webhook = await evolution.configurarWebhook();
    res.json({ ok: true, webhook: webhook.replace(/[^/]+$/, "•••"), status: await evolution.status() });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.get("/api/evolution/status", async (req, res) => {
  try {
    res.json(await evolution.status());
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.post("/api/evolution/conectar", async (req, res) => {
  try {
    res.json(await evolution.conectar(req.body?.telefone));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// Diagnóstico: o que chegou no WhatsApp nas últimas horas e se o sistema registrou.
app.get("/api/whatsapp/recebidas", async (req, res) => {
  const horas = Math.min(48, Math.max(1, Number(req.query.horas) || 6));
  const registros = await evolution.buscarMensagens({ horas });
  const lista = [];
  for (const r of registros) {
    const k = r.key ?? {};
    if (String(k.remoteJid ?? "").endsWith("@g.us")) continue;
    const m = evolution.extrairMensagemEvolution({ event: "messages.upsert", data: r });
    lista.push({
      quando: new Date(Number(r.messageTimestamp) * 1000).toISOString(),
      deMim: Boolean(k.fromMe), remoteJid: k.remoteJid, alt: k.remoteJidAlt ?? k.senderPn ?? null, nome: r.pushName ?? null,
      tipo: r.messageType, texto: String(r.message?.conversation ?? r.message?.extendedTextMessage?.text ?? "").slice(0, 80),
      lido: m ? { de: m.de, registrada: await db.respostaJaRegistrada(m.id) } : null,
    });
  }
  res.json(lista);
});

app.post("/api/evolution/desconectar", async (req, res) => {
  try {
    await evolution.desconectar();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

const ETAPAS = {
  automatica: (c) => pipeline.rodadaAutomatica(c),
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
