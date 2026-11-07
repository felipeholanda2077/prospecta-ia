import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Sem rodapé no WhatsApp: a mensagem sai como uma conversa normal. Quem responder
// "sair", "parar" ou "não quero receber" continua indo para a lista de supressão.
export const RODAPE_WHATSAPP = "";

/**
 * Link "clique para conversar" com a mensagem já escrita. Usado no modo manual:
 * você revisa no painel, abre o link e aperta enviar no seu próprio WhatsApp.
 */
export function linkWhatsapp(numero, corpo, comRodape = true) {
  const destino = String(config.modoTeste.whatsapp || numero).replace(/\D/g, "");
  return `https://wa.me/${destino}?text=${encodeURIComponent(corpo + (comRodape ? RODAPE_WHATSAPP : ""))}`;
}

// ---------- Conexão com a API oficial (Cloud API da Meta), salva pelo painel ----------

const CHAVE = "whatsapp_oficial";
let cache = null;
let cacheAte = 0;

/**
 * Token, número e template da API oficial. As variáveis de ambiente (WHATSAPP_*) têm prioridade
 * sobre o que foi salvo em Configurações; o token de verificação do webhook é gerado pelo sistema.
 */
export async function obterConfig() {
  if (Date.now() < cacheAte) return cache;
  const env = config.whatsapp;
  const salvo = (await db.lerConfig(CHAVE)) ?? {};
  cache = {
    ativo: env.ativo || Boolean(salvo.ativo),
    token: env.token || salvo.token || "",
    phoneNumberId: env.phoneNumberId || salvo.phoneNumberId || "",
    template: process.env.WHATSAPP_TEMPLATE || salvo.template || env.template,
    idioma: process.env.WHATSAPP_TEMPLATE_IDIOMA || salvo.idioma || env.idioma,
    apiVersion: env.apiVersion,
    verifyToken: env.verifyToken || salvo.verifyToken || "",
    appSecret: env.appSecret || salvo.appSecret || "",
    extras: Array.isArray(salvo.extras) ? salvo.extras : [],
    contaId: salvo.contaId || "",
  };
  cacheAte = Date.now() + 30_000;
  return cache;
}

/** Id de um número oficial no sistema (o mesmo campo `numero_wa` das conversas da UAZap, com prefixo para não colidir). */
export const idDoNumeroOficial = (phoneNumberId) => `meta-${String(phoneNumberId ?? "").replace(/\D/g, "")}`;
export const ehNumeroOficial = (id) => String(id ?? "").startsWith("meta-");

/**
 * Os números da API oficial: o principal (o da conexão) e os que foram adicionados depois. Cada um pode
 * ter token e template próprios (número de outra conta do WhatsApp Business); sem eles, usa os da conexão.
 * `ativos: true` devolve só os que enviam (os extras podem ser desligados um a um).
 */
export async function numerosOficiais({ ativos = false } = {}) {
  const c = await obterConfig();
  const lista = [];
  if (c.phoneNumberId) lista.push({ id: idDoNumeroOficial(c.phoneNumberId), nome: "Principal", principal: true, phoneNumberId: c.phoneNumberId, ativo: true, tokenProprio: false });
  for (const e of c.extras) {
    if (!e?.phoneNumberId || lista.some((n) => n.phoneNumberId === e.phoneNumberId)) continue;
    lista.push({ id: idDoNumeroOficial(e.phoneNumberId), nome: e.nome || "Número", principal: false, phoneNumberId: e.phoneNumberId, ativo: e.ativo !== false, tokenProprio: Boolean(e.token), segredoProprio: Boolean(e.appSecret), template: e.template || "", idioma: e.idioma || "" });
  }
  return ativos ? lista.filter((n) => n.ativo) : lista;
}

/** Token, número e template de um envio: os do número escolhido, ou os da conexão quando ele não tem próprios. */
async function dadosDoNumero(numeroId, { soAtivos = true } = {}) {
  const c = await obterConfig();
  const extra = numeroId ? c.extras.find((e) => idDoNumeroOficial(e.phoneNumberId) === numeroId && (!soAtivos || e.ativo !== false)) : null;
  if (!extra) return { ...c, numeroId: c.phoneNumberId ? idDoNumeroOficial(c.phoneNumberId) : null };
  return { ...c, token: extra.token || c.token, phoneNumberId: extra.phoneNumberId, template: extra.template || c.template, idioma: extra.idioma || c.idioma, contaId: extra.contaId || null, appSecretDoNumero: extra.appSecret || "", numeroId };
}

