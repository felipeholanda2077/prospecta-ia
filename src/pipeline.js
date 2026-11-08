import crypto from "node:crypto";
import { config } from "./config.js";
import * as db from "./db.js";
import { buscarEmpresas } from "./descoberta/googlePlaces.js";
import { buscaNoInstagram, buscarEmpresasNoInstagram, instagramDaEmpresa, perfilDoInstagram, contatosDoPerfil } from "./descoberta/instagram.js";
import { buscarEmpresasPorCnpj, contatoDoCnpj, emailDeContador } from "./descoberta/cnpj.js";
import { buscarAnunciantes, podeBuscarSozinho, completarContatos, cortar } from "./descoberta/anuncios.js";
import { buscarEmpresasContratando, FUNCOES } from "./descoberta/vagas.js";
import { buscarAnunciantesNoGoogle } from "./descoberta/googleAds.js";
import { avaliacoesDoGoogle, oportunidadeDasAvaliacoes } from "./analise/avaliacoes.js";
import { escolherAbordagem } from "./ia/abordagens.js";
import { analisarSite } from "./analise/site.js";
import { identificarOportunidades, oportunidadesParaSiteBom } from "./analise/oportunidades.js";
import { ehCelularBR, normalizarTelefoneBR, variantesWhatsappBR } from "./analise/telefone.js";
import { PAISES, cidadeEPais, dadosDoPais, ehExterior, segmentoNoIdioma, telefoneInternacional, podeSerCelular } from "./internacional.js";
import { contatosLigados } from "./respostas/contatoNovo.js";
import { gerarSequencia, escreverDirectDeProspeccao } from "./ia/proposta.js";
import { enviarEmail, explicarErroEmail, enviarNotificacao } from "./envio/email.js";
import { enviarWhatsapp, enviarTextoWhatsappOficial, oficialAtiva, numerosOficiais, ehNumeroOficial, prontoParaEmpresaNova, RODAPE_WHATSAPP } from "./envio/whatsapp.js";
import { enviarDirect } from "./envio/instagram.js";
import * as uazap from "./envio/uazap.js";
import * as evolution from "./envio/evolution.js";
import { imagemDaMensagem, legendaDaArte, roteiroDoAudio } from "./vendas/campanha.js";
import { audioDoTexto, oggDoAudio } from "./conteudo/narracao.js";
import { falarPelaRunway, lerConfigAvatar } from "./conteudo/avatar.js";
import { linkDaMidia } from "./conteudo/instagram.js";
import { verificarAgendamentos, aplicarLinkAgendamento } from "./agenda/calendly.js";
import { semSiteProprio, potencialDaEmpresa } from "./analise/prioridade.js";
import { verificarRespostasEmail } from "./respostas/email.js";
import { numerosComAgente } from "./respostas/agentes.js";
import { followupsDeInteressados } from "./respostas/followup.js";
import { encerrarRecusasAbertas } from "./respostas/processar.js";
import { rodadaDeReativacao } from "./respostas/reativacao.js";
import { salvarFotosDasEmpresas } from "./respostas/fotos.js";
import { rodadaDeRamos } from "./descoberta/ramos.js";

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
// Directs para quem nunca falou com a conta, por dia: mais que isso o Instagram costuma limitar a conta,
// mesmo enviando na mão. O painel avisa quando você chega nesse número.
export const LIMITE_DIRECT_DIA = 25;
// Entre uma empresa nova e a próxima, de 5 a 12 minutos (sorteado a cada vez), para o número
// e o e-mail não parecerem disparo em massa. Ajustável em Automação. As etapas 2 e 3 do WhatsApp
// dividem essa mesma vez: o número manda uma mensagem por vez, nunca várias em sequência.
const INTERVALO_EMPRESAS_MIN = [5, 12];
const VEZ_DO_PROXIMO_CONTATO = "vez_da_empresa_nova";

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
 * Como o WhatsApp sai: pela API oficial da Meta (quando ligada em Configurações, ela tem
 * prioridade), pela UAZap ou pela Evolution API (número conectado no painel), ou manual
 * (você envia pelo seu WhatsApp a partir do painel).
 */
export async function modoWhatsapp() {
  if (await oficialAtiva()) return "oficial";
  return (await integracaoWhatsapp()) ?? "manual";
}

// Erros de envio que indicam o número desconectado (e não um problema com a mensagem).
const QUEDA_DO_WHATSAPP = /connection closed|not connected|disconnected|desconectad|respondeu 503|respondeu 502|instance.*(not found|close)|não foi possível acessar/i;
const AVISO_DESCONECTADO_MS = 6 * 3600 * 1000;

/**
 * O áudio de uma mensagem. Fica guardado enquanto o texto e a voz forem os mesmos: quem ouve no painel
 * ouve exatamente o que vai sair, sem gastar crédito duas vezes.
 */
export async function audioDaMensagem(id, corpo) {
  const roteiro = roteiroDoAudio(corpo);
  const { vozDasMensagens } = await lerConfigAvatar();
  const prefixo = `audio-mensagem-${id}-`;
  const chave = `${prefixo}${crypto.createHash("sha256").update(`${vozDasMensagens}:${roteiro}`).digest("hex").slice(0, 12)}.ogg`;
  const guardado = await db.lerMidia(chave);
  if (guardado) return { chave, dados: Buffer.from(guardado.dados) };
  const dados = await falarPelaRunway(roteiro).then(oggDoAudio).catch((e) => {
    log(`⚠️  Voz da Runway indisponível (${e.message}); o áudio sai pelas outras vozes.`);
    return audioDoTexto(roteiro);
  });
  await db.apagarMidias(prefixo);
  await db.gravarMidia(chave, "audio/ogg", dados);
  return { chave, dados };
}

/**
 * A mensagem da campanha: a arte, com o link na legenda, e o texto em mensagem de voz.
 * Se a imagem falhar, o áudio sai mesmo assim; se o áudio falhar, a mensagem sai em texto para não se perder.
 */
async function enviarCampanhaEmAudio(integracao, destino, m, texto, imagem, opcoes) {
  const semQueda = (e, oQue) => {
    if (QUEDA_DO_WHATSAPP.test(e.message)) throw e;
    log(`⚠️  ${oQue} não foi enviado para ${m.empresa}: ${e.message}`);
  };
  await integracao.enviarImagem(destino, imagem, legendaDaArte(m.corpo), opcoes).catch((e) => semQueda(e, "A arte"));
  try {
    const { chave } = await audioDaMensagem(m.id, m.corpo);
    return await integracao.enviarAudio(destino, linkDaMidia(chave), opcoes);
  } catch (e) {
    semQueda(e, "O áudio");
    return integracao.enviarTexto(destino, texto, opcoes);
  }
}

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

// `fuso`: o da empresa de fora do Brasil (o horário comercial é o de lá); sem ele, o do sistema.
function partesNoFuso(data, fuso = config.timezone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: fuso || config.timezone, hour: "numeric", hourCycle: "h23", weekday: "short" })
      .formatToParts(data)
      .map((p) => [p.type, p.value])
  );
}

const ehFimDeSemana = (data, fuso) => ["Sat", "Sun"].includes(partesNoFuso(data, fuso).weekday);

export function dentroDoHorario(limites, agora = new Date(), fuso = config.timezone) {
  const partes = partesNoFuso(agora, fuso);
  const hora = Number(partes.hour);
  if (limites.somenteDiasUteis && ["Sat", "Sun"].includes(partes.weekday)) return false;
  return hora >= limites.horarioComercial.inicio && hora < limites.horarioComercial.fim;
}

// WhatsApp sem limite de empresas novas por dia: o ritmo do número fica com o intervalo entre uma mensagem
// e outra (5 a 12 minutos, ajustável em Automação). O e-mail continua com a meta do dia.
export const SEM_LIMITE = Infinity;

/** Quantas mensagens de prospecção podem sair hoje por este canal (no WhatsApp, sem limite). */
export async function limiteDoDia(campanha, canal) {
  if (canal === "whatsapp") return SEM_LIMITE;
  return Number(campanha.automacao?.metaDiaria?.[canal]) || campanha.limites.envioDiarioMax;
}

/**
 * Por qual número da UAZap sai esta mensagem. A conversa fica sempre no número que já fala com
 * a empresa; empresa nova vai para o número conectado que mandou menos hoje.
 * Retorna { numero } ou { motivo } (a mensagem continua na fila).
 */
export async function numeroParaEnviar(m) {
  const todos = await uazap.numeros();
  const doLead = m.numero_wa_lead !== undefined ? m.numero_wa_lead : (await db.buscarLead(m.lead_id))?.numero_wa;
  // Conversa de antes de existirem vários números: ela começou pelo principal. (Conversa nova, como a de
  // quem preencheu o formulário do site, vai para o número que mandou menos hoje.)
  const conversaAntiga = !doLead && (m.tipo === "resposta" || m.etapa > 1) && (await db.whatsappJaEnviado(m.lead_id)) ? uazap.PRINCIPAL : null;
  const dono = todos.find((n) => n.id === (doLead || conversaAntiga));
  if (dono) {
    return (await uazap.conectadoAgora(dono.id))
      ? { numero: dono }
      : { motivo: `o número "${dono.nome}" está desconectado; sai quando você reconectar em Configurações` };
  }
  // Número com agente de atendimento não manda prospecção para empresas novas.
  const comAgente = await numerosComAgente();
  const conectados = await uazap.conectados();
  const ativos = conectados.filter((n) => !comAgente.has(n.id));
  if (!conectados.length) return { motivo: "WhatsApp desconectado; sai quando você reconectar o número em Configurações" };
  if (!ativos.length) return { motivo: "os números conectados têm agente de atendimento e não mandam prospecção; conecte outro número em Configurações" };
  // Empresa nova vai para o número que mandou menos hoje, para dividir o volume entre eles.
  const enviadas = await Promise.all(ativos.map((n) => db.enviadasHoje("whatsapp", { primeiroContato: true, numero: n.id })));
  return { numero: ativos[enviadas.indexOf(Math.min(...enviadas))] };
}

/**
 * Número da API oficial para uma mensagem: a conversa continua no número em que começou; conversa antiga
 * (de antes de existirem vários números) fica no principal; empresa nova vai para o número que mandou menos hoje.
 */
export async function numeroOficialParaEnviar(m) {
  const ativos = await numerosOficiais({ ativos: true });
  if (!ativos.length) return null;
  const doLead = m.numero_wa_lead !== undefined ? m.numero_wa_lead : (await db.buscarLead(m.lead_id))?.numero_wa;
  const dono = ativos.find((n) => n.id === doLead);
  if (dono) return dono;
  if (ativos.length === 1 || m.tipo === "resposta" || m.etapa > 1) return ativos[0];
  // Empresa nova não vai para número que a Meta ainda não liberou (se nenhum estiver pronto, vale a lista toda).
  const prontos = [];
  for (const n of ativos) if (await prontoParaEmpresaNova(n.id)) prontos.push(n);
  const lista = prontos.length ? prontos : ativos;
  const enviadas = await Promise.all(lista.map((n) => db.enviadasHoje("whatsapp", { primeiroContato: true, numero: n.id })));
  return lista[enviadas.indexOf(Math.min(...enviadas))];
}

