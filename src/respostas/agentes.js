import * as db from "../db.js";
import * as uazap from "../envio/uazap.js";

// Agentes de atendimento: cada um responde, com o próprio prompt, as conversas dos números de WhatsApp
// (instâncias da UAZap) escolhidos para ele. Um número tem no máximo um agente. Número com agente não
// manda prospecção da FluxDeck para empresas novas, e contato novo nele vira conversa do agente.

export const MODOS_DELEGAR = ["mensagem", "fixa", "silencio"];
// A conversa que o agente passou para você fica parada com este motivo (e volta com "IA continua").
export const PREFIXO_DELEGOU = "delegou para você: ";
export const delegou = (pausa) => String(pausa ?? "").startsWith(PREFIXO_DELEGOU);

const LIMITE_PROMPT = 60_000;
const LIMITE_CONHECIMENTO = 100_000;
const LIMITE_ARQUIVO = 100_000;
const MAX_ARQUIVOS = 20;
// Sem resposta do cliente há mais que isso: a conversa aparece como "sem resposta".
const HORAS_SEM_RESPOSTA = 24;

const texto = (v, max) => String(v ?? "").replace(/\r\n/g, "\n").slice(0, max);

/** O agente que atende este número (ligado ou não), ou null: o número segue como antes. */
export async function agenteDoNumero(numeroId) {
  if (!numeroId) return null;
  return (await db.listarAgentes()).find((a) => a.numeros.includes(numeroId)) ?? null;
}

/** Ids dos números que têm agente: eles ficam fora da prospecção de empresas novas. */
export async function numerosComAgente() {
  return new Set((await db.listarAgentes()).flatMap((a) => a.numeros));
}

/**
 * Cria (sem `id`) ou atualiza um agente. Confere os números (existem e não são de outro agente)
 * e só deixa ligar com prompt e número escolhido.
 */
export async function salvarAgente(id, dados) {
  const atual = id ? await db.buscarAgente(id) : null;
  if (id && !atual) throw new Error("Agente não encontrado");
  const v = { ...atual, ...Object.fromEntries(Object.entries(dados ?? {}).filter(([, x]) => x !== undefined)) };
  const campos = {
    nome: texto(v.nome, 60).trim(),
    prompt: texto(v.prompt, LIMITE_PROMPT).trim(),
    conhecimento: texto(v.conhecimento, LIMITE_CONHECIMENTO).trim(),
    numeros: [...new Set((Array.isArray(v.numeros) ? v.numeros : []).map(String))],
    ligado: v.ligado === true || v.ligado === "true",
    delegar_modo: MODOS_DELEGAR.includes(v.delegar_modo) ? v.delegar_modo : "mensagem",
    delegar_mensagem: texto(v.delegar_mensagem, 1000).trim() || null,
    pendencias: texto(v.pendencias, 2000).trim() || null,
    max_respostas: Math.min(200, Math.max(1, Math.round(Number(v.max_respostas) || 40))),
  };
  if (!campos.nome) throw new Error("Dê um nome ao agente");
  if (campos.delegar_modo === "fixa" && !campos.delegar_mensagem) throw new Error("Escreva a mensagem que o cliente recebe ao passar para você");
  const existentes = new Map((await uazap.numeros()).map((n) => [n.id, n]));
  const desconhecido = campos.numeros.find((n) => !existentes.has(n));
  if (desconhecido) throw new Error("Um dos números escolhidos não existe mais em Configurações");
  for (const outro of await db.listarAgentes()) {
    if (outro.id === atual?.id) continue;
    const repetido = campos.numeros.find((n) => outro.numeros.includes(n));
    if (repetido) throw new Error(`O número "${existentes.get(repetido).nome}" já é atendido pelo agente ${outro.nome}`);
  }
  if (campos.numeros.length > 1) throw new Error("Cada agente atende um número de WhatsApp só");
  if (campos.ligado && !campos.prompt) throw new Error("Escreva o prompt do agente antes de ligar");
  if (campos.ligado && !campos.numeros.length) throw new Error("Escolha o número de WhatsApp do agente antes de ligar");
  if (atual) await db.atualizarAgente(atual.id, campos);
  return db.buscarAgente(atual?.id ?? (await db.criarAgente(campos)));
}