/** Os dados de um número para conferir e corrigir na Meta, ligado ou não. Número desconhecido é erro. */
async function numeroParaGerenciar(numeroId) {
  const c = await obterConfig();
  if (numeroId && numeroId !== idDoNumeroOficial(c.phoneNumberId) && !c.extras.some((e) => idDoNumeroOficial(e.phoneNumberId) === numeroId)) {
    throw new Error("Número não encontrado");
  }
  return dadosDoNumero(numeroId, { soAtivos: false });
}

/** A API oficial está ligada e com token e número: o WhatsApp sai por ela. */
export async function oficialAtiva() {
  const c = await obterConfig();
  return Boolean(c.ativo && c.token && c.phoneNumberId);
}

async function graph(c, caminho, token = c.token, corpo = null) {
  let resp;
  try {
    resp = await fetch(`https://graph.facebook.com/${c.apiVersion}/${caminho}`, {
      ...(corpo ? { method: "POST", body: JSON.stringify(corpo) } : {}),
      headers: { Authorization: `Bearer ${token}`, ...(corpo ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Não foi possível falar com a Meta agora. Tente de novo em instantes.");
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = dados.error ?? {};
    const falha = (texto) => Object.assign(new Error(texto), { daMeta: `${erro.code ?? resp.status}: ${erro.message ?? "erro desconhecido"}` });
    if (erro.code === 190) throw falha("A Meta recusou o token de acesso (inválido ou vencido). Gere um token permanente de usuário do sistema.");
    if (erro.code === 100 || erro.code === 803) throw falha("A Meta não encontrou esse ID do número de telefone com esse token. Confira o ID em WhatsApp → Configuração da API.");
    throw falha(`A Meta respondeu ${resp.status}: ${erro.message ?? "erro desconhecido"}`);
  }
  return dados;
}

/** Dados do número na Meta (nome verificado, número e qualidade), para o painel. */
export async function statusOficial(numeroId = null) {
  const c = numeroId ? await numeroParaGerenciar(numeroId) : await obterConfig();
  if (!c.token || !c.phoneNumberId) return { configurada: false, ativo: c.ativo };
  const n = await graph(c, `${c.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
  return {
    configurada: true,
    ativo: c.ativo,
    numero: n.display_phone_number ?? null,
    nome: n.verified_name ?? null,
    qualidade: n.quality_rating ?? null,
    situacao: await situacaoDoNumero(c),
    template: await situacaoDoTemplate(c),
    conta: await infoDaConta(c),
  };
}

// ---------- Conta do WhatsApp Business (WABA) de cada número ----------

/** Fuso horário de São Paulo na lista da Meta (timezone_id). Sem fuso, a Meta bloqueia os envios (erro 141007). */
export const FUSO_SAO_PAULO = "25";
/** A Meta devolve timezone_id "0" para conta sem fuso. */
const temFuso = (v) => Boolean(v) && String(v) !== "0";
const contaPorNumero = new Map();

/**
 * Contas do WhatsApp Business que o token acessa. Tenta, nesta ordem: o próprio token no debug_token,
 * o token do app (id do app + chave secreta) no debug_token, e as BMs do token. Guarda o último motivo de falha.
 */
let ultimoMotivo = "";
async function contasDoToken(c, token = c.token, segredo = c.appSecret) {
  const ids = new Set();
  const doDebug = (dbg) => (dbg?.data?.granular_scopes ?? [])
    .filter((s) => /whatsapp_business_(management|messaging)/.test(s.scope))
    .flatMap((s) => s.target_ids ?? [])
    .forEach((id) => ids.add(String(id)));
  const motivos = [];
  try { doDebug(await graph(c, `debug_token?input_token=${encodeURIComponent(token)}`, token)); }
  catch (e) { motivos.push(e.daMeta ?? e.message); }
  if (!ids.size && segredo) {
    try {
      const app = await graph(c, "app?fields=id", token);
      doDebug(await graph(c, `debug_token?input_token=${encodeURIComponent(token)}`, `${app.id}|${segredo}`));
    } catch (e) { motivos.push(e.daMeta ?? e.message); }
  }
  // Token que acessa todas as contas da BM não lista os ids: procura pelas empresas (BMs) do token.
  if (!ids.size) {
    try {
      const empresas = await graph(c, "me/businesses?fields=id&limit=50", token);
      for (const { id } of empresas?.data ?? []) {
        for (const tipo of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
          const r = await graph(c, `${id}/${tipo}?fields=id&limit=100`, token).catch(() => null);
          for (const w of r?.data ?? []) ids.add(String(w.id));
        }
      }
    } catch (e) { motivos.push(e.daMeta ?? e.message); }
  }
  ultimoMotivo = ids.size ? "" : motivos.filter(Boolean).join(" · ");
  return [...ids];
}

/** Id da conta do WhatsApp Business que tem este número (procura nas contas do token; guarda na memória). */
async function contaDoNumero(c) {
  if (c.contaId) return c.contaId;
  const chave = `${c.phoneNumberId}`;
  if (contaPorNumero.has(chave)) return contaPorNumero.get(chave);
  for (const conta of await contasDoToken(c, c.token, c.appSecretDoNumero || c.appSecret)) {
    const r = await graph(c, `${conta}/phone_numbers?fields=id&limit=100`).catch(() => null);
    if ((r?.data ?? []).some((p) => String(p.id) === String(c.phoneNumberId))) {
      contaPorNumero.set(chave, conta);
      return conta;
    }
  }
  return null;
}

/**
 * Nome, empresa (BM) e fuso da conta do número, com os links certos da Meta para ela.
 * Número de outra BM tem links da BM dele, não da principal. Retorna null se não der para ler.
 */
async function infoDaConta(c) {
  try {
    const id = await contaDoNumero(c);
    if (!id) return null;
    const w = await graph(c, `${id}?fields=name,timezone_id,owner_business_info`);
    const empresa = w.owner_business_info?.id ?? null;
    const base = "https://business.facebook.com/latest";
    return {
      id,
      nome: w.name ?? null,
      empresaId: empresa,
      empresaNome: w.owner_business_info?.name ?? null,
      fuso: temFuso(w.timezone_id) ? String(w.timezone_id) : null,
      links: empresa ? {
        conta: `${base}/settings/whatsapp_account?business_id=${empresa}&selected_asset_id=${id}&selected_asset_type=whatsapp-business-account`,
        pagamento: `https://business.facebook.com/billing_hub/payment_settings/?business_id=${empresa}&asset_id=${id}&payment_account_id=${id}`,
        verificacao: `https://business.facebook.com/settings/security?business_id=${empresa}`,
        templates: `${base}/whatsapp_manager/message_templates?business_id=${empresa}&asset_id=${id}`,
      } : null,
    };
  } catch {
    return null;
  }
}

/**
 * Corrige na Meta o que dá para corrigir pela API: define o fuso de São Paulo se a conta estiver sem fuso
 * e liga o app do sistema à conta (para as respostas chegarem pelo webhook). Diz o que fez e o que falhou.
 */
export async function corrigirNaMeta(numeroId = null) {
  const c = numeroId ? await numeroParaGerenciar(numeroId) : await obterConfig();
  if (!c.token || !c.phoneNumberId) throw new Error("Salve o token e o número da Meta antes");
  const conta = await contaDoNumero(c);
  if (!conta) throw new Error(semPermissao(ultimoMotivo) ? SEM_GERENCIAR : `O sistema não achou a conta do WhatsApp Business deste número. Informe o ID da conta no cartão do número (Gerenciador do WhatsApp → Configurações da conta).${ultimoMotivo ? ` Resposta da Meta: ${ultimoMotivo}` : ""}`);
  const feito = [], falhou = [];
  const w = await graph(c, `${conta}?fields=timezone_id`).catch(() => ({}));
  if (!temFuso(w.timezone_id)) {
    try { await graph(c, conta, c.token, { timezone_id: FUSO_SAO_PAULO }); feito.push("fuso horário definido (São Paulo)"); }
    catch (e) { falhou.push(`fuso horário: ${e.message}`); }
  }
  try { await graph(c, `${conta}/subscribed_apps`, c.token, {}); feito.push("respostas ligadas ao sistema"); }
  catch (e) { falhou.push(`respostas: ${e.message}`); }
  return { feito, falhou };
}

/**
 * Números que um token acessa, para escolher na lista em vez de procurar o ID na Meta.
 * Sem token, usa o da conexão principal (números da mesma BM).
 */
export async function descobrirNumeros(token) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const tk = String(token ?? "").trim() || atual.token || config.whatsapp.token;
  if (!tk) throw new Error("Cole o token de acesso da outra BM");
  const c = { apiVersion: config.whatsapp.apiVersion, token: tk };
  const contas = await contasDoToken(c, tk, config.whatsapp.appSecret || atual.appSecret || "");
  if (!contas.length) throw new Error(`O sistema não conseguiu listar as contas do WhatsApp deste token. Ao gerar o token, marque a conta do WhatsApp e as permissões whatsapp_business_management e whatsapp_business_messaging. Se preferir, use "digitar o ID do número".${ultimoMotivo ? ` Resposta da Meta: ${ultimoMotivo}` : ""}`);
  const noSistema = new Set([atual.phoneNumberId, config.whatsapp.phoneNumberId, ...(atual.extras ?? []).map((e) => e.phoneNumberId)].filter(Boolean).map(String));
  const lista = [];
  for (const conta of contas) {
    const w = await graph(c, `${conta}?fields=name,owner_business_info`).catch(() => null);
    const r = await graph(c, `${conta}/phone_numbers?fields=display_phone_number,verified_name,status&limit=100`).catch(() => null);
    for (const p of r?.data ?? []) {
      lista.push({
        phoneNumberId: String(p.id), numero: p.display_phone_number ?? null, nome: p.verified_name ?? null, status: p.status ?? null,
        contaId: conta, conta: w?.name ?? null, empresa: w?.owner_business_info?.name ?? null, noSistema: noSistema.has(String(p.id)),
      });
    }
  }
  if (!lista.length) throw new Error("O token acessa a conta do WhatsApp, mas não achou nenhum número nela. Adicione o número no Gerenciador do WhatsApp da outra BM primeiro.");
  return lista;
}

const ERROS_DO_CODIGO = {
  136024: "A Meta não conseguiu mandar o código para este número. Confira se ele recebe SMS ou ligação.",
  136025: "O código não confere. Peça um novo e digite os 6 números.",
  133009: "Tentativas rápidas demais. Espere um minuto e tente de novo.",
  133010: "Este número ainda não está ligado à conta. Adicione no Gerenciador do WhatsApp.",
};

async function postNoNumero(c, acao, corpo) {
  let resp;
  try {
    resp = await fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/${acao}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Não foi possível falar com a Meta agora. Tente de novo em instantes.");
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = dados.error ?? {};
    throw new Error(ERROS_DO_CODIGO[erro.code] ?? `A Meta recusou: ${erro.error_data?.details ?? erro.message ?? `erro ${resp.status}`}`);
  }
  return dados;
}

/** Pede à Meta o código que confirma a posse do número (chega por SMS ou ligação no próprio número). */
export async function pedirCodigo(numeroId, metodo = "SMS") {
  const c = await numeroParaGerenciar(numeroId);
  await postNoNumero(c, "request_code", { code_method: metodo === "VOICE" ? "VOICE" : "SMS", language: "pt_BR" });
}

/** Confere o código de 6 números que chegou no número. */
export async function confirmarCodigo(numeroId, codigo) {
  const c = await numeroParaGerenciar(numeroId);
  const limpo = String(codigo ?? "").replace(/\D/g, "");
  if (limpo.length !== 6) throw new Error("O código tem 6 números");
  await postNoNumero(c, "verify_code", { code: limpo });
}

/**
 * Se o número já pode enviar: token e ID válidos não garantem isso, ele pode estar pendente na Meta.
 * Perguntado à parte porque um campo que a Meta recuse não pode derrubar o resto do status.
 * Retorna null quando não dá para conferir.
 */
async function situacaoDoNumero(c) {
  const n = await graph(c, `${c.phoneNumberId}?fields=status,code_verification_status,name_status,health_status`).catch(() => null);
  if (!n) return null;
  const saude = n.health_status ?? {};
  const erros = (saude.entities ?? []).flatMap((e) => e.errors ?? []).map((e) => ({
    codigo: e.error_code ?? null,
    descricao: e.error_description ?? "",
    solucao: e.possible_solution ?? "",
  }));
  return {
    status: n.status ?? null,
    verificacao: n.code_verification_status ?? null,
    nome: n.name_status ?? null,
    podeEnviar: saude.can_send_message ?? null,
    erros,
    pronto: n.status === "CONNECTED" && saude.can_send_message !== "BLOCKED",
  };
}

// Se cada número oficial pode receber empresas novas (pronto na Meta), lido no máximo a cada 10 minutos.
const prontoPorNumero = new Map();
const PRONTO_VALE_MS = 10 * 60_000;

/**
 * O número oficial está pronto para mandar o primeiro contato (conectado e não bloqueado na Meta)? Número que ainda
 * não foi liberado, ou que não deu para ler, fica fora da divisão de empresas novas; as conversas dele continuam nele.
 */
export async function prontoParaEmpresaNova(numeroId) {
  const guardado = prontoPorNumero.get(numeroId);
  if (guardado && guardado.ate > Date.now()) return guardado.pronto;
  const c = await numeroParaGerenciar(numeroId).catch(() => null);
  const pronto = Boolean(c?.token && c?.phoneNumberId && (await situacaoDoNumero(c))?.pronto);
  prontoPorNumero.set(numeroId, { pronto, ate: Date.now() + PRONTO_VALE_MS });
  return pronto;
}

const ERROS_DO_REGISTRO = {
  190: "A Meta recusou o token de acesso (inválido ou vencido). Gere um token permanente de usuário do sistema.",
  200: "Este token não tem permissão para registrar o número. Ele precisa de whatsapp_business_management e whatsapp_business_messaging.",
  133005: "O PIN não confere com o da verificação em duas etapas deste número. Se não lembrar, troque o PIN no Gerenciador do WhatsApp.",
  133006: "A Meta ainda precisa verificar este número. Conclua a verificação no Gerenciador do WhatsApp e tente de novo.",
  133008: "Muitas tentativas com o PIN errado. A Meta bloqueou novas tentativas por um tempo.",
  133009: "Tentativas rápidas demais. Espere um minuto e tente de novo.",
  133016: "Limite de tentativas da Meta atingido: 10 a cada 72 horas. Novas tentativas ficam bloqueadas por 72 horas.",
};

/** Registra o número na API oficial, passo que a Meta só aceita pela API. O PIN não é guardado. */
export async function registrarNumero(pin, numeroId = null) {
  const c = numeroId ? await numeroParaGerenciar(numeroId) : await obterConfig();
  if (!c.token || !c.phoneNumberId) throw new Error("Salve o token e o número da Meta antes de registrar");
  const limpo = String(pin ?? "").trim();
  if (!/^\d{6}$/.test(limpo)) throw new Error("O PIN precisa ter 6 números");
  let resp;
  try {
    resp = await fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: limpo }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Não foi possível falar com a Meta agora. Tente de novo em instantes.");
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = dados.error ?? {};
    throw new Error(ERROS_DO_REGISTRO[erro.code] ?? `A Meta não registrou o número: ${erro.error_data?.details ?? erro.message ?? `erro ${resp.status}`}`);
  }
}