/**
 * Por onde sai uma mensagem de WhatsApp quando a API oficial e a UAZap (ou a Evolution) estão ligadas juntas.
 * Cada empresa fica sempre no número que já fala com ela, seja da API oficial ou da UAZap; empresa nova vai para
 * o número, de qualquer uma das duas, que mandou menos primeiros contatos hoje. Com só uma delas ligada, vale ela.
 * Retorna { modo, numeroId } ou { motivo } (a mensagem continua na fila).
 */
export async function canalDoWhatsapp(m) {
  // Empresa nova que já ganhou a vez de um número (no envio, cada número tem a sua) sai por ele.
  if (m.numeroDaVez && !(m.numero_wa_lead !== undefined ? m.numero_wa_lead : (await db.buscarLead(m.lead_id))?.numero_wa)) return m.numeroDaVez;
  const [oficial, web] = await Promise.all([oficialAtiva(), integracaoWhatsapp()]);
  const pelaWeb = async () => {
    if (web !== "uazap") return { modo: web, numeroId: null };
    const escolha = await numeroParaEnviar(m);
    return escolha.numero ? { modo: "uazap", numeroId: escolha.numero.id } : { motivo: escolha.motivo };
  };
  const pelaOficial = async () => ({ modo: "oficial", numeroId: (await numeroOficialParaEnviar(m))?.id ?? null });
  if (!oficial) return web ? pelaWeb() : { modo: "manual", numeroId: null };
  // Empresa de fora do Brasil não começa pela API oficial: o primeiro contato lá é o modelo aprovado, em português.
  const doLeadAntes = m.numero_wa_lead !== undefined ? m.numero_wa_lead : (await db.buscarLead(m.lead_id))?.numero_wa;
  if (m.pais && m.pais !== "BR" && !ehNumeroOficial(doLeadAntes)) {
    return web ? pelaWeb() : { motivo: "empresa de fora do Brasil: a API oficial só começa a conversa com o modelo aprovado, em português; conecte um número pela UAZap" };
  }
  if (!web) return pelaOficial();

  const doLead = m.numero_wa_lead !== undefined ? m.numero_wa_lead : (await db.buscarLead(m.lead_id))?.numero_wa;
  const oficiais = await numerosOficiais({ ativos: true });
  if (ehNumeroOficial(doLead)) {
    const dono = oficiais.find((n) => n.id === doLead);
    if (dono) return { modo: "oficial", numeroId: dono.id };
  } else if (doLead && web === "uazap" && (await uazap.numeros()).some((n) => n.id === doLead)) {
    return pelaWeb();
  }
  // Conversa que já existia antes (resposta ou etapa 2 e 3 sem número guardado) continua pela UAZap, como começou.
  if (!doLead && (m.tipo === "resposta" || m.etapa > 1) && (await db.whatsappJaEnviado(m.lead_id))) return pelaWeb();
  if (web !== "uazap") return pelaOficial();

  // Empresa nova: entre todos os números ligados das duas, o que mandou menos primeiros contatos hoje.
  // Número oficial que a Meta ainda não liberou (ex.: de outra BM sem pagamento) não recebe empresa nova.
  const comAgente = await numerosComAgente();
  const oficiaisProntos = [];
  for (const n of oficiais) if (!comAgente.has(n.id) && (await prontoParaEmpresaNova(n.id))) oficiaisProntos.push(n);
  const candidatos = [
    ...oficiaisProntos.map((n) => ({ modo: "oficial", numeroId: n.id })),
    ...(await uazap.conectados()).filter((n) => !comAgente.has(n.id)).map((n) => ({ modo: "uazap", numeroId: n.id })),
  ];
  if (!candidatos.length) return pelaOficial();
  const enviadas = await Promise.all(candidatos.map((c) => db.enviadasHoje("whatsapp", { primeiroContato: true, numero: c.numeroId })));
  return candidatos[enviadas.indexOf(Math.min(...enviadas))];
}

/** Minutos que faltam para o fim do horário comercial de hoje (negativo depois dele). */
export function minutosAteOFim(limites, agora = new Date(), fuso = config.timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: fuso || config.timezone, hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(agora)
      .map((x) => [x.type, x.value])
  );
  return limites.horarioComercial.fim * 60 - (Number(p.hour) * 60 + Number(p.minute));
}

/** Início do horário comercial do próximo dia útil (com alguns minutos de folga, como uma pessoa; sem `folga`, na hora certa). */
export function inicioDoProximoDiaUtil(limites, agora = new Date(), { folga = true, fuso = config.timezone } = {}) {
  const minutosAgora = limites.horarioComercial.fim * 60 - minutosAteOFim(limites, agora, fuso);
  const inicio = limites.horarioComercial.inicio * 60;
  // Antes do expediente, o "próximo início" ainda é hoje.
  const minutos = (minutosAgora < inicio ? 0 : 24 * 60) - minutosAgora + inicio + (folga ? Math.floor(Math.random() * 30) : 0);
  const d = new Date(Math.floor(agora.getTime() / 60_000) * 60_000 + minutos * 60_000);
  while (limites.somenteDiasUteis !== false && ehFimDeSemana(d, fuso)) d.setTime(d.getTime() + 24 * 3600 * 1000);
  return d;
}

/**
 * Quando sai a próxima etapa depois de enviar `etapaEnviada`. No WhatsApp, no mesmo dia,
 * encaixada até o fim do expediente (se não couber, no começo do próximo dia útil).
 * No e-mail, 1 a 2 dias úteis depois, no mesmo horário, para não lotar a caixa da empresa.
 */
export function horarioDaProximaEtapa(etapaEnviada, campanha, agora = new Date(), canal = "whatsapp", fuso = config.timezone) {
  const { limites } = campanha;
  if (canal === "email") {
    const dias = campanha.cadencia?.diasEntreEmails ?? DIAS_ENTRE_EMAILS;
    return somarDiasUteis(agora, dias[etapaEnviada - 1] ?? 2, fuso);
  }
  const horas = campanha.cadencia?.horasEntreEtapas ?? HORAS_ENTRE_ETAPAS;
  const ideal = (horas[etapaEnviada - 1] ?? 2) * 60 * (0.85 + Math.random() * 0.15);
  const faltam = 3 - etapaEnviada;
  const cabe = (minutosAteOFim(limites, agora, fuso) - MARGEM_FIM_MIN) / faltam;
  const intervalo = Math.min(ideal, cabe);
  if (dentroDoHorario(limites, agora, fuso) && intervalo >= INTERVALO_MINIMO_MIN) return new Date(agora.getTime() + intervalo * 60_000);
  return inicioDoProximoDiaUtil(limites, agora, { fuso });
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
export const daTempoDeSequenciaHoje = (limites, agora = new Date(), fuso = config.timezone) => minutosAteOFim(limites, agora, fuso) >= TEMPO_PARA_SEQUENCIA_MIN;

/** Soma dias úteis (segunda a sexta) mantendo o horário. */
export function somarDiasUteis(data, dias, fuso = config.timezone) {
  const resultado = new Date(data);
  let faltam = dias;
  while (faltam > 0) {
    resultado.setTime(resultado.getTime() + 24 * 3600 * 1000);
    if (!ehFimDeSemana(resultado, fuso)) faltam--;
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
        const r = await buscarEInserir({ nicho, cidade }, campanha, campanha.limites.maxEmpresasPorBusca);
        novas += r.novas;
        log(`🔎 "${r.consulta}": ${r.encontradas} encontradas`);
      } catch (e) {
        log(`⚠️  Falha na busca "${consulta}": ${e.message}`);
      }
    }
  }
  log(`🔎 Descoberta concluída: ${novas} empresas novas`);
  return { novas };
}

/** Todas as combinações segmento × cidade da campanha, na ordem da rotação. */
/**
 * Busca no Google Maps e salva as empresas novas. Cidade com país no fim ("Lisboa, Portugal", "Miami, EUA")
 * procura naquele país, com o segmento no idioma de lá, e a empresa fica marcada com país, idioma e fuso.
 */
export async function buscarEInserir({ nicho, cidade }, campanha, maximo = 60, { ordenar = false } = {}) {
  const { cidade: local, pais } = cidadeEPais(cidade);
  const { consulta, opcoes } = await consultaDoMaps(nicho, local, pais);
  let empresas = await buscarEmpresas(consulta, maximo, opcoes);
  if (ordenar) empresas = ordenarPorPrioridade(empresas);
  let novas = 0;
  for (const e of empresas) {
    const exterior = dadosDoPais(pais, campanha.automacao?.idiomaExterior, { endereco: e.endereco, cidade: local });
    if (await db.inserirLead({ ...e, nicho, cidade, ...exterior })) novas++;
  }
  return { novas, encontradas: empresas.length, consulta, pais };
}

export function combinacoesDeBusca(campanha) {
  const fixas = campanha.buscas.flatMap(({ nicho, cidades }) => cidades.map((cidade) => ({ nicho, cidade })));
  // Os ramos que a IA está testando entram nas mesmas cidades (sem repetir um ramo que já é fixo).
  const jaTem = new Set(campanha.buscas.map((b) => b.nicho.trim().toLowerCase()));
  const cidades = [...new Set(campanha.buscas.flatMap((b) => b.cidades))];
  const extras = (campanha.ramosExtras ?? []).filter((n) => !jaTem.has(n.trim().toLowerCase()))
    .flatMap((nicho) => cidades.map((cidade) => ({ nicho, cidade })));
  return [...fixas, ...extras];
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
      novas += (await buscarEInserir({ nicho, cidade }, campanha, 60, { ordenar: true })).novas;
      feitas.push(`${nicho} em ${cidade}`);
      log(`🔎 Busca automática "${nicho} em ${cidade}": ${novas} novas`);
    } catch (e) {
      log(`⚠️  Falha na busca automática "${nicho} em ${cidade}": ${e.message}`);
      break;
    }
  }
  await db.gravarEstado("busca_rotacao", indice % combinacoes.length);
  // Instagram, CNPJ, anúncios, vagas, contadores e Google Ads só no Brasil: fora, a busca é no Google Maps.
  const base = combinacoes[inicio % combinacoes.length];
  const noBrasil = cidadeEPais(base.cidade).pais === "BR";
  const soNoBrasil = (fazer) => (noBrasil ? fazer(campanha, base) : null);
  const instagram = await soNoBrasil(descobrirNoInstagram);
  const cnpj = await soNoBrasil(descobrirPorCnpj);
  const anuncios = await soNoBrasil(descobrirNosAnuncios);
  const vagas = await soNoBrasil(descobrirNasVagas);
  const contadores = await soNoBrasil(descobrirContadores);
  const googleAds = await soNoBrasil(descobrirNoGoogleAds);
  return {
    novas: novas + (instagram?.novas ?? 0) + (cnpj?.novas ?? 0) + (anuncios?.novas ?? 0) + (vagas?.novas ?? 0) + (contadores?.novas ?? 0) + (googleAds?.novas ?? 0),
    buscas: feitas, ...(googleAds ? { googleAds } : {}),
    ...(instagram ? { instagram } : {}), ...(cnpj ? { cnpj } : {}), ...(anuncios ? { anuncios } : {}), ...(vagas ? { vagas } : {}),
    ...(contadores ? { contadores } : {}),
  };
}

// ---------- Quem paga anúncio no Google ----------

