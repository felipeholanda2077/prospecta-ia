import { test } from "node:test";
import assert from "node:assert/strict";
import { analisarHtml, extrairEmails, extrairWhatsapp, paginasDeContato, decodificarCfemail } from "../src/analise/site.js";
import { identificarOportunidades } from "../src/analise/oportunidades.js";
import { ehCelularBR, normalizarTelefoneBR } from "../src/analise/telefone.js";

const SITE_ANTIGO = `<html><head><title>Ótica Visão</title></head>
<body><p>Bem-vindo</p><a href="mailto:contato@oticavisao.com.br">fale</a>
<img src="logo@2x.png"> suporte@wix.com <footer>© 2017 Ótica Visão</footer></body></html>`;

const SITE_MODERNO = `<html><head><title>Clínica Sorriso</title>
<meta name="viewport" content="width=device-width"><meta name="description" content="Dentistas em Fortaleza">
</head><body>${"Tratamentos odontológicos completos. ".repeat(40)}
<a href="https://wa.me/5585988887777">WhatsApp</a> Agende online sua consulta. © 2026</body></html>`;

test("analisarHtml detecta site antigo e sem versão mobile", () => {
  const a = analisarHtml(SITE_ANTIGO, "http://oticavisao.com.br");
  assert.equal(a.https, false);
  assert.equal(a.responsivo, false);
  assert.equal(a.anoCopyright, 2017);
  assert.equal(a.temLoja, false);
  assert.equal(a.poucoConteudo, true);
});

test("analisarHtml detecta site moderno com agendamento e WhatsApp", () => {
  const a = analisarHtml(SITE_MODERNO, "https://clinicasorriso.com.br");
  assert.equal(a.https, true);
  assert.equal(a.responsivo, true);
  assert.equal(a.temDescricao, true);
  assert.equal(a.temAgendamento, true);
  assert.equal(a.temChat, true);
});

test("extrairEmails ignora imagens e prioriza o domínio do site", () => {
  const emails = extrairEmails(SITE_ANTIGO + " vendas@gmail.com", "http://www.oticavisao.com.br");
  assert.equal(emails[0], "contato@oticavisao.com.br");
  assert.ok(!emails.some((e) => e.endsWith(".png")));
});

test("extrairWhatsapp lê links wa.me", () => {
  assert.equal(extrairWhatsapp(SITE_MODERNO), "5585988887777");
  assert.equal(extrairWhatsapp("<p>sem whats</p>"), null);
});

test("telefones brasileiros", () => {
  assert.equal(normalizarTelefoneBR("(85) 98888-7777"), "5585988887777");
  assert.equal(normalizarTelefoneBR("+55 85 3333-4444"), "558533334444");
  assert.equal(ehCelularBR("(85) 98888-7777"), true);
  assert.equal(ehCelularBR("(85) 3333-4444"), false);
  assert.equal(normalizarTelefoneBR("123"), null);
});

test("empresa sem site de varejo recebe site e e-commerce", () => {
  const ops = identificarOportunidades({ temSite: false }, "loja de roupas");
  assert.deepEqual(ops.map((o) => o.servico), ["site", "ecommerce"]);
});

test("site antigo de ótica recebe modernização e loja virtual", () => {
  const analise = { temSite: true, ...analisarHtml(SITE_ANTIGO, "http://oticavisao.com.br") };
  const servicos = identificarOportunidades(analise, "ótica").map((o) => o.servico);
  assert.ok(servicos.includes("redesign"));
  assert.ok(servicos.includes("ecommerce"));
});

test("site completo de clínica não recebe redesign nem agendamento", () => {
  const analise = { temSite: true, tempoRespostaMs: 800, ...analisarHtml(SITE_MODERNO, "https://clinicasorriso.com.br") };
  const servicos = identificarOportunidades(analise, "clínica odontológica").map((o) => o.servico);
  assert.ok(!servicos.includes("redesign"));
  assert.ok(!servicos.includes("agendamento"));
});

test("extrairEmails acha e-mail protegido pelo Cloudflare e escrito com [arroba]", () => {
  const chave = 0x2a;
  const hex = [chave, ...Buffer.from("contato@clinica.com.br")].map((b, i) => (i ? b ^ chave : b).toString(16).padStart(2, "0")).join("");
  assert.equal(decodificarCfemail(hex), "contato@clinica.com.br");
  const html = `<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</a>
    <p>Fale com a gente: agenda [arroba] clinica.com.br</p>`;
  assert.deepEqual(extrairEmails(html, "https://clinica.com.br").sort(), ["agenda@clinica.com.br", "contato@clinica.com.br"]);
});

test("paginasDeContato segue os links do próprio site antes dos caminhos comuns", () => {
  const html = `<a href="/fale-com-a-gente">Fale conosco</a> <a href="https://outro.com/contato">Contato</a>
    <a href="/servicos">Serviços</a> <a href="quem-somos.html"><span>Quem somos</span></a>`;
  const paginas = paginasDeContato(html, "https://clinica.com.br/");
  assert.deepEqual(paginas, ["https://clinica.com.br/fale-com-a-gente", "https://clinica.com.br/quem-somos.html",
                             "https://clinica.com.br/contato", "https://clinica.com.br/fale-conosco"]);
});