/**
 * Procura o template nas contas do WhatsApp Business que o token acessa e diz se está aprovado.
 * Retorna null quando não dá para conferir (token sem essa permissão, por exemplo).
 */
async function situacaoDoTemplate(c) {
  try {
    const conta0 = await contaDoNumero(c).catch(() => null);
    const contas = new Set(conta0 ? [conta0] : await contasDoToken(c));
    for (const conta of contas) {
      const r = await graph(c, `${conta}/message_templates?name=${encodeURIComponent(c.template)}&fields=name,status,language`).catch(() => null);
      const achado = (r?.data ?? []).filter((t) => t.name === c.template);
      if (!achado.length) continue;
      const doIdioma = achado.find((t) => t.language === c.idioma);
      return { nome: c.template, idioma: c.idioma, status: doIdioma?.status ?? "IDIOMA_DIFERENTE", idiomas: achado.map((t) => t.language) };
    }
    return contas.size ? { nome: c.template, idioma: c.idioma, status: "NAO_ENCONTRADO" } : null;
  } catch {
    return null;
  }
}

/** Salva o que foi informado no painel, depois de confirmar com a Meta que o token e o número funcionam. */
export async function salvarConfig({ token, phoneNumberId, template, idioma, appSecret, ativo }) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const limpo = (v) => String(v ?? "").trim();
  const novo = {
    token: limpo(token) || atual.token || "",
    phoneNumberId: (limpo(phoneNumberId) || atual.phoneNumberId || "").replace(/\D/g, ""),
    template: limpo(template) || atual.template || config.whatsapp.template,
    idioma: limpo(idioma) || atual.idioma || config.whatsapp.idioma,
    appSecret: limpo(appSecret) || atual.appSecret || "",
    verifyToken: atual.verifyToken || crypto.randomBytes(16).toString("hex"),
    ativo: ativo === undefined ? Boolean(atual.ativo) : Boolean(ativo),
    contaId: (limpo(phoneNumberId) || atual.phoneNumberId || "").replace(/\D/g, "") === String(atual.phoneNumberId ?? "") ? atual.contaId || "" : "",
    extras: Array.isArray(atual.extras) ? atual.extras.filter((e) => e.phoneNumberId !== (limpo(phoneNumberId) || atual.phoneNumberId || "").replace(/\D/g, "")) : [],
  };
  if (!novo.token) throw new Error("Informe o token de acesso da Meta");
  if (!novo.phoneNumberId) throw new Error("Informe o ID do número de telefone (só números)");
  if (!/^[a-z0-9_]+$/.test(novo.template)) throw new Error("O nome do template usa só letras minúsculas, números e _ (como está na Meta)");
  await graph({ apiVersion: config.whatsapp.apiVersion }, `${novo.phoneNumberId}?fields=display_phone_number`, novo.token);
  await db.gravarConfig(CHAVE, novo);
  cacheAte = 0;
  return novo;
}

