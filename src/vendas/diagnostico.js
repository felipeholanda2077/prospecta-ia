import { z } from "zod";
import { config } from "../config.js";
import * as db from "../db.js";
import { analisarSite } from "../analise/site.js";
import { NICHOS_AGENDA, NICHOS_VAREJO } from "../analise/oportunidades.js";
import { documentoEmPdf } from "../contratos/documento.js";
import { reais } from "../contratos/valores.js";
import { gerarJson } from "../ia/cliente.js";

// O diagnóstico pago: o que a auditoria do site viu, em linguagem de dono de empresa, com um plano do que fazer
// primeiro. Os pontos saem de verificações reais, nunca da IA; ela só escreve o resumo e ordena o plano, e recebe os
// pontos já prontos, sem o texto do site. Se ela falhar, o relatório sai do mesmo jeito.
const TIPO_DO_DOCUMENTO = "Diagnóstico do site";

const ponto = (titulo, porque, como, prioridade) => ({ titulo, porque, como, prioridade });

/** O que a auditoria encontrou: os problemas (os mais graves primeiro) e o que já está bom. */
export function achados(analise, { nicho = "", avaliacao = null, totalAvaliacoes = null } = {}, anoAtual = new Date().getFullYear()) {
  const problemas = [];
  const bons = [];
  if (analise.fora) {
    problemas.push(ponto("O site não abriu quando verificamos",
      "Quem procura a empresa no Google e encontra o site fora do ar costuma ir para o concorrente.",
      "Fale com quem cuida da hospedagem e confira se o endereço cadastrado no Google está certo.", "alta"));
  } else {
    if (analise.https) bons.push("O site tem cadeado de segurança (HTTPS).");
    else problemas.push(ponto("O site não usa o cadeado de segurança (HTTPS)",
      "O navegador pode avisar que o site não é seguro, e o visitante desiste antes de ver a empresa.",
      "Ative um certificado SSL na hospedagem e redirecione o endereço para a versão com https.", "alta"));
    if (analise.responsivo) bons.push("O site declara a configuração para celular.");
    else problemas.push(ponto("Não encontramos a configuração para celular",
      "Sem ela, as páginas tendem a abrir pequenas no celular, de onde vem boa parte das visitas.",
      "Adapte o layout para celular e inclua a configuração de viewport no código do site.", "alta"));
    if (!analise.temChat) problemas.push(ponto("Não encontramos WhatsApp ou chat na página inicial",
      "Quem quer falar com a empresa precisa procurar o contato, e parte dessas pessoas desiste.",
      "Coloque um botão de WhatsApp visível, com uma mensagem inicial pronta.", "alta"));
    else bons.push("A página inicial tem WhatsApp ou chat para o cliente chamar.");
    if (analise.lento) problemas.push(ponto(`A página demorou ${(analise.tempoRespostaMs / 1000).toFixed(1).replace(".", ",")} segundos para responder`,
      "Páginas lentas perdem visitantes, principalmente no celular.",
      "Reduza o tamanho das imagens, ative o cache e avalie a hospedagem.", "media"));
    else if (analise.tempoRespostaMs) bons.push("A página respondeu em um tempo bom quando verificamos.");
    if (!analise.temDescricao) problemas.push(ponto("A página não tem descrição para o Google",
      "O Google escolhe sozinho o texto que aparece nos resultados, e ele pode não convencer ninguém a clicar.",
      "Escreva uma descrição curta com o que a empresa faz e a cidade onde atende.", "media"));
    else bons.push("A página tem descrição para os resultados do Google.");
    if (analise.anoCopyright && analise.anoCopyright < anoAtual - 3) problemas.push(ponto(`O rodapé ainda mostra o ano de ${analise.anoCopyright}`,
      "É um detalhe, mas passa a impressão de site abandonado.",
      "Atualize o ano e revise se endereços, telefones e serviços continuam certos.", "baixa"));
    if (analise.poucoConteudo) problemas.push(ponto("A página inicial tem pouco texto",
      "Com pouco texto, o visitante entende menos o que a empresa faz, e o Google tem menos o que mostrar.",
      "Explique os serviços, a região atendida e por que escolher a empresa.", "media"));
    if (["linktree", "google sites"].includes(analise.construtor)) problemas.push(ponto(`O site foi feito em ${analise.construtor}`,
      "Essas ferramentas limitam a aparência e os recursos, e passam menos confiança que um site próprio.",
      "Migre para um site próprio, no domínio da empresa.", "media"));
    if (!analise.temAgendamento && NICHOS_AGENDA.test(nicho)) problemas.push(ponto("Não encontramos agendamento online",
      "Em negócios com horário marcado, quem não consegue agendar fora do expediente pode procurar outro lugar.",
      "Ofereça agendamento online com confirmação e lembrete automáticos.", "media"));
    if (!analise.temLoja && NICHOS_VAREJO.test(nicho)) problemas.push(ponto("Não encontramos loja virtual ou carrinho",
      "O site mostra a empresa, mas não deixa o cliente comprar na hora.",
      "Avalie uma loja virtual, começando pelos produtos mais vendidos.", "media"));
  }
  if (avaliacao >= 4.5 && totalAvaliacoes >= 10) bons.push(`A empresa tem nota ${String(avaliacao).replace(".", ",")} no Google, com ${totalAvaliacoes} avaliações. Vale destacar isso no site.`);
  const ordem = { alta: 0, media: 1, baixa: 2 };
  return { problemas: problemas.sort((a, b) => ordem[a.prioridade] - ordem[b.prioridade]), bons };
}

