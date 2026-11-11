// A página do checkout da FluxDeck (fluxdeck.com.br/checkout/<plano>): o cliente paga sem sair do nosso endereço,
// por Pix, cartão ou boleto, e quem processa é o Asaas (pela API). Os dados do cartão vão direto para o Asaas.

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reais = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
const telefoneBonito = (t) => {
  const d = String(t ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : String(t ?? "");
};

const ICONE = {
  escudo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  cadeado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  recibo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 1V2l-1 1-3-2-3 2-3-2-3 2-3-2z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  livre: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  pix: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 2.8 9.2 9.2-9.2 9.2L2.8 12z"/><path d="m7.5 7.5 4.5 4.5 4.5-4.5M7.5 16.5l4.5-4.5 4.5 4.5"/></svg>',
  cartao: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/></svg>',
  boleto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5v14M7 5v14M10 5v14M14 5v14M16 5v14M20 5v14"/></svg>',
};

/** A página inteira de um plano. `plano` vem de resumoDoPlano (checkoutsAsaas.js). */
export function paginaDoCheckout(plano, { marca = "FluxDeck", telefone = "", logo = "/checkout/_/logo.jpg" } = {}) {
  const linhas = plano.anual
    ? [["12 meses, implantação inclusa", reais(plano.hoje)]]
    : [...(plano.implantacao ? [["Implantação (uma vez)", reais(plano.implantacao)]] : []), ["1ª mensalidade", reais(plano.mensal)]];
  const depois = plano.anual
    ? `À vista no Pix ou boleto, ou em até 12x de ${reais(plano.hoje / 12)} no cartão.`
    : `Depois, ${reais(plano.mensal)} por mês. Sem fidelidade: cancele quando quiser.`;
  const parcelas = plano.anual
    ? Array.from({ length: 12 }, (_, k) => `<option value="${k + 1}">${k + 1}x de ${reais(Math.round((plano.hoje / (k + 1)) * 100) / 100)}${k ? "" : " (à vista)"}</option>`).join("")
    : "";
  const whats = telefone ? `https://wa.me/55${String(telefone).replace(/\D/g, "").replace(/^55/, "")}` : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Contratar ${esc(plano.plano)} · ${esc(marca)}</title>
<link rel="icon" href="${esc(logo)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#070b16;--card:#0f1628;--card2:#131c33;--borda:rgba(255,255,255,.09);--texto:#eef2ff;--suave:#9aa6c4;--ciano:#00d4ff;--violeta:#b44df5;--azul:#1e90ff;--ok:#2fd27c;--erro:#ff6b81}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:radial-gradient(50% 40% at 85% 0%,rgba(180,77,245,.16),transparent 70%),radial-gradient(45% 40% at 0% 100%,rgba(0,212,255,.12),transparent 70%),var(--bg);
  color:var(--texto);font-family:"Plus Jakarta Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.topo{max-width:1080px;margin:0 auto;padding:22px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.marca{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;text-decoration:none}
.marca img{width:36px;height:36px;border-radius:10px;background:#000;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 0 22px rgba(30,144,255,.35)}
.seguro{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--suave);font-weight:600}.seguro svg{width:16px;height:16px;color:var(--ok)}
.grade{max-width:1080px;margin:0 auto;padding:8px 20px 48px;display:grid;grid-template-columns:.9fr 1.1fr;gap:24px;align-items:start}
.painel{background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));border:1px solid var(--borda);border-radius:22px;padding:28px}
.resumo{position:sticky;top:20px}
.rotulo{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ciano);font-weight:700}
.resumo h1{font-size:30px;line-height:1.15;margin:8px 0 20px;letter-spacing:-.01em}
.linha{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--borda);font-size:15px;color:var(--suave)}
.linha b{color:var(--texto);font-weight:700}
.total{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:16px}
.total span{font-weight:700}.total b{font-size:34px;font-weight:800;background:linear-gradient(90deg,#fff 30%,var(--ciano));-webkit-background-clip:text;background-clip:text;color:transparent}
.depois{margin-top:8px;font-size:14px;color:var(--suave);line-height:1.5}
.selos{list-style:none;display:grid;gap:12px;margin-top:24px;padding-top:20px;border-top:1px solid var(--borda)}
.selos li{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;color:var(--suave)}
.selos svg{flex:none;width:20px;height:20px;color:var(--ciano);margin-top:1px}.selos b{color:var(--texto);display:block}
.ajuda{margin-top:20px;font-size:13.5px;color:var(--suave)}.ajuda a{color:var(--ciano);font-weight:700;text-decoration:none}
h2{font-size:18px;margin-bottom:14px}
.campos{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.campo{display:flex;flex-direction:column;gap:6px}.campo.todo{grid-column:1/-1}
label{font-size:13px;font-weight:600;color:var(--suave)}
input,select{width:100%;font:inherit;font-size:15px;color:var(--texto);background:var(--card2);border:1px solid var(--borda);border-radius:12px;padding:13px 14px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus,select:focus{border-color:var(--ciano);box-shadow:0 0 0 3px rgba(0,212,255,.15)}
input::placeholder{color:#5c6789}
.formas{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0 16px}
.forma{display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 8px;border-radius:14px;border:1px solid var(--borda);background:var(--card2);color:var(--texto);font:inherit;font-weight:700;font-size:14px;cursor:pointer;transition:.15s}
.forma svg{width:22px;height:22px;color:var(--suave)}.forma small{font-weight:500;font-size:11.5px;color:var(--suave)}
.forma[aria-pressed=true]{border-color:var(--ciano);background:linear-gradient(160deg,rgba(0,212,255,.12),rgba(180,77,245,.1));box-shadow:0 0 0 1px var(--ciano)}
.forma[aria-pressed=true] svg{color:var(--ciano)}
.bloco-cartao{display:none}.bloco-cartao.ativo{display:grid}
.dica{font-size:13px;color:var(--suave);line-height:1.5;margin-bottom:6px}
.pagar{margin-top:20px;width:100%;border:0;border-radius:14px;padding:17px;font:inherit;font-weight:800;font-size:17px;color:#06101f;cursor:pointer;
  background:linear-gradient(90deg,var(--ciano),var(--violeta));box-shadow:0 12px 32px rgba(0,212,255,.25);transition:transform .15s,opacity .15s}
.pagar:hover{transform:translateY(-1px)}.pagar:disabled{opacity:.6;cursor:wait;transform:none}
.erro{display:none;margin-top:14px;padding:12px 14px;border-radius:12px;background:rgba(255,107,129,.1);border:1px solid rgba(255,107,129,.35);color:#ffc2cc;font-size:14px}
.erro.ativo{display:block}
.rodape-form{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:14px;font-size:12.5px;color:var(--suave)}.rodape-form svg{width:14px;height:14px}
.escondido{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.resultado{display:none;text-align:center}.resultado.ativo{display:block}
.qr{width:220px;height:220px;margin:16px auto;border-radius:16px;background:#fff;padding:10px}.qr img{width:100%;height:100%}
.codigo{display:flex;gap:8px;margin:12px 0}.codigo input{font-size:13px}
.btn{border:1px solid var(--borda);background:var(--card2);color:var(--texto);border-radius:12px;padding:12px 16px;font:inherit;font-weight:700;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-block}
.esperando{display:flex;align-items:center;justify-content:center;gap:10px;color:var(--suave);font-size:14px;margin-top:10px}
.roda{width:16px;height:16px;border-radius:50%;border:2px solid var(--borda);border-top-color:var(--ciano);animation:gira 1s linear infinite}
@keyframes gira{to{transform:rotate(360deg)}}
.ok{width:76px;height:76px;margin:6px auto 16px;border-radius:50%;display:grid;place-items:center;font-size:38px;color:#06101f;background:linear-gradient(135deg,var(--ok),var(--ciano));box-shadow:0 0 40px rgba(47,210,124,.35);animation:pulsa 1.6s ease-out}
@keyframes pulsa{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}
.resultado h2{font-size:24px;margin-bottom:8px}.resultado p{color:var(--suave);line-height:1.55;font-size:15px}
@media (max-width:820px){.grade{grid-template-columns:1fr}.resumo{position:static}.resumo h1{font-size:25px}.painel{padding:22px}}
@media (max-width:480px){.campos{grid-template-columns:1fr}.forma small{display:none}.topo .seguro span{display:none}}
</style></head><body>
<header class="topo"><a class="marca" href="/"><img src="${esc(logo)}" alt="">${esc(marca)}</a><div class="seguro">${ICONE.cadeado}<span>Pagamento seguro</span></div></header>
<main class="grade">
  <aside class="painel resumo">
    <span class="rotulo">Você está contratando</span>
    <h1>${esc(plano.plano)}</h1>
    ${linhas.map(([a, b]) => `<div class="linha"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join("")}
    <div class="total"><span>Total hoje</span><b>${esc(reais(plano.hoje))}</b></div>
    <p class="depois">${esc(depois)}</p>
    <ul class="selos">
      <li>${ICONE.escudo}<span><b>Pagamento processado pelo Asaas</b>Pix, cartão e boleto com a segurança de uma instituição de pagamento.</span></li>
      <li>${ICONE.cadeado}<span><b>Seus dados protegidos</b>Conexão criptografada. Não guardamos os dados do seu cartão.</span></li>
      ${plano.anual ? "" : `<li>${ICONE.livre}<span><b>Sem fidelidade</b>Você cancela a mensalidade quando quiser.</span></li>`}
      <li>${ICONE.recibo}<span><b>Recibo no seu e-mail</b>E a gente chama você no WhatsApp para começar.</span></li>
    </ul>
    ${whats ? `<p class="ajuda">Dúvidas? <a href="${esc(whats)}" target="_blank" rel="noopener">WhatsApp ${esc(telefoneBonito(telefone))}</a></p>` : ""}
  </aside>

  <section class="painel">
    <form id="form" novalidate>
      <h2>Seus dados</h2>
      <div class="campos">
        <div class="campo todo"><label for="nome">Nome completo</label><input id="nome" name="nome" autocomplete="name" required></div>
        <div class="campo"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" required></div>
        <div class="campo"><label for="celular">WhatsApp</label><input id="celular" name="celular" inputmode="tel" autocomplete="tel-national" placeholder="(11) 99999-9999" required></div>
        <div class="campo todo"><label for="documento">CPF ou CNPJ</label><input id="documento" name="documento" inputmode="numeric" placeholder="000.000.000-00" required></div>
      </div>
      <input class="escondido" name="site" tabindex="-1" autocomplete="off" aria-hidden="true">

      <div class="formas" role="group" aria-label="Forma de pagamento">
        <button type="button" class="forma" data-forma="pix" aria-pressed="true">${ICONE.pix}Pix<small>Aprovação na hora</small></button>
        <button type="button" class="forma" data-forma="cartao" aria-pressed="false">${ICONE.cartao}Cartão<small>${plano.anual ? "Até 12x" : "Crédito"}</small></button>
        <button type="button" class="forma" data-forma="boleto" aria-pressed="false">${ICONE.boleto}Boleto<small>Até 3 dias úteis</small></button>
      </div>

      <div class="campos bloco-cartao" id="cartao">
        <div class="campo todo"><label for="numero">Número do cartão</label><input id="numero" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000"></div>
        <div class="campo todo"><label for="nomeCartao">Nome impresso no cartão</label><input id="nomeCartao" autocomplete="cc-name"></div>
        <div class="campo"><label for="validade">Validade</label><input id="validade" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/AA"></div>
        <div class="campo"><label for="cvv">CVV</label><input id="cvv" inputmode="numeric" autocomplete="cc-csc" placeholder="123"></div>
        <div class="campo"><label for="cep">CEP do titular</label><input id="cep" inputmode="numeric" autocomplete="postal-code" placeholder="00000-000"></div>
        <div class="campo"><label for="numeroEndereco">Número do endereço</label><input id="numeroEndereco" autocomplete="address-line2"></div>
        ${plano.anual ? `<div class="campo todo"><label for="parcelas">Parcelas</label><select id="parcelas">${parcelas}</select></div>` : ""}
      </div>
      <p class="dica" id="dica"></p>

      <button class="pagar" id="pagar" type="submit">Pagar ${esc(reais(plano.hoje))}</button>
      <div class="erro" id="erro" role="alert"></div>
      <p class="rodape-form">${ICONE.cadeado}Processado pelo Asaas · ${esc(marca)}</p>
    </form>

    <div class="resultado" id="resPix">
      <h2>Pague com Pix</h2><p>Abra o app do seu banco e escaneie o QR Code ou use o Pix copia e cola.</p>
      <div class="qr"><img id="qrImg" alt="QR Code do Pix"></div>
      <div class="codigo"><input id="pixCodigo" readonly aria-label="Pix copia e cola"><button class="btn" type="button" data-copiar="pixCodigo">Copiar</button></div>
      <div class="esperando"><span class="roda"></span>Aguardando o pagamento…</div>
    </div>
    <div class="resultado" id="resBoleto">
      <h2>Boleto gerado</h2><p>O boleto também foi para o seu e-mail. A confirmação leva até 3 dias úteis depois do pagamento.</p>
      <div class="codigo"><input id="linha" readonly aria-label="Linha digitável"><button class="btn" type="button" data-copiar="linha">Copiar</button></div>
      <a class="btn" id="boletoUrl" target="_blank" rel="noopener">Abrir o boleto</a>
    </div>
    <div class="resultado" id="resOk">
      <div class="ok">✓</div>
      <h2>Pagamento confirmado!</h2>
      <p>Bem-vindo à ${esc(marca)}. O recibo vai para o seu e-mail e a gente chama você no WhatsApp para começar a implantação.</p>
    </div>
  </section>
</main>
<script>
(function(){
var forma="pix",consulta=null;
var $=function(id){return document.getElementById(id)};
var dicas={pix:"Depois de clicar, aparece o QR Code. A confirmação é na hora.",cartao:"${plano.anual ? "Escolha em quantas vezes quer pagar." : "A mensalidade dos próximos meses é cobrada no mesmo cartão, sem fidelidade."}",boleto:"O boleto vence em 3 dias e a confirmação leva até 3 dias úteis."};
function escolher(f){forma=f;document.querySelectorAll(".forma").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.forma===f))});
  $("cartao").classList.toggle("ativo",f==="cartao");$("dica").textContent=dicas[f];}
document.querySelectorAll(".forma").forEach(function(b){b.addEventListener("click",function(){escolher(b.dataset.forma)})});
escolher("pix");
function mascara(el,fn){el.addEventListener("input",function(){var v=el.value.replace(/\\D/g,"");el.value=fn(v)})}
mascara($("documento"),function(v){v=v.slice(0,14);if(v.length<=11)return v.replace(/(\\d{3})(\\d)/,"$1.$2").replace(/(\\d{3})(\\d)/,"$1.$2").replace(/(\\d{3})(\\d{1,2})$/,"$1-$2");
  return v.replace(/^(\\d{2})(\\d)/,"$1.$2").replace(/^(\\d{2})\\.(\\d{3})(\\d)/,"$1.$2.$3").replace(/\\.(\\d{3})(\\d)/,".$1/$2").replace(/(\\d{4})(\\d)/,"$1-$2")});
mascara($("celular"),function(v){v=v.slice(0,11);return v.length>10?v.replace(/(\\d{2})(\\d{5})(\\d{0,4})/,"($1) $2-$3"):v.replace(/(\\d{2})(\\d{0,4})(\\d{0,4})/,function(m,a,b,c){return(a?"("+a+(a.length===2?") ":""):"")+b+(c?"-"+c:"")})});
mascara($("numero"),function(v){return v.slice(0,19).replace(/(\\d{4})(?=\\d)/g,"$1 ")});
mascara($("validade"),function(v){v=v.slice(0,4);return v.length>2?v.slice(0,2)+"/"+v.slice(2):v});
mascara($("cvv"),function(v){return v.slice(0,4)});
mascara($("cep"),function(v){v=v.slice(0,8);return v.length>5?v.slice(0,5)+"-"+v.slice(5):v});
document.querySelectorAll("[data-copiar]").forEach(function(b){b.addEventListener("click",function(){var i=$(b.dataset.copiar);i.select();
  (navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand("copy")});b.textContent="Copiado!";setTimeout(function(){b.textContent="Copiar"},2000)})});
var base=location.pathname.replace(/\\/+$/,"");
function mostrar(id){$("form").style.display="none";["resPix","resBoleto","resOk"].forEach(function(r){$(r).classList.toggle("ativo",r===id)});window.scrollTo({top:0,behavior:"smooth"})}
function acompanhar(id){var vezes=0;consulta=setInterval(function(){if(++vezes>450)return clearInterval(consulta);
  fetch(base+"/status/"+encodeURIComponent(id),{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(d){if(d&&d.pago){clearInterval(consulta);mostrar("resOk")}}).catch(function(){})},4000)}
$("form").addEventListener("submit",function(e){e.preventDefault();var erro=$("erro");erro.classList.remove("ativo");
  var f=e.target,corpo={forma:forma,nome:f.nome.value,email:f.email.value,celular:f.celular.value,documento:f.documento.value,site:f.site.value};
  if(forma==="cartao"){corpo.cartao={numero:$("numero").value,nome:$("nomeCartao").value,validade:$("validade").value,cvv:$("cvv").value,cep:$("cep").value,numeroEndereco:$("numeroEndereco").value};
    if($("parcelas"))corpo.parcelas=$("parcelas").value}
  var botao=$("pagar"),texto=botao.textContent;botao.disabled=true;botao.textContent=forma==="cartao"?"Processando o pagamento…":"Gerando…";
  fetch(base+"/pagar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(corpo)}).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})})
  .then(function(x){if(!x.ok)throw new Error(x.d&&x.d.erro||"Não foi possível concluir.");var d=x.d;
    if(d.pago)return mostrar("resOk");
    if(d.pix){$("qrImg").src="data:image/png;base64,"+d.pix.imagem;$("pixCodigo").value=d.pix.codigo;mostrar("resPix");return acompanhar(d.id)}
    if(d.boleto){$("linha").value=d.boleto.linha||"";if(d.boleto.url)$("boletoUrl").href=d.boleto.url;mostrar("resBoleto");return acompanhar(d.id)}})
  .catch(function(err){erro.textContent=err.message;erro.classList.add("ativo")})
  .finally(function(){botao.disabled=false;botao.textContent=texto;if(forma==="cartao"){$("cvv").value=""}})});
})();
</script></body></html>`;
}
