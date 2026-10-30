import PDFDocument from "pdfkit";
import { config } from "../config.js";
import * as db from "../db.js";
import * as linkedin from "../envio/linkedin.js";
import { enviarNotificacao } from "../envio/email.js";
import { escreverParaLinkedin } from "../ia/conteudo.js";
import { gerarArquivos } from "./instagram.js";
import { lerBaseDeConteudo } from "./base.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Depois de 3 falhas seguidas o post para de tentar sozinho (e você recebe um e-mail).
export const MAX_TENTATIVAS = 3;
// O LinkedIn processa o documento em segundos e o vídeo em poucos minutos.
const ESPERA_MS = 15_000;
const CONSULTAS = 8;

// Crédito das fotos: a licença exige que apareça onde a foto é publicada.
const CREDITO = /\n\nFotos: [^\n]*$/;

/** A legenda do Instagram, sem o crédito das fotos, para a IA adaptar. */
const legendaSemCredito = (post) => post.conteudo.legenda.replace(CREDITO, "");

/**
 * O texto do LinkedIn do post (escrito pela IA uma vez e guardado nele). Fica pronto junto com o post,
 * para aparecer no painel antes de sair; se a IA falhar nessa hora, é escrito na hora de publicar.
 */
export async function textoDoPost(post, campanha, { escrever = escreverParaLinkedin } = {}) {
  if (post.conteudo.linkedin) return post.conteudo.linkedin;
  const escrito = await escrever({
    campanha, base: await lerBaseDeConteudo(), formato: post.formato, tema: post.tema, gancho: post.conteudo.gancho,
    legenda: legendaSemCredito(post), telas: post.conteudo.slides ?? [], publico: post.conteudo.publico,
  });
  await db.atualizarConteudoDoPost(post.id, { ...post.conteudo, linkedin: escrito });
  post.conteudo.linkedin = escrito;
  return escrito;
}

/** O texto final do post: o da IA, o aviso do avatar, o crédito das fotos, o contato e as hashtags. */
export function textoFinal(post) {
  const { texto, hashtags = [] } = post.conteudo.linkedin;
  const aviso = postParaLinkedin(post).conteudo.slides?.some((s) => s.avatar) ? "Avatar do Felipe gerado com IA." : "";
  const credito = post.conteudo.legenda.match(CREDITO)?.[0].trim() ?? "";
  const contato = `Fale com a gente: ${config.painel.urlPublica}/contato?origem=linkedin`;
  const tags = hashtags.map((t) => `#${t}`).join(" ");
  const fim = [contato, aviso, credito, tags].filter(Boolean).join("\n\n");
  // A folga é para as barras que o formato do LinkedIn acrescenta nos caracteres reservados.
  return `${texto.slice(0, linkedin.MAX_TEXTO - fim.length - 100).trim()}\n\n${fim}`;
}

/**
 * O post com a última tela trocada pela chamada do LinkedIn: "comenta que te mando no direct" não
 * faz sentido lá. O resto é o mesmo conteúdo do Instagram. O clipe do avatar sai dessa tela, porque ele
 * fala a chamada antiga.
 */
export function postParaLinkedin(post) {
  const slides = post.conteudo.slides ?? [];
  const { cta } = post.conteudo.linkedin;
  if (!slides.length || !cta) return post;
  const { avatar, ...ultima } = slides.at(-1);
  return { ...post, conteudo: { ...post.conteudo, slides: [...slides.slice(0, -1), { ...ultima, titulo: cta.titulo, texto: cta.texto, destaque: cta.destaque, fala: post.formato === "reels" ? cta.fala : "" }] } };
}

/** As telas do carrossel num PDF, uma por página: no LinkedIn o documento é o carrossel de passar. */
export function pdfDoCarrossel(imagens, { titulo = "", largura = 1080, altura = 1350 } = {}) {
  return new Promise((ok, falhou) => {
    const doc = new PDFDocument({ autoFirstPage: false, info: { Title: titulo, Author: "FluxDeck" } });
    const partes = [];
    doc.on("data", (p) => partes.push(p));
    doc.on("end", () => ok(Buffer.concat(partes)));
    doc.on("error", falhou);
    for (const imagem of imagens) {
      doc.addPage({ size: [largura, altura], margin: 0 });
      doc.image(Buffer.from(imagem), 0, 0, { width: largura, height: altura });
    }
    doc.end();
  });
}