const contextoDoLead = (lead) => ({ nicho: lead.nicho ?? "", avaliacao: lead.avaliacao, totalAvaliacoes: lead.total_avaliacoes });
const lerJson = (valor) => {
  if (!valor || typeof valor === "object") return valor ?? null;
  try {
    return JSON.parse(valor);
  } catch {
    return null;
  }
};
const lerAnalise = (lead) => lerJson(lead.analise);
const legivel = (a) => a?.temSite && !a.bloqueadoPorRobots;

/** Os pontos que aparecem antes da compra. Usa a análise guardada; sem ela, lê o site agora. Retorna { erro } quando não há o que vender. */
export async function previa(lead) {
  let analise = lerAnalise(lead);
  if (!legivel(analise) && lead.site) analise = await analisarSite(lead.site);
  if (!legivel(analise)) return { erro: "Esta empresa não tem um site que o sistema consiga ler. O diagnóstico não se aplica." };
  const { problemas } = achados(analise, contextoDoLead(lead));
  if (!problemas.length) return { erro: "Não encontrei problemas no site desta empresa, então não faz sentido vender o diagnóstico." };
  return { problemas };
}

export const enderecoDaPagina = (token) => `${config.painel.urlPublica}/diagnostico/${token}`;

export function mensagemDoDiagnostico(lead, venda, problemas) {
  const destaques = problemas.slice(0, 2).map((p) => `• ${p.titulo}`).join("\n");
  const total = problemas.length;
  return `Olhei o site da ${lead.nome} e encontrei ${total === 1 ? "um ponto que pode estar" : `${total} pontos que podem estar`} afastando clientes:\n\n${destaques}\n\n`
    + `O relatório completo traz ${total === 1 ? "esse ponto" : "todos eles"}, como resolver e um plano do que fazer primeiro. Custa ${reais(venda.valor)} por PIX, e sai na hora depois do pagamento: ${enderecoDaPagina(venda.token)}`;
}

const PlanoSchema = z.object({
  resumo: z.string(),
  plano: z.array(z.object({ quando: z.enum(["Esta semana", "Este mês", "Próximos 3 meses"]), acao: z.string(), motivo: z.string() })),
});

const PLANO_JSON_SCHEMA = {
  type: "object",
  properties: {
    resumo: { type: "string", description: "2 a 3 frases para o dono da empresa, com o que mais importa" },
    plano: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quando: { type: "string", enum: ["Esta semana", "Este mês", "Próximos 3 meses"] },
          acao: { type: "string", description: "o que fazer, em uma frase" },
          motivo: { type: "string", description: "por que isso vem nesta ordem, em uma frase" },
        },
        required: ["quando", "acao", "motivo"],
        additionalProperties: false,
      },
    },
  },
  required: ["resumo", "plano"],
  additionalProperties: false,
};

/** O resumo e a ordem do plano, escritos pela IA a partir dos pontos verificados. */
async function planoDaIA(lead, { problemas, bons }) {
  return gerarJson({
    system: `Você escreve a parte final de um diagnóstico de site para o dono de uma pequena empresa brasileira, em português simples, sem jargão.
Use só os pontos informados. Não invente dados, números, porcentagens, promessas de faturamento nem problemas novos. Não venda nenhum serviço.
Monte o plano com uma ação por ponto a corrigir, começando pelo que mais pesa para quem visita o site.`,
    pedido: JSON.stringify({ empresa: lead.nome, segmento: lead.nicho, cidade: lead.cidade, problemas: problemas.map((p) => ({ ponto: p.titulo, prioridade: p.prioridade })), pontos_bons: bons }),
    jsonSchema: PLANO_JSON_SCHEMA, zodSchema: PlanoSchema, effort: "low",
  });
}

