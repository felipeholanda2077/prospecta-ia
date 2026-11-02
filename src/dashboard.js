// A dashboard do painel: o que precisa de você agora e os números de cada setor, numa rota só.
// Cada setor é lido à parte: o que falhar aparece como "não foi possível ler", sem derrubar os outros.
// Um setor de cada vez, e sem abandonar consulta no meio: com todos juntos e um limite de tempo por cima,
// a função respondia com consultas ainda em andamento e as conexões do banco travavam para o painel inteiro.
// Daqui não sai chave nem segredo: só contagens, rótulos e o estado de cada serviço.
import { waitUntil } from "@vercel/functions";
import { config } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";
import { carregarCampanhaCompleta } from "./campanha.js";
import { indicadoresDasConversas } from "./respostas/andamento.js";
import { comIntegracoes } from "./descoberta/fornecedores.js";
import * as uazap from "./envio/uazap.js";
import * as evolution from "./envio/evolution.js";
import * as whatsappOficial from "./envio/whatsapp.js";
import * as linkedin from "./envio/linkedin.js";
import * as tiktok from "./envio/tiktok.js";
import * as mercadolivre from "./envio/mercadolivre.js";
import * as shopee from "./envio/shopee.js";
import { statusEmail } from "./envio/email.js";
import { statusDaConexao as statusDoInstagram } from "./envio/instagram.js";
import { statusDoBanco } from "./agendamento/banco.js";
import * as calendly from "./agenda/calendly.js";
import * as asaas from "./contratos/asaas.js";
import * as cobrancas from "./contratos/cobranca.js";
import * as entrada from "./vendas/entrada.js";
import { lerConfigConteudo, agoraEmBrasilia } from "./conteudo/diario.js";
import { desempenho, lerPlano } from "./conteudo/insights.js";
import { lerConfigAvatar, saldoDoHeygen, creditosDaRunway } from "./conteudo/avatar.js";
import { narracaoDisponivel, carregarChaveDaVoz } from "./conteudo/narracao.js";

const LIMITE_EXTERNO_MS = 3_000;
const ORCAMENTO_MS = 25_000;
const DASHBOARD_VALIDA_MS = 20_000;
const CREDITOS_VALIDOS_MS = 10 * 60_000;
const PEDIDOS_VALIDOS_MS = 5 * 60_000;
// Abaixo disso, avisa que o saldo está acabando. O HeyGen gasta perto de 1 crédito por minuto de vídeo; na Runway, 1 crédito vale US$ 0,01.
const POUCO_SALDO = { heygen: { creditos: 5, usd: 2 }, runway: { creditos: 200 } };
const AGENDADOR_PARADO_MS = 30 * 60_000;
const ATRASO_DO_POST_MIN = 60;
const DIAS_DE_POST_FALHO = 3;
const TOKEN_ACABANDO_MS = 2 * 24 * 3600_000;

const SEM_RESPOSTA = Symbol("sem resposta");

/** Espera no máximo `ms`. Só para chamadas a serviços de fora, nunca para consultas ao banco. */
function comLimite(promessa, ms = LIMITE_EXTERNO_MS) {
  let relogio;
  const estourou = new Promise((_, falhar) => { relogio = setTimeout(() => falhar(new Error(`passou de ${ms} ms`)), ms); });
  return Promise.race([promessa, estourou]).finally(() => clearTimeout(relogio));
}

const guardados = new Map();

/** Leitura de serviço de fora guardada por um tempo. Sem resposta a tempo, vale a última que chegou (ou SEM_RESPOSTA). */
async function guardado(chave, validadeMs, ler) {
  const g = guardados.get(chave) ?? {};
  guardados.set(chave, g);
  if (g.ate > Date.now()) return g.valor;
  g.lendo ??= ler().then(
    (valor) => Object.assign(g, { valor, tem: true, ate: Date.now() + validadeMs }),
    // Serviço fora do ar: só pergunta de novo daqui a 1 minuto.
    () => Object.assign(g, { ate: Date.now() + 60_000 })
  ).finally(() => { g.lendo = null; });
  // Passou do limite: a leitura termina depois da resposta e fica guardada para a próxima vez.
  waitUntil(g.lendo);
  await comLimite(g.lendo).catch(() => {});
  return g.tem ? g.valor : SEM_RESPOSTA;
}

let ultimaDashboard = null;

function dashboardGuardada(ler) {
  if (ultimaDashboard && ultimaDashboard.ate > Date.now()) return ultimaDashboard.promessa;
  const promessa = ler();
  ultimaDashboard = { promessa, ate: Infinity };
  promessa.then(
    () => { if (ultimaDashboard?.promessa === promessa) ultimaDashboard.ate = Date.now() + DASHBOARD_VALIDA_MS; },
    () => { if (ultimaDashboard?.promessa === promessa) ultimaDashboard = null; }
  );
  return promessa;
}

