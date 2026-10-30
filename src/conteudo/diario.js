import { config } from "../config.js";
import * as db from "../db.js";
import { gerarPost, PILARES, ESTRUTURAS, PUBLICOS, TONS } from "../ia/conteudo.js";
import { colocarFotos } from "./fotos.js";
import { pedirClipes } from "./avatar.js";
import { enviarNotificacao } from "../envio/email.js";
import { lerBaseDeConteudo } from "./base.js";
import { postarNoInstagram, MAX_TENTATIVAS } from "./instagram.js";
import { lerConexao, renovarTokenSePreciso } from "../envio/instagram.js";
import { postarNoLinkedin, textoDoPost, MAX_TENTATIVAS as MAX_TENTATIVAS_LINKEDIN } from "./linkedin.js";
import { lerConexao as lerConexaoLinkedin, renovarTokenSePreciso as renovarTokenLinkedin } from "../envio/linkedin.js";
import { desempenho, escolherPorDesempenho, lerAprendizados, MINIMO_PARA_APRENDER } from "./insights.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Dois posts por dia, às 12h e às 18h (Brasília), alternando Reels e carrossel. Ajustável no painel.
// Com o Instagram conectado, cada um sai sozinho no perfil no seu horário.
export const CONTEUDO_PADRAO = { ativo: true, horarios: [12, 18], postarSozinho: true, apresentador: true };
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
export async function criarPostDeHoje(campanha, { formato, horario = null, escrever = gerarPost, agora = new Date(), sorteio = Math.random, fotos = colocarFotos, clipes = pedirClipes, escreverLinkedin } = {}) {
  const { dia } = agoraEmBrasilia(agora);
  const recentes = await db.postsRecentes(30);
  const deHoje = await db.postsDoDia(dia);
  const escolha = await escolhaPeloDesempenho({ dia, n: deHoje.length, recentes, agora, sorteio });
  const escolhido = formato ?? escolha.formato;
  const { pilar, estrutura } = escolha;
  const base = await lerBaseDeConteudo();
  const conf = await lerConfigConteudo();
  const variedade = escolherVariedade(recentes, { formato: escolhido, apresentador: conf.apresentador, sorteio });
  const pedido = {
    campanha, formato: escolhido, pilar, estrutura, base, aprendizados: escolha.aprendizados, ...variedade,
    recentes: recentes.slice(0, 20).map((p) => ({ tema: p.tema, gancho: p.conteudo?.gancho ?? "" })),
  };
  let escrito = await escrever(pedido);
  // Saiu parecido demais com um post recente: pede outro, uma vez, dizendo com qual ficou igual.
  const parecido = ganchoParecido(escrito.gancho, recentes);
  if (parecido) {
    log(`🔁 Gancho parecido com um post recente ("${parecido}"); a IA escreve outro`);
    escrito = await escrever({ ...pedido, aviso: `o gancho "${escrito.gancho}" ficou parecido demais com "${parecido}". Escreva outro assunto, com outro gancho.` });
  }
  const conteudo = await clipes(await fotos({ ...escrito, ...variedade }, { formato: escolhido, dia }), { formato: escolhido });
  // Os estilos de foto sem nenhuma foto achada virariam fundo escuro: troca por um que não depende dela.
  if (["foto_cheia", "dividido"].includes(conteudo.arte) && !conteudo.slides?.some((s) => s.foto)) conteudo.arte = sorteio() < 0.5 ? "cor" : "claro";
  const id = await db.criarPost({ dia, formato: escolhido, pilar, tema: conteudo.tema, conteudo, horario });
  log(`🎬 Post criado${horario ? ` para as ${horario}h` : ""} (${escolhido}, ${pilar}, ${estrutura}, ${variedade.publico}, ${variedade.tom}, arte ${variedade.arte}${variedade.comFelipe ? ", com Felipe" : ""}${escolha.peloDesempenho ? ", pelos insights" : ""}): ${conteudo.tema}`);
  const post = await db.buscarPost(id);
  // Com o LinkedIn conectado, o texto dele já fica pronto para aparecer no painel. Se a IA falhar aqui, é escrito ao publicar.
  if ((await lerConexaoLinkedin()).organizacao) await textoDoPost(post, campanha, { escrever: escreverLinkedin }).catch((e) => log(`⚠️  Texto do LinkedIn fica para a hora de publicar: ${e.message}`));
  return post;
}

const ARTES_DOS_POSTS = ["foto_cheia", "dividido", "claro", "cor", "escuro"];

/** Sorteia entre as opções que não apareceram nos últimos posts. */
function sortearSemRepetir(opcoes, usados, sorteio) {
  const livres = opcoes.filter((o) => !usados.includes(o));
  const lista = livres.length ? livres : opcoes;
  return lista[Math.floor(sorteio() * lista.length) % lista.length];
}

/**
 * Para quem o post fala, o tom e o estilo visual: cada um fora dos últimos posts, para o feed não repetir.
 * O Felipe aparece em um Reels sim, um não.
 */
export function escolherVariedade(recentes, { formato, apresentador = true, sorteio = Math.random } = {}) {
  const de = (campo, n) => recentes.slice(0, n).map((p) => p.conteudo?.[campo]).filter(Boolean);
  const ultimoReels = recentes.find((p) => p.formato === "reels");
  return {
    publico: sortearSemRepetir(Object.keys(PUBLICOS), de("publico", 8), sorteio),
    tom: sortearSemRepetir(Object.keys(TONS), de("tom", 4), sorteio),
    arte: sortearSemRepetir(ARTES_DOS_POSTS, de("arte", 3), sorteio),
    comFelipe: formato === "reels" && apresentador !== false && !ultimoReels?.conteudo?.comFelipe,
  };
}

