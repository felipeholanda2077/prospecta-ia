import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import { registrarResposta } from "./processar.js";
import { normalizarTelefoneBR, variantesWhatsappBR } from "../analise/telefone.js";
import { enviarNotificacao } from "../envio/email.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Formulário de contato do site (e do link na bio): quem preenche vira um lead já em conversa e a
// IA chama no WhatsApp (ou responde por e-mail, se a pessoa não deixou WhatsApp).
export const FORMULARIO_PADRAO = { iaResponde: true };
// Robô preenche na hora: abaixo disso não é uma pessoa.
const TEMPO_MINIMO_MS = 3000;
const MESMO_IP_MS = 20_000;
const MESMO_CONTATO_MS = 10 * 60_000;

export async function lerConfigFormulario() {
  return { ...FORMULARIO_PADRAO, ...((await db.lerConfig("formulario")) ?? {}) };
}

export const salvarConfigFormulario = async ({ iaResponde }) => {
  await db.gravarConfig("formulario", { ...(await lerConfigFormulario()), iaResponde: Boolean(iaResponde) });
  return lerConfigFormulario();
};

const texto = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Confere os campos e devolve os dados limpos, ou { erro } com o que a pessoa precisa corrigir. */
export function validarFormulario(dados = {}, agora = Date.now()) {
  // Campo escondido que só robô preenche, e formulário enviado rápido demais.
  if (texto(dados.site, 200)) return { robo: true };
  const aberto = Number(dados.t);
  if (aberto && agora - aberto < TEMPO_MINIMO_MS) return { robo: true };

  const nome = texto(dados.nome, 80);
  const empresa = texto(dados.empresa, 100);
  const whatsapp = dados.whatsapp ? normalizarTelefoneBR(dados.whatsapp) : null;
  const email = texto(dados.email, 120).toLowerCase() || null;
  if (nome.length < 2) return { erro: "Conta pra gente o seu nome." };
  if (dados.whatsapp && !whatsapp) return { erro: "Confira o WhatsApp: DDD + número, ex.: (85) 99999-9999." };
  if (email && !EMAIL.test(email)) return { erro: "Confira o e-mail." };
  if (!whatsapp && !email) return { erro: "Deixe o seu WhatsApp (ou e-mail) para a gente te responder." };
  if (![true, "true", "on", "1", 1].includes(dados.consentimento)) return { erro: "Marque que aceita ser contatado, para a gente poder te responder." };
  return {
    nome, empresa, whatsapp, email,
    servico: texto(dados.servico, 80),
    mensagem: String(dados.mensagem ?? "").trim().slice(0, 1000),
    origem: texto(dados.origem, 40).replace(/[^\p{L}\p{N} _-]/gu, ""),
  };
}

const resumo = (d) => [
  `[formulário do site${d.origem ? ` · veio de: ${d.origem}` : ""}]`,
  `Nome: ${d.nome}`, d.empresa && `Empresa: ${d.empresa}`, d.servico && `Precisa de: ${d.servico}`,
  d.mensagem && `Mensagem: ${d.mensagem}`,
].filter(Boolean).join("\n");

/**
 * Recebe um envio do formulário: confere, evita robô e envio repetido, liga à empresa que já tem esse
 * contato (ou cria o lead) e registra como a primeira mensagem da conversa, para a IA responder.
 * Retorna { ok } ou { erro }.
 */
export async function receberFormulario(dados, campanha, { ip = "", agora = Date.now(), registrar = registrarResposta, avisar = enviarNotificacao } = {}) {
  const d = validarFormulario(dados, agora);
  if (d.robo) return { ok: true }; // robô não precisa saber que foi barrado
  if (d.erro) return { erro: d.erro };

  const doIp = crypto.createHash("sha256").update(`formulario:${ip}`).digest("hex").slice(0, 24);
  if (ip && !(await db.travar(`formulario_ip:${doIp}`, MESMO_IP_MS))) return { erro: "Recebemos seu envio. Aguarde alguns segundos para enviar de novo." };
  // A mesma pessoa clicando duas vezes (ou enviando de novo) não abre duas conversas.
  if (!(await db.travar(`formulario_contato:${d.whatsapp ?? d.email}`, MESMO_CONTATO_MS))) return { ok: true, repetido: true };

  const conhecido = await db.leadPorContato({ whatsapps: d.whatsapp ? variantesWhatsappBR(d.whatsapp) : [], email: d.email });
  const lead = conhecido ?? (await db.buscarLead(await db.criarLeadDeContato({
    nome: d.empresa || d.nome, whatsapp: d.whatsapp, email: d.email, origem: "formulario",
    observacao: `Preencheu o formulário do site${d.servico ? `: ${d.servico}` : ""}${d.origem ? ` (veio de ${d.origem})` : ""}`,
  })));
  if (conhecido && !["agendado", "fechado"].includes(lead.status)) await db.atualizarLead(lead.id, { status: "respondeu" });

  const cfg = await lerConfigFormulario();
  const canal = d.whatsapp ? "whatsapp" : "email";
  const r = await registrar({
    lead, canal, de: d.whatsapp ?? d.email, texto: resumo(d), nomeRemetente: d.nome,
    origem_id: `<formulario-${crypto.randomUUID()}@prospecta>`,
    assunto: canal === "email" ? `Seu contato pelo site da ${campanha.empresa.nome}` : null,
    // Ligado no painel, a IA responde mesmo com a resposta automática desligada para as outras conversas.
    campanha: { ...campanha, automacao: { ...campanha.automacao, respostaAutomatica: cfg.iaResponde } },
  });
  await avisar(
    `Novo contato pelo site: ${d.nome}${d.empresa ? ` (${d.empresa})` : ""}`,
    `${resumo(d)}\n\nWhatsApp: ${d.whatsapp ?? "-"}\nE-mail: ${d.email ?? "-"}\n\n${cfg.iaResponde ? `A IA vai chamar pelo ${canal === "whatsapp" ? "WhatsApp" : "e-mail"} (em horário comercial).` : "Responda pela página Respostas do painel."}`
  ).catch((e) => log(`⚠️  Não foi possível avisar do contato do site: ${e.message}`));
  log(`📝 Contato pelo formulário do site: ${d.nome}${d.empresa ? ` (${d.empresa})` : ""} · ${canal}`);
  return { ok: true, leadId: lead.id, respostaId: r?.id ?? null };
}