/** Com a SerpApi conectada, a busca automática também pega quem paga anúncio no Google para o segmento na cidade. */
export async function descobrirNoGoogleAds(campanha, { nicho, cidade }, { agora = new Date() } = {}) {
  if (campanha.automacao?.buscarNoGoogleAds === false) return null;
  if (!(await podeBuscarSozinho(agora, "googleads"))) return null;
  try {
    const r = await buscarNoGoogleAds(nicho, cidade, { agora });
    const novas = (await capturarDoGoogleAds(r.empresas.filter((e) => !e.jaCapturado), nicho, cidade)).novas;
    log(`🔝 Busca automática nos anúncios do Google "${nicho} em ${cidade}": ${novas} novas`);
    return { novas };
  } catch (e) {
    log(`⚠️  Falha na busca nos anúncios do Google "${nicho} em ${cidade}": ${e.message}`);
    return { novas: 0, erro: e.message };
  }
}

/** Quem paga anúncio no Google para o segmento na cidade, sem salvar (o contato sai do site, na análise). */
export async function buscarNoGoogleAds(nicho, cidade, { agora = new Date() } = {}) {
  const r = await buscarAnunciantesNoGoogle({ nicho, cidade, agora });
  const capturados = await db.placeIdsCapturados(r.empresas.map((e) => `gads:${e.dominio}`));
  const doSite = await db.sitesCapturados(r.empresas.map((e) => e.dominio));
  log(`🔝 Busca nos anúncios do Google "${nicho} em ${cidade}": ${r.empresas.length} anunciantes`);
  return {
    ...r,
    empresas: r.empresas.map((e) => ({ ...e, jaCapturado: capturados.has(`gads:${e.dominio}`) || doSite.has(e.dominio), celular: ehCelularBR(e.telefone), semSite: false })),
  };
}

/** Salva os anunciantes do Google como leads, com o anúncio (o e-mail e o WhatsApp saem da análise do site). */
export async function capturarDoGoogleAds(empresas, nicho, cidade) {
  let novas = 0;
  const doSite = await db.sitesCapturados(empresas.map((e) => e?.dominio).filter(Boolean));
  for (const e of empresas) {
    const dominio = String(e?.dominio ?? "").toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dominio) || !e?.nome || !e?.site || doSite.has(dominio)) continue;
    const a = e.anuncio ?? {};
    const lead = {
      place_id: `gads:${dominio}`, nome: String(e.nome).slice(0, 120), endereco: null,
      telefone: e.telefone ? String(e.telefone).replace(/\D/g, "").slice(0, 15) : null, site: String(e.site).slice(0, 500),
      maps_url: null, avaliacao: null, total_avaliacoes: null, nicho, cidade, origem: "google_ads",
      anuncio: { plataforma: "google", consulta: cortar(a.consulta, 120), texto: cortar(a.texto, 400), link: a.link ? String(a.link).slice(0, 500) : null, topo: Boolean(a.topo) },
    };
    if (await db.inserirLead(lead)) novas++;
  }
  if (novas) log(`🔝 ${novas} empresas capturadas dos anúncios do Google`);
  return { novas };
}

// ---------- Contadores: parceria de indicação ----------

export const NICHO_CONTADOR = "escritório de contabilidade";

/**
 * Uma vez por dia, a busca automática também pega escritórios de contabilidade da cidade da rodada: eles atendem
 * empresas que estão abrindo e precisam de site e sistema. A abordagem com eles é de parceria (indicação), não de venda.
 */
export async function descobrirContadores(campanha, { cidade }, { agora = new Date() } = {}) {
  if (campanha.automacao?.buscarContadores === false) return null;
  const hoje = new Date(agora).toLocaleDateString("en-CA", { timeZone: config.timezone });
  if ((await db.lerEstado("contadores_ultimo_dia")) === hoje) return null;
  await db.gravarEstado("contadores_ultimo_dia", hoje);
  try {
    const empresas = await buscarEmpresas(`${NICHO_CONTADOR} em ${cidade}`, 20);
    const novas = (await capturarContadores(empresas, cidade)).novas;
    log(`🤝 Busca automática de contadores em ${cidade}: ${novas} novos para parceria`);
    return { novas };
  } catch (e) {
    log(`⚠️  Falha na busca de contadores em ${cidade}: ${e.message}`);
    return { novas: 0, erro: e.message };
  }
}

/** Escritórios de contabilidade da cidade no Google Maps, sem salvar. */
export async function buscarContadores(cidade, quantidade = 20) {
  const empresas = await buscarEmpresas(`${NICHO_CONTADOR} em ${cidade}`, Math.min(Number(quantidade) || 20, 60));
  const capturados = await db.placeIdsCapturados(empresas.map((e) => e.place_id));
  log(`🤝 Busca de contadores em ${cidade}: ${empresas.length} escritórios`);
  return { empresas: empresas.map((e) => ({ ...e, jaCapturado: capturados.has(e.place_id), celular: ehCelularBR(e.telefone), semSite: semSiteProprio(e.site), contador: true })) };
}

/** Salva os escritórios de contabilidade como leads de parceria (origem "contador"). */
export async function capturarContadores(empresas, cidade) {
  let novas = 0;
  for (const e of empresas) {
    if (!e?.place_id || !e?.nome) continue;
    const lead = {
      place_id: String(e.place_id), nome: String(e.nome).slice(0, 120), endereco: e.endereco ?? null, telefone: e.telefone ?? null,
      site: e.site ?? null, maps_url: e.maps_url ?? null, avaliacao: e.avaliacao ?? null, total_avaliacoes: e.total_avaliacoes ?? null,
      nicho: NICHO_CONTADOR, cidade, origem: "contador",
    };
    if (await db.inserirLead(lead)) novas++;
  }
  if (novas) log(`🤝 ${novas} escritórios de contabilidade capturados para parceria`);
  return { novas };
}

/**
 * Com a SerpApi conectada, a busca automática também procura empresas contratando, na cidade da rodada, para uma
 * função que a FluxDeck resolve (uma função por rodada, em rodízio). Gasta no máximo 1 busca, dentro da cota das vagas.
 */
export async function descobrirNasVagas(campanha, { cidade }, { agora = new Date() } = {}) {
  if (campanha.automacao?.buscarEmVagas === false) return null;
  if (!(await podeBuscarSozinho(agora, "vagas"))) return null;
  const vez = Number(await db.lerEstado("vagas_rotacao")) || 0;
  await db.gravarEstado("vagas_rotacao", (vez + 1) % FUNCOES.length);
  try {
    const r = await buscarNasVagas(cidade, { funcao: vez % FUNCOES.length, agora });
    const novas = (await capturarDasVagas(r.empresas.filter((e) => !e.jaCapturado && e.naCidade), "", cidade)).novas;
    log(`💼 Busca automática nas vagas "${FUNCOES[vez % FUNCOES.length].cargo} em ${cidade}": ${novas} novas${r.avisos.length ? ` · ${r.avisos.join(" · ")}` : ""}`);
    return { novas };
  } catch (e) {
    log(`⚠️  Falha na busca automática nas vagas em ${cidade}: ${e.message}`);
    return { novas: 0, erro: e.message };
  }
}

/** Empresas contratando numa cidade, com o contato do Google Maps (sem ele, não dá para chamar). Não salva. */
export async function buscarNasVagas(cidade, { funcao = 0, agora = new Date() } = {}) {
  const r = await buscarEmpresasContratando({ cidade, funcoes: [Number(funcao) || 0], maxBuscas: 1, agora });
  await completarContatos(r.empresas, cidade, { maps: (consulta) => buscarEmpresas(consulta, 3), maximo: 20 });
  const capturados = await db.placeIdsCapturados(r.empresas.map((e) => e.mapsPlaceId).filter(Boolean));
  log(`💼 Busca nas vagas "${FUNCOES[Number(funcao) || 0]?.cargo} em ${cidade}": ${r.empresas.length} empresas contratando`);
  return {
    ...r,
    empresas: r.empresas.map((e) => ({
      ...e, jaCapturado: capturados.has(e.mapsPlaceId), celular: ehCelularBR(e.telefone),
      semSite: !e.site, semContato: !e.mapsPlaceId || (!e.telefone && !e.site),
    })),
  };
}

/** Salva como leads as empresas contratando (com o contato do Google Maps), com a vaga delas. */
export async function capturarDasVagas(empresas, nicho, cidade) {
  let novas = 0;
  for (const e of empresas) {
    // Sem a empresa no Google Maps não há contato confiável; e o place_id do Maps evita repetir quem já veio por lá.
    if (!e?.mapsPlaceId || !e?.nome || (!e.telefone && !e.site)) continue;
    const v = e.vaga ?? {};
    const lead = {
      place_id: String(e.mapsPlaceId),
      nome: String(e.nome).slice(0, 120),
      endereco: e.endereco ?? null,
      telefone: e.telefone ? String(e.telefone).replace(/\D/g, "").slice(0, 15) : null,
      site: e.site ? String(e.site).slice(0, 500) : null,
      maps_url: e.maps_url ?? null,
      avaliacao: e.avaliacao ?? null,
      total_avaliacoes: e.total_avaliacoes ?? null,
      nicho: String(nicho ?? "").trim() || null,
      cidade,
      origem: "vaga",
      vaga: {
        cargo: cortar(v.cargo, 120), funcao: v.funcao ?? null, servico: v.servico ?? null, dor: v.dor ?? null,
        publicada: v.publicada ?? null, onde: v.onde ?? null, link: v.link ? String(v.link).slice(0, 500) : null,
      },
    };
    if (await db.inserirLead(lead)) novas++;
  }
  if (novas) log(`💼 ${novas} empresas capturadas pelas vagas abertas`);
  return { novas };
}

/**
 * Com a SerpApi conectada, a busca automática também procura quem está anunciando no Instagram e no Facebook
 * no mesmo segmento e cidade. Gasta no máximo 1 busca por rodada e o limite do mês aos poucos.
 */
export async function descobrirNosAnuncios(campanha, { nicho, cidade }, { agora = new Date() } = {}) {
  if (campanha.automacao?.buscarEmAnuncios === false) return null;
  if (!(await podeBuscarSozinho(agora))) return null;
  try {
    const { empresas, avisos } = await buscarAnunciantes({ nicho, cidade, quantidade: 30, maxBuscas: 1, agora });
    await completarContatosDosAnunciantes(empresas, cidade);
    const novas = (await capturarDosAnuncios(empresas, nicho, cidade)).novas;
    log(`📣 Busca automática nos anúncios da Meta "${nicho} em ${cidade}": ${novas} novas${avisos.length ? ` · ${avisos.join(" · ")}` : ""}`);
    return { novas };
  } catch (e) {
    log(`⚠️  Falha na busca automática nos anúncios "${nicho} em ${cidade}": ${e.message}`);
    return { novas: 0, erro: e.message };
  }
}

/** O contato de quem anuncia só com "Enviar mensagem no WhatsApp": pelo Instagram conectado e pelo Google Maps. */
async function completarContatosDosAnunciantes(empresas, cidade) {
  const { conexao } = await buscaNoInstagram();
  await completarContatos(empresas, cidade, {
    instagram: conexao ? async (usuario) => {
      const p = await perfilDoInstagram(conexao, usuario);
      return p && { ...p, contatos: contatosDoPerfil(p.bio, p.site) };
    } : null,
    maps: (consulta) => buscarEmpresas(consulta, 3),
  });
}