function planoPadrao({ problemas }) {
  const prazo = { alta: "Esta semana", media: "Este mês", baixa: "Próximos 3 meses" };
  const motivo = { alta: "Afeta diretamente quem chega ao site.", media: "Melhora a forma como o site convence e aparece no Google.", baixa: "É simples e completa a revisão." };
  const altos = problemas.filter((p) => p.prioridade === "alta").length;
  return {
    resumo: `Encontramos ${problemas.length} ${problemas.length === 1 ? "ponto a corrigir" : "pontos a corrigir"} no site${altos ? `, ${altos === 1 ? "um deles prioritário" : `${altos} deles prioritários`}` : ""}. A ordem abaixo começa pelo que mais pesa para quem visita a página.`,
    plano: problemas.map((p) => ({ quando: prazo[p.prioridade], acao: p.como, motivo: motivo[p.prioridade] })),
  };
}

const linha = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
const celula = (t) => linha(t).replace(/\|/g, "/");
const NOME_PRIORIDADE = { alta: "alta", media: "média", baixa: "baixa" };

/** O texto do relatório, no mesmo formato simples dos contratos. */
export function textoDoRelatorio({ lead, url, data, achado, escrito, servicos = [] }) {
  const partes = [
    `# ${TIPO_DO_DOCUMENTO}`, `## ${linha(lead.nome)}`,
    "::resumo", `Site | ${celula(url)}`, `Verificado em | ${data}`, `Pontos a corrigir | ${achado.problemas.length}`, "::",
    "### Resumo", linha(escrito.resumo),
    "### O que encontramos",
    ...achado.problemas.map((p) => [`::aviso ${linha(p.titulo)} (prioridade ${NOME_PRIORIDADE[p.prioridade]})`, `${p.porque} Como resolver: ${p.como}`, "::"].join("\n")),
    ...(achado.bons.length ? ["### O que já está bom", ...achado.bons.map((b) => `• ${b}`)] : []),
    "### Plano de ação",
    ["| Quando | O que fazer | Por quê |", "|---|---|---|", ...escrito.plano.map((p) => `| ${celula(p.quando)} | ${celula(p.acao)} | ${celula(p.motivo)} |`)].join("\n"),
    "### Como este diagnóstico foi feito",
    `Verificação automática da página inicial, feita em ${data}: cadeado de segurança, configuração para celular, tempo de resposta, descrição para o Google, ano no rodapé, quantidade de texto e formas de contato e venda. Ela não testa compras, formulários nem as outras páginas do site, e o tempo de resposta pode variar de um momento para outro.`,
    ...(servicos.length ? ["### Se preferir que a gente resolva", ...servicos.map((s) => `• **${linha(s.nome)}:** ${linha(s.descricao)}${s.aPartirDe ? ` A partir de ${s.aPartirDe}.` : ""}`)] : []),
  ];
  return partes.join("\n\n");
}

const chaveDoRelatorio = (id) => `relatorio-${id}.pdf`;

/**
 * O PDF de uma venda. Uma vez pronto, fica guardado: quem pagou recebe sempre o mesmo documento.
 * Retorna null se ele já estiver sendo gerado por outra chamada.
 */
