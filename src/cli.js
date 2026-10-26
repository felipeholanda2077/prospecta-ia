import { carregarCampanhaCompleta } from "./campanha.js";
import * as db from "./db.js";
import * as pipeline from "./pipeline.js";

const [comando] = process.argv.slice(2);
const campanha = await carregarCampanhaCompleta();

const comandos = {
  respostas: () => pipeline.verificarRespostas(campanha),
  descobrir: () => pipeline.descobrir(campanha),
  analisar: () => pipeline.analisar(),
  propor: () => pipeline.propor(campanha),
  enviar: () => pipeline.enviar(campanha),
  envios: () => pipeline.rodadaDeEnvios(campanha),
  ciclo: () => pipeline.executarCiclo(campanha),
  stats: async () => console.log(JSON.stringify(await db.estatisticas(), null, 2)),
};

if (!comandos[comando]) {
  console.log(`Uso: node src/cli.js <comando>

  respostas   lê a caixa de entrada (IMAP) e classifica as respostas com a IA
  descobrir   busca empresas no Google Maps (nichos e cidades de config/campanha.json)
  analisar    visita os sites, acha e-mail/WhatsApp e identifica oportunidades
  propor      a IA escreve as propostas personalizadas
  enviar      envia as etapas aprovadas que já chegaram no dia (só em horário comercial)
  envios      lê as respostas e envia a fila (a rotina do horário comercial)
  ciclo       roda todas as etapas em sequência
  stats       mostra os números do funil`);
  process.exit(comando ? 1 : 0);
}

const resultado = await comandos[comando]();
if (resultado?.restantes) console.log(`Ainda há ${resultado.restantes} na fila; rode o comando de novo para continuar.`);
// A conexão com o banco mantém o processo vivo; encerra ao terminar o comando.
process.exit(0);
