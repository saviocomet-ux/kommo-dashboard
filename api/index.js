require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const crypto = require('crypto');

// Helper to compute SHA-256 hash for Meta Conversions API compliance
function sha256(text) {
  if (!text) return null;
  const clean = String(text).toLowerCase().trim();
  return crypto.createHash('sha256').update(clean).digest('hex');
}

// Format phone number to Meta requirements (only numbers, include country code e.g. 55)
function formatPhoneForMeta(rawPhone) {
  if (!rawPhone) return null;
  let phone = String(rawPhone).replace(/\D/g, '');
  if (!phone) return null;
  // Brasil: if length is 10 or 11 (DDD + phone number) and doesn't start with 55, prepend 55
  if (phone.length >= 10 && phone.length <= 11 && !phone.startsWith('55')) {
    phone = '55' + phone;
  }
  return phone;
}

// Split full name into first and last name for Meta CAPI
function getNameParts(fullName) {
  if (!fullName) return { fn: null, ln: null };
  const parts = String(fullName).trim().split(/\s+/);
  const fn = parts[0] || null;
  const ln = parts.slice(1).join(' ') || null;
  return { fn, ln };
}

// Meta Ads API Configuration
const META_APP_ID = process.env.META_APP_ID || '1569672838149143';
const DEFAULT_META_ACCESS_TOKEN = 'EAAWTmZBZCudBcBSDyr5qIfwdotZCyzL9GTxRiy0BNiu5QxTEidArSHgd54L7kWIdt1gTwLSnUSYd9o1AyZAGBJxmAniRbczR4k5h6iqAJzaTZAMjRhsi3IzYgG2Q5jEtpwxNQOayzwNYPOEgOq4aZAYCJ5DhtdYWl9DWrTxMCyuchbDbmcb1eqfiWVrtdGBZAO6Jtz7Due7';

// Send event to Meta Conversions API
async function sendMetaEvent(eventName, buyerInfo, customData, eventId) {
  const pixelId = process.env.META_PIXEL_ID || '825634764746487';
  const accessToken = process.env.META_ACCESS_TOKEN || DEFAULT_META_ACCESS_TOKEN;
  const testEventCode = process.env.META_TEST_EVENT_CODE;

  if (!pixelId || !accessToken) {
    console.warn('[Meta CAPI] Warning: META_PIXEL_ID or META_ACCESS_TOKEN not set. Skipping event.');
    return;
  }

  const userData = {};
  if (buyerInfo.email) {
    const hashedEmail = sha256(buyerInfo.email);
    if (hashedEmail) userData.em = [hashedEmail];
  }
  if (buyerInfo.phone) {
    const formattedPhone = formatPhoneForMeta(buyerInfo.phone);
    const hashedPhone = sha256(formattedPhone);
    if (hashedPhone) userData.ph = [hashedPhone];
  }
  if (buyerInfo.name) {
    const { fn, ln } = getNameParts(buyerInfo.name);
    const hashedFn = sha256(fn);
    const hashedLn = sha256(ln);
    if (hashedFn) userData.fn = [hashedFn];
    if (hashedLn) userData.ln = [hashedLn];
  }
  if (buyerInfo.clientIp) userData.client_ip_address = buyerInfo.clientIp;
  if (buyerInfo.clientUserAgent) userData.client_user_agent = buyerInfo.clientUserAgent;

  const eventPayload = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId || `eduzz_${Date.now()}`,
    action_source: 'system_generated',
    user_data: userData,
    custom_data: {
      event_source: 'crm',
      lead_event_source: 'Kommo',
      ...customData
    }
  };

  const body = {
    data: [eventPayload]
  };

  if (testEventCode) {
    body.test_event_code = testEventCode;
  }

  const url = `https://graph.facebook.com/v25.0/${pixelId}/events?access_token=${accessToken}`;
  console.log(`[Meta CAPI] Dispatching event: ${eventName} (Event ID: ${eventPayload.event_id}) Payload:`, JSON.stringify(body, null, 2));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const resJson = await response.json();
    if (!response.ok) {
      console.error(`[Meta CAPI] API Error:`, resJson);
    } else {
      console.log(`[Meta CAPI] Success:`, resJson);
    }
  } catch (error) {
    console.error(`[Meta CAPI] Network Error:`, error);
  }
}

// Send message via Evolution API
async function sendWhatsApp(targetPhone, message) {
  const apiUrl = process.env.EVOLUTION_API_URL || 'https://swimmingdugong-evolution.cloudfy.live';
  const apiKey = process.env.EVOLUTION_API_KEY || 'C5018DB0736C-4B49-AD4E-C1C8C008A490';
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'Notificações Chef Kaká';

  let cleanPhone = String(targetPhone).replace(/\D/g, '');
  if (cleanPhone.length >= 10 && cleanPhone.length <= 11 && !cleanPhone.startsWith('55')) {
    cleanPhone = '55' + cleanPhone;
  }

  const url = `${apiUrl.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(instanceName)}`;
  console.log(`[Evolution API] Dispatching WhatsApp report to ${cleanPhone} via URL: ${url}`);

  const body = {
    number: cleanPhone,
    text: message
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey
      },
      body: JSON.stringify(body)
    });

    const resText = await response.text();
    console.log(`[Evolution API] Status Code: ${response.status}. Response: ${resText}`);

    if (!response.ok) {
      console.error(`[Evolution API] API Error: ${resText}`);
    } else {
      console.log(`[Evolution API] Message successfully sent.`);
    }
  } catch (error) {
    console.error(`[Evolution API] Network Error:`, error);
  }
}

// Send message via Z-API
async function sendZapi(targetPhone, message) {
  const instanceId = process.env.ZAPI_INSTANCE_ID || '3EFEA33D477C038EB9D7C61238667D26';
  const token = process.env.ZAPI_TOKEN || '7AF205F57962776381052B74';
  const clientToken = process.env.ZAPI_CLIENT_TOKEN || 'F7b6f857e32b6433e8739d3bac819a251S';

  let cleanPhone = String(targetPhone).replace(/\D/g, '');
  if (cleanPhone.length >= 10 && cleanPhone.length <= 11 && !cleanPhone.startsWith('55')) {
    cleanPhone = '55' + cleanPhone;
  }

  const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`;
  console.log(`[Z-API] Dispatching WhatsApp report to ${cleanPhone} via URL: ${url}`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client-token': clientToken
      },
      body: JSON.stringify({
        phone: cleanPhone,
        message: message
      })
    });

    const resText = await response.text();
    console.log(`[Z-API] Status Code: ${response.status}. Response: ${resText}`);

    if (!response.ok) {
      console.error(`[Z-API] API Error: ${resText}`);
    } else {
      console.log(`[Z-API] Message successfully sent via Z-API.`);
    }
  } catch (error) {
    console.error(`[Z-API] Network Error:`, error);
  }
}

// Send message via Telegram Bot API (supports multiple IDs separated by commas, inline reply markup, and thread routing)
async function sendTelegram(chatId, message, replyMarkup, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const targetChatId = chatId || process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !targetChatId) {
    console.log('[Telegram Bot] Skipping: TELEGRAM_BOT_TOKEN or target chat ID not set.');
    return;
  }

  // Split by comma to support sending to multiple chat IDs/users
  const chatIds = String(targetChatId).split(',').map(id => id.trim()).filter(Boolean);

  for (const id of chatIds) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    console.log(`[Telegram Bot] Dispatching notification to chat ID ${id}`);

    try {
      let response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: id,
          text: message,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
          ...(threadId ? { message_thread_id: parseInt(threadId) } : {})
        })
      });

      let resText = await response.text();
      console.log(`[Telegram Bot] Markdown Send Status for ${id}: ${response.status}`);

      // If Telegram returns 400 Bad Request (usually markdown parse error), try as plain text
      if (!response.ok && response.status === 400) {
        console.log(`[Telegram Bot] Retrying as plain text for ${id} due to formatting error...`);
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: id,
            text: message,
            reply_markup: replyMarkup,
            ...(threadId ? { message_thread_id: parseInt(threadId) } : {})
          })
        });
        resText = await response.text();
        console.log(`[Telegram Bot] Plain Text Send Status for ${id}: ${response.status}`);
      }

      if (!response.ok) {
        console.error(`[Telegram Bot] API Error for ${id}: ${resText}`);
      } else {
        console.log(`[Telegram Bot] Telegram message successfully sent to ${id}.`);
      }
    } catch (error) {
      console.error(`[Telegram Bot] Network Error for ${id}:`, error);
    }
  }
}


// Save lead to Google Sheets (backup before CRM)
const GOOGLE_SHEETS_URL = 'https://script.google.com/macros/s/AKfycbztNCEF0QxVB-YeEFoh0nSFRKxRLTAwweogmhewNIiJAaZFodD373OUvejd9tw7MRW7nw/exec';

async function saveToGoogleSheets(sheetName, leadData) {
  try {
    console.log(`[Google Sheets] Saving lead to sheet: ${sheetName}...`);
    const response = await fetch(GOOGLE_SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: sheetName, lead: leadData }),
      redirect: 'follow'
    });
    const result = await response.text();
    console.log(`[Google Sheets] Response: ${result}`);
    try {
      const parsed = JSON.parse(result);
      return parsed;
    } catch {
      return { success: false, error: 'Invalid JSON response' };
    }
  } catch (error) {
    console.error(`[Google Sheets] Error saving lead:`, error.message);
    return { success: false, error: error.message };
  }
}

async function updateGoogleSheetsStatus(sheetName, row, status, leadId) {
  try {
    const url = `${GOOGLE_SHEETS_URL}?action=update_status&sheet=${encodeURIComponent(sheetName)}&row=${row}&status=${encodeURIComponent(status)}&lead_id=${leadId || ''}`;
    await fetch(url, { redirect: 'follow' });
  } catch (error) {
    console.error(`[Google Sheets] Error updating status:`, error.message);
  }
}

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// CORS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static files from the parent (root) directory where index.html, style.css, app.js live
app.use(express.static(path.join(__dirname, '..')));

// Vercel Environment Detection
const isVercel = process.env.VERCEL === '1' || !!process.env.NOW_REGION;
const CACHE_DIR = __dirname;

// Static references to force Vercel bundling and provide initial cache fallback
const bundledLeads = require('./all_leads.json');
const bundledPipelines = require('./pipelines.json');
const bundledUsers = require('./users.json');
const bundledFields = require('./custom_fields.json');
const bundledEduzzClients = require('./eduzz_clients_processed.json');
const bundledEduzzSales = require('./eduzz_sales_raw.json');

const BUNDLED = {
  'all_leads.json': bundledLeads,
  'pipelines.json': bundledPipelines,
  'users.json': bundledUsers,
  'custom_fields.json': bundledFields,
  'eduzz_clients_processed.json': bundledEduzzClients,
  'eduzz_sales_raw.json': bundledEduzzSales
};

// ============================================================
//  CAMADA DE ARMAZENAMENTO DO CACHE
// ============================================================
// No Vercel o filesystem é somente-leitura e /tmp é efêmero e não compartilhado
// entre invocações: o /api/sync gravava, respondia "sucesso", e no request
// seguinte os dados voltavam ao snapshot do deploy.
//
// Ordem de leitura: memória → Vercel Blob → disco (/tmp ou local) → bundled.
// Blob só é usado quando BLOB_READ_WRITE_TOKEN existe; sem ele o
// comportamento é exatamente o de antes, então nada quebra sem configuração.

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const BLOB_ATIVO = Boolean(BLOB_TOKEN);
const BLOB_PREFIXO = 'kommo-cache/';

// Sobrevive entre invocações quentes do lambda.
// Com TTL: sem ele, um lambda quente serviria para sempre o que leu na
// primeira vez, e nunca enxergaria uma sincronização feita por outra instância.
const memoriaCache = new Map();
const urlsBlob = new Map();
const TTL_MEMORIA_MS = 60 * 1000;

function lerMemoria(filename) {
  const item = memoriaCache.get(filename);
  if (!item) return undefined;
  if (Date.now() - item.gravadoEm > TTL_MEMORIA_MS) {
    memoriaCache.delete(filename);
    return undefined;
  }
  return item.dados;
}

function gravarMemoria(filename, dados) {
  memoriaCache.set(filename, { dados, gravadoEm: Date.now() });
}

function caminhoDisco(filename) {
  return isVercel ? path.join('/tmp', filename) : path.join(CACHE_DIR, filename);
}

async function listarBlobs() {
  const resp = await fetch(`https://blob.vercel-storage.com/?prefix=${encodeURIComponent(BLOB_PREFIXO)}&limit=100`, {
    headers: { authorization: `Bearer ${BLOB_TOKEN}`, 'x-api-version': '7' }
  });
  if (!resp.ok) throw new Error(`Blob list ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  (data.blobs || []).forEach(b => {
    const nome = String(b.pathname || '').replace(BLOB_PREFIXO, '');
    if (nome) urlsBlob.set(nome, b.url);
  });
  return urlsBlob;
}

async function lerDoBlob(filename) {
  if (!urlsBlob.has(filename)) await listarBlobs();
  const url = urlsBlob.get(filename);
  if (!url) return undefined;

  // cache-busting: o CDN do Blob serve a versão anterior por alguns segundos
  const resp = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Blob get ${resp.status}`);
  return resp.json();
}

async function gravarNoBlob(filename, dados) {
  const resp = await fetch(`https://blob.vercel-storage.com/${BLOB_PREFIXO}${filename}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${BLOB_TOKEN}`,
      'x-api-version': '7',
      'x-content-type': 'application/json',
      'x-add-random-suffix': '0',
      'x-cache-control-max-age': '60'
    },
    body: JSON.stringify(dados)
  });
  if (!resp.ok) throw new Error(`Blob put ${resp.status}: ${await resp.text()}`);
  const info = await resp.json();
  if (info && info.url) urlsBlob.set(filename, info.url);
  return info;
}

// Leitura assíncrona — use esta nas rotas
async function lerCache(filename, defaultVal) {
  const emMemoria = lerMemoria(filename);
  if (emMemoria !== undefined) return emMemoria;

  if (BLOB_ATIVO) {
    try {
      const dados = await lerDoBlob(filename);
      if (dados !== undefined) {
        gravarMemoria(filename, dados);
        return dados;
      }
    } catch (err) {
      console.error(`[Cache] Falha ao ler ${filename} do Blob, caindo para disco:`, err.message);
    }
  }

  const doDisco = readCacheFile(filename, defaultVal);
  gravarMemoria(filename, doDisco);
  return doDisco;
}

// Gravação — persiste no Blob quando configurado, e sempre no disco local
async function gravarCache(filename, dados) {
  gravarMemoria(filename, dados);

  let persistido = false;
  if (BLOB_ATIVO) {
    try {
      await gravarNoBlob(filename, dados);
      persistido = true;
    } catch (err) {
      console.error(`[Cache] Falha ao gravar ${filename} no Blob:`, err.message);
    }
  }

  try {
    fs.writeFileSync(caminhoDisco(filename), JSON.stringify(dados, null, 2));
    if (!isVercel) persistido = true; // em dev o disco é persistência de verdade
  } catch (err) {
    console.error(`[Cache] Falha ao gravar ${filename} em disco:`, err.message);
  }

  return persistido;
}

// Leitura síncrona (disco → bundled). Mantida para os pontos que ainda
// não são assíncronos; não enxerga o Blob.
function readCacheFile(filename, defaultVal) {
  try {
    const filePath = caminhoDisco(filename);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading cache file ${filename}:`, err);
  }

  if (filename in BUNDLED) return BUNDLED[filename];
  return defaultVal;
}

// Get path for writing cache updates
function getWriteCachePath(filename) {
  return caminhoDisco(filename);
}

// Fetch helper with Authorization
async function fetchFromKommo(endpoint) {
  const domain = process.env.KOMMO_DOMAIN;
  const token = process.env.KOMMO_LONG_LIVED_TOKEN;
  
  if (!domain || !token) {
    throw new Error('Kommo domain or long-lived token not configured in environment variables');
  }

  const url = `https://${domain}${endpoint}`;
  console.log(`[Kommo API] Fetching: ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API Error (${response.status}): ${errText || response.statusText}`);
  }

  return response.json();
}

// API Routes
app.get('/api/leads', async (req, res) => {
  const leads = await lerCache('all_leads.json', []);
  res.json(leads);
});

