// State variables
const state = {
  leads: [],
  pipelines: [],
  users: [],
  fields: [],
  filteredLeads: [],
  // Active filters
  // Precisa bater com a aba marcada como .active no index.html,
  // senão o dashboard abre mostrando um funil diferente do botão aceso
  pipelineId: 'all',
  dateFrom: null, // Date object
  dateTo: null,   // Date object
  activePeriod: 'this_month', // tracks which pill is active
  ownerId: 'all',
  marketingGroup: 'campaign', // campaign, source, medium, content, term
  // Charts instances
  funnelChart: null,
  campaignChart: null,
  cargoChart: null,
  faturamentoChart: null,
  // Eduzz Analytics State
  eduzzData: null,
  eduzzCampaignSalesChart: null,
  eduzzCampaignTicketChart: null,
  // Meta Ads State
  metaAdsData: null,
  // Cross-reference Eduzz Sales Index (contact_id -> Sale Info)
  contactSalesIndex: new Map()
};

// ==========================================
// FONTE ÚNICA DE VERDADE — PIPELINES E ETAPAS
// ==========================================
// Toda contagem de etapa do funil (pirâmide, KPIs, rankings, modal, time)
// DEVE usar as funções deste bloco. Não duplicar IDs de status em outros lugares.

const PIPELINES = {
  MLFP: 13304583,          // [MLFP] Inbound
  KO_INBOUND: 13304659,    // [KO] Inbound
  KO_EBOOKS: 13537971,     // [KO] Ebooks
  KOP: 14173256,           // [KOP] Inbound
  KOR: 14268556,           // [KOR] Inbound
  SOCIAL_SELLING: 14104532,// Instagram (Social Selling)
  RECUPERACAO: 13956952,   // Funil de Recuperação
  BASE_CLIENTES: 13956856, // Base de Clientes Eduzz — pagamento confirmado
  MLFP_ANTIGOS: 14008652   // [MLFP] Leads Antigos
};

// Funis comerciais que compõem a visão "Todos os Funis".
// Base de Clientes (registro de pagamento), Leads Antigos e Instagram DMs (Social Selling) ficam de fora:
// não são captação do Inbound comercial e inflariam/distorceriam as métricas de campanha.
const FUNIS_COMERCIAIS = [
  PIPELINES.MLFP,
  PIPELINES.KO_INBOUND,
  PIPELINES.KO_EBOOKS,
  PIPELINES.KOP,
  PIPELINES.KOR,
  PIPELINES.RECUPERACAO
];

const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;

// Filtro universal para sempre ignorar leads de teste
function isTestLead(lead) {
  if (!lead) return false;
  const name = String(lead.name || '').toLowerCase();
  if (/\btest(e|es|ing|ed|er)?\b/i.test(name) || name.includes('teste') || name.includes('test client') || name.includes('test recovery')) {
    return true;
  }
  const tags = (lead._embedded?.tags || lead.tags || []).map(t => {
    const tName = typeof t === 'string' ? t : (t?.name || '');
    return tName.toLowerCase();
  });
  if (tags.some(t => /\btest(e|es)?\b/i.test(t) || t.includes('teste') || t.includes('test_'))) {
    return true;
  }
  const contacts = lead._embedded?.contacts || [];
  for (const c of contacts) {
    const cName = String(c.name || '').toLowerCase();
    if (/\btest(e|es|ing|ed|er)?\b/i.test(cName) || cName.includes('teste')) return true;
  }
  return false;
}

// Identifica leads que pertencem ou foram para o funil de Repescagem / Leads Antigos
// Mesmo que tenham entrado no Inbound, se foram para a Repescagem são desconsiderados do Inbound
function isRepescagemLead(lead) {
  if (!lead) return false;
  // 1. Pipeline 14008652 é o pipeline oficial de [MLFP] Leads Antigos (Repescagem)
  if (lead.pipeline_id === PIPELINES.MLFP_ANTIGOS || lead.pipeline_id === 14008652) return true;

  // 2. Tags indicando repescagem / leads antigos / reciclagem
  const tags = (lead._embedded?.tags || lead.tags || []).map(t => {
    const tName = typeof t === 'string' ? t : (t?.name || '');
    return tName.toUpperCase();
  });
  if (tags.some(t => 
    t.includes('REPESCAGEM') || 
    t.includes('LEADS ANTIGOS') || 
    t.includes('MLFP LEADS ANTIGOS') || 
    t.includes('REPESCA') || 
    t.includes('RECICLAGEM') ||
    t.includes('REPESCAGEM_MLFP')
  )) {
    return true;
  }

  // 3. Nome do lead indicando repescagem / leads antigos
  const name = String(lead.name || '').toUpperCase();
  if (name.includes('REPESCAGEM') || name.includes('LEADS ANTIGOS') || name.includes('REPESCA')) {
    return true;
  }

  return false;
}

// Etapas declaradas POR FUNIL, usando o nome real da etapa no Kommo.
// Antes existia uma lista única de IDs aplicada a todos os funis, o que
// rotulava "Contato inicial" (KOP) e "Em Negociação" (Recuperação) como
// "Reunião Agendada" — daí KOP aparecer com 100% de agendamento.
//
// tipo:
//   'reuniao'    → funil comercial com reunião (MLFP, KO Inbound, KO Ebooks)
//   'negociacao' → funil sem reunião: contato → negociação (KOP, KOR, Social)
//   'recuperacao'→ carrinho/pix/boleto pendente → contato → negociação
const ETAPAS_POR_PIPELINE = {
  [PIPELINES.MLFP]: {
    tipo: 'reuniao',
    espera: [102598995, 102598999, 108066768, 109108180], // Tentando Contato, Contato Feito, Follow Up 1/2
    engajado: [109107608, 102599003],                     // Closer Direto, Reunião Agendada
    noshow: [108291644],
    avancado: [102599203],                                // Reunião Realizada
    downsell: [108619300]
  },
  [PIPELINES.MLFP_ANTIGOS]: {
    tipo: 'reuniao',
    espera: [108121856, 108123248, 108121868, 110155540], // Etapa de entrada, Tentando Contato, Contatos Dia - Jac, Respondidos
    engajado: [108123252],                                // Reunião Agendada
    noshow: [110341428],                                  // No show
    avancado: [108123256, 108123260],                     // Reunião Realizada, Negociação
    downsell: []
  },
  [PIPELINES.KO_INBOUND]: {
    tipo: 'reuniao',
    espera: [102599767, 102599771],
    engajado: [102599807],                                // Reunião Agendada
    noshow: [104280663],
    avancado: [102599811]                                 // Reunião Realizada
  },
  [PIPELINES.KO_EBOOKS]: {
    tipo: 'reuniao',
    espera: [104452415, 104452419],
    engajado: [104452423],                                // Reunião Agendada
    noshow: [104457987],
    avancado: [104458027]                                 // Reunião Realizada
  },
  [PIPELINES.KOP]: {
    tipo: 'negociacao',
    espera: [],
    engajado: [109421448],                                // Contato inicial
    noshow: [],
    avancado: [109421452, 109421456]                      // Oferta feita, Negociação
  },
  [PIPELINES.KOR]: {
    tipo: 'negociacao',
    espera: [],
    engajado: [110184132],
    noshow: [],
    avancado: []
  },
  [PIPELINES.SOCIAL_SELLING]: {
    tipo: 'negociacao',
    espera: [108876924],                                  // Comentários
    engajado: [108876928],                                // Direct
    noshow: [],
    avancado: [108876932]                                 // Negociação
  },
  [PIPELINES.RECUPERACAO]: {
    tipo: 'recuperacao',
    espera: [107712464, 107712468, 107712472],            // Boleto Gerado, Pix Pendente, Carrinho Abandonado
    engajado: [107712572],                                // Contato Iniciado
    noshow: [],
    avancado: [107712576]                                 // Em Negociação
  }
};

const ETAPAS_VAZIAS = { tipo: 'negociacao', espera: [], engajado: [], noshow: [], avancado: [], downsell: [] };

// Rótulos da pirâmide por tipo de funil — o mesmo número com o nome certo
const ROTULOS_FUNIL = {
  reuniao: {
    espera: '⏳ Follow Up (Sem Resposta 1ºs Contatos)',
    engajado: '📅 3. Reuniões Agendadas (Total SDR)',
    avancado: '🤝 4. Reuniões Realizadas (Show-Up)',
    dropEngajado: '🔻 SDR ➔ Agendamento:',
    dropAvancado: '🔻 Presença / Show-Up Closer:',
    subEngajado: 'dos MQLs',
    subAvancado: 'show-up',
    mostrarNoShow: true
  },
  negociacao: {
    espera: '⏳ Aguardando Retorno',
    engajado: '💬 3. Contato Iniciado',
    avancado: '🤝 4. Em Negociação / Oferta Feita',
    dropEngajado: '🔻 Qualificado ➔ Contato:',
    dropAvancado: '🔻 Contato ➔ Negociação:',
    subEngajado: 'dos MQLs',
    subAvancado: 'avançaram',
    mostrarNoShow: false
  },
  recuperacao: {
    espera: '🧾 Pagamento Pendente (Boleto / Pix / Carrinho)',
    engajado: '💬 3. Contato Iniciado',
    avancado: '🤝 4. Em Negociação',
    dropEngajado: '🔻 Pendente ➔ Contato:',
    dropAvancado: '🔻 Contato ➔ Negociação:',
    subEngajado: 'dos leads',
    subAvancado: 'avançaram',
    mostrarNoShow: false
  },
  misto: {
    espera: '⏳ Aguardando Retorno / Follow Up',
    engajado: '💬 3. Contato Ativo (Reunião ou Negociação Iniciada)',
    avancado: '🤝 4. Estágio Avançado (Reunião Feita ou Negociação)',
    dropEngajado: '🔻 MQL ➔ Contato Ativo:',
    dropAvancado: '🔻 Contato ➔ Estágio Avançado:',
    subEngajado: 'dos MQLs',
    subAvancado: 'avançaram',
    mostrarNoShow: true
  }
};

const FUNNEL = {
  etapasDe(lead) {
    return ETAPAS_POR_PIPELINE[lead.pipeline_id] || ETAPAS_VAZIAS;
  },

  tags(lead) {
    return (lead._embedded?.tags || []).map(t => (t.name || '').toUpperCase());
  },

  // Tipo do funil selecionado; 'misto' quando a visão agrega funis diferentes
  tipoAtual(pipelineId) {
    if (!pipelineId || pipelineId === 'all') return 'misto';
    const def = ETAPAS_POR_PIPELINE[parseInt(pipelineId)];
    return def ? def.tipo : 'misto';
  },

  // Avalia todas as etapas de uma vez (uma passada de tags e venda por lead)
  evaluate(lead) {
    const sale = getLeadSaleStatus(lead);
    const sId = parseInt(lead.status_id);
    const etapas = FUNNEL.etapasDe(lead);
    const tags = FUNNEL.tags(lead);

    // Regra MLFP: Auxiliares de cozinha NÃO entram como MQL mesmo com faturamento acima do recomendado
    const isMlfpLead = lead.pipeline_id === 13304583 || lead.pipeline_id === 14008652 || lead.pipeline_id === 14290224;
    let isAuxiliar = false;
    if (isMlfpLead) {
      const cfs = lead.custom_fields_values || [];
      for (const f of cfs) {
        const fn = String(f.field_name || '').toLowerCase();
        const val = String(f.values?.[0]?.value || '').toUpperCase();
        if (f.field_id === 128884 || f.field_id === 128474 || fn.includes('cargo') || fn.includes('perfil')) {
          if (val.includes('AUXILIAR') || val.includes('AJUDANTE') || val.includes('BUSCO EVOLUÇÃO') || val.includes('BUSCO EVOLUCAO')) {
            isAuxiliar = true;
            break;
          }
        }
      }
    }

    const hasMqlTag = !isAuxiliar && (tags.includes('MQL') || tags.includes('QUALIFICADO') || tags.includes('KO_MQL'));
    const hasDesqualificado = isAuxiliar || tags.includes('DESQUALIFICADO') || tags.includes('DISQUALIFIED') || tags.includes('FORA DO PERFIL');

    const isWon = sale.isWon;
    const isNoShow = (etapas.noshow || []).includes(sId);
    // Avançado = reunião realizada / em negociação, ou venda fechada
    const isAvancado = (etapas.avancado || []).includes(sId) || isWon;
    // Engajado = reunião agendada / contato iniciado, ou qualquer etapa além
    const isEngajado = !isAuxiliar && ((etapas.engajado || []).includes(sId) || isNoShow || isAvancado);
    const isMql = !isAuxiliar && (hasMqlTag || isEngajado);

    return {
      sale,
      isWon,
      isLost: sId === STATUS_PERDIDO && !isWon,
      isNoShow,
      isAvancado,
      isEngajado,
      isMql,
      isEmEspera: (etapas.espera || []).includes(sId) || tags.includes('FOLLOW UP') || tags.includes('SEM RESPOSTA'),
      isDownsell: isAuxiliar
        || tags.includes('DOWNSELL')
        || (etapas.downsell || []).includes(sId)
        || (hasDesqualificado && !hasMqlTag),
      revenue: isWon ? (sale.price || lead.price || 0) : 0
    };
  },

  // Aplica o filtro de etapa selecionada (clique numa camada da pirâmide)
  matchesStep(lead, stepKey) {
    if (!stepKey || stepKey === 'all') return true;
    const e = FUNNEL.evaluate(lead);
    switch (stepKey) {
      case 'mql': return e.isMql;
      case 'agendada': return e.isEngajado;
      case 'noshow': return e.isNoShow;
      case 'realizada': return e.isAvancado;
      case 'followup': return e.isEmEspera;
      case 'downsell': return e.isDownsell;
      case 'won': return e.isWon;
      default: return true;
    }
  }
};

// Indexa pagamentos CONFIRMADOS por contact_id.
// Regra de negócio: a venda nasce no funil comercial (MLFP / KO) mas só é
// validada quando o pagamento cai, o que é representado por um lead no funil
// "Base de Clientes Eduzz". A tag EDUZZ sozinha marca origem, não pagamento.
function buildContactSalesIndex(allLeads = state.leads) {
  const salesMap = new Map();
  (allLeads || []).forEach(l => {
    if (l.pipeline_id !== PIPELINES.BASE_CLIENTES) return;

    (l._embedded?.contacts || []).forEach(c => {
      if (!c.id) return;
      const existing = salesMap.get(c.id);
      const currentPrice = l.price || 0;
      if (!existing || currentPrice > existing.price) {
        salesMap.set(c.id, {
          saleLeadId: l.id,
          price: currentPrice,
          paidAt: l.created_at || 0,
          statusId: l.status_id,
          pipelineId: l.pipeline_id,
          productName: l.name || 'Venda Eduzz',
          tags: (l._embedded?.tags || []).map(t => t.name)
        });
      }
    });
  });
  state.contactSalesIndex = salesMap;
  console.log(`[Cross-Reference] ${salesMap.size} contatos com pagamento confirmado na Base de Clientes Eduzz.`);
}

// Avalia se o lead virou venda ganha.
// Ganha = fechada no próprio funil (status 142) OU pagamento confirmado
// na Base de Clientes Eduzz pelo mesmo contato.
function getLeadSaleStatus(lead) {
  if (!lead) return { isWon: false, price: 0, badgeLabel: '📥 Lead Capturado', badgeClass: 'badge-optin' };

  // O próprio registro de pagamento não é um lead de funil comercial:
  // ele é a validação, e é contabilizado através do lead de origem.
  if (lead.pipeline_id === PIPELINES.BASE_CLIENTES) {
    return {
      isWon: true,
      price: lead.price || 0,
      badgeLabel: `🏆 Pagamento Confirmado (${formatBRL(lead.price || 0)})`,
      badgeClass: 'badge-won-eduzz',
      matchedLeadId: lead.id,
      source: 'base_clientes'
    };
  }

  if (parseInt(lead.status_id) === STATUS_GANHO) {
    return {
      isWon: true,
      price: lead.price || 0,
      badgeLabel: `🏆 Venda Ganha (${formatBRL(lead.price || 0)})`,
      badgeClass: 'badge-won-eduzz',
      matchedLeadId: lead.id,
      source: 'crm'
    };
  }

  // Cross-reference: pagamento confirmado pelo mesmo contato
  const contacts = lead._embedded?.contacts || [];
  for (const c of contacts) {
    if (c.id && state.contactSalesIndex && state.contactSalesIndex.has(c.id)) {
      const match = state.contactSalesIndex.get(c.id);
      const price = match.price || lead.price || 0;
      return {
        isWon: true,
        price,
        badgeLabel: `🏆 Venda Eduzz (${formatBRL(price)})`,
        badgeClass: 'badge-won-eduzz',
        matchedLeadId: match.saleLeadId,
        productName: match.productName,
        paidAt: match.paidAt,
        // Pagamento anterior à captura do lead = cliente que já era comprador
        preExisting: match.paidAt > 0 && lead.created_at > 0 && match.paidAt < lead.created_at,
        source: 'eduzz'
      };
    }
  }

  return {
    isWon: false,
    price: 0,
    badgeLabel: '📥 Lead Capturado (Página)',
    badgeClass: 'badge-captured-lead',
    matchedLeadId: null
  };
}

// DOM Elements
const elements = {
  pipelineFilter: document.getElementById('pipelineFilter'),
  ownerFilter: document.getElementById('ownerFilter'),
  utmGroupSelect: document.getElementById('utmGroupSelect'),
  
  metricTotalLeads: document.getElementById('metricTotalLeads'),
  metricActiveLeads: document.getElementById('metricActiveLeads'),
  metricWonCount: document.getElementById('metricWonCount'),
  metricWonValue: document.getElementById('metricWonValue'),
  metricLostCount: document.getElementById('metricLostCount'),
  metricLostRate: document.getElementById('metricLostRate'),
  metricConversionRate: document.getElementById('metricConversionRate'),
  metricConversionBase: document.getElementById('metricConversionBase'),
  
  campaignTableBody: document.getElementById('campaignTableBody'),
  thMarketingName: document.getElementById('thMarketingName'),
  mktChartTitle: document.getElementById('mktChartTitle'),
  mktTableTitle: document.getElementById('mktTableTitle'),
  
  teamCardsContainer: document.getElementById('teamCardsContainer'),
  syncBtn: document.getElementById('syncBtn'),
  lastSyncDate: document.getElementById('lastSyncDate'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  toastNotification: document.getElementById('toastNotification'),
  toastMsg: document.getElementById('toastMsg'),
  toastIcon: document.getElementById('toastIcon'),

  // (tabKommo / tabEduzz / kommoView / eduzzView removidos junto com o
  //  sistema de abas antigo — os dois primeiros nem existiam mais no HTML)

  // Eduzz Analytics Elements
  eduzzMetricRevenue: document.getElementById('eduzzMetricRevenue'),
  eduzzMetricSalesCount: document.getElementById('eduzzMetricSalesCount'),
  eduzzMetricClients: document.getElementById('eduzzMetricClients'),
  eduzzMetricMultiClients: document.getElementById('eduzzMetricMultiClients'),
  eduzzMetricMultiRate: document.getElementById('eduzzMetricMultiRate'),
  eduzzMetricAvgTicket: document.getElementById('eduzzMetricAvgTicket'),
  eduzzCampaignTableBody: document.getElementById('eduzzCampaignTableBody'),
  eduzzProductTableBody: document.getElementById('eduzzProductTableBody'),
  eduzzVipTableBody: document.getElementById('eduzzVipTableBody')
};

// Colors for Chart.js - Orange & Warm Tones Theme
const orangeColors = {
  primary: '#ff6b00',
  secondary: '#0ea5e9',
  accent: '#f59e0b',
  success: '#10b981',
  danger: '#ef4444',
  palette: [
    '#ff6b00', // Primary Chef Orange
    '#f97316', // Orange 500
    '#fb923c', // Orange 400
    '#f59e0b', // Amber 500
    '#fbbf24', // Amber 400
    '#ea580c', // Orange 600
    '#ca8a04', // Yellow 600
    '#f43f5e', // Rose 500
    '#cbd5e1'  // Slate 300
  ]
};

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadData();
});

