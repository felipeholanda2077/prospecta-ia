import { z } from "zod";
import { config } from "../config.js";
import * as db from "../db.js";
import { gerarJson } from "../ia/cliente.js";

// Ramos em teste: a IA escolhe ramos novos que fazem sentido para os serviços da FluxDeck, eles entram na
// rotação da busca (nas mesmas cidades) e, com empresas suficientes contatadas, a IA fica com os que geram
// INTERESSE (não só resposta: há ramo que responde muito e quase nunca quer nada) e pausa os outros.
// Uma vez por dia; no máximo 2 ramos em teste ao mesmo tempo.

const log = (...args) => console.log(new Date().toLocaleTimeString("pt-BR", { timeZone: config.timezone }), ...args);

const CHAVE = "ramos_teste";
const ULTIMA_RODADA = "ramos_ultima_rodada";
const DIA_MS = 24 * 3600_000;
export const EM_TESTE_AO_MESMO_TEMPO = 2;
export const MIN_CONTATADAS = 20; // com isso já dá para comparar com os outros ramos
export const TAXA_BOA = 0.2; // responde 20% ou mais à primeira abordagem
export const TAXA_INTERESSE = 0.05; // 5% das contatadas se interessam (ex.: 1 em 20)
export const MAX_CONTATADAS_SEM_INTERESSE = 40; // responde bem, mas sem interesse: espera até aqui antes de pausar
export const DIAS_MAXIMOS = 30; // depois disso decide com o que tiver

const normal = (n) => String(n ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

export async function lerRamos() {
  return (await db.lerConfig(CHAVE))?.ramos ?? [];
}

/** Interessadas suficientes para aprovar: 5% das contatadas, e pelo menos 2. */
const interesseSuficiente = (contatadas, interessadas) => interessadas >= Math.max(2, Math.ceil(contatadas * TAXA_INTERESSE));

/**
 * O que fazer com um ramo em teste, pelo resultado dele: segue testando, aprovado (fica) ou pausado (sai).
 * Quem decide é o interesse; a resposta só dá mais tempo a um ramo que responde bem e ainda não gerou interesse.
 */
export function avaliarRamo(ramo, resultado = {}, agora = new Date()) {
  const contatadas = resultado.contatadas ?? 0;
  const responderam = resultado.responderam ?? 0;
  const interessadas = resultado.interessadas ?? 0;
  const taxa = contatadas ? responderam / contatadas : 0;
  const pct = `${Math.round(taxa * 100)}%`;
  const dias = (agora - new Date(ramo.desde)) / DIA_MS;
  const resumo = `${interessadas} se interessaram e ${pct} responderam em ${contatadas} contatadas`;
  if (contatadas >= MIN_CONTATADAS) {
    if (interesseSuficiente(contatadas, interessadas)) return { status: "aprovado", motivo: resumo };
    if (taxa >= TAXA_BOA && contatadas < MAX_CONTATADAS_SEM_INTERESSE && dias < DIAS_MAXIMOS) {
      return { status: "testando", motivo: `responde bem (${pct}), esperando interesse` };
    }
    return { status: "pausado", motivo: taxa >= TAXA_BOA ? `responde (${pct}), mas quase ninguém se interessa: ${resumo}` : `pouca resposta: ${resumo}` };
  }
  if (dias < DIAS_MAXIMOS) return { status: "testando", motivo: ramo.motivo };
  if (contatadas >= 8 && interessadas >= 1) return { status: "aprovado", motivo: `${resumo} (${DIAS_MAXIMOS} dias de teste)` };
  if ((resultado.capturadas ?? 0) < MIN_CONTATADAS) return { status: "pausado", motivo: `a busca achou poucas empresas (${resultado.capturadas ?? 0}) em ${DIAS_MAXIMOS} dias` };
  return { status: "pausado", motivo: `${resumo} (${DIAS_MAXIMOS} dias de teste)` };
}

const SugestaoSchema = z.object({ ramos: z.array(z.object({ nicho: z.string(), servico: z.string(), motivo: z.string() })) });
const SUGESTAO_JSON_SCHEMA = {
  type: "object",
  properties: {
    ramos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          nicho: { type: "string", description: "termo de busca no Google Maps, em português, minúsculo, 1 a 4 palavras (ex.: clínica de estética)" },
          servico: { type: "string", description: "o serviço da lista que mais resolve a dor desse ramo" },
          motivo: { type: "string", description: "uma frase: por que esse ramo deve responder e comprar" },
        },
        required: ["nicho", "servico", "motivo"],
        additionalProperties: false,
      },
    },
  },
  required: ["ramos"],
  additionalProperties: false,
};

