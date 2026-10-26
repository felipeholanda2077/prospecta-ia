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
const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR"), ...args);

/** Etapa 1: encontra empresas no Google Maps para cada nicho/cidade da campanha. */
export async function descobrir(campanha) {
  let novas = 0;
  for (const { nicho, cidades } of campanha.buscas) {
    for (const cidade of cidades) {
      const consulta = `${nicho} em ${cidade}`;
      try {
        const empresas = await buscarEmpresas(consulta, campanha.limites.maxEmpresasPorBusca);
        for (const e of empresas) if (db.inserirLead({ ...e, nicho, cidade })) novas++;
        log(`🔎 "${consulta}": ${empresas.length} encontradas`);
      } catch (e) {
        log(`⚠️  Falha na busca "${consulta}": ${e.message}`);
      }
    }
  }
  log(`🔎 Descoberta concluída: ${novas} empresas novas`);
  return { novas };
}

/** Etapa 2: visita o site de cada empresa nova, encontra contatos e oportunidades. */
export async function analisar() {
  const leads = db.leadsPorStatus("novo");
  let analisados = 0;
  let descartados = 0;

  for (const lead of leads) {
    const analise = await analisarSite(lead.site);
    const oportunidades = identificarOportunidades(analise, lead.nicho);
    const email = analise.emails?.[0] ?? null;
    const whatsapp = analise.whatsapp ?? (ehCelularBR(lead.telefone) ? normalizarTelefoneBR(lead.telefone) : null);

    let status = "analisado";
    let observacao = null;
    if (!email && !whatsapp) [status, observacao] = ["descartado", "nenhum e-mail ou celular encontrado"];
    else if (!oportunidades.length) [status, observacao] = ["descartado", "nenhuma oportunidade clara"];

    db.atualizarLead(lead.id, {
      email,
      whatsapp,
      analise: JSON.stringify(analise),
      oportunidades: JSON.stringify(oportunidades),
      status,
      observacao,
    });
    status === "analisado" ? analisados++ : descartados++;
    await esperar(1000); // educação com os servidores visitados
  }

  log(`🧪 Análise concluída: ${analisados} com oportunidade, ${descartados} descartadas`);
  return { analisados, descartados };
}

/** Etapa 3: a IA escreve uma proposta personalizada para cada empresa analisada. */
export async function propor(campanha) {
  const leads = db.leadsPorStatus("analisado", campanha.limites.maxPropostasPorCiclo);
  const statusInicial = campanha.aprovacaoManual ? "rascunho" : "aprovada";
  let geradas = 0;

  for (const lead of leads) {
    const canais = [];
    if (campanha.canais.includes("email") && lead.email) canais.push(["email", lead.email]);
    if (campanha.canais.includes("whatsapp") && config.whatsapp.ativo && lead.whatsapp)
      canais.push(["whatsapp", lead.whatsapp]);
    const destinosLivres = canais.filter(([, d]) => !db.estaDescadastrado(d) && !db.contatoJaUsado(d));

    if (!destinosLivres.length) {
      db.atualizarLead(lead.id, { status: "descartado", observacao: "contato já usado, descadastrado ou canal inativo" });
      continue;
    }

    try {
      const oportunidades = JSON.parse(lead.oportunidades);
      const p = await gerarProposta(lead, oportunidades, campanha);
      for (const [canal, destino] of destinosLivres) {
        db.criarMensagem({
          lead_id: lead.id,
          canal,
          destino,
          assunto: canal === "email" ? p.assunto_email : null,
          corpo: canal === "email" ? p.corpo_email : p.mensagem_whatsapp,
          status: statusInicial,
        });
      }
      db.atualizarLead(lead.id, { status: "proposta_gerada", observacao: p.resumo_interno });
      geradas++;
      log(`✍️  Proposta para ${lead.nome} (${p.servico_principal})`);
    } catch (e) {
      db.atualizarLead(lead.id, { observacao: `erro ao gerar proposta: ${e.message}` });
      log(`⚠️  Falha ao gerar proposta para ${lead.nome}: ${e.message}`);
    }
  }

  log(`✍️  ${geradas} propostas geradas (${statusInicial === "rascunho" ? "aguardando aprovação no painel" : "aprovadas automaticamente"})`);
  return { geradas };
}

