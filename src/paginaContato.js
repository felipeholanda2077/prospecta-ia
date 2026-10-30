// Página pública do formulário de contato (o link do site e da bio do Instagram). Funciona sem
// JavaScript (envio normal do formulário) e, com `?embed=1`, fica sem fundo para ir num iframe no site.

const escapar = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ESTILO = `
  :root{--bg:#f5f6fb;--card:#fff;--text:#14151f;--muted:#5d6275;--accent:#5b4cf0;--accent-soft:#ecebfe;--border:#e3e5ef;--danger:#c0362c;--ok:#1f8a4c}
  @media (prefers-color-scheme:dark){:root{--bg:#0b0c14;--card:#141625;--text:#eceef8;--muted:#9aa0b8;--accent:#8b7dff;--accent-soft:#25234a;--border:#262940;--danger:#ff7a6e;--ok:#4cd087}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);
       font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
  body.embed{background:transparent;padding:0;min-height:0}
  main{width:100%;max-width:520px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:28px 24px;
       box-shadow:0 20px 50px -24px rgba(20,21,40,.35)}
  body.embed main{max-width:none;box-shadow:none}
  .marca{font-weight:700;color:var(--accent);margin-bottom:6px}
  h1{margin:0 0 6px;font-size:24px;letter-spacing:-.02em;line-height:1.2}
  p.sub{color:var(--muted);margin:0 0 20px}
  form{display:grid;gap:14px}
  .linha{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:520px){.linha{grid-template-columns:1fr}}
  label{display:grid;gap:6px;font-size:14px;font-weight:600}
  label span.op{font-weight:400;color:var(--muted)}
  input,select,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:11px 13px;width:100%}
  input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  textarea{min-height:96px;resize:vertical}
  .aceite{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:13.5px;color:var(--muted)}
  .aceite input{width:18px;height:18px;margin-top:2px;flex:none;accent-color:var(--accent)}
  .escondido{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  button{font:inherit;font-weight:600;padding:13px 18px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
  button:disabled{opacity:.6;cursor:wait}
  .erro{color:var(--danger);font-size:14px;min-height:1em}
  .pronto{text-align:center;padding:12px 0}
  .pronto .ic{font-size:40px;line-height:1}
  .pronto h2{margin:10px 0 6px}
  .pronto p{color:var(--muted);margin:0}`;

/** O formulário. `servicos` vira a lista "Do que você precisa?". */
export function paginaDoFormulario({ empresa, servicos = [], origem = "", embed = false, erro = "" }) {
  const opcoes = [...servicos.map((s) => s.nome), "Ainda não sei, quero conversar"];
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fale com a ${escapar(empresa)}</title>
<meta name="description" content="Conte o que você precisa e a ${escapar(empresa)} te chama no WhatsApp.">
<style>${ESTILO}</style></head><body${embed ? ' class="embed"' : ""}><main>
  <div id="area">
    ${embed ? "" : `<div class="marca">${escapar(empresa)}</div>`}
    <h1>Vamos tirar sua ideia do papel?</h1>
    <p class="sub">Conte o que você precisa. A gente te chama no WhatsApp para entender e mostrar como pode ficar.</p>
    <form method="post" action="/contato" id="form" novalidate>
      <div class="linha">
        <label>Seu nome<input name="nome" autocomplete="name" required maxlength="80"></label>
        <label>Empresa <span class="op">(opcional)</span><input name="empresa" autocomplete="organization" maxlength="100"></label>
      </div>
      <div class="linha">
        <label>WhatsApp<input name="whatsapp" type="tel" inputmode="tel" autocomplete="tel" placeholder="(85) 99999-9999" maxlength="20"></label>
        <label>E-mail <span class="op">(opcional)</span><input name="email" type="email" autocomplete="email" maxlength="120"></label>
      </div>
      <label>Do que você precisa?<select name="servico">${opcoes.map((o) => `<option>${escapar(o)}</option>`).join("")}</select></label>
      <label>Conte um pouco <span class="op">(opcional)</span><textarea name="mensagem" maxlength="1000" placeholder="Ex.: tenho uma clínica e quero agendamento online pelo site"></textarea></label>
      <label class="escondido" aria-hidden="true">Não preencha<input name="site" tabindex="-1" autocomplete="off"></label>
      <input type="hidden" name="origem" value="${escapar(origem)}">
      <input type="hidden" name="t" value="${Date.now()}">
      <label class="aceite"><input type="checkbox" name="consentimento" value="true" required>
        <span>Aceito que a ${escapar(empresa)} entre em contato comigo pelo WhatsApp ou e-mail sobre o meu pedido.</span></label>
      <div class="erro" id="erro" role="alert">${escapar(erro)}</div>
      <button type="submit" id="enviar">Quero ser chamado</button>
    </form>
  </div>
</main>
<script>
  const form = document.getElementById("form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const botao = document.getElementById("enviar");
    const erro = document.getElementById("erro");
    erro.textContent = "";
    botao.disabled = true;
    try {
      const dados = Object.fromEntries(new FormData(form));
      dados.consentimento = form.consentimento.checked;
      const r = await fetch("/contato", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dados) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.erro) throw new Error(d.erro || "Não foi possível enviar agora. Tente de novo em instantes.");
      document.getElementById("area").innerHTML = ${JSON.stringify(PRONTO)};
      parent.postMessage({ tipo: "contato-enviado" }, "*");
    } catch (e) {
      erro.textContent = e.message;
      botao.disabled = false;
    }
  });
</script></body></html>`;
}

const PRONTO = `<div class="pronto"><div class="ic">✅</div><h2>Recebemos!</h2>
  <p>Em breve a gente te chama no WhatsApp (em horário comercial, de segunda a sexta).</p></div>`;

/** Página de "recebemos" para o envio sem JavaScript. */
export function paginaDeObrigado({ empresa, embed = false }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Recebemos · ${escapar(empresa)}</title>
<style>${ESTILO}</style></head><body${embed ? ' class="embed"' : ""}><main>${PRONTO}</main></body></html>`;
}
