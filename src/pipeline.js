import { config } from "./config.js";
import * as db from "./db.js";
import { buscarEmpresas } from "./descoberta/googlePlaces.js";
import { buscaNoInstagram, buscarEmpresasNoInstagram, instagramDaEmpresa } from "./descoberta/instagram.js";
import { analisarSite } from "./analise/site.js";
import { identificarOportunidades, oportunidadesParaSiteBom } from "./analise/oportunidades.js";
import { ehCelularBR, normalizarTelefoneBR } from "./analise/telefone.js";
import { gerarSequencia } from "./ia/proposta.js";
import { enviarEmail, explicarErroEmail, enviarNotificacao } from "./envio/email.js";
import { enviarWhatsapp, enviarTextoWhatsappOficial, RODAPE_WHATSAPP } from "./envio/whatsapp.js";
import * as uazap from "./envio/uazap.js";
import * as evolution from "./envio/evolution.js";
import { verificarAgendamentos, aplicarLinkAgendamento } from "./agenda/calendly.js";
import { semSiteProprio, potencialDaEmpresa } from "./analise/prioridade.js";
import { verificarRespostasEmail } from "./respostas/email.js";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

// Na Vercel cada execução tem no máximo 300 s; as etapas param com folga
// e o que sobrar continua na próxima execução (ou no próximo clique no painel).
const TEMPO_POR_EXECUCAO_MS = 240_000;
// Folga antes do prazo para não começar uma tarefa demorada (IA, visita a site) que passaria do limite.
const FOLGA_MS = 60_000;
const semTempo = (ate) => Date.now() + FOLGA_MS > ate;

// As 3 etapas saem no mesmo dia: a 2 cerca de 2 h depois da 1, e a 3 cerca de 2 h depois da 2.
// No fim do expediente o intervalo encolhe para caber no dia, mas nunca fica abaixo do mínimo.
const HORAS_ENTRE_ETAPAS = [2, 2];
// No e-mail, cada etapa sai em outro dia: a 2 um dia útil depois da 1, e a 3 dois dias úteis depois da 2.
const DIAS_ENTRE_EMAILS = [1, 2];
const INTERVALO_MINIMO_MIN = 45;
const MARGEM_FIM_MIN = 15;
// Sequência nova só começa se ainda der tempo de as 3 etapas saírem hoje.
const TEMPO_PARA_SEQUENCIA_MIN = 2 * INTERVALO_MINIMO_MIN + MARGEM_FIM_MIN;
// Empresas novas por rodada, no mínimo: terminou uma, já vai para a próxima (com intervalo entre elas).
const LOTE_POR_RODADA = 5;
// Entre uma empresa nova e a próxima, de 5 a 12 minutos (sorteado a cada vez), para o número
// e o e-mail não parecerem disparo em massa. Ajustável em Automação.
const INTERVALO_EMPRESAS_MIN = [5, 12];
const VEZ_DA_EMPRESA_NOVA = "vez_da_empresa_nova";

/** Momento-limite para uma etapa terminar. */
export function prazoPadrao() {
  return config.naVercel ? Date.now() + TEMPO_POR_EXECUCAO_MS : Infinity;
}

const INTEGRACOES_WHATSAPP = { uazap, evolution };

/**
 * Integração de WhatsApp Web em uso. Com a UAZap e a Evolution configuradas, vale a que
 * estiver conectada; se as duas estiverem (ou nenhuma), a UAZap.
 */
async function integracaoWhatsapp() {
  const [temUazap, temEvolution] = await Promise.all([uazap.configurada(), evolution.configurada()]);
  if (temUazap && temEvolution) {
    return !(await uazap.conectadoAgora()) && (await evolution.conectadoAgora()) ? "evolution" : "uazap";
  }
  return temUazap ? "uazap" : temEvolution ? "evolution" : null;
}

/**
 * Como o WhatsApp sai: pela UAZap ou pela Evolution API (número conectado no painel),
 * pela API oficial da Meta, ou manual (você envia pelo seu WhatsApp a partir do painel).
 */
export async function modoWhatsapp() {
  const integracao = await integracaoWhatsapp();
  if (integracao) return integracao;
  if (config.whatsapp.ativo) return "oficial";
  return "manual";
}

// Erros de envio que indicam o número desconectado (e não um problema com a mensagem).
const QUEDA_DO_WHATSAPP = /connection closed|not connected|disconnected|desconectad|respondeu 503|respondeu 502|instance.*(not found|close)|não foi possível acessar/i;
const AVISO_DESCONECTADO_MS = 6 * 3600 * 1000;

