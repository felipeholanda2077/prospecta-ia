import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";
import * as instagram from "../envio/instagram.js";
import { enviarNotificacao } from "../envio/email.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Depois de 3 falhas seguidas o post para de tentar sozinho (e você recebe um e-mail); o botão do painel tenta de novo.
export const MAX_TENTATIVAS = 3;
// O Instagram leva de segundos (imagens) a poucos minutos (vídeo) para processar a mídia.
const ESPERA_MS = 15_000;
const CONSULTAS = 7;

// Os links das mídias são públicos (o Instagram baixa sem login), mas assinados: só o sistema consegue gerar.
const chaveDosLinks = () => crypto.createHash("sha256").update(`prospecta-midia:${config.painel.senha}`).digest();
export const assinaturaDaMidia = (chave) => crypto.createHmac("sha256", chaveDosLinks()).update(chave).digest("hex").slice(0, 32);
export const linkDaMidia = (chave) => `${config.painel.urlPublica}/api/midia/${chave}?a=${assinaturaDaMidia(chave)}`;

/** Legenda com as hashtags, no limite de 2.200 caracteres do Instagram. */
export function legendaDoPost(post) {
  const tags = post.conteudo.hashtags.map((t) => `#${t}`).join(" ");
  // Avatar de IA é avisado na legenda: quem assiste tem que saber.
  const aviso = post.conteudo.slides?.some((s) => s.avatar) ? "\n\nAvatar do Felipe gerado com IA." : "";
  return `${post.conteudo.legenda.slice(0, 2190 - tags.length - aviso.length).trim()}${aviso}\n\n${tags}`;
}

/** Os arquivos do post: as telas em JPEG (carrossel; a capa é a primeira) ou o vídeo em MP4 e a capa em JPEG (Reels). */
export async function gerarArquivos(post, empresa) {
  // Carregado só aqui: o canvas e o ffmpeg são pesados e o resto do sistema não precisa deles.
  const { imagensDoCarrossel, videoDoReels, capaDoReels } = await import("./arquivos.js");
  if (post.formato === "reels") {
    return [
      { chave: `post-${post.id}-reels.mp4`, tipo: "video/mp4", dados: await videoDoReels(post, empresa) },
      { chave: `post-${post.id}-capa.jpg`, tipo: "image/jpeg", dados: await capaDoReels(post, empresa), capa: true },
    ];
  }
  return (await imagensDoCarrossel(post, empresa)).map((dados, i) => ({ chave: `post-${post.id}-${i + 1}.jpg`, tipo: "image/jpeg", dados }));
}

/** Apaga os arquivos do post. Com o TikTok conectado, o vídeo fica para ele aproveitar: ele apaga ao publicar, e o que sobrar sai em 3 dias. */
async function apagarArquivosDoPost(post) {
  const atual = (await db.buscarPost(post.id)) ?? post;
  const guardar = atual.formato === "reels" && !atual.tiktok_id && (await db.lerConfig("tiktok"))?.token ? `post-${atual.id}-reels.mp4` : null;
  await db.apagarMidias(`post-${atual.id}-`, { menos: guardar });
}

/**
 * Leva o post até o perfil do Instagram: gera os arquivos e cria a mídia lá, espera o
 * Instagram processar e publica. Se o vídeo ainda estiver processando no fim da espera,
 * a próxima rodada continua de onde parou (o container fica guardado no post).
 */
