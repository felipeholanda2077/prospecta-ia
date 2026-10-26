#!/bin/sh
# Cadastra na Vercel as variáveis obrigatórias e publica o sistema.
# Cada valor é colado por você no terminal: nada fica salvo no código nem no Git.
# Uso (na pasta do projeto): sh scripts/configurar-vercel.sh
set -e

ESCOPO=felipeholanda2077s-projects
OBRIGATORIAS="PAINEL_SENHA ANTHROPIC_API_KEY DATABASE_URL GOOGLE_PLACES_API_KEY"

existentes=$(vercel env ls production --scope "$ESCOPO" 2>/dev/null || true)

for VAR in $OBRIGATORIAS; do
  if printf '%s\n' "$existentes" | grep -q "^ *$VAR "; then
    echo "✓ $VAR já está cadastrada (para trocar: vercel env rm $VAR production --scope $ESCOPO)"
    continue
  fi
  echo ""
  case "$VAR" in
    PAINEL_SENHA)          echo ">>> PAINEL_SENHA: a senha para entrar no painel" ;;
    ANTHROPIC_API_KEY)     echo ">>> ANTHROPIC_API_KEY: a chave da Anthropic (começa com sk-ant-)" ;;
    DATABASE_URL)          echo ">>> DATABASE_URL: Supabase > Connect > Transaction pooler (porta 6543), com a senha do banco no lugar de [YOUR-PASSWORD]" ;;
    GOOGLE_PLACES_API_KEY) echo ">>> GOOGLE_PLACES_API_KEY: a chave do Google Cloud com a Places API (New) ativada" ;;
  esac
  vercel env add "$VAR" production --scope "$ESCOPO"
done

echo ""
echo ">>> Publicando com as variáveis novas..."
vercel deploy --prod --yes --scope "$ESCOPO"
echo ""
echo "Pronto! Abra https://prospecta-ia-three.vercel.app"