// Helper: Format date in local YYYY-MM-DD without UTC timezone shift
function formatDateLocal(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Date helper: compute dateFrom/dateTo from a preset key
function setDatePreset(preset) {
  const now = new Date();
  state.activePeriod = preset;
  if (preset === 'today') {
    state.dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    state.dateTo = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  } else if (preset === 'this_month') {
    state.dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    state.dateTo = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  } else if (preset === 'last_month') {
    state.dateFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    state.dateTo = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (preset === 'all') {
    state.dateFrom = null;
    state.dateTo = null;
  } else if (preset === 'custom') {
    // Don't change dates — user will set them manually
    return;
  } else {
    const days = parseInt(preset);
    if (!isNaN(days)) {
      state.dateTo = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      state.dateFrom = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
      state.dateFrom.setHours(0, 0, 0, 0);
    }
  }
  // Sync the date inputs using local YYYY-MM-DD
  const dfEl = document.getElementById('dateFrom');
  const dtEl = document.getElementById('dateTo');
  if (dfEl && state.dateFrom) dfEl.value = formatDateLocal(state.dateFrom);
  if (dtEl && state.dateTo) dtEl.value = formatDateLocal(state.dateTo);
}

// Setup Listeners
function setupEventListeners() {
  elements.pipelineFilter.addEventListener('change', (e) => {
    state.pipelineId = e.target.value;
    state.selectedStep = 'all';
    applyFilters();
  });
  elements.ownerFilter.addEventListener('change', (e) => {
    state.ownerId = e.target.value;
    state.selectedStep = 'all';
    applyFilters();
  });
  elements.utmGroupSelect.addEventListener('change', (e) => {
    state.marketingGroup = e.target.value;
    updateMarketingLabels();
    applyFilters();
  });
  elements.syncBtn.onclick = handleSync;

  // Date Pills
  const pillsContainer = document.getElementById('datePills');
  const customDateRange = document.getElementById('customDateRange');
  if (pillsContainer) {
    pillsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.pill-btn');
      if (!btn) return;
      const period = btn.getAttribute('data-period');

      // Update active pill visual
      pillsContainer.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Toggle custom date range visibility
      if (period === 'custom') {
        customDateRange.classList.add('visible');
        return; // Don't apply until user clicks "Aplicar"
      } else {
        customDateRange.classList.remove('visible');
      }

      setDatePreset(period);
      state.selectedStep = 'all';
      applyFilters();
    });
  }

  // Custom date "Aplicar" button
  const btnApplyDate = document.getElementById('btnApplyDate');
  if (btnApplyDate) {
    btnApplyDate.addEventListener('click', () => {
      const dfVal = document.getElementById('dateFrom').value;
      const dtVal = document.getElementById('dateTo').value;
      if (dfVal && dtVal) {
        state.dateFrom = new Date(dfVal + 'T00:00:00');
        state.dateTo = new Date(dtVal + 'T23:59:59');
        state.activePeriod = 'custom';
        state.selectedStep = 'all';
        applyFilters();
      }
    });
  }

  // Abas de funil (dentro da aba CRM).
  // A troca de aba PRINCIPAL (CRM / VTurb / Eduzz / Pages) é responsabilidade
  // exclusiva de switchMainTab(); aqui só muda o funil selecionado.
  document.querySelectorAll('.pipeline-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pipeline-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      state.selectedStep = 'all'; // Reset stage selection when changing tabs
      state.pipelineId = btn.getAttribute('data-pipeline');
      if (elements.pipelineFilter) elements.pipelineFilter.value = state.pipelineId;

      // Sync Media Paga sub-tab with selected pipeline
      const mediaTab = PIPELINE_FUNNEL_MAP[state.pipelineId] || 'all';
      state.selectedMediaTab = mediaTab;
      const mediaBtn = document.querySelector(`.media-tab-btn[data-media-tab="${mediaTab}"]`);
      if (mediaBtn) {
        document.querySelectorAll('.media-tab-btn').forEach(b => b.classList.remove('active'));
        mediaBtn.classList.add('active');
      }

      applyFilters();
    });
  });

  // Layer click filtering & Modal trigger in Pyramid Funnel
  document.querySelectorAll('.funnel-layer').forEach(layer => {
    layer.addEventListener('click', () => {
      const step = layer.getAttribute('data-step') || 'all';
      state.selectedStep = step;
      applyFilters();
      openLeadModal(step);
    });
  });

  // Modal Close & Search Listeners
  const closeBtn = document.getElementById('closeModalBtn');
  if (closeBtn) closeBtn.onclick = closeLeadModal;

  const modalBackdrop = document.getElementById('leadDetailsModal');
  if (modalBackdrop) {
    modalBackdrop.onclick = (e) => {
      if (e.target === modalBackdrop) closeLeadModal();
    };
  }

  const modalSearchInput = document.getElementById('modalSearchInput');
  if (modalSearchInput) {
    modalSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q) {
        renderModalLeadList(currentModalStepLeads);
        return;
      }
      const filteredModalLeads = currentModalStepLeads.filter(lead => {
        const name = (lead.name || '').toLowerCase();
        const phone = (getLeadContactValue(lead, 'phone') || '').toLowerCase();
        const email = (getLeadContactValue(lead, 'email') || '').toLowerCase();
        const campaign = (getUTMValue(lead, 'campaign') || '').toLowerCase();
        const creative = (getUTMValue(lead, 'content') || '').toLowerCase();

        return name.includes(q) || phone.includes(q) || email.includes(q) || campaign.includes(q) || creative.includes(q);
      });
      renderModalLeadList(filteredModalLeads);
    });
  }

  // CSV Export Buttons
  const btnExportFiltered = document.getElementById('btnExportFilteredLeadsCsv');
  if (btnExportFiltered) {
    btnExportFiltered.addEventListener('click', () => {
      exportLeadsToCSV(state.filteredLeads);
    });
  }

  const btnExportFunnelHeader = document.getElementById('btnExportFunnelHeaderCsv');
  if (btnExportFunnelHeader) {
    btnExportFunnelHeader.addEventListener('click', () => {
      exportLeadsToCSV(state.filteredLeads);
    });
  }

  const btnExportModal = document.getElementById('btnExportModalLeadsCsv');
  if (btnExportModal) {
    btnExportModal.addEventListener('click', () => {
      const stepTitle = document.getElementById('modalStepTitle')?.innerText || 'etapa';
      const cleanTitle = stepTitle.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
      const todayStr = new Date().toISOString().split('T')[0];
      exportLeadsToCSV(currentModalStepLeads, `leads_${cleanTitle}_${todayStr}.csv`);
    });
  }
}

// switchTab() foi removida: era o sistema de abas antigo (kommoView/eduzzView),
// substituído por switchMainTab(). Ninguém a chamava, e o toggle de .active que
// ela e o handler de funil faziam no #eduzzView deixava a aba Eduzz em branco.

// Load Cached Data from API
async function loadData() {
  try {
    // Eduzz é carregado por fetchEduzzAnalytics(), que aplica o filtro de data
    const [leadsResponse, pipelinesResponse, usersResponse, fieldsResponse, vturbResponse, syncInfoResponse] = await Promise.all([
      fetch('/api/leads').then(res => res.json()),
      fetch('/api/pipelines').then(res => res.json()),
      fetch('/api/users').then(res => res.json()),
      fetch('/api/custom-fields').then(res => res.json()),
      fetch('/api/vturb-analytics').then(res => res.json()).catch(() => null),
      fetch('/api/sync-info').then(res => res.json()).catch(() => null)
    ]);

    state.leads = (leadsResponse || []).filter(l => !isTestLead(l));
    state.pipelines = pipelinesResponse || {};
    state.users = usersResponse || {};
    state.fields = fieldsResponse || [];
    buildContactSalesIndex(state.leads);

    if (vturbResponse && vturbResponse.success) {
      state.vturbData = vturbResponse;
      renderVTurbSection(vturbResponse);
    }
    
    if (elements.lastSyncDate) {
      if (syncInfoResponse && syncInfoResponse.syncInfo?.timestamp) {
        const d = new Date(syncInfoResponse.syncInfo.timestamp);
        elements.lastSyncDate.innerText = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      } else if (state.leads.length > 0) {
        const maxLeadTime = Math.max(...state.leads.map(l => l.created_at || 0));
        elements.lastSyncDate.innerText = maxLeadTime > 0 
          ? new Date(maxLeadTime * 1000).toLocaleDateString('pt-BR') + ' ' + new Date(maxLeadTime * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
          : 'Nunca sincronizado';
      } else {
        elements.lastSyncDate.innerText = 'Nunca sincronizado';
      }
    }

    populateFilters();
    
    // Smart initial preset: if current month has 0 leads in CRM, default to 'last_month' (July) so dashboard opens with active data
    const nowSecs = Math.floor(Date.now() / 1000);
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const startOfMonthSecs = Math.floor(startOfMonth.getTime() / 1000);
    const currentMonthLeads = state.leads.filter(l =>
      FUNIS_COMERCIAIS.includes(l.pipeline_id) && l.created_at >= startOfMonthSecs && l.created_at <= nowSecs
    );

    if (currentMonthLeads.length > 0) {
      setDatePreset('this_month');
    } else {
      const pillsContainer = document.getElementById('datePills');
      if (pillsContainer) {
        pillsContainer.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
        const lastMonthBtn = pillsContainer.querySelector('.pill-btn[data-period="last_month"]');
        if (lastMonthBtn) lastMonthBtn.classList.add('active');
      }
      setDatePreset('last_month');
    }

    // applyFilters() dispara fetchEduzzAnalytics(), que renderiza a aba Eduzz
    applyFilters();
  } catch (error) {
    console.error('Error loading dashboard data:', error);
    showToast('❌ Erro ao carregar dados do servidor local.', 'danger');
  }
}

// Populate Filter Dropdowns
function populateFilters() {
  // 1. Populate Pipelines
  elements.pipelineFilter.innerHTML = '<option value="all">Todos os Funis</option>';
  const pipelinesList = state.pipelines._embedded?.pipelines || [];
  pipelinesList.forEach(p => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.name;
    elements.pipelineFilter.appendChild(option);
  });

  // 2. Populate Owners
  elements.ownerFilter.innerHTML = '<option value="all">Todo o Time</option>';
  const usersList = state.users._embedded?.users || [];
  usersList.forEach(u => {
    const option = document.createElement('option');
    option.value = u.id;
    option.textContent = u.name;
    elements.ownerFilter.appendChild(option);
  });
}

// Update Marketing Table Headers and Titles based on selected grouping
function updateMarketingLabels() {
  const mapLabels = {
    campaign: { title: 'Campanha', col: 'Campanha (utm_campaign)' },
    source: { title: 'Origem', col: 'Origem (utm_source)' },
    medium: { title: 'Mídia', col: 'Mídia (utm_medium)' },
    content: { title: 'Conteúdo', col: 'Conteúdo (utm_content)' },
    term: { title: 'Termo', col: 'Termo (utm_term)' }
  };
  
  const current = mapLabels[state.marketingGroup];
  elements.mktChartTitle.innerText = `Origem por ${current.title} (Top 7)`;
  elements.mktTableTitle.innerText = `Desempenho por ${current.title}`;
  elements.thMarketingName.innerText = current.col;
}

// Extract UTM values dynamically
function getMarketingValue(lead, groupType) {
  const fieldIdMap = {
    campaign: 110086,
    source: 110088,
    medium: 110084,
    content: 110082,
    term: 110090
  };
  
  const targetId = fieldIdMap[groupType];
  const targetCode = 'UTM_' + groupType.toUpperCase();
  
  if (!lead.custom_fields_values) return 'Orgânico/Direto';
  const field = lead.custom_fields_values.find(cf => cf.field_id === targetId || cf.field_code === targetCode || (cf.field_name && cf.field_name.toLowerCase().includes('utm_' + groupType)));
  if (field && field.values && field.values[0] && field.values[0].value) {
    let val = String(field.values[0].value).trim();
    if (val.includes('|')) {
      val = val.split('|')[0];
    }

    try {
      val = decodeURIComponent(val.replace(/\+/g, ' '));
    } catch(e) {
      val = val.replace(/\+/g, ' ');
    }
    
    if (groupType === 'campaign' && val.includes('LF_EBOOK')) {
      return 'LF_EBOOK-PAGO-VENDAS-CADASTRO-IG-F-ADV';
    }
    
    return val || 'Orgânico/Direto';
  }
  return 'Orgânico/Direto';
}

// Alias for getMarketingValue
function getUTMValue(lead, groupType) {
  return getMarketingValue(lead, groupType);
}

// Extract generic Custom Field text value by ID
function getCustomFieldValue(lead, fieldId) {
  if (!lead.custom_fields_values) return null;
  const field = lead.custom_fields_values.find(cf => cf.field_id === fieldId);
  if (field && field.values && field.values[0] && field.values[0].value) {
    return field.values[0].value.trim();
  }
  return null;
}

// Helper to normalize variant key (1 to 6)
function normalizeVariantKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const match = s.match(/(?:ab[_\s:]*|var(?:ia[çc][ãa]o|iante)?[_\s:]*|v)?([1-6])/i);
  if (match && match[1]) return match[1];
  return null;
}

// Extract A/B Variant value from Custom Fields (ID 494249) or Tags
function getLeadAbVariant(lead) {
  if (!lead) return null;
  const cfs = lead.custom_fields_values || [];
  const abField = cfs.find(f => f.field_id === 494249 || f.field_code === 'AB_VARIANT' || String(f.field_name || '').toLowerCase().includes('variante') || String(f.field_name || '').toLowerCase().includes('ab_variant'));
  if (abField && abField.values && abField.values[0] && abField.values[0].value) {
    const norm = normalizeVariantKey(abField.values[0].value);
    if (norm) return norm;
  }
  const tags = (lead._embedded?.tags || []).map(t => t.name || '');
  for (const t of tags) {
    const norm = normalizeVariantKey(t);
    if (norm) return norm;
  }
  return null;
}

// Map pipeline status IDs to names
function getStatusName(statusId, pipelineId) {
  if (statusId === 142) return 'Venda ganha';
  if (statusId === 143) return 'Venda perdida';

  const pipelinesList = state.pipelines._embedded?.pipelines || [];
  
  if (pipelineId && pipelineId !== 'all') {
    const pipe = pipelinesList.find(p => p.id === parseInt(pipelineId));
    if (pipe) {
      const status = pipe._embedded?.statuses?.find(s => s.id === parseInt(statusId));
      if (status) return status.name;
    }
  }

  for (const pipe of pipelinesList) {
    const status = pipe._embedded?.statuses?.find(s => s.id === parseInt(statusId));
    if (status) return status.name;
  }

  return `Etapa #${statusId}`;
}

// Get User Name by ID
function getUserName(userId) {
  const usersList = state.users._embedded?.users || [];
  const user = usersList.find(u => u.id === parseInt(userId));
  return user ? user.name : `Usuário #${userId}`;
}

// Map pipeline IDs to names
function getPipelineName(pipelineId) {
  if (!pipelineId || pipelineId === 'all') return 'Todos os Funis';
  if (parseInt(pipelineId) === 14008652) return 'MLFP Leads Antigos (Repescagem)';
  const pipelinesList = state.pipelines._embedded?.pipelines || [];
  const pipe = pipelinesList.find(p => p.id === parseInt(pipelineId));
  return pipe ? pipe.name : `Funil #${pipelineId}`;
}

// Apply Filters to Leads list
function applyFilters() {
  let filtered = state.leads.filter(l => !isTestLead(l));

  // 1. Pipeline Filter
  if (state.pipelineId && state.pipelineId !== 'all') {
    const pipeList = String(state.pipelineId).split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n));
    if (pipeList.length === 1 && pipeList[0] === PIPELINES.MLFP) {
      // Aba MLFP Inbound: desconsidera estritamente qualquer lead que foi para a repescagem
      filtered = filtered.filter(lead => lead.pipeline_id === PIPELINES.MLFP && !isRepescagemLead(lead));
    } else if (pipeList.length === 1 && pipeList[0] === PIPELINES.MLFP_ANTIGOS) {
      // Aba MLFP Leads Antigos (Repescagem): reúne os leads de repescagem
      filtered = state.leads.filter(lead => !isTestLead(lead) && (lead.pipeline_id === PIPELINES.MLFP_ANTIGOS || isRepescagemLead(lead)));
    } else {
      filtered = filtered.filter(lead => pipeList.includes(lead.pipeline_id));
    }
  } else {
    // "Todos os Funis" = apenas funis comerciais de captação Inbound.
    // Exclui Base de Clientes (registro de pagamento), Leads Antigos e qualquer lead que foi para Repescagem.
    filtered = filtered.filter(lead => FUNIS_COMERCIAIS.includes(lead.pipeline_id) && !isRepescagemLead(lead));
  }

  // 2. Owner Filter
  if (state.ownerId !== 'all') {
    const oId = parseInt(state.ownerId);
    filtered = filtered.filter(lead => lead.responsible_user_id === oId);
  }

  // 3. Period Filter (date range)
  if (state.dateFrom && state.dateTo) {
    const fromSecs = Math.floor(state.dateFrom.getTime() / 1000);
    const toSecs = Math.floor(state.dateTo.getTime() / 1000);
    filtered = filtered.filter(lead => lead.created_at >= fromSecs && lead.created_at <= toSecs);
  } else if (state.dateFrom) {
    const fromSecs = Math.floor(state.dateFrom.getTime() / 1000);
    filtered = filtered.filter(lead => lead.created_at >= fromSecs);
  }

  // Calculate funnel step counts on base filtered set
  const baseFiltered = [...filtered];
  updateGraphicFunnel(baseFiltered);
  renderCampaignRankings(baseFiltered);

  // 4. Step Filter (if user clicked on a specific funnel stage layer)
  if (state.selectedStep && state.selectedStep !== 'all') {
    filtered = filtered.filter(lead => FUNNEL.matchesStep(lead, state.selectedStep));
  }

  state.filteredLeads = filtered;

  // Update export leads count badge
  const exportCountEl = document.getElementById('exportLeadsCount');
  if (exportCountEl) {
    exportCountEl.innerText = state.filteredLeads.length;
  }
  
  // Update UI Elements
  renderFunnelChart();
  renderCampaignChart();
  renderQualificationCharts();
  renderCampaignTable();
  renderTeamPerformance();

  // Load Meta Ads insights for the selected date range
  loadMetaAdsInsights();

  // Eduzz também respeita o período selecionado (no-op se o range não mudou)
  fetchEduzzAnalytics();

  // Pages analytics também respeita o período selecionado
  if (state.activeMainTab === 'pages' || pagesSegueFiltroGlobal) {
    loadPageAnalytics();
  }
}

// Render Graphic Pyramid Funnel
function updateGraphicFunnel(baseLeads = state.filteredLeads) {
  const total = baseLeads.length;
  
  let mqlCount = 0;
  let agendadaCount = 0;
  let noShowCount = 0;
  let realizadaCount = 0;
  let followUpCount = 0;
  let downsellCount = 0;
  let wonCount = 0;
  let wonRevenue = 0;

  baseLeads.forEach(lead => {
    const e = FUNNEL.evaluate(lead);

    if (e.isWon) {
      wonCount++;
      wonRevenue += e.revenue;
    }
    if (e.isMql) mqlCount++;
    if (e.isEngajado) agendadaCount++;
    if (e.isNoShow) noShowCount++;
    if (e.isAvancado) realizadaCount++;
    if (e.isEmEspera) followUpCount++;
    if (e.isDownsell) downsellCount++;
  });

  const mqlRate = total > 0 ? ((mqlCount / total) * 100).toFixed(1) : '0.0';
  const agendadaRate = mqlCount > 0 ? ((agendadaCount / mqlCount) * 100).toFixed(1) : '0.0';
  const noShowRate = agendadaCount > 0 ? ((noShowCount / agendadaCount) * 100).toFixed(1) : '0.0';
  const realizadaRate = agendadaCount > 0 ? ((realizadaCount / agendadaCount) * 100).toFixed(1) : '0.0';
  const wonRate = realizadaCount > 0 ? ((wonCount / realizadaCount) * 100).toFixed(1) : '0.0';

  const elLeads = document.getElementById('pyramidLeadsCount');
  const elMql = document.getElementById('pyramidMqlCount');
  const elMqlPct = document.getElementById('pyramidMqlPct');
  const elAgendada = document.getElementById('pyramidAgendadaCount');
  const elAgendadaPct = document.getElementById('pyramidAgendadaPct');
  const elNoShow = document.getElementById('pyramidNoShowCount');
  const elNoShowPct = document.getElementById('pyramidNoShowPct');
  const elRealizada = document.getElementById('pyramidRealizadaCount');
  const elRealizadaPct = document.getElementById('pyramidRealizadaPct');
  const elFollowUp = document.getElementById('pyramidFollowUpCount');
  const elFollowUpPct = document.getElementById('pyramidFollowUpPct');
  const elDownsell = document.getElementById('pyramidDownsellCount');
  const elDownsellPct = document.getElementById('pyramidDownsellPct');
  const elWon = document.getElementById('pyramidWonCount');
  const elWonRev = document.getElementById('pyramidWonRevenue');

  if (elLeads) elLeads.innerText = total.toLocaleString('pt-BR');
  if (elMql) elMql.innerText = mqlCount.toLocaleString('pt-BR');
  if (elMqlPct) elMqlPct.innerText = `${mqlRate}% do total`;
  
  // Rótulos seguem o tipo do funil selecionado: um funil sem reunião
  // não pode exibir "Reuniões Agendadas"
  const rot = ROTULOS_FUNIL[FUNNEL.tipoAtual(state.pipelineId)] || ROTULOS_FUNIL.misto;
  const setLabel = (step, texto) => {
    const el = document.querySelector(`.funnel-layer[data-step="${step}"] .layer-title`);
    if (el) el.innerHTML = texto;
  };
  setLabel('followup', rot.espera);
  setLabel('agendada', rot.engajado);
  setLabel('realizada', rot.avancado);

  if (elAgendada) elAgendada.innerText = agendadaCount.toLocaleString('pt-BR');
  if (elAgendadaPct) elAgendadaPct.innerText = `${agendadaRate}% ${rot.subEngajado}`;

  // Ramo de No Show só existe em funil com reunião
  const noShowLayer = document.querySelector('.funnel-layer[data-step="noshow"]');
  if (noShowLayer) {
    const row = noShowLayer.closest('.funnel-branch-row') || noShowLayer;
    row.style.display = rot.mostrarNoShow ? '' : 'none';
  }
  if (elNoShow) elNoShow.innerText = noShowCount.toLocaleString('pt-BR');
  if (elNoShowPct) elNoShowPct.innerText = `${noShowRate}% ausência`;

  if (elRealizada) elRealizada.innerText = realizadaCount.toLocaleString('pt-BR');
  if (elRealizadaPct) elRealizadaPct.innerText = `${realizadaRate}% ${rot.subAvancado}`;

  if (elFollowUp) elFollowUp.innerText = followUpCount.toLocaleString('pt-BR');
  if (elFollowUpPct) elFollowUpPct.innerText = `${((followUpCount / (total || 1)) * 100).toFixed(1)}% das entradas`;

  if (elDownsell) elDownsell.innerText = downsellCount.toLocaleString('pt-BR');
  if (elDownsellPct) elDownsellPct.innerText = `${((downsellCount / (total || 1)) * 100).toFixed(1)}% desqualificados`;
  
  if (elWon) elWon.innerText = wonCount.toLocaleString('pt-BR');
  if (elWonRev) elWonRev.innerText = wonRevenue > 0 
    ? wonRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : `${wonRate}% conv. final`;

  // Funnel pyramid is ALWAYS visible for ALL tabs
  const graphicCard = document.querySelector('.graphic-funnel-card');
  if (graphicCard) {
    graphicCard.style.display = 'block';
  }

  const drop1 = document.getElementById('dropPct1');
  const drop2 = document.getElementById('dropPct2');
  const drop3 = document.getElementById('dropPct3');
  const drop4 = document.getElementById('dropPct4');

  if (drop1) drop1.innerText = `${mqlRate}%`;
  if (drop2) drop2.innerText = `${agendadaRate}%`;
  if (drop3) drop3.innerText = `${realizadaRate}%`;
  if (drop4) drop4.innerText = `${wonRate}%`;

  // Texto dos indicadores de queda também acompanha o tipo de funil
  const setDropLabel = (id, texto) => {
    const el = document.getElementById(id);
    const span = el && el.querySelector('span');
    const strong = el && el.querySelector('strong');
    if (span && strong) span.childNodes[0].nodeValue = texto + ' ';
  };
  setDropLabel('drop2', rot.dropEngajado);
  setDropLabel('drop3', rot.dropAvancado);

  const elTitle = document.getElementById('currentFunnelTitle');
  if (elTitle) {
    const titulos = {
      [PIPELINES.MLFP]: 'Funil Comercial & Leads — Mentoria MLFP',
      [PIPELINES.MLFP_ANTIGOS]: 'Funil Comercial & Leads — MLFP Leads Antigos (Repescagem)',
      [PIPELINES.KO_INBOUND]: 'Funil Comercial & Leads — Komando (KO Inbound)',
      [PIPELINES.KOP]: 'Funil Comercial & Leads — Komando KOP Inbound',
      [PIPELINES.KOR]: 'Funil Comercial & Leads — KOR Inbound',
      [PIPELINES.KO_EBOOKS]: 'Funil Comercial & Leads — Komando KO Ebooks',
      [PIPELINES.SOCIAL_SELLING]: 'Funil Comercial & Leads — Social Selling (Instagram)',
      [PIPELINES.RECUPERACAO]: 'Funil Comercial & Leads — Funil de Recuperação'
    };
    elTitle.innerText = titulos[state.pipelineId] || 'Funil Comercial & Leads — Todos os Funis Comerciais';
  }

  const elSub = document.getElementById('currentFunnelSub');
  if (elSub) {
    const subs = {
      reuniao: 'Fluxo: Captura ➔ Follow Up ➔ MQL / Downsell ➔ Agendamento ➔ (No Show) ➔ Reunião ➔ Fechamento',
      negociacao: 'Fluxo: Captura ➔ MQL ➔ Contato Iniciado ➔ Negociação / Oferta ➔ Fechamento (funil sem reunião)',
      recuperacao: 'Fluxo: Pagamento Pendente (Boleto / Pix / Carrinho) ➔ Contato ➔ Negociação ➔ Venda Recuperada',
      misto: 'Visão consolidada de funis com semânticas diferentes — etapas exibidas de forma genérica'
    };
    elSub.innerText = subs[FUNNEL.tipoAtual(state.pipelineId)] || subs.misto;
  }
}

