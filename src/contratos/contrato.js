import { readFile } from "node:fs/promises";
import * as db from "../db.js";
import { reais, reaisComExtenso, numeroPorExtenso, lerValor, diasPorExtenso, documentoFormatado, lerData, dataPorExtenso, mesDepois } from "./valores.js";

// O contrato de cada cliente nasce do modelo (editável no painel; o padrão fica em config/contrato-modelo.md,
// sem dados pessoais, porque o repositório é público). Os dados de quem contrata e o pagamento entram quando o
// contrato é criado; os da contratada (CPF, PIX...) ficam só no banco e entram quando o documento é mostrado.
const MODELO_PADRAO = new URL("../../config/contrato-modelo.md", import.meta.url);
const CHAVE_MODELO = "contrato_modelo";
const CHAVE_CONTRATADA = "contrato_contratada";
export const STATUS_CONTRATO = ["rascunho", "enviado", "assinado", "cancelado"];
const EM_BRANCO = "____________________";

export const modeloPadrao = () => readFile(MODELO_PADRAO, "utf8");
export const lerModelo = async () => (await db.lerConfig(CHAVE_MODELO))?.corpo ?? modeloPadrao();

/** Salva o modelo; sem texto, volta para o modelo padrão. Não muda os contratos já criados. */
export async function salvarModelo(corpo) {
  const texto = String(corpo ?? "").trim();
  await db.gravarConfig(CHAVE_MODELO, texto ? { corpo: texto } : {});
  return lerModelo();
}

/** Seus dados no contrato. O que ainda não foi preenchido vem do perfil da empresa, ou fica em branco. */
export async function lerContratada(campanha) {
  const salvo = (await db.lerConfig(CHAVE_CONTRATADA)) ?? {};
  const e = campanha?.empresa ?? {};
  return { nome: salvo.nome || e.responsavel || "", marca: salvo.marca || e.nome || "", cnpj: salvo.cnpj ?? "", cpf: salvo.cpf ?? "", email: salvo.email || e.email || "", pix: salvo.pix ?? "", foro: salvo.foro ?? "" };
}

/** Salva só os campos que vieram; os outros continuam como estão. */
export async function salvarContratada(dados = {}) {
  const limpo = (v, max = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const novo = { ...((await db.lerConfig(CHAVE_CONTRATADA)) ?? {}) };
  for (const k of ["nome", "marca", "cnpj", "cpf", "email", "pix", "foro"]) if (dados[k] !== undefined) novo[k] = limpo(dados[k]);
  await db.gravarConfig(CHAVE_CONTRATADA, novo);
  return novo;
}

const OBRIGACOES_PADRAO = "A CONTRATANTE obriga-se a fornecer, na data da assinatura, os materiais e acessos necessários ao projeto, tais como textos, imagens e identidade visual completa, e as contas necessárias à publicação, ativas e em seu nome, conforme o Anexo I.";

/**
 * O pagamento, nos dois formatos: "mensal" (valor × meses) ou "entrada e saldo". Retorna os trechos do
 * contrato, ou { erro } com o que falta preencher.
 */
export function montarPagamento({ tipoPagamento = "mensal", valorMensal, meses, primeiroPagamento, entrada, saldo }) {
  const linhaTabela = (...c) => `| ${c.join(" | ")} |`;
  const blocoResumo = (...linhas) => ["::resumo", ...linhas.map(([a, b]) => `${a} | ${b}`), "::"].join("\n");
  if (tipoPagamento === "mensal") {
    const valor = lerValor(valorMensal);
    const n = Number.parseInt(meses, 10);
    if (!valor) return { erro: "Informe o valor por mês" };
    if (!(n >= 1 && n <= 120)) return { erro: "Informe em quantos meses (de 1 a 120)" };
    const parcela = reaisComExtenso(valor);
    const qtd = `${n} (${numeroPorExtenso(n).replace(/^um$/, "uma").replace(/^dois$/, "duas")})`;
    const periodo = `${n} (${numeroPorExtenso(n)}) ${n === 1 ? "mês" : "meses"}`;
    const primeira = lerData(primeiroPagamento);
    if (primeiroPagamento && !primeira) return { erro: "Confira a data do primeiro pagamento" };
    // Dia 29 a 31 não existe em todo mês.
    const todoDia = primeira && `Todo dia ${primeira.dia}${primeira.dia > 28 ? " (ou o último dia do mês)" : ""}`;
    const demais = primeira
      ? (n === 2 ? `Dia ${primeira.dia} de ${mesDepois(primeira, 1)}` : `${todoDia}, de ${mesDepois(primeira, 1)} a ${mesDepois(primeira, n - 1)}`)
      : (n === 2 ? "No mesmo dia do mês seguinte" : `No mesmo dia dos ${n - 1} meses seguintes`);
    return {
      total: valor * n,
      forma_de_pagamento: n === 1 ? "em parcela única, da seguinte forma"
        : `em ${qtd} parcelas mensais e consecutivas de ${parcela}, com período de vigência de ${periodo}, da seguinte forma`,
      tabela_pagamento: [
        linhaTabela("Parcela", "Valor", "Vencimento"), "|---|---|---|",
        linhaTabela("1ª", parcela, primeira ? dataPorExtenso(primeira) : "Na assinatura deste contrato"),
        ...(n > 1 ? [linhaTabela(n === 2 ? "2ª" : `2ª a ${n}ª`, `${parcela}${n > 2 ? " cada" : ""}`, demais)] : []),
      ].join("\n"),
      bloco_resumo: blocoResumo(["Valor mensal", reais(valor)], ["Vigência", `${n} ${n === 1 ? "mês" : "meses"}`],
        ["1º pagamento", primeira ? dataPorExtenso(primeira) : "Na assinatura"], ["Valor total", reais(valor * n)]),
      rescisao_valores_pagos: n === 1 ? "o valor pago não será restituído" : "as parcelas já pagas não serão restituídas",
      resumo: `${reaisComExtenso(valor)} por mês, ${n} ${n === 1 ? "mês" : "meses"}`,
    };
  }
  const e = lerValor(entrada);
  const s = lerValor(saldo);
  if (!e) return { erro: "Informe o valor da entrada" };
  if (s == null) return { erro: "Informe o valor do saldo" };
  return {
    total: e + s,
    forma_de_pagamento: "dividido da seguinte forma",
    tabela_pagamento: [
      linhaTabela("Parcela", "Valor", "Vencimento"), "|---|---|---|",
      linhaTabela("1ª — entrada", reaisComExtenso(e), "Na assinatura deste contrato"),
      ...(s ? [linhaTabela("2ª — saldo", reaisComExtenso(s), "Na entrega final dos serviços")] : []),
    ].join("\n"),
    rescisao_valores_pagos: "o valor da 1ª parcela não será restituído",
    bloco_resumo: blocoResumo(["Entrada", reais(e)], ["Saldo", reais(s)], ["Valor total", reais(e + s)]),
    resumo: `${reaisComExtenso(e + s)} (entrada e saldo)`,
  };
}

const substituir = (texto, valores) => texto.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (tudo, nome) => (nome in valores ? valores[nome] || EM_BRANCO : tudo));