/** Sobe a mídia do post: o vídeo do Reels ou o carrossel em PDF. */
async function subirMidia(api, conexao, post, empresa, arquivos) {
  const gerados = await arquivos(postParaLinkedin(post), empresa);
  if (post.formato === "reels") return api.enviarVideo(conexao, gerados[0].dados);
  return api.enviarDocumento(conexao, await pdfDoCarrossel(gerados.map((a) => a.dados), { titulo: post.conteudo.linkedin.tituloDocumento }));
}

/**
 * Leva o post até a página da empresa no LinkedIn. É independente do Instagram: gera os próprios
 * arquivos e guarda o próprio resultado, então o erro de um não atrapalha o outro. Se a mídia ainda
 * estiver processando no fim da espera, a próxima rodada continua de onde parou.
 */
export async function postarNoLinkedin(postId, campanha, {
  api = linkedin, arquivos = gerarArquivos, escrever = escreverParaLinkedin, esperaMs = ESPERA_MS, consultas = CONSULTAS, avisar = enviarNotificacao,
} = {}) {
  const conexao = await api.lerConexao();
  if (!conexao?.token || !conexao.organizacao) return { linkedin: "desconectado" };
  if (!(await db.travar(`linkedin_post_${postId}`, 8 * 60_000))) return { linkedin: "em andamento" };
  const post = await db.buscarPost(postId);
  try {
    if (post.linkedin_id) return { linkedin: "postado", link: post.linkedin_link };
    await textoDoPost(post, campanha, { escrever });
    let midia = post.linkedin_midia;
    if (!midia) {
      midia = await subirMidia(api, conexao, post, campanha.empresa.nome, arquivos);
      await db.atualizarLinkedinDoPost(post.id, { linkedin_midia: midia, linkedin_erro: null });
    }
    for (let i = 1; ; i++) {
      const { codigo, detalhe } = await api.statusDaMidia(conexao, midia);
      if (codigo === "AVAILABLE") break;
      if (codigo === "PROCESSING_FAILED") throw new Error(`o LinkedIn não aceitou a mídia (${detalhe || codigo})`);
      if (i >= consultas) return { linkedin: "processando" };
      await new Promise((r) => setTimeout(r, esperaMs));
    }
    const publicado = await api.publicarPost(conexao, { texto: textoFinal(post), midia: { id: midia, titulo: post.conteudo.linkedin.tituloDocumento || post.tema } });
    await db.atualizarLinkedinDoPost(post.id, { linkedin_id: publicado.id, linkedin_link: publicado.link, linkedin_midia: null, linkedin_erro: null });
    log(`💼 Post ${post.id} publicado no LinkedIn: ${publicado.link}`);
    return { linkedin: "postado", link: publicado.link };
  } catch (e) {
    const tentativas = (post.linkedin_tentativas ?? 0) + 1;
    await db.atualizarLinkedinDoPost(post.id, { linkedin_midia: null, linkedin_erro: e.message, linkedin_tentativas: tentativas });
    log(`⚠️  Post ${post.id} não foi para o LinkedIn (tentativa ${tentativas}): ${e.message}`);
    if (tentativas === MAX_TENTATIVAS) {
      await avisar(
        "O post de hoje não saiu no LinkedIn",
        `Tentei ${tentativas} vezes e o LinkedIn recusou: ${e.message}\n\nO Instagram segue normal. Confira em ${config.painel.urlPublica}/#conteudo. Lá dá para tentar de novo.`
      ).catch((x) => log(`⚠️  Não foi possível avisar do erro no LinkedIn: ${x.message}`));
    }
    return { linkedin: "erro", erro: e.message };
  } finally {
    await db.destravar(`linkedin_post_${postId}`);
  }
}