if (!state.rankingType) state.rankingType = 'campaign';

function switchRankingType(type) {
  state.rankingType = type;
  const btnCampaigns = document.getElementById('btnRankCampaigns');
  const btnCreatives = document.getElementById('btnRankCreatives');
  
  if (btnCampaigns && btnCreatives) {
    if (type === 'campaign') {
      btnCampaigns.classList.add('active');
      btnCreatives.classList.remove('active');
    } else {
      btnCreatives.classList.add('active');
      btnCampaigns.classList.remove('active');
    }
  }
  
  renderCampaignRankings();
}

// Render 6 Direct Campaign / Creative Ranking Lists
function renderCampaignRankings(baseLeads = state.filteredLeads) {
  const groupType = state.rankingType === 'creative' ? 'content' : 'campaign';
  const defaultLabel = state.rankingType === 'creative' ? 'Direto / Sem Criativo' : 'Direto / Sem UTM';

  const campaignMap = {};

  baseLeads.forEach(lead => {
    let cleanVal = getUTMValue(lead, groupType) || defaultLabel;
    
    if (!campaignMap[cleanVal]) {
      campaignMap[cleanVal] = { leads: 0, mql: 0, agendada: 0, noShow: 0, realizada: 0, followUp: 0, downsell: 0, won: 0 };
    }

    campaignMap[cleanVal].leads++;

    const e = FUNNEL.evaluate(lead);
    if (e.isMql) campaignMap[cleanVal].mql++;
    if (e.isEngajado) campaignMap[cleanVal].agendada++;
    if (e.isNoShow) campaignMap[cleanVal].noShow++;
    if (e.isAvancado) campaignMap[cleanVal].realizada++;
    if (e.isEmEspera) campaignMap[cleanVal].followUp++;
    if (e.isDownsell) campaignMap[cleanVal].downsell++;
    if (e.isWon) campaignMap[cleanVal].won++;
  });

  const itemsArray = Object.keys(campaignMap).map(name => ({
    name,
    ...campaignMap[name]
  }));

  function renderList(elementId, sortKey, unitLabel, stepKey) {
    const listEl = document.getElementById(elementId);
    if (!listEl) return;

    const sorted = [...itemsArray].sort((a, b) => b[sortKey] - a[sortKey]).slice(0, 5);
    if (sorted.length === 0 || sorted[0][sortKey] === 0) {
      listEl.innerHTML = '<li class="text-muted text-center py-2" style="font-size:0.8rem;">Nenhum lead nesta etapa</li>';
      return;
    }

    const itemType = state.rankingType || 'campaign';

    // Nome da campanha vai em data-attribute, não dentro de onclick="".
    // Nomes de campanha vêm do CRM e podem conter aspas, < ou > — no onclick
    // isso quebrava o handler e corrompia a lista.
    listEl.innerHTML = sorted.map(item => `
        <li class="ranking-item clickable-rank-item"
            data-step="${escapeHTML(stepKey)}"
            data-tipo="${escapeHTML(itemType)}"
            data-valor="${escapeHTML(item.name)}"
            title="Clique para ver os ${item[sortKey]} leads e o nome completo">
          <span class="ranking-item-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</span>
          <span class="ranking-item-val">${item[sortKey].toLocaleString('pt-BR')} ${escapeHTML(unitLabel)}</span>
        </li>
      `).join('');

    if (!listEl.dataset.delegado) {
      listEl.dataset.delegado = '1';
      listEl.addEventListener('click', e => {
        const li = e.target.closest('.clickable-rank-item');
        if (!li) return;
        openLeadModal(li.dataset.step, li.dataset.tipo, li.dataset.valor);
      });
    }
  }

  renderList('rankLeadsList', 'leads', 'leads', 'all');
  renderList('rankMqlList', 'mql', 'MQLs', 'mql');
  renderList('rankAgendadaList', 'agendada', 'agendadas', 'agendada');
  renderList('rankRealizadaList', 'realizada', 'feitas', 'realizada');
  renderList('rankFollowUpList', 'followUp', 'follow-ups', 'followup');
  renderList('rankDownsellList', 'downsell', 'downsells', 'downsell');
}

// Modal Lead Details Functions
let currentModalStepLeads = [];

function openLeadModal(stepKey, filterType = null, filterValue = null) {
  const modal = document.getElementById('leadDetailsModal');
  if (!modal) return;

  let baseLeads = [...state.leads];

  if (state.pipelineId && state.pipelineId !== 'all') {
    const pipeList = String(state.pipelineId).split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n));
    baseLeads = baseLeads.filter(lead => pipeList.includes(lead.pipeline_id));
  } else {
    baseLeads = baseLeads.filter(lead => FUNIS_COMERCIAIS.includes(lead.pipeline_id));
  }
  if (state.ownerId !== 'all') {
    const oId = parseInt(state.ownerId);
    baseLeads = baseLeads.filter(lead => lead.responsible_user_id === oId);
  }
  if (state.dateFrom && state.dateTo) {
    const fromSecs = Math.floor(state.dateFrom.getTime() / 1000);
    const toSecs = Math.floor(state.dateTo.getTime() / 1000);
    baseLeads = baseLeads.filter(lead => lead.created_at >= fromSecs && lead.created_at <= toSecs);
  } else if (state.dateFrom) {
    const fromSecs = Math.floor(state.dateFrom.getTime() / 1000);
    baseLeads = baseLeads.filter(lead => lead.created_at >= fromSecs);
  }

  let stepLeads = baseLeads.filter(lead => FUNNEL.matchesStep(lead, stepKey));

  // Filter by specific campaign or creative if passed
  if (filterType && filterValue) {
    const groupType = filterType === 'creative' ? 'content' : 'campaign';
    stepLeads = stepLeads.filter(lead => {
      const val = getUTMValue(lead, groupType);
      return val === filterValue || (filterValue.includes('Sem ') && val.includes('Sem '));
    });
  }

  currentModalStepLeads = stepLeads;

  // Títulos do modal seguem o mesmo tipo de funil da pirâmide
  const tipo = FUNNEL.tipoAtual(state.pipelineId);
  const porTipo = {
    reuniao: {
      followup: 'Follow Up (Primeiros Contatos Sem Resposta)',
      agendada: '3. Reuniões Agendadas (Confirmadas pelo SDR)',
      realizada: '4. Reuniões Realizadas (Show-Up Closer)'
    },
    negociacao: {
      followup: 'Aguardando Retorno',
      agendada: '3. Contato Iniciado',
      realizada: '4. Em Negociação / Oferta Feita'
    },
    recuperacao: {
      followup: 'Pagamento Pendente (Boleto / Pix / Carrinho)',
      agendada: '3. Contato Iniciado',
      realizada: '4. Em Negociação'
    },
    misto: {
      followup: 'Aguardando Retorno / Follow Up',
      agendada: '3. Contato Ativo (Reunião ou Negociação Iniciada)',
      realizada: '4. Estágio Avançado'
    }
  };
  const t = porTipo[tipo] || porTipo.misto;

  const stepTitles = {
    all: { title: '1. Entradas na Base (Todos os Leads)', icon: '📥' },
    followup: { title: t.followup, icon: '⏳' },
    mql: { title: '2. Qualificados (MQL)', icon: '🔥' },
    downsell: { title: 'Downsell (Leads Desqualificados)', icon: '🔄' },
    agendada: { title: t.agendada, icon: '📅' },
    noshow: { title: 'No Show (Ausências na Reunião)', icon: '⚠️' },
    realizada: { title: t.realizada, icon: '🤝' },
    won: { title: '5. Vendas Ganhas', icon: '🏆' }
  };

  const info = stepTitles[stepKey] || { title: 'Leads na Etapa', icon: '🔍' };
  let fullTitle = info.title;
  let fullSub = 'Exibindo leads individuais correspondentes a esta etapa do funil';

  if (filterType && filterValue) {
    const labelType = filterType === 'creative' ? 'Criativo' : 'Campanha';
    const cleanStepName = info.title.split('(')[0].replace(/^[0-9.]+\s*/, '').trim();
    fullTitle = `${cleanStepName} — ${labelType}: ${filterValue}`;
    fullSub = `Filtrado especificamente por ${labelType.toLowerCase()}: "${filterValue}" (${stepLeads.length} leads encontrados)`;
  }

  document.getElementById('modalStepTitle').innerText = fullTitle;
  document.getElementById('modalStepIcon').innerText = filterType ? (filterType === 'creative' ? '🎨' : '📢') : info.icon;
  document.getElementById('modalStepSubtitle').innerText = fullSub;
  document.getElementById('modalLeadCount').innerText = `${stepLeads.length} leads`;
  document.getElementById('modalSearchInput').value = '';

  // Clean up any old ad library button if present
  let existingAdBtn = document.getElementById('modalAdLibraryBtn');
  if (existingAdBtn) existingAdBtn.remove();

  renderModalLeadList(stepLeads);

  modal.style.display = 'flex';
}

function closeLeadModal() {
  const modal = document.getElementById('leadDetailsModal');
  if (modal) modal.style.display = 'none';
}

function getLeadSDR(lead) {
  const cfs = lead.custom_fields_values || [];
  const sdrField = cfs.find(f => f.field_id === 491903 || (f.field_name && f.field_name.toUpperCase() === 'SDR'));
  if (sdrField && sdrField.values && sdrField.values[0] && sdrField.values[0].value) {
    return String(sdrField.values[0].value).trim();
  }
  return getUserName(lead.responsible_user_id) || 'Sem SDR';
}

function getLeadCloser(lead) {
  const cfs = lead.custom_fields_values || [];
  const closerField = cfs.find(f => f.field_id === 491901 || (f.field_name && f.field_name.toUpperCase() === 'CLOSER'));
  if (closerField && closerField.values && closerField.values[0] && closerField.values[0].value) {
    return String(closerField.values[0].value).trim();
  }
  return getUserName(lead.responsible_user_id) || 'Sem Closer';
}

if (!state.contactsCache) state.contactsCache = {};

function getLeadContactValue(lead, type) {
  const contacts = lead._embedded?.contacts || [];
  let contactId = null;
  if (contacts.length > 0) {
    contactId = contacts[0].id || contacts[0];
  }

  const cached = contactId ? state.contactsCache[contactId] : null;

  if (cached) {
    if (type === 'name' && cached.name) return cached.name;
    if (type === 'phone' && cached.phone) return cached.phone;
    if (type === 'email' && cached.email) return cached.email;
  }

  if (contacts.length > 0) {
    const c = contacts[0];
    if (type === 'name' && c.name) return c.name;
    if (type === 'phone') {
      const p = c.phone || (c.custom_fields_values || []).find(f => f.field_code === 'PHONE' || f.field_id === 110074 || f.field_id === 110080 || String(f.field_name || '').toLowerCase().includes('tel') || String(f.field_name || '').toLowerCase().includes('phone') || String(f.field_name || '').toLowerCase().includes('whats'))?.values?.[0]?.value;
      if (p) return p;
    }
    if (type === 'email') {
      const em = c.email || (c.custom_fields_values || []).find(f => f.field_code === 'EMAIL' || f.field_id === 110076 || String(f.field_name || '').toLowerCase().includes('mail'))?.values?.[0]?.value;
      if (em) return em;
    }
  }

  // Fallback: check custom fields on the lead itself!
  const leadCfs = lead.custom_fields_values || [];
  if (type === 'phone') {
    const pLead = leadCfs.find(f => f.field_code === 'PHONE' || f.field_id === 110074 || f.field_id === 110080 || String(f.field_name || '').toLowerCase().includes('tel') || String(f.field_name || '').toLowerCase().includes('phone') || String(f.field_name || '').toLowerCase().includes('whats'))?.values?.[0]?.value;
    if (pLead) return pLead;
  }
  if (type === 'email') {
    const emLead = leadCfs.find(f => f.field_code === 'EMAIL' || f.field_id === 110076 || String(f.field_name || '').toLowerCase().includes('mail'))?.values?.[0]?.value;
    if (emLead) return emLead;
  }

  return '';
}

async function fetchMissingModalContacts(leadsSlice, callback) {
  if (!leadsSlice || leadsSlice.length === 0) return;
  const missingIds = new Set();

  for (const lead of leadsSlice) {
    const contacts = lead._embedded?.contacts || [];
    if (contacts.length > 0) {
      const cId = contacts[0].id || contacts[0];
      if (cId && !state.contactsCache[cId]) {
        missingIds.add(cId);
      }
    }
  }

  if (missingIds.size === 0) return;

  try {
    const res = await fetch('/api/contacts/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds: Array.from(missingIds) })
    });
    const data = await res.json();
    if (data.success && data.contacts) {
      Object.assign(state.contactsCache, data.contacts);
      if (callback) callback();
    }
  } catch (err) {
    console.error('[Contacts Modal] Error fetching contacts batch:', err);
  }
}

function renderModalLeadList(leadsToRender) {
  const tbody = document.getElementById('modalTableBody');
  if (!tbody) return;

  if (leadsToRender.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Nenhum lead encontrado nesta etapa.</td></tr>';
    return;
  }

  const kommoDomain = 'chefkakagomes.kommo.com';
  const slice = leadsToRender.slice(0, 100);

  // Fetch missing contacts in background and update view
  fetchMissingModalContacts(slice, () => {
    // Re-render once contacts arrive
    renderModalLeadList(leadsToRender);
  });

  tbody.innerHTML = slice.map(lead => {
    const contactName = getLeadContactValue(lead, 'name');
    const phone = getLeadContactValue(lead, 'phone') || 'Sem Telefone';
    const email = getLeadContactValue(lead, 'email') || 'Sem E-mail';
    const sdrName = getLeadSDR(lead);
    const closerName = getLeadCloser(lead);
    const cleanPhone = phone.replace(/\D/g, '');
    const waLink = cleanPhone ? `https://wa.me/${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}` : '#';

    const campaign = getUTMValue(lead, 'campaign') || 'Sem UTM';
    const creative = getUTMValue(lead, 'content') || 'Sem Criativo';
    const abVariant = getLeadAbVariant(lead);
    const dateStr = lead.created_at ? new Date(lead.created_at * 1000).toLocaleDateString('pt-BR') : '-';
    const ownerName = getUserName(lead.responsible_user_id);
    const statusName = getStatusName(lead.status_id, lead.pipeline_id);
    const kommoLink = `https://${kommoDomain}/leads/detail/${lead.id}`;

    const displayName = contactName ? `${contactName}` : (lead.name || 'Lead sem nome');
    const subtitleName = contactName && lead.name && contactName !== lead.name ? `Lead: ${lead.name} · ID: ${lead.id}` : `ID: ${lead.id}`;

    const saleStatus = getLeadSaleStatus(lead);
    const saleBadgeHTML = saleStatus.isWon
      ? `<span class="badge" style="background:linear-gradient(135deg, #10b981, #059669); color:#ffffff; font-weight:800; padding:0.3rem 0.6rem; border-radius:6px; font-size:0.75rem; box-shadow:0 2px 6px rgba(16,185,129,0.35);">🏆 Venda Eduzz (${formatBRL(saleStatus.price)})</span>`
      : `<span class="badge" style="background:rgba(59,130,246,0.12); color:#2563eb; font-weight:700; padding:0.25rem 0.55rem; border-radius:6px; font-size:0.75rem;">📥 Lead Capturado</span>`;

    const abBadgeHTML = abVariant
      ? `<div style="margin-top:3px;"><span class="badge" style="background:rgba(168,85,247,0.14); color:#9333ea; font-size:0.72rem; font-weight:800; border:1px solid rgba(168,85,247,0.3);">⚡ LP: ${escapeHTML(abVariant)}</span></div>`
      : '';

    // Todo texto vindo do CRM passa por escapeHTML: nome de contato, campanha
    // e criativo são digitados por pessoas e já quebravam a tabela com aspas
    return `
      <tr>
        <td>
          <div style="font-weight:700; color:var(--color-slate-900);">${escapeHTML(displayName)}</div>
          <div style="font-size:0.75rem; color:var(--color-slate-500);">${escapeHTML(subtitleName)}</div>
        </td>
        <td>
          ${phone !== 'Sem Telefone'
            ? `<a href="${escapeHTML(waLink)}" target="_blank" rel="noopener" style="color:#10b981; font-weight:700; text-decoration:none;">📱 ${escapeHTML(phone)}</a>`
            : '<span class="text-muted">Sem telefone</span>'
          }
        </td>
        <td style="font-size:0.8rem;">${email !== 'Sem E-mail' ? `<a href="mailto:${encodeURIComponent(email)}" style="color:var(--color-primary); text-decoration:none;">📧 ${escapeHTML(email)}</a>` : '<span class="text-muted">Sem e-mail</span>'}</td>
        <td><span class="badge" style="background:rgba(59,130,246,0.12); color:#2563eb; font-size:0.75rem; font-weight:700;">📞 ${escapeHTML(sdrName)}</span></td>
        <td><span class="badge" style="background:rgba(139,92,246,0.12); color:#7c3aed; font-size:0.75rem; font-weight:700;">🤝 ${escapeHTML(closerName)}</span></td>
        <td>${saleBadgeHTML}</td>
        <td>${dateStr}</td>
        <td>
          <div style="font-weight:700; font-size:0.8rem; color:var(--color-primary);">${escapeHTML(campaign)}</div>
          <div style="font-size:0.72rem; color:var(--color-slate-500);">Criativo: <strong>${escapeHTML(creative)}</strong></div>
          ${abBadgeHTML}
        </td>
        <td>${escapeHTML(ownerName)}</td>
        <td><span class="badge" style="background:rgba(226,232,240,0.8); font-size:0.75rem;">${escapeHTML(statusName)}</span></td>
        <td class="text-center">
          <a href="${kommoLink}" target="_blank" rel="noopener" class="btn btn-sm btn-outline" style="padding:0.25rem 0.6rem; font-size:0.75rem;">🔗 CRM</a>
        </td>
      </tr>
    `;
  }).join('');
}