export const esquecerGuardados = () => {
  guardados.clear();
  ultimaDashboard = null;
};

// ---------- Formato ----------

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

const emReais = (v) => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: Number.isInteger(v) ? 0 : 2 });

function tempoAtras(quando, agora = Date.now()) {
  const min = Math.floor((agora - new Date(quando)) / 60_000);
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const horas = Math.floor(min / 60);
  return horas < 48 ? `há ${horas} h` : `há ${Math.floor(horas / 24)} dias`;
}

// Zero não pede atenção nem comemora: fica sem cor.
const ind = (rotulo, valor, link, { tom = "", detalhe = null, aba = null } = {}) => ({ rotulo, valor: valor ?? "—", link, tom: valor === 0 || valor === emReais(0) ? "" : tom, detalhe, aba });
const alerta = (nivel, titulo, link, { detalhe = null, aba = null } = {}) => ({ nivel, titulo, link, detalhe, aba });
const seVier = (condicao, item) => (condicao ? [item] : []);
const curto = (texto, max = 140) => {
  const t = String(texto ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ---------- Setores ----------

/** Lidos uma vez só por rodada, mesmo quando vários setores usam. */
function leiturasCompartilhadas(lerConversas) {
  const umaVez = (ler) => {
    let p;
    return () => (p ??= ler());
  };
  return { stats: umaVez(db.estatisticas), campanha: umaVez(carregarCampanhaCompleta), conversas: umaVez(lerConversas), whatsappRespondeu: umaVez(whatsappRespondeu) };
}

/**
 * Pergunta aos números se estão conectados, com limite de tempo. A resposta fica guardada por 1 minuto, então
 * depois dela o modo e o limite do WhatsApp só leem o banco. Sem resposta, eles ficam sem mostrar.
 */
async function whatsappRespondeu() {
  await uazap.numeros();
  const temEvolution = await evolution.configurada();
  return comLimite(Promise.all([uazap.conectados(), ...(temEvolution ? [evolution.conectadoAgora()] : [])])).then(() => true, () => false);
}

async function prospeccao(c) {
  const s = await c.stats();
  const campanha = await c.campanha();
  const capturadasHoje = await db.empresasCapturadasHoje();
  const aprovar = s.sequenciasPendentes ?? 0;
  const comErro = s.mensagens.erro ?? 0;
  const cidades = new Set(campanha.buscas.flatMap((b) => b.cidades)).size;
  return {
    indicadores: [
      ind("Capturadas hoje", capturadasHoje, "maps", { detalhe: `${plural(campanha.buscas.length, "segmento", "segmentos")} em ${plural(cidades, "cidade", "cidades")}` }),
      ind("Para aprovar", aprovar, "rascunho", { tom: aprovar ? "atencao" : "" }),
      ind("Na fila de envio", s.filaEmpresas ?? 0, "aprovada"),
      ind("Enviadas hoje", s.enviadasHoje, "enviada", { detalhe: `${s.enviadasHojePorCanal.email} por e-mail · ${s.enviadasHojePorCanal.whatsapp} por WhatsApp` }),
      ind("Com erro", comErro, "erro", { tom: comErro ? "perigo" : "" }),
    ],
    atencao: [
      ...seVier(comErro, alerta("perigo", `${plural(comErro, "mensagem", "mensagens")} com erro no envio`, "erro", { detalhe: "Corrija e tente de novo, ou descarte." })),
      ...seVier(aprovar, alerta("atencao", `${plural(aprovar, "sequência", "sequências")} para aprovar`, "rascunho", { detalhe: "Nada sai sem a sua aprovação." })),
    ],
  };
}

async function fornecedores() {
  const lista = (await db.fornecedoresSalvos()).map(comIntegracoes);
  const conta = (f) => lista.filter(f).length;
  return {
    indicadores: [
      ind("Salvos", lista.length, "fornecedores"),
      ind("Novos para avaliar", conta((f) => f.status === "novo"), "fornecedores"),
      ind("Aprovados", conta((f) => f.status === "aprovado"), "fornecedores", { tom: "ok" }),
      ind("Com API", conta((f) => f.integracoes.api.status === "sim"), "fornecedores"),
    ],
    atencao: [],
  };
}

/** Pedidos dos últimos 15 dias em todas as contas. Conta com erro fica de fora, sem esconder as outras. */
async function pedidosRecentes(ml, sp, agora) {
  const leituras = await Promise.allSettled([
    ...ml.contas.map((conta) => mercadolivre.pedidosRecentes(conta.id)),
    ...sp.lojas.map((loja) => shopee.pedidosRecentes(loja.id)),
  ]);
  const lidas = leituras.filter((l) => l.status === "fulfilled");
  if (!lidas.length) throw new Error("nenhuma conta respondeu");
  const desde = +agora - 15 * 86_400_000;
  return lidas.flatMap((l) => l.value).filter((p) => !p.criadoEm || new Date(p.criadoEm) >= desde).length;
}

async function marketplaces(c, agora) {
  const ml = await mercadolivre.statusDaConexao();
  const sp = await shopee.statusDaConexao();
  const perguntas = await db.perguntasML("pendente");
  const produtos = await db.produtosCadastrados();
  const contas = ml.contas.length + sp.lojas.length;
  const pedidos = contas ? await guardado("pedidos", PEDIDOS_VALIDOS_MS, () => pedidosRecentes(ml, sp, agora)) : 0;
  const comErro = [...ml.contas.filter((x) => x.erro).map((x) => `Mercado Livre: ${x.apelido ?? x.id}`), ...sp.lojas.filter((x) => x.erro).map((x) => `Shopee: ${x.nome}`)];
  return {
    indicadores: [
      ind("Perguntas para responder", perguntas.length, "marketplaces", { tom: perguntas.length ? "atencao" : "" }),
      ind("Pedidos em 15 dias", pedidos === SEM_RESPOSTA ? null : pedidos, "marketplaces", { detalhe: pedidos === SEM_RESPOSTA ? "As lojas não responderam agora" : null }),
      ind("Produtos cadastrados", produtos.length, "marketplaces", { detalhe: `${produtos.filter((p) => p.publicacoes.some((x) => x.externo_id)).length} publicados` }),
      ind("Contas conectadas", contas, "marketplaces", { tom: comErro.length ? "perigo" : "", detalhe: `${ml.contas.length} no Mercado Livre · ${sp.lojas.length} na Shopee` }),
    ],
    atencao: [
      ...seVier(comErro.length, alerta("perigo", "Marketplace precisa ser reconectado", "marketplaces", { detalhe: comErro.join(" · ") })),
      ...seVier(perguntas.length, alerta("atencao", `${plural(perguntas.length, "pergunta", "perguntas")} no Mercado Livre para responder`, "marketplaces")),
    ],
  };
}

async function conversas(c) {
  const lista = await c.conversas();
  const funil = await db.funilDeConversas();
  const s = await c.stats();
  const i = indicadoresDasConversas(lista, funil);
  return {
    indicadores: [
      ind("Precisam de você", i.precisamDeVoce, "respostas", { tom: i.precisamDeVoce ? "perigo" : "" }),
      ind("Não lidas", s.respostasNaoLidas, "respostas", { tom: s.respostasNaoLidas ? "atencao" : "" }),
      ind("Em andamento", i.ativas, "respostas", { tom: "acc" }),
      ind("Chance alta de fechar", i.quentes, "respostas", { tom: "ok" }),
      ind("Reuniões agendadas", i.agendadas, "respostas", { tom: "ok" }),
      ind("Taxa de resposta", `${i.taxaResposta}%`, "respostas", { detalhe: `${funil.responderam ?? 0} de ${plural(funil.contatadas ?? 0, "contatada", "contatadas")}` }),
    ],
    atencao: seVier(i.precisamDeVoce, alerta("perigo", `${plural(i.precisamDeVoce, "conversa precisa", "conversas precisam")} de você`, "respostas", { detalhe: "A IA parou e está esperando a sua resposta." })),
  };
}

async function empresas(c) {
  const s = await c.stats();
  const de = (...status) => status.reduce((t, st) => t + (s.leads[st] ?? 0), 0);
  return {
    indicadores: [
      ind("Capturadas", Object.values(s.leads).reduce((a, b) => a + b, 0), "leads"),
      ind("Em andamento", de("novo", "analisado", "proposta_gerada", "contatado", "respondeu", "agendado"), "leads", { tom: "acc" }),
      ind("Interessadas", (s.respostas.interessado ?? 0) + (s.respostas.quer_informacoes ?? 0), "leads", { tom: "ok" }),
      ind("Clientes fechados", de("fechado"), "leads", { tom: "ok" }),
      ind("Descartadas", de("sem_interesse", "descartado", "descadastrado"), "leads", { detalhe: `${s.descadastros} descadastro${s.descadastros === 1 ? "" : "s"}` }),
    ],
    atencao: [],
  };
}

async function contratos() {
  const lista = await db.listarContratos();
  const parcelas = await cobrancas.painelDeCobrancas();
  const vendas = await entrada.painelDeVendas();
  const conta = (st) => lista.filter((x) => x.status === st).length;
  const { recebidoNoMes, aReceber, emAtraso } = parcelas.resumo;
  const aguardando = conta("enviado");
  return {
    indicadores: [
      ind("Aguardando assinatura", aguardando, "contratos", { tom: aguardando ? "atencao" : "" }),
      ind("Assinados", conta("assinado"), "contratos", { tom: "ok", detalhe: `${plural(conta("rascunho"), "rascunho", "rascunhos")}` }),
      ind("Recebido no mês", emReais(recebidoNoMes + vendas.recebidoNoMes), "contratos", { aba: "cobrancas", tom: "ok" }),
      ind("A receber", emReais(aReceber), "contratos", { aba: "cobrancas", detalhe: vendas.mensalidades ? `${emReais(vendas.mensalidades)} por mês em assinaturas` : null }),
      ind("Em atraso", emReais(emAtraso), "contratos", { aba: "cobrancas", tom: emAtraso ? "perigo" : "" }),
    ],
    atencao: seVier(emAtraso, alerta("perigo", `${emReais(emAtraso)} em cobranças atrasadas`, "contratos", { aba: "cobrancas" })),
  };
}

/** Quando sai o próximo post, e os posts de hoje que deviam ter saído e não saíram. */
export function situacaoDosPosts(posts, conf, agora = new Date()) {
  const { dia, minutos } = agoraEmBrasilia(agora);
  const saiu = (p) => p.status === "postado" || Boolean(p.instagram_id);
  const deHoje = posts.filter((p) => p.dia === dia);
  const horarios = conf.horarios ?? [];
  const proxima = horarios.find((h) => h * 60 > minutos);
  const limiteDosFalhos = agoraEmBrasilia(new Date(+agora - DIAS_DE_POST_FALHO * 86_400_000)).dia;
  return {
    proximo: !conf.ativo ? null : proxima != null ? { quando: `Hoje às ${proxima}h`, post: deHoje.find((p) => p.horario === proxima) ?? null } : horarios.length ? { quando: `Amanhã às ${horarios[0]}h`, post: null } : null,
    saiuHoje: deHoje.filter(saiu).length,
    // Só conta como atrasado o horário que já passou há um tempo: o Reels leva alguns minutos para ficar pronto.
    atrasados: !conf.ativo || !conf.postarSozinho ? [] : horarios.filter((h) => minutos > h * 60 + ATRASO_DO_POST_MIN && !deHoje.some((p) => p.horario === h && saiu(p))),
    falhosHoje: deHoje.filter((p) => !saiu(p) && p.instagram_erro),
    naoSairam: posts.filter((p) => !saiu(p) && p.dia < dia),
    falhosRecentes: posts.filter((p) => !saiu(p) && p.dia < dia && p.dia >= limiteDosFalhos && p.instagram_erro),
    falhosNoTiktok: deHoje.filter((p) => p.tiktok_erro && !p.tiktok_id && !p.tiktok_publicacao),
  };
}

async function redes(c, agora) {
  const conf = await lerConfigConteudo(agora);
  const plano = await lerPlano();
  const posts = await db.postsRecentes(14);
  const insights = await desempenho({ agora });
  const insta = await statusDoInstagram();
  const resumoDirect = await db.resumoDosDirects();
  const lista = await c.conversas();
  const directsHoje = await db.enviadasHoje("instagram", { primeiroContato: true });
  const p = situacaoDosPosts(posts, conf, agora);
  const noDirect = new Map(resumoDirect.map((r) => [r.lead_id, r]));
  const directs = lista.filter((x) => noDirect.has(x.id));
  const directPedeVoce = directs.filter((x) => x.andamento.precisaDeVoce).length;
  const recusados = resumoDirect.reduce((t, r) => t + r.recusados, 0);
  const horas = (lista) => lista.map((h) => `${h}h`).join(", ").replace(/, ([^,]*)$/, " e $1");
  const planoPelaIA = conf.horariosPelaIA && plano?.horarios?.length;
  const tokenAcabando = insta.expiraEm && new Date(insta.expiraEm) - agora < TOKEN_ACABANDO_MS;
  const problemas = p.atrasados.length + p.falhosHoje.length;
  return {
    indicadores: [
      ind("Próximo post", p.proximo?.quando ?? "Desligado", "conteudo", { aba: "posts", tom: p.proximo ? "acc" : "", detalhe: p.proximo?.post ? `${p.proximo.post.formato === "reels" ? "Reels" : "Carrossel"} já criado` : null }),
      ind("Saíram hoje", `${p.saiuHoje} de ${conf.horarios.length}`, "conteudo", { aba: "posts", tom: problemas ? "perigo" : p.saiuHoje ? "ok" : "" }),
      ind("Plano de posts", `${conf.horarios.length} por dia`, "conteudo", { aba: "config", detalhe: `${planoPelaIA ? "A IA decide" : "Horários fixos"}: ${horas(conf.horarios)}` }),
      ind("Não saíram", p.naoSairam.length, "conteudo", { aba: "posts", tom: p.naoSairam.length ? "atencao" : "", detalhe: "Dos últimos 14 posts" }),
      ind("Seguidores", insights.conta?.seguidores ?? null, "conteudo", { aba: "desempenho" }),
      ind("Alcance médio", insights.medias?.alcance ?? null, "conteudo", { aba: "desempenho", detalhe: insights.medias ? `${insights.medias.engajamento}% de engajamento em ${plural(insights.analisados, "post", "posts")}` : "Ainda sem posts medidos" }),
      ind("Conversas no direct", directs.length, "conteudo", { aba: "direct", tom: directPedeVoce ? "perigo" : "", detalhe: `${plural(directPedeVoce, "precisa", "precisam")} de você · ${directsHoje} de ${pipeline.LIMITE_DIRECT_DIA} novos hoje${recusados ? ` · ${plural(recusados, "recusado", "recusados")}` : ""}` }),
    ],
    atencao: [
      ...seVier(!insta.conectado, alerta("perigo", "Instagram desconectado: os posts não estão saindo", "conteudo", { aba: "config" })),
      ...seVier(insta.conectado && tokenAcabando, alerta("perigo", "O token do Instagram está para vencer", "conteudo", { aba: "config", detalhe: "Conecte de novo com o token estendido." })),
      // Instagram desconectado já explica os horários perdidos: um aviso só.
      ...p.atrasados.filter((h) => insta.conectado && !p.falhosHoje.some((x) => x.horario === h)).map((h) => alerta("perigo", `O post das ${h}h ainda não saiu`, "conteudo", { aba: "posts" })),
      ...p.falhosHoje.map((x) => alerta("perigo", `O post ${x.horario != null ? `das ${x.horario}h ` : "de hoje "}não saiu no Instagram`, "conteudo", { aba: "posts", detalhe: curto(x.instagram_erro) })),
      ...p.falhosNoTiktok.map((x) => alerta("atencao", `O post ${x.horario != null ? `das ${x.horario}h ` : "de hoje "}não saiu no TikTok`, "conteudo", { aba: "posts", detalhe: curto(x.tiktok_erro) })),
      ...seVier(p.falhosRecentes.length, alerta("atencao", `${plural(p.falhosRecentes.length, "post", "posts")} dos últimos dias não ${p.falhosRecentes.length === 1 ? "saiu" : "saíram"}`, "conteudo", { aba: "posts" })),
    ],
  };
}

async function automacao(c, agora) {
  const campanha = await c.campanha();
  const ultimaRodada = await db.lerEstado("ultima_rodada");
  const proximaNova = await pipeline.proximaEmpresaNovaEm();
  const emails = await db.enviadasHoje("email", { primeiroContato: true });
  const whats = await db.enviadasHoje("whatsapp", { primeiroContato: true });
  const limiteEmail = await pipeline.limiteDoDia(campanha, "email");
  const limiteWhats = (await c.whatsappRespondeu()) ? await pipeline.limiteDoDia(campanha, "whatsapp") : null;
  const ligado = campanha.automacao.ativo;
  const noHorario = pipeline.dentroDoHorario(campanha.limites, agora);
  const modoTeste = Boolean(config.modoTeste.email || config.modoTeste.whatsapp);
  const perfilIncompleto = !campanha.empresa.responsavel || !campanha.empresa.telefone;
  return {
    indicadores: [
      ind("Funil automático", ligado ? "Ligado" : "Desligado", "automacao", { tom: ligado ? "ok" : "", detalhe: campanha.automacao.respostaAutomatica ? "IA responde sozinha" : "Respostas com a sua aprovação" }),
      ind("Horário de envio", noHorario ? "Dentro" : "Fora", "automacao", { tom: noHorario ? "ok" : "", detalhe: `Das ${campanha.limites.horarioComercial.inicio}h às ${campanha.limites.horarioComercial.fim}h` }),
      ind("Novas por WhatsApp", `${whats}${limiteWhats != null ? ` de ${limiteWhats}` : ""}`, "automacao", { detalhe: proximaNova ? `Próxima às ${new Date(proximaNova).toLocaleTimeString("pt-BR", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit" })}` : "Hoje" }),
      ind("Novas por e-mail", `${emails} de ${limiteEmail}`, "automacao", { detalhe: "Hoje" }),
      ind("Última rodada", ultimaRodada ? tempoAtras(ultimaRodada, +agora) : "Nenhuma", "automacao"),
    ],
    atencao: [
      ...seVier(modoTeste, alerta("atencao", "Modo teste ligado: os envios vão para você, não para as empresas", "configuracoes")),
      ...seVier(perfilIncompleto, alerta("atencao", "Falta o responsável ou o telefone no perfil da empresa", "configuracoes")),
    ],
  };
}

// ---------- Serviços ----------

const servico = (nome, estado, tom, link, { detalhe = null, aba = null } = {}) => ({ nome, estado, tom, link, detalhe, aba });

async function servicosDoWhatsapp(c) {
  const modo = (await c.whatsappRespondeu()) ? await pipeline.modoWhatsapp() : null;
  const oficial = await whatsappOficial.obterConfig();
  const lista = [servico("WhatsApp oficial (Meta)", oficial.ativo ? "Ligado" : oficial.token ? "Desligado" : "Não configurado", oficial.ativo ? "ok" : "", "configuracoes")];
  const atencao = [];
  const numeros = await uazap.numeros();
  for (const [n, conectado] of await Promise.all(numeros.map(async (n) => [n, await comLimite(uazap.conectadoAgora(n.id)).catch(() => SEM_RESPOSTA)]))) {
    const nome = `UAZap · ${n.nome ?? "Número"}`;
    if (conectado === SEM_RESPOSTA) lista.push(servico(nome, "Sem resposta agora", "atencao", "automacao"));
    else if (conectado) lista.push(servico(nome, "Conectado", "ok", "automacao"));
    else {
      lista.push(servico(nome, "Desconectado", "perigo", "automacao"));
      atencao.push(alerta("perigo", `WhatsApp desconectado: ${n.nome ?? "número"}`, "automacao", { detalhe: "As mensagens ficam na fila até reconectar o número." }));
    }
  }
  if (await evolution.configurada()) {
    const conectado = await comLimite(evolution.conectadoAgora()).catch(() => SEM_RESPOSTA);
    lista.push(servico("Evolution API", conectado === SEM_RESPOSTA ? "Sem resposta agora" : conectado ? "Conectada" : "Desconectada", conectado === SEM_RESPOSTA ? "atencao" : conectado ? "ok" : "perigo", "automacao"));
    if (conectado === false && modo === "evolution") atencao.push(alerta("perigo", "WhatsApp desconectado na Evolution API", "automacao"));
  }
  if (modo === "manual") atencao.push(alerta("atencao", "Nenhum WhatsApp conectado: o envio está manual", "automacao"));
  return { lista, atencao };
}

/** Os avisos internos precisam de um e-mail válido: com o campo vazio ou errado, ninguém é avisado de nada. */
function servicosDeEmail() {
  const e = statusEmail();
  const avisosOk = /^[^\s@]+@[^\s@]+\.[^\s@]+/.test(String(e.notificar ?? "").trim());
  return {
    lista: [
      servico("E-mail (envio)", e.smtp.configurado ? "Configurado" : "Não configurado", e.smtp.configurado ? "ok" : "atencao", "automacao"),
      servico("E-mail (leitura de respostas)", e.imap.configurado ? "Configurado" : "Não configurado", e.imap.configurado ? "ok" : "atencao", "automacao"),
      servico("Avisos por e-mail", avisosOk ? "Com destinatário" : "Sem destinatário", avisosOk ? "ok" : "atencao", "configuracoes"),
    ],
    atencao: [
      ...seVier(!e.smtp.configurado, alerta("atencao", "O envio de e-mail não está configurado", "automacao")),
      ...seVier(!avisosOk, alerta("atencao", "Os avisos por e-mail não estão chegando", "configuracoes", { detalhe: "Falta um e-mail válido em NOTIFICAR_EMAIL, nas variáveis da Vercel." })),
    ],
  };
}

function situacaoDoSaldo(saldo, limites) {
  if (saldo === SEM_RESPOSTA || saldo == null) return { tom: "", estado: "Não deu para conferir", acabando: false, zerado: false };
  const { valor, moeda } = saldo;
  const zerado = valor <= 0;
  const acabando = !zerado && valor < limites[moeda];
  const quanto = moeda === "usd" ? valor.toLocaleString("pt-BR", { style: "currency", currency: "USD" }) : plural(valor, "crédito", "créditos");
  return { tom: zerado ? "perigo" : acabando ? "atencao" : "ok", estado: zerado ? "Sem saldo" : quanto, acabando, zerado };
}

async function servicosDeVideo() {
  const c = await lerConfigAvatar();
  await carregarChaveDaVoz();
  const voz = narracaoDisponivel();
  const lista = [servico("Voz dos Reels", voz[0].toUpperCase() + voz.slice(1), "ok", "conteudo", { aba: "config" })];
  const atencao = [];
  const [heygen, runway] = await Promise.all([
    c.chave ? guardado("heygen", CREDITOS_VALIDOS_MS, () => saldoDoHeygen(c.chave)) : null,
    c.runwayChave ? guardado("runway", CREDITOS_VALIDOS_MS, async () => ({ valor: await creditosDaRunway(c.runwayChave), moeda: "creditos" })) : null,
  ]);
  const h = situacaoDoSaldo(heygen, POUCO_SALDO.heygen);
  const r = situacaoDoSaldo(runway?.valor == null ? null : runway, POUCO_SALDO.runway);
  lista.push(servico("Avatar (HeyGen)", !c.chave ? "Sem chave" : !c.ativo ? "Desligado" : h.estado, c.chave && c.ativo ? h.tom : "", "conteudo", { aba: "config" }));
  lista.push(servico("Avatar reserva (Runway)", !c.runwayChave ? "Sem chave" : r.estado, c.runwayChave ? r.tom : "", "conteudo", { aba: "config" }));
  if (c.ativo && c.chave && (h.zerado || h.acabando)) {
    const reserva = c.runwayChave && !r.zerado ? "A Runway faz os clipes no lugar dele." : "Os Reels saem sem avatar, com a voz grátis.";
    atencao.push(alerta("atencao", h.zerado ? "HeyGen sem saldo" : `HeyGen com pouco saldo (${h.estado})`, "conteudo", { aba: "config", detalhe: h.zerado ? reserva : "Quando acabar, a reserva entra sozinha." }));
  }
  if (c.runwayChave && (r.zerado || r.acabando)) atencao.push(alerta("atencao", r.zerado ? "Runway sem saldo" : `Runway com pouco saldo (${r.estado})`, "conteudo", { aba: "config" }));
  return { lista, atencao };
}

async function servicoDoAgendador(agora) {
  const banco = await statusDoBanco();
  if (!banco.ativo) {
    return { lista: [servico("Agendador", "Desligado", "perigo", "automacao")], atencao: [alerta("perigo", "O agendador está desligado: nada roda sozinho", "automacao")] };
  }
  const execucoes = (banco.jobs ?? []).map((j) => j.ultimaExecucao).filter((u) => u?.end_time);
  const ultima = Math.max(0, ...execucoes.map((u) => +new Date(u.end_time)));
  const parado = !ultima || +agora - ultima > AGENDADOR_PARADO_MS;
  const falhas = execucoes.filter((u) => u.status === "failed").length;
  return {
    lista: [servico("Agendador", parado ? "Parado" : falhas ? `${plural(falhas, "tarefa falhou", "tarefas falharam")}` : "Funcionando", parado ? "perigo" : falhas ? "atencao" : "ok", "automacao", { detalhe: ultima ? `Última chamada ${tempoAtras(ultima, +agora)}` : null })],
    atencao: [
      ...seVier(parado, alerta("perigo", "O agendador parou de rodar", "automacao", { detalhe: ultima ? `Última chamada ${tempoAtras(ultima, +agora)}.` : "Ainda não houve nenhuma chamada." })),
      ...seVier(!parado && falhas, alerta("atencao", `${plural(falhas, "tarefa do agendador falhou", "tarefas do agendador falharam")} na última vez`, "automacao")),
    ],
  };
}

async function servicosDasContas() {
  const li = await linkedin.statusDaConexao();
  const tt = await tiktok.statusDaConexao();
  const ml = await mercadolivre.statusDaConexao();
  const sp = await shopee.statusDaConexao();
  const cal = await calendly.status();
  const cob = await asaas.situacao();
  const insta = await statusDoInstagram();
  const conectou = (nome, ok, link, aba = null) => servico(nome, ok ? "Conectado" : "Não conectado", ok ? "ok" : "", link, { aba });
  return {
    lista: [
      servico("Instagram", insta.conectado ? `@${insta.usuario}` : "Desconectado", insta.conectado ? "ok" : "perigo", "conteudo", { aba: "config" }),
      servico("LinkedIn", li.conectado ? "Conectado" : li.entrou ? "Falta escolher a página" : li.appDefinido ? "Aguardando aprovação" : "Não configurado", li.conectado ? "ok" : li.erro ? "perigo" : "", "conteudo", { aba: "config" }),
      servico("TikTok", tt.conectado ? (tt.usuario ? `@${tt.usuario}` : "Conectado") : tt.faltaPermissao ? "Falta permissão" : tt.entrou ? "Falta escolher quem vê" : tt.appDefinido ? "Falta entrar" : "Não configurado", tt.conectado ? "ok" : tt.faltaPermissao ? "atencao" : "", "conteudo", { aba: "config" }),
      conectou("Mercado Livre", ml.conectado, "marketplaces"),
      conectou("Shopee", sp.conectado, "marketplaces"),
      conectou("Cobranças (Asaas)", cob.conectado, "contratos", "cobrancas"),
      conectou("Calendly", cal.conectado, "automacao"),
    ],
    atencao: [
      ...seVier(li.erro && li.conectado, alerta("atencao", "O LinkedIn precisa de atenção", "conteudo", { aba: "config", detalhe: curto(li.erro) })),
      ...seVier(tt.faltaPermissao, alerta("atencao", "O TikTok precisa de mais uma permissão", "conteudo", { aba: "config" })),
    ],
  };
}

/** Um grupo de serviços com erro aparece como "não foi possível ler", sem levar os outros junto. */
async function servicos(c, agora) {
  const grupos = [];
  for (const [nome, link, ler] of [
    ["WhatsApp", "automacao", () => servicosDoWhatsapp(c)],
    ["E-mail", "automacao", async () => servicosDeEmail()],
    ["Vídeo e voz", "conteudo", servicosDeVideo],
    ["Agendador", "automacao", () => servicoDoAgendador(agora)],
    ["Contas conectadas", "configuracoes", servicosDasContas],
  ]) {
    grupos.push(await ler().catch((e) => {
      console.error(`⚠️  Dashboard, serviços (${nome}):`, e.message);
      return { lista: [servico(nome, "Não foi possível ler", "atencao", link)], atencao: [] };
    }));
  }
  return { servicos: grupos.flatMap((g) => g.lista), atencao: grupos.flatMap((g) => g.atencao) };
}

export const SETORES = [
  { id: "prospeccao", nome: "Prospecção", icone: "pin", link: "maps", ler: prospeccao },
  { id: "conversas", nome: "Conversas", icone: "message", link: "respostas", ler: conversas },
  { id: "empresas", nome: "Empresas", icone: "building", link: "leads", ler: empresas },
  { id: "contratos", nome: "Contratos e cobranças", icone: "file", link: "contratos", ler: contratos },
  { id: "redes", nome: "Redes sociais", icone: "camera", link: "conteudo", ler: redes },
  { id: "marketplaces", nome: "Marketplaces", icone: "store", link: "marketplaces", ler: marketplaces },
  { id: "fornecedores", nome: "Fornecedores", icone: "box", link: "fornecedores", ler: fornecedores },
  { id: "automacao", nome: "Automação", icone: "zap", link: "automacao", ler: automacao },
  { id: "servicos", nome: "Estado dos serviços", icone: "settings", link: "configuracoes", ler: servicos },
];

/**
 * Os setores, um de cada vez. Se a soma passar do orçamento, os que faltam ficam sem ler nesta rodada.
 * `setores` e `orcamentoMs` existem para os testes.
 */
export async function montarDashboard({ conversasAvaliadas, setores = SETORES, orcamentoMs = ORCAMENTO_MS, agora = new Date() }) {
  // Religar a função pode levar 20 s preparando o banco: isso não conta no orçamento.
  await db.iniciar();
  const inicio = Date.now();
  const c = leiturasCompartilhadas(conversasAvaliadas);
  const lidos = [];
  for (const { ler, ...setor } of setores) {
    const naoLido = { ...setor, indicadores: [], atencao: [], erro: "Não foi possível ler" };
    if (Date.now() - inicio > orcamentoMs) {
      console.error(`⚠️  Dashboard, ${setor.nome}: sem tempo para ler nesta rodada`);
      lidos.push(naoLido);
      continue;
    }
    try {
      const { atencao = [], ...resto } = await ler(c, agora);
      lidos.push({ ...setor, ...resto, atencao });
    } catch (e) {
      console.error(`⚠️  Dashboard, ${setor.nome}:`, e.message);
      lidos.push(naoLido);
    }
  }
  const peso = { perigo: 0, atencao: 1 };
  return {
    geradoEm: agora.toISOString(),
    atencao: lidos.flatMap((s) => s.atencao.map((a) => ({ ...a, setor: s.nome }))).sort((a, b) => peso[a.nivel] - peso[b.nivel]),
    setores: lidos.map(({ atencao, ...s }) => s),
  };
}

/** Várias abas abertas dividem a mesma leitura: quem chega com uma em andamento, ou recém-feita, recebe ela. */
export function dashboardDoPainel(opcoes) {
  return dashboardGuardada(() => montarDashboard(opcoes));
}
