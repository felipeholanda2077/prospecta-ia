import { test } from "node:test";
import assert from "node:assert/strict";

const { partesDaMensagem, TAMANHO_DA_PARTE } = await import("../src/respostas/partes.js");

test("mensagem grande da IA sai separada (2 ou 3 mensagens curtas), curta e e-mail ficam inteiras", () => {
  assert.deepEqual(partesDaMensagem("Oi! Tudo bem?"), ["Oi! Tudo bem?"]);
  const link = "https://fluxdeck.com.br/checkout/x/WcNCK8ypKLNlLLJq";
  const grande = `Claro, com certeza. Vou explicar como funcionaria para o salão.\n\n*Como funciona:*\n1) Ajustamos o site com as vossas fotos e informações.\n2) Fica pronto no prazo de uma semana.\n3) É totalmente personalizável, alteramos o que quiserem.\n\nO valor é 150 €, pagamento único, sem mensalidade. Para avançar, é por aqui: ${link}. Diga-me se ficou alguma dúvida!`;
  const partes = partesDaMensagem(grande);
  assert.ok(partes.length >= 2 && partes.length <= 3, partes.length);
  assert.ok(partes.every((p) => p.length <= TAMANHO_DA_PARTE + 100), partes.map((p) => p.length).join(","));
  assert.ok(partes.some((p) => p.includes(link))); // link inteiro
  assert.equal(partes.join(" ").replace(/\s+/g, " "), grande.replace(/\s+/g, " ")); // nada some, na ordem
  assert.deepEqual(partesDaMensagem(grande, "email"), [grande.trim()]);
  // Um parágrafo só, comprido: corta nas frases.
  const corrido = "Esta é uma frase de exemplo com bastante texto para ocupar espaço. ".repeat(8).trim();
  assert.ok(partesDaMensagem(corrido).length >= 2);
  // Muito texto: no máximo 3 mensagens.
  assert.ok(partesDaMensagem("Frase longa de teste para encher a mensagem. ".repeat(60)).length <= 3);
});