/**
 * Adiciona outro número da API oficial, depois de confirmar com a Meta que ele existe. Sem token próprio,
 * usa o da conexão (número da mesma conta do WhatsApp Business); com token, pode ser de outra conta.
 */
export async function adicionarNumero({ nome, phoneNumberId, token, template, idioma, appSecret, contaId }) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const limpo = (v) => String(v ?? "").trim();
  const pid = limpo(phoneNumberId).replace(/\D/g, "");
  if (!(atual.token || config.whatsapp.token)) throw new Error("Salve a conexão principal (token e número) antes de adicionar outros números");
  if (!pid) throw new Error("Informe o ID do número de telefone (só números)");
  const extras = Array.isArray(atual.extras) ? atual.extras : [];
  if (pid === String(atual.phoneNumberId ?? config.whatsapp.phoneNumberId ?? "") || extras.some((e) => e.phoneNumberId === pid)) throw new Error("Esse número já está no sistema");
  const tpl = limpo(template);
  if (tpl && !/^[a-z0-9_]+$/.test(tpl)) throw new Error("O nome do template usa só letras minúsculas, números e _ (como está na Meta)");
  const tk = limpo(token);
  const n = await graph({ apiVersion: config.whatsapp.apiVersion }, `${pid}?fields=display_phone_number,verified_name`, tk || atual.token || config.whatsapp.token);
  const novo = {
    nome: limpo(nome).slice(0, 40) || n.verified_name || n.display_phone_number || "Número", phoneNumberId: pid, token: tk, template: tpl,
    idioma: limpo(idioma), appSecret: limpo(appSecret), contaId: limpo(contaId).replace(/\D/g, ""), ativo: true, criadoEm: new Date().toISOString(),
  };
  await db.gravarConfig(CHAVE, { ...atual, extras: [...extras, novo] });
  cacheAte = 0;
  const id = idDoNumeroOficial(pid);
  // Já deixa a conta pronta no que dá pela API (fuso e respostas); o que falhar aparece no cartão do número.
  const correcao = await corrigirNaMeta(id).catch((e) => ({ feito: [], falhou: [e.message] }));
  return { id, nome: novo.nome, numero: n.display_phone_number ?? null, correcao };
}

