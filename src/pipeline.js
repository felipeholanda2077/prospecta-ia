import { config } from "./config.js";
import * as db from "./db.js";
import { buscarEmpresas } from "./descoberta/googlePlaces.js";
import { analisarSite } from "./analise/site.js";
import { identificarOportunidades, oportunidadesParaSiteBom } from "./analise/oportunidades.js";
import { ehCelularBR, normalizarTelefoneBR } from "./analise/telefone.js";
import { gerarSequencia } from "./ia/proposta.js";
import { enviarEmail } from "./envio/email.js";
import { enviarWhatsapp, enviarTextoWhatsappOficial, RODAPE_WHATSAPP } from "./envio/whatsapp.js";
import * as uazap from "./envio/uazap.js";
import { verificarRespostasEmail } from "./respostas/email.js";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Na Vercel cada execução tem no máximo 300 s; as etapas param com folga
// e o que sobrar continua na próxima execução (ou no próximo clique no painel).
const TEMPO_POR_EXECUCAO_MS = 240_000;

// Dias úteis de espera antes das etapas 2 e 3 da sequência.
const CADENCIA_PADRAO = [2, 3];

/** Momento-limite para uma etapa terminar. */
export function prazoPadrao() {
  return config.naVercel ? Date.now() + TEMPO_POR_EXECUCAO_MS : Infinity;
}

/**
 * Como o WhatsApp sai: pela UAZap (número conectado no painel), pela API oficial da Meta,
 * ou manual (você envia pelo seu WhatsApp a partir do painel).
 */
export async function modoWhatsapp() {
  if (await uazap.configurada()) return "uazap";
  if (config.whatsapp.ativo) return "oficial";
  return "manual";
}

// ---------- Datas e horário comercial ----------

function partesNoFuso(data) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, hour: "numeric", hourCycle: "h23", weekday: "short" })
      .formatToParts(data)
      .map((p) => [p.type, p.value])
  );
}

const ehFimDeSemana = (data) => ["Sat", "Sun"].includes(partesNoFuso(data).weekday);

export function dentroDoHorario(limites, agora = new Date()) {
  const partes = partesNoFuso(agora);
  const hora = Number(partes.hour);
  if (limites.somenteDiasUteis && ["Sat", "Sun"].includes(partes.weekday)) return false;
  return hora >= limites.horarioComercial.inicio && hora < limites.horarioComercial.fim;
}

/** Soma dias úteis (segunda a sexta) mantendo o horário. */
export function somarDiasUteis(data, dias) {
  const resultado = new Date(data);
  let faltam = dias;
  while (faltam > 0) {
    resultado.setTime(resultado.getTime() + 24 * 3600 * 1000);
    if (!ehFimDeSemana(resultado)) faltam--;
  }
  return resultado;
}

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
// Perfil no Google só com rede social ou link agregador conta como "sem site próprio".
const SO_REDE_SOCIAL = /instagram\.com|facebook\.com|linktr\.ee|wa\.me|ifood\.com/i;

export const semSiteProprio = (site) => !site || SO_REDE_SOCIAL.test(site);

/**
 * Ordem de prioridade dos resultados: empresas sem site primeiro (são o melhor lead
 * para vender um site), depois as com celular (dá para chamar no WhatsApp) e as mais
 * avaliadas (negócio ativo). As já capturadas vão para o fim.
 */
export function ordenarPorPrioridade(empresas) {
  const pontos = (e) => (semSiteProprio(e.site) ? 100 : 0) + (e.celular ? 10 : 0);
  return [...empresas].sort(
    (a, b) =>
      Number(Boolean(a.jaCapturado)) - Number(Boolean(b.jaCapturado)) ||
      pontos(b) - pontos(a) ||
      (b.total_avaliacoes ?? 0) - (a.total_avaliacoes ?? 0)
  );
}

