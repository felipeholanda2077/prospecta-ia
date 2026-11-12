import crypto from "node:crypto";
import { z } from "zod";
import * as db from "../db.js";
import { gerarJson } from "../ia/cliente.js";
import { contextoEmpresa } from "../ia/proposta.js";
import { lerApresentacao } from "../respostas/apresentacao.js";
import { enderecoDoCheckout } from "./checkoutsAsaas.js";

// Slides sobre a FluxDeck feitos para uma empresa (página Slides do painel): a IA escreve com o que se sabe dela
// (cadastro, análise e conversa) e a apresentação fica pronta no sistema, em /slides/<código>. Nada é enviado:
// você apresenta numa call ou manda o link quando quiser. Nunca com valores.

export const TIPOS = ["capa", "sobre", "cenario", "solucao", "conversa", "processo", "resultados", "investimento", "garantias", "fechamento", "proximo_passo"];
// Os slides de fechamento (para apresentar na call e o cliente contratar ali): terminam no "fechamento", com o
// link de pagamento do Asaas do plano recomendado, no lugar do convite para o bate-papo.
const FIM = { normal: "proximo_passo", fechamento: "fechamento" };
const MAX_SLIDES = 10;

const texto = (max, descricao = "") => ({ type: "string", description: `${descricao}${descricao ? " " : ""}(até ${max} caracteres)` });
const esquema = (modo) => ({
  type: "object",
  additionalProperties: false,
  required: ["titulo", "slides"],
  properties: {
    titulo: texto(80, "Nome da apresentação, para a lista do painel"),
    slides: {
      type: "array",
      description: modo === "fechamento"
        ? "8 a 9 slides, nesta ordem: capa, cenario, solucao, conversa, processo, resultados, investimento, garantias, fechamento"
        : "7 a 9 slides, nesta ordem: capa, sobre, cenario, solucao, conversa, processo, resultados, proximo_passo",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "titulo", "subtitulo", "itens"],
        properties: {
          tipo: { type: "string", enum: TIPOS },
          titulo: texto(90, "Título do slide, forte e curto"),
          subtitulo: texto(260, "Uma frase de apoio"),
          itens: {
            type: "array",
            description: "capa e proximo_passo: vazio; sobre, cenario, solucao, resultados, garantias: 3 ou 4 cartões; " +
              "conversa: 4 a 6 falas de WhatsApp (titulo = \"Cliente\" ou \"IA\", texto = a fala); processo: 4 ou 5 etapas; " +
              "investimento: 2 ou 3 planos, o recomendado primeiro (titulo = nome EXATO do plano, texto = valores exatos e o que inclui); " +
              "fechamento: 3 passos para começar hoje",
            items: {
              type: "object", additionalProperties: false, required: ["titulo", "texto"],
              properties: { titulo: texto(50), texto: texto(180) },
            },
          },
        },
      },
    },
  },
});
const ZOD = z.object({
  titulo: z.string(),
  slides: z.array(z.object({ tipo: z.enum(TIPOS), titulo: z.string(), subtitulo: z.string(), itens: z.array(z.object({ titulo: z.string(), texto: z.string() })) })),
});

const corta = (t, max) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Arruma o que a IA escreveu: tipos válidos, capa no começo, próximo passo no fim, tamanhos e quantidades. */
export function arrumarSlides(dados, { empresa = "", modo = "normal" } = {}) {
  let slides = (dados?.slides ?? [])
    .filter((s) => TIPOS.includes(s?.tipo))
    .map((s) => ({
      tipo: s.tipo,
      titulo: corta(s.titulo, 90),
      subtitulo: corta(s.subtitulo, 260),
      // No processo o número já vem no círculo: "1. Reunião inicial" vira "Reunião inicial".
      itens: (s.itens ?? []).map((i) => ({ titulo: corta(s.tipo === "processo" ? String(i?.titulo ?? "").replace(/^\s*(?:etapa\s*\d+\s*[.)º°:-]?|\d+\s*[.)º°:-])\s*/i, "") : i?.titulo, 50), texto: corta(i?.texto, 180) }))
        .filter((i) => i.titulo || i.texto).slice(0, s.tipo === "conversa" ? 6 : 5),
    }));
  const capa = slides.find((s) => s.tipo === "capa") ?? { tipo: "capa", titulo: corta(dados?.titulo, 90) || "Apresentação", subtitulo: "", itens: [] };
  const tipoFim = FIM[modo] ?? FIM.normal;
  const fim = slides.find((s) => s.tipo === tipoFim) ?? (tipoFim === "fechamento"
    ? { tipo: "fechamento", titulo: "Vamos começar hoje?", subtitulo: "Escolha o plano e a implantação já entra na fila.", itens: [] }
    : { tipo: "proximo_passo", titulo: "Próximo passo", subtitulo: "Um bate-papo rápido para entender como vocês atendem hoje.", itens: [] });
  slides = slides.filter((s) => s.tipo !== "capa" && s.tipo !== "proximo_passo" && s.tipo !== "fechamento").slice(0, MAX_SLIDES - 2);
  if (empresa && !capa.subtitulo) capa.subtitulo = `Preparada para a ${empresa}`;
  return { titulo: corta(dados?.titulo, 80) || capa.titulo, modo, slides: [capa, ...slides, fim] };
}

function sistemaDeFechamento(campanha) {
  return `${contextoEmpresa(campanha, { semValores: true })}

Monte os slides que o vendedor vai apresentar AO VIVO numa call já marcada com UMA empresa (os dados dela vêm a seguir),
com um objetivo: a empresa contratar ali mesmo, no fim da call. Pouco texto por slide, uma ideia só, tom confiante e humano.
Slides (nesta ordem):
- capa: o resultado que ESSA empresa quer (ex.: "Nenhum aluno sem resposta no WhatsApp da Telles Fight Team");
  subtítulo "Proposta para a <empresa>".
- cenario: o que entendemos da operação e da dor deles, com os fatos da conversa (é aqui que ela se reconhece).
- solucao: o que vamos colocar para funcionar para eles, em 3 ou 4 partes, só com o que o plano tem.
- conversa: um exemplo curto de atendimento pelo WhatsApp, realista para o ramo (falas de "Cliente" e "IA").
- processo: como fica a implantação, do pagamento ao ar, em 4 ou 5 etapas, com os prazos da apresentação.
- resultados: o que muda no dia a dia, em 3 cartões, sem números inventados.
- investimento: 2 ou 3 planos da apresentação abaixo, o RECOMENDADO para a dor dela primeiro (ex.: só o atendimento no
  WhatsApp → "WhatsApp com IA"; quem também quer site e funil → "Completo Mensal"), e o anual como opção de melhor
  custo quando fizer sentido. titulo = o nome EXATO do plano como está na apresentação; texto = os valores EXATOS da
  apresentação (implantação e mensalidade, ou o anual) e depois, separado por vírgulas, 2 ou 3 itens curtos do que
  inclui (ex.: "IA 24h no WhatsApp oficial, 15 dias de ajustes"). Cite o preço de lançamento só se a apresentação
  disser que ainda vale.
- garantias: o que tira o risco da decisão, em 3 ou 4 cartões, só com o que a apresentação diz (sem fidelidade, ajustes
  incluídos, prazo de entrada no ar, suporte humano).
- fechamento: o convite para começar hoje, em 3 passos simples (ex.: 1. escolher o plano; 2. pagar a implantação pelo
  link seguro; 3. a configuração começa e entra no ar no prazo). O link de pagamento é colocado pelo sistema.
Regras:
- Se a empresa já disse o que quer (ex.: "só o atendimento automatizado do WhatsApp"), tudo gira em torno disso.
- Português do Brasil, sem jargão técnico, sem exagero e sem emojis.
- Valores: SÓ os da apresentação, exatamente como estão (nunca invente desconto, condição ou prazo).
- Não invente clientes, depoimentos, números ou resultados em porcentagem.`;
}

