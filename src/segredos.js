import crypto from "node:crypto";
import { config } from "./config.js";

// Guarda segredos criptografados no banco (AES-256-GCM). A chave vem da senha do painel, que fica só nas
// variáveis de ambiente: quem lê o banco não consegue usar os tokens. Trocar a senha obriga a conectar de novo.
const chave = () => crypto.hkdfSync("sha256", config.painel.senha, "prospecta-segredos", "tokens-de-integracao", 32);

export function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(chave()), iv);
  const dados = Buffer.concat([c.update(String(texto), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), dados].map((b) => b.toString("base64")).join(".");
}

/** O texto original, ou null se não der para abrir (a senha do painel mudou). */
export function decifrar(guardado) {
  try {
    const [iv, tag, dados] = String(guardado).split(".").map((p) => Buffer.from(p, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(chave()), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(dados), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
