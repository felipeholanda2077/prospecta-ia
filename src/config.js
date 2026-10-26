import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const env = process.env;

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
    pass: env.SMTP_PASS || "",
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
    pass: env.IMAP_PASS || env.SMTP_PASS || "",
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
  timezone: env.TZ || "America/Sao_Paulo",
  dbPath: env.DB_PATH || "data/prospecta.db",
};

const CAMPANHA_PATH = path.resolve("config/campanha.json");

export function carregarCampanha() {
  return JSON.parse(fs.readFileSync(CAMPANHA_PATH, "utf8"));
}