/** O plano recomendado (o primeiro do slide de investimento) e o checkout dele no Asaas, para o slide de fechamento. */
async function checkoutDoRecomendado(dados) {
  const recomendado = dados.slides.find((s) => s.tipo === "investimento")?.itens?.[0]?.titulo ?? "";
  if (!recomendado) return null;
  const { checkoutsAsaas } = await import("./checkoutsAsaas.js");
  const simples = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const link = (await checkoutsAsaas()).find((l) => simples(l.plano) === simples(recomendado))
    ?? (await checkoutsAsaas()).find((l) => simples(recomendado).includes(simples(l.plano)) || simples(l.plano).includes(simples(recomendado)));
  return link ? { plano: link.plano, url: link.url } : null;
}

function sistema(campanha) {
  return `${contextoEmpresa(campanha, { semValores: true })}

Monte uma apresentação em slides sobre a ${campanha.empresa.nome}, feita para UMA empresa (os dados dela vêm a seguir).
Ela vai ser apresentada numa conversa ou numa call, então cada slide tem pouco texto e uma ideia só.
Slides (nesta ordem; pode pular "conversa" ou "resultados" se não fizerem sentido):
- capa: o título fala do que importa para ESSA empresa (ex.: "Atendimento 24 h no WhatsApp da Telles Fight Team");
  subtítulo "Preparada para a <empresa>".
- sobre: quem é a ${campanha.empresa.nome}, em 3 ou 4 cartões (o que faz, como trabalha, diferenciais).
- cenario: o que entendemos da operação deles e onde perdem tempo ou cliente, com os fatos do cadastro e da conversa.
- solucao: o que a ${campanha.empresa.nome} faria para eles, em 3 ou 4 partes, só com serviços que existem.
- conversa: um exemplo curto de atendimento pelo WhatsApp, realista para o ramo (falas de "Cliente" e "IA").
- processo: como é o trabalho, do bate-papo inicial ao lançamento, em 4 ou 5 etapas (use a apresentação abaixo).
- resultados: o que muda no dia a dia, em 3 cartões, sem números inventados.
- proximo_passo: o convite para um bate-papo rápido, sem pressão.
Regras:
- Se a empresa já disse o que quer (ex.: "só o atendimento automatizado do WhatsApp"), a apresentação inteira é sobre isso.
- Português do Brasil, direto e humano, sem jargão técnico, sem exagero e sem emojis.
- NUNCA cite valores, preços, planos com preço, descontos nem prazos fechados.
- Não invente clientes, depoimentos, números ou resultados em porcentagem. Não prometa o que o catálogo não tem.`;
}

async function pedidoDaEmpresa(lead, nota, campanha, { comValores = false } = {}) {
  const historico = await db.historicoConversa(lead.id);
  const conversa = historico.length
    ? historico.map((h) => `${h.autor === "nos" ? "Nós" : lead.nome}: ${String(h.texto ?? "").replace(/\s+/g, " ").replace(/Em .{0,90} escreveu:.*$/, "").slice(0, 600)}`).join("\n")
    : "(ainda sem conversa)";
  let oportunidades = [];
  try { oportunidades = JSON.parse(lead.oportunidades || "[]"); } catch {}
  return `Empresa: ${lead.nome}
Segmento: ${lead.nicho ?? "-"}
Cidade: ${lead.cidade ?? "-"}
Site: ${lead.site ?? "não sabemos"}
Instagram: ${lead.instagram ? `@${lead.instagram}` : "-"}
Avaliação no Google: ${lead.avaliacao ? `${lead.avaliacao} (${lead.total_avaliacoes} avaliações)` : "-"}
Oportunidades da análise: ${oportunidades.map((o) => `[${o.servico}] ${o.motivo}`).join("; ") || "-"}

Como a ${campanha.empresa.nome} trabalha (apresentação; ${comValores ? "use as etapas e os planos com os valores EXATOS" : "use as etapas, ignore valores"}):
${(await lerApresentacao(lead)).slice(0, 2500)}

Conversa até agora:
${conversa}${nota ? `\n\nO que mudar desta vez (pedido do vendedor): ${nota}` : ""}`;
}

/**
 * Cria os slides de uma empresa ou, com `id`, refaz os que já existem (com o pedido `nota`, se houver).
 * Não envia nada. Retorna o registro salvo.
 */
export async function gerarSlides({ leadId, id = null, nota = "", modo = null }, campanha, { gerar = gerarJson } = {}) {
  const atual = id ? await db.buscarSlides(id) : null;
  if (id && !atual) throw new Error("Apresentação não encontrada");
  const lead = await db.buscarLead(atual?.lead_id ?? leadId);
  if (!lead) throw new Error("Empresa não encontrada");
  nota = corta(nota, 500);
  // Refazer mantém o tipo (normal ou de fechamento), a não ser que venha outro.
  let anterior = {};
  try { anterior = atual ? JSON.parse(atual.dados || "{}") : {}; } catch {}
  modo = modo === "fechamento" || (!modo && anterior.modo === "fechamento") ? "fechamento" : "normal";
  const dados = arrumarSlides(await gerar({
    system: modo === "fechamento" ? sistemaDeFechamento(campanha) : sistema(campanha),
    pedido: await pedidoDaEmpresa(lead, nota, campanha, { comValores: modo === "fechamento" }),
    jsonSchema: esquema(modo),
    zodSchema: ZOD,
    effort: "medium",
    maxTokens: 16000, // o pensamento da IA também conta: com 6000 a de fechamento era cortada
  }), { empresa: lead.nome, modo });
  if (modo === "fechamento") dados.checkout = await checkoutDoRecomendado(dados).catch(() => null);
  if (atual) {
    await db.atualizarSlides(atual.id, { titulo: dados.titulo, dados, pedido: nota || null });
    return db.buscarSlides(atual.id);
  }
  const novo = await db.criarSlides({ leadId: lead.id, codigo: crypto.randomBytes(12).toString("base64url"), titulo: dados.titulo, dados, pedido: nota || null });
  return db.buscarSlides(novo);
}

/** Troca os textos de uma apresentação (edição no painel), mantendo a estrutura. */
export async function editarSlides(id, dados) {
  const atual = await db.buscarSlides(id);
  if (!atual) throw new Error("Apresentação não encontrada");
  let anterior = {};
  try { anterior = JSON.parse(atual.dados || "{}"); } catch {}
  const arrumado = arrumarSlides(dados, { empresa: atual.empresa ?? "", modo: anterior.modo ?? "normal" });
  if (anterior.checkout) arrumado.checkout = anterior.checkout;
  await db.atualizarSlides(atual.id, { titulo: arrumado.titulo, dados: arrumado, pedido: atual.pedido });
  return db.buscarSlides(atual.id);
}

