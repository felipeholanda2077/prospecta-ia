import { config } from "../config.js";
import * as db from "../db.js";
import { classificarResposta, limparTextoResposta, escreverApresentacao, semCumprimentoRepetido } from "../ia/resposta.js";
import { enviarNotificacao } from "../envio/email.js";
import { linkAgendamento } from "../agenda/calendly.js";
import { contatosNoTexto, contatarIndicados } from "./indicacao.js";
import { lerApresentacao } from "./apresentacao.js";
import { responderComoAgente } from "../ia/agente.js";
import { fontesDoAgente, PREFIXO_DELEGOU } from "./agentes.js";

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// A IA espera alguns minutos antes de responder, como uma pessoa faria.
const ESPERA_MIN_MS = 2 * 60 * 1000;
const ESPERA_MAX_MS = 6 * 60 * 1000;
const RESPONDE_SOZINHA = ["interessado", "quer_informacoes", "outro"];
// Empresa que disse não: recebe só o agradecimento, e nada mais sai para ela.
export const ENCERRADOS = ["sem_interesse", "descadastrado"];
const QUER_SABER = ["interessado", "quer_informacoes"];
const chaveApresentacao = (leadId) => `apresentacao_enviada:${leadId}`;
/** A apresentação saiu (pela IA ou por você): nas próximas mensagens a conversa segue sem repeti-la. */
export const marcarApresentacaoEnviada = (leadId) => db.gravarEstado(chaveApresentacao(leadId), new Date().toISOString());

/**
 * Já apresentou? Só conta se uma resposta da conversa saiu depois disso: se a apresentação ainda estava
 * na fila (ou foi cancelada) quando a pessoa escreveu de novo, a próxima resposta ainda é a apresentação.
 */
async function jaApresentou(leadId) {
  const desde = await db.lerEstado(chaveApresentacao(leadId));
  return Boolean(desde) && db.respostaDaConversaDesde(leadId, desde);
}
// Atendimento automático responde na hora: 3 respostas seguidas em até 25 s depois da nossa = robô.
const RAPIDO_MS = 25_000;
const RESPOSTAS_RAPIDAS = 3;
const chavePausa = (leadId) => `ia_pausada:${leadId}`;

/** A IA não responde mais esta conversa (robô do outro lado, ou você parou). Volta com "IA continua". */
export const pausarIA = (leadId, motivo) => db.gravarEstado(chavePausa(leadId), motivo);
const MOTIVO_ROBO = "parece um atendimento automático";
/** A conversa foi parada porque do outro lado parecia um robô (e não por você, nem por um agente que delegou). */
export const pausadaPorRobo = (pausa) => String(pausa ?? "").startsWith(MOTIVO_ROBO);
const RELEITURAS_DE_ROBO = 2;
const chaveReleituras = (leadId) => `robo_releituras:${leadId}`;
export const iaPausada = (leadId) => db.lerEstado(chavePausa(leadId));
const retomarIA = (leadId) => db.gravarEstado(chavePausa(leadId), "");

/**
 * Do outro lado é um robô? Olha as últimas respostas da IA: se cada uma foi respondida em segundos,
 * sem pausa para ler, é atendimento automático. Retorna o motivo, ou null.
 */
export function roboPelaVelocidade(historico, agora = new Date()) {
  const eventos = [...historico, { autor: "lead", quando: agora }].map((e) => ({ ...e, t: new Date(e.quando).getTime() }));
  const rapidas = [];
  for (let i = eventos.length - 1; i > 0 && rapidas.length < RESPOSTAS_RAPIDAS; i--) {
    if (eventos[i].autor !== "lead" || eventos[i - 1].autor !== "nos") continue;
    if (eventos[i - 1].tipo !== "resposta" || eventos[i].t - eventos[i - 1].t > RAPIDO_MS) return null;
    rapidas.push(eventos[i].t - eventos[i - 1].t);
  }
  return rapidas.length >= RESPOSTAS_RAPIDAS
    ? `parece um atendimento automático: respondeu ${RESPOSTAS_RAPIDAS} vezes seguidas em segundos`
    : null;
}

export const AGRADECIMENTO_PADRAO = "Imagina, obrigado pelo retorno! Fico à disposição se precisarem no futuro. Um abraço!";