/** Só apaga agente sem conversas; com conversas, desligue (o histórico fica no CRM). */
export async function excluirAgente(id) {
  const agente = await db.buscarAgente(id);
  if (!agente) throw new Error("Agente não encontrado");
  if ((await db.numerosDoAgente(agente.id)).conversas) throw new Error("Este agente já tem conversas: desligue em vez de excluir, para o histórico continuar no CRM");
  await db.excluirAgente(agente.id);
}

export async function adicionarArquivo(agenteId, nome, conteudo) {
  if (!(await db.buscarAgente(agenteId))) throw new Error("Agente não encontrado");
  const limpo = texto(conteudo, LIMITE_ARQUIVO + 1).trim();
  if (!limpo) throw new Error("O arquivo está vazio ou não é de texto");
  if (limpo.length > LIMITE_ARQUIVO) throw new Error(`O arquivo passa de ${LIMITE_ARQUIVO / 1000} mil caracteres; divida em partes`);
  if ((await db.arquivosDoAgente(agenteId)).length >= MAX_ARQUIVOS) throw new Error(`Cada agente tem no máximo ${MAX_ARQUIVOS} arquivos`);
  return db.criarArquivoDoAgente(agenteId, texto(nome, 120).trim() || "arquivo.txt", limpo);
}

/** A base de conhecimento do agente: o texto escrito no painel e o dos arquivos. */
export async function fontesDoAgente(agente) {
  return [
    ...(agente.conhecimento?.trim() ? [{ nome: "Base de conhecimento", texto: agente.conhecimento }] : []),
    ...(await db.textosDoAgente(agente.id)),
  ];
}

/** O que falta para o agente atender: aparece no painel. */
export function faltando(agente, arquivos = 0) {
  const lista = [];
  if (!agente.prompt?.trim()) lista.push("o prompt");
  if (!agente.conhecimento?.trim() && !arquivos) lista.push("a base de conhecimento");
  if (!agente.numeros.length) lista.push("o número de WhatsApp");
  return lista;
}

export const ANDAMENTOS = {
  em_conversa: "Em conversa",
  delegou: "Delegou para você",
  sem_resposta: "Sem resposta",
  fechou: "Fechou",
  encerrada: "Encerrada",
};

/** Andamento de uma conversa do agente (uma linha de db.conversas()). */
export function andamentoDoAgente(c, agora = new Date()) {
  let estado = "em_conversa";
  if (["fechado", "agendado"].includes(c.status)) estado = "fechou";
  else if (["sem_interesse", "descadastrado", "descartado"].includes(c.status)) estado = "encerrada";
  else if (delegou(c.ia_pausada)) estado = "delegou";
  else if (c.ultima?.autor === "nos" && agora - new Date(c.ultima.quando) > HORAS_SEM_RESPOSTA * 3600_000) estado = "sem_resposta";
  return { estado, rotulo: ANDAMENTOS[estado] };
}

/**
 * O número de WhatsApp do agente, criado pelo CRM dele: uma instância nova na UAZap (ou a que o dono informar pelo
 * token), com o webhook apontado para o sistema e já atribuída ao agente. Cada agente tem um número só.
 */
export async function criarNumeroDoAgente(agenteId, { token = "" } = {}) {
  const trava = `agente_numero:${agenteId}`;
  if (!(await db.travar(trava, 60_000))) throw new Error("O número já está sendo criado. Aguarde alguns segundos.");
  try {
    const agente = await db.buscarAgente(agenteId);
    if (!agente) throw new Error("Agente não encontrado");
    if (agente.numeros.length) throw new Error("Este agente já tem um número de WhatsApp. Cada agente usa um número só.");
    const instancia = String(token).trim()
      ? { url: (await uazap.lerAdmin()).url, token: String(token).trim() }
      : await uazap.criarInstancia(`agente-${agente.id}-${agente.nome}`.normalize("NFD").replace(/[^\w-]+/g, "-").toLowerCase().slice(0, 40));
    if (!instancia.url) throw new Error("A FluxDeck ainda não configurou o servidor da UAZap");
    const n = await uazap.salvarNumero({ nome: `${agente.nome} (agente)`, url: instancia.url, token: instancia.token });
    await uazap.configurarWebhook(n.id);
    await salvarAgente(agente.id, { numeros: [n.id] });
    return n;
  } finally {
    await db.destravar(trava);
  }
}