export async function postarNoInstagram(postId, campanha, {
  api = instagram, arquivos = gerarArquivos, esperaMs = ESPERA_MS, consultas = CONSULTAS,
} = {}) {
  const conexao = await api.lerConexao();
  if (!conexao?.token) return { instagram: "desconectado" };
  if (!(await db.travar(`instagram_post_${postId}`, 8 * 60_000))) return { instagram: "em andamento" };
  const post = await db.buscarPost(postId);
  const tentativas = (post.instagram_tentativas ?? 0) + 1;
  try {
    if (post.instagram_id) return { instagram: "postado", link: post.instagram_link };
    let container = post.instagram_container;
    if (!container) {
      // Conta antes de gerar: se a Vercel cortar a execução no meio, a próxima rodada fica sabendo (veja videoDoReels).
      await db.atualizarInstagramDoPost(post.id, { instagram_tentativas: tentativas, instagram_erro: null });
      const gerados = await arquivos(post, campanha.empresa.nome);
      for (const a of gerados) await db.gravarMidia(a.chave, a.tipo, a.dados);
      const capa = gerados.find((a) => a.capa);
      container = await api.criarContainer(conexao, {
        formato: post.formato, urls: gerados.filter((a) => !a.capa).map((a) => linkDaMidia(a.chave)), capaUrl: capa && linkDaMidia(capa.chave), legenda: legendaDoPost(post),
      });
      await db.atualizarInstagramDoPost(post.id, { instagram_container: container, instagram_erro: null });
    }
    for (let i = 1; ; i++) {
      const { codigo, detalhe } = await api.statusDoContainer(conexao, container);
      if (codigo === "FINISHED") break;
      if (codigo === "ERROR" || codigo === "EXPIRED") throw new Error(`o Instagram não aceitou a mídia (${detalhe || codigo})`);
      if (i >= consultas) return { instagram: "processando" };
      await new Promise((r) => setTimeout(r, esperaMs));
    }
    const publicado = await api.publicarContainer(conexao, container);
    await db.atualizarInstagramDoPost(post.id, { instagram_id: publicado.id, instagram_link: publicado.link, instagram_container: null, instagram_erro: null });
    await db.atualizarStatusPost(post.id, "postado");
    // Com outros perfis recebendo o post, os arquivos ficam até eles publicarem (rodadaDasOutrasContas apaga depois).
    if (!(await api.contasParaPublicar?.())?.length) await apagarArquivosDoPost(post);
    log(`📸 Post ${post.id} publicado no Instagram: ${publicado.link ?? publicado.id}`);
    return { instagram: "postado", link: publicado.link };
  } catch (e) {
    // Começa do zero na próxima tentativa: um container com erro não serve mais.
    await db.atualizarInstagramDoPost(post.id, { instagram_container: null, instagram_erro: e.message, instagram_tentativas: tentativas });
    log(`⚠️  Post ${post.id} não foi para o Instagram (tentativa ${tentativas}): ${e.message}`);
    if (tentativas === MAX_TENTATIVAS) {
      await enviarNotificacao(
        "O post de hoje não saiu no Instagram",
        `Tentei ${tentativas} vezes e o Instagram recusou: ${e.message}\n\nConfira em ${config.painel.urlPublica}/#conteudo. Lá dá para tentar de novo ou baixar e postar à mão.`
      ).catch((x) => log(`⚠️  Não foi possível avisar do erro no Instagram: ${x.message}`));
    }
    return { instagram: "erro", erro: e.message };
  } finally {
    await db.destravar(`instagram_post_${postId}`);
  }
}

// ---------- O mesmo post nos outros perfis ----------

const chaveDaOutra = (postId, igId) => `ig_outra:${postId}:${igId}`;
const lerResultado = async (postId, igId) => { try { return JSON.parse((await db.lerEstado(chaveDaOutra(postId, igId))) || "{}"); } catch { return {}; } };
const gravarResultado = (postId, igId, r) => db.gravarEstado(chaveDaOutra(postId, igId), JSON.stringify(r));

/** Onde o post saiu nos outros perfis (para o painel): { igId: { link, erro } }. */
export async function resultadosNasOutrasContas(postId, contas) {
  const r = {};
  for (const c of contas) {
    const x = await lerResultado(postId, c.igId);
    if (x.id || x.erro) r[c.igId] = { usuario: c.usuario, link: x.link ?? null, erro: x.id ? null : x.erro ?? null };
  }
  return r;
}

