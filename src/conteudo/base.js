import * as db from "../db.js";

// O que a IA sabe sobre a FluxDeck para criar os posts: o conteúdo do site
// https://fluxdeck.vercel.app (o site é montado no navegador, então o servidor não consegue
// lê-lo sozinho). Fica editável na página Conteúdo do painel; mude lá quando o site mudar.
// Os depoimentos do site ficaram de fora (parecem exemplos de modelo); preços também.
export const BASE_PADRAO = `FluxDeck — Desenvolvimento de software sob medida com inteligência artificial. "Transforme ideias em software."
Site: fluxdeck.vercel.app · Alphaville, Barueri - SP

O que a FluxDeck faz:
- Desenvolvimento web: sites e sistemas sob medida, com design responsivo, SEO e hospedagem.
- E-commerce (lojas virtuais).
- CRM e dashboards administrativos para gestão de clientes, pipeline e relacionamento.
- Automação de processos e integrações entre sistemas (APIs).
- IA própria para atendimento, vendas e SDR no WhatsApp.
- IA para criação de imagens e vídeos.
- Análise de dados.
- Aplicativos mobile nativos (iOS e Android), com publicação na App Store e na Play Store.
- Consultoria técnica e correções/manutenção avulsas (bugs, layout, performance).

Por que a FluxDeck: inteligência artificial para automatizar processos; código limpo com as tecnologias mais modernas;
performance (aplicações rápidas); segurança em todos os níveis; escalabilidade (arquitetura que cresce com o negócio);
suporte dedicado e humano; metodologia ágil com entregas frequentes e feedback contínuo; parceria real ("não somos só
desenvolvedores, somos parceiros do seu sucesso").

Missão: democratizar o acesso à tecnologia de ponta, com softwares personalizados que resolvem problemas reais.
"Todo negócio merece ter ferramentas digitais de qualidade."

Quem está por trás: Felipe Holanda, fundador e CEO. Mais de 7 anos de experiência em desenvolvimento de software e mais
de 100 projetos entregues. Missão dele: ajudar empreendedores e empresas a escalar usando automação, inteligência
artificial e desenvolvimento ágil, sem complicação.

Portfólio (projetos reais de clientes):
- Amenai: plataforma de IA conversacional para atendimento e vendas.
- CenterGarbin: e-commerce de fogões e eletrodomésticos.
- GarbinTools: suíte de ferramentas para automação empresarial (B2B).
- NextApps: CRM completo para gestão de clientes, pipeline e relacionamento.
- Belzag: e-commerce de peças de moto.
- Pilar Finanças: plataforma financeira para ser o pilar financeiro das famílias.
- Grupo ICF: sistemas internos integrados com IA para uma empresa de paredes de isopor para edifícios e casas.

Como funciona contratar: planos sem fidelidade, setup rápido, suporte humano e reuniões de acompanhamento.
Garantia de satisfação: reembolso total nos primeiros 7 dias. Orçamento sem compromisso e resposta em 24h.
Reunião gratuita de 30 minutos, online pelo Meet, para entender o projeto.

Perguntas frequentes dos clientes: quanto tempo leva para desenvolver um software; como funciona o processo de
desenvolvimento; se dá para fazer alterações durante o projeto; o que o suporte inclui; como funciona a IA personalizada;
quais tecnologias são usadas; se fazem apps mobile; e se já tenho um sistema e só preciso de melhorias.`;

export async function lerBaseDeConteudo() {
  return (await db.lerConfig("conteudo_base"))?.texto || BASE_PADRAO;
}

export async function gravarBaseDeConteudo(texto) {
  const limpo = String(texto ?? "").trim().slice(0, 12_000);
  await db.gravarConfig("conteudo_base", { texto: limpo || BASE_PADRAO, atualizada: new Date().toISOString() });
}
