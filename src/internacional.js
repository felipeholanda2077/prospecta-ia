import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import * as db from "./db.js";

// Empresas fora do Brasil: os países do euro e os Estados Unidos. Cada empresa guarda o país, o idioma em
// que a IA fala com ela e o fuso (para as mensagens saírem no horário comercial de lá). Os valores da
// apresentação e do catálogo, que estão em reais, viram a moeda do país pela cotação do dia.

/** Os países atendidos: nome no painel, idioma local, moeda e fuso (nos EUA, o fuso vem do estado). */
export const PAISES = {
  BR: { nome: "Brasil", idioma: "pt-BR", moeda: "BRL", fuso: "America/Sao_Paulo" },
  US: { nome: "Estados Unidos", idioma: "en-US", moeda: "USD", fuso: "America/New_York" },
  PT: { nome: "Portugal", idioma: "pt-PT", moeda: "EUR", fuso: "Europe/Lisbon" },
  ES: { nome: "Espanha", idioma: "es-ES", moeda: "EUR", fuso: "Europe/Madrid" },
  FR: { nome: "França", idioma: "fr-FR", moeda: "EUR", fuso: "Europe/Paris" },
  DE: { nome: "Alemanha", idioma: "de-DE", moeda: "EUR", fuso: "Europe/Berlin" },
  IT: { nome: "Itália", idioma: "it-IT", moeda: "EUR", fuso: "Europe/Rome" },
  NL: { nome: "Holanda", idioma: "nl-NL", moeda: "EUR", fuso: "Europe/Amsterdam" },
  BE: { nome: "Bélgica", idioma: "nl-BE", moeda: "EUR", fuso: "Europe/Brussels" },
  AT: { nome: "Áustria", idioma: "de-AT", moeda: "EUR", fuso: "Europe/Vienna" },
  IE: { nome: "Irlanda", idioma: "en-IE", moeda: "EUR", fuso: "Europe/Dublin" },
  LU: { nome: "Luxemburgo", idioma: "fr-LU", moeda: "EUR", fuso: "Europe/Luxembourg" },
  FI: { nome: "Finlândia", idioma: "fi-FI", moeda: "EUR", fuso: "Europe/Helsinki" },
  GR: { nome: "Grécia", idioma: "el-GR", moeda: "EUR", fuso: "Europe/Athens" },
  MT: { nome: "Malta", idioma: "en-MT", moeda: "EUR", fuso: "Europe/Malta" },
  CY: { nome: "Chipre", idioma: "el-CY", moeda: "EUR", fuso: "Asia/Nicosia" },
  SK: { nome: "Eslováquia", idioma: "sk-SK", moeda: "EUR", fuso: "Europe/Bratislava" },
  SI: { nome: "Eslovênia", idioma: "sl-SI", moeda: "EUR", fuso: "Europe/Ljubljana" },
  EE: { nome: "Estônia", idioma: "et-EE", moeda: "EUR", fuso: "Europe/Tallinn" },
  LV: { nome: "Letônia", idioma: "lv-LV", moeda: "EUR", fuso: "Europe/Riga" },
  LT: { nome: "Lituânia", idioma: "lt-LT", moeda: "EUR", fuso: "Europe/Vilnius" },
  HR: { nome: "Croácia", idioma: "hr-HR", moeda: "EUR", fuso: "Europe/Zagreb" },
  BG: { nome: "Bulgária", idioma: "bg-BG", moeda: "EUR", fuso: "Europe/Sofia" },
};

const sem = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// Outros nomes de cada país (em inglês e no idioma de lá), para ler "Lisboa, Portugal" ou "Miami, USA".
const APELIDOS = {
  US: ["eua", "usa", "estados unidos", "united states", "estados unidos da america", "us"],
  PT: ["portugal"], ES: ["espanha", "spain", "espana"], FR: ["franca", "france"], DE: ["alemanha", "germany", "deutschland"],
  IT: ["italia", "italy"], NL: ["holanda", "paises baixos", "netherlands", "nederland", "holland"], BE: ["belgica", "belgium", "belgique", "belgie"],
  AT: ["austria", "osterreich"], IE: ["irlanda", "ireland"], LU: ["luxemburgo", "luxembourg"], FI: ["finlandia", "finland", "suomi"],
  GR: ["grecia", "greece"], MT: ["malta"], CY: ["chipre", "cyprus"], SK: ["eslovaquia", "slovakia"], SI: ["eslovenia", "slovenia"],
  EE: ["estonia"], LV: ["letonia", "latvia"], LT: ["lituania", "lithuania"], HR: ["croacia", "croatia"], BG: ["bulgaria"], BR: ["brasil", "brazil"],
};

