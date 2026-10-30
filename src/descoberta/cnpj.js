import { readFile } from "node:fs/promises";
import { z } from "zod";
import * as db from "../db.js";
import { gerarJson } from "../ia/cliente.js";

// Empresas pelos dados abertos do CNPJ (Receita Federal), sem chave e sem custo:
// - a Casa dos Dados acha os CNPJs por atividade (CNAE) e cidade, até 20 por consulta (as próximas
//   vêm pedindo de novo sem os que já vieram);
// - a Minha Receita (ou a BrasilAPI, com os mesmos dados) traz o telefone e o e-mail de cada CNPJ; o que ela ainda não tem
//   (CNPJ aberto este mês) vem da API aberta da CNPJá, que aceita 5 consultas por minuto;
// - a lista de atividades (CNAE) do IBGE fica em config/cnae.json (a API do IBGE recusa acessos de fora
//   do Brasil, como o servidor da Vercel), para a IA achar a do segmento digitado.
const PESQUISA = "https://api.casadosdados.com.br/v5/public/cnpj/pesquisa";
const CONSULTA = "https://minhareceita.org";
// Mesmos dados e formato da Minha Receita, para quando ela recusar o acesso (ex.: pelo servidor da Vercel).
const CONSULTA_ESPELHO = "https://brasilapi.com.br/api/cnpj/v1";
const CONSULTA_RESERVA = "https://open.cnpja.com/office";
// Uma consulta à CNPJá a cada 12 s, somando todas as execuções (o limite dela é 5 por minuto).
const RITMO_RESERVA_MS = 12_000;
const LISTA_CNAE = new URL("../../config/cnae.json", import.meta.url);
const POR_CONSULTA = 20;
// A busca traz primeiro os CNPJs mais novos, e os abertos nas últimas semanas ainda não estão na base
// que tem o telefone e o e-mail: ficam de fora, para a busca trazer empresas com contato.
const DIAS_ATE_ENTRAR_NA_BASE = 30;
const diasAtras = (dias) => new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** "Fortaleza - CE", "Fortaleza, CE", "Fortaleza/CE" → { municipio: "fortaleza", uf: "ce" }. */
export function municipioEUf(cidade) {
  const [, nome, uf] = String(cidade ?? "").trim().match(/^(.*?)(?:\s*[-,/]\s*([A-Za-z]{2}))?$/) ?? [];
  const municipio = String(nome ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  return { municipio, uf: uf ? uf.toLowerCase() : null };
}

/**
 * Telefone do cadastro (DDD + número) no formato do Brasil. Celular antigo, sem o nono dígito
 * (8 dígitos começando com 6 a 9), ganha o 9 na frente.
 */
export function telefoneDoCnpj(valor) {
  let d = String(valor ?? "").replace(/\D/g, "");
  if (/^(\d)\1+$/.test(d.slice(2)) || /^0+$/.test(d.slice(0, 2))) return null; // (11) 1111-1111 e afins
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return null;
}

// E-mail de escritório de contabilidade (muito comum no cadastro do CNPJ): não é da empresa.
const EMAIL_DE_CONTADOR = /cont[aá]b|contador|escrit[oó]rio|assessoria|fiscal|tribut|declara|abertura.?de.?empresa|legaliza/i;
export const emailDeContador = (email) => EMAIL_DE_CONTADOR.test(String(email ?? ""));

/** "STUDIO MAS CABELEIREIROS" → "Studio Mas Cabeleireiros"; tira o CNPJ/CPF que o MEI leva no nome. */
export function nomeDaEmpresa({ nome_fantasia, razao_social }) {
  const bruto = String(nome_fantasia || razao_social || "").replace(/^[\d.]+\s+/, "").replace(/\s+\d{11}$/, "").trim();
  if (bruto !== bruto.toUpperCase()) return bruto;
  const minusculas = new Set(["de", "da", "do", "das", "dos", "e", "em"]);
  return bruto.toLowerCase().split(/\s+/)
    .map((p, i) => (i > 0 && minusculas.has(p) ? p : /^(ltda|me|epp|eireli|s\/a|sa)$/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

let listaCnae = null;
/** As atividades do CNAE (subclasses) com a descrição, da tabela do IBGE. */
async function atividades() {
  listaCnae ??= JSON.parse(await readFile(LISTA_CNAE, "utf8")).map(([codigo, descricao]) => ({ codigo, descricao }));
  return listaCnae;
}

/** fetch que diz qual fonte falhou ("fetch failed" sozinho não ajuda). */
async function buscar(fonte, url, opcoes) {
  try {
    return await fetch(url, opcoes);
  } catch (e) {
    throw new Error(`${fonte} não respondeu (${e.cause?.code ?? e.message})`);
  }
}

const CnaeSchema = z.object({ codigos: z.array(z.string()) });
const CNAE_JSON_SCHEMA = {
  type: "object",
  properties: { codigos: { type: "array", items: { type: "string" }, description: "códigos de 7 dígitos, do mais para o menos fiel ao segmento; o primeiro é o que vale" } },
  required: ["codigos"],
  additionalProperties: false,
};

/** A IA escolhe na lista do IBGE as atividades que são o segmento (o negócio final, não fábrica nem atacado). */
async function escolherComIA({ nicho, lista }) {
  return gerarJson({
    system: `Você conhece a tabela CNAE do Brasil. Escolha as atividades (subclasses) que uma empresa desse segmento declara
como atividade principal no CNPJ. É o negócio que atende o cliente final do segmento: nada de fábrica, atacado,
representante comercial, laboratório ou fornecedor do segmento, a não ser que o próprio segmento seja isso.
O primeiro código é o que vai ser usado na busca: ponha primeiro a atividade que a maioria das empresas desse
segmento declara. Use só códigos da lista.`,
    pedido: `Segmento: ${nicho}\n\nAtividades (código: descrição):\n${lista.map((a) => `${a.codigo}: ${a.descricao.slice(0, 90)}`).join("\n")}`,
    jsonSchema: CNAE_JSON_SCHEMA,
    zodSchema: CnaeSchema,
    effort: "low",
  });
}

const chaveCnae = (nicho) => `cnae_do_segmento_v3:${String(nicho).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()}`;

/**
 * As atividades (CNAE) do segmento: as que você informou, ou as que a IA escolheu (guardadas
 * por segmento, para não perguntar de novo). Retorna [{ codigo, descricao }].
 */
export async function cnaesDoSegmento(nicho, { cnae = "", escolher = escolherComIA } = {}) {
  const lista = await atividades();
  const porCodigo = new Map(lista.map((a) => [a.codigo, a]));
  const informados = String(cnae).replace(/[^\d,; ]/g, "").split(/[,; ]+/).map((c) => c.replace(/\D/g, "")).filter((c) => c.length === 7);
  if (informados.length) {
    const validos = informados.filter((c) => porCodigo.has(c));
    if (!validos.length) throw new Error(`CNAE não encontrado na tabela do IBGE: ${informados.join(", ")}`);
    return validos.map((c) => porCodigo.get(c));
  }
  const salvo = await db.lerEstado(chaveCnae(nicho));
  if (salvo) return JSON.parse(salvo);
  const { codigos } = await escolher({ nicho, lista });
  const achados = [...new Set(codigos.map((c) => String(c).replace(/\D/g, "")))].filter((c) => porCodigo.has(c)).slice(0, 1).map((c) => porCodigo.get(c));
  if (!achados.length) throw new Error(`não achei a atividade (CNAE) de "${nicho}"; informe o código do CNAE`);
  await db.gravarEstado(chaveCnae(nicho), JSON.stringify(achados));
  return achados;
}

/** Uma consulta à Casa dos Dados: até 20 CNPJs ativos da atividade na cidade, sem os de `excluir`. */
async function pesquisar({ cnaes, municipio, uf, incluirMei, abertasHaDias, excluir }) {
  const corpo = {
    codigo_atividade_principal: cnaes,
    situacao_cadastral: ["ATIVA"],
    municipio: [municipio],
    ...(uf ? { uf: [uf] } : {}),
    ...(incluirMei ? {} : { mei: { excluir_optante: true } }),
    data_abertura: { ...(abertasHaDias ? { inicio: diasAtras(Number(abertasHaDias)) } : {}), fim: diasAtras(DIAS_ATE_ENTRAR_NA_BASE) },
    mais_filtros: { com_telefone: true, excluir_email_contab: true },
    ...(excluir.length ? { excluir: { cnpj: excluir } } : {}),
    limite: POR_CONSULTA,
    pagina: 1,
  };
  const r = await buscar("Casa dos Dados", PESQUISA, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Prospecta IA)" }, body: JSON.stringify(corpo) });
  if (!r.ok) throw new Error(`a busca de CNPJs (Casa dos Dados) respondeu ${r.status}`);
  const d = await r.json();
  return { total: d.total ?? 0, cnpjs: d.cnpjs ?? [] };
}

/**
 * O cadastro completo de um CNPJ (telefone, e-mail, endereço, abertura), pela Minha Receita; se ela
 * recusar o acesso (não o "não encontrado"), pela BrasilAPI.
 */
export async function dadosDoCnpj(cnpj) {
  const numero = String(cnpj).replace(/\D/g, "");
  let r = await buscar("Minha Receita", `${CONSULTA}/${numero}`).catch(() => null);
  if (!r || (!r.ok && r.status !== 404)) r = await buscar("BrasilAPI", `${CONSULTA_ESPELHO}/${numero}`);
  if (r.status === 404) throw Object.assign(new Error("CNPJ ainda não está na base"), { naoEncontrado: true });
  if (!r.ok) throw new Error(`a consulta do CNPJ respondeu ${r.status}`);
  const d = await r.json();
  const endereco = [[d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(" "), d.numero, d.bairro, d.municipio && `${d.municipio} - ${d.uf}`]
    .filter(Boolean).join(", ");
  return {
    telefones: [d.ddd_telefone_1, d.ddd_telefone_2].map(telefoneDoCnpj).filter(Boolean),
    email: d.email ? String(d.email).trim().toLowerCase() : null,
    endereco: endereco || null,
    bairro: d.bairro ?? null,
    abertura: d.data_inicio_atividade ?? null,
    porte: d.porte ?? null,
    mei: Boolean(d.opcao_pelo_mei),
  };
}

/**
 * Reserva: o cadastro pela CNPJá (mais atualizado). Respeita o ritmo da API aberta: se outra consulta
 * saiu há menos de 12 s, retorna null sem consultar (`semVez`), para tentar de novo depois.
 */
export async function dadosDoCnpjNaReserva(cnpj) {
  if (!(await db.travar("cnpja_aberta", RITMO_RESERVA_MS))) return { semVez: true };
  const r = await buscar("CNPJá", `${CONSULTA_RESERVA}/${String(cnpj).replace(/\D/g, "")}`);
  if (!r.ok) throw new Error(`a consulta do CNPJ (reserva) respondeu ${r.status}`);
  const d = await r.json();
  const a = d.address ?? {};
  // Celular primeiro: é o que costuma ter WhatsApp.
  const telefones = [...(d.phones ?? [])].sort((x, y) => Number(y.type === "MOBILE") - Number(x.type === "MOBILE"))
    .map((t) => telefoneDoCnpj(`${t.area}${t.number}`)).filter(Boolean);
  const email = (d.emails ?? []).find((e) => e.ownership !== "ACCOUNTING")?.address ?? null;
  return {
    telefones,
    email: email ? String(email).toLowerCase() : null,
    endereco: [a.street, a.number, a.district, a.city && `${a.city} - ${a.state}`].filter(Boolean).join(", ") || null,
    bairro: a.district ?? null,
    abertura: d.founded ?? null,
    porte: d.company?.size?.text ?? null,
    mei: Boolean(d.company?.simei?.optant),
  };
}

/**
 * Telefone e e-mail do CNPJ: pela Minha Receita e, se ela não tiver, pela reserva (quando for a vez).
 * `erros` traz as falhas de acesso (não o "ainda não está na base"), para o painel mostrar.
 */
export async function contatoDoCnpj(cnpj, { consultar = dadosDoCnpj, reserva = dadosDoCnpjNaReserva } = {}) {
  const erros = [];
  const falhou = (e) => (e.naoEncontrado || erros.push(e.message), null);
  const dados = await consultar(cnpj).catch(falhou);
  if (dados?.telefones.length) return dados;
  const daReserva = await reserva(cnpj).catch(falhou);
  if (daReserva?.semVez) return { ...(dados ?? { telefones: [] }), incompleto: true, erros };
  if (daReserva?.telefones?.length || daReserva?.email) return { ...dados, ...daReserva };
  return { ...(dados ?? { telefones: [] }), erros };
}

/**
 * Busca empresas pelo CNPJ: atividade do segmento + cidade, só ativas, com telefone e (por padrão)
 * sem MEI. Traz o telefone e o e-mail de cada uma e tira o que parece ser do contador: e-mail de
 * contabilidade e telefone que se repete em empresas diferentes (é o do escritório que cuida delas).
 * `jaCapturados` são CNPJs que não devem voltar (para a busca trazer empresas novas).
 */
export async function buscarEmpresasPorCnpj({
  nicho, cidade, quantidade = 20, cnae = "", incluirMei = false, abertasHaDias = null, jaCapturados = [],
  escolher, contato = contatoDoCnpj, telefoneUsado = async () => false, pausa = 250,
}) {
  const { municipio, uf } = municipioEUf(cidade);
  if (!municipio) throw new Error("Informe a cidade (ex.: Fortaleza - CE)");
  const cnaes = await cnaesDoSegmento(nicho, { cnae, escolher });
  const codigos = cnaes.map((c) => c.codigo);

  const achados = [];
  const excluir = [...jaCapturados].slice(-800);
  let total = 0;
  for (let i = 0; i < Math.ceil(quantidade / POR_CONSULTA) + 1 && achados.length < quantidade; i++) {
    const r = await pesquisar({ cnaes: codigos, municipio, uf, incluirMei, abertasHaDias, excluir });
    if (i === 0) total = r.total;
    const novos = r.cnpjs.filter((c) => !excluir.includes(c.cnpj));
    if (!novos.length) break;
    achados.push(...novos);
    excluir.push(...novos.map((c) => c.cnpj));
  }

  const empresas = [];
  const avisos = new Set();
  for (const c of achados.slice(0, quantidade)) {
    const dados = await contato(c.cnpj).catch((e) => ({ erros: [e.message], telefones: [] }));
    for (const erro of dados?.erros ?? []) avisos.add(erro);
    if (pausa) await esperar(pausa);
    empresas.push({
      cnpj: c.cnpj,
      place_id: `cnpj:${c.cnpj}`,
      nome: nomeDaEmpresa(c),
      razao_social: c.razao_social,
      telefone: dados?.telefones?.[0] ?? null,
      email: dados?.email ?? null,
      endereco: dados?.endereco ?? null,
      bairro: dados?.bairro ?? null,
      abertura: dados?.abertura ?? null,
      porte: dados?.porte ?? null,
      mei: dados?.mei ?? false,
      // A CNPJá não deu a vez: o contato é buscado de novo na análise.
      contatoPendente: Boolean(dados?.incompleto),
    });
  }

  // Contato do contador: e-mail de contabilidade, ou o mesmo telefone em empresas diferentes
  // (nesta busca ou em outra empresa já capturada pelo CNPJ).
  // (Calculado antes de apagar: as duas empresas com o mesmo telefone perdem o telefone.)
  const raiz = (cnpj) => cnpj.slice(0, 8);
  const repetidos = new Set(empresas.filter((e) => e.telefone && empresas.some((o) => o !== e && o.telefone === e.telefone && raiz(o.cnpj) !== raiz(e.cnpj)))
    .map((e) => e.telefone));
  for (const e of empresas) {
    const contador = [];
    if (e.email && emailDeContador(e.email)) contador.push("e-mail");
    if (e.telefone && (repetidos.has(e.telefone) || (await telefoneUsado(e.telefone, e.place_id)))) contador.push("telefone");
    if (contador.includes("e-mail")) e.email = null;
    if (contador.includes("telefone")) e.telefone = null;
    e.contador = contador;
    e.semContato = !e.telefone && !e.email && !e.contatoPendente;
  }
  return { empresas, cnaes, total, avisos: [...avisos].map((a) => `Contato do cadastro: ${a}`) };
}