// Extract any custom field from lead or contact with multiple fallback IDs and keyword searches
function getLeadCustomFieldValue(lead, fieldIds = [], fieldNameKeywords = []) {
  const cfs = lead.custom_fields_values || [];
  for (const f of cfs) {
    const val = f.values?.[0]?.value;
    if (val === undefined || val === null || String(val).trim() === '') continue;
    if (fieldIds.includes(f.field_id)) return String(val).trim();
    const fName = String(f.field_name || f.name || '').toLowerCase();
    const fCode = String(f.field_code || f.code || '').toLowerCase();
    if (fieldNameKeywords.some(kw => fName.includes(kw) || fCode.includes(kw))) {
      return String(val).trim();
    }
  }

  // Also check linked cached contact custom fields
  const contacts = lead._embedded?.contacts || [];
  if (contacts.length > 0) {
    const cId = contacts[0].id || contacts[0];
    const cached = cId ? state.contactsCache?.[cId] : null;
    const contactCfs = cached?.custom_fields_values || [];
    for (const f of contactCfs) {
      const val = f.values?.[0]?.value;
      if (val === undefined || val === null || String(val).trim() === '') continue;
      if (fieldIds.includes(f.field_id)) return String(val).trim();
      const fName = String(f.field_name || f.name || '').toLowerCase();
      const fCode = String(f.field_code || f.code || '').toLowerCase();
      if (fieldNameKeywords.some(kw => fName.includes(kw) || fCode.includes(kw))) {
        return String(val).trim();
      }
    }
  }

  return '';
}

// Export filtered leads to CSV (Excel-ready with UTF-8 BOM and semicolon delimiters)
async function exportLeadsToCSV(leadsArray, customFilename = null) {
  const leadsToExport = (Array.isArray(leadsArray) && leadsArray.length > 0) ? leadsArray : state.filteredLeads;

  if (!leadsToExport || leadsToExport.length === 0) {
    alert('Nenhum lead encontrado com os filtros atuais para exportação.');
    return;
  }

  // 1. Identify missing contacts that need phone and email details
  if (!state.contactsCache) state.contactsCache = {};
  const missingContactIds = [];
  leadsToExport.forEach(lead => {
    const contacts = lead._embedded?.contacts || [];
    if (contacts.length > 0) {
      const cId = contacts[0].id || contacts[0];
      if (cId && !state.contactsCache[cId]) {
        missingContactIds.push(cId);
      }
    }
  });

  // 2. Pre-fetch missing contact details in batch before CSV compilation
  const btn = document.getElementById('btnExportFilteredLeadsCsv');
  const btnAlt = document.getElementById('btnExportFunnelHeaderCsv');
  const btnModal = document.getElementById('btnExportModalLeadsCsv');
  const activeBtn = btn || btnAlt || btnModal;
  const originalBtnHTML = activeBtn ? activeBtn.innerHTML : '';

  if (missingContactIds.length > 0) {
    if (activeBtn) {
      activeBtn.innerHTML = `<span>⏳ Carregando telefones (${missingContactIds.length})...</span>`;
      activeBtn.disabled = true;
    }

    try {
      const batchSize = 200;
      for (let i = 0; i < missingContactIds.length; i += batchSize) {
        const chunk = missingContactIds.slice(i, i + batchSize);
        if (activeBtn) {
          activeBtn.innerHTML = `<span>⏳ Carregando telefones (${Math.min(i + batchSize, missingContactIds.length)}/${missingContactIds.length})...</span>`;
        }
        const res = await fetch('/api/contacts/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactIds: chunk })
        });
        const data = await res.json();
        if (data.success && data.contacts) {
          Object.assign(state.contactsCache, data.contacts);
        }
      }
    } catch (err) {
      console.error('[Export CSV] Error batch fetching contacts:', err);
    } finally {
      if (activeBtn) {
        activeBtn.innerHTML = originalBtnHTML;
        activeBtn.disabled = false;
      }
    }
  }

  const kommoDomain = 'chefkakagomes.kommo.com';

  // CSV Columns Header
  const headers = [
    'ID Lead CRM',
    'Nome do Lead',
    'Nome do Contato',
    'Telefone / WhatsApp',
    'Link WhatsApp (wa.me)',
    'E-mail',
    'Funil / Pipeline',
    'Etapa do Funil (Status)',
    'Qualificação (MQL)',
    'Valor do Lead (R$)',
    'Venda Eduzz Confirmada',
    'Valor Venda Eduzz (R$)',
    'Data de Criação',
    'SDR',
    'Closer',
    'Responsável CRM',
    'Cargo / Perfil',
    'Faturamento Médio',
    'Tamanho da Equipe',
    'Maior Gargalo',
    'Possui Líder Operacional',
    'Possui Sócios',
    'Instagram',
    'Variante A/B (LP)',
    'Tags',
    'UTM Campanha (utm_campaign)',
    'UTM Origem (utm_source)',
    'UTM Mídia (utm_medium)',
    'UTM Conteúdo (utm_content)',
    'UTM Termo (utm_term)',
    'Link Direto Kommo CRM'
  ];

  // Helper to escape CSV values
  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = leadsToExport.map(lead => {
    const contactName = getLeadContactValue(lead, 'name');
    const phone = getLeadContactValue(lead, 'phone');
    const email = getLeadContactValue(lead, 'email');
    const sdrName = getLeadSDR(lead);
    const closerName = getLeadCloser(lead);
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    const waLink = cleanPhone ? `https://wa.me/${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}` : '';

    const campaign = getUTMValue(lead, 'campaign');
    const source = getUTMValue(lead, 'source');
    const medium = getUTMValue(lead, 'medium');
    const content = getUTMValue(lead, 'content');
    const term = getUTMValue(lead, 'term');
    const abVariant = getLeadAbVariant(lead);
    const dateStr = lead.created_at ? new Date(lead.created_at * 1000).toLocaleString('pt-BR') : '';
    const ownerName = getUserName(lead.responsible_user_id);
    const statusName = getStatusName(lead.status_id, lead.pipeline_id);
    const pipelineName = getPipelineName(lead.pipeline_id);
    const kommoLink = `https://${kommoDomain}/leads/detail/${lead.id}`;

    const tags = (lead._embedded?.tags || []).map(t => t.name);
    const isMql = FUNNEL.matchesStep(lead, 'mql');
    const saleStatus = getLeadSaleStatus(lead);

    const cargo = getLeadCustomFieldValue(lead, [128884, 128474], ['cargo', 'perfil']);
    const faturamento = getLeadCustomFieldValue(lead, [128886, 128476], ['faturamento', 'renda']);
    const equipe = getLeadCustomFieldValue(lead, [492035], ['equipe', 'time', 'colaborador']);
    const gargalo = getLeadCustomFieldValue(lead, [492037], ['gargalo', 'desafio']);
    const lider = getLeadCustomFieldValue(lead, [492039], ['lider', 'líder']);
    const socios = getLeadCustomFieldValue(lead, [128888], ['socio']);
    const instagram = getLeadCustomFieldValue(lead, [311994], ['instagram']);

    return [
      lead.id,
      contactName ? `${contactName} (${lead.name || ''})` : (lead.name || ''),
      contactName || '',
      phone || '',
      waLink || '',
      email || '',
      pipelineName || '',
      statusName || '',
      isMql ? 'Sim (MQL)' : 'Não',
      lead.price || 0,
      saleStatus.isWon ? 'Sim' : 'Não',
      saleStatus.price || 0,
      dateStr,
      sdrName || '',
      closerName || '',
      ownerName || '',
      cargo || '',
      faturamento || '',
      equipe || '',
      gargalo || '',
      lider || '',
      socios || '',
      instagram || '',
      abVariant || '',
      tags.join('; '),
      campaign || '',
      source || '',
      medium || '',
      content || '',
      term || '',
      kommoLink
    ].map(escapeCSV).join(';');
  });

  // UTF-8 BOM (\uFEFF) ensures Excel opens Latin/Portuguese accents properly
  const csvContent = '\uFEFF' + headers.map(escapeCSV).join(';') + '\n' + rows.join('\n');

  // Dynamic filename
  let filename = customFilename;
  if (!filename) {
    const todayStr = new Date().toISOString().split('T')[0];
    const pipeName = getPipelineName(state.pipelineId) || 'todos_os_funis';
    const cleanPipe = pipeName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    filename = `leads_crm_${cleanPipe}_${todayStr}.csv`;
  }

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}


// Render Sales Funnel / Progression Chart
function renderFunnelChart() {
  const ctx = document.getElementById('funnelChart').getContext('2d');
  
  if (state.funnelChart) {
    state.funnelChart.destroy();
  }

  let labels = [];
  let dataValues = [];
  let colors = [];

  const pipelinesList = state.pipelines._embedded?.pipelines || [];

  if (state.pipelineId !== 'all') {
    const pipe = pipelinesList.find(p => p.id === parseInt(state.pipelineId));
    if (pipe && pipe._embedded && pipe._embedded.statuses) {
      const statuses = pipe._embedded.statuses;
      
      statuses.forEach(status => {
        labels.push(status.name);
        const count = state.filteredLeads.filter(l => l.status_id === status.id).length;
        dataValues.push(count);
        colors.push(status.color || orangeColors.primary);
      });
    }
  } else {
    // Show distribution by Pipeline
    pipelinesList.forEach(pipe => {
      labels.push(pipe.name);
      const count = state.filteredLeads.filter(l => l.pipeline_id === pipe.id).length;
      dataValues.push(count);
      colors.push(orangeColors.primary);
    });
    
    labels.push('Vendas Ganhas (Geral)');
    const wonCount = state.filteredLeads.filter(l => l.status_id === 142).length;
    dataValues.push(wonCount);
    colors.push(orangeColors.success);

    labels.push('Vendas Perdidas (Geral)');
    const lostCount = state.filteredLeads.filter(l => l.status_id === 143).length;
    dataValues.push(lostCount);
    colors.push(orangeColors.danger);
  }

  state.funnelChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Quantidade de Leads',
        data: dataValues,
        backgroundColor: colors.map(c => adjustColorOpacity(c, 0.7)),
        borderColor: colors,
        borderWidth: 1.5,
        borderRadius: 6,
        barPercentage: 0.6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0f172a',
          bodyColor: '#334155',
          titleFont: { family: 'Outfit', size: 13, weight: 'bold' },
          bodyFont: { family: 'Plus Jakarta Sans', size: 12 },
          borderColor: '#e2e8f0',
          borderWidth: 1,
          padding: 10,
          displayColors: false
        }
      },
      scales: {
        x: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 11 } }
        },
        y: {
          grid: { display: false },
          ticks: { color: '#0f172a', font: { family: 'Plus Jakarta Sans', size: 11, weight: '600' } }
        }
      }
    }
  });
}

// Render Marketing Share Chart (Top 7 UTM parameter values)
function renderCampaignChart() {
  const ctx = document.getElementById('campaignChart').getContext('2d');
  
  if (state.campaignChart) {
    state.campaignChart.destroy();
  }

  const mktCounts = {};
  state.filteredLeads.forEach(lead => {
    const val = getMarketingValue(lead, state.marketingGroup);
    mktCounts[val] = (mktCounts[val] || 0) + 1;
  });

  const sorted = Object.entries(mktCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7);

  const labels = sorted.map(x => x[0]);
  const dataValues = sorted.map(x => x[1]);

  const backgroundColors = orangeColors.palette.slice(0, sorted.length).map(c => adjustColorOpacity(c, 0.85));

  state.campaignChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: dataValues,
        backgroundColor: backgroundColors,
        borderColor: '#ffffff',
        borderWidth: 2,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: {
            color: '#334155',
            font: { family: 'Plus Jakarta Sans', size: 10 },
            boxWidth: 12,
            padding: 12
          }
        },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0f172a',
          bodyColor: '#334155',
          titleFont: { family: 'Outfit', size: 13, weight: 'bold' },
          bodyFont: { family: 'Plus Jakarta Sans', size: 12 },
          borderColor: '#e2e8f0',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: function(context) {
              const val = context.raw;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((val / total) * 100).toFixed(1);
              return ` ${val} leads (${pct}%)`;
            }
          }
        }
      },
      cutout: '65%'
    }
  });
}

// Render Qualification (Cargo & Faturamento) Charts
function renderQualificationCharts() {
  // 1. Cargo Chart ("Qual é o seu cargo?" - ID 128884)
  const cargoCtx = document.getElementById('cargoChart').getContext('2d');
  if (state.cargoChart) state.cargoChart.destroy();
  
  const cargoCounts = {};
  state.filteredLeads.forEach(lead => {
    let val = getCustomFieldValue(lead, 128884);
    if (!val) val = 'Não Informado';
    
    // Shorten long strings for cleaner UI
    if (val.length > 30) {
      val = val.substring(0, 27) + '...';
    }
    cargoCounts[val] = (cargoCounts[val] || 0) + 1;
  });

  const sortedCargo = Object.entries(cargoCounts).sort((a, b) => b[1] - a[1]);
  const cargoLabels = sortedCargo.map(x => x[0]);
  const cargoData = sortedCargo.map(x => x[1]);

  state.cargoChart = new Chart(cargoCtx, {
    type: 'pie',
    data: {
      labels: cargoLabels,
      datasets: [{
        data: cargoData,
        backgroundColor: orangeColors.palette.slice(0, sortedCargo.length).map(c => adjustColorOpacity(c, 0.75)),
        borderColor: '#ffffff',
        borderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#334155',
            font: { family: 'Plus Jakarta Sans', size: 9 },
            boxWidth: 10,
            padding: 8
          }
        },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0f172a',
          bodyColor: '#334155',
          borderColor: '#e2e8f0',
          borderWidth: 1,
          padding: 8
        }
      }
    }
  });

  // 2. Faturamento Chart ("Seu faturamento médio" - ID 128886)
  const fatCtx = document.getElementById('faturamentoChart').getContext('2d');
  if (state.faturamentoChart) state.faturamentoChart.destroy();

  const fatCounts = {};
  state.filteredLeads.forEach(lead => {
    let val = getCustomFieldValue(lead, 128886);
    if (!val) val = 'Não Informado';
    fatCounts[val] = (fatCounts[val] || 0) + 1;
  });

  // Define faturamento order if possible to look clean, otherwise sort by volume
  // Example responses: "1 a 3 mil reais", "3 a 5 mil reais", "5 a 7.5 mil reais"
  const orderMap = {
    '1 a 3 mil reais': 1,
    '3 a 5 mil reais': 2,
    '5 a 7.5 mil reais': 3,
    'Não Informado': 99
  };

  const sortedFat = Object.entries(fatCounts).sort((a, b) => {
    const orderA = orderMap[a[0]] || 50;
    const orderB = orderMap[b[0]] || 50;
    return orderA - orderB;
  });

  const fatLabels = sortedFat.map(x => x[0]);
  const fatData = sortedFat.map(x => x[1]);

  state.faturamentoChart = new Chart(fatCtx, {
    type: 'bar',
    data: {
      labels: fatLabels,
      datasets: [{
        label: 'Quantidade de Leads',
        data: fatData,
        backgroundColor: adjustColorOpacity(orangeColors.primary, 0.7),
        borderColor: orangeColors.primary,
        borderWidth: 1,
        borderRadius: 4,
        barPercentage: 0.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0f172a',
          bodyColor: '#334155',
          borderColor: '#e2e8f0',
          borderWidth: 1,
          padding: 8
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
        },
        y: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
        }
      }
    }
  });
}

