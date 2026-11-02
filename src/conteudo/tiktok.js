import { config } from "../config.js";
import * as db from "../db.js";
import * as tiktok from "../envio/tiktok.js";
import { enviarNotificacao } from "../envio/email.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Depois de 3 falhas seguidas o post para de tentar sozinho (e você recebe um e-mail).
export const MAX_TENTATIVAS = 3;
// O TikTok processa o vídeo em segundos ou poucos minutos. O que não terminar aqui, a próxima rodada confere.
const ESPERA_MS = 15_000;
const CONSULTAS = 4;
// O endereço de envio vale 1 hora: passado isso, um vídeo ainda "enviando" não vai mais chegar.
const ENVIO_VALE_MS = 3_600_000;
// Com a conta parada por um mesmo motivo, cada post falharia igual: o e-mail sai no máximo uma vez por dia.
const INTERVALO_DO_AVISO_MS = 86_400_000;

export const chaveDoVideo = (postId) => `post-${postId}-reels.mp4`;

/** A legenda do post com as hashtags, no limite do TikTok. O aviso de IA vai no selo do próprio TikTok. */
export function legendaDoTiktok(post) {
  const tags = (post.conteudo.hashtags ?? []).map((t) => `#${t}`).join(" ");
  return `${post.conteudo.legenda.slice(0, tiktok.MAX_LEGENDA - tags.length - 2).trim()}\n\n${tags}`.trim();
}

// Carregado só aqui: o canvas e o ffmpeg são pesados e o resto do sistema não precisa deles.
async function gerarVideo(post, empresa) {
  const { videoDoReels } = await import("./arquivos.js");
  return videoDoReels(post, empresa);
}

/**
 * O vídeo que o Instagram já gerou, quando ainda está guardado: renderizar de novo leva minutos e gasta o
 * tempo da execução. Sem ele, gera aqui, contando as tentativas do TikTok no lugar das do Instagram.
 */
async function videoDoPost(post, empresa, gerar) {
  const guardado = await db.lerMidia(chaveDoVideo(post.id));
  if (guardado) return guardado.dados;
  return gerar({ ...post, instagram_tentativas: post.tiktok_tentativas ?? 0, instagram_erro: post.tiktok_erro }, empresa);
}

/** Registra a falha e, ao desistir do post, avisa por e-mail (no máximo uma vez por dia). */
async function falhou(post, e, tentativas, avisar) {
  const conta = e.definitivo ? MAX_TENTATIVAS : tentativas;
  await db.atualizarTiktokDoPost(post.id, { tiktok_publicacao: null, tiktok_enviado_em: null, tiktok_erro: e.message, tiktok_tentativas: conta });
  log(`⚠️  Post ${post.id} não foi para o TikTok (tentativa ${tentativas}): ${e.message}`);
  if (conta >= MAX_TENTATIVAS && (await db.travar("tiktok_aviso_erro", INTERVALO_DO_AVISO_MS))) {
    await avisar(
      "O vídeo de hoje não saiu no TikTok",
      `Motivo: ${e.message}\n\nO Instagram segue normal. Confira em ${config.painel.urlPublica}/#conteudo. Lá dá para tentar de novo.`
    ).catch((x) => log(`⚠️  Não foi possível avisar do erro no TikTok: ${x.message}`));
  }
  return { tiktok: "erro", erro: e.message };
}

/**
 * Leva o Reels até o TikTok. É independente do Instagram: tem resultado e tentativas próprios, então o
 * erro de um não atrapalha o outro. O id da publicação é guardado antes de subir o vídeo: se a execução
 * for cortada ou o TikTok demorar, a próxima rodada confere esse envio, em vez de publicar duas vezes.
 */
