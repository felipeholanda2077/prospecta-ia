import { config } from "../config.js";
import * as db from "../db.js";
import { escreverFollowup, pediuValor, semValores, valoresPermitidos } from "../ia/resposta.js";
import { enderecoDoGuia } from "../vendas/campanha.js";
import { momentoDaPrevia, semLinkDaPrevia, origemDaPrevia } from "../vendas/previa.js";
import { lerApresentacao } from "./apresentacao.js";
import { iaPausada } from "./processar.js";
import { contatosLigados } from "./contatoNovo.js";
import { variantesWhatsappBR } from "../analise/telefone.js";

// Follow-up da IA para quem mostrou interesse, ou está numa conversa morna ou quente (ex.: ficou de ver, ou de
// repassar para o responsável), e parou de responder: 1 dia depois da nossa última mensagem, a IA retoma de onde
// pararam, oferece um material de graça (o guia em PDF da empresa) ou pergunta se conseguiu falar com o responsável.
// Quem recebeu o link de pagamento e não pagou recebe o link de novo, com as formas de pagar (pedido de 18/11/2026).
// Sai no horário comercial do país da empresa (Portugal: o de Lisboa). No máximo
// MAX_SEGUIDOS seguidos sem resposta; quando a pessoa responde, a conversa volta ao normal e a conta zera.

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

const DIA_MS = 24 * 3600_000;
export const MAX_SEGUIDOS = 2;
// Conversa parada há mais tempo que isso já esfriou: o follow-up não vai (a campanha cuida dela).
const DIAS_MAXIMOS = 14;
const POR_RODADA = 3;
const CANAIS = ["whatsapp", "email"];
const chave = (leadId) => `followup_ia:${leadId}`;

/** Os follow-ups já mandados desde a última mensagem da pessoa: { n, desde, opcoes: ["retomar" | "material"] }. */
async function lerRegistro(leadId) {
  try {
    return JSON.parse((await db.lerEstado(chave(leadId))) || "null");
  } catch {
    return null;
  }
}

/**
 * Esta conversa pede follow-up agora? Retorna { canal, de, numero, opcao } ou null.
 * `historico` = db.historicoConversa(lead.id); `registro` = os follow-ups desde a última resposta dela.
 */
export function precisaDeFollowup({ historico, registro, pausada = "" }, agora = new Date()) {
  if (pausada) return null;
  const ultimaDela = [...historico].reverse().find((h) => h.autor === "lead");
  const ultima = historico.at(-1);
  if (!ultimaDela || !ultima || ultima.autor !== "nos") return null;
  if (!CANAIS.includes(ultima.canal)) return null; // direct do Instagram: a Meta só deixa responder em 24 h
  if (agora - new Date(ultima.quando) < DIA_MS) return null;
  if (agora - new Date(ultimaDela.quando) > DIAS_MAXIMOS * DIA_MS) return null;
  // A conta é por silêncio: se ela respondeu depois do último follow-up, recomeça.
  const valendo = registro && new Date(registro.desde) >= new Date(ultimaDela.quando) ? registro : null;
  const n = valendo?.n ?? 0;
  if (n >= MAX_SEGUIDOS) return null;
  // Alterna: um retoma a conversa, o outro oferece o material (o primeiro é o que a IA achar melhor).
  const usadas = valendo?.opcoes ?? [];
  return { canal: ultima.canal, de: ultimaDela.contato || ultima.contato, numero: n + 1, evitar: usadas.at(-1) ?? null };
}

/** O último link de pagamento (checkout da FluxDeck) que mandamos nesta conversa, ou "". */
export function linkDePagamento(historico = []) {
  for (const h of [...historico].reverse()) {
    if (h.autor !== "nos") continue;
    const achado = String(h.texto ?? "").match(/https?:\/\/[^\s]+\/checkout\/[^\s]+/);
    if (achado) return achado[0].replace(/[).,!?;:]+$/, "");
  }
  return "";
}

/**
 * Quando o follow-up sai: em alguns minutos, se for horário comercial no país da empresa (Portugal: o de Lisboa);
 * fora dele, no começo do próximo dia útil de lá (com alguns minutos de folga, como uma pessoa).
 */
export async function horarioDoFollowup(campanha, lead, agora = new Date()) {
  const logo = new Date(+agora + (2 + Math.random() * 6) * 60_000);
  const limites = campanha.limites;
  if (!limites?.horarioComercial) return logo;
  const { dentroDoHorario, inicioDoProximoDiaUtil, minutosAteOFim } = await import("../pipeline.js");
  const fuso = (lead.pais && lead.pais !== "BR" && lead.fuso) || config.timezone;
  if (dentroDoHorario(limites, logo, fuso) && minutosAteOFim(limites, logo, fuso) >= 15) return logo;
  return inicioDoProximoDiaUtil(limites, agora, { fuso });
}