/** A IA propõe ramos novos para testar, pelos serviços e pelo que já respondeu bem ou mal. */
export async function sugerirRamos({ campanha, quantos, resultados, evitar }) {
  const servicos = (campanha.servicos ?? []).map((s) => `- ${s.nome}: ${s.descricao}`).join("\n");
  const tabela = resultados.length
    ? resultados.map((r) => `- ${r.ramo}: ${r.contatadas} contatadas, ${r.contatadas ? Math.round((r.responderam / r.contatadas) * 100) : 0}% responderam, ${r.interessadas} interessadas (${r.contatadas ? Math.round((r.interessadas / r.contatadas) * 100) : 0}% de interesse)`).join("\n")
    : "(ainda sem resultados)";
  const cidades = [...new Set((campanha.buscas ?? []).flatMap((b) => b.cidades))].join(", ");
  const r = await gerarJson({
    system: `Você escolhe onde a ${campanha.empresa?.nome || "empresa"} vai prospectar. Ela vende para empresas locais:
${servicos}

A prospecção busca empresas no Google Maps e no CNPJ (em ${cidades || "cidades do Brasil"}) e manda a primeira mensagem pelo WhatsApp.
Proponha ${quantos} ramos NOVOS para testar. Cada ramo deve:
- Ser um tipo de negócio local com telefone ou WhatsApp, fácil de achar no Google Maps (o "nicho" é o termo da busca).
- Ter uma dor clara que um dos serviços resolve (ex.: agenda cheia de faltas → agendamento online; vende pelo Instagram → loja virtual).
- Ter dono acessível e dinheiro para investir (evite órgãos públicos, franquias grandes e redes nacionais).
- Ser diferente dos ramos já usados ou já testados (nem sinônimo, nem variação do mesmo ramo).
Use a tabela de resultados: o que importa é o INTERESSE (empresas que quiseram saber mais), não só a resposta. Prefira ramos
parecidos com os de maior % de interesse e fuja do perfil dos que respondem muito mas quase nunca se interessam.`,
    pedido: `Resultado por ramo até agora:
${tabela}

Ramos que você NÃO pode propor (já usados, em teste ou pausados):
${evitar.map((n) => `- ${n}`).join("\n") || "(nenhum)"}`,
    jsonSchema: SUGESTAO_JSON_SCHEMA,
    zodSchema: SugestaoSchema,
    effort: "low",
  });
  return r.ramos;
}

/**
 * Rodada dos ramos (dentro da rodada do funil automático, uma vez por dia): avalia os que estão em teste e,
 * se sobrar vaga, pede ramos novos à IA. Retorna o que mudou.
 */
export async function rodadaDeRamos(campanha, { sugerir = sugerirRamos, agora = new Date() } = {}) {
  if (campanha.automacao?.testarRamos === false) return { pulada: "teste de ramos desligado" };
  const ultima = Number(await db.lerEstado(ULTIMA_RODADA));
  if (ultima && agora.getTime() - ultima < 20 * 3600_000) return { pulada: "já rodou hoje" };
  await db.gravarEstado(ULTIMA_RODADA, String(agora.getTime()));

  const ramos = await lerRamos();
  const resultados = await db.resultadoPorRamo();
  const porRamo = new Map(resultados.map((r) => [normal(r.ramo), r]));
  const aprovados = [];
  const pausados = [];
  for (const ramo of ramos) {
    const resultado = porRamo.get(normal(ramo.nicho)) ?? {};
    ramo.resultado = { contatadas: resultado.contatadas ?? 0, responderam: resultado.responderam ?? 0, interessadas: resultado.interessadas ?? 0, capturadas: resultado.capturadas ?? 0 };
    if (ramo.status !== "testando") continue;
    const decisao = avaliarRamo(ramo, resultado, agora);
    if (decisao.status === "testando") continue;
    Object.assign(ramo, { status: decisao.status, decisao: decisao.motivo, decididoEm: agora.toISOString() });
    (decisao.status === "aprovado" ? aprovados : pausados).push(ramo.nicho);
    log(`🧪 Ramo "${ramo.nicho}" ${decisao.status === "aprovado" ? "aprovado: fica na busca" : "pausado: sai da busca"} (${decisao.motivo})`);
  }

  const novos = [];
  const vagas = EM_TESTE_AO_MESMO_TEMPO - ramos.filter((r) => r.status === "testando").length;
  if (vagas > 0) {
    const fixos = (campanha.buscas ?? []).map((b) => b.nicho);
    const evitar = [...new Set([...fixos, ...ramos.map((r) => r.nicho), ...resultados.map((r) => r.ramo)])];
    const usados = new Set(evitar.map(normal));
    for (const s of await sugerir({ campanha, quantos: vagas, resultados: resultados.filter((r) => r.contatadas > 0), evitar })) {
      const nicho = String(s.nicho ?? "").trim().toLowerCase().slice(0, 60);
      if (!nicho || usados.has(normal(nicho)) || novos.length >= vagas) continue;
      usados.add(normal(nicho));
      const ramo = { nicho, servico: String(s.servico ?? "").slice(0, 80), motivo: String(s.motivo ?? "").slice(0, 300), status: "testando", desde: agora.toISOString(), resultado: { contatadas: 0, responderam: 0, interessadas: 0, capturadas: 0 } };
      ramos.push(ramo);
      novos.push(nicho);
      log(`🧪 Ramo novo em teste: "${nicho}" (${ramo.servico})`);
    }
  }
  await db.gravarConfig(CHAVE, { ramos, atualizadoEm: agora.toISOString() });
  return { novos, aprovados, pausados };
}
