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
    lista.push({ id: idDoNumeroOficial(e.phoneNumberId), nome: e.nome || "Número", principal: false, phoneNumberId: e.phoneNumberId, ativo: e.ativo !== false, tokenProprio: Boolean(e.token), template: e.template || "", idioma: e.idioma || "" });
  }
  return ativos ? lista.filter((n) => n.ativo) : lista;
}

/** Token, número e template de um envio: os do número escolhido, ou os da conexão quando ele não tem próprios. */
async function dadosDoNumero(numeroId) {
  const c = await obterConfig();
  const extra = numeroId ? c.extras.find((e) => idDoNumeroOficial(e.phoneNumberId) === numeroId && e.ativo !== false) : null;
  if (!extra) return { ...c, numeroId: c.phoneNumberId ? idDoNumeroOficial(c.phoneNumberId) : null };
  return { ...c, token: extra.token || c.token, phoneNumberId: extra.phoneNumberId, template: extra.template || c.template, idioma: extra.idioma || c.idioma, numeroId };
}

/** A API oficial está ligada e com token e número: o WhatsApp sai por ela. */
export async function oficialAtiva() {
  const c = await obterConfig();
  return Boolean(c.ativo && c.token && c.phoneNumberId);
}

async function graph(c, caminho, token = c.token) {
  let resp;
  try {
    resp = await fetch(`https://graph.facebook.com/${c.apiVersion}/${caminho}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Não foi possível falar com a Meta agora. Tente de novo em instantes.");
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = dados.error ?? {};
    if (erro.code === 190) throw new Error("A Meta recusou o token de acesso (inválido ou vencido). Gere um token permanente de usuário do sistema.");
    if (erro.code === 100 || erro.code === 803) throw new Error("A Meta não encontrou esse ID do número de telefone com esse token. Confira o ID em WhatsApp → Configuração da API.");
    throw new Error(`A Meta respondeu ${resp.status}: ${erro.message ?? "erro desconhecido"}`);
  }
  return dados;
}

/** Dados do número na Meta (nome verificado, número e qualidade), para o painel. */
export async function statusOficial(numeroId = null) {
  const c = numeroId ? await dadosDoNumero(numeroId) : await obterConfig();
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
  };
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
  const c = numeroId ? await dadosDoNumero(numeroId) : await obterConfig();
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
    const dbg = await graph(c, `debug_token?input_token=${encodeURIComponent(c.token)}`);
    const contas = new Set(
      (dbg.data?.granular_scopes ?? [])
        .filter((s) => /whatsapp_business_(management|messaging)/.test(s.scope))
        .flatMap((s) => s.target_ids ?? [])
    );
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
export async function adicionarNumero({ nome, phoneNumberId, token, template, idioma }) {
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
  const novo = { nome: limpo(nome).slice(0, 40) || n.verified_name || n.display_phone_number || "Número", phoneNumberId: pid, token: tk, template: tpl, idioma: limpo(idioma), ativo: true, criadoEm: new Date().toISOString() };
  await db.gravarConfig(CHAVE, { ...atual, extras: [...extras, novo] });
  cacheAte = 0;
  return { id: idDoNumeroOficial(pid), nome: novo.nome, numero: n.display_phone_number ?? null };
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