const semPermissao = (texto) => /Missing Permission|\(#10\)|\(#200\)/i.test(String(texto ?? ""));
const SEM_GERENCIAR = "O token deste número só envia mensagens: falta a permissão de gerenciar a conta do WhatsApp. Gere um token novo no usuário do sistema da BM do número, com a conta do WhatsApp atribuída (controle total) e as permissões whatsapp_business_management e whatsapp_business_messaging, e cole no lugar do atual.";

const ONDE_ACHAR_A_CONTA = "O ID certo fica em business.facebook.com → Configurações do negócio → Contas → Contas do WhatsApp: clique na conta e copie o número que aparece abaixo do nome. Também dá para colar o ID da BM (empresa), que o sistema procura a conta sozinho.";
const NOMES_DE_TIPO = { business: "o ID de uma BM (empresa)", application: "o ID de um app", user: "o ID de um usuário", page: "o ID de uma página do Facebook", whatsapp_business_phone_number: "o ID de um número de telefone" };

/**
 * A conta do WhatsApp Business do número, a partir do ID colado no painel. Aceita o ID da conta ou o da BM
 * (procura nas contas dela a que tem o número). Outro tipo de ID volta com uma explicação do que foi colado.
 */
async function contaPeloIdInformado(c, id) {
  if (id === String(c.phoneNumberId)) throw new Error(`Esse é o ID do número de telefone, não o da conta. ${ONDE_ACHAR_A_CONTA}`);
  if (/^55\d{10,11}$/.test(id)) throw new Error(`Isso parece o número do WhatsApp, não o ID da conta. ${ONDE_ACHAR_A_CONTA}`);
  const temONumero = (r) => (r?.data ?? []).some((p) => String(p.id) === String(c.phoneNumberId));
  const erroDaMeta = (e) => (semPermissao(e.daMeta) ? new Error(SEM_GERENCIAR) : null);
  try {
    if (temONumero(await graph(c, `${id}/phone_numbers?fields=id&limit=100`))) return id;
    throw Object.assign(new Error("Essa conta do WhatsApp não tem este número. Confira se colou a conta da BM certa."), { final: true });
  } catch (e) {
    if (e.final) throw e;
    if (erroDaMeta(e)) throw erroDaMeta(e);
    if (/does not exist|Unsupported get request/i.test(e.daMeta ?? "")) throw new Error(`A Meta não achou esse ID com o token deste número: ou o ID está errado, ou é de outra BM. ${ONDE_ACHAR_A_CONTA}`);
    if (!/nonexisting field/i.test(e.daMeta ?? "")) throw new Error(`A Meta não abriu essa conta com o token deste número: ${e.daMeta ?? e.message}`);
  }
  // Não é uma conta do WhatsApp: se for a BM, procura nas contas dela a que tem o número.
  const contasDaBm = [];
  for (const tipo of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
    const r = await graph(c, `${id}/${tipo}?fields=id&limit=100`).catch((e) => { if (erroDaMeta(e)) throw erroDaMeta(e); return null; });
    for (const w of r?.data ?? []) contasDaBm.push(String(w.id));
  }
  for (const conta of contasDaBm) {
    if (temONumero(await graph(c, `${conta}/phone_numbers?fields=id&limit=100`).catch(() => null))) return conta;
  }
  if (contasDaBm.length) throw new Error("Essa BM tem contas do WhatsApp, mas nenhuma com este número. O número deve estar em outra BM: cole o ID da BM ou da conta onde ele foi cadastrado.");
  const tipo = await graph(c, `${id}?metadata=1&fields=id`).then((r) => r.metadata?.type ?? null).catch(() => null);
  if (tipo === "business") throw new Error("Esse é o ID de uma BM, mas o token deste número não enxerga as contas do WhatsApp dela. Gere o token no usuário do sistema dessa BM, com a conta do WhatsApp atribuída, e troque o token do número.");
  throw new Error(`Esse ID não é de uma conta do WhatsApp Business${NOMES_DE_TIPO[tipo] ? ` (é ${NOMES_DE_TIPO[tipo]})` : ""}. ${ONDE_ACHAR_A_CONTA}`);
}

/** Guarda o ID da conta do WhatsApp Business de um número (quando o sistema não consegue achar sozinho). */
export async function definirContaDoNumero(numeroId, contaId) {
  const id = String(contaId ?? "").replace(/\D/g, "");
  if (!id) throw new Error("Informe o ID da conta do WhatsApp Business (só números)");
  const c = await numeroParaGerenciar(numeroId);
  const conta = await contaPeloIdInformado(c, id);
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const extras = Array.isArray(atual.extras) ? atual.extras : [];
  const alvo = extras.find((e) => idDoNumeroOficial(e.phoneNumberId) === numeroId);
  if (alvo) alvo.contaId = conta;
  await db.gravarConfig(CHAVE, alvo ? { ...atual, extras } : { ...atual, contaId: conta });
  contaPorNumero.set(String(c.phoneNumberId), conta);
  cacheAte = 0;
  return { contaId: conta };
}

/** Troca o token de um número de outra BM (confere com a Meta antes) e já tenta corrigir o que falta. */
export async function trocarTokenDoNumero(numeroId, token) {
  const tk = String(token ?? "").trim();
  if (!tk) throw new Error("Cole o token novo");
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const extras = Array.isArray(atual.extras) ? atual.extras : [];
  const alvo = extras.find((e) => idDoNumeroOficial(e.phoneNumberId) === numeroId);
  if (!alvo) throw new Error("Para o número principal, troque o token no formulário da conexão, acima.");
  await graph({ apiVersion: config.whatsapp.apiVersion }, `${alvo.phoneNumberId}?fields=display_phone_number`, tk);
  alvo.token = tk;
  await db.gravarConfig(CHAVE, { ...atual, extras });
  contaPorNumero.delete(String(alvo.phoneNumberId));
  cacheAte = 0;
  return corrigirNaMeta(numeroId).catch((e) => ({ feito: [], falhou: [e.message] }));
}

/** Liga ou desliga um número extra (o principal liga e desliga com a API oficial inteira). */
export async function definirNumeroAtivo(numeroId, ativo) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const extras = Array.isArray(atual.extras) ? atual.extras : [];
  const alvo = extras.find((e) => idDoNumeroOficial(e.phoneNumberId) === numeroId);
  if (!alvo) throw new Error("Número não encontrado");
  alvo.ativo = Boolean(ativo);
  await db.gravarConfig(CHAVE, { ...atual, extras });
  cacheAte = 0;
}