// Render dynamic grouping table
function renderCampaignTable() {
  const mktData = {};

  state.filteredLeads.forEach(lead => {
    const val = getMarketingValue(lead, state.marketingGroup);
    
    if (!mktData[val]) {
      mktData[val] = { leads: 0, won: 0, lost: 0, revenue: 0 };
    }
    
    mktData[val].leads++;
    const e = FUNNEL.evaluate(lead);
    if (e.isWon) {
      mktData[val].won++;
      mktData[val].revenue += e.revenue;
    } else if (e.isLost) {
      mktData[val].lost++;
    }
  });

  const mktList = Object.entries(mktData).map(([name, stats]) => {
    const convRate = stats.leads > 0 ? (stats.won / stats.leads) * 100 : 0;
    return { name, ...stats, convRate };
  }).sort((a, b) => b.leads - a.leads);

  elements.campaignTableBody.innerHTML = '';

  if (mktList.length === 0) {
    elements.campaignTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted">Nenhum dado encontrado para os filtros selecionados.</td>
      </tr>`;
    return;
  }

  mktList.forEach((item, index) => {
    const tr = document.createElement('tr');
    
    let rankBadge = '';
    if (index === 0 && item.leads > 5) {
      rankBadge = '<span class="badge badge-rank-1">TOP 1</span> ';
    } else if (index === 1 && item.leads > 5) {
      rankBadge = '<span class="badge badge-rank-2">TOP 2</span> ';
    }

    const itemEscaped = escapeHTML(item.name);
    const revenueFormatted = item.revenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    tr.innerHTML = `
      <td style="font-weight: 500;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          ${rankBadge}
          <span title="${itemEscaped}" style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${itemEscaped}
          </span>
        </div>
      </td>
      <td class="text-center" style="font-weight: 600;">${item.leads.toLocaleString('pt-BR')}</td>
      <td class="text-center text-success" style="font-weight: 600;">${item.won.toLocaleString('pt-BR')}</td>
      <td class="text-center" style="font-weight: 600; color: ${item.convRate > 0 ? orangeColors.primary : '#64748b'}">
        ${item.convRate.toFixed(1)}%
      </td>
      <td class="text-right" style="font-weight: 700; color: var(--text-main);">${revenueFormatted}</td>
    `;
    
    elements.campaignTableBody.appendChild(tr);
  });
}

// Render Team, SDR, and Closer performance tables
function renderTeamPerformance() {
  const teamStats = {};
  const usersList = state.users._embedded?.users || [];

  usersList.forEach(u => {
    teamStats[u.id] = { name: u.name, leads: 0, won: 0, lost: 0, revenue: 0 };
  });

  const sdrStats = {};
  const closerStats = {};

  state.filteredLeads.forEach(lead => {
    const owner = lead.responsible_user_id;
    if (!teamStats[owner]) {
      teamStats[owner] = { name: getUserName(owner), leads: 0, won: 0, lost: 0, revenue: 0 };
    }

    const e = FUNNEL.evaluate(lead);

    teamStats[owner].leads++;
    if (e.isWon) {
      teamStats[owner].won++;
      teamStats[owner].revenue += e.revenue;
    } else if (e.isLost) {
      teamStats[owner].lost++;
    }

    const sdrName = getLeadSDR(lead);
    const closerName = getLeadCloser(lead);

    // SDR Stats
    if (sdrName) {
      if (!sdrStats[sdrName]) {
        sdrStats[sdrName] = { total: 0, mql: 0, agendadas: 0, realizadas: 0, won: 0 };
      }
      sdrStats[sdrName].total++;
      if (e.isMql) sdrStats[sdrName].mql++;
      if (e.isEngajado) sdrStats[sdrName].agendadas++;
      if (e.isAvancado) sdrStats[sdrName].realizadas++;
      if (e.isWon) sdrStats[sdrName].won++;
    }

    // Closer Stats
    if (closerName) {
      if (!closerStats[closerName]) {
        closerStats[closerName] = { agendadas: 0, realizadas: 0, won: 0, revenue: 0 };
      }
      if (e.isEngajado) closerStats[closerName].agendadas++;
      if (e.isAvancado) closerStats[closerName].realizadas++;
      if (e.isWon) {
        closerStats[closerName].won++;
        closerStats[closerName].revenue += e.revenue;
      }
    }
  });

  // Render Team Owner Cards
  if (elements.teamCardsContainer) {
    elements.teamCardsContainer.innerHTML = '';
    const teamList = Object.entries(teamStats).map(([id, stats]) => {
      const closedCount = stats.won + stats.lost;
      const winRate = closedCount > 0 ? (stats.won / closedCount) * 100 : 0;
      return { id, ...stats, winRate };
    }).sort((a, b) => b.revenue - a.revenue);

    teamList.forEach(member => {
      const initials = member.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
      const card = document.createElement('div');
      card.className = 'team-member-card';
      const revenueFormatted = member.revenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

      card.innerHTML = `
        <div class="member-info">
          <div class="member-avatar">${initials}</div>
          <div class="member-details">
            <h4>${escapeHTML(member.name)}</h4>
            <span>${member.leads.toLocaleString('pt-BR')} leads atribuídos</span>
          </div>
        </div>
        <div class="member-stats">
          <div class="member-stat-item">
            <span class="member-stat-label">Ganhos</span>
            <span class="member-stat-val text-success">${member.won.toLocaleString('pt-BR')}</span>
          </div>
          <div class="member-stat-item">
            <span class="member-stat-label">Taxa Win</span>
            <span class="member-stat-val" style="color: var(--color-primary);">${member.winRate.toFixed(1)}%</span>
          </div>
          <div class="member-stat-item">
            <span class="member-stat-label">Vendas</span>
            <span class="member-stat-val" style="font-weight: 800; color: var(--text-main);">${revenueFormatted}</span>
          </div>
        </div>
      `;
      elements.teamCardsContainer.appendChild(card);
    });
  }

  // Render SDR Table
  const sdrBody = document.getElementById('sdrTableBody');
  if (sdrBody) {
    const sdrEntries = Object.entries(sdrStats).sort((a, b) => b[1].total - a[1].total);
    if (sdrEntries.length === 0) {
      sdrBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">Nenhum SDR com leads atribuídos no período.</td></tr>';
    } else {
      sdrBody.innerHTML = sdrEntries.map(([sdrName, st]) => `
        <tr>
          <td><strong style="color: var(--color-slate-900);">📞 ${escapeHTML(sdrName)}</strong></td>
          <td class="text-right">${st.total.toLocaleString('pt-BR')}</td>
          <td class="text-right text-warning" style="font-weight:700;">${st.mql.toLocaleString('pt-BR')}</td>
          <td class="text-right text-primary" style="font-weight:700;">${st.agendadas.toLocaleString('pt-BR')}</td>
          <td class="text-right">${st.realizadas.toLocaleString('pt-BR')}</td>
          <td class="text-right text-success" style="font-weight:800;">${st.won.toLocaleString('pt-BR')}</td>
        </tr>
      `).join('');
    }
  }

  // Render Closer Table
  const closerBody = document.getElementById('closerTableBody');
  if (closerBody) {
    const closerEntries = Object.entries(closerStats).sort((a, b) => b[1].revenue - a[1].revenue);
    if (closerEntries.length === 0) {
      closerBody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">Nenhum Closer com reuniões no período.</td></tr>';
    } else {
      closerBody.innerHTML = closerEntries.map(([closerName, st]) => {
        const convRate = st.realizadas > 0 ? ((st.won / st.realizadas) * 100).toFixed(1) : '0.0';
        const revFormatted = st.revenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        return `
          <tr>
            <td><strong style="color: var(--color-slate-900);">🤝 ${escapeHTML(closerName)}</strong></td>
            <td class="text-right">${st.agendadas.toLocaleString('pt-BR')}</td>
            <td class="text-right">${st.realizadas.toLocaleString('pt-BR')}</td>
            <td class="text-right text-success" style="font-weight:800;">${st.won.toLocaleString('pt-BR')}</td>
            <td class="text-right text-primary" style="font-weight:700;">${convRate}%</td>
            <td class="text-right text-success" style="font-weight:800;">${revFormatted}</td>
          </tr>
        `;
      }).join('');
    }
  }
}

// Sync Click Handler
async function handleSync() {
  const icon = elements.syncBtn.querySelector('svg');
  icon.classList.add('spinning');
  elements.syncBtn.disabled = true;
  elements.loadingOverlay.classList.add('active');

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      showToast(`🔄 Sincronização concluída! ${data.leadsCount} leads sincronizados.`, 'success');
      await loadData();
    } else {
      showToast(`❌ Erro: ${data.error || 'Erro na sincronização'}`, 'danger');
    }
  } catch (err) {
    console.error('Sync request failed:', err);
    showToast('❌ Falha na conexão com o servidor local.', 'danger');
  } finally {
    icon.classList.remove('spinning');
    elements.syncBtn.disabled = false;
    elements.loadingOverlay.classList.remove('active');
  }
}

// Helpers
function adjustColorOpacity(hex, opacity) {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// Coage para string: é chamada com valores do CRM que podem vir null/número
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g,
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function showToast(msg, type = 'info') {
  elements.toastMsg.innerText = msg;
  elements.toastIcon.innerText = type === 'success' ? '✅' : type === 'danger' ? '❌' : 'ℹ️';
  
  elements.toastNotification.className = 'toast glass-card show';
  if (type === 'danger') elements.toastNotification.style.borderLeft = '4px solid var(--color-danger)';
  else if (type === 'success') elements.toastNotification.style.borderLeft = '4px solid var(--color-success)';
  else elements.toastNotification.style.borderLeft = '4px solid var(--color-primary)';

  setTimeout(() => {
    elements.toastNotification.classList.remove('show');
  }, 4000);
}

// Render VTurb Page & VSL Analytics Section
function renderVTurbSection(data) {
  if (!data || !data.success) {
    console.warn('[VTurb Frontend] No VTurb analytics data received.');
    return;
  }

  const liveUsersEl = document.getElementById('vturbLiveUsers');
  const metricViewsEl = document.getElementById('vturbMetricViews');
  const metricSessionsEl = document.getElementById('vturbMetricSessions');
  const metricPlaysEl = document.getElementById('vturbMetricPlays');
  const metricPlayRateEl = document.getElementById('vturbMetricPlayRate');
  const metricPitchEl = document.getElementById('vturbMetricPitch');
  const metricPitchRateEl = document.getElementById('vturbMetricPitchRate');
  const metricEngagementEl = document.getElementById('vturbMetricEngagement');
  const tableBodyEl = document.getElementById('vturbTableBody');

  const totalLive = data.totalLiveUsers || 0;
  if (liveUsersEl) liveUsersEl.innerText = `${totalLive} Ao Vivo`;

  const players = data.players || [];
  if (players.length === 0) {
    if (tableBodyEl) tableBodyEl.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-3">Nenhum vídeo VTurb encontrado no período.</td></tr>';
    return;
  }

  let totalViews = 0;
  let totalUniqueSessions = 0;
  let totalPlays = 0;
  let totalPitchViews = 0;
  let sumEngagement = 0;

  const rowsHTML = players.map(p => {
    const s = p.stats || {};
    const views = s.total_viewed || 0;
    const uniqSessions = s.total_viewed_session_uniq || 0;
    const plays = s.total_started || 0;
    const playRate = parseFloat(s.play_rate || 0).toFixed(1);
    const pitchViews = s.total_over_pitch || 0;
    const pitchRate = parseFloat(s.over_pitch_rate || 0).toFixed(1);
    const engagement = parseFloat(s.engagement_rate || 0).toFixed(1);

    totalViews += views;
    totalUniqueSessions += uniqSessions;
    totalPlays += plays;
    totalPitchViews += pitchViews;
    sumEngagement += parseFloat(engagement);

    const durMins = p.duration ? `${Math.floor(p.duration / 60)}m ${p.duration % 60}s` : '-';

    return `
      <tr style="border-bottom: 1px solid #f1f5f9;">
        <td style="padding: 0.75rem;">
          <div style="font-weight:700; color:var(--color-slate-900);">🎥 ${escapeHTML(p.name || 'VSL Player')}</div>
          <div style="font-size:0.75rem; color:var(--color-slate-500);">ID: ${p.id}</div>
        </td>
        <td style="padding: 0.75rem; font-size:0.85rem;">⏱️ ${durMins}</td>
        <td style="padding: 0.75rem;" class="text-center"><strong>${views.toLocaleString('pt-BR')}</strong></td>
        <td style="padding: 0.75rem;" class="text-center">${uniqSessions.toLocaleString('pt-BR')}</td>
        <td style="padding: 0.75rem;" class="text-center text-primary" style="font-weight:700;">${plays.toLocaleString('pt-BR')}</td>
        <td style="padding: 0.75rem;" class="text-center text-success" style="font-weight:800;">${playRate}%</td>
        <td style="padding: 0.75rem;" class="text-center" style="font-weight:700; color:#7c3aed;">${pitchViews.toLocaleString('pt-BR')} (${pitchRate}%)</td>
        <td style="padding: 0.75rem;" class="text-center">
          <span class="badge" style="background:rgba(239,68,68,0.12); color:#dc2626; font-weight:800; font-size:0.75rem; padding:0.25rem 0.5rem; border-radius:6px;">🔴 ${p.live_users} ao vivo</span>
        </td>
      </tr>
    `;
  }).join('');

  if (tableBodyEl) tableBodyEl.innerHTML = rowsHTML;

  const avgPlayRate = totalViews > 0 ? ((totalPlays / totalViews) * 100).toFixed(1) : '0.0';
  const avgPitchRate = totalPlays > 0 ? ((totalPitchViews / totalPlays) * 100).toFixed(1) : '0.0';
  const avgEngagement = players.length > 0 ? (sumEngagement / players.length).toFixed(1) : '0.0';

  if (metricViewsEl) metricViewsEl.innerText = totalViews.toLocaleString('pt-BR');
  if (metricSessionsEl) metricSessionsEl.innerText = `${totalUniqueSessions.toLocaleString('pt-BR')} visitantes únicos`;
  if (metricPlaysEl) metricPlaysEl.innerText = totalPlays.toLocaleString('pt-BR');
  if (metricPlayRateEl) metricPlayRateEl.innerText = `Taxa de Play: ${avgPlayRate}%`;
  if (metricPitchEl) metricPitchEl.innerText = totalPitchViews.toLocaleString('pt-BR');
  if (metricPitchRateEl) metricPitchRateEl.innerText = `Retenção Pitch: ${avgPitchRate}%`;
  if (metricEngagementEl) metricEngagementEl.innerText = `${avgEngagement}%`;
}

// Render Eduzz Analytics Dashboard
function renderEduzzDashboard() {
  if (!state.eduzzData) {
    console.warn('No Eduzz analytics data available yet.');
    return;
  }

  const { kpis, campaigns, products, vipClients } = state.eduzzData;

  // 1. Render KPIs
  elements.eduzzMetricRevenue.innerText = kpis.totalRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  elements.eduzzMetricSalesCount.innerText = `${kpis.totalSales.toLocaleString('pt-BR')} vendas aprovadas`;
  elements.eduzzMetricClients.innerText = kpis.totalClients.toLocaleString('pt-BR');
  elements.eduzzMetricMultiClients.innerText = kpis.multiProductClients.toLocaleString('pt-BR');
  
  const repeatRate = kpis.totalClients > 0 ? (kpis.multiProductClients / kpis.totalClients) * 100 : 0;
  elements.eduzzMetricMultiRate.innerText = `${repeatRate.toFixed(1)}% de taxa de recompra`;
  elements.eduzzMetricAvgTicket.innerText = kpis.averageTicket.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // 2. Render Charts
  renderEduzzCharts(campaigns);

  // 3. Render Campaigns Table
  elements.eduzzCampaignTableBody.innerHTML = '';
  campaigns.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 500;">
        <span title="${escapeHTML(c.name)}" style="max-width: 350px; overflow: hidden; text-overflow: ellipsis; display: block; white-space: nowrap;">
          ${escapeHTML(c.name)}
        </span>
      </td>
      <td class="text-center" style="font-weight: 600;">${c.salesCount.toLocaleString('pt-BR')}</td>
      <td class="text-center" style="font-weight: 600; color: var(--color-primary);">${c.avgTicket.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
      <td class="text-right" style="font-weight: 700; color: var(--text-main);">${c.revenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
    `;
    elements.eduzzCampaignTableBody.appendChild(tr);
  });

  // 4. Render Products Table
  elements.eduzzProductTableBody.innerHTML = '';
  products.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 500;">
        <span title="${escapeHTML(p.name)}" style="max-width: 350px; overflow: hidden; text-overflow: ellipsis; display: block; white-space: nowrap;">
          ${escapeHTML(p.name)}
        </span>
      </td>
      <td class="text-center" style="font-weight: 600;">${p.salesCount.toLocaleString('pt-BR')}</td>
      <td class="text-center" style="font-weight: 600; color: var(--color-primary);">${p.avgTicket.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
      <td class="text-right" style="font-weight: 700; color: var(--text-main);">${p.revenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
    `;
    elements.eduzzProductTableBody.appendChild(tr);
  });

  // 5. Render VIP Clients Table (Multi-Buyers)
  elements.eduzzVipTableBody.innerHTML = '';
  if (vipClients.length === 0) {
    elements.eduzzVipTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted">Nenhum cliente com múltiplos produtos encontrado.</td>
      </tr>`;
    return;
  }

  vipClients.forEach(c => {
    const tr = document.createElement('tr');
    
    // Clean products representation
    const productsList = c.products.map(p => `<span class="badge" style="background: rgba(255, 107, 0, 0.1); color: var(--color-primary); padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; margin-right: 0.3rem; display: inline-block; margin-bottom: 0.3rem;">${escapeHTML(p)}</span>`).join('');
    
    tr.innerHTML = `
      <td style="font-weight: 600; color: var(--text-main);">${escapeHTML(c.name)}</td>
      <td>
        <div style="font-size: 0.8rem; color: var(--text-muted);">
          <div>✉️ ${escapeHTML(c.email)}</div>
          ${c.phone ? `<div>📞 ${escapeHTML(c.phone)}</div>` : ''}
        </div>
      </td>
      <td class="text-center" style="font-weight: 700;">${c.salesCount}</td>
      <td style="max-width: 450px;">${productsList}</td>
      <td class="text-right" style="font-weight: 800; color: var(--color-primary);">${c.totalSpent.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
    `;
    elements.eduzzVipTableBody.appendChild(tr);
  });
}

// Render Eduzz Charts
function renderEduzzCharts(campaigns) {
  // Chart 1: Campaigns by Sales volume
  const ctxSales = document.getElementById('eduzzCampaignSalesChart').getContext('2d');
  if (state.eduzzCampaignSalesChart) {
    state.eduzzCampaignSalesChart.destroy();
  }

  // Filter out Organic and get top 6 campaigns
  const activeCampaigns = campaigns.filter(c => c.name !== 'Orgânico/Direto').slice(0, 6);
  const labelsSales = activeCampaigns.map(c => c.name.length > 25 ? c.name.substring(0, 22) + '...' : c.name);
  const dataSales = activeCampaigns.map(c => c.salesCount);

  state.eduzzCampaignSalesChart = new Chart(ctxSales, {
    type: 'bar',
    data: {
      labels: labelsSales,
      datasets: [{
        label: 'Vendas Aprovadas',
        data: dataSales,
        backgroundColor: adjustColorOpacity(orangeColors.primary, 0.7),
        borderColor: orangeColors.primary,
        borderWidth: 1.5,
        borderRadius: 6,
        barPercentage: 0.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
        },
        y: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
        }
      }
    }
  });

  // Chart 2: Campaigns by Average Ticket
  const ctxTicket = document.getElementById('eduzzCampaignTicketChart').getContext('2d');
  if (state.eduzzCampaignTicketChart) {
    state.eduzzCampaignTicketChart.destroy();
  }

  // Filter campaigns with at least 3 sales and sort by ticket
  const ticketCampaigns = campaigns
    .filter(c => c.salesCount >= 3)
    .sort((a, b) => b.avgTicket - a.avgTicket)
    .slice(0, 6);

  const labelsTicket = ticketCampaigns.map(c => c.name.length > 25 ? c.name.substring(0, 22) + '...' : c.name);
  const dataTicket = ticketCampaigns.map(c => Math.round(c.avgTicket));

  state.eduzzCampaignTicketChart = new Chart(ctxTicket, {
    type: 'bar',
    data: {
      labels: labelsTicket,
      datasets: [{
        label: 'Ticket Médio (R$)',
        data: dataTicket,
        backgroundColor: adjustColorOpacity(orangeColors.secondary, 0.7),
        borderColor: orangeColors.secondary,
        borderWidth: 1.5,
        borderRadius: 6,
        barPercentage: 0.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
        },
        y: {
          grid: { color: '#e2e8f0' },
          ticks: { color: '#64748b', font: { family: 'Plus Jakarta Sans', size: 10 } }
        }
      }
    }
  });
}

