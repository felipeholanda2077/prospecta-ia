const NICHOS_VAREJO =
  /loja|boutique|moda|roupa|cal[cç]ado|pet ?shop|farm[aá]cia|perfumaria|cosm[eé]tico|m[oó]veis|decora|materia(l|is) de constru|papelaria|[oó]tica|joalheria|suplemento|distribuidora|atacad|padaria|confeitaria|doceria|floricultura|brinquedo|eletr[oô]nico|autope[cç]a/i;

const NICHOS_AGENDA =
  /cl[ií]nica|odonto|dentista|consult[oó]rio|m[eé]dic|fisioterap|psic[oó]log|nutricion|est[eé]tica|sal[aã]o|barbearia|manicure|spa|academia|personal|pet ?shop|veterin[aá]ri|oficina|lava ?jato|tatuagem|studio|est[uú]dio/i;

const NICHOS_GESTAO =
  /distribuidora|atacad|ind[uú]stria|f[aá]brica|transportadora|construtora|escola|curso|imobili[aá]ria|contabilidade|restaurante|oficina|cl[ií]nica/i;

/**
 * Para empresas que você escolheu no Maps e que já têm um site bom: em vez de
 * descartar, a abordagem vai por automação de atendimento e sistema sob medida.
 */
export function oportunidadesParaSiteBom(nicho = "") {
  const ops = [{ servico: "automacao", motivo: "a empresa já tem um bom site; dá para automatizar o atendimento e o WhatsApp", peso: 2 }];
  if (NICHOS_GESTAO.test(nicho)) ops.push({ servico: "sistema", motivo: "segmento que costuma se beneficiar de um sistema de gestão", peso: 1 });
  return ops;
}

/**
 * Transforma a auditoria do site em uma lista ordenada de oportunidades de venda.
 * Cada oportunidade aponta para um serviço do catálogo (config/campanha.json)
 * e traz o motivo concreto observado, que a IA usa para personalizar a proposta.
 */
export function identificarOportunidades(analise, nicho = "") {
  const ops = [];
  const add = (servico, motivo, peso) => ops.push({ servico, motivo, peso });
  const anoAtual = new Date().getFullYear();

  if (!analise?.temSite) {
    const insta = analise?.instagram;
    if (insta?.seguidores) {
      add("site", `a empresa atende pelo Instagram (@${insta.usuario}, ${insta.seguidores.toLocaleString("pt-BR")} seguidores), mas não tem um site próprio`, 10);
    } else if (analise?.apenasRedeSocial) {
      add("site", "a empresa usa apenas rede social como site, sem um endereço próprio", 10);
    } else {
      add("site", "a empresa não tem site cadastrado no Google", 10);
    }
    if (NICHOS_VAREJO.test(nicho)) add("ecommerce", "segmento de varejo que poderia vender online", 8);
    if (NICHOS_AGENDA.test(nicho)) add("agendamento", "segmento que trabalha com horários marcados", 7);
  } else if (analise.fora) {
    add("redesign", "o site informado no Google está fora do ar ou com erro", 10);
  } else if (!analise.bloqueadoPorRobots) {
    const problemas = [];
    if (!analise.https) problemas.push("sem cadeado de segurança (HTTPS)");
    if (!analise.responsivo) problemas.push("não se adapta bem ao celular");
    if (analise.lento) problemas.push(`demorou ${(analise.tempoRespostaMs / 1000).toFixed(1)}s para carregar`);
    if (analise.anoCopyright && analise.anoCopyright < anoAtual - 3)
      problemas.push(`rodapé com ano de ${analise.anoCopyright}, sinal de site desatualizado`);
    if (!analise.temDescricao) problemas.push("sem descrição para o Google (SEO)");
    if (analise.poucoConteudo) problemas.push("pouco conteúdo na página inicial");
    if (analise.construtor === "linktree" || analise.construtor === "google sites")
      problemas.push(`feito em ${analise.construtor}, com aparência pouco profissional`);

    if (problemas.length) add("redesign", problemas.join("; "), 5 + problemas.length);
    if (!analise.temLoja && NICHOS_VAREJO.test(nicho))
      add("ecommerce", "o site não tem loja virtual nem carrinho de compras", 8);
    if (!analise.temAgendamento && NICHOS_AGENDA.test(nicho))
      add("agendamento", "o site não oferece agendamento online", 7);
    if (!analise.temChat) add("automacao", "o site não tem WhatsApp ou chat para atendimento rápido", 4);
  }

  if (NICHOS_GESTAO.test(nicho)) add("sistema", "segmento que costuma se beneficiar de um sistema de gestão", 3);

  return ops.sort((a, b) => b.peso - a.peso);
}
