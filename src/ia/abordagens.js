// Teste A/B da primeira mensagem do WhatsApp: cada empresa nova recebe uma das abordagens abaixo. Até cada uma ter
// MIN_POR_ABORDAGEM empresas contatadas, vai a que tem menos; depois, na maioria das vezes, a que gerou mais
// INTERESSE (e, no empate, mais resposta), e de vez em quando outra, para continuar medindo.

export const ABORDAGENS = {
  elogio: {
    nome: "Elogio e pergunta",
    instrucao: `Cumprimente, diga quem é em poucas palavras e cite UMA coisa positiva e concreta observada sobre a empresa
  (ex.: as avaliações no Google). Termine com UMA pergunta simples e aberta sobre como eles trabalham hoje, ligada à
  oportunidade observada (ex.: como os pacientes costumam encontrar vocês).`,
  },
  pergunta: {
    nome: "Pergunta direta",
    instrucao: `Cumprimente e diga quem é em poucas palavras, SEM elogio. Vá direto a UMA pergunta curta sobre uma dor comum
  desse tipo de negócio, ligada à oportunidade observada (ex.: "Vocês costumam perder paciente quando demoram para
  responder no WhatsApp?"). Nada além disso.`,
  },
  responsavel: {
    nome: "Pergunta pelo responsável",
    instrucao: `Curtíssima (até ~120 caracteres): cumprimente, diga quem é em poucas palavras e pergunte se está falando com
  o dono ou o responsável pela empresa (pelo primeiro nome do sócio, se os dados trouxerem). Ainda NÃO diga o assunto.`,
  },
};
export const ABORDAGEM_PADRAO = "elogio";
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