/**
 * Rodada dos follow-ups (em horário comercial, dentro da rodada do funil): escolhe as conversas com
 * interesse e 1 dia sem resposta, a IA escreve e a mensagem entra na fila de respostas.
 */
export async function followupsDeInteressados(campanha, { limite = POR_RODADA, escrever = escreverFollowup, agora = new Date() } = {}) {
  if (!campanha.automacao?.respostaAutomatica || campanha.automacao?.followupInteressados === false) return { criados: 0 };
  let criados = 0;
  for (const lead of await db.interessadosParaFollowup(agora.toISOString())) {
    if (criados >= limite) break;
    const historico = await db.historicoConversa(lead.id);
    const registro = await lerRegistro(lead.id);
    const plano = precisaDeFollowup({ historico, registro, pausada: await iaPausada(lead.id) }, agora);
    if (!plano) continue;
    try {
      // A prévia que você viu no painel é a que sai (mesma conversa, mesmo número de follow-up); sem prévia, a IA escreve agora.
      const vista = await lerPreviaGuardada(lead.id, historico, plano);
      const f = await prepararFollowup({ lead, historico, campanha, plano, escrever, pronta: vista });
      if (!f) continue;
      const id = await db.criarMensagem({
        lead_id: lead.id, canal: f.canal, destino: f.destino, assunto: f.assunto,
        corpo: f.corpo, status: "aprovada", tipo: "resposta", etapa: 0, em_resposta_a: f.em_resposta_a, followup: plano.numero,
      });
      // Alguns minutos, como uma pessoa, no horário comercial do país da empresa (fora dele, no começo do próximo dia útil de lá).
      const horario = await horarioDoFollowup(campanha, lead, agora);
      const marcado = vista?.quando && new Date(vista.quando) > horario ? new Date(vista.quando) : horario;
      await db.atualizarMensagem(id, { agendada_para: marcado.toISOString() });
      await db.gravarEstado(chave(lead.id), JSON.stringify({
        n: plano.numero, desde: new Date().toISOString(), opcoes: [...((registro && plano.numero > 1 ? registro.opcoes : []) ?? []), f.opcao],
      }));
      if (vista) await db.gravarEstado(chavePrevia(lead.id), "");
      criados++;
      log(`🔔 Follow-up ${plano.numero} de ${MAX_SEGUIDOS} para ${lead.nome} (${{ material: "com o guia gratuito", responsavel: "perguntando pelo responsável", previa: "com a prévia do site", pagamento: "retomando o link de pagamento" }[f.opcao] ?? "retomando a conversa"})`);
    } catch (e) {
      log(`⚠️  Follow-up de ${lead.nome} não saiu: ${e.message}`);
    }
  }
  return { criados };
}

/**
 * O follow-up desta conversa (texto, canal e para quem vai), sem gravar nada: a mesma lógica serve para o envio e
 * para a prévia do painel. `pronta` = o texto já escrito na prévia ({ opcao, corpo }), para não escrever de novo.
 * Retorna null quando não há o que mandar.
 */
async function prepararFollowup({ lead, historico, campanha, plano, escrever = escreverFollowup, pronta = null }) {
  // Responde no mesmo canal e para o mesmo contato da última mensagem dela (no e-mail, na mesma conversa).
  const dela = await db.ultimaRespostaDaConversa(lead.id);
  if (!dela || !CANAIS.includes(dela.canal)) return null;
  // No WhatsApp, para quem falou por último: depois de escrevermos para a pessoa que a empresa indicou, o
  // follow-up é com ela, não com quem passou o contato.
  const ultimoWa = dela.canal === "whatsapp" ? historico.filter((h) => h.canal === "whatsapp" && h.contato).at(-1) : null;
  const envio = {
    canal: dela.canal, destino: ultimoWa?.contato || dela.de || (dela.canal === "email" ? lead.email : lead.whatsapp),
    assunto: dela.canal === "email" ? (/^re:/i.test(dela.assunto ?? "") ? dela.assunto : `Re: ${dela.assunto ?? lead.nome}`) : null,
    em_resposta_a: dela.canal === "email" ? dela.origem_id : null,
  };
  if (pronta?.corpo) return { ...envio, opcao: pronta.opcao, corpo: pronta.corpo };
  // Prévia do site: só para empresa sem site, quando a conversa tocou em presença online e o link ainda não foi.
  const linkPrevia = momentoDaPrevia({ lead, historico, origem: origemDaPrevia(campanha) });
  // Recebeu o link de pagamento e não pagou (quem paga vira "fechado" e sai desta lista): o follow-up retoma o link.
  const linkPagamento = linkDePagamento(historico);
  // Para quem vai: a pessoa indicada que ainda não respondeu recebe um follow-up escrito para ela.
  const indicado = ultimoWa?.autor === "nos" ? (await contatosLigados(lead.id)).find((c) => variantesWhatsappBR(c.numero).includes(String(ultimoWa.contato).replace(/\D/g, ""))) : null;
  const r = await escrever({
    lead, historico, campanha, canal: dela.canal, numero: plano.numero, evitar: plano.evitar, contatoIndicado: indicado ?? null,
    apresentacao: await lerApresentacao(lead), linkMaterial: enderecoDoGuia(lead), linkPrevia, linkPagamento,
  });
  let corpo = pediuValor(dela.texto, historico) ? r.mensagem : semValores(r.mensagem, { manter: valoresPermitidos(lead) });
  if (!linkPrevia || !corpo?.includes(linkPrevia)) corpo = semLinkDaPrevia(corpo);
  if (!corpo?.trim()) return null;
  return { ...envio, opcao: r.opcao, corpo: corpo.trim() };
}

