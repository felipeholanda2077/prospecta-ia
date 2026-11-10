import { carregarCampanha } from "./config.js";
import * as db from "./db.js";

// enderecoComercial: o endereço físico que a lei dos EUA (CAN-SPAM) exige no rodapé do e-mail para empresas de fora.
export const CAMPOS_EMPRESA = ["nome", "responsavel", "cargo", "telefone", "email", "site", "portfolio", "enderecoComercial"];

// Valores de exemplo do campanha.json que não devem aparecer nas mensagens.
const PLACEHOLDER = /seu nome|seudominio|99999-9999/i;

// Funil automático: começa desligado; você liga e ajusta em Automação.
export const AUTOMACAO_PADRAO = {
  ativo: false, // busca, aprova e envia sozinho
  respostaAutomatica: false, // a IA responde as conversas sozinha
  metaDiaria: { email: 100 }, // empresas novas por dia no e-mail (o WhatsApp não tem limite por dia: vale o intervalo)
  intervaloEmpresasMin: 5, // minutos entre uma empresa nova e a próxima (sorteado entre o mínimo e o máximo)
  intervaloEmpresasMax: 12,
  intervaloOficialMin: 2, // minutos entre uma empresa e a próxima no número da API oficial da Meta (sai mais rápido)
  intervaloOficialMax: 4,
  maxRespostasIA: 6, // depois disso a conversa passa para você
  calendly: "",
  buscarNoInstagram: true, // com o Instagram conectado pela página do Facebook, busca lá também
  buscarPorCnpj: true, // busca também pelos dados abertos do CNPJ (Receita Federal)
  buscarEmAnuncios: true, // com a SerpApi conectada, busca também quem anuncia no Instagram e no Facebook
  buscarContadores: true, // uma vez por dia, escritórios de contabilidade das cidades da campanha, para parceria de indicação
  buscarEmVagas: true,
  buscarNoGoogleAds: true, // com a SerpApi conectada, busca também quem paga anúncio no Google para o segmento na cidade // com a SerpApi conectada, busca também empresas contratando para funções que a FluxDeck resolve
  buscarNaSerpApi: true, // com a SerpApi conectada, busca também no Google Maps as empresas depois das 60 que a API do Google mostra
  buscas: null, // null = usa as do campanha.json
  testarRamos: true, // a IA escolhe ramos novos, testa na captação e fica com os que respondem bem
};

export async function lerAutomacao() {
  const salvo = (await db.lerConfig("automacao")) ?? {};
  return { ...AUTOMACAO_PADRAO, ...salvo, metaDiaria: { ...AUTOMACAO_PADRAO.metaDiaria, ...(salvo.metaDiaria ?? {}) } };
}

/** Campanha do arquivo + perfil da empresa e automação salvos no painel (que têm prioridade). */
export async function carregarCampanhaCompleta() {
  const campanha = carregarCampanha();
  const automacao = await lerAutomacao();
  if (Array.isArray(automacao.buscas) && automacao.buscas.length) campanha.buscas = automacao.buscas;
  campanha.automacao = automacao;
  // Ramos que a IA está testando (ou já aprovou): entram na rotação da busca, nas mesmas cidades.
  campanha.ramosExtras = automacao.testarRamos === false ? []
    : ((await db.lerConfig("ramos_teste"))?.ramos ?? []).filter((r) => ["testando", "aprovado"].includes(r.status)).map((r) => r.nicho);
  const salvo = (await db.lerConfig("empresa")) ?? {};
  const empresa = { ...campanha.empresa };
  for (const campo of CAMPOS_EMPRESA) {
    if (typeof salvo[campo] === "string" && salvo[campo].trim()) empresa[campo] = salvo[campo].trim();
  }
  // Campos ainda com o valor de exemplo ficam vazios: a IA não deve citá-los.
  for (const campo of CAMPOS_EMPRESA) if (PLACEHOLDER.test(empresa[campo] ?? "")) empresa[campo] = "";
  return { ...campanha, empresa };
}
