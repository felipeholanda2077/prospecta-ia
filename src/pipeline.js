import { config } from "./config.js";
import * as db from "./db.js";
import { buscarEmpresas } from "./descoberta/googlePlaces.js";
import { analisarSite } from "./analise/site.js";
import { identificarOportunidades } from "./analise/oportunidades.js";
import { ehCelularBR, normalizarTelefoneBR } from "./analise/telefone.js";
import { gerarFollowup, gerarProposta } from "./ia/proposta.js";
import { enviarEmail } from "./envio/email.js";
import { enviarWhatsapp } from "./envio/whatsapp.js";
import { verificarRespostasEmail } from "./respostas/email.js";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Na Vercel cada execução tem no máximo 300 s; as etapas param com folga
// e o que sobrar continua na próxima execução (ou no próximo clique no painel).
const TEMPO_POR_EXECUCAO_MS = 240_000;

/** Momento-limite para uma etapa terminar. */
export function prazoPadrao() {
  return config.naVercel ? Date.now() + TEMPO_POR_EXECUCAO_MS : Infinity;
}

/** WhatsApp pela API oficial (automático) ou manual (você envia pelo seu WhatsApp, a partir do painel). */
export const whatsappAutomatico = () => config.whatsapp.ativo;

// ---------- Captura de empresas ----------

/** Etapa 1: encontra empresas no Google Maps para cada nicho/cidade da campanha. */
export async function descobrir(campanha, { ate = prazoPadrao() } = {}) {
  let novas = 0;
  for (const { nicho, cidades } of campanha.buscas) {
    for (const cidade of cidades) {
      if (Date.now() > ate) return { novas, interrompido: true };
      const consulta = `${nicho} em ${cidade}`;
      try {
        const empresas = await buscarEmpresas(consulta, campanha.limites.maxEmpresasPorBusca);
        for (const e of empresas) if (await db.inserirLead({ ...e, nicho, cidade })) novas++;
        log(`🔎 "${consulta}": ${empresas.length} encontradas`);
      } catch (e) {
        log(`⚠️  Falha na busca "${consulta}": ${e.message}`);
      }
    }
  }
  log(`🔎 Descoberta concluída: ${novas} empresas novas`);
  return { novas };
}

/** Busca no Google Maps pelo painel, sem salvar: mostra o resultado para você escolher quem capturar. */
export async function buscarNoMaps(nicho, cidade, quantidade = 20) {
  const empresas = await buscarEmpresas(`${nicho} em ${cidade}`, Math.min(Number(quantidade) || 20, 60));
  const capturados = await db.placeIdsCapturados(empresas.map((e) => e.place_id));
  return empresas.map((e) => ({
    ...e,
    jaCapturado: capturados.has(e.place_id),
    celular: ehCelularBR(e.telefone),
  }));
}

/** Salva como leads as empresas escolhidas no painel. */
export async function capturarDoMaps(empresas, nicho, cidade) {
  let novas = 0;
  for (const e of empresas) {
    if (!e?.place_id || !e?.nome) continue;
    const lead = {
      place_id: String(e.place_id),
      nome: String(e.nome),
      endereco: e.endereco ?? null,
      telefone: e.telefone ?? null,
      site: e.site ?? null,
      maps_url: e.maps_url ?? null,
      avaliacao: e.avaliacao ?? null,
      total_avaliacoes: e.total_avaliacoes ?? null,
      nicho,
      cidade,
      origem: "maps",
    };
    if (await db.inserirLead(lead)) novas++;
  }
  log(`📍 ${novas} empresas capturadas do Google Maps`);
  return { novas };
}

// ---------- Análise e propostas ----------

/** Etapa 2: visita o site de cada empresa nova, encontra contatos e oportunidades. */
export async function analisar({ ate = prazoPadrao() } = {}) {
  const leads = await db.leadsPorStatus("novo");
  let analisados = 0;
  let descartados = 0;

  for (const lead of leads) {
    if (Date.now() > ate) break;
    const analise = await analisarSite(lead.site);
    const oportunidades = identificarOportunidades(analise, lead.nicho);
    const email = analise.emails?.[0] ?? null;
    const whatsapp = analise.whatsapp ?? (ehCelularBR(lead.telefone) ? normalizarTelefoneBR(lead.telefone) : null);

    let status = "analisado";
    let observacao = null;
    if (!email && !whatsapp) [status, observacao] = ["descartado", "nenhum e-mail ou celular encontrado"];
    else if (!oportunidades.length) [status, observacao] = ["descartado", "nenhuma oportunidade clara"];

    await db.atualizarLead(lead.id, {
      email,
      whatsapp,
      analise: JSON.stringify(analise),
      oportunidades: JSON.stringify(oportunidades),
      status,
      observacao,
    });
    status === "analisado" ? analisados++ : descartados++;
    await esperar(500); // educação com os servidores visitados
  }

  const restantes = await db.contarLeadsPorStatus("novo");
  log(`🧪 Análise: ${analisados} com oportunidade, ${descartados} descartadas, ${restantes} na fila`);
  return { analisados, descartados, restantes };
}