// ---------- A página da apresentação ----------

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ICONES = ["◆", "●", "▲", "■", "✦", "◉"];

/** "11953528042" ou "5511953528042" → "(11) 95352-8042"; outro formato fica como está. */
export function telefoneBonito(t) {
  const d = String(t ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(t ?? "");
}

const numeroBR = (t) => Number(String(t).replace(/\./g, "").replace(",", "."));
const reaisBR = (v) => `R$ ${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v)}`;
const primeiraMaiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Os números de um plano do slide de investimento, lidos do texto ("Implantação R$ 497 (lançamento até 30/11/2026;
 * depois R$ 900) + R$ 129,90/mês. IA 24h..."), para o cartão de preço. Sem preço no texto, devolve null.
 */
export function precoDoPlano(texto) {
  const t = String(texto ?? "");
  const achar = (re) => { const m = t.match(re); return m ? numeroBR(m[1]) : null; };
  const mensal = achar(/R\$\s*([\d.]+(?:,\d{1,2})?)\s*(?:\/|por)\s*m[eê]s/i) ?? achar(/mensalidade[^R\d]{0,12}R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  const anual = achar(/R\$\s*([\d.]+(?:,\d{1,2})?)\s*(?:\/|por)\s*ano/i);
  const parcelas = t.match(/(\d{1,2})\s*x\s*(?:de\s*)?R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  const implantacao = /implanta[çc][ãa]o[^.;]{0,20}gr[aá]tis|gr[aá]tis[^.;]{0,10}implanta/i.test(t) ? 0
    : achar(/implanta[çc][ãa]o[^R\d]{0,25}R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  const depois = achar(/depois[^R\d]{0,10}R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  const ate = t.match(/at[ée]\s*(\d{1,2}\/\d{1,2})(?:\/\d{2,4})?/i)?.[1] ?? null;
  if (mensal == null && anual == null) return null;
  // O que sobra depois dos valores vira a lista do que o plano inclui.
  // Cada trecho sem valor (ou com a economia do anual) vira um item; os de preço já estão no cartão.
  const inclui = t.replace(/\([^)]*\)/g, "").split(/[,;]\s+|\.\s+|\.$/)
    .map((f) => f.trim().replace(/\.$/, "").replace(/^(com|e|inclui|incluindo)\s+/i, ""))
    .filter((f) => f.length > 2 && !/^recomendad[oa]$/i.test(f) && !/implanta[çc][ãa]o|lan[çc]amento/i.test(f) && (!/R\$/.test(f) || /^economia/i.test(f)))
    .map(primeiraMaiuscula).slice(0, 4);
  return {
    mensal, anual, implantacao, depois: depois && implantacao != null && depois > implantacao ? depois : null, ate,
    parcelas: parcelas ? { vezes: Number(parcelas[1]), valor: numeroBR(parcelas[2]) } : null,
    hoje: mensal != null && implantacao ? Math.round((implantacao + mensal) * 100) / 100 : null,
    inclui,
  };
}

function cartaoDePreco(it, k) {
  const p = precoDoPlano(it.texto);
  const recomendado = k === 0;
  const topo = `${recomendado ? `<span class="selo">★ Recomendado para vocês</span>` : ""}<b class="nome">${esc(it.titulo)}</b>`;
  if (!p) return `<div class="cartao plano${recomendado ? " recomendado" : ""}" style="--k:${k}">${topo}<p>${esc(it.texto)}</p></div>`;
  const grande = p.mensal != null ? { valor: p.mensal, por: "/mês" }
    : p.parcelas ? { valor: p.parcelas.valor, por: "/mês", antes: `${p.parcelas.vezes}x` } : { valor: p.anual, por: "/ano" };
  const [inteiro, cents] = reaisBR(grande.valor).replace("R$ ", "").split(",");
  const linhaImplantacao = p.implantacao === 0 ? `<div class="linha-preco"><span>Implantação</span><b class="gratis">Grátis</b></div>`
    : p.implantacao != null ? `<div class="linha-preco"><span>Implantação${p.ate && p.depois ? ` <i class="lanc">lançamento até ${esc(p.ate)}</i>` : ""}</span>
        <span class="valores">${p.depois ? `<s>${esc(reaisBR(p.depois))}</s>` : ""}<b>${esc(reaisBR(p.implantacao))}</b></span></div>` : "";
  const linhaAno = p.mensal == null && p.anual != null && p.parcelas ? `<div class="linha-preco"><span>Ou à vista</span><b>${esc(reaisBR(p.anual))}/ano</b></div>` : "";
  const hoje = p.hoje != null ? `<div class="hoje"><span>Para começar hoje</span><b>${esc(reaisBR(p.hoje))}</b><small>implantação + 1º mês</small></div>` : "";
  return `<div class="cartao plano${recomendado ? " recomendado" : ""}" style="--k:${k}">${topo}
    <div class="preco">${grande.antes ? `<span class="vezes">${esc(grande.antes)}</span>` : ""}<span class="moeda">R$</span><span class="valor">${esc(inteiro)}</span>${cents ? `<span class="cents">,${esc(cents)}</span>` : ""}<span class="por">${esc(grande.por)}</span></div>
    ${linhaImplantacao}${linhaAno}${hoje}
    ${p.inclui.length ? `<ul class="inclui">${p.inclui.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
  </div>`;
}

const marcaComLogo = (marca, logo, classe = "marca") => `<div class="${classe}">${logo ? `<img class="logo-img" src="${esc(logo)}" alt="">` : `<span class="logo">${esc(marca.slice(0, 1))}</span>`}${esc(marca)}</div>`;
const curto = (t, max) => { const s = String(t ?? "").trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };

/** A capa: o título à esquerda e, à direita, uma cena animada com a conversa da proposta (ou a logo em órbita). */
function capaAnimada(s, { marca, logo, empresa, todos }) {
  const conversa = (todos.find((x) => x.tipo === "conversa")?.itens ?? []).slice(0, 3);
  const selos = (todos.find((x) => x.tipo === "solucao")?.itens ?? []).map((x) => curto(x.titulo, 30)).filter(Boolean).slice(0, 3);
  const flutuantes = (selos.length ? selos : ["Atendimento 24h", "Resposta em segundos", "Mais clientes"])
    .map((t, k) => `<span class="flutua f${k + 1}"><i>${["⚡", "✓", "★"][k]}</i>${esc(t)}</span>`).join("");
  const cena = conversa.length
    ? `<div class="celular mini"><div class="tela"><div class="topo-wa"><span class="av">${esc((empresa || marca).slice(0, 1))}</span>${esc(curto(empresa || "WhatsApp", 22))}<em>online</em></div>
        ${conversa.map((it, k) => `<div class="bolha ${/^cliente$/i.test(it.titulo) ? "ela" : "nos"}" style="--k:${3 + k * 4}">${esc(curto(it.texto, 110))}</div>`).join("")}
        <div class="digitando" style="--k:${3 + conversa.length * 4}"><span></span><span></span><span></span></div></div></div>`
    : `<div class="logo-orbita">${logo ? `<img src="${esc(logo)}" alt="">` : `<span class="logo">${esc(marca.slice(0, 1))}</span>`}</div>`;
  return `<div class="fundo-anim" aria-hidden="true"><span class="orbe o1"></span><span class="orbe o2"></span><span class="orbe o3"></span><span class="grade"></span>
      ${Array.from({ length: 14 }, (_, k) => `<span class="faisca" style="--x:${(k * 37) % 100};--y:${(k * 53) % 100};--d:${(k % 5) * 0.9}s"></span>`).join("")}</div>
    <div class="capa">
      <div class="capa-texto">${marcaComLogo(marca, logo)}
        <h1 class="entra">${esc(s.titulo)}</h1>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}<div class="linha"></div></div>
      <div class="capa-visual" aria-hidden="true"><span class="anel a1"></span><span class="anel a2"></span>${cena}${flutuantes}</div>
    </div>`;
}

/** Quem é a FluxDeck: logo, o que faz, diferenciais, serviços e o responsável com foto e contatos. */
function quemSomos(s, i, { marca, logo, foto, responsavel, cargo, telefone, site, email, diferenciais, servicos }) {
  const pontos = (s.itens?.length ? s.itens : diferenciais.map((d) => ({ titulo: d, texto: "" }))).slice(0, 4);
  const contatos = [telefone && `WhatsApp ${telefoneBonito(telefone)}`, site && site.replace(/^https?:\/\//, "").replace(/\/$/, ""), email].filter(Boolean);
  return `<div class="quem">
    <div class="quem-esq">
      <span class="tag">${String(i).padStart(2, "0")} · QUEM SOMOS</span>
      <div class="quem-marca">${logo ? `<img class="logo-grande" src="${esc(logo)}" alt="">` : ""}<div><h2>${esc(s.titulo || marca)}</h2>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}</div></div>
      <ul class="dif">${pontos.map((p, k) => `<li class="entra" style="--k:${k + 1}"><b>${esc(p.titulo)}</b>${p.texto ? `<span>${esc(p.texto)}</span>` : ""}</li>`).join("")}</ul>
      ${servicos.length ? `<div class="chips entra" style="--k:${pontos.length + 1}">${servicos.slice(0, 6).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    ${responsavel ? `<div class="pessoa cartao" style="--k:2">${foto ? `<div class="foto"><img src="${esc(foto)}" alt=""></div>` : ""}
      <b>${esc(responsavel)}</b><span class="cargo">${esc([cargo, marca].filter(Boolean).join(" da "))}</span>
      ${contatos.length ? `<div class="contatos-mini">${contatos.map((c) => `<span>${esc(c)}</span>`).join("")}</div>` : ""}</div>` : ""}
  </div>`;
}

function corpoDoSlide(s, i, { marca, telefone, site, empresa, checkout, logo, todos, ...perfil }) {
  const itens = s.itens ?? [];
  const cartoes = (classe = "") => `<div class="cartoes ${classe} n${Math.min(itens.length, 4)}">${itens.map((it, k) => `
    <div class="cartao" style="--k:${k}"><span class="ic">${ICONES[k % ICONES.length]}</span><b>${esc(it.titulo)}</b><p>${esc(it.texto)}</p></div>`).join("")}</div>`;
  const cab = `<div class="cab"><span class="tag">${String(i).padStart(2, "0")}</span><h2>${esc(s.titulo)}</h2>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}</div>`;
  switch (s.tipo) {
    case "capa":
      return capaAnimada(s, { marca, logo, empresa, todos });
    case "sobre":
    case "quem_somos":
      return quemSomos(s, i, { marca, logo, telefone, site, ...perfil });
    case "conversa":
      return `<div class="duas">${cab}<div class="celular"><div class="tela"><div class="topo-wa"><span class="av">${esc((empresa || marca).slice(0, 1))}</span>${esc(empresa || "WhatsApp")}</div>
        ${itens.map((it, k) => `<div class="bolha ${/^cliente$/i.test(it.titulo) ? "ela" : "nos"}" style="--k:${k}">${esc(it.texto)}</div>`).join("")}</div></div></div>`;
    case "processo":
      return `${cab}<ol class="passos">${itens.map((it, k) => `<li style="--k:${k}"><span class="num">${k + 1}</span><b>${esc(it.titulo)}</b><p>${esc(it.texto)}</p></li>`).join("")}</ol>`;
    case "resultados":
    case "garantias":
      return `${cab}${cartoes("grandes")}`;
    case "investimento":
      return `${cab}<div class="cartoes planos n${Math.min(itens.length, 3)}">${itens.map(cartaoDePreco).join("")}</div>`;
    case "fechamento":
      return `<div class="fim">${marcaComLogo(marca, logo, "marca topo-fim")}${s.titulo ? `<h2>${esc(s.titulo)}</h2>` : ""}${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}
        ${itens.length ? `<ol class="passos curtos">${itens.map((it, k) => `<li style="--k:${k}"><span class="num">${k + 1}</span><b>${esc(it.titulo)}</b><p>${esc(it.texto)}</p></li>`).join("")}</ol>` : ""}
        ${checkout?.url ? (() => {
          // O checkout da FluxDeck no site (fluxdeck.com.br/checkout/<plano>); sem site no perfil, o daqui mesmo.
          const origem = (() => { try { return new URL(site).origin; } catch { return ""; } })();
          const url = checkout.plano ? `${origem}${enderecoDoCheckout(checkout.plano)}` : checkout.url;
          return `<a class="pagar" href="${esc(url)}" target="_blank" rel="noopener">Contratar ${esc(checkout.plano)} agora →</a><span class="link">${esc(url.replace(/^https?:\/\//, ""))}</span>`;
        })() : ""}
        <div class="contatos">${telefone ? `<span>WhatsApp ${esc(telefoneBonito(telefone))}</span>` : ""}${site ? `<span>${esc(site.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</span>` : ""}</div></div>`;
    case "proximo_passo":
      return `<div class="fim"><h2>${esc(s.titulo)}</h2>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}
        <div class="contatos">${telefone ? `<span>WhatsApp ${esc(telefoneBonito(telefone))}</span>` : ""}${site ? `<span>${esc(site.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</span>` : ""}</div>
        ${marcaComLogo(marca, logo)}</div>`;
    default:
      return `${cab}${cartoes()}`;
  }
}

/** A apresentação inteira numa página: 16:9, setas/toque para passar, tela cheia e impressão (um slide por página). */
export function paginaDosSlides(registro, {
  marca = "FluxDeck", telefone = "", site = "", email = "", responsavel = "", cargo = "",
  logo = "/fluxdeck-logo.jpg", foto = "/felipe-holanda.jpg", diferenciais = [], servicos = [],
} = {}) {
  let dados = {};
  try { dados = typeof registro.dados === "string" ? JSON.parse(registro.dados) : registro.dados ?? {}; } catch {}
  // Quem é a FluxDeck entra logo depois da capa quando a IA não escreveu o slide "sobre" (ex.: os de fechamento).
  const salvos = dados.slides ?? [];
  const slides = salvos.length && !salvos.some((s) => s.tipo === "sobre")
    ? [salvos[0], { tipo: "quem_somos", titulo: marca, subtitulo: "Sites, sistemas e IA no WhatsApp para empresas que querem atender melhor e vender mais.", itens: [] }, ...salvos.slice(1)]
    : salvos;
  const perfil = { email, responsavel, cargo, foto, diferenciais, servicos };
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(dados.titulo || registro.titulo || "Apresentação")} · ${esc(marca)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b1120;--bg2:#111a2e;--ciano:#00d4ff;--violeta:#b44df5;--texto:#eef2ff;--suave:#9aa6c4;--borda:rgba(255,255,255,.09)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#05080f;color:var(--texto);font-family:"Plus Jakarta Sans",system-ui,sans-serif;overflow:hidden}
.palco{position:fixed;inset:0;display:grid;place-items:center;padding:clamp(0px,2vw,24px) clamp(0px,2vw,24px) 60px}
.quadro{position:relative;width:min(100%,calc((100vh - 90px)*16/9));aspect-ratio:16/9;container-type:inline-size;border-radius:clamp(0px,1.2cqw,18px);overflow:hidden;
  background:radial-gradient(60% 80% at 100% 0%,color-mix(in srgb,var(--violeta) 22%,transparent),transparent 60%),radial-gradient(50% 70% at 0% 100%,color-mix(in srgb,var(--ciano) 16%,transparent),transparent 60%),var(--bg);
  box-shadow:0 30px 80px rgba(0,0,0,.5)}
.slide{position:absolute;inset:0;padding:5.5cqw 6cqw;display:flex;flex-direction:column;opacity:0;visibility:hidden;transform:translateX(3cqw);transition:opacity .55s ease,transform .55s cubic-bezier(.2,.8,.2,1),visibility 0s .55s}
.slide.ativo{opacity:1;visibility:visible;transform:none;transition:opacity .55s ease,transform .55s cubic-bezier(.2,.8,.2,1)}
.slide.antes{transform:translateX(-3cqw)}
.slide .entra,.slide .cartao,.slide .passos li,.slide .bolha{opacity:0;transform:translateY(1.6cqw)}
.slide.ativo .entra,.slide.ativo .cartao,.slide.ativo .passos li,.slide.ativo .bolha{animation:sobe .6s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:calc(.25s + var(--k,0)*.12s)}
@keyframes sobe{to{opacity:1;transform:none}}
.cab{margin-bottom:3.2cqw}.cab .tag{display:inline-block;font-weight:700;font-size:1.25cqw;letter-spacing:.2em;color:var(--ciano);margin-bottom:1.2cqw}
h1{font-size:5.4cqw;line-height:1.05;font-weight:800;letter-spacing:-.02em;max-width:80%}
h2{font-size:3.6cqw;line-height:1.1;font-weight:800;letter-spacing:-.015em;max-width:85%}
.sub{font-size:1.75cqw;line-height:1.45;color:var(--suave);margin-top:1.4cqw;max-width:70%}
.grad,h1{background:linear-gradient(90deg,#fff 30%,var(--ciano) 70%,var(--violeta));-webkit-background-clip:text;background-clip:text;color:transparent}
.capa{position:relative;z-index:1;margin:auto 0;display:grid;grid-template-columns:1.12fr .88fr;gap:3cqw;align-items:center;height:100%}
.capa-texto{display:flex;flex-direction:column;gap:2cqw}.capa h1{max-width:none;font-size:4.7cqw}.capa .sub{max-width:none}
.logo-img{width:3.6cqw;height:3.6cqw;border-radius:1cqw;object-fit:cover;background:#000;box-shadow:0 0 0 1px rgba(255,255,255,.14),0 0 2.4cqw rgba(30,144,255,.45)}
.fundo-anim{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.orbe{position:absolute;border-radius:50%;filter:blur(5cqw);opacity:.55;animation:deriva 14s ease-in-out infinite alternate}
.o1{width:30cqw;height:30cqw;background:#1e90ff;top:-10cqw;right:6cqw}.o2{width:24cqw;height:24cqw;background:var(--violeta);bottom:-12cqw;right:-6cqw;animation-duration:18s;opacity:.4}
.o3{width:20cqw;height:20cqw;background:var(--ciano);bottom:-8cqw;left:-6cqw;animation-duration:16s;opacity:.3}
@keyframes deriva{0%{transform:translate(0,0) scale(1)}50%{transform:translate(-4cqw,3cqw) scale(1.12)}100%{transform:translate(3cqw,-2cqw) scale(.95)}}
.grade{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:4cqw 4cqw;
  -webkit-mask-image:radial-gradient(60% 70% at 72% 45%,#000,transparent);mask-image:radial-gradient(60% 70% at 72% 45%,#000,transparent);animation:grade 20s linear infinite}
@keyframes grade{to{background-position:4cqw 4cqw}}
.faisca{position:absolute;left:calc(var(--x)*1%);top:calc(var(--y)*1%);width:.35cqw;height:.35cqw;border-radius:50%;background:#fff;box-shadow:0 0 1cqw var(--ciano);opacity:0;animation:pisca 4.5s ease-in-out infinite;animation-delay:var(--d)}
@keyframes pisca{0%,100%{opacity:0;transform:scale(.4)}50%{opacity:.8;transform:scale(1)}}
.capa-visual{position:relative;height:100%;display:grid;place-items:center}
.anel{position:absolute;border-radius:50%;border:1px dashed rgba(255,255,255,.14);animation:gira 40s linear infinite}
.a1{width:34cqw;height:34cqw}.a2{width:24cqw;height:24cqw;border-style:solid;border-color:color-mix(in srgb,var(--ciano) 25%,transparent);animation-duration:28s;animation-direction:reverse}
.anel::after{content:"";position:absolute;top:-.5cqw;left:50%;width:1cqw;height:1cqw;border-radius:50%;background:var(--ciano);box-shadow:0 0 1.4cqw var(--ciano)}
.a2::after{background:var(--violeta);box-shadow:0 0 1.4cqw var(--violeta)}
@keyframes gira{to{transform:rotate(360deg)}}
.celular.mini{position:relative;width:21cqw;height:34cqw;border-radius:3cqw;animation:boia 6s ease-in-out infinite;box-shadow:0 2cqw 6cqw rgba(0,0,0,.55),0 0 6cqw rgba(30,144,255,.18)}
.celular.mini .tela{border-radius:2.3cqw;gap:.8cqw}.celular.mini .topo-wa{font-size:1.05cqw}.celular.mini .topo-wa em{margin-left:auto;font-style:normal;font-size:.85cqw;color:#3ddc84}
.celular.mini .bolha{font-size:.98cqw;padding:.75cqw .95cqw}
.slide.ativo .capa .bolha{animation-delay:calc(var(--k)*.22s)}
.digitando{align-self:flex-start;display:flex;gap:.35cqw;padding:.8cqw 1cqw;border-radius:1.2cqw;background:#1f2a44;opacity:0}
.slide.ativo .digitando{animation:sobe .5s forwards;animation-delay:calc(var(--k)*.22s)}
.digitando span{width:.55cqw;height:.55cqw;border-radius:50%;background:var(--suave);animation:pulo 1.2s infinite}.digitando span:nth-child(2){animation-delay:.15s}.digitando span:nth-child(3){animation-delay:.3s}
@keyframes pulo{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-.4cqw);opacity:1}}
@keyframes boia{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-1.2cqw) rotate(-1deg)}}
.logo-orbita img,.logo-orbita .logo{width:13cqw;height:13cqw;border-radius:3.4cqw;object-fit:cover;background:#000;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 0 7cqw rgba(30,144,255,.5);animation:boia 6s ease-in-out infinite}
.logo-orbita .logo{font-size:6cqw}
.flutua{position:absolute;display:flex;align-items:center;gap:.6cqw;padding:.75cqw 1.2cqw;border-radius:99px;font-size:1.1cqw;font-weight:700;white-space:nowrap;
  background:rgba(14,22,40,.78);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);box-shadow:0 1cqw 3cqw rgba(0,0,0,.4);opacity:0}
.flutua i{font-style:normal;display:grid;place-items:center;width:1.7cqw;height:1.7cqw;border-radius:50%;font-size:.9cqw;color:#06101f;background:linear-gradient(135deg,var(--ciano),var(--violeta))}
.f1{top:12%;left:-4%}.f2{top:61%;right:-9%}.f3{bottom:9%;left:0}
.slide.ativo .flutua{animation:aparece .6s cubic-bezier(.2,.8,.2,1) forwards,flutua 5s ease-in-out infinite}
.slide.ativo .f1{animation-delay:.9s,1.5s}.slide.ativo .f2{animation-delay:1.3s,1.9s}.slide.ativo .f3{animation-delay:1.7s,2.3s}
@keyframes aparece{from{opacity:0;transform:translateY(1.5cqw) scale(.9)}to{opacity:1;transform:none}}
@keyframes flutua{0%,100%{opacity:1;transform:translateY(0)}50%{opacity:1;transform:translateY(-.9cqw)}}
.quem{display:grid;grid-template-columns:1.35fr .65fr;gap:4cqw;align-items:center;height:100%}
.quem .tag{display:inline-block;font-weight:700;font-size:1.25cqw;letter-spacing:.2em;color:var(--ciano);margin-bottom:1.6cqw}
.quem-marca{display:flex;align-items:center;gap:2cqw;margin-bottom:2.4cqw}.quem-marca h2{font-size:4cqw}.quem-marca .sub{margin-top:.6cqw;max-width:none}
.logo-grande{width:8cqw;height:8cqw;border-radius:2.2cqw;object-fit:cover;background:#000;flex:none;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 0 5cqw rgba(30,144,255,.4)}
.slide.ativo .logo-grande{animation:boia 6s ease-in-out infinite}
.dif{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:1.2cqw 2cqw}
.dif li{position:relative;padding-left:2.6cqw;display:flex;flex-direction:column;gap:.3cqw}
.dif li::before{content:"✓";position:absolute;left:0;top:.1cqw;width:1.8cqw;height:1.8cqw;border-radius:50%;display:grid;place-items:center;font-size:1cqw;font-weight:800;color:#06101f;background:linear-gradient(135deg,var(--ciano),var(--violeta))}
.dif b{font-size:1.45cqw;line-height:1.3}.dif span{font-size:1.15cqw;line-height:1.4;color:var(--suave)}
.chips{display:flex;flex-wrap:wrap;gap:.7cqw;margin-top:2.2cqw}.chips span{font-size:1.05cqw;font-weight:600;padding:.5cqw 1.1cqw;border-radius:99px;border:1px solid var(--borda);background:rgba(255,255,255,.04);color:var(--suave)}
.pessoa{align-items:center;text-align:center;padding:2.4cqw 2cqw;gap:.5cqw}
.pessoa .foto{width:13cqw;height:13cqw;border-radius:50%;padding:.3cqw;background:linear-gradient(135deg,var(--ciano),var(--violeta));margin-bottom:1cqw}
.pessoa .foto img{width:100%;height:100%;border-radius:50%;object-fit:cover;object-position:60% 20%;display:block;border:.3cqw solid var(--bg)}
.pessoa b{font-size:1.8cqw}.pessoa .cargo{font-size:1.2cqw;color:var(--suave)}
.contatos-mini{display:flex;flex-direction:column;gap:.5cqw;margin-top:1.2cqw;width:100%}.contatos-mini span{font-size:1.05cqw;padding:.55cqw 1cqw;border-radius:99px;border:1px solid var(--borda);font-weight:600}
.marca.topo-fim{margin-bottom:.6cqw}
.rod-marca{display:flex;align-items:center;gap:.6cqw;font-weight:700}.rod-marca .logo-img{width:1.7cqw;height:1.7cqw;border-radius:.45cqw;box-shadow:none}
.rod-marca .logo{width:1.7cqw;height:1.7cqw;font-size:1cqw;border-radius:.45cqw}
@media (prefers-reduced-motion:reduce){.orbe,.grade,.faisca,.anel,.celular.mini,.logo-orbita img,.logo-grande,.digitando span{animation:none!important}.flutua{opacity:1}}
.marca{display:flex;align-items:center;gap:1cqw;font-weight:800;font-size:1.7cqw;letter-spacing:.02em}
.logo{display:grid;place-items:center;width:3.4cqw;height:3.4cqw;border-radius:.9cqw;background:linear-gradient(135deg,var(--ciano),var(--violeta));color:#06101f;font-size:1.9cqw}
.capa .linha{width:12cqw;height:.45cqw;border-radius:1cqw;background:linear-gradient(90deg,var(--ciano),var(--violeta));transform-origin:left;animation:risca 1s .4s both}
@keyframes risca{from{transform:scaleX(0)}}
.cartoes{display:grid;gap:1.6cqw;margin:auto 0 3cqw}.cartoes.n2{grid-template-columns:repeat(2,1fr)}.cartoes.n3{grid-template-columns:repeat(3,1fr)}.cartoes.n4{grid-template-columns:repeat(4,1fr)}
.cartao{background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));border:1px solid var(--borda);border-radius:1.4cqw;padding:2cqw;display:flex;flex-direction:column;gap:.8cqw}
.cartao .ic{font-size:1.6cqw;background:linear-gradient(135deg,var(--ciano),var(--violeta));-webkit-background-clip:text;background-clip:text;color:transparent}
.cartao b{font-size:1.65cqw;line-height:1.25}.cartao p{font-size:1.32cqw;line-height:1.5;color:var(--suave)}
.grandes .cartao{padding:2.6cqw}.grandes .cartao b{font-size:2cqw}
.passos{list-style:none;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:1.4cqw;margin:auto 0 3cqw;position:relative}
.passos li{position:relative;padding-top:4.4cqw}.passos li::before{content:"";position:absolute;top:1.6cqw;left:3.4cqw;right:-1.4cqw;height:2px;background:linear-gradient(90deg,var(--ciano),var(--violeta));opacity:.5}
.passos li:last-child::before{display:none}
.num{position:absolute;top:0;left:0;width:3.4cqw;height:3.4cqw;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:1.5cqw;color:#06101f;background:linear-gradient(135deg,var(--ciano),var(--violeta))}
.passos b{display:block;font-size:1.55cqw;margin-bottom:.6cqw}.passos p{font-size:1.25cqw;line-height:1.45;color:var(--suave)}
.duas{display:grid;grid-template-columns:1.1fr .9fr;gap:4cqw;align-items:center;height:100%}.duas .cab{margin:0}
.celular{justify-self:center;width:24cqw;height:42cqw;border-radius:3.4cqw;padding:1cqw;background:#1b2238;border:1px solid var(--borda);box-shadow:0 2cqw 5cqw rgba(0,0,0,.45)}
.tela{height:100%;border-radius:2.6cqw;background:#0e1626;padding:1.2cqw;display:flex;flex-direction:column;gap:.9cqw;overflow:hidden}
.topo-wa{display:flex;align-items:center;gap:.8cqw;font-weight:700;font-size:1.2cqw;padding-bottom:.8cqw;border-bottom:1px solid var(--borda)}
.av{width:2.4cqw;height:2.4cqw;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,var(--ciano),var(--violeta));color:#06101f;font-size:1.1cqw}
.bolha{max-width:85%;padding:.9cqw 1.1cqw;border-radius:1.2cqw;font-size:1.12cqw;line-height:1.4}
.bolha.ela{align-self:flex-start;background:#1f2a44;border-bottom-left-radius:.3cqw}
.bolha.nos{align-self:flex-end;background:linear-gradient(135deg,color-mix(in srgb,var(--ciano) 35%,#0e1626),color-mix(in srgb,var(--violeta) 35%,#0e1626));border-bottom-right-radius:.3cqw}
.fim{margin:auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:1.6cqw}.fim h2,.fim .sub{max-width:none}
.fim h2{font-size:4.6cqw;background:linear-gradient(90deg,#fff,var(--ciano),var(--violeta));-webkit-background-clip:text;background-clip:text;color:transparent}
.contatos{display:flex;gap:1.4cqw;flex-wrap:wrap;justify-content:center;margin-top:1cqw}.contatos span{border:1px solid var(--borda);border-radius:99px;padding:.9cqw 1.8cqw;font-size:1.4cqw;font-weight:600}
.fim .marca{margin-top:2cqw;color:var(--suave)}
[data-tipo=investimento] .cab{margin-bottom:1.6cqw}[data-tipo=investimento] h2{font-size:3.2cqw}[data-tipo=investimento] .sub{font-size:1.5cqw;margin-top:1cqw}
.planos{margin:auto 0 3.4cqw;align-items:stretch;gap:2.2cqw}.planos.n2{grid-template-columns:1.12fr 1fr;width:min(100%,82cqw)}.planos.n3{grid-template-columns:1.12fr 1fr 1fr}
.plano{position:relative;padding:2.4cqw 2.6cqw;gap:1cqw;border-radius:1.8cqw;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02))}
.plano .nome{font-size:1.75cqw;font-weight:700;color:var(--suave);letter-spacing:.01em}
.plano.recomendado .nome{color:var(--texto)}
.plano.recomendado{border:0;background:linear-gradient(160deg,color-mix(in srgb,var(--ciano) 16%,#0f1830),color-mix(in srgb,var(--violeta) 14%,#0f1830));
  box-shadow:0 0 0 .18cqw color-mix(in srgb,var(--ciano) 70%,transparent),0 2cqw 6cqw rgba(0,212,255,.18),0 0 8cqw rgba(180,77,245,.12)}
.plano.recomendado::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:.18cqw;background:linear-gradient(135deg,var(--ciano),var(--violeta));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.selo{position:absolute;top:-1.25cqw;left:2.4cqw;background:linear-gradient(90deg,var(--ciano),var(--violeta));color:#06101f;font-weight:800;font-size:1.05cqw;letter-spacing:.02em;padding:.45cqw 1.2cqw;border-radius:99px;box-shadow:0 .6cqw 1.6cqw rgba(0,212,255,.3)}
.preco{display:flex;align-items:flex-end;gap:.25cqw;line-height:1;margin-top:.2cqw}
.preco .moeda{font-size:1.8cqw;font-weight:700;color:var(--suave);margin-right:.3cqw;align-self:flex-start;margin-top:.8cqw}
.preco .valor{font-size:5.6cqw;font-weight:800;letter-spacing:-.03em}
.plano.recomendado .preco .valor,.plano.recomendado .preco .cents{background:linear-gradient(90deg,#fff 20%,var(--ciano));-webkit-background-clip:text;background-clip:text;color:transparent}
.preco .cents{font-size:2.6cqw;font-weight:800;align-self:flex-start;margin-top:.6cqw}
.preco .por{font-size:1.6cqw;color:var(--suave);font-weight:600;margin-left:.3cqw;margin-bottom:.7cqw}
.preco .vezes{font-size:2cqw;font-weight:800;color:var(--ciano);margin-right:.6cqw;margin-bottom:.7cqw}
.linha-preco{display:flex;justify-content:space-between;align-items:center;gap:1cqw;font-size:1.3cqw;color:var(--suave);padding:.9cqw 0;border-top:1px solid var(--borda)}
.linha-preco b{color:var(--texto);font-size:1.5cqw;margin-left:.6cqw}.linha-preco s{opacity:.7}
.linha-preco .gratis{color:var(--ciano)}.linha-preco .valores{white-space:nowrap}
[data-tipo=investimento]:has(.n3) .cab{margin-bottom:1.2cqw}[data-tipo=investimento]:has(.n3) h2{font-size:2.7cqw}[data-tipo=investimento]:has(.n3) .sub{font-size:1.3cqw;margin-top:.7cqw}
.planos.n3{margin-bottom:3.6cqw;gap:1.6cqw}.n3 .plano{padding:1.9cqw 1.9cqw;gap:.75cqw;border-radius:1.5cqw}.n3 .plano .nome{font-size:1.5cqw}
.n3 .preco .valor{font-size:4.2cqw}.n3 .preco .cents{font-size:2cqw;margin-top:.4cqw}.n3 .preco .moeda{font-size:1.4cqw;margin-top:.5cqw}.n3 .preco .por{font-size:1.25cqw;margin-bottom:.5cqw}.n3 .preco .vezes{font-size:1.6cqw;margin-bottom:.5cqw}
.n3 .linha-preco{flex-wrap:wrap;row-gap:.4cqw;font-size:1.1cqw;padding:.7cqw 0}.n3 .linha-preco b{font-size:1.3cqw}.n3 .lanc{font-size:.85cqw}
.n3 .hoje{grid-template-columns:1fr;padding:.9cqw 1.1cqw}.n3 .hoje b{grid-row:auto;font-size:1.8cqw;order:3}.n3 .hoje span{font-size:1.1cqw}.n3 .hoje small{font-size:.9cqw}
.n3 .inclui{gap:.5cqw}.n3 .inclui li{font-size:1.12cqw;padding-left:1.9cqw}.n3 .inclui li::before{width:1.3cqw;height:1.3cqw;font-size:.8cqw}
.n3 .selo{font-size:.95cqw;top:-1.1cqw;left:1.9cqw}
.lanc{font-style:normal;font-size:1cqw;font-weight:700;color:#06101f;background:var(--ciano);border-radius:99px;padding:.2cqw .7cqw;margin-left:.5cqw;white-space:nowrap}
.hoje{display:grid;grid-template-columns:1fr auto;align-items:center;column-gap:1cqw;padding:1.1cqw 1.3cqw;border-radius:1cqw;background:rgba(255,255,255,.05);border:1px solid var(--borda)}
.plano.recomendado .hoje{background:rgba(0,212,255,.1);border-color:color-mix(in srgb,var(--ciano) 40%,transparent)}
.hoje span{font-size:1.25cqw;font-weight:700}.hoje b{grid-row:span 2;font-size:2.2cqw;font-weight:800}.hoje small{font-size:1cqw;color:var(--suave)}
.inclui{list-style:none;display:grid;gap:.7cqw;margin-top:.4cqw}
.inclui li{position:relative;padding-left:2.2cqw;font-size:1.3cqw;line-height:1.35;color:var(--texto)}
.inclui li::before{content:"✓";position:absolute;left:0;top:-.05cqw;width:1.5cqw;height:1.5cqw;border-radius:50%;display:grid;place-items:center;font-size:.95cqw;font-weight:800;color:#06101f;background:linear-gradient(135deg,var(--ciano),var(--violeta))}
.passos.curtos{margin:1.5cqw 0;text-align:left;width:min(100%,80cqw)}
.pagar{display:inline-block;margin-top:1cqw;padding:1.3cqw 3cqw;border-radius:99px;font-weight:800;font-size:1.9cqw;color:#06101f;text-decoration:none;background:linear-gradient(90deg,var(--ciano),var(--violeta));box-shadow:0 1cqw 3cqw rgba(0,212,255,.25)}
.fim .link{font-size:1.15cqw;color:var(--suave)}
.rodape{position:absolute;left:6cqw;right:6cqw;bottom:2.2cqw;display:flex;justify-content:space-between;font-size:1.05cqw;color:var(--suave);pointer-events:none}
.barra{position:absolute;left:0;bottom:0;height:.35cqw;background:linear-gradient(90deg,var(--ciano),var(--violeta));transition:width .5s}
.controles{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);display:flex;gap:6px;align-items:center;background:rgba(10,15,28,.8);border:1px solid var(--borda);border-radius:99px;padding:5px;backdrop-filter:blur(8px);font-size:13px;z-index:5;transition:opacity .3s}
.controles button{background:none;border:0;color:var(--texto);width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:16px}.controles button:hover{background:rgba(255,255,255,.08)}
.controles .conta{min-width:54px;text-align:center;color:var(--suave);font-variant-numeric:tabular-nums}
body.quieto .controles{opacity:0}
.toque{position:absolute;top:0;bottom:0;width:30%;z-index:2;cursor:pointer}.toque.esq{left:0}.toque.dir{right:0}
@media (max-width:700px){.palco{padding:0 0 60px}.quadro{border-radius:0}}
@media print{@page{size:1280px 720px;margin:0}html,body{overflow:visible;background:var(--bg)}.palco{position:static;display:block;padding:0}
  .quadro{width:1280px;height:720px;aspect-ratio:auto;border-radius:0;box-shadow:none;overflow:visible;background:none}
  .slide{position:relative;width:1280px;height:720px;opacity:1;visibility:visible;transform:none;page-break-after:always;break-after:page;
    background:radial-gradient(60% 80% at 100% 0%,rgba(180,77,245,.22),transparent 60%),radial-gradient(50% 70% at 0% 100%,rgba(0,212,255,.16),transparent 60%),#0b1120;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .slide .entra,.slide .cartao,.slide .passos li,.slide .bolha,.flutua,.digitando{opacity:1;transform:none;animation:none}.orbe,.faisca,.anel{animation:none}.controles,.toque,.barra,.rodape{display:none}}
</style></head><body>
<div class="palco"><div class="quadro" id="quadro">
${slides.map((s, i) => `<section class="slide${i === 0 ? " ativo" : ""}" data-tipo="${esc(s.tipo)}" aria-label="Slide ${i + 1} de ${slides.length}">${corpoDoSlide(s, i, { marca, telefone, site, empresa: registro.empresa ?? "", checkout: dados.checkout, logo, todos: slides, ...perfil })
    .replace(/<h2>/g, '<h2 class="entra">').replace(/<p class="sub">/g, '<p class="sub entra" style="--k:1">')}</section>`).join("\n")}
<div class="rodape">${marcaComLogo(marca, logo, "rod-marca")}<span>${esc(registro.empresa ?? "")}</span></div>
<div class="barra" id="barra"></div>
<div class="toque esq" data-ir="-1"></div><div class="toque dir" data-ir="1"></div>
</div></div>
<nav class="controles" aria-label="Controles da apresentação">
<button type="button" data-ir="-1" aria-label="Slide anterior">‹</button><span class="conta" id="conta"></span>
<button type="button" data-ir="1" aria-label="Próximo slide">›</button>
<button type="button" id="cheia" aria-label="Tela cheia" title="Tela cheia (F)">⛶</button>
<button type="button" onclick="print()" aria-label="Salvar em PDF" title="Salvar em PDF">⤓</button>
</nav>
<script>
const slides=[...document.querySelectorAll(".slide")];let atual=0;
const n=slides.length;const conta=document.getElementById("conta");const barra=document.getElementById("barra");
function ir(i){i=Math.max(0,Math.min(n-1,i));if(i===atual&&slides[i].classList.contains("ativo"))return;
  slides.forEach((s,k)=>{s.classList.toggle("ativo",k===i);s.classList.toggle("antes",k<i)});atual=i;
  conta.textContent=(i+1)+" / "+n;barra.style.width=((i+1)/n*100)+"%";history.replaceState(null,"","#"+(i+1));}
document.addEventListener("click",(e)=>{const b=e.target.closest("[data-ir]");if(b)ir(atual+Number(b.dataset.ir));});
document.addEventListener("keydown",(e)=>{if(["ArrowRight","PageDown"," ","Enter"].includes(e.key)){e.preventDefault();ir(atual+1)}
  else if(["ArrowLeft","PageUp","Backspace"].includes(e.key)){e.preventDefault();ir(atual-1)}else if(e.key==="Home")ir(0);else if(e.key==="End")ir(n-1);
  else if(e.key.toLowerCase()==="f")cheia();});
let x0=null;document.addEventListener("touchstart",(e)=>{x0=e.touches[0].clientX},{passive:true});
document.addEventListener("touchend",(e)=>{if(x0===null)return;const d=e.changedTouches[0].clientX-x0;if(Math.abs(d)>40)ir(atual+(d<0?1:-1));x0=null});
function cheia(){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen?.()}
document.getElementById("cheia").onclick=cheia;
let parado;document.addEventListener("mousemove",()=>{document.body.classList.remove("quieto");clearTimeout(parado);parado=setTimeout(()=>document.body.classList.add("quieto"),2500)});
const doEndereco=()=>ir(Math.max(0,(parseInt(location.hash.slice(1))||1)-1));addEventListener("hashchange",doEndereco);doEndereco();
</script></body></html>`;
}