/**
 * Agenda uma mensagem da conversa para sair em alguns minutos, como uma pessoa responderia. Com `partes`
 * (agentes), cada parte vira uma mensagem, uma logo depois da outra, na ordem.
 */
async function agendarResposta({ respostaId, lead, canal, de, assunto, origem_id, corpo, partes = [corpo], esperaMinMs = ESPERA_MIN_MS, esperaMaxMs = ESPERA_MAX_MS }) {
  // Responde para quem escreveu (pode ser um contato indicado, não o e-mail/número original da empresa).
  const destino = de || (canal === "email" ? lead.email : lead.whatsapp);
  const espera = esperaMinMs + Math.random() * (esperaMaxMs - esperaMinMs);
  const ids = [];
  for (const [i, texto] of partes.entries()) {
    const id = await db.criarMensagem({
      lead_id: lead.id,
      canal,
      destino,
      assunto: canal === "email" ? (/^re:/i.test(assunto ?? "") ? assunto : `Re: ${assunto ?? ""}`) : null,
      corpo: texto,
      status: "aprovada",
      tipo: "resposta",
      etapa: 0,
      em_resposta_a: canal === "email" ? origem_id : null,
    });
    // Alguns segundos entre as partes; o envio ainda espera o intervalo normal entre uma mensagem e outra.
    await db.atualizarMensagem(id, { agendada_para: new Date(Date.now() + espera + i * 5000).toISOString() });
    ids.push(id);
  }
  await db.atualizarResposta(respostaId, { mensagem_id: ids[0], lida: true });
  return { mensagemId: ids[0], espera };
}

// Agentes respondem mais rápido que a prospecção: quem chamou está esperando.
const ESPERA_AGENTE_MS = [60_000, 150_000];
const partesDa = (c) => (c.partes?.length ? c.partes : c.sugestao_resposta?.trim() ? [c.sugestao_resposta.trim()] : []);

/**
 * Agente de atendimento: responde em até 3 partes ou, quando delega (comando DELEGAR), manda a
 * mensagem escolhida para essa hora (ou nada), para a IA nesta conversa e avisa você.
 */
async function responderPeloAgente({ respostaId, lead, canal, de, c, agente }) {
  // A IA falhou (ou o áudio não foi transcrito): marca para você responder, sem parar o agente.
  if (c.precisa_humano && !c.delegou) {
    await db.atualizarResposta(respostaId, { precisa_humano: c.motivo_humano || "o agente não conseguiu responder" });
    return { precisaHumano: c.motivo_humano };
  }
  let motivo = c.delegou ? c.motivo_humano || "o agente passou a conversa para você" : null;
  if (!motivo && (await db.respostasEnviadasNaConversa(lead.id)) >= agente.max_respostas) {
    motivo = `o agente já respondeu ${agente.max_respostas} vezes nesta conversa`;
  }
  const [esperaMinMs, esperaMaxMs] = ESPERA_AGENTE_MS;
  if (!motivo) {
    const partes = partesDa(c);
    if (!partes.length) return null;
    const { mensagemId, espera } = await agendarResposta({ respostaId, lead, canal, de, partes, esperaMinMs, esperaMaxMs });
    log(`🤖 Agente ${agente.nome} respondeu ${lead.nome} em ${partes.length} parte(s); sai em ~${Math.round(espera / 60000)} min, em horário comercial`);
    return { mensagemId };
  }

  const partes = agente.delegar_modo === "silencio" ? [] : agente.delegar_modo === "fixa" ? [agente.delegar_mensagem] : partesDa(c);
  if (partes.length) await agendarResposta({ respostaId, lead, canal, de, partes, esperaMinMs, esperaMaxMs });
  await db.atualizarResposta(respostaId, { precisa_humano: motivo });
  await pausarIA(lead.id, `${PREFIXO_DELEGOU}${motivo}`);
  await db.atualizarLead(lead.id, { agente_delegou_em: new Date().toISOString() });
  await enviarNotificacao(`${lead.nome} precisa de você (agente ${agente.nome})`,
    `${motivo}\n\nÚltima mensagem:\n${c.resumo}\n\nO agente parou nesta conversa: responda pelo painel (Respostas) e clique em "IA continua" se quiser que ele volte.`)
    .catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
  log(`🙋 Agente ${agente.nome} passou ${lead.nome} para você: ${motivo}`);
  return { precisaHumano: motivo, delegou: true };
}

