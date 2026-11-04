import { config } from "../config.js";
import * as db from "../db.js";
import { escreverReativacao, pediuValor, semValores } from "../ia/resposta.js";
import { enderecoDoGuia } from "../vendas/campanha.js";

// Reativação de quem recebeu a sequência inteira e nunca respondeu: depois de 30 dias de pausa, UMA mensagem
// diferente da primeira abordagem (outro canal quando der, algo de valor e a dor do ramo). Sem resposta em
// 7 dias, a empresa sai do funil (descartada) e fica anotado para voltar daqui a 6 meses.

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

const DIA_MS = 24 * 3600_000;
export const DIAS_DE_PAUSA = 30;
export const DIAS_PARA_ENCERRAR = 7;
export const DIAS_PARA_VOLTAR = 180;
const POR_RODADA = 4;
const POR_DIA = 15; // pouco por dia: protege o número de WhatsApp e a caixa de e-mail
const chave = (leadId) => `reativacao:${leadId}`;

async function lerRegistro(leadId) {
  try {
    return JSON.parse((await db.lerEstado(chave(leadId))) || "null");
  } catch {
    return null;
  }
}

/** A dor mais comum de cada ramo, para a mensagem falar do que a empresa vive no dia a dia. */
export function dorDoRamo(nicho) {
  const n = String(nicho ?? "").toLowerCase();
  if (/odonto|dent|cl[ií]nica|consult[oó]rio|m[eé]dic|est[eé]tica|fisio|psic|sa[uú]de/.test(n)) {
    return "paciente que chama no WhatsApp fora do horário e fica sem resposta, e consulta marcada que o paciente esquece (confirmação e lembrete)";
  }
  if (/concession|ve[ií]cul|carro|auto|moto|seminov|revenda/.test(n)) {
    return "estoque que não aparece no Google e cliente que pergunta de um carro e desiste porque a resposta demorou";
  }
  if (/roupa|moda|boutique|loja|cal[çc]ado|acess[oó]rio/.test(n)) {
    return "vender pelo Instagram sem perder pedido no direct, e ter uma loja virtual que vende sozinha";
  }
  return "atrair cliente novo pela internet e responder rápido quem chama";
}

/** Pontos concretos do site (da análise que o sistema já fez), para o mini diagnóstico. Nunca inventa. */
export function pontosDoSite(analise, nicho = "", agora = new Date()) {
  let a = analise;
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch { a = null; }
  }
  if (!a?.temSite || a.fora || a.bloqueadoPorRobots) return [];
  const n = String(nicho ?? "").toLowerCase();
  const pontos = [];
  if (a.https === false) pontos.push("o site abre sem o cadeado de segurança (https), e o navegador avisa o cliente que não é seguro");
  if (a.responsivo === false) pontos.push("o site não se ajusta ao celular, onde está a maioria dos clientes");
  if (a.lento) pontos.push("o site demora mais de 4 segundos para abrir, e muita gente desiste antes");
  if (a.temDescricao === false) pontos.push("falta a descrição que aparece embaixo do nome no Google");
  if (a.temChat === false) pontos.push("não há botão de WhatsApp nem chat no site para o cliente chamar na hora");
  if (a.temAgendamento === false && /odonto|dent|cl[ií]nica|consult|m[eé]dic|est[eé]tica/.test(n)) pontos.push("não dá para agendar consulta pelo site");
  if (a.temLoja === false && /roupa|moda|boutique|loja/.test(n)) pontos.push("o site não tem loja para vender online");
  if (a.anoCopyright && a.anoCopyright < agora.getFullYear() - 1) pontos.push(`o rodapé ainda mostra ${a.anoCopyright}, o que passa a impressão de site parado`);
  if (a.poucoConteudo) pontos.push("a página inicial tem pouco texto, e o Google entende pouco do que vocês fazem");
  return pontos.slice(0, 3);
}

