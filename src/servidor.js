// Execução local ou em VPS/Docker: serve o painel e agenda as tarefas.
// Na Vercel quem roda é api/index.js e o agendamento fica no vercel.json.
import express from "express";
import cron from "node-cron";
import { config, carregarCampanha } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";
import { app } from "./app.js";

const servidor = express();
servidor.use(express.static("public"));
servidor.use(app);

await db.iniciar();
servidor.listen(config.painel.porta, () => {
  console.log(`Painel em http://localhost:${config.painel.porta}`);
});

if (config.cicloCron) {
  cron.schedule(config.cicloCron, () => pipeline.executarCiclo(carregarCampanha()).catch(console.error), {
    timezone: config.timezone,
  });
  console.log(`Ciclo automático agendado: "${config.cicloCron}" (${config.timezone})`);
}

if (config.verificarRespostasCron && config.imap.host) {
  cron.schedule(config.verificarRespostasCron, () => pipeline.verificarRespostas(carregarCampanha()).catch(console.error), {
    timezone: config.timezone,
  });
  console.log(`Verificação de respostas por e-mail agendada: "${config.verificarRespostasCron}"`);
}

if (config.modoTeste.email || config.modoTeste.whatsapp) {
  console.log(`⚠️  MODO TESTE: mensagens vão para ${config.modoTeste.email || "-"} / ${config.modoTeste.whatsapp || "-"}`);
}
