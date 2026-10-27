import { createRemoteJWKSet, jwtVerify } from "jose";

// Autenticação do agendamento sem segredo compartilhado: o GitHub Actions emite um
// token OIDC assinado para cada execução, e conferimos a assinatura com as chaves
// públicas do GitHub. Referência:
// https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
const EMISSOR = "https://token.actions.githubusercontent.com";
export const AUDIENCIA = "prospecta-ia";
const REPOSITORIO = process.env.GITHUB_REPOSITORIO || "felipeholanda2077/prospecta-ia";
const WORKFLOW = `${REPOSITORIO}/.github/workflows/envios.yml@refs/heads/main`;
const EVENTOS = ["schedule", "workflow_dispatch"];

let chaves;

/**
 * Só aceita o token se ele foi emitido pelo GitHub para o workflow de envios deste
 * repositório, na branch main, disparado pelo agendamento ou manualmente. Cópias do
 * repositório (forks) recebem tokens com outro `repository` e são recusadas.
 */
export function conferirClaims(claims) {
  return (
    claims.repository === REPOSITORIO &&
    claims.ref === "refs/heads/main" &&
    claims.workflow_ref === WORKFLOW &&
    EVENTOS.includes(claims.event_name)
  );
}

export async function tokenDoGithubValido(token) {
  if (!token || token.split(".").length !== 3) return false;
  chaves ??= createRemoteJWKSet(new URL(`${EMISSOR}/.well-known/jwks`));
  try {
    const { payload } = await jwtVerify(token, chaves, { issuer: EMISSOR, audience: AUDIENCIA });
    return conferirClaims(payload);
  } catch {
    return false;
  }
}
