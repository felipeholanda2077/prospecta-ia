// Função da Vercel: todas as rotas dinâmicas (API, descadastro, webhook, cron) passam por aqui.
// O painel (public/) é servido como arquivo estático pela própria Vercel.
import app from "../src/app.js";

export default app;