/**
 * Etapa 3: a IA escreve uma proposta personalizada para cada empresa analisada.
 * A primeira mensagem SEMPRE fica como rascunho, aguardando sua aprovação no painel.
 */
export async function propor(campanha, { ate = prazoPadrao() } = {}) {
  const leads = await db.leadsPorStatus("analisado", campanha.limites.maxPropostasPorCiclo);
  let geradas = 0;
  let ultimoErro = null;

  for (const lead of leads) {
    if (Date.now() > ate) break;
    const canais = [];
    if (campanha.canais.includes("email") && lead.email) canais.push(["email", lead.email]);
    if (campanha.canais.includes("whatsapp") && lead.whatsapp) canais.push(["whatsapp", lead.whatsapp]);

    const destinosLivres = [];
    for (const [canal, destino] of canais) {
      if (!(await db.estaDescadastrado(destino)) && !(await db.contatoJaUsado(destino))) destinosLivres.push([canal, destino]);
    }
    if (!destinosLivres.length) {
      await db.atualizarLead(lead.id, { status: "descartado", observacao: "contato já usado ou descadastrado" });
      continue;
    }

    try {
      const p = await gerarProposta(lead, JSON.parse(lead.oportunidades), campanha);
      for (const [canal, destino] of destinosLivres) {
        await db.criarMensagem({
          lead_id: lead.id,
          canal,
          destino,
          assunto: canal === "email" ? p.assunto_email : null,
          corpo: canal === "email" ? p.corpo_email : p.mensagem_whatsapp,
          status: "rascunho",
        });
      }
      await db.atualizarLead(lead.id, { status: "proposta_gerada", observacao: p.resumo_interno });
      geradas++;
      log(`✍️  Proposta para ${lead.nome} (${p.servico_principal})`);
    } catch (e) {
      ultimoErro = e.message;
      await db.atualizarLead(lead.id, { observacao: `erro ao gerar proposta: ${e.message}` });
      log(`⚠️  Falha ao gerar proposta para ${lead.nome}: ${e.message}`);
    }
  }

  const restantes = await db.contarLeadsPorStatus("analisado");
  log(`✍️  ${geradas} propostas geradas, aguardando aprovação no painel (${restantes} empresas na fila)`);
  return { geradas, restantes, ...(ultimoErro ? { erro: ultimoErro } : {}) };
}

/** Lê a caixa de entrada e registra as respostas (as do WhatsApp chegam pelo webhook). */
export async function verificarRespostas(campanha) {
  try {
    return await verificarRespostasEmail(campanha);
  } catch (e) {
    log(`⚠️  Falha ao ler respostas por e-mail: ${e.message}`);
    return { lidas: 0, respostas: 0, erro: e.message };
  }
}

/** Etapa 3b: um único lembrete, na mesma conversa, para quem não respondeu após N dias. */
export async function criarFollowups(campanha, { ate = prazoPadrao() } = {}) {
  const fu = campanha.followUp;
  if (!fu?.ativo) return { criados: 0 };

  const statusInicial = fu.aprovacaoManual === false ? "aprovada" : "rascunho";
  let criados = 0;
  for (const original of await db.candidatosFollowup(fu.diasDepois, campanha.limites.maxPropostasPorCiclo)) {
    if (Date.now() > ate) break;
    if (await db.estaDescadastrado(original.destino)) continue;
    try {
      const corpo = await gerarFollowup(original, campanha);
      await db.criarMensagem({
        lead_id: original.lead_id,
        canal: "email",
        destino: original.destino,
        assunto: /^re:/i.test(original.assunto ?? "") ? original.assunto : `Re: ${original.assunto ?? ""}`,
        corpo,
        status: statusInicial,
        tipo: "followup",
        responde_a: original.id,
      });
      criados++;
      log(`🔁 Follow-up para ${original.empresa}`);
    } catch (e) {
      log(`⚠️  Falha ao gerar follow-up para ${original.empresa}: ${e.message}`);
    }
  }
  log(`🔁 ${criados} follow-ups criados`);
  return { criados };
}

// ---------- Envio ----------

export function dentroDoHorario(limites, agora = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour: "numeric",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(agora)
      .map((p) => [p.type, p.value])
  );
  const hora = Number(partes.hour);
  const fimDeSemana = partes.weekday === "Sat" || partes.weekday === "Sun";
  if (limites.somenteDiasUteis && fimDeSemana) return false;
  return hora >= limites.horarioComercial.inicio && hora < limites.horarioComercial.fim;
}

/** Último passo antes de enviar: confere descadastro, duplicidade e status do lead. */
async function bloqueioDeEnvio(m) {
  if (await db.estaDescadastrado(m.destino)) return "contato descadastrado";
  if (m.tipo === "inicial" && (await db.contatoJaUsado(m.destino, ["enviada"]))) return "contato já recebeu outra proposta";
  if (m.tipo === "followup" && m.status_lead !== "contatado") return `follow-up cancelado: lead está como ${m.status_lead}`;
  return null;
}