/**
 * O WhatsApp Web (UAZap/Evolution) caiu? Enquanto estiver desconectado, as mensagens de
 * WhatsApp ficam na fila (sem virar erro) e saem quando o número for reconectado.
 */
export async function whatsappDesconectado(modo) {
  return Boolean(INTEGRACOES_WHATSAPP[modo]) && !(await INTEGRACOES_WHATSAPP[modo].conectadoAgora());
}

/** Avisa por e-mail que o WhatsApp caiu, no máximo a cada 6 horas. */
async function avisarWhatsappDesconectado(modo) {
  if (await db.travar("aviso_whatsapp_desconectado", AVISO_DESCONECTADO_MS)) {
    await enviarNotificacao(
      "WhatsApp desconectado: os envios estão parados",
      `O número do WhatsApp (${modo === "evolution" ? "Evolution API" : "UAZap"}) está desconectado. As mensagens de WhatsApp ficam na Fila de envio e saem sozinhas assim que você reconectar o número em Configurações (lendo o QR code). Os e-mails continuam saindo normalmente.`
    ).catch((e) => log(`⚠️  Não foi possível enviar o aviso: ${e.message}`));
  }
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

/** Dias úteis entre duas datas (sem contar o dia inicial). */
export function diasUteisEntre(inicio, fim = new Date()) {
  let dias = 0;
  const d = new Date(inicio);
  while (true) {
    d.setTime(d.getTime() + 24 * 3600 * 1000);
    if (d > fim) return dias;
    if (!ehFimDeSemana(d)) dias++;
  }
}

// Aquecimento do número de WhatsApp: começa com 50 empresas novas por dia e sobe 15 a cada
// dia útil até a meta (os dois valores dá para mudar em Automação).
const AQUECIMENTO_INICIAL = 50;
const AQUECIMENTO_PASSO = 15;

/** Quantas mensagens de prospecção podem sair hoje por este canal. */
export async function limiteDoDia(campanha, canal) {
  const auto = campanha.automacao;
  const meta = Number(auto?.metaDiaria?.[canal]) || campanha.limites.envioDiarioMax;
  if (canal !== "whatsapp" || !auto?.aquecimentoWhatsapp) return meta;
  const inicio = await db.lerEstado("aquecimento_whatsapp_inicio");
  const dias = inicio ? diasUteisEntre(inicio) : 0;
  const inicial = Number(auto.aquecimentoInicial) || AQUECIMENTO_INICIAL;
  const passo = Number(auto.aquecimentoPasso) || AQUECIMENTO_PASSO;
  return Math.min(meta, inicial + passo * dias);
}

/** Minutos que faltam para o fim do horário comercial de hoje (negativo depois dele). */
export function minutosAteOFim(limites, agora = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(agora)
      .map((x) => [x.type, x.value])
  );
  return limites.horarioComercial.fim * 60 - (Number(p.hour) * 60 + Number(p.minute));
}

/** Início do horário comercial do próximo dia útil (com alguns minutos de folga, como uma pessoa). */
export function inicioDoProximoDiaUtil(limites, agora = new Date()) {
  const minutosAgora = limites.horarioComercial.fim * 60 - minutosAteOFim(limites, agora);
  const inicio = limites.horarioComercial.inicio * 60;
  // Antes do expediente, o "próximo início" ainda é hoje.
  const minutos = (minutosAgora < inicio ? 0 : 24 * 60) - minutosAgora + inicio + Math.floor(Math.random() * 30);
  const d = new Date(agora.getTime() + minutos * 60_000);
  while (limites.somenteDiasUteis !== false && ehFimDeSemana(d)) d.setTime(d.getTime() + 24 * 3600 * 1000);
  return d;
}

/**
 * Quando sai a próxima etapa depois de enviar `etapaEnviada`. No WhatsApp, no mesmo dia,
 * encaixada até o fim do expediente (se não couber, no começo do próximo dia útil).
 * No e-mail, 1 a 2 dias úteis depois, no mesmo horário, para não lotar a caixa da empresa.
 */
export function horarioDaProximaEtapa(etapaEnviada, campanha, agora = new Date(), canal = "whatsapp") {
  const { limites } = campanha;
  if (canal === "email") {
    const dias = campanha.cadencia?.diasEntreEmails ?? DIAS_ENTRE_EMAILS;
    return somarDiasUteis(agora, dias[etapaEnviada - 1] ?? 2);
  }
  const horas = campanha.cadencia?.horasEntreEtapas ?? HORAS_ENTRE_ETAPAS;
  const ideal = (horas[etapaEnviada - 1] ?? 2) * 60 * (0.85 + Math.random() * 0.15);
  const faltam = 3 - etapaEnviada;
  const cabe = (minutosAteOFim(limites, agora) - MARGEM_FIM_MIN) / faltam;
  const intervalo = Math.min(ideal, cabe);
  if (dentroDoHorario(limites, agora) && intervalo >= INTERVALO_MINIMO_MIN) return new Date(agora.getTime() + intervalo * 60_000);
  return inicioDoProximoDiaUtil(limites, agora);
}

