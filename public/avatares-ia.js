// Desenhos para a foto de perfil dos agentes de atendimento (usados no painel e no CRM externo).
// A lista de chaves precisa bater com AVATARES em src/respostas/agentes.js.
(() => {
  const pele = "#f6d1b1";
  const rosto = (olhos = "#1f2937", boca = "#b45309") =>
    `<circle cx="27.5" cy="31" r="1.7" fill="${olhos}"/><circle cx="36.5" cy="31" r="1.7" fill="${olhos}"/>` +
    `<path d="M28 36.5c2.2 2 5.8 2 8 0" stroke="${boca}" stroke-width="1.7" fill="none" stroke-linecap="round"/>` +
    `<circle cx="24.5" cy="35" r="1.6" fill="#f9a8a8" opacity=".6"/><circle cx="39.5" cy="35" r="1.6" fill="#f9a8a8" opacity=".6"/>`;
  const fone = '<path d="M19 30a13 13 0 0 1 26 0" stroke="#111827" stroke-width="2.4" fill="none"/>' +
    '<rect x="16.5" y="28" width="5" height="8.5" rx="2.5" fill="#111827"/><rect x="42.5" y="28" width="5" height="8.5" rx="2.5" fill="#111827"/>' +
    '<path d="M45 36.5c0 4-3 6.5-7.5 6.5" stroke="#111827" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="37" cy="43" r="2" fill="#111827"/>';
  const svg = (fundo, miolo) => `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="64" height="64" rx="32" fill="${fundo}"/>${miolo}</svg>`;

  const AVATARES = {
    atendente: {
      nome: "Atendente",
      svg: svg("#1677ff",
        '<path d="M13 64c2-12 9.5-18 19-18s17 6 19 18z" fill="#0b2a5b"/><path d="M27 43h10v6c0 3-2 4.5-5 4.5s-5-1.5-5-4.5z" fill="#eab896"/>' +
        `<circle cx="32" cy="30" r="12" fill="${pele}"/><path d="M20 28.5c0-8 5-13.5 12-13.5s12 5.5 12 13.5c-2.5-4.5-6.5-6.5-12-6.5s-9.5 2-12 6.5z" fill="#3a2a1f"/>` +
        rosto() + fone) },
    atendente2: {
      nome: "Atendente 2",
      svg: svg("#10b981",
        '<path d="M19 33c0-11 6-17.5 13-17.5S45 22 45 33v12c-3 2.5-6 2.5-8.5 0V29h-9v16c-2.5 2.5-5.5 2.5-8.5 0z" fill="#7c2d12"/>' +
        '<path d="M13 64c2-12 9.5-18 19-18s17 6 19 18z" fill="#064e3b"/><path d="M27 43h10v6c0 3-2 4.5-5 4.5s-5-1.5-5-4.5z" fill="#eab896"/>' +
        `<circle cx="32" cy="30" r="12" fill="${pele}"/><path d="M20 29c1-8 5.5-12.5 12-12.5S43 21 44 29c-3-5-7-7-12-7s-9 2-12 7z" fill="#7c2d12"/>` +
        rosto("#1f2937", "#be123c") + fone) },
    robo: {
      nome: "Robô",
      svg: svg("#7c5cff",
        '<line x1="32" y1="12" x2="32" y2="18" stroke="#e5e7eb" stroke-width="2.2"/><circle cx="32" cy="10.5" r="3.2" fill="#fbbf24"/>' +
        '<path d="M17 64c1-10 6.5-16 15-16s14 6 15 16z" fill="#cbd5e1"/><circle cx="32" cy="56" r="3" fill="#7c5cff"/>' +
        '<rect x="12" y="27" width="4.5" height="9" rx="2.2" fill="#cbd5e1"/><rect x="47.5" y="27" width="4.5" height="9" rx="2.2" fill="#cbd5e1"/>' +
        '<rect x="15.5" y="18" width="33" height="27" rx="9.5" fill="#f1f5f9"/><rect x="20.5" y="23.5" width="23" height="14" rx="6.5" fill="#1e293b"/>' +
        '<circle cx="27.5" cy="30.5" r="2.6" fill="#22d3ee"/><circle cx="36.5" cy="30.5" r="2.6" fill="#22d3ee"/>' +
        '<path d="M28.5 41h7" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round"/>') },
    rastreio: {
      nome: "Rastreio",
      svg: svg("#0ea5e9",
        '<path d="M44 7c-5.2 0-9.3 4.1-9.3 9.2 0 7 9.3 15.3 9.3 15.3s9.3-8.3 9.3-15.3C53.3 11.1 49.2 7 44 7z" fill="#ef4444"/><circle cx="44" cy="16.2" r="3.6" fill="#fff"/>' +
        '<path d="M10 42l4.5-9.5c1-2 3-3.5 5.5-3.5h23c2.5 0 4.5 1.5 5.5 3.5L53 42v8.5H10z" fill="#fff"/>' +
        '<path d="M17.5 31.5h12v7.5H14z M33.5 31.5h10.5l3.5 7.5h-14z" fill="#bae6fd"/>' +
        '<rect x="10" y="42" width="5" height="3" rx="1.5" fill="#fde047"/><rect x="48" y="42" width="5" height="3" rx="1.5" fill="#fde047"/>' +
        '<circle cx="20" cy="50.5" r="5.5" fill="#1f2937"/><circle cx="20" cy="50.5" r="2.2" fill="#9ca3af"/>' +
        '<circle cx="43" cy="50.5" r="5.5" fill="#1f2937"/><circle cx="43" cy="50.5" r="2.2" fill="#9ca3af"/>') },
    balao: {
      nome: "Conversa",
      svg: svg("#ec4899",
        '<path d="M15 16h34a7 7 0 0 1 7 7v17a7 7 0 0 1-7 7H29l-10 8.5V47h-4a7 7 0 0 1-7-7V23a7 7 0 0 1 7-7z" fill="#fff"/>' +
        '<circle cx="25" cy="30" r="2.6" fill="#1f2937"/><circle cx="39" cy="30" r="2.6" fill="#1f2937"/>' +
        '<path d="M26 36c3 3.2 9 3.2 12 0" stroke="#db2777" stroke-width="2" fill="none" stroke-linecap="round"/>') },
    estrela: {
      nome: "Estrela",
      svg: svg("#6366f1",
        '<path d="M32 9l6.4 14.2 15.4 1.7-11.5 10.4 3.2 15.2L32 42.8l-13.5 7.7 3.2-15.2L10.2 24.9l15.4-1.7z" fill="#fde68a" stroke="#f59e0b" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<circle cx="28" cy="29.5" r="1.9" fill="#1f2937"/><circle cx="36" cy="29.5" r="1.9" fill="#1f2937"/>' +
        '<path d="M28.5 34c2 1.8 5 1.8 7 0" stroke="#b45309" stroke-width="1.6" fill="none" stroke-linecap="round"/>') },
  };

  window.AVATARES_IA = AVATARES;
  /** O desenho do agente (o padrão é a atendente). */
  window.avatarIA = (chave) => (AVATARES[chave] ?? AVATARES.atendente).svg;
})();
