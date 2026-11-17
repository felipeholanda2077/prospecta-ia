// O checkout transparente da FluxDeck para empresas de fora do Brasil (fluxdeck.com.br/checkout/x/<código>): página
// nossa, com a logo e as cores da FluxDeck, e o cartão digitado no campo seguro do Stripe (Payment Element, dentro
// da página). Quem processa é o Stripe; os dados do cartão nunca passam pelo sistema.

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TEXTOS = {
  pt: {
    lang: "pt-PT", contratando: "Está a contratar", total: "Total", unico: "Pagamento único, sem mensalidade.", mensal: "por mês",
    email: "E-mail", nome: "Nome completo", pagar: "Pagar", seguro: "Pagamento seguro", processado: "Pagamento processado pelo Stripe",
    processadoTxt: "Cartão, Apple Pay e Google Pay com a segurança do Stripe.", protegidos: "Os seus dados protegidos",
    protegidosTxt: "Ligação encriptada. Não guardamos os dados do seu cartão.", recibo: "Recibo no seu e-mail",
    reciboTxt: "E falamos consigo pelo WhatsApp para começar.", preencha: "Preencha o nome e o e-mail.", erro: "Não foi possível concluir. Tente outro cartão.",
    ok: "Pagamento confirmado!", okTxt: "Obrigado! Já recebemos o seu pagamento e vamos falar consigo pelo WhatsApp para começar o seu site.",
    pendente: "Pagamento em processamento", pendenteTxt: "Assim que o Stripe confirmar, avisamos pelo WhatsApp.",
    contrato: "Ao pagar, aceita o contrato de serviço da FluxDeck", duvidas: "Dúvidas?",
  },
  en: {
    lang: "en", contratando: "You're getting", total: "Total", unico: "One-time payment, no monthly fee.", mensal: "per month",
    email: "Email", nome: "Full name", pagar: "Pay", seguro: "Secure payment", processado: "Payment processed by Stripe",
    processadoTxt: "Card, Apple Pay and Google Pay with Stripe security.", protegidos: "Your data is protected",
    protegidosTxt: "Encrypted connection. We never store your card details.", recibo: "Receipt by email",
    reciboTxt: "We'll reach out on WhatsApp to get started.", preencha: "Please fill in your name and email.", erro: "We couldn't complete it. Please try another card.",
    ok: "Payment confirmed!", okTxt: "Thank you! We received your payment and will reach out on WhatsApp to start your website.",
    pendente: "Payment processing", pendenteTxt: "As soon as Stripe confirms it, we'll let you know on WhatsApp.",
    contrato: "By paying, you agree to the FluxDeck Service Agreement", duvidas: "Questions?",
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
.feito{text-align:center;padding:48px 26px}.feito svg{width:64px;height:64px;color:var(--ok)}.feito h1{margin-top:12px}.feito p{color:var(--suave);max-width:30em;margin:8px auto 0}`;

const ESCUDO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>';
const CADEADO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const RECIBO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 1V2l-1 1-3-2-3 2-3-2-3 2-3-2z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
const CERTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>';

const cabeca = (t, titulo, logo) => `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulo)} · FluxDeck</title><link rel="icon" href="${esc(logo)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>${ESTILO}</style></head><body>
<header class="topo"><a class="marca" href="/"><img src="${esc(logo)}" alt="">FluxDeck</a><div class="seguro">${CADEADO}<span>${esc(t.seguro)}</span></div></header>`;

/**
 * A página do checkout. `compra` = { plano, empresa, valor, moeda, unico, pais }; `publica` = a chave publicável do
 * Stripe (pk_..., pública por natureza); `base` = o endereço desta página (para a intenção de pagamento e a volta).
 */
export function paginaDoCheckoutStripe(compra, { publica, base, logo = "/checkout/_/logo.jpg", contrato = "https://fluxdeck.com.br/en/terms", whatsapp = "" }) {
  const t = textosDoCheckout(compra.pais);
  const preco = new Intl.NumberFormat(t.lang, { style: "currency", currency: compra.moeda }).format(compra.valor);
  const local = compra.pais === "PT" ? "pt" : "en";
  return `${cabeca(t, compra.plano, logo)}
