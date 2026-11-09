// Teste A/B da primeira mensagem do WhatsApp escrita pela IA (a dos números da UAZap; o número oficial da Meta manda
// o modelo aprovado). As duas abordagens partem da DOR da empresa: em vez de elogio (avaliações do Google não dizem
// nada para quem lê), a mensagem mostra uma situação que a pessoa reconhece como dela, para ela perceber que aquilo é
// um problema e confiar em quem entende do assunto. Até cada uma ter MIN_POR_ABORDAGEM empresas contatadas, vai a que
// tem menos; depois, na maioria das vezes, a que gerou mais INTERESSE (e, no empate, mais resposta), e de vez em
// quando a outra, para continuar medindo.

export const ABORDAGENS = {
  dor_na_pratica: {
    nome: "A · A dor na prática",
    instrucao: `Cumprimente e diga quem é e o que faz em poucas palavras, ligado ao ramo (ex.: "Sou o Felipe, da FluxDeck, a
  gente automatiza o atendimento no WhatsApp de clínicas."), SEM elogio. Descreva em UMA frase uma cena concreta do dia a dia
  desse tipo de negócio, ligada à oportunidade observada, que a pessoa reconheça como dela (ex.: "Em clínica 24h, no
  pico o WhatsApp acumula, e o tutor que fica esperando acaba indo para outra."). Termine perguntando, de forma simples,
  se isso acontece aí também.`,
  },
  dor_custo: {
    nome: "B · O que a dor custa",
    instrucao: `Cumprimente e diga quem é e o que faz em poucas palavras, ligado ao ramo (ex.: "Sou o Felipe, da FluxDeck, a
  gente faz sites e sistemas para clínicas."), SEM elogio. Nomeie a dor mais comum desse tipo de negócio, ligada à
  oportunidade observada, e mostre em UMA frase o que ela custa sem a empresa perceber (cliente que vai para o
  concorrente, horas da equipe respondendo a mesma coisa, venda que não volta), sem inventar números. Termine com UMA
  pergunta sobre como eles lidam com isso hoje.`,
  },
};
// As abordagens de antes (fora do teste): o nome aparece no resultado, e a fila delas é reescrita aos poucos.
export const ABORDAGENS_ANTIGAS = { elogio: "Elogio e pergunta (antiga)", pergunta: "Pergunta direta (antiga)", responsavel: "Pergunta pelo responsável (antiga)" };
export const ABORDAGEM_PADRAO = "dor_na_pratica";
export const MIN_POR_ABORDAGEM = 30;
export const EXPLORAR = 0.2; // 20% das vezes vai outra abordagem, para continuar medindo

/**
 * Escolhe a abordagem da próxima empresa. `contagem` = { abordagem: { contatadas, responderam, interessadas } };
 * ela é atualizada aqui (+1 contatada na escolhida), para uma rodada com várias empresas não mandar todas na mesma.
 */
export function escolherAbordagem(contagem, sorteio = Math.random) {
  const chaves = Object.keys(ABORDAGENS);
  for (const k of chaves) contagem[k] ??= { contatadas: 0, responderam: 0, interessadas: 0 };
  const taxa = (k, campo) => (contagem[k].contatadas ? contagem[k][campo] / contagem[k].contatadas : 0);
  let escolhida;
  const poucas = chaves.filter((k) => contagem[k].contatadas < MIN_POR_ABORDAGEM);
  if (poucas.length) {
    escolhida = poucas.reduce((a, b) => (contagem[b].contatadas < contagem[a].contatadas ? b : a));
  } else {
    const melhor = [...chaves].sort((a, b) => taxa(b, "interessadas") - taxa(a, "interessadas") || taxa(b, "responderam") - taxa(a, "responderam"))[0];
    const outras = chaves.filter((k) => k !== melhor);
    escolhida = sorteio() < EXPLORAR ? outras[Math.floor(sorteio() * outras.length) % outras.length] : melhor;
  }
  contagem[escolhida].contatadas++;
  return escolhida;
}
