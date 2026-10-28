import * as db from "../db.js";

// O que a IA conta para quem demonstra interesse: como funciona, os planos e o prazo, tirado do
// site https://fluxdeck.vercel.app. Fica editável em Automação no painel; mude lá quando os planos mudarem.
export const APRESENTACAO_PADRAO = `Como funciona:
1) Reunião inicial gratuita de 30 minutos, online pelo Meet, para entender o que a empresa precisa.
2) Definição do escopo e do cronograma.
3) Desenvolvimento com entregas parciais: o cliente acompanha e dá feedback (dá para pedir alterações durante o projeto).
4) Testes e ajustes finais.
5) Lançamento e treinamento. Depois, suporte contínuo: correções, pequenos ajustes de conteúdo, segurança e suporte pelo WhatsApp.

Planos (todos sem fidelidade, com setup rápido e suporte humano; garantia de reembolso total nos primeiros 7 dias):
- Starter (valor sob consulta, conforme o projeto): presença digital profissional. Site responsivo, SEO, hospedagem inclusa, formulários de contato, integrações básicas, suporte mensal e até 1 reunião por semana.
- Professional (R$ 2.500/mês, o mais escolhido): tudo do Starter, mais páginas ilimitadas, painel administrativo, IA para criar imagens e vídeos, análise de dados, automações e 2 a 3 calls por semana. Bônus por tempo limitado: app mobile incluso.
- Professional com IA de atendimento no WhatsApp (R$ 4.500/mês): o Professional mais uma IA própria que atende, vende e agenda pelo WhatsApp. Esse valor é só para quem quer a IA de atendimento no WhatsApp.
- App Mobile (sob consulta): aplicativo iOS e Android publicado na App Store e na Play Store.
- Enterprise: para empresas grandes, com time dedicado e suporte 24/7.
- Correções avulsas (R$ 1.000/mês): manutenção e melhorias em site ou sistema que já existe.

Promoção de Black Friday (só em novembro de 2026): criação de site ou de e-commerce por R$ 1.500/mês.

Prazo: projetos simples ficam prontos em 2 a 4 semanas; sistemas mais complexos levam de 2 a 3 meses. O cronograma exato sai na reunião inicial.`;

export async function lerApresentacao() {
  return (await db.lerConfig("apresentacao"))?.texto || APRESENTACAO_PADRAO;
}

export async function gravarApresentacao(texto) {
  const limpo = String(texto ?? "").trim().slice(0, 6000);
  await db.gravarConfig("apresentacao", { texto: limpo || APRESENTACAO_PADRAO, atualizada: new Date().toISOString() });
}
