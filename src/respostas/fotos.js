import * as db from "../db.js";
import * as uazap from "../envio/uazap.js";

// Foto de perfil de cada empresa, para os avatares do painel e do CRM: a do WhatsApp (pela UAZap) ou, sem ela,
// a do Instagram que a busca já guardou. O link dessas fotos expira, então a imagem é baixada e guardada
// (midias, chave foto-lead-<id>) e renovada a cada 7 dias; "sem foto" também fica guardado, por 3 dias.

const VALIDADE_MS = 7 * 24 * 3600_000;
const SEM_FOTO_MS = 3 * 24 * 3600_000;
const MAX_BYTES = 400_000;
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

async function buscarFoto(lead, { foto, baixar }) {
  const telefone = String(lead.whatsapp ?? "").replace(/\D/g, "");
  let url = "";
  if (telefone && (await uazap.configurada())) url = await foto(telefone, { numeroId: lead.numero_wa || null }).catch(() => "");
  if (!url) url = fotoDoInstagram(lead) ?? "";
  const imagem = url ? await baixarImagem(url, baixar).catch(() => null) : null;
  await db.gravarMidia(chave(lead.id), imagem?.tipo ?? "sem", imagem?.dados ?? Buffer.alloc(0));
  return imagem;
}

/** A foto da empresa ({ tipo, dados }) ou null quando ela não tem foto. Busca só quando a guardada venceu. */
export async function fotoDoLead(leadId, { foto = uazap.fotoDoContato, baixar = fetch, agora = Date.now() } = {}) {
  const guardada = await db.lerMidiaComData(chave(leadId));
  if (guardada) {
    const idade = agora - guardada.criadaEm.getTime();
    if (guardada.tipo === "sem" ? idade < SEM_FOTO_MS : idade < VALIDADE_MS) return guardada.tipo === "sem" ? null : guardada;
  }
  if (buscando.has(leadId)) return buscando.get(leadId);
  const lead = await db.buscarLead(leadId);
  if (!lead) return null;
  const promessa = buscarFoto(lead, { foto, baixar })
    .catch(() => (guardada && guardada.tipo !== "sem" ? guardada : null)) // a antiga ainda serve se a busca falhar
    .finally(() => buscando.delete(leadId));
  buscando.set(leadId, promessa);
  return promessa;
}