// Batch fetch contact details (name, phone, email) from Kommo CRM
app.post('/api/contacts/batch', async (req, res) => {
  try {
    const { contactIds } = req.body || {};
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.json({ success: true, contacts: {} });
    }
    const contactsMap = await fetchContactsInBulk(contactIds);
    res.json({ success: true, contacts: contactsMap });
  } catch (err) {
    console.error('[Contacts API] Batch fetch error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/pipelines', async (req, res) => {
  const pipelines = await lerCache('pipelines.json', {});
  res.json(pipelines);
});

app.get('/api/users', async (req, res) => {
  const users = await lerCache('users.json', {});
  res.json(users);
});

app.get('/api/custom-fields', async (req, res) => {
  const fields = await lerCache('custom_fields.json', []);
  res.json(fields);
});

// GET Eduzz Analytics (with real-time & date filter support)
app.get('/api/eduzz-analytics', async (req, res) => {
  try {
    const { from, to } = req.query;
    const processedClients = await lerCache('eduzz_clients_processed.json', []);
    const rawSales = await lerCache('eduzz_sales_raw.json', []);
    
    // Filter paid sales
    let paidSales = rawSales.filter(s => s.sale_status === 3 || s.sale_status_name === 'Paga' || s.status === 'paid');
    
    // Data da venda: o pagamento é o que vale (é quando a venda é validada).
    // Os campos reais do payload Eduzz são date_payment / date_create —
    // created_at / sale_date / date NÃO existem.
    const dataDaVenda = s => {
      const raw = s.date_payment || s.date_create;
      if (!raw) return NaN;
      return Math.floor(new Date(String(raw).replace(' ', 'T')).getTime() / 1000);
    };

    // Apply date range filter if provided
    const filtrandoPorData = Boolean(from || to);
    if (filtrandoPorData) {
      const dFrom = from ? new Date(from + 'T00:00:00-03:00').getTime() / 1000 : 0;
      const dTo = to ? new Date(to + 'T23:59:59-03:00').getTime() / 1000 : Infinity;

      paidSales = paidSales.filter(s => {
        const sSecs = dataDaVenda(s);
        // Venda sem data utilizável fica de fora quando há filtro ativo,
        // senão ela apareceria em todos os períodos
        return !isNaN(sSecs) && sSecs >= dFrom && sSecs <= dTo;
      });
    }

    // Clientes do período: reconstruídos a partir das vendas já filtradas,
    // para não misturar receita do período com base de clientes histórica.
    const clientesDoPeriodo = new Map();
    paidSales.forEach(s => {
      const chave = s.client_email || s.client_document || s.client_id;
      if (!chave) return;
      if (!clientesDoPeriodo.has(chave)) {
        clientesDoPeriodo.set(chave, {
          name: s.client_name || 'Sem nome',
          email: s.client_email || '',
          phone: s.client_cel || '',
          products: [],
          totalSpent: 0,
          salesCount: 0
        });
      }
      const c = clientesDoPeriodo.get(chave);
      const produto = s.content_title || s.product_name || 'Produto Eduzz';
      if (!c.products.includes(produto)) c.products.push(produto);
      c.totalSpent += parseFloat(s.sale_total) || parseFloat(s.value) || 0;
      c.salesCount++;
    });

    const clientes = filtrandoPorData
      ? Array.from(clientesDoPeriodo.values())
      : processedClients;

    // Calculate KPIs
    const totalClients = clientes.length;
    const multiProductClients = clientes.filter(c => c.products && c.products.length > 1).length;

    const totalSales = paidSales.length;
    const totalRevenue = paidSales.reduce((sum, s) => sum + (parseFloat(s.sale_total) || parseFloat(s.value) || 0), 0);
    const averageTicket = totalSales > 0 ? totalRevenue / totalSales : 0;
    
    // Calculate Campaign stats
    const campaignMap = {};
    paidSales.forEach(s => {
      let camp = s.utm_campaign || 'Orgânico/Direto';
      if (camp.includes('LF_EBOOK')) {
        camp = 'LF_EBOOK-PAGO-VENDAS-CADASTRO-IG-F-ADV';
      }
      const val = parseFloat(s.sale_total) || parseFloat(s.value) || 0;
      if (!campaignMap[camp]) {
        campaignMap[camp] = { salesCount: 0, revenue: 0 };
      }
      campaignMap[camp].salesCount++;
      campaignMap[camp].revenue += val;
    });
    
    const campaigns = Object.entries(campaignMap).map(([name, stats]) => ({
      name,
      salesCount: stats.salesCount,
      revenue: stats.revenue,
      avgTicket: stats.salesCount > 0 ? stats.revenue / stats.salesCount : 0
    })).sort((a, b) => b.salesCount - a.salesCount);
    
    // Calculate Product stats
    const productMap = {};
    paidSales.forEach(s => {
      const prod = s.content_title || s.product_name || 'Produto Eduzz';
      const val = parseFloat(s.sale_total) || parseFloat(s.value) || 0;
      if (!productMap[prod]) {
        productMap[prod] = { salesCount: 0, revenue: 0 };
      }
      productMap[prod].salesCount++;
      productMap[prod].revenue += val;
    });
    
    const products = Object.entries(productMap).map(([name, stats]) => ({
      name,
      salesCount: stats.salesCount,
      revenue: stats.revenue,
      avgTicket: stats.salesCount > 0 ? stats.revenue / stats.salesCount : 0
    })).sort((a, b) => b.salesCount - a.salesCount);
    
    // Compile list of multi-product clients (bought > 1 product)
    const vipClients = clientes
      .filter(c => c.products && c.products.length > 1)
      .map(c => ({
        name: c.name,
        email: c.email,
        phone: c.phone,
        products: c.products,
        totalSpent: c.totalSpent,
        salesCount: c.salesCount
      }))
      .sort((a, b) => b.totalSpent - a.totalSpent);
      
    res.json({
      success: true,
      kpis: {
        totalClients,
        multiProductClients,
        totalSales,
        totalRevenue,
        averageTicket
      },
      campaigns,
      products,
      vipClients,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating Eduzz analytics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// VTurb Video Player & Page Analytics Integration
const VTURB_API_TOKEN = process.env.VTURB_API_TOKEN || 'f913f3a4050ce208f7e56ca78d9e4a43f50c4c8cc244b8e32c276782dabff421';

async function fetchFromVTurb(path, method = 'GET', bodyData = null) {
  const https = require('https');
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  
  return new Promise((resolve, reject) => {
    try {
      const u = new URL('https://analytics.vturb.net' + path);
      const reqHeaders = {
        'User-Agent': UA,
        'Accept': 'application/json',
        'X-Api-Token': VTURB_API_TOKEN,
        'X-Api-Version': 'v1'
      };

      let postData = null;
      if (bodyData) {
        postData = JSON.stringify(bodyData);
        reqHeaders['Content-Type'] = 'application/json';
        reqHeaders['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: method,
        headers: reqHeaders
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch(e) {
            resolve({ rawBody: body });
          }
        });
      });

      req.on('error', err => reject(err));
      if (postData) req.write(postData);
      req.end();
    } catch(err) {
      reject(err);
    }
  });
}

// Resolve a janela de datas de um request.
// Sem parâmetros válidos, usa do 1º dia do mês corrente até hoje.
// Nunca usar datas fixas no código — elas vencem silenciosamente.
function resolveDateWindow(from, to) {
  const pad = num => String(num).padStart(2, '0');
  const fmt = (d, hora) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hora}`;

  const agora = new Date();
  let dFrom = new Date(agora.getFullYear(), agora.getMonth(), 1);
  let dTo = agora;

  if (from && to) {
    const pFrom = new Date(from);
    const pTo = new Date(to);
    if (!isNaN(pFrom.getTime()) && !isNaN(pTo.getTime())) {
      dFrom = pFrom;
      dTo = pTo;
    }
  }

  return {
    startDate: fmt(dFrom, '00:00:00'),
    endDate: fmt(dTo, '23:59:59')
  };
}

app.get('/api/vturb-analytics', async (req, res) => {
  try {
    const { from, to } = req.query;
    const { startDate, endDate } = resolveDateWindow(from, to);

    // 1. Fetch Players
    const players = await fetchFromVTurb(`/players/list?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
    const playerList = Array.isArray(players) ? players : [];

    let totalLiveUsers = 0;
    const playerMetrics = [];

    for (const p of playerList) {
      const pId = p.id;
      const duration = p.duration || 567;

      // Live viewers
      const liveRes = await fetchFromVTurb(`/sessions/live_users?player_id=${pId}`).catch(() => []);
      const liveUsersArr = Array.isArray(liveRes) ? liveRes : [];
      const pLive = liveUsersArr.reduce((sum, item) => sum + (item.live_users || 0), 0);
      totalLiveUsers += pLive;

      // Stats
      const statsRes = await fetchFromVTurb('/sessions/stats', 'POST', {
        player_id: pId,
        start_date: startDate,
        end_date: endDate,
        timezone: 'America/Sao_Paulo'
      }).catch(() => ({}));

      // Traffic origin
      const trafficRes = await fetchFromVTurb('/traffic_origin/stats', 'POST', {
        player_id: pId,
        video_duration: duration,
        start_date: startDate,
        end_date: endDate,
        timezone: 'America/Sao_Paulo'
      }).catch(() => []);

      playerMetrics.push({
        id: p.id,
        name: p.name,
        duration: p.duration,
        pitch_time: p.pitch_time,
        created_at: p.created_at,
        live_users: pLive,
        live_domains: liveUsersArr,
        stats: statsRes,
        traffic_origin: Array.isArray(trafficRes) ? trafficRes : []
      });
    }

    res.json({
      success: true,
      totalLiveUsers,
      players: playerMetrics
    });
  } catch(err) {
    console.error('[VTurb API Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Comprehensive Ecosystem Page Analytics Endpoint
// Fontes REAIS: pageviews.json (tracker das LPs) + VTurb (VSL) + Kommo (leads).
// Métrica sem fonte disponível retorna null — o frontend exibe "—".
// Nunca estimar pageview a partir de contagem de lead.
app.get('/api/page-analytics', async (req, res) => {
  try {
    const { since, until } = req.query;
    const { startDate, endDate } = resolveDateWindow(since, until);

    // 1. Fetch VTurb Players & Stats
    const vturbPlayers = await fetchFromVTurb(`/players/list?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`).catch(() => []);
    const playerList = Array.isArray(vturbPlayers) ? vturbPlayers : [];

    let vturbStats = { views: 0, uniq: 0, plays: 0, pitch: 0, live: 0 };
    for (const p of playerList) {
      const liveRes = await fetchFromVTurb(`/sessions/live_users?player_id=${p.id}`).catch(() => []);
      const liveCount = Array.isArray(liveRes) ? liveRes.reduce((s, i) => s + (i.live_users || 0), 0) : 0;
      vturbStats.live += liveCount;

      const stats = await fetchFromVTurb('/sessions/stats', 'POST', {
        player_id: p.id, start_date: startDate, end_date: endDate, timezone: 'America/Sao_Paulo'
      }).catch(() => ({}));

      vturbStats.views += stats.total_viewed || 0;
      vturbStats.uniq += stats.total_viewed_session_uniq || 0;
      vturbStats.plays += stats.total_started || 0;
      vturbStats.pitch += stats.total_over_pitch || 0;
    }

    // 2. Fetch CRM Leads for Conversion Cross-reference
    const allLeads = await lerCache('all_leads.json', []);
    
    // Filter CRM leads by date range
    const dFromSec = since ? Math.floor(new Date(since).getTime() / 1000) : 0;
    const dToSec = until ? Math.floor(new Date(until).getTime() / 1000) : Infinity;

    // Mesma definição usada no dashboard: Base de Clientes (registro de
    // pagamento) e Leads Antigos não são captação de LP e ficam de fora
    const FUNIS_COMERCIAIS = [13304583, 13304659, 13537971, 14173256, 14268556, 14104532, 13956952];

    const filteredLeads = allLeads.filter(l => {
      const created = l.created_at || 0;
      return FUNIS_COMERCIAIS.includes(l.pipeline_id) && created >= dFromSec && created <= dToSec;
    });

    // Categorize leads by page/pipeline
    const koLeads = filteredLeads.filter(l => l.pipeline_id === 13304659); // Komando
    const mlfpLeads = filteredLeads.filter(l => l.pipeline_id === 13304583); // Mentoria (chefkaka.com)
    const kopLeads = filteredLeads.filter(l => l.pipeline_id === 14173256); // KOP
    const korLeads = filteredLeads.filter(l => l.pipeline_id === 14268556); // KOR
    const ebookLeads = filteredLeads.filter(l => l.pipeline_id === 13537971); // Ebooks

    // 3. Pageviews REAIS registrados pelo tracker das LPs
    const allViews = await readPageviews();
    const sinceIso = since || new Date(startDate.replace(' ', 'T')).toISOString();
    const untilIso = until || new Date(endDate.replace(' ', 'T')).toISOString();

    const periodViews = allViews.filter(v => {
      const ts = v.timestamp || '';
      return ts >= sinceIso && ts <= untilIso;
    });
    const hasTracker = periodViews.length > 0;

    // Views por chave de página (o tracker envia `page`).
    // "Visitante único" só é contado quando o tracker manda session_id ou
    // visitor_id. Sem identificador não dá para saber — antes isso era
    // aproximado por device+hora, o que colapsava 4 acessos em 1 "único".
    const viewsByPage = {};
    const uniqByPage = {};
    periodViews.forEach(v => {
      const key = v.page || 'unknown';
      viewsByPage[key] = (viewsByPage[key] || 0) + 1;

      const id = v.session_id || v.visitor_id;
      if (id) {
        if (!uniqByPage[key]) uniqByPage[key] = new Set();
        uniqByPage[key].add(String(id));
      }
    });

    // A/B Variant: views do tracker, leads do CRM
    const VARIANT_LABELS = {
      '1': 'VSL Travada (7:33) - Headline 1',
      '2': 'VSL Travada (7:33) - Headline 2',
      '3': 'VSL Aberta - Headline 1',
      '4': 'VSL Aberta - Headline 2',
      '5': 'Sem VSL - Headline 1',
      '6': 'Sem VSL - Headline 2'
    };
    const variantMap = {};
    Object.keys(VARIANT_LABELS).forEach(k => {
      variantMap[k] = { label: VARIANT_LABELS[k], views: 0, leads: 0 };
    });
    periodViews.forEach(v => {
      const key = String(v.variant || '');
      if (!variantMap[key]) variantMap[key] = { label: `Variação desconhecida (${key || 'sem valor'})`, views: 0, leads: 0 };
      variantMap[key].views++;
    });
    koLeads.forEach(l => {
      const cfs = l.custom_fields_values || [];
      const varVal = cfs.find(f => f.field_id === 494249 || f.field_code === 'AB_VARIANT')?.values?.[0]?.value;
      const key = String(varVal || '');
      if (variantMap[key]) variantMap[key].leads++;
    });

    // UTM source: do tracker quando existir, senão do CRM (marcado na resposta)
    const utmSourceMap = {};
    if (hasTracker) {
      periodViews.forEach(v => {
        const src = v.utm_source || '(direto)';
        utmSourceMap[src] = (utmSourceMap[src] || 0) + 1;
      });
    } else {
      filteredLeads.forEach(l => {
        const cfs = l.custom_fields_values || [];
        const src = cfs.find(f => f.field_id === 110088 || f.field_code === 'UTM_SOURCE')?.values?.[0]?.value || '(direto)';
        utmSourceMap[src] = (utmSourceMap[src] || 0) + 1;
      });
    }

    // Acessos por dia — série real do tracker
    const byDayMap = {};
    periodViews.forEach(v => {
      const day = (v.timestamp || '').split('T')[0];
      if (day) byDayMap[day] = (byDayMap[day] || 0) + 1;
    });
    const by_day = Object.keys(byDayMap)
      .sort()
      .map(date => ({ date, views: byDayMap[date] }));

    // Dispositivo
    const by_device = {};
    periodViews.forEach(v => {
      const d = v.device || 'unknown';
      by_device[d] = (by_device[d] || 0) + 1;
    });

    // Helper: monta a linha de uma LP só com o que foi realmente medido
    const buildPage = ({ id, name, url, pageKeys, leads, vturb }) => {
      const views = pageKeys.reduce((sum, k) => sum + (viewsByPage[k] || 0), 0);
      const uniqSet = new Set();
      pageKeys.forEach(k => (uniqByPage[k] || new Set()).forEach(x => uniqSet.add(x)));

      // Ordem de preferência: tracker da LP > views do player VTurb.
      // Sem nenhum dos dois, fica null (não medido) em vez de estimado.
      let trackedViews = views > 0 ? views : null;
      let viewsOrigem = trackedViews ? 'tracker' : null;
      if (trackedViews === null && vturb && vturb.views > 0) {
        trackedViews = vturb.views;
        viewsOrigem = 'vturb';
      }

      let uniqVisitors = uniqSet.size > 0 ? uniqSet.size : null;
      if (uniqVisitors === null && viewsOrigem === 'vturb' && vturb.uniq > 0) {
        uniqVisitors = vturb.uniq;
      }

      const baseForConv = uniqVisitors || trackedViews;

      // Conversão só é comparável quando o denominador cobre a mesma
      // população do numerador. Views do VTurb medem só quem abriu a VSL,
      // enquanto os leads do CRM chegam por todas as origens do funil —
      // daí sair taxa acima de 100%. Nesse caso devolvemos null com o motivo,
      // em vez de exibir um número impossível.
      let conversionRate = null;
      let conversionObs = null;
      if (baseForConv) {
        const razao = leads / baseForConv;
        if (razao > 1) {
          conversionObs = viewsOrigem === 'vturb'
            ? 'Leads do CRM excedem os espectadores da VSL: os leads chegam por outras origens além desta página. Instale o tracker na LP para uma taxa real.'
            : 'Leads excedem os acessos medidos no período — verifique a cobertura do tracker.';
        } else {
          conversionRate = (razao * 100).toFixed(1) + '%';
        }
      }

      return {
        id,
        name,
        url,
        vsl_player_id: vturb ? vturb.playerId : null,
        views: trackedViews,
        views_origem: viewsOrigem,
        uniq_visitors: uniqVisitors,
        plays: vturb ? vturb.plays : null,
        play_rate: vturb && vturb.views > 0 ? ((vturb.plays / vturb.views) * 100).toFixed(1) + '%' : null,
        pitch_views: vturb ? vturb.pitch : null,
        pitch_rate: vturb && vturb.plays > 0 ? ((vturb.pitch / vturb.plays) * 100).toFixed(1) + '%' : null,
        leads,
        conversion_rate: conversionRate,
        conversion_obs: conversionObs,
        live_users: vturb ? vturb.live : 0
      };
    };

    const CATALOGO_PAGINAS = [
      { id: 'komando_vsl', name: 'Komando VSL Principal', url: 'consultoriakomando.com.br',
        pageKeys: ['komando_vsl', 'komando', 'consultoriakomando.com.br', '/'],
        leads: koLeads.length, vturb: { playerId: '6a820f153c0897e7c536a2e7', ...vturbStats } },
      { id: 'mentoria_mlfp', name: 'Mentoria Líder Faixa Preta (MLFP)', url: 'chefkaka.com',
        pageKeys: ['mentoria_mlfp', 'mlfp', 'chefkaka.com'],
        leads: mlfpLeads.length, vturb: null },
      { id: 'kop_inbound', name: 'KOP Inbound LP', url: 'chefkakagomes.com/kop',
        pageKeys: ['kop_inbound', 'kop', '/kop'],
        leads: kopLeads.length, vturb: null },
      { id: 'kor_inbound', name: 'KOR Inbound LP', url: 'chefkakagomes.com/kor',
        pageKeys: ['kor_inbound', 'kor', '/kor'],
        leads: korLeads.length, vturb: null },
      { id: 'ebooks_icdigitais', name: 'Ebooks & Iscas Digitais', url: 'consultoriakomando.com.br/ebooks',
        pageKeys: ['ebooks_icdigitais', 'ebooks', '/ebooks'],
        leads: ebookLeads.length, vturb: null }
    ];

    const by_page = CATALOGO_PAGINAS.map(buildPage);

    // Páginas registradas pelo tracker que não estão no catálogo acima —
    // aparecem em vez de sumirem silenciosamente
    const chavesCatalogadas = new Set(CATALOGO_PAGINAS.flatMap(p => p.pageKeys));
    Object.keys(viewsByPage).forEach(key => {
      if (chavesCatalogadas.has(key)) return;
      by_page.push({
        id: key,
        name: key,
        url: key,
        vsl_player_id: null,
        views: viewsByPage[key],
        uniq_visitors: (uniqByPage[key] || new Set()).size || null,
        plays: null,
        play_rate: null,
        pitch_views: null,
        pitch_rate: null,
        leads: null,
        conversion_rate: null,
        live_users: 0
      });
    });

    const totalViews = periodViews.length;
    const totalLeads = filteredLeads.length;

    res.json({
      success: true,
      data: {
        // null quando o tracker não registrou nada no período — evita que
        // "0" seja lido como "medido e deu zero"
        total_pageviews: hasTracker ? totalViews : null,
        total_leads: totalLeads,
        conversion_rate: hasTracker && totalViews > 0
          ? ((totalLeads / totalViews) * 100).toFixed(1) + '%'
          : null,
        tracker_ativo: hasTracker,
        utm_source_origem: hasTracker ? 'tracker' : 'crm',
        by_page,
        by_variant: variantMap,
        by_utm_source: utmSourceMap,
        by_device,
        by_day,
        periodo: { since: sinceIso, until: untilIso }
      }
    });
  } catch (err) {
    console.error('[Page Analytics Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync Data from Kommo CRM
app.post('/api/sync', async (req, res) => {
  try {
    console.log('[Sync] Starting full synchronization with Kommo CRM...');
    
    // 1. Fetch Users
    console.log('[Sync] Fetching users...');
    const usersData = await fetchFromKommo('/api/v4/users');
    await gravarCache('users.json', usersData || {});

    // 2. Fetch Pipelines
    console.log('[Sync] Fetching pipelines...');
    const pipelinesData = await fetchFromKommo('/api/v4/leads/pipelines');
    await gravarCache('pipelines.json', pipelinesData || {});

    // 3. Fetch Custom Fields
    console.log('[Sync] Fetching custom fields...');
    const fieldsData = await fetchFromKommo('/api/v4/leads/custom_fields');
    await gravarCache('custom_fields.json', fieldsData || {});

    // 4. Fetch All Leads (paged)
    console.log('[Sync] Fetching leads (paged)...');
    let allLeads = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      console.log(`[Sync] Fetching page ${page} of leads...`);
      const data = await fetchFromKommo(`/api/v4/leads?limit=250&page=${page}`);
      
      if (!data || !data._embedded || !data._embedded.leads || data._embedded.leads.length === 0) {
        hasMore = false;
        break;
      }
      
      const leads = data._embedded.leads;
      allLeads = allLeads.concat(leads);
      console.log(`[Sync] Page ${page} fetched: ${leads.length} leads. Total so far: ${allLeads.length}`);
      
      if (leads.length < 250) {
        hasMore = false;
      } else {
        page++;
        // Throttling to respect API limits (max 7 req/sec)
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const persistido = await gravarCache('all_leads.json', allLeads);
    console.log(`[Sync] Sync complete. Saved ${allLeads.length} leads. Persistido: ${persistido}`);

    // Sem persistência real, o sync some no próximo request. Dizer isso na
    // resposta evita o "sincronizado com sucesso" seguido de dados velhos.
    const aviso = persistido
      ? null
      : 'Os dados foram sincronizados, mas NÃO ficaram persistidos: no Vercel o /tmp é descartado entre requisições. Configure BLOB_READ_WRITE_TOKEN para que a sincronização valha de verdade.';

    res.json({
      success: true,
      leadsCount: allLeads.length,
      usersCount: usersData?._embedded?.users?.length || 0,
      pipelinesCount: pipelinesData?._embedded?.pipelines?.length || 0,
      persistido,
      armazenamento: BLOB_ATIVO ? 'vercel-blob' : (isVercel ? 'tmp-efemero' : 'disco-local'),
      aviso,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Sync] Error during sync:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Generic request helper for Kommo CRM API
async function kommoRequest(method, endpoint, body = null) {
  const domain = process.env.KOMMO_DOMAIN;
  const token = process.env.KOMMO_LONG_LIVED_TOKEN;
  
  if (!domain || !token) {
    throw new Error('Kommo domain or long-lived token not configured in environment variables');
  }

  const url = `https://${domain}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  
  const response = await fetch(url, opts);
  
  if (response.status === 204) {
    return null;
  }
  
  if (response.status === 429) {
    console.log('[Kommo API] Rate limited, waiting 1.5s...');
    await new Promise(r => setTimeout(r, 1500));
    return kommoRequest(method, endpoint, body);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Kommo API Error (${response.status}): ${errText}`);
  }

  return response.json();
}

let leadCustomFieldCache = null;
async function getLeadCustomFields() {
  if (leadCustomFieldCache) return leadCustomFieldCache;
  try {
    const data = await kommoRequest('GET', '/api/v4/leads/custom_fields');
    const fields = data?._embedded?.custom_fields || [];
    leadCustomFieldCache = {
      utm_source: fields.find(f => f.name?.toLowerCase()?.includes('utm_source'))?.id,
      utm_campaign: fields.find(f => f.name?.toLowerCase()?.includes('utm_campaign'))?.id,
      utm_medium: fields.find(f => f.name?.toLowerCase()?.includes('utm_medium'))?.id,
      utm_content: fields.find(f => f.name?.toLowerCase()?.includes('utm_content'))?.id
    };
    return leadCustomFieldCache;
  } catch (err) {
    console.error('Error fetching lead custom fields:', err);
    return {};
  }
}

let pipelineStatusesMapCache = null;
async function getStatusInfo(statusId) {
  // Load cached status map if it exists
  if (!pipelineStatusesMapCache) {
    pipelineStatusesMapCache = {};
    try {
      const data = await lerCache('pipelines.json', null);
      if (data && data._embedded && data._embedded.pipelines) {
        data._embedded.pipelines.forEach(p => {
          const statuses = p._embedded?.statuses || [];
          statuses.forEach(s => {
            pipelineStatusesMapCache[s.id] = { name: s.name, pipelineName: p.name, pipelineId: p.id };
          });
        });
      }
    } catch (err) {
      console.error('Error loading pipelines cache for status info:', err);
    }
  }

  // If statusId is found in cache, return it
  if (pipelineStatusesMapCache[statusId]) {
    return pipelineStatusesMapCache[statusId];
  }

  // If not found in cache, let's fetch it from Kommo API
  try {
    console.log(`[Kommo Webhook] Status ID ${statusId} not in cache, fetching pipelines from API...`);
    const data = await kommoRequest('GET', '/api/v4/leads/pipelines');
    if (data && data._embedded && data._embedded.pipelines) {
      // Rebuild cache
      pipelineStatusesMapCache = {};
      data._embedded.pipelines.forEach(p => {
        const statuses = p._embedded?.statuses || [];
        statuses.forEach(s => {
          pipelineStatusesMapCache[s.id] = { name: s.name, pipelineName: p.name, pipelineId: p.id };
        });
      });
      // Save updated pipelines to cache file
      try {
        await gravarCache('pipelines.json', data);
      } catch (writeErr) {
        console.error('Error writing updated pipelines.json cache:', writeErr);
      }
    }
  } catch (err) {
    console.error('Error fetching pipelines for status info:', err);
  }

  return pipelineStatusesMapCache[statusId] || null;
}

// Eduzz Webhook Endpoint
app.post('/api/eduzz-webhook', async (req, res) => {
  console.log('[Webhook] Received Eduzz webhook notification');
  
  // 1. Signature Verification
  const signature = req.headers['x-signature'] || req.headers['x-signature-sha256'];
  const secret = process.env.EDUZZ_WEBHOOK_SECRET;
  
  if (secret) {
    if (!signature) {
      console.warn('[Webhook] Warning: Missing signature header but webhook secret is configured');
      return res.status(401).json({ success: false, error: 'Unauthorized: Missing signature' });
    }
    
    const hmac = crypto.createHmac('sha256', secret);
    const digest = hmac.update(req.rawBody || '').digest('hex');
    
    if (signature !== digest) {
      console.error('[Webhook] Signature verification failed');
      return res.status(401).json({ success: false, error: 'Unauthorized: Invalid signature' });
    }
    console.log('[Webhook] Signature verified successfully');
  } else {
    console.log('[Webhook] Proceeding without signature verification (EDUZZ_WEBHOOK_SECRET not set)');
  }
  
  const payload = req.body;
  const event = payload.event || payload.status || '';
  const isPaidEvent = event === 'myeduzz.invoice_paid' || payload.data?.status === 'paid' || payload.status === 'paid';
  
  // 2. Handle ping event
  if (event === 'ping' || event === 'test' || payload.status === 'ping') {
    console.log('[Webhook] Ping received, responding pong');
    return res.status(200).send('pong');
  }
  
  try {
    // 3. Extract customer and purchase details
    const email = (
      payload.data?.buyer?.email || 
      payload.data?.client?.email || 
      payload.client_email || 
      payload.email || 
      ''
    ).toLowerCase().trim();
    
    const name = payload.data?.buyer?.name || 
                 payload.data?.client?.name || 
                 payload.client_name || 
                 payload.name || 
                 'Sem Nome';
                 
    const rawPhone = payload.data?.buyer?.phone || 
                     payload.data?.buyer?.cellphone || 
                     payload.data?.client?.phone || 
                     payload.client_cel || 
                     payload.phone || 
                     '';
    const phone = rawPhone.replace(/[^0-9+]/g, '');
    
    const productName = payload.data?.items?.[0]?.name || 
                        payload.data?.product_name || 
                        payload.content_title || 
                        payload.product || 
                        payload.product_name || 
                        'Produto Eduzz';
                        
    const value = parseFloat(payload.data?.gains?.producer?.value) || 
                  parseFloat(payload.data?.value) || 
                  parseFloat(payload.data?.amount) || 
                  parseFloat(payload.sale_total) || 
                  parseFloat(payload.value) || 
                  0;
                  
    const valueToAdd = isPaidEvent ? value : 0;
                  
    const utm_source = payload.data?.utm_source || payload.utm_source || '';
    const utm_campaign = payload.data?.utm_campaign || payload.utm_campaign || '';
    const utm_medium = payload.data?.utm_medium || payload.utm_medium || '';
    const utm_content = payload.data?.utm_content || payload.utm_content || '';
    
    const eduzzId = payload.data?.id || 
                    payload.data?.invoice?.id || 
                    payload.sale_id || 
                    payload.invoice_id || 
                    payload.id || 
                    String(Date.now());
                    
    const clientIp = payload.data?.client_ip || payload.client_ip || payload.data?.buyer?.ip || null;
    const clientUserAgent = payload.data?.client_user_agent || payload.client_user_agent || null;
    
    console.log(`[Webhook] Sale Details:
      Email: ${email}
      Client: ${name}
      Product: ${productName}
      Value: R$ ${value.toFixed(2)}
    `);
    
    if (!email) {
      console.warn('[Webhook] No email address in payload or non-client event, ignoring request');
      return res.status(200).json({ success: true, message: 'Ignored: Email address is required but was not found' });
    }
    
    const PIPELINES = {
      CLIENTS: {
        ID: 13956856, // Base de Clientes - Edduz
        STATUS_DEFAULT: 107711720 // Boas-vindas
      },
      RECOVERY: {
        ID: 13956952, // Funil de Recuperação
        STATUS_BOLETO: 107712464, // Boleto Gerado
        STATUS_PIX: 107712468, // Pix Pendente
        STATUS_ABANDONMENT: 107712472 // Carrinho Abandonado
      }
    };

    const isRecoveryEvent = event === 'sun.cart_abandonment' ||
                            event === 'myeduzz.contract_bankslip_attempted' ||
                            event === 'myeduzz.contract_pix_attempted' ||
                            event === 'myeduzz.contract_card_attempted';

    if (!isPaidEvent && !isRecoveryEvent) {
      console.log(`[Webhook] Ignoring non-sale and non-recovery event: ${event}`);
      return res.status(200).json({ success: true, message: `Ignored event: ${event}` });
    }

    let recoveryStatus = PIPELINES.RECOVERY.STATUS_ABANDONMENT;
    const paymentMethod = (
      payload.data?.payment?.method || 
      payload.sale_payment_method || 
      payload.payment_method || 
      ''
    ).toLowerCase();
    
    if (
      event === 'myeduzz.contract_bankslip_attempted' || 
      paymentMethod.includes('boleto') || 
      paymentMethod.includes('bankslip') || 
      paymentMethod.includes('billet')
    ) {
      recoveryStatus = PIPELINES.RECOVERY.STATUS_BOLETO;
    } else if (
      event === 'myeduzz.contract_pix_attempted' || 
      paymentMethod.includes('pix')
    ) {
      recoveryStatus = PIPELINES.RECOVERY.STATUS_PIX;
    } else {
      recoveryStatus = PIPELINES.RECOVERY.STATUS_ABANDONMENT;
    }
    
    // 4. Search existing contact by email in Kommo CRM
    console.log(`[Webhook] Searching for existing contact: ${email}...`);
    const contactSearch = await kommoRequest('GET', `/api/v4/contacts?query=${encodeURIComponent(email)}&with=leads`);
    const existingContacts = contactSearch?._embedded?.contacts || [];
    
    if (isPaidEvent) {
      // --- CLIENT PIPELINE (PAID SALES) ---
      if (existingContacts.length > 0) {
        // Sort to find the oldest contact as primary
        existingContacts.sort((a, b) => a.id - b.id);
        const primaryContact = existingContacts[0];
        const contactId = primaryContact.id;
        console.log(`[Webhook] Paid Event: Found existing contact ID: ${contactId} (${primaryContact.name || 'unnamed'})`);
        
        // A. If they have a lead in the Recovery Pipeline, mark it as WON (status 142)
        const linkedLeads = primaryContact._embedded?.leads || [];
        for (const leadRef of linkedLeads) {
          try {
            const lead = await kommoRequest('GET', `/api/v4/leads/${leadRef.id}`);
            if (lead && lead.pipeline_id === PIPELINES.RECOVERY.ID && lead.status_id !== 142) {
              console.log(`[Webhook] Moving recovery lead ${lead.id} to WON status (142)...`);
              await kommoRequest('PATCH', `/api/v4/leads/${lead.id}`, { status_id: 142 });
            }
          } catch (leadErr) {
            console.error(`[Webhook] Error updating recovery lead ${leadRef.id}:`, leadErr.message);
          }
        }

        // B. Check if contact already has a lead in the Clients Pipeline
        let existingLead = null;
        for (const leadRef of linkedLeads) {
          try {
            const lead = await kommoRequest('GET', `/api/v4/leads/${leadRef.id}`);
            if (lead && lead.pipeline_id === PIPELINES.CLIENTS.ID) {
              existingLead = lead;
              break;
            }
          } catch (leadErr) {
            console.error(`[Webhook] Error fetching client lead ${leadRef.id}:`, leadErr.message);
          }
        }

        if (existingLead) {
          console.log(`[Webhook] Paid Event: Updating existing lead ID ${existingLead.id} in Clients Pipeline`);
          const updatedPrice = (existingLead.price || 0) + Math.round(valueToAdd);
          
          // Merge tags
          const existingTags = existingLead._embedded?.tags?.map(t => t.name) || [];
          const newTags = Array.from(new Set(['Eduzz', ...existingTags, productName.substring(0, 50)]));
          
          const fieldIds = await getLeadCustomFields();
          const customFieldsValues = [];
          if (fieldIds.utm_source && utm_source) customFieldsValues.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
          if (fieldIds.utm_campaign && utm_campaign) customFieldsValues.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
          if (fieldIds.utm_medium && utm_medium) customFieldsValues.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
          if (fieldIds.utm_content && utm_content) customFieldsValues.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });

          await kommoRequest('PATCH', `/api/v4/leads/${existingLead.id}`, {
            price: updatedPrice,
            custom_fields_values: customFieldsValues.length > 0 ? customFieldsValues : undefined,
            _embedded: {
              tags: newTags.map(name => ({ name }))
            }
          });
          console.log(`[Webhook] Lead ${existingLead.id} updated successfully: Price: R$ ${updatedPrice}`);
        } else {
          console.log('[Webhook] Paid Event: Contact exists but no lead in Clients Pipeline. Creating new lead...');
          const fieldIds = await getLeadCustomFields();
          const customFieldsValues = [];
          if (fieldIds.utm_source && utm_source) customFieldsValues.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
          if (fieldIds.utm_campaign && utm_campaign) customFieldsValues.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
          if (fieldIds.utm_medium && utm_medium) customFieldsValues.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
          if (fieldIds.utm_content && utm_content) customFieldsValues.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });

          const leadData = {
            name: `[Eduzz] ${primaryContact.name || name}`,
            price: Math.round(valueToAdd),
            pipeline_id: PIPELINES.CLIENTS.ID,
            status_id: PIPELINES.CLIENTS.STATUS_DEFAULT,
            custom_fields_values: customFieldsValues.length > 0 ? customFieldsValues : undefined,
            _embedded: {
              tags: [
                { name: 'Eduzz' },
                { name: productName.substring(0, 50) }
              ]
            }
          };

          const newLeadRes = await kommoRequest('POST', '/api/v4/leads', [leadData]);
          const newLeadId = newLeadRes?._embedded?.leads?.[0]?.id;
          if (newLeadId) {
            await kommoRequest('POST', `/api/v4/leads/${newLeadId}/link`, [{
              to_entity_id: contactId,
              to_entity_type: 'contacts'
            }]);
            console.log(`[Webhook] Created lead ${newLeadId} in Clients Pipeline and linked to contact ${contactId}`);
          }
        }
      } else {
        console.log('[Webhook] Paid Event: Contact not found. Creating new lead + contact in Clients Pipeline...');
        const fieldIds = await getLeadCustomFields();
        const customFieldsValues = [];
        if (fieldIds.utm_source && utm_source) customFieldsValues.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
        if (fieldIds.utm_campaign && utm_campaign) customFieldsValues.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
        if (fieldIds.utm_medium && utm_medium) customFieldsValues.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
        if (fieldIds.utm_content && utm_content) customFieldsValues.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });

        const complexLead = {
          name: `[Eduzz] ${name}`,
          price: Math.round(valueToAdd),
          pipeline_id: PIPELINES.CLIENTS.ID,
          status_id: PIPELINES.CLIENTS.STATUS_DEFAULT,
          custom_fields_values: customFieldsValues.length > 0 ? customFieldsValues : undefined,
          _embedded: {
            tags: [
              { name: 'Eduzz' },
              { name: productName.substring(0, 50) }
            ],
            contacts: [{
              first_name: name,
              custom_fields_values: [
                {
                  field_id: 110076,
                  values: [{ value: email, enum_code: 'WORK' }]
                },
                ...(phone ? [{
                  field_id: 110074,
                  values: [{ value: phone, enum_code: 'MOB' }]
                }] : [])
              ]
            }]
          }
        };
        await kommoRequest('POST', '/api/v4/leads/complex', [complexLead]);
        console.log('[Webhook] New lead + contact created successfully in Clients Pipeline');
      }

      // Notify new approved sale on Telegram
      try {
        const saleMessage = `🎉 *Nova Venda Aprovada!*
        
👤 *Cliente:* ${name}
✉️ *E-mail:* ${email || 'Não informado'}
📞 *Telefone:* ${phone || 'Não informado'}
📦 *Produto:* ${productName}
💰 *Valor:* R$ ${value.toFixed(2)}
🔢 *ID Fatura:* ${eduzzId}`;
        
        // Send to Telegram (private chat)
        await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, saleMessage);
      } catch (telErr) {
        console.error('[Eduzz Webhook] Error sending sale notification to Telegram:', telErr);
      }
    } else if (isRecoveryEvent) {
      // --- RECOVERY PIPELINE (ABANDONMENTS / ERRORS / PENDING) ---
      if (existingContacts.length > 0) {
        existingContacts.sort((a, b) => a.id - b.id);
        const primaryContact = existingContacts[0];
        const contactId = primaryContact.id;
        console.log(`[Webhook] Recovery Event: Found existing contact ID: ${contactId} (${primaryContact.name || 'unnamed'})`);

        // Check if they already have a lead in the Recovery Pipeline (that isn't closed won/lost)
        const linkedLeads = primaryContact._embedded?.leads || [];
        let existingRecoveryLead = null;
        for (const leadRef of linkedLeads) {
          try {
            const lead = await kommoRequest('GET', `/api/v4/leads/${leadRef.id}`);
            if (lead && lead.pipeline_id === PIPELINES.RECOVERY.ID && lead.status_id !== 142 && lead.status_id !== 143) {
              existingRecoveryLead = lead;
              break;
            }
          } catch (leadErr) {
            console.error(`[Webhook] Error fetching recovery lead ${leadRef.id}:`, leadErr.message);
          }
        }

        if (existingRecoveryLead) {
          console.log(`[Webhook] Recovery Event: Updating existing lead ID ${existingRecoveryLead.id} in Recovery Pipeline to status ${recoveryStatus}`);
          
          // Merge tags
          const existingTags = existingRecoveryLead._embedded?.tags?.map(t => t.name) || [];
          const newTags = Array.from(new Set(['KOR', 'Recuperação', ...existingTags, productName.substring(0, 50)]));
          
          const fieldIds = await getLeadCustomFields();
          const customFieldsValues = [];
          if (fieldIds.utm_source && utm_source) customFieldsValues.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
          if (fieldIds.utm_campaign && utm_campaign) customFieldsValues.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
          if (fieldIds.utm_medium && utm_medium) customFieldsValues.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
          if (fieldIds.utm_content && utm_content) customFieldsValues.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });

          await kommoRequest('PATCH', `/api/v4/leads/${existingRecoveryLead.id}`, {
            status_id: recoveryStatus,
            price: Math.round(value), // update to current recovery potential value
            custom_fields_values: customFieldsValues.length > 0 ? customFieldsValues : undefined,
            _embedded: {
              tags: newTags.map(name => ({ name }))
            }
          });
          console.log(`[Webhook] Recovery Lead ${existingRecoveryLead.id} updated successfully`);
        } else {
          console.log('[Webhook] Recovery Event: Contact exists but no active lead in Recovery Pipeline. Creating new recovery lead...');
          const fieldIds = await getLeadCustomFields();
          const customFieldsValues = [];
          if (fieldIds.utm_source && utm_source) customFieldsValues.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
          if (fieldIds.utm_campaign && utm_campaign) customFieldsValues.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
          if (fieldIds.utm_medium && utm_medium) customFieldsValues.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
          if (fieldIds.utm_content && utm_content) customFieldsValues.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });

          const leadData = {
            name: `[Recuperação] ${primaryContact.name || name}`,
            price: Math.round(value),
            pipeline_id: PIPELINES.RECOVERY.ID,
            status_id: recoveryStatus,
            custom_fields_values: customFieldsValues.length > 0 ? customFieldsValues : undefined,
            _embedded: {
              tags: [
                { name: 'KOR' },
                { name: 'Recuperação' },
                { name: productName.substring(0, 50) }
              ]
            }
          };

          const newLeadRes = await kommoRequest('POST', '/api/v4/leads', [leadData]);
          const newLeadId = newLeadRes?._embedded?.leads?.[0]?.id;
          if (newLeadId) {
            await kommoRequest('POST', `/api/v4/leads/${newLeadId}/link`, [{
              to_entity_id: contactId,
              to_entity_type: 'contacts'
            }]);
            console.log(`[Webhook] Created recovery lead ${newLeadId} and linked to contact ${contactId}`);
          }
        }
      } else {
        console.log('[Webhook] Recovery Event: Contact not found. Creating new lead + contact in Recovery Pipeline...');
        const fieldIds = await getLeadCustomFields();
        const customFieldsValues = [];
        if (fieldIds.utm_source && utm_source) customFieldsValues.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
        if (fieldIds.utm_campaign && utm_campaign) customFieldsValues.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
        if (fieldIds.utm_medium && utm_medium) customFieldsValues.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
        if (fieldIds.utm_content && utm_content) customFieldsValues.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });

        const complexLead = {
          name: `[Recuperação] ${name}`,
          price: Math.round(value),
          pipeline_id: PIPELINES.RECOVERY.ID,
          status_id: recoveryStatus,
          custom_fields_values: customFieldsValues.length > 0 ? customFieldsValues : undefined,
          _embedded: {
            tags: [
              { name: 'KOR' },
              { name: 'Recuperação' },
              { name: productName.substring(0, 50) }
            ],
            contacts: [{
              first_name: name,
              custom_fields_values: [
                {
                  field_id: 110076,
                  values: [{ value: email, enum_code: 'WORK' }]
                },
                ...(phone ? [{
                  field_id: 110074,
                  values: [{ value: phone, enum_code: 'MOB' }]
                }] : [])
              ]
            }]
          }
        };
        await kommoRequest('POST', '/api/v4/leads/complex', [complexLead]);
        console.log('[Webhook] New recovery lead + contact created successfully in Recovery Pipeline');
      }
    }
    
    // 5. Send Meta Conversions API event
    try {
      const eventName = isPaidEvent ? 'Purchase' : 'InitiateCheckout';
      const eventId = `eduzz_${eduzzId}`;
      const buyerInfo = {
        email,
        phone,
        name,
        clientIp,
        clientUserAgent
      };
      
      const customData = {
        value: Number(value.toFixed(2)),
        currency: 'BRL',
        content_name: productName,
        content_type: 'product'
      };
      
      if (utm_source) customData.utm_source = utm_source;
      if (utm_medium) customData.utm_medium = utm_medium;
      if (utm_campaign) customData.utm_campaign = utm_campaign;
      if (utm_content) customData.utm_content = utm_content;

      await sendMetaEvent(eventName, buyerInfo, customData, eventId);
    } catch (capiErr) {
      console.error('[Webhook] Failed to send Meta CAPI event:', capiErr.message);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('[Webhook] Error processing webhook event:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kommo CRM Webhook Endpoint
app.post('/api/kommo-webhook', async (req, res) => {
  console.log('[Kommo Webhook] Received status update notification');
  
  let leadsToProcess = [];
  if (req.body?.leads?.status) {
    leadsToProcess = req.body.leads.status;
  } else if (req.body?.leads?.update) {
    leadsToProcess = req.body.leads.update;
  } else if (req.body?.leads?.add) {
    leadsToProcess = req.body.leads.add;
  }

  if (leadsToProcess.length === 0) {
    console.log('[Kommo Webhook] No leads found in payload');
    return res.status(200).json({ success: true, message: 'No leads found' });
  }

  try {
    for (const lead of leadsToProcess) {
      const leadId = lead.id;
      const statusId = lead.status_id;
      
      if (!statusId) continue;
      
      const statusInfo = await getStatusInfo(statusId);
      if (!statusInfo) {
        console.log(`[Kommo Webhook] Could not resolve status ID ${statusId}`);
        continue;
      }
      
      const statusName = (statusInfo.name || '').toLowerCase().trim();
      let metaEvent = null;
      
      if (statusName.includes('reunião agendada') || statusName.includes('reuniao agendada')) {
        metaEvent = 'ReuniaoAgendada';
      } else if (statusName.includes('reunião realizada') || statusName.includes('reuniao realizada')) {
        metaEvent = 'ReuniaoRealizada';
      }
      
      if (!metaEvent) {
        console.log(`[Kommo Webhook] Status "${statusInfo.name}" does not match criteria for Meta event`);
        continue;
      }
      
      console.log(`[Kommo Webhook] Lead ${leadId} moved to "${statusInfo.name}". Fetching contact...`);
      
      try {
        const leadDetails = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
        const contacts = leadDetails?._embedded?.contacts || [];
        
        if (contacts.length === 0) {
          console.warn(`[Kommo Webhook] Lead ${leadId} has no linked contacts`);
          continue;
        }
        
        contacts.sort((a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0));
        const mainContactRef = contacts[0];
        
        const contactDetails = await kommoRequest('GET', `/api/v4/contacts/${mainContactRef.id}`);
        if (!contactDetails) continue;
        
        const fields = contactDetails.custom_fields_values || [];
        let email = '';
        let phone = '';
        
        fields.forEach(f => {
          if (f.field_code === 'EMAIL' || f.field_id === 110076) {
            email = f.values?.[0]?.value || email;
          }
          if (f.field_code === 'PHONE' || f.field_id === 110074) {
            phone = f.values?.[0]?.value || phone;
          }
        });
        
        const name = contactDetails.name || leadDetails.name || 'Sem Nome';
        
        const buyerInfo = {
          email,
          phone,
          name
        };
        
        const customData = {
          value: parseFloat(leadDetails.price) || 0,
          currency: 'BRL',
          content_name: leadDetails.name || 'Oportunidade CRM',
          content_type: 'product',
          pipeline_name: statusInfo.pipelineName,
          status_name: statusInfo.name
        };
        
        const eventId = `kommo_${leadId}_${statusId}`;
        await sendMetaEvent(metaEvent, buyerInfo, customData, eventId);
      } catch (err) {
        console.error(`[Kommo Webhook] Error fetching details for lead ${leadId}:`, err.message);
      }
    }
    
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Kommo Webhook] Internal server error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper to extract values from payload using flexible, case-insensitive, and accent-insensitive matching
function getFlexibleValue(payload, possibleKeys) {
  if (!payload || typeof payload !== 'object') return '';
  
  const fields = payload.fields || {};
  const formData = payload.form_data || {};
  const utmData = payload.utm_data || {};
  
  const getValue = (obj, key) => {
    if (!obj || typeof obj !== 'object') return null;
    
    // Direct match (case-sensitive)
    if (obj[key] !== undefined && obj[key] !== null) {
      const val = obj[key];
      if (typeof val === 'object' && val !== null) {
        if (val.value !== undefined && val.value !== null) return String(val.value).trim();
        if (val.raw_value !== undefined && val.raw_value !== null) return String(val.raw_value).trim();
      }
      return String(val).trim();
    }
    
    // Case-insensitive direct match
    const lowerKey = key.toLowerCase();
    const foundKey = Object.keys(obj).find(k => k.toLowerCase() === lowerKey);
    if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null) {
      const val = obj[foundKey];
      if (typeof val === 'object' && val !== null) {
        if (val.value !== undefined && val.value !== null) return String(val.value).trim();
        if (val.raw_value !== undefined && val.raw_value !== null) return String(val.raw_value).trim();
      }
      return String(obj[foundKey]).trim();
    }
    
    return null;
  };

  // 1. Try direct keys sequentially
  for (const key of possibleKeys) {
    const valRoot = getValue(payload, key);
    if (valRoot !== null) return valRoot;
    
    const valFields = getValue(fields, key);
    if (valFields !== null) return valFields;

    const valForm = getValue(formData, key);
    if (valForm !== null) return valForm;

    const valUtm = getValue(utmData, key);
    if (valUtm !== null) return valUtm;
  }
  
  // 2. Normalization matching (ignores spaces, accents, question marks, asterisks, and underscores)
  const normalize = str => {
    return String(str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove accents
      .replace(/[^a-z0-9]/g, '');     // remove everything else
  };

  const checkNormalized = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const normalizedObj = {};
    for (const k of Object.keys(obj)) {
      normalizedObj[normalize(k)] = obj[k];
    }
    for (const key of possibleKeys) {
      const normKey = normalize(key);
      if (normalizedObj[normKey] !== undefined && normalizedObj[normKey] !== null) {
        const val = normalizedObj[normKey];
        if (typeof val === 'object' && val !== null) {
          if (val.value !== undefined && val.value !== null) return String(val.value).trim();
          if (val.raw_value !== undefined && val.raw_value !== null) return String(val.raw_value).trim();
        }
        return String(val).trim();
      }
    }
    return null;
  };

  const normValRoot = checkNormalized(payload);
  if (normValRoot !== null) return normValRoot;

  const normValFields = checkNormalized(fields);
  if (normValFields !== null) return normValFields;

  const normValForm = checkNormalized(formData);
  if (normValForm !== null) return normValForm;

  const normValUtm = checkNormalized(utmData);
  if (normValUtm !== null) return normValUtm;
  
  return '';
}

// Helper to validate if a lead is a Partner, Owner, CEO or Executive Decision Maker
function isPartnerOrOwner(cargo, perfil) {
  const c = String(cargo || '').toLowerCase().trim();
  const p = String(perfil || '').toLowerCase().trim();
  
  const keywords = [
    'socio', 'sócio', 'socia', 'sócia', 'proprietario', 'proprietário',
    'dono', 'dona', 'owner', 'ceo', 'founder', 'fundador', 'fundadora',
    'diretor', 'diretora', 'director', 'empresario', 'empresário',
    'empresaria', 'empresária', 'vp', 'vice-presidente', 'vice presidente'
  ];
  
  return keywords.some(kw => c.includes(kw) || p.includes(kw));
}

// Helper to extract numeric value from free-text faturamento/renda in Portuguese
function parseFaturamentoNumber(str) {
  if (!str) return 0;
  const clean = String(str).toLowerCase().replace(/[\s_-]+/g, '');
  
  // Handle ranges like "1 a 3 mil" or "entre 100 e 150 mil" -> use the lower bound
  const rangeMatch = clean.match(/(?:entre)?(\d+(?:[.,]\d+)?)[ae](\d+(?:[.,]\d+)?)mil/);
  if (rangeMatch) {
    const num = parseFloat(rangeMatch[1].replace(',', '.'));
    return num * 1000;
  }
  
  let val = 0;
  
  // Handle explicit million multipliers
  if (clean.includes('milhao') || clean.includes('milhão') || clean.includes('1m') || clean.includes('2m') || clean.includes('5m')) {
    val = 1000000;
  } else {
    // Check if it's a "k" abbreviation (e.g., 10k, 3k, 100k, 150k)
    const kMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*k/);
    if (kMatch) {
      const num = parseFloat(kMatch[1].replace(',', '.'));
      val = num * 1000;
    } else {
      // Check if it's a "mil" abbreviation (e.g., 3 mil, 100 mil)
      const milMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*mil/);
      if (milMatch) {
        const num = parseFloat(milMatch[1].replace(',', '.'));
        val = num * 1000;
      } else {
        // Check for standard currency formats like "R$ 3.000,00" or "3.000" or "3000"
        const numbers = clean.replace(/[^0-9.,]/g, '');
        if (numbers) {
          // If it has a comma at the end with 2 decimal places, it's cents (e.g. 3.000,00)
          if (numbers.includes(',') && numbers.split(',')[1].length === 2) {
            const parts = numbers.split(',');
            const mainPart = parts[0].replace(/\./g, ''); // remove thousands separator dot
            val = parseFloat(mainPart);
          } else if (numbers.includes('.') && !numbers.includes(',')) {
            // If it's just dots (e.g. 3.000)
            const parts = numbers.split('.');
            if (parts[parts.length - 1].length === 3) {
              // Thousands separator (e.g. 3.000 -> 3000)
              val = parseFloat(numbers.replace(/\./g, ''));
            } else {
              // Decimal separator
              val = parseFloat(numbers);
            }
          } else {
            // Fallback: just remove everything non-numeric and parse
            const digits = clean.replace(/\D/g, '');
            if (digits.length > 0) {
              val = parseInt(digits, 10);
              if (clean.includes(',00') || clean.includes('.00')) {
                val = val / 100;
              }
            }
          }
        }
      }
    }
  }
  
  // If the text indicates "less than" or "up to", adjust the value downward
  if (
    clean.includes('menos') ||
    clean.includes('abaixo') ||
    clean.includes('menor') ||
    clean.includes('under') ||
    clean.includes('less') ||
    clean.includes('ate') ||
    clean.includes('até')
  ) {
    if (val > 0) {
      val = val - 1; // e.g. 3000 becomes 2999, failing the >= 3000 check
    }
  }
  
  return val;
}

// Helper to validate if billing is equal to or greater than 100k
function isFaturamentoAbove100k(faturamento, renda) {
  const fVal = parseFaturamentoNumber(faturamento);
  const rVal = parseFaturamentoNumber(renda);
  return fVal >= 100000 || rVal >= 100000;
}

// Helper to validate if billing is equal to or greater than 50k
function isFaturamentoAbove50k(faturamento, renda) {
  const fVal = parseFaturamentoNumber(faturamento);
  const rVal = parseFaturamentoNumber(renda);
  return fVal >= 50000 || rVal >= 50000;
}

// Helper to validate if billing is equal to or greater than 3k
function isFaturamentoAbove3k(faturamento, renda) {
  const fVal = parseFaturamentoNumber(faturamento);
  const rVal = parseFaturamentoNumber(renda);
  return fVal >= 3000 || rVal >= 3000;
}

app.post('/api/ko-webhook', async (req, res) => {
  console.log('[KO Webhook] Received form submission');
  
  const payload = req.body || {};
  const email = getFlexibleValue(payload, ['E_mail', 'e_mail', 'Email', 'email']).toLowerCase().trim();
  const rawPhone = getFlexibleValue(payload, ['WhatsApp_com_DDD', 'whatsapp_com_ddd', 'WhatsApp', 'whatsapp', 'Telefone', 'telefone', 'phone']);
  const phone = rawPhone.replace(/[^0-9+]/g, '');
  const name = getFlexibleValue(payload, ['Nome', 'nome', 'Name', 'name']) || 'Lead Sem Nome (KO)';
  const faturamento = getFlexibleValue(payload, ['Qual_seu_faturamento_medio_mensal', 'Qual_seu_faturamento_medio', 'Qual_seu_faturamento_medic', 'Qual_seu_faturamento', 'faturamento', 'Faturamento']);
  const cargo = getFlexibleValue(payload, ['Qual_seu_cargo', 'cargo', 'Cargo']);
  const equipe = getFlexibleValue(payload, ['equipe', 'Equipe']);
  const gargalo = getFlexibleValue(payload, ['Por_que_buscou_a_Komando', 'por_que_buscou_a_komando', 'gargalo', 'Gargalo']);
  const lider = getFlexibleValue(payload, ['lider', 'Líder', 'Lider']);

  const utm_source = getFlexibleValue(payload, ['UTM_Source', 'utm_source', 'Source', 'source']);
  const utm_medium = getFlexibleValue(payload, ['UTM_Medium', 'utm_medium', 'Medium', 'medium']);
  const utm_campaign = getFlexibleValue(payload, ['UTM_Campaign', 'utm_campaign', 'Campaign', 'campaign']);
  const utm_content = getFlexibleValue(payload, ['UTM_Content', 'utm_content', 'Content', 'content']);
  const utm_term = getFlexibleValue(payload, ['UTM_Term', 'utm_term', 'Term', 'term']);
  const ab_variant = getFlexibleValue(payload, ['ab_variant', 'abVariant', 'ab_test', 'variant', 'page_variant', 'pagina_variante', 'variante', 'variant_id']);
  
  if (!email && !phone) {
    console.warn('[KO Webhook] Warning: Form submission without email and phone, ignoring.');
    return res.status(400).json({ success: false, error: 'Email or Phone is required' });
  }

  console.log(`[KO Webhook] Lead Details:
    Name: ${name}
    Email: ${email}
    Phone: ${phone}
    Faturamento: ${faturamento}
  `);

  const isEbookEvent = (payload.event === 'ebook_lead_captured') || 
                       (utm_campaign && utm_campaign.toLowerCase().includes('ebook'));
  const PIPELINE_KO = isEbookEvent ? 13537971 : 13304659; // KO_EBOOKS (13537971) or KO_INBOUND (13304659)
  const STATUS_KO_INCOMING = isEbookEvent ? 104460259 : 102599767; // ETAPA LEADS DE ENTRADA (104460259) or Tentando Contato (102599767)

  // Save to Google Sheets FIRST (backup)
  const gsSheetName = isEbookEvent ? 'KO Ebook' : 'KO Inbound';
  const gsResult = await saveToGoogleSheets(gsSheetName, {
    nome: name, email, telefone: phone, faturamento,
    cargo, equipe, gargalo, lider,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term
  });
  const gsRow = gsResult?.row;
  console.log(`[KO Webhook] Lead saved to Google Sheets (${gsSheetName}, row: ${gsRow})`);

  try {
    let existingContacts = [];
    if (email) {
      console.log(`[KO Webhook] Searching for existing contact by email: ${email}...`);
      const contactSearch = await kommoRequest('GET', `/api/v4/contacts?query=${encodeURIComponent(email)}&with=leads`);
      existingContacts = contactSearch?._embedded?.contacts || [];
    }
    
    if (existingContacts.length === 0 && phone) {
      const cleanPhone = phone.startsWith('55') && phone.length > 10 ? phone.substring(2) : phone;
      console.log(`[KO Webhook] Searching for existing contact by phone: ${cleanPhone}...`);
      const contactSearch = await kommoRequest('GET', `/api/v4/contacts?query=${encodeURIComponent(cleanPhone)}&with=leads`);
      existingContacts = contactSearch?._embedded?.contacts || [];
    }

    const fieldIds = await getLeadCustomFields();
    const leadCustomFields = [];
    
    if (fieldIds.utm_source && utm_source) leadCustomFields.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
    if (fieldIds.utm_campaign && utm_campaign) leadCustomFields.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
    if (fieldIds.utm_medium && utm_medium) leadCustomFields.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
    if (fieldIds.utm_content && utm_content) leadCustomFields.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });
    if (fieldIds.utm_term && utm_term) leadCustomFields.push({ field_id: fieldIds.utm_term, values: [{ value: utm_term }] });
    
    // Mapeamento dos campos fixos da KO
    if (faturamento) leadCustomFields.push({ field_id: 128886, values: [{ value: faturamento }] }); // Seu faturamento médio
    if (cargo) leadCustomFields.push({ field_id: 128884, values: [{ value: cargo }] }); // Qual é o seu cargo?
    if (equipe) leadCustomFields.push({ field_id: 492035, values: [{ value: equipe }] }); // Tamanho da equipe
    if (gargalo) leadCustomFields.push({ field_id: 492037, values: [{ value: gargalo }] }); // Maior gargalo
    if (lider) leadCustomFields.push({ field_id: 492039, values: [{ value: lider }] }); // Possui líder operacional?
    if (ab_variant) leadCustomFields.push({ field_id: 494249, values: [{ value: String(ab_variant) }] }); // Variante A/B (Página)

    let leadId = null;
    const baseTags = isEbookEvent ? ['KO_Ebooks', 'Ebook'] : ['KO_Inbound'];
    if (ab_variant) baseTags.push(`AB_${String(ab_variant).substring(0, 30)}`);

    if (existingContacts.length > 0) {
      existingContacts.sort((a, b) => a.id - b.id);
      const primaryContact = existingContacts[0];
      const contactId = primaryContact.id;
      console.log(`[KO Webhook] Contact found: ID ${contactId} (${primaryContact.name || 'unnamed'})`);
      
      const contactUpdatePayload = {};
      let needsUpdate = false;
      
      const existingPhoneField = primaryContact.custom_fields_values?.find(f => f.field_id === 110074);
      if (phone && (!existingPhoneField || !existingPhoneField.values?.some(v => v.value === phone))) {
        contactUpdatePayload.custom_fields_values = contactUpdatePayload.custom_fields_values || [];
        contactUpdatePayload.custom_fields_values.push({
          field_id: 110074,
          values: [{ value: phone, enum_code: 'MOB' }]
        });
        needsUpdate = true;
      }
      
      const existingEmailField = primaryContact.custom_fields_values?.find(f => f.field_id === 110076);
      if (email && (!existingEmailField || !existingEmailField.values?.some(v => v.value === email))) {
        contactUpdatePayload.custom_fields_values = contactUpdatePayload.custom_fields_values || [];
        contactUpdatePayload.custom_fields_values.push({
          field_id: 110076,
          values: [{ value: email, enum_code: 'WORK' }]
        });
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        console.log(`[KO Webhook] Updating contact ID ${contactId}...`);
        await kommoRequest('PATCH', `/api/v4/contacts/${contactId}`, contactUpdatePayload);
      }

      const linkedLeads = primaryContact._embedded?.leads || [];
      let activeLead = null;
      
      for (const leadRef of linkedLeads) {
        try {
          const lead = await kommoRequest('GET', `/api/v4/leads/${leadRef.id}`);
          if (lead && lead.pipeline_id === PIPELINE_KO && lead.status_id !== 142 && lead.status_id !== 143) {
            activeLead = lead;
            break;
          }
        } catch (leadErr) {
          console.error(`[KO Webhook] Error fetching lead ${leadRef.id}:`, leadErr.message);
        }
      }
      
      if (activeLead) {
        leadId = activeLead.id;
        console.log(`[KO Webhook] Updating existing active lead ID ${leadId} in KO pipeline...`);
        
        const existingTags = activeLead._embedded?.tags?.map(t => t.name) || [];
        const newTags = Array.from(new Set([...baseTags, ...existingTags]));
        
        await kommoRequest('PATCH', `/api/v4/leads/${leadId}`, {
          custom_fields_values: leadCustomFields.length > 0 ? leadCustomFields : undefined,
          _embedded: {
            tags: newTags.map(name => ({ name }))
          }
        });
      } else {
        console.log(`[KO Webhook] Creating new lead in KO pipeline linked to contact ID ${contactId}...`);
        
        const newLeadPayload = {
          name: `[KO] ${primaryContact.name || name}`,
          pipeline_id: PIPELINE_KO,
          status_id: STATUS_KO_INCOMING,
          custom_fields_values: leadCustomFields.length > 0 ? leadCustomFields : undefined,
          _embedded: {
            tags: baseTags.map(tagName => ({ name: tagName }))
          }
        };
        
        const newLeadRes = await kommoRequest('POST', '/api/v4/leads', [newLeadPayload]);
        leadId = newLeadRes?._embedded?.leads?.[0]?.id;
        
        if (leadId) {
          await kommoRequest('POST', `/api/v4/leads/${leadId}/link`, [{
            to_entity_id: contactId,
            to_entity_type: 'contacts'
          }]);
          console.log(`[KO Webhook] Linked new lead ID ${leadId} to contact ID ${contactId}`);
        }
      }
    } else {
      console.log('[KO Webhook] Contact not found. Creating complex Lead + Contact in KO pipeline...');
      
      const complexLead = {
        name: `[KO] ${name}`,
        pipeline_id: PIPELINE_KO,
        status_id: STATUS_KO_INCOMING,
        custom_fields_values: leadCustomFields.length > 0 ? leadCustomFields : undefined,
        _embedded: {
          tags: baseTags.map(tagName => ({ name: tagName })),
          contacts: [{
            first_name: name,
            custom_fields_values: [
              ...(email ? [{
                field_id: 110076,
                values: [{ value: email, enum_code: 'WORK' }]
              }] : []),
              ...(phone ? [{
                field_id: 110074,
                values: [{ value: phone, enum_code: 'MOB' }]
              }] : [])
            ]
          }]
        }
      };
      
      const complexRes = await kommoRequest('POST', '/api/v4/leads/complex', [complexLead]);
      leadId = complexRes?.[0]?.id;
    }

    // Update Google Sheets with CRM result
    if (gsRow) await updateGoogleSheetsStatus(gsSheetName, gsRow, 'Processado', leadId);

    res.status(200).json({ success: true, lead_id: leadId });
  } catch (err) {
    console.error('[KO Webhook] Error processing webhook:', err);
    if (gsRow) await updateGoogleSheetsStatus(gsSheetName, gsRow, 'Erro CRM', '');
    
    // Report error to Telegram (private chat)
    try {
      await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro KO Webhook]*\nID do Lead na Planilha: ${gsRow || 'N/A'}\nErro: ${err.message}`);
    } catch(telErr) { /* ignore */ }
    
    res.status(500).json({ success: false, error: err.message });
  }
});

// Landing Page (LP) Webhook Endpoint for MLFP Mentoria
app.post('/api/lp-webhook', async (req, res) => {
  console.log('[LP Webhook] Received form submission');
  
  const payload = req.body || {};
  
  // 1. Flexible Field Extraction using getFlexibleValue
  const email = getFlexibleValue(payload, [
    'Seu_melhor_e_mail', 'seu_melhor_e_mail', 'email', 'e-mail', 'e_mail', 'email_address', 'e-mail *', 'email *', 'E-mail'
  ]).toLowerCase().trim();
  
  const rawPhone = getFlexibleValue(payload, [
    'Seu_WhatsApp_com_DDD', 'seu_whatsapp_com_ddd', 'whatsapp', 'whats', 'telefone', 'phone', 'celular', 'tel', 'WhatsApp', 'WhatsApp *'
  ]);
  const phone = rawPhone.replace(/[^0-9+]/g, '');
  
  const name = getFlexibleValue(payload, [
    'Seu_nome_completo', 'seu_nome_completo', 'nome', 'name', 'nome_completo', 'full_name', 'Nome', 'Nome *'
  ]);
  
  const instagram = getFlexibleValue(payload, [
    'Seu_instagram', 'seu_instagram', 'Instagram', 'instagram', 'insta', 'user_instagram', 'Seu instagram?', 'Seu instagram'
  ]);
  
  const cargo = getFlexibleValue(payload, [
    'Cargo', 'cargo', 'profissao', 'ocupacao', 'cargo_profissao', 'Qual é o seu cargo?', 'Qual o seu cargo', 'Cargo/Perfil', 'perfil'
  ]);
  
  const faturamento = getFlexibleValue(payload, [
    'Seu_faturamento_medio', 'seu_faturamento_medio', 'faturamento', 'faturamento_medio', 'faturamento_empresa', 'Seu faturamento médio', 'faturamento medio', 'Faturamento'
  ]);
  
  const socios = getFlexibleValue(payload, [
    'Possui_socios', 'possui_socios', 'socios', 'tem_socios', 'Possui sócios?', 'Possui socios', 'Possui_socio'
  ]);
  
  const renda = getFlexibleValue(payload, [
    'renda', 'sua_renda', 'Atualmente, sua renda está entre:', 'Atualmente sua renda esta entre', 'renda_entre'
  ]);
  
  const perfil = getFlexibleValue(payload, [
    'perfil', 'define', 'melhor_define', 'Qual das opções abaixo melhor te define hoje?', 'Qual das opcoes abaixo melhor te define hoje'
  ]);

  const utm_source = getFlexibleValue(payload, ['utm_source']);
  const utm_medium = getFlexibleValue(payload, ['utm_medium']);
  const utm_campaign = getFlexibleValue(payload, ['utm_campaign']);
  const utm_content = getFlexibleValue(payload, ['utm_content']);
  
  if (!email && !phone) {
    console.warn('[LP Webhook] Warning: Form submission without email and phone, ignoring.');
    return res.status(400).json({ success: false, error: 'Email or Phone is required' });
  }

  console.log(`[LP Webhook] Lead Details:
    Name: ${name}
    Email: ${email}
    Phone: ${phone}
    Instagram: ${instagram}
    Cargo: ${cargo}
  `);

  // Save to Google Sheets FIRST (backup)
  const isMqlCheck = isFaturamentoAbove3k(faturamento, renda);
  const gsResult = await saveToGoogleSheets('MLFP', {
    nome: name, email, telefone: phone, instagram,
    cargo: perfil || cargo, faturamento: renda || faturamento, socios,
    utm_source, utm_medium, utm_campaign, utm_content,
    mql: isMqlCheck ? 'Sim' : 'Nao'
  });
  const gsRow = gsResult?.row;
  console.log(`[LP Webhook] Lead saved to Google Sheets (MLFP, row: ${gsRow})`);

  const PIPELINES = {
    MLFP: {
      ID: 13304583, // [MLFP] Inbound
      STATUS_OPTIN: 102598991, // Opt-In
      STATUS_DOWNSELL: 108619300 // Downsell
    }
  };

  try {
    // 2. Search for existing contact by email in Kommo CRM
    console.log(`[LP Webhook] Searching for existing contact: ${email}...`);
    const contactSearch = await kommoRequest('GET', `/api/v4/contacts?query=${encodeURIComponent(email)}&with=leads`);
    const existingContacts = contactSearch?._embedded?.contacts || [];
    
    // Resolve dynamic custom field IDs
    const fieldIds = await getLeadCustomFields();
    
    // Build custom fields array for the lead
    const leadCustomFields = [];
    if (fieldIds.utm_source && utm_source) leadCustomFields.push({ field_id: fieldIds.utm_source, values: [{ value: utm_source }] });
    if (fieldIds.utm_campaign && utm_campaign) leadCustomFields.push({ field_id: fieldIds.utm_campaign, values: [{ value: utm_campaign }] });
    if (fieldIds.utm_medium && utm_medium) leadCustomFields.push({ field_id: fieldIds.utm_medium, values: [{ value: utm_medium }] });
    if (fieldIds.utm_content && utm_content) leadCustomFields.push({ field_id: fieldIds.utm_content, values: [{ value: utm_content }] });
    
    // Mapeamento de campos adicionais da LP (Opção 1: Mesclar campos para evitar Estatísticas)
    if (instagram) leadCustomFields.push({ field_id: 311994, values: [{ value: instagram }] }); // Seu instagram?
    
    const finalCargo = perfil || cargo;
    if (finalCargo) leadCustomFields.push({ field_id: 128884, values: [{ value: finalCargo }] }); // Qual é o seu cargo?
    
    const finalFaturamento = renda || faturamento;
    if (finalFaturamento) leadCustomFields.push({ field_id: 128886, values: [{ value: finalFaturamento }] }); // Seu faturamento médio
    
    if (socios) leadCustomFields.push({ field_id: 128888, values: [{ value: socios }] }); // Possui sócios?

    let leadId = null;

    // MLFP Qualification Logic: Revenue >= 3k AND Cargo is Chef, Gerente, Dono, Sócio, etc.
    const fVal = parseFaturamentoNumber(finalFaturamento);
    const rVal = parseFaturamentoNumber(renda);
    const hasMinRevenue3k = (fVal >= 3000 || rVal >= 3000);
    
    const cUpper = String(finalCargo || '').toUpperCase();
    const isQualifiedCargo = cUpper.includes('CHEF') || 
                             cUpper.includes('GERENTE') || 
                             cUpper.includes('DONO') || 
                             cUpper.includes('SÓCIO') || 
                             cUpper.includes('SOCIO') || 
                             cUpper.includes('PROPRIETÁRIO') || 
                             cUpper.includes('PROPRIETARIO') || 
                             cUpper.includes('DIRETOR') ||
                             cUpper.includes('COZINHEIRO') ||
                             cUpper.includes('SUBGERENTE') ||
                             cUpper.includes('LÍDER') ||
                             cUpper.includes('LIDER') ||
                             cUpper.length === 0;

    const isMql = hasMinRevenue3k && isQualifiedCargo;
    const shouldGoToDownsell = !isMql;

    const baseTags = ['LP_MLFP'];
    if (isMql) {
      baseTags.push('OptIn', 'MQL');
    } else {
      baseTags.push('Downsell');
    }

    if (existingContacts.length > 0) {
      // Contact exists
      existingContacts.sort((a, b) => a.id - b.id);
      const primaryContact = existingContacts[0];
      const contactId = primaryContact.id;
      console.log(`[LP Webhook] Contact found: ID ${contactId} (${primaryContact.name || 'unnamed'})`);
      
      // Update contact details (phone if not present)
      const contactUpdatePayload = {};
      let needsUpdate = false;
      
      // Check if phone needs update
      const existingPhoneField = primaryContact.custom_fields_values?.find(f => f.field_id === 110074);
      if (phone && (!existingPhoneField || !existingPhoneField.values?.some(v => v.value === phone))) {
        contactUpdatePayload.custom_fields_values = [
          {
            field_id: 110074,
            values: [{ value: phone, enum_code: 'MOB' }]
          }
        ];
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        console.log(`[LP Webhook] Updating contact ID ${contactId} with new phone...`);
        await kommoRequest('PATCH', `/api/v4/contacts/${contactId}`, contactUpdatePayload);
      }

      // Look for an active lead in the MLFP Inbound pipeline (not closed-won/closed-lost)
      const linkedLeads = primaryContact._embedded?.leads || [];
      let activeLead = null;
      
      for (const leadRef of linkedLeads) {
        try {
          const lead = await kommoRequest('GET', `/api/v4/leads/${leadRef.id}`);
          if (lead && lead.pipeline_id === PIPELINES.MLFP.ID && lead.status_id !== 142 && lead.status_id !== 143) {
            activeLead = lead;
            break;
          }
        } catch (leadErr) {
          console.error(`[LP Webhook] Error fetching lead ${leadRef.id}:`, leadErr.message);
        }
      }
      
      if (activeLead) {
        // Update active lead
        leadId = activeLead.id;
        console.log(`[LP Webhook] Updating existing active lead ID ${leadId} in MLFP pipeline...`);
        
        // Merge tags
        const existingTags = activeLead._embedded?.tags?.map(t => t.name) || [];
        const newTags = Array.from(new Set([...baseTags, ...existingTags]));
        
        const updatePayload = {
          custom_fields_values: leadCustomFields.length > 0 ? leadCustomFields : undefined,
          _embedded: {
            tags: newTags.map(name => ({ name }))
          }
        };
        if (shouldGoToDownsell) {
          updatePayload.status_id = PIPELINES.MLFP.STATUS_DOWNSELL;
        }
        
        await kommoRequest('PATCH', `/api/v4/leads/${leadId}`, updatePayload);
      } else {
        // Create new lead in MLFP pipeline linked to existing contact
        console.log(`[LP Webhook] Creating new lead in MLFP pipeline linked to contact ID ${contactId}...`);
        
        const newLeadPayload = {
          name: `[LP] ${primaryContact.name || name}`,
          pipeline_id: PIPELINES.MLFP.ID,
          status_id: shouldGoToDownsell ? PIPELINES.MLFP.STATUS_DOWNSELL : PIPELINES.MLFP.STATUS_OPTIN,
          custom_fields_values: leadCustomFields.length > 0 ? leadCustomFields : undefined,
          _embedded: {
            tags: baseTags.map(name => ({ name }))
          }
        };
        
        const newLeadRes = await kommoRequest('POST', '/api/v4/leads', [newLeadPayload]);
        leadId = newLeadRes?._embedded?.leads?.[0]?.id;
        
        if (leadId) {
          await kommoRequest('POST', `/api/v4/leads/${leadId}/link`, [{
            to_entity_id: contactId,
            to_entity_type: 'contacts'
          }]);
          console.log(`[LP Webhook] Linked new lead ID ${leadId} to contact ID ${contactId}`);
        }
      }
    } else {
      // Contact does not exist -> Create complex Lead + Contact
      console.log('[LP Webhook] Contact not found. Creating complex Lead + Contact in MLFP pipeline...');
      
      const complexLead = {
        name: `[LP] ${name}`,
        pipeline_id: PIPELINES.MLFP.ID,
        status_id: shouldGoToDownsell ? PIPELINES.MLFP.STATUS_DOWNSELL : PIPELINES.MLFP.STATUS_OPTIN,
        custom_fields_values: leadCustomFields.length > 0 ? leadCustomFields : undefined,
        _embedded: {
          tags: baseTags.map(name => ({ name })),
          contacts: [{
            first_name: name,
            custom_fields_values: [
              {
                field_id: 110076,
                values: [{ value: email, enum_code: 'WORK' }]
              },
              ...(phone ? [{
                field_id: 110074,
                values: [{ value: phone, enum_code: 'MOB' }]
              }] : [])
            ]
          }]
        }
      };
      
      const complexRes = await kommoRequest('POST', '/api/v4/leads/complex', [complexLead]);
      leadId = complexRes?.[0]?.id || complexRes?._embedded?.leads?.[0]?.id;
      console.log(`[LP Webhook] Complex Lead + Contact created successfully (Lead ID: ${leadId})`);
    }

    // 3. Send Meta Conversions API (CAPI) event
    try {
      const buyerInfo = {
        email,
        phone,
        name
      };
      const customData = {
        content_name: 'Mentoria Líder Faixa Preta - Inscrição LP',
        content_type: 'product'
      };
      if (utm_source) customData.utm_source = utm_source;
      if (utm_medium) customData.utm_medium = utm_medium;
      if (utm_campaign) customData.utm_campaign = utm_campaign;
      if (utm_content) customData.utm_content = utm_content;
      
      const eventId = `lp_mlfp_${leadId || Date.now()}`;
      await sendMetaEvent('Lead', buyerInfo, customData, eventId);
    } catch (capiErr) {
      console.error('[LP Webhook] Failed to send Meta CAPI Lead event:', capiErr.message);
    }

    // Update Google Sheets with CRM result
    if (gsRow) await updateGoogleSheetsStatus('MLFP', gsRow, 'Processado', leadId);

    res.status(200).json({ success: true, lead_id: leadId });
  } catch (err) {
    console.error('[LP Webhook] Error processing LP submission:', err);
    if (gsRow) await updateGoogleSheetsStatus('MLFP', gsRow, 'Erro CRM', '');
    
    // Report error to Telegram (private chat)
    try {
      await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro LP Webhook]*\nID do Lead na Planilha: ${gsRow || 'N/A'}\nErro: ${err.message}`);
    } catch(telErr) { /* ignore */ }
    
    res.status(500).json({ success: false, error: err.message });
  }
});