/**
 * O código do país ("PT") a partir de um nome ("Portugal", "EUA", "Alemanha") ou, com `sigla`, do código.
 * (Sem `sigla`, "ES" e "MT" ficam como estados do Brasil: "Vitória, ES".)
 */
export function codigoDoPais(texto, { sigla = false } = {}) {
  const t = sem(texto);
  if (!t) return null;
  if (sigla && PAISES[t.toUpperCase()]) return t.toUpperCase();
  return Object.entries(APELIDOS).find(([, nomes]) => nomes.includes(t))?.[0] ?? null;
}

/** "Lisboa, Portugal" → { cidade: "Lisboa", pais: "PT" }; sem país conhecido no fim, é do Brasil. */
export function cidadeEPais(texto) {
  const partes = String(texto ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const pais = partes.length > 1 ? codigoDoPais(partes.at(-1)) : null;
  if (!pais || pais === "BR") return { cidade: String(texto ?? "").trim(), pais: "BR" };
  return { cidade: partes.slice(0, -1).join(", "), pais };
}

export const ehExterior = (lead) => Boolean(lead?.pais) && lead.pais !== "BR";

// Nos EUA o fuso depende do estado (vem no endereço do Google: "Miami, FL 33101, USA").
const FUSOS_EUA = {
  "America/New_York": "CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV",
  "America/Chicago": "AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI",
  "America/Denver": "CO ID MT NM UT WY",
  "America/Phoenix": "AZ",
  "America/Los_Angeles": "CA NV OR WA",
  "America/Anchorage": "AK",
  "Pacific/Honolulu": "HI",
};
const ESTADOS = {
  florida: "FL", "new york": "NY", california: "CA", texas: "TX", illinois: "IL", massachusetts: "MA", georgia: "GA", nevada: "NV",
  washington: "WA", arizona: "AZ", colorado: "CO", "new jersey": "NJ", pennsylvania: "PA", ohio: "OH", michigan: "MI", "north carolina": "NC",
  virginia: "VA", tennessee: "TN", oregon: "OR", utah: "UT", minnesota: "MN", louisiana: "LA", connecticut: "CT", maryland: "MD", hawaii: "HI",
};
const fusoDoEstado = (uf) => Object.entries(FUSOS_EUA).find(([, ufs]) => ufs.split(" ").includes(uf))?.[0] ?? null;

/** O estado americano citado no endereço ou na cidade ("Miami, FL 33101", "Austin, Texas"). */
export function estadoDosEua(texto) {
  const t = String(texto ?? "");
  const sigla = t.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,|$)/)?.[1];
  if (sigla && fusoDoEstado(sigla)) return sigla;
  const nome = Object.keys(ESTADOS).find((n) => sem(t).includes(n));
  return nome ? ESTADOS[nome] : null;
}

/** O fuso da empresa: o do país; nos EUA, o do estado (sem estado no endereço, o de Nova York). */
export function fusoDaEmpresa({ pais, endereco, cidade } = {}) {
  const p = PAISES[pais] ?? PAISES.BR;
  if (pais !== "US") return p.fuso;
  return fusoDoEstado(estadoDosEua(endereco) ?? estadoDosEua(cidade) ?? "") ?? p.fuso;
}

/** O idioma em que a IA fala com a empresa: o do país ou o inglês. */
export function idiomaParaEmpresa(pais, preferencia = "local") {
  if (!pais || pais === "BR") return "pt-BR";
  return preferencia === "en" ? "en" : PAISES[pais]?.idioma ?? "en";
}

/** O país, o idioma e o fuso que a empresa capturada guarda (nada para as do Brasil). */
export function dadosDoPais(pais, preferencia, { endereco, cidade } = {}) {
  if (!pais || pais === "BR" || !PAISES[pais]) return {};
  return { pais, idioma: idiomaParaEmpresa(pais, preferencia), fuso: fusoDaEmpresa({ pais, endereco, cidade }) };
}

