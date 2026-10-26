# Prospecta IA

IA que **encontra empresas na internet**, **analisa a presença digital** de cada uma e **envia propostas personalizadas** de sites, lojas virtuais, sistemas de agendamento, sistemas de gestão e automação de atendimento.

```
 Google Maps          Site da empresa          Claude (IA)            Painel            E-mail / WhatsApp
┌───────────┐       ┌────────────────┐      ┌───────────────┐    ┌────────────┐     ┌─────────────────┐
│ 1. Buscar │ ───▶  │ 2. Analisar    │ ───▶ │ 3. Escrever   │ ─▶ │ Aprovar /  │ ──▶ │ 4. Enviar com   │
│ empresas  │       │ contatos e     │      │ proposta sob  │    │ editar     │     │ limite diário e │
│ por nicho │       │ oportunidades  │      │ medida        │    │ (opcional) │     │ descadastro     │
└───────────┘       └────────────────┘      └───────────────┘    └────────────┘     └─────────────────┘
```

## Como funciona

1. **Descoberta** — para cada nicho e cidade em `config/campanha.json` (ex.: "clínica odontológica em Fortaleza - CE"), busca empresas na **Google Places API** oficial: nome, telefone, site, avaliação.
2. **Análise** — visita o site de cada empresa (respeitando o `robots.txt`) e verifica: tem site? HTTPS? funciona no celular? está lento? rodapé desatualizado? tem loja virtual? tem agendamento online? tem WhatsApp? Também encontra o e-mail e o WhatsApp de contato.
3. **Oportunidades** — transforma a análise em serviços do seu catálogo, com o motivo concreto (ex.: *"loja de roupas sem loja virtual"*, *"site sem versão para celular e com rodapé de 2017"*).
4. **Proposta com IA** — o Claude escreve um e-mail e uma mensagem de WhatsApp curtos, citando o que foi observado, oferecendo um serviço principal com os preços do seu catálogo e terminando com uma pergunta simples.
5. **Aprovação** — por padrão as propostas ficam como rascunho no painel para você revisar, editar e aprovar. Dá para desligar (`"aprovacaoManual": false`) e deixar 100% automático.
6. **Envio** — envia somente em horário comercial, com limite diário e intervalo entre mensagens, nunca contata o mesmo e-mail/telefone duas vezes e respeita a lista de descadastro.

## Instalação

Requisitos: Node.js 20+.

```bash
npm install
```

```bash
cp .env.example .env
```

Preencha o `.env`:

| Variável | Para quê |
|---|---|
| `ANTHROPIC_API_KEY` | IA que escreve as propostas ([console.anthropic.com](https://console.anthropic.com/)) |
| `GOOGLE_PLACES_API_KEY` | Busca de empresas — ative a **Places API (New)** no Google Cloud |
| `SMTP_*`, `EMAIL_REMETENTE` | Conta de e-mail que envia as propostas |
| `PAINEL_SENHA` | Senha do painel web |
| `URL_PUBLICA` | Endereço público do painel (vai no link de descadastro dos e-mails) |
| `CICLO_CRON` | Opcional: roda o ciclo sozinho, ex. `30 9 * * 1-5` |

Depois edite **`config/campanha.json`** com os dados da sua empresa, seu catálogo de serviços e preços, os nichos e cidades que quer prospectar e os limites de envio.

## Uso

Painel web (aprovar propostas, acompanhar envios, marcar quem respondeu):

```bash
npm start
```

Abra http://localhost:3000 (usuário `admin` e a senha do `.env`).

Ou pelo terminal, etapa por etapa:

```bash
npm run descobrir
```

```bash
npm run analisar
```

```bash
npm run propor
```

```bash
npm run enviar
```

Ou tudo de uma vez:

```bash
npm run ciclo
```

`npm run stats` mostra os números do funil e `npm test` roda os testes.

### Modo automático

Com `CICLO_CRON` preenchido e `npm start` rodando (num servidor/VPS), o sistema busca, analisa, gera e envia sozinho no horário definido. Para o envio sair sem revisão, coloque `"aprovacaoManual": false` na campanha. Recomendo começar com aprovação manual nas primeiras semanas para calibrar o tom das mensagens.

## WhatsApp

O envio por WhatsApp usa a **API oficial (WhatsApp Cloud API da Meta)** e vem desligado (`WHATSAPP_ATIVO=false`). Bibliotecas não oficiais como open-wa, whatsapp-web.js ou Baileys não são usadas de propósito: disparo para números que não conhecem você por essas bibliotecas viola os termos do WhatsApp e o número costuma ser banido em poucos dias.

Para ativar:

1. Crie um app no [Meta for Developers](https://developers.facebook.com/) com o produto WhatsApp e pegue o `WHATSAPP_TOKEN` e o `WHATSAPP_PHONE_NUMBER_ID`.
2. Crie e aprove um template de categoria **Marketing** chamado `proposta_inicial` (ou o nome em `WHATSAPP_TEMPLATE`) com duas variáveis, por exemplo:
   > Olá, {{1}}! {{2}} Se preferir não receber mensagens, responda SAIR.
3. Coloque `WHATSAPP_ATIVO=true`.

Atenção: a política da Meta exige que o contato tenha dado consentimento (opt-in) para receber mensagens de marketing da sua empresa. Para prospecção fria de quem nunca falou com você, use o **e-mail** como primeiro contato e deixe o WhatsApp para quem responder.

## Boas práticas e LGPD

O sistema já vem com as proteções abaixo. Mantenha-as ligadas:

- **Só dados públicos de empresas** (Google Maps e o próprio site da empresa). Nada de comprar listas.
- **Descadastro em toda mensagem**: link no rodapé + cabeçalho `List-Unsubscribe` (botão "cancelar inscrição" do Gmail/Outlook). Quem sai entra numa lista de supressão permanente.
- **Uma proposta por contato**: o mesmo e-mail/telefone nunca recebe duas abordagens.
- **Volume baixo e espaçado**: limite diário (padrão 30) e 90 s entre envios. Volume alto queima o domínio e manda tudo para o spam.
- **Mensagens verdadeiras**: a IA é instruída a citar só o que foi observado, sem urgência falsa nem promessas de resultado.

Para entregar bem os e-mails, configure **SPF, DKIM e DMARC** no domínio do remetente e, de preferência, use um subdomínio ou domínio separado para prospecção. Quando alguém responder pedindo para não ser contatado, use o botão "Pediu para não receber" no painel.

## Estrutura

```
config/campanha.json        empresa, catálogo de serviços, nichos/cidades, limites
src/descoberta/             busca de empresas (Google Places API)
src/analise/                auditoria do site, contatos e oportunidades
src/ia/proposta.js          geração da proposta com Claude
src/envio/                  e-mail (SMTP) e WhatsApp (Cloud API)
src/pipeline.js             as 4 etapas do funil
src/servidor.js             painel, API, descadastro e agendamento
src/cli.js                  comandos de terminal
public/index.html           painel web
data/                       banco SQLite (não vai para o git)
```