export async function buscarNoMaps(nicho, cidade, quantidade = 20) {
  const empresas = await buscarEmpresas(`${nicho} em ${cidade}`, Math.min(Number(quantidade) || 20, 60));
  const capturados = await db.placeIdsCapturados(empresas.map((e) => e.place_id));
  log(`🔎 Busca no painel "${nicho} em ${cidade}": ${empresas.length} empresas`);
  return ordenarPorPrioridade(
    empresas.map((e) => ({
      ...e,
      jaCapturado: capturados.has(e.place_id),
      celular: ehCelularBR(e.telefone),
      semSite: semSiteProprio(e.site),
    }))
  );
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

// ---------- Análise e sequências ----------

/**
 * Descobre o WhatsApp da empresa: link wa.me no site, celular ou até o fixo
 * (muita empresa usa WhatsApp Business no fixo). Com a UAZap conectada, confirma
 * quais números realmente têm WhatsApp.
 */
export async function descobrirWhatsapp(lead, analise) {
  const doSite = analise.whatsapp ?? null;
  const telefone = normalizarTelefoneBR(lead.telefone);
  const candidatos = [doSite, telefone].filter(Boolean);
  if (!candidatos.length) return { whatsapp: null, whatsapp_status: null };

  if (await uazap.configurada()) {
    try {
      const verificados = await uazap.verificarNumeros(candidatos);
      const achado = verificados.find((v) => v.existe);
      if (achado) return { whatsapp: achado.numero || achado.consulta, whatsapp_status: "verificado" };
      if (verificados.length) return { whatsapp: null, whatsapp_status: "sem_whatsapp" };
    } catch (e) {
      log(`⚠️  Não foi possível verificar o WhatsApp de ${lead.nome}: ${e.message}`);
    }
  }
  if (doSite) return { whatsapp: doSite, whatsapp_status: "site" };
  return { whatsapp: telefone, whatsapp_status: ehCelularBR(telefone) ? "celular" : "fixo" };
}

/** Etapa 2: visita o site de cada empresa nova, encontra contatos e oportunidades. */
export async function analisar({ ate = prazoPadrao() } = {}) {
  const leads = await db.leadsPorStatus("novo");
  let analisados = 0;
  let descartados = 0;
  const descartes = [];

  for (const lead of leads) {
    if (Date.now() > ate) break;
    const analise = await analisarSite(lead.site);
    let oportunidades = identificarOportunidades(analise, lead.nicho);
    // Empresa escolhida por você no Maps nunca é descartada por "site bom": muda o ângulo.
    if (!oportunidades.length && lead.origem === "maps") oportunidades = oportunidadesParaSiteBom(lead.nicho);
    const email = analise.emails?.[0] ?? null;
    const { whatsapp, whatsapp_status } = await descobrirWhatsapp(lead, analise);

    let status = "analisado";
    let observacao = null;
    if (!email && !whatsapp) {
      observacao = whatsapp_status === "sem_whatsapp"
        ? "sem e-mail no site e o telefone não tem WhatsApp"
        : "sem e-mail no site e sem telefone no Google";
      status = "descartado";
    } else if (!oportunidades.length) [status, observacao] = ["descartado", "nenhuma oportunidade clara"];

    await db.atualizarLead(lead.id, {
      email,
      whatsapp,
      whatsapp_status,
      analise: JSON.stringify(analise),
      oportunidades: JSON.stringify(oportunidades),
      status,
      observacao,
    });
    if (status === "analisado") analisados++;
    else {
      descartados++;
      descartes.push({ nome: lead.nome, motivo: observacao });
    }
    await esperar(500); // educação com os servidores visitados
  }

  const restantes = await db.contarLeadsPorStatus("novo");
  log(`🧪 Análise: ${analisados} com oportunidade, ${descartados} descartadas, ${restantes} na fila`);
  return { analisados, descartados, restantes, descartes };
}

/** Volta a empresa para a análise (ex.: depois de conectar a UAZap ou mudar as regras). */
export async function reanalisar(leadId) {
  const lead = await db.buscarLead(leadId);
  if (!lead) throw new Error("Empresa não encontrada");
  if (["contatado", "respondeu", "descadastrado"].includes(lead.status)) {
    throw new Error("Esta empresa já está em contato; não dá para reanalisar");
  }
  await db.atualizarLead(lead.id, { status: "novo", observacao: null });
}

/**
 * Etapa 3: a IA escreve a sequência gradual (3 etapas por canal) de cada empresa analisada.
 * Tudo fica como rascunho, aguardando sua aprovação no painel.
 */
export async function propor(campanha, { ate = prazoPadrao() } = {}) {
  const leads = await db.leadsPorStatus("analisado", campanha.limites.maxPropostasPorCiclo);
  let geradas = 0;
  let ultimoErro = null;
  const prontas = [];

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
      // Já existe sequência para estes contatos (ex.: reanálise só para incluir o WhatsApp).
      const jaTem = await db.contatoJaUsado(lead.email ?? "") || await db.contatoJaUsado(lead.whatsapp ?? "");
      await db.atualizarLead(lead.id, jaTem
        ? { status: "proposta_gerada" }
        : { status: "descartado", observacao: "contato já usado ou descadastrado" });
      continue;
    }

    try {
      const s = await gerarSequencia(lead, JSON.parse(lead.oportunidades), campanha);
      for (const [canal, destino] of destinosLivres) {
        const textos = canal === "email" ? s.email : s.whatsapp;
        for (const [i, corpo] of textos.entries()) {
          await db.criarMensagem({
            lead_id: lead.id,
            canal,
            destino,
            // As etapas seguintes do e-mail vão como resposta na mesma conversa.
            assunto: canal === "email" ? (i === 0 ? s.assunto_email : `Re: ${s.assunto_email}`) : null,
            corpo,
            etapa: i + 1,
            tipo: i === 0 ? "inicial" : "sequencia",
          });
        }
      }
      await db.atualizarLead(lead.id, { status: "proposta_gerada", observacao: s.resumo_interno });
      geradas++;
      prontas.push({ nome: lead.nome, canais: destinosLivres.map(([c]) => c), whatsappStatus: lead.whatsapp_status });
      log(`✍️  Sequência para ${lead.nome} (${s.servico_principal})`);
    } catch (e) {
      ultimoErro = e.message;
      await db.atualizarLead(lead.id, { observacao: `erro ao gerar proposta: ${e.message}` });
      log(`⚠️  Falha ao gerar proposta para ${lead.nome}: ${e.message}`);
    }
  }

  const restantes = await db.contarLeadsPorStatus("analisado");
  log(`✍️  ${geradas} sequências geradas, aguardando aprovação no painel (${restantes} empresas na fila)`);
  return { geradas, restantes, prontas, ...(ultimoErro ? { erro: ultimoErro } : {}) };
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

