import * as db from "../db.js";
import * as uazap from "../envio/uazap.js";

// Foto de perfil de cada empresa, para os avatares do painel e do CRM: a do WhatsApp (pela UAZap) ou, sem ela,
// a do Instagram que a busca já guardou. O link dessas fotos expira, então a imagem é baixada e fica salva no
// banco (midias, chave foto-lead-<id>), sem prazo para sair. A rodada salva as fotos das empresas das conversas
// aos poucos e procura uma foto nova a cada 7 dias; se a empresa tirou a foto ou a busca falhou, a salva continua.
// Quem não tem foto nenhuma é conferido de novo a cada 3 dias.

const DIA_MS = 24 * 3600_000;
export const RENOVAR_MS = 7 * DIA_MS;
export const SEM_FOTO_MS = 3 * DIA_MS;
const MAX_BYTES = 400_000;
const POR_RODADA = 3;
const chave = (leadId) => `foto-lead-${leadId}`;
const buscando = new Map(); // leadId → promessa (duas telas pedindo a mesma foto ao mesmo tempo buscam uma vez só)

function fotoDoInstagram(lead) {
  try {
    return JSON.parse(lead.instagram_dados || "null")?.foto ?? null;
  } catch {
    return null;
  }
}

async function baixarImagem(url, baixar = fetch) {
  const resp = await baixar(url, { signal: AbortSignal.timeout(10_000) });
  const tipo = resp.headers.get("content-type") ?? "";
  if (!resp.ok || !tipo.startsWith("image/")) return null;
  const dados = Buffer.from(await resp.arrayBuffer());
  return dados.length && dados.length <= MAX_BYTES ? { tipo, dados } : null;
}

/** Busca a foto atual e salva. Sem foto nova, a que já estava salva continua (só a data de conferência muda). */
async function buscarESalvar(lead, guardada, { foto, baixar }) {
  const telefone = String(lead.whatsapp ?? "").replace(/\D/g, "");
  let url = "";
  if (telefone && (await uazap.configurada())) url = await foto(telefone, { numeroId: lead.numero_wa || null }).catch(() => "");
  if (!url) url = fotoDoInstagram(lead) ?? "";
  const nova = url ? await baixarImagem(url, baixar).catch(() => null) : null;
  const salvar = nova ?? (guardada?.tipo !== "sem" ? guardada : null);
  await db.gravarMidia(chave(lead.id), salvar?.tipo ?? "sem", salvar?.dados ?? Buffer.alloc(0));
  return salvar;
}

function salvarAgora(leadId, guardada, opcoes) {
  if (buscando.has(leadId)) return buscando.get(leadId);
  const promessa = db.buscarLead(leadId)
    .then((lead) => (lead ? buscarESalvar(lead, guardada, opcoes) : null))
    .catch(() => (guardada?.tipo !== "sem" ? guardada : null)) // a salva ainda serve se a busca falhar
    .finally(() => buscando.delete(leadId));
  buscando.set(leadId, promessa);
  return promessa;
}

/**
 * A foto da empresa ({ tipo, dados }) ou null quando ela não tem foto. A salva sai na hora, sem ir ao WhatsApp;
 * a tela só busca quando a empresa ainda não tem foto salva (ou o "sem foto" já tem 3 dias).
 */
export async function fotoDoLead(leadId, { foto = uazap.fotoDoContato, baixar = fetch, agora = Date.now() } = {}) {
  const guardada = await db.lerMidiaComData(chave(leadId));
  if (guardada?.tipo && guardada.tipo !== "sem") return guardada;
  if (guardada && agora - guardada.criadaEm.getTime() < SEM_FOTO_MS) return null;
  return salvarAgora(leadId, guardada, { foto, baixar });
}

/** Na rodada: salva as fotos que faltam e renova as de 7 dias (e confere as "sem foto" de 3 dias), poucas por vez. */
export async function salvarFotosDasEmpresas({ foto = uazap.fotoDoContato, baixar = fetch, agora = Date.now(), limite = POR_RODADA } = {}) {
  const ids = await db.leadsParaFoto({
    fotoAntesDe: new Date(agora - RENOVAR_MS).toISOString(),
    semFotoAntesDe: new Date(agora - SEM_FOTO_MS).toISOString(),
    limite,
  });
  let salvas = 0;
  for (const id of ids) { // uma por vez: o banco e a UAZap não recebem pedidos em paralelo
    const guardada = await db.lerMidiaComData(chave(id));
    if (await salvarAgora(id, guardada, { foto, baixar })) salvas++;
  }
  return { conferidas: ids.length, salvas };
}