/**
 * Com a resposta automática ligada, agenda a próxima mensagem da conversa (sai na
 * próxima rodada em horário comercial) ou marca que a conversa precisa de você.
 */
async function responderSozinha({ respostaId, lead, canal, de, assunto, origem_id, c, campanha, agente = null }) {
  if (agente) return responderPeloAgente({ respostaId, lead, canal, de, c, agente });
  const auto = campanha.automacao;
  // Pedido de ajuda da IA fica marcado sempre, mesmo com a resposta automática desligada.
  let motivo = c.precisa_humano ? c.motivo_humano || "a IA pediu sua ajuda nesta conversa" : null;
  if (!motivo && (!auto?.respostaAutomatica || !RESPONDE_SOZINHA.includes(c.classificacao) || !c.sugestao_resposta)) return null;

  if (!motivo && (await db.respostasEnviadasNaConversa(lead.id)) >= auto.maxRespostasIA) {
    motivo = `a IA já respondeu ${auto.maxRespostasIA} vezes nesta conversa`;
  }
  if (motivo) {
    await db.atualizarResposta(respostaId, { precisa_humano: motivo });
    await enviarNotificacao(`${lead.nome} precisa de você`, `${motivo}\n\nÚltima mensagem:\n${c.resumo}\n\nSugestão da IA:\n${c.sugestao_resposta}`)
      .catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
    return { precisaHumano: motivo };
  }

  const { mensagemId, espera } = await agendarResposta({ respostaId, lead, canal, de, assunto, origem_id, corpo: c.sugestao_resposta });
  log(`🤖 IA respondeu ${lead.nome} (${canal}); sai em ~${Math.round(espera / 60000)} min${canal === "instagram" ? "" : ", em horário comercial"}`);
  return { mensagemId };
}

/**
 * Registra a resposta de um lead, classifica com a IA e aplica a ação certa:
 * descadastro → lista de supressão; sem interesse → encerra; interesse → avisa você.
 * Em qualquer resposta humana, as etapas pendentes são canceladas e, com a resposta
 * automática ligada, a IA continua a conversa rumo ao agendamento.
 */
/** A resposta sem um "Bom dia!" de novo no começo, se a conversa já começou (em todas as partes do agente também). */
function semRepetirCumprimento(c, historico) {
  if (!c) return c;
  const partes = c.partes?.length ? c.partes.map((p, i) => (i === 0 ? semCumprimentoRepetido(p, historico) : p)) : c.partes;
  const sugestao = c.partes?.length ? partes.join("\n\n") : semCumprimentoRepetido(c.sugestao_resposta, historico);
  return { ...c, partes, sugestao_resposta: sugestao };
}

/**
 * Classifica a última mensagem e escreve a próxima. Na primeira demonstração de interesse,
 * a próxima mensagem é a apresentação (processo, planos, prazo) com o convite.
 */
async function pensarResposta(contexto, { classificar, apresentar }) {
  const c = await classificar(contexto);
  if (QUER_SABER.includes(c.classificacao) && c.sugestao_resposta && !c.precisa_humano && !(await jaApresentou(contexto.lead.id))) {
    return { c: { ...c, sugestao_resposta: await apresentar(contexto) }, apresentou: true };
  }
  return { c, apresentou: false };
}