/**
 * Envia uma mensagem aprovada. Retorna { enviada, motivo }.
 * Fora do horário ou acima do limite diário, ela fica na fila para a próxima rodada.
 */
export async function enviarMensagem(m, campanha, { ignorarHorario = false } = {}) {
  if (m.status !== "aprovada") return { enviada: false, motivo: `mensagem está como ${m.status}` };
  if (m.canal === "whatsapp" && !whatsappAutomatico()) {
    return { enviada: false, motivo: "WhatsApp manual: envie pelo botão do painel" };
  }

  const bloqueio = await bloqueioDeEnvio(m);
  if (bloqueio) {
    await db.atualizarMensagem(m.id, { status: "rejeitada", erro: bloqueio });
    return { enviada: false, motivo: bloqueio };
  }
  if (!ignorarHorario && !dentroDoHorario(campanha.limites)) {
    return { enviada: false, naFila: true, motivo: "fora do horário comercial; sai no próximo envio" };
  }
  if ((await db.enviadasHoje()) >= campanha.limites.envioDiarioMax) {
    return { enviada: false, naFila: true, motivo: `limite diário de ${campanha.limites.envioDiarioMax} envios atingido` };
  }

  try {
    let messageId = null;
    if (m.canal === "email") {
      const original = m.responde_a ? await db.buscarMensagem(m.responde_a) : null;
      messageId = await enviarEmail({
        para: m.destino,
        assunto: m.assunto,
        corpo: m.corpo,
        token: m.token,
        respondendoA: original?.message_id ?? null,
      });
    } else {
      await enviarWhatsapp({ para: m.destino, empresa: m.empresa, corpo: m.corpo });
    }
    await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: new Date().toISOString(), erro: null, message_id: messageId });
    await db.atualizarLead(m.lead_id, { status: "contatado" });
    log(`📨 ${m.canal} enviado para ${m.empresa} <${m.destino}>`);
    return { enviada: true };
  } catch (e) {
    await db.atualizarMensagem(m.id, { status: "erro", erro: e.message });
    log(`⚠️  Falha ao enviar para ${m.empresa}: ${e.message}`);
    return { enviada: false, motivo: e.message };
  }
}

/** Você enviou pelo seu WhatsApp (botão do painel): registra como enviada. */
export async function marcarEnviadaManual(id) {
  const m = await db.buscarMensagem(id);
  if (!m || m.canal !== "whatsapp" || !["rascunho", "aprovada"].includes(m.status)) return false;
  const bloqueio = await bloqueioDeEnvio(m);
  if (bloqueio) {
    await db.atualizarMensagem(m.id, { status: "rejeitada", erro: bloqueio });
    return false;
  }
  await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: new Date().toISOString(), erro: null });
  await db.atualizarLead(m.lead_id, { status: "contatado" });
  return true;
}

/** Etapa 4: envia a fila de mensagens aprovadas, com intervalo entre elas. */
export async function enviar(campanha, { ignorarHorario = false, ate = prazoPadrao() } = {}) {
  const { limites } = campanha;
  if (!ignorarHorario && !dentroDoHorario(limites)) {
    log("📭 Fora do horário comercial configurado; nada enviado");
    return { enviadas: 0, motivo: "fora do horário comercial" };
  }

  const restante = limites.envioDiarioMax - (await db.enviadasHoje());
  if (restante <= 0) {
    log(`📭 Limite diário de ${limites.envioDiarioMax} envios atingido`);
    return { enviadas: 0, motivo: "limite diário atingido" };
  }

  const fila = (await db.mensagensPorStatus("aprovada", restante * 2))
    .filter((m) => m.canal === "email" || whatsappAutomatico())
    .slice(0, restante);
  const intervalo = limites.intervaloEntreEnviosSegundos * 1000;
  let enviadas = 0;

  for (const [i, m] of fila.entries()) {
    const r = await enviarMensagem(m, campanha, { ignorarHorario });
    if (r.enviada) enviadas++;
    if (i === fila.length - 1) break;
    // Intervalo entre envios para não parecer disparo em massa (e não cair no spam).
    if (Date.now() + intervalo > ate) break;
    await esperar(intervalo);
  }

  log(`📨 ${enviadas} mensagens enviadas`);
  return { enviadas };
}

// ---------- Ciclo completo ----------

let cicloEmAndamento = false;

/**
 * Roda o funil completo. As respostas são lidas primeiro para que ninguém que já
 * respondeu receba follow-up no mesmo ciclo. As propostas novas ficam aguardando
 * aprovação; só a fila já aprovada é enviada.
 */
export async function executarCiclo(campanha) {
  if (cicloEmAndamento) {
    log("⏳ Já existe um ciclo em andamento");
    return null;
  }
  cicloEmAndamento = true;
  const ate = prazoPadrao();
  try {
    return {
      respostas: await verificarRespostas(campanha),
      descoberta: await descobrir(campanha, { ate }),
      analise: await analisar({ ate }),
      propostas: await propor(campanha, { ate }),
      followups: await criarFollowups(campanha, { ate }),
      envio: await enviar(campanha, { ate }),
    };
  } finally {
    cicloEmAndamento = false;
  }
}