/** Etapas de e-mail que ficaram para o mesmo dia (regra antiga) passam para 1 a 2 dias úteis depois da anterior. */
export async function reagendarEmailsDoMesmoDia(campanha) {
  const dias = campanha.cadencia?.diasEntreEmails ?? DIAS_ENTRE_EMAILS;
  const lista = await db.emailsAgendadosNoMesmoDia();
  for (const m of lista) {
    const quando = somarDiasUteis(new Date(m.anterior_enviada_em), dias[m.etapa - 2] ?? 2);
    await db.atualizarMensagem(m.id, { agendada_para: quando.toISOString() });
  }
  if (lista.length) log(`📅 ${lista.length} etapas de e-mail reagendadas para outro dia`);
  return lista.length;
}

/** Ainda dá tempo de começar uma sequência e as 3 etapas saírem hoje? */
export const daTempoDeSequenciaHoje = (limites, agora = new Date()) => minutosAteOFim(limites, agora) >= TEMPO_PARA_SEQUENCIA_MIN;

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

/** Todas as combinações segmento × cidade da campanha, na ordem da rotação. */
export function combinacoesDeBusca(campanha) {
  return campanha.buscas.flatMap(({ nicho, cidades }) => cidades.map((cidade) => ({ nicho, cidade })));
}

/**
 * Busca automática: pega a próxima combinação segmento × cidade da rotação. Se ela não
 * trouxer nenhuma empresa nova (já capturou todas), tenta as seguintes.
 */
export async function descobrirProxima(campanha, { tentativas = 3 } = {}) {
  const combinacoes = combinacoesDeBusca(campanha);
  if (!combinacoes.length) return { novas: 0, motivo: "nenhuma busca configurada" };
  let indice = Number((await db.lerEstado("busca_rotacao")) ?? 0);
  const inicio = indice;
  let novas = 0;
  const feitas = [];
  for (let t = 0; t < Math.min(tentativas, combinacoes.length) && !novas; t++) {
    const { nicho, cidade } = combinacoes[indice % combinacoes.length];
    indice++;
    try {
      const empresas = ordenarPorPrioridade(await buscarEmpresas(`${nicho} em ${cidade}`, 60));
      for (const e of empresas) if (await db.inserirLead({ ...e, nicho, cidade })) novas++;
      feitas.push(`${nicho} em ${cidade}`);
      log(`🔎 Busca automática "${nicho} em ${cidade}": ${novas} novas`);
    } catch (e) {
      log(`⚠️  Falha na busca automática "${nicho} em ${cidade}": ${e.message}`);
      break;
    }
  }
  await db.gravarEstado("busca_rotacao", indice % combinacoes.length);
  const instagram = await descobrirNoInstagram(campanha, combinacoes[inicio % combinacoes.length]);
  return { novas: novas + (instagram?.novas ?? 0), buscas: feitas, ...(instagram ? { instagram } : {}) };
}

/**
 * Com o Instagram conectado pela página do Facebook, a busca automática também procura no
 * Instagram o mesmo segmento e cidade (pela hashtag, ex.: #petshopfortaleza).
 */