/** Busca nos anúncios da Meta pelo painel, sem salvar: mostra os anunciantes para você escolher quem capturar. */
export async function buscarNosAnuncios(nicho, cidade, { quantidade = 20 } = {}) {
  const r = await buscarAnunciantes({ nicho, cidade, quantidade: Math.min(Number(quantidade) || 20, 60), maxBuscas: Number(quantidade) > 30 ? 2 : 1 });
  await completarContatosDosAnunciantes(r.empresas, cidade);
  // A mesma empresa já capturada pelo Google Maps (achada pelo nome) conta como capturada.
  const capturados = await db.placeIdsCapturados(r.empresas.flatMap((e) => [`ad:${e.page_id}`, e.mapsPlaceId].filter(Boolean)));
  log(`📣 Busca no painel nos anúncios "${nicho} em ${cidade}": ${r.empresas.length} anunciantes (${r.buscas} ${r.buscas === 1 ? "busca" : "buscas"})`);
  return {
    ...r,
    empresas: r.empresas.map((e) => ({
      ...e, jaCapturado: capturados.has(`ad:${e.page_id}`) || capturados.has(e.mapsPlaceId), celular: ehCelularBR(e.telefone),
      semSite: !e.site, semContato: !e.site && !e.telefone && !e.instagram,
    })),
  };
}

/** Salva como leads os anunciantes escolhidos (ou achados pela busca automática), com o anúncio deles. */
export async function capturarDosAnuncios(empresas, nicho, cidade) {
  let novas = 0;
  const peloMaps = await db.placeIdsCapturados(empresas.map((e) => e?.mapsPlaceId).filter(Boolean));
  for (const e of empresas) {
    if (e?.mapsPlaceId && peloMaps.has(e.mapsPlaceId)) continue; // já está no funil pelo Google Maps
    const pagina = String(e?.page_id ?? "").replace(/\D/g, "");
    if (!pagina || !e?.nome || (!e.site && !e.telefone && !e.instagram)) continue;
    const instagram = /^[a-z0-9._]{2,30}$/.test(String(e.instagram ?? "")) ? e.instagram : null;
    const a = e.anuncio ?? {};
    const lead = {
      place_id: `ad:${pagina}`,
      nome: String(e.nome).slice(0, 120),
      endereco: e.endereco ?? null,
      telefone: e.telefone ? String(e.telefone).replace(/\D/g, "").slice(0, 15) : null,
      email: e.email ? String(e.email).slice(0, 200) : null,
      site: e.site ? String(e.site).slice(0, 500) : instagram ? `https://www.instagram.com/${instagram}/` : null,
      maps_url: e.maps_url ?? null,
      avaliacao: e.avaliacao ?? null,
      total_avaliacoes: e.total_avaliacoes ?? null,
      instagram,
      nicho,
      cidade,
      origem: "anuncio",
      anuncio: {
        texto: cortar(a.texto, 400), desde: a.desde ?? null, link: a.link ? String(a.link).slice(0, 500) : null,
        chamada: a.chamada ?? null, plataformas: Array.isArray(a.plataformas) ? a.plataformas.slice(0, 6) : [], biblioteca: a.biblioteca ?? null,
      },
    };
    if (await db.inserirLead(lead)) novas++;
  }
  if (novas) log(`📣 ${novas} empresas capturadas dos anúncios da Meta`);
  return { novas };
}

/** A busca pelo CNPJ com o que o sistema já sabe: os CNPJs já capturados e os telefones de contador. */
const buscarPorCnpj = async (opcoes) => buscarEmpresasPorCnpj({
  ...opcoes,
  jaCapturados: await db.cnpjsCapturados(opcoes.cidade),
  telefoneUsado: db.telefoneDeOutroCnpj,
});

/**
 * A busca automática também procura pelo CNPJ (dados abertos da Receita Federal) o mesmo
 * segmento e cidade: empresas ativas, sem MEI, com telefone, que ainda não foram capturadas.
 */
export async function descobrirPorCnpj(campanha, { nicho, cidade }, { quantidade = 10 } = {}) {
  if (campanha.automacao?.buscarPorCnpj === false) return null;
  try {
    const { empresas, cnaes } = await buscarPorCnpj({ nicho, cidade, quantidade });
    const novas = (await capturarDoCnpj(empresas.filter((e) => !e.semContato), nicho, cidade)).novas;
    log(`🏢 Busca automática pelo CNPJ "${nicho} em ${cidade}" (CNAE ${cnaes.map((c) => c.codigo).join(", ")}): ${novas} novas`);
    return { novas, cnaes };
  } catch (e) {
    log(`⚠️  Falha na busca automática pelo CNPJ "${nicho} em ${cidade}": ${e.message}`);
    return { novas: 0, erro: e.message };
  }
}

/** Busca pelo CNPJ no painel, sem salvar: mostra as empresas para você escolher quem capturar. */
export async function buscarNoCnpj(nicho, cidade, { quantidade = 20, cnae = "", incluirMei = false, abertasHaDias = null } = {}) {
  const r = await buscarPorCnpj({ nicho, cidade, quantidade: Math.min(Number(quantidade) || 20, 60), cnae, incluirMei, abertasHaDias: Number(abertasHaDias) || null });
  log(`🏢 Busca no painel pelo CNPJ "${nicho} em ${cidade}": ${r.empresas.length} empresas (de ${r.total})`);
  return {
    ...r,
    empresas: r.empresas.map((e) => ({ ...e, site: null, semSite: true, celular: ehCelularBR(e.telefone) }))
      .sort((a, b) => Number(a.semContato) - Number(b.semContato) || Number(b.celular) - Number(a.celular)),
  };
}

/** Salva como leads as empresas achadas pelo CNPJ (as sem contato ainda têm o contato buscado na análise). */
export async function capturarDoCnpj(empresas, nicho, cidade) {
  let novas = 0;
  for (const e of empresas) {
    const cnpj = String(e?.cnpj ?? "").replace(/\D/g, "");
    if (cnpj.length !== 14 || !e?.nome) continue;
    const lead = {
      place_id: `cnpj:${cnpj}`,
      nome: String(e.nome).slice(0, 120),
      endereco: e.endereco ?? null,
      telefone: e.telefone ?? null,
      email: e.email ?? null,
      site: null,
      maps_url: null,
      avaliacao: null,
      total_avaliacoes: null,
      nicho,
      cidade,
      origem: "cnpj",
      responsavel: e.socio ? String(e.socio).slice(0, 80) : null,
    };
    if (await db.inserirLead(lead)) novas++;
  }
  if (novas) log(`🏢 ${novas} empresas capturadas pelo CNPJ`);
  return { novas };
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
export async function buscarNoMaps(nicho, cidade, quantidade = 20, { pais = "BR", idioma = "local" } = {}) {
  const { consulta, opcoes } = await consultaDoMaps(nicho, cidade, pais);
  const empresas = await buscarEmpresas(consulta, Math.min(Number(quantidade) || 20, 60), opcoes);
  const capturados = await db.placeIdsCapturados(empresas.map((e) => e.place_id));
  log(`🔎 Busca no painel "${consulta}"${pais !== "BR" ? ` (${pais})` : ""}: ${empresas.length} empresas`);
  return ordenarPorPrioridade(
    empresas.map((e) => ({
      ...e,
      jaCapturado: capturados.has(e.place_id),
      celular: pais === "BR" ? ehCelularBR(e.telefone) : podeSerCelular(e.telefone, pais),
      semSite: semSiteProprio(e.site),
      ...(pais !== "BR" ? { ...dadosDoPais(pais, idioma, { endereco: e.endereco, cidade }), consulta } : {}),
    }))
  );
}

/**
 * O texto da busca no Google Maps. No Brasil, "dentista em Osasco"; fora, o segmento no idioma de lá
 * ("Zahnarzt Berlin"), procurando só naquele país.
 */
export async function consultaDoMaps(nicho, cidade, pais = "BR") {
  if (!pais || pais === "BR" || !PAISES[pais]) return { consulta: `${nicho} em ${cidade}`, opcoes: {} };
  const idiomaLocal = PAISES[pais].idioma;
  const segmento = await segmentoNoIdioma(nicho, idiomaLocal);
  return { consulta: `${segmento} ${cidade}`, opcoes: { pais, idioma: idiomaLocal.split("-")[0] } };
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
export async function capturarDoMaps(empresas, nicho, cidade, { pais = "BR", idioma = "local" } = {}) {
  let novas = 0;
  for (const e of empresas) {
    if (!e?.place_id || !e?.nome) continue;
    const exterior = pais && pais !== "BR" && PAISES[pais] ? dadosDoPais(pais, idioma, { endereco: e.endereco, cidade }) : {};
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
      ...exterior,
    };
    if (await db.inserirLead(lead)) novas++;
  }
  log(`📍 ${novas} empresas capturadas do Google Maps${pais && pais !== "BR" ? ` (${pais})` : ""}`);
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
  const exterior = ehExterior(lead);
  const telefone = exterior ? telefoneInternacional(lead.telefone, lead.pais) : normalizarTelefoneBR(lead.telefone);
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
  const celular = exterior ? podeSerCelular(`+${telefone}`, lead.pais) : ehCelularBR(telefone);
  return { whatsapp: telefone, whatsapp_status: celular ? "celular" : "fixo" };
}

const WEBMAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|uol|bol|terra|ig|globo|globomail|zipmail|r7|aol|protonmail|proton)\.(com|com\.br|me)(\.br)?$/i;