// Webhook for new leads created in Kommo (dispatches Z-API reports if qualified)
app.post('/api/kommo-lead-created', async (req, res) => {
  console.log('[Z-API Webhook] Received lead created notification from Kommo');
  
  let leadsToProcess = [];
  if (req.body?.leads?.add) {
    leadsToProcess = req.body.leads.add;
  } else if (req.body?.leads?.status) {
    leadsToProcess = req.body.leads.status;
  } else if (req.body?.leads?.update) {
    leadsToProcess = req.body.leads.update;
  }

  if (leadsToProcess.length === 0) {
    console.log('[Z-API Webhook] No leads found in payload');
    return res.status(200).json({ success: true, message: 'No leads found' });
  }

  const PIPELINES = {
    KO_INBOUND: 13304659,
    KO_EBOOKS: 13537971,
    MLFP_INBOUND: 13304583,
    KOP: 14173256,
    KOR: 14268556,
    RECOVERY: 13956952
  };

  try {
    for (const lead of leadsToProcess) {
      const leadId = lead.id;
      const pipelineId = parseInt(lead.pipeline_id || lead.raw?.pipeline_id);
      
      // Filter: Only process tracked pipelines (KO, MLFP, KOP, KOR)
      const isKoPipeline = pipelineId === PIPELINES.KO_INBOUND || pipelineId === PIPELINES.KO_EBOOKS;
      const isMlfpPipeline = pipelineId === PIPELINES.MLFP_INBOUND;
      const isKopPipeline = pipelineId === PIPELINES.KOP;
      const isKorPipeline = pipelineId === PIPELINES.KOR;
      
      if (!isKoPipeline && !isMlfpPipeline && !isKopPipeline && !isKorPipeline) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId}: Not in tracked pipelines (Pipeline ID: ${pipelineId})`);
        continue;
      }
      
      console.log(`[Z-API Webhook] Processing lead ID ${leadId} from pipeline ${pipelineId}...`);
      
      // Fetch complete lead details with contacts
      const leadDetails = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
      if (!leadDetails) continue;

      // Skip retroactive/old leads (created more than 12 hours ago) to prevent notification storm (can be bypassed for testing)
      const nowUnix = Math.floor(Date.now() / 1000);
      const skipOldLeads = process.env.SKIP_OLD_LEADS_NOTIFICATION !== 'false' && req.query.test !== 'true';
      if (skipOldLeads && (nowUnix - leadDetails.created_at > 12 * 60 * 60)) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId}: Retroactive/Old lead (created ${nowUnix - leadDetails.created_at}s ago).`);
        continue;
      }
      
      const contacts = leadDetails._embedded?.contacts || [];
      if (contacts.length === 0) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId}: No contacts linked.`);
        continue;
      }

      // Fetch primary contact details
      contacts.sort((a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0));
      const primaryContactRef = contacts[0];
      const contactDetails = await kommoRequest('GET', `/api/v4/contacts/${primaryContactRef.id}`);
      if (!contactDetails) continue;
      
      // Extract lead & contact custom fields
      const leadFields = leadDetails.custom_fields_values || [];
      const contactFields = contactDetails.custom_fields_values || [];
      
      let email = '';
      let phone = '';
      contactFields.forEach(f => {
        if (f.field_code === 'EMAIL' || f.field_id === 110076) {
          email = f.values?.[0]?.value || email;
        }
        if (f.field_code === 'PHONE' || f.field_id === 110074) {
          phone = f.values?.[0]?.value || phone;
        }
      });
      
      let instagram = '';
      let cargo = '';
      let faturamento = '';
      let socios = '';
      let renda = '';
      let perfil = '';
      let equipe = '';
      let gargalo = '';
      let lider = '';
      let utmSource = '';
      let utmCampaign = '';
      
      leadFields.forEach(f => {
        if (f.field_id === 311994) instagram = f.values?.[0]?.value || instagram;
        if (f.field_id === 128884) cargo = f.values?.[0]?.value || cargo;
        if (f.field_id === 128886) faturamento = f.values?.[0]?.value || faturamento;
        if (f.field_id === 128888) socios = f.values?.[0]?.value || socios;
        if (f.field_id === 128476) renda = f.values?.[0]?.value || renda;
        if (f.field_id === 128474) perfil = f.values?.[0]?.value || perfil;
        if (f.field_id === 492035) equipe = f.values?.[0]?.value || equipe;
        if (f.field_id === 492037) gargalo = f.values?.[0]?.value || gargalo;
        if (f.field_id === 492039) lider = f.values?.[0]?.value || lider;
        if (f.field_id === 110088) utmSource = f.values?.[0]?.value || utmSource;
        if (f.field_id === 110086) utmCampaign = f.values?.[0]?.value || utmCampaign;
      });

      // Para compatibilidade (tanto leads antigos com campos separados quanto novos mesclados)
      const displayCargo = cargo || perfil;
      const displayFaturamento = faturamento || renda;

      const clientName = contactDetails.name || leadDetails.name || 'Sem Nome';

      // 3. Qualification and Routing Branching
      let isQualified = false;
      let targetPhone = '';
      let pipelineName = '';
      let headerTitle = '';
      
      if (isKoPipeline) {
        const isQualifiedRole = isPartnerOrOwner(displayCargo, '');
        const isQualifiedBilling = isFaturamentoAbove50k(displayFaturamento, '');
        isQualified = isQualifiedBilling || (isQualifiedRole && isFaturamentoAbove3k(displayFaturamento, ''));
        targetPhone = process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763'; // Savio
        pipelineName = pipelineId === PIPELINES.KO_INBOUND ? '[KO] Inbound' : '[KO] Ebooks';
        headerTitle = '🚀 *Novo Lead VIP Recebido - Komando!*';
        
        console.log(`[Z-API Webhook] KO Lead ${leadId} qualification check:
          Role Check (Partner/Owner): ${isQualifiedRole} (Cargo/Perfil: "${displayCargo}")
          Billing Check (>= 50k): ${isQualifiedBilling} (Faturamento/Renda: "${displayFaturamento}")
          Overall Qualified: ${isQualified}
        `);

        if (isQualified && (pipelineId === PIPELINES.KO_INBOUND || pipelineId === PIPELINES.KO_EBOOKS)) {
          const currentTags = leadDetails._embedded?.tags || [];
          const hasMqlTag = currentTags.some(t => t.name.toUpperCase() === 'MQL');
          if (!hasMqlTag) {
            console.log(`[Z-API Webhook] Lead ${leadId} is qualified in ${pipelineName}. Adding 'MQL' tag in Kommo...`);
            const updatedTags = currentTags.map(t => ({ name: t.name }));
            updatedTags.push({ name: 'MQL' });
            try {
              await kommoRequest('PATCH', `/api/v4/leads/${leadId}`, {
                _embedded: {
                  tags: updatedTags
                }
              });
              console.log(`[Z-API Webhook] Successfully added 'MQL' tag to lead ${leadId}`);
            } catch (tagErr) {
              console.error(`[Z-API Webhook] Error adding 'MQL' tag to lead ${leadId}:`, tagErr);
            }
          } else {
            console.log(`[Z-API Webhook] Lead ${leadId} already has 'MQL' tag. Skipping WhatsApp notification.`);
            isQualified = false;
          }
        }
      } else if (isMlfpPipeline) {
        const currentTags = leadDetails._embedded?.tags || [];
        const hasDownsellTag = currentTags.some(t => t.name.toLowerCase() === 'downsell');

        if (hasDownsellTag) {
          isQualified = false; // Não notificar leads de downsell no WhatsApp
        } else {
          isQualified = isFaturamentoAbove3k(displayFaturamento, '');
          headerTitle = '🔥 *Novo Lead Qualificado Recebido - Mentoria MLFP!*';
        }
        
        targetPhone = process.env.MLFP_NOTIFICATION_NUMBER || '556194319690'; // Mentoria
        pipelineName = '[MLFP] Inbound';
        
        console.log(`[Z-API Webhook] MLFP Lead ${leadId} qualification check:
          Billing Check (>= 3k): ${isFaturamentoAbove3k(displayFaturamento, '')} (Faturamento/Renda: "${displayFaturamento}")
          Has Downsell Tag: ${hasDownsellTag}
          Overall Qualified (Send WhatsApp): ${isQualified}
        `);

        const isInitialStage = [102598987, 102598991].includes(leadDetails.status_id);
        const shouldMoveToDownsell = hasDownsellTag || (isInitialStage && !isQualified);

        if (shouldMoveToDownsell && leadDetails.status_id !== 108619300) {
          console.log(`[Z-API Webhook] MLFP Lead ${leadId} should go to Downsell. Moving to Downsell stage (108619300) and adding tag...`);
          const updatedTags = currentTags.map(t => ({ name: t.name }));
          if (!updatedTags.some(t => t.name.toLowerCase() === 'downsell')) {
            updatedTags.push({ name: 'Downsell' });
          }
          
          try {
            await kommoRequest('PATCH', `/api/v4/leads/${leadId}`, {
              status_id: 108619300,
              _embedded: {
                tags: updatedTags
              }
            });
            console.log(`[Z-API Webhook] Successfully moved lead ${leadId} to Downsell stage and added tag.`);
          } catch (patchErr) {
            console.error(`[Z-API Webhook] Error moving lead ${leadId} to Downsell stage:`, patchErr.message);
          }
        }
      } else if (isKopPipeline) {
        // KOP — Same qualification as Komando (Cargo + Faturamento >= 100k)
        const isQualifiedRole = isPartnerOrOwner(displayCargo, '');
        const isQualifiedBilling = isFaturamentoAbove100k(displayFaturamento, '');
        isQualified = isQualifiedRole && isQualifiedBilling;
        targetPhone = process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763';
        pipelineName = '[KOP] Komando Operação';
        headerTitle = '📦 *Novo Lead KOP Recebido!*';

        console.log(`[Z-API Webhook] KOP Lead ${leadId} qualification check:
          Role Check (Partner/Owner): ${isQualifiedRole} (Cargo: "${displayCargo}")
          Billing Check (>= 100k): ${isQualifiedBilling} (Faturamento: "${displayFaturamento}")
          Overall Qualified: ${isQualified}
        `);

        // Add MQL tag if qualified
        if (isQualified) {
          const currentTags = leadDetails._embedded?.tags || [];
          const hasMqlTag = currentTags.some(t => t.name.toUpperCase() === 'MQL');
          if (!hasMqlTag) {
            console.log(`[Z-API Webhook] KOP Lead ${leadId} is qualified. Adding 'MQL' tag...`);
            const updatedTags = currentTags.map(t => ({ name: t.name }));
            updatedTags.push({ name: 'MQL' });
            try {
              await kommoRequest('PATCH', `/api/v4/leads/${leadId}`, {
                _embedded: { tags: updatedTags }
              });
              console.log(`[Z-API Webhook] Successfully added 'MQL' tag to KOP lead ${leadId}`);
            } catch (tagErr) {
              console.error(`[Z-API Webhook] Error adding 'MQL' tag to KOP lead ${leadId}:`, tagErr);
            }
          } else {
            console.log(`[Z-API Webhook] KOP Lead ${leadId} already has 'MQL' tag.`);
            isQualified = false;
          }
        }
      } else if (isKorPipeline) {
        // KOR — All recovery leads are notified (no qualification needed)
        isQualified = true;
        pipelineName = '[KOR] KOR Inbound';
        headerTitle = '🔄 *Novo Lead KOR Inbound!*';
        
        console.log(`[Z-API Webhook] KOR Lead ${leadId}: Auto-qualified for notification.`);
      }

      if (req.query.test === 'true') {
        isQualified = true;
      }

      if (!isQualified) {
        console.log(`[Z-API Webhook] Lead ${leadId} did not meet qualification criteria. Skipping WhatsApp report.`);
        continue;
      }

      // 4. Format report message
      const cleanPhone = phone.replace(/\D/g, '');
      const waLink = cleanPhone ? `https://wa.me/${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}` : '';
      
      const domain = process.env.KOMMO_DOMAIN || 'chefkakagomes.kommo.com';
      const kommoLeadUrl = `https://${domain}/leads/detail/${leadId}`;
      
      const footerLink = isMlfpPipeline 
        ? `💬 _Clique no link abaixo para abrir o lead no Kommo CRM:_\n${kommoLeadUrl}`
        : `💬 _Clique no link abaixo para falar com o lead:_\n${waLink || 'Sem telefone para gerar link wa.me'}`;
      
      let message = `${headerTitle}

👤 *Nome:* ${clientName}
📞 *WhatsApp:* ${phone || 'Não informado'}
✉️ *E-mail:* ${email || 'Não informado'}

📂 *Funil:* ${pipelineName}
💼 *Cargo/Perfil:* ${displayCargo || 'Não informado'}
📊 *Faturamento/Renda:* ${displayFaturamento || 'Não informado'}
👥 *Sócios:* ${socios || 'Não informado'}`;

      const displayAbVariant = leadFields.find(f => f.field_id === 494249 || f.field_code === 'AB_VARIANT' || String(f.field_name || '').toLowerCase().includes('variante'))?.values?.[0]?.value || '';

      if (utmCampaign) message += `\n📢 *Campanha (UTM):* ${utmCampaign}`;
      if (utmSource) message += `\n🔍 *Origem (UTM):* ${utmSource}`;
      if (displayAbVariant) message += `\n⚡ *Variante A/B (Página):* ${displayAbVariant}`;

      if (equipe) message += `\n🧑‍🤝‍🧑 *Equipe:* ${equipe}`;
      if (gargalo) message += `\n🚧 *Gargalo:* ${gargalo}`;
      if (lider) message += `\n🎯 *Líder Operacional:* ${lider}`;

      message += `\n\n${footerLink}`;

      // 5. Send message via WhatsApp (Only KO Inbound via Z-API)
      if (Number(pipelineId) === PIPELINES.KO_INBOUND) {
        await sendZapi(targetPhone, message);
      }

      // Generate buttons markup
      const cleanPhoneNum = phone.replace(/\D/g, '');
      const targetWaLink = cleanPhoneNum ? `https://wa.me/${cleanPhoneNum.startsWith('55') ? cleanPhoneNum : '55' + cleanPhoneNum}` : '';
      const replyMarkup = {
        inline_keyboard: [
          [
            ...(targetWaLink ? [{ text: '📞 Falar no WhatsApp', url: targetWaLink }] : []),
            { text: '❌ Desqualificar', callback_data: `disqualify_${leadId}` }
          ]
        ]
      };

      // Send message via Telegram Bot (with thread routing per product)
      let telegramChatId = process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID;
      let threadId = null;
      
      if (pipelineId === PIPELINES.KO_INBOUND) {
        telegramChatId = process.env.TELEGRAM_CHAT_ID; // KO Inbound to main group
        threadId = process.env.TELEGRAM_THREAD_KO || null;
      } else if (isKopPipeline) {
        threadId = process.env.TELEGRAM_THREAD_KOP || null;
      } else if (isKorPipeline) {
        threadId = process.env.TELEGRAM_THREAD_KOR || null;
      } else if (isMlfpPipeline) {
        threadId = process.env.TELEGRAM_THREAD_MLFP || null;
      }
      
      await sendTelegram(telegramChatId, message, replyMarkup, threadId);
    }
    
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Z-API Webhook] Error processing webhook:', err);
    
    // Report error to Telegram (private chat)
    try {
      await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Z-API Webhook]*\nErro: ${err.message}`);
    } catch(telErr) { /* ignore */ }
    
    res.status(500).json({ success: false, error: err.message });
  }
});

// MLFP Weekly Report Cron Endpoint
app.get('/api/cron/mlfp-weekly-report', async (req, res) => {
  try {
    const PIPELINE_MLFP = 13304583;
    const STATUS_CONTATO = 102598999;
    const STATUS_AGENDADA = 102599003;
    const STATUS_REALIZADA = 102599203;
    const STATUS_NEGOCIACAO = 108066768;
    const STATUS_NO_SHOW = 108291644;
    const STATUS_DOWNSELL = 108619300;
    const STATUS_WON = 142;
    const STATUS_LOST = 143;

    // Last 7 days in seconds (Kommo API uses seconds for created_at filter)
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
    
    let allLeads = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const data = await kommoRequest('GET', `/api/v4/leads?filter[pipeline_id]=${PIPELINE_MLFP}&filter[created_at][from]=${sevenDaysAgo}&limit=250&page=${page}`);
      
      if (!data || !data._embedded || !data._embedded.leads || data._embedded.leads.length === 0) {
        hasMore = false;
        break;
      }
      
      allLeads = allLeads.concat(data._embedded.leads);
      if (data._embedded.leads.length < 250) {
        hasMore = false;
      } else {
        page++;
        await new Promise(r => setTimeout(r, 500));
      }
    }

    let totalLeads = allLeads.length;
    let totalMql = 0;
    
    for (const lead of allLeads) {
      const tags = lead._embedded?.tags?.map(t => t.name.toUpperCase()) || [];
      if (tags.includes('MQL')) totalMql++;
    }

    // 2. Fetch lead_status_changed events in the last 7 days for MLFP pipeline
    let allEvents = [];
    let eventsPage = 1;
    let eventsHasMore = true;

    while (eventsHasMore) {
      const data = await kommoRequest('GET', `/api/v4/events?filter[type]=lead_status_changed&filter[created_at][from]=${sevenDaysAgo}&limit=250&page=${eventsPage}`);
      
      if (!data || !data._embedded || !data._embedded.events || data._embedded.events.length === 0) {
        eventsHasMore = false;
        break;
      }
      
      allEvents = allEvents.concat(data._embedded.events);
      if (data._embedded.events.length < 250) {
        eventsHasMore = false;
      } else {
        eventsPage++;
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const conversasLeads = new Set();
    const agendadaLeads = new Set();
    const realizadaLeads = new Set();
    const noShowLeads = new Set();
    const downsellLeads = new Set();

    for (const event of allEvents) {
      const statusAfter = event.value_after?.[0]?.lead_status;
      if (!statusAfter || parseInt(statusAfter.pipeline_id) !== PIPELINE_MLFP) continue;
      
      const sId = parseInt(statusAfter.id);
      const leadId = event.entity_id;
      
      if (sId === STATUS_CONTATO) conversasLeads.add(leadId);
      if (sId === STATUS_AGENDADA) agendadaLeads.add(leadId);
      if ([STATUS_REALIZADA, STATUS_NEGOCIACAO, STATUS_WON].includes(sId)) realizadaLeads.add(leadId);
      if (sId === STATUS_NO_SHOW) noShowLeads.add(leadId);
      if (sId === STATUS_DOWNSELL) downsellLeads.add(leadId);
    }
    
    const totalConversas = conversasLeads.size;
    const totalAgendada = agendadaLeads.size;
    const totalRealizada = realizadaLeads.size;
    const totalNoShow = noShowLeads.size;
    const totalDownsell = downsellLeads.size;

    const txLeadMql = totalLeads > 0 ? ((totalMql / totalLeads) * 100).toFixed(1) : '0.0';
    const txMqlConv = totalMql > 0 ? ((totalConversas / totalMql) * 100).toFixed(1) : '0.0';
    const txConvAgend = totalConversas > 0 ? ((totalAgendada / totalConversas) * 100).toFixed(1) : '0.0';
    const txAgendReal = totalAgendada > 0 ? ((totalRealizada / totalAgendada) * 100).toFixed(1) : '0.0';
    const txNoShow = totalAgendada > 0 ? ((totalNoShow / totalAgendada) * 100).toFixed(1) : '0.0';

    const message = `📊 *Relatório Semanal Comercial - MLFP* 📊\n_Resumo de performance dos últimos 7 dias_\n\n📥 *Novos Leads na Base:* ${totalLeads}\n🔥 *Novos MQLs:* ${totalMql} _(${txLeadMql}% de entrada)_\n\n💬 *Conversas Realizadas:* ${totalConversas} _(${txMqlConv}% dos MQLs)_\n📅 *Reunião Agendada:* ${totalAgendada} _(${txConvAgend}% das Conversas)_\n🤝 *Reunião Realizada:* ${totalRealizada} _(${txAgendReal}% de conversão Agendada -> Realizada)_\n📉 *Downsell:* ${totalDownsell}\n👻 *No Show:* ${totalNoShow} _(${txNoShow}% de taxa de No Show)_\n\n_Relatório gerado automaticamente analisando os eventos da semana._`;

    // Send weekly report to Telegram (private chat)
    const telegramChatId = process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID;
    await sendTelegram(telegramChatId, message);
    
    res.json({ success: true, metrics: { totalLeads, totalMql, totalConversas, totalAgendada, totalRealizada, totalDownsell, totalNoShow }});
  } catch (err) {
    console.error('[Cron] Error generating MLFP weekly report:', err);
    
    // Report error to Telegram (private chat)
    try {
      await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Cron MLFP Relatório Semanal]*\nErro: ${err.message}`);
    } catch(telErr) { /* ignore */ }
    
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper for Gemini Agent: Query Leads in Kommo CRM
async function queryCRMLeads(query) {
  try {
    const endpoint = query 
      ? `/api/v4/leads?query=${encodeURIComponent(query)}&limit=20&with=contacts` 
      : `/api/v4/leads?limit=20&order[created_at]=desc&with=contacts`;
    const res = await kommoRequest('GET', endpoint);
    const leads = res?._embedded?.leads || [];
    return leads.map(l => ({
      id: l.id,
      name: l.name,
      price: l.price,
      created_at: new Date(l.created_at * 1000).toLocaleString('pt-BR'),
      status_id: l.status_id,
      pipeline_id: l.pipeline_id
    }));
  } catch (err) {
    return { error: err.message };
  }
}