export async function descobrirNoInstagram(campanha, { nicho, cidade }, { quantidade = 10 } = {}) {
  if (campanha.automacao?.buscarNoInstagram === false) return null;
  if (!(await buscaNoInstagram()).conexao) return null;
  try {
    const { empresas, hashtags, avisos } = await buscarEmpresasNoInstagram({ nicho, cidade, quantidade });
    const novas = (await capturarDoInstagram(empresas, nicho, cidade)).novas;
    log(`📸 Busca automática no Instagram ${hashtags.map((t) => `#${t}`).join(" ") || "(sem hashtag livre)"}: ${novas} novas${avisos.length ? ` · ${avisos.join(" · ")}` : ""}`);
    return { novas, hashtags, avisos };
  } catch (e) {
    log(`⚠️  Falha na busca automática no Instagram "${nicho} em ${cidade}": ${e.message}`);
    return { novas: 0, erro: e.message };
  }
}

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

/** Busca no Google Maps pelo painel, sem salvar: mostra o resultado para você escolher quem capturar. */
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

/** Busca no Instagram pelo painel, sem salvar: mostra os perfis comerciais para você escolher. */
export async function buscarNoInstagram(nicho, cidade, termos = "", quantidade = 20) {
  const r = await buscarEmpresasNoInstagram({ nicho, cidade, termos, quantidade: Math.min(Number(quantidade) || 20, 40) });
  const capturados = await db.instagramsCapturados(r.empresas.map((e) => e.instagram));
  log(`📸 Busca no painel no Instagram "${nicho} em ${cidade}": ${r.empresas.length} perfis`);
  return {
    ...r,
    empresas: ordenarPorPrioridade(
      r.empresas.map((e) => ({ ...e, jaCapturado: capturados.has(e.instagram), celular: ehCelularBR(e.telefone), semSite: semSiteProprio(e.site) }))
    ),
  };
}

/** Salva como leads os perfis do Instagram escolhidos (ou achados pela busca automática). */
export async function capturarDoInstagram(empresas, nicho, cidade) {
  const validas = empresas.filter((e) => /^[a-z0-9._]{2,30}$/.test(String(e?.instagram ?? "")) && e?.nome);
  const capturados = await db.instagramsCapturados(validas.map((e) => e.instagram));
  let novas = 0;
  for (const e of validas) {
    if (capturados.has(e.instagram)) continue;
    const dados = e.instagram_dados ?? {};
    const lead = {
      place_id: `ig:${e.instagram}`,
      nome: String(e.nome).slice(0, 120),
      endereco: null,
      telefone: e.telefone ? String(e.telefone) : null,
      email: e.email ? String(e.email) : null,
      site: e.site ? String(e.site) : `https://www.instagram.com/${e.instagram}/`,
      maps_url: null,
      avaliacao: null,
      total_avaliacoes: null,
      instagram: e.instagram,
      instagram_dados: { seguidores: dados.seguidores ?? null, posts: dados.posts ?? null, ultimoPost: dados.ultimoPost ?? null, bio: String(dados.bio ?? "").slice(0, 300) },
      nicho,
      cidade,
      origem: "instagram",
    };
    if (await db.inserirLead(lead)) novas++;
  }
  if (novas) log(`📸 ${novas} empresas capturadas do Instagram`);
  return { novas };
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
 * (muita empresa usa WhatsApp Business no fixo). Com a UAZap ou a Evolution conectada,
 * confirma quais números realmente têm WhatsApp.
 */
export async function descobrirWhatsapp(lead, analise) {
  const doSite = analise.whatsapp ?? null;
  const telefone = normalizarTelefoneBR(lead.telefone);
  const candidatos = [doSite, telefone].filter(Boolean);
  if (!candidatos.length) return { whatsapp: null, whatsapp_status: null };

  const integracao = await integracaoWhatsapp();
  if (integracao) {
    try {
      const verificados = await INTEGRACOES_WHATSAPP[integracao].verificarNumeros(candidatos);
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
export async function analisar({ ate = prazoPadrao(), limite = 1000 } = {}) {
  const leads = await db.leadsPorStatus("novo", limite);
  let analisados = 0;
  let descartados = 0;
  const descartes = [];

  for (const lead of leads) {
    if (semTempo(ate)) break;
    let analise = await analisarSite(lead.site);
    // O perfil do Instagram (o do Google, o do site ou o capturado por lá): bio com WhatsApp e
    // e-mail, e o site de verdade quando o Google só tem o link do Instagram.
    const insta = await instagramDaEmpresa(lead, analise).catch(() => null);
    if (insta && !analise.temSite && insta.site && !semSiteProprio(insta.site)) analise = await analisarSite(insta.site);
    if (insta) {
      analise.instagram = { usuario: insta.usuario, seguidores: insta.seguidores, posts: insta.posts, ultimoPost: insta.ultimoPost };
      analise.whatsapp ??= insta.contatos.whatsapp;
    }
    let oportunidades = identificarOportunidades(analise, lead.nicho);
    // Empresa com site bom não é descartada: a abordagem muda para automação e sistema.
    if (!oportunidades.length) oportunidades = oportunidadesParaSiteBom(lead.nicho);
    const email = analise.emails?.[0] ?? insta?.contatos.email ?? lead.email ?? null;
    const telefone = lead.telefone ?? insta?.contatos.telefone ?? null;
    const { whatsapp, whatsapp_status } = await descobrirWhatsapp({ ...lead, telefone }, analise);

    let status = "analisado";
    let observacao = null;
    if (!email && !whatsapp) {
      observacao = whatsapp_status === "sem_whatsapp"
        ? "sem e-mail no site e o telefone não tem WhatsApp"
        : lead.origem === "instagram" ? "sem e-mail nem WhatsApp na bio do Instagram" : "sem e-mail no site e sem telefone no Google";
      status = "descartado";
    } else if (!oportunidades.length) [status, observacao] = ["descartado", "nenhuma oportunidade clara"];

    await db.atualizarLead(lead.id, {
      email,
      telefone,
      ...(insta ? { instagram: insta.usuario, instagram_dados: JSON.stringify({ ...analise.instagram, bio: insta.bio }) } : {}),
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

/** Volta a empresa para a análise (ex.: depois de conectar o WhatsApp ou mudar as regras). */
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
export async function propor(campanha, { ate = prazoPadrao(), limite = campanha.limites.maxPropostasPorCiclo } = {}) {
  const leads = await db.leadsPorStatus("analisado", limite);
  // No modo automático as sequências já nascem aprovadas; senão esperam você no painel.
  const statusInicial = campanha.automacao?.ativo ? "aprovada" : "rascunho";
  let geradas = 0;
  let ultimoErro = null;
  const prontas = [];

  for (const lead of leads) {
    if (semTempo(ate)) break;
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
            status: statusInicial,
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
  log(`✍️  ${geradas} sequências geradas (${statusInicial === "aprovada" ? "aprovadas automaticamente" : "aguardando aprovação no painel"}; ${restantes} empresas na fila)`);
  return { geradas, restantes, prontas, ...(ultimoErro ? { erro: ultimoErro } : {}) };
}

/** Lê a caixa de entrada e registra as respostas (as do WhatsApp chegam pelo webhook). */
export async function verificarRespostas(campanha) {
  try {
    return await verificarRespostasEmail(campanha);
  } catch (e) {
    const motivo = explicarErroEmail(e, "IMAP");
    // Diagnóstico só no log do servidor (privado): quem está logando e o tamanho da senha, nunca a senha.
    const { host, user, pass } = config.imap;
    log(`⚠️  Falha ao ler respostas por e-mail: ${motivo}${e.responseText ? ` (servidor: ${e.responseText})` : ""}` +
        ` [host=${host} usuario=${user} senha=${pass.length} caracteres${/\s/.test(pass) ? ", com espaços" : ""}]`);
    return { lidas: 0, respostas: 0, erro: motivo };
  }
}

// ---------- Envio ----------

/** Último passo antes de enviar: confere descadastro, duplicidade e status do lead. */
async function bloqueioDeEnvio(m) {
  if (await db.estaDescadastrado(m.destino)) return "contato descadastrado";
  if (m.tipo === "resposta") return null;
  // Disse que não tem interesse: nenhuma etapa sai mais (só o agradecimento, que é uma resposta).
  if (["sem_interesse", "descadastrado"].includes(m.status_lead)) return `empresa encerrada: ${m.status_lead.replace("_", " ")}`;
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
  if (m.etapa < 3) await db.agendarProximaEtapa(m, horarioDaProximaEtapa(m.etapa, campanha, new Date(), m.canal).toISOString());
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
  if (m.canal === "whatsapp" && (await whatsappDesconectado(modo))) {
    return { enviada: false, naFila: true, motivo: "WhatsApp desconectado; sai quando você reconectar o número em Configurações" };
  }
  if (m.tipo !== "resposta" && m.etapa <= 1) {
    const limite = await limiteDoDia(campanha, m.canal);
    if ((await db.enviadasHoje(m.canal, { primeiroContato: true })) >= limite) {
      return { enviada: false, naFila: true, motivo: `limite de hoje no ${m.canal === "email" ? "e-mail" : "WhatsApp"} (${limite}) atingido` };
    }
  }

  // Outra execução (os dois agendadores, ou um clique no painel) pode já estar enviando esta mensagem.
  if (!(await db.reservarParaEnvio(m.id))) return { enviada: false, motivo: "já está sendo enviada" };

  // O marcador da última etapa vira o link de agendamento desta empresa (e fica salvo no histórico).
  const corpoFinal = aplicarLinkAgendamento(m.corpo, campanha.automacao?.calendly, { token: m.token, email: m.destino }, m.canal);
  if (corpoFinal !== m.corpo) {
    await db.atualizarMensagem(m.id, { corpo: corpoFinal });
    m = { ...m, corpo: corpoFinal };
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
    } else if (INTEGRACOES_WHATSAPP[modo]) {
      if (config.modoTeste.email && !config.modoTeste.whatsapp) throw new Error("modo teste ativo sem MODO_TESTE_WHATSAPP; WhatsApp não enviado");
      messageId = await INTEGRACOES_WHATSAPP[modo].enviarTexto(config.modoTeste.whatsapp || m.destino, m.corpo + rodape);
    } else if (m.tipo === "resposta") {
      messageId = await enviarTextoWhatsappOficial({ para: m.destino, corpo: m.corpo });
    } else {
      messageId = await enviarWhatsapp({ para: m.destino, empresa: m.empresa, corpo: m.corpo });
    }
    await registrarEnvio(m, campanha, messageId);
    if (m.canal === "whatsapp" && !(await db.lerEstado("aquecimento_whatsapp_inicio"))) {
      await db.gravarEstado("aquecimento_whatsapp_inicio", new Date().toISOString());
    }
    log(`📨 ${m.canal} (etapa ${m.etapa}) enviado para ${m.empresa} <${m.destino}>`);
    return { enviada: true };
  } catch (e) {
    // O número caiu no meio do envio: a mensagem volta para a fila em vez de virar erro.
    if (m.canal === "whatsapp" && INTEGRACOES_WHATSAPP[modo] && QUEDA_DO_WHATSAPP.test(e.message)) {
      INTEGRACOES_WHATSAPP[modo].esquecerConexao();
      await db.atualizarMensagem(m.id, { status: "aprovada", erro: null });
      log(`📵 WhatsApp desconectado ao enviar para ${m.empresa}; a mensagem continua na fila`);
      return { enviada: false, naFila: true, motivo: "WhatsApp desconectado; a mensagem continua na fila" };
    }
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
  // Para quem escreveu (pode ser um contato indicado, não o e-mail/número original da empresa).
  const destino = r.de || (r.canal === "email" ? r.email : r.whatsapp);
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
 * Ordem de envio: respostas da conversa (quem respondeu não pode esperar), depois as etapas
 * 2 e 3 já agendadas, e por último as empresas novas, das com mais potencial de venda para as
 * com menos. A cota do dia de empresas novas vai, assim, para as melhores.
 */
export function ordenarFilaDeEnvio(fila) {
  const grupo = (m) => (m.tipo === "resposta" ? 0 : m.etapa > 1 ? 1 : 2);
  const potencial = (m) => (grupo(m) === 2 ? potencialDaEmpresa(m).pontos : 0);
  return [...fila].sort((a, b) => grupo(a) - grupo(b) || potencial(b) - potencial(a));
}

/** Espera até a próxima empresa nova, em ms: sorteada entre o mínimo e o máximo da Automação. */
export function intervaloEntreEmpresasMs(auto = {}, sorteio = Math.random()) {
  const min = Math.max(0, Number(auto?.intervaloEmpresasMin ?? INTERVALO_EMPRESAS_MIN[0]));
  const max = Math.max(min, Number(auto?.intervaloEmpresasMax ?? INTERVALO_EMPRESAS_MIN[1]));
  return Math.round((min + sorteio * (max - min)) * 60_000);
}

/** Quando a próxima empresa nova pode receber o primeiro contato (null = já pode). */
export async function proximaEmpresaNovaEm() {
  const ate = Number(await db.lerEstado(VEZ_DA_EMPRESA_NOVA));
  return ate > Date.now() ? new Date(ate).toISOString() : null;
}

/** Rodadas de 10 minutos que ainda restam no horário comercial de hoje. */
export function rodadasRestantesHoje(limites, agora = new Date(), folgaMin = 0) {
  return Math.max(1, Math.floor((minutosAteOFim(limites, agora) - folgaMin) / 10));
}

/**
 * Etapa 4: envia a fila (etapas aprovadas e já no dia agendado), com intervalo variável.
 * Nada sai fora do horário comercial de segunda a sexta. Com `distribuir`, a cota de
 * hoje é espalhada pelas rodadas que faltam, para não sair tudo de uma vez.
 * Empresas novas saem uma por vez, com 5 a 12 minutos entre elas (o agendador do banco
 * chama `somenteNovas` a cada minuto para respeitar esse intervalo).
 */
export async function enviar(campanha, { ate = prazoPadrao(), distribuir = false, somenteNovas = false } = {}) {
  const { limites } = campanha;
  if (!dentroDoHorario(limites)) {
    if (!somenteNovas) log("📭 Fora do horário comercial; nada enviado");
    return { enviadas: 0, motivo: "fora do horário comercial" };
  }

  const modo = await modoWhatsapp();
  // Manual ou desconectado: o WhatsApp fica na fila e só o e-mail sai nesta rodada.
  const semWhatsapp = modo === "manual" || (await whatsappDesconectado(modo));
  if (semWhatsapp && modo !== "manual") {
    if (!somenteNovas) log("📵 WhatsApp desconectado: as mensagens de WhatsApp ficam na fila até reconectar");
    await avisarWhatsappDesconectado(modo);
  }
  // A meta do dia é de empresas novas (etapa 1). No WhatsApp ela é espalhada até a hora em
  // que ainda dá para as 3 etapas saírem hoje; no e-mail, até o fim do expediente (as etapas
  // seguintes saem em outros dias). Etapas 2 e 3 e respostas da conversa não entram na conta.
  const vagas = {};
  for (const canal of ["email", "whatsapp"]) {
    const iniciaSequencias = canal === "email" || daTempoDeSequenciaHoje(limites);
    const restante = iniciaSequencias
      ? (await limiteDoDia(campanha, canal)) - (await db.enviadasHoje(canal, { primeiroContato: true }))
      : 0;
    const rodadas = rodadasRestantesHoje(limites, new Date(), canal === "email" ? 0 : TEMPO_PARA_SEQUENCIA_MIN);
    vagas[canal] = distribuir ? Math.min(restante, Math.max(LOTE_POR_RODADA, Math.ceil(restante / rodadas))) : restante;
  }
  const vagasDaRodada = { ...vagas };
  const todas = ordenarFilaDeEnvio(await db.filaDeEnvio(400));
  const daConversa = (m) => m.tipo === "resposta" || m.etapa > 1;
  const enviaveis = todas.filter((m) => m.canal === "email" || !semWhatsapp);
  // Da empresa nova da vez (a de mais potencial com vaga hoje) saem juntos o e-mail e o WhatsApp.
  const novas = enviaveis.filter((m) => !daConversa(m) && vagas[m.canal] > 0);
  const empresaDaVez = novas[0]?.lead_id;
  const fila = [
    ...(somenteNovas ? [] : enviaveis.filter(daConversa)),
    ...novas.filter((m) => m.lead_id === empresaDaVez),
  ];
  const naFila = { email: 0, whatsapp: 0 };
  for (const m of todas) naFila[m.canal]++;
  if (!fila.length) {
    if (!somenteNovas) log("📭 Nada para enviar agora");
    return { enviadas: 0, naFila, vagas: vagasDaRodada };
  }

  const intervalo = limites.intervaloEntreEnviosSegundos * 1000;
  let enviadas = 0;
  let enviouEmpresaNova = false;
  let proximaEmpresaNova = null;
  const porCanal = { email: 0, whatsapp: 0 };
  for (const [i, m] of fila.entries()) {
    const novaDaVez = !daConversa(m);
    // A vez da empresa nova é reservada no banco: com dois agendadores rodando juntos, só um
    // deles envia, e a próxima só sai depois do intervalo sorteado.
    if (novaDaVez && !enviouEmpresaNova && proximaEmpresaNova === null) {
      const espera = intervaloEntreEmpresasMs(campanha.automacao);
      if (!(await db.travar(VEZ_DA_EMPRESA_NOVA, espera))) break;
      proximaEmpresaNova = new Date(Date.now() + espera).toISOString();
    }
    const r = await enviarMensagem(m, campanha);
    if (r.enviada) {
      enviadas++;
      porCanal[m.canal]++;
      if (novaDaVez) enviouEmpresaNova = true;
    }
    if (i === fila.length - 1) break;
    // Intervalo variável entre envios, para não parecer disparo em massa (nem cair no spam).
    const espera = Math.round(intervalo * (0.6 + Math.random() * 0.8));
    if (Date.now() + espera > ate) break;
    await esperar(espera);
  }

  // Nada da empresa da vez saiu (bloqueada, limite, erro): a próxima não precisa esperar.
  if (proximaEmpresaNova && !enviouEmpresaNova) {
    await db.destravar(VEZ_DA_EMPRESA_NOVA);
    proximaEmpresaNova = null;
  }
  if (enviouEmpresaNova) log(`⏱️  Próxima empresa nova a partir de ${new Date(proximaEmpresaNova).toLocaleTimeString("pt-BR", { timeZone: config.timezone })}`);
  log(`📨 ${enviadas} mensagens enviadas (e-mail: ${porCanal.email}, WhatsApp: ${porCanal.whatsapp})`);
  return { enviadas, porCanal, naFila, vagas: vagasDaRodada, proximaEmpresaNova };
}

// ---------- Rotinas ----------

// Quantas empresas preparadas (analisadas ou na fila de análise) manter de reserva.
const RESERVA_DE_EMPRESAS = 15;

/**
 * Rodada do funil automático (a cada 10 minutos): lê respostas, envia a cota da rodada
 * (só em horário comercial) e, no modo automático, usa o tempo que sobra para buscar,
 * analisar e preparar novas sequências. Antes das 9h ela só prepara, para o dia começar
 * com a fila cheia.
 */
export async function rodadaAutomatica(campanha) {
  // Só uma rodada por vez, mesmo com o agendador do banco e o do GitHub disparando juntos.
  if (!(await db.travar("rodada_em_andamento", TEMPO_POR_EXECUCAO_MS + 60_000))) {
    return { pulada: "outra rodada já está em andamento" };
  }
  try {
    return await rodada(campanha);
  } finally {
    await db.destravar("rodada_em_andamento");
  }
}

async function rodada(campanha) {
  const ate = prazoPadrao();
  await db.liberarEnviosTravados();
  const devolvidas = await db.devolverErrosDeConexaoWhatsapp();
  if (devolvidas) log(`↩️  ${devolvidas} mensagens de WhatsApp que falharam com o número desconectado voltaram para a fila`);
  await reagendarEmailsDoMesmoDia(campanha);
  await conferirWebhookWhatsapp();
  const resultado = { respostas: await verificarRespostas(campanha) };
  resultado.reescritas = await reescreverSequenciasComPreco(campanha, { ate });
  // Antes dos envios, para quem acabou de marcar a reunião não receber a próxima etapa.
  resultado.agendamentos = await verificarAgendamentos().catch((e) => {
    log(`⚠️  Falha ao conferir o Calendly: ${e.message}`);
    return { erro: e.message };
  });
  resultado.envio = await enviar(campanha, { ate, distribuir: Boolean(campanha.automacao?.ativo) });
  if (!campanha.automacao?.ativo) return resultado;

  const reserva = (await db.contarLeadsPorStatus("novo")) + (await db.contarLeadsPorStatus("analisado"));
  if (reserva < RESERVA_DE_EMPRESAS && !semTempo(ate)) resultado.descoberta = await descobrirProxima(campanha);
  if (!semTempo(ate)) resultado.analise = await analisar({ ate, limite: 10 });
  if (!semTempo(ate)) resultado.propostas = await propor(campanha, { ate, limite: 6 });
  return resultado;
}

/**
 * Reescreve, com a regra atual (sem preço, convite para o bate-papo), as etapas ainda
 * não enviadas de sequências antigas que citam valores. As etapas já enviadas ficam como estão.
 */
export async function reescreverSequenciasComPreco(campanha, { ate = prazoPadrao(), limite = 3 } = {}) {
  let reescritas = 0;
  for (const leadId of await db.leadsComPrecoPendente(limite)) {
    if (semTempo(ate)) break;
    const lead = await db.buscarLead(leadId);
    try {
      const s = await gerarSequencia(lead, JSON.parse(lead.oportunidades || "[]"), campanha);
      for (const m of await db.etapasPendentes(leadId)) {
        const corpo = (m.canal === "email" ? s.email : s.whatsapp)[m.etapa - 1];
        if (!corpo) continue;
        const assunto = m.canal === "email" ? (m.etapa === 1 ? s.assunto_email : m.assunto) : null;
        await db.atualizarMensagem(m.id, { corpo, assunto });
      }
      reescritas++;
      log(`✍️  Sequência de ${lead.nome} reescrita sem preço, com convite para o bate-papo`);
    } catch (e) {
      log(`⚠️  Não foi possível reescrever a sequência de ${lead.nome}: ${e.message}`);
    }
  }
  return { reescritas };
}

const CONFERIR_WEBHOOK_MS = 60 * 60 * 1000;

/** Uma vez por hora, garante que as respostas da Evolution chegam aqui (o webhook pode ter falhado ao salvar). */
async function conferirWebhookWhatsapp() {
  if ((await integracaoWhatsapp()) !== "evolution") return;
  const ultima = Number((await db.lerEstado("webhook_evolution_conferido")) ?? 0);
  if (Date.now() - ultima < CONFERIR_WEBHOOK_MS) return;
  try {
    if (await evolution.garantirWebhook()) log("🔧 Webhook da Evolution apontado de novo para o sistema");
    await db.gravarEstado("webhook_evolution_conferido", Date.now());
  } catch (e) {
    log(`⚠️  Não foi possível conferir o webhook da Evolution: ${e.message}`);
  }
}

/** Compatibilidade: o agendamento antigo chamava "envios". */
export const rodadaDeEnvios = rodadaAutomatica;

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
