import crypto from "node:crypto";
import { z } from "zod";
import * as db from "../db.js";
import { gerarJson } from "../ia/cliente.js";
import { contextoEmpresa } from "../ia/proposta.js";
import { lerApresentacao } from "../respostas/apresentacao.js";

// Slides sobre a FluxDeck feitos para uma empresa (página Slides do painel): a IA escreve com o que se sabe dela
// (cadastro, análise e conversa) e a apresentação fica pronta no sistema, em /slides/<código>. Nada é enviado:
// você apresenta numa call ou manda o link quando quiser. Nunca com valores.

export const TIPOS = ["capa", "sobre", "cenario", "solucao", "conversa", "processo", "resultados", "proximo_passo"];
const MAX_SLIDES = 10;

const texto = (max, descricao = "") => ({ type: "string", description: `${descricao}${descricao ? " " : ""}(até ${max} caracteres)` });
const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titulo", "slides"],
  properties: {
    titulo: texto(80, "Nome da apresentação, para a lista do painel"),
    slides: {
      type: "array",
      description: "7 a 9 slides, nesta ordem: capa, sobre, cenario, solucao, conversa, processo, resultados, proximo_passo",
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
            description: "capa e proximo_passo: vazio; sobre, cenario, solucao, resultados: 3 ou 4 cartões; " +
              "conversa: 4 a 6 falas de WhatsApp (titulo = \"Cliente\" ou \"IA\", texto = a fala); processo: 4 ou 5 etapas",
            items: {
              type: "object", additionalProperties: false, required: ["titulo", "texto"],
              properties: { titulo: texto(50), texto: texto(180) },
            },
          },
        },
      },
    },
  },
};
const ZOD = z.object({
  titulo: z.string(),
  slides: z.array(z.object({ tipo: z.enum(TIPOS), titulo: z.string(), subtitulo: z.string(), itens: z.array(z.object({ titulo: z.string(), texto: z.string() })) })),
});