/** Por onde vai a reativação: um canal que ainda não foi usado (e-mail, depois direct), ou o mesmo WhatsApp com outra abordagem. */
export function canalDaReativacao(lead, canaisUsados) {
  const usados = new Set(canaisUsados);
  if (lead.email && !usados.has("email")) return { canal: "email", destino: lead.email };
  if (lead.instagram && !usados.has("instagram")) return { canal: "instagram", destino: `@${String(lead.instagram).replace(/^@/, "")}` };
  if (lead.whatsapp) return { canal: "whatsapp", destino: lead.whatsapp };
  if (lead.email) return { canal: "email", destino: lead.email };
  return null;
}

/**
 * Rodada da reativação (dentro da rodada do funil). Escreve a mensagem de quem completou 30 dias sem resposta
 * e encerra quem não respondeu à reativação em 7 dias. Com o funil automático ligado a mensagem já vai para a
 * fila; desligado, fica em Aprovar mensagens.
 */
export async function rodadaDeReativacao(campanha, { escrever = escreverReativacao, agora = new Date(), limite = POR_RODADA } = {}) {
  if (campanha.automacao?.reativacao === false) return { criadas: 0, encerradas: 0 };
  const encerradas = await encerrarSemResposta(agora);
  let criadas = 0;
  const vagas = Math.min(limite, POR_DIA - (await db.reativacoesHoje()));
  if (vagas <= 0) return { criadas, encerradas };
  for (const lead of await db.paraReativar(new Date(agora - DIAS_DE_PAUSA * DIA_MS).toISOString())) {
    if (criadas >= vagas) break;
    if (await lerRegistro(lead.id)) continue; // uma reativação só por empresa
    const historico = await db.historicoConversa(lead.id);
    const via = canalDaReativacao(lead, historico.filter((h) => h.autor === "nos").map((h) => h.canal));
    if (!via || (await db.estaDescadastrado(via.destino))) continue;
    try {
      const r = await escrever({
        lead, canal: via.canal, campanha, historico, dor: dorDoRamo(lead.nicho),
        pontos: pontosDoSite(lead.analise, lead.nicho, agora), linkGuia: enderecoDoGuia(lead),
      });
      const corpo = pediuValor("", historico) ? r.mensagem : semValores(r.mensagem);
      if (!corpo?.trim()) continue;
      const id = await db.criarMensagem({
        lead_id: lead.id, canal: via.canal, destino: via.destino, assunto: via.canal === "email" ? r.assunto || `Um presente para a ${lead.nome}` : null,
        corpo: corpo.trim(), status: campanha.automacao?.ativo ? "aprovada" : "rascunho", tipo: "reativacao", etapa: 4,
      });
      await db.atualizarMensagem(id, { agendada_para: new Date(Date.now() + (2 + Math.random() * 10) * 60_000).toISOString() });
      await db.gravarEstado(chave(lead.id), JSON.stringify({ mensagemId: id, canal: via.canal, oferta: r.oferta, criadaEm: agora.toISOString() }));
      criadas++;
      log(`♻️  Reativação para ${lead.nome} por ${via.canal} (${r.oferta === "diagnostico" ? "mini diagnóstico do site" : "guia gratuito"})`);
    } catch (e) {
      log(`⚠️  Reativação de ${lead.nome} não saiu: ${e.message}`);
    }
  }
  return { criadas, encerradas };
}

/** Reativação enviada há 7 dias e nenhuma resposta: a empresa sai do funil, com a data para voltar (6 meses). */
async function encerrarSemResposta(agora) {
  let encerradas = 0;
  for (const r of await db.reativacoesSemResposta(new Date(agora - DIAS_PARA_ENCERRAR * DIA_MS).toISOString())) {
    const registro = await lerRegistro(r.lead_id);
    if (!registro || registro.encerradaEm) continue;
    const voltarEm = new Date(agora.getTime() + DIAS_PARA_VOLTAR * DIA_MS);
    await db.atualizarLead(r.lead_id, {
      status: "descartado",
      observacao: `Sem resposta à reativação; tentar de novo a partir de ${voltarEm.toLocaleDateString("pt-BR", { timeZone: config.timezone })}`,
    });
    await db.gravarEstado(chave(r.lead_id), JSON.stringify({ ...registro, encerradaEm: agora.toISOString(), voltarEm: voltarEm.toISOString() }));
    encerradas++;
  }
  return encerradas;
}
