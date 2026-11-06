import { config } from "../config.js";
import { semSiteProprio } from "../analise/prioridade.js";

// Prévia personalizada: para a empresa SEM site próprio, um rascunho de como ficaria o site dela (nome, ramo,
// cidade, nota no Google, serviços típicos do ramo e botão de WhatsApp), numa página pública em /previa/<token>.
// A página é montada na hora com os dados públicos da própria empresa (nada é guardado e nenhum outro lead
// aparece). A IA da conversa e o follow-up oferecem o link quando a conversa toca em presença online.

// Só para empresas que nós prospectamos (o site foi conferido no Google ou no CNPJ). Quem chamou por conta própria,
// pelo formulário ou por um agente pode ter site e nós só não sabemos.
const ORIGENS_COM_PREVIA = ["campanha", "maps", "cnpj", "instagram", "manual"];
const STATUS_SEM_PREVIA = ["descadastrado", "fechado"];

/** Esta empresa pode ter a prévia? (sem site próprio, prospectada por nós e ainda não cliente nem descadastrada) */
export function podeTerPrevia(lead) {
  if (!lead?.token || !String(lead.nome ?? "").trim()) return false;
  if (!ORIGENS_COM_PREVIA.includes(lead.origem ?? "campanha")) return false;
  if (STATUS_SEM_PREVIA.includes(lead.status)) return false;
  if (lead.agente_id) return false;
  return semSiteProprio(lead.site);
}

export const enderecoDaPrevia = (lead) => (podeTerPrevia(lead) ? `${config.painel.urlPublica}/previa/${lead.token}` : "");

// A pessoa falou de algo ligado a presença online (ou pediu algo para ver).
const FALA_DE_PRESENCA = /\bsites?\b|\bp[aá]gina\b|\binternet\b|\bweb\b|\bgoogle\b|\bon-?line\b|\binstagram\b|\bredes? sociais\b|\baparecer\b|\bdivulga|\bapresenta[çc](?:[ãa]o|[õo]es)\b|\bportf[oó]lio\b|\bdar uma olhada\b|\bexemplos?\b|\bcomo (?:ficaria|fica)\b|\bpresen[çc]a\b|\bclientes? novos?\b|\bnovos? clientes?\b/i;
// ...mas já tem site, ou disse que não quer: a prévia não faz sentido.
const JA_TEM_SITE = /\bj[aá] (?:temos|tenho|tem|possu[ií]mos|possuo)\s+(?:um\s+)?site\b|\b(?:nosso|meu)\s+site\b|\bsite\s+(?:nosso|pr[oó]prio)\s+j[aá]\b/i;
const NAO_QUER = /\bn[aã]o\s+(?:quero|queremos|preciso|precisamos|tenho interesse|temos interesse|me interessa|nos interessa)\b/i;

/** O link da prévia já foi mandado nesta conversa (por nós). */
export const jaOfereceuPrevia = (historico = []) => historico.some((h) => h.autor === "nos" && /\/previa\/[\w-]+/.test(h.texto ?? ""));

/**
 * É hora de oferecer a prévia? Retorna o link (para a IA usar) ou "" (a IA nem fica sabendo dele).
 * Precisa: empresa sem site próprio, link ainda não mandado, e a pessoa ter falado de presença online
 * (site, Google, internet, Instagram, aparecer, pediu uma apresentação ou algo para dar uma olhada),
 * sem ter dito que já tem site ou que não quer.
 */
export function momentoDaPrevia({ lead, historico = [], texto = "" }) {
  if (!podeTerPrevia(lead) || jaOfereceuPrevia(historico)) return "";
  const dela = [...historico.filter((h) => h.autor === "lead").map((h) => h.texto ?? ""), texto ?? ""].join("\n");
  if (!FALA_DE_PRESENCA.test(dela) || JA_TEM_SITE.test(dela) || NAO_QUER.test(texto ?? "")) return "";
  return enderecoDaPrevia(lead);
}

// O link só sai numa conversa que segue: não para quem recusou, robô, despedida ou conversa que vai para o vendedor.
const CLASSIFICACOES_COM_PREVIA = ["interessado", "quer_informacoes", "outro"];