<main class="grade">
  <aside class="painel">
    <span class="rotulo">${esc(t.contratando)}</span>
    <h1>${esc(compra.plano)}</h1><div class="empresa">${esc(compra.empresa)}</div>
    <div class="linha"><span>${esc(compra.plano)}</span><b>${esc(preco)}</b></div>
    <div class="total"><span>${esc(t.total)}</span><b>${esc(preco)}</b></div>
    <p class="depois">${esc(compra.unico ? t.unico : t.mensal)}</p>
    <ul class="selos">
      <li>${ESCUDO}<span><b>${esc(t.processado)}</b>${esc(t.processadoTxt)}</span></li>
      <li>${CADEADO}<span><b>${esc(t.protegidos)}</b>${esc(t.protegidosTxt)}</span></li>
      <li>${RECIBO}<span><b>${esc(t.recibo)}</b>${esc(t.reciboTxt)}</span></li>
    </ul>
    ${whatsapp ? `<p class="letra">${esc(t.duvidas)} <a href="${esc(whatsapp)}" target="_blank" rel="noopener">WhatsApp</a></p>` : ""}
  </aside>
  <section class="painel">
    <form id="form">
      <div class="campo"><label for="nome">${esc(t.nome)}</label><input id="nome" autocomplete="name" required></div>
      <div class="campo"><label for="email">${esc(t.email)}</label><input id="email" type="email" autocomplete="email" required></div>
      <div id="elemento"></div>
      <button class="pagar" id="pagar" type="submit">${esc(t.pagar)} ${esc(preco)}</button>
      <div class="msg" id="msg" role="alert"></div>
      <p class="letra">${esc(t.contrato)}: <a href="${esc(contrato)}" target="_blank" rel="noopener">Service Agreement</a></p>
    </form>
  </section>
</main>
<script src="https://js.stripe.com/v3/"></script>
<script>
(async function(){
  var t = ${JSON.stringify({ preencha: t.preencha, erro: t.erro })};
  var stripe = Stripe(${JSON.stringify(publica)}, { locale: ${JSON.stringify(local)} });
  var msg = document.getElementById("msg"), botao = document.getElementById("pagar");
  var r = await fetch(${JSON.stringify(`${base}/intencao`)}, { method: "POST" }).then(function(x){ return x.json(); }).catch(function(){ return {}; });
  if (!r.clientSecret) { msg.textContent = r.erro || t.erro; botao.disabled = true; return; }
  var elements = stripe.elements({ clientSecret: r.clientSecret, appearance: { theme: "night", variables: { colorPrimary: "#00d4ff", colorBackground: "#131c33", borderRadius: "12px", fontFamily: "Plus Jakarta Sans, system-ui, sans-serif" } },
    fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600&display=swap" }] });
  elements.create("payment", { layout: "tabs" }).mount("#elemento");
  document.getElementById("form").addEventListener("submit", async function(ev){
    ev.preventDefault(); msg.textContent = "";
    var nome = document.getElementById("nome").value.trim(), email = document.getElementById("email").value.trim();
    if (!nome || !email) { msg.textContent = t.preencha; return; }
    botao.disabled = true;
    var res = await stripe.confirmPayment({ elements: elements, confirmParams: { return_url: location.origin + ${JSON.stringify(`${base}/obrigado`)}, receipt_email: email,
      payment_method_data: { billing_details: { name: nome, email: email } } } });
    if (res.error) { msg.textContent = res.error.message || t.erro; botao.disabled = false; }
  });
})();
</script>
</body></html>`;
}

/** A página de volta, depois do pagamento: confirmado ou em processamento. */
export function paginaDoCheckoutStripeFeito(compra, { pago, logo = "/checkout/_/logo.jpg" }) {
  const t = textosDoCheckout(compra.pais);
  return `${cabeca(t, compra.plano, logo)}
<main class="grade" style="grid-template-columns:1fr;max-width:640px"><section class="painel feito">${CERTO}
<h1>${esc(pago ? t.ok : t.pendente)}</h1><p>${esc(pago ? t.okTxt : t.pendenteTxt)}</p></section></main></body></html>`;
}