/** "alemão (Deutsch)"; o português de Portugal fica marcado ("português de Portugal"). */
export function nomeDoIdioma(codigo) {
  if (codigo === "pt-PT") return "português de Portugal (não o do Brasil: use o vocabulário e o tratamento de Portugal)";
  const base = String(codigo ?? "en").split("-")[0];
  try {
    const emPortugues = new Intl.DisplayNames(["pt-BR"], { type: "language" }).of(base);
    const nativo = new Intl.DisplayNames([base], { type: "language" }).of(base);
    return emPortugues === nativo ? emPortugues : `${emPortugues} (${nativo})`;
  } catch {
    return codigo;
  }
}

// ---------- Telefone ----------

/** O telefone em formato internacional sem "+" (ex.: 4915123456789), ou null se não for válido no país. */
export function telefoneInternacional(telefone, pais) {
  if (!telefone) return null;
  const n = parsePhoneNumberFromString(String(telefone), pais && pais !== "BR" ? pais : undefined);
  return n?.isValid() ? n.number.slice(1) : null;
}

/** Pode ser celular (e ter WhatsApp)? Nos EUA o número não diz: conta como possível. */
export function podeSerCelular(telefone, pais) {
  const n = parsePhoneNumberFromString(String(telefone ?? ""), pais && pais !== "BR" ? pais : undefined);
  return Boolean(n?.isValid() && ["MOBILE", "FIXED_LINE_OR_MOBILE"].includes(n.getType()));
}

// ---------- Moeda ----------

// Reserva quando a cotação do dia não responde (R$ 1 em cada moeda).
const COTACAO_RESERVA = { EUR: 0.16, USD: 0.18 };
let cotacaoEmMemoria = null;

/** Quanto vale R$ 1 em euro e em dólar hoje (Banco Central Europeu, pela Frankfurter; guardada por dia). */
export async function cotacoes({ agora = new Date(), buscar = fetch } = {}) {
  const dia = agora.toISOString().slice(0, 10);
  if (cotacaoEmMemoria?.dia === dia) return cotacaoEmMemoria;
  const salva = await db.lerConfig("cotacao_brl").catch(() => null);
  if (salva?.dia === dia) return (cotacaoEmMemoria = salva);
  try {
    const r = await buscar("https://api.frankfurter.dev/v1/latest?base=BRL&symbols=EUR,USD", { signal: AbortSignal.timeout(8000) });
    const dados = r.ok ? await r.json() : null;
    if (dados?.rates?.EUR && dados?.rates?.USD) {
      cotacaoEmMemoria = { dia, data: dados.date, EUR: dados.rates.EUR, USD: dados.rates.USD };
      await db.gravarConfig("cotacao_brl", cotacaoEmMemoria).catch(() => {});
      return cotacaoEmMemoria;
    }
  } catch {}
  return salva?.EUR ? salva : { dia, data: null, ...COTACAO_RESERVA, reserva: true };
}

/** O ajuste do preço para fora do Brasil (% sobre o valor convertido), editável no painel. */
export async function configInternacional() {
  const c = (await db.lerConfig("internacional").catch(() => null)) ?? {};
  return { ajustePct: Number.isFinite(Number(c.ajustePct)) ? Number(c.ajustePct) : 0 };
}

export async function gravarConfigInternacional({ ajustePct }) {
  const n = Math.round(Number(String(ajustePct ?? 0).replace(",", ".")));
  if (!Number.isFinite(n) || n < -50 || n > 500) throw new Error("O ajuste do preço vai de -50% a 500%");
  await db.gravarConfig("internacional", { ajustePct: n });
  return { ajustePct: n };
}

/** Arredonda como numa tabela de preços: 31 → 31, 154 → 150, 728 → 730, 2.437 → 2.450. */
export function arredondarPreco(v) {
  if (v >= 1000) return Math.round(v / 50) * 50;
  if (v >= 100) return Math.round(v / 10) * 10;
  return Math.max(1, Math.round(v));
}