// ---------- Envio ----------

/** Último passo antes de enviar: confere descadastro, duplicidade e status do lead. */
async function bloqueioDeEnvio(m) {
  if (await db.estaDescadastrado(m.destino)) return "contato descadastrado";
  if (m.tipo === "resposta") return null;
  if (m.etapa <= 1 && (await db.contatoJaUsado(m.destino, ["enviada"]))) return "contato já recebeu outra proposta";
  if (m.etapa > 1 && m.status_lead !== "contatado") return `sequência encerrada: lead está como ${m.status_lead}`;
  return null;
}

/** Message-ID do e-mail da etapa 1, para as etapas seguintes caírem na mesma conversa. */
async function threadDoEmail(m) {
  if (m.tipo === "resposta") return m.em_resposta_a;
  if (m.etapa > 1) {
    const anteriores = await db.mensagensDaSequencia(m.lead_id, "email");
    return anteriores.find((x) => x.status === "enviada" && x.message_id)?.message_id ?? null;
  }
  return m.responde_a ? (await db.buscarMensagem(m.responde_a))?.message_id ?? null : null;
}

async function registrarEnvio(m, campanha, messageId = null) {
  await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: new Date().toISOString(), erro: null, message_id: messageId });
  if (m.tipo === "resposta") return;
  await db.atualizarLead(m.lead_id, { status: "contatado" });
  if (m.etapa < 3) {
    const cadencia = campanha.cadencia?.diasUteisEntreEtapas ?? CADENCIA_PADRAO;
    await db.agendarProximaEtapa(m, somarDiasUteis(new Date(), cadencia[m.etapa - 1] ?? 2).toISOString());
  }
}

