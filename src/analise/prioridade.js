// Prioridade de cada empresa: quem já está conversando e tem mais chance de fechar vem
// primeiro; entre as que ainda não responderam, as com mais potencial de venda.

// Perfil no Google só com rede social, página de links (bio), página de marcação de outra plataforma ou o perfil
// do Google conta como "sem site próprio": a empresa recebe o site de exemplo (pedido de 18/11/2026, o salão
// TA Cabeleireiros tinha só um bio.site e não recebeu).
export const SO_REDE_SOCIAL = new RegExp([
  "instagram\\.com", "facebook\\.com", "fb\\.com", "tiktok\\.com", "youtube\\.com", "wa\\.me", "wa\\.link", "api\\.whatsapp\\.com",
  "ifood\\.com", "linktr\\.ee", "bio\\.site", "linkin\\.bio", "lnk\\.bio", "bio\\.link", "linkr\\.bio", "beacons\\.ai",
  "taplink\\.", "campsite\\.bio", "solo\\.to", "msha\\.ke", "linkbio\\.", "allmylinks\\.com",
  "fresha\\.com", "booksy\\.com", "treatwell\\.", "business\\.site", "g\\.page",
].join("|"), "i");

export const semSiteProprio = (site) => !site || SO_REDE_SOCIAL.test(site);

// Sem site CONFIRMADO: a empresa do CNPJ não traz o site (o cadastro da Receita não informa), então lá "sem site" é
// só "não sabemos". Essas não vão para a frente da fila nem recebem a prévia de cara (abordagem principal).
export const semSiteConfirmado = (lead) => semSiteProprio(lead?.site) && lead?.origem !== "cnpj";

/**
 * Potencial de venda de uma empresa que ainda não respondeu (0 a 100), com os motivos.
 * Sem site é o principal (é o que a FluxDeck vende); muitas avaliações indicam um negócio
 * movimentado, que pode investir; WhatsApp confirmado garante que a mensagem chega.
 */
export function potencialDaEmpresa(l, { canais = [] } = {}) {
  let pontos = 0;
  const motivos = [];
  const somar = (n, motivo) => {
    pontos += n;
    motivos.push(motivo);
  };
  if (semSiteProprio(l.site)) somar(35, "sem site próprio");
  const avaliacoes = Number(l.total_avaliacoes) || 0;
  if (avaliacoes >= 200) somar(25, `${avaliacoes} avaliações no Google`);
  else if (avaliacoes >= 50) somar(15, `${avaliacoes} avaliações no Google`);
  else if (avaliacoes >= 10) somar(6, `${avaliacoes} avaliações no Google`);
  if (Number(l.avaliacao) >= 4.5) somar(10, `nota ${l.avaliacao}`);
  if (l.whatsapp_status === "verificado") somar(15, "WhatsApp confirmado");
  else if (l.whatsapp_status === "celular") somar(8, "celular");
  if (canais.includes("email") && canais.includes("whatsapp")) somar(10, "e-mail e WhatsApp");
  pontos = Math.min(100, pontos);
  return { pontos, nivel: pontos >= 55 ? "alta" : pontos >= 30 ? "media" : "baixa", motivos };
}

// Conversas vêm antes das empresas novas, pela chance de fechar.
const PESO_DA_CONVERSA = { agendada: 700, quente: 600, morna: 400, fria: 200, encerrada: -1000 };

/**
 * Prioridade de uma empresa na fila de envio. `andamento` vem da página de Respostas
 * (quando a empresa já respondeu); `temResposta` = há uma resposta da conversa para sair.
 * Retorna { pontos, nivel, rotulo, motivos } — quanto maior, mais para cima.
 */
export function prioridadeNaFila(lead, { andamento = null, temResposta = false, canais = [] } = {}) {
  const potencial = potencialDaEmpresa(lead, { canais });
  if (temResposta) {
    return { pontos: 1000 + potencial.pontos, nivel: "alta", rotulo: "Conversa em andamento", motivos: ["a empresa está esperando a resposta"] };
  }
  if (andamento) {
    const pontos = (PESO_DA_CONVERSA[andamento.chance] ?? 200) + potencial.pontos;
    const nivel = ["agendada", "quente"].includes(andamento.chance) ? "alta" : andamento.chance === "morna" ? "media" : "baixa";
    return { pontos, nivel, rotulo: `Respondeu · chance ${andamento.rotulo.toLowerCase()}`, motivos: [andamento.proximoPasso] };
  }
  const rotulo = { alta: "Potencial alto", media: "Potencial médio", baixa: "Potencial baixo" }[potencial.nivel];
  // Sem site próprio: na frente das outras empresas novas (abordagem principal, com a prévia do site), mas ainda
  // atrás das conversas (a mais fria vale 200).
  if (semSiteConfirmado(lead)) return { ...potencial, pontos: Math.min(199, 100 + potencial.pontos), rotulo: `Sem site · ${rotulo.toLowerCase()}` };
  return { ...potencial, rotulo };
}
