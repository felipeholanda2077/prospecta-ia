import { config } from "../config.js";
import * as db from "../db.js";
import { gerarPost, PILARES, ESTRUTURAS } from "../ia/conteudo.js";
import { enviarNotificacao } from "../envio/email.js";
import { lerBaseDeConteudo } from "./base.js";
import { postarNoInstagram, MAX_TENTATIVAS } from "./instagram.js";
import { lerConexao, renovarTokenSePreciso } from "../envio/instagram.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Dois posts por dia, às 12h e às 18h (Brasília), alternando Reels e carrossel. Ajustável no painel.
// Com o Instagram conectado, cada um sai sozinho no perfil no seu horário.
export const CONTEUDO_PADRAO = { ativo: true, horarios: [12, 18], postarSozinho: true };
// O agendador do banco passa a cada 15 minutos; o post é criado na passagem logo antes do horário.
const ANTECEDENCIA_MIN = 15;
// Se o sistema estava parado no horário, o post ainda é criado até 2 horas depois; mais que isso, pula.
const ATRASO_MAXIMO_MIN = 120;

/** Horários válidos (6h às 23h), sem repetir e em ordem. */
export function normalizarHorarios(lista) {
  const horas = (Array.isArray(lista) ? lista : String(lista ?? "").split(/[^\d]+/))
    .map((h) => Number.parseInt(h, 10))
    .filter((h) => h >= 6 && h <= 23);
  return [...new Set(horas)].sort((a, b) => a - b);
}

export async function lerConfigConteudo() {
  // A configuração antiga tinha um horário só (`horario`); ela passou para os horários do padrão.
  const { horario, ...salvo } = (await db.lerConfig("conteudo")) ?? {};
  const horarios = normalizarHorarios(salvo.horarios);
  return { ...CONTEUDO_PADRAO, ...salvo, horarios: horarios.length ? horarios : CONTEUDO_PADRAO.horarios };
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

/** Já passou da hora de criar o post deste horário? */
export const horaDoPost = (horario, agora = new Date()) => agoraEmBrasilia(agora).minutos >= horario * 60 - ANTECEDENCIA_MIN;

/** Reels num post, carrossel no seguinte: o contrário do último post. */
export function proximoFormato(ultimo) {
  return ultimo?.formato === "reels" ? "carrossel" : "reels";
}

/** Linha editorial do dia, em rodízio pelo dia do ano (e a seguinte a cada "gerar outro"). */
export function pilarDoDia(dia, tentativa = 0) {
  const nomes = Object.keys(PILARES);
  const diaDoAno = Math.floor((Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${dia.slice(0, 4)}-01-01T12:00:00Z`)) / 864e5);
  return nomes[(diaDoAno + tentativa) % nomes.length];
}

/**
 * Estrutura do roteiro do post, em rodízio próprio, separado da linha editorial.
 */
export function estruturaDoPost(dia, n = 0) {
  const nomes = Object.keys(ESTRUTURAS);
  const diaDoAno = Math.floor((Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${dia.slice(0, 4)}-01-01T12:00:00Z`)) / 864e5);
  // Nunca repete a estrutura do post anterior, e o deslocamento a cada ciclo completo faz o
  // assunto e a estrutura não se repetirem juntos (40 posts seguidos, 40 combinações diferentes).
  return nomes[(diaDoAno + n * 2 + 5 + Math.floor(diaDoAno / nomes.length) * 2) % nomes.length];
}

/**
 * Cria um post para hoje. `formato` fixo serve para "gerar outro" no lugar de um post; `horario`
 * é o horário do dia em que ele sai (sem horário, entra no próximo horário vago).
 */
