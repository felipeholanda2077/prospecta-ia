// O checkout transparente da FluxDeck para empresas de fora do Brasil (fluxdeck.com.br/checkout/x/<código>): página
// nossa, com a logo e as cores da FluxDeck, e o cartão digitado no campo seguro do Stripe (Payment Element, dentro
// da página). Quem processa é o Stripe; os dados do cartão nunca passam pelo sistema.

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TEXTOS = {
  pt: {
    lang: "pt-PT", inicio: "/pt", contratando: "Está a contratar", total: "Total", unico: "Pagamento único, sem mensalidade.", mensal: "por mês",
    email: "E-mail", nome: "Nome completo", pagar: "Pagar", seguro: "Pagamento seguro", processado: "Pagamento processado pelo Stripe",
    processadoTxt: "Cartão, Apple Pay e Google Pay com a segurança do Stripe.", protegidos: "Os seus dados protegidos",
    protegidosTxt: "Ligação encriptada. Não guardamos os dados do seu cartão.", recibo: "Recibo no seu e-mail",
    reciboTxt: "E falamos consigo pelo WhatsApp para começar.", preencha: "Preencha o nome e o e-mail.", erro: "Não foi possível concluir. Tente outro cartão.",
    ok: "Pagamento confirmado!", okTxt: "Obrigado! Já recebemos o seu pagamento e vamos falar consigo pelo WhatsApp para começar o seu site.",
    pendente: "Pagamento em processamento", pendenteTxt: "Assim que o Stripe confirmar, avisamos pelo WhatsApp.",
    contrato: "Ao pagar, aceita o contrato de serviço da FluxDeck", duvidas: "Dúvidas?",
    rapido: "Pagamento rápido", ouCartao: "ou pague com cartão", incluido: "O que está incluído", depoisTitulo: "Depois do pagamento",
    passos: ["Recebe a confirmação no e-mail.", "Falamos consigo pelo WhatsApp e pedimos as fotos e as informações.", "O seu site fica no ar no prazo de uma semana."],
    exemplo: "Ver o exemplo do seu site", empresaTitulo: "Quem está a receber", aceitos: "Aceitamos", contratoOpc: "Se preferir, fazemos um contrato de prestação de serviço.",
    hoje: "Hoje", criacao: "Criação do site (pagamento único)", mensalidade: "Mensalidade", porMes: "/mês", aPartir: "a partir de",
    depoisRec: (m, d) => `Depois, ${m} por mês no mesmo cartão. O primeiro débito é a ${d}; até lá não paga mais nada.`,
    autorizo: (m, d) => `Ao pagar, aceita o contrato de serviço da FluxDeck e autoriza a cobrança de ${m} por mês neste cartão a partir de ${d}, até cancelar`,
    okRec: (i, m, d) => `Obrigado! Recebemos os ${i} da criação do site. A mensalidade de ${m} fica agendada para ${d}. Vamos entrar em contacto consigo para começar.`,
    passosRec: (d) => ["Recebe a confirmação no e-mail.", "Entramos em contacto para pedir as informações do site e o acesso à API do seu sistema de agendamento.", `A primeira mensalidade só é cobrada a ${d}.`],
    itensSite: ["Site profissional com a cara da sua empresa", "Versão para telemóvel, rápida", "Botão do WhatsApp em todas as páginas", "Pronto para aparecer no Google", "Domínio e publicação incluídos", "Alterações sempre que precisar"],
  },
  en: {
    lang: "en", inicio: "/en", contratando: "You're getting", total: "Total", unico: "One-time payment, no monthly fee.", mensal: "per month",
    email: "Email", nome: "Full name", pagar: "Pay", seguro: "Secure payment", processado: "Payment processed by Stripe",
    processadoTxt: "Card, Apple Pay and Google Pay with Stripe security.", protegidos: "Your data is protected",
    protegidosTxt: "Encrypted connection. We never store your card details.", recibo: "Receipt by email",
    reciboTxt: "We'll reach out on WhatsApp to get started.", preencha: "Please fill in your name and email.", erro: "We couldn't complete it. Please try another card.",
    ok: "Payment confirmed!", okTxt: "Thank you! We received your payment and will reach out on WhatsApp to start your website.",
    pendente: "Payment processing", pendenteTxt: "As soon as Stripe confirms it, we'll let you know on WhatsApp.",
    contrato: "By paying, you agree to the FluxDeck Service Agreement", duvidas: "Questions?",
    rapido: "Express checkout", ouCartao: "or pay with card", incluido: "What's included", depoisTitulo: "After payment",
    passos: ["You get the confirmation by email.", "We reach out on WhatsApp for your photos and details.", "Your website goes live within one week."],
    exemplo: "See your website preview", empresaTitulo: "Who you're paying", aceitos: "We accept", contratoOpc: "If you prefer, we sign a service agreement.",
    hoje: "Due today", criacao: "Website build (one-time)", mensalidade: "Monthly plan", porMes: "/mo", aPartir: "from",
    depoisRec: (m, d) => `Then ${m} per month on the same card. The first charge is on ${d}; nothing else until then.`,
    autorizo: (m, d) => `By paying, you agree to the FluxDeck Service Agreement and authorize a charge of ${m} per month on this card starting ${d}, until you cancel`,
    okRec: (i, m, d) => `Thank you! We received ${i} for your website build. The ${m} monthly plan is scheduled to start on ${d}. We'll reach out to get started.`,
    passosRec: (d) => ["You get the confirmation by email.", "We reach out for your website details and access to your booking system's API.", `The first monthly charge only happens on ${d}.`],
    itensSite: ["A professional website with your brand", "Fast mobile version", "WhatsApp button on every page", "Ready to show up on Google", "Domain and publishing included", "Changes whenever you need"],
  },
};
export const textosDoCheckout = (pais) => (pais === "PT" ? TEXTOS.pt : TEXTOS.en);