export async function registrarResposta({
  lead, canal, origem_id, de, assunto = null, texto, campanha, forcarHumano = null,
  contatosIndicados = [], nomeRemetente = null, // cartão de contato do WhatsApp, já lido
  classificar = classificarResposta, apresentar = escreverApresentacao,
  agente = null, responderAgente = responderComoAgente, // agente de atendimento do número que recebeu
}) {
  if (origem_id && (await db.respostaJaRegistrada(origem_id))) return null;

  const limpo = limparTextoResposta(texto) || String(texto ?? "").slice(0, 2000);

  // Robô do outro lado (ou conversa parada por você): registra sem gastar IA e sem responder.
  let pausada = await iaPausada(lead.id);
  // Parada por robô, mas chegou uma mensagem nova (diferente das que o robô já mandou): pode ser a pessoa
  // escrevendo depois da mensagem automática. A IA lê de novo; se for robô outra vez, a conversa para de novo.
  // (No máximo RELEITURAS_DE_ROBO vezes por conversa: robô que varia o texto não gasta IA para sempre.)
  if (pausadaPorRobo(pausada) && !(await db.textoJaRecebido(lead.id, limpo))) {
    const releituras = Number(await db.lerEstado(chaveReleituras(lead.id))) || 0;
    if (releituras < RELEITURAS_DE_ROBO) {
      await db.gravarEstado(chaveReleituras(lead.id), String(releituras + 1));
      await retomarIA(lead.id);
      pausada = "";
      log(`🔁 ${lead.nome} escreveu algo novo numa conversa parada por robô: a IA lê de novo`);
    }
  }
  // No agente quem chamou foi o cliente, e gente responde rápido no WhatsApp: lá só a IA decide se é robô.
  const robo = pausada || agente ? null : roboPelaVelocidade(await db.historicoConversa(lead.id));
  if (pausada || robo) {
    if (robo) await pararPorRobo(lead, robo);
    const id = await db.criarResposta({ lead_id: lead.id, canal, origem_id, de, assunto, texto: limpo, classificacao: "outro",
      resumo: `A IA não responde esta conversa: ${pausada || robo}.`, sugestao: null });
    // Conversa de agente parada: quem responde é você.
    if (id) await db.atualizarResposta(id, { lida: !agente, ...(agente ? { precisa_humano: pausada || robo } : {}) });
    log(`🤖 ${lead.nome} escreveu, mas a IA está parada nesta conversa (${pausada || robo})`);
    return id ? { id, classificacao: "outro", pausada: true } : null;
  }

  // Agente desligado: a conversa fica registrada no CRM dele, sem gastar IA, e quem responde é você.
  if (agente && !agente.ligado) {
    const id = await db.criarResposta({ lead_id: lead.id, canal, origem_id, de, assunto, texto: limpo, classificacao: "outro",
      resumo: `O agente ${agente.nome} está desligado: a IA não respondeu.`, sugestao: null });
    if (id) await db.atualizarResposta(id, { precisa_humano: `o agente ${agente.nome} está desligado` });
    log(`💤 ${lead.nome} escreveu para o agente ${agente.nome}, que está desligado`);
    return id ? { id, classificacao: "outro", desligado: true } : null;
  }

  let c;
  let apresentou = false;
  let historico = [];
  try {
    // Ex.: áudio que não deu para transcrever: a sequência para e você responde.
    if (forcarHumano) throw new Error(forcarHumano);
    historico = await db.historicoConversa(lead.id);
    if (agente) {
      // O agente responde com o prompt e a base dele, sem a apresentação da FluxDeck.
      c = await responderAgente({ agente, fontes: await fontesDoAgente(agente), texto: limpo, lead, historico });
    } else {
      const contexto = {
        texto: limpo, assunto, lead, historico, campanha, canal,
        linkAgendamento: linkAgendamento(campanha.automacao?.calendly, lead, canal),
        apresentacao: await lerApresentacao(),
      };
      ({ c, apresentou } = await pensarResposta(contexto, { classificar, apresentar }));
    }
  } catch (e) {
    c = { classificacao: "outro", resumo: forcarHumano ? "Mandou um áudio." : `Não foi possível classificar automaticamente: ${e.message}`,
          sugestao_resposta: "", precisa_humano: true, motivo_humano: forcarHumano || "a IA não conseguiu ler esta resposta" };
  }
  c = semRepetirCumprimento(c, historico);

  const id = await db.criarResposta({
    lead_id: lead.id,
    canal,
    origem_id,
    de,
    assunto,
    texto: limpo,
    classificacao: c.classificacao,
    resumo: c.resumo,
    sugestao: c.sugestao_resposta || null,
    temperatura: c.temperatura ?? null,
    proximo_passo: c.proximo_passo || null,
  });
  if (!id) return null;

  // Já disse que não tem interesse: só reabre se agora mostrar interesse; o resto fica registrado sem resposta.
  // (Agente: quem chamou foi o cliente, então ele sempre é respondido.)
  const jaEncerrada = ENCERRADOS.includes(lead.status) && !agente;
  if (jaEncerrada && !["interessado", "quer_informacoes", "descadastro"].includes(c.classificacao)) {
    await db.atualizarResposta(id, { lida: true });
    log(`💬 ${lead.nome} escreveu de novo (${c.classificacao}); está sem interesse, então nada é enviado`);
    return { id, ...c };
  }

  // Robô do outro lado, ou nada a responder (só agradeceu/despediu): não responde e não gasta mais IA.
  // Mensagem automática do WhatsApp Business ("agradecemos o contato, responderemos em breve") não para a conversa:
  // a pessoa costuma escrever logo depois. Só para quando a IA vê um robô respondendo de verdade.
  if (c.classificacao === "automatica") c = { ...c, robo: false };
  if (c.robo || c.encerrar) {
    await db.atualizarResposta(id, { lida: true });
    if (c.robo) await pararPorRobo(lead, "parece um atendimento automático (robô)");
    else await db.cancelarPendentes(lead.id, "conversa encerrada");
    log(`🤫 ${lead.nome}: ${c.robo ? "é um robô, a IA parou" : "nada a responder, a IA não responde"}`);
    return { id, ...c };
  }

  switch (c.classificacao) {
    case "descadastro":
      await db.descadastrarLead(lead, `pediu por ${canal}`);
      break;
    case "sem_interesse": {
      // Encerra: cancela tudo o que estava para sair (todos os canais), marca e agradece uma única vez.
      await db.cancelarPendentes(lead.id, "lead sem interesse");
      await db.atualizarLead(lead.id, { status: "sem_interesse", observacao: `Sem interesse no momento (respondeu por ${canal})` });
      if (agente) {
        // O agente se despede do jeito do prompt dele (ou não diz nada), sem o agradecimento padrão da FluxDeck.
        const partes = partesDa(c);
        if (partes.length) await agendarResposta({ respostaId: id, lead, canal, de, partes, esperaMinMs: ESPERA_AGENTE_MS[0], esperaMaxMs: ESPERA_AGENTE_MS[1] });
      } else if (campanha.automacao?.respostaAutomatica) {
        const corpo = c.sugestao_resposta?.trim() || AGRADECIMENTO_PADRAO;
        await agendarResposta({ respostaId: id, lead, canal, de, assunto, origem_id, corpo, esperaMinMs: 60_000, esperaMaxMs: 3 * 60_000 });
        log(`🙏 ${lead.nome} não tem interesse: encerrada, com agradecimento`);
      }
      break;
    }
    case "automatica":
      // Não conta como resposta: a sequência continua valendo e ela já entra como lida.
      await db.atualizarResposta(id, { lida: true });
      break;
    default:
      await db.cancelarPendentes(lead.id, "lead respondeu");
      if (!["agendado", "fechado"].includes(lead.status)) await db.atualizarLead(lead.id, { status: "respondeu" });
      if (!agente && (c.classificacao === "interessado" || c.classificacao === "quer_informacoes")) {
        await enviarNotificacao(
          `${lead.nome} respondeu (${c.classificacao.replace("_", " ")})`,
          `${c.resumo}\n\nResposta:\n${limpo}\n\nPróxima mensagem${campanha.automacao?.respostaAutomatica ? " (a IA vai enviar sozinha)" : " sugerida"}:\n${c.sugestao_resposta}\n\nContato: ${de}`
        ).catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
      }
      if ((await responderSozinha({ respostaId: id, lead, canal, de, assunto, origem_id, c, campanha, agente }))?.mensagemId && apresentou) {
        await marcarApresentacaoEnviada(lead.id);
      }
  }

  // Indicou outra pessoa (cartão de contato, ou e-mail/telefone escrito na mensagem): a IA escreve para ela.
  // Nas conversas de agente isso não acontece: a mensagem para o indicado é da FluxDeck.
  if (!agente && !["descadastro", "automatica", "sem_interesse"].includes(c.classificacao)) {
    // Contatos escritos no texto só contam se a IA viu uma indicação (assinaturas de e-mail também têm telefone e e-mail).
    const doTexto = c.indicou_contato ? contatosNoTexto(limpo, [de, lead.email, lead.whatsapp]) : [];
    const indicados = [...contatosIndicados, ...doTexto];
    if (indicados.length) {
      await contatarIndicados({ lead, contatos: indicados, de, nomeDeQuemIndicou: nomeRemetente, textoDaIndicacao: limpo, campanha })
        .catch((e) => log(`⚠️  Não foi possível escrever para o contato indicado: ${e.message}`));
    }
  }

  log(`💬 Resposta de ${lead.nome} por ${canal}: ${c.classificacao}`);
  return { id, ...c };
}