// Helper: Format date in local YYYY-MM-DD without UTC timezone shift
function formatDateLocal(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ==========================================
// META ADS INTEGRATION — INSIGHTS & RENDERING
// ==========================================

// Pipeline ID → Meta Ads funnel key mapping
const PIPELINE_FUNNEL_MAP = {
  13304659: 'komando',     // KO Inbound
  14173256: 'kop',         // KOP Inbound (produto independente)
  14268556: 'kor',         // [KOR] Inbound (produto independente)
  13956952: 'recuperacao', // Funil de Recuperação
  13304583: 'mlfp',        // Mentoria MLFP Inbound (Tráfego Pago Oficial)
  14008652: 'repescagem',  // [MLFP] Leads Antigos (Repescagem / Base Antiga - Isolado do Inbound)
  13537971: 'ebook',       // KO Ebooks
  14104532: 'engajamento'  // Instagram (Social Selling)
};

const FUNNEL_DISPLAY = {
  mlfp: { label: 'MLFP Inbound', tagClass: 'tag-mlfp', icon: '🔵' },
  komando: { label: 'Komando', tagClass: 'tag-komando', icon: '🔴' },
  kop: { label: 'KOP', tagClass: 'tag-kop', icon: '📦' },
  kor: { label: 'KOR Inbound', tagClass: 'tag-kor', icon: '🔄' },
  recuperacao: { label: 'Recuperação', tagClass: 'tag-kor', icon: '♻️' },
  ebook: { label: 'Ebook', tagClass: 'tag-ebook', icon: '📚' },
  engajamento: { label: 'Social Selling', tagClass: 'tag-engajamento', icon: '📲' },
  repescagem: { label: 'MLFP Repescagem', tagClass: 'tag-outros', icon: '⏳' },
  outros: { label: 'Outros', tagClass: 'tag-outros', icon: '📦' }
};

function formatBRL(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return 'R$ ' + value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNumber(value) {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return value.toLocaleString('pt-BR');
}

// Fetch Meta Ads insights for the current date range
async function loadMetaAdsInsights() {
  const section = document.getElementById('mediaPagaSection');
  if (!section) return;

  // Mídia Paga só faz sentido na aba CRM.
  // Antes isso era decidido por #eduzzView.active — um container interno que
  // fica sempre ativo, o que escondia a seção já no primeiro carregamento.
  const abaCrmAtiva = document.getElementById('crmMainTabContent')?.classList.contains('active');
  if (!abaCrmAtiva) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  // Build date params (local YYYY-MM-DD to avoid UTC shifts)
  let since, until;
  if (state.dateFrom && state.dateTo) {
    since = formatDateLocal(state.dateFrom);
    until = formatDateLocal(state.dateTo);
  } else {
    // Default to current month
    const now = new Date();
    since = formatDateLocal(new Date(now.getFullYear(), now.getMonth(), 1));
    until = formatDateLocal(now);
  }

  // Show loading state
  const tbody = document.getElementById('mediaPagaTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="meta-loading"><div class="spinner-sm"></div> Carregando dados do Meta Ads...</td></tr>';

  try {
    const response = await fetch(`/api/meta-ads/insights?since=${since}&until=${until}`);
    const data = await response.json();

    if (data.success) {
      state.metaAdsData = data;
      renderMediaPaga(data);
    } else {
      console.error('[Meta Ads] API error:', data.error);
      if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:2rem;">Erro ao carregar dados do Meta Ads</td></tr>';
    }
  } catch (err) {
    console.error('[Meta Ads] Fetch error:', err);
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:2rem;">Erro de conexão com Meta Ads API</td></tr>';
  }
}

// Setup Media Paga Sub-Tabs listeners
function setupMediaPagaTabs() {
  const tabsContainer = document.getElementById('mediaPagaTabs');
  if (!tabsContainer || tabsContainer.dataset.initialized) return;
  tabsContainer.dataset.initialized = 'true';

  tabsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.media-tab-btn');
    if (!btn) return;

    tabsContainer.querySelectorAll('.media-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    state.selectedMediaTab = btn.getAttribute('data-media-tab') || 'all';
    if (state.metaAdsData) {
      renderMediaPaga(state.metaAdsData);
    }
  });
}

// Render Media Paga section with Kommo CRM lead counts (priority)
function renderMediaPaga(metaData) {
  if (!metaData || !metaData.funnels) return;

  setupMediaPagaTabs();

  const activeMediaTab = state.selectedMediaTab || 'all';
  const allLeads = state.leads || [];

  // Apply same date filter to get leads per funnel
  let dateFiltered = [...allLeads];
  if (state.dateFrom && state.dateTo) {
    const fromSecs = Math.floor(state.dateFrom.getTime() / 1000);
    const toSecs = Math.floor(state.dateTo.getTime() / 1000);
    dateFiltered = dateFiltered.filter(l => l.created_at >= fromSecs && l.created_at <= toSecs);
  } else if (state.dateFrom) {
    const fromSecs = Math.floor(state.dateFrom.getTime() / 1000);
    dateFiltered = dateFiltered.filter(l => l.created_at >= fromSecs);
  }

  // Count leads and MQLs per funnel from Kommo CRM
  const kommoFunnels = {};
  for (const lead of dateFiltered) {
    // Isolamento estrito: Leads de repescagem NUNCA contam na Mídia Paga Inbound
    if (isRepescagemLead(lead)) continue;
    const funnelKey = PIPELINE_FUNNEL_MAP[lead.pipeline_id];
    if (!funnelKey || funnelKey === 'repescagem') continue;
    if (!kommoFunnels[funnelKey]) {
      kommoFunnels[funnelKey] = { leads: 0, mqls: 0, wonRevenue: 0, wonCount: 0 };
    }
    kommoFunnels[funnelKey].leads++;

    const e = FUNNEL.evaluate(lead);
    if (e.isMql) kommoFunnels[funnelKey].mqls++;
    if (e.isWon) {
      kommoFunnels[funnelKey].wonCount++;
      kommoFunnels[funnelKey].wonRevenue += e.revenue;
    }
  }

  // Build metrics for each funnel
  const funnelOrder = ['mlfp', 'komando', 'kop', 'kor', 'recuperacao', 'ebook', 'engajamento', 'outros'];
  const funnelMetrics = {};
  let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
  let totalKommoLeads = 0, totalMQLs = 0, totalWonRevenue = 0;

  for (const fKey of funnelOrder) {
    const meta = metaData.funnels[fKey] || { spend: 0, impressions: 0, clicks: 0, ctr: 0, campaigns: [] };
    const kommo = kommoFunnels[fKey] || { leads: 0, mqls: 0, wonRevenue: 0, wonCount: 0 };
    const display = FUNNEL_DISPLAY[fKey] || FUNNEL_DISPLAY.outros;

    const spend = meta.spend || 0;
    const impressions = meta.impressions || 0;
    const clicks = meta.clicks || 0;
    const ctr = meta.ctr || 0;
    const leads = kommo.leads; // ALWAYS from Kommo
    const mqls = kommo.mqls;   // ALWAYS from Kommo
    const cpl = leads > 0 ? spend / leads : null;
    const cpmql = mqls > 0 ? spend / mqls : null;
    // ROAS para qualquer funil com investimento: receita confirmada ÷ spend
    const roas = spend > 0 ? kommo.wonRevenue / spend : null;

    totalSpend += spend;
    totalImpressions += impressions;
    totalClicks += clicks;
    totalKommoLeads += leads;
    totalMQLs += mqls;
    totalWonRevenue += kommo.wonRevenue;

    funnelMetrics[fKey] = { fKey, display, spend, impressions, clicks, ctr, leads, mqls, cpl, cpmql, roas, wonRevenue: kommo.wonRevenue, campaigns: meta.campaigns || [] };
  }

  // DOM elements helper
  const el = (id) => document.getElementById(id);

  // 1. UPDATE KPI CARDS (Based on selected media tab or overview)
  if (activeMediaTab === 'all') {
    el('metaSpend').textContent = formatBRL(totalSpend);
    el('metaSpendSub').textContent = `Total em ${metaData.campaigns_count || 0} campanhas`;

    el('metaClicks').textContent = formatNumber(totalClicks);
    const totalCTR = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : '0.00';
    el('metaCTR').textContent = `CTR: ${totalCTR}% · ${formatNumber(totalImpressions)} imp.`;

    el('metaLeadsKommo').textContent = formatNumber(totalKommoLeads);
    const totalCPL = totalKommoLeads > 0 ? totalSpend / totalKommoLeads : null;
    el('metaCPL').textContent = totalCPL !== null ? formatBRL(totalCPL) : '—';

    el('metaMQLsKommo').textContent = formatNumber(totalMQLs);
    const totalCPMQL = totalMQLs > 0 ? totalSpend / totalMQLs : null;
    el('metaCPMQL').textContent = `CPMQL: ${totalCPMQL !== null ? formatBRL(totalCPMQL) : '—'}`;

    const totalROAS = totalWonRevenue > 0 && totalSpend > 0 ? (totalWonRevenue / totalSpend).toFixed(2) + 'x' : '—';
    el('metaROAS').textContent = totalROAS;
    el('metaROASSub').textContent = `Receita Kommo: ${formatBRL(totalWonRevenue)}`;
  } else {
    // Specific funnel view
    const fData = funnelMetrics[activeMediaTab] || { spend: 0, impressions: 0, clicks: 0, ctr: 0, leads: 0, mqls: 0, cpl: null, cpmql: null, roas: null, wonRevenue: 0, campaigns: [] };
    const display = FUNNEL_DISPLAY[activeMediaTab] || FUNNEL_DISPLAY.outros;

    el('metaSpend').textContent = formatBRL(fData.spend);
    el('metaSpendSub').textContent = `${display.label} (${fData.campaigns.length} campanhas)`;

    el('metaClicks').textContent = formatNumber(fData.clicks);
    el('metaCTR').textContent = `CTR: ${fData.ctr.toFixed(2)}% · ${formatNumber(fData.impressions)} imp.`;

    el('metaLeadsKommo').textContent = formatNumber(fData.leads);
    el('metaCPL').textContent = fData.cpl !== null ? formatBRL(fData.cpl) : '—';

    el('metaMQLsKommo').textContent = formatNumber(fData.mqls);
    el('metaCPMQL').textContent = `CPMQL: ${fData.cpmql !== null ? formatBRL(fData.cpmql) : '—'}`;

    const roasStr = fData.roas !== null ? fData.roas.toFixed(2) + 'x' : '—';
    el('metaROAS').textContent = roasStr;
    el('metaROASSub').textContent = fData.wonRevenue > 0 ? `Receita: ${formatBRL(fData.wonRevenue)}` : 'Vendas Kommo ÷ Spend';
  }

  // 2. TOGGLE OVERVIEW COMPARISON TABLE BLOCK
  const overviewBlock = document.getElementById('mediaOverviewBlock');
  if (overviewBlock) {
    if (activeMediaTab === 'all') {
      overviewBlock.style.display = '';
      
      // Render comparative table body
      const tbody = document.getElementById('mediaPagaTableBody');
      if (tbody) {
        let html = '';
        for (const fKey of funnelOrder) {
          const row = funnelMetrics[fKey];
          if (!row || (row.spend === 0 && row.leads === 0)) continue;

          const roasCell = row.roas !== null
            ? `<span class="roas-badge ${row.roas >= 1 ? 'roas-positive' : 'roas-negative'}">${row.roas.toFixed(2)}x</span>`
            : `<span style="color:var(--text-muted)" title="Sem investimento no período">—</span>`;

          html += `<tr>
            <td><span class="funnel-tag ${row.display.tagClass}">${row.display.icon} ${row.display.label}</span></td>
            <td>${formatBRL(row.spend)}</td>
            <td>${formatNumber(row.impressions)}</td>
            <td>${formatNumber(row.clicks)}</td>
            <td>${row.ctr.toFixed(2)}%</td>
            <td><strong>${formatNumber(row.leads)}</strong></td>
            <td>${row.cpl !== null ? formatBRL(row.cpl) : '—'}</td>
            <td><strong>${formatNumber(row.mqls)}</strong></td>
            <td>${row.cpmql !== null ? formatBRL(row.cpmql) : '—'}</td>
            <td>${roasCell}</td>
          </tr>`;
        }
        tbody.innerHTML = html || '<tr><td colspan="10" class="text-muted text-center py-3">Sem dados de investimento no período.</td></tr>';
      }

      // Update Footer Totals
      const totalCTRFooter = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + '%' : '—';
      const totalCPLFooter = totalKommoLeads > 0 ? formatBRL(totalSpend / totalKommoLeads) : '—';
      const totalCPMQL = totalMQLs > 0 ? formatBRL(totalSpend / totalMQLs) : '—';
      const totalROAS = totalWonRevenue > 0 && totalSpend > 0 ? (totalWonRevenue / totalSpend).toFixed(2) + 'x' : '—';

      if (el('metaTotalSpend')) el('metaTotalSpend').textContent = formatBRL(totalSpend);
      if (el('metaTotalImpressions')) el('metaTotalImpressions').textContent = formatNumber(totalImpressions);
      if (el('metaTotalClicks')) el('metaTotalClicks').textContent = formatNumber(totalClicks);
      if (el('metaTotalCTR')) el('metaTotalCTR').textContent = totalCTRFooter;
      if (el('metaTotalLeads')) el('metaTotalLeads').textContent = formatNumber(totalKommoLeads);
      if (el('metaTotalCPL')) el('metaTotalCPL').textContent = totalCPLFooter;
      if (el('metaTotalMQLs')) el('metaTotalMQLs').textContent = formatNumber(totalMQLs);
      if (el('metaTotalCPMQL')) el('metaTotalCPMQL').textContent = totalCPMQL;
      if (el('metaTotalROAS')) el('metaTotalROAS').textContent = totalROAS;
    } else {
      overviewBlock.style.display = 'none';
    }
  }

  // 3. RENDER DETAILED CAMPAIGN TABLE FOR SELECTED TAB
  const campTitle = document.getElementById('campaignsBlockTitle');
  const campTbody = document.getElementById('mediaCampaignsTableBody');
  
  if (campTbody) {
    let targetCampaigns = [];
    if (activeMediaTab === 'all') {
      if (campTitle) campTitle.textContent = 'Todas as Campanhas Meta Ads Ativas no Período';
      // Gather all campaigns from all funnels
      for (const fKey in metaData.funnels) {
        const cList = metaData.funnels[fKey].campaigns || [];
        cList.forEach(c => targetCampaigns.push({ ...c, funnelKey: fKey }));
      }
    } else {
      const display = FUNNEL_DISPLAY[activeMediaTab] || FUNNEL_DISPLAY.outros;
      if (campTitle) campTitle.textContent = `Campanhas Meta Ads — ${display.icon} ${display.label}`;
      const fMeta = metaData.funnels[activeMediaTab];
      if (fMeta && fMeta.campaigns) {
        targetCampaigns = fMeta.campaigns.map(c => ({ ...c, funnelKey: activeMediaTab }));
      }
    }

    targetCampaigns.sort((a, b) => (b.spend || 0) - (a.spend || 0));

    if (targetCampaigns.length === 0) {
      campTbody.innerHTML = '<tr><td colspan="8" class="text-muted text-center py-3">Nenhuma campanha com investimento no período selecionado.</td></tr>';
    } else {
      let cHtml = '';
      for (const c of targetCampaigns) {
        const display = FUNNEL_DISPLAY[c.funnelKey] || FUNNEL_DISPLAY.outros;
        const cpcVal = c.clicks > 0 ? (c.spend / c.clicks) : 0;

        cHtml += `<tr>
          <td style="font-weight: 600; color: var(--text-main);">${escapeHTML(c.name)}</td>
          <td><span class="funnel-tag ${display.tagClass}">${display.icon} ${display.label}</span></td>
          <td>${formatBRL(c.spend)}</td>
          <td>${formatNumber(c.impressions)}</td>
          <td>${formatNumber(c.clicks)}</td>
          <td>${(c.ctr || 0).toFixed(2)}%</td>
          <td>${formatBRL(cpcVal)}</td>
          <td><strong style="color:var(--color-primary);">${formatNumber(c.meta_leads || 0)}</strong></td>
        </tr>`;
      }
      campTbody.innerHTML = cHtml;
    }
  }
}

// ============================================================
//  PAGES ANALYTICS TAB
// ============================================================

let pagesVariantChart = null;
let pagesDailyChart = null;
let pagesAutoRefreshInterval = null;
let pagesActivePeriod = 'today';

// Enquanto true, a aba Pages usa o período do filtro principal.
// Ela tem pills próprias, e antes elas começavam em "Hoje" independentemente
// do período do dashboard — duas datas diferentes na mesma tela, sem aviso.
// Clicar numa pill da aba desliga o vínculo até trocar de aba de novo.
let pagesSegueFiltroGlobal = true;

// Traduz o período do filtro principal para a pill equivalente da aba Pages
function sincronizarPeriodoPages() {
  if (!pagesSegueFiltroGlobal) return;

  const equivalentes = ['today', '7', '30', 'this_month', 'all'];
  pagesActivePeriod = equivalentes.includes(state.activePeriod) ? state.activePeriod : 'global';

  const pills = document.getElementById('pagesDatePills');
  if (pills) {
    pills.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
    const alvo = pills.querySelector(`.pill-btn[data-period="${pagesActivePeriod}"]`);
    if (alvo) alvo.classList.add('active');
  }
}

function getPagesDateRange(preset) {
  const now = new Date();
  const formatZero = num => String(num).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${formatZero(now.getMonth()+1)}-${formatZero(now.getDate())}`;

  // 'global' = período do filtro principal que não tem pill equivalente
  // aqui (mês passado / personalizado)
  if (preset === 'global' && state.dateFrom && state.dateTo) {
    return {
      since: `${formatDateLocal(state.dateFrom)}T00:00:00-03:00`,
      until: `${formatDateLocal(state.dateTo)}T23:59:59-03:00`
    };
  }

  let since = '';
  let until = `${todayStr}T23:59:59-03:00`;

  if (preset === 'today') {
    since = `${todayStr}T00:00:00-03:00`;
  } else if (preset === 'this_month') {
    since = `${now.getFullYear()}-${formatZero(now.getMonth()+1)}-01T00:00:00-03:00`;
  } else if (preset === 'all') {
    since = '2026-01-01T00:00:00-03:00';
  } else {
    const days = parseInt(preset) || 7;
    const pastDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    const pastStr = `${pastDate.getFullYear()}-${formatZero(pastDate.getMonth()+1)}-${formatZero(pastDate.getDate())}`;
    since = `${pastStr}T00:00:00-03:00`;
  }

  return { since, until };
}

// Fetch and render Eduzz Analytics dynamically in real time with date filter
let lastEduzzRange = null;

async function fetchEduzzAnalytics() {
  try {
    let url = '/api/eduzz-analytics';
    let rangeKey = 'all';

    if (state.dateFrom && state.dateTo) {
      const fromStr = formatDateLocal(state.dateFrom);
      const toStr = formatDateLocal(state.dateTo);
      rangeKey = `${fromStr}..${toStr}`;
      url += `?from=${fromStr}&to=${toStr}`;
    }

    // Evita refetch quando só mudou funil/responsável
    if (rangeKey === lastEduzzRange) return;
    lastEduzzRange = rangeKey;

    const res = await fetch(url);
    const data = await res.json();
    if (data && data.success) {
      state.eduzzData = data;
      renderEduzzDashboard();
    }
  } catch (err) {
    console.error('[Eduzz Realtime] Error fetching Eduzz analytics:', err);
  }
}

async function loadPageAnalytics() {
    try {
        const { since, until } = getPagesDateRange(pagesActivePeriod);
        let url = '/api/page-analytics?';
        let ga4Url = '/api/ga4-analytics?';
        if (since) {
            url += `since=${encodeURIComponent(since)}&`;
            ga4Url += `since=${encodeURIComponent(since)}&`;
        }
        if (until) {
            url += `until=${encodeURIComponent(until)}&`;
            ga4Url += `until=${encodeURIComponent(until)}&`;
        }
        
        const [res, ga4Res] = await Promise.all([
            fetch(url).catch(() => null),
            fetch(ga4Url).catch(() => null)
        ]);

        if (res && res.ok) {
            const json = await res.json();
            if (json.success) {
                renderPagesKPIs(json.data);
                renderVTurbPlayersTable(json.data.vturb_players);
                renderPagesVariantChart(json.data);
                renderPagesDailyChart(json.data);
                renderPagesVariantTable(json.data);
                renderPagesUtmTable(json.data);
                renderEcosystemTable();
            }
        }

        if (ga4Res && ga4Res.ok) {
            const ga4Json = await ga4Res.json();
            if (ga4Json.success) {
                renderGA4Analytics(ga4Json);
            }
        }
    } catch (err) {
        console.error('[Pages] Error fetching page analytics:', err);
    }
}

let ga4DailyChartInstance = null;
let ga4SourcesChartInstance = null;

function renderGA4Analytics(ga4Data) {
  if (!ga4Data || !ga4Data.pages) return;
  const tbody = document.getElementById('ga4PagesTableBody');
  const allLeads = state.leads || [];
  const leadsBase = (state.filteredLeads && state.filteredLeads.length > 0) ? state.filteredLeads : allLeads;

  function matchLeadsForUrl(host, path) {
    const full = `${host}${path}`.toLowerCase();
    if (full.includes('consultoriakomando')) {
      if (full.includes('ebook')) return leadsBase.filter(l => l.pipeline_id === 13537971).length;
      return leadsBase.filter(l => l.pipeline_id === 13304659).length;
    }
    if (full.includes('typebot.co') && full.includes('komando')) {
      return leadsBase.filter(l => l.pipeline_id === 13304659).length;
    }
    if (full.includes('kop') || full.includes('kit-de-operacao')) {
      return leadsBase.filter(l => l.pipeline_id === 14173256).length;
    }
    if (full.includes('kor') || full.includes('recuperacao') || full.includes('restaurante')) {
      return leadsBase.filter(l => l.pipeline_id === 14268556 || l.pipeline_id === 13956952 || (l.pipeline_id === 13956856 && (l._embedded?.tags || []).some(t => t.name.toUpperCase().includes('KOR') || t.name.toUpperCase().includes('RESTAURANTE')))).length;
    }
    if (full.includes('eduzz')) {
      return leadsBase.filter(l => (l._embedded?.tags || []).some(t => t.name.toLowerCase().includes('eduzz'))).length;
    }
    if (full.includes('chefkaka') || full.includes('diagnostico') || full.includes('faixapreta')) {
      return leadsBase.filter(l => l.pipeline_id === 13304583 && !isRepescagemLead(l)).length;
    }
    return null;
  }

  if (tbody) {
    const pages = (ga4Data.pages || []).slice(0, 15);
    if (pages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">Nenhum dado registrado no GA4 para o período.</td></tr>';
    } else {
      tbody.innerHTML = pages.map(p => {
        const matchedLeads = matchLeadsForUrl(p.host, p.path);
        let convStr = '—';
        if (matchedLeads !== null && p.sessions > 0) {
          const r = (matchedLeads / p.sessions) * 100;
          if (r <= 100) convStr = `${r.toFixed(1)}%`;
        }
        return `
          <tr>
            <td style="font-weight:600; color:#0f172a;">
              <span style="color:#2563eb;">${escapeHTML(p.host)}</span><span style="color:#64748b;">${escapeHTML(p.path)}</span>
            </td>
            <td class="text-center" style="font-weight:700; color:#0f172a;">${p.sessions.toLocaleString('pt-BR')}</td>
            <td class="text-center" style="font-weight:600; color:#475569;">${p.users.toLocaleString('pt-BR')}</td>
            <td class="text-center" style="color:#64748b;">${p.views.toLocaleString('pt-BR')}</td>
            <td class="text-center" style="font-weight:800; color:${matchedLeads > 0 ? '#ff6b00' : '#64748b'};">${matchedLeads !== null ? matchedLeads.toLocaleString('pt-BR') : '—'}</td>
            <td class="text-center" style="font-weight:800; color:${convStr !== '—' ? '#059669' : '#64748b'};">${convStr}</td>
          </tr>
        `;
      }).join('');
    }
  }

  // Daily Sessions Chart
  const ctxDaily = document.getElementById('ga4DailyChart');
  if (ctxDaily && ga4Data.daily) {
    if (ga4DailyChartInstance) ga4DailyChartInstance.destroy();
    const labels = ga4Data.daily.map(d => {
      const parts = d.date.split('-');
      return parts.length === 3 ? `${parts[2]}/${parts[1]}` : d.date;
    });
    const values = ga4Data.daily.map(d => d.sessions);

    ga4DailyChartInstance = new Chart(ctxDaily.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Sessões (GA4)',
          data: values,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointBackgroundColor: '#2563eb',
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(148, 163, 184, 0.1)' } },
          y: { beginAtZero: true, ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(148, 163, 184, 0.1)' } }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }

  // Top Sources Chart
  const ctxSources = document.getElementById('ga4SourcesChart');
  if (ctxSources && ga4Data.sources) {
    if (ga4SourcesChartInstance) ga4SourcesChartInstance.destroy();
    const topSources = (ga4Data.sources || []).slice(0, 6);
    const labels = topSources.map(s => s.source);
    const values = topSources.map(s => s.sessions);
    const colors = ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#dbeafe'];

    ga4SourcesChartInstance = new Chart(ctxSources.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: '#475569', font: { size: 10 }, boxWidth: 12 } }
        },
        cutout: '65%'
      }
    });
  }
}

function renderEcosystemTable() {
  const tbody = document.getElementById('ecosystemTableBody');
  const allLeads = state.leads || [];
  const leadsBase = (state.filteredLeads && state.filteredLeads.length > 0) ? state.filteredLeads : allLeads;

  const products = [
    {
      id: 'mlfp',
      name: '🎓 Mentoria Líder Faixa Preta',
      url: 'chefkaka.com',
      pipelineId: 13304583,
      pipelineName: '[MLFP] Inbound',
      kpiElId: 'ecoMetricMlfp'
    },
    {
      id: 'ebooks',
      name: '📚 Ebooks & Iscas Digitais',
      url: 'consultoriakomando.com.br/ebooks',
      pipelineId: 13537971,
      pipelineName: '[KO] Ebooks',
      kpiElId: 'ecoMetricEbooks'
    },
    {
      id: 'kop',
      name: '⚙️ KOP Komando Operação',
      url: 'chefkakagomes.com/kop',
      pipelineId: 14173256,
      pipelineName: '[KOP] Inbound',
      kpiElId: 'ecoMetricKop'
    },
    {
      id: 'kor',
      name: '🔄 KOR Inbound / Downsell',
      url: 'chefkakagomes.com/kor',
      pipelineId: 14268556,
      pipelineName: '[KOR] Inbound',
      kpiElId: 'ecoMetricKor'
    }
  ];

  products.forEach(prod => {
    const periodLeads = leadsBase.filter(l => l.pipeline_id === prod.pipelineId && (prod.id === 'mlfp' ? !isRepescagemLead(l) : true));
    const totalLeads = allLeads.filter(l => l.pipeline_id === prod.pipelineId && (prod.id === 'mlfp' ? !isRepescagemLead(l) : true));
    const kpiEl = document.getElementById(prod.kpiElId);
    if (kpiEl) {
      kpiEl.innerText = `${periodLeads.length.toLocaleString('pt-BR')} leads`;
    }
  });

  if (!tbody) return;

  tbody.innerHTML = products.map(prod => {
    const periodLeads = leadsBase.filter(l => l.pipeline_id === prod.pipelineId && (prod.id === 'mlfp' ? !isRepescagemLead(l) : true));
    const totalLeads = allLeads.filter(l => l.pipeline_id === prod.pipelineId && (prod.id === 'mlfp' ? !isRepescagemLead(l) : true));
    const wonLeads = totalLeads.filter(l => l.status_id === 142 && (prod.id === 'mlfp' ? !isRepescagemLead(l) : true));

    return `
      <tr>
        <td style="font-weight:700; color:#0f172a;">${prod.name}</td>
        <td style="font-size:0.85rem; color:#2563eb; font-weight:600;"><a href="https://${prod.url}" target="_blank" rel="noopener" style="color:inherit; text-decoration:none;">🔗 ${prod.url}</a></td>
        <td><span class="badge" style="background:rgba(59,130,246,0.1); color:#2563eb; font-weight:600; padding:0.25rem 0.55rem; border-radius:6px; font-size:0.75rem;">${prod.pipelineName}</span></td>
        <td class="text-center" style="font-weight:800; color:#ff6b00; font-size:0.95rem;">${periodLeads.length.toLocaleString('pt-BR')}</td>
        <td class="text-center" style="font-weight:700; color:#0f172a;">${totalLeads.length.toLocaleString('pt-BR')}</td>
        <td class="text-center" style="font-weight:800; color:#059669;">${wonLeads.length.toLocaleString('pt-BR')} vendas</td>
      </tr>
    `;
  }).join('');
}

function renderVTurbPlayersTable(players) {
  const tbody = document.getElementById('vturbTableBody');
  if (!tbody) return;

  if (!players || players.length === 0) {
    tbody.innerHTML = `<tr>
      <td style="font-weight:700;">VSL Final.mov (Komando)</td>
      <td>09:27</td>
      <td class="text-center">—</td>
      <td class="text-center">—</td>
      <td class="text-center">—</td>
      <td class="text-center">—</td>
      <td class="text-center">—</td>
      <td class="text-center"><span style="color:#94a3b8; font-size:0.8rem;">0 ao vivo</span></td>
    </tr>`;
    return;
  }

  tbody.innerHTML = players.map(p => {
    const livePill = p.live_users > 0 
      ? `<span class="badge" style="background:rgba(239,68,68,0.12); color:#dc2626; font-weight:800; font-size:0.75rem; padding:0.25rem 0.5rem; border-radius:6px;">🔴 ${p.live_users} ao vivo</span>`
      : `<span style="color:#94a3b8; font-size:0.8rem;">0 ao vivo</span>`;

    return `
      <tr>
        <td style="font-weight:700; color:#0f172a;">${escapeHTML(p.name || 'VSL Final.mov')}</td>
        <td style="font-size:0.85rem; color:#64748b;">${p.duration_formatted || '09:27'}</td>
        <td class="text-center" style="font-weight:600;">${ouTraco(p.views)}</td>
        <td class="text-center">${ouTraco(p.uniq_visitors)}</td>
        <td class="text-center" style="font-weight:700; color:#10b981;">${ouTraco(p.plays)}</td>
        <td class="text-center" style="font-weight:700; color:#10b981;">${p.play_rate || '—'}</td>
        <td class="text-center" style="font-weight:700; color:#7c3aed;">${ouTraco(p.pitch_views)} (${p.pitch_rate || '—'})</td>
        <td class="text-center">${livePill}</td>
      </tr>
    `;
  }).join('');
}

// "—" quando a métrica não foi medida; distingue de um zero real
function ouTraco(valor, formatador = v => v.toLocaleString('pt-BR')) {
    return (valor === null || valor === undefined) ? '—' : formatador(valor);
}

function renderPagesKPIs(data) {
    const totalEl = document.getElementById('pagesKpiTotal');
    const playsEl = document.getElementById('vturbMetricPlays');
    const playRateEl = document.getElementById('vturbMetricPlayRate');
    const pitchEl = document.getElementById('vturbMetricPitch');
    const pitchRateEl = document.getElementById('vturbMetricPitchRate');
    const leadsEl = document.getElementById('pagesKpiLeads');
    const convEl = document.getElementById('pagesKpiConversion');
    const deviceEl = document.getElementById('pagesKpiDevice');
    const liveEl = document.getElementById('vturbLiveUsers');

    if (totalEl) totalEl.innerText = ouTraco(data.total_pageviews);

    const vSummary = data.vturb_summary || {};
    if (playsEl) playsEl.innerText = ouTraco(vSummary.plays);
    if (playRateEl) playRateEl.innerText = `Taxa de Play: ${vSummary.play_rate || '—'}`;
    if (pitchEl) pitchEl.innerText = ouTraco(vSummary.pitch);
    if (pitchRateEl) pitchRateEl.innerText = `Retenção Pitch: ${vSummary.pitch_rate || '—'}`;
    if (liveEl) liveEl.innerText = `${vSummary.live || 0} Ao Vivo`;

    const totalLeads = data.total_leads || 0;
    if (leadsEl) leadsEl.innerText = totalLeads.toLocaleString('pt-BR');
    if (convEl) convEl.innerText = `Taxa de Conversão: ${data.conversion_rate || '—'}`;

    const desktop = (data.by_device && data.by_device.desktop) || 0;
    const mobile = (data.by_device && data.by_device.mobile) || 0;
    if (deviceEl) deviceEl.innerText = (desktop || mobile) ? `Dispositivos: ${desktop} PC / ${mobile} Celular` : '—';

    // Aviso visível quando o tracker das LPs não registrou nada no período:
    let aviso = document.getElementById('pagesTrackerWarning');
    if (!aviso) {
        const host = document.getElementById('pagesMainTabContent');
        if (host) {
            aviso = document.createElement('div');
            aviso.id = 'pagesTrackerWarning';
            aviso.style.cssText = 'margin:0 0 1rem; padding:0.75rem 1rem; border-radius:8px; background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.35); color:#b45309; font-size:0.85rem; font-weight:600;';
            host.prepend(aviso);
        }
    }
    if (aviso) {
        if (data.tracker_ativo) {
            aviso.style.display = 'none';
        } else {
            aviso.style.display = '';
            aviso.innerHTML = 'ℹ️ Tracker de pageviews direto das LPs. Views, conversão e teste A/B mostram dados consolidados medidos no período.';
        }
    }
}

function renderPagesVariantChart(data) {
    const ctx = document.getElementById('pagesVariantChart');
    if (!ctx) return;
    
    if (pagesVariantChart) pagesVariantChart.destroy();
    
    const variants = data.by_variant || {};
    const labels = [];
    const values = [];
    const colors = ['#d4af37', '#0ea5e9'];
    
    for (let i = 1; i <= 2; i++) {
        const v = variants[i.toString()] || { views: 0, label: i === 1 ? 'VSL Aberta' : 'Sem VSL' };
        labels.push(`V${i}: ${v.label}`);
        values.push(v.views);
    }
    
    pagesVariantChart = new Chart(ctx.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: colors,
                borderColor: 'rgba(0,0,0,0.3)',
                borderWidth: 1,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        color: '#e2e8f0',
                        font: { family: 'Plus Jakarta Sans', size: 10 },
                        boxWidth: 12,
                        padding: 10
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#f8fafc',
                    bodyColor: '#cbd5e1',
                    titleFont: { family: 'Outfit', size: 13, weight: 'bold' },
                    bodyFont: { family: 'Plus Jakarta Sans', size: 12 },
                    borderColor: 'rgba(212, 175, 55, 0.3)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        label: function(context) {
                            const val = context.raw;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0';
                            return ` ${val} acessos (${pct}%)`;
                        }
                    }
                }
            },
            cutout: '65%'
        }
    });
}

function renderPagesDailyChart(data) {
    const ctx = document.getElementById('pagesDailyChart');
    if (!ctx) return;
    
    if (pagesDailyChart) pagesDailyChart.destroy();
    
    const byDay = data.by_day || [];
    const labels = byDay.map(d => {
        const parts = d.date.split('-');
        return `${parts[2]}/${parts[1]}`;
    });
    const values = byDay.map(d => d.views);
    
    pagesDailyChart = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Acessos',
                data: values,
                borderColor: '#d4af37',
                backgroundColor: 'rgba(212, 175, 55, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointBackgroundColor: '#d4af37',
                pointBorderColor: '#d4af37',
                pointRadius: 3,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    ticks: { color: '#94a3b8', font: { size: 10 } },
                    grid: { color: 'rgba(148, 163, 184, 0.1)' }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: '#94a3b8', font: { size: 10 } },
                    grid: { color: 'rgba(148, 163, 184, 0.1)' }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#f8fafc',
                    bodyColor: '#cbd5e1',
                    borderColor: 'rgba(212, 175, 55, 0.3)',
                    borderWidth: 1
                }
            }
        }
    });
}

function renderPagesVariantTable(data) {
    const tbody = document.getElementById('pagesVariantTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const variants = data.by_variant || {};
    const variantMeta = {
        '1': { vsl: 'VSL Aberta (com vídeo)', headline: 'Headline Oficial' },
        '2': { vsl: 'Sem VSL (oferta direta)', headline: 'Headline Oficial' }
    };

    // Cruzar com os leads reais do CRM para Komando
    const leadsBase = (state.filteredLeads && state.filteredLeads.length > 0) ? state.filteredLeads : (state.leads || []);
    const koLeads = leadsBase.filter(l => 
        l.pipeline_id === 13304659 || 
        l.pipeline_id === 13537971 || 
        (l._embedded?.tags || []).some(t => String(t.name || '').toUpperCase().includes('KO_') || String(t.name || '').toUpperCase().includes('KOMANDO') || String(t.name || '').toUpperCase().startsWith('AB_'))
    );

    const crmLeadsByVariant = { '1': 0, '2': 0 };
    koLeads.forEach(l => {
        const v = getLeadAbVariant(l);
        if (v && crmLeadsByVariant[v] !== undefined) {
            crmLeadsByVariant[v]++;
        }
    });
    
    // Amostra mínima para declarar um vencedor.
    const MIN_VIEWS_PARA_VENCEDOR = 15;

    let bestConv = 0;
    const rows = [];
    let totalAbLeadsCount = 0;
    for (let i = 1; i <= 2; i++) {
        const strKey = i.toString();
        const v = variants[strKey] || { views: 0, leads: 0 };
        const views = v.views || 0;
        
        // Prioriza a contagem cruzada do CRM
        const leadsCount = (crmLeadsByVariant[strKey] !== undefined && crmLeadsByVariant[strKey] > 0)
            ? crmLeadsByVariant[strKey]
            : (v.leads || 0);

        totalAbLeadsCount += leadsCount;
        const conv = views > 0 ? (leadsCount / views) * 100 : null;
        if (views >= MIN_VIEWS_PARA_VENCEDOR && conv !== null && conv > bestConv) bestConv = conv;
        rows.push({ i, v, views, leadsCount, conv });
    }

    rows.forEach(({ i, v, views, leadsCount, conv }) => {
        const meta = variantMeta[i.toString()];
        const tr = document.createElement('tr');
        const isBest = bestConv > 0 && views >= MIN_VIEWS_PARA_VENCEDOR && conv === bestConv;
        const badge = isBest ? ' <span style="background:linear-gradient(135deg,#ff6b00,#ea580c);color:#fff;padding:2px 8px;border-radius:6px;font-size:0.7rem;font-weight:800;box-shadow:0 2px 6px rgba(255,107,0,0.3);">🏆 MELHOR</span>' : '';
        tr.innerHTML = `
            <td style="font-weight:700; color:#0f172a;">Variação ${i}${badge}</td>
            <td class="text-center" style="color:#475569; font-weight:500;">${meta.vsl}</td>
            <td class="text-center" style="color:#475569; font-weight:500;">${meta.headline}</td>
            <td class="text-center" style="font-weight:700; color:#0f172a;">${views > 0 ? views.toLocaleString('pt-BR') : '—'}</td>
            <td class="text-center" style="font-weight:800; color:${leadsCount > 0 ? '#ff6b00' : '#64748b'};">${leadsCount.toLocaleString('pt-BR')}</td>
            <td class="text-center" style="font-weight:800; color:${conv !== null ? (conv > 0 ? '#059669' : '#64748b') : '#94a3b8'}; background:${conv > 0 ? 'rgba(16,185,129,0.08)' : 'transparent'}; border-radius:6px;">${conv !== null ? conv.toFixed(1) + '%' : '—'}</td>
        `;
        tbody.appendChild(tr);
    });

    const untaggedKo = Math.max(0, koLeads.length - totalAbLeadsCount);
    const summaryTr = document.createElement('tr');
    summaryTr.style.background = 'rgba(241, 245, 249, 0.7)';
    summaryTr.style.borderTop = '2px solid rgba(226, 232, 240, 0.9)';
    summaryTr.innerHTML = `
        <td colspan="3" style="font-size:0.8rem; font-weight:700; color:#475569; padding:0.75rem 1rem;">
            📌 <strong>Resumo Komando:</strong> ${totalAbLeadsCount} leads no Teste A/B | ${untaggedKo} leads anteriores ao Teste A/B
        </td>
        <td class="text-center" style="font-weight:700; font-size:0.85rem; color:#64748b;">—</td>
        <td class="text-center" style="font-weight:800; color:#ff6b00; font-size:0.95rem;">${koLeads.length} leads</td>
        <td class="text-center" style="font-size:0.75rem; color:#64748b; font-weight:600;">(Total Funil)</td>
    `;
    tbody.appendChild(summaryTr);
}

function renderPagesUtmTable(data) {
    const tbody = document.getElementById('pagesUtmTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    const sources = data.by_utm_source || {};
    const total = Object.values(sources).reduce((a, b) => a + b, 0);
    const sorted = Object.entries(sources).sort((a, b) => b[1] - a[1]);
    
    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="color:#64748b;">Nenhum dado de UTM disponível.</td></tr>';
        return;
    }
    
    sorted.forEach(([source, count]) => {
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : null;
        const tr = document.createElement('tr');
        const isNoUtm = source === 'Outras Fontes (Sem UTM)';
        tr.innerHTML = `
            <td style="font-weight:600; color:${isNoUtm ? '#64748b' : '#0f172a'};">${escapeHTML(source)} ${isNoUtm ? '<span style="font-size:0.75rem; color:#94a3b8; font-weight:normal;">(Vendas diretas/sem parâmetro na URL)</span>' : ''}</td>
            <td class="text-center" style="font-weight:600;">${count.toLocaleString('pt-BR')}</td>
            <td class="text-center" style="color:#d4af37;font-weight:700;">${pct !== null ? pct + '%' : '—'}</td>
        `;
        tbody.appendChild(tr);
    });
}

// Switch Main Executive Top Navigation Tabs (CRM, VTurb, Eduzz, Pages)
function switchMainTab(tabName) {
  state.activeMainTab = tabName;

  // 1. Update main nav buttons
  const navBtns = document.querySelectorAll('#mainExecutiveNav .main-nav-btn');
  navBtns.forEach(btn => {
    if (btn.getAttribute('data-main-tab') === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // 2. Hide all main tab content containers and show target
  const tabContents = document.querySelectorAll('.main-tab-content');
  tabContents.forEach(content => content.classList.remove('active'));

  const targetContent = document.getElementById(`${tabName}MainTabContent`);
  if (targetContent) {
    targetContent.classList.add('active');
  }

  // 3. Auto-refresh da aba Pages só roda enquanto ela está visível.
  // (Antes ficava no handler das abas de funil, que nem sempre era acionado —
  //  o intervalo continuava rodando em segundo plano nas outras abas.)
  if (pagesAutoRefreshInterval) {
    clearInterval(pagesAutoRefreshInterval);
    pagesAutoRefreshInterval = null;
  }

  // 4. Trigger specific renderers if needed
  if (tabName === 'eduzz') {
    fetchEduzzAnalytics();
  } else if (tabName === 'pages') {
    pagesSegueFiltroGlobal = true; // ao reabrir a aba, volta a seguir o filtro principal
    sincronizarPeriodoPages();
    loadPageAnalytics();
    pagesAutoRefreshInterval = setInterval(loadPageAnalytics, 60000);
  } else if (tabName === 'crm') {
    loadMetaAdsInsights();
  } else if (tabName === 'trafficSales') {
    loadTrafficSalesDashboard();
  }
}

// ============================================================
//  PAINEL EXECUTIVO TRÁFEGO X COMERCIAL
// ============================================================

let activeTrafficFunnel = 'all';

const DEFAULT_TRAFFIC_GOALS_BY_FUNNEL = {
  all: {
    investimento: [1200, 1200, 1200, 1200, 1200],
    leads: [90, 90, 90, 90, 90],
    agendadas: [15, 15, 15, 15, 15],
    comparecidas: [13, 13, 13, 13, 13],
    vendas: [10, 10, 10, 10, 10],
    faturamento: [11000, 11000, 11000, 11000, 11000],
    noShow: [2, 2, 2, 2, 2],
    cpl: [13.33, 13.33, 13.33, 13.33, 13.33],
    cpa: [80.00, 80.00, 80.00, 80.00, 80.00],
    cpr: [92.31, 92.31, 92.31, 92.31, 92.31],
    cac: [120.00, 120.00, 120.00, 120.00, 120.00],
    ticketMedio: [1100.00, 1100.00, 1100.00, 1100.00, 1100.00],
    noShowPct: [13.3, 13.3, 13.3, 13.3, 13.3],
    roas: [9.17, 9.17, 9.17, 9.17, 9.17]
  },
  mlfp: {
    investimento: [1200, 1200, 1200, 1200, 1200],
    leads: [90, 90, 90, 90, 90],
    agendadas: [15, 15, 15, 15, 15],
    comparecidas: [13, 13, 13, 13, 13],
    vendas: [10, 10, 10, 10, 10],
    faturamento: [11000, 11000, 11000, 11000, 11000],
    noShow: [2, 2, 2, 2, 2],
    cpl: [13.33, 13.33, 13.33, 13.33, 13.33],
    cpa: [80.00, 80.00, 80.00, 80.00, 80.00],
    cpr: [92.31, 92.31, 92.31, 92.31, 92.31],
    cac: [120.00, 120.00, 120.00, 120.00, 120.00],
    ticketMedio: [2997.00, 2997.00, 2997.00, 2997.00, 2997.00],
    noShowPct: [13.3, 13.3, 13.3, 13.3, 13.3],
    roas: [9.17, 9.17, 9.17, 9.17, 9.17]
  },
  komando: {
    investimento: [1000, 1000, 1000, 1000, 1000],
    leads: [100, 100, 100, 100, 100],
    agendadas: [20, 20, 20, 20, 20],
    comparecidas: [16, 16, 16, 16, 16],
    vendas: [15, 15, 15, 15, 15],
    faturamento: [15000, 15000, 15000, 15000, 15000],
    noShow: [4, 4, 4, 4, 4],
    cpl: [10.00, 10.00, 10.00, 10.00, 10.00],
    cpa: [50.00, 50.00, 50.00, 50.00, 50.00],
    cpr: [62.50, 62.50, 62.50, 62.50, 62.50],
    cac: [66.66, 66.66, 66.66, 66.66, 66.66],
    ticketMedio: [1000.00, 1000.00, 1000.00, 1000.00, 1000.00],
    noShowPct: [20.0, 20.0, 20.0, 20.0, 20.0],
    roas: [15.00, 15.00, 15.00, 15.00, 15.00]
  },
  kop: {
    investimento: [500, 500, 500, 500, 500],
    leads: [50, 50, 50, 50, 50],
    agendadas: [10, 10, 10, 10, 10],
    comparecidas: [8, 8, 8, 8, 8],
    vendas: [10, 10, 10, 10, 10],
    faturamento: [5000, 5000, 5000, 5000, 5000],
    noShow: [2, 2, 2, 2, 2],
    cpl: [10.00, 10.00, 10.00, 10.00, 10.00],
    cpa: [50.00, 50.00, 50.00, 50.00, 50.00],
    cpr: [62.50, 62.50, 62.50, 62.50, 62.50],
    cac: [50.00, 50.00, 50.00, 50.00, 50.00],
    ticketMedio: [500.00, 500.00, 500.00, 500.00, 500.00],
    noShowPct: [20.0, 20.0, 20.0, 20.0, 20.0],
    roas: [10.00, 10.00, 10.00, 10.00, 10.00]
  },
  kor: {
    investimento: [500, 500, 500, 500, 500],
    leads: [50, 50, 50, 50, 50],
    agendadas: [10, 10, 10, 10, 10],
    comparecidas: [8, 8, 8, 8, 8],
    vendas: [10, 10, 10, 10, 10],
    faturamento: [3000, 3000, 3000, 3000, 3000],
    noShow: [2, 2, 2, 2, 2],
    cpl: [10.00, 10.00, 10.00, 10.00, 10.00],
    cpa: [50.00, 50.00, 50.00, 50.00, 50.00],
    cpr: [62.50, 62.50, 62.50, 62.50, 62.50],
    cac: [50.00, 50.00, 50.00, 50.00, 50.00],
    ticketMedio: [300.00, 300.00, 300.00, 300.00, 300.00],
    noShowPct: [20.0, 20.0, 20.0, 20.0, 20.0],
    roas: [6.00, 6.00, 6.00, 6.00, 6.00]
  },
  ebook: {
    investimento: [300, 300, 300, 300, 300],
    leads: [150, 150, 150, 150, 150],
    agendadas: [0, 0, 0, 0, 0],
    comparecidas: [0, 0, 0, 0, 0],
    vendas: [30, 30, 30, 30, 30],
    faturamento: [1500, 1500, 1500, 1500, 1500],
    noShow: [0, 0, 0, 0, 0],
    cpl: [2.00, 2.00, 2.00, 2.00, 2.00],
    cpa: [0, 0, 0, 0, 0],
    cpr: [0, 0, 0, 0, 0],
    cac: [10.00, 10.00, 10.00, 10.00, 10.00],
    ticketMedio: [50.00, 50.00, 50.00, 50.00, 50.00],
    noShowPct: [0, 0, 0, 0, 0],
    roas: [5.00, 5.00, 5.00, 5.00, 5.00]
  }
};

function getSavedTrafficGoals(monthKey, funnelKey = 'all') {
  try {
    const saved = localStorage.getItem(`traffic_goals_${funnelKey}_${monthKey}`);
    if (saved) return JSON.parse(saved);
  } catch(e) {}
  const def = DEFAULT_TRAFFIC_GOALS_BY_FUNNEL[funnelKey] || DEFAULT_TRAFFIC_GOALS_BY_FUNNEL.all;
  return JSON.parse(JSON.stringify(def));
}

function saveTrafficGoalsToStorage(monthKey, funnelKey, goals) {
  try {
    localStorage.setItem(`traffic_goals_${funnelKey}_${monthKey}`, JSON.stringify(goals));
  } catch(e) {}
}

let currentTrafficSalesData = null;

async function loadTrafficSalesDashboard() {
  const monthSelect = document.getElementById('trafficSalesMonthSelect');
  const month = monthSelect ? monthSelect.value : '2026-08';
  const funnel = activeTrafficFunnel || 'all';

  const tbodyWeekly = document.getElementById('trafficWeeklyTableBody');
  const tbodyChamps = document.getElementById('championCreativesTableBody');
  const tbodyAnnual = document.getElementById('annualTrafficSalesTableBody');

  if (tbodyWeekly) tbodyWeekly.innerHTML = '<tr><td colspan="14" class="text-center py-4 text-muted">Carregando métricas de tráfego e comercial...</td></tr>';
  if (tbodyChamps) tbodyChamps.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">Carregando criativos campeões...</td></tr>';
  if (tbodyAnnual) tbodyAnnual.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Carregando histórico anual...</td></tr>';

  try {
    const res = await fetch(`/api/traffic-sales-weekly?month=${month}&funnel=${funnel}`);
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Erro ao carregar dados');
    }
    currentTrafficSalesData = data;
    renderTrafficWeeklyTable(data);
    renderChampionCreatives(data.championCreatives || []);
    renderAnnualTrafficSalesTable(data.annual || []);
  } catch(err) {
    console.error('Error loading traffic sales dashboard:', err);
    if (tbodyWeekly) tbodyWeekly.innerHTML = `<tr><td colspan="14" class="text-center py-4 text-danger">Erro: ${err.message}</td></tr>`;
  }
}

function formatMoney(val) {
  if (val === null || val === undefined || isNaN(val)) return 'R$ 0,00';
  return 'R$ ' + parseFloat(val).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTrafficWeeklyTable(data) {
  const tbody = document.getElementById('trafficWeeklyTableBody');
  if (!tbody) return;

  const monthKey = data.month || '2026-08';
  const funnelKey = data.funnel || activeTrafficFunnel || 'all';
  const goals = getSavedTrafficGoals(monthKey, funnelKey);
  const weeks = data.weeks || [];
  const totals = data.totals || {};

  const metricsConfig = [
    { key: 'investimento', label: 'Investimento', isMoney: true },
    { key: 'leads', label: 'Leads', isMoney: false },
    { key: 'agendadas', label: 'Reuniões Agendadas', isMoney: false },
    { key: 'comparecidas', label: 'Reuniões Comparecidas', isMoney: false },
    { key: 'vendas', label: 'Número de Novos Clientes / Vendas', isMoney: false, highlight: true },
    { key: 'faturamento', label: 'Valor Total Faturado / Vendas', isMoney: true, highlight: true },
    { key: 'noShow', label: 'No Show Reunião (Qtd)', isMoney: false },
    { key: 'cpl', label: 'Custo por Lead (CPL)', isMoney: true },
    { key: 'cpa', label: 'Custo por Reunião Agendada (CPA)', isMoney: true },
    { key: 'cpr', label: 'Custo por Reunião Comparecida (CPR)', isMoney: true },
    { key: 'cac', label: 'Custo de Aquisição (CAC)', isMoney: true },
    { key: 'ticketMedio', label: 'Ticket Médio', isMoney: true },
    { key: 'noShowPct', label: 'Taxa de No Show (%)', isPct: true },
    { key: 'roas', label: 'Retorno Sobre Investimento (ROAS)', isRatio: true, highlight: true }
  ];

  tbody.innerHTML = metricsConfig.map(m => {
    const goalArr = goals[m.key] || [0, 0, 0, 0, 0];
    const totalGoal = goalArr.reduce((a, b) => a + (parseFloat(b) || 0), 0);
    const totalReal = totals[m.key] || 0;

    let pctRealStr = '—';
    let pctClass = '';
    if (totalGoal > 0) {
      const pctVal = (totalReal / totalGoal) * 100;
      pctRealStr = pctVal.toFixed(1) + '%';
      if (m.key === 'noShow' || m.key === 'noShowPct' || m.key === 'cpl' || m.key === 'cac') {
        pctClass = pctVal <= 100 ? 'pct-good' : 'pct-bad';
      } else {
        pctClass = pctVal >= 90 ? 'pct-good' : (pctVal >= 60 ? 'pct-warn' : 'pct-bad');
      }
    }

    const rowClass = m.highlight ? 'row-highlight' : '';

    let cellsHtml = `<td><strong>${m.label}</strong></td>`;

    // 5 Weeks Cells (Meta vs Real)
    for (let i = 0; i < 5; i++) {
      const wReal = weeks[i] ? weeks[i][m.key] : 0;
      const gVal = goalArr[i] !== undefined ? goalArr[i] : 0;

      let realFormatted = '—';
      if (m.isMoney) realFormatted = formatMoney(wReal);
      else if (m.isPct) realFormatted = (wReal || 0) + '%';
      else if (m.isRatio) realFormatted = (wReal || 0).toFixed(2);
      else realFormatted = (wReal || 0).toLocaleString('pt-BR');

      cellsHtml += `
        <td class="text-center col-meta" style="border-left: 2px solid rgba(203,213,225,0.4);">
          <input type="text" class="editable-meta-input" data-metric="${m.key}" data-week="${i}" value="${gVal}" />
        </td>
        <td class="text-center col-real">${realFormatted}</td>
      `;
    }

    // Total Month Cells (Meta, Real, % Real)
    let totalGoalFormatted = m.isMoney ? formatMoney(totalGoal) : totalGoal.toLocaleString('pt-BR');
    if (m.isPct) totalGoalFormatted = (totalGoal / 5).toFixed(1) + '%';
    if (m.isRatio) totalGoalFormatted = (totalGoal / 5).toFixed(2);

    let totalRealFormatted = m.isMoney ? formatMoney(totalReal) : totalReal.toLocaleString('pt-BR');
    if (m.isPct) totalRealFormatted = (totalReal || 0) + '%';
    if (m.isRatio) totalRealFormatted = (totalReal || 0).toFixed(2);

    cellsHtml += `
      <td class="text-center col-meta" style="border-left: 2px solid rgba(15,23,42,0.3); font-weight:700;">${totalGoalFormatted}</td>
      <td class="text-center col-real" style="font-weight:800; color:#0f172a;">${totalRealFormatted}</td>
      <td class="text-center col-pct ${pctClass}">${pctRealStr}</td>
    `;

    return `<tr class="${rowClass}">${cellsHtml}</tr>`;
  }).join('');
}

function renderChampionCreatives(creatives) {
  const tbody = document.getElementById('championCreativesTableBody');
  if (!tbody) return;

  if (creatives.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-muted">Nenhum criativo ativo para este funil no período.</td></tr>';
    return;
  }

  tbody.innerHTML = creatives.map((c, idx) => {
    const medal = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : (idx === 2 ? '🥉' : `#${idx + 1}`));
    const isDirectSales = c.funnel === 'kop' || c.funnel === 'kor' || c.funnel === 'ebook' || (c.vendas && c.vendas > 0);

    let resultCol = '';
    let costCol = '';

    if (c.vendas && c.vendas > 0) {
      resultCol = `<span style="font-weight:800; color:#059669; font-size:0.95rem;">🛍️ ${c.vendas} venda${c.vendas > 1 ? 's' : ''}</span>${c.leads > 0 ? `<br><small style="color:#64748b;">${c.leads} leads</small>` : ''}`;
      costCol = `<span style="font-weight:800; color:#059669;">CAC: ${formatMoney(c.cac)}</span>${c.cpl > 0 ? `<br><small style="color:#64748b;">CPL: ${formatMoney(c.cpl)}</small>` : ''}`;
    } else {
      resultCol = `<span style="font-weight:800; color:#ff6b00; font-size:0.95rem;">${c.leads.toLocaleString('pt-BR')} leads</span>`;
      costCol = `<span style="font-weight:800; color:${c.cpl > 0 && c.cpl < 15 ? '#059669' : '#0f172a'};">${c.cpl > 0 ? formatMoney(c.cpl) : '—'}</span>`;
    }

    return `
      <tr>
        <td class="text-center" style="font-weight:800; font-size:1rem;">${medal}</td>
        <td style="font-weight:700; color:#0f172a;">${escapeHTML(c.nome)}</td>
        <td style="color:#475569; font-size:0.8rem;">${escapeHTML(c.campanha)}</td>
        <td class="text-center" style="font-weight:700; color:#0f172a;">${formatMoney(c.investimento)}</td>
        <td class="text-center" style="color:#64748b;">${c.impressoes.toLocaleString('pt-BR')}</td>
        <td class="text-center">${resultCol}</td>
        <td class="text-center">${costCol}</td>
        <td><span class="insight-badge">${escapeHTML(c.melhorias)}</span></td>
        <td class="text-center">
          <a href="${c.link}" target="_blank" rel="noopener noreferrer" class="ad-link-btn" title="Ver Anúncio na Biblioteca da Meta">
            🔗 Ver Anúncio
          </a>
        </td>
      </tr>
    `;
  }).join('');
}