/** Lê a caixa de entrada e registra as respostas (as do WhatsApp chegam pelo webhook). */
export async function verificarRespostas(campanha) {
  try {
    return await verificarRespostasEmail(campanha);
  } catch (e) {
    log(`⚠️  Falha ao ler respostas por e-mail: ${e.message}`);
    return { lidas: 0, respostas: 0 };
  }
}

/** Etapa 3b: um único lembrete, na mesma conversa, para quem não respondeu após N dias. */
export async function criarFollowups(campanha) {
  const fu = campanha.followUp;
  if (!fu?.ativo) return { criados: 0 };

  const statusInicial = campanha.aprovacaoManual ? "rascunho" : "aprovada";
  let criados = 0;
  for (const original of db.candidatosFollowup(fu.diasDepois, campanha.limites.maxPropostasPorCiclo)) {
    if (db.estaDescadastrado(original.destino)) continue;
    try {
      const corpo = await gerarFollowup(original, campanha);
      db.criarMensagem({
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

/** Etapa 4: envia as mensagens aprovadas, respeitando horário, limite diário e descadastros. */
export async function enviar(campanha, { ignorarHorario = false } = {}) {
  const { limites } = campanha;
  if (!ignorarHorario && !dentroDoHorario(limites)) {
    log("📭 Fora do horário comercial configurado; nada enviado");
    return { enviadas: 0 };
  }

  const restante = limites.envioDiarioMax - db.enviadasHoje();
  if (restante <= 0) {
    log(`📭 Limite diário de ${limites.envioDiarioMax} envios atingido`);
    return { enviadas: 0 };
  }

  const fila = db.mensagensPorStatus("aprovada", restante);
  let enviadas = 0;

  for (const [i, m] of fila.entries()) {
    if (db.estaDescadastrado(m.destino)) {
      db.atualizarMensagem(m.id, { status: "rejeitada", erro: "contato descadastrado" });
      continue;
    }
    if (m.tipo === "inicial" && db.contatoJaUsado(m.destino, ["enviada"])) {
      db.atualizarMensagem(m.id, { status: "rejeitada", erro: "contato já recebeu outra proposta" });
      continue;
    }
    if (m.tipo === "followup" && m.status_lead !== "contatado") {
      db.atualizarMensagem(m.id, { status: "rejeitada", erro: `follow-up cancelado: lead está como ${m.status_lead}` });
      continue;
    }

    try {
      let messageId = null;
      if (m.canal === "email") {
        const original = m.responde_a ? db.buscarMensagem(m.responde_a) : null;
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
      db.atualizarMensagem(m.id, { status: "enviada", enviada_em: new Date().toISOString(), erro: null, message_id: messageId });
      db.atualizarLead(m.lead_id, { status: "contatado" });
      enviadas++;
      log(`📨 ${m.canal} enviado para ${m.empresa} <${m.destino}>`);
    } catch (e) {
      db.atualizarMensagem(m.id, { status: "erro", erro: e.message });
      log(`⚠️  Falha ao enviar para ${m.empresa}: ${e.message}`);
    }

    // Intervalo entre envios para não parecer disparo em massa (e não cair no spam).
    if (i < fila.length - 1) await esperar(limites.intervaloEntreEnviosSegundos * 1000);
  }

  log(`📨 ${enviadas} mensagens enviadas`);
  return { enviadas };
}

let cicloEmAndamento = false;

/**
 * Roda o funil completo. As respostas são lidas primeiro para que ninguém que já
 * respondeu receba follow-up no mesmo ciclo.
 */
export async function executarCiclo(campanha) {
  if (cicloEmAndamento) {
    log("⏳ Já existe um ciclo em andamento");
    return null;
  }
  cicloEmAndamento = true;
  try {
    return {
      respostas: await verificarRespostas(campanha),
      descoberta: await descobrir(campanha),
      analise: await analisar(),
      propostas: await propor(campanha),
      followups: await criarFollowups(campanha),
      envio: await enviar(campanha),
    };
  } finally {
    cicloEmAndamento = false;
  }
}