/** Do outro lado é um robô: para a conversa (nada mais sai) e a IA não lê as próximas mensagens. */
async function pararPorRobo(lead, motivo) {
  await pausarIA(lead.id, motivo);
  await db.cancelarPendentes(lead.id, motivo);
  await db.atualizarLead(lead.id, { observacao: `IA parou: ${motivo}` });
}

/**
 * Conversa que a IA tinha passado para você: ela lê tudo de novo (com a sua observação, se houver)
 * e continua sozinha, respondendo a última mensagem em 1 a 2 minutos.
 */
export async function continuarComIA(respostaId, campanha, {
  nota = "", classificar = classificarResposta, apresentar = escreverApresentacao, responderAgente = responderComoAgente,
} = {}) {
  const r = await db.buscarResposta(respostaId);
  if (!r) throw new Error("Resposta não encontrada");
  const lead = await db.buscarLead(r.lead_id);
  if (lead.agente_id) return continuarComAgente(r, lead, { nota, responderAgente });
  await retomarIA(lead.id); // você mandou a IA continuar: sai da pausa
  const contexto = {
    texto: r.texto, assunto: r.assunto, lead, historico: await db.historicoConversa(lead.id), campanha, canal: r.canal,
    linkAgendamento: linkAgendamento(campanha.automacao?.calendly, lead, r.canal), apresentacao: await lerApresentacao(),
    nota: String(nota ?? "").trim().slice(0, 500),
  };
  const pensado = await pensarResposta(contexto, { classificar, apresentar });
  const { apresentou } = pensado;
  const c = semRepetirCumprimento(pensado.c, contexto.historico);
  if (!c.sugestao_resposta?.trim()) throw new Error("A IA não escreveu uma resposta para esta conversa");
  await db.atualizarResposta(r.id, {
    precisa_humano: null, classificacao: c.classificacao, resumo: c.resumo, sugestao: c.sugestao_resposta,
    temperatura: c.temperatura ?? null, proximo_passo: c.proximo_passo || null,
  });
  await db.cancelarPendentes(lead.id, "a IA respondeu de novo");
  const { mensagemId } = await agendarResposta({
    respostaId: r.id, lead, canal: r.canal, de: r.de, assunto: r.assunto, origem_id: r.origem_id,
    corpo: c.sugestao_resposta.trim(), esperaMinMs: 60_000, esperaMaxMs: 2 * 60_000,
  });
  if (apresentou) await marcarApresentacaoEnviada(lead.id);
  log(`🤖 IA voltou a conversar com ${lead.nome}`);
  return { mensagemId, sugestao: c.sugestao_resposta.trim(), classificacao: c.classificacao };
}

