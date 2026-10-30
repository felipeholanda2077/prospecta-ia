import PDFDocument from "pdfkit";

// O texto do contrato é simples de editar à mão:
//   # Título · ## Subtítulo · ### Cláusula · **negrito** · | tabela | (com |---| abaixo da 1ª linha, ela é o cabeçalho)
//   ::assinatura ... ::  (cada linha: esquerda | direita)  ·  ::aviso Título ... ::
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
    else if (l.startsWith("::assinatura") || l.startsWith("::aviso")) {
      const conteudo = [];
      for (i++; i < linhas.length && linhas[i].trim() !== "::"; i++) if (linhas[i].trim()) conteudo.push(linhas[i].trim());
      if (l.startsWith("::aviso")) blocos.push({ tipo: "aviso", titulo: l.slice(7).trim(), texto: conteudo.join(" ") });
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
const inline = (t) => trechos(t).map((x) => (x.negrito ? `<b>${escapar(x.texto)}</b>` : escapar(x.texto))).join("");

/** A prévia do painel, em HTML (com o texto escapado: o conteúdo é digitado à mão). */
export function documentoEmHtml(texto) {
  return lerBlocos(texto).map((b) => {
    switch (b.tipo) {
      case "titulo": return `<h2 class="ct-titulo">${inline(b.texto)}</h2>`;
      case "subtitulo": return `<p class="ct-subtitulo">${inline(b.texto)}</p>`;
      case "clausula": return `<h3 class="ct-clausula">${inline(b.texto)}</h3>`;
      case "item": return `<p class="ct-item">${inline(b.texto)}</p>`;
      case "tabela": return `<div class="ct-tabela"><table>${b.cabecalho ? `<thead><tr>${b.cabecalho.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${b.linhas.map((l) => `<tr>${l.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      case "assinatura": return `<div class="ct-assinaturas">${[0, 1].map((col) => `<div>${b.linhas.map((l, i) => `<div class="${i === 0 ? "ct-nome" : ""}">${inline(l[col] ?? "")}</div>`).join("")}</div>`).join("")}</div>`;
      case "aviso": return `<div class="ct-aviso"><b>${inline(b.titulo)}</b><p>${inline(b.texto)}</p></div>`;
      default: return `<p>${inline(b.texto)}</p>`;
    }
  }).join("");
}

const COR = { texto: "#14151f", suave: "#5d6275", marca: "#5b4cf0", linha: "#d9dbe6", fundo: "#f3f3fb" };
const MARGEM = { x: 56, topo: 72, base: 62 };

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

function tabela(doc, b, largura) {
  const colunas = (b.cabecalho ?? b.linhas[0] ?? []).length || 1;
  // Duas colunas sem cabeçalho são as partes do contrato (rótulo e texto); as outras, por igual.
  const larguras = colunas === 2 ? [largura * 0.2, largura * 0.8] : colunas === 3 ? [largura * 0.22, largura * 0.42, largura * 0.36] : Array(colunas).fill(largura / colunas);
  const desenharLinha = (celulas, destaque) => {
    const alturas = celulas.map((c, i) => alturaDe(doc, c, larguras[i] - 16, 9.5, destaque || (!b.cabecalho && i === 0)));
    const altura = Math.max(...alturas) + 12;
    novaPaginaSePreciso(doc, altura);
    const y = doc.y;
    let x = MARGEM.x;
    if (destaque) doc.rect(x, y, largura, altura).fill(COR.fundo);
    doc.moveTo(x, y + altura).lineTo(x + largura, y + altura).lineWidth(0.6).strokeColor(COR.linha).stroke();
    celulas.forEach((c, i) => {
      doc.y = y + 6;
      escrever(doc, c, { x: x + 8, largura: larguras[i] - 16, tamanho: 9.5, negrito: destaque || (!b.cabecalho && i === 0) });
      x += larguras[i];
    });
    doc.x = MARGEM.x;
    doc.y = y + altura;
  };
  if (b.cabecalho) desenharLinha(b.cabecalho, true);
  b.linhas.forEach((l) => desenharLinha(l, false));
  doc.y += 10;
}

/** O PDF do contrato (Buffer), com cabeçalho e rodapé em todas as páginas. */
export function documentoEmPdf(texto, { marca = "", projeto = "" } = {}) {
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

    for (const b of lerBlocos(texto)) {
      switch (b.tipo) {
        case "titulo":
          escrever(doc, b.texto, { x: MARGEM.x, largura, tamanho: 15, align: "center", negrito: true, depois: 4 });
          break;
        case "subtitulo":
          escrever(doc, b.texto, { x: MARGEM.x, largura, tamanho: 10.5, align: "center", cor: COR.suave, depois: 16 });
          break;
        case "clausula":
          // A cláusula não fica sozinha no fim da página.
          novaPaginaSePreciso(doc, 60);
          doc.y += 8;
          escrever(doc, b.texto, { x: MARGEM.x, largura, tamanho: 11, negrito: true, cor: COR.marca, depois: 5 });
          break;
        case "item":
          escrever(doc, b.texto, { x: MARGEM.x + 12, largura: largura - 12, tamanho: 10, depois: 5 });
          break;
        case "tabela":
          tabela(doc, b, largura);
          break;
        case "assinatura": {
          const alturaBloco = b.linhas.length * 15 + 56;
          novaPaginaSePreciso(doc, alturaBloco);
          doc.y += 36;
          const y = doc.y;
          const col = (largura - 40) / 2;
          [0, 1].forEach((c) => {
            const x = MARGEM.x + c * (col + 40);
            doc.moveTo(x, y).lineTo(x + col, y).lineWidth(0.8).strokeColor(COR.texto).stroke();
            doc.y = y + 6;
            b.linhas.forEach((l, i) => escrever(doc, l[c] ?? "", { x, largura: col, tamanho: i === 0 ? 10 : 9, align: "center", negrito: i === 0, cor: i === 0 ? COR.texto : COR.suave }));
          });
          doc.x = MARGEM.x;
          doc.y += 16;
          break;
        }
        case "aviso": {
          const altura = alturaDe(doc, b.texto, largura - 24, 9) + 34;
          novaPaginaSePreciso(doc, altura);
          const y = doc.y;
          doc.roundedRect(MARGEM.x, y, largura, altura, 6).fill(COR.fundo);
          doc.y = y + 9;
          escrever(doc, b.titulo, { x: MARGEM.x + 12, largura: largura - 24, tamanho: 9.5, negrito: true, depois: 2 });
          escrever(doc, b.texto, { x: MARGEM.x + 12, largura: largura - 24, tamanho: 9, cor: COR.suave });
          doc.x = MARGEM.x;
          doc.y = y + altura + 8;
          break;
        }
        default:
          escrever(doc, b.texto, { x: MARGEM.x, largura, tamanho: 10, depois: 7 });
      }
    }

    // Cabeçalho e rodapé (sem margem de baixo, para o texto não abrir outra página).
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      const base = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COR.marca).text(marca, MARGEM.x, 34, { width: largura / 2, lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(COR.suave)
        .text(`Contrato de Prestação de Serviços${projeto ? ` | ${projeto}` : ""}`, MARGEM.x + largura / 2, 35, { width: largura / 2, align: "right", lineBreak: false });
      doc.moveTo(MARGEM.x, 50).lineTo(MARGEM.x + largura, 50).lineWidth(0.6).strokeColor(COR.linha).stroke();
      doc.fontSize(8.5).fillColor(COR.suave).text(`Contrato ${projeto} - Página ${i - start + 1}`.replace(/\s+/g, " "), MARGEM.x, doc.page.height - 40, { width: largura, align: "center", lineBreak: false });
      doc.page.margins.bottom = base;
    }
    doc.end();
  });
}
