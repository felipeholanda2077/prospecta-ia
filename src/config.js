import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const env = process.env;

// O Google mostra a senha de app em grupos de 4 letras ("abcd efgh ..."); colar com os
// espaços faz o login falhar. Senha de app nunca tem espaço, então eles são removidos.
const senhaDeEmail = (senha, host) => (/gmail|googlemail|google\.com/i.test(host ?? "") ? String(senha ?? "").replace(/\s+/g, "") : String(senha ?? ""));

export const config = {
  claude: {
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
  },
  googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY || "",
  smtp: {
    host: env.SMTP_HOST || "",
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === "true",
    user: env.SMTP_USER || "",
    pass: senhaDeEmail(env.SMTP_PASS, env.SMTP_HOST),
    remetente: env.EMAIL_REMETENTE || env.SMTP_USER || "",
    descadastro: env.EMAIL_DESCADASTRO || "",
  },
  whatsapp: {
    ativo: env.WHATSAPP_ATIVO === "true",
    token: env.WHATSAPP_TOKEN || "",
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "",
    template: env.WHATSAPP_TEMPLATE || "proposta_inicial",
    idioma: env.WHATSAPP_TEMPLATE_IDIOMA || "pt_BR",
    apiVersion: env.WHATSAPP_API_VERSION || "v21.0",
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || "",
    appSecret: env.WHATSAPP_APP_SECRET || "",
  },
  imap: {
    host: env.IMAP_HOST || "",
    port: Number(env.IMAP_PORT || 993),
    secure: env.IMAP_SECURE !== "false",
    user: env.IMAP_USER || env.SMTP_USER || "",
    pass: senhaDeEmail(env.IMAP_PASS || env.SMTP_PASS, env.IMAP_HOST),
    pasta: env.IMAP_PASTA || "INBOX",
  },
  // Quem recebe o aviso quando um lead responde com interesse.
  notificarEmail: env.NOTIFICAR_EMAIL || "",
  // Modo teste: todas as mensagens vão para estes contatos em vez da empresa real.
  modoTeste: {
    email: env.MODO_TESTE_EMAIL || "",
    whatsapp: env.MODO_TESTE_WHATSAPP || "",
  },
  verificarRespostasCron: env.VERIFICAR_RESPOSTAS_CRON || "*/10 * * * *",
  painel: {
    porta: Number(env.PORTA || 3000),
    urlPublica: (env.URL_PUBLICA || "http://localhost:3000").replace(/\/$/, ""),
    usuario: env.PAINEL_USUARIO || "admin",
    senha: env.PAINEL_SENHA || "",
  },
  cicloCron: env.CICLO_CRON || "",
  // Não usa TZ: na Vercel ela é reservada e fica em UTC.
  timezone: env.FUSO_HORARIO || "America/Sao_Paulo",
  // Postgres do Supabase (obrigatório na Vercel). Vazio = Postgres embutido em DB_PATH.
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || "",
  dbPath: env.DB_PATH || "data/pglite",
  // Na Vercel cada execução tem limite de tempo; as etapas param antes e continuam na próxima.
  naVercel: Boolean(env.VERCEL),
  // Sem espaços nem quebra de linha: colar o valor costuma trazer um "enter" no fim.
  cronSecret: (env.CRON_SECRET || "").trim(),
};

const CAMPANHA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "campanha.json");

export function carregarCampanha() {
  return JSON.parse(fs.readFileSync(CAMPANHA_PATH, "utf8"));
}