/** Tira da mensagem a frase (ou linha) com o link da prévia. */
export function semLinkDaPrevia(texto) {
  if (!texto || !/\/previa\//.test(texto)) return texto;
  const linhas = [];
  for (const linha of String(texto).split("\n")) {
    if (!/\/previa\//.test(linha)) { linhas.push(linha); continue; }
    // Frases terminam em . ! ? ou logo depois do link (o link costuma vir sem ponto final).
    const frases = linha.split(/(?<=[.!?]|\/previa\/[\w-]+)\s+/).filter((f) => !/\/previa\//.test(f));
    if (frases.length) linhas.push(frases.join(" "));
  }
  return linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Última trava: a resposta da IA só leva o link da prévia se era a hora (`link`) e a conversa segue. */
export function previaSoNaHora(c, link) {
  if (!c?.sugestao_resposta || !/\/previa\//.test(c.sugestao_resposta)) return c;
  const pode = link && c.sugestao_resposta.includes(link) && CLASSIFICACOES_COM_PREVIA.includes(c.classificacao)
    && !c.precisa_humano && !c.robo && !c.encerrar;
  return pode ? c : { ...c, sugestao_resposta: semLinkDaPrevia(c.sugestao_resposta) };
}

// ---------- A página ----------

const escapar = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const digitos = (s) => String(s ?? "").replace(/\D/g, "");

// Conteúdo típico de cada ramo: título do topo, frase de apoio, serviços e motivos para escolher.
// `cor` = cor principal do rascunho; `icone` = emoji dos cartões de serviço.
const RAMOS = [
  {
    teste: /oficina|mec[aâ]nic|funilaria|pneu|auto ?pe[çc]as|el[eé]trica automotiva|lava ?jato|est[eé]tica automotiva/i, cor: "#374151", icone: "🔧",
    titulo: "Seu veículo em boas mãos", frase: "Serviço honesto, orçamento claro e prazo combinado.",
    servicos: [["Revisão", "Revisão completa com checklist."], ["Freios e suspensão", "Mais segurança no dia a dia."], ["Troca de óleo", "Rápida, com o óleo certo."], ["Diagnóstico", "Scanner e avaliação detalhada."], ["Elétrica", "Bateria, alternador e partida."], ["Orçamento", "Mande fotos pelo WhatsApp."]],
    motivos: ["Orçamento antes do serviço", "Peças de qualidade", "Prazo cumprido"],
  },
  {
    teste: /odonto|dent|sorriso|ortodon|implante/i, cor: "#0f8b8d", icone: "🦷",
    titulo: "Seu sorriso em boas mãos", frase: "Atendimento odontológico com cuidado, horário marcado e estrutura completa.",
    servicos: [["Limpeza e prevenção", "Consulta de rotina, limpeza e orientação."], ["Clareamento", "Sorriso mais claro com acompanhamento."], ["Implantes", "Reabilitação com planejamento e segurança."], ["Ortodontia", "Aparelhos fixos e alinhadores."], ["Restaurações", "Tratamento de cáries e reparos estéticos."], ["Urgência", "Dor de dente? Fale com a gente pelo WhatsApp."]],
    motivos: ["Agendamento rápido pelo WhatsApp", "Profissionais experientes", "Ambiente confortável e seguro"],
  },
  {
    teste: /\bpet|veterin|banho e tosa|ra[çc][aã]o/i, cor: "#c26a12", icone: "🐾",
    titulo: "Seu pet tratado como família", frase: "Banho, tosa e cuidados com carinho e segurança.",
    servicos: [["Banho e tosa", "Com produtos próprios para cada pelagem."], ["Consultas", "Atendimento veterinário com hora marcada."], ["Vacinas", "Calendário de vacinação em dia."], ["Leva e traz", "Buscamos e entregamos o seu pet."], ["Rações e acessórios", "Encomende pelo WhatsApp."], ["Hotelzinho", "Cuidado enquanto você viaja."]],
    motivos: ["Profissionais que amam animais", "Ambiente limpo e seguro", "Atendimento pelo WhatsApp"],
  },
  {
    teste: /est[eé]tica|beleza|sal[aã]o|cabel|barbear|manicure|unha|sobrancelha|depila|spa\b/i, cor: "#b8476b", icone: "✨",
    titulo: "Beleza e autoestima com hora marcada", frase: "Cuidados feitos por quem entende, num espaço pensado para você.",
    servicos: [["Cabelo", "Corte, coloração, escova e tratamentos."], ["Unhas", "Manicure, pedicure e alongamento."], ["Sobrancelhas", "Design e coloração."], ["Estética facial", "Limpeza de pele e hidratação."], ["Estética corporal", "Massagem e tratamentos corporais."], ["Pacotes", "Combos para noivas, festas e eventos."]],
    motivos: ["Horário marcado sem espera", "Produtos de qualidade", "Atendimento atencioso"],
  },
  {
    teste: /cl[ií]nica|consult[oó]rio|m[eé]dic|fisio|psic|nutri|sa[uú]de|pediatr|dermat|oftalm|laborat/i, cor: "#2563a8", icone: "🩺",
    titulo: "Cuidado com a sua saúde, perto de você", frase: "Consultas com horário marcado, atendimento humano e acompanhamento de verdade.",
    servicos: [["Consultas", "Avaliação completa com hora marcada."], ["Retornos", "Acompanhamento do seu tratamento."], ["Exames", "Pedidos e orientações sem complicação."], ["Convênios e particular", "Consulte as opções pelo WhatsApp."], ["Teleatendimento", "Quando fizer sentido, sem sair de casa."], ["Lembrete de consulta", "Confirmação e lembrete pelo WhatsApp."]],
    motivos: ["Agendamento fácil", "Equipe qualificada", "Atendimento acolhedor"],
  },
  {
    teste: /restaurante|lanchonete|pizza|hamb[uú]rg|padaria|confeit|doce|bolo|a[çc]a[ií]|caf[eé]|bar\b|marmit|comida|food|sorvet|churrasc|sushi|japon/i, cor: "#c2410c", icone: "🍽️",
    titulo: "Sabor que faz voltar", frase: "Comida feita com capricho, para comer aqui ou pedir em casa.",
    servicos: [["Cardápio", "Os pratos e preços sempre atualizados."], ["Delivery", "Peça pelo WhatsApp e receba em casa."], ["Retirada", "Peça antes e retire sem fila."], ["Encomendas", "Para festas, eventos e empresas."], ["Promoções do dia", "Ofertas especiais toda semana."], ["Reservas", "Garanta a sua mesa."]],
    motivos: ["Ingredientes frescos", "Pedido rápido pelo WhatsApp", "Atendimento caprichado"],
  },
  {
    teste: /academia|fitness|crossfit|pilates|muscula|yoga|luta|dan[çc]a|personal/i, cor: "#1d4ed8", icone: "💪",
    titulo: "Treine com quem entende de resultado", frase: "Estrutura, acompanhamento e horários que cabem na sua rotina.",
    servicos: [["Musculação", "Treino montado para o seu objetivo."], ["Aulas coletivas", "Turmas em vários horários."], ["Avaliação física", "Comece sabendo onde está."], ["Personal", "Acompanhamento individual."], ["Planos", "Mensal, trimestral e anual."], ["Aula experimental", "Agende pelo WhatsApp."]],
    motivos: ["Professores qualificados", "Equipamentos modernos", "Horários flexíveis"],
  },
  {
    teste: /concession|ve[ií]cul|carro|seminov|revenda|motos?\b|automotiv|autom[oó]veis/i, cor: "#1e3a8a", icone: "🚗",
    titulo: "O seu próximo carro está aqui", frase: "Veículos revisados, procedência garantida e negociação sem enrolação.",
    servicos: [["Estoque", "Veículos com fotos, ano e quilometragem."], ["Financiamento", "Simulação rápida pelo WhatsApp."], ["Seu usado na troca", "Avaliação justa do seu veículo."], ["Garantia", "Carros revisados e com procedência."], ["Documentação", "Cuidamos da transferência."], ["Test drive", "Agende uma visita."]],
    motivos: ["Procedência garantida", "Condições facilitadas", "Resposta rápida no WhatsApp"],
  },
  {
    teste: /advoca|advogad|jur[ií]dic|direito/i, cor: "#1f2937", icone: "⚖️",
    titulo: "Orientação jurídica clara e próxima", frase: "Atendimento sério, linguagem simples e acompanhamento do seu caso.",
    servicos: [["Consultoria", "Entenda seus direitos antes de decidir."], ["Direito civil", "Contratos, cobranças e indenizações."], ["Direito trabalhista", "Orientação para empregados e empresas."], ["Direito de família", "Divórcio, pensão e inventário."], ["Direito do consumidor", "Problemas com compras e serviços."], ["Atendimento online", "Converse pelo WhatsApp."]],
    motivos: ["Atendimento personalizado", "Transparência em cada etapa", "Experiência comprovada"],
  },
  {
    teste: /cont[aá]bil|contabilidade|contador/i, cor: "#0f766e", icone: "📊",
    titulo: "Contabilidade que simplifica a sua empresa", frase: "Impostos em dia, menos burocracia e mais tempo para o seu negócio.",
    servicos: [["Abertura de empresa", "CNPJ, alvarás e enquadramento."], ["Contabilidade mensal", "Fiscal, contábil e folha."], ["MEI", "Declarações e regularização."], ["Imposto de Renda", "Declaração de pessoa física."], ["Planejamento tributário", "Pague só o que é justo."], ["Consultoria", "Tire dúvidas pelo WhatsApp."]],
    motivos: ["Atendimento próximo", "Prazos sempre em dia", "Orientação clara"],
  },
  {
    teste: /imobili|im[oó]ve|corretor|aluguel/i, cor: "#1e40af", icone: "🏠",
    titulo: "O imóvel certo para você", frase: "Compra, venda e aluguel com segurança e atendimento próximo.",
    servicos: [["Imóveis à venda", "Casas, apartamentos e terrenos."], ["Aluguel", "Opções para morar ou trabalhar."], ["Anuncie seu imóvel", "Avaliação e divulgação."], ["Financiamento", "Ajuda com a simulação."], ["Documentação", "Tudo certo do começo ao fim."], ["Visitas", "Agende pelo WhatsApp."]],
    motivos: ["Conhecemos a região", "Negociação transparente", "Atendimento ágil"],
  },
  {
    teste: /constru|reforma|engenhar|arquitet|pintur|marcenar|vidra[çc]|serralher|el[eé]tric|hidr[aá]ulic|gesso|piso|telhad|materia(?:l|is) de constru/i, cor: "#b45309", icone: "🛠️",
    titulo: "Sua obra feita do jeito certo", frase: "Qualidade, prazo combinado e orçamento sem surpresa.",
    servicos: [["Orçamento", "Mande fotos e medidas pelo WhatsApp."], ["Reformas", "Do pequeno reparo à obra completa."], ["Projetos", "Planejamento antes de começar."], ["Acabamento", "Detalhes que fazem a diferença."], ["Manutenção", "Serviços rápidos para casa e empresa."], ["Portfólio", "Veja trabalhos já entregues."]],
    motivos: ["Orçamento sem compromisso", "Equipe experiente", "Prazo cumprido"],
  },
  {
    teste: /escola|curso|idioma|ingl[eê]s|refor[çc]o|educa|creche|col[eé]gio|faculdade|autoescola/i, cor: "#4338ca", icone: "🎓",
    titulo: "Aprender com quem se importa", frase: "Turmas, horários e um acompanhamento próximo de cada aluno.",
    servicos: [["Cursos", "Conheça as turmas e níveis."], ["Matrículas", "Faça pelo WhatsApp."], ["Aula experimental", "Conheça antes de decidir."], ["Horários", "Manhã, tarde e noite."], ["Material", "Tudo o que o aluno precisa."], ["Acompanhamento", "Retorno para alunos e pais."]],
    motivos: ["Professores dedicados", "Turmas reduzidas", "Ambiente acolhedor"],
  },
  {
    teste: /roupa|moda|boutique|loja|cal[çc]ado|acess[oó]rio|joia|semijoia|bijou|[oó]tica|perfum|cosm[eé]tic|presente|variedade/i, cor: "#9d174d", icone: "🛍️",
    titulo: "Estilo para todos os momentos", frase: "Novidades toda semana, com atendimento próximo e entrega rápida.",
    servicos: [["Novidades", "As últimas peças que chegaram."], ["Mais vendidos", "O que os clientes mais amam."], ["Compre pelo WhatsApp", "Atendimento e pedido sem complicação."], ["Entrega", "Enviamos para a sua casa."], ["Troca fácil", "Sem burocracia."], ["Vale-presente", "Para acertar no presente."]],
    motivos: ["Peças selecionadas", "Atendimento próximo", "Pagamento facilitado"],
  },
];

const RAMO_PADRAO = {
  cor: "#4f46e5", icone: "⭐",
  titulo: "Atendimento de confiança, perto de você", frase: "Qualidade, atenção a cada cliente e resposta rápida no WhatsApp.",
  servicos: [["Nossos serviços", "Conheça tudo o que fazemos."], ["Orçamento rápido", "Peça pelo WhatsApp."], ["Atendimento", "Tire suas dúvidas com a gente."], ["Onde estamos", "Endereço e como chegar."]],
  motivos: ["Atendimento próximo", "Qualidade garantida", "Resposta rápida no WhatsApp"],
};

export const ramoDaPrevia = (nicho) => RAMOS.find((r) => r.teste.test(String(nicho ?? ""))) ?? RAMO_PADRAO;

/** "São Paulo - SP" → "São Paulo". */
const cidadeCurta = (cidade) => String(cidade ?? "").split(/\s+[-–/]\s+|,/)[0].trim();

const estrelas = (nota) => {
  const cheias = Math.round(Math.max(0, Math.min(5, nota)));
  return "★".repeat(cheias) + "☆".repeat(5 - cheias);
};

// Ícones que flutuam no topo e enfeitam os cartões, pelo ícone principal do ramo.
const ENFEITES = {
  "🦷": ["🦷", "✨", "😁", "🪥", "💎"], "✨": ["✨", "💅", "💇", "🌸", "💄"], "🩺": ["🩺", "💙", "🩹", "📋", "🌿"],
  "🐾": ["🐾", "🐶", "🐱", "🦴", "💛"], "🍽️": ["🍽️", "🍕", "🍔", "🥤", "🔥"], "💪": ["💪", "🏋️", "⚡", "🥇", "🔥"],
  "🚗": ["🚗", "🔑", "🏁", "⭐", "🛞"], "🔧": ["🔧", "🚗", "⚙️", "🛞", "✅"], "🛍️": ["🛍️", "👗", "👟", "💳", "✨"],
  "⚖️": ["⚖️", "📜", "🤝", "🏛️", "✅"], "📊": ["📊", "🧾", "💼", "📈", "✅"], "🏠": ["🏠", "🔑", "🏡", "📍", "✨"],
  "🛠️": ["🛠️", "🧱", "📐", "🏗️", "✅"], "🎓": ["🎓", "📚", "✏️", "💡", "⭐"], "⭐": ["⭐", "💬", "🤝", "✅", "📍"],
};
// A galeria mostra onde entram as fotos da empresa (o rascunho não inventa fotos).
const GALERIA = ["Fachada", "Ambiente", "Equipe", "Nosso trabalho"];

/**
 * O HTML da prévia de uma empresa. Usa só os dados públicos dela: nome, ramo, cidade, nota e número de avaliações
 * do Google, telefone/WhatsApp e, se ela tem perfil no Google Maps, o endereço. `marca` = nome da FluxDeck;
 * `telefoneMarca` = WhatsApp da FluxDeck para o "gostou?" do topo (opcional).
 * Visual: topo com fundo em movimento e um celular com uma conversa de WhatsApp animada, faixa de serviços
 * correndo, números que contam, cartões que aparecem ao rolar, galeria (onde entram as fotos), passo a passo,
 * mapa com o pino pulsando e perguntas frequentes. Quem pede menos movimento no aparelho vê tudo parado.
 */
export function paginaDaPrevia(lead, { marca = "FluxDeck", telefoneMarca = "", ano = new Date().getFullYear() } = {}) {
  const ramo = ramoDaPrevia(lead.nicho);
  const enfeites = ENFEITES[ramo.icone] ?? ENFEITES["⭐"];
  const nome = String(lead.nome).trim();
  const cidade = cidadeCurta(lead.cidade);
  const doGoogle = Boolean(lead.place_id || lead.maps_url);
  const mapa = /^https:\/\/(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(lead.maps_url ?? "") ? lead.maps_url : "";
  const endereco = doGoogle ? String(lead.endereco ?? "").trim() : "";
  const nota = Number(lead.avaliacao) || 0;
  const avaliacoes = Number(lead.total_avaliacoes) || 0;
  const temNota = doGoogle && nota > 0 && avaliacoes > 0;
  const notaTexto = nota.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const avaliacoesTexto = avaliacoes.toLocaleString("pt-BR");

  const zap = digitos(lead.whatsapp);
  const fone = digitos(lead.telefone);
  const textoZap = encodeURIComponent(`Olá! Vi o site da ${nome} e queria mais informações.`);
  const contato = zap.length >= 10
    ? { href: `https://wa.me/${zap.startsWith("55") ? zap : `55${zap}`}?text=${textoZap}`, rotulo: "Chamar no WhatsApp" }
    : fone.length >= 8 ? { href: `tel:+${fone.startsWith("55") ? fone : `55${fone}`}`, rotulo: "Ligar agora" } : { href: "#contato", rotulo: "Fale com a gente" };
  const link = (classe, rotulo = contato.rotulo, href = contato.href) =>
    `<a class="${classe}" href="${escapar(href)}"${href.startsWith("#") ? "" : ' target="_blank" rel="noopener noreferrer"'}>${escapar(rotulo)}</a>`;

  const zapMarca = digitos(telefoneMarca);
  const gostou = zapMarca.length >= 10
    ? `<a href="https://wa.me/${zapMarca.startsWith("55") ? zapMarca : `55${zapMarca}`}?text=${encodeURIComponent(`Oi! Vi o rascunho do site da ${nome}.`)}" target="_blank" rel="noopener noreferrer">Gostou? Fale comigo</a>`
    : "<span>Gostou? É só responder a nossa conversa.</span>";

  const iniciais = nome.split(/\s+/).filter((p) => /^[\p{L}\p{N}]/u.test(p)).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "★";
  const subtitulo = [lead.nicho ? String(lead.nicho).trim() : "", cidade].filter(Boolean).join(" em ");
  const titulo = cidade ? `${ramo.titulo} em ${cidade}` : ramo.titulo;
  const [primeiro] = ramo.servicos[0];

  // Números do topo: só o que é verdade (nota e avaliações do Google, os serviços da página, o WhatsApp a um clique).
  const numeros = [
    temNota ? { valor: nota, casas: 1, texto: notaTexto, rotulo: "nota no Google", icone: "⭐" } : null,
    temNota ? { valor: avaliacoes, casas: 0, texto: avaliacoesTexto, rotulo: "avaliações", icone: "💬" } : null,
    { valor: ramo.servicos.length, casas: 0, texto: String(ramo.servicos.length), rotulo: "serviços", icone: ramo.icone },
    { valor: 1, casas: 0, texto: "1", rotulo: "clique até o WhatsApp", icone: "📲" },
  ].filter(Boolean);
  const passos = [
    ["Você chama", `Pelo WhatsApp, a qualquer hora, direto do site da ${nome}.`],
    ["A gente responde", "Tira suas dúvidas e combina o melhor horário para você."],
    ["Você é atendido", "Com cuidado, do jeito que combinamos."],
  ];
  const perguntas = [
    ["Vocês atendem pelo WhatsApp?", "Sim! Toque no botão verde e fale direto com a gente."],
    ["Onde vocês ficam?", endereco || (cidade ? `Em ${cidade}. Chame no WhatsApp que passamos o endereço.` : "Chame no WhatsApp que passamos o endereço.")],
    [`Como sei o que a ${nome} oferece?`, `Os serviços estão logo acima. Para valores e horários, fale com a gente pelo WhatsApp.`],
  ];
  const marquee = ramo.servicos.map(([t]) => `<span>${ramo.icone} ${escapar(t)}</span>`).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="${ramo.cor}">
<title>${escapar(nome)} · rascunho do site</title>
<script>document.documentElement.classList.add("js")</script><style>
:root{--cor:${ramo.cor};--escura:color-mix(in srgb,var(--cor) 55%,#000);--clara:color-mix(in srgb,var(--cor) 12%,#fff);--bg:#f7f7fb;--card:#fff;--texto:#16171f;--suave:#5c6070;--borda:#e6e7ef}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--texto);font:16px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}
.progresso{position:fixed;top:0;left:0;right:0;height:3px;background:var(--cor);transform:scaleX(0);transform-origin:0 50%;z-index:20}
.faixa{background:#14151f;color:#e9eaf3;font-size:13px;padding:9px 16px;display:flex;gap:6px 14px;justify-content:center;align-items:center;flex-wrap:wrap;text-align:center}
.faixa b{color:#fff}.faixa a{color:#fff;font-weight:600;text-decoration:underline;text-underline-offset:3px}
.topo{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.9);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--borda)}
.topo .in{max-width:1120px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;min-width:0}.logo span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sigla{flex:none;width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--cor),var(--escura));color:#fff;display:grid;place-items:center;font-size:15px;letter-spacing:.02em}
nav{display:flex;gap:22px;font-size:15px;color:var(--suave)}nav a{text-decoration:none}nav a:hover{color:var(--cor)}
.botao{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:600;text-decoration:none;border-radius:12px;padding:13px 20px;background:var(--cor);color:#fff;border:0;white-space:nowrap;transition:transform .2s,box-shadow .2s}
.botao:hover{transform:translateY(-2px);box-shadow:0 10px 24px -10px var(--cor)}.botao.claro{background:#fff;color:var(--texto);border:1px solid var(--borda)}.topo .botao{padding:9px 14px;font-size:14px}
/* Topo: fundo em movimento, bolhas e ícones flutuando, e o celular com a conversa */
.hero{position:relative;overflow:hidden;color:#fff;background:linear-gradient(120deg,var(--cor),var(--escura),color-mix(in srgb,var(--cor) 70%,#7c3aed));background-size:220% 220%;animation:fundo 14s ease-in-out infinite alternate}
@keyframes fundo{to{background-position:100% 100%}}
.bolha{position:absolute;border-radius:50%;filter:blur(40px);opacity:.35;background:#fff;animation:boia 12s ease-in-out infinite alternate}
.bolha.b1{width:260px;height:260px;top:-80px;right:-60px}.bolha.b2{width:200px;height:200px;bottom:-90px;left:-50px;animation-duration:15s;opacity:.22}
.enfeite{position:absolute;font-size:28px;opacity:.28;animation:boia 9s ease-in-out infinite alternate;pointer-events:none}
@keyframes boia{0%{transform:translate(0,0) rotate(0)}100%{transform:translate(14px,-22px) rotate(12deg)}}
.hero .in{position:relative;max-width:1120px;margin:0 auto;padding:48px 16px 56px;display:grid;gap:36px;align-items:center}
@media (min-width:880px){.hero .in{grid-template-columns:1.15fr .85fr;padding:72px 16px 80px}}
.sobe{animation:sobe .8s cubic-bezier(.2,.7,.2,1) both}.d1{animation-delay:.1s}.d2{animation-delay:.22s}.d3{animation-delay:.34s}.d4{animation-delay:.46s}
@keyframes sobe{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
.tag{display:inline-block;font-size:13px;font-weight:600;background:rgba(255,255,255,.16);padding:5px 12px;border-radius:999px;margin-bottom:16px}.tag::first-letter{text-transform:uppercase}
h1{font-size:clamp(28px,7vw,50px);line-height:1.1;letter-spacing:-.02em;margin:0 0 14px;max-width:15em}
.hero p{font-size:clamp(16px,4.2vw,19px);opacity:.92;margin:0 0 26px;max-width:32em}
.acoes{display:flex;gap:10px;flex-wrap:wrap}.acoes .botao{background:#fff;color:var(--cor)}.acoes .botao.vazado{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.55)}
.nota{display:inline-flex;align-items:center;gap:8px;margin-top:22px;background:rgba(0,0,0,.18);padding:8px 14px;border-radius:12px;font-size:14px}.nota .est{color:#ffd166;letter-spacing:1px}
.celular{justify-self:center;width:min(300px,100%);background:#0f1115;border-radius:34px;padding:10px;box-shadow:0 30px 60px -20px rgba(0,0,0,.55);animation:sobe .9s .3s both,flutua 6s 1.2s ease-in-out infinite alternate}
@keyframes flutua{to{transform:translateY(-10px)}}
.tela{background:#efe7dd;border-radius:26px;overflow:hidden;color:#111;font-size:14px}
.tela header{background:#075e54;color:#fff;display:flex;align-items:center;gap:10px;padding:12px 14px}.tela header .sigla{width:32px;height:32px;font-size:12px;border-radius:50%}
.tela header small{display:block;opacity:.8;font-size:11px}.tela header b{display:block;font-size:14px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conversa{display:flex;flex-direction:column;gap:8px;padding:16px 12px 20px;min-height:250px}
.msg{max-width:82%;padding:8px 11px;border-radius:10px;line-height:1.4;box-shadow:0 1px 1px rgba(0,0,0,.08);opacity:0}
.msg.ela{align-self:flex-end;background:#d9fdd3;border-top-right-radius:2px}.msg.nos{align-self:flex-start;background:#fff;border-top-left-radius:2px}
.msg.m1{animation:m1 11s infinite}.msg.m2{animation:m2 11s infinite}.msg.m3{animation:m3 11s infinite}
.digitando{align-self:flex-start;background:#fff;border-radius:10px;padding:10px 12px;display:flex;gap:4px;opacity:0;animation:dg 11s infinite}
.digitando i{width:6px;height:6px;border-radius:50%;background:#9aa0a6;animation:pula 1s infinite}.digitando i:nth-child(2){animation-delay:.15s}.digitando i:nth-child(3){animation-delay:.3s}
@keyframes pula{0%,60%,100%{transform:none}30%{transform:translateY(-4px)}}
@keyframes m1{0%,4%{opacity:0;transform:translateY(8px)}8%,90%{opacity:1;transform:none}96%,100%{opacity:0}}
@keyframes dg{0%,14%{opacity:0;height:0;padding:0 12px}16%,30%{opacity:1;height:auto;padding:10px 12px}32%,100%{opacity:0;height:0;padding:0 12px}}
@keyframes m2{0%,30%{opacity:0;transform:translateY(8px)}34%,90%{opacity:1;transform:none}96%,100%{opacity:0}}
@keyframes m3{0%,50%{opacity:0;transform:translateY(8px)}54%,90%{opacity:1;transform:none}96%,100%{opacity:0}}
/* Faixa de serviços correndo */
.corre{background:var(--texto);color:#fff;overflow:hidden;white-space:nowrap;padding:14px 0}
.corre .trilho{display:inline-flex;gap:40px;padding-right:40px;animation:corre 28s linear infinite;font-weight:600}
@keyframes corre{to{transform:translateX(-50%)}}
section{max-width:1120px;margin:0 auto;padding:56px 16px}h2{font-size:clamp(23px,5.5vw,32px);letter-spacing:-.01em;margin:0 0 6px}.sub{color:var(--suave);margin:0 0 26px}
/* Aparece ao rolar (sem JavaScript, tudo aparece normalmente) */
.js .rv{opacity:0;transform:translateY(26px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.7,.2,1);transition-delay:var(--atraso,0s)}.js .rv.in{opacity:1;transform:none}
.numeros{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:-34px;position:relative;z-index:2;padding-top:0;padding-bottom:0}
.numero{background:var(--card);border:1px solid var(--borda);border-radius:16px;padding:18px;box-shadow:0 18px 40px -26px rgba(20,21,40,.45)}
.numero b{display:block;font-size:30px;line-height:1.1;color:var(--cor);letter-spacing:-.02em}.numero span{color:var(--suave);font-size:14px}.numero em{font-style:normal;float:right;font-size:22px}
.grade{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.cartao{background:var(--card);border:1px solid var(--borda);border-radius:16px;padding:20px;transition:transform .25s,box-shadow .25s,border-color .25s}
.cartao:hover{transform:translateY(-4px);box-shadow:0 16px 34px -20px var(--cor);border-color:color-mix(in srgb,var(--cor) 40%,var(--borda))}
.cartao .ic{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;font-size:23px;margin-bottom:12px;background:var(--clara)}
.cartao h3{margin:0 0 4px;font-size:17px}.cartao p{margin:0;color:var(--suave);font-size:15px}
.galeria{display:grid;gap:12px;grid-template-columns:repeat(4,1fr)}
.foto{position:relative;overflow:hidden;aspect-ratio:4/5;border-radius:18px;display:flex;flex-direction:column;justify-content:flex-end;padding:14px;color:#fff;background:linear-gradient(160deg,color-mix(in srgb,var(--cor) 80%,#fff),var(--escura))}
.foto:nth-child(2){background:linear-gradient(200deg,color-mix(in srgb,var(--cor) 60%,#f59e0b),var(--escura))}.foto:nth-child(3){background:linear-gradient(140deg,color-mix(in srgb,var(--cor) 65%,#ec4899),var(--escura))}.foto:nth-child(4){background:linear-gradient(180deg,color-mix(in srgb,var(--cor) 70%,#06b6d4),var(--escura))}
.foto .grande{position:absolute;inset:0;display:grid;place-items:center;font-size:54px;opacity:.9;animation:boia 7s ease-in-out infinite alternate}
.foto::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.28) 50%,transparent 70%);transform:translateX(-100%);animation:brilho 4.5s ease-in-out infinite}
.foto:nth-child(2)::after{animation-delay:.6s}.foto:nth-child(3)::after{animation-delay:1.2s}.foto:nth-child(4)::after{animation-delay:1.8s}
@keyframes brilho{0%,40%{transform:translateX(-100%)}80%,100%{transform:translateX(100%)}}
.foto b{position:relative;font-size:15px}.foto small{position:relative;opacity:.85;font-size:12px}
.passos{display:grid;gap:16px;grid-template-columns:repeat(3,1fr);position:relative;list-style:none;padding:0;margin:0}
.passos::before{content:"";position:absolute;top:24px;left:16%;right:16%;height:3px;background:var(--clara);border-radius:3px}
.passos::after{content:"";position:absolute;top:24px;left:16%;right:16%;height:3px;background:var(--cor);border-radius:3px;transform:scaleX(0);transform-origin:0 50%;transition:transform 1.4s .3s ease}
.passos.in::after,html:not(.js) .passos::after{transform:scaleX(1)}
.passo{position:relative;z-index:1;text-align:center}.passo .n{width:50px;height:50px;margin:0 auto 12px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:19px;color:#fff;background:var(--cor);box-shadow:0 0 0 6px var(--bg)}
.passo h3{margin:0 0 4px;font-size:17px}.passo p{margin:0;color:var(--suave);font-size:15px}
.motivos{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));list-style:none;padding:0;margin:0}
.motivos li{display:flex;gap:10px;align-items:center;background:var(--card);border:1px solid var(--borda);border-radius:14px;padding:14px 16px;font-weight:600}
.motivos li::before{content:"✓";flex:none;width:28px;height:28px;border-radius:50%;background:var(--clara);color:var(--cor);display:grid;place-items:center;font-size:14px}
.avaliacao{background:var(--card);border:1px solid var(--borda);border-radius:18px;padding:26px;display:flex;flex-wrap:wrap;gap:18px 28px;align-items:center}
.avaliacao .grande{font-size:56px;font-weight:800;line-height:1;color:var(--texto)}.avaliacao p{margin:4px 0 0;color:var(--suave)}
.estrelas{position:relative;display:inline-block;font-size:24px;letter-spacing:3px;color:#e3e5ef}.estrelas span{position:absolute;inset:0;overflow:hidden;white-space:nowrap;color:#f5a524;width:var(--cheio);transition:width 1.4s .2s ease}
.js .estrelas:not(.in) span{width:0}
.contato{display:grid;gap:14px;grid-template-columns:1fr 1fr}
.contato .cartao b{display:block;margin-bottom:4px}.contato .cartao span{color:var(--suave);font-size:15px;word-break:break-word}
.mapa{position:relative;height:150px;border-radius:12px;margin:12px 0;overflow:hidden;background:#e8eef3;background-image:linear-gradient(#fff 3px,transparent 3px),linear-gradient(90deg,#fff 3px,transparent 3px),linear-gradient(35deg,transparent 46%,#d6dde5 46%,#d6dde5 54%,transparent 54%);background-size:46px 46px,46px 46px,100% 100%}
.mapa .rio{position:absolute;left:-10%;right:-10%;top:62%;height:16px;background:#bcdcf5;transform:rotate(-8deg);border-radius:20px}
.pino{position:absolute;left:50%;top:44%;width:26px;height:26px;margin:-26px 0 0 -13px;background:var(--cor);border-radius:50% 50% 50% 0;transform:rotate(-45deg);animation:pino 1.8s ease-in-out infinite}
.pino::after{content:"";position:absolute;inset:8px;background:#fff;border-radius:50%}
@keyframes pino{0%,100%{translate:0 0}50%{translate:0 -6px}}
.onda{position:absolute;left:50%;top:44%;width:16px;height:8px;margin:2px 0 0 -8px;border-radius:50%;background:color-mix(in srgb,var(--cor) 45%,transparent);animation:onda 1.8s ease-out infinite}
@keyframes onda{from{transform:scale(1);opacity:.9}to{transform:scale(5);opacity:0}}
details{background:var(--card);border:1px solid var(--borda);border-radius:14px;padding:4px 18px;margin-bottom:10px}
summary{cursor:pointer;font-weight:600;padding:14px 0;list-style:none;display:flex;justify-content:space-between;gap:12px}summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:var(--cor);font-size:22px;line-height:1;transition:transform .25s}details[open] summary::after{transform:rotate(45deg)}
details p{margin:0 0 16px;color:var(--suave)}
.final{max-width:1088px;margin:0 16px 56px;border-radius:24px;padding:40px 24px;text-align:center;color:#fff;background:linear-gradient(120deg,var(--cor),var(--escura));background-size:200% 200%;animation:fundo 10s ease-in-out infinite alternate}
@media (min-width:1120px){.final{margin:0 auto 56px}}
.final h2{margin-bottom:10px}.final p{opacity:.9;margin:0 0 22px}.final .botao{background:#fff;color:var(--cor)}
footer{border-top:1px solid var(--borda);color:var(--suave);font-size:13px;text-align:center;padding:26px 16px 96px}
.flutua{position:fixed;right:16px;bottom:16px;z-index:12;width:58px;height:58px;border-radius:50%;background:#25d366;display:grid;place-items:center;box-shadow:0 10px 26px -8px rgba(0,0,0,.45);text-decoration:none}
.flutua::before{content:"";position:absolute;inset:0;border-radius:50%;background:#25d366;animation:pulso 2.2s ease-out infinite;z-index:-1}
@keyframes pulso{from{transform:scale(1);opacity:.6}to{transform:scale(1.7);opacity:0}}
.flutua svg{width:30px;height:30px;fill:#fff}
@media (max-width:879px){nav{display:none}}
@media (max-width:520px){.topo .botao{display:none}.hero .in{padding:36px 16px 44px}.acoes .botao{flex:1 1 100%}section{padding:44px 16px}
.celular{width:min(270px,100%)}.conversa{min-height:220px}
.numeros{grid-template-columns:1fr 1fr;gap:10px}.numero{padding:14px}.numero b{font-size:25px}
.grade{grid-template-columns:1fr 1fr;gap:10px}.grade .cartao{padding:14px}.cartao .ic{width:38px;height:38px;font-size:19px;margin-bottom:8px}.cartao h3{font-size:15px;line-height:1.3}.cartao p{font-size:13.5px;line-height:1.45}
.galeria{grid-template-columns:1fr 1fr;gap:10px}.foto{aspect-ratio:1}.foto .grande{font-size:42px}
.passos{grid-template-columns:1fr;gap:20px;text-align:left}.passos::before,.passos::after{top:25px;bottom:25px;left:24px;right:auto;width:3px;height:auto}.passos::after{transform:scaleY(0);transform-origin:50% 0}.passos.in::after{transform:scaleY(1)}
.passo{display:grid;grid-template-columns:50px 1fr;gap:4px 14px;text-align:left}.passo .n{margin:0;grid-row:span 2}
.contato{grid-template-columns:1fr}.final{padding:32px 18px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.msg,.digitando{opacity:1!important}.digitando{display:none!important}.js .rv{opacity:1;transform:none}.js .estrelas span{width:var(--cheio)!important}}
</style></head><body>
<div class="progresso" id="progresso"></div>
<div class="faixa"><span><b>Rascunho</b> feito pela ${escapar(marca)} para a ${escapar(nome)}, com informações públicas${doGoogle ? " do Google" : ""}.</span>${gostou}</div>
<header class="topo"><div class="in"><div class="logo"><span class="sigla">${escapar(iniciais)}</span><span>${escapar(nome)}</span></div>
<nav><a href="#servicos">Serviços</a><a href="#galeria">Galeria</a><a href="#como">Como funciona</a><a href="#contato">Contato</a></nav>${link("botao")}</div></header>
<div class="hero"><span class="bolha b1"></span><span class="bolha b2"></span>
${enfeites.map((e, i) => `<span class="enfeite" style="left:${[6, 82, 48, 18, 70][i]}%;top:${[18, 12, 78, 70, 55][i]}%;animation-delay:-${i * 1.7}s;animation-duration:${8 + i * 1.5}s">${e}</span>`).join("")}
<div class="in"><div>
${subtitulo ? `<span class="tag sobe">${escapar(subtitulo)}</span>` : ""}
<h1 class="sobe d1">${escapar(titulo)}</h1>
<p class="sobe d2">${escapar(ramo.frase)}</p>
<div class="acoes sobe d3">${link("botao")}${mapa ? link("botao vazado", "Como chegar", mapa) : link("botao vazado", "Ver serviços", "#servicos")}</div>
${temNota ? `<div class="nota sobe d4"><span class="est">${estrelas(nota)}</span><span><b>${notaTexto}</b> · ${avaliacoesTexto} avaliações no Google</span></div>` : ""}
</div>
<div class="celular" aria-hidden="true"><div class="tela"><header><span class="sigla">${escapar(iniciais)}</span><div><b>${escapar(nome)}</b><small>online</small></div></header>
<div class="conversa"><div class="msg ela m1">Oi! Queria saber sobre ${escapar(primeiro.toLowerCase())} 😊</div><div class="digitando"><i></i><i></i><i></i></div>
<div class="msg nos m2">Oi! Claro, te explico agora. Qual o melhor horário para você?</div><div class="msg ela m3">Perfeito, obrigado pela rapidez! 🙌</div></div></div></div>
</div></div>
<div class="corre" aria-hidden="true"><div class="trilho">${marquee}${marquee}</div></div>
<section class="numeros">${numeros.map((x, i) => `<div class="numero rv" style="--atraso:${i * 0.1}s"><em>${x.icone}</em><b data-conta="${x.valor}" data-casas="${x.casas}">${escapar(x.texto)}</b><span>${escapar(x.rotulo)}</span></div>`).join("")}</section>
<section id="servicos"><h2 class="rv">Serviços</h2><p class="sub rv">O que a ${escapar(nome)} oferece${cidade ? ` em ${escapar(cidade)}` : ""}.</p>
<div class="grade">${ramo.servicos.map(([t, d], i) => `<div class="cartao rv" style="--atraso:${(i % 3) * 0.1}s"><div class="ic">${enfeites[i % enfeites.length]}</div><h3>${escapar(t)}</h3><p>${escapar(d)}</p></div>`).join("")}</div></section>
<section id="galeria"><h2 class="rv">Galeria</h2><p class="sub rv">Aqui entram as fotos da ${escapar(nome)}: o espaço, a equipe e o trabalho de vocês.</p>
<div class="galeria">${GALERIA.map((g, i) => `<div class="foto rv" style="--atraso:${i * 0.1}s"><span class="grande" style="animation-delay:-${i * 1.3}s">${enfeites[i % enfeites.length]}</span><b>${g}</b><small>sua foto aqui</small></div>`).join("")}</div></section>
<section id="como"><h2 class="rv">Como funciona</h2><p class="sub rv">Simples, rápido e sem fila.</p>
<ol class="passos rv">${passos.map(([t, d], i) => `<li class="passo"><span class="n">${i + 1}</span><h3>${escapar(t)}</h3><p>${escapar(d)}</p></li>`).join("")}</ol></section>
<section><h2 class="rv">Por que escolher a ${escapar(nome)}</h2><p class="sub rv">Quem conhece, recomenda.</p>
<ul class="motivos">${ramo.motivos.map((m, i) => `<li class="rv" style="--atraso:${i * 0.1}s">${escapar(m)}</li>`).join("")}</ul></section>
${temNota ? `<section><h2 class="rv">O que os clientes dizem</h2><p class="sub rv">A nota da ${escapar(nome)} no Google.</p>
<div class="avaliacao rv"><div class="grande" data-conta="${nota}" data-casas="1">${notaTexto}</div><div><span class="estrelas rv" style="--cheio:${Math.round((nota / 5) * 100)}%" aria-label="${notaTexto} de 5">★★★★★<span>★★★★★</span></span><p>${avaliacoesTexto} ${avaliacoes === 1 ? "pessoa avaliou" : "pessoas avaliaram"} no Google</p></div>${mapa ? link("botao claro", "Ver as avaliações", mapa) : ""}</div></section>` : ""}
<section id="contato"><h2 class="rv">Fale com a gente</h2><p class="sub rv">Atendimento rápido pelo WhatsApp.</p>
<div class="contato">
<div class="cartao rv"><b>WhatsApp</b><span>${zap.length >= 10 || fone.length >= 8 ? "Resposta rápida, sem fila." : "Em breve."}</span><p style="margin-top:14px">${link("botao")}</p></div>
${endereco || cidade ? `<div class="cartao rv" style="--atraso:.1s"><b>Onde estamos</b><span>${escapar(endereco || cidade)}</span><div class="mapa" aria-hidden="true"><span class="rio"></span><span class="onda"></span><span class="pino"></span></div>${mapa ? link("botao claro", "Abrir no mapa", mapa) : ""}</div>` : ""}
</div></section>
<section><h2 class="rv">Perguntas frequentes</h2><p class="sub rv">As dúvidas mais comuns, respondidas.</p>
${perguntas.map(([p, r], i) => `<details class="rv" style="--atraso:${i * 0.08}s"${i === 0 ? " open" : ""}><summary>${escapar(p)}</summary><p>${escapar(r)}</p></details>`).join("")}</section>
<div class="final rv"><h2>Vamos conversar?</h2><p>A ${escapar(nome)} responde rapidinho pelo WhatsApp.</p>${link("botao")}</div>
<footer>© ${escapar(ano)} ${escapar(nome)}${cidade ? ` · ${escapar(cidade)}` : ""}<br>Este é um rascunho ilustrativo feito pela ${escapar(marca)}: ainda não está no ar, e textos, serviços e imagens são exemplos do ramo.</footer>
<a class="flutua" href="${escapar(contato.href)}"${contato.href.startsWith("#") ? "" : ' target="_blank" rel="noopener noreferrer"'} aria-label="${escapar(contato.rotulo)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg></a>
<script>
(function(){
  var parado = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var formatar = function(v, casas){ return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }); };
  var contar = function(el){
    var alvo = parseFloat(el.dataset.conta), casas = +el.dataset.casas || 0, t0 = null;
    if (parado || !(alvo > 0)) return;
    var passo = function(t){ t0 = t0 || t; var p = Math.min(1, (t - t0) / 1400); el.textContent = formatar(alvo * (1 - Math.pow(1 - p, 3)), casas); if (p < 1) requestAnimationFrame(passo); };
    requestAnimationFrame(passo);
    setTimeout(function(){ el.textContent = formatar(alvo, casas); }, 1700); // aba pausada no meio: o número certo fica
  };
  var mostrar = function(el){ el.classList.add("in"); el.querySelectorAll("[data-conta]").forEach(contar); if (el.dataset.conta) contar(el); };
  if (!("IntersectionObserver" in window) || parado) { document.querySelectorAll(".rv").forEach(function(el){ el.classList.add("in"); }); }
  else {
    var io = new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting) { mostrar(e.target); io.unobserve(e.target); } }); }, { threshold: 0.15 });
    document.querySelectorAll(".rv").forEach(function(el){ io.observe(el); });
  }
  var barra = document.getElementById("progresso");
  addEventListener("scroll", function(){ var h = document.documentElement.scrollHeight - innerHeight; barra.style.transform = "scaleX(" + (h > 0 ? scrollY / h : 0) + ")"; }, { passive: true });
})();
</script>
</body></html>`;
}