const ESTILO = `:root{--bg:#070b16;--card:#0f1628;--card2:#131c33;--borda:rgba(255,255,255,.09);--texto:#eef2ff;--suave:#9aa6c4;--ciano:#00d4ff;--violeta:#b44df5;--ok:#2fd27c;--erro:#ff6b81}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:radial-gradient(50% 40% at 85% 0%,rgba(180,77,245,.16),transparent 70%),radial-gradient(45% 40% at 0% 100%,rgba(0,212,255,.12),transparent 70%),var(--bg);color:var(--texto);font:16px/1.5 "Plus Jakarta Sans",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--ciano)}
.topo{max-width:1040px;margin:0 auto;padding:22px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.marca{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;color:var(--texto);text-decoration:none}.marca img{width:38px;height:38px;border-radius:10px}
.seguro{display:flex;align-items:center;gap:6px;color:var(--suave);font-size:14px}.seguro svg{width:16px;height:16px}
.grade{max-width:1040px;margin:0 auto;padding:8px 16px 56px;display:grid;gap:20px}
@media (min-width:860px){.grade{grid-template-columns:.9fr 1.1fr;align-items:start}}
.painel{background:var(--card);border:1px solid var(--borda);border-radius:22px;padding:26px}
.rotulo{color:var(--suave);font-size:13px;text-transform:uppercase;letter-spacing:.08em;font-weight:700}
h1{font-size:28px;margin:6px 0 4px}.empresa{color:var(--suave);margin-bottom:18px}
.linha{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--borda)}
.total{display:flex;justify-content:space-between;align-items:baseline;padding:16px 0 4px;border-top:1px solid var(--borda)}
.total b{font-size:34px;background:linear-gradient(90deg,var(--ciano),var(--violeta));-webkit-background-clip:text;background-clip:text;color:transparent}
.depois{color:var(--suave);font-size:14px;margin-top:4px}
.selos{list-style:none;margin-top:22px;display:grid;gap:14px}.selos li{display:flex;gap:12px;font-size:14px;color:var(--suave)}.selos b{display:block;color:var(--texto)}
.selos svg{flex:none;width:22px;height:22px;color:var(--ciano)}
.campo{display:grid;gap:6px;margin-bottom:14px}.campo label{font-size:14px;color:var(--suave)}
.campo input{width:100%;padding:13px 14px;border-radius:12px;border:1px solid var(--borda);background:var(--card2);color:var(--texto);font:inherit}
.campo input:focus{outline:2px solid var(--ciano);outline-offset:1px}
#elemento{margin:6px 0 16px;min-height:180px}
.pagar{width:100%;padding:16px;border:0;border-radius:14px;font:inherit;font-weight:800;font-size:17px;color:#06101f;cursor:pointer;background:linear-gradient(90deg,var(--ciano),#7cf3ff);transition:transform .2s,box-shadow .2s}
.pagar:hover{transform:translateY(-1px);box-shadow:0 14px 30px -14px var(--ciano)}.pagar:disabled{opacity:.6;cursor:wait}
.msg{margin-top:12px;font-size:14px;color:var(--erro);min-height:20px}
.letra{color:var(--suave);font-size:12.5px;margin-top:12px}
.incluido{list-style:none;display:grid;gap:9px;margin:18px 0 4px}.incluido li{display:flex;gap:10px;font-size:14.5px}.incluido li::before{content:"✓";flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;color:#06101f;background:linear-gradient(135deg,var(--ciano),#7cf3ff)}
.sub{font-size:13px;color:var(--suave);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:22px 0 10px}
.passos{list-style:none;counter-reset:p;display:grid;gap:10px}.passos li{counter-increment:p;display:flex;gap:10px;font-size:14px;color:var(--suave)}.passos li::before{content:counter(p);flex:none;width:24px;height:24px;border-radius:8px;display:grid;place-items:center;font-weight:800;font-size:12.5px;color:var(--texto);background:var(--card2);border:1px solid var(--borda)}
.exemplo{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;padding:12px;border-radius:12px;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.08);color:var(--texto);text-decoration:none;font-weight:700;font-size:14.5px}.exemplo:hover{background:rgba(0,212,255,.14)}
.quem{margin-top:22px;padding:14px;border-radius:14px;background:var(--card2);border:1px solid var(--borda);font-size:13.5px;color:var(--suave);display:grid;gap:3px}.quem b{color:var(--texto)}
#rapido{margin-bottom:6px}.ou{display:flex;align-items:center;gap:10px;color:var(--suave);font-size:13px;margin:14px 0}.ou::before,.ou::after{content:"";flex:1;height:1px;background:var(--borda)}
.marcas{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:14px;color:var(--suave);font-size:12.5px}.marcas span{padding:4px 8px;border-radius:7px;background:#fff;color:#1a1f36;font-weight:800;font-size:11.5px;letter-spacing:.02em}
.stripe{display:inline-flex;align-items:center;gap:6px;margin-top:12px;color:var(--suave);font-size:12.5px}.stripe b{color:#fff;background:#635bff;border-radius:6px;padding:2px 7px;font-size:12px;letter-spacing:.02em}
.resumo-movel{display:none}
@media (max-width:859px){.grade{display:flex;flex-direction:column}.grade>.pagamento{order:-1}
  .resumo-movel{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--borda)}
  .resumo-movel b{font-size:24px;background:linear-gradient(90deg,var(--ciano),var(--violeta));-webkit-background-clip:text;background-clip:text;color:transparent}
  .resumo-movel span{color:var(--suave);font-size:14px}}
.feito{text-align:center;padding:48px 26px}.feito svg{width:64px;height:64px;color:var(--ok)}.feito h1{margin-top:12px}.feito p{color:var(--suave);max-width:30em;margin:8px auto 0}`;

const ESCUDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>';
const CADEADO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const RECIBO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 1V2l-1 1-3-2-3 2-3-2-3 2-3-2z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
const CERTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>';

const cabeca = (t, titulo, logo) => `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulo)} · FluxDeck</title><link rel="icon" href="${esc(logo)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${ESTILO}</style></head><body>
<header class="topo"><a class="marca" href="${esc(t.inicio)}"><img src="${esc(logo)}" alt="">FluxDeck</a><div class="seguro">${CADEADO}<span>${esc(t.seguro)}</span></div></header>`;

/**
 * A página do checkout. `compra` = { plano, empresa, valor, moeda, unico, pais }; `publica` = a chave publicável do
 * Stripe (pk_..., pública por natureza); `base` = o endereço desta página (para a intenção de pagamento e a volta).
 */
// A FluxDeck, para quem paga saber quem recebe (o mesmo do rodapé de fluxdeck.com.br).
const CNPJ_FLUXDECK = "57.167.092/0001-16";

const dataDoInicio = (t, inicio) => new Date(`${inicio}T12:00:00Z`).toLocaleDateString(t.lang === "en" ? "en-US" : t.lang, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function paginaDoCheckoutStripe(compra, { publica, base, volta = `${base}/obrigado`, intencao = `${base}/intencao`, logo = "/checkout/_/logo.jpg", contrato = "https://fluxdeck.com.br/en/terms", whatsapp = "", email = "", previa = "", site = "https://fluxdeck.com.br" }) {
  const t = textosDoCheckout(compra.pais);
  const dinheiro = (v) => new Intl.NumberFormat(t.lang, { style: "currency", currency: compra.moeda }).format(v);
  const rec = Boolean(compra.recorrente);
  // Assinatura com criação: hoje paga só a criação; a mensalidade começa na data marcada.
  const preco = dinheiro(rec ? compra.implantacao : compra.valor);
  const mensal = dinheiro(compra.valor);
  const inicio = rec ? dataDoInicio(t, compra.inicio) : "";
  const local = compra.pais === "PT" ? "pt" : "en";
  const itens = compra.itens ?? (/site/i.test(compra.plano) ? t.itensSite : null);
  const passos = rec ? t.passosRec(inicio) : t.passos;
  return `${cabeca(t, compra.plano, logo)}
<main class="grade">
  <aside class="painel">
    <span class="rotulo">${esc(t.contratando)}</span>
    <h1>${esc(compra.plano)}</h1>${compra.empresa ? `<div class="empresa">${esc(compra.empresa)}</div>` : '<div class="empresa"></div>'}
    ${rec ? `<div class="linha"><span>${esc(t.criacao)}</span><b>${esc(preco)}</b></div>
    <div class="linha"><span>${esc(t.mensalidade)}<br><small style="color:var(--suave)">${esc(t.aPartir)} ${esc(inicio)}</small></span><b>${esc(mensal)}${esc(t.porMes)}</b></div>
    <div class="total"><span>${esc(t.hoje)}</span><b>${esc(preco)}</b></div>
    <p class="depois">${esc(t.depoisRec(mensal, inicio))}</p>`
    : `<div class="linha"><span>${esc(compra.plano)}</span><b>${esc(preco)}</b></div>
    <div class="total"><span>${esc(t.total)}</span><b>${esc(preco)}</b></div>
    <p class="depois">${esc(compra.unico ? t.unico : t.mensal)}</p>`}
    ${itens ? `<div class="sub">${esc(t.incluido)}</div><ul class="incluido">${itens.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
    ${previa ? `<a class="exemplo" href="${esc(previa)}" target="_blank" rel="noopener">👀 ${esc(t.exemplo)}</a>` : ""}
    <div class="sub">${esc(t.depoisTitulo)}</div><ol class="passos">${passos.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
    <p class="depois" style="margin-top:12px">${esc(t.contratoOpc)}</p>
    <ul class="selos">
      <li>${ESCUDO}<span><b>${esc(t.processado)}</b>${esc(t.processadoTxt)}</span></li>
      <li>${CADEADO}<span><b>${esc(t.protegidos)}</b>${esc(t.protegidosTxt)}</span></li>
      <li>${RECIBO}<span><b>${esc(t.recibo)}</b>${esc(t.reciboTxt)}</span></li>
    </ul>
    <div class="quem"><span>${esc(t.empresaTitulo)}</span><b>FluxDeck</b><span>CNPJ ${CNPJ_FLUXDECK}</span>
      <span><a href="${esc(site)}" target="_blank" rel="noopener">${esc(site.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>${email ? ` · ${esc(email)}` : ""}</span>
      ${whatsapp ? `<span>${esc(t.duvidas)} <a href="${esc(whatsapp)}" target="_blank" rel="noopener">WhatsApp</a></span>` : ""}</div>
  </aside>
  <section class="painel pagamento">
    <div class="resumo-movel"><span>${esc(compra.plano)}${compra.empresa ? ` · ${esc(compra.empresa)}` : ""}${rec ? ` · ${esc(t.hoje)}` : ""}</span><b>${esc(preco)}</b></div>
    <div id="caixa-rapido" hidden><div class="sub" style="margin-top:0">${esc(t.rapido)}</div><div id="rapido"></div><div class="ou">${esc(t.ouCartao)}</div></div>
    <form id="form">
      <div class="campo"><label for="nome">${esc(t.nome)}</label><input id="nome" autocomplete="name" required></div>
      <div class="campo"><label for="email">${esc(t.email)}</label><input id="email" type="email" autocomplete="email" required></div>
      <div id="elemento"></div>
      <button class="pagar" id="pagar" type="submit">${esc(t.pagar)} ${esc(preco)}</button>
      <div class="msg" id="msg" role="alert"></div>
      <div class="marcas">${esc(t.aceitos)}: <span>VISA</span><span>Mastercard</span><span>AMEX</span><span>Apple Pay</span><span>Google Pay</span></div>
      <div class="stripe">${CADEADO.replace("<svg", '<svg width="14" height="14"')} SSL · <b>stripe</b></div>
      <p class="letra">${esc(rec ? t.autorizo(mensal, inicio) : t.contrato)}: <a href="${esc(contrato)}" target="_blank" rel="noopener">Service Agreement</a></p>
    </form>
  </section>
</main>
<script src="https://js.stripe.com/v3/"></script>
<script>
(async function(){
  var t = ${JSON.stringify({ preencha: t.preencha, erro: t.erro })};
  var stripe = Stripe(${JSON.stringify(publica)}, { locale: ${JSON.stringify(local)} });
  var msg = document.getElementById("msg"), botao = document.getElementById("pagar");
  var volta = location.origin + ${JSON.stringify(volta)}, rec = ${JSON.stringify(rec)};
  var aparencia = { theme: "night", variables: { colorPrimary: "#00d4ff", colorBackground: "#131c33", borderRadius: "12px", fontFamily: "Plus Jakarta Sans, system-ui, sans-serif" } };
  var fontes = [{ cssSrc: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600&display=swap" }];
  var pedir = function(dados){ return fetch(${JSON.stringify(intencao)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dados || {}) })
    .then(function(x){ return x.json(); }).catch(function(){ return {}; }); };
  var elements, segredo = null;
  if (rec) {
    // Assinatura: o campo do cartão abre já; a cobrança (só a criação do site) é criada quando a pessoa paga, com o nome e o e-mail.
    elements = stripe.elements({ mode: "payment", amount: ${Math.round((rec ? compra.implantacao : compra.valor) * 100)}, currency: ${JSON.stringify(String(compra.moeda).toLowerCase())},
      setupFutureUsage: "off_session", paymentMethodTypes: ["card"], appearance: aparencia, fonts: fontes });
  } else {
    var r = await pedir();
    if (!r.clientSecret) { msg.textContent = r.erro || t.erro; botao.disabled = true; return; }
    segredo = r.clientSecret;
    elements = stripe.elements({ clientSecret: segredo, appearance: aparencia, fonts: fontes });
  }
  elements.create("payment", { layout: { type: "accordion", defaultCollapsed: false, radios: true, spacedAccordionItems: true }, wallets: { applePay: "auto", googlePay: "auto" },
    defaultValues: { billingDetails: { address: { country: ${JSON.stringify(compra.pais || "PT")} } } } }).mount("#elemento");
  // Na assinatura, confirma a cobrança criada agora para esta pessoa; no pagamento único, a que já veio com a página.
  async function pagar(nome, email, carteira){
    var cs = segredo, extra = {};
    if (rec) {
      var envio = await elements.submit();
      if (envio.error) return envio;
      var a = await pedir({ nome: nome, email: email });
      if (!a.clientSecret) return { error: { message: a.erro || t.erro } };
      cs = a.clientSecret;
    } else if (email && !carteira) extra.receipt_email = email;
    if (!carteira && (nome || email)) extra.payment_method_data = { billing_details: { name: nome, email: email } };
    var params = Object.assign({ return_url: volta }, extra);
    return stripe.confirmPayment(rec ? { elements: elements, clientSecret: cs, confirmParams: params } : { elements: elements, confirmParams: params });
  }
  // Apple Pay e Google Pay num toque (aparecem só no aparelho que tem).
  try {
    var rapido = elements.create("expressCheckout", { buttonHeight: 48, buttonType: { applePay: "buy", googlePay: "buy" }, emailRequired: rec });
    rapido.on("ready", function(ev){ if (ev.availablePaymentMethods) document.getElementById("caixa-rapido").hidden = false; });
    rapido.on("confirm", async function(ev){
      var d = (ev && ev.billingDetails) || {};
      var res = await pagar(d.name || document.getElementById("nome").value.trim(), d.email || document.getElementById("email").value.trim(), true);
      if (res && res.error) msg.textContent = res.error.message || t.erro;
    });
    rapido.mount("#rapido");
  } catch (e) {}
  document.getElementById("form").addEventListener("submit", async function(ev){
    ev.preventDefault(); msg.textContent = "";
    var nome = document.getElementById("nome").value.trim(), email = document.getElementById("email").value.trim();
    if (!nome || !email) { msg.textContent = t.preencha; return; }
    botao.disabled = true;
    var res = await pagar(nome, email);
    if (res && res.error) { msg.textContent = res.error.message || t.erro; botao.disabled = false; }
  });
})();
</script>
</body></html>`;
}

function okDaAssinatura(t, compra) {
  const d = (v) => new Intl.NumberFormat(t.lang, { style: "currency", currency: compra.moeda }).format(v);
  return t.okRec(d(compra.implantacao), d(compra.valor), dataDoInicio(t, compra.inicio));
}

/** A página de volta, depois do pagamento: confirmado ou em processamento. */
export function paginaDoCheckoutStripeFeito(compra, { pago, logo = "/checkout/_/logo.jpg" }) {
  const t = textosDoCheckout(compra.pais);
  return `${cabeca(t, compra.plano, logo)}
<main class="grade" style="grid-template-columns:1fr;max-width:640px"><section class="painel feito">${CERTO}
<h1>${esc(pago ? t.ok : t.pendente)}</h1><p>${esc(!pago ? t.pendenteTxt : compra.recorrente ? okDaAssinatura(t, compra) : t.okTxt)}</p></section></main></body></html>`;
}