/** Monta o texto do contrato de um cliente a partir do modelo. Os dados da contratada continuam como {{...}}. */
export function montarCorpo(modelo, dados) {
  const pagamento = montarPagamento(dados);
  if (pagamento.erro) return pagamento;
  const projeto = String(dados.projeto ?? "").trim();
  if (!String(dados.contratante ?? "").trim()) return { erro: "Informe o nome do cliente" };
  if (!projeto) return { erro: "Informe o nome do projeto" };
  const doc = documentoFormatado(dados.documento);
  if (String(dados.documento ?? "").trim() && !doc) return { erro: "Confira o CNPJ ou CPF do cliente" };
  const dias = Number.parseInt(dados.prazoDias, 10);
  const objeto = String(dados.objeto ?? "").trim() || `o desenvolvimento de ${projeto}`;
  return {
    corpo: substituir(modelo, {
      subtitulo: String(dados.subtitulo ?? "").trim() || `Desenvolvimento de ${projeto}`,
      contratante_nome: String(dados.contratante).trim(),
      contratante_documento: doc?.tipo === "CPF" ? `pessoa física, inscrita no CPF sob o nº ${doc.numero}`
        : `pessoa jurídica de direito privado, inscrita no CNPJ sob o nº ${doc?.numero ?? EM_BRANCO}`,
      contratante_documento_curto: doc ? `${doc.tipo}: ${doc.numero}` : `CNPJ: ${EM_BRANCO}`,
      contratante_email: String(dados.email ?? "").trim(),
      representante: String(dados.representante ?? "").trim(),
      representante_cpf: documentoFormatado(dados.representanteCpf)?.numero ?? "",
      objeto,
      documento_escopo: String(dados.documentoEscopo ?? "").trim() || `${projeto} — Escopo`,
      valor_total: reaisComExtenso(pagamento.total),
      forma_de_pagamento: pagamento.forma_de_pagamento,
      tabela_pagamento: pagamento.tabela_pagamento,
      rescisao_valores_pagos: pagamento.rescisao_valores_pagos,
      bloco_resumo: pagamento.bloco_resumo,
      prazo: `${dias >= 1 ? diasPorExtenso(dias) : `${EM_BRANCO} dias`}`,
      obrigacoes_contratante: String(dados.obrigacoes ?? "").trim() || OBRIGACOES_PADRAO,
      foro: String(dados.foro ?? "").trim(),
    }),
    total: pagamento.total,
    resumo: pagamento.resumo,
  };
}

/** O texto final do documento: os dados da contratada no lugar (em branco no que faltar). */
export function preencherContratada(corpo, contratada) {
  return substituir(corpo, Object.fromEntries(["nome", "marca", "cnpj", "cpf", "email", "pix"].map((k) => [`contratada_${k}`, contratada[k] ?? ""])));
}

/**
 * Cria o contrato de um cliente. Com `leadId`, a empresa vira cliente: nada mais de prospecção
 * sai para ela. Retorna o contrato, ou { erro }.
 */
export async function criarContrato(dados, campanha) {
  const m = montarCorpo(await lerModelo(), dados);
  if (m.erro) return m;
  const lead = dados.leadId ? await db.buscarLead(dados.leadId) : null;
  if (dados.leadId && !lead) return { erro: "Empresa não encontrada" };
  const id = await db.criarContrato({
    lead_id: lead?.id ?? null, projeto: String(dados.projeto).trim().slice(0, 120), contratante: String(dados.contratante).trim().slice(0, 160),
    corpo: m.corpo, resumo: m.resumo, valor_total: m.total,
  });
  if (lead) {
    await db.cancelarPendentes(lead.id, "cliente fechou o contrato");
    await db.atualizarLead(lead.id, { status: "fechado" });
  }
  return db.buscarContrato(id);
}

/** O que já dá para preencher no contrato de uma empresa do sistema. */
export async function padroesDoContrato(leadId, campanha) {
  const contratada = await lerContratada(campanha);
  const lead = leadId ? await db.buscarLead(leadId) : null;
  return {
    foro: contratada.foro,
    ...(lead ? {
      leadId: lead.id, contratante: lead.nome, email: lead.email ?? "",
      documento: String(lead.place_id ?? "").startsWith("cnpj:") ? lead.place_id.slice(5) : "",
    } : {}),
  };
}