/** Etapa 2: visita o site de cada empresa nova, encontra contatos e oportunidades. */
export async function analisar({ ate = prazoPadrao(), limite = 1000 } = {}) {
  const leads = await db.leadsPorStatus("novo", limite);
  let analisados = 0;
  let descartados = 0;
  const descartes = [];

  for (const lead of leads) {
    if (semTempo(ate)) break;
    // Empresa do CNPJ sem contato: a consulta de reserva (que tem os CNPJs mais novos) só aceita
    // uma por vez a cada poucos segundos; sem a vez, a empresa espera a próxima análise.
    if (lead.origem === "cnpj" && !lead.telefone && !lead.email) {
      const dados = await contatoDoCnpj(lead.place_id.slice(5));
      if (dados?.incompleto) continue;
      const email = dados?.email && !emailDeContador(dados.email) ? dados.email : null;
      const telefone = dados?.telefones?.[0] ?? null;
      const doContador = telefone && (await db.telefoneDeOutroCnpj(telefone, lead.place_id));
      Object.assign(lead, { email, telefone: doContador ? null : telefone, endereco: lead.endereco ?? dados?.endereco ?? null,
        responsavel: lead.responsavel ?? dados?.socio ?? null });
      await db.atualizarLead(lead.id, { email: lead.email, telefone: lead.telefone, endereco: lead.endereco, responsavel: lead.responsavel });
    }
    // Do CNPJ não vem o site; um e-mail de domínio próprio (não Gmail, Hotmail...) costuma ser o do site.
    if (lead.origem === "cnpj" && !lead.site && lead.email) {
      const dominio = lead.email.split("@")[1];
      if (dominio && !WEBMAIL.test(dominio)) {
        const doEmail = await analisarSite(`https://${dominio}`);
        if (doEmail.temSite) await db.atualizarLead(lead.id, { site: (lead.site = `https://${dominio}`) });
      }
    }
    let analise = await analisarSite(lead.site);
    // O perfil do Instagram (o do Google, o do site ou o capturado por lá): bio com WhatsApp e
    // e-mail, e o site de verdade quando o Google só tem o link do Instagram.
    const insta = await instagramDaEmpresa(lead, analise).catch(() => null);
    if (insta && !analise.temSite && insta.site && !semSiteProprio(insta.site)) analise = await analisarSite(insta.site);
    if (insta) {
      analise.instagram = { usuario: insta.usuario, seguidores: insta.seguidores, posts: insta.posts, ultimoPost: insta.ultimoPost };
      analise.whatsapp ??= insta.contatos.whatsapp;
    }
    // Avaliações recentes do Google sem resposta da empresa (pela SerpApi, dentro da cota do mês).
    // (Fora do Brasil, não: a leitura das reclamações é feita em português.)
    const avaliacoes = ehExterior(lead) ? null : await avaliacoesDoGoogle(lead).catch((e) => { log(`⚠️  Avaliações de ${lead.nome}: ${e.message}`); return null; });
    if (avaliacoes) analise.avaliacoes = avaliacoes;
    let oportunidades = identificarOportunidades(analise, lead.nicho);
    // Empresa com site bom não é descartada: a abordagem muda para automação e sistema.
    if (!oportunidades.length) oportunidades = oportunidadesParaSiteBom(lead.nicho);
    const pelasAvaliacoes = oportunidadeDasAvaliacoes(analise.avaliacoes);
    if (pelasAvaliacoes) oportunidades = [...oportunidades, pelasAvaliacoes].sort((a, b) => (b.peso ?? 0) - (a.peso ?? 0));
    // Achada por uma vaga aberta: a função que ela quer contratar é a oportunidade principal.
    const vaga = (() => { try { return JSON.parse(lead.vaga ?? "null"); } catch { return null; } })();
    if (vaga?.servico) {
      oportunidades = [{ servico: vaga.servico, motivo: `a empresa está contratando "${vaga.cargo}" (quer ${vaga.dor}); dá para resolver isso com tecnologia, sem depender só de contratar`, peso: 20 },
        ...oportunidades.filter((o) => o.servico !== vaga.servico)];
    }
    const email = analise.emails?.[0] ?? insta?.contatos.email ?? lead.email ?? null;
    const telefone = lead.telefone ?? insta?.contatos.telefone ?? null;
    const { whatsapp, whatsapp_status } = await descobrirWhatsapp({ ...lead, telefone }, analise);

    let status = "analisado";
    let observacao = null;
    const instagram = insta?.usuario ?? lead.instagram ?? null;
    // Só o Instagram como contato: a IA escreve o direct e você envia pelo Instagram.
    if (!email && !whatsapp && instagram) observacao = "sem WhatsApp e e-mail: o contato é pelo direct do Instagram";
    else if (!email && !whatsapp) {
      observacao = whatsapp_status === "sem_whatsapp"
        ? "sem e-mail no site e o telefone não tem WhatsApp"
        : lead.origem === "instagram" ? "sem e-mail nem WhatsApp na bio do Instagram"
          : ["anuncio", "google_ads"].includes(lead.origem) ? "o anúncio não leva a site, WhatsApp ou Instagram com contato"
            : "sem e-mail no site e sem telefone no Google";
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
  if (["contatado", "respondeu", "descadastrado", "fechado"].includes(lead.status)) {
    throw new Error("Esta empresa já está em contato; não dá para reanalisar");
  }
  await db.atualizarLead(lead.id, { status: "novo", observacao: null });
}

/**
 * Etapa 3: a IA escreve a sequência gradual (3 etapas por canal) de cada empresa analisada.
 * Tudo fica como rascunho, aguardando sua aprovação no painel.
 */
export async function propor(campanha, { ate = prazoPadrao(), limite = campanha.limites.maxPropostasPorCiclo } = {}) {
  // Uma vez só: as empresas descartadas antes por terem só o Instagram voltam, agora pelo direct.
  if (!(await db.lerEstado("leads_recuperados_para_direct"))) {
    const voltaram = await db.recuperarLeadsParaDirect();
    await db.gravarEstado("leads_recuperados_para_direct", new Date().toISOString());
    if (voltaram) log(`📸 ${voltaram} empresas que só tinham o Instagram voltaram para a fila, agora pelo direct`);
  }
  const leads = await db.leadsPorStatus("analisado", limite);
  let directsNaFila = await db.directsPendentes();
  // No modo automático as sequências já nascem aprovadas; senão esperam você no painel.
  const statusInicial = campanha.automacao?.ativo ? "aprovada" : "rascunho";
  let geradas = 0;
  let ultimoErro = null;
  const prontas = [];
  // Teste A/B da primeira mensagem: a contagem de cada abordagem, atualizada a cada empresa desta rodada.
  const contagem = leads.length ? Object.fromEntries((await db.resultadoPorAbordagem()).map((r) => [r.abordagem, r])) : {};

  for (const lead of leads) {
    if (semTempo(ate)) break;
    // Duas rodadas ao mesmo tempo (os dois agendadores, ou um clique no painel) não escrevem a sequência duas vezes:
    // a empresa fica reservada para uma só, e a outra confere de novo se ela ainda está esperando proposta.
    if (!(await db.travar(`propor_lead:${lead.id}`, 5 * 60_000))) continue;
    if ((await db.buscarLead(lead.id))?.status !== lead.status) continue;
    const canais = [];
    if (campanha.canais.includes("email") && lead.email) canais.push(["email", lead.email]);
    if (campanha.canais.includes("whatsapp") && lead.whatsapp) canais.push(["whatsapp", lead.whatsapp]);
    // Sem WhatsApp e e-mail, o direct do Instagram (o @ fica como contato, para não chamar a mesma conta duas vezes).
    const soDirect = !lead.email && !lead.whatsapp && lead.instagram;
    if (soDirect) {
      // Não adianta acumular: você envia uns 25 por dia. O resto espera a fila andar.
      if (directsNaFila >= LIMITE_DIRECT_DIA * 2) continue;
      canais.push(["instagram", `@${lead.instagram}`]);
    }

    const destinosLivres = [];
    for (const [canal, destino] of canais) {
      if (!(await db.estaDescadastrado(destino)) && !(await db.contatoJaUsado(destino))) destinosLivres.push([canal, destino]);
    }
    if (!destinosLivres.length) {
      // Já existe sequência para estes contatos (ex.: reanálise só para incluir o WhatsApp).
      const jaTem = await db.contatoJaUsado(lead.email ?? "") || await db.contatoJaUsado(lead.whatsapp ?? "")
        || (soDirect && await db.contatoJaUsado(`@${lead.instagram}`));
      await db.atualizarLead(lead.id, jaTem
        ? { status: "proposta_gerada" }
        : { status: "descartado", observacao: "contato já usado ou descadastrado" });
      continue;
    }

    try {
      if (soDirect) {
        const d = await escreverDirectDeProspeccao(lead, JSON.parse(lead.oportunidades), campanha);
        await db.criarMensagem({ lead_id: lead.id, canal: "instagram", destino: destinosLivres[0][1], corpo: d.mensagem, etapa: 1, tipo: "inicial", status: statusInicial });
        await db.atualizarLead(lead.id, { status: "proposta_gerada", observacao: d.resumo_interno });
        directsNaFila++;
        geradas++;
        prontas.push({ nome: lead.nome, canais: ["instagram"] });
        log(`✍️  Direct para @${lead.instagram} (${d.servico_principal}); você envia pelo Instagram`);
        continue;
      }
      // A abordagem só é sorteada (e conta no teste) quando a sequência vai pelo WhatsApp.
      const abordagem = destinosLivres.some(([c]) => c === "whatsapp") ? escolherAbordagem(contagem) : null;
      const s = await gerarSequencia(lead, JSON.parse(lead.oportunidades), campanha, abordagem ? { abordagem } : {});
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
      await db.atualizarLead(lead.id, { status: "proposta_gerada", observacao: s.resumo_interno, ...(abordagem ? { abordagem } : {}) });
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

async function registrarEnvio(m, campanha, messageId = null, numeroId = null) {
  await db.atualizarMensagem(m.id, { status: "enviada", enviada_em: new Date().toISOString(), erro: null, message_id: messageId, numero_wa: numeroId });
  // A empresa passa a conversar sempre por este número.
  if (numeroId && m.numero_wa_lead !== numeroId) await db.atualizarLead(m.lead_id, { numero_wa: numeroId });
  if (m.tipo === "resposta") return;
  await db.atualizarLead(m.lead_id, { status: "contatado" });
  if (m.etapa < 3) await db.agendarProximaEtapa(m, horarioDaProximaEtapa(m.etapa, campanha, new Date(), m.canal, m.fuso || config.timezone).toISOString());
}

/**
 * Envia uma mensagem aprovada, SOMENTE em horário comercial e dentro do limite diário.
 * Fora disso, ela fica na fila e sai na próxima janela. Retorna { enviada, naFila, motivo }.
 */
export async function enviarMensagem(m, campanha, { agora = new Date() } = {}) {
  if (m.status !== "aprovada") return { enviada: false, motivo: `mensagem está como ${m.status}` };
  // A Meta não deixa a API mandar o primeiro direct: quem envia é você, pelo botão do painel.
  if (m.canal === "instagram" && m.tipo !== "resposta") return { enviada: false, manual: true, motivo: "direct do Instagram: envie pelo botão Abrir direct" };
  let modo = m.canal === "whatsapp" ? await modoWhatsapp() : null;
  if (modo === "manual") return { enviada: false, motivo: "WhatsApp manual: envie pelo botão do painel" };

  const bloqueio = await bloqueioDeEnvio(m);
  if (bloqueio) {
    await db.atualizarMensagem(m.id, { status: "rejeitada", erro: bloqueio });
    return { enviada: false, motivo: bloqueio };
  }
  // O direct do Instagram responde a qualquer hora: a Meta só aceita até 24 h depois da mensagem da pessoa.
  if (m.canal !== "instagram" && !dentroDoHorario(campanha.limites, agora, fusoDaMensagem(m))) {
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
  let numeroId = null;
  if (m.canal === "whatsapp") {
    // API oficial e UAZap juntas: cada empresa sai pelo número dela, de uma ou da outra.
    const escolha = await canalDoWhatsapp(m);
    if (!escolha.modo) return { enviada: false, naFila: true, motivo: escolha.motivo };
    modo = escolha.modo;
    numeroId = escolha.numeroId;
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
        idioma: m.idioma,
      });
    } else if (m.canal === "instagram") {
      messageId = await enviarDirect({ para: m.destino, comentarioId: m.em_resposta_a, texto: m.corpo });
    } else if (INTEGRACOES_WHATSAPP[modo]) {
      if (config.modoTeste.email && !config.modoTeste.whatsapp) throw new Error("modo teste ativo sem MODO_TESTE_WHATSAPP; WhatsApp não enviado");
      const destino = config.modoTeste.whatsapp || m.destino;
      const imagem = imagemDaMensagem(m);
      const enviarPara = (para) => (imagem
        ? enviarCampanhaEmAudio(INTEGRACOES_WHATSAPP[modo], para, m, m.corpo + rodape, imagem, { numeroId })
        : INTEGRACOES_WHATSAPP[modo].enviarTexto(para, m.corpo + rodape, { numeroId }));
      try {
        messageId = await enviarPara(destino);
      } catch (e) {
        // Contato @lid que o WhatsApp não reconhece: nada saiu para ele, então vai pelo telefone da empresa.
        const telefone = String(destino).includes("@lid") && /not on whatsapp/i.test(e.message) ? telefoneDoLead(await db.buscarLead(m.lead_id)) : null;
        if (!telefone) throw e;
        log(`↪️  ${m.empresa}: o contato do WhatsApp (@lid) não foi aceito; enviando pelo telefone da empresa`);
        messageId = await enviarPara(telefone);
      }
    } else if (m.tipo === "resposta") {
      messageId = await enviarTextoWhatsappOficial({ para: m.destino, corpo: m.corpo, numeroId });
    } else {
      messageId = await enviarWhatsapp({ para: m.destino, empresa: m.empresa, corpo: m.corpo, numeroId });
    }
    await registrarEnvio(m, campanha, messageId, numeroId);
    log(`📨 ${m.canal} (etapa ${m.etapa}) enviado para ${m.empresa} <${m.destino}>${numeroId ? ` pelo número ${numeroId}` : ""}`);
    return { enviada: true };
  } catch (e) {
    // O número caiu no meio do envio: a mensagem volta para a fila em vez de virar erro.
    if (m.canal === "whatsapp" && INTEGRACOES_WHATSAPP[modo] && QUEDA_DO_WHATSAPP.test(e.message)) {
      INTEGRACOES_WHATSAPP[modo].esquecerConexao(numeroId);
      await db.atualizarMensagem(m.id, { status: "aprovada", erro: null });
      log(`📵 WhatsApp desconectado ao enviar para ${m.empresa}; a mensagem continua na fila`);
      return { enviada: false, naFila: true, motivo: "WhatsApp desconectado; a mensagem continua na fila" };
    }
    await db.atualizarMensagem(m.id, { status: "erro", erro: e.message });
    log(`⚠️  Falha ao enviar para ${m.empresa}: ${e.message}`);
    return { enviada: false, motivo: e.message };
  }
}

/** O telefone da empresa para o WhatsApp (o confirmado no WhatsApp, senão o do cadastro), sem @lid. */
export function telefoneDoLead(lead) {
  for (const v of [lead?.whatsapp, lead?.telefone]) {
    if (!v || String(v).includes("@")) continue;
    const digitos = String(v).replace(/\D/g, "");
    if (digitos.length >= 12) return digitos;
    if (digitos.length >= 10) return `55${digitos}`;
  }
  return null;
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
  if (!m || !["whatsapp", "instagram"].includes(m.canal) || !["rascunho", "aprovada"].includes(m.status)) return false;
  const bloqueio = await bloqueioDeEnvio(m);
  if (bloqueio) {
    await db.atualizarMensagem(m.id, { status: "rejeitada", erro: bloqueio });
    return false;
  }
  // Enviar o primeiro contato manualmente também aprova as etapas seguintes da sequência.
  if (m.etapa <= 1 && m.tipo !== "resposta") {
    for (const x of await db.mensagensDaSequencia(m.lead_id, m.canal)) {
      if (x.id !== m.id && x.status === "rascunho") await db.atualizarMensagem(x.id, { status: "aprovada" });
    }
  }
  await registrarEnvio(m, campanha);
  return true;
}

/** Responde uma conversa com o texto revisado no painel. Respeita o horário comercial. */
/**
 * As pessoas com quem a conversa de uma empresa acontece no WhatsApp: o número da empresa, os contatos que ela
 * indicou (ligados pela indicação) e quem mais apareceu na conversa. `responderPara` é quem falou por último,
 * de um lado ou do outro (ex.: depois de escrevermos para a pessoa indicada, a resposta vai para ela).
 */
export async function contatosDaConversa(lead, historico = null) {
  historico ??= await db.historicoConversa(lead.id);
  const lista = [];
  const mesmo = (a, b) => /^\d+$/.test(String(a)) && /^\d+$/.test(String(b)) ? variantesWhatsappBR(a).includes(String(b)) : String(a) === String(b);
  const juntar = (numero, nome, papel) => {
    if (!numero || lista.some((c) => mesmo(c.numero, numero))) return;
    lista.push({ numero: String(numero), nome: nome || "", papel });
  };
  juntar(lead.whatsapp, lead.nome, "empresa");
  for (const c of await contatosLigados(lead.id)) juntar(c.numero, c.nome, c.papel || "indicado");
  // Indicação de antes deste registro: o nome sai da observação ("Indicou Ingrid (5511942117931); ...").
  const antiga = String(lead.observacao ?? "").match(/Indicou (.+?) \((\d{10,15})\)/);
  if (antiga) juntar(antiga[2], antiga[1] === "um contato" ? "" : antiga[1], "indicado");
  for (const h of historico) if (h.canal === "whatsapp") juntar(h.contato, "", "contato");
  const ultimo = historico.filter((h) => h.canal === "whatsapp" && h.contato).at(-1);
  const responderPara = ultimo ? lista.find((c) => mesmo(c.numero, ultimo.contato))?.numero ?? null : null;
  return { contatos: lista, responderPara };
}

export async function responderConversa(respostaId, texto, campanha, { destino: escolhido = null } = {}) {
  const r = await db.buscarResposta(respostaId);
  if (!r) throw new Error("Resposta não encontrada");
  if (!String(texto ?? "").trim()) throw new Error("Escreva a mensagem antes de enviar");
  // Para quem escreveu (pode ser um contato indicado, não o e-mail/número original da empresa), ou para quem
  // foi escolhido no painel, desde que seja alguém desta conversa.
  let destino = r.de || (r.canal === "email" ? r.email : r.whatsapp);
  if (escolhido && r.canal === "whatsapp") {
    const { contatos } = await contatosDaConversa(await db.buscarLead(r.lead_id));
    const achado = contatos.find((c) => variantesWhatsappBR(c.numero).includes(String(escolhido).replace(/\D/g, "")) || c.numero === String(escolhido));
    if (!achado) throw new Error("Esse número não faz parte desta conversa");
    destino = achado.numero;
  }
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

/** Chave da vez de um número no banco (sem número, a vez única de antes). */
const chaveDaVez = (numeroId) => (numeroId ? `${VEZ_DO_PROXIMO_CONTATO}:${numeroId}` : VEZ_DO_PROXIMO_CONTATO);

/**
 * Os números de WhatsApp que mandam prospecção, cada um com a sua vez: uma empresa nova (ou etapa 2 e 3)
 * por número, com o intervalo da Automação entre uma e outra no mesmo número. Segue as regras de quem recebe
 * empresa nova (número oficial liberado pela Meta, UAZap conectada, sem agente de atendimento). Sem nenhum,
 * fica a vez única de antes (que também é a do e-mail quando o WhatsApp está parado).
 */
export async function pistasDaVez() {
  const pistas = [];
  const modo = await modoWhatsapp();
  if (modo !== "manual" && !(await whatsappDesconectado(modo))) {
    const oficial = await oficialAtiva();
    const web = await integracaoWhatsapp();
    const comAgente = await numerosComAgente();
    if (oficial) {
      const ativos = (await numerosOficiais({ ativos: true })).filter((n) => !comAgente.has(n.id));
      const prontos = [];
      for (const n of ativos) if (await prontoParaEmpresaNova(n.id)) prontos.push(n);
      for (const n of prontos.length ? prontos : web === "uazap" ? [] : ativos) pistas.push({ modo: "oficial", numeroId: n.id });
    }
    if (web === "uazap") {
      for (const n of await uazap.conectados()) if (!comAgente.has(n.id)) pistas.push({ modo: "uazap", numeroId: n.id });
    } else if (web && !oficial) pistas.push({ modo: web, numeroId: null });
  }
  if (!pistas.length) pistas.push({ modo: null, numeroId: null });
  return pistas.map((p) => ({ ...p, chave: chaveDaVez(p.numeroId) }));
}

/** Quando a vez de cada número libera (0 = já está livre). */
async function vezesLivresEm(pistas) {
  const quando = [];
  for (const p of pistas) {
    const ate = Number(await db.lerEstado(p.chave)) || 0;
    quando.push(ate > Date.now() ? ate : 0);
  }
  return quando;
}

/**
 * As vezes guardadas no banco, sem perguntar a ninguém de fora se o número está conectado (para a Dashboard,
 * que não pode travar esperando um serviço lento): os números cadastrados, sem os que têm agente (sem nenhum, a vez única).
 */
async function pistasGuardadas() {
  const comAgente = await numerosComAgente();
  const ids = [...(await numerosOficiais({ ativos: true })), ...(await uazap.numeros())].map((n) => n.id).filter((id) => !comAgente.has(id));
  return (ids.length ? ids : [null]).map((id) => ({ chave: chaveDaVez(id) }));
}

/** Quando a próxima empresa nova pode receber o primeiro contato (null = já pode, em algum número). */
export async function proximaEmpresaNovaEm() {
  const ate = Math.min(...(await vezesLivresEm(await pistasGuardadas())));
  return ate > Date.now() ? new Date(ate).toISOString() : null;
}

/**
 * Quando sai a próxima mensagem pelo WhatsApp, para a Dashboard: { quando, oQue }, ou { motivo } quando nada vai
 * sair sozinho. Segue as regras do envio: a resposta da conversa vai no próximo minuto (o agendador chama a cada
 * minuto), a etapa 2 ou 3 e a empresa nova esperam a vez do número, e nada sai fora do horário comercial.
 */
export async function proximoEnvioWhatsapp(campanha, agora = new Date()) {
  const modo = await modoWhatsapp();
  if (modo === "manual") return { motivo: "WhatsApp no modo manual: você envia pelo painel" };
  if (await whatsappDesconectado(modo)) return { motivo: "WhatsApp desconectado: nada sai até você reconectar o número" };
  const { limites } = campanha;
  const proximoMinuto = (t) => Math.ceil(t / 60_000) * 60_000;
  const vez = Math.min(...(await vezesLivresEm(await pistasGuardadas())));
  const naVez = (t) => proximoMinuto(Math.max(t, vez, +agora + 1));
  const fila = (await db.filaDeEnvio(400)).filter((m) => m.canal === "whatsapp");
  const candidatos = [];
  if (fila.some((m) => m.tipo === "resposta")) candidatos.push({ quando: proximoMinuto(+agora + 1), oQue: "Resposta da conversa" });
  const seguimento = fila.find((m) => m.tipo !== "resposta" && m.etapa > 1);
  if (seguimento) candidatos.push({ quando: naVez(+agora), oQue: `Etapa ${seguimento.etapa} de 3 para ${seguimento.empresa}` });
  const nova = ordenarFilaDeEnvio(fila).find((m) => m.tipo !== "resposta" && m.etapa <= 1);
  if (nova) {
    const temVaga = daTempoDeSequenciaHoje(limites, agora)
      && (await db.enviadasHoje("whatsapp", { primeiroContato: true })) < (await limiteDoDia(campanha, "whatsapp"));
    // Sem vaga hoje, ela sai no começo do próximo dia útil.
    const quando = temVaga ? naVez(+agora) : +inicioDoProximoDiaUtil(limites, agora, { folga: false });
    candidatos.push({ quando, oQue: `Empresa nova: ${nova.empresa}` });
  }
  const agendada = await db.proximaAgendadaNoCanal("whatsapp");
  if (agendada) candidatos.push({ quando: naVez(+new Date(agendada.agendada_para)), oQue: agendada.tipo === "resposta" ? "Resposta da conversa" : `Etapa ${agendada.etapa} de 3 para ${agendada.empresa}` });
  if (!candidatos.length) return { motivo: "Nada na fila do WhatsApp agora" };
  const proximo = candidatos.sort((a, b) => a.quando - b.quando)[0];
  let quando = new Date(proximo.quando);
  if (!dentroDoHorario(limites, quando)) quando = inicioDoProximoDiaUtil(limites, quando, { folga: false });
  return { quando: quando.toISOString(), oQue: proximo.oQue };
}

/**
 * Quanto tempo a fila de envio leva para sair inteira, se nenhuma empresa responder antes (quem responde
 * não recebe as próximas etapas, então na prática acaba antes), com todos os números que mandam prospecção e,
 * para comparar, com um só. Simula as regras do envio com os valores médios:
 * uma mensagem por vez em cada número de WhatsApp (empresa nova ou etapa 2 e 3), o intervalo do meio entre o mínimo e o
 * máximo da Automação, as etapas de WhatsApp cerca de 2 h depois da anterior (no mesmo dia, se couber), as de
 * e-mail em outro dia útil, o limite de empresas novas por dia e só em horário comercial.
 */
export async function previsaoDaFila(campanha, agora = new Date(), { mensagens = null } = {}) {
  const { limites } = campanha;
  const lista = mensagens ?? (await db.mensagensPorStatus("aprovada", 2000));
  const modo = await modoWhatsapp();
  const parado = modo === "manual" ? "o WhatsApp está no modo manual: as mensagens de WhatsApp saem só quando você envia pelo painel"
    : (await whatsappDesconectado(modo)) ? "o WhatsApp está desconectado: a conta vale a partir de quando você reconectar" : null;
  const intervaloMs = intervaloEntreEmpresasMs(campanha.automacao, 0.5);
  const horas = campanha.cadencia?.horasEntreEtapas ?? HORAS_ENTRE_ETAPAS;
  const diasEmail = campanha.cadencia?.diasEntreEmails ?? DIAS_ENTRE_EMAILS;
  const limite = { whatsapp: await limiteDoDia(campanha, "whatsapp"), email: await limiteDoDia(campanha, "email") };
  const enviadasHojeNoInicio = { whatsapp: await db.enviadasHoje("whatsapp", { primeiroContato: true }), email: await db.enviadasHoje("email", { primeiroContato: true }) };
  const diaDe = (t) => new Date(t).toLocaleDateString("pt-BR", { timeZone: config.timezone });
  const abrir = (t) => (dentroDoHorario(limites, new Date(t)) ? t : +inicioDoProximoDiaUtil(limites, new Date(t), { folga: false }));
  // Como no envio: a próxima etapa de WhatsApp cerca de 2 h depois, encolhendo no fim do dia; se não couber, no dia útil seguinte.
  const proximaNoWhatsapp = (etapa, t) => {
    const cabe = (minutosAteOFim(limites, new Date(t)) - MARGEM_FIM_MIN) / (3 - etapa);
    const intervalo = Math.min((horas[etapa - 1] ?? 2) * 60 * 0.925, cabe);
    return intervalo >= INTERVALO_MINIMO_MIN ? t + intervalo * 60_000 : +inicioDoProximoDiaUtil(limites, new Date(t), { folga: false }) + 15 * 60_000;
  };

  let terminaRespostas = +agora;
  let contadas = 0;
  let manuais = 0;
  const empresas = new Set();
  const sequencias = new Map();
  for (const m of ordenarFilaDeEnvio(lista)) {
    if (m.canal === "instagram" && m.tipo !== "resposta") { manuais++; continue; }
    if (m.canal === "whatsapp" && modo === "manual") { manuais++; continue; }
    contadas++;
    empresas.add(m.lead_id);
    // Resposta da conversa: sai no minuto seguinte (o direct do Instagram, a qualquer hora).
    if (m.tipo === "resposta") { terminaRespostas = Math.max(terminaRespostas, m.canal === "instagram" ? +agora + 60_000 : abrir(+agora + 60_000)); continue; }
    const chave = `${m.lead_id}|${m.canal}`;
    if (!sequencias.has(chave)) sequencias.set(chave, { lead: m.lead_id, canal: m.canal, etapas: [] });
    sequencias.get(chave).etapas.push({ etapa: m.etapa, agendada: m.agendada_para ? +new Date(m.agendada_para) : null });
  }
  for (const s of sequencias.values()) s.etapas.sort((a, b) => a.etapa - b.etapa);
  // Canal com limite zero não manda empresa nova nenhuma: essas ficam fora da conta.
  const semVaga = [...sequencias.values()].filter((s) => s.etapas[0]?.etapa <= 1 && !(limite[s.canal] > 0));
  contadas -= semVaga.reduce((soma, s) => soma + s.etapas.length, 0);
  const vezes = await vezesLivresEm(await pistasDaVez());
  const numeros = vezes.length;

  /** Simula o envio com `qtd` números, cada um na sua vez; devolve quando a última mensagem sai. */
  const simular = (qtd) => {
    let termina = terminaRespostas;
    const hoje = { ...enviadasHojeNoInicio };
    const seqs = [...sequencias.values()].map((s) => ({ ...s, etapas: s.etapas.map((e) => ({ ...e })) }));
    // E-mail: as etapas seguintes não esperam a vez; cada uma sai alguns dias úteis depois da anterior.
    const terminarEmail = (s, t, etapaEnviada) => {
      let fim = t;
      for (const e of s.etapas) {
        fim = e.agendada && e.agendada > fim ? abrir(e.agendada) : abrir(+somarDiasUteis(new Date(fim), diasEmail[etapaEnviada - 1] ?? 2));
        etapaEnviada = e.etapa;
      }
      s.etapas = [];
      termina = Math.max(termina, fim);
    };
    // Cada número com a sua vez e as etapas 2 e 3 (WhatsApp) das conversas dele; as que já estavam na fila se dividem entre eles.
    const pistas = Array.from({ length: qtd }, (_, i) => ({ t: abrir(Math.max(+agora, vezes[i] ?? 0)), devidaEm: new Map() }));
    let k = 0;
    for (const s of seqs) {
      const primeira = s.etapas[0];
      if (primeira.etapa <= 1) continue; // empresa nova: espera a vez e a vaga do dia
      if (s.canal === "email") { terminarEmail(s, primeira.agendada ?? +agora, primeira.etapa - 1); continue; }
      pistas[k++ % qtd].devidaEm.set(s, primeira.agendada ?? +agora);
    }
    const novas = seqs.filter((s) => s.etapas[0]?.etapa <= 1 && limite[s.canal] > 0);
    let dia = diaDe(Math.min(...pistas.map((p) => p.t)));
    const LIMITE_DE_PASSOS = 40_000;
    const horizonte = +agora + 365 * 86_400_000;
    for (let passo = 0; passo < LIMITE_DE_PASSOS; passo++) {
      // A vez é do número que libera primeiro (o tempo só anda para a frente, então o dia vira na ordem certa).
      const ativas = pistas.filter((p) => p.devidaEm.size || novas.length);
      if (!ativas.length) break;
      const p = ativas.reduce((x, y) => (y.t < x.t ? y : x));
      if (p.t >= horizonte) break;
      let t = (p.t = abrir(p.t));
      if (diaDe(t) !== dia) { dia = diaDe(t); hoje.whatsapp = 0; hoje.email = 0; }
      // A vez é das etapas 2 e 3 do WhatsApp; sem nenhuma pronta, da empresa nova com vaga hoje.
      const pronta = [...p.devidaEm].filter(([, d]) => d <= t).sort((a, b) => a[1] - b[1])[0]?.[0];
      let enviou = null;
      if (pronta) {
        enviou = pronta;
      } else if (novas.length && daTempoDeSequenciaHoje(limites, new Date(t))) {
        const i = novas.findIndex((s) => hoje[s.canal] < limite[s.canal]);
        if (i >= 0) {
          enviou = novas[i];
          // O e-mail e o WhatsApp da mesma empresa saem juntos, na mesma vez.
          for (const s of novas.filter((x) => x.lead === enviou.lead && hoje[x.canal] < limite[x.canal])) {
            hoje[s.canal]++;
            novas.splice(novas.indexOf(s), 1);
            const e = s.etapas.shift();
            termina = Math.max(termina, t);
            if (s.canal === "email") terminarEmail(s, t, e.etapa);
            else if (s.etapas.length) p.devidaEm.set(s, proximaNoWhatsapp(e.etapa, t));
          }
        }
      }
      if (pronta) {
        const e = pronta.etapas.shift();
        termina = Math.max(termina, t);
        if (pronta.etapas.length) p.devidaEm.set(pronta, Math.max(pronta.etapas[0].agendada ?? 0, proximaNoWhatsapp(e.etapa, t)));
        else p.devidaEm.delete(pronta);
      }
      if (enviou) { p.t = t + intervaloMs; continue; }
      // Nada pode sair agora neste número: pula para a próxima etapa marcada dele ou para o dia seguinte (vaga nova).
      const proximaDevida = p.devidaEm.size ? Math.min(...p.devidaEm.values()) : Infinity;
      const amanha = +inicioDoProximoDiaUtil(limites, new Date(t), { folga: false });
      p.t = novas.length ? Math.min(proximaDevida, amanha) : proximaDevida;
    }
    return contadas ? new Date(termina).toISOString() : null;
  };

  const termina = simular(numeros);
  return {
    termina,
    // Quanto levaria se fosse um número só (igual ao de cima quando só há um).
    terminaComUmNumero: numeros > 1 ? simular(1) : termina,
    numeros,
    mensagens: contadas,
    empresas: empresas.size,
    manuais,
    semVaga: semVaga.reduce((soma, s) => soma + s.etapas.length, 0),
    parado,
    ritmo: { intervaloMin: Math.round(intervaloMs / 60_000), limiteEmail: limite.email },
  };
}

/** Rodadas de 10 minutos que ainda restam no horário comercial de hoje. */
export function rodadasRestantesHoje(limites, agora = new Date(), folgaMin = 0, fuso = config.timezone) {
  return Math.max(1, Math.floor((minutosAteOFim(limites, agora, fuso) - folgaMin) / 10));
}

/** O fuso do horário comercial de uma mensagem: o da empresa de fora do Brasil, ou o do sistema. */
export const fusoDaMensagem = (m) => (m?.pais && m.pais !== "BR" && m.fuso) || config.timezone;

/**
 * O que sai numa chamada de envio sem esperar vez: as respostas da conversa e as etapas 2 e 3 de e-mail
 * (na chamada de cada minuto, só as respostas: quem está conversando não espera a rodada de 10 minutos).
 * As empresas novas e as etapas 2 e 3 do WhatsApp esperam a vez de um número (escolherVezes).
 */
export function conversaDaChamada(enviaveis, { somenteDaVez = false } = {}) {
  return enviaveis.filter((m) => (somenteDaVez ? m.tipo === "resposta" : m.tipo === "resposta" || (m.etapa > 1 && m.canal !== "whatsapp")));
}

/**
 * Etapa 4: envia a fila (etapas aprovadas e já no dia agendado), com intervalo variável.
 * Nada sai fora do horário comercial de segunda a sexta. Com `distribuir`, a cota de
 * hoje é espalhada pelas rodadas que faltam, para não sair tudo de uma vez.
 * Empresas novas e etapas 2 e 3 do WhatsApp saem uma por vez em cada número, com 5 a 12 minutos entre elas
 * no mesmo número (o agendador do banco chama `somenteDaVez` a cada minuto para respeitar esse intervalo).
 */
export async function enviar(campanha, { ate = prazoPadrao(), distribuir = false, somenteDaVez = false, agora = new Date() } = {}) {
  const { limites } = campanha;
  // Fora do horário daqui, só podem sair as mensagens para empresas de fora do Brasil (no horário de lá).
  const aquiNoHorario = dentroDoHorario(limites, agora);
  const foraDoHorario = () => {
    if (!somenteDaVez) log("📭 Fora do horário comercial; nada enviado");
    return { enviadas: 0, motivo: "fora do horário comercial" };
  };
  if (!aquiNoHorario && !(await db.temFilaNoExterior())) return foraDoHorario();
  // Cada mensagem sai no horário comercial do fuso da empresa (o daqui, ou o do país dela).
  const todas = ordenarFilaDeEnvio(await db.filaDeEnvio(400));
  const noHorario = todas.filter((m) => m.canal === "instagram" || dentroDoHorario(limites, agora, fusoDaMensagem(m)));
  if (!aquiNoHorario && !noHorario.some((m) => m.canal !== "instagram")) return foraDoHorario();

  const modo = await modoWhatsapp();
  // Manual ou desconectado: o WhatsApp fica na fila e só o e-mail sai nesta rodada.
  const semWhatsapp = modo === "manual" || (await whatsappDesconectado(modo));
  if (semWhatsapp && modo !== "manual") {
    const motivo = await INTEGRACOES_WHATSAPP[modo].motivoDaQueda?.();
    if (!somenteDaVez) log(`📵 WhatsApp desconectado${motivo ? ` (${motivo})` : ""}: as mensagens de WhatsApp ficam na fila até reconectar`);
    await avisarWhatsappDesconectado(modo);
  }
  // A meta do dia é de empresas novas (etapa 1). No WhatsApp ela é espalhada até a hora em
  // que ainda dá para as 3 etapas saírem hoje; no e-mail, até o fim do expediente (as etapas
  // seguintes saem em outros dias). Etapas 2 e 3 e respostas da conversa não entram na conta.
  const fusos = [...new Set([...(aquiNoHorario ? [config.timezone] : []), ...noHorario.map(fusoDaMensagem)])];
  const vagas = {};
  for (const canal of ["email", "whatsapp"]) {
    const comTempo = fusos.filter((f) => canal === "email" || daTempoDeSequenciaHoje(limites, agora, f));
    const restante = comTempo.length
      ? (await limiteDoDia(campanha, canal)) - (await db.enviadasHoje(canal, { primeiroContato: true }))
      : 0;
    const rodadas = Math.max(1, ...comTempo.map((f) => rodadasRestantesHoje(limites, agora, canal === "email" ? 0 : TEMPO_PARA_SEQUENCIA_MIN, f)));
    vagas[canal] = distribuir ? Math.min(restante, Math.max(LOTE_POR_RODADA, Math.ceil(restante / rodadas))) : restante;
  }
  const vagasDaRodada = { ...vagas };
  // Empresa nova no WhatsApp só começa se as 3 etapas ainda couberem hoje no horário dela.
  const enviaveis = noHorario.filter((m) => (m.canal !== "whatsapp" || !semWhatsapp)
    && !(m.canal === "whatsapp" && m.tipo !== "resposta" && m.etapa <= 1 && !daTempoDeSequenciaHoje(limites, agora, fusoDaMensagem(m))));
  const conversa = conversaDaChamada(enviaveis, { somenteDaVez });
  const naFila = { email: 0, whatsapp: 0, instagram: 0 };
  for (const m of todas) naFila[m.canal]++;
  // Cada número tem a sua vez: a vez é reservada no banco (com dois agendadores rodando juntos, só um envia)
  // e a próxima daquele número só sai depois do intervalo sorteado.
  const vezes = await escolherVezes(enviaveis, vagas, await pistasDaVez(), campanha);
  const fila = [...conversa, ...vezes.flatMap((v) => v.mensagens)];
  if (!fila.length) {
    if (!somenteDaVez) log("📭 Nada para enviar agora");
    return { enviadas: 0, naFila, vagas: vagasDaRodada };
  }

  const intervalo = limites.intervaloEntreEnviosSegundos * 1000;
  let enviadas = 0;
  const saiu = new Set();
  const porCanal = { email: 0, whatsapp: 0, instagram: 0 };
  for (const [i, m] of fila.entries()) {
    const r = await enviarMensagem(m, campanha, { agora });
    if (r.enviada) {
      enviadas++;
      porCanal[m.canal]++;
      saiu.add(m.id);
    } else if (r.naFila) log(`⏸️  ${m.empresa} (${m.canal}, ${m.tipo === "resposta" ? "resposta" : `etapa ${m.etapa}`}) continua na fila: ${r.motivo}`);
    if (i === fila.length - 1) break;
    // Intervalo variável entre envios, para não parecer disparo em massa (nem cair no spam).
    const espera = Math.round(intervalo * (0.6 + Math.random() * 0.8));
    if (Date.now() + espera > ate) break;
    await esperar(espera);
  }

  // Número cuja vez não mandou nada (bloqueada, limite, erro, sem tempo): a próxima dele não precisa esperar.
  for (const v of vezes) if (!v.mensagens.some((m) => saiu.has(m.id))) await db.destravar(v.chave);
  const deram = vezes.filter((v) => v.mensagens.some((m) => saiu.has(m.id))).length;
  const proximaVez = deram ? await proximaEmpresaNovaEm() : null;
  if (deram) log(`⏱️  ${deram} ${deram === 1 ? "número usou a vez" : "números usaram a vez"}; próximo contato a partir de ${proximaVez ? new Date(proximaVez).toLocaleTimeString("pt-BR", { timeZone: config.timezone }) : "agora"}`);
  log(`📨 ${enviadas} mensagens enviadas (e-mail: ${porCanal.email}, WhatsApp: ${porCanal.whatsapp})`);
  return { enviadas, porCanal, naFila, vagas: vagasDaRodada, proximaEmpresaNova: proximaVez };
}

/**
 * O que cada número manda nesta chamada, na vez dele: primeiro as etapas 2 e 3 do WhatsApp, cada uma pelo
 * número da conversa; depois, nos números que sobraram livres (os que mandaram menos hoje antes), as empresas
 * novas de mais potencial com vaga hoje (o e-mail e o WhatsApp da mesma empresa saem juntos, na mesma vez).
 * Reserva a vez de cada número escolhido. Retorna [{ chave, mensagens }].
 */
const MAX_SEGUIMENTOS_POR_CHAMADA = 30;
export async function escolherVezes(enviaveis, vagas, pistas, campanha) {
  const vezes = [];
  const decididas = new Set();
  const leads = new Set();
  const reservar = async (chave) => {
    if (decididas.has(chave)) return false;
    decididas.add(chave);
    return db.travar(chave, intervaloEntreEmpresasMs(campanha.automacao));
  };
  let vistos = 0;
  for (const m of enviaveis) {
    if (!(m.canal === "whatsapp" && m.tipo !== "resposta" && m.etapa > 1) || leads.has(m.lead_id)) continue;
    if (++vistos > MAX_SEGUIMENTOS_POR_CHAMADA || pistas.every((p) => decididas.has(p.chave))) break;
    const escolha = await canalDoWhatsapp(m);
    if (!escolha.modo) continue;
    const chave = chaveDaVez(escolha.numeroId);
    if (!(await reservar(chave))) continue;
    leads.add(m.lead_id);
    vezes.push({ chave, mensagens: [m] });
  }
  const restam = { ...vagas };
  const novas = enviaveis.filter((m) => m.tipo !== "resposta" && m.etapa <= 1);
  const enviadasHoje = new Map();
  for (const p of pistas) enviadasHoje.set(p, p.numeroId ? await db.enviadasHoje("whatsapp", { primeiroContato: true, numero: p.numeroId }) : 0);
  for (const p of [...pistas].sort((a, b) => enviadasHoje.get(a) - enviadasHoje.get(b))) {
    if (decididas.has(p.chave)) continue;
    // Número da API oficial não começa conversa com empresa de fora do Brasil (o modelo aprovado é em português).
    const lead = novas.find((m) => !leads.has(m.lead_id) && restam[m.canal] > 0 && !(p.modo === "oficial" && m.pais && m.pais !== "BR"))?.lead_id;
    if (lead === undefined) break;
    if (!(await reservar(p.chave))) continue;
    const mensagens = novas.filter((m) => m.lead_id === lead && restam[m.canal] > 0);
    for (const m of mensagens) {
      restam[m.canal]--;
      if (m.canal === "whatsapp" && p.modo) m.numeroDaVez = { modo: p.modo, numeroId: p.numeroId };
    }
    leads.add(lead);
    vezes.push({ chave: p.chave, mensagens });
  }
  return vezes;
}

/**
 * Respostas do direct do Instagram que já chegaram na hora marcada, a qualquer hora e dia
 * (chamado a cada 2 minutos pelo agendador do banco).
 */
export async function enviarInstagram(campanha) {
  const fila = (await db.filaDeEnvio(400)).filter((m) => m.canal === "instagram" && m.tipo === "resposta");
  let enviadas = 0;
  for (const m of fila) if ((await enviarMensagem(m, campanha)).enviada) enviadas++;
  return { enviadas, naFila: fila.length - enviadas };
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
  // Recusa clara que ficou aberta ("no momento não" lido como outra coisa): encerra antes de qualquer follow-up.
  resultado.recusas = await encerrarRecusasAbertas().catch((e) => {
    log(`⚠️  Falha ao rever as recusas: ${e.message}`);
    return { erro: e.message };
  });
  // Follow-up de quem mostrou interesse e parou de responder há 1 dia (sai pela fila de respostas, em minutos).
  if (!semTempo(ate)) {
    resultado.followups = await followupsDeInteressados(campanha).catch((e) => {
      log(`⚠️  Falha nos follow-ups: ${e.message}`);
      return { erro: e.message };
    });
  }
  // Reativação de quem recebeu tudo e não respondeu há 30 dias (uma mensagem só) e encerramento de quem não
  // respondeu a ela em 7 dias.
  if (!semTempo(ate)) {
    resultado.reativacao = await rodadaDeReativacao(campanha).catch((e) => {
      log(`⚠️  Falha na reativação: ${e.message}`);
      return { erro: e.message };
    });
  }
  resultado.envio = await enviar(campanha, { ate, distribuir: Boolean(campanha.automacao?.ativo) });
  // Fotos de perfil das empresas das conversas: salva as que faltam e renova as de 7 dias, poucas por rodada.
  if (!semTempo(ate)) {
    resultado.fotos = await salvarFotosDasEmpresas().catch((e) => {
      log(`⚠️  Falha ao salvar as fotos de perfil: ${e.message}`);
      return { erro: e.message };
    });
  }
  if (!campanha.automacao?.ativo) return resultado;

  // Uma vez por dia: a IA avalia os ramos em teste (fica com os que respondem bem) e escolhe ramos novos.
  if (!semTempo(ate)) {
    resultado.ramos = await rodadaDeRamos(campanha).catch((e) => {
      log(`⚠️  Falha ao escolher ramos novos: ${e.message}`);
      return { erro: e.message };
    });
  }
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
      const s = await gerarSequencia(lead, JSON.parse(lead.oportunidades || "[]"), campanha, lead.abordagem ? { abordagem: lead.abordagem } : {});
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
