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
import * as whatsappOficial from "./envio/whatsapp.js";
import * as uazap from "./envio/uazap.js";
import * as evolution from "./envio/evolution.js";
import { testarIA } from "./ia/cliente.js";
import { rodadaDeConteudo, criarPostDeHoje, lerConfigConteudo, agoraEmBrasilia, normalizarHorarios } from "./conteudo/diario.js";
import { lerBaseDeConteudo, gravarBaseDeConteudo } from "./conteudo/base.js";
import { postarNoInstagram, assinaturaDaMidia, gerarArquivos } from "./conteudo/instagram.js";
import { narracaoDisponivel } from "./conteudo/narracao.js";
import { lerChavePexels, salvarChavePexels } from "./conteudo/fotos.js";
import { lerConfigAvatar, salvarConfigAvatar, testarAvatar } from "./conteudo/avatar.js";
import { rotinaDeInsights, desempenho, atualizarInsights, gerarAprendizados, lerAprendizados } from "./conteudo/insights.js";
import { statusDaConexao, conectarInstagram, desconectarInstagram, configDoDirect, salvarConfigDoDirect, statusDoDirect, assinarWebhookDoDirect } from "./envio/instagram.js";
import { processarWebhookInstagram } from "./respostas/instagram.js";
import { receberFormulario, lerConfigFormulario, salvarConfigFormulario } from "./respostas/formulario.js";
import { paginaDoFormulario, paginaDeObrigado } from "./paginaContato.js";
import * as contratos from "./contratos/contrato.js";
import { documentoEmHtml, documentoEmPdf, ROTULOS_CAMPOS } from "./contratos/documento.js";
import { lerApresentacao, gravarApresentacao } from "./respostas/apresentacao.js";
import { escreverApresentacao } from "./ia/resposta.js";
import { marcarApresentacaoEnviada, continuarComIA, pausarIA, iaPausada } from "./respostas/processar.js";

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

// ---------- Formulário de contato do site (público) ----------

// O site da empresa pode mandar o próprio formulário para cá (de outro domínio).
const liberarOutroSite = (res) => res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });

app.get("/contato", async (req, res) => {
  const campanha = await carregarCampanhaCompleta();
  res.set("Cache-Control", "no-store").send(paginaDoFormulario({
    empresa: campanha.empresa.nome, servicos: campanha.servicos, origem: String(req.query.origem ?? "").slice(0, 40), embed: req.query.embed === "1",
  }));
});

app.options("/contato", (req, res) => liberarOutroSite(res).sendStatus(204));

// JSON (pelo formulário com JavaScript ou pelo site) responde JSON; o envio sem JavaScript recebe a página.
app.post("/contato", async (req, res) => {
  liberarOutroSite(res);
  const campanha = await carregarCampanhaCompleta();
  const comoJson = req.is("application/json");
  let r;
  try {
    r = await receberFormulario(req.body ?? {}, campanha, { ip: req.ip });
  } catch (e) {
    console.error("Erro no formulário do site:", e);
    r = { erro: "Não foi possível enviar agora. Tente de novo em instantes." };
  }
  if (comoJson) return res.status(r.erro ? 400 : 200).json(r.erro ? { erro: r.erro } : { ok: true });
  const embed = String(req.body?.embed ?? "") === "1";
  res.status(r.erro ? 400 : 200).send(r.erro
    ? paginaDoFormulario({ empresa: campanha.empresa.nome, servicos: campanha.servicos, origem: req.body?.origem, embed, erro: r.erro })
    : paginaDeObrigado({ empresa: campanha.empresa.nome, embed }));
});

// ---------- Webhook do WhatsApp (público, validado pela assinatura da Meta) ----------

// Verificação feita pela Meta ao cadastrar a URL do webhook.
app.get("/webhooks/whatsapp", async (req, res) => {
  const { verifyToken } = await whatsappOficial.obterConfig();
  const ok = req.query["hub.mode"] === "subscribe" && verifyToken && req.query["hub.verify_token"] === verifyToken;
  ok ? res.send(req.query["hub.challenge"]) : res.sendStatus(403);
});

