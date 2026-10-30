import crypto from "node:crypto";
import { config } from "../config.js";
import * as db from "../db.js";

// Agendador dentro do próprio banco (Supabase): o pg_cron dispara a cada 10 minutos e o
// pg_net chama a rodada do sistema (e, a cada minuto, o envio da próxima empresa nova). É mais pontual que o agendamento do GitHub, que pode
// atrasar ou pular execuções; o do GitHub continua como reserva (uma trava evita rodadas
// em dobro). A chave fica só no banco: aqui guardamos o resumo dela.
const NOME_JOB = "prospecta-ia-rodada";
const TEMPO_LIMITE_MS = 290_000;
const JOBS = [
  // A rodada completa: minuto 3, 13, 23... das 9h às 20h UTC (6h às 17h53 em Brasília), segunda a sexta.
  { nome: NOME_JOB, agenda: "3-59/10 9-20 * * 1-5", tarefa: "envios" },
  // A cada minuto do horário comercial (9h às 17h59 em Brasília): a próxima empresa nova sai
  // assim que termina o intervalo de 5 a 12 minutos desde a anterior.
  { nome: "prospecta-ia-empresas-novas", agenda: "* 12-20 * * 1-5", tarefa: "novas" },
  // A cada 15 minutos, todos os dias: cria o post de conteúdo do dia no horário escolhido.
  { nome: "prospecta-ia-conteudo", agenda: "*/15 * * * *", tarefa: "conteudo" },
  // A cada 2 minutos, todos os dias: as respostas da IA no direct do Instagram (a Meta só aceita até 24 h depois).
  { nome: "prospecta-ia-instagram", agenda: "*/2 * * * *", tarefa: "instagram" },
];

export const resumoDaChave = (chave) => crypto.createHash("sha256").update(`prospecta-banco:${chave}`).digest("hex");

let configurado = false;

/** Endereço que o banco chama em cada execução. */
const destino = (tarefa) => `${config.painel.urlPublica}/api/cron/${tarefa}`;

/**
 * Liga (ou confere) o agendador do banco. Só funciona com o Postgres do Supabase
 * (DATABASE_URL); com o banco embutido dos testes e do uso local, não faz nada.
 */
export async function garantirAgendamentoNoBanco({ forcar = false } = {}) {
  if (!config.databaseUrl) return { ativo: false, motivo: "só funciona com o banco do Supabase" };
  if (!/^https:\/\//.test(config.painel.urlPublica)) return { ativo: false, motivo: "URL_PUBLICA precisa ser o endereço https do sistema" };
  if (configurado && !forcar) return { ativo: true };

  if (!forcar) {
    const existentes = await Promise.all(JOBS.map((j) => db
      .consultar("SELECT 1 FROM cron.job WHERE jobname = $1 AND schedule = $2 AND command LIKE $3", [j.nome, j.agenda, `%${destino(j.tarefa)}%`])
      .catch(() => [])));
    if (existentes.every((e) => e.length)) {
      configurado = true;
      return { ativo: true };
    }
  }

  await db.consultar("CREATE EXTENSION IF NOT EXISTS pg_cron");
  await db.consultar("CREATE EXTENSION IF NOT EXISTS pg_net");
  // Uma chave nova para todos os jobs (cron.schedule com o mesmo nome atualiza o job).
  const chave = crypto.randomBytes(32).toString("hex");
  for (const j of JOBS) {
    await db.consultar(
      `SELECT cron.schedule($1, $2, format(
         'SELECT net.http_get(url := %L, headers := jsonb_build_object(%L, %L), timeout_milliseconds := %s)',
         $3::text, 'Authorization', 'Bearer ' || $4::text, $5::int))`,
      [j.nome, j.agenda, destino(j.tarefa), chave, TEMPO_LIMITE_MS]
    );
  }
  await db.gravarConfig("cron_banco", { resumo: resumoDaChave(chave), criado: new Date().toISOString() });
  configurado = true;
  console.log("⏰ Agendador do banco (pg_cron) ligado: rodada a cada 10 minutos, empresas novas a cada minuto, o post do dia e o direct do Instagram");
  return { ativo: true, ligadoAgora: true };
}

/** A chave recebida é a que o agendador do banco usa? */
export async function chaveDoBancoValida(recebido) {
  const salvo = (await db.lerConfig("cron_banco"))?.resumo;
  if (!salvo || !recebido) return false;
  const a = Buffer.from(resumoDaChave(recebido));
  const b = Buffer.from(salvo);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Última execução de um job do agendador do banco. */
const ultimaExecucao = async (nome) => (await db
  .consultar(
    `SELECT status, return_message, end_time FROM cron.job_run_details
      WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = $1) ORDER BY start_time DESC LIMIT 1`,
    [nome]
  )
  .catch(() => []))[0] ?? null;

/** Situação do agendador do banco para o painel: ligado e as últimas chamadas que ele fez. */
export async function statusDoBanco() {
  if (!config.databaseUrl) return { ativo: false, motivo: "só funciona com o banco do Supabase" };
  try {
    const job = await db.consultar("SELECT active FROM cron.job WHERE jobname = $1", [NOME_JOB]);
    if (!job.length) return { ativo: false, motivo: "ainda não ligado" };
    const jobs = [];
    for (const j of JOBS) {
      const [linha] = await db.consultar("SELECT active FROM cron.job WHERE jobname = $1", [j.nome]);
      jobs.push({ nome: j.nome, agenda: j.agenda, ativo: Boolean(linha?.active), ultimaExecucao: await ultimaExecucao(j.nome) });
    }
    return { ativo: Boolean(job[0].active), ultimaExecucao: await ultimaExecucao(NOME_JOB), jobs };
  } catch (e) {
    return { ativo: false, motivo: e.message };
  }
}
