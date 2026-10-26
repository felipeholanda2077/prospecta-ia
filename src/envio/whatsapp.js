import { config } from "../config.js";

/**
 * Envia mensagem pela WhatsApp Cloud API oficial da Meta usando um template aprovado.
 *
 * O template (WHATSAPP_TEMPLATE) deve ter 2 variáveis no corpo:
 *   {{1}} = nome da empresa   {{2}} = texto da proposta
 * Ex.: "Olá, {{1}}! {{2}} Responda SAIR se não quiser mais receber mensagens."
 *
 * Bibliotecas não oficiais (open-wa, whatsapp-web.js, Baileys) violam os termos do
 * WhatsApp para disparos em massa e levam ao banimento do número — por isso não são usadas aqui.
 */
export async function enviarWhatsapp({ para, empresa, corpo }) {
  const { ativo, token, phoneNumberId, template, idioma, apiVersion } = config.whatsapp;
  if (!ativo) throw new Error("WhatsApp desativado (WHATSAPP_ATIVO=false)");
  if (!token || !phoneNumberId) throw new Error("WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID não configurados");

  // Variáveis de template não aceitam quebras de linha nem tabs.
  const texto = corpo.replace(/\s*\n+\s*/g, " ").slice(0, 900);

  const resp = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "template",
      template: {
        name: template,
        language: { code: idioma },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: empresa },
              { type: "text", text: texto },
            ],
          },
        ],
      },
    }),
  });

  const dados = await resp.json();
  if (!resp.ok) throw new Error(`WhatsApp API ${resp.status}: ${dados.error?.message ?? JSON.stringify(dados)}`);
  return dados.messages?.[0]?.id;
}
