import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("painel: o script compila (um erro aqui deixa o painel inteiro em branco)", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const codigo of scripts) new vm.Script(codigo); // acusa erro de sintaxe e nome declarado duas vezes
});

test("painel: as abas do Instagram ligam na barra certa (há outra barra de abas em Contratos)", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal((html.match(/class="ig-abas"/g) ?? []).length, 2);
  assert.match(html, /id="ig-abas"/);
  assert.match(html, /id="ct-abas"/);
  assert.doesNotMatch(html, /\$\("\.ig-abas"\)/);
});
