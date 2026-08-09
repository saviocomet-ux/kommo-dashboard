// State variables
const state = {
  leads: [],
  pipelines: [],
  users: [],
  fields: [],
  filteredLeads: [],
  // Active filters
  pipelineId: '13304583', // Default to MLFP Mentoria
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
  metaAdsData: null
};

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

  // Tab Elements
  tabKommo: document.getElementById('tabKommo'),
  tabEduzz: document.getElementById('tabEduzz'),
  kommoView: document.getElementById('kommoView'),
  eduzzView: document.getElementById('eduzzView'),

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

  // Dedicated Pipeline Tabs switching
  document.querySelectorAll('.pipeline-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.pipeline-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetPipeline = btn.getAttribute('data-pipeline');
      state.selectedStep = 'all'; // Reset stage selection when changing tabs
      if (targetPipeline === 'eduzz') {
        elements.kommoView.classList.remove('active');
        elements.eduzzView.classList.add('active');
        renderEduzzDashboard();
      } else {
        elements.kommoView.classList.add('active');
        elements.eduzzView.classList.remove('active');
        state.pipelineId = targetPipeline;
        if (elements.pipelineFilter) elements.pipelineFilter.value = targetPipeline;
        
        // Sync Media Paga sub-tab with selected pipeline
        const mediaTab = PIPELINE_FUNNEL_MAP[targetPipeline] || 'all';
        state.selectedMediaTab = mediaTab;
        const mediaBtn = document.querySelector(`.media-tab-btn[data-media-tab="${mediaTab}"]`);
        if (mediaBtn) {
          document.querySelectorAll('.media-tab-btn').forEach(b => b.classList.remove('active'));
          mediaBtn.classList.add('active');
        }

        applyFilters();
      }
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
}

// Switch tabs view
function switchTab(tabName) {
  const tabKommo = document.getElementById('tabKommo');
  const tabEduzz = document.getElementById('tabEduzz');
  const kommoView = document.getElementById('kommoView');
  const eduzzView = document.getElementById('eduzzView');

  if (tabName === 'kommo') {
    if (tabKommo) tabKommo.classList.add('active');
    if (tabEduzz) tabEduzz.classList.remove('active');
    if (kommoView) kommoView.classList.add('active');
    if (eduzzView) eduzzView.classList.remove('active');
  } else {
    if (tabKommo) tabKommo.classList.remove('active');
    if (tabEduzz) tabEduzz.classList.add('active');
    if (kommoView) kommoView.classList.remove('active');
    if (eduzzView) eduzzView.classList.add('active');
    renderEduzzDashboard();
  }
}

