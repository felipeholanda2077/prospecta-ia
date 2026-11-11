import { analisarSite } from "../analise/site.js";
import { identificarOportunidades, oportunidadesParaSiteBom } from "../analise/oportunidades.js";
import { gerarSequencia } from "../ia/proposta.js";
import { classificarResposta } from "../ia/resposta.js";
import { lerApresentacao } from "../respostas/apresentacao.js";
import { PAISES, dadosDoPais } from "../internacional.js";

/**
 * Prévia para uma empresa de fora do Brasil, SEM salvar nada: analisa o site, escreve a sequência como a IA
 * escreveria e, com `pergunta`, a resposta da IA a essa pergunta (ex.: o preço). Nada vai para o funil nem
 * para a fila de envio: serve para conferir o idioma, o tom e os valores antes de ligar a busca lá fora.
 */
export async function previaParaEmpresaDeFora({ empresa, nicho, cidade, pais, idioma = "local", pergunta = "" }, campanha) {
  if (!PAISES[pais] || pais === "BR") throw new Error("Escolha um país de fora do Brasil");
  if (!empresa?.nome) throw new Error("Informe a empresa");
  const lead = {
    id: 0, nome: String(empresa.nome), nicho, cidade: `${cidade}, ${PAISES[pais].nome}`, site: empresa.site ?? null,
    avaliacao: empresa.avaliacao ?? null, total_avaliacoes: empresa.total_avaliacoes ?? null, origem: "maps",
    ...dadosDoPais(pais, idioma, { endereco: empresa.endereco, cidade }),
  };
  const analise = await analisarSite(lead.site);
  let oportunidades = identificarOportunidades(analise, nicho);
  if (!oportunidades.length) oportunidades = oportunidadesParaSiteBom(nicho);
  const seq = await gerarSequencia(lead, oportunidades, campanha);
  let resposta = null;
  if (pergunta) {
    const c = await classificarResposta({
      texto: pergunta, lead, campanha, canal: "whatsapp", apresentacao: await lerApresentacao(lead),
      historico: [{ autor: "nos", texto: seq.whatsapp[0], canal: "whatsapp" }],
    });
    resposta = c.sugestao_resposta ?? null;
  }
  return {
    empresa: lead.nome, pais, idioma: lead.idioma, fuso: lead.fuso, site: lead.site,
    oportunidades: oportunidades.map((o) => o.servico), resumo: seq.resumo_interno,
    assunto: seq.assunto_email, whatsapp: seq.whatsapp, email: seq.email, pergunta, resposta,
  };
}
