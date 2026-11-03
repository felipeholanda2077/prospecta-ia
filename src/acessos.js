import crypto from "node:crypto";
import * as db from "./db.js";

// Acessos ao painel além do admin principal (PAINEL_USUARIO e PAINEL_SENHA, na Vercel). Todos entram como admin.
// A senha fica só como resumo (scrypt com sal próprio); cada acesso tem uma versão, que vai na sessão:
// remover o acesso troca tudo e derruba as sessões dele.
const CHAVE = "acessos_painel";
// As sessões conferem a lista guardada por pouco tempo, para não ler o banco a cada chamada do painel.
const GUARDADO_MS = 30_000;
let guardado = null;

export const normalizarUsuario = (usuario) => String(usuario ?? "").trim().toLowerCase();
const resumir = (senha, sal) => crypto.scryptSync(String(senha), sal, 64).toString("hex");

async function lerTodos({ fresco = false } = {}) {
  if (!fresco && guardado && Date.now() < guardado.ate) return guardado.lista;
  const lista = (await db.lerConfig(CHAVE))?.lista ?? [];
  guardado = { lista, ate: Date.now() + GUARDADO_MS };
  return lista;
}

async function gravar(lista) {
  await db.gravarConfig(CHAVE, { lista });
  guardado = { lista, ate: Date.now() + GUARDADO_MS };
}

const publico = ({ usuario, nome, criado }) => ({ usuario, nome, criado });

export async function listarAcessos() {
  return (await lerTodos({ fresco: true })).map(publico);
}

/** Cria um acesso de admin. `principal` é o usuário da Vercel, que não pode ser repetido. Retorna { acesso } ou { erro }. */
export async function criarAcesso({ nome, usuario, senha } = {}, { principal = "" } = {}) {
  const u = normalizarUsuario(usuario);
  if (!/^[a-z0-9._-]{3,40}$/.test(u)) return { erro: "Usuário: de 3 a 40 letras, números, ponto, hífen ou sublinhado, sem espaço" };
  if (u === normalizarUsuario(principal)) return { erro: "Esse usuário já é o do admin principal" };
  if (String(senha ?? "").length < 8) return { erro: "A senha precisa ter pelo menos 8 caracteres" };
  const lista = await lerTodos({ fresco: true });
  if (lista.some((a) => a.usuario === u)) return { erro: "Já existe um acesso com esse usuário" };
  const sal = crypto.randomBytes(16).toString("hex");
  const novo = {
    usuario: u, nome: String(nome ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || u,
    sal, resumo: resumir(senha, sal), versao: crypto.randomBytes(8).toString("hex"), criado: new Date().toISOString(),
  };
  await gravar([...lista, novo]);
  return { acesso: publico(novo) };
}

export async function removerAcesso(usuario) {
  const u = normalizarUsuario(usuario);
  const lista = await lerTodos({ fresco: true });
  if (!lista.some((a) => a.usuario === u)) return false;
  await gravar(lista.filter((a) => a.usuario !== u));
  return true;
}

/** O acesso, se o usuário e a senha conferem (o tempo da resposta é o mesmo quando o usuário não existe). */
export async function conferirSenha(usuario, senha) {
  const acesso = (await lerTodos({ fresco: true })).find((a) => a.usuario === normalizarUsuario(usuario));
  const esperado = Buffer.from(acesso?.resumo ?? "0".repeat(128), "hex");
  const recebido = Buffer.from(resumir(senha, acesso?.sal ?? "sem-acesso"), "hex");
  return acesso && crypto.timingSafeEqual(esperado, recebido) ? acesso : null;
}

/** O acesso continua valendo para esta sessão? (Removido ou recriado, a versão muda.) */
export async function acessoAtivo(usuario, versao) {
  return (await lerTodos()).find((a) => a.usuario === usuario && a.versao === versao) ?? null;
}
