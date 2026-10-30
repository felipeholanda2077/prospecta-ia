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
   **Busca pelo CNPJ (grátis, sem chave)** — na mesma aba, em "Onde buscar", escolha **CNPJ (Receita Federal)**. A IA acha a atividade (CNAE) do segmento na tabela do IBGE, guardada em `config/cnae.json` (ou você informa o código), e o sistema traz as empresas ativas da cidade pelos dados abertos do CNPJ: a [Casa dos Dados](https://casadosdados.com.br) acha os CNPJs (20 por consulta; as próximas vêm sem os já capturados) e a [Minha Receita](https://minhareceita.org) traz o telefone e o e-mail do cadastro. A busca deixa de fora as empresas abertas nos últimos 30 dias, que ainda não estão na base com telefone e e-mail; o contato que faltar vem da [API aberta da CNPJá](https://cnpja.com/api/open), no máximo uma consulta a cada 12 s (o limite dela é 5 por minuto), e o que não couber é buscado de novo na análise. Se a Minha Receita recusar o acesso, a consulta vai para a [BrasilAPI](https://brasilapi.com.br), com os mesmos dados. Por padrão fica sem MEI, e dá para pegar só as abertas no último ano ou nos últimos 90 dias (costumam ainda não ter site). Telefone e e-mail de contador ficam de fora: e-mail de contabilidade e telefone que se repete em empresas diferentes. Em **Automação**, a busca automática também procura pelo CNPJ.
2. **Análise** — visita o site de cada empresa (respeitando o `robots.txt`) e verifica: tem site? HTTPS? funciona no celular? está lento? rodapé desatualizado? tem loja virtual? tem agendamento online? tem WhatsApp? Também encontra o e-mail e o WhatsApp de contato.
3. **Oportunidades** — transforma a análise em serviços do seu catálogo, com o motivo concreto (ex.: *"loja de roupas sem loja virtual"*, *"site sem versão para celular e com rodapé de 2017"*).
4. **Sequência gradual com IA** — em vez de uma proposta direta, o Claude escreve 3 mensagens curtas por canal, que revelam a informação aos poucos:
   1. **Primeiro contato:** cumprimenta, cita algo positivo da empresa e faz uma pergunta leve. Sem preço, sem lista de serviços.
   2. **Se não responder (WhatsApp: cerca de 2 horas depois, no mesmo dia; e-mail: 1 dia útil depois):** traz uma observação concreta e o impacto para o negócio. Ainda sem preço.
   3. **Último toque (WhatsApp: cerca de 2 horas depois da etapa 2; e-mail: 2 dias úteis depois):** convida para um bate-papo de 15 minutos com o link de agendamento, sem preço.

   Quando a empresa responde, a sequência para na hora.
5. **Aprovação (obrigatória)** — cada sequência aparece na aba **Aprovar mensagens**, com as 3 etapas editáveis e a prévia exata do que a empresa vai receber. Você clica em **Aprovar sequência** ou **Não enviar**. Nada sai sem esse clique.
6. **Envio só em horário comercial** — de segunda a sexta, das 9h às 18h (Brasília), uma rodada de envios roda a cada 20 minutos e envia as etapas aprovadas que já chegaram no dia, com intervalo entre elas e limite diário. Fora desse horário nada é enviado (a regra está no próprio código, não só no agendamento). Nunca contata o mesmo e-mail/telefone duas vezes e respeita a lista de descadastro.
7. **Conversa conduzida pela IA** — as respostas chegam pelo e-mail (IMAP) e pelo WhatsApp (UAZap ou Evolution API). A IA lê a conversa inteira, classifica a resposta (*interessado*, *quer informações*, *sem interesse*, *pediu para sair*, *resposta automática*) e escreve a **próxima mensagem**: responde o que foi perguntado, entrega uma informação nova por vez e só fala de preço quando perguntam. Você revisa e clica em **Enviar resposta**. Quem pede para sair vai direto para a lista de supressão; interessados geram aviso no seu e-mail.

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
| `ANTHROPIC_API_KEY` | IA que escreve as propostas e responde as conversas ([console.anthropic.com](https://console.anthropic.com/)). Usa o Claude Haiku 5.5, o modelo mais barato; para trocar, defina `CLAUDE_MODEL` |
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

Também existem `npm run respostas` (lê a caixa de entrada agora) e `npm run envios` (a rodada do horário comercial: lê respostas e envia a fila). `npm run stats` mostra os números do funil e `npm test` roda os testes.

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

Para ligar a rodada de envios do horário comercial (a cada 20 minutos, pelo GitHub Actions, porque o plano gratuito da Vercel só agenda uma vez por dia), rode uma vez:

```bash
sh scripts/configurar-envios.sh
```

Ele gera um segredo, salva o mesmo valor na Vercel e no GitHub e publica. Depois de cadastrar variáveis, publique de novo para valer:

```bash
vercel deploy --prod
```

As tabelas são criadas sozinhas na primeira vez que o sistema conecta no banco. O plano gratuito (Hobby) da Vercel permite as duas rotinas diárias; cada execução tem no máximo 5 minutos, então as etapas longas param e continuam na próxima (no painel, os botões repetem sozinhos até acabar a fila).

## WhatsApp

O WhatsApp funciona de três jeitos:

- **UAZap (recomendado para automatizar)** — em **Configurações → Números de WhatsApp pela UAZap**, adicione cada número com um *nome*, a *Server URL* e o *token da instância* (cada número é uma instância na UAZap) e clique em **Adicionar e configurar webhook**. O sistema testa a conexão antes de salvar e aponta o webhook da instância para cá. Depois clique em **QR code** no número e leia o código no celular (WhatsApp → Aparelhos conectados). Com vários números, a IA prospecta e conversa por todos: cada empresa fica sempre no número que falou com ela, as empresas novas vão para o número com mais folga no dia, e a meta diária de WhatsApp (e o aquecimento) vale por número. Se um número cair, as conversas dele esperam na fila até ele voltar. A UAZap usa o WhatsApp Web, que não é a API oficial: por isso o sistema mantém volume baixo, intervalo entre envios, só horário comercial e opção de sair em toda sequência.
- **Áudios** — quando a empresa responde com áudio pela Evolution, o sistema transcreve e a IA responde por texto. Cadastre `GROQ_API_KEY` (plano grátis em console.groq.com) ou `OPENAI_API_KEY` na Vercel. Sem a chave, ou se o áudio não puder ser transcrito, a conversa fica marcada como "Precisa de você".
- **Evolution API (alternativa à UAZap)** — em **Configurações → WhatsApp pela Evolution API**, cole a *Server URL*, o *nome da instância* e a *API key* e clique em **Salvar e configurar webhook**. Se a instância não existir, o sistema cria (use a API key global do servidor). Depois conecte com QR code ou código. Com a UAZap e a Evolution configuradas, o WhatsApp sai pela que estiver conectada; se as duas estiverem, pela UAZap.
- **Manual (padrão)** — a IA escreve a mensagem, você revisa no painel e clica em **Abrir no WhatsApp**: abre a conversa no seu WhatsApp (Web ou celular) com o texto pronto. Você aperta enviar e confirma no painel. Não precisa de API nem de aprovação da Meta, e como é você quem envia, uma a uma, o risco de bloqueio do número é baixo. As respostas chegam no seu WhatsApp; marque no painel quem respondeu.
- **API oficial da Meta (WhatsApp Cloud API)** — configurada em **Configurações → WhatsApp oficial da Meta**. Quando ligada, tem prioridade sobre a UAZap e a Evolution.

Bibliotecas não oficiais como open-wa, whatsapp-web.js ou Baileys não são usadas de propósito: disparo para números que não conhecem você por essas bibliotecas viola os termos do WhatsApp e o número costuma ser banido em poucos dias.

Para usar a API oficial:

1. Crie um app no [Meta for Developers](https://developers.facebook.com/) com o produto WhatsApp. Em WhatsApp → Configuração da API, copie o **ID do número de telefone**.
2. Gere um **token permanente** em business.facebook.com → Usuários do sistema, com `whatsapp_business_messaging` e `whatsapp_business_management` (o token temporário da Configuração da API vence em 24 h).
3. Crie e aprove um template chamado `proposta_inicial` (ou outro nome) com duas variáveis, por exemplo:
   > Olá, {{1}}! {{2}} Se preferir não receber mensagens, responda SAIR.
4. Em **Configurações → WhatsApp oficial da Meta**, preencha o ID do número, o token, o nome e o idioma do template e a **chave secreta do app** (Configurações do app → Básico), ligue **Enviar o WhatsApp pela API oficial** e clique em **Salvar e testar com a Meta**. O sistema confere o token e o número com a Meta antes de salvar e mostra se o template está aprovado.
5. Para receber as respostas: o cartão mostra a **URL de callback** e o **token de verificação** gerado pelo sistema. Cole os dois no app da Meta em WhatsApp → Configuração → Webhook e assine o campo `messages`.

As variáveis `WHATSAPP_*` do `.env` continuam funcionando e têm prioridade sobre o que foi salvo no painel.

Atenção: a política da Meta exige que o contato tenha dado consentimento (opt-in) para receber mensagens de marketing da sua empresa. Para prospecção fria de quem nunca falou com você, use o **e-mail** como primeiro contato e deixe o WhatsApp para quem responder.

## Contratos

A página **Contratos** do painel guarda o modelo e o contrato de cada cliente:

- **Modelo:** o texto de onde nasce cada contrato, editável (com prévia ao lado). O original fica em `config/contrato-modelo.md`, sem dados pessoais, porque o repositório é público. Mudar o modelo não altera os contratos já criados.
- **Seus dados:** nome, CNPJ, CPF, marca, e-mail, chave PIX e foro padrão. Ficam só no banco e entram sozinhos em todos os contratos, inclusive nos já criados.
- **Quando o cliente aceita:** o botão **Cliente aceitou: gerar contrato** (na conversa ou na lista de empresas) abre o formulário já com os dados da empresa. Ao gerar, a empresa passa a **Cliente fechado**, as mensagens de prospecção na fila são canceladas e, se o cliente escrever, a IA não vende nada e passa a conversa para você. O **Novo contrato** cria um contrato para quem não veio de uma conversa.
- **Pagamento por contrato:** por mês (valor, meses de vigência e data do primeiro pagamento) ou entrada e saldo. O resumo, o valor total por extenso, a tabela de parcelas e a cláusula de rescisão saem de acordo.
- **Cada contrato** pode ser editado à vontade, com situação (rascunho, enviado, assinado, cancelado) e **Baixar PDF**, pronto para assinar pelo gov.br.

## Formulário do site

O sistema tem um formulário de contato pronto, com link próprio: `https://SEU-SISTEMA/contato`. Quem preenche (nome, empresa, WhatsApp, e-mail, do que precisa e uma mensagem, com o aceite de contato) vira uma empresa já em conversa, você recebe um aviso por e-mail e a IA chama no WhatsApp em alguns minutos, em horário comercial (ou responde por e-mail, se a pessoa não deixou WhatsApp). Se o WhatsApp ou o e-mail já forem de uma empresa do sistema, entra na conversa dela.

Em **Configurações → Formulário do site** estão:
- o link para o botão de contato do site (`?origem=site`) e para a bio do Instagram (`?origem=instagram`), para saber de onde veio cada contato;
- o código de um `<iframe>` para colocar o formulário dentro de uma página do site (`?embed=1` deixa sem fundo);
- a opção **A IA chama sozinha quem preencher** (vale mesmo com a resposta automática desligada para as outras conversas) e os últimos contatos.

O site também pode mandar o próprio formulário para `POST /contato` (JSON, de qualquer domínio) com os campos `nome`, `empresa`, `whatsapp`, `email`, `servico`, `mensagem`, `origem` e `consentimento: true`. Contra robôs: campo escondido (`site`), tempo mínimo de preenchimento (`t`, o horário em que a página abriu), um envio a cada 20 s por IP e a mesma pessoa só uma vez a cada 10 minutos.

## Variedade e fotos nos posts

Cada post novo nasce com um público (clínica, restaurante, loja...), um tom (provocador, história, conta simples...) e um estilo visual (foto de fundo, foto no topo, fundo claro, fundo colorido ou fundo escuro), sempre fora dos usados nos últimos posts. Se o gancho sair parecido com o de um post recente, a IA escreve outro.

- **Fotos reais:** a IA descreve a cena de cada tela e o sistema busca a foto. Com a chave grátis do [Pexels](https://www.pexels.com/api/) (em **Instagram → Configurações** ou `PEXELS_API_KEY`), vêm fotos profissionais. Sem ela, vêm do Wikimedia Commons, só com licença que permite o uso, e o crédito exigido entra na legenda. Foto que não for achada só fica de fora.
- **Elementos visuais:** ilustrações animadas nas telas sem foto (celular, site, gráfico, agenda, estrelas, notificações).
- **Felipe nos vídeos:** em um Reels sim, um não, a foto dele aparece com o nome, e as falas são em primeira pessoa. Dá para desligar em **Instagram → Configurações**.
- **Avatar de IA (opcional, pago):** com uma conta no HeyGen, em **Instagram → Configurações → Avatar de IA do Felipe**, o avatar fala na capa e na chamada final desses Reels (cerca de 10 segundos por vídeo). Os clipes são pedidos quando o post é criado e entram na hora de gerar o vídeo; se algum falhar ou não estiver pronto, aquela tela sai com a foto. A legenda avisa que o avatar é gerado com IA, e a marcação de IA do Instagram precisa ser feita à mão.

## Fornecedores de dropshipping

A página **Fornecedores** procura quem envia direto ao cliente do lojista, por segmento e região. Fica separada das empresas: ninguém aqui recebe mensagem automática.

- **Fontes:** a lista inicial (`config/fornecedores-dropshipping.json`, com sites conferidos), o Google Maps, atacadistas pelo CNPJ (com segmento e cidade) e, se marcar, o Instagram.
- **Confirmação:** o sistema lê o site de cada um. Só aparece "Faz dropshipping" quando o texto do site comprova, e o trecho fica no cartão. O resto é "Possível, confirmar". Curso, blog e loja comum ficam de fora.
- **Depois:** salve os que interessarem e marque como contatado, aprovado ou descartado, com anotações. O contato sai pela sua mão, pelos botões do cartão.

## LinkedIn

Os mesmos posts do Instagram saem na página da empresa no LinkedIn, nos mesmos horários, numa execução separada (um erro em uma rede não atrapalha a outra):

- **Formato:** o Reels sai como vídeo vertical e o carrossel como documento em PDF, de passar as páginas (a API do LinkedIn só tem carrossel de verdade para anúncios).
- **Público:** a IA reescreve o texto para donos e gestores de empresa e troca a última tela por uma chamada que faz sentido lá. O resto do post é o mesmo.
- **Conexão:** em **Redes sociais → Configurações → Página do LinkedIn**, com um app próprio aprovado no produto *Community Management API*. O acesso vale 60 dias: renova sozinho quando o LinkedIn libera a renovação para o app; senão, o sistema avisa por e-mail 10 dias antes para entrar de novo.

## Insights do Instagram

Em **Conteúdo → Desempenho no Instagram** aparecem os números do perfil: seguidores (e o ganho na semana), alcance médio, engajamento e, post a post, alcance, curtidas, comentários, salvamentos e compartilhamentos (e o tempo médio assistido nos Reels). Os posts feitos fora do sistema também entram. O sistema lê os insights sozinho a cada 6 horas (ou no botão **Atualizar agora**), pelo mesmo token dos posts, que precisa de `instagram_manage_insights`.

Cada post ganha uma **nota** comparada à média do próprio perfil (1 = na média, 2 = o dobro): 60% engajamento, em que salvar e compartilhar pesam mais que curtir, e 40% alcance. Só os posts com mais de 24 h no ar entram na comparação.

Com 6 posts ou mais, a IA aprende com os números:
- uma vez por dia ela escreve **o que fazer mais e o que evitar** (formato, assunto, jeito do gancho, estrutura), que aparece no painel e vai no pedido de cada post novo, junto com os ganchos dos posts que mais deram certo;
- o assunto, a estrutura do roteiro e o formato que performam melhor ganham mais vez no sorteio do próximo post (sem repetir os dois últimos). Um em cada quatro posts segue o rodízio normal, para os assuntos ainda pouco testados continuarem aparecendo.

## Direct do Instagram

Com o Instagram conectado em **Conteúdo**, a IA também conversa pelo direct da conta, pela API oficial da Meta:

- **Responde quem chama no direct**, a qualquer hora, alguns minutos depois, como nas conversas do WhatsApp (apresenta a empresa, tira dúvidas e leva para o agendamento). Quem chama vira um lead com o nome e o @ do perfil; se o @ for de uma empresa já prospectada, a conversa entra nela.
- **Chama no direct quem comenta nos posts**: a IA lê cada comentário e, se a pessoa pediu o que o post prometeu ("Comenta SITE que eu te mando..."), perguntou algo ou mostrou interesse, manda a mensagem privada com o conteúdo prometido e responde o comentário avisando. Elogio solto, emoji e marcação de amigo ficam sem direct.
- As conversas aparecem em **Respostas**, junto com as do WhatsApp e do e-mail.

Limites da Meta: só dá para responder quem escreveu primeiro (até 24 h depois da última mensagem da pessoa) e mandar uma mensagem privada por comentário (até 7 dias depois). A API não manda o primeiro direct para quem nunca falou com a conta.

**Prospecção pelo direct, enviada por você.** Empresas encontradas sem WhatsApp nem e-mail, mas com Instagram, não são mais descartadas: a IA escreve um direct curto e personalizado (pelo perfil e pela bio), que aparece em Aprovar mensagens e na Fila com o botão **Abrir direct**. Ele copia a mensagem e abre a conversa com a empresa no Instagram; você cola, envia e confirma no painel. Quando a empresa responder, a IA continua a conversa pelo direct. O painel mostra quantos directs saíram no dia e avisa a partir de 25, porque mais que isso o Instagram costuma limitar a conta. A fila guarda no máximo 50 directs esperando; as outras empresas esperam a fila andar.

Para ligar:
1. Gere o token como para os posts, acrescentando `instagram_manage_messages`, `instagram_manage_comments` e `pages_manage_metadata`, e conecte de novo em **Conteúdo → Instagram**.
2. No app da Meta → Webhooks → **Instagram**, cole a URL de callback e o token de verificação que aparecem no cartão **Direct do Instagram** e assine `messages` e `comments`.
3. No cartão, cole a **chave secreta do app**, ligue o que a IA deve fazer e clique em **Salvar e testar**.
4. Peça na **Análise do app** o acesso avançado a `instagram_manage_messages` e `instagram_manage_comments`. Até a Meta aprovar, só funciona com contas que têm função no app (bom para testar).
5. No Instagram → Configurações → Mensagens → Ferramentas conectadas, ative **Permitir acesso às mensagens**.

As respostas do direct saem pelo agendador do banco a cada 2 minutos, todos os dias.

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
