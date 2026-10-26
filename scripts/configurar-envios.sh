#!/bin/sh
# Liga a rodada de envios em horário comercial (GitHub Actions a cada 20 minutos).
# Gera um segredo novo e salva o MESMO valor na Vercel (CRON_SECRET) e no GitHub,
# sem mostrar na tela. Uso (na pasta do projeto): sh scripts/configurar-envios.sh
set -e

ESCOPO=felipeholanda2077s-projects
REPO=felipeholanda2077/prospecta-ia

SEGREDO=$(openssl rand -hex 32)

echo ">>> Salvando CRON_SECRET na Vercel..."
vercel env rm CRON_SECRET production --scope "$ESCOPO" -y >/dev/null 2>&1 || true
printf '%s' "$SEGREDO" | vercel env add CRON_SECRET production --scope "$ESCOPO" --sensitive

echo ">>> Salvando CRON_SECRET no GitHub (usado pelo agendamento)..."
printf '%s' "$SEGREDO" | gh secret set CRON_SECRET --repo "$REPO"
unset SEGREDO

echo ">>> Publicando para a Vercel usar o segredo novo..."
vercel deploy --prod --yes --scope "$ESCOPO"

echo ">>> Ligando o agendamento e testando uma rodada agora..."
gh workflow enable envios.yml --repo "$REPO"
gh workflow run envios.yml --repo "$REPO"
echo ""
echo "Pronto! A rodada roda a cada 20 minutos, de segunda a sexta, das 9h às 18h."
