// Andamento de cada conversa na página de Respostas: chance de fechar, se precisa de você
// e o próximo passo. A base é a avaliação que a IA faz a cada resposta (quente, morna ou
// fria), ajustada pela situação da empresa e pelo tempo sem resposta.

export const CHANCES = {
  agendada: { nivel: 4, rotulo: "Reunião agendada" },
  quente: { nivel: 3, rotulo: "Alta" },
  morna: { nivel: 2, rotulo: "Média" },
  fria: { nivel: 1, rotulo: "Baixa" },
  encerrada: { nivel: 0, rotulo: "Encerrada" },
};

const ENCERRADAS = ["sem_interesse", "descadastrado", "descartado"];
// Depois de tantos dias sem a empresa responder à nossa última mensagem, a conversa esfria um nível.
const DIAS_PARA_ESFRIAR = 3;

/** Avalia uma conversa (uma linha de db.conversas()). */
export function avaliarConversa(c, agora = new Date()) {
  let chance;
  if (c.status === "agendado") chance = "agendada";
  else if (ENCERRADAS.includes(c.status)) chance = "encerrada";
  // Respostas de antes da avaliação da IA: estimativa pelo que a empresa já disse.
  else chance = c.avaliacao?.temperatura ?? (c.mostrou_interesse ? "quente" : c.respostas >= 2 ? "morna" : "fria");

  const esperandoEmpresa = c.ultima?.autor === "nos";
  const diasSemResposta = c.ultima_resposta ? (agora - new Date(c.ultima_resposta)) / 864e5 : 0;
  const esfriou = ["quente", "morna"].includes(chance) && esperandoEmpresa && diasSemResposta > DIAS_PARA_ESFRIAR;
  if (esfriou) chance = chance === "quente" ? "morna" : "fria";

  const precisaDeVoce = !ENCERRADAS.includes(c.status) && Boolean(c.recente?.precisa_humano) && !esperandoEmpresa;
  let proximoPasso;
  if (precisaDeVoce) proximoPasso = `Responder você: ${c.recente.precisa_humano}`;
  else if (chance === "agendada") proximoPasso = "Preparar a reunião";
  else if (chance === "encerrada") proximoPasso = "Nenhum: conversa encerrada";
  else if (c.proxima?.tipo === "resposta") proximoPasso = "A IA já vai responder";
  else proximoPasso = c.avaliacao?.proximo_passo || (esperandoEmpresa ? "Aguardar a resposta da empresa" : "Responder a empresa");

  return {
    chance,
    ...CHANCES[chance],
    esfriou,
    diasSemResposta: Math.floor(diasSemResposta),
    precisaDeVoce,
    aguardando: esperandoEmpresa ? "empresa" : "nos",
    proximoPasso,
  };
}

/** Indicadores do topo da página: quantas em cada nível, taxas do funil e quem precisa de você. */
export function indicadoresDasConversas(lista, funil) {
  const conta = (f) => lista.filter(f).length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return {
    conversas: lista.length,
    ativas: conta((c) => !["agendada", "encerrada"].includes(c.andamento.chance)),
    quentes: conta((c) => c.andamento.chance === "quente"),
    mornas: conta((c) => c.andamento.chance === "morna"),
    frias: conta((c) => c.andamento.chance === "fria"),
    encerradas: conta((c) => c.andamento.chance === "encerrada"),
    precisamDeVoce: conta((c) => c.andamento.precisaDeVoce),
    agendadas: funil.agendadas,
    funil,
    naoResponderam: funil.nao_responderam ?? 0,
    // Ainda vão receber etapas / já receberam todas e não responderam.
    naoResponderamNaSequencia: funil.nao_responderam_na_sequencia ?? 0,
    naoResponderamSequenciaEncerrada: (funil.nao_responderam ?? 0) - (funil.nao_responderam_na_sequencia ?? 0),
    taxaSemResposta: pct(funil.nao_responderam ?? 0, funil.contatadas),
    taxaResposta: pct(funil.responderam, funil.contatadas),
    taxaInteresse: pct(funil.interessadas, funil.responderam),
    taxaAgendamento: pct(funil.agendadas, funil.interessadas),
  };
}