const palavrasDe = (t) => String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];

/** O gancho recente com que este ficou parecido (mesmo começo ou metade das palavras iguais), ou null. */
export function ganchoParecido(gancho, recentes) {
  const novo = palavrasDe(gancho);
  if (!novo.length) return null;
  for (const p of recentes.slice(0, 14)) {
    const velho = palavrasDe(p.conteudo?.gancho);
    if (!velho.length) continue;
    const comuns = novo.filter((x) => velho.includes(x)).length;
    if (novo.slice(0, 2).join(" ") === velho.slice(0, 2).join(" ") || comuns / Math.min(novo.length, velho.length) >= 0.5) return p.conteudo.gancho;
  }
  return null;
}

// Mesmo com os insights, 1 em cada 4 posts segue o rodízio normal: assim os assuntos e estruturas que
// ainda não foram bem testados continuam aparecendo, e a IA não fica presa no que deu certo uma vez.
const CHANCE_DE_EXPLORAR = 0.25;

/**
 * Formato, linha editorial e estrutura do próximo post. Sem insights suficientes, o rodízio de sempre.
 * Com eles, mais chance para o que performa melhor no perfil (sem repetir os 2 últimos posts), o
 * formato que está claramente melhor sai em 2 de cada 3 posts, e os aprendizados da IA vão no pedido.
 */
export async function escolhaPeloDesempenho({ dia, n, recentes, agora = new Date(), sorteio = Math.random }) {
  const rodizio = { formato: proximoFormato(recentes[0]), pilar: pilarDoDia(dia, n), estrutura: estruturaDoPost(dia, n) };
  const d = await desempenho({ agora }).catch(() => null);
  const aprendizados = await lerAprendizados();
  const doSistema = d?.posts.filter((p) => p.nota != null && p.conteudo).length ?? 0;
  const comAprendizados = aprendizados && {
    ...aprendizados,
    ganchosQueFuncionaram: (d?.melhores ?? []).map((p) => p.conteudo?.gancho).filter(Boolean),
  };
  if (doSistema < MINIMO_PARA_APRENDER || sorteio() < CHANCE_DE_EXPLORAR) return { ...rodizio, aprendizados: comAprendizados, peloDesempenho: false };

  const ultimos = recentes.slice(0, 2);
  const pilar = escolherPorDesempenho(Object.keys(PILARES), d.porPilar, { evitar: ultimos.map((p) => p.pilar), sorteio: sorteio() });
  const estrutura = escolherPorDesempenho(Object.keys(ESTRUTURAS), d.porEstrutura, { evitar: ultimos.map((p) => p.conteudo?.estrutura), sorteio: sorteio() });
  const { reels, carrossel } = d.porFormato;
  let formato = rodizio.formato;
  if (reels?.posts >= 3 && carrossel?.posts >= 3) {
    const melhor = reels.media >= carrossel.media ? "reels" : "carrossel";
    const pior = melhor === "reels" ? carrossel : reels;
    if (d.porFormato[melhor].media >= 1.3 * pior.media) formato = sorteio() < 2 / 3 ? melhor : melhor === "reels" ? "carrossel" : "reels";
  }
  return { formato, pilar, estrutura, aprendizados: comAprendizados, peloDesempenho: true };
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

// Uma falha no LinkedIn espera 15 minutos antes de tentar de novo.
const ESPERA_ENTRE_TENTATIVAS_MS = 15 * 60_000;

/**
 * Chamado pelo agendador a cada 5 minutos: publica na página do LinkedIn os posts cujo horário chegou,
 * nos mesmos horários do Instagram. Passou a janela de 2 horas, não publica atrasado.
 */
export async function rodadaDoLinkedin(campanha, { agora = new Date(), postar = postarNoLinkedin, avisar = enviarNotificacao } = {}) {
  const conexao = await lerConexaoLinkedin();
  if (!conexao.token || !conexao.organizacao) return { linkedin: "desconectado" };
  const conf = await lerConfigConteudo();
  if (!conf.ativo || !conf.postarSozinho) return { linkedin: "desligado" };
  const token = await renovarTokenLinkedin(agora).catch((e) => (log(`⚠️  ${e.message}`), {}));
  if (token.avisar != null && (await db.travar("linkedin_aviso_token", 3 * 86_400_000))) {
    await avisar(
      `O acesso ao LinkedIn vence em ${token.avisar} dias`,
      `Para os posts continuarem saindo na página, entre de novo no LinkedIn em ${config.painel.urlPublica}/#conteudo (aba Configurações). Leva 1 minuto.`
    ).catch((e) => log(`⚠️  Não foi possível avisar do token do LinkedIn: ${e.message}`));
  }
  const { dia, minutos } = agoraEmBrasilia(agora);
  const pendentes = (await db.postsDoDia(dia)).filter((p) => p.status !== "descartado" && p.horario != null && !p.linkedin_id
    && minutos >= p.horario * 60 && minutos <= p.horario * 60 + ATRASO_MAXIMO_MIN && (p.linkedin_tentativas ?? 0) < MAX_TENTATIVAS_LINKEDIN);
  for (const post of pendentes) {
    if (!(await db.travar(`linkedin_espera_${post.id}`, ESPERA_ENTRE_TENTATIVAS_MS))) continue;
    const r = await postar(post.id, campanha);
    // Só um erro espera: a mídia ainda processando continua na próxima passagem.
    if (r.linkedin !== "erro") await db.destravar(`linkedin_espera_${post.id}`);
    return { linkedin: "publicando", postId: post.id, ...r };
  }
  return { linkedin: "nada a fazer" };
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
