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
const linkDaMidia = (chave) => `${config.painel.urlPublica}/api/midia/${chave}?a=${assinaturaDaMidia(chave)}`;

/** Legenda com as hashtags, no limite de 2.200 caracteres do Instagram. */
export function legendaDoPost(post) {
  const tags = post.conteudo.hashtags.map((t) => `#${t}`).join(" ");
  return `${post.conteudo.legenda.slice(0, 2190 - tags.length).trim()}\n\n${tags}`;
}

/** Os arquivos do post: as telas em JPEG (carrossel) ou o vídeo em MP4 (Reels). */
async function gerarArquivos(post, empresa) {
  // Carregado só aqui: o canvas e o ffmpeg são pesados e o resto do sistema não precisa deles.
  const { imagensDoCarrossel, videoDoReels } = await import("./arquivos.js");
  if (post.formato === "reels") return [{ chave: `post-${post.id}-reels.mp4`, tipo: "video/mp4", dados: await videoDoReels(post, empresa) }];
  return (await imagensDoCarrossel(post, empresa)).map((dados, i) => ({ chave: `post-${post.id}-${i + 1}.jpg`, tipo: "image/jpeg", dados }));
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
  try {
    if (post.instagram_id) return { instagram: "postado", link: post.instagram_link };
    let container = post.instagram_container;
    if (!container) {
      const gerados = await arquivos(post, campanha.empresa.nome);
      for (const a of gerados) await db.gravarMidia(a.chave, a.tipo, a.dados);
      container = await api.criarContainer(conexao, { formato: post.formato, urls: gerados.map((a) => linkDaMidia(a.chave)), legenda: legendaDoPost(post) });
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
    await db.apagarMidias(`post-${post.id}-`);
    log(`📸 Post ${post.id} publicado no Instagram: ${publicado.link ?? publicado.id}`);
    return { instagram: "postado", link: publicado.link };
  } catch (e) {
    // Começa do zero na próxima tentativa: um container com erro não serve mais.
    const tentativas = (post.instagram_tentativas ?? 0) + 1;
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
