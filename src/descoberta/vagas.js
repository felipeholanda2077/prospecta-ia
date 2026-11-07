import { buscarNaSerpApi, cidadeSemUf, cortar, semAcento, localDaSerpApi } from "./anuncios.js";

// Empresas contratando para uma função que a FluxDeck resolve (social media, atendimento no WhatsApp, marketing,
// site, sistema): a dor está declarada na própria vaga. Vem das vagas do Google (Google Jobs, pela SerpApi), e o
// contato da empresa vem do Google Maps, pelo nome na cidade. Cada busca gasta 1 do plano da SerpApi.

/** As funções procuradas e o serviço da FluxDeck que responde a cada uma. */
export const FUNCOES = [
  { cargo: "atendente whatsapp", servico: "automacao", dor: "contratar gente para atender no WhatsApp" },
  { cargo: "recepcionista", servico: "agendamento", dor: "contratar recepcionista para atender e marcar horários" },
  { cargo: "social media", servico: "automacao", dor: "contratar alguém para postar e responder nas redes sociais" },
  { cargo: "desenvolvedor web", servico: "site", dor: "contratar desenvolvedor para o site" },
  { cargo: "analista de sistemas", servico: "sistema", dor: "contratar alguém para cuidar do sistema da empresa" },
  { cargo: "pré-vendas sdr", servico: "automacao", dor: "contratar gente para responder e qualificar contatos" },
];

// Agência de emprego, RH e plataforma de vagas não é o contratante.
const INTERMEDIARIO = /\b(recrutamento|recursos humanos|\brh\b|staffing|talent|empregos?|vagas|headhunter|consultoria de rh|selecao|seleção|terceiriza|temporarios)\b/i;

/** As vagas de uma função numa cidade: uma por empresa, sem agência de emprego. */
export function empresasDasVagas(vagas, funcao) {
  const porEmpresa = new Map();
  for (const v of vagas ?? []) {
    const nome = String(v.company_name ?? "").trim();
    if (!nome || INTERMEDIARIO.test(semAcento(nome))) continue;
    const chave = semAcento(nome).toLowerCase();
    if (porEmpresa.has(chave)) continue;
    porEmpresa.set(chave, {
      nome,
      vaga: {
        cargo: cortar(v.title ?? funcao.cargo, 120),
        funcao: funcao.cargo,
        servico: funcao.servico,
        dor: funcao.dor,
        publicada: v.detected_extensions?.posted_at ?? null,
        onde: cortar(v.via ?? "", 60).replace(/^via\s+/i, "") || null,
        local: cortar(v.location ?? "", 80) || null,
        link: v.share_link ?? null,
      },
    });
  }
  return [...porEmpresa.values()];
}

/**
 * Empresas contratando para as funções escolhidas numa cidade. Gasta 1 busca por função (até `maxBuscas`).
 * `funcoes` = índices de FUNCOES (padrão: as três primeiras).
 */
export async function buscarEmpresasContratando({ cidade, funcoes = [0, 1, 2], maxBuscas = 1, agora = new Date() } = {}) {
  const empresas = [];
  const avisos = [];
  let buscas = 0;
  for (const i of funcoes) {
    const funcao = FUNCOES[i];
    if (!funcao || buscas >= maxBuscas) continue;
    // Com o local da cidade, o Google procura as vagas de lá; sem ele, a cidade vai no texto da busca.
    const local = await localDaSerpApi(cidade);
    const { dados, aviso } = await buscarNaSerpApi({
      engine: "google_jobs", q: local ? funcao.cargo : `${funcao.cargo} ${cidadeSemUf(cidade)}`, ...(local ? { location: local } : {}), gl: "br", hl: "pt-br",
    }, { fonte: "vagas", agora });
    if (!dados) { avisos.push(aviso); break; }
    buscas++;
    for (const e of empresasDasVagas(dados.jobs_results, funcao)) {
      if (!empresas.some((x) => semAcento(x.nome).toLowerCase() === semAcento(e.nome).toLowerCase())) empresas.push(e);
    }
  }
  // O Google mistura vagas de cidades vizinhas: as que citam a cidade (no local ou no título) vêm primeiro,
  // e só elas entram na busca automática.
  const daCidade = semAcento(cidadeSemUf(cidade)).toLowerCase();
  for (const e of empresas) e.naCidade = Boolean(daCidade) && semAcento(`${e.vaga.local ?? ""} ${e.vaga.cargo}`).toLowerCase().includes(daCidade);
  empresas.sort((a, b) => Number(b.naCidade) - Number(a.naCidade));
  return { empresas, buscas, avisos };
}