// ---------- A prévia do follow-up no painel (pedido de 18/11/2026) ----------

const chavePrevia = (leadId) => `followup_previa:${leadId}`;
/** A marca da conversa para a prévia: a nossa última mensagem e o número do follow-up (mudou = a prévia não vale mais). */
const marcaDaConversa = (historico, plano) => `${historico.at(-1)?.quando ?? ""}#${plano.numero}`;

async function lerPreviaGuardada(leadId, historico, plano) {
  try {
    const p = JSON.parse((await db.lerEstado(chavePrevia(leadId))) || "null");
    return p && p.marca === marcaDaConversa(historico, plano) ? p : null;
  } catch {
    return null;
  }
}

/**
 * A prévia do próximo follow-up desta conversa, sem enviar nada: o texto exato (a mesma lógica do envio, e o envio
 * usa este mesmo texto) e a partir de quando sai (1 dia depois da nossa última mensagem, no horário comercial do país
 * da empresa). Fica guardada até a conversa mudar; `refazer` pede outro texto à IA.
 * Retorna { numero, de, quando, canal, destino, opcao, texto } ou { motivo } quando não há follow-up previsto.
 */
export async function previaDoFollowup(leadId, campanha, { refazer = false, soGuardada = false, escrever = escreverFollowup, agora = new Date() } = {}) {
  const lead = await db.buscarLead(leadId);
  if (!lead) throw new Error("Empresa não encontrada");
  if (!campanha.automacao?.respostaAutomatica || campanha.automacao?.followupInteressados === false) return { motivo: "O follow-up da IA está desligado em Automação" };
  if (lead.agente_id) return { motivo: "Esta conversa está com um agente: o follow-up da IA não sai" };
  if (lead.status !== "respondeu") return { motivo: lead.status === "fechado" ? "Já pagou ou fechou: não há follow-up" : "Não há follow-up previsto para esta conversa" };
  const historico = await db.historicoConversa(lead.id);
  const ultima = historico.at(-1);
  if (!ultima || ultima.autor !== "nos") return { motivo: "A empresa está esperando a sua resposta: não há follow-up" };
  // Avalia no momento em que o follow-up vence (1 dia depois da nossa última mensagem).
  const vence = new Date(Math.max(+agora, +new Date(ultima.quando) + DIA_MS));
  const plano = precisaDeFollowup({ historico, registro: await lerRegistro(lead.id), pausada: await iaPausada(lead.id) }, vence);
  if (!plano) return { motivo: "Não há follow-up previsto para esta conversa (já foram os 2 seguidos, a IA está parada ou a conversa esfriou)" };
  const guardada = refazer ? null : await lerPreviaGuardada(lead.id, historico, plano);
  // `soGuardada`: a que já foi escrita (para abrir a conversa na hora, sem esperar a IA); sem ela, null.
  if (soGuardada && !guardada) return null;
  const f = await prepararFollowup({ lead, historico, campanha, plano, escrever, pronta: guardada });
  if (!f) return { motivo: "A IA não tem o que mandar nesta conversa" };
  const quando = guardada?.quando ?? (await horarioDoFollowup(campanha, lead, vence)).toISOString();
  if (!guardada) await db.gravarEstado(chavePrevia(lead.id), JSON.stringify({ marca: marcaDaConversa(historico, plano), opcao: f.opcao, corpo: f.corpo, quando }));
  return { numero: plano.numero, de: MAX_SEGUIDOS, quando, canal: f.canal, destino: f.destino, opcao: f.opcao, texto: f.corpo };
}

// ---------- O site de exemplo para quem já tinha mostrado interesse (pedido de 17/11/2026) ----------

const PREVIAS_POR_RODADA = 2;
const ESPERA_DEPOIS_DA_NOSSA_MS = 2 * 3600_000;

