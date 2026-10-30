import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";

const LOGO = new URL("../../public/fluxdeck-logo.jpg", import.meta.url);

// O texto do contrato é simples de editar à mão:
//   # Título · ## Subtítulo · ### Cláusula · **negrito** · | tabela | (com |---| abaixo da 1ª linha, ela é o cabeçalho)
//   ::assinatura ... ::  (cada linha: esquerda | direita)  ·  ::resumo ... ::  (cada linha: rótulo | valor)  ·  ::aviso Título ... ::
// Daqui saem a prévia do painel e o PDF, para os dois ficarem iguais.

export function lerBlocos(texto) {
  const linhas = String(texto ?? "").replace(/\r/g, "").split("\n");
  const blocos = [];
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i].trim();
    if (!l) continue;
    if (l.startsWith("### ")) blocos.push({ tipo: "clausula", texto: l.slice(4) });
    else if (l.startsWith("## ")) blocos.push({ tipo: "subtitulo", texto: l.slice(3) });
    else if (l.startsWith("# ")) blocos.push({ tipo: "titulo", texto: l.slice(2) });
    else if (l.startsWith("::assinatura") || l.startsWith("::aviso") || l.startsWith("::resumo")) {
      const conteudo = [];
      for (i++; i < linhas.length && linhas[i].trim() !== "::"; i++) if (linhas[i].trim()) conteudo.push(linhas[i].trim());
      if (l.startsWith("::aviso")) blocos.push({ tipo: "aviso", titulo: l.slice(7).trim(), texto: conteudo.join(" ") });
      else if (l.startsWith("::resumo")) blocos.push({ tipo: "resumo", linhas: conteudo.map((c) => c.split("|").map((x) => x.trim())) });
      else blocos.push({ tipo: "assinatura", linhas: conteudo.map((c) => c.split("|").map((x) => x.trim())) });
    } else if (l.startsWith("|")) {
      const celulas = (c) => c.replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
      const grupo = [];
      while (i < linhas.length && linhas[i].trim().startsWith("|")) grupo.push(linhas[i++].trim());
      i--;
      const separador = grupo[1] && /^\|[\s:|-]+\|$/.test(grupo[1]);
      blocos.push({ tipo: "tabela", cabecalho: separador ? celulas(grupo[0]) : null, linhas: grupo.slice(separador ? 2 : 0).map(celulas) });
    } else blocos.push({ tipo: /^\d+\.\d+\.?\s/.test(l) ? "item" : "paragrafo", texto: l });
  }
  return blocos;
}

/** "a **b** c" → [{ texto: "a " }, { texto: "b", negrito: true }, { texto: " c" }] */
export function trechos(texto) {
  return String(texto).split(/(\*\*[^*]+\*\*)/).filter(Boolean)
    .map((t) => (t.startsWith("**") && t.endsWith("**") ? { texto: t.slice(2, -2), negrito: true } : { texto: t }));
}

const escapar = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Como cada campo do modelo aparece na folha, para ninguém precisar ler {{contratante_nome}}. */
export const ROTULOS_CAMPOS = {
  contratada_nome: "Seu nome", contratada_cnpj: "CNPJ da empresa", contratada_cpf: "Seu CPF", contratada_marca: "Sua marca", contratada_email: "Seu e-mail", contratada_pix: "Sua chave PIX",
  subtitulo: "Subtítulo do contrato", contratante_nome: "Nome do cliente", contratante_documento: "CNPJ ou CPF do cliente (por extenso)",
  contratante_documento_curto: "CNPJ ou CPF do cliente", contratante_email: "E-mail do cliente", representante: "Representante", representante_cpf: "CPF do representante",
  objeto: "O que será feito", documento_escopo: "Documento de escopo", valor_total: "Valor total", forma_de_pagamento: "Forma de pagamento",
  tabela_pagamento: "Tabela de parcelas", bloco_resumo: "Resumo do contrato", prazo: "Prazo", obrigacoes_contratante: "O que o cliente entrega", rescisao_valores_pagos: "Valores na rescisão", foro: "Foro",
};

/**
 * Um trecho de texto para a folha: {{campo}} vira um selo com o valor (ou o nome do campo, em destaque se
 * faltar preencher) e a linha em branco (____) fica marcada, para clicar e digitar por cima.
 */