function renderAnnualTrafficSalesTable(annual) {
  const tbody = document.getElementById('annualTrafficSalesTableBody');
  if (!tbody) return;

  let totalInvestido = 0;
  let totalFaturado = 0;

  const rowsHtml = annual.map(a => {
    totalInvestido += a.investimento || 0;
    totalFaturado += a.faturamento || 0;

    let badgeStyle = a.status === 'Lucrativo' 
      ? 'background:rgba(16,185,129,0.12); color:#059669;' 
      : (a.status === 'Em maturação' ? 'background:rgba(245,158,11,0.12); color:#d97706;' : 'background:rgba(148,163,184,0.15); color:#64748b;');

    return `
      <tr>
        <td style="font-weight:700; color:#0f172a;">${escapeHTML(a.mes)}</td>
        <td class="text-center" style="font-weight:600; color:#0f172a;">${formatMoney(a.investimento)}</td>
        <td class="text-center" style="font-weight:700; color:#059669;">${formatMoney(a.faturamento)}</td>
        <td class="text-center" style="font-weight:800; color:${a.roas >= 2 ? '#059669' : (a.roas > 0 ? '#d97706' : '#64748b')};">${a.roas > 0 ? a.roas.toFixed(2) + 'x' : '—'}</td>
        <td class="text-center">
          <span class="badge" style="${badgeStyle} font-weight:700; font-size:0.75rem; padding:0.25rem 0.6rem; border-radius:12px;">
            ${escapeHTML(a.status)}
          </span>
        </td>
      </tr>
    `;
  }).join('');

  const totalRoas = totalInvestido > 0 ? (totalFaturado / totalInvestido) : 0;

  const totalRow = `
    <tr class="row-total">
      <td style="font-weight:800; font-size:0.9rem;">TOTAL ANO</td>
      <td class="text-center" style="font-weight:800; font-size:0.9rem;">${formatMoney(totalInvestido)}</td>
      <td class="text-center" style="font-weight:800; font-size:0.9rem; color:#059669;">${formatMoney(totalFaturado)}</td>
      <td class="text-center" style="font-weight:800; font-size:0.95rem; color:#059669;">${totalRoas.toFixed(2)}x</td>
      <td class="text-center"><span class="badge" style="background:rgba(16,185,129,0.2); color:#059669; font-weight:800;">${totalRoas >= 1 ? 'Lucro Total' : 'Em Execução'}</span></td>
    </tr>
  `;

  tbody.innerHTML = rowsHtml + totalRow;
}

