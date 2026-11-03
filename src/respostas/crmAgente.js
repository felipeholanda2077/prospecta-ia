import crypto from "node:crypto";
import * as db from "../db.js";
import { normalizarUsuario } from "../acessos.js";

// CRM externo de cada agente (/crm): o dono do agente entra com o login dele e vê só as conversas desse
// agente. A senha fica só como resumo (scrypt com sal próprio); a sessão leva a versão do acesso, então
// remover o acesso derruba quem estiver dentro.

export const COOKIE_CRM = "prospecta_crm";
export const DURACAO_CRM_MS = 7 * 24 * 3600 * 1000;
const resumir = (senha, sal) => crypto.scryptSync(String(senha), sal, 64).toString("hex");

/** Cria um login do CRM do agente. Retorna o acesso (sem senha) ou lança o motivo. */
export async function criarAcesso(agenteId, { nome, usuario, senha } = {}) {
  if (!(await db.buscarAgente(agenteId))) throw new Error("Agente não encontrado");
  const u = normalizarUsuario(usuario);
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new Error("Usuário: de 3 a 40 letras, números, ponto, hífen ou sublinhado, sem espaço");
  if (String(senha ?? "").length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres");
  const sal = crypto.randomBytes(16).toString("hex");
  const id = await db.criarAcessoDoCrm({
    agente_id: agenteId, usuario: u, sal, resumo: resumir(senha, sal), versao: crypto.randomBytes(8).toString("hex"),
    nome: String(nome ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || u,
  });
  if (!id) throw new Error("Já existe um login do CRM com esse usuário");
  return (await db.acessosDoAgente(agenteId)).find((a) => a.id === id);
}

/** O acesso, se usuário e senha conferem (mesmo tempo de resposta quando o usuário não existe). */
export async function conferirSenha(usuario, senha) {
  const acesso = await db.acessoDoCrmPorUsuario(normalizarUsuario(usuario));
  const esperado = Buffer.from(acesso?.resumo ?? "0".repeat(128), "hex");
  const recebido = Buffer.from(resumir(senha, acesso?.sal ?? "sem-acesso"), "hex");
  return acesso && crypto.timingSafeEqual(esperado, recebido) ? acesso : null;
}

const assinar = (chave, texto) => crypto.createHmac("sha256", chave).update(`crm:${texto}`).digest("hex");

/** O valor do cookie da sessão do CRM: "expira.idDoAcesso.versão.assinatura". */
export function valorDaSessao(acesso, chave, agora = Date.now()) {
  const dados = `${agora + DURACAO_CRM_MS}.${acesso.id}.${acesso.versao}`;
  return `${dados}.${assinar(chave, dados)}`;
}

/** Quem está no CRM: { acesso, agente } ou null (sessão vencida, adulterada, ou acesso removido). */
export async function sessaoDoCrm(valor, chave, agora = Date.now()) {
  const partes = String(valor ?? "").split(".");
  if (partes.length !== 4) return null;
  const [expira, id, versao, assinatura] = partes;
  const esperado = Buffer.from(assinar(chave, `${expira}.${id}.${versao}`));
  const recebido = Buffer.from(assinatura);
  if (!(Number(expira) > agora) || esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  const acesso = await db.acessoDoCrm(Number(id));
  if (!acesso || acesso.versao !== versao) return null;
  const agente = await db.buscarAgente(acesso.agente_id);
  return agente ? { acesso, agente } : null;
}

/** A conversa, só se for deste agente (o CRM nunca abre conversa de outro agente nem da prospecção). */
export async function conversaDoAgente(agenteId, leadId) {
  const lead = await db.buscarLead(Number(leadId));
  if (!lead || lead.agente_id !== agenteId) throw new Error("Conversa não encontrada");
  return lead;
}