/**
 * Envia uma mensagem aprovada, SOMENTE em horário comercial e dentro do limite diário.
 * Fora disso, ela fica na fila e sai na próxima janela. Retorna { enviada, naFila, motivo }.
 */
export async function enviarMensagem(m, campanha) {
  if (m.status !== "aprovada") return { enviada: false, motivo: `mensagem está como ${m.status}` };
  const modo = m.canal === "whatsapp" ? await modoWhatsapp() : null;
  if (modo === "manual") return { enviada: false, motivo: "WhatsApp manual: envie pelo botão do painel" };

  const bloqueio = await bloqueioDeEnvio(m);
  if (bloqueio) {
    await db.atualizarMensagem(m.id, { status: "rejeitada", erro: bloqueio });
    return { enviada: false, motivo: bloqueio };
  }
  if (!dentroDoHorario(campanha.limites)) {
    return { enviada: false, naFila: true, motivo: "fora do horário comercial; sai no próximo horário de envio" };
  }
  if (m.tipo !== "resposta" && (await db.enviadasHoje()) >= campanha.limites.envioDiarioMax) {
    return { enviada: false, naFila: true, motivo: `limite diário de ${campanha.limites.envioDiarioMax} envios atingido` };
  }

  try {
    let messageId = null;
    const rodape = m.tipo === "resposta" ? "" : RODAPE_WHATSAPP;
    if (m.canal === "email") {
      messageId = await enviarEmail({
        para: m.destino,
        assunto: m.assunto,
        corpo: m.corpo,
        token: m.token,
        respondendoA: await threadDoEmail(m),
      });
    } else if (modo === "uazap") {
      if (config.modoTeste.email && !config.modoTeste.whatsapp) throw new Error("modo teste ativo sem MODO_TESTE_WHATSAPP; WhatsApp não enviado");
      messageId = await uazap.enviarTexto(config.modoTeste.whatsapp || m.destino, m.corpo + rodape);
    } else if (m.tipo === "resposta") {
      messageId = await enviarTextoWhatsappOficial({ para: m.destino, corpo: m.corpo });
    } else {
      messageId = await enviarWhatsapp({ para: m.destino, empresa: m.empresa, corpo: m.corpo });
    }
    await registrarEnvio(m, campanha, messageId);
    log(`📨 ${m.canal} (etapa ${m.etapa}) enviado para ${m.empresa} <${m.destino}>`);
    return { enviada: true };
  } catch (e) {
    await db.atualizarMensagem(m.id, { status: "erro", erro: e.message });
    log(`⚠️  Falha ao enviar para ${m.empresa}: ${e.message}`);
    return { enviada: false, motivo: e.message };
  }
}

/** Aprova as 3 etapas de uma vez. A etapa 1 sai na hora se for horário comercial. */
export async function aprovarSequencia(leadId, canal, campanha) {
  const etapas = (await db.mensagensDaSequencia(leadId, canal)).filter((m) => ["rascunho", "erro"].includes(m.status));
  if (!etapas.length) throw new Error("Nada para aprovar nesta sequência");
  for (const m of etapas) await db.atualizarMensagem(m.id, { status: "aprovada", erro: null });
  const primeira = etapas.find((m) => m.etapa <= 1);
  if (!primeira) return { enviada: false, naFila: true, motivo: "etapas aprovadas; saem nas datas agendadas" };
  return enviarMensagem({ ...primeira, status: "aprovada" }, campanha);
}

export async function rejeitarSequencia(leadId, canal) {
  for (const m of await db.mensagensDaSequencia(leadId, canal)) {
    if (["rascunho", "aprovada", "erro"].includes(m.status)) await db.atualizarMensagem(m.id, { status: "rejeitada", erro: "rejeitada no painel" });
  }
}