const corta = (t, max) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Arruma o que a IA escreveu: tipos válidos, capa no começo, próximo passo no fim, tamanhos e quantidades. */
export function arrumarSlides(dados, { empresa = "" } = {}) {
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
  const fim = slides.find((s) => s.tipo === "proximo_passo") ?? { tipo: "proximo_passo", titulo: "Próximo passo", subtitulo: "Um bate-papo rápido para entender como vocês atendem hoje.", itens: [] };
  slides = slides.filter((s) => s.tipo !== "capa" && s.tipo !== "proximo_passo").slice(0, MAX_SLIDES - 2);
  if (empresa && !capa.subtitulo) capa.subtitulo = `Preparada para a ${empresa}`;
  return { titulo: corta(dados?.titulo, 80) || capa.titulo, slides: [capa, ...slides, fim] };
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

async function pedidoDaEmpresa(lead, nota, campanha) {
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

Como a ${campanha.empresa.nome} trabalha (apresentação; use as etapas, ignore valores):
${(await lerApresentacao()).slice(0, 2500)}

Conversa até agora:
${conversa}${nota ? `\n\nO que mudar desta vez (pedido do vendedor): ${nota}` : ""}`;
}

/**
 * Cria os slides de uma empresa ou, com `id`, refaz os que já existem (com o pedido `nota`, se houver).
 * Não envia nada. Retorna o registro salvo.
 */
export async function gerarSlides({ leadId, id = null, nota = "" }, campanha, { gerar = gerarJson } = {}) {
  const atual = id ? await db.buscarSlides(id) : null;
  if (id && !atual) throw new Error("Apresentação não encontrada");
  const lead = await db.buscarLead(atual?.lead_id ?? leadId);
  if (!lead) throw new Error("Empresa não encontrada");
  nota = corta(nota, 500);
  const dados = arrumarSlides(await gerar({
    system: sistema(campanha),
    pedido: await pedidoDaEmpresa(lead, nota, campanha),
    jsonSchema: ESQUEMA,
    zodSchema: ZOD,
    effort: "medium",
    maxTokens: 6000,
  }), { empresa: lead.nome });
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
  const arrumado = arrumarSlides(dados, { empresa: atual.empresa ?? "" });
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

function corpoDoSlide(s, i, { marca, telefone, site, empresa }) {
  const itens = s.itens ?? [];
  const cartoes = (classe = "") => `<div class="cartoes ${classe} n${Math.min(itens.length, 4)}">${itens.map((it, k) => `
    <div class="cartao" style="--k:${k}"><span class="ic">${ICONES[k % ICONES.length]}</span><b>${esc(it.titulo)}</b><p>${esc(it.texto)}</p></div>`).join("")}</div>`;
  const cab = `<div class="cab"><span class="tag">${String(i).padStart(2, "0")}</span><h2>${esc(s.titulo)}</h2>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}</div>`;
  switch (s.tipo) {
    case "capa":
      return `<div class="capa"><div class="marca"><span class="logo">${esc(marca.slice(0, 1))}</span>${esc(marca)}</div>
        <h1 class="entra">${esc(s.titulo)}</h1>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}<div class="linha"></div></div>`;
    case "conversa":
      return `<div class="duas">${cab}<div class="celular"><div class="tela"><div class="topo-wa"><span class="av">${esc((empresa || marca).slice(0, 1))}</span>${esc(empresa || "WhatsApp")}</div>
        ${itens.map((it, k) => `<div class="bolha ${/^cliente$/i.test(it.titulo) ? "ela" : "nos"}" style="--k:${k}">${esc(it.texto)}</div>`).join("")}</div></div></div>`;
    case "processo":
      return `${cab}<ol class="passos">${itens.map((it, k) => `<li style="--k:${k}"><span class="num">${k + 1}</span><b>${esc(it.titulo)}</b><p>${esc(it.texto)}</p></li>`).join("")}</ol>`;
    case "resultados":
      return `${cab}${cartoes("grandes")}`;
    case "proximo_passo":
      return `<div class="fim"><h2>${esc(s.titulo)}</h2>${s.subtitulo ? `<p class="sub">${esc(s.subtitulo)}</p>` : ""}
        <div class="contatos">${telefone ? `<span>WhatsApp ${esc(telefoneBonito(telefone))}</span>` : ""}${site ? `<span>${esc(site.replace(/^https?:\/\//, ""))}</span>` : ""}</div>
        <div class="marca">${esc(marca)}</div></div>`;
    default:
      return `${cab}${cartoes()}`;
  }
}

/** A apresentação inteira numa página: 16:9, setas/toque para passar, tela cheia e impressão (um slide por página). */
export function paginaDosSlides(registro, { marca = "FluxDeck", telefone = "", site = "" } = {}) {
  let dados = {};
  try { dados = typeof registro.dados === "string" ? JSON.parse(registro.dados) : registro.dados ?? {}; } catch {}
  const slides = dados.slides ?? [];
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
.capa{margin:auto 0;display:flex;flex-direction:column;gap:2cqw}
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
  .slide .entra,.slide .cartao,.slide .passos li,.slide .bolha{opacity:1;transform:none;animation:none}.controles,.toque,.barra,.rodape{display:none}}
</style></head><body>
<div class="palco"><div class="quadro" id="quadro">
${slides.map((s, i) => `<section class="slide${i === 0 ? " ativo" : ""}" data-tipo="${esc(s.tipo)}" aria-label="Slide ${i + 1} de ${slides.length}">${corpoDoSlide(s, i, { marca, telefone, site, empresa: registro.empresa ?? "" })
    .replace(/<h2>/g, '<h2 class="entra">').replace(/<p class="sub">/g, '<p class="sub entra" style="--k:1">')}</section>`).join("\n")}
<div class="rodape"><span>${esc(marca)}</span><span>${esc(registro.empresa ?? "")}</span></div>
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