function textoNaFolha(texto, valores) {
  return escapar(texto)
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (tudo, nome) => {
      const valor = valores[nome];
      const rotulo = ROTULOS_CAMPOS[nome] ?? nome;
      const falta = nome in valores && !valor;
      return `<span class="ct-campo${falta ? " falta" : ""}" contenteditable="false" data-campo="${nome}" title="${escapar(rotulo)}">${escapar(valor || (falta ? `${rotulo}: preencher` : rotulo))}</span>`;
    })
    .replace(/_{4,}/g, (linha) => `<span class="ct-branco" title="Clique e digite">${linha}</span>`);
}

const inline = (t, valores = {}) => trechos(t).map((x) => (x.negrito ? `<b>${textoNaFolha(x.texto, valores)}</b>` : textoNaFolha(x.texto, valores))).join("");

/** O documento em HTML, para a folha do painel (o texto é escapado: ele é digitado à mão). */
export function documentoEmHtml(texto, { valores = {} } = {}) {
  const t = (x) => inline(x, valores);
  return lerBlocos(texto).map((b) => {
    switch (b.tipo) {
      case "titulo": return `<h2>${t(b.texto)}</h2>`;
      case "subtitulo": return `<p class="ct-subtitulo">${t(b.texto)}</p>`;
      case "clausula": return `<h3>${t(b.texto)}</h3>`;
      case "item": return `<p class="ct-item">${t(b.texto)}</p>`;
      case "tabela": return `<div class="ct-tabela${b.cabecalho ? " com-cabecalho" : ""}"><table>${b.cabecalho ? `<thead><tr>${b.cabecalho.map((c) => `<th>${t(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${b.linhas.map((l) => `<tr>${l.map((c) => `<td>${t(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      case "resumo": return `<div class="ct-resumo">${b.linhas.map((l) => `<div><div class="ct-resumo-rotulo">${t(l[0] ?? "")}</div><div class="ct-resumo-valor">${t(l[1] ?? "")}</div></div>`).join("")}</div>`;
      case "assinatura": return `<div class="ct-assinaturas">${[0, 1].map((col) => `<div>${b.linhas.map((l, i) => `<div class="${i === 0 ? "ct-nome" : ""}">${t(l[col] ?? "") || "<br>"}</div>`).join("")}</div>`).join("")}</div>`;
      case "aviso": return `<div class="ct-aviso"><div class="ct-aviso-titulo">${t(b.titulo)}</div><p>${t(b.texto)}</p></div>`;
      default: return `<p>${t(b.texto)}</p>`;
    }
  }).join("");
}

const COR = { texto: "#0f172a", suave: "#5b6478", marca: "#0f8bff", linha: "#dfe5ef", fundo: "#f1f7ff", preto: "#000000", claro: "#ffffff" };
const MARGEM = { x: 54, topo: 76, base: 58 };
// Cabeçalho preto, onde a logo (fundo preto) se funde: alto na primeira página, fino nas outras.
const ALTURA_CAPA = 92;
const ALTURA_FAIXA = 46;

/** Escreve um texto com partes em negrito, seguindo na mesma linha. */
function escrever(doc, texto, { x, largura, tamanho = 10.5, cor = COR.texto, align = "left", negrito = false, depois = 0 }) {
  const partes = trechos(texto);
  doc.fillColor(cor).fontSize(tamanho);
  partes.forEach((p, i) => {
    doc.font(p.negrito || negrito ? "Helvetica-Bold" : "Helvetica");
    const opcoes = { width: largura, align, continued: i < partes.length - 1, lineGap: 1.5 };
    if (i === 0) doc.text(p.texto, x, doc.y, opcoes);
    else doc.text(p.texto, opcoes);
  });
  if (depois) doc.y += depois;
}

const alturaDe = (doc, texto, largura, tamanho, negrito = false) =>
  doc.font(negrito ? "Helvetica-Bold" : "Helvetica").fontSize(tamanho).heightOfString(String(texto).replace(/\*\*/g, ""), { width: largura, lineGap: 1.5 });

function novaPaginaSePreciso(doc, altura) {
  if (doc.y + altura > doc.page.height - MARGEM.base) doc.addPage();
}

/** As partes do contrato: um cartão para cada uma, lado a lado. */
function cartoesDasPartes(doc, linhas, largura) {
  const col = (largura - 14) / 2;
  const altura = Math.max(...linhas.map((l) => alturaDe(doc, l[1], col - 24, 9.5))) + 42;
  novaPaginaSePreciso(doc, altura);
  const y = doc.y;
  linhas.slice(0, 2).forEach((l, i) => {
    const x = MARGEM.x + i * (col + 14);
    doc.roundedRect(x, y, col, altura, 8).fill(COR.fundo);
    doc.y = y + 12;
    escrever(doc, l[0], { x: x + 12, largura: col - 24, tamanho: 8.5, negrito: true, cor: COR.marca, depois: 5 });
    escrever(doc, l[1], { x: x + 12, largura: col - 24, tamanho: 9.5 });
  });
  doc.x = MARGEM.x;
  doc.y = y + altura + 12;
}

/** A faixa de resumo: valor, vigência, primeiro pagamento e total, de relance. */
function faixaDeResumo(doc, linhas, largura) {
  const col = largura / Math.max(1, linhas.length);
  const altura = 50;
  novaPaginaSePreciso(doc, altura + 12);
  const y = doc.y;
  doc.roundedRect(MARGEM.x, y, largura, altura, 8).fill(COR.preto);
  linhas.forEach((l, i) => {
    const x = MARGEM.x + i * col;
    if (i) doc.moveTo(x, y + 11).lineTo(x, y + altura - 11).lineWidth(0.5).strokeColor("#3a3f4b").stroke();
    doc.y = y + 10;
    escrever(doc, l[0] ?? "", { x: x + 10, largura: col - 16, tamanho: 7.5, cor: "#9fb3c8" });
    doc.y += 3;
    escrever(doc, l[1] ?? "", { x: x + 10, largura: col - 14, tamanho: 9.2, negrito: true, cor: COR.claro });
  });
  doc.x = MARGEM.x;
  doc.y = y + altura + 14;
}

function tabela(doc, b, largura) {
  const colunas = (b.cabecalho ?? b.linhas[0] ?? []).length || 1;
  const larguras = colunas === 2 ? [largura * 0.25, largura * 0.75] : colunas === 3 ? [largura * 0.16, largura * 0.42, largura * 0.42] : Array(colunas).fill(largura / colunas);
  const desenharLinha = (celulas, cabecalho) => {
    const alturas = celulas.map((c, i) => alturaDe(doc, c, larguras[i] - 16, 9.5, cabecalho));
    const altura = Math.max(...alturas) + 12;
    novaPaginaSePreciso(doc, altura);
    const y = doc.y;
    let x = MARGEM.x;
    if (cabecalho) doc.roundedRect(x, y, largura, altura, 5).fill(COR.marca);
    else doc.moveTo(x, y + altura).lineTo(x + largura, y + altura).lineWidth(0.6).strokeColor(COR.linha).stroke();
    celulas.forEach((c, i) => {
      doc.y = y + 6;
      escrever(doc, c, { x: x + 8, largura: larguras[i] - 16, tamanho: 9.5, negrito: cabecalho, cor: cabecalho ? COR.claro : COR.texto });
      x += larguras[i];
    });
    doc.x = MARGEM.x;
    doc.y = y + altura;
  };
  if (b.cabecalho) desenharLinha(b.cabecalho, true);
  b.linhas.forEach((l) => desenharLinha(l, false));
  doc.y += 10;
}

/** O PDF do contrato (Buffer), com a logo no cabeçalho e o rodapé em todas as páginas. */
export function documentoEmPdf(texto, { marca = "", projeto = "", cnpj = "" } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4", bufferPages: true,
      margins: { top: MARGEM.topo, bottom: MARGEM.base, left: MARGEM.x, right: MARGEM.x },
      info: { Title: `Contrato ${projeto}`.trim(), Author: marca },
    });
    const partes = [];
    doc.on("data", (d) => partes.push(d));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(partes)));
    const largura = doc.page.width - MARGEM.x * 2;
    doc.y = ALTURA_CAPA + 26; // abaixo do cabeçalho da primeira página

    for (const b of lerBlocos(texto)) {
      switch (b.tipo) {
        case "titulo":
          escrever(doc, b.texto, { x: MARGEM.x, largura, tamanho: 17, align: "center", negrito: true, depois: 3 });
          break;
        case "subtitulo":
          escrever(doc, b.texto, { x: MARGEM.x, largura, tamanho: 10.5, align: "center", cor: COR.marca, depois: 16 });
          break;
        case "clausula": {
          // A cláusula não fica sozinha no fim da página.
          novaPaginaSePreciso(doc, 62);
          doc.y += 9;
          const y = doc.y;
          doc.roundedRect(MARGEM.x, y - 1, 3, 13, 1.5).fill(COR.marca);
          doc.y = y;
          escrever(doc, b.texto, { x: MARGEM.x + 10, largura: largura - 10, tamanho: 10.5, negrito: true, depois: 6 });
          doc.x = MARGEM.x;
          break;
        }
        case "item":
          escrever(doc, b.texto, { x: MARGEM.x + 10, largura: largura - 10, tamanho: 9.8, depois: 5 });
          break;
        case "tabela":
          if (!b.cabecalho && b.linhas[0]?.length === 2) cartoesDasPartes(doc, b.linhas, largura);
          else tabela(doc, b, largura);
          break;
        case "resumo":
          faixaDeResumo(doc, b.linhas, largura);
          break;
        case "assinatura": {
          const alturaBloco = b.linhas.length * 14 + 62;
          novaPaginaSePreciso(doc, alturaBloco);
          doc.y += 40;
          const y = doc.y;
          const col = (largura - 40) / 2;
          [0, 1].forEach((c) => {
            const x = MARGEM.x + c * (col + 40);
            doc.moveTo(x, y).lineTo(x + col, y).lineWidth(0.8).strokeColor(COR.texto).stroke();
            doc.y = y + 7;
            b.linhas.forEach((l, i) => escrever(doc, l[c] ?? " ", { x, largura: col, tamanho: i === 0 ? 10 : 8.8, align: "center", negrito: i === 0, cor: i === 0 ? COR.texto : COR.suave }));
          });
          doc.x = MARGEM.x;
          doc.y += 18;
          break;
        }
        case "aviso": {
          const altura = alturaDe(doc, b.texto, largura - 30, 8.8) + 34;
          novaPaginaSePreciso(doc, altura);
          const y = doc.y;
          doc.roundedRect(MARGEM.x, y, largura, altura, 8).fill(COR.fundo);
          doc.roundedRect(MARGEM.x, y, 3, altura, 1.5).fill(COR.marca);
          doc.y = y + 9;
          escrever(doc, b.titulo, { x: MARGEM.x + 15, largura: largura - 30, tamanho: 9.5, negrito: true, depois: 2 });
          escrever(doc, b.texto, { x: MARGEM.x + 15, largura: largura - 30, tamanho: 8.8, cor: COR.suave });
          doc.x = MARGEM.x;
          doc.y = y + altura + 8;
          break;
        }
        default:
          escrever(doc, b.texto, { x: MARGEM.x, largura, tamanho: 9.8, depois: 7 });
      }
    }

    // Cabeçalho e rodapé (sem margem de baixo, para o texto não abrir outra página).
    const logo = readFileSync(LOGO);
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      const base = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const capa = i === start;
      const alto = capa ? ALTURA_CAPA : ALTURA_FAIXA;
      doc.rect(0, 0, doc.page.width, alto).fill(COR.preto);
      doc.rect(0, alto, doc.page.width, 2.5).fill(COR.marca);
      const lado = capa ? 58 : 30;
      doc.image(logo, MARGEM.x - (capa ? 6 : 3), (alto - lado) / 2, { width: lado, height: lado });
      const xMarca = MARGEM.x + lado + (capa ? 4 : 3);
      doc.font("Helvetica-Bold").fontSize(capa ? 19 : 12).fillColor(COR.claro)
        .text(marca, xMarca, capa && cnpj ? 28 : alto / 2 - (capa ? 10 : 6), { width: largura / 2, lineBreak: false });
      if (capa && cnpj) doc.font("Helvetica").fontSize(8.5).fillColor("#9fb3c8").text(`CNPJ ${cnpj}`, xMarca, 52, { width: largura / 2, lineBreak: false });
      const xDireita = MARGEM.x + largura / 2;
      if (capa) {
        doc.font("Helvetica").fontSize(8.5).fillColor("#9fb3c8").text("Contrato de Prestação de Serviços", xDireita, 32, { width: largura / 2, align: "right", lineBreak: false });
        doc.font("Helvetica-Bold").fontSize(12).fillColor(COR.claro).text(projeto, xDireita, 46, { width: largura / 2, align: "right", lineBreak: false });
      } else {
        doc.font("Helvetica").fontSize(8.5).fillColor("#9fb3c8").text(`Contrato de Prestação de Serviços${projeto ? ` | ${projeto}` : ""}`, xDireita, alto / 2 - 5, { width: largura / 2, align: "right", lineBreak: false });
      }
      doc.moveTo(MARGEM.x, doc.page.height - 44).lineTo(MARGEM.x + largura, doc.page.height - 44).lineWidth(0.5).strokeColor(COR.linha).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(COR.suave)
        .text(`${marca}${cnpj ? ` · CNPJ ${cnpj}` : ""}`, MARGEM.x, doc.page.height - 36, { width: largura / 2, lineBreak: false })
        .text(`Página ${i - start + 1} de ${count}`, MARGEM.x + largura / 2, doc.page.height - 36, { width: largura / 2, align: "right", lineBreak: false });
      doc.page.margins.bottom = base;
    }
    doc.end();
  });
}
