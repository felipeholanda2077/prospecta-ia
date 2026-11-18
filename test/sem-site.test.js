import { test } from "node:test";
import assert from "node:assert/strict";

const { semSiteProprio } = await import("../src/analise/prioridade.js");
const { momentoDaPrevia } = await import("../src/vendas/previa.js");

test("página de links (bio.site, Linktree), rede social e página de marcação contam como sem site: recebe o exemplo", () => {
  for (const u of ["https://bio.site/Tacabeleireiroseestetica", "https://linktr.ee/salao", "https://www.instagram.com/salao/",
    "https://www.fresha.com/pt/a/salao", "https://booksy.com/pt-pt/123", "https://beacons.ai/salao", "https://g.page/salao", null, ""]) {
    assert.equal(semSiteProprio(u), true, u);
  }
  for (const u of ["https://salaobonito.pt", "https://www.biosite.com.br", "https://clinica.com.br/agendar"]) assert.equal(semSiteProprio(u), false, u);

  // O salão de Portugal só com bio.site, que perguntou "como seria?": a IA tem o link do exemplo para mandar.
  const lead = { token: "abc", nome: "TA Cabeleireiros", origem: "maps", status: "respondeu", pais: "PT", site: "https://bio.site/Tacabeleireiroseestetica" };
  const historico = [{ autor: "nos", texto: "Faz sentido mostrar um exemplo?" }, { autor: "lead", texto: "Boa tarde , sim como seria ?" }];
  assert.equal(momentoDaPrevia({ lead, historico, texto: "Boa tarde , sim como seria ?", origem: "https://fluxdeck.com.br" }), "https://fluxdeck.com.br/previa/abc");
});