/** A mensagem com o site de exemplo, no português de cada país (conversa já começada: sem bom dia de novo). */
export function mensagemDaPrevia(lead, link) {
  return lead.pais === "PT"
    ? `Lembrei-me de vocês e preparei um exemplo de como ficaria o site do ${lead.nome}, já com as vossas fotos, os serviços e as avaliações do Google:\n${link}\nDiga-me o que acha!`
    : `Lembrei de vocês e montei um exemplo de como ficaria o site da ${lead.nome}, já com as fotos, os serviços e as avaliações do Google:\n${link}\nMe conta o que achou!`;
}

/**
 * Quem mostrou interesse antes e ainda não recebeu o site de exemplo recebe agora, pela fila de respostas (poucos
 * por rodada). Só empresa sem site do Brasil ou de Portugal, com a conversa parada do nosso lado (a última mensagem é
 * nossa, há 2 horas ou mais), sem recusa, sem dizer que já tem site e com a IA ligada nessa conversa.
 */
export async function previasParaInteressados(campanha, { limite = PREVIAS_POR_RODADA, agora = new Date() } = {}) {
  if (!campanha.automacao?.respostaAutomatica) return { criadas: 0 };
  let criadas = 0;
  for (const lead of await db.interessadosSemPrevia()) {
    if (criadas >= limite) break;
    if (await iaPausada(lead.id)) continue;
    const historico = await db.historicoConversa(lead.id);
    const ultima = historico.at(-1);
    if (!ultima || ultima.autor !== "nos" || +agora - +new Date(ultima.quando) < ESPERA_DEPOIS_DA_NOSSA_MS) continue;
    const dela = await db.ultimaRespostaDaConversa(lead.id);
    if (!dela || !["whatsapp", "email"].includes(dela.canal)) continue;
    const link = momentoDaPrevia({ lead, historico, texto: dela.texto, origem: origemDaPrevia(campanha) });
    if (!link) continue;
    const ultimoContato = dela.canal === "whatsapp" ? historico.filter((h) => h.canal === "whatsapp" && h.contato).at(-1)?.contato : null;
    const id = await db.criarMensagem({
      lead_id: lead.id, canal: dela.canal, destino: ultimoContato || dela.de || (dela.canal === "email" ? lead.email : lead.whatsapp),
      assunto: dela.canal === "email" ? (/^re:/i.test(dela.assunto ?? "") ? dela.assunto : `Re: ${dela.assunto ?? lead.nome}`) : null,
      corpo: mensagemDaPrevia(lead, link), status: "aprovada", tipo: "resposta", etapa: 0,
      em_resposta_a: dela.canal === "email" ? dela.origem_id : null,
    });
    await db.atualizarMensagem(id, { agendada_para: new Date(+agora + (2 + Math.random() * 6) * 60_000).toISOString() });
    criadas++;
    log(`🌐 Site de exemplo para ${lead.nome} (mostrou interesse antes)`);
  }
  return { criadas };
}

/**
 * Para o painel: o próximo follow-up de uma conversa, com os dados que a lista de conversas já tem.
 * Retorna { quando, numero, de } (sai a partir de `quando`, na rodada em horário comercial), { fim: true, de }
 * quando já foram os MAX_SEGUIDOS sem resposta, ou null quando não se aplica.
 * `ultima` = última mensagem da conversa ({ autor, quando, canal }); `ultimaDela` = quando a empresa escreveu por último.
 */
export function previsaoDoFollowup({ interessado, status, agenteId = null, ultima, ultimaDela, pausada = "", temFila = false, registro = null }, agora = new Date()) {
  if (!interessado || agenteId || status !== "respondeu" || pausada || temFila || !ultima || !ultimaDela) return null;
  if (ultima.autor !== "nos" || !CANAIS.includes(ultima.canal)) return null;
  const quando = new Date(new Date(ultima.quando).getTime() + DIA_MS);
  if (quando - new Date(ultimaDela) > DIAS_MAXIMOS * DIA_MS) return null;
  const valendo = registro && new Date(registro.desde) >= new Date(ultimaDela) ? registro : null;
  const n = valendo?.n ?? 0;
  if (n >= MAX_SEGUIDOS) return { fim: true, de: MAX_SEGUIDOS };
  return { quando: quando.toISOString(), numero: n + 1, de: MAX_SEGUIDOS, atrasado: quando < agora };
}

/** Os registros de follow-up de várias conversas de uma vez (uma leitura só), por id da empresa. */
export async function registrosDeFollowup() {
  const linhas = await db.consultar("SELECT chave, valor FROM estado WHERE chave LIKE 'followup_ia:%'");
  const mapa = new Map();
  for (const l of linhas) {
    try { mapa.set(Number(l.chave.split(":")[1]), JSON.parse(l.valor)); } catch { /* registro estragado: ignora */ }
  }
  return mapa;
}
