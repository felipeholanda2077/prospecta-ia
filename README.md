# Prospecta IA

IA que **encontra empresas no Google Maps**, **analisa a presença digital** de cada uma e **envia propostas personalizadas** por e-mail e WhatsApp, oferecendo sites, lojas virtuais, sistemas de agendamento, sistemas de gestão e automação de atendimento.

**Painel online:** https://prospecta-ia-three.vercel.app (hospedado na Vercel, banco no Supabase).

```
 Google Maps          Site da empresa          Claude (IA)            Painel            E-mail / WhatsApp
┌───────────┐       ┌────────────────┐      ┌───────────────┐    ┌────────────┐     ┌─────────────────┐
│ 1. Buscar │ ───▶  │ 2. Analisar    │ ───▶ │ 3. Escrever   │ ─▶ │ VOCÊ       │ ──▶ │ 4. Enviar com   │
│ e capturar│       │ contatos e     │      │ proposta sob  │    │ aprova ou  │     │ limite diário e │
│ empresas  │       │ oportunidades  │      │ medida        │    │ descarta   │     │ descadastro     │
└───────────┘       └────────────────┘      └───────────────┘    └────────────┘     └─────────────────┘
```

## Como funciona

1. **Captura no Google Maps** — na aba **Buscar no Google Maps** do painel você digita o segmento e a cidade (ex.: "pet shop" em "Fortaleza - CE"), vê as empresas encontradas com telefone, site, avaliação e link do Maps, e escolhe quais capturar. Celulares são marcados como *WhatsApp provável*. A busca também roda sozinha para os nichos/cidades de `config/campanha.json`. Usa a **Google Places API** oficial.
2. **Análise** — visita o site de cada empresa (respeitando o `robots.txt`) e verifica: tem site? HTTPS? funciona no celular? está lento? rodapé desatualizado? tem loja virtual? tem agendamento online? tem WhatsApp? Também encontra o e-mail e o WhatsApp de contato.
3. **Oportunidades** — transforma a análise em serviços do seu catálogo, com o motivo concreto (ex.: *"loja de roupas sem loja virtual"*, *"site sem versão para celular e com rodapé de 2017"*).
4. **Proposta com IA** — o Claude escreve um e-mail e uma mensagem de WhatsApp curtos, citando o que foi observado, oferecendo um serviço principal com os preços do seu catálogo e terminando com uma pergunta simples.
5. **Aprovação (obrigatória)** — toda primeira mensagem escrita pela IA aparece na aba **Aprovar mensagens**, ao lado de uma prévia exata do que a empresa vai receber (com o rodapé). Você edita se quiser e clica em **Aprovar e enviar** ou **Não enviar**. Nenhuma primeira mensagem sai sem esse clique. Os follow-ups também pedem aprovação, a não ser que você mude `"followUp": { "aprovacaoManual": false }`.
6. **Envio** — ao aprovar, a mensagem sai na hora se estiver no horário comercial e dentro do limite diário; senão fica na fila. Nunca contata o mesmo e-mail/telefone duas vezes e respeita a lista de descadastro. No WhatsApp, sem a API oficial configurada, o botão **Abrir no WhatsApp** abre a conversa com o texto pronto no seu WhatsApp; você aperta enviar e confirma no painel.
7. **Respostas** — lê a caixa de entrada (IMAP) a cada 10 minutos e recebe as respostas do WhatsApp pelo webhook. A IA classifica cada resposta (*interessado*, *quer informações*, *sem interesse*, *pediu para sair*, *resposta automática*) e escreve uma sugestão de retorno. Quem pede para sair vai direto para a lista de supressão; quando alguém demonstra interesse, você recebe um aviso por e-mail.
8. **Follow-up** — quem não respondeu em 4 dias (configurável em `"followUp"`) recebe **um único** lembrete curto, na mesma conversa do e-mail original. Quem responde, mesmo que seja "não", nunca recebe follow-up.

## Instalação

Requisitos: Node.js 20+. Para rodar no seu computador não precisa instalar banco: sem `DATABASE_URL`, o sistema usa um Postgres embutido gravado em `data/pglite`.

```bash
npm install
```