export async function pdfDoRelatorio(venda, campanha, marca, { escrever = planoDaIA, agora = new Date() } = {}) {
  const pronto = await db.lerMidia(chaveDoRelatorio(venda.id));
  if (pronto) return pronto.dados;
  const trava = `relatorio_${venda.id}`;
  if (!(await db.travar(trava, 150_000))) return null;
  try {
    const lead = await db.buscarLead(venda.lead_id);
    if (!lead) throw new Error("Empresa não encontrada");
    const guardada = lerAnalise(lead);
    const endereco = guardada?.url ?? lead.site;
    const nova = endereco ? await analisarSite(endereco) : null;
    // Se o site bloquear a leitura ou falhar agora, vale o que foi visto antes da venda: uma instabilidade
    // de momento não pode trocar o relatório pago por "o site não abriu".
    const aberta = legivel(nova) && !nova.fora;
    const analise = aberta || !legivel(guardada) ? nova : guardada;
    if (!legivel(analise)) throw new Error("Não foi possível ler o site desta empresa");
    const achado = achados(analise, contextoDoLead(lead), agora.getFullYear());
    const escrito = await escrever(lead, achado).catch((e) => {
      console.error("Diagnóstico sem o texto da IA:", e.message);
      return planoPadrao(achado);
    });
    const ids = new Set((lerJson(lead.oportunidades) ?? []).map((o) => o.servico));
    const servicos = (campanha?.servicos ?? []).filter((s) => ids.has(s.id)).slice(0, 3);
    const data = agora.toLocaleDateString("pt-BR", { timeZone: config.timezone });
    const pdf = await documentoEmPdf(textoDoRelatorio({ lead, url: analise.url ?? endereco, data, achado, escrito, servicos }), { marca: marca.marca, cnpj: marca.cnpj, projeto: lead.nome, tipo: TIPO_DO_DOCUMENTO });
    await db.gravarMidia(chaveDoRelatorio(venda.id), "application/pdf", pdf);
    return pdf;
  } finally {
    await db.destravar(trava);
  }
}

const escapar = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** A página que o cliente abre: mostra os pontos, leva ao PIX e libera o relatório quando o pagamento entra. */
export function paginaDoDiagnostico({ venda, lead, problemas = [], marca }) {
  const paga = venda.status === "paga";
  const encerrada = ["cancelada", "estornada"].includes(venda.status);
  const destaques = problemas.slice(0, 2);
  const corpo = encerrada
    ? `<h1>Este link não está mais ativo</h1><p>Fale com a ${escapar(marca)} para receber um novo.</p>`
    : paga
      ? `<h1>Pagamento confirmado</h1><p>O diagnóstico de <b>${escapar(lead?.nome)}</b> está pronto. A primeira abertura pode levar até um minuto.</p>
         <a class="botao" href="/diagnostico/${escapar(venda.token)}/relatorio.pdf">Baixar o relatório em PDF</a>
         <p class="nota">Guarde este link: o relatório continua disponível aqui.</p>`
      : `<h1>Diagnóstico do site de ${escapar(lead?.nome)}</h1>
         <p>${problemas.length === 1 ? "Encontramos um ponto que pode estar" : `Encontramos ${problemas.length} pontos que podem estar`} afastando clientes do seu site. ${problemas.length > 2 ? "Dois deles:" : ""}</p>
         <ul>${destaques.map((p) => `<li><b>${escapar(p.titulo)}</b><br>${escapar(p.porque)}</li>`).join("")}</ul>
         <p>O relatório em PDF traz ${problemas.length === 1 ? "esse ponto" : "todos os pontos"}, como resolver cada um e um plano do que fazer primeiro.</p>
         <a class="botao" href="${escapar(venda.link)}" target="_blank" rel="noopener">Pagar ${escapar(reais(venda.valor))} por PIX</a>
         <p class="nota" id="aviso">O pagamento abre em outra aba. Depois de pagar, volte aqui: o relatório é liberado sozinho.</p>
         <script>setInterval(async()=>{try{const r=await fetch(location.pathname+"/situacao");const d=await r.json();if(d.status!=="aguardando")location.reload()}catch{}},8000)</script>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Diagnóstico do site · ${escapar(marca)}</title><style>
:root{--bg:#f5f6fb;--card:#fff;--text:#14151f;--muted:#5d6275;--accent:#5b4cf0;--border:#e3e5ef}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c14;--card:#141625;--text:#eceef8;--muted:#9aa0b8;--accent:#8b7dff;--border:#262940}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:520px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:32px 28px;box-shadow:0 20px 50px -24px rgba(20,21,40,.35)}
.marca{font-weight:700;color:var(--accent);margin-bottom:16px}h1{margin:0 0 12px;font-size:23px;line-height:1.25;letter-spacing:-.02em}p{color:var(--muted);margin:0 0 16px}
ul{margin:0 0 18px;padding:0;list-style:none;display:grid;gap:12px}li{border:1px solid var(--border);border-radius:12px;padding:12px 14px;color:var(--muted);font-size:15px}li b{color:var(--text)}
.botao{display:block;text-align:center;font-weight:600;padding:14px 18px;border-radius:12px;background:var(--accent);color:#fff;text-decoration:none;margin-bottom:12px}.nota{font-size:14px;margin:0}
</style></head><body><main><div class="marca">${escapar(marca)}</div>${corpo}</main></body></html>`;
}