/** "IA continua" numa conversa de agente: ele lê tudo de novo e responde, com o prompt dele. */
async function continuarComAgente(r, lead, { nota, responderAgente }) {
  const agente = await db.buscarAgente(lead.agente_id);
  if (!agente) throw new Error("O agente desta conversa foi excluído");
  if (!agente.ligado) throw new Error(`O agente ${agente.nome} está desligado: ligue em Agentes para ele voltar a responder`);
  const historico = await db.historicoConversa(lead.id);
  const c = semRepetirCumprimento(await responderAgente({
    agente, fontes: await fontesDoAgente(agente), texto: r.texto, lead, historico,
    nota: String(nota ?? "").trim().slice(0, 500),
  }), historico);
  if (c.delegou) throw new Error(`O agente pediu de novo para você responder: ${c.motivo_humano}`);
  const partes = partesDa(c);
  if (!partes.length) throw new Error("O agente não escreveu uma resposta para esta conversa");
  await retomarIA(lead.id);
  await db.atualizarResposta(r.id, {
    precisa_humano: null, classificacao: c.classificacao, resumo: c.resumo, sugestao: c.sugestao_resposta,
    temperatura: c.temperatura ?? null, proximo_passo: c.proximo_passo || null,
  });
  await db.cancelarPendentes(lead.id, "o agente respondeu de novo");
  const { mensagemId } = await agendarResposta({
    respostaId: r.id, lead, canal: r.canal, de: r.de, partes, esperaMinMs: 60_000, esperaMaxMs: 2 * 60_000,
  });
  log(`🤖 Agente ${agente.nome} voltou a conversar com ${lead.nome}`);
  return { mensagemId, sugestao: c.sugestao_resposta, classificacao: c.classificacao };
}