```bash
cp .env.example .env
```

Preencha o `.env`:

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Postgres do Supabase (obrigatório na Vercel; opcional no seu computador) |
| `ANTHROPIC_API_KEY` | IA que escreve as propostas ([console.anthropic.com](https://console.anthropic.com/)) |
| `GOOGLE_PLACES_API_KEY` | Busca de empresas — ative a **Places API (New)** no Google Cloud |
| `SMTP_*`, `EMAIL_REMETENTE` | Conta de e-mail que envia as propostas |
| `IMAP_*` | Leitura das respostas (normalmente a mesma conta do SMTP) |
| `NOTIFICAR_EMAIL` | Seu e-mail, para ser avisado quando alguém se interessar |
| `MODO_TESTE_EMAIL` | Opcional: manda tudo para você em vez das empresas (veja abaixo) |
| `PAINEL_SENHA` | Senha do painel web |
| `URL_PUBLICA` | Endereço público do painel (vai no link de descadastro dos e-mails) |
| `CICLO_CRON` | Opcional, fora da Vercel: roda o ciclo sozinho, ex. `30 9 * * 1-5` |

Depois edite **`config/campanha.json`** com os dados da sua empresa, seu catálogo de serviços e preços, os nichos e cidades que quer prospectar e os limites de envio.

## Uso

Painel web (buscar no Google Maps, aprovar propostas, acompanhar envios e respostas):

```bash
npm start
```

Abra http://localhost:3000 e entre com o usuário `admin` e a senha do `.env`.

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

Também existem `npm run respostas` (lê a caixa de entrada agora) e `npm run followup` (gera os lembretes). `npm run stats` mostra os números do funil e `npm test` roda os testes.

### Modo teste (faça isto antes de ligar de verdade)

Com `MODO_TESTE_EMAIL=seu@email.com` no `.env`, **todas** as mensagens vão para você, com o assunto `[TESTE → empresa@real.com] ...`. Nada chega às empresas. Responda esses e-mails para ver a classificação da IA e o aviso de interesse funcionando. O mesmo vale para `MODO_TESTE_WHATSAPP`.

Use um banco separado durante o teste, porque as empresas testadas ficam marcadas como contatadas:

```bash
DB_PATH=data/teste MODO_TESTE_EMAIL=seu@email.com npm run ciclo
```

Quando estiver satisfeito com o tom das propostas, apague o `MODO_TESTE_EMAIL` e use o banco normal.

### Modo automático

Na Vercel, o ciclo roda sozinho de segunda a sexta às 9h30 e as respostas por e-mail são lidas todo dia às 19h (horários em `vercel.json`, em UTC). Fora da Vercel, use `CICLO_CRON` com `npm start` rodando. O ciclo lê as respostas, busca as empresas da campanha, analisa os sites e deixa as propostas **esperando sua aprovação**; só envia o que você já aprovou.

## Publicar na Vercel

O projeto `prospecta-ia` já está criado na sua conta pessoal da Vercel e publicado em https://prospecta-ia-three.vercel.app. Falta só configurar as variáveis. Em **Vercel → prospecta-ia → Settings → Environment Variables** (ambiente *Production*), cadastre:

| Variável | Obrigatória | Onde conseguir |
|---|---|---|
| `DATABASE_URL` | sim | Supabase → projeto `prospecta-ia` → **Connect** → *Transaction pooler* (porta 6543), trocando `[YOUR-PASSWORD]` pela senha do banco |
| `PAINEL_SENHA` | sim | Uma senha forte que você escolher para entrar no painel |
| `ANTHROPIC_API_KEY` | sim | [console.anthropic.com](https://console.anthropic.com/) |
| `GOOGLE_PLACES_API_KEY` | sim | Google Cloud → APIs → **Places API (New)** |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_REMETENTE` | para enviar e-mail | Seu provedor de e-mail |
| `IMAP_HOST` (+ `IMAP_USER`/`IMAP_PASS` se diferentes) | para ler respostas | Seu provedor de e-mail |
| `NOTIFICAR_EMAIL`, `EMAIL_DESCADASTRO` | recomendadas | Seus e-mails |
| `URL_PUBLICA`, `CRON_SECRET` | já configuradas | — |

Também dá para cadastrar pelo terminal, uma por vez (o valor é pedido de forma interativa):

```bash
vercel env add PAINEL_SENHA production
```

Depois de cadastrar, publique de novo para valer:

```bash
vercel deploy --prod
```

As tabelas são criadas sozinhas na primeira vez que o sistema conecta no banco. O plano gratuito (Hobby) da Vercel permite as duas rotinas diárias; cada execução tem no máximo 5 minutos, então as etapas longas param e continuam na próxima (no painel, os botões repetem sozinhos até acabar a fila).

## WhatsApp

O WhatsApp funciona de dois jeitos:

- **Manual (padrão)** — a IA escreve a mensagem, você revisa no painel e clica em **Abrir no WhatsApp**: abre a conversa no seu WhatsApp (Web ou celular) com o texto pronto. Você aperta enviar e confirma no painel. Não precisa de API nem de aprovação da Meta, e como é você quem envia, uma a uma, o risco de bloqueio do número é baixo. As respostas chegam no seu WhatsApp; marque no painel quem respondeu.
- **Automático (API oficial da Meta)** — o envio sai direto do sistema ao aprovar. Exige a WhatsApp Cloud API.

Bibliotecas não oficiais como open-wa, whatsapp-web.js ou Baileys não são usadas de propósito: disparo para números que não conhecem você por essas bibliotecas viola os termos do WhatsApp e o número costuma ser banido em poucos dias.

Para ativar o modo automático:

1. Crie um app no [Meta for Developers](https://developers.facebook.com/) com o produto WhatsApp e pegue o `WHATSAPP_TOKEN` e o `WHATSAPP_PHONE_NUMBER_ID`.
2. Crie e aprove um template de categoria **Marketing** chamado `proposta_inicial` (ou o nome em `WHATSAPP_TEMPLATE`) com duas variáveis, por exemplo:
   > Olá, {{1}}! {{2}} Se preferir não receber mensagens, responda SAIR.
3. Coloque `WHATSAPP_ATIVO=true`.
4. Para receber as respostas: no app da Meta, em WhatsApp → Configuração → Webhook, cadastre a URL `https://SEU_DOMINIO/webhooks/whatsapp`, use o mesmo valor de `WHATSAPP_VERIFY_TOKEN` como token de verificação e assine o campo `messages`. Preencha `WHATSAPP_APP_SECRET` com a "chave secreta do app" (Configurações → Básico); sem ela o webhook recusa tudo, porque é assim que ele sabe que a mensagem veio mesmo da Meta.

Atenção: a política da Meta exige que o contato tenha dado consentimento (opt-in) para receber mensagens de marketing da sua empresa. Para prospecção fria de quem nunca falou com você, use o **e-mail** como primeiro contato e deixe o WhatsApp para quem responder.

## Rodar num servidor (Docker)

Para o modo automático ele precisa ficar ligado o tempo todo, então o ideal é uma VPS. Com Docker instalado no servidor:

```bash
docker compose up -d --build
```

Sem `DATABASE_URL`, o banco fica em `./data` e a campanha em `./config` (pode editar sem reconstruir; reinicie com `docker compose restart`). Coloque o painel atrás de HTTPS (ex.: Caddy ou Nginx) e use esse endereço em `URL_PUBLICA`: o link de descadastro e o webhook do WhatsApp precisam ser acessíveis pela internet.

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
src/ia/                     Claude: propostas, follow-ups e classificação das respostas
src/envio/                  e-mail (SMTP) e WhatsApp (Cloud API)
src/respostas/              leitura da caixa de entrada (IMAP), webhook do WhatsApp e ações
src/pipeline.js             as etapas do funil
src/app.js                  API do painel, login, descadastro, webhook e cron
src/servidor.js             execução local/Docker (serve o painel e agenda)
api/index.js + vercel.json  execução na Vercel
src/db.js, src/schema.js    banco Postgres (Supabase ou embutido)
src/cli.js                  comandos de terminal
public/index.html           painel web
data/                       banco embutido local (não vai para o git)
```