export async function criarPostDeHoje(campanha, { formato, horario = null, escrever = gerarPost, agora = new Date() } = {}) {
  const { dia } = agoraEmBrasilia(agora);
  const recentes = await db.postsRecentes(30);
  const deHoje = await db.postsDoDia(dia);
  const escolhido = formato ?? proximoFormato(recentes[0]);
  const pilar = pilarDoDia(dia, deHoje.length);
  const estrutura = estruturaDoPost(dia, deHoje.length);
  const base = await lerBaseDeConteudo();
  const conteudo = await escrever({
    campanha, formato: escolhido, pilar, estrutura, base,
    recentes: recentes.slice(0, 20).map((p) => ({ tema: p.tema, gancho: p.conteudo?.gancho ?? "" })),
  });
  const id = await db.criarPost({ dia, formato: escolhido, pilar, tema: conteudo.tema, conteudo, horario });
  log(`🎬 Post criado${horario ? ` para as ${horario}h` : ""} (${escolhido}, ${pilar}, ${estrutura}): ${conteudo.tema}`);
  return db.buscarPost(id);
}

/**
 * Chamado pelo agendador a cada 15 minutos. Para cada horário do dia: um pouco antes, cria o post
 * desse horário (se ainda não houver); no horário, publica no Instagram (se a conta estiver
 * conectada). Faz uma coisa por vez: o que sobrar fica para a passagem seguinte.
 */
export async function rodadaDeConteudo(campanha, { agora = new Date(), escrever = gerarPost, postar = postarNoInstagram } = {}) {
  const conf = await lerConfigConteudo();
  if (!conf.ativo) return { conteudo: "desligado" };
  const { dia, minutos } = agoraEmBrasilia(agora);
  const chegaram = conf.horarios.filter((h) => horaDoPost(h, agora));
  if (!chegaram.length) return { conteudo: "antes do horário" };
  const conectado = conf.postarSozinho && Boolean((await lerConexao())?.token);
  const deHoje = (await db.postsDoDia(dia)).filter((p) => p.status !== "descartado");

  // Posts de hoje criados pelo botão (sem horário) ocupam o primeiro horário vago.
  for (const h of chegaram) {
    if (deHoje.some((p) => p.horario === h)) continue;
    const solto = deHoje.find((p) => p.horario == null);
    if (!solto) break;
    await db.definirHorarioDoPost(solto.id, h);
    solto.horario = h;
  }

  let situacao = null;
  for (const h of chegaram) {
    const post = deHoje.find((p) => p.horario === h);
    // Só o horário da vez ganha post novo: um horário que já passou sem post (sistema desligado,
    // por exemplo) não vira post atrasado.
    if (!post) {
      if (h === chegaram.at(-1) && minutos <= h * 60 + ATRASO_MAXIMO_MIN) return criarEAvisar(campanha, conf, { agora, escrever, conectado, dia, horario: h });
      continue;
    }
    if (post.status === "postado") situacao = `post das ${h}h já publicado`;
    else if (!conectado || minutos < h * 60) situacao = `post das ${h}h já criado`;
    else if ((post.instagram_tentativas ?? 0) >= MAX_TENTATIVAS) situacao = `post das ${h}h não foi aceito pelo Instagram`;
    else {
      await renovarTokenSePreciso(agora).catch((e) => log(`⚠️  ${e.message}`));
      return { conteudo: "publicando", horario: h, postId: post.id, ...(await postar(post.id, campanha)) };
    }
  }
  return { conteudo: situacao ?? "nada a fazer" };
}

async function criarEAvisar(campanha, conf, { agora, escrever, conectado, dia, horario }) {
  // Dois agendadores ao mesmo tempo não criam dois posts.
  if (!(await db.travar(`post_do_dia_${dia}_${horario}`, 10 * 60_000))) return { conteudo: "post sendo criado" };
  const post = await criarPostDeHoje(campanha, { agora, escrever, horario });
  const formato = post.formato === "reels" ? "Reels" : "carrossel";
  await enviarNotificacao(
    `Post das ${horario}h pronto: ${post.conteudo.gancho}`,
    conectado
      ? `O ${formato} das ${horario}h está pronto e sai sozinho no Instagram nesse horário. Se quiser trocar ou descartar antes, é na página Conteúdo do painel (${config.painel.urlPublica}/#conteudo).`
      : `O ${formato} das ${horario}h está pronto na página Conteúdo do painel (${config.painel.urlPublica}/#conteudo). Baixe, copie a legenda com as hashtags e poste às ${horario}h.`
  ).catch((e) => log(`⚠️  Não foi possível avisar do post: ${e.message}`));
  return { conteudo: "criado", horario, postId: post.id };
}
