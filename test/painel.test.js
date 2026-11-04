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

test("painel: nenhuma função com o mesmo nome (a segunda apaga a primeira e um botão para de funcionar)", async () => {
  for (const arquivo of ["../public/index.html", "../public/crm.html"]) {
    const html = await readFile(new URL(arquivo, import.meta.url), "utf8");
    const codigo = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    const vistos = new Map();
    for (const [, nome] of codigo.matchAll(/^(?:async )?function (\w+)\(/gm)) vistos.set(nome, (vistos.get(nome) ?? 0) + 1);
    assert.deepEqual([...vistos].filter(([, n]) => n > 1), [], arquivo);
  }
});

test("painel: as abas do Instagram ligam na barra certa (há outras barras de abas em Contratos e Agentes)", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal((html.match(/class="ig-abas"/g) ?? []).length, 3);
  assert.match(html, /id="ig-abas"/);
  assert.match(html, /id="ct-abas"/);
  assert.match(html, /id="ag-abas"/);
  assert.doesNotMatch(html, /\$\("\.ig-abas"\)/);
});
