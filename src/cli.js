import { carregarCampanha } from "./config.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";

const [comando, ...flags] = process.argv.slice(2);
const campanha = carregarCampanha();

const comandos = {
  descobrir: () => pipeline.descobrir(campanha),
  analisar: () => pipeline.analisar(),
  propor: () => pipeline.propor(campanha),
  enviar: () => pipeline.enviar(campanha, { ignorarHorario: flags.includes("--agora") }),
  ciclo: () => pipeline.executarCiclo(campanha),
  stats: async () => console.log(JSON.stringify(db.estatisticas(), null, 2)),
};

if (!comandos[comando]) {
  console.log(`Uso: node src/cli.js <comando>

  descobrir   busca empresas no Google Maps (nichos e cidades de config/campanha.json)
  analisar    visita os sites, acha e-mail/WhatsApp e identifica oportunidades
  propor      a IA escreve as propostas personalizadas
  enviar      envia as mensagens aprovadas (use --agora para ignorar o horário comercial)
  ciclo       roda as quatro etapas em sequência
  stats       mostra os números do funil`);
  process.exit(comando ? 1 : 0);
}

await comandos[comando]();