/**
 * A cada 2 minutos: os posts publicados no principal nos últimos 2 dias vão também para os outros perfis
 * marcados, com os mesmos arquivos e a mesma legenda. Não espera o Instagram processar: cria a mídia numa
 * rodada e publica numa seguinte. Quando todos terminam (ou desistem depois de 3 tentativas), os arquivos são apagados.
 */
export async function rodadaDasOutrasContas(campanha, { api = instagram, agora = Date.now() } = {}) {
  const outras = await api.contasParaPublicar();
  if (!outras.length) return { outrasContas: "nenhuma" };
  const posts = (await db.postsRecentes(10)).filter((p) => p.status === "postado" && p.instagram_id && agora - new Date(p.postado_em ?? p.criado_em) < 2 * 24 * 3600_000);
  let publicados = 0;
  for (const post of posts) {
    if (await db.lerEstado(`ig_outras_fim:${post.id}`)) continue;
    let pendentes = 0;
    for (const conta of outras) {
      // Post publicado antes de o perfil entrar no sistema não vai para ele.
      if (conta.conectadoEm && new Date(post.postado_em ?? post.criado_em) < new Date(conta.conectadoEm)) continue;
      let st = await lerResultado(post.id, conta.igId);
      if (st.id || (st.tentativas ?? 0) >= MAX_TENTATIVAS) continue;
      pendentes++;
      if (!(await db.travar(`ig_outra_${post.id}_${conta.igId}`, 4 * 60_000))) continue;
      try {
        if (!st.container) {
          st = { ...st, tentativas: (st.tentativas ?? 0) + 1, erro: null };
          await gravarResultado(post.id, conta.igId, st);
          const chaves = await db.chavesDeMidia(`post-${post.id}-`);
          const capa = chaves.find((k) => k.endsWith("-capa.jpg"));
          const urls = post.formato === "reels" ? chaves.filter((k) => k.endsWith("-reels.mp4")) : chaves.filter((k) => /-\d+\.jpg$/.test(k)).sort((a, b) => Number(a.match(/-(\d+)\.jpg$/)[1]) - Number(b.match(/-(\d+)\.jpg$/)[1]));
          if (!urls.length) throw new Error("os arquivos do post já foram apagados");
          const container = await api.criarContainer(conta, { formato: post.formato, urls: urls.map(linkDaMidia), capaUrl: capa && linkDaMidia(capa), legenda: legendaDoPost(post) });
          st = { ...st, container };
          await gravarResultado(post.id, conta.igId, st);
        }
        const { codigo, detalhe } = await api.statusDoContainer(conta, st.container);
        if (codigo === "ERROR" || codigo === "EXPIRED") throw new Error(`o Instagram não aceitou a mídia (${detalhe || codigo})`);
        if (codigo === "FINISHED") {
          const pub = await api.publicarContainer(conta, st.container);
          st = { id: pub.id, link: pub.link, tentativas: st.tentativas };
          await gravarResultado(post.id, conta.igId, st);
          publicados++;
          pendentes--;
          log(`📸 Post ${post.id} publicado também em @${conta.usuario}: ${pub.link ?? pub.id}`);
        }
      } catch (e) {
        st = { ...st, container: null, erro: e.message };
        await gravarResultado(post.id, conta.igId, st);
        if (st.tentativas >= MAX_TENTATIVAS) pendentes--;
        log(`⚠️  Post ${post.id} não foi para @${conta.usuario} (tentativa ${st.tentativas}): ${e.message}`);
      } finally {
        await db.destravar(`ig_outra_${post.id}_${conta.igId}`);
      }
    }
    if (!pendentes) {
      await apagarArquivosDoPost(post);
      await db.gravarEstado(`ig_outras_fim:${post.id}`, new Date(agora).toISOString());
    }
  }
  return { outrasContas: outras.length, publicados };
}
