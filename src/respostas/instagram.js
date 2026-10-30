import { config } from "../config.js";
import * as db from "../db.js";
import { registrarResposta } from "./processar.js";
import { textoDoAudio } from "./whatsapp.js";
import { escreverDirectDoComentario } from "../ia/resposta.js";
import * as instagram from "../envio/instagram.js";
import { enviarMensagem } from "../pipeline.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// A mensagem privada ao comentário sai em 20 a 60 s, como alguém olhando as notificações.
const ESPERA_COMENTARIO_MS = [20_000, 60_000];

const chaveDoContato = (id) => `contato_ig:${id}`;
/** Lead ligado a quem escreveu ou comentou (pelo id que a Meta dá para a pessoa nesta conta). */
const leadDoContato = async (id) => {
  const leadId = Number(await db.lerEstado(chaveDoContato(id)));
  return leadId ? db.buscarLead(leadId) : null;
};
const ligarContato = (id, leadId) => db.gravarEstado(chaveDoContato(id), leadId);

const TIPOS_DE_ANEXO = { image: "imagem", video: "vídeo", audio: "áudio", file: "arquivo", share: "post compartilhado", ig_reel: "reels compartilhado", story_mention: "menção no story", reel: "reels compartilhado" };

/**
 * Lê o webhook do Instagram: as mensagens do direct (sem as que a própria conta mandou) e os comentários
 * nos posts (sem os da própria conta). Funciona com o webhook do Instagram Login e com o da página do Facebook.
 */
export function extrairEventosInstagram(payload, { meuId = null, meuUsuario = null } = {}) {
  const mensagens = [];
  const comentarios = [];
  if (payload?.object !== "instagram") return { mensagens, comentarios };
  const proprio = (id, usuario) => (meuId && String(id) === String(meuId)) || (meuUsuario && usuario && usuario.toLowerCase() === meuUsuario.toLowerCase());
  for (const entrada of payload.entry ?? []) {
    for (const ev of entrada.messaging ?? []) {
      const m = ev.message;
      if (!m || m.is_echo || m.is_deleted || m.is_unsupported || proprio(ev.sender?.id)) continue;
      const anexos = (m.attachments ?? []).map((a) => ({ tipo: a.type, url: a.payload?.url ?? null }));
      const audio = anexos.find((a) => a.tipo === "audio" && a.url);
      const texto = m.text?.trim() || anexos.filter((a) => a.tipo !== "audio").map((a) => `[${TIPOS_DE_ANEXO[a.tipo] ?? "anexo"}]`).join(" ");
      if (!texto && !audio) continue;
      mensagens.push({
        id: m.mid, de: String(ev.sender.id), texto,
        ...(audio ? { audio: true, url: audio.url } : {}),
        ...(m.reply_to?.story ? { story: true } : {}),
      });
    }
    for (const mudanca of entrada.changes ?? []) {
      const v = mudanca.value ?? {};
      if (mudanca.field !== "comments" || !v.id || !v.text || proprio(v.from?.id, v.from?.username)) continue;
      comentarios.push({ id: String(v.id), de: String(v.from?.id ?? ""), usuario: v.from?.username ?? "", texto: v.text, midiaId: v.media?.id ?? null, resposta: Boolean(v.parent_id) });
    }
  }
  return { mensagens, comentarios };
}

/**
 * O lead de quem escreveu: o que já está ligado a essa pessoa, a empresa prospectada com o mesmo @
 * ou um lead novo, já em conversa.
 */
async function leadDaPessoa({ id, usuario = "", nome = "", observacao }) {
  const ligado = id ? await leadDoContato(id) : null;
  if (ligado) return ligado;
  let perfil = null;
  if (id && (!usuario || !nome)) perfil = await instagram.perfilDoContato(id);
  usuario ||= perfil?.usuario ?? "";
  nome ||= perfil?.nome ?? "";
  const lead = (await db.leadPeloInstagram(usuario))
    ?? (await db.buscarLead(await db.criarLeadDeContato({
      nome: nome || (usuario ? `@${usuario}` : "Contato do Instagram"), instagram: usuario || null, origem: "instagram_direct", observacao,
    })));
  if (id) await ligarContato(id, lead.id);
  return lead;
}

const conversouNoDirectHoje = async (leadId) =>
  (await db.historicoConversa(leadId)).some((h) => h.canal === "instagram" && Date.now() - new Date(h.quando) < 24 * 3600_000);

/** A IA responde o direct só se estiver ligada para o Instagram (vale mesmo com a resposta automática desligada para o WhatsApp). */
const campanhaDoDirect = (campanha, respostas) => ({ ...campanha, automacao: { ...campanha.automacao, respostaAutomatica: respostas } });

