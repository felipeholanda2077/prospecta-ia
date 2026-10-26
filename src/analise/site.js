import { normalizarTelefoneBR } from "./telefone.js";

const USER_AGENT = "ProspectaIA/0.1 (+analise de presenca digital; respeita robots.txt)";
const TIMEOUT_MS = 12000;

const PLATAFORMAS_LOJA = [
  ["shopify", /cdn\.shopify\.com|shopify/i],
  ["woocommerce", /woocommerce/i],
  ["nuvemshop", /nuvemshop|tiendanube/i],
  ["vtex", /vtex/i],
  ["loja integrada", /lojaintegrada/i],
  ["tray", /tray\.com\.br|traycorp/i],
];

const CONSTRUTORES = [
  ["wix", /wix\.com|wixstatic/i],
  ["wordpress", /wp-content|wordpress/i],
  ["squarespace", /squarespace/i],
  ["google sites", /sites\.google\.com/i],
  ["linktree", /linktr\.ee/i],
];

const EXTENSOES_FALSAS = /\.(png|jpe?g|gif|webp|svg|css|js)$/i;

/** Extrai e-mails de um HTML, priorizando os do mesmo domínio do site. */
export function extrairEmails(html, url) {
  const encontrados = new Set();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) encontrados.add(decodeURIComponent(m[1]));
  for (const m of html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) encontrados.add(m[0]);

  const emails = [...encontrados]
    .map((e) => e.trim().toLowerCase())
    .filter((e) => !EXTENSOES_FALSAS.test(e))
    .filter((e) => !/(example|exemplo|sentry|wixpress|seudominio|domain)\./.test(e));

  let dominio = "";
  try {
    dominio = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  return emails.sort((a, b) => Number(b.endsWith(dominio)) - Number(a.endsWith(dominio)));
}

/** Extrai número de WhatsApp de links wa.me / api.whatsapp.com. */
export function extrairWhatsapp(html) {
  const m =
    html.match(/wa\.me\/(\+?\d{10,15})/i) ||
    html.match(/api\.whatsapp\.com\/send\/?\?phone=(\+?\d{10,15})/i) ||
    html.match(/whatsapp\.com\/send\/?\?phone=(\+?\d{10,15})/i);
  return m ? normalizarTelefoneBR(m[1]) : null;
}

/**
 * Auditoria simples da presença digital a partir do HTML da página inicial.
 * Função pura para facilitar testes.
 */
export function analisarHtml(html, url) {
  const titulo = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  const descricao =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim() ?? "";
  const anos = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) =>
    Number(m[1])
  );
  const texto = html.replace(/<[^>]+>/g, " ").toLowerCase();

  return {
    https: url.startsWith("https://"),
    responsivo: /<meta[^>]+name=["']viewport["']/i.test(html),
    titulo,
    temDescricao: descricao.length > 0,
    plataformaLoja: PLATAFORMAS_LOJA.find(([, re]) => re.test(html))?.[0] ?? null,
    temLoja:
      PLATAFORMAS_LOJA.some(([, re]) => re.test(html)) ||
      /carrinho|adicionar ao carrinho|add to cart|checkout|finalizar compra/.test(texto),
    temAgendamento: /agend(e|ar|amento)\s+(online|agora|sua|seu)|calendly|doctoralia|marcar consulta/.test(texto),
    temChat: /wa\.me|api\.whatsapp|tawk\.to|jivochat|zendesk|crisp\.chat|chatbot/i.test(html),
    construtor: CONSTRUTORES.find(([, re]) => re.test(html))?.[0] ?? null,
    anoCopyright: anos.length ? Math.max(...anos) : null,
    tamanhoKb: Math.round(Buffer.byteLength(html, "utf8") / 1024),
    poucoConteudo: texto.replace(/\s+/g, " ").trim().length < 800,
  };
}

async function baixar(url) {
  const inicio = Date.now();
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const html = await resp.text();
  return { ok: resp.ok, status: resp.status, urlFinal: resp.url, html, ms: Date.now() - inicio };
}

/** Verifica de forma simples se o robots.txt bloqueia robôs genéricos na raiz do site. */
async function robotsPermite(origem) {
  try {
    const resp = await fetch(new URL("/robots.txt", origem), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return true;
    const linhas = (await resp.text()).split(/\r?\n/).map((l) => l.trim().toLowerCase());
    let paraTodos = false;
    for (const linha of linhas) {
      if (linha.startsWith("user-agent:")) paraTodos = linha.endsWith("*");
      else if (paraTodos && linha.replace(/\s/g, "") === "disallow:/") return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Visita o site da empresa (página inicial + página de contato, se precisar)
 * e devolve a auditoria e os contatos encontrados.
 */
export async function analisarSite(url) {
  if (!url) return { temSite: false };

  let alvo = url.startsWith("http") ? url : `https://${url}`;
  try {
    alvo = new URL(alvo).toString();
  } catch {
    return { temSite: false, erro: "URL inválida" };
  }

  // Sites que são só uma rede social ou link agregador contam como "sem site próprio".
  if (/instagram\.com|facebook\.com|linktr\.ee|wa\.me|ifood\.com/i.test(alvo)) {
    return { temSite: false, apenasRedeSocial: true, urlRedeSocial: alvo };
  }

  if (!(await robotsPermite(alvo))) {
    return { temSite: true, url: alvo, bloqueadoPorRobots: true };
  }

  try {
    const pagina = await baixar(alvo);
    if (!pagina.ok) return { temSite: true, url: alvo, fora: true, status: pagina.status };

    const resultado = {
      temSite: true,
      url: pagina.urlFinal,
      tempoRespostaMs: pagina.ms,
      lento: pagina.ms > 4000,
      ...analisarHtml(pagina.html, pagina.urlFinal),
      emails: extrairEmails(pagina.html, pagina.urlFinal),
      whatsapp: extrairWhatsapp(pagina.html),
    };

    if (!resultado.emails.length) {
      for (const caminho of ["/contato", "/fale-conosco", "/contact"]) {
        try {
          const contato = await baixar(new URL(caminho, pagina.urlFinal).toString());
          if (!contato.ok) continue;
          resultado.emails = extrairEmails(contato.html, pagina.urlFinal);
          resultado.whatsapp ??= extrairWhatsapp(contato.html);
          if (resultado.emails.length) break;
        } catch {}
      }
    }
    return resultado;
  } catch (e) {
    return { temSite: true, url: alvo, fora: true, erro: e.message };
  }
}