/** Você enviou pelo seu WhatsApp (botão do painel): registra como enviada e agenda a próxima etapa. */
export async function marcarEnviadaManual(id, campanha) {
  const m = await db.buscarMensagem(id);
  if (!m || m.canal !== "whatsapp" || !["rascunho", "aprovada"].includes(m.status)) return false;
  const bloqueio = await bloqueioDeEnvio(m);
  if (bloqueio) {
    await db.atualizarMensagem(m.id, { status: "rejeitada", erro: bloqueio });
    return false;
  }
  // Enviar o primeiro contato manualmente também aprova as etapas seguintes da sequência.
  if (m.etapa <= 1 && m.tipo !== "resposta") {
    for (const x of await db.mensagensDaSequencia(m.lead_id, "whatsapp")) {
      if (x.id !== m.id && x.status === "rascunho") await db.atualizarMensagem(x.id, { status: "aprovada" });
    }
  }
  await registrarEnvio(m, campanha);
  return true;
}

/** Responde uma conversa com o texto revisado no painel. Respeita o horário comercial. */
export async function responderConversa(respostaId, texto, campanha) {
  const r = await db.buscarResposta(respostaId);
  if (!r) throw new Error("Resposta não encontrada");
  if (!String(texto ?? "").trim()) throw new Error("Escreva a mensagem antes de enviar");
  const destino = r.canal === "email" ? r.email || r.de : r.whatsapp || r.de;
  const id = await db.criarMensagem({
    lead_id: r.lead_id,
    canal: r.canal,
    destino,
    assunto: r.canal === "email" ? (/^re:/i.test(r.assunto ?? "") ? r.assunto : `Re: ${r.assunto ?? ""}`) : null,
    corpo: texto.trim(),
    status: "aprovada",
    tipo: "resposta",
    etapa: 0,
    em_resposta_a: r.canal === "email" ? r.origem_id : null,
  });
  await db.marcarRespostaLida(respostaId);
  const m = await db.buscarMensagem(id);
  if (r.canal === "whatsapp" && (await modoWhatsapp()) === "manual") {
    return { enviada: false, manual: true, id, motivo: "envie pelo seu WhatsApp" };
  }
  return { id, ...(await enviarMensagem(m, campanha)) };
}

/**
 * Etapa 4: envia a fila (etapas aprovadas e já no dia agendado), com intervalo entre elas.
 * Nada sai fora do horário comercial de segunda a sexta.
 */
export async function enviar(campanha, { ate = prazoPadrao() } = {}) {
  const { limites } = campanha;
  if (!dentroDoHorario(limites)) {
    log("📭 Fora do horário comercial; nada enviado");
    return { enviadas: 0, motivo: "fora do horário comercial" };
  }

  const restante = limites.envioDiarioMax - (await db.enviadasHoje());
  const manual = (await modoWhatsapp()) === "manual";
  let vagas = restante;
  const fila = (await db.filaDeEnvio(200))
    .filter((m) => m.canal === "email" || !manual)
    .filter((m) => m.tipo === "resposta" || vagas-- > 0);
  if (!fila.length) {
    log(restante <= 0 ? `📭 Limite diário de ${limites.envioDiarioMax} envios atingido` : "📭 Nada para enviar agora");
    return { enviadas: 0, ...(restante <= 0 ? { motivo: "limite diário atingido" } : {}) };
  }

  const intervalo = limites.intervaloEntreEnviosSegundos * 1000;
  let enviadas = 0;
  for (const [i, m] of fila.entries()) {
    const r = await enviarMensagem(m, campanha);
    if (r.enviada) enviadas++;
    if (i === fila.length - 1) break;
    // Intervalo entre envios para não parecer disparo em massa (e não cair no spam).
    if (Date.now() + intervalo > ate) break;
    await esperar(intervalo);
  }

  log(`📨 ${enviadas} mensagens enviadas`);
  return { enviadas };
}

// ---------- Rotinas ----------

/** Rodada de envios do horário comercial: lê respostas (para parar sequências) e envia a fila. */
export async function rodadaDeEnvios(campanha) {
  const ate = prazoPadrao();
  return {
    respostas: await verificarRespostas(campanha),
    envio: await enviar(campanha, { ate }),
  };
}

let cicloEmAndamento = false;

/**
 * Roda o funil completo. As respostas são lidas primeiro para que ninguém que já
 * respondeu receba a próxima etapa. As sequências novas ficam aguardando aprovação;
 * só o que você já aprovou é enviado.
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
      envio: await enviar(campanha, { ate }),
    };
  } finally {
    cicloEmAndamento = false;
  }
}