// Load Cached Data from API
async function loadData() {
  try {
    const [leadsResponse, pipelinesResponse, usersResponse, fieldsResponse, eduzzResponse] = await Promise.all([
      fetch('/api/leads').then(res => res.json()),
      fetch('/api/pipelines').then(res => res.json()),
      fetch('/api/users').then(res => res.json()),
      fetch('/api/custom-fields').then(res => res.json()),
      fetch('/api/eduzz-analytics').then(res => res.json())
    ]);

    state.leads = leadsResponse || [];
    state.pipelines = pipelinesResponse || {};
    state.users = usersResponse || {};
    state.fields = fieldsResponse || [];
    
    if (eduzzResponse && eduzzResponse.success) {
      state.eduzzData = eduzzResponse;
    }
    
    if (elements.lastSyncDate) {
      elements.lastSyncDate.innerText = state.leads.length > 0 
        ? new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : 'Nunca sincronizado';
    }

    populateFilters();
    
    // Smart initial preset: if current month has 0 leads in CRM, default to 'last_month' (July) so dashboard opens with active data
    const nowSecs = Math.floor(Date.now() / 1000);
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const startOfMonthSecs = Math.floor(startOfMonth.getTime() / 1000);
    const currentMonthLeads = state.leads.filter(l => l.created_at >= startOfMonthSecs && l.created_at <= nowSecs);

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

    applyFilters();
    
    if (elements.tabEduzz && elements.tabEduzz.classList.contains('active')) {
      renderEduzzDashboard();
    }
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
  const field = lead.custom_fields_values.find(cf => cf.field_id === targetId || cf.field_code === targetCode);
  if (field && field.values && field.values[0] && field.values[0].value) {
    let val = field.values[0].value.trim();
    if (val.includes('|')) {
      val = val.split('|')[0];
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

// Apply Filters to Leads list
function applyFilters() {
  let filtered = [...state.leads];

  // 1. Pipeline Filter
  if (state.pipelineId && state.pipelineId !== 'all') {
    const pipeList = String(state.pipelineId).split(',').map(id => parseInt(id.trim())).filter(n => !isNaN(n));
    filtered = filtered.filter(lead => pipeList.includes(lead.pipeline_id));
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
  updateKPIs(baseFiltered);
  updateGraphicFunnel(baseFiltered);
  renderCampaignRankings(baseFiltered);

  // 4. Step Filter (if user clicked on a specific funnel stage layer)
  if (state.selectedStep && state.selectedStep !== 'all') {
    const AGENDADA_IDS = [102599003, 102599807, 104452423];
    const NOSHOW_IDS = [108291644, 104280663, 104457987];
    const REALIZADA_IDS = [102599203, 102599811, 104458027];
    const FOLLOWUP_IDS = [108066768, 109108180];
    const DOWNSELL_IDS = [108619300];

    filtered = filtered.filter(lead => {
      const sId = parseInt(lead.status_id);
      const tags = (lead._embedded?.tags || []).map(t => t.name.toUpperCase());
      const hasMqlTag = tags.includes('MQL') || tags.includes('QUALIFICADO');
      
      const isAgendadaOrHigher = AGENDADA_IDS.includes(sId) || NOSHOW_IDS.includes(sId) || REALIZADA_IDS.includes(sId) || FOLLOWUP_IDS.includes(sId) || DOWNSELL_IDS.includes(sId) || sId === 142;
      const isNoShow = NOSHOW_IDS.includes(sId);
      const isRealizadaOrHigher = REALIZADA_IDS.includes(sId) || FOLLOWUP_IDS.includes(sId) || DOWNSELL_IDS.includes(sId) || sId === 142;
      const isFollowUp = FOLLOWUP_IDS.includes(sId);
      const isDownsell = DOWNSELL_IDS.includes(sId);
      const isWon = sId === 142;

      if (state.selectedStep === 'mql') return hasMqlTag || isAgendadaOrHigher;
      if (state.selectedStep === 'agendada') return isAgendadaOrHigher;
      if (state.selectedStep === 'noshow') return isNoShow;
      if (state.selectedStep === 'realizada') return isRealizadaOrHigher;
      if (state.selectedStep === 'followup') return isFollowUp;
      if (state.selectedStep === 'downsell') return isDownsell;
      if (state.selectedStep === 'won') return isWon;
      return true;
    });
  }

  state.filteredLeads = filtered;
  
  // Update UI Elements
  renderFunnelChart();
  renderCampaignChart();
  renderQualificationCharts();
  renderCampaignTable();
  renderTeamPerformance();

  // Load Meta Ads insights for the selected date range
  loadMetaAdsInsights();
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

  const AGENDADA_IDS = [102599003, 102599807, 104452423];
  const NOSHOW_IDS = [108291644, 104280663, 104457987];
  const REALIZADA_IDS = [102599203, 102599811, 104458027];
  const FOLLOWUP_IDS = [102598995, 102598999, 108066768, 109108180, 102599767, 102599771, 104452415, 104452419];
  const DOWNSELL_IDS = [108619300];

  baseLeads.forEach(lead => {
    const sId = parseInt(lead.status_id);
    const tags = (lead._embedded?.tags || []).map(t => t.name.toUpperCase());
    const hasMqlTag = tags.includes('MQL') || (tags.includes('QUALIFICADO') && lead.pipeline_id !== 13304659);
    const hasDesqualificado = tags.includes('DESQUALIFICADO') || tags.includes('DISQUALIFIED') || tags.includes('FORA DO PERFIL');
    const hasDownsellTag = tags.includes('DOWNSELL') || (tags.includes('EBOOK') && lead.pipeline_id !== 13304659);
    const hasFollowUpTag = tags.includes('FOLLOW UP') || tags.includes('SEM RESPOSTA');

    const isNoShow = NOSHOW_IDS.includes(sId);
    const isRealizadaOrHigher = REALIZADA_IDS.includes(sId) || sId === 142;
    const isAgendadaOrHigher = AGENDADA_IDS.includes(sId) || isNoShow || isRealizadaOrHigher;
    const isFollowUp = FOLLOWUP_IDS.includes(sId) || hasFollowUpTag;
    const isDownsell = tags.includes('DOWNSELL') || DOWNSELL_IDS.includes(sId) || (hasDownsellTag && lead.pipeline_id !== 13304659) || (hasDesqualificado && !hasMqlTag);
    const isWon = sId === 142;

    if (isWon) {
      wonCount++;
      wonRevenue += lead.price || 0;
    }
    if (hasMqlTag || isAgendadaOrHigher) {
      mqlCount++;
    }
    if (isAgendadaOrHigher) {
      agendadaCount++;
    }
    if (isNoShow) {
      noShowCount++;
    }
    if (isRealizadaOrHigher) {
      realizadaCount++;
    }
    if (isFollowUp) {
      followUpCount++;
    }
    if (isDownsell) {
      downsellCount++;
    }
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
  
  if (elAgendada) elAgendada.innerText = agendadaCount.toLocaleString('pt-BR');
  if (elAgendadaPct) elAgendadaPct.innerText = `${agendadaRate}% dos MQLs`;

  if (elNoShow) elNoShow.innerText = noShowCount.toLocaleString('pt-BR');
  if (elNoShowPct) elNoShowPct.innerText = `${noShowRate}% ausência`;

  if (elRealizada) elRealizada.innerText = realizadaCount.toLocaleString('pt-BR');
  if (elRealizadaPct) elRealizadaPct.innerText = `${realizadaRate}% show-up`;

  if (elFollowUp) elFollowUp.innerText = followUpCount.toLocaleString('pt-BR');
  if (elFollowUpPct) elFollowUpPct.innerText = `${((followUpCount / (total || 1)) * 100).toFixed(1)}% das entradas`;

  if (elDownsell) elDownsell.innerText = downsellCount.toLocaleString('pt-BR');
  if (elDownsellPct) elDownsellPct.innerText = `${((downsellCount / (total || 1)) * 100).toFixed(1)}% desqualificados`;
  
  if (elWon) elWon.innerText = wonCount.toLocaleString('pt-BR');
  if (elWonRev) elWonRev.innerText = wonRevenue > 0 
    ? wonRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : `${wonRate}% conv. final`;

  const graphicCard = document.querySelector('.graphic-funnel-card');
  if (graphicCard) {
    if (state.pipelineId === '13304583') {
      graphicCard.style.display = 'block';
    } else {
      graphicCard.style.display = 'none';
    }
  }

  const drop1 = document.getElementById('dropPct1');
  const drop2 = document.getElementById('dropPct2');
  const drop3 = document.getElementById('dropPct3');
  const drop4 = document.getElementById('dropPct4');

  if (drop1) drop1.innerText = `${mqlRate}%`;
  if (drop2) drop2.innerText = `${agendadaRate}%`;
  if (drop3) drop3.innerText = `${realizadaRate}%`;
  if (drop4) drop4.innerText = `${wonRate}%`;

  const elTitle = document.getElementById('currentFunnelTitle');
  if (elTitle) {
    if (state.pipelineId === '13304583') elTitle.innerText = 'Funil de Conversão Comercial — Mentoria MLFP';
    else if (state.pipelineId === '13304659') elTitle.innerText = 'Painel de Rastreamento & Leads — Komando KO Inbound';
    else if (state.pipelineId === '14173256') elTitle.innerText = 'Painel de Rastreamento & Leads — Komando KOP Inbound';
    else if (state.pipelineId === '13537971') elTitle.innerText = 'Painel de Rastreamento & Leads — Komando KO Ebooks';
    else elTitle.innerText = 'Painel de Rastreamento & Leads — Visão Geral';
  }
}

// Render 6 Direct Campaign Ranking Lists
function renderCampaignRankings(baseLeads = state.filteredLeads) {
  const AGENDADA_IDS = [102599003, 102599807, 104452423];
  const NOSHOW_IDS = [108291644, 104280663, 104457987];
  const REALIZADA_IDS = [102599203, 102599811, 104458027];
  const FOLLOWUP_IDS = [108066768, 109108180];
  const DOWNSELL_IDS = [108619300];

  const campaignMap = {};

  baseLeads.forEach(lead => {
    let camp = getUTMValue(lead, state.marketingGroup) || 'Direto / Sem UTM';
    if (!campaignMap[camp]) {
      campaignMap[camp] = { leads: 0, mql: 0, agendada: 0, noShow: 0, realizada: 0, followUp: 0, downsell: 0, won: 0 };
    }

    campaignMap[camp].leads++;

    const sId = parseInt(lead.status_id);
    const tags = (lead._embedded?.tags || []).map(t => t.name.toUpperCase());
    const hasMqlTag = tags.includes('MQL') || tags.includes('QUALIFICADO');
    const isAgendadaOrHigher = AGENDADA_IDS.includes(sId) || NOSHOW_IDS.includes(sId) || REALIZADA_IDS.includes(sId) || FOLLOWUP_IDS.includes(sId) || DOWNSELL_IDS.includes(sId) || sId === 142;
    const isNoShow = NOSHOW_IDS.includes(sId);
    const isRealizadaOrHigher = REALIZADA_IDS.includes(sId) || FOLLOWUP_IDS.includes(sId) || DOWNSELL_IDS.includes(sId) || sId === 142;
    const isFollowUp = FOLLOWUP_IDS.includes(sId);
    const isDownsell = DOWNSELL_IDS.includes(sId);
    const isWon = sId === 142;

    if (hasMqlTag || isAgendadaOrHigher) campaignMap[camp].mql++;
    if (isAgendadaOrHigher) campaignMap[camp].agendada++;
    if (isNoShow) campaignMap[camp].noShow++;
    if (isRealizadaOrHigher) campaignMap[camp].realizada++;
    if (isFollowUp) campaignMap[camp].followUp++;
    if (isDownsell) campaignMap[camp].downsell++;
    if (isWon) campaignMap[camp].won++;
  });

  const campaignsArray = Object.keys(campaignMap).map(name => ({
    name,
    ...campaignMap[name]
  }));

  function renderList(elementId, sortKey, unitLabel) {
    const listEl = document.getElementById(elementId);
    if (!listEl) return;

    const sorted = [...campaignsArray].sort((a, b) => b[sortKey] - a[sortKey]).slice(0, 5);
    if (sorted.length === 0 || sorted[0][sortKey] === 0) {
      listEl.innerHTML = '<li class="text-muted text-center py-2" style="font-size:0.8rem;">Nenhum lead nesta etapa</li>';
      return;
    }

    listEl.innerHTML = sorted.map(item => `
      <li class="ranking-item">
        <span class="ranking-item-name" title="${item.name}">${item.name}</span>
        <span class="ranking-item-val">${item[sortKey].toLocaleString('pt-BR')} ${unitLabel}</span>
      </li>
    `).join('');
  }

  renderList('rankLeadsList', 'leads', 'leads');
  renderList('rankMqlList', 'mql', 'MQLs');
  renderList('rankAgendadaList', 'agendada', 'agendadas');
  renderList('rankRealizadaList', 'realizada', 'feitas');
  renderList('rankFollowUpList', 'followUp', 'follow-ups');
  renderList('rankDownsellList', 'downsell', 'downsells');
}

// Modal Lead Details Functions
let currentModalStepLeads = [];

function openLeadModal(stepKey) {
  const modal = document.getElementById('leadDetailsModal');
  if (!modal) return;

  const AGENDADA_IDS = [102599003, 102599807, 104452423];
  const NOSHOW_IDS = [108291644, 104280663, 104457987];
  const REALIZADA_IDS = [102599203, 102599811, 104458027];
  const FOLLOWUP_IDS = [102598995, 102598999, 108066768, 109108180, 102599767, 102599771, 104452415, 104452419];
  const DOWNSELL_IDS = [108619300];

  let baseLeads = [...state.leads];

  if (state.pipelineId !== 'all') {
    const pId = parseInt(state.pipelineId);
    baseLeads = baseLeads.filter(lead => lead.pipeline_id === pId);
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

  let stepLeads = baseLeads.filter(lead => {
    const sId = parseInt(lead.status_id);
    const tags = (lead._embedded?.tags || []).map(t => t.name.toUpperCase());
    const hasMqlTag = tags.includes('MQL') || (tags.includes('QUALIFICADO') && lead.pipeline_id !== 13304659);
    const hasDesqualificado = tags.includes('DESQUALIFICADO') || tags.includes('DISQUALIFIED') || tags.includes('FORA DO PERFIL');
    const hasDownsellTag = tags.includes('DOWNSELL') || (tags.includes('EBOOK') && lead.pipeline_id !== 13304659);
    const hasFollowUpTag = tags.includes('FOLLOW UP') || tags.includes('SEM RESPOSTA');
    
    const isNoShow = NOSHOW_IDS.includes(sId);
    const isRealizadaOrHigher = REALIZADA_IDS.includes(sId) || sId === 142;
    const isAgendadaOrHigher = AGENDADA_IDS.includes(sId) || isNoShow || isRealizadaOrHigher;
    const isFollowUp = FOLLOWUP_IDS.includes(sId) || hasFollowUpTag;
    const isDownsell = tags.includes('DOWNSELL') || DOWNSELL_IDS.includes(sId) || (hasDownsellTag && lead.pipeline_id !== 13304659) || (hasDesqualificado && !hasMqlTag);
    const isWon = sId === 142;

    if (stepKey === 'mql') return hasMqlTag || isAgendadaOrHigher;
    if (stepKey === 'agendada') return isAgendadaOrHigher;
    if (stepKey === 'noshow') return isNoShow;
    if (stepKey === 'realizada') return isRealizadaOrHigher;
    if (stepKey === 'followup') return isFollowUp;
    if (stepKey === 'downsell') return isDownsell;
    if (stepKey === 'won') return isWon;
    return true;
  });

  currentModalStepLeads = stepLeads;

  const stepTitles = {
    all: { title: '1. Entradas na Base (Todos os Leads)', icon: '📥' },
    followup: { title: 'Follow Up (Primeiros Contatos Sem Resposta)', icon: '⏳' },
    mql: { title: '2. Qualificados (MQL)', icon: '🔥' },
    downsell: { title: 'Downsell (Leads Desqualificados)', icon: '🔄' },
    agendada: { title: '3. Reuniões Agendadas (Confirmadas pelo SDR)', icon: '📅' },
    noshow: { title: 'No Show (Ausências na Reunião)', icon: '⚠️' },
    realizada: { title: '4. Reuniões Realizadas (Show-Up Closer)', icon: '🤝' },
    won: { title: '5. Vendas Ganhas (Mentoria Fechada)', icon: '🏆' }
  };

  const info = stepTitles[stepKey] || { title: 'Leads na Etapa', icon: '🔍' };
  document.getElementById('modalStepTitle').innerText = info.title;
  document.getElementById('modalStepIcon').innerText = info.icon;
  document.getElementById('modalLeadCount').innerText = `${stepLeads.length} leads`;
  document.getElementById('modalSearchInput').value = '';

  renderModalLeadList(stepLeads);

  modal.style.display = 'flex';
}

function closeLeadModal() {
  const modal = document.getElementById('leadDetailsModal');
  if (modal) modal.style.display = 'none';
}

if (!state.contactsCache) state.contactsCache = {};

function getLeadContactValue(lead, type) {
  const contacts = lead._embedded?.contacts || [];
  if (contacts.length === 0) return '';
  const contactId = contacts[0].id || contacts[0];
  const cached = state.contactsCache[contactId];

  if (cached) {
    if (type === 'name') return cached.name || '';
    if (type === 'phone') return cached.phone || '';
    if (type === 'email') return cached.email || '';
  }

  const c = contacts[0];
  if (type === 'name') return c.name || '';
  if (type === 'phone') {
    return c.phone || (c.custom_fields_values || []).find(f => f.field_code === 'PHONE' || f.field_id === 110074)?.values?.[0]?.value || '';
  }
  if (type === 'email') {
    return c.email || (c.custom_fields_values || []).find(f => f.field_code === 'EMAIL' || f.field_id === 110076)?.values?.[0]?.value || '';
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
    const cleanPhone = phone.replace(/\D/g, '');
    const waLink = cleanPhone ? `https://wa.me/${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}` : '#';

    const campaign = getUTMValue(lead, 'campaign') || 'Sem UTM';
    const creative = getUTMValue(lead, 'content') || 'Sem Criativo';
    const dateStr = lead.created_at ? new Date(lead.created_at * 1000).toLocaleDateString('pt-BR') : '-';
    const ownerName = getUserName(lead.responsible_user_id);
    const statusName = getStatusName(lead.status_id, lead.pipeline_id);
    const kommoLink = `https://${kommoDomain}/leads/detail/${lead.id}`;

    const displayName = contactName ? `${contactName}` : (lead.name || 'Lead sem nome');
    const subtitleName = contactName && lead.name && contactName !== lead.name ? `Lead: ${lead.name} · ID: ${lead.id}` : `ID: ${lead.id}`;

    return `
      <tr>
        <td>
          <div style="font-weight:700; color:var(--color-slate-900);">${displayName}</div>
          <div style="font-size:0.75rem; color:var(--color-slate-500);">${subtitleName}</div>
        </td>
        <td>
          ${phone !== 'Sem Telefone' 
            ? `<a href="${waLink}" target="_blank" style="color:#10b981; font-weight:700; text-decoration:none;">📱 ${phone}</a>`
            : '<span class="text-muted">Sem telefone</span>'
          }
        </td>
        <td style="font-size:0.8rem;">${email !== 'Sem E-mail' ? `<a href="mailto:${email}" style="color:var(--color-primary); text-decoration:none;">📧 ${email}</a>` : '<span class="text-muted">Sem e-mail</span>'}</td>
        <td>${dateStr}</td>
        <td>
          <div style="font-weight:700; font-size:0.8rem; color:var(--color-primary);">${campaign}</div>
          <div style="font-size:0.72rem; color:var(--color-slate-500);">Criativo: <strong>${creative}</strong></div>
        </td>
        <td>${ownerName}</td>
        <td><span class="badge" style="background:rgba(226,232,240,0.8); font-size:0.75rem;">${statusName}</span></td>
        <td class="text-center">
          <a href="${kommoLink}" target="_blank" class="btn btn-sm btn-outline" style="padding:0.25rem 0.6rem; font-size:0.75rem;">🔗 CRM</a>
        </td>
      </tr>
    `;
  }).join('');
}

// Update Funnel Header Navigation & KPIs
function updateKPIs(baseLeads = state.filteredLeads) {
  const total = baseLeads.length;
  
  let active = 0;
  let won = 0;
  let lost = 0;
  let wonRevenue = 0;
  let mqlCount = 0;
  let agendadaCount = 0;
  let realizadaCount = 0;

  const AGENDADA_IDS = [102599003, 102599807, 104452423];
  const REALIZADA_IDS = [102599203, 102599811, 104458027];

  baseLeads.forEach(lead => {
    const sId = parseInt(lead.status_id);
    const tags = (lead._embedded?.tags || []).map(t => t.name.toUpperCase());
    const hasMqlTag = tags.includes('MQL') || tags.includes('QUALIFICADO');

    const isAgendadaOrHigher = AGENDADA_IDS.includes(sId) || REALIZADA_IDS.includes(sId) || sId === 142;
    const isRealizadaOrHigher = REALIZADA_IDS.includes(sId) || sId === 142;
    const isWon = sId === 142;
    const isLost = sId === 143;

    if (isWon) {
      won++;
      wonRevenue += lead.price || 0;
    } else if (isLost) {
      lost++;
    } else {
      active++;
    }

    if (hasMqlTag || isAgendadaOrHigher) {
      mqlCount++;
    }
    if (isAgendadaOrHigher) {
      agendadaCount++;
    }
    if (isRealizadaOrHigher) {
      realizadaCount++;
    }
  });

  const mqlRate = total > 0 ? ((mqlCount / total) * 100).toFixed(1) : '0.0';
  const agendadaRate = mqlCount > 0 ? ((agendadaCount / mqlCount) * 100).toFixed(1) : '0.0';
  const realizadaRate = agendadaCount > 0 ? ((realizadaCount / agendadaCount) * 100).toFixed(1) : '0.0';
  const wonRate = total > 0 ? ((won / total) * 100).toFixed(1) : '0.0';

  // Update Funnel Navigation Menu Header Cards
  const elValLeads = document.getElementById('funnelValLeads');
  const elSubLeads = document.getElementById('funnelSubLeads');
  if (elValLeads) elValLeads.innerText = total.toLocaleString('pt-BR');
  if (elSubLeads) elSubLeads.innerText = `${active.toLocaleString('pt-BR')} ativos no CRM`;

  const elValMql = document.getElementById('funnelValMql');
  const elSubMql = document.getElementById('funnelSubMql');
  const elFillMql = document.getElementById('funnelFillMql');
  if (elValMql) elValMql.innerText = mqlCount.toLocaleString('pt-BR');
  if (elSubMql) elSubMql.innerText = `${mqlRate}% do total`;
  if (elFillMql) elFillMql.style.width = `${Math.min(parseFloat(mqlRate), 100)}%`;

  const elValAgendada = document.getElementById('funnelValAgendada');
  const elSubAgendada = document.getElementById('funnelSubAgendada');
  const elFillAgendada = document.getElementById('funnelFillAgendada');
  if (elValAgendada) elValAgendada.innerText = agendadaCount.toLocaleString('pt-BR');
  if (elSubAgendada) elSubAgendada.innerText = `${agendadaRate}% dos MQLs`;
  if (elFillAgendada) elFillAgendada.style.width = `${Math.min(parseFloat(agendadaRate), 100)}%`;

  const elValRealizada = document.getElementById('funnelValRealizada');
  const elSubRealizada = document.getElementById('funnelSubRealizada');
  const elFillRealizada = document.getElementById('funnelFillRealizada');
  if (elValRealizada) elValRealizada.innerText = realizadaCount.toLocaleString('pt-BR');
  if (elSubRealizada) elSubRealizada.innerText = `${realizadaRate}% show-up`;
  if (elFillRealizada) elFillRealizada.style.width = `${Math.min(parseFloat(realizadaRate), 100)}%`;

  const elValWon = document.getElementById('funnelValWon');
  const elSubWon = document.getElementById('funnelSubWon');
  const elFillWon = document.getElementById('funnelFillWon');
  if (elValWon) elValWon.innerText = won.toLocaleString('pt-BR');
  if (elSubWon) elSubWon.innerText = wonRevenue > 0 
    ? wonRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : `${wonRate}% conv. final`;
  if (elFillWon) elFillWon.style.width = `${Math.min(parseFloat(wonRate), 100)}%`;

  // Update legacy KPI elements if present
  if (elements.metricTotalLeads) elements.metricTotalLeads.innerText = total.toLocaleString('pt-BR');
  if (elements.metricActiveLeads) elements.metricActiveLeads.innerText = `${active.toLocaleString('pt-BR')} ativos`;
  if (elements.metricWonCount) elements.metricWonCount.innerText = won.toLocaleString('pt-BR');
  if (elements.metricWonValue) elements.metricWonValue.innerText = wonRevenue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  if (elements.metricLostCount) elements.metricLostCount.innerText = lost.toLocaleString('pt-BR');
  if (elements.metricLostRate) elements.metricLostRate.innerText = `${((lost / (won + lost || 1)) * 100).toFixed(1)}% de perda`;
  if (elements.metricConversionRate) elements.metricConversionRate.innerText = `${((won / (won + lost || 1)) * 100).toFixed(1)}%`;
  if (elements.metricConversionBase) elements.metricConversionBase.innerText = `Win Rate: ${wonRate}% do total`;
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
    if (lead.status_id === 142) {
      mktData[val].won++;
      mktData[val].revenue += lead.price || 0;
    } else if (lead.status_id === 143) {
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

// Render Team performance cards
function renderTeamPerformance() {
  const teamStats = {};
  const usersList = state.users._embedded?.users || [];

  usersList.forEach(u => {
    teamStats[u.id] = { name: u.name, leads: 0, won: 0, lost: 0, revenue: 0 };
  });

  state.filteredLeads.forEach(lead => {
    const owner = lead.responsible_user_id;
    if (!teamStats[owner]) {
      teamStats[owner] = { name: getUserName(owner), leads: 0, won: 0, lost: 0, revenue: 0 };
    }
    
    teamStats[owner].leads++;
    if (lead.status_id === 142) {
      teamStats[owner].won++;
      teamStats[owner].revenue += lead.price || 0;
    } else if (lead.status_id === 143) {
      teamStats[owner].lost++;
    }
  });

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

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
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
  13956952: 'kor',         // KOR Funil de Recuperação (produto independente)
  13304583: 'mlfp',        // Mentoria MLFP
  13537971: 'ebook',       // KO Ebooks
  14104532: 'engajamento'  // Instagram (Social Selling)
};

const FUNNEL_DISPLAY = {
  mlfp: { label: 'MLFP', tagClass: 'tag-mlfp', icon: '🔵' },
  komando: { label: 'Komando', tagClass: 'tag-komando', icon: '🔴' },
  kop: { label: 'KOP', tagClass: 'tag-kop', icon: '📦' },
  kor: { label: 'KOR (Recuperação)', tagClass: 'tag-kor', icon: '🔄' },
  ebook: { label: 'Ebook', tagClass: 'tag-ebook', icon: '📚' },
  engajamento: { label: 'Social Selling', tagClass: 'tag-engajamento', icon: '📲' },
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

  // Only show for commercial funnels (not eduzz tab)
  const isEduzz = document.getElementById('eduzzView')?.classList.contains('active');
  if (isEduzz) {
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
    const funnelKey = PIPELINE_FUNNEL_MAP[lead.pipeline_id];
    if (!funnelKey) continue;
    if (!kommoFunnels[funnelKey]) {
      kommoFunnels[funnelKey] = { leads: 0, mqls: 0, wonRevenue: 0, wonCount: 0 };
    }
    kommoFunnels[funnelKey].leads++;
    
    // Check MQL tag
    const tags = (lead._embedded?.tags || []).map(t => t.name.toUpperCase());
    if (tags.includes('MQL') || tags.includes('QUALIFICADO')) {
      kommoFunnels[funnelKey].mqls++;
    }
    
    // Check won (for ROAS)
    if (parseInt(lead.status_id) === 142) {
      kommoFunnels[funnelKey].wonCount++;
      kommoFunnels[funnelKey].wonRevenue += (lead.price || 0);
    }
  }

  // Build metrics for each funnel
  const funnelOrder = ['mlfp', 'komando', 'kop', 'kor', 'ebook', 'engajamento', 'outros'];
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
    let roas = null;
    if (fKey === 'ebook' && kommo.wonRevenue > 0 && spend > 0) {
      roas = kommo.wonRevenue / spend;
    }

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
            : (row.fKey === 'ebook' ? `<span style="color:var(--text-muted)">—</span>` : `<span style="color:var(--text-muted)">n/a</span>`);

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
          <td style="font-weight: 600; color: var(--text-main);">${c.name}</td>
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