const VALOR_EM_REAIS = /R\$\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)|(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?\s*reais\b/gi;

/** Troca os valores em reais do texto pela moeda do país ("R$ 4.500/mês" → "€ 730/mês" ou "$810/mês"). */
export function converterValores(texto, { moeda, idioma, taxa, ajustePct = 0 }) {
  if (!texto || !moeda || moeda === "BRL") return texto;
  const formato = new Intl.NumberFormat(idioma || "en", { style: "currency", currency: moeda, maximumFractionDigits: 0 });
  return String(texto).replace(VALOR_EM_REAIS, (inteiro, a, b) => {
    const reais = Number(String(a ?? b).replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(reais)) return inteiro;
    return formato.format(arredondarPreco(reais * taxa * (1 + ajustePct / 100))).replace(/ /g, " ");
  });
}

/**
 * O pedido para a IA quando a empresa é de fora: os valores na moeda de lá e a ordem de escrever no idioma
 * dela (vale acima das regras de "Português do Brasil" do resto do texto). Para empresa do Brasil, igual.
 */
export async function localizarParaEmpresa(system, lead) {
  if (!ehExterior(lead)) return system;
  const pais = PAISES[lead.pais];
  const [cot, conf] = await Promise.all([cotacoes(), configInternacional()]);
  const idioma = lead.idioma || pais.idioma;
  const convertido = converterValores(system, { moeda: pais.moeda, idioma, taxa: cot[pais.moeda], ajustePct: conf.ajustePct });
  const nomeMoeda = pais.moeda === "EUR" ? "euros (€)" : "dólares americanos (US$)";
  return `${convertido}

IDIOMA, PAÍS E MOEDA (esta regra vale acima de qualquer outra sobre idioma neste texto):
- Esta empresa fica em ${pais.nome}${lead.cidade ? ` (${lead.cidade})` : ""}. Tudo o que vai para ela (mensagens, e-mail, assunto) deve ser escrito em ${nomeDoIdioma(idioma)}, como um nativo de lá escreveria, no tom de negócios local. Ignore as instruções que pedem "Português do Brasil" para o texto que vai à empresa.
- Os campos internos (resumo_interno, resumo, motivos e explicações para a equipe) continuam em português do Brasil.
- Todos os valores já estão em ${nomeMoeda}: use exatamente como estão. Nunca cite reais, R$ nem converta de novo.
- Nada que só existe no Brasil: Pix, boleto, CNPJ, DDD, feriados ou cidades brasileiras como referência.
- Se perguntarem de onde vocês são: uma empresa brasileira que atende clientes de outros países, com reuniões online e no idioma do cliente.
- Horários citados na conversa são no fuso de lá (${fusoDaEmpresa(lead)}).`;
}

// ---------- Busca ----------

const traducoes = new Map();

/** O segmento no idioma do país, para a busca do Google ("dentista" → "Zahnarzt"); guardado no banco. */
export async function segmentoNoIdioma(nicho, idioma, { traduzir } = {}) {
  const base = String(idioma ?? "en").split("-")[0];
  const texto = String(nicho ?? "").trim();
  if (!texto || base === "pt") return texto;
  const chave = `${base}:${sem(texto)}`;
  if (traducoes.has(chave)) return traducoes.get(chave);
  const salvas = (await db.lerConfig("segmentos_traduzidos").catch(() => null)) ?? {};
  if (salvas[chave]) return traducoes.set(chave, salvas[chave]).get(chave);
  let traduzido = texto;
  try {
    traduzido = (await (traduzir ?? traduzirComIA)(texto, base))?.trim() || texto;
  } catch {}
  traducoes.set(chave, traduzido);
  await db.gravarConfig("segmentos_traduzidos", { ...salvas, [chave]: traduzido }).catch(() => {});
  return traduzido;
}

async function traduzirComIA(texto, idioma) {
  const { z } = await import("zod");
  const { gerarJson } = await import("./ia/cliente.js");
  const r = await gerarJson({
    system: "Você traduz tipos de negócio para a busca no Google Maps de outro país. Responda só o termo que um morador de lá digitaria para achar esse tipo de empresa, no singular, sem cidade.",
    pedido: `Tipo de negócio em português: "${texto}". Idioma de destino: ${nomeDoIdioma(idioma)}.`,
    jsonSchema: { type: "object", properties: { termo: { type: "string" } }, required: ["termo"], additionalProperties: false },
    zodSchema: z.object({ termo: z.string() }),
    effort: "low",
    maxTokens: 400,
  });
  return r.termo;
}
