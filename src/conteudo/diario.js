import { config } from "../config.js";
import * as db from "../db.js";
import { gerarPost, PILARES } from "../ia/conteudo.js";
import { enviarNotificacao } from "../envio/email.js";
import { lerBaseDeConteudo } from "./base.js";
import { postarNoInstagram, MAX_TENTATIVAS } from "./instagram.js";
import { lerConexao, renovarTokenSePreciso } from "../envio/instagram.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Um post por dia, alternando Reels e carrossel, pronto às 18h (Brasília). Ajustável no painel.
// Com o Instagram conectado, ele sai sozinho no perfil nesse horário.
export const CONTEUDO_PADRAO = { ativo: true, horario: 18, postarSozinho: true };
// O agendador do banco passa a cada 15 minutos; o post é criado na passagem logo antes do horário.
const ANTECEDENCIA_MIN = 15;

export async function lerConfigConteudo() {
  return { ...CONTEUDO_PADRAO, ...((await db.lerConfig("conteudo")) ?? {}) };
}

/** Dia (AAAA-MM-DD) e minutos desde a meia-noite, no fuso de Brasília. */
export function agoraEmBrasilia(agora = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(agora)
      .map((x) => [x.type, x.value])
  );
  return { dia: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute) };
}

/** Já passou da hora de criar o post de hoje? */
export const horaDoPost = (horario, agora = new Date()) => agoraEmBrasilia(agora).minutos >= horario * 60 - ANTECEDENCIA_MIN;

/** Reels num dia, carrossel no outro: o contrário do último post. */
export function proximoFormato(ultimo) {
  return ultimo?.formato === "reels" ? "carrossel" : "reels";
}

/** Linha editorial do dia, em rodízio pelo dia do ano (e a seguinte a cada "gerar outro"). */
export function pilarDoDia(dia, tentativa = 0) {
  const nomes = Object.keys(PILARES);
  const diaDoAno = Math.floor((Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${dia.slice(0, 4)}-01-01T12:00:00Z`)) / 864e5);
  return nomes[(diaDoAno + tentativa) % nomes.length];
}

/** Cria um post para hoje. `formato` fixo serve para "gerar outro" no lugar de um post. */
export async function criarPostDeHoje(campanha, { formato, escrever = gerarPost, agora = new Date() } = {}) {
  const { dia } = agoraEmBrasilia(agora);
  const recentes = await db.postsRecentes(30);
  const deHoje = await db.postsDoDia(dia);
  const ultimoAntesDeHoje = recentes.find((p) => p.dia < dia);
  const escolhido = formato ?? deHoje.find((p) => p.status !== "descartado")?.formato ?? proximoFormato(ultimoAntesDeHoje);
  const pilar = pilarDoDia(dia, deHoje.length);
  const base = await lerBaseDeConteudo();
  const conteudo = await escrever({ campanha, formato: escolhido, pilar, base, recentes: recentes.map((p) => p.tema) });
  const id = await db.criarPost({ dia, formato: escolhido, pilar, tema: conteudo.tema, conteudo });
  log(`🎬 Post do dia criado (${escolhido}, ${pilar}): ${conteudo.tema}`);
  return db.buscarPost(id);
}

/**
 * Chamado pelo agendador a cada 15 minutos: um pouco antes do horário escolhido, cria o post
 * do dia (se ainda não houver); no horário, publica no Instagram (se a conta estiver conectada).
 */
export async function rodadaDeConteudo(campanha, { agora = new Date(), escrever = gerarPost, postar = postarNoInstagram } = {}) {
  const conf = await lerConfigConteudo();
  if (!conf.ativo) return { conteudo: "desligado" };
  if (!horaDoPost(conf.horario, agora)) return { conteudo: "antes do horário" };
  const { dia, minutos } = agoraEmBrasilia(agora);
  const conectado = conf.postarSozinho && Boolean((await lerConexao())?.token);
  const deHoje = (await db.postsDoDia(dia)).filter((p) => p.status !== "descartado");
  if (!deHoje.length) return criarEAvisar(campanha, conf, { agora, escrever, conectado, dia });

  // Um post por dia no perfil: o primeiro de hoje que ainda não saiu (os extras do botão ficam para você).
  if (!conectado || minutos < conf.horario * 60) return { conteudo: "post de hoje já criado" };
  if (deHoje.some((p) => p.status === "postado")) return { conteudo: "post de hoje já publicado" };
  const pendente = deHoje.find((p) => (p.instagram_tentativas ?? 0) < MAX_TENTATIVAS);
  if (!pendente) return { conteudo: "post de hoje não foi aceito pelo Instagram" };
  await renovarTokenSePreciso(agora).catch((e) => log(`⚠️  ${e.message}`));
  return { conteudo: "publicando", postId: pendente.id, ...(await postar(pendente.id, campanha)) };
}

async function criarEAvisar(campanha, conf, { agora, escrever, conectado, dia }) {
  // Dois agendadores ao mesmo tempo não criam dois posts.
  if (!(await db.travar(`post_do_dia_${dia}`, 10 * 60_000))) return { conteudo: "post de hoje sendo criado" };
  const post = await criarPostDeHoje(campanha, { agora, escrever });
  const formato = post.formato === "reels" ? "Reels" : "carrossel";
  await enviarNotificacao(
    `Post do dia pronto: ${post.conteudo.gancho}`,
    conectado
      ? `O ${formato} de hoje está pronto e sai sozinho no Instagram às ${conf.horario}h. Se quiser trocar ou descartar antes, é na página Conteúdo do painel (${config.painel.urlPublica}/#conteudo).`
      : `O ${formato} de hoje está pronto na página Conteúdo do painel (${config.painel.urlPublica}/#conteudo). Baixe, copie a legenda com as hashtags e poste às ${conf.horario}h.`
  ).catch((e) => log(`⚠️  Não foi possível avisar do post: ${e.message}`));
  return { conteudo: "criado", postId: post.id };
}