/** Tira um número extra do sistema. As conversas dele passam a sair pelo número que mandou menos no dia. */
export async function removerNumero(numeroId) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  const extras = Array.isArray(atual.extras) ? atual.extras : [];
  if (!extras.some((e) => idDoNumeroOficial(e.phoneNumberId) === numeroId)) throw new Error("Número não encontrado");
  await db.gravarConfig(CHAVE, { ...atual, extras: extras.filter((e) => idDoNumeroOficial(e.phoneNumberId) !== numeroId) });
  cacheAte = 0;
}

/** Liga ou desliga o envio pela API oficial sem mexer no resto. */
export async function definirAtivo(ativo) {
  const atual = (await db.lerConfig(CHAVE)) ?? {};
  if (ativo && !(atual.token || config.whatsapp.token)) throw new Error("Salve o token e o número da Meta antes de ligar");
  await db.gravarConfig(CHAVE, { ...atual, ativo: Boolean(ativo) });
  cacheAte = 0;
}

/**
 * Envia mensagem pela WhatsApp Cloud API oficial da Meta usando um template aprovado.
 *
 * O template (o nome salvo em Configurações) deve ter 2 variáveis no corpo:
 *   {{1}} = nome da empresa   {{2}} = texto da proposta
 * Ex.: "Olá, {{1}}! {{2}} Responda SAIR se não quiser mais receber mensagens."
 *
 * Bibliotecas não oficiais (open-wa, whatsapp-web.js, Baileys) violam os termos do
 * WhatsApp para disparos em massa e levam ao banimento do número — por isso não são usadas aqui.
 */