// Pages date pills listener & Main Executive Nav tabs
document.addEventListener('DOMContentLoaded', () => {
    const mainNav = document.getElementById('mainExecutiveNav');
    if (mainNav) {
      mainNav.querySelectorAll('.main-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const tabName = btn.getAttribute('data-main-tab');
          if (tabName) switchMainTab(tabName);
        });
      });
    }

    // Traffic Product Filter Pills
    const trafficProductNav = document.getElementById('trafficProductNav');
    if (trafficProductNav) {
      trafficProductNav.querySelectorAll('.pipeline-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const funnel = btn.getAttribute('data-traffic-funnel') || 'all';
          trafficProductNav.querySelectorAll('.pipeline-tab-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeTrafficFunnel = funnel;
          loadTrafficSalesDashboard();
        });
      });
    }

    const trafficMonthSelect = document.getElementById('trafficSalesMonthSelect');
    if (trafficMonthSelect) {
      trafficMonthSelect.addEventListener('change', () => {
        loadTrafficSalesDashboard();
      });
    }

    const btnSaveGoals = document.getElementById('btnSaveTrafficGoals');
    if (btnSaveGoals) {
      btnSaveGoals.addEventListener('click', () => {
        const monthSelect = document.getElementById('trafficSalesMonthSelect');
        const monthKey = monthSelect ? monthSelect.value : '2026-08';
        const funnelKey = activeTrafficFunnel || 'all';
        const goals = getSavedTrafficGoals(monthKey, funnelKey);

        const inputs = document.querySelectorAll('.editable-meta-input');
        inputs.forEach(input => {
          const mKey = input.getAttribute('data-metric');
          const wIdx = parseInt(input.getAttribute('data-week'), 10);
          const val = parseFloat(input.value) || 0;
          if (!goals[mKey]) goals[mKey] = [0, 0, 0, 0, 0];
          goals[mKey][wIdx] = val;
        });

        saveTrafficGoalsToStorage(monthKey, funnelKey, goals);
        if (currentTrafficSalesData) {
          renderTrafficWeeklyTable(currentTrafficSalesData);
        }
        btnSaveGoals.innerText = '✅ Salvo!';
        setTimeout(() => { btnSaveGoals.innerText = '💾 Salvar Metas'; }, 2000);
      });
    }

    const pagesDatePills = document.getElementById('pagesDatePills');
    if (pagesDatePills) {
        pagesDatePills.addEventListener('click', (e) => {
            const btn = e.target.closest('.pill-btn');
            if (!btn) return;
            pagesDatePills.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            pagesSegueFiltroGlobal = false; // escolha manual sobrepõe o filtro principal
            pagesActivePeriod = btn.getAttribute('data-period');
            loadPageAnalytics();
        });
    }

    const pagesSubnavBar = document.getElementById('pagesSubnavBar');
    if (pagesSubnavBar) {
        pagesSubnavBar.querySelectorAll('.pages-subnav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetSubtab = btn.getAttribute('data-subtab');
                pagesSubnavBar.querySelectorAll('.pages-subnav-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const subtabPanes = document.querySelectorAll('.pages-subtab-pane');
                subtabPanes.forEach(pane => pane.classList.remove('active'));

                if (targetSubtab === 'komando') {
                    const pane = document.getElementById('pagesSubtabKomando');
                    if (pane) pane.classList.add('active');
                } else if (targetSubtab === 'ecosystem') {
                    const pane = document.getElementById('pagesSubtabEcosystem');
                    if (pane) pane.classList.add('active');
                }
            });
        });
    }

    // Initialize AI Assistant
    initAIAssistant();
});

// ==========================================
// AI ASSISTANT FRONTEND CLIENT
// ==========================================
function initAIAssistant() {
    const fabBtn = document.getElementById('aiFabBtn');
    const headerBtn = document.getElementById('aiAssistantHeaderBtn');
    const drawer = document.getElementById('aiDrawer');
    const overlay = document.getElementById('aiDrawerOverlay');
    const closeBtn = document.getElementById('aiCloseDrawerBtn');
    const clearBtn = document.getElementById('aiClearChatBtn');
    const chatForm = document.getElementById('aiChatForm');
    const chatInput = document.getElementById('aiChatInput');
    const sendBtn = document.getElementById('aiSendBtn');
    const messagesContainer = document.getElementById('aiMessagesContainer');
    const chipsWrapper = document.getElementById('aiChipsWrapper');

    if (!drawer) return;

    let messageHistory = [];

    function openDrawer() {
        drawer.classList.add('active');
        if (overlay) overlay.classList.add('active');
        setTimeout(() => { if (chatInput) chatInput.focus(); }, 250);
    }

    function closeDrawer() {
        drawer.classList.remove('active');
        if (overlay) overlay.classList.remove('active');
    }

    if (fabBtn) fabBtn.addEventListener('click', openDrawer);
    if (headerBtn) headerBtn.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (overlay) overlay.addEventListener('click', closeDrawer);

    // Clear chat
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            messageHistory = [];
            if (messagesContainer) {
                messagesContainer.innerHTML = `
                    <div class="ai-message ai-message-system">
                        <div class="ai-msg-avatar">✨</div>
                        <div class="ai-msg-bubble">
                            <p>Conversa reiniciada! 🚀</p>
                            <p>Posso analisar métricas em tempo real, localizar leads no Kommo CRM, consultar respostas de formulários, vendas da Eduzz e dados de tráfego.</p>
                            <p class="ai-tip">💡 <em>Como posso te ajudar agora?</em></p>
                        </div>
                    </div>
                `;
            }
        });
    }

    // Chips click
    if (chipsWrapper) {
        chipsWrapper.addEventListener('click', (e) => {
            const chip = e.target.closest('.ai-chip-btn');
            if (!chip) return;
            const query = chip.getAttribute('data-query');
            if (query && chatInput) {
                chatInput.value = query;
                submitAIMessage(query);
            }
        });
    }

    // Auto-resize textarea
    if (chatInput) {
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
        });

        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (chatForm) chatForm.dispatchEvent(new Event('submit'));
            }
        });
    }

    // Submit form
    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = (chatInput ? chatInput.value : '').trim();
            if (!text) return;
            if (chatInput) {
                chatInput.value = '';
                chatInput.style.height = 'auto';
            }
            submitAIMessage(text);
        });
    }

    function appendMessageUI(role, htmlContent) {
        if (!messagesContainer) return;
        const msgDiv = document.createElement('div');
        msgDiv.className = `ai-message ai-message-${role}`;
        
        const avatar = role === 'user' ? '👤' : '✨';
        msgDiv.innerHTML = `
            <div class="ai-msg-avatar">${avatar}</div>
            <div class="ai-msg-bubble">${htmlContent}</div>
        `;
        messagesContainer.appendChild(msgDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        return msgDiv;
    }

    function renderSimpleMarkdown(md) {
        if (!md) return '';
        let html = md;
        
        // Escapar tags HTML básicas
        html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        // Links [texto](url)
        html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        
        // Headers ### e ####
        html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*?)$/gm, '<h3>$1</h3>');
        
        // Divisores ---
        html = html.replace(/^---$/gm, '<hr>');
        
        // Negrito **texto**
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        
        // Itálico *texto* ou _texto_
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        html = html.replace(/_(.*?)_/g, '<em>$1</em>');
        
        // Inline code `code`
        html = html.replace(/`(.*?)`/g, '<code>$1</code>');
        
        // Listas com bullet (* ou -)
        html = html.replace(/^[*-] (.*?)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
        
        // Tabelas simples em Markdown
        const lines = html.split('\n');
        let inTable = false;
        let tableHtml = '';
        let newLines = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('|') && line.endsWith('|')) {
                const cells = line.split('|').map(c => c.trim()).slice(1, -1);
                if (cells.every(c => c.startsWith('---') || c.startsWith(':---') || c.startsWith('---:'))) {
                    // Linha de separador de cabeçalho
                    continue;
                }
                if (!inTable) {
                    inTable = true;
                    tableHtml = '<table><thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
                } else {
                    tableHtml += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
                }
            } else {
                if (inTable) {
                    tableHtml += '</tbody></table>';
                    newLines.push(tableHtml);
                    inTable = false;
                    tableHtml = '';
                }
                newLines.push(line);
            }
        }
        if (inTable) {
            tableHtml += '</tbody></table>';
            newLines.push(tableHtml);
        }
        
        html = newLines.join('\n');
        
        // Parágrafos
        html = html.replace(/\n\n+/g, '</p><p>');
        html = '<p>' + html + '</p>';
        html = html.replace(/<p>\s*<\/p>/g, '');
        html = html.replace(/<p>(<h[34]>.*?<\/h[34]>)<\/p>/g, '$1');
        html = html.replace(/<p>(<table>.*?<\/table>)<\/p>/g, '$1');
        html = html.replace(/<p>(<ul>.*?<\/ul>)<\/p>/g, '$1');
        html = html.replace(/<p>(<hr>)<\/p>/g, '$1');

        return html;
    }

    async function submitAIMessage(userText) {
        // 1. Append User Message
        appendMessageUI('user', `<p>${userText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`);
        messageHistory.push({ role: 'user', content: userText });

        // 2. Append Loading / Typing indicator
        if (sendBtn) sendBtn.disabled = true;
        const typingDiv = appendMessageUI('assistant', `
            <div class="ai-typing-indicator">
                <span class="ai-typing-dot"></span>
                <span class="ai-typing-dot"></span>
                <span class="ai-typing-dot"></span>
            </div>
        `);

        try {
            // Gather active dashboard context
            const context = {
                active_pipeline: typeof currentPipelineFilter !== 'undefined' ? currentPipelineFilter : 'all',
                active_period: typeof dateFilterType !== 'undefined' ? dateFilterType : 'this_month'
            };

            const res = await fetch('/api/ai-assistant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: userText,
                    history: messageHistory,
                    context: context
                })
            });

            const data = await res.json();
            const answer = data.response || data.message || 'Não consegui processar a resposta no momento.';
            
            // Update typing div with actual answer
            if (typingDiv) {
                const bubble = typingDiv.querySelector('.ai-msg-bubble');
                if (bubble) bubble.innerHTML = renderSimpleMarkdown(answer);
            }
            messageHistory.push({ role: 'assistant', content: answer });
        } catch (err) {
            if (typingDiv) {
                const bubble = typingDiv.querySelector('.ai-msg-bubble');
                if (bubble) bubble.innerHTML = `<p style="color:#ef4444;">⚠️ Erro ao consultar assistente: ${err.message}</p>`;
            }
        } finally {
            if (sendBtn) sendBtn.disabled = false;
            if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }
}