export async function postarNoTiktok(postId, campanha, {
  api = tiktok, gerar = gerarVideo, esperaMs = ESPERA_MS, consultas = CONSULTAS, avisar = enviarNotificacao, agora = new Date(),
} = {}) {
  await api.renovarTokenSePreciso(agora).catch((e) => log(`⚠️  ${e.message}`));
  const conexao = await api.lerConexao();
  if (!conexao?.token) return { tiktok: "desconectado" };
  if (!(await db.travar(`tiktok_post_${postId}`, 8 * 60_000))) return { tiktok: "em andamento" };
  const post = await db.buscarPost(postId);
  let tentativas = post.tiktok_tentativas ?? 0;
  try {
    if (post.tiktok_id) return { tiktok: "postado", link: post.tiktok_link };
    if (post.formato !== "reels") return { tiktok: "só vídeo" };
    let publicacao = post.tiktok_publicacao;
    let enviadoEm = post.tiktok_enviado_em;
    const rascunho = conexao.modo === "rascunho";
    if (!publicacao) {
      // Conta antes de gerar: se a Vercel cortar a execução no meio, a próxima rodada fica sabendo (veja videoDoReels).
      tentativas += 1;
      await db.atualizarTiktokDoPost(post.id, { tiktok_tentativas: tentativas, tiktok_erro: null });
      try {
        // O TikTok pede a situação da conta na hora de publicar: ela pode ter mudado desde a escolha no painel.
        const info = rascunho ? null : await api.criador(conexao);
        if (!rascunho && !conexao.privacidade) throw Object.assign(new Error("escolha quem pode ver os vídeos em Redes sociais > Configurações."), { definitivo: true });
        if (info && !(info.privacy_level_options ?? []).includes(conexao.privacidade)) throw new tiktok.ErroDoTiktok("privacy_level_option_mismatch");
        const dados = await videoDoPost(post, campanha.empresa.nome, gerar);
        const envio = await api.iniciarPublicacao(conexao, { tamanho: dados.length, legenda: legendaDoTiktok(post), info });
        publicacao = envio.publishId;
        enviadoEm = new Date(agora).toISOString();
        await db.atualizarTiktokDoPost(post.id, { tiktok_publicacao: publicacao, tiktok_enviado_em: enviadoEm, tiktok_privacidade: rascunho ? "RASCUNHO" : conexao.privacidade, tiktok_erro: null });
        await api.enviarVideo(envio.uploadUrl, dados);
      } catch (e) {
        return await falhou(post, e, tentativas, avisar);
      }
    }
    for (let i = 1; ; i++) {
      // Falha ao consultar não é falha da publicação: o vídeo pode estar saindo. Só confere de novo na próxima rodada.
      const situacao = await api.statusDaPublicacao(conexao, publicacao).catch((e) => {
        log(`⚠️  Post ${post.id}: não deu para conferir o TikTok agora: ${e.message}`);
        return null;
      });
      if (!situacao) return { tiktok: "processando" };
      if (situacao.codigo === "FAILED") return await falhou(post, new tiktok.ErroDoTiktok(situacao.motivo || "falhou", `não publicou (${situacao.motivo || "sem motivo informado"})`), tentativas, avisar);
      if (situacao.codigo === "PUBLISH_COMPLETE" || situacao.codigo === "SEND_TO_USER_INBOX") {
        const noInbox = situacao.codigo === "SEND_TO_USER_INBOX";
        const link = noInbox ? null : tiktok.linkDoPost(conexao.usuario, situacao.postId);
        await db.atualizarTiktokDoPost(post.id, { tiktok_id: situacao.postId ?? publicacao, tiktok_link: link, tiktok_publicacao: null, tiktok_enviado_em: null, tiktok_erro: null });
        // Com o Instagram ainda buscando o vídeo pelo link, quem apaga é ele, ao publicar.
        if ((await db.buscarPost(post.id)).instagram_id) await db.apagarMidias(`post-${post.id}-reels`);
        log(`🎵 Post ${post.id} ${noInbox ? "enviado para o app do TikTok" : "publicado no TikTok"}${link ? `: ${link}` : ""}`);
        // O TikTok não leva a legenda para o rascunho, então ela vai no e-mail para colar.
        if (noInbox) {
          await avisar(
            "Vídeo esperando no app do TikTok",
            `Abra o app do TikTok, toque na notificação do vídeo e publique. A legenda não vai junto; copie esta:\n\n${legendaDoTiktok(post)}`
          ).catch((x) => log(`⚠️  Não foi possível avisar do rascunho do TikTok: ${x.message}`));
        }
        return { tiktok: noInbox ? "no app" : "postado", link };
      }
      if (enviadoEm && agora - new Date(enviadoEm) > ENVIO_VALE_MS) {
        return await falhou(post, new tiktok.ErroDoTiktok("parado", "o envio ficou parado por mais de 1 hora"), tentativas, avisar);
      }
      if (i >= consultas) return { tiktok: "processando" };
      await new Promise((r) => setTimeout(r, esperaMs));
    }
  } finally {
    await db.destravar(`tiktok_post_${postId}`);
  }
}