// Helper for Gemini Agent: Query Lead details (including contacts & custom fields)
async function queryCRMLeadDetails(leadId) {
  try {
    const lead = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
    if (!lead) return { error: 'Lead não encontrado' };
    
    const contacts = lead._embedded?.contacts || [];
    let contactInfo = null;
    if (contacts.length > 0) {
      contacts.sort((a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0));
      const contactDetails = await kommoRequest('GET', `/api/v4/contacts/${contacts[0].id}`);
      if (contactDetails) {
        let phone = '', email = '';
        (contactDetails.custom_fields_values || []).forEach(f => {
          if (f.field_code === 'PHONE' || f.field_id === 110074) phone = f.values?.[0]?.value || phone;
          if (f.field_code === 'EMAIL' || f.field_id === 110076) email = f.values?.[0]?.value || email;
        });
        contactInfo = { name: contactDetails.name, phone, email };
      }
    }
    
    const cfs = {};
    (lead.custom_fields_values || []).forEach(f => {
      cfs[f.field_name || f.field_id] = f.values?.[0]?.value || '';
    });
    
    return {
      id: lead.id,
      name: lead.name,
      price: lead.price,
      created_at: new Date(lead.created_at * 1000).toLocaleString('pt-BR'),
      status_id: lead.status_id,
      pipeline_id: lead.pipeline_id,
      contact: contactInfo,
      custom_fields: cfs,
      tags: (lead._embedded?.tags || []).map(t => t.name)
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Helper for Gemini Agent: Read and filter Google Sheets data
async function querySpreadsheet(sheetName, searchQuery) {
  try {
    const url = `${GOOGLE_SHEETS_URL}?action=read_all&sheet=${encodeURIComponent(sheetName)}`;
    const response = await fetch(url, { redirect: 'follow' });
    const data = await response.json();
    if (!data.success) return { error: data.error || 'Erro ao ler planilha' };
    
    let rows = data.rows || [];
    if (searchQuery) {
      const q = String(searchQuery).toLowerCase();
      rows = rows.filter(r => {
        return Object.values(r).some(val => String(val).toLowerCase().includes(q));
      });
    } else {
      // Return last 40 rows to stay within model context size limits comfortably
      rows = rows.slice(-40);
    }
    
    return {
      sheet: sheetName,
      total_rows_in_sheet: data.rows?.length || 0,
      returned_rows: rows.length,
      rows: rows
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Gemini Agent Loop
async function runGeminiAgent(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return '⚠️ *Erro de Configuração*\nA chave `GEMINI_API_KEY` não está configurada na Vercel. Por favor, adicione-a para habilitar a consulta por IA.';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const systemInstruction = {
    parts: [{
      text: "Você é o Agente IA Consultor da Komando. Você ajuda o administrador a consultar os dados de leads das planilhas (KO Inbound, KO Ebook, MLFP) e do Kommo CRM. Responda em português de forma amigável, clara e profissional. Quando o usuário te pedir informações sobre leads, contatos ou métricas (ex: 'quantos leads entraram ontem', 'qual o status do lead X'), use as ferramentas/funções disponíveis para obter os dados reais. Sempre formate as respostas com Markdown padrão para o Telegram (use * para negrito, _ para itálico). Se o usuário fizer uma pergunta geral não relacionada aos leads ou ao CRM, responda educadamente dentro do seu papel."
    }]
  };

  const tools = [{
    functionDeclarations: [
      {
        name: "queryCRMLeads",
        description: "Busca ou lista leads recentes no Kommo CRM.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: {
              type: "STRING",
              description: "Termo de busca opcional (ex: nome, email ou telefone do lead)."
            }
          }
        }
      },
      {
        name: "queryCRMLeadDetails",
        description: "Obtém detalhes completos de um lead específico no Kommo CRM pelo ID.",
        parameters: {
          type: "OBJECT",
          properties: {
            leadId: {
              type: "INTEGER",
              description: "ID numérico do lead no Kommo."
            }
          },
          required: ["leadId"]
        }
      },
      {
        name: "querySpreadsheet",
        description: "Obtém dados salvos na planilha do Google Sheets. Pode filtrar por termo de busca.",
        parameters: {
          type: "OBJECT",
          properties: {
            sheetName: {
              type: "STRING",
              description: "Nome da aba (deve ser 'KO Inbound', 'KO Ebook' ou 'MLFP')."
            },
            searchQuery: {
              type: "STRING",
              description: "Termo opcional para filtrar as linhas (ex: nome, email, telefone)."
            }
          },
          required: ["sheetName"]
        }
      }
    ]
  }];

  let contents = [
    {
      role: 'user',
      parts: [{ text: userMessage }]
    }
  ];

  let maxIterations = 5;
  while (maxIterations > 0) {
    maxIterations--;

    const body = {
      contents,
      systemInstruction,
      tools
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API Error: ${errText}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const message = candidate?.content;
    
    if (!message) {
      return 'Desculpe, não consegui gerar uma resposta.';
    }

    contents.push(message);

    const parts = message.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length === 0) {
      return parts.map(p => p.text || '').join('\n');
    }

    const functionResponsesParts = [];
    for (const fc of functionCalls) {
      const call = fc.functionCall;
      let result;
      if (call.name === 'queryCRMLeads') {
        result = await queryCRMLeads(call.args.query);
      } else if (call.name === 'queryCRMLeadDetails') {
        result = await queryCRMLeadDetails(call.args.leadId);
      } else if (call.name === 'querySpreadsheet') {
        result = await querySpreadsheet(call.args.sheetName, call.args.searchQuery);
      } else {
        result = { error: `Função ${call.name} não existe.` };
      }

      functionResponsesParts.push({
        functionResponse: {
          name: call.name,
          response: { output: result }
        }
      });
    }

    contents.push({
      role: 'function',
      parts: functionResponsesParts
    });
  }

  return 'Desculpe, o processamento da sua pergunta excedeu o limite de passos.';
}

// Telegram Bot Message Receiver Webhook
app.post('/api/telegram-webhook', async (req, res) => {
  const update = req.body;
  if (!update) {
    return res.status(200).json({ success: true, message: 'Empty body' });
  }

  // Handle Callback Queries (button clicks)
  if (update.callback_query) {
    return handleTelegramCallback(update.callback_query, res);
  }
  
  if (!update.message) {
    return res.status(200).json({ success: true, message: 'No message to process' });
  }
  
  const chatId = update.message.chat?.id;
  const userText = update.message.text;
  const fromUser = update.message.from?.username || update.message.from?.first_name || 'Usuário';

  if (!chatId || !userText) {
    return res.status(200).json({ success: true, message: 'Empty message' });
  }

  // Validate authorized user chat ID (allows both group and private chat)
  const authorizedChatIdStr = `${process.env.TELEGRAM_CHAT_ID || ''},${process.env.TELEGRAM_CHAT_ID_ERROR || ''}`;
  const authorizedIds = authorizedChatIdStr.split(',').map(id => id.trim()).filter(Boolean);
  if (authorizedIds.length === 0) {
    console.log('[Telegram Webhook] TELEGRAM_CHAT_ID environment variables not set.');
    return res.status(200).json({ success: true, message: 'Unconfigured authorized user' });
  }
  if (!authorizedIds.includes(String(chatId))) {
    console.log(`[Telegram Webhook] Unauthorized message from chat ID ${chatId} (${fromUser}). Ignoring.`);
    await sendTelegram(chatId, '❌ *Acesso Não Autorizado.*\nVocê não está configurado para interagir com este agente.');
    return res.status(200).json({ success: true });
  }

  console.log(`[Telegram Webhook] Authorized message from ${fromUser}: "${userText}"`);

  // Send typing action to Telegram
  try {
    const typingUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`;
    await fetch(typingUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch(e) { /* ignore */ }

  try {
    const aiResponse = await runGeminiAgent(userText);
    await sendTelegram(chatId, aiResponse);
  } catch (err) {
    console.error('[Telegram Webhook] Error running Gemini Agent:', err);
    await sendTelegram(chatId, `❌ *Erro ao processar sua pergunta:*\n${err.message}`);
  }

  return res.status(200).json({ success: true });
});

// Automatic Webhook Registration on startup (Vercel Production environment)
if (isVercel && process.env.TELEGRAM_BOT_TOKEN) {
  const registerUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook?url=https://kommo-dashboard-delta.vercel.app/api/telegram-webhook`;
  fetch(registerUrl)
    .then(r => r.json())
    .then(data => console.log('[Telegram Bot] Webhook registration status:', data))
    .catch(err => console.error('[Telegram Bot] Webhook registration error:', err.message));
}

// Helper to fetch contact details in bulk from Kommo CRM
async function fetchContactsInBulk(contactIds) {
  const contactsMap = {};
  if (!contactIds || contactIds.length === 0) return contactsMap;
  const batchSize = 100;
  for (let i = 0; i < contactIds.length; i += batchSize) {
    const batch = contactIds.slice(i, i + batchSize);
    const query = batch.map(id => `filter[id][]=${id}`).join('&');
    try {
      const res = await kommoRequest('GET', `/api/v4/contacts?${query}&limit=250`);
      const contacts = res?._embedded?.contacts || [];
      contacts.forEach(c => {
        let phone = '';
        let email = '';
        const cfValues = c.custom_fields_values || [];
        cfValues.forEach(f => {
          if (f.field_id === 110074 || f.field_code === 'PHONE') phone = f.values?.[0]?.value || phone;
          if (f.field_id === 110076 || f.field_code === 'EMAIL') email = f.values?.[0]?.value || email;
        });
        contactsMap[c.id] = { name: c.name || 'Sem Nome', phone, email };
      });
    } catch(e) {
      console.error(`Error fetching contacts batch:`, e.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return contactsMap;
}

// Helper to generate daily leads report for Telegram
async function getDailyLeadsReport(isYesterday) {
  const now = new Date();
  const spOffset = -3 * 60 * 60 * 1000;
  const spTime = new Date(now.getTime() + spOffset);
  
  const spMidnight = new Date(Date.UTC(spTime.getUTCFullYear(), spTime.getUTCMonth(), spTime.getUTCDate()));
  
  const todayStart = Math.floor(spMidnight.getTime() / 1000);
  const startTimestamp = isYesterday ? todayStart - 24 * 60 * 60 : todayStart;
  const endTimestamp = isYesterday ? todayStart - 1 : Math.floor(now.getTime() / 1000);
  
  const dateLabel = isYesterday 
    ? new Date(startTimestamp * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : new Date(endTimestamp * 1000).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const endpoint = `/api/v4/leads?filter[created_at][from]=${startTimestamp}&filter[created_at][to]=${endTimestamp}&limit=250&with=contacts`;
  const res = await kommoRequest('GET', endpoint);
  const leads = res?._embedded?.leads || [];

  if (leads.length === 0) {
    return `📭 *Relatório Comercial (${dateLabel})*\nNenhum lead registrado neste período.`;
  }

  const contactIdsSet = new Set();
  leads.forEach(l => {
    (l._embedded?.contacts || []).forEach(c => contactIdsSet.add(c.id));
  });
  
  const contactsMap = await fetchContactsInBulk(Array.from(contactIdsSet));

  const PIPELINES = {
    KO_INBOUND: 13304659,
    KO_EBOOKS: 13537971,
    MLFP: 13304583,
    KOP: 14173256,
    KOR: 14268556
  };

  const categorized = {
    KO_INBOUND: { mql: [], normal: [] },
    KO_EBOOKS: { mql: [], normal: [] },
    MLFP: { mql: [], normal: [] },
    KOP: { mql: [], normal: [] },
    KOR: { mql: [], normal: [] },
    OUTROS: []
  };

  leads.forEach(lead => {
    const cfs = lead.custom_fields_values || [];
    let faturamento = '', cargo = '';
    cfs.forEach(f => {
      if (f.field_id === 128886 || f.field_id === 128476) faturamento = f.values?.[0]?.value || '';
      if (f.field_id === 128884 || f.field_id === 128474) cargo = f.values?.[0]?.value || '';
    });

    const firstContact = lead._embedded?.contacts?.[0];
    const contactInfo = firstContact ? contactsMap[firstContact.id] : null;
    const tags = (lead._embedded?.tags || []).map(t => t.name.toUpperCase());
    let isMql = tags.includes('MQL');
    if (!isMql) {
      if (lead.pipeline_id === PIPELINES.KO_INBOUND || lead.pipeline_id === PIPELINES.KO_EBOOKS) {
        isMql = isPartnerOrOwner(cargo, '') && isFaturamentoAbove50k(faturamento, '');
      } else if (lead.pipeline_id === PIPELINES.MLFP) {
        isMql = isFaturamentoAbove3k(faturamento, '');
      } else if (lead.pipeline_id === PIPELINES.KOP) {
        // KOP MQL: Same rule as Komando (Cargo + Faturamento >= 100k)
        isMql = isPartnerOrOwner(cargo, '') && isFaturamentoAbove100k(faturamento, '');
      }
    }

    const leadData = {
      id: lead.id,
      nome: contactInfo?.name || lead.name || 'Sem Nome',
      telefone: contactInfo?.phone || '',
      faturamento,
      cargo,
      created_at: new Date(lead.created_at * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
    };

    if (lead.pipeline_id === PIPELINES.KO_INBOUND) {
      if (isMql) categorized.KO_INBOUND.mql.push(leadData);
      else categorized.KO_INBOUND.normal.push(leadData);
    } else if (lead.pipeline_id === PIPELINES.KO_EBOOKS) {
      if (isMql) categorized.KO_EBOOKS.mql.push(leadData);
      else categorized.KO_EBOOKS.normal.push(leadData);
    } else if (lead.pipeline_id === PIPELINES.MLFP) {
      if (isMql) categorized.MLFP.mql.push(leadData);
      else categorized.MLFP.normal.push(leadData);
    } else if (lead.pipeline_id === PIPELINES.KOP) {
      if (isMql) categorized.KOP.mql.push(leadData);
      else categorized.KOP.normal.push(leadData);
    } else if (lead.pipeline_id === PIPELINES.KOR) {
      categorized.KOR.normal.push(leadData); // KOR has no MQL qualification
    } else {
      categorized.OUTROS.push(leadData);
    }
  });

  let message = `📊 *Relatório de Leads - ${dateLabel} (${isYesterday ? 'Dia Anterior' : 'Hoje'})*\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  const formatSection = (title, data) => {
    if (data.mql.length === 0 && data.normal.length === 0) return '';
    
    let text = `📂 *${title}*\n`;
    if (data.mql.length > 0) {
      text += `🔥 *MQLs (${data.mql.length}):*\n`;
      data.mql.forEach(l => {
        text += `• *${l.nome}* (${l.created_at}) - ${l.cargo || 'S/ Cargo'} | ${l.faturamento || 'S/ Fat'}\n  📞 ${l.telefone || 'S/ Tel'}\n`;
      });
    }
    if (data.normal.length > 0) {
      text += `⚡ *Outros Leads (${data.normal.length}):*\n`;
      data.normal.forEach(l => {
        text += `• *${l.nome}* (${l.created_at}) - ${l.cargo || 'S/ Cargo'} | ${l.faturamento || 'S/ Fat'}\n  📞 ${l.telefone || 'S/ Tel'}\n`;
      });
    }
    text += `\n`;
    return text;
  };

  message += formatSection('KO Inbound', categorized.KO_INBOUND);
  message += formatSection('KO Ebook', categorized.KO_EBOOKS);
  message += formatSection('MLFP Inbound', categorized.MLFP);
  message += formatSection('📦 KOP (Komando Operação)', categorized.KOP);
  message += formatSection('🔄 KOR Inbound', categorized.KOR);

  if (categorized.OUTROS.length > 0) {
    message += `📦 *Outros Funis (${categorized.OUTROS.length} leads)*\n\n`;
  }

  const totalLeads = leads.length;
  const totalMql = categorized.KO_INBOUND.mql.length + categorized.KO_EBOOKS.mql.length + categorized.MLFP.mql.length + categorized.KOP.mql.length;
  
  message += `━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `📈 *Métricas Totais:*\n`;
  message += `• *Total de Leads:* ${totalLeads}\n`;
  message += `• *Total MQLs:* ${totalMql} _(${totalLeads > 0 ? ((totalMql / totalLeads) * 100).toFixed(1) : 0}% MQL)_\n`;

  return message;
}

// Cron: Daily Report Morning (Yesterday's leads)
app.get('/api/cron/daily-report-morning', async (req, res) => {
  console.log('[Cron] Triggering daily morning report (Yesterday)...');
  try {
    const message = await getDailyLeadsReport(true);
    const targetChatId = process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID;
    await sendTelegram(targetChatId, message);
    res.json({ success: true, message: 'Morning report sent.' });
  } catch (err) {
    console.error('[Cron] Error generating daily morning report:', err);
    await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Cron Morning]*\nErro: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cron: Daily Report Evening (Today's leads)
app.get('/api/cron/daily-report-evening', async (req, res) => {
  console.log('[Cron] Triggering daily evening report (Today)...');
  try {
    const message = await getDailyLeadsReport(false);
    const targetChatId = process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID;
    await sendTelegram(targetChatId, message);
    res.json({ success: true, message: 'Evening report sent.' });
  } catch (err) {
    console.error('[Cron] Error generating daily evening report:', err);
    await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Cron Evening]*\nErro: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Telegram Callback Query Handler (handles button clicks)
async function handleTelegramCallback(callbackQuery, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data || '';
  const fromUser = callbackQuery.from?.username || callbackQuery.from?.first_name || 'Usuário';
  
  if (!botToken || !chatId || !messageId) {
    return res.status(200).json({ success: true });
  }
  
  // Verify authorized chat ID
  const authorizedChatIdStr = `${process.env.TELEGRAM_CHAT_ID || ''},${process.env.TELEGRAM_CHAT_ID_ERROR || ''}`;
  const authorizedIds = authorizedChatIdStr.split(',').map(id => id.trim()).filter(Boolean);
  if (!authorizedIds.includes(String(chatId))) {
    console.log(`[Telegram Callback] Unauthorized click from chat ID ${chatId}`);
    return res.status(200).json({ success: true });
  }
  
  console.log(`[Telegram Callback] Click by ${fromUser}: data="${data}"`);
  
  if (data.startsWith('disqualify_')) {
    const leadId = data.replace('disqualify_', '');
    
    try {
      // 1. Move lead to Closed/Lost (status 143) in Kommo CRM
      await kommoRequest('PATCH', `/api/v4/leads/${leadId}`, {
        status_id: 143
      });
      
      // 2. Answer callback query to show top banner alert
      const answerUrl = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
      await fetch(answerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQuery.id,
          text: `❌ Lead #${leadId} desqualificado com sucesso!`
        })
      });
      
      // 3. Edit original message in Telegram to append info
      const originalText = callbackQuery.message.text || '';
      const updatedText = `${originalText}\n\n❌ *Lead Desqualificado por:* ${fromUser} (via Telegram)`;
      
      const editUrl = `https://api.telegram.org/bot${botToken}/editMessageText`;
      await fetch(editUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: updatedText,
          parse_mode: 'Markdown'
        })
      });
      
      console.log(`[Telegram Callback] Successfully disqualified lead ${leadId} and updated message.`);
    } catch (err) {
      console.error('[Telegram Callback] Error handling disqualify action:', err.message);
      try {
        const answerUrl = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
        await fetch(answerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQuery.id,
            text: `⚠️ Erro ao desqualificar: ${err.message}`,
            show_alert: true
          })
        });
      } catch(e) {}
    }
  }
  
  return res.status(200).json({ success: true });
}

// Cron: SLA Alert Check (runs every 30 mins)
app.get('/api/cron/sla-check', async (req, res) => {
  console.log('[Cron] Running SLA 2-Hour Alert Check...');
  try {
    // Check if it is business hours (Monday-Friday, 08:00 to 18:59)
    const spTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const hour = spTime.getHours();
    const day = spTime.getDay(); // 0 = Sunday, 6 = Saturday

    const isWeekend = day === 0 || day === 6;
    const isBusinessHours = hour >= 8 && hour < 19; // 08:00 to 18:59

    if (isWeekend || !isBusinessHours) {
      console.log(`[SLA Cron] Outside business hours (${spTime.toLocaleTimeString('pt-BR')}, Day: ${day}). Skipping SLA check.`);
      return res.json({ success: true, message: 'Outside business hours. SLA check skipped.' });
    }

    const statusIds = [102599767, 104460259, 102598991];
    const now = Date.now();
    const twoHoursAgoUtc = Math.floor(now / 1000) - 2 * 60 * 60;
    const twentyFourHoursAgoUtc = Math.floor(now / 1000) - 24 * 60 * 60;

    const queryParams = statusIds.map(id => `filter[status_id][]=${id}`).join('&');
    const endpoint = `/api/v4/leads?${queryParams}&limit=250&with=contacts`;
    
    const data = await kommoRequest('GET', endpoint);
    const leads = data?._embedded?.leads || [];
    
    console.log(`[SLA Cron] Found ${leads.length} leads in initial stages.`);
    let alertedCount = 0;

    if (leads.length > 0) {
      const contactIdsSet = new Set();
      leads.forEach(l => {
        (l._embedded?.contacts || []).forEach(c => contactIdsSet.add(c.id));
      });
      const contactsMap = await fetchContactsInBulk(Array.from(contactIdsSet));

      for (const lead of leads) {
        if (lead.created_at < twoHoursAgoUtc && lead.created_at > twentyFourHoursAgoUtc) {
          const tags = (lead._embedded?.tags || []).map(t => t.name.toLowerCase());
          
          if (!tags.includes('sla_alerta') && !tags.includes('sla_alerted')) {
            const firstContact = lead._embedded?.contacts?.[0];
            const contactInfo = firstContact ? contactsMap[firstContact.id] : null;
            const clientName = contactInfo?.name || lead.name || 'Sem Nome';
            
            let pipelineName = 'Outros';
            if (lead.pipeline_id === 13304659) pipelineName = 'KO Inbound';
            else if (lead.pipeline_id === 13537971) pipelineName = 'KO Ebooks';
            else if (lead.pipeline_id === 13304583) pipelineName = 'MLFP Inbound';

            const domain = process.env.KOMMO_DOMAIN || 'chefkakagomes.kommo.com';
            const kommoLeadUrl = `https://${domain}/leads/detail/${lead.id}`;

            const message = `🚨 *ALERTA DE SLA - Lead Sem Atendimento!* 🚨
            
👤 *Cliente:* ${clientName}
📂 *Funil:* ${pipelineName}
⏳ *Criado em:* ${new Date(lead.created_at * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (há mais de 2 horas)
💬 *Status:* Entrada (aguardando atendimento)

🔗 [Ver Lead no Kommo CRM](${kommoLeadUrl})`;

            // Send to Telegram (private chat)
            await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, message);
            alertedCount++;

            const updatedTags = (lead._embedded?.tags || []).map(t => ({ name: t.name }));
            updatedTags.push({ name: 'SLA_Alerta' });
            
            try {
              await kommoRequest('PATCH', `/api/v4/leads/${lead.id}`, {
                _embedded: { tags: updatedTags }
              });
            } catch(e) {
              console.error(`[SLA Cron] Error tagging lead ${lead.id}:`, e.message);
            }
          }
        }
      }
    }
    
    res.json({ success: true, leads_checked: leads.length, alerts_sent: alertedCount });
  } catch (err) {
    console.error('[SLA Cron] Error running SLA check:', err);
    await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Cron SLA]*\nErro: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Central Webhook & System Healthcheck Endpoint
app.get(['/api/healthcheck', '/api/webhook/healthcheck'], async (req, res) => {
  const startTime = Date.now();
  const healthResults = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: isVercel ? 'production-vercel' : 'development-local',
    services: {
      lp_mlfp_webhook: { status: 'ok', endpoint: '/api/lp-webhook' },
      greatpages_kop_webhook: { status: 'ok', endpoint: '/api/webhook/greatpages-kop' },
      greatpages_kor_webhook: { status: 'ok', endpoint: '/api/webhook/greatpages-kor' },
      ko_inbound_webhook: { status: 'ok', endpoint: '/api/ko-webhook' }
    }
  };

  try {
    const crmStart = Date.now();
    const accountInfo = await kommoRequest('GET', '/api/v4/account');
    healthResults.services.crm_api = {
      status: 'ok',
      latency_ms: Date.now() - crmStart,
      account_id: accountInfo.id,
      account_name: accountInfo.name
    };
  } catch (err) {
    healthResults.status = 'degraded';
    healthResults.services.crm_api = {
      status: 'error',
      error: err.message
    };
  }

  healthResults.total_latency_ms = Date.now() - startTime;
  const statusCode = healthResults.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(healthResults);
});

// Meta Ads Integration API Endpoint
app.get('/api/meta-ads/summary', async (req, res) => {
  const token = process.env.META_ACCESS_TOKEN || DEFAULT_META_ACCESS_TOKEN;
  const appId = process.env.META_APP_ID || META_APP_ID;

  try {
    const meRes = await fetch(`https://graph.facebook.com/v20.0/me?access_token=${token}`);
    const meData = await meRes.json();

    const adAccRes = await fetch(`https://graph.facebook.com/v20.0/me/adaccounts?fields=id,name,account_id,currency,account_status&access_token=${token}`);
    const adAccData = await adAccRes.json();

    res.json({
      success: true,
      app_id: appId,
      user: meData,
      ad_accounts: adAccData.data || [],
      message: 'Conexão com Meta Ads API estabelecida com sucesso!'
    });
  } catch (err) {
    console.error('[Meta Ads API] Error fetching Meta data:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Meta Ads Insights API — Campaign performance by funnel with date range
const META_AD_ACCOUNTS = [
  { id: 'act_322391662838622', name: '[KG] DISTRIBUIÇÃO / PERPÉTUO', type: 'main' },
  { id: 'act_342834581', name: 'Caio Gomes', type: 'engagement' }
];

// Classifica a campanha pelo nome.
// Ordem importa: os marcadores mais específicos vêm primeiro. Antes 'KO' era
// testado antes de MLFP e EBOOK, então "KOMANDO-MLFP" caía em komando.
// 'KO' também é casado como palavra isolada (\bKO\b) — como substring solto
// ele engolia qualquer nome que contivesse essas duas letras juntas.
function classifyCampaignFunnel(campaignName) {
  const n = (campaignName || '').toUpperCase();

  if (n.includes('KOP')) return 'kop';
  if (n.includes('KOR')) return 'kor';
  if (n.includes('RECUPERAC') || n.includes('RECUPERAÇ')) return 'recuperacao';
  if (n.includes('EBOOK') || n.includes('E-BOOK')) return 'ebook';
  if (n.includes('MLFP') || n.includes('FAIXA PRETA')) return 'mlfp';
  if (n.includes('KOMANDO') || /\bKO\b/.test(n)) return 'komando';
  if (n.includes('[VIEWS]') || n.includes('[A]') || n.includes('POST DO INSTAGRAM') || n.includes('PUBLICAÇÃO DO INSTAGRAM') || n.includes('INSTAGRAM POST')) return 'engajamento';

  return 'outros';
}

app.get('/api/meta-ads/insights', async (req, res) => {
  let token = (process.env.META_ACCESS_TOKEN && process.env.META_ACCESS_TOKEN.trim()) || DEFAULT_META_ACCESS_TOKEN;
  const { since, until } = req.query;

  if (!since || !until) {
    return res.status(400).json({ success: false, error: 'Parâmetros since e until são obrigatórios (formato YYYY-MM-DD)' });
  }

  // Helper to fetch account insights with token fallback
  async function fetchAccountInsights(accountId, timeRangeStr, currentToken) {
    const url = `https://graph.facebook.com/v20.0/${accountId}/insights?time_range=${encodeURIComponent(timeRangeStr)}&fields=campaign_name,campaign_id,spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type&level=campaign&limit=200&access_token=${currentToken}`;
    let resp = await fetch(url);
    let data = await resp.json();

    // If permission error and we used process.env token, retry with DEFAULT_META_ACCESS_TOKEN
    if (data.error && data.error.code === 200 && currentToken !== DEFAULT_META_ACCESS_TOKEN) {
      console.warn(`[Meta Ads] Token from process.env failed with permission error for account ${accountId}. Retrying with DEFAULT_META_ACCESS_TOKEN...`);
      const fallbackUrl = `https://graph.facebook.com/v20.0/${accountId}/insights?time_range=${encodeURIComponent(timeRangeStr)}&fields=campaign_name,campaign_id,spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type&level=campaign&limit=200&access_token=${DEFAULT_META_ACCESS_TOKEN}`;
      resp = await fetch(fallbackUrl);
      data = await resp.json();
    }
    return data;
  }

  try {
    const timeRange = JSON.stringify({ since, until });
    const allCampaigns = [];
    const errors = [];

    // Fetch insights from all ad accounts
    for (const account of META_AD_ACCOUNTS) {
      try {
        const campData = await fetchAccountInsights(account.id, timeRange, token);

        if (campData.error) {
          console.error(`[Meta Ads] Graph API Error for account ${account.id}:`, campData.error);
          errors.push({ account_id: account.id, error: campData.error.message || campData.error });
        }

        if (campData.data) {
          for (const camp of campData.data) {
            // Antes só entrava spend > 0, o que escondia campanha pausada no
            // meio do período que ainda assim gerou impressão/lead no recorte
            const temGasto = parseFloat(camp.spend) > 0;
            const temEntrega = parseInt(camp.impressions || 0) > 0;
            if (temGasto || temEntrega) {
              const funnel = account.type === 'engagement' ? 'engajamento' : classifyCampaignFunnel(camp.campaign_name);
              
              // Extract lead and purchase actions
              const actions = camp.actions || [];
              const metaLeadsAction = actions.find(a => 
                a.action_type === 'lead' || 
                a.action_type === 'offsite_conversion.fb_pixel_lead' || 
                a.action_type === 'onsite_web_lead' ||
                a.action_type === 'leadgen_grouped'
              );
              const metaLeads = metaLeadsAction ? parseInt(metaLeadsAction.value || 0) : 0;
              const linkClicks = actions.find(a => a.action_type === 'link_click')?.value || 0;
              const landingPageViews = actions.find(a => a.action_type === 'landing_page_view' || a.action_type === 'omni_landing_page_view')?.value || 0;
              const purchases = actions.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase')?.value || 0;
              const purchaseValue = actions.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
              
              allCampaigns.push({
                account_id: account.id,
                account_name: account.name,
                campaign_id: camp.campaign_id,
                campaign_name: camp.campaign_name,
                funnel,
                // NaN aqui contamina todos os somatórios a jusante (spend,
                // CTR, CPL, ROAS viram NaN), então tudo cai para 0
                spend: parseFloat(camp.spend) || 0,
                impressions: parseInt(camp.impressions) || 0,
                clicks: parseInt(camp.clicks) || 0,
                ctr: parseFloat(camp.ctr) || 0,
                cpc: parseFloat(camp.cpc) || 0,
                meta_leads: metaLeads || 0,
                link_clicks: parseInt(linkClicks) || 0,
                landing_page_views: parseInt(landingPageViews) || 0,
                purchases: parseInt(purchases) || 0
              });
            }
          }
        }
      } catch (accErr) {
        console.error(`[Meta Ads] Error fetching account ${account.id}:`, accErr.message);
      }
    }

    // Group by funnel
    const funnels = {};
    for (const camp of allCampaigns) {
      if (!funnels[camp.funnel]) {
        funnels[camp.funnel] = { spend: 0, impressions: 0, clicks: 0, meta_leads: 0, link_clicks: 0, landing_page_views: 0, purchases: 0, campaigns: [] };
      }
      const f = funnels[camp.funnel];
      f.spend += camp.spend;
      f.impressions += camp.impressions;
      f.clicks += camp.clicks;
      f.meta_leads += camp.meta_leads;
      f.link_clicks += camp.link_clicks;
      f.landing_page_views += camp.landing_page_views;
      f.purchases += camp.purchases;
      f.campaigns.push({
        id: camp.campaign_id,
        name: camp.campaign_name,
        spend: camp.spend,
        impressions: camp.impressions,
        clicks: camp.clicks,
        ctr: camp.ctr,
        meta_leads: camp.meta_leads
      });
    }

    // Calculate CTR per funnel
    for (const key in funnels) {
      const f = funnels[key];
      f.ctr = f.impressions > 0 ? ((f.clicks / f.impressions) * 100) : 0;
      f.cpc = f.clicks > 0 ? (f.spend / f.clicks) : 0;
      f.spend = Math.round(f.spend * 100) / 100;
      f.ctr = Math.round(f.ctr * 100) / 100;
      f.cpc = Math.round(f.cpc * 100) / 100;
    }

    // Calculate totals
    const totals = {
      spend: allCampaigns.reduce((s, c) => s + c.spend, 0),
      impressions: allCampaigns.reduce((s, c) => s + c.impressions, 0),
      clicks: allCampaigns.reduce((s, c) => s + c.clicks, 0),
      meta_leads: allCampaigns.reduce((s, c) => s + c.meta_leads, 0),
      link_clicks: allCampaigns.reduce((s, c) => s + c.link_clicks, 0)
    };
    totals.ctr = totals.impressions > 0 ? Math.round(((totals.clicks / totals.impressions) * 100) * 100) / 100 : 0;
    totals.cpc = totals.clicks > 0 ? Math.round((totals.spend / totals.clicks) * 100) / 100 : 0;
    totals.spend = Math.round(totals.spend * 100) / 100;

    res.json({
      success: true,
      period: { since, until },
      totals,
      funnels,
      campaigns_count: allCampaigns.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (err) {
    console.error('[Meta Ads Insights] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// LP Webhook Endpoint for MLFP Page (GET status check)
app.get(['/api/lp-webhook', '/api/webhook/lp-webhook'], (req, res) => {
  res.status(200).json({ success: true, message: 'LP Webhook (MLFP) está ativo e operante!' });
});

// LP Webhook Endpoint for MLFP (Mentoria MLFP) Page
app.post(['/api/lp-webhook', '/api/webhook/lp-webhook'], async (req, res) => {
  try {
    const data = req.body || {};
    console.log('[LP MLFP Webhook] Received payload:', JSON.stringify(data));

    const name = data.Seu_nome_completo || data.nome || data.name || data.full_name || 'Lead MLFP';
    const email = data.Seu_melhor_e_mail || data.email || data['e-mail'] || '';
    const phone = data.Seu_WhatsApp_com_DDD || data.whatsapp || data.telefone || data.phone || '';
    const instagram = data.Seu_instagram || data.seu_instagram || data.Instagram || data.instagram || data.insta || data.ig || '';
    const cargo = data.Cargo || data.cargo || data['Cargo/Perfil'] || data.perfil || '';
    const faturamento = data.Seu_faturamento_medio || data.faturamento || data.Faturamento || data['Faturamento/Renda'] || '';
    const socios = data.Possui_socios || data.socios || data.Possui_socio || '';

    const utm_source = data.utm_source || '';
    const utm_campaign = data.utm_campaign || '';
    const utm_medium = data.utm_medium || '';
    const utm_content = data.utm_content || '';
    const utm_term = data.utm_term || '';

    // MLFP Qualification Logic
    const cargoUpper = cargo.toUpperCase();
    const fatUpper = faturamento.toUpperCase();

    const is1M = fatUpper.includes('1 MILHÃO') || fatUpper.includes('1 MILHAO') || fatUpper.includes('1M') || fatUpper.includes('1.000.000');
    const isOver50k = fatUpper.includes('50') || fatUpper.includes('60') || fatUpper.includes('70') || fatUpper.includes('80') || fatUpper.includes('90') || fatUpper.includes('100') || fatUpper.includes('150') || fatUpper.includes('300') || fatUpper.includes('600') || is1M || parseFaturamentoNumber(faturamento) >= 50000;
    const isDonoSocio = cargoUpper.includes('DONO') || cargoUpper.includes('SÓCIO') || cargoUpper.includes('SOCIO') || cargoUpper.includes('PROPRIETÁRIO') || cargoUpper.includes('PROPRIETARIO');

    const isMql = is1M || (isDonoSocio && isOver50k);
    const tag = isMql ? 'MQL' : 'Downsell';

    const ab_variant = data.ab_variant || data.abVariant || data.ab_test || data.variant || data.pagina_variante || data.variante || '';

    const customFields = [];
    if (cargo) customFields.push({ field_id: 128884, values: [{ value: cargo }] });
    if (instagram) customFields.push({ field_id: 311994, values: [{ value: String(instagram) }] });
    if (faturamento) customFields.push({ field_id: 128886, values: [{ value: String(faturamento) }] });
    if (socios) customFields.push({ field_id: 128888, values: [{ value: String(socios) }] });
    if (ab_variant) customFields.push({ field_id: 494249, values: [{ value: String(ab_variant) }] });

    if (utm_campaign) customFields.push({ field_code: 'UTM_CAMPAIGN', values: [{ value: utm_campaign }] });
    if (utm_source) customFields.push({ field_code: 'UTM_SOURCE', values: [{ value: utm_source }] });
    if (utm_medium) customFields.push({ field_code: 'UTM_MEDIUM', values: [{ value: utm_medium }] });
    if (utm_content) customFields.push({ field_code: 'UTM_CONTENT', values: [{ value: utm_content }] });
    if (utm_term) customFields.push({ field_code: 'UTM_TERM', values: [{ value: utm_term }] });

    const contactCustomFields = [];
    if (phone) contactCustomFields.push({ field_code: 'PHONE', values: [{ value: String(phone), enum_code: 'WORK' }] });
    if (email) contactCustomFields.push({ field_code: 'EMAIL', values: [{ value: String(email), enum_code: 'WORK' }] });

    const payload = [
      {
        name: `Lead - ${name}`,
        pipeline_id: 13304583,
        status_id: 102598995,
        custom_fields_values: customFields,
        _embedded: {
          tags: [
            { name: tag },
            { name: 'LP_MLFP' }
          ],
          contacts: [
            {
              first_name: name,
              custom_fields_values: contactCustomFields
            }
          ]
        }
      }
    ];

    const result = await kommoRequest('POST', '/api/v4/leads/complex', payload);
    console.log('[LP MLFP Webhook] Kommo response:', JSON.stringify(result));

    res.status(200).json({ success: true, message: 'MLFP Lead created successfully', data: result });
  } catch (err) {
    console.error('[LP MLFP Webhook] Error:', err.message);
    res.status(200).json({ success: false, error: err.message });
  }
});

// GreatPages Webhook Endpoint for KOP Page
app.post(['/api/webhook/greatpages-kop', '/api/greatpages-kop'], async (req, res) => {
  let gsRow = null;
  try {
    const data = req.body || {};
    console.log('[GreatPages KOP Webhook] Received payload:', JSON.stringify(data));

    const name = data.Seu_nome_completo || data.nome || data.name || data.full_name || 'Lead KOP';
    const email = data.Seu_melhor_e_mail || data.email || data['e-mail'] || '';
    const phone = data.Seu_WhatsApp_com_DDD || data.whatsapp || data.telefone || data.phone || '';
    const instagram = data.Seu_instagram || data.seu_instagram || data.Instagram || data.instagram || data['Seu_instagram'] || data['Seu instagram?'] || data.insta || data.ig || '';
    const faturamento = data.Seu_faturamento_medio || data.faturamento || data.Seu_faturamento || '';
    const socios = data.Possui_socios || data.socios || data.Possui_socio || '';
    const gargalo = data.Maior_gargalo || data.gargalo || '';
    const cargo = data.Cargo || data.cargo || '';

    const utm_source = data.utm_source || '';
    const utm_campaign = data.utm_campaign || '';
    const utm_medium = data.utm_medium || '';
    const utm_content = data.utm_content || '';
    const utm_term = data.utm_term || '';

    // KOP Qualification Logic (same as Komando: Cargo + Faturamento >= 100k)
    const cargoUpper = cargo.toUpperCase();
    const fatUpper = faturamento.toUpperCase();
    const is1M = fatUpper.includes('1 MILHÃO') || fatUpper.includes('1 MILHAO') || fatUpper.includes('1M') || fatUpper.includes('1.000.000');
    const isOver100k = fatUpper.includes('100') || fatUpper.includes('150') || fatUpper.includes('300') || fatUpper.includes('600') || is1M;
    const isDonoSocio = cargoUpper.includes('DONO') || cargoUpper.includes('SÓCIO') || cargoUpper.includes('SOCIO') || cargoUpper.includes('PROPRIETÁRIO') || cargoUpper.includes('PROPRIETARIO');
    const kopIsMql = is1M || (isDonoSocio && isOver100k);
    const kopTag = kopIsMql ? 'MQL' : 'Downsell';
    console.log(`[GreatPages KOP Webhook] Qualification: Cargo="${cargo}", Fat="${faturamento}", isMQL=${kopIsMql}`);

    // 1. SAVE FIRST TO GOOGLE SHEETS (Backup before CRM API)
    const gsResult = await saveToGoogleSheets('KOP', {
      nome: name,
      email: email,
      telefone: phone,
      instagram: instagram,
      cargo: cargo,
      faturamento: faturamento,
      socios: socios,
      gargalo: gargalo,
      utm_source: utm_source,
      utm_medium: utm_medium,
      utm_campaign: utm_campaign,
      utm_content: utm_content,
      utm_term: utm_term
    });
    gsRow = gsResult?.row;
    console.log(`[GreatPages KOP Webhook] Lead saved FIRST to Google Sheets (row: ${gsRow || 'N/A'})`);

    const ab_variant = data.ab_variant || data.abVariant || data.ab_test || data.variant || data.pagina_variante || data.variante || '';

    const customFields = [];
    if (cargo) customFields.push({ field_id: 128884, values: [{ value: cargo }] });
    if (instagram) customFields.push({ field_id: 311994, values: [{ value: String(instagram) }] });
    if (faturamento) customFields.push({ field_id: 128886, values: [{ value: String(faturamento) }] });
    if (socios) customFields.push({ field_id: 128888, values: [{ value: String(socios) }] });
    if (gargalo) customFields.push({ field_id: 492037, values: [{ value: String(gargalo) }] });
    if (ab_variant) customFields.push({ field_id: 494249, values: [{ value: String(ab_variant) }] });

    if (utm_campaign) customFields.push({ field_code: 'UTM_CAMPAIGN', values: [{ value: utm_campaign }] });
    if (utm_source) customFields.push({ field_code: 'UTM_SOURCE', values: [{ value: utm_source }] });
    if (utm_medium) customFields.push({ field_code: 'UTM_MEDIUM', values: [{ value: utm_medium }] });
    if (utm_content) customFields.push({ field_code: 'UTM_CONTENT', values: [{ value: utm_content }] });
    if (utm_term) customFields.push({ field_code: 'UTM_TERM', values: [{ value: utm_term }] });

    const contactCustomFields = [];
    if (phone) contactCustomFields.push({ field_code: 'PHONE', values: [{ value: String(phone), enum_code: 'WORK' }] });
    if (email) contactCustomFields.push({ field_code: 'EMAIL', values: [{ value: String(email), enum_code: 'WORK' }] });

    const payload = [
      {
        name: `Lead KOP - ${name}`,
        pipeline_id: 14173256,
        status_id: 109421448,
        custom_fields_values: customFields,
        _embedded: {
          tags: [
            { name: 'KOP' },
            { name: kopTag }
          ],
          contacts: [
            {
              first_name: name,
              custom_fields_values: contactCustomFields
            }
          ]
        }
      }
    ];

    const result = await kommoRequest('POST', '/api/v4/leads/complex', payload);
    const leadId = result?.[0]?.id || result?._embedded?.leads?.[0]?.id;
    console.log('[GreatPages KOP Webhook] Kommo response:', JSON.stringify(result));

    // Update Google Sheets status
    if (gsRow) await updateGoogleSheetsStatus('KOP', gsRow, 'Processado', leadId);

    res.status(200).json({ success: true, message: 'Lead created successfully', lead_id: leadId, data: result });
  } catch (err) {
    console.error('[GreatPages KOP Webhook] Error:', err.message);
    if (gsRow) await updateGoogleSheetsStatus('KOP', gsRow, 'Erro CRM', '');

    // Send Telegram alert on error
    try {
      await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Webhook GreatPages KOP]*\nLinha na Planilha: ${gsRow || 'N/A'}\nErro: ${err.message}`);
    } catch(tErr) { /* ignore */ }

    res.status(200).json({ success: false, error: err.message, saved_in_sheets: true });
  }
});

// GreatPages Webhook Endpoint for KOR Page (Funil de Recuperação)
// URL: POST /api/webhook/greatpages-kor or POST /api/greatpages-kor
app.post(['/api/webhook/greatpages-kor', '/api/greatpages-kor'], async (req, res) => {
  let gsRow = null;
  try {
    const data = req.body || {};
    console.log('[GreatPages KOR Webhook] Received payload:', JSON.stringify(data));

    const name = data.Seu_nome_completo || data.nome || data.name || data.full_name || 'Lead KOR';
    const email = data.Seu_melhor_e_mail || data.email || data['e-mail'] || '';
    const phone = data.Seu_WhatsApp_com_DDD || data.whatsapp || data.telefone || data.phone || '';
    const instagram = data.Seu_instagram || data.seu_instagram || data.Instagram || data.instagram || data['Seu_instagram'] || data['Seu instagram?'] || data.insta || data.ig || '';
    const faturamento = data.Seu_faturamento_medio || data.faturamento || data.Seu_faturamento || '';
    const socios = data.Possui_socios || data.socios || data.Possui_socio || '';
    const gargalo = data.Maior_gargalo || data.gargalo || '';
    const cargo = data.Cargo || data.cargo || '';

    const utm_source = data.utm_source || '';
    const utm_campaign = data.utm_campaign || '';
    const utm_medium = data.utm_medium || '';
    const utm_content = data.utm_content || '';
    const utm_term = data.utm_term || '';

    // KOR Qualification Logic (Cargo + Faturamento >= 100k)
    const cargoUpper = cargo.toUpperCase();
    const fatUpper = faturamento.toUpperCase();
    const is1M = fatUpper.includes('1 MILHÃO') || fatUpper.includes('1 MILHAO') || fatUpper.includes('1M') || fatUpper.includes('1.000.000');
    const isOver100k = fatUpper.includes('100') || fatUpper.includes('150') || fatUpper.includes('300') || fatUpper.includes('600') || is1M;
    const isDonoSocio = cargoUpper.includes('DONO') || cargoUpper.includes('SÓCIO') || cargoUpper.includes('SOCIO') || cargoUpper.includes('PROPRIETÁRIO') || cargoUpper.includes('PROPRIETARIO');
    const korIsMql = is1M || (isDonoSocio && isOver100k);
    const korTag = korIsMql ? 'MQL' : 'Downsell';
    console.log(`[GreatPages KOR Webhook] Qualification: Cargo="${cargo}", Fat="${faturamento}", isMQL=${korIsMql}`);

    // 1. SAVE FIRST TO GOOGLE SHEETS (Separate 'KOR' Tab!)
    const gsResult = await saveToGoogleSheets('KOR', {
      nome: name,
      email: email,
      telefone: phone,
      instagram: instagram,
      cargo: cargo,
      faturamento: faturamento,
      socios: socios,
      gargalo: gargalo,
      utm_source: utm_source,
      utm_medium: utm_medium,
      utm_campaign: utm_campaign,
      utm_content: utm_content,
      utm_term: utm_term
    });
    gsRow = gsResult?.row;
    console.log(`[GreatPages KOR Webhook] Lead saved FIRST to Google Sheets KOR tab (row: ${gsRow || 'N/A'})`);

    const ab_variant = data.ab_variant || data.abVariant || data.ab_test || data.variant || data.pagina_variante || data.variante || '';

    const customFields = [];
    if (cargo) customFields.push({ field_id: 128884, values: [{ value: cargo }] });
    if (instagram) customFields.push({ field_id: 311994, values: [{ value: String(instagram) }] });
    if (faturamento) customFields.push({ field_id: 128886, values: [{ value: String(faturamento) }] });
    if (socios) customFields.push({ field_id: 128888, values: [{ value: String(socios) }] });
    if (gargalo) customFields.push({ field_id: 492037, values: [{ value: String(gargalo) }] });
    if (ab_variant) customFields.push({ field_id: 494249, values: [{ value: String(ab_variant) }] });

    if (utm_campaign) customFields.push({ field_code: 'UTM_CAMPAIGN', values: [{ value: utm_campaign }] });
    if (utm_source) customFields.push({ field_code: 'UTM_SOURCE', values: [{ value: utm_source }] });
    if (utm_medium) customFields.push({ field_code: 'UTM_MEDIUM', values: [{ value: utm_medium }] });
    if (utm_content) customFields.push({ field_code: 'UTM_CONTENT', values: [{ value: utm_content }] });
    if (utm_term) customFields.push({ field_code: 'UTM_TERM', values: [{ value: utm_term }] });

    const contactCustomFields = [];
    if (phone) contactCustomFields.push({ field_code: 'PHONE', values: [{ value: String(phone), enum_code: 'WORK' }] });
    if (email) contactCustomFields.push({ field_code: 'EMAIL', values: [{ value: String(email), enum_code: 'WORK' }] });

    const payload = [
      {
        name: `Lead KOR - ${name}`,
        pipeline_id: 14268556, // [KOR] Inbound Pipeline
        status_id: 110184132,  // Contato inicial em [KOR] Inbound
        custom_fields_values: customFields,
        _embedded: {
          tags: [
            { name: 'KOR' },
            { name: 'RECUPERAÇÃO' },
            { name: korTag }
          ],
          contacts: [
            {
              first_name: name,
              custom_fields_values: contactCustomFields
            }
          ]
        }
      }
    ];

    const result = await kommoRequest('POST', '/api/v4/leads/complex', payload);
    const leadId = result?.[0]?.id || result?._embedded?.leads?.[0]?.id;
    console.log('[GreatPages KOR Webhook] Kommo response:', JSON.stringify(result));

    // Update Google Sheets status in KOR tab
    if (gsRow) await updateGoogleSheetsStatus('KOR', gsRow, 'Processado', leadId);

    res.status(200).json({ success: true, message: 'Lead KOR created successfully', lead_id: leadId, data: result });
  } catch (err) {
    console.error('[GreatPages KOR Webhook] Error:', err.message);
    if (gsRow) await updateGoogleSheetsStatus('KOR', gsRow, 'Erro CRM', '');

    // Send Telegram alert on error
    try {
      await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Webhook GreatPages KOR]*\nLinha na Planilha: ${gsRow || 'N/A'}\nErro: ${err.message}`);
    } catch(tErr) { /* ignore */ }

    res.status(200).json({ success: false, error: err.message, saved_in_sheets: true });
  }
});

// Start Server when run locally (not in serverless environment)
// ========================================================
// Webhook: Lead Responded — Kommo Automation Trigger
// Triggered when a lead responds to an automated message.
// Sends Z-API WhatsApp notification to Chef Kaka with lead details.
// URL: POST /api/webhook/lead-responded
// ========================================================
app.post(['/api/webhook/lead-responded', '/api/lead-responded'], async (req, res) => {
  console.log('[Lead Responded Webhook] Received payload:', JSON.stringify(req.body));

  try {
    const data = req.body || {};
    
    // Extract lead ID from various possible Kommo webhook formats
    let leadId = data.lead_id || data.leads?.status?.[0]?.id || data.leads?.add?.[0]?.id || data.leads?.update?.[0]?.id || data.id;
    
    // Also support receiving lead ID via query params
    if (!leadId && req.query.lead_id) {
      leadId = req.query.lead_id;
    }

    if (!leadId) {
      console.log('[Lead Responded Webhook] No lead_id found in payload:', JSON.stringify(data));
      return res.status(400).json({ success: false, error: 'lead_id é obrigatório. Envie no body: { "lead_id": 12345 } ou na query: ?lead_id=12345' });
    }

    leadId = parseInt(leadId);
    console.log(`[Lead Responded Webhook] Processing lead ID: ${leadId}`);

    // 1. Fetch complete lead details with contacts
    const leadDetails = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
    if (!leadDetails) {
      return res.status(404).json({ success: false, error: `Lead ${leadId} não encontrado no Kommo` });
    }

    // 2. Get pipeline name
    const pipelineId = leadDetails.pipeline_id;
    const PIPELINE_NAMES = {
      13304659: 'KO Inbound',
      13537971: 'KO Ebooks',
      13304583: 'MLFP Inbound',
      14173256: 'KOP Inbound',
      14268556: 'KOR Inbound',
      13956952: 'Funil de Recuperação',
      13956856: 'Base de Clientes',
      8403910: 'E-book Pago',
      8403918: 'Social Selling'
    };
    const pipelineName = PIPELINE_NAMES[pipelineId] || `Pipeline ${pipelineId}`;

    // 3. Fetch primary contact details
    const contacts = leadDetails._embedded?.contacts || [];
    let clientName = leadDetails.name || 'Sem Nome';
    let phone = '';
    let email = '';
    let cargo = '';
    let faturamento = '';

    if (contacts.length > 0) {
      contacts.sort((a, b) => (b.is_main ? 1 : 0) - (a.is_main ? 1 : 0));
      const contactDetails = await kommoRequest('GET', `/api/v4/contacts/${contacts[0].id}`);
      
      if (contactDetails) {
        clientName = contactDetails.name || clientName;
        const contactFields = contactDetails.custom_fields_values || [];
        contactFields.forEach(f => {
          if (f.field_code === 'EMAIL' || f.field_id === 110076) {
            email = f.values?.[0]?.value || email;
          }
          if (f.field_code === 'PHONE' || f.field_id === 110074) {
            phone = f.values?.[0]?.value || phone;
          }
        });
      }
    }

    // 4. Extract lead custom fields
    const leadFields = leadDetails.custom_fields_values || [];
    leadFields.forEach(f => {
      if (f.field_id === 128884) cargo = f.values?.[0]?.value || cargo;
      if (f.field_id === 128886) faturamento = f.values?.[0]?.value || faturamento;
    });

    // 5. Build WhatsApp direct link for the lead
    const cleanPhone = phone.replace(/\D/g, '');
    const waLink = cleanPhone ? `https://wa.me/${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}` : 'Sem telefone';

    // 6. Build the Kommo lead URL
    const domain = process.env.KOMMO_DOMAIN || 'chefkakagomes.kommo.com';
    const kommoLeadUrl = `https://${domain}/leads/detail/${leadId}`;

    // 7. Format the Z-API notification message
    const message = `📩 *Lead Respondeu na Automação!*

👤 *Nome:* ${clientName}
📞 *WhatsApp:* ${phone || 'Não informado'}
✉️ *E-mail:* ${email || 'Não informado'}

📂 *Funil:* ${pipelineName}
💼 *Cargo:* ${cargo || 'Não informado'}
📊 *Faturamento:* ${faturamento || 'Não informado'}

💬 *Fale direto com o lead:*
${waLink}

🔗 *Ver no Kommo CRM:*
${kommoLeadUrl}`;

    // 8. Send to Chef Kaka via Z-API
    const kakaPhone = process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763';
    await sendZapi(kakaPhone, message);
    console.log(`[Lead Responded Webhook] Z-API notification sent to ${kakaPhone} for lead ${leadId}`);

    // 9. Also send to Telegram (backup visibility)
    const telegramChatId = process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID;
    await sendTelegram(telegramChatId, message);

    res.status(200).json({ 
      success: true, 
      message: 'Notification sent successfully', 
      lead_id: leadId,
      lead_name: clientName,
      sent_to: kakaPhone
    });
  } catch (err) {
    console.error('[Lead Responded Webhook] Error:', err.message);
    
    try {
      await sendTelegram(
        process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, 
        `🚨 *[Erro Lead Responded Webhook]*\nErro: ${err.message}`
      );
    } catch(tErr) { /* ignore */ }

    res.status(200).json({ success: false, error: err.message });
  }
});

// --- Page Analytics API ---

const PAGEVIEWS_FILE_NAME = 'pageviews.json';

// Pageviews passam pela mesma camada de armazenamento: gravados só em /tmp,
// cada acesso registrado no Vercel era descartado na invocação seguinte —
// por isso o histórico nunca acumulava.
async function readPageviews() {
  try {
    const dados = await lerCache(PAGEVIEWS_FILE_NAME, []);
    return Array.isArray(dados) ? dados : [];
  } catch (err) {
    console.error('[Page Analytics] Error reading pageviews:', err.message);
    return [];
  }
}

async function writePageviews(data) {
  try {
    await gravarCache(PAGEVIEWS_FILE_NAME, data);
  } catch (err) {
    console.error('[Page Analytics] Error writing pageviews:', err.message);
  }
}

// POST /api/track-pageview (with preflight)
app.options('/api/track-pageview', (req, res) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', '*'); // Allow * for testing as requested
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/api/track-pageview', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // Allow * for testing as requested
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    // session_id/visitor_id são opcionais, mas são o que permite contar
    // visitante único de verdade — sem eles a LP só produz total de acessos
    const { page, variant, device, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, timestamp, session_id, visitor_id } = req.body || {};

    let views = await readPageviews();

    // Auto-prune entries older than 90 days
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    views = views.filter(v => (v.timestamp || '') >= ninetyDaysAgo);

    views.push({
      page, variant, device, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      session_id: session_id || visitor_id || null,
      timestamp: timestamp || new Date().toISOString()
    });

    await writePageviews(views);

    res.json({ success: true });
  } catch (err) {
    console.error('[Page Analytics] Track error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// (Rota duplicada de /api/page-analytics removida: o Express registrava duas
// e a segunda nunca era alcançada. O agregador ativo fica logo acima.)


// Start Server when run locally (not in serverless environment)
if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(` Kommo CRM Sales Dashboard Server Running on:`);
    console.log(` http://localhost:${PORT}`);
    console.log(`===================================================`);
  });
}

module.exports = app;