export async function enviarWhatsapp({ para, empresa, corpo, numeroId = null }) {
  const { ativo, token, phoneNumberId, template, idioma, apiVersion } = await dadosDoNumero(numeroId);
  if (!ativo) throw new Error("API oficial do WhatsApp desligada (ligue em Configurações)");
  if (!token || !phoneNumberId) throw new Error("API oficial do WhatsApp sem token ou ID do número (preencha em Configurações)");

  if (config.modoTeste.whatsapp) para = config.modoTeste.whatsapp;
  else if (config.modoTeste.email) throw new Error("modo teste ativo sem MODO_TESTE_WHATSAPP; WhatsApp não enviado");

  // Variáveis de template não aceitam quebras de linha nem tabs.
  const texto = corpo.replace(/\s*\n+\s*/g, " ").slice(0, 900);

  const resp = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "template",
      template: {
        name: template,
        language: { code: idioma },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: empresa },
              { type: "text", text: texto },
            ],
          },
        ],
      },
    }),
  });

  const dados = await resp.json();
  if (!resp.ok) throw new Error(`WhatsApp API ${resp.status}: ${dados.error?.message ?? JSON.stringify(dados)}`);
  return dados.messages?.[0]?.id;
}

/**
 * Texto livre pela API oficial. Só é aceito dentro das 24 h seguintes a uma mensagem
 * do contato, então serve para responder conversas, não para o primeiro contato.
 */
export async function enviarTextoWhatsappOficial({ para, corpo, numeroId = null }) {
  const { token, phoneNumberId, apiVersion } = await dadosDoNumero(numeroId);
  if (config.modoTeste.whatsapp) para = config.modoTeste.whatsapp;
  const resp = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: para, type: "text", text: { body: corpo } }),
  });
  const dados = await resp.json();
  if (!resp.ok) throw new Error(`WhatsApp API ${resp.status}: ${dados.error?.message ?? JSON.stringify(dados)}`);
  return dados.messages?.[0]?.id;
}