/** Uma mensagem do direct: entra na conversa da pessoa e a IA responde como em qualquer conversa. */
async function registrarDirect(m, campanha, cfg, { classificar, apresentar } = {}) {
  const lead = await leadDaPessoa({ id: m.de, observacao: "Chamou no direct do Instagram" });
  let forcarHumano = null;
  if (m.audio) ({ texto: m.texto, forcarHumano } = await textoDoAudio(m, () => instagram.baixarAnexo(m.url)));
  if (m.story) m.texto = `[respondeu um story] ${m.texto}`;
  const r = await registrarResposta({
    lead, canal: "instagram", origem_id: m.id, de: m.de, texto: m.texto, forcarHumano, classificar, apresentar,
    campanha: campanhaDoDirect(campanha, cfg.respostas),
  });
  return r ? 1 : 0;
}

/**
 * Um comentário num post: a IA decide se vale chamar no direct (pediu o que o post prometeu, perguntou,
 * mostrou interesse) e manda a mensagem privada, que abre a conversa no direct. Depois, se der, responde
 * o comentário em público avisando.
 */
export async function registrarComentario(cm, campanha, { esperar = ESPERA_COMENTARIO_MS, escrever = escreverDirectDoComentario } = {}) {
  // O mesmo comentário pode chegar duas vezes (a Meta reenvia quando demoramos): só um processa.
  if ((await db.respostaJaRegistrada(cm.id)) || !(await db.travar(`comentario_ig:${cm.id}`, 30 * 60_000))) return null;
  // Já está conversando com a pessoa no direct (ex.: comentou em vários posts): não chama de novo.
  const conhecido = cm.de ? await leadDoContato(cm.de) : null;
  if (conhecido && (await conversouNoDirectHoje(conhecido.id))) {
    log(`💬 @${cm.usuario} comentou de novo no Instagram; a conversa no direct já está aberta`);
    return { respondido: false };
  }
  const post = cm.midiaId ? await db.postPeloInstagram(cm.midiaId) : null;
  const d = await escrever({ comentario: cm.texto, usuario: cm.usuario, post, campanha });
  if (!d.responder || !d.mensagem) {
    log(`💬 @${cm.usuario} comentou no Instagram ("${cm.texto.slice(0, 60)}"); sem direct: ${d.resumo}`);
    return { respondido: false };
  }
  const lead = await leadDaPessoa({ id: cm.de, usuario: cm.usuario, observacao: `Comentou num post do Instagram: ${d.resumo}` });
  const onde = post ? ` no post "${post.tema}"` : " num post";
  const respostaId = await db.criarResposta({
    lead_id: lead.id, canal: "instagram", origem_id: cm.id, de: cm.de, assunto: null,
    texto: `[comentou${onde}] ${cm.texto}`, classificacao: "quer_informacoes", resumo: d.resumo, sugestao: d.mensagem,
  });
  if (!respostaId) return null;
  // A mensagem privada vai para o comentário (em_resposta_a); as próximas, para a pessoa.
  const mensagemId = await db.criarMensagem({
    lead_id: lead.id, canal: "instagram", destino: cm.de, corpo: d.mensagem, status: "aprovada", tipo: "resposta", etapa: 0, em_resposta_a: cm.id,
  });
  await db.atualizarResposta(respostaId, { mensagem_id: mensagemId, lida: true });
  if (!["agendado", "fechado"].includes(lead.status)) await db.atualizarLead(lead.id, { status: "respondeu" });

  const [min, max] = esperar;
  if (max) await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
  const envio = await enviarMensagem(await db.buscarMensagem(mensagemId), campanha);
  if (envio.enviada && d.resposta_publica) {
    await instagram.responderComentario(cm.id, d.resposta_publica)
      .catch((e) => log(`⚠️  Não foi possível responder o comentário de @${cm.usuario} em público: ${e.message}`));
  }
  log(`📩 @${cm.usuario} comentou${onde}: ${envio.enviada ? "direct enviado" : `direct não saiu (${envio.motivo})`}`);
  return { respondido: envio.enviada, lead, mensagemId, motivo: envio.motivo };
}

/**
 * Processa o webhook do Instagram conforme o que estiver ligado no painel. Retorna quantos eventos entraram.
 * `opcoes` troca a IA e a espera (nos testes).
 */
export async function processarWebhookInstagram(payload, campanha, opcoes = {}) {
  const [cfg, conexao] = await Promise.all([instagram.configDoDirect(), instagram.lerConexao()]);
  if (!conexao?.token) return 0;
  await db.gravarEstado("instagram_webhook_ultimo", new Date().toISOString());
  const { mensagens, comentarios } = extrairEventosInstagram(payload, { meuId: conexao.igId, meuUsuario: conexao.usuario });
  let registrados = 0;
  for (const m of mensagens) {
    registrados += await registrarDirect(m, campanha, cfg, opcoes).catch((e) => (log(`⚠️  Direct do Instagram: ${e.message}`), 0));
  }
  if (cfg.comentarios) {
    for (const cm of comentarios.filter((c) => !c.resposta)) {
      const r = await registrarComentario(cm, campanha, opcoes).catch((e) => (log(`⚠️  Comentário do Instagram: ${e.message}`), null));
      if (r?.respondido) registrados++;
    }
  }
  return registrados;
}