app.post("/webhooks/whatsapp", async (req, res) => {
  const { appSecret } = await whatsappOficial.obterConfig();
  if (!assinaturaValida(req.corpoBruto, req.get("x-hub-signature-256"), appSecret)) {
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
  const numero = await uazap.webhookValido(req.params.segredo, req.body);
  if (!numero) return res.sendStatus(401);
  // A UAZap espera resposta rápida; a classificação com IA continua depois (waitUntil na Vercel).
  res.sendStatus(200);
  waitUntil(
    carregarCampanhaCompleta()
      .then((campanha) => processarWebhookUazap(req.body, campanha, numero.id))
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

// ---------- Webhook do Instagram (público, validado pela assinatura da Meta) ----------

// Verificação feita pela Meta ao cadastrar a URL do webhook no app (produto Instagram).
app.get("/webhooks/instagram", async (req, res) => {
  const { verifyToken } = await configDoDirect();
  const ok = req.query["hub.mode"] === "subscribe" && verifyToken && req.query["hub.verify_token"] === verifyToken;
  ok ? res.send(req.query["hub.challenge"]) : res.sendStatus(403);
});

// Mensagens do direct e comentários nos posts. A Meta espera resposta rápida: a IA trabalha depois (waitUntil).
app.post("/webhooks/instagram", async (req, res) => {
  const { appSecret } = await configDoDirect();
  if (!assinaturaValida(req.corpoBruto, req.get("x-hub-signature-256"), appSecret)) return res.sendStatus(401);
  res.sendStatus(200);
  waitUntil(
    carregarCampanhaCompleta()
      .then((campanha) => processarWebhookInstagram(req.body, campanha))
      .catch((e) => console.error("Erro no webhook do Instagram:", e))
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
  // Quando não há post para criar ou publicar, lê os insights (a cada 6 h) e atualiza os aprendizados.
  conteudo: async (c) => {
    const r = await rodadaDeConteudo(c);
    if (["criado", "publicando"].includes(r.conteudo)) return r;
    return { ...r, insights: await rotinaDeInsights().catch((e) => ({ erro: e.message })) };
  },
  // A cada 2 minutos, a qualquer hora: as respostas da IA no direct do Instagram.
  instagram: (c) => pipeline.enviarInstagram(c),
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
  if (!["novas", "conteudo", "instagram"].includes(req.params.tarefa)) await db.gravarEstado("ultima_rodada", new Date().toISOString());
  // Se o agendador do banco ainda não estiver ligado, liga (na primeira rodada que chegar).
  const agendador = await garantirAgendamentoNoBanco().catch((e) => {
    console.error("⚠️  Agendador do banco:", e.message);
    return { ativo: false, erro: e.message };
  });
  const resultado = (await tarefa(await carregarCampanhaCompleta())) ?? {};
  res.json({ ...resultado, agendador: agendador.ativo ? { ...agendador, ...(await statusDoBanco()) } : agendador });
});

// Imagens e vídeos dos posts, para o Instagram baixar na hora de publicar (link assinado, sem login).
app.get("/api/midia/:chave", async (req, res) => {
  const { chave } = req.params;
  if (!iguais(String(req.query.a ?? ""), assinaturaDaMidia(chave))) return res.sendStatus(403);
  const midia = await db.lerMidia(chave);
  if (!midia) return res.sendStatus(404);
  res.set({ "Content-Type": midia.tipo, "Cache-Control": "private, max-age=3600" }).send(midia.dados);
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
    numerosWhatsapp: modo === "uazap" ? (await uazap.conectados()).length : null,
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
    directs: { hoje: await db.enviadasHoje("instagram", { primeiroContato: true }), limite: pipeline.LIMITE_DIRECT_DIA },
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

// Busca no Instagram pelo painel (perfis comerciais das hashtags ou os @ informados), sem salvar.
app.post("/api/instagram/buscar", async (req, res) => {
  const { nicho, cidade, termos, quantidade } = req.body ?? {};
  if (!nicho?.trim() || !cidade?.trim()) return res.status(400).json({ erro: "Informe o segmento e a cidade" });
  try {
    res.json(await pipeline.buscarNoInstagram(nicho.trim(), cidade.trim(), String(termos ?? ""), quantidade));
  } catch (e) {
    res.status(502).json({ erro: e.message });
  }
});

app.post("/api/instagram/capturar", async (req, res) => {
  const { empresas, nicho, cidade } = req.body ?? {};
  if (!Array.isArray(empresas) || !empresas.length) return res.status(400).json({ erro: "Selecione ao menos uma empresa" });
  res.json(await pipeline.capturarDoInstagram(empresas.slice(0, 100), String(nicho ?? ""), String(cidade ?? "")));
});

// Busca pelo CNPJ (dados abertos da Receita Federal): atividade do segmento + cidade.
app.post("/api/cnpj/buscar", async (req, res) => {
  const { nicho, cidade, quantidade, cnae, incluirMei, abertasHaDias } = req.body ?? {};
  if (!String(nicho ?? "").trim() || !String(cidade ?? "").trim()) return res.status(400).json({ erro: "Informe o segmento e a cidade" });
  try {
    res.json(await pipeline.buscarNoCnpj(nicho.trim(), cidade.trim(), { quantidade, cnae, incluirMei: Boolean(incluirMei), abertasHaDias }));
  } catch (e) {
    res.status(502).json({ erro: e.message });
  }
});

app.post("/api/cnpj/capturar", async (req, res) => {
  const { empresas, nicho, cidade } = req.body ?? {};
  if (!Array.isArray(empresas) || !empresas.length) return res.status(400).json({ erro: "Selecione ao menos uma empresa" });
  res.json(await pipeline.capturarDoCnpj(empresas.slice(0, 100), String(nicho ?? ""), String(cidade ?? "")));
});

app.post("/api/maps/capturar", async (req, res) => {
  const { empresas, nicho, cidade } = req.body ?? {};
  if (!Array.isArray(empresas) || !empresas.length) return res.status(400).json({ erro: "Selecione ao menos uma empresa" });
  res.json(await pipeline.capturarDoMaps(empresas.slice(0, 100), String(nicho ?? ""), String(cidade ?? "")));
});

/** O que a empresa vai receber de fato, com o rodapé que é adicionado no envio. */
function prepararMensagem({ token, ...m }, modo) {
  // O primeiro direct do Instagram sai sempre pela sua mão: o painel abre a conversa com a empresa.
  const directManual = m.canal === "instagram" && m.tipo !== "resposta";
  const automatico = !directManual && (m.canal !== "whatsapp" || modo !== "manual");
  const rodape = m.tipo === "resposta" || m.canal === "instagram" ? "" : m.canal === "email" ? rodapeDescadastro(token) : RODAPE_WHATSAPP;
  return {
    ...m,
    oportunidades: JSON.parse(m.oportunidades || "[]"),
    rodape,
    previa: m.corpo + rodape,
    envioManual: !automatico,
    linkWhatsapp: directManual ? `https://ig.me/m/${encodeURIComponent(m.destino.replace(/^@/, ""))}`
      : !automatico ? linkWhatsapp(m.destino, m.corpo, m.tipo !== "resposta") : null,
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
  if (!["email", "whatsapp", "instagram"].includes(canal)) return res.status(400).json({ erro: "Canal inválido" });
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
  const lista = (await db.conversas()).map((c) => {
    const andamento = avaliarConversa(c);
    // Já demonstrou interesse e a conversa não foi encerrada: ganha coroa e destaque no painel.
    return { ...c, andamento, interessado: Boolean(c.mostrou_interesse) && andamento.chance !== "encerrada" };
  });
  const quando = (c) => new Date(c.ultima?.quando ?? 0).getTime();
  // Quem precisa de você primeiro; depois quem demonstrou interesse; depois quem tem mais chance de fechar; depois as mais recentes.
  const chance = (c) => ({ fechada: 5, agendada: 4, quente: 3, morna: 2, fria: 1, encerrada: 0 })[c.andamento.chance] ?? 0;
  return lista.sort((a, b) => Number(b.andamento.precisaDeVoce) - Number(a.andamento.precisaDeVoce)
    || Number(b.interessado) - Number(a.interessado) || chance(b) - chance(a) || quando(b) - quando(a));
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
    interessado: conversa?.interessado ?? false,
    iaPausada: (await iaPausada(lead.id)) || null,
    numeroWhatsapp: lead.numero_wa ? (await uazap.numero(lead.numero_wa))?.nome ?? null : null,
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
// Para a IA nesta conversa (ex.: do outro lado é um robô): nada mais sai e as mensagens não gastam IA.
app.post("/api/leads/:id/pausar-ia", async (req, res) => {
  const lead = await db.buscarLead(req.params.id);
  if (!lead) return res.status(404).json({ erro: "Empresa não encontrada" });
  await pausarIA(lead.id, String(req.body?.motivo || "você parou a IA nesta conversa").slice(0, 200));
  await db.cancelarPendentes(lead.id, "IA parada nesta conversa");
  res.json({ ok: true });
});

// Conversa que a IA passou para você: ela retoma e responde sozinha.
app.post("/api/respostas/:id/ia-continua", async (req, res) => {
  res.json(await continuarComIA(req.params.id, await carregarCampanhaCompleta(), { nota: req.body?.nota }));
});

// Escreve a apresentação (processo, planos, prazo e convite) para esta conversa, sem enviar: você revisa e envia
// (já conta como apresentada, para a IA não mandar de novo).
app.post("/api/respostas/:id/apresentacao", async (req, res) => {
  const r = await db.buscarResposta(req.params.id);
  if (!r) return res.status(404).json({ erro: "Resposta não encontrada" });
  const campanha = await carregarCampanhaCompleta();
  const lead = await db.buscarLead(r.lead_id);
  const texto = await escreverApresentacao({
    texto: r.texto, lead, historico: await db.historicoConversa(lead.id), campanha, canal: r.canal,
    apresentacao: await lerApresentacao(), linkAgendamento: calendly.linkAgendamento(campanha.automacao?.calendly, lead, r.canal),
  });
  await marcarApresentacaoEnviada(lead.id);
  res.json({ texto });
});

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
  const numerosUazap = await uazap.numeros();
  const ev = await evolution.obterConfig();
  const wa = await whatsappOficial.obterConfig();
  res.json({
    empresa: Object.fromEntries(CAMPOS_EMPRESA.map((c) => [c, campanha.empresa[c] ?? ""])),
    uazap: {
      url: numerosUazap[0]?.url ?? "",
      numeros: numerosUazap.map((n) => ({ id: n.id, nome: n.nome, url: n.url, tokenDefinido: Boolean(n.token) })),
    },
    evolution: {
      url: ev.url,
      instancia: ev.instancia,
      apikeyDefinida: Boolean(ev.apikey),
      webhook: ev.segredoWebhook ? `${config.painel.urlPublica}/webhooks/evolution/•••` : null,
    },
    // O token de verificação não é segredo de terceiros: é gerado aqui e você cola na Meta.
    oficial: {
      ativo: wa.ativo,
      phoneNumberId: wa.phoneNumberId,
      tokenDefinido: Boolean(wa.token),
      appSecretDefinido: Boolean(wa.appSecret),
      template: wa.template,
      idioma: wa.idioma,
      webhook: `${config.painel.urlPublica}/webhooks/whatsapp`,
      verifyToken: wa.verifyToken || null,
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
    apresentacao: await lerApresentacao(),
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
    buscarNoInstagram: b.buscarNoInstagram !== false,
    buscarPorCnpj: b.buscarPorCnpj !== false,
    buscas: nichos.length && cidades.length ? nichos.map((nicho) => ({ nicho, cidades })) : null,
  };
  await db.gravarConfig("automacao", novo);
  if (b.apresentacao !== undefined) await gravarApresentacao(b.apresentacao);
  res.json({ ok: true });
});

app.get("/api/email/status", (req, res) => res.json(statusEmail()));

// ---------- Conteúdo para o Instagram ----------

app.get("/api/conteudo", async (req, res) => {
  const conf = await lerConfigConteudo();
  res.json({
    config: conf, base: await lerBaseDeConteudo(), hoje: agoraEmBrasilia().dia, posts: await db.postsRecentes(14),
    instagram: await statusDaConexao(), narracao: narracaoDisponivel(), pexels: Boolean(await lerChavePexels()),
  });
});

app.put("/api/conteudo/config", async (req, res) => {
  const horarios = normalizarHorarios(req.body?.horarios ?? req.body?.horario);
  if (!horarios.length) return res.status(400).json({ erro: "Escolha ao menos um horário entre 6h e 23h" });
  if (horarios.length > 4) return res.status(400).json({ erro: "Escolha no máximo 4 horários por dia" });
  await db.gravarConfig("conteudo", { ativo: req.body?.ativo !== false, horarios, postarSozinho: req.body?.postarSozinho !== false, apresentador: req.body?.apresentador !== false });
  if (String(req.body?.pexels ?? "").trim()) await salvarChavePexels(req.body.pexels);
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
  const novo = await criarPostDeHoje(await carregarCampanhaCompleta(), { formato: post.formato, horario: post.horario });
  await db.atualizarStatusPost(post.id, "descartado");
  res.json(novo);
});

// Publica agora no Instagram (também serve para tentar de novo depois de um erro).
app.post("/api/conteudo/:id/instagram", async (req, res) => {
  const post = await db.buscarPost(req.params.id);
  if (!post) return res.status(404).json({ erro: "Post não encontrado" });
  if (post.status === "descartado") return res.status(400).json({ erro: "Esse post foi descartado" });
  await db.atualizarInstagramDoPost(post.id, { instagram_tentativas: 0 });
  const r = await postarNoInstagram(post.id, await carregarCampanhaCompleta());
  if (r.instagram === "desconectado") return res.status(400).json({ erro: "Conecte o Instagram primeiro" });
  if (r.instagram === "erro") return res.status(502).json({ erro: r.erro });
  res.json(r);
});

// O Reels em MP4, com a trilha e a voz, para baixar pelo painel (o mesmo vídeo que vai para o Instagram).
app.get("/api/conteudo/:id/video", async (req, res) => {
  const post = await db.buscarPost(req.params.id);
  if (!post || post.formato !== "reels") return res.status(404).json({ erro: "Reels não encontrado" });
  const [video] = await gerarArquivos(post, (await carregarCampanhaCompleta()).empresa.nome);
  res.set({ "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="fluxdeck-${post.dia}-reels.mp4"` }).send(video.dados);
});

// O avatar de IA do Felipe (HeyGen). A chave nunca volta para o navegador.
const avatarParaPainel = ({ chave, ...c }) => ({ ...c, chaveDefinida: Boolean(chave) });
app.get("/api/avatar", async (req, res) => res.json(avatarParaPainel(await lerConfigAvatar())));
app.put("/api/avatar", async (req, res) => {
  const { ativo, chave, avatarId, vozId } = req.body ?? {};
  res.json(avatarParaPainel(await salvarConfigAvatar({ ativo, chave, avatarId, vozId })));
});
app.post("/api/avatar/testar", async (req, res) => {
  try {
    res.json(await testarAvatar());
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// As fotos dos posts, para as prévias do painel.
app.get("/api/foto/:chave", async (req, res) => {
  if (!req.params.chave.startsWith("foto-")) return res.sendStatus(404);
  const midia = await db.lerMidia(req.params.chave);
  if (!midia) return res.sendStatus(404);
  res.set({ "Content-Type": midia.tipo, "Cache-Control": "private, max-age=86400" }).send(midia.dados);
});

// Diagnóstico: gera os arquivos do post no servidor (sem publicar) e diz o tamanho e o tempo.
app.post("/api/conteudo/:id/testar-arquivos", async (req, res) => {
  const post = await db.buscarPost(req.params.id);
  if (!post) return res.status(404).json({ erro: "Post não encontrado" });
  const inicio = Date.now();
  const arquivos = await gerarArquivos(post, (await carregarCampanhaCompleta()).empresa.nome);
  res.json({ ms: Date.now() - inicio, arquivos: arquivos.map((a) => ({ chave: a.chave, tipo: a.tipo, bytes: a.dados.length })) });
});

app.post("/api/instagram/conectar", async (req, res) => {
  try {
    res.json(await conectarInstagram(req.body?.token, req.body?.igId));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.post("/api/instagram/desconectar", async (req, res) => {
  await desconectarInstagram();
  res.json({ ok: true });
});

/** O que o painel mostra do direct: o que está ligado, o webhook e se o token consegue ler o direct. */
async function painelDoDirect({ conferir = false } = {}) {
  const c = await configDoDirect();
  return {
    respostas: c.respostas, comentarios: c.comentarios, appSecretDefinido: Boolean(c.appSecret), verifyToken: c.verifyToken,
    webhook: `${config.painel.urlPublica}/webhooks/instagram`,
    ultimoEvento: (await db.lerEstado("instagram_webhook_ultimo")) || null,
    ...(conferir ? { status: await statusDoDirect() } : {}),
  };
}

app.get("/api/instagram/direct", async (req, res) => res.json(await painelDoDirect({ conferir: req.query.conferir === "1" })));

app.put("/api/instagram/direct", async (req, res) => {
  const { respostas, comentarios, appSecret } = req.body ?? {};
  await salvarConfigDoDirect({ respostas, comentarios, appSecret });
  // Ligou alguma coisa: pede para a Meta mandar os eventos da conta (se o token permitir; senão o painel explica).
  let assinatura = null;
  if (respostas || comentarios) {
    assinatura = await assinarWebhookDoDirect().then(() => ({ ok: true }), (e) => ({ ok: false, erro: e.message.replace(/^Instagram: /, "") }));
  }
  res.json({ ...(await painelDoDirect({ conferir: true })), assinatura });
});

// Contratos: o modelo editável, seus dados e o contrato de cada cliente (também editável, em PDF).
app.get("/api/contratos", async (req, res) => res.json(await db.listarContratos()));

app.get("/api/contratos/padroes", async (req, res) => {
  res.json(await contratos.padroesDoContrato(req.query.lead, await carregarCampanhaCompleta()));
});

app.get("/api/contratos/modelo", async (req, res) => res.json({ corpo: await contratos.lerModelo() }));
app.put("/api/contratos/modelo", async (req, res) => res.json({ corpo: await contratos.salvarModelo(req.body?.corpo) }));

app.get("/api/contratos/contratada", async (req, res) => res.json(await contratos.lerContratada(await carregarCampanhaCompleta())));
app.put("/api/contratos/contratada", async (req, res) => {
  await contratos.salvarContratada(req.body);
  res.json(await contratos.lerContratada(await carregarCampanhaCompleta()));
});

// A folha do painel: o documento como vai sair, com os seus dados no lugar, para editar direto nela.
app.post("/api/contratos/folha", async (req, res) => {
  const c = await contratos.lerContratada(await carregarCampanhaCompleta());
  const valores = { contratada_nome: c.nome, contratada_cnpj: c.cnpj, contratada_cpf: c.cpf, contratada_marca: c.marca, contratada_email: c.email, contratada_pix: c.pix };
  res.json({ html: documentoEmHtml(String(req.body?.corpo ?? ""), { valores }), marca: c.marca, cnpj: c.cnpj, campos: ROTULOS_CAMPOS });
});

app.post("/api/contratos", async (req, res) => {
  const r = await contratos.criarContrato(req.body ?? {}, await carregarCampanhaCompleta());
  r.erro ? res.status(400).json(r) : res.json(r);
});

// O que falta nos seus dados, para o painel avisar antes de mandar o contrato.
const dadosQueFaltam = (c) => [["CNPJ", c.cnpj], ["CPF", c.cpf], ["e-mail", c.email], ["chave PIX", c.pix], ["nome", c.nome]].filter(([, v]) => !v).map(([n]) => n);

app.get("/api/contratos/:id", async (req, res) => {
  const contrato = await db.buscarContrato(req.params.id);
  if (!contrato) return res.status(404).json({ erro: "Contrato não encontrado" });
  res.json({ ...contrato, faltando: dadosQueFaltam(await contratos.lerContratada(await carregarCampanhaCompleta())) });
});

app.put("/api/contratos/:id", async (req, res) => {
  const contrato = await db.buscarContrato(req.params.id);
  if (!contrato) return res.status(404).json({ erro: "Contrato não encontrado" });
  const { corpo, status } = req.body ?? {};
  if (corpo !== undefined && !String(corpo).trim()) return res.status(400).json({ erro: "O contrato não pode ficar vazio" });
  if (status !== undefined && !contratos.STATUS_CONTRATO.includes(status)) return res.status(400).json({ erro: "Situação inválida" });
  await db.atualizarContrato(contrato.id, { ...(corpo !== undefined ? { corpo: String(corpo) } : {}), ...(status !== undefined ? { status } : {}) });
  res.json(await db.buscarContrato(contrato.id));
});

app.delete("/api/contratos/:id", async (req, res) => {
  await db.excluirContrato(req.params.id);
  res.json({ ok: true });
});

app.get("/api/contratos/:id/pdf", async (req, res) => {
  const contrato = await db.buscarContrato(req.params.id);
  if (!contrato) return res.status(404).json({ erro: "Contrato não encontrado" });
  const campanha = await carregarCampanhaCompleta();
  const contratada = await contratos.lerContratada(campanha);
  const pdf = await documentoEmPdf(contratos.preencherContratada(contrato.corpo, contratada), { marca: contratada.marca, cnpj: contratada.cnpj, projeto: contrato.projeto });
  const arquivo = `contrato-${contrato.projeto}`.normalize("NFD").replace(/[^\w-]+/g, "-").toLowerCase();
  // Com ?ver=1 abre no navegador; sem ele, baixa o arquivo.
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `${req.query.ver === "1" ? "inline" : "attachment"}; filename="${arquivo}.pdf"`, "Cache-Control": "no-store" }).send(pdf);
});

// Formulário do site: o link, se a IA responde sozinha e os últimos contatos que chegaram por ele.
app.get("/api/formulario", async (req, res) => {
  res.json({
    ...(await lerConfigFormulario()), link: `${config.painel.urlPublica}/contato`,
    contatos: await db.leadsDaOrigem("formulario", 10),
  });
});

app.put("/api/formulario", async (req, res) => res.json(await salvarConfigFormulario(req.body ?? {})));

// Insights do Instagram: os números de cada post, as médias e o que a IA aprendeu com eles.
app.get("/api/instagram/insights", async (req, res) => {
  const d = await desempenho();
  const { posts, melhores, piores, ...resto } = d;
  const resumir = ({ conteudo, metricas, ...p }) => ({ ...p, metricas, gancho: conteudo?.gancho ?? null, estrutura: conteudo?.estrutura ?? null, trilha: conteudo?.trilha ?? null });
  res.json({ ...resto, posts: posts.map(resumir), melhores: melhores.map((p) => p.midia_id), piores: piores.map((p) => p.midia_id), aprendizados: await lerAprendizados() });
});

// Lê os insights agora e a IA refaz os aprendizados.
app.post("/api/instagram/insights/atualizar", async (req, res) => {
  try {
    const lidos = await atualizarInsights({ forcar: true });
    if (lidos.insights === "instagram desconectado") return res.status(400).json({ erro: "Conecte o Instagram primeiro" });
    const r = await gerarAprendizados().catch((e) => ({ erro: e.message }));
    res.json({ ...lidos, aprendizados: r.aprendizados ?? null, motivo: r.motivo ?? r.erro ?? null });
  } catch (e) {
    res.status(502).json({ erro: e.message });
  }
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

// UAZap: vários números, cada um uma instância. Salvar já aponta o webhook da instância para este sistema.
const respostaDoNumero = async (id) => ({ ok: true, id, status: await uazap.status(id) });
const comErro = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
};

// Todos os números com status, empresas novas de hoje e limite de cada um.
app.get("/api/uazap/numeros", comErro(async () => {
  const campanha = await carregarCampanhaCompleta();
  return Promise.all((await uazap.statusDeTodos()).map(async (n) => ({
    ...n,
    hoje: await db.enviadasHoje("whatsapp", { primeiroContato: true, numero: n.id }),
    limite: await pipeline.limiteDoNumero(campanha, n.id),
    conversas: await db.conversasDoNumero(n.id),
  })));
}));

app.post("/api/uazap/numeros", comErro(async (req) => {
  const n = await uazap.salvarNumero({ nome: req.body?.nome, url: req.body?.url, token: req.body?.token });
  await uazap.configurarWebhook(n.id);
  return respostaDoNumero(n.id);
}));

app.put("/api/uazap/numeros/:id", comErro(async (req) => {
  const n = await uazap.salvarNumero({ id: req.params.id, nome: req.body?.nome, url: req.body?.url, token: req.body?.token });
  await uazap.configurarWebhook(n.id);
  return respostaDoNumero(n.id);
}));

app.delete("/api/uazap/numeros/:id", comErro(async (req) => {
  await uazap.removerNumero(req.params.id);
  return { ok: true };
}));

app.get("/api/uazap/numeros/:id/status", comErro((req) => uazap.status(req.params.id)));
app.post("/api/uazap/numeros/:id/conectar", comErro((req) => uazap.conectar(req.params.id, req.body?.telefone)));
app.post("/api/uazap/numeros/:id/desconectar", comErro(async (req) => {
  await uazap.desconectar(req.params.id);
  return { ok: true };
}));

// API oficial do WhatsApp (Cloud API da Meta): salvar confere o token e o número com a Meta.
app.post("/api/whatsapp-oficial/config", async (req, res) => {
  try {
    const b = req.body ?? {};
    await whatsappOficial.salvarConfig({
      token: b.token, phoneNumberId: b.phoneNumberId, template: b.template, idioma: b.idioma, appSecret: b.appSecret, ativo: b.ativo,
    });
    res.json({ ok: true, verifyToken: (await whatsappOficial.obterConfig()).verifyToken, status: await whatsappOficial.statusOficial() });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.get("/api/whatsapp-oficial/status", async (req, res) => {
  try {
    res.json(await whatsappOficial.statusOficial());
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.put("/api/whatsapp-oficial/ativo", async (req, res) => {
  try {
    await whatsappOficial.definirAtivo(Boolean(req.body?.ativo));
    res.json({ ok: true, modoWhatsapp: await pipeline.modoWhatsapp() });
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
  const registros = await evolution.buscarMensagens({ horas, remoteJid: req.query.jid || null, limite: Math.min(1000, Number(req.query.limite) || 200) });
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

// Mensagem que não foi lida na hora (ex.: o webhook falhou): passa a última do contato pelo fluxo de novo.
app.post("/api/whatsapp/reprocessar", async (req, res) => {
  const jid = String(req.body?.jid ?? "").trim();
  if (!/^\d+@(lid|s\.whatsapp\.net)$/.test(jid)) return res.status(400).json({ erro: "Informe o contato (ex.: 5511999999999@s.whatsapp.net)" });
  const ultima = (await evolution.buscarMensagens({ horas: 72, remoteJid: jid, limite: 30 })).find((r) => !r.key?.fromMe);
  if (!ultima) return res.status(404).json({ erro: "Nenhuma mensagem recebida desse contato nos últimos 3 dias" });
  const campanha = await carregarCampanhaCompleta();
  const registradas = await processarWebhookEvolution({ event: "messages.upsert", data: ultima }, campanha, { esperar: 0 });
  res.json({ ok: true, registradas });
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
