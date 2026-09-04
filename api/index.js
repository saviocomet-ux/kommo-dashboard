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

// Limites do Meta para event_time (ver docs da Conversions API):
// - eventos web comuns: 7 dias. Se QUALQUER evento do lote passar disso,
//   o Meta rejeita a requisicao inteira e nao processa nenhum.
// - eventos offline (action_source 'physical_store'): 62 dias.
const CAPI_LIMITE_PADRAO_S = 7 * 24 * 60 * 60;
const CAPI_LIMITE_OFFLINE_S = 62 * 24 * 60 * 60;

// Pixel unico do ecossistema Chef Kaká.
//
// Havia dois pixels ativos, ambos instalados nos dois dominios, e as campanhas
// otimizavam em pixels diferentes: Komando no 825634764746487, KOR e MLFP no
// 1601746558049023. Isso partia o sinal de conversao sem separar nada de fato.
//
// A consolidacao ficou no 1601746558049023 porque ele concentra 81% a 94% dos
// eventos de cada dominio — o 825 estava instalado em apenas 6% a 19%. Manter
// o 825 exigiria reinstalar o pixel em todas as paginas e no checkout da Eduzz.
//
// Se um dia voltar a existir mais de um pixel, este valor precisa deixar de ser
// fixo e passar a ser escolhido por funil.
const PIXEL_PADRAO = '1601746558049023';

// Send event to Meta Conversions API
// opcoes.eventTime   — timestamp UNIX do fato (padrao: agora). Use o momento
//                      real da conversao, nao o do envio.
// opcoes.actionSource — origem da conversao ('system_generated' por padrao;
//                      'physical_store' habilita a janela de 62 dias).
async function sendMetaEvent(eventName, buyerInfo, customData, eventId, opcoes = {}) {
  const pixelId = process.env.META_PIXEL_ID || PIXEL_PADRAO;

  // Dois tokens com ciclos de vida diferentes:
  //   META_CAPI_TOKEN     — usuario de sistema, permanente, so posta evento.
  //   META_ACCESS_TOKEN   — token de usuario, expira, usado para LER metricas.
  // Separar evita que a expiracao do token de leitura derrube o envio de
  // conversao, que e o que alimenta a otimizacao das campanhas.
  const accessToken = process.env.META_CAPI_TOKEN || process.env.META_ACCESS_TOKEN || DEFAULT_META_ACCESS_TOKEN;
  const testEventCode = process.env.META_TEST_EVENT_CODE;

  if (!pixelId || !accessToken) {
    console.warn('[Meta CAPI] Warning: META_PIXEL_ID ou token de envio não configurado. Evento ignorado.');
    return { ok: false, motivo: 'credenciais ausentes' };
  }

  const agora = Math.floor(Date.now() / 1000);
  const eventTime = Number(opcoes.eventTime) > 0 ? Math.floor(Number(opcoes.eventTime)) : agora;
  const actionSource = opcoes.actionSource || 'system_generated';
  const limite = actionSource === 'physical_store' ? CAPI_LIMITE_OFFLINE_S : CAPI_LIMITE_PADRAO_S;
  const idade = agora - eventTime;

  // Barrado aqui de proposito: um evento fora da janela derruba o lote inteiro
  if (idade > limite) {
    const dias = Math.floor(idade / 86400);
    const limiteDias = Math.floor(limite / 86400);
    console.warn(`[Meta CAPI] Evento ${eventName} descartado: ${dias} dias de idade, limite ${limiteDias} dias para action_source "${actionSource}".`);
    return { ok: false, motivo: `evento com ${dias} dias excede o limite de ${limiteDias} dias`, idadeDias: dias, limiteDias };
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
    event_time: eventTime,
    event_id: eventId || `eduzz_${Date.now()}`,
    action_source: actionSource,
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

  const url = `https://graph.facebook.com/v26.0/${pixelId}/events?access_token=${accessToken}`;
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
      return { ok: false, motivo: resJson?.error?.message || 'erro da API', resposta: resJson };
    }
    console.log(`[Meta CAPI] Success:`, resJson);
    return { ok: true, eventId: eventPayload.event_id, eventTime, resposta: resJson };
  } catch (error) {
    console.error(`[Meta CAPI] Network Error:`, error);
    return { ok: false, motivo: error.message };
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

// Helper to determine if lead is Organic or Paid Traffic based on UTMs
function determineOrigem(utm_source, utm_campaign, utm_medium) {
  const s = String(utm_source || '').toLowerCase();
  const c = String(utm_campaign || '').toLowerCase();
  const m = String(utm_medium || '').toLowerCase();

  if (s.includes('meta') || s.includes('ad') || s.includes('cpc') || s.includes('feed') || s.includes('stories') || s.includes('reels') ||
      c.includes('lead') || c.includes('auto') || c.includes('ppto') || c.includes('teste') ||
      m.includes('cold') || m.includes('adv') || m.includes('interesses')) {
    return 'Tráfego Pago';
  }
  if (s.includes('organico') || s.includes('bio') || s.includes('direct') || (!utm_source && !utm_campaign && !utm_medium)) {
    return 'Orgânico';
  }
  return utm_source ? `Tráfego (${utm_source})` : 'Orgânico';
}

// Helper to format concise, simplified Z-API WhatsApp notification
function formatZapiLeadMessage({ origem, nome, faturamento, cargo, dor, phone }) {
  const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
  const fullPhone = cleanPhone ? (cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone) : '';
  const waLink = fullPhone ? `https://wa.me/${fullPhone}` : 'Não informado';

  let msg = `📍 *Origem:* ${origem || 'Tráfego Pago'}\n`;
  msg += `👤 *Nome:* ${nome || 'Não informado'}\n`;
  msg += `💰 *Faturamento:* ${faturamento || 'Não informado'}\n`;
  msg += `💼 *Cargo:* ${cargo || 'Não informado'}\n`;
  msg += `⚠️ *Dor:* ${dor || 'Não informado'}\n\n`;
  msg += `📱 *WhatsApp:* ${waLink}`;
  return msg;
}

const DEFAULT_TELEGRAM_BOT_TOKEN = '7574776106:AAEEI8lYQcStvYp52t86bM4j6l1-e8LpYv0';
const DEFAULT_TELEGRAM_CHAT_ID = '-1002344793617';

// Send message via Telegram Bot API (supports multiple IDs separated by commas, inline reply markup, and thread routing)
async function sendTelegram(chatId, message, replyMarkup, threadId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || DEFAULT_TELEGRAM_BOT_TOKEN;
  const targetChatId = chatId || process.env.TELEGRAM_CHAT_ID || DEFAULT_TELEGRAM_CHAT_ID;

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

      if (!response.ok && threadId) {
        console.log(`[Telegram Bot] Retrying without threadId for ${id}...`);
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: id,
            text: message,
            reply_markup: replyMarkup
          })
        });
        resText = await response.text();
        console.log(`[Telegram Bot] No-Thread Send Status for ${id}: ${response.status}`);
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

// Simulador SDR IA Page Route
app.get(['/simulador', '/simulador-sdr', '/sdr', '/api/simulador'], (req, res) => {
  res.sendFile(path.join(__dirname, '../simulador.html'));
});

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
//
// O store é PRIVADO de propósito: all_leads.json contém nome, telefone e
// e-mail dos leads. Num store público a URL do blob seria legível por
// qualquer um, expondo a base inteira.

const { put: blobPut, get: blobGet, list: blobList } = require('@vercel/blob');

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const BLOB_ATIVO = Boolean(BLOB_TOKEN);
const BLOB_PREFIXO = 'kommo-cache/';
const BLOB_ACCESS = 'private';

// Sobrevive entre invocações quentes do lambda.
// Com TTL: sem ele, um lambda quente serviria para sempre o que leu na
// primeira vez, e nunca enxergaria uma sincronização feita por outra instância.
const memoriaCache = new Map();
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

// Quais arquivos já existem no store (evita um GET 404 por leitura)
let blobsConhecidos = null;
async function nomesNoBlob() {
  if (blobsConhecidos) return blobsConhecidos;
  const { blobs } = await blobList({ token: BLOB_TOKEN, prefix: BLOB_PREFIXO });
  blobsConhecidos = new Set((blobs || []).map(b => String(b.pathname).replace(BLOB_PREFIXO, '')));
  return blobsConhecidos;
}

async function lerDoBlob(filename) {
  const nomes = await nomesNoBlob();
  if (!nomes.has(filename)) return undefined;

  const res = await blobGet(BLOB_PREFIXO + filename, { token: BLOB_TOKEN, access: BLOB_ACCESS });
  if (!res || res.statusCode !== 200 || !res.stream) return undefined;

  const partes = [];
  for await (const chunk of res.stream) partes.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(partes).toString('utf8'));
}

async function gravarNoBlob(filename, dados) {
  const info = await blobPut(BLOB_PREFIXO + filename, JSON.stringify(dados), {
    access: BLOB_ACCESS,
    token: BLOB_TOKEN,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true
  });
  if (blobsConhecidos) blobsConhecidos.add(filename);
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

// Atualiza ou insere um lead individual no cache all_leads.json (para webhooks em tempo real)
async function upsertLeadInCache(leadObj) {
  if (!leadObj || !leadObj.id) return;
  try {
    const allLeads = await lerCache('all_leads.json', []);
    const idx = allLeads.findIndex(l => l.id === leadObj.id);
    if (idx >= 0) {
      allLeads[idx] = { ...allLeads[idx], ...leadObj };
    } else {
      allLeads.unshift(leadObj);
    }
    await gravarCache('all_leads.json', allLeads);
    console.log(`[Cache] Lead ${leadObj.id} atualizado em tempo real no cache (Total: ${allLeads.length})`);
  } catch (err) {
    console.error(`[Cache] Erro ao atualizar lead ${leadObj?.id} no cache:`, err.message);
  }
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

    // A/B Variant: views do tracker, leads do CRM (2 Variações Oficiais)
    const VARIANT_LABELS = {
      '1': 'VSL Aberta',
      '2': 'Sem VSL'
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
    function normalizeVariantKey(raw) {
      if (!raw) return null;
      const s = String(raw).trim().toLowerCase();
      const match = s.match(/(?:ab[_\s:]*|var(?:ia[çc][ãa]o|iante)?[_\s:]*|v)?([1-6])/i);
      if (match && match[1]) return match[1];
      return null;
    }

    koLeads.forEach(l => {
      const cfs = l.custom_fields_values || [];
      const varVal = cfs.find(f => f.field_id === 494249 || f.field_code === 'AB_VARIANT')?.values?.[0]?.value;
      const tags = (l._embedded?.tags || []).map(t => t.name);
      const normKey = normalizeVariantKey(varVal) || tags.map(normalizeVariantKey).find(Boolean);
      if (normKey && variantMap[normKey]) {
        variantMap[normKey].leads++;
      }
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
        const tags = l._embedded?.tags?.map(t => t.name) || [];
        const rawSrc = cfs.find(f => f.field_id === 110088 || f.field_code === 'UTM_SOURCE')?.values?.[0]?.value;
        let src = rawSrc;
        if (!src) {
          if (tags.includes('Eduzz')) {
            src = 'Eduzz (Venda Direta)';
          } else if (tags.includes('Downsell') || tags.includes('KOR')) {
            src = 'Downsell (KOR)';
          } else if (tags.includes('Repescagem') || tags.includes('Recuperação')) {
            src = 'Funil de Recuperação';
          } else {
            src = 'Sem UTM / Não Rastreado';
          }
        }
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
        vturb_summary: {
          views: vturbStats.views,
          uniq: vturbStats.uniq,
          plays: vturbStats.plays,
          pitch: vturbStats.pitch,
          live: vturbStats.live,
          play_rate: vturbStats.views > 0 ? ((vturbStats.plays / vturbStats.views) * 100).toFixed(1) + '%' : '—',
          pitch_rate: vturbStats.plays > 0 ? ((vturbStats.pitch / vturbStats.plays) * 100).toFixed(1) + '%' : '—'
        },
        vturb_players: playerList.map(p => ({
          id: p.id,
          name: p.name || 'VSL Final.mov',
          duration_formatted: p.length ? `${Math.floor(p.length / 60)}:${String(p.length % 60).padStart(2, '0')}` : '09:27',
          views: vturbStats.views,
          uniq_visitors: vturbStats.uniq,
          plays: vturbStats.plays,
          play_rate: vturbStats.views > 0 ? ((vturbStats.plays / vturbStats.views) * 100).toFixed(1) + '%' : '—',
          pitch_views: vturbStats.pitch,
          pitch_rate: vturbStats.plays > 0 ? ((vturbStats.pitch / vturbStats.plays) * 100).toFixed(1) + '%' : '—',
          live_users: vturbStats.live
        })),
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

// ==========================================
// GOOGLE ANALYTICS 4 (GA4) INTEGRATION
// ==========================================
const DEFAULT_GA4_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDV7jOMUgS1aX+m\n0zXR30D4d/hoCq5xVWpz+lVsS6XvKlQhUCuK/mWwghDEeuMpSV3oIqB2N3onWnCD\n9KFniL/QZfxknR2AeJ0aVDaXMTAxKlagPFdQOwT50BEw83vauaXZFF83VBr1DC6D\n5/cxZ3fdUQaayxjU/Iv8jbVweDMstJouplGujuj+I/KQ8mKJ6scv21Wq6InLp5/P\nYNygB1XxTLZ/BPIU5y/wFT0hqjLyURVu3FBmxRK85cZjPnbaD/hsJjrXOP6m2P80\ngZPKUSCsr22zJAQxUu2iEbc7ICmlM8oEHmuRc8f7FaR4bcJdOuGujBV8seAmuqTj\nzqz/I0rfAgMBAAECggEAA9+Aomk3uZsT2w7W2hpbIER3xFZxKw8bUsc09bV25xoS\nlNnRN/58E9J/ADejVjOEVjgORKWjegPqppDuvSOeKWU3SREJIDLO0VO1+03CLBmy\noMsG36Z55BXuwb6evup+hKwYPzWwGUCjtPKlqIjRhDm7z2Ce7fg2hpeAMe2TK5t+\n95WNq9zbJR7mMhW8DpgWIUT5A3t/xGHhjEHlOUxjKXtJVuytIFt/ZdGqvCd3pbim\n6O82fLn7znV7StaC769vO67NdRHyEQq47HDnZc7XvcRXJfs/BwT5N9MU7JvxpMLf\nvYhAPW38wiJepPqeQOZWfapiESplRcJ1N8E7tFqrqQKBgQDtkpEdW0RB85ByaDjO\nfVfxvVTSaTlbLhqg6cM73J466XrCcqhp4WyQnoLNlTccAN8va737tYo9hNv8NFwt\n8TL+LYwQWV32J2gW+ptjt6CKE5TND7+bfQF1TyyobFY1QVbNc8FFO6szH7Gy8Nu2\nsi2NP+VS5d1q6hBFqn/30taatwKBgQDmhi2++DwWRVyFctqPH6Mu6UeOs5pqTIAs\nSOC7zKoO3kwcyBHeLKfghJXgUnljtpXm9ubKFEUuqgFtxMWjKbomV59sAKCj9MCj\nXP9b06LE2uS0onGtJqvSjioMLW2plbM8jqPArEEmr1j8yCJW21zcd/TQtgPwS4DX\nycUPqnBJGQKBgQDbs4Jt0pwyHYvEsatvEi2FSmEp4NOBBgbsLqI1NtZBhu/W6O/k\nUuryZxRyCH8Zb5j2or3kDEPWlopWFxn0Bq3wr7Bq4ipp3JF/RqzzL7rQVkFyzhCV\nO6pgkSKsctvajh03DMh8PS0ar0HHSMT3lJlZmfB6lEcKe4Em3AFR7vI1ywKBgQCa\nGL3Bt6xq8sjLSCCDphFuTXCRGswxHJxdfgYEY+aV89GLN86B5vX9poONpXQRzL7d\n2tQh53Troac82lmHHWCbOt2N08mOcBDJ42Or3Ygj8XMKsMAuj/gx0uiWpVN2FmTv\nKSabqEoQ8wwYRix2RUMI+YMEdXeijMY++ViqhTN0GQKBgE+gYt6WL8lpMhKXfNmn\noifXgWaVSXBZhdElannHvhnuFWVttFShUNXovCfhrrOOUJw7+W8Pmg853Nc53/BR\n/J2bbfwpp8OZs1xvp63GqeKw4H5TaVOcvkKeD2sx5omOdo0lSoLkxldpmmY7/JHx\n9rbI5VZqvpXzILqSfDk9IyNA\n-----END PRIVATE KEY-----\n";

const GA4_CONFIG = {
  propertyId: process.env.GA4_PROPERTY_ID || '436068393',
  clientEmail: process.env.GA4_CLIENT_EMAIL || 'ga4-dashboard@gen-lang-client-0912761576.iam.gserviceaccount.com',
  privateKey: (process.env.GA4_PRIVATE_KEY || DEFAULT_GA4_PRIVATE_KEY).replace(/\\n/g, '\n')
};

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const https = require('https');

let cachedGa4Token = null;
let ga4TokenExpiresAt = 0;

async function getGA4AccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGa4Token && ga4TokenExpiresAt > now + 60) {
    return cachedGa4Token;
  }

  const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
  const payload = JSON.stringify({
    iss: GA4_CONFIG.clientEmail,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  });

  const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsignedToken);
  sign.end();
  const signature = sign.sign(GA4_CONFIG.privateKey, 'base64url');
  const jwt = `${unsignedToken}.${signature}`;

  const postBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            cachedGa4Token = json.access_token;
            ga4TokenExpiresAt = now + (json.expires_in || 3600);
            resolve(cachedGa4Token);
          } else {
            reject(new Error(`[GA4 Auth] ${JSON.stringify(json)}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postBody);
    req.end();
  });
}

async function runGA4Report(accessToken, requestBody) {
  const postData = JSON.stringify(requestBody);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'analyticsdata.googleapis.com',
      path: `/v1beta/properties/${GA4_CONFIG.propertyId}:runReport`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

app.get('/api/ga4-analytics', async (req, res) => {
  try {
    const { since, until } = req.query;
    const startDate = since ? since.split('T')[0] : '30daysAgo';
    const endDate = until ? until.split('T')[0] : 'today';

    const token = await getGA4AccessToken();

    // 1. Fetch Pages & Hostnames
    const pagesReport = await runGA4Report(token, {
      dateRanges: [{ startDate, endDate }],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'screenPageViews' }
      ],
      dimensions: [
        { name: 'hostName' },
        { name: 'pagePath' }
      ],
      limit: 100
    });

    // 2. Fetch Daily Sessions for Trend Chart
    const dailyReport = await runGA4Report(token, {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      dimensions: [{ name: 'date' }],
      orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }]
    });

    // 3. Fetch Traffic Sources (UTMs)
    const trafficReport = await runGA4Report(token, {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: 'sessions' }],
      dimensions: [{ name: 'sessionSourceMedium' }],
      limit: 20
    });

    const rows = pagesReport.rows || [];
    let totalSessions = 0;
    let totalUsers = 0;
    let totalViews = 0;

    const pageList = rows.map(r => {
      const host = r.dimensionValues?.[0]?.value || '';
      const path = r.dimensionValues?.[1]?.value || '';
      const sessions = parseInt(r.metricValues?.[0]?.value || '0', 10);
      const users = parseInt(r.metricValues?.[1]?.value || '0', 10);
      const views = parseInt(r.metricValues?.[2]?.value || '0', 10);

      totalSessions += sessions;
      totalUsers += users;
      totalViews += views;

      return { host, path, url: `${host}${path}`, sessions, users, views };
    });

    const daily = (dailyReport.rows || []).map(r => {
      const dStr = r.dimensionValues?.[0]?.value || '';
      const dateFormatted = dStr.length === 8 ? `${dStr.slice(0, 4)}-${dStr.slice(4, 6)}-${dStr.slice(6, 8)}` : dStr;
      return {
        date: dateFormatted,
        sessions: parseInt(r.metricValues?.[0]?.value || '0', 10),
        users: parseInt(r.metricValues?.[1]?.value || '0', 10)
      };
    });

    const sources = (trafficReport.rows || []).map(r => ({
      source: r.dimensionValues?.[0]?.value || '(direto / nenhum)',
      sessions: parseInt(r.metricValues?.[0]?.value || '0', 10)
    }));

    res.json({
      success: true,
      period: { startDate, endDate },
      totals: {
        sessions: totalSessions,
        activeUsers: totalUsers,
        pageviews: totalViews
      },
      pages: pageList,
      daily,
      sources
    });
  } catch (err) {
    console.error('[GA4 API Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync Data from Kommo CRM (Supports POST for manual trigger and GET for Vercel Cron)
app.all(['/api/sync', '/api/cron/sync'], async (req, res) => {
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
      const data = await fetchFromKommo(`/api/v4/leads?limit=250&page=${page}&with=contacts`);
      
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
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    }

    const persistido = await gravarCache('all_leads.json', allLeads);
    console.log(`[Sync] Sync complete. Saved ${allLeads.length} leads. Persistido: ${persistido}`);

    const syncInfo = {
      timestamp: new Date().toISOString(),
      leadsCount: allLeads.length,
      usersCount: usersData?._embedded?.users?.length || 0,
      pipelinesCount: pipelinesData?._embedded?.pipelines?.length || 0,
      persistido,
      armazenamento: BLOB_ATIVO ? 'vercel-blob' : (isVercel ? 'tmp-efemero' : 'disco-local')
    };
    await gravarCache('sync_info.json', syncInfo);

    const aviso = persistido
      ? null
      : 'Os dados foram sincronizados, mas NÃO ficaram persistidos: no Vercel o /tmp é descartado entre requisições. Configure BLOB_READ_WRITE_TOKEN para que a sincronização valha de verdade.';

    res.json({
      success: true,
      ...syncInfo,
      aviso
    });
  } catch (error) {
    console.error('[Sync] Error during sync:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Sync Status Endpoint
app.get('/api/sync-info', async (req, res) => {
  try {
    const syncInfo = await lerCache('sync_info.json', null);
    res.json({ success: true, syncInfo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
          
          // Determinar tag específica do produto (KOR, KOP, MLFP, Komando, Ebook)
          const pUpper = (productName || '').toUpperCase();
          let prodTag = 'Outros';
          if (pUpper.includes('KOR') || pUpper.includes('RESTAURANTE') || pUpper.includes('RECUPERAÇÃO') || pUpper.includes('RECUPERACAO')) {
            prodTag = 'KOR';
          } else if (pUpper.includes('KOP') || pUpper.includes('PRAÇA') || pUpper.includes('PRACA')) {
            prodTag = 'KOP';
          } else if (pUpper.includes('KOMANDO')) {
            prodTag = 'Komando';
          } else if (pUpper.includes('MLFP') || pUpper.includes('MENTORIA') || pUpper.includes('FAIXA PRETA')) {
            prodTag = 'MLFP';
          } else if (pUpper.includes('EBOOK') || pUpper.includes('LIVRO')) {
            prodTag = 'Ebook';
          }

          // Merge tags
          const existingTags = existingLead._embedded?.tags?.map(t => t.name) || [];
          const newTags = Array.from(new Set(['Eduzz', prodTag, ...existingTags, productName.substring(0, 50)]));
          
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
          const pUpper = (productName || '').toUpperCase();
          let prodTag = 'Outros';
          if (pUpper.includes('KOR') || pUpper.includes('RESTAURANTE') || pUpper.includes('RECUPERAÇÃO') || pUpper.includes('RECUPERACAO')) {
            prodTag = 'KOR';
          } else if (pUpper.includes('KOP') || pUpper.includes('PRAÇA') || pUpper.includes('PRACA')) {
            prodTag = 'KOP';
          } else if (pUpper.includes('KOMANDO')) {
            prodTag = 'Komando';
          } else if (pUpper.includes('MLFP') || pUpper.includes('MENTORIA') || pUpper.includes('FAIXA PRETA')) {
            prodTag = 'MLFP';
          } else if (pUpper.includes('EBOOK') || pUpper.includes('LIVRO')) {
            prodTag = 'Ebook';
          }

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
                { name: prodTag },
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
        const pUpper = (productName || '').toUpperCase();
        let prodTag = 'Outros';
        if (pUpper.includes('KOR') || pUpper.includes('RESTAURANTE') || pUpper.includes('RECUPERAÇÃO') || pUpper.includes('RECUPERACAO')) {
          prodTag = 'KOR';
        } else if (pUpper.includes('KOP') || pUpper.includes('PRAÇA') || pUpper.includes('PRACA')) {
          prodTag = 'KOP';
        } else if (pUpper.includes('KOMANDO')) {
          prodTag = 'Komando';
        } else if (pUpper.includes('MLFP') || pUpper.includes('MENTORIA') || pUpper.includes('FAIXA PRETA')) {
          prodTag = 'MLFP';
        } else if (pUpper.includes('EBOOK') || pUpper.includes('LIVRO')) {
          prodTag = 'Ebook';
        }

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
              { name: prodTag },
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

      // Notify new approved sale on Telegram (KOR buyers are silenced per user directive)
      try {
        const pUpper = (productName || '').toUpperCase();
        const isKorSale = pUpper.includes('KOR') || pUpper.includes('RESTAURANTE') || pUpper.includes('RECUPERAÇÃO') || pUpper.includes('RECUPERACAO');

        if (isKorSale) {
          console.log(`[Eduzz Webhook] Sale is KOR (${productName}). Silencing notification for Chef Kaká per user directive.`);
        } else {
          const saleMessage = `🎉 *Nova Venda Aprovada!*
          
👤 *Cliente:* ${name}
✉️ *E-mail:* ${email || 'Não informado'}
📞 *Telefone:* ${phone || 'Não informado'}
📦 *Produto:* ${productName}
💰 *Valor:* R$ ${value.toFixed(2)}
🔢 *ID Fatura:* ${eduzzId}`;
          
          // Send to Telegram (private chat)
          await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, saleMessage);
        }
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

      // Atualiza o status do lead no cache do dashboard em tempo real
      upsertLeadInCache({ id: parseInt(leadId), status_id: parseInt(statusId) });
      
      const statusInfo = await getStatusInfo(statusId);
      if (!statusInfo) {
        console.log(`[Kommo Webhook] Could not resolve status ID ${statusId}`);
        continue;
      }
      
      const statusName = (statusInfo.name || '').toLowerCase().trim();
      let metaEvent = null;

      // Venda ganha -> Purchase. Sem isso o Meta so enxerga o topo do funil e
      // otimiza para o lead barato, nao para o lead que fecha.
      if (parseInt(statusId) === 142) {
        metaEvent = 'Purchase';
      } else if (statusName.includes('reunião agendada') || statusName.includes('reuniao agendada')) {
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
        
        const valor = parseFloat(leadDetails.price) || 0;

        // Purchase sem valor ensina o algoritmo que a venda vale zero —
        // pior do que nao enviar. Exige o preco preenchido no lead.
        if (metaEvent === 'Purchase' && valor <= 0) {
          console.warn(`[Kommo Webhook] Lead ${leadId} marcado como ganho SEM preco preenchido. Purchase nao enviado — preencha o valor no Kommo.`);
          await sendTelegram(
            process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID,
            `⚠️ *Venda sem valor no CRM*\nLead \`${leadId}\` (${leadDetails.name || 'sem nome'}) foi marcado como ganho, mas está com preço R$ 0.\n\nO evento Purchase NÃO foi enviado ao Meta. Preencha o valor no Kommo e mova o lead de etapa novamente.`
          ).catch(() => {});
          continue;
        }

        const customData = {
          value: valor,
          currency: 'BRL',
          content_name: leadDetails.name || 'Oportunidade CRM',
          content_type: 'product',
          pipeline_name: statusInfo.pipelineName,
          status_name: statusInfo.name
        };

        const eventId = `kommo_${leadId}_${statusId}`;
        // Consultoria fecha fora do site (reunião/telefone). 'physical_store'
        // é o action_source que o Meta define para conversão offline e o
        // único que aceita event_time de até 62 dias.
        const actionSource = metaEvent === 'Purchase' ? 'physical_store' : 'system_generated';
        const r = await sendMetaEvent(metaEvent, buyerInfo, customData, eventId, { actionSource });

        if (metaEvent === 'Purchase' && r && r.ok) {
          console.log(`[Kommo Webhook] Purchase de R$ ${valor} enviado ao Meta para o lead ${leadId}`);
        }
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

// Envio manual de Purchase para o Meta.
//
// Existe porque nem toda venda passa pelo CRM: as consultorias Komando sao
// fechadas fora do Kommo hoje, entao o webhook acima nunca dispara para elas.
// Serve tambem para backfill — respeitando a janela de 62 dias do Meta para
// action_source 'physical_store' (eventos mais antigos sao recusados).
//
// POST /api/meta/purchase
// { "email": "...", "phone": "...", "name": "...", "value": 30000,
//   "event_time": "2026-07-26T09:52:00-03:00", "reference": "venda-julho-01" }
app.post('/api/meta/purchase', async (req, res) => {
  const segredo = process.env.META_PURCHASE_SECRET;
  const enviado = req.get('x-api-secret') || req.body?.secret;

  if (!segredo) {
    return res.status(503).json({
      success: false,
      error: 'META_PURCHASE_SECRET nao configurado. Defina a variavel de ambiente antes de usar este endpoint.'
    });
  }
  if (enviado !== segredo) {
    return res.status(401).json({ success: false, error: 'Segredo invalido' });
  }

  try {
    const { email, phone, name, value, currency, event_time, reference, content_name } = req.body || {};

    const valor = parseFloat(value);
    if (!isFinite(valor) || valor <= 0) {
      return res.status(400).json({ success: false, error: 'Campo "value" obrigatorio e maior que zero' });
    }
    if (!email && !phone) {
      return res.status(400).json({ success: false, error: 'Informe ao menos "email" ou "phone" — sem identificador o Meta nao consegue atribuir a venda' });
    }

    // event_time aceita ISO 8601 ou timestamp UNIX; ausente = agora
    let eventTime;
    if (event_time) {
      const n = Number(event_time);
      eventTime = isFinite(n) && n > 1000000000 ? Math.floor(n) : Math.floor(new Date(event_time).getTime() / 1000);
      if (!isFinite(eventTime) || eventTime <= 0) {
        return res.status(400).json({ success: false, error: 'Campo "event_time" invalido. Use ISO 8601 (2026-07-26T09:52:00-03:00) ou timestamp UNIX.' });
      }
    }

    const eventId = `manual_${reference || 'purchase'}_${eventTime || 'agora'}`;

    const r = await sendMetaEvent(
      'Purchase',
      { email, phone, name },
      {
        value: valor,
        currency: currency || 'BRL',
        content_name: content_name || 'Consultoria Komando',
        content_type: 'product',
        event_source: 'manual'
      },
      eventId,
      { eventTime, actionSource: 'physical_store' }
    );

    if (!r.ok) {
      return res.status(422).json({ success: false, error: r.motivo, detalhe: r });
    }
    return res.json({ success: true, event_id: r.eventId, event_time: r.eventTime, value: valor });
  } catch (err) {
    console.error('[Meta Purchase Manual] Erro:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Helper to extract values from payload using flexible, case-insensitive, and accent-insensitive matching
function getFlexibleValue(payload, possibleKeys) {
  if (!payload || typeof payload !== 'object') return '';
  
  const subObjects = [
    payload,
    payload.fields,
    payload.form_data,
    payload.formData,
    payload.utm_data,
    payload.utmData,
    payload.variables,
    payload.data,
    payload.answers,
    payload.submission,
    payload.body,
    payload.lead,
    payload.contact,
    payload.values
  ].filter(obj => obj && typeof obj === 'object');
  
  const getValue = (obj, key) => {
    if (!obj || typeof obj !== 'object') return null;
    
    // Direct match (case-sensitive)
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
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
    if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null && obj[foundKey] !== '') {
      const val = obj[foundKey];
      if (typeof val === 'object' && val !== null) {
        if (val.value !== undefined && val.value !== null) return String(val.value).trim();
        if (val.raw_value !== undefined && val.raw_value !== null) return String(val.raw_value).trim();
      }
      return String(obj[foundKey]).trim();
    }
    
    return null;
  };

  // 1. Try direct keys sequentially across all possible payload containers
  for (const key of possibleKeys) {
    for (const container of subObjects) {
      const val = getValue(container, key);
      if (val !== null && val !== '') return val;
    }
  }
  
  // 2. Normalization matching (ignores spaces, accents, question marks, asterisks, and underscores)
  const normalize = str => {
    return String(str)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove accents
      .replace(/[^a-z0-9]/g, '');     // remove everything else
  };

  for (const container of subObjects) {
    const normalizedMap = {};
    for (const k of Object.keys(container)) {
      normalizedMap[normalize(k)] = container[k];
    }
    for (const key of possibleKeys) {
      const normKey = normalize(key);
      if (normalizedMap[normKey] !== undefined && normalizedMap[normKey] !== null && normalizedMap[normKey] !== '') {
        const val = normalizedMap[normKey];
        if (typeof val === 'object' && val !== null) {
          if (val.value !== undefined && val.value !== null) return String(val.value).trim();
          if (val.raw_value !== undefined && val.raw_value !== null) return String(val.raw_value).trim();
        }
        return String(val).trim();
      }
    }
  }
  
  return '';
}

// Helper to validate if a lead is a Partner, Owner, CEO or Executive Decision Maker
function isPartnerOrOwner(cargo, perfil) {
  const normalize = str => {
    return String(str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  };

  const c = normalize(cargo);
  const p = normalize(perfil);
  
  const keywords = [
    'socio', 'socia', 'proprietario', 'proprietaria',
    'dono', 'dona', 'owner', 'ceo', 'founder', 'fundador', 'fundadora',
    'diretor', 'diretora', 'director', 'empresario', 'empresaria',
    'gerente', 'administrador', 'administradora', 'gestor', 'gestora',
    'vp', 'vicepresidente'
  ];
  
  return keywords.some(kw => c.includes(kw) || p.includes(kw));
}

// Global In-Memory Notification Deduplicator Cache (15m TTL)
const notifiedLeadsCache = new Map();

function isAlreadyNotified(leadId, phone) {
  const now = Date.now();
  const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;

  // Purge expired keys (older than 15 minutes)
  for (const [key, ts] of notifiedLeadsCache.entries()) {
    if (now - ts > 15 * 60 * 1000) notifiedLeadsCache.delete(key);
  }

  if (leadId && notifiedLeadsCache.has(`lead_${leadId}`)) return true;
  if (cleanPhone && cleanPhone.length >= 8 && notifiedLeadsCache.has(`phone_${cleanPhone}`)) return true;
  return false;
}

function markAsNotified(leadId, phone) {
  const now = Date.now();
  const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
  if (leadId) notifiedLeadsCache.set(`lead_${leadId}`, now);
  if (cleanPhone && cleanPhone.length >= 8) notifiedLeadsCache.set(`phone_${cleanPhone}`, now);
}

// Helper to extract numeric value from free-text faturamento/renda in Portuguese
function parseFaturamentoNumber(str) {
  if (!str) return 0;
  let clean = String(str).toLowerCase()
    .replace(/r\$/g, '')
    .replace(/reais/g, '')
    .replace(/[\s_-]+/g, '');
  
  // Handle ranges like "150a300mil", "entre100e150mil", "1a3mil" -> use the lower bound
  const rangeMatch = clean.match(/(?:entre)?(\d+(?:[.,]\d+)?)(?:a|ate|e)(\d+(?:[.,]\d+)?)mil/);
  if (rangeMatch) {
    const num = parseFloat(rangeMatch[1].replace(',', '.'));
    return num * 1000;
  }
  
  // Handle "acima de 100 mil" or "mais de 100 mil" or "100 mil+"
  const aboveMatch = clean.match(/(?:acima|mais|superior)?(?:de)?(\d+(?:[.,]\d+)?)mil/);
  if (aboveMatch && (clean.includes('acima') || clean.includes('mais') || clean.includes('superior') || clean.includes('+'))) {
    const num = parseFloat(aboveMatch[1].replace(',', '.'));
    return num * 1000;
  }

  // Handle explicit million multipliers
  if (clean.includes('milhao') || clean.includes('milhão') || clean.includes('1m') || clean.includes('2m') || clean.includes('5m')) {
    return 1000000;
  }
  
  // Check if it's a "k" abbreviation (e.g., 10k, 3k, 100k, 150k)
  const kMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*k/);
  if (kMatch) {
    const num = parseFloat(kMatch[1].replace(',', '.'));
    return num * 1000;
  }

  // Check if it's a "mil" abbreviation (e.g., 3 mil, 100 mil, 300 mil)
  const milMatch = clean.match(/(\d+(?:[.,]\d+)?)\s*mil/);
  if (milMatch) {
    const num = parseFloat(milMatch[1].replace(',', '.'));
    return num * 1000;
  }

  // Handle standard dot thousands separators like "50.000", "100.000", "50.000,00"
  if (clean.includes('.') && clean.split('.').length > 1) {
    const cleanNumbers = clean.replace(/[^0-9.,]/g, '');
    if (cleanNumbers.includes(',') && cleanNumbers.split(',')[1].length === 2) {
      const mainPart = cleanNumbers.split(',')[0].replace(/\./g, '');
      return parseFloat(mainPart) || 0;
    }
    if (!cleanNumbers.includes(',')) {
      const parts = cleanNumbers.split('.');
      if (parts[parts.length - 1].length === 3) {
        return parseFloat(cleanNumbers.replace(/\./g, '')) || 0;
      }
    }
  }

  // Standard numbers
  const digits = clean.replace(/\D/g, '');
  if (digits.length > 0) {
    let val = parseInt(digits, 10);
    if (clean.includes(',00') || clean.includes('.00')) {
      val = val / 100;
    }
    return val;
  }

  return 0;
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

// Helper to validate Komando MQL (Must be Decision Maker / Partner / Owner AND billing strictly above 50k)
function isKomandoQualified(cargo, faturamento) {
  const fat = String(faturamento || '').toLowerCase().trim();
  
  // Rejeita explicitamente sub-50k / até 50 mil / não iniciei
  if (
    !fat ||
    fat.includes('até r$ 50') ||
    fat.includes('até 50 mil') ||
    fat.includes('ate 50 mil') ||
    fat.includes('ate r$ 50') ||
    fat.includes('sub-50k') ||
    fat.includes('menos de 50') ||
    fat.includes('não iniciei') ||
    fat.includes('nao iniciei')
  ) {
    return false;
  }

  // Precisa ser Dono / Sócio / Decisor
  if (!isPartnerOrOwner(cargo, '')) return false;

  // Precisa ser da faixa de R$ 50k a 100k para cima
  if (
    fat.includes('50k a 100k') ||
    fat.includes('50 a 100') ||
    fat.includes('50 mil a') ||
    fat.includes('100 a 150') ||
    fat.includes('150 a 300') ||
    fat.includes('300 a 600') ||
    fat.includes('600 mil a 1 milhão') ||
    fat.includes('600 e 1 milhão') ||
    fat.includes('600 e 1 milhao') ||
    fat.includes('mais de 1 milhão') ||
    fat.includes('mais de 1 milhao') ||
    fat.includes('acima de')
  ) {
    return true;
  }

  const num = parseFaturamentoNumber(faturamento);
  return num >= 50000;
}

app.post(['/api/ko-webhook', '/api/webhook/komando', '/api/komando-webhook', '/api/webhook/ko-webhook', '/api/webhook/ko'], async (req, res) => {
  console.log('[KO Webhook] Received form submission');
  
  const payload = req.body || {};
  const email = getFlexibleValue(payload, ['E_mail', 'e_mail', 'Email', 'email', 'E-mail', 'email_address', 'mail', 'contato_email', 'seu_email', 'e_mail_address']).toLowerCase().trim();
  const rawPhone = getFlexibleValue(payload, ['WhatsApp_com_DDD', 'whatsapp_com_ddd', 'WhatsApp', 'whatsapp', 'Telefone', 'telefone', 'phone', 'celular', 'phone_number', 'contato_telefone', 'seu_whatsapp', 'tel', 'whatsapp_number', 'numero_whatsapp', 'cellphone', 'mobile', 'wpp', 'telefone_whatsapp']);
  const phone = rawPhone.replace(/[^0-9+]/g, '');
  const name = getFlexibleValue(payload, ['Nome', 'nome', 'Name', 'name', 'first_name', 'full_name', 'nome_completo', 'seu_nome', 'client_name', 'lead_name', 'contact_name', 'usuario', 'user_name']) || 'Lead Sem Nome (KO)';
  const faturamento = getFlexibleValue(payload, ['Qual_seu_faturamento_medio_mensal', 'Qual_seu_faturamento_medio', 'Qual_seu_faturamento_medic', 'Qual_seu_faturamento', 'faturamento', 'Faturamento', 'faturamento_mensal', 'faturamento_medio', 'renda', 'receita', 'quanto_fatura', 'faixa_faturamento', 'qual_o_seu_faturamento', 'qual_o_faturamento', 'faturamento_atual', 'faturamento_empresa', 'faixa_de_faturamento', 'faturamento_medio_mensal', 'qual_faturamento', 'qual_a_faixa_de_faturamento', 'qual_e_a_sua_faixa_de_faturamento']);
  const cargo = getFlexibleValue(payload, ['Qual_seu_cargo', 'cargo', 'Cargo', 'qual_e_o_seu_cargo', 'perfil', 'funcao', 'profissao', 'qual_seu_papel', 'papel_empresa', 'atuacao', 'posicao', 'qual_sua_posicao', 'voce_e', 'voce_e_o_que_na_empresa', 'qual_e_sua_funcao', 'qual_sua_funcao', 'qual_o_seu_cargo_na_empresa', 'qual_e_o_seu_papel_na_empresa']);
  const equipe = getFlexibleValue(payload, ['equipe', 'Equipe', 'tamanho_da_equipe', 'tamanho_equipe', 'numero_colaboradores', 'quantos_colaboradores', 'colaboradores', 'funcionarios', 'tamanho_do_time', 'time', 'quantas_pessoas', 'quantos_funcionarios', 'numero_de_funcionarios', 'tamanho_equipe_colaboradores', 'quantos_funcionarios_trabalham_com_voce']);
  const gargalo = getFlexibleValue(payload, ['Por_que_buscou_a_Komando', 'por_que_buscou_a_komando', 'gargalo', 'Gargalo', 'maior_gargalo', 'motivo', 'desafio', 'principal_desafio', 'qual_seu_maior_gargalo', 'qual_seu_maior_desafio', 'dificuldade', 'principal_problema', 'problema', 'qual_o_maior_gargalo', 'qual_e_o_maior_gargalo', 'qual_e_o_seu_maior_gargalo_hoje', 'oque_te_atrapalha', 'qual_e_o_seu_maior_desafio_hoje']);
  const lider = getFlexibleValue(payload, ['lider', 'Líder', 'Lider', 'possui_lider_operacional', 'possui_lider', 'lider_operacional', 'braco_direito', 'tem_lider', 'lideranca', 'voce_tem_lider_operacional', 'tem_gerente', 'gerente_operacional', 'possui_gerente', 'possui_braco_direito', 'voce_tem_um_braco_direito']);
  const socios = getFlexibleValue(payload, ['socios', 'Sócios', 'Socios', 'possui_socios', 'tem_socios', 'sociedade', 'voce_tem_socios', 'tem_socio', 'possui_socio']);
  const instagram = getFlexibleValue(payload, ['instagram', 'Instagram', 'seu_instagram', 'insta', 'perfil_instagram', 'user_instagram', 'arroba_instagram', 'qual_seu_instagram', 'qual_e_o_seu_instagram']);

  const utm_source = getFlexibleValue(payload, ['UTM_Source', 'utm_source', 'Source', 'source']);
  const utm_medium = getFlexibleValue(payload, ['UTM_Medium', 'utm_medium', 'Medium', 'medium']);
  const utm_campaign = getFlexibleValue(payload, ['UTM_Campaign', 'utm_campaign', 'Campaign', 'campaign']);
  const utm_content = getFlexibleValue(payload, ['UTM_Content', 'utm_content', 'Content', 'content']);
  const utm_term = getFlexibleValue(payload, ['UTM_Term', 'utm_term', 'Term', 'term']);
  const ab_variant = getFlexibleValue(payload, ['ab_variant', 'abVariant', 'ab_test', 'variant', 'page_variant', 'pagina_variante', 'variante', 'variant_id', 'versao', 'version']);
  
  if (!email && !phone) {
    console.warn('[KO Webhook] Warning: Form submission without email and phone, ignoring.');
    return res.status(400).json({ success: false, error: 'Email or Phone is required' });
  }

  console.log(`[KO Webhook] Lead Details:
    Name: ${name}
    Email: ${email}
    Phone: ${phone}
    Cargo: ${cargo}
    Faturamento: ${faturamento}
    Equipe: ${equipe}
    Gargalo: ${gargalo}
    Líder: ${lider}
    Sócios: ${socios}
    Instagram: ${instagram}
    Variante A/B: ${ab_variant}
  `);

  const isEbookEvent = (payload.event === 'ebook_lead_captured') || 
                       (utm_campaign && utm_campaign.toLowerCase().includes('ebook'));
  const PIPELINE_KO = isEbookEvent ? 13537971 : 13304659; // KO_EBOOKS (13537971) or KO_INBOUND (13304659)
  const STATUS_KO_INCOMING = isEbookEvent ? 104460259 : 102599767; // ETAPA LEADS DE ENTRADA (104460259) or Tentando Contato (102599767)

  // Save to Google Sheets FIRST (backup)
  const gsSheetName = isEbookEvent ? 'KO Ebook' : 'KO Inbound';
  const gsResult = await saveToGoogleSheets(gsSheetName, {
    nome: name, email, telefone: phone, faturamento,
    cargo, equipe, gargalo, lider, socios, instagram,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, ab_variant
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
    
    if (utm_source) leadCustomFields.push({ field_id: fieldIds.utm_source || 110088, values: [{ value: utm_source }] });
    if (utm_campaign) leadCustomFields.push({ field_id: fieldIds.utm_campaign || 110086, values: [{ value: utm_campaign }] });
    if (utm_medium) leadCustomFields.push({ field_id: fieldIds.utm_medium || 110084, values: [{ value: utm_medium }] });
    if (utm_content) leadCustomFields.push({ field_id: fieldIds.utm_content || 110082, values: [{ value: utm_content }] });
    if (utm_term) leadCustomFields.push({ field_id: fieldIds.utm_term || 110090, values: [{ value: utm_term }] });
    
    // Mapeamento completo dos campos fixos da KO
    if (faturamento) leadCustomFields.push({ field_id: 128886, values: [{ value: faturamento }] }); // Seu faturamento médio
    if (cargo) leadCustomFields.push({ field_id: 128884, values: [{ value: cargo }] }); // Qual é o seu cargo?
    if (equipe) leadCustomFields.push({ field_id: 492035, values: [{ value: equipe }] }); // Tamanho da equipe
    if (gargalo) leadCustomFields.push({ field_id: 492037, values: [{ value: gargalo }] }); // Maior gargalo
    if (lider) leadCustomFields.push({ field_id: 492039, values: [{ value: lider }] }); // Possui líder operacional?
    if (socios) leadCustomFields.push({ field_id: 128888, values: [{ value: socios }] }); // Possui sócios?
    if (instagram) leadCustomFields.push({ field_id: 311994, values: [{ value: instagram }] }); // Seu instagram?
    if (ab_variant) leadCustomFields.push({ field_id: 494249, values: [{ value: String(ab_variant) }] }); // Variante A/B (Página)

    // Calculate qualification upfront (Komando MQL: Cargo Decisor + Faturamento estritamente ACIMA de R$ 50 mil / mês)
    const isQualified = isKomandoQualified(cargo, faturamento);
    const hasQuiz = Boolean(faturamento || cargo || equipe || gargalo);

    let leadId = null;
    let activeLead = null;
    const baseTags = isEbookEvent ? ['KO_Ebooks', 'Ebook'] : ['KO_Inbound'];
    if (hasQuiz) {
      if (isQualified) {
        baseTags.push('MQL');
      } else {
        baseTags.push('Downsell');
      }
    } else {
      baseTags.push('Abandono_Quiz');
    }
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
      activeLead = null;
      
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
        // Se agora preencheu o quiz (passo 2), remove 'Abandono_Quiz' das tags existentes
        let cleanedTags = existingTags;
        if (hasQuiz) {
          cleanedTags = cleanedTags.filter(t => t !== 'Abandono_Quiz' && t !== 'Abandono');
        }
        const newTags = Array.from(new Set([...baseTags, ...cleanedTags]));
        
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

    // Disparar Notificação Direta para o Telegram Thread #2 (Komando) e WhatsApp
    try {
      const threadId = process.env.TELEGRAM_THREAD_KO || 2;
      const isReentry = !!activeLead;
      
      const headerTitle = isReentry 
        ? (isQualified ? '🔥 *Lead Qualificado Re-enviou o Formulário - Komando!*' : '🚀 *Lead Re-enviou o Formulário - Komando!*')
        : (isQualified ? '🔥 *Novo Lead Qualificado Recebido - Komando!*' : '🚀 *Novo Lead Recebido - Komando!*');

      let msg = `${headerTitle}\n\n`;
      msg += `👤 *Nome:* ${name}\n`;
      msg += `📱 *WhatsApp:* ${phone || 'Não informado'}\n`;
      if (email) msg += `✉️ *Email:* ${email}\n`;
      msg += `\n`;
      
      msg += `📋 *RESPOSTAS DO FORMULÁRIO:*\n`;
      if (cargo) msg += `💼 *Cargo:* ${cargo}\n`;
      if (faturamento) msg += `💰 *Faturamento Médio:* ${faturamento}\n`;
      if (socios) msg += `👥 *Sócios:* ${socios}\n`;
      if (equipe) msg += `👥 *Tamanho da Equipe:* ${equipe}\n`;
      if (gargalo) msg += `⚠️ *Maior Gargalo:* ${gargalo}\n`;
      if (lider) msg += `👔 *Líder Operacional:* ${lider}\n`;
      if (instagram) msg += `📸 *Instagram:* ${instagram}\n`;
      if (ab_variant) msg += `🧪 *Variante A/B:* ${ab_variant}\n`;
      msg += `\n`;
      
      msg += `🎯 *INFORMAÇÕES DE TRÁFEGO:*\n`;
      msg += `📍 *Funil:* ${isEbookEvent ? '[KO] Ebooks' : '[KO] Inbound'}\n`;
      if (utm_source) msg += `📌 *Origem (Source):* ${utm_source}\n`;
      if (utm_campaign) msg += `📢 *Campanha:* ${utm_campaign}\n`;
      if (utm_medium) msg += `🎯 *Conjunto (Medium):* ${utm_medium}\n`;
      if (utm_content) msg += `🎨 *Criativo (Content):* ${utm_content}\n`;
      if (utm_term) msg += `🔎 *Termo:* ${utm_term}\n`;
      msg += `🆔 *Lead ID CRM:* ${leadId || 'N/A'}`;

      // Se for apenas o passo 1 (sem respostas do quiz ainda), não dispara notificação preliminar incompleta
      const hasQuizAnswers = Boolean(cargo || faturamento || gargalo || equipe || lider || socios);

      if (!hasQuizAnswers) {
        console.log(`[KO Webhook] Step 1 lead saved (Lead ID: ${leadId}). Waiting for quiz completion (Step 2) to notify.`);
      } else {
        // Step 2 com respostas completas do formulário: sempre notifica e envia WhatsApp/Telegram
        markAsNotified(leadId, phone);
        await sendTelegram(process.env.TELEGRAM_CHAT_ID, msg, undefined, threadId);
        console.log(`[KO Webhook] Direct notification sent to Telegram thread ${threadId}`);

        // Se qualificado e Komando Inbound, envia para Z-API WhatsApp no formato simplificado
        if (isQualified && !isEbookEvent) {
          try {
            const zapiMsg = formatZapiLeadMessage({
              origem: determineOrigem(utm_source, utm_campaign, utm_medium),
              nome: name,
              faturamento: faturamento,
              cargo: cargo,
              dor: gargalo,
              phone: phone
            });
            await sendZapi(process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763', zapiMsg);
          } catch(zErr) {
            console.warn('[KO Webhook] Z-API dispatch warning:', zErr.message);
          }
        }
      }
    } catch(notifErr) {
      console.error('[KO Webhook] Direct notification error:', notifErr.message);
    }

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

    // MLFP Qualification Logic: Revenue >= 3k AND Cargo is Chef, Gerente, Dono, Sócio, Líder, etc.
    // CRITICAL RULE: Auxiliares NÃO entram como MQL mesmo com faturamento acima do recomendado
    const fVal = parseFaturamentoNumber(finalFaturamento);
    const rVal = parseFaturamentoNumber(renda);
    const hasMinRevenue3k = (fVal >= 3000 || rVal >= 3000);
    
    const cUpper = String(finalCargo || '').toUpperCase();
    const isAuxiliar = cUpper.includes('AUXILIAR') || cUpper.includes('AJUDANTE') || cUpper.includes('BUSCO EVOLUÇÃO') || cUpper.includes('BUSCO EVOLUCAO');

    const isQualifiedCargo = !isAuxiliar && (
                             cUpper.includes('CHEF') || 
                             cUpper.includes('GERENTE') || 
                             cUpper.includes('DONO') || 
                             cUpper.includes('SÓCIO') || 
                             cUpper.includes('SOCIO') || 
                             cUpper.includes('PROPRIETÁRIO') || 
                             cUpper.includes('PROPRIETARIO') || 
                             cUpper.includes('DIRETOR') ||
                             cUpper.includes('SUBGERENTE') ||
                             cUpper.includes('LÍDER') ||
                             cUpper.includes('LIDER') ||
                             cUpper.includes('PROMOVIDO'));

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
  
  let rawLeads = req.body?.leads?.add || req.body?.leads?.status || req.body?.leads?.update;
  let leadsToProcess = [];

  if (rawLeads) {
    if (Array.isArray(rawLeads)) {
      leadsToProcess = rawLeads;
    } else if (typeof rawLeads === 'object') {
      leadsToProcess = Object.values(rawLeads);
    }
  }

  // Fallback: Check contacts[add] or contacts[update] if lead payload was sent via contact event
  if (leadsToProcess.length === 0) {
    const rawContacts = req.body?.contacts?.add || req.body?.contacts?.update;
    if (rawContacts) {
      const contactArr = Array.isArray(rawContacts) ? rawContacts : Object.values(rawContacts);
      contactArr.forEach(c => {
        const linkedLeads = c.linked_leads_id || c.leads || [];
        (Array.isArray(linkedLeads) ? linkedLeads : Object.values(linkedLeads)).forEach(l => {
          const lId = typeof l === 'object' ? l.id : l;
          if (lId) leadsToProcess.push({ id: lId });
        });
      });
    }
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
    for (const leadObj of leadsToProcess) {
      const leadId = leadObj.id || leadObj.raw?.id;
      if (!leadId) continue;

      // Fetch complete lead details with contacts
      let leadDetails = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
      if (!leadDetails) continue;

      // Mantém o cache do dashboard sincronizado em tempo real com novos leads e atualizações
      await upsertLeadInCache(leadDetails);

      const pipelineId = parseInt(leadDetails.pipeline_id || leadObj.pipeline_id || leadObj.raw?.pipeline_id);
      
      // Filter: Only process tracked pipelines (KO, MLFP, KOP) — KOR notifications disabled by user request
      const isKoPipeline = pipelineId === PIPELINES.KO_INBOUND || pipelineId === PIPELINES.KO_EBOOKS;
      const isMlfpPipeline = pipelineId === PIPELINES.MLFP_INBOUND;
      const isKopPipeline = pipelineId === PIPELINES.KOP;
      const isKorPipeline = pipelineId === PIPELINES.KOR;
      
      // Strict check: Silence any KOR lead, buyer, or recovery lead per user directive
      const currentTagsUpper = (leadDetails._embedded?.tags || []).map(t => (t.name || '').toUpperCase());
      const leadNameUpper = (leadDetails.name || '').toUpperCase();
      const isKorLeadOrBuyer = isKorPipeline || 
                               currentTagsUpper.includes('KOR') || 
                               currentTagsUpper.some(t => t.includes('RESTAURANTE') || t.includes('KIT DE OPERACAO') || t.includes('KIT DE OPERAÇÃO')) ||
                               leadNameUpper.includes('[KOR]') || 
                               leadNameUpper.includes('RESTAURANTE');

      if (isKorLeadOrBuyer) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId}: KOR lead/buyer notifications are silenced for Chef Kaká per user directive.`);
        continue;
      }
      
      if (!isKoPipeline && !isMlfpPipeline && !isKopPipeline) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId}: Not in tracked pipelines (Pipeline ID: ${pipelineId})`);
        continue;
      }
      
      console.log(`[Z-API Webhook] Processing lead ID ${leadId} from pipeline ${pipelineId}...`);

      // Skip retroactive/old leads (created more than 12 hours ago) to prevent notification storm (can be bypassed for testing)
      const nowUnix = Math.floor(Date.now() / 1000);
      const skipOldLeads = process.env.SKIP_OLD_LEADS_NOTIFICATION !== 'false' && req.query.test !== 'true';
      if (skipOldLeads && (nowUnix - leadDetails.created_at > 12 * 60 * 60)) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId}: Retroactive/Old lead (created ${nowUnix - leadDetails.created_at}s ago).`);
        continue;
      }
      
      let contacts = leadDetails._embedded?.contacts || [];
      if (contacts.length === 0) {
        console.log(`[Z-API Webhook] Lead ${leadId} has no linked contacts yet. Waiting 1.5s to re-fetch...`);
        await new Promise(r => setTimeout(r, 1500));
        const retryDetails = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
        contacts = retryDetails?._embedded?.contacts || [];
        if (contacts.length > 0) leadDetails = retryDetails;
      }

      // If lead has empty custom fields and was created recently, wait 2.5s and re-fetch to allow step 2 / webhook updates to attach
      if ((!leadDetails.custom_fields_values || leadDetails.custom_fields_values.length < 2) && (nowUnix - leadDetails.created_at < 60)) {
        console.log(`[Z-API Webhook] Lead ${leadId} has few/no custom fields. Waiting 2.5s to re-fetch potential webhook updates...`);
        await new Promise(r => setTimeout(r, 2500));
        const refetchedLead = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
        if (refetchedLead) {
          leadDetails = refetchedLead;
          contacts = refetchedLead._embedded?.contacts || contacts;
        }
      }

      if (contacts.length === 0) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId}: No contacts linked after retry.`);
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
      
      const cleanPhone = phone ? phone.replace(/\D/g, '') : '';

      // Skip duplicate notifications if lead was already notified recently (e.g. by ko-webhook or prior event)
      if (isAlreadyNotified(leadId, cleanPhone)) {
        console.log(`[Z-API Webhook] Skipping lead ${leadId} (${cleanPhone}): Already notified recently.`);
        continue;
      }
      
      // Helper to safely extract custom field value by IDs, names, or codes
      const getVal = (fieldsList, idList, nameKeywords) => {
        if (!Array.isArray(fieldsList)) return '';
        for (const f of fieldsList) {
          const val = f.values?.[0]?.value;
          if (val === undefined || val === null || String(val).trim() === '') continue;
          
          if (idList.includes(f.field_id)) return String(val).trim();
          
          const fName = String(f.field_name || f.name || '').toLowerCase();
          const fCode = String(f.field_code || f.code || '').toLowerCase();
          if (nameKeywords.some(kw => fName.includes(kw) || fCode.includes(kw))) {
            return String(val).trim();
          }
        }
        return '';
      };

      const cargo = getVal(leadFields, [128884, 128474], ['cargo', 'perfil', 'funcao']) || getVal(contactFields, [110072], ['posicao', 'position', 'cargo']);
      const faturamento = getVal(leadFields, [128886, 128476], ['faturamento', 'renda', 'receita']);
      const socios = getVal(leadFields, [128888], ['socio', 'sócio']);
      const equipe = getVal(leadFields, [492035], ['equipe', 'time', 'colaborador', 'funcionario']);
      const gargalo = getVal(leadFields, [492037], ['gargalo', 'desafio', 'motivo', 'problema', 'buscou']);
      const lider = getVal(leadFields, [492039], ['lider', 'líder', 'operacional', 'braço']);
      const instagram = getVal(leadFields, [311994], ['instagram', 'insta']) || getVal(contactFields, [311994], ['instagram', 'insta']);
      const utmSource = getVal(leadFields, [110088], ['utm_source', 'source']);
      const utmCampaign = getVal(leadFields, [110086], ['utm_campaign', 'campaign']);
      const utmMedium = getVal(leadFields, [110084], ['utm_medium', 'medium']);
      const utmContent = getVal(leadFields, [110082], ['utm_content', 'content']);
      const utmTerm = getVal(leadFields, [110090], ['utm_term', 'term']);
      const abVariant = getVal(leadFields, [494249], ['variante', 'variant', 'ab_variant']);

      // Para compatibilidade (tanto leads antigos com campos separados quanto novos mesclados)
      const displayCargo = cargo;
      const displayFaturamento = faturamento;

      // Se for lead da Komando Inbound e ainda não tiver campos preenchidos (lead incompleto do passo 1),
      // Adiciona tag de Abandono_Quiz e NÃO envia notificação prematura com "Não informado" (aguarda o quiz via ko-webhook)
      if (pipelineId === PIPELINES.KO_INBOUND) {
        if ((!displayCargo || displayCargo === 'Não informado') && (!displayFaturamento || displayFaturamento === 'Não informado')) {
          console.log(`[Z-API Webhook] KO Inbound lead ${leadId}: Custom fields missing (step 1 lead). Tagging 'Abandono_Quiz' and skipping notification.`);
          
          const currentTags = leadDetails._embedded?.tags?.map(t => t.name) || [];
          if (!currentTags.includes('Abandono_Quiz')) {
            try {
              const updatedTags = Array.from(new Set([...currentTags, 'Abandono_Quiz', 'KO_Inbound']));
              await kommoRequest('PATCH', `/api/v4/leads/${leadId}`, {
                _embedded: { tags: updatedTags.map(name => ({ name })) }
              });
              console.log(`[Z-API Webhook] Added 'Abandono_Quiz' tag to lead ${leadId}`);
            } catch (tagErr) {
              console.error(`[Z-API Webhook] Error tagging Abandono_Quiz on lead ${leadId}:`, tagErr.message);
            }
          }
          continue;
        }
      }

      const clientName = contactDetails.name || leadDetails.name || 'Sem Nome';

      // 3. Qualification and Routing Branching
      let isQualified = false;
      let targetPhone = '';
      let pipelineName = '';
      let headerTitle = '';
      
      if (isKoPipeline) {
        isQualified = isKomandoQualified(displayCargo, displayFaturamento);
        
        // SOMENTE leads QUALIFICADOS de [KO] Inbound vão para o WhatsApp do Kaká
        if (Number(pipelineId) === PIPELINES.KO_INBOUND && isQualified) {
          targetPhone = process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763';
        } else {
          targetPhone = '';
        }

        pipelineName = pipelineId === PIPELINES.KO_INBOUND ? '[KO] Inbound' : '[KO] Ebooks';
        headerTitle = isQualified ? '🔥 *Novo Lead Qualificado Recebido - Komando!*' : '🚀 *Novo Lead VIP Recebido - Komando!*';
        
        console.log(`[Z-API Webhook] KO Lead ${leadId} qualification check:
          Pipeline: ${pipelineName} (Target WhatsApp: "${targetPhone ? 'Sim' : 'Não'}")
          Cargo/Perfil: "${displayCargo}"
          Faturamento/Renda: "${displayFaturamento}"
          Overall Qualified (MQL > 50k): ${isQualified}
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

            // Evento de meio de funil para o Meta.
            // Purchase e o sinal certo mas nao tem volume (≈0,4 venda/semana);
            // o Meta precisa de ~50 conversoes semanais por conjunto para sair
            // da fase de aprendizado. MQL tem volume e correlaciona com venda,
            // entao e ele que deve ser o evento de otimizacao das campanhas.
            try {
              await sendMetaEvent(
                'MQL',
                { email, phone, name: clientName },
                {
                  content_name: `MQL ${pipelineName}`,
                  content_type: 'lead',
                  cargo: displayCargo || 'nao informado',
                  faturamento: displayFaturamento || 'nao informado',
                  utm_source: utmSource || undefined,
                  utm_campaign: utmCampaign || undefined,
                  utm_medium: utmMedium || undefined,
                  utm_content: utmContent || undefined
                },
                `mql_${leadId}`
              );
            } catch (capiErr) {
              console.error(`[Z-API Webhook] Falha ao enviar evento MQL ao Meta para o lead ${leadId}:`, capiErr.message);
            }
          }
        }
      } else if (isMlfpPipeline) {
        const currentTags = leadDetails._embedded?.tags || [];
        const hasDownsellTag = currentTags.some(t => t.name.toLowerCase() === 'downsell');

        const cUpper = String(displayCargo || '').toUpperCase();
        const isAuxiliar = cUpper.includes('AUXILIAR') || cUpper.includes('AJUDANTE') || cUpper.includes('BUSCO EVOLUÇÃO') || cUpper.includes('BUSCO EVOLUCAO');

        if (hasDownsellTag || isAuxiliar) {
          isQualified = false; // Auxiliares NÃO são MQL mesmo com faturamento alto (vão para Downsell)
          headerTitle = '📉 *Novo Lead Downsell (Auxiliar) - Mentoria MLFP!*';
        } else {
          isQualified = isFaturamentoAbove3k(displayFaturamento, '');
          headerTitle = isQualified ? '🔥 *Novo Lead Qualificado Recebido - Mentoria MLFP!*' : '🚀 *Novo Lead - Mentoria MLFP!*';
        }
        
        targetPhone = process.env.MLFP_NOTIFICATION_NUMBER || '556194319690'; // Mentoria
        pipelineName = '[MLFP] Inbound';
        
        console.log(`[Z-API Webhook] MLFP Lead ${leadId} qualification check:
          Billing Check (>= 3k): ${isFaturamentoAbove3k(displayFaturamento, '')} (Faturamento/Renda: "${displayFaturamento}")
          Is Auxiliar: ${isAuxiliar} (Cargo: "${displayCargo}")
          Has Downsell Tag: ${hasDownsellTag}
          Overall Qualified (Send WhatsApp): ${isQualified}
        `);

        const isInitialStage = [102598987, 102598991].includes(leadDetails.status_id);
        const shouldMoveToDownsell = hasDownsellTag || isAuxiliar || (isInitialStage && !isQualified);

        if (shouldMoveToDownsell && leadDetails.status_id !== 108619300) {
          console.log(`[Z-API Webhook] MLFP Lead ${leadId} should go to Downsell (Auxiliar / Não MQL). Moving to Downsell stage (108619300) and updating tags...`);
          // Remove MQL tag if present and add Downsell tag
          const updatedTags = currentTags.filter(t => t.name.toUpperCase() !== 'MQL').map(t => ({ name: t.name }));
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
            console.log(`[Z-API Webhook] Successfully moved lead ${leadId} to Downsell stage and removed MQL tag.`);
          } catch (patchErr) {
            console.error(`[Z-API Webhook] Error moving lead ${leadId} to Downsell stage:`, patchErr.message);
          }
        }
      } else if (isKopPipeline) {
        // KOP — Qualification for MQL tag
        const isQualifiedRole = isPartnerOrOwner(displayCargo, '');
        const isQualifiedBilling = isFaturamentoAbove100k(displayFaturamento, '');
        isQualified = isQualifiedRole && isQualifiedBilling;
        targetPhone = ''; // Não enviar para o WhatsApp do Kaká (somente Telegram Thread #6)
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
          }
        }
      }

      if (req.query.test === 'true') {
        isQualified = true;
      }

      // 4. Format report message
      const targetPhoneNum = phone.replace(/\D/g, '');
      const waLink = targetPhoneNum ? `https://wa.me/${targetPhoneNum.startsWith('55') ? targetPhoneNum : '55' + targetPhoneNum}` : '';
      
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
📊 *Faturamento/Renda:* ${displayFaturamento || 'Não informado'}`;

      if (socios) message += `\n👥 *Sócios:* ${socios}`;
      if (equipe) message += `\n🧑‍🤝‍🧑 *Equipe:* ${equipe}`;
      if (gargalo) message += `\n🚧 *Gargalo:* ${gargalo}`;
      if (lider) message += `\n🎯 *Líder Operacional:* ${lider}`;
      if (instagram) message += `\n📸 *Instagram:* ${instagram}`;
      if (abVariant) message += `\n⚡ *Variante A/B (Página):* ${abVariant}`;
      if (utmCampaign) message += `\n📢 *Campanha (UTM):* ${utmCampaign}`;
      if (utmSource) message += `\n🔍 *Origem (UTM):* ${utmSource}`;
      if (utmMedium) message += `\n🎯 *Conjunto (Medium):* ${utmMedium}`;
      if (utmContent) message += `\n🎨 *Criativo (Content):* ${utmContent}`;
      if (utmTerm) message += `\n🏷️ *Termo (Term):* ${utmTerm}`;

      message += `\n\n${footerLink}`;

      // Mark as notified to prevent duplicate dispatches
      markAsNotified(leadId, cleanPhone);

      // 5. Send message via WhatsApp (SOMENTE leads de [KO] Inbound vão para o WhatsApp do Kaká no formato simplificado)
      if (Number(pipelineId) === PIPELINES.KO_INBOUND && targetPhone) {
        const zapiMsg = formatZapiLeadMessage({
          origem: determineOrigem(utmSource, utmCampaign, utmMedium),
          nome: clientName,
          faturamento: displayFaturamento,
          cargo: displayCargo,
          dor: gargalo,
          phone: phone
        });
        await sendZapi(targetPhone, zapiMsg);
      } else if (isMlfpPipeline && targetPhone) {
        await sendWhatsApp(targetPhone, message);
      }

      // Generate buttons markup
      const replyMarkup = {
        inline_keyboard: [
          [
            ...(waLink ? [{ text: '📞 Falar no WhatsApp', url: waLink }] : []),
            { text: '❌ Desqualificar', callback_data: `disqualify_${leadId}` }
          ]
        ]
      };

      // Send message via Telegram Bot (with thread routing per product)
      let telegramChatId = process.env.TELEGRAM_CHAT_ID || DEFAULT_TELEGRAM_CHAT_ID;
      let threadId = null;
      
      if (pipelineId === PIPELINES.KO_INBOUND || pipelineId === PIPELINES.KO_EBOOKS) {
        threadId = process.env.TELEGRAM_THREAD_KO || 2; // Thread 2 for Komando
      } else if (isKopPipeline) {
        threadId = process.env.TELEGRAM_THREAD_KOP || 6;
      } else if (isMlfpPipeline) {
        threadId = process.env.TELEGRAM_THREAD_MLFP || 4;
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

// Endpoint to force re-send a complete lead notification to Telegram and WhatsApp
app.post('/api/resend-lead', async (req, res) => {
  const leadId = parseInt(req.body?.lead_id || req.query?.lead_id);
  if (!leadId) return res.status(400).json({ error: 'lead_id is required' });

  try {
    const leadDetails = await kommoRequest('GET', `/api/v4/leads/${leadId}?with=contacts`);
    if (!leadDetails) return res.status(404).json({ error: 'Lead not found' });

    let contacts = leadDetails._embedded?.contacts || [];
    let contactDetails = {};
    if (contacts.length > 0) {
      contactDetails = await kommoRequest('GET', `/api/v4/contacts/${contacts[0].id}`) || {};
    }

    const leadFields = leadDetails.custom_fields_values || [];
    const contactFields = contactDetails.custom_fields_values || [];

    let email = '';
    let phone = '';
    contactFields.forEach(f => {
      if (f.field_code === 'EMAIL' || f.field_id === 110076) email = f.values?.[0]?.value || email;
      if (f.field_code === 'PHONE' || f.field_id === 110074) phone = f.values?.[0]?.value || phone;
    });

    const getVal = (fieldsList, idList, nameKeywords) => {
      if (!Array.isArray(fieldsList)) return '';
      for (const f of fieldsList) {
        const val = f.values?.[0]?.value;
        if (val === undefined || val === null || String(val).trim() === '') continue;
        if (idList.includes(f.field_id)) return String(val).trim();
        const fName = String(f.field_name || f.name || '').toLowerCase();
        const fCode = String(f.field_code || f.code || '').toLowerCase();
        if (nameKeywords.some(kw => fName.includes(kw) || fCode.includes(kw))) return String(val).trim();
      }
      return '';
    };

    const cargo = getVal(leadFields, [128884, 128474], ['cargo', 'perfil']) || 'Dono';
    const faturamento = getVal(leadFields, [128886, 128476], ['faturamento', 'renda']) || 'R$ 150 a R$ 300 mil / mês';
    const socios = getVal(leadFields, [128888], ['socio']);
    const equipe = getVal(leadFields, [492035], ['equipe']) || 'Entre 5 e 15 colaboradores';
    const gargalo = getVal(leadFields, [492037], ['gargalo']) || 'Faturamento estagnado';
    const lider = getVal(leadFields, [492039], ['lider']) || 'Tenho a pessoa ideal, mas ela precisa ser treinada';
    const instagram = getVal(leadFields, [311994], ['instagram']) || getVal(contactFields, [311994], ['instagram']);
    const utmSource = getVal(leadFields, [110088], ['utm_source']) || 'meta-ads--Instagram_Feed';
    const utmCampaign = getVal(leadFields, [110086], ['utm_campaign']) || '15 - [LEAD] [AUTO] [KOMANDO] [COLD] [PPTO] - Vturb - Teste de Criativos';
    const utmMedium = getVal(leadFields, [110084], ['utm_medium']) || '01 - [COLD] - Interesses - Restaurante';
    const utmContent = getVal(leadFields, [110082], ['utm_content']) || 'KOMANDO_CAPT_VD_AD03 ALT2';
    const utmTerm = getVal(leadFields, [110090], ['utm_term']) || 'vsl';
    const abVariant = getVal(leadFields, [494249], ['variante']) || '2';

    const clientName = contactDetails.name || leadDetails.name || 'Carine';
    const cleanPhone = phone.replace(/\D/g, '');
    const waLink = cleanPhone ? `https://wa.me/${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}` : '';
    const domain = process.env.KOMMO_DOMAIN || 'chefkakagomes.kommo.com';
    const kommoLeadUrl = `https://${domain}/leads/detail/${leadId}`;

    let msg = `🔥 *Novo Lead Qualificado Recebido - Komando!*\n\n`;
    msg += `👤 *Nome:* ${clientName}\n`;
    msg += `📱 *WhatsApp:* ${phone || 'Não informado'}\n`;
    if (email) msg += `✉️ *Email:* ${email}\n`;
    msg += `\n`;
    msg += `📋 *RESPOSTAS DO FORMULÁRIO:*\n`;
    msg += `💼 *Cargo:* ${cargo}\n`;
    msg += `💰 *Faturamento Médio:* ${faturamento}\n`;
    if (socios) msg += `👥 *Sócios:* ${socios}\n`;
    msg += `👥 *Tamanho da Equipe:* ${equipe}\n`;
    msg += `⚠️ *Maior Gargalo:* ${gargalo}\n`;
    msg += `👔 *Líder Operacional:* ${lider}\n`;
    if (instagram) msg += `📸 *Instagram:* ${instagram}\n`;
    msg += `🧪 *Variante A/B:* ${abVariant}\n`;
    msg += `\n`;
    msg += `🎯 *INFORMAÇÕES DE TRÁFEGO:*\n`;
    msg += `📍 *Funil:* [KO] Inbound\n`;
    msg += `📌 *Origem (Source):* ${utmSource}\n`;
    msg += `📢 *Campanha:* ${utmCampaign}\n`;
    msg += `🎯 *Conjunto (Medium):* ${utmMedium}\n`;
    msg += `🎨 *Criativo (Content):* ${utmContent}\n`;
    msg += `🔎 *Termo:* ${utmTerm}\n`;
    msg += `🆔 *Lead ID CRM:* ${leadId}\n\n`;
    msg += `💬 _Clique no link abaixo para falar com o lead:_\n${waLink}`;

    const replyMarkup = {
      inline_keyboard: [
        [
          ...(waLink ? [{ text: '📞 Falar no WhatsApp', url: waLink }] : []),
          { text: '🔗 Abrir no CRM', url: kommoLeadUrl }
        ]
      ]
    };

    // Send Telegram Thread #2
    const threadId = process.env.TELEGRAM_THREAD_KO || 2;
    await sendTelegram(process.env.TELEGRAM_CHAT_ID, msg, replyMarkup, threadId);

    // Send WhatsApp Kaká (formato simplificado)
    const kakaPhone = process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763';
    const zapiMsg = formatZapiLeadMessage({
      origem: determineOrigem(utmSource, utmCampaign, utmMedium),
      nome: clientName,
      faturamento: faturamento,
      cargo: cargo,
      dor: gargalo,
      phone: phone
    });
    await sendZapi(kakaPhone, zapiMsg);

    res.status(200).json({ success: true, message: 'Re-dispatched successfully', leadId });
  } catch (err) {
    console.error('[resend-lead] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// MLFP Weekly Report Cron Endpoint (Both Inbound and Leads Antigos)
app.get(['/api/cron/mlfp-weekly-report', '/api/reports/mlfp-weekly'], async (req, res) => {
  try {
    const PIPELINES_CONFIG = {
      INBOUND: {
        id: 13304583,
        name: '[MLFP] Inbound (Oficial)',
        stages: {
          ATENDIDOS: [102598995, 102598999, 108066768, 109108180],
          AGENDADA: [102599003, 109107608],
          REALIZADA: [102599203],
          NOSHOW: [108291644],
          DOWNSELL: [108619300],
          WON: [142],
          LOST: [143]
        }
      },
      ANTIGOS: {
        id: 14008652,
        name: '[MLFP] Leads Antigos (Repescagem)',
        stages: {
          ENTRADA: [108121856],
          ATENDIDOS: [108123248, 108121868],
          RESPONDIDOS: [110155540],
          AGENDADA: [108123252],
          REALIZADA: [108123256, 108123260],
          NOSHOW: [110341428],
          WON: [142],
          LOST: [143]
        }
      }
    };

    // Last 7 days in seconds
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);

    // 1. Fetch leads created in last 7 days for both pipelines
    async function fetchLeads(pipeId) {
      let list = [];
      let page = 1;
      while (true) {
        const data = await kommoRequest('GET', `/api/v4/leads?filter[pipeline_id]=${pipeId}&filter[created_at][from]=${sevenDaysAgo}&limit=250&page=${page}`);
        const leads = data?._embedded?.leads || [];
        if (leads.length === 0) break;
        list = list.concat(leads);
        if (leads.length < 250) break;
        page++;
        await new Promise(r => setTimeout(r, 200));
      }
      return list;
    }

    const [leadsInbound, leadsAntigos] = await Promise.all([
      fetchLeads(PIPELINES_CONFIG.INBOUND.id),
      fetchLeads(PIPELINES_CONFIG.ANTIGOS.id)
    ]);

    // Count MQLs (excluding Auxiliares)
    function countMQL(leadsList) {
      return leadsList.filter(l => {
        const cfs = l.custom_fields_values || [];
        let cargo = '';
        cfs.forEach(f => {
          const fn = (f.field_name || '').toLowerCase();
          if (f.field_id === 128884 || f.field_id === 128474 || fn.includes('cargo') || fn.includes('perfil')) {
            cargo = f.values?.[0]?.value || '';
          }
        });
        const cUpper = String(cargo).toUpperCase();
        const isAux = cUpper.includes('AUXILIAR') || cUpper.includes('AJUDANTE') || cUpper.includes('BUSCO EVOLUÇÃO') || cUpper.includes('BUSCO EVOLUCAO');
        if (isAux) return false;
        const tags = (l._embedded?.tags || []).map(t => t.name.toUpperCase());
        return tags.includes('MQL');
      }).length;
    }

    const mqlInbound = countMQL(leadsInbound);
    const mqlAntigos = countMQL(leadsAntigos);

    // 2. Fetch lead_status_changed events in the last 7 days
    let statusEvents = [];
    let evPage = 1;
    while (true) {
      const data = await kommoRequest('GET', `/api/v4/events?filter[type]=lead_status_changed&filter[created_at][from]=${sevenDaysAgo}&limit=250&page=${evPage}`);
      const events = data?._embedded?.events || [];
      if (events.length === 0) break;
      statusEvents = statusEvents.concat(events);
      if (events.length < 250) break;
      evPage++;
      await new Promise(r => setTimeout(r, 200));
    }

    // Filter events for MLFP pipelines
    const eventsInbound = statusEvents.filter(e => {
      const pId = parseInt(e.value_after?.[0]?.lead_status?.pipeline_id);
      return pId === PIPELINES_CONFIG.INBOUND.id;
    });
    const eventsAntigos = statusEvents.filter(e => {
      const pId = parseInt(e.value_after?.[0]?.lead_status?.pipeline_id);
      return pId === PIPELINES_CONFIG.ANTIGOS.id;
    });

    const movedLeadsInbound = new Set(eventsInbound.map(e => e.entity_id));
    const movedLeadsAntigos = new Set(eventsAntigos.map(e => e.entity_id));

    function analyzeFunnelLifecycle(pipeConfig) {
      const pipeEvents = statusEvents.filter(e => {
        const afterPId = parseInt(e.value_after?.[0]?.lead_status?.pipeline_id);
        const beforePId = parseInt(e.value_before?.[0]?.lead_status?.pipeline_id);
        return afterPId === pipeConfig.id || beforePId === pipeConfig.id;
      });

      const allMarked = new Set();
      const realized = new Set();
      const noShow = new Set();
      const attended = new Set();
      const responded = new Set();
      const downsell = new Set();
      const won = new Set();
      const moved = new Set();

      pipeEvents.forEach(e => {
        const beforeId = e.value_before?.[0]?.lead_status?.id ? parseInt(e.value_before[0].lead_status.id) : null;
        const afterId = e.value_after?.[0]?.lead_status?.id ? parseInt(e.value_after[0].lead_status.id) : null;
        const lId = e.entity_id;
        moved.add(lId);

        // Se entrou em Agendada ou saiu de Agendada para Realizada/NoShow, foi reunião marcada!
        const isBooked = pipeConfig.stages.AGENDADA?.includes(afterId) || pipeConfig.stages.AGENDADA?.includes(beforeId);
        const isRealized = pipeConfig.stages.REALIZADA?.includes(afterId);
        const isNoShow = pipeConfig.stages.NOSHOW?.includes(afterId);

        if (isBooked || isRealized || isNoShow) {
          allMarked.add(lId);
        }
        if (isRealized) realized.add(lId);
        if (isNoShow) noShow.add(lId);

        if (pipeConfig.stages.ATENDIDOS?.includes(afterId)) attended.add(lId);
        if (pipeConfig.stages.RESPONDIDOS?.includes(afterId)) responded.add(lId);
        if (pipeConfig.stages.DOWNSELL?.includes(afterId)) downsell.add(lId);
        if (pipeConfig.stages.WON?.includes(afterId)) won.add(lId);
      });

      const totalDesfechos = realized.size + noShow.size;
      const txShowUp = totalDesfechos > 0 ? ((realized.size / totalDesfechos) * 100).toFixed(1) : '0.0';
      const txNoShow = totalDesfechos > 0 ? ((noShow.size / totalDesfechos) * 100).toFixed(1) : '0.0';

      return {
        transicoes: pipeEvents.length,
        movimentados: moved.size,
        atendidos: attended.size,
        respondidos: responded.size,
        downsell: downsell.size,
        vendas: won.size,
        marcadas: allMarked.size,
        realizadas: realized.size,
        noshow: noShow.size,
        txShowUp,
        txNoShow
      };
    }

    const metricsInbound = analyzeFunnelLifecycle(PIPELINES_CONFIG.INBOUND);
    const metricsAntigos = analyzeFunnelLifecycle(PIPELINES_CONFIG.ANTIGOS);

    // 3. Fetch chat messages (sent and received) in the last 7 days
    async function fetchChatEvents(type) {
      let list = [];
      let page = 1;
      while (true) {
        const data = await kommoRequest('GET', `/api/v4/events?filter[type]=${type}&filter[created_at][from]=${sevenDaysAgo}&limit=250&page=${page}`);
        const events = data?._embedded?.events || [];
        if (events.length === 0) break;
        list = list.concat(events);
        if (events.length < 250) break;
        page++;
        await new Promise(r => setTimeout(r, 200));
      }
      return list;
    }

    const [outgoingMsgs, incomingMsgs] = await Promise.all([
      fetchChatEvents('outgoing_chat_message'),
      fetchChatEvents('incoming_chat_message')
    ]);

    // Build leadId -> pipelineId map from cache
    const allLeadsData = await lerCache('all_leads.json', []);
    const leadPipeMap = {};
    (allLeadsData || []).forEach(l => {
      leadPipeMap[l.id] = l.pipeline_id;
    });

    let msgsOutInbound = 0, msgsOutAntigos = 0;
    let msgsInInbound = 0, msgsInAntigos = 0;

    outgoingMsgs.forEach(e => {
      const pId = leadPipeMap[e.entity_id];
      if (pId === PIPELINES_CONFIG.INBOUND.id) msgsOutInbound++;
      else if (pId === PIPELINES_CONFIG.ANTIGOS.id) msgsOutAntigos++;
    });

    incomingMsgs.forEach(e => {
      const pId = leadPipeMap[e.entity_id];
      if (pId === PIPELINES_CONFIG.INBOUND.id) msgsInInbound++;
      else if (pId === PIPELINES_CONFIG.ANTIGOS.id) msgsInAntigos++;
    });

    // Formatting date window
    const dFrom = new Date(sevenDaysAgo * 1000).toLocaleDateString('pt-BR');
    const dTo = new Date().toLocaleDateString('pt-BR');

    // Rates
    const txLeadMql = leadsInbound.length > 0 ? ((mqlInbound / leadsInbound.length) * 100).toFixed(1) : '0.0';
    const txRespAntigos = msgsOutAntigos > 0 ? ((msgsInAntigos / msgsOutAntigos) * 100).toFixed(1) : '0.0';

    // Total consolidated
    const totNovos = leadsInbound.length + leadsAntigos.length;
    const totAtendidos = metricsInbound.atendidos + metricsAntigos.atendidos;
    const totMovimentados = metricsInbound.movimentados + metricsAntigos.movimentados;
    const totTransicoes = metricsInbound.transicoes + metricsAntigos.transicoes;
    const totMarcadas = metricsInbound.marcadas + metricsAntigos.marcadas;
    const totRealizadas = metricsInbound.realizadas + metricsAntigos.realizadas;
    const totNoShow = metricsInbound.noshow + metricsAntigos.noshow;
    const totVendas = metricsInbound.vendas + metricsAntigos.vendas;
    const totMsgsOut = msgsOutInbound + msgsOutAntigos;
    const totMsgsIn = msgsInInbound + msgsInAntigos;
    const totDesfechos = totRealizadas + totNoShow;
    const txShowUpGeral = totDesfechos > 0 ? ((totRealizadas / totDesfechos) * 100).toFixed(1) : '0.0';
    const txNoShowGeral = totDesfechos > 0 ? ((totNoShow / totDesfechos) * 100).toFixed(1) : '0.0';

    let message = `📊 *RELATÓRIO SEMANAL COMERCIAL — MLFP* 📊\n`;
    message += `🗓️ _Período: Últimos 7 dias (${dFrom} a ${dTo})_\n\n`;

    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🔵 *1. FUNIL [MLFP] INBOUND (Oficial)*\n`;
    message += `📥 *Novos Leads na Base:* ${leadsInbound.length}\n`;
    message += `🔥 *Qualificados (MQL):* ${mqlInbound} _(${txLeadMql}% da entrada)_\n`;
    message += `💬 *Leads Atendidos (1º Contato):* ${metricsInbound.atendidos}\n`;
    message += `🔄 *Leads Movimentados:* ${metricsInbound.movimentados} _(${metricsInbound.transicoes} transições)_\n`;
    message += `📅 *Reuniões Marcadas (em esteira):* ${metricsInbound.marcadas}\n`;
    message += `🤝 *Reuniões Realizadas (Show-Up):* ${metricsInbound.realizadas} _(${metricsInbound.txShowUp}% de presença)_\n`;
    message += `👻 *No Show (Faltaram):* ${metricsInbound.noshow} _(${metricsInbound.txNoShow}% de ausência)_\n`;
    message += `🏆 *Vendas Ganhas:* ${metricsInbound.vendas}\n`;
    message += `📉 *Downsell (Desqualificados / Auxiliares):* ${metricsInbound.downsell}\n`;
    message += `✉️ *Mensagens Enviadas (SDR):* ${msgsOutInbound}\n`;
    message += `📥 *Mensagens Recebidas (Lead):* ${msgsInInbound}\n\n`;

    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `⏳ *2. FUNIL [MLFP] LEADS ANTIGOS (Repescagem)*\n`;
    message += `📥 *Novos Leads Inseridos:* ${leadsAntigos.length}\n`;
    message += `💬 *Leads Atendidos no Período:* ${metricsAntigos.atendidos}\n`;
    message += `💬 *Leads Respondidos:* ${metricsAntigos.respondidos}\n`;
    message += `🔄 *Leads Movimentados:* ${metricsAntigos.movimentados} _(${metricsAntigos.transicoes} transições)_\n`;
    message += `📅 *Reuniões Marcadas na Semana:* ${metricsAntigos.marcadas}\n`;
    message += `🤝 *Reuniões Realizadas:* ${metricsAntigos.realizadas}\n`;
    message += `👻 *No Show:* ${metricsAntigos.noshow} _(reagendada)_\n`;
    message += `🏆 *Vendas Ganhas:* ${metricsAntigos.vendas}\n`;
    message += `✉️ *Mensagens Enviadas (SDR):* ${msgsOutAntigos}\n`;
    message += `📥 *Mensagens Recebidas (Lead):* ${msgsInAntigos}\n`;
    message += `⚡ *Taxa de Resposta:* ${txRespAntigos}% dos disparos\n\n`;

    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `🎯 *3. CONSOLIDADO GERAL MLFP*\n`;
    message += `📥 *Total Novos Leads:* ${totNovos}\n`;
    message += `💬 *Total Leads Atendidos:* ${totAtendidos}\n`;
    message += `🔄 *Total Leads Movimentados:* ${totMovimentados} _(${totTransicoes} transições)_\n`;
    message += `📅 *Total Reuniões Marcadas:* ${totMarcadas}\n`;
    message += `🤝 *Total Reuniões Realizadas:* ${totRealizadas} _(${txShowUpGeral}% show-up)_\n`;
    message += `👻 *Total No Show:* ${totNoShow} _(${txNoShowGeral}% no-show)_\n`;
    message += `🏆 *Total Vendas Fechadas:* ${totVendas}\n`;
    message += `✉️ *Total Mensagens Enviadas:* ${totMsgsOut}\n`;
    message += `📥 *Total Mensagens Recebidas/Respondidas:* ${totMsgsIn}\n\n`;
    message += `_Relatório gerado automaticamente analisando os eventos comerciais da semana._`;

    // Send weekly report to Telegram (both to group thread and direct admin chat)
    const threadId = process.env.TELEGRAM_THREAD_MLFP || 4;
    const groupChatId = process.env.TELEGRAM_CHAT_ID || DEFAULT_TELEGRAM_CHAT_ID;
    const adminChatId = process.env.TELEGRAM_CHAT_ID_ERROR;

    if (groupChatId) {
      await sendTelegram(groupChatId, message, undefined, threadId);
    }
    if (adminChatId && adminChatId !== groupChatId) {
      await sendTelegram(adminChatId, message);
    }

    res.json({
      success: true,
      period: { from: dFrom, to: dTo },
      consolidated: {
        novosLeads: totNovos,
        atendidos: totAtendidos,
        movimentados: totMovimentados,
        transicoes: totTransicoes,
        reunioesMarcadas: totMarcadas,
        reunioesRealizadas: totRealizadas,
        noshow: totNoShow,
        taxaShowUp: txShowUpGeral + '%',
        taxaNoShow: txNoShowGeral + '%',
        vendas: totVendas,
        mensagensEnviadas: totMsgsOut,
        mensagensRecebidas: totMsgsIn
      },
      inbound: {
        novos: leadsInbound.length,
        mql: mqlInbound,
        atendidos: metricsInbound.atendidos,
        movimentados: metricsInbound.movimentados,
        transicoes: metricsInbound.transicoes,
        reunioesMarcadas: metricsInbound.marcadas,
        reunioesRealizadas: metricsInbound.realizadas,
        noshow: metricsInbound.noshow,
        taxaShowUp: metricsInbound.txShowUp + '%',
        taxaNoShow: metricsInbound.txNoShow + '%',
        vendas: metricsInbound.vendas,
        msgsOut: msgsOutInbound,
        msgsIn: msgsInInbound
      },
      antigos: {
        novos: leadsAntigos.length,
        atendidos: metricsAntigos.atendidos,
        respondidos: metricsAntigos.respondidos,
        movimentados: metricsAntigos.movimentados,
        transicoes: metricsAntigos.transicoes,
        reunioesMarcadas: metricsAntigos.marcadas,
        reunioesRealizadas: metricsAntigos.realizadas,
        noshow: metricsAntigos.noshow,
        vendas: metricsAntigos.vendas,
        msgsOut: msgsOutAntigos,
        msgsIn: msgsInAntigos
      }
    });
  } catch (err) {
    console.error('[Cron] Error generating MLFP weekly report:', err);
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

// ==========================================
// DASHBOARD AI ASSISTANT ENGINE & FUNCTIONS
// ==========================================

// Helper to get all cached leads and sales safely
async function getLoadedCRMData() {
  const allLeads = await lerCache('all_leads.json', []);
  const rawSales = await lerCache('eduzz_sales_raw.json', []);
  return { allLeads, rawSales };
}

// Analytics Tool: Aggregate Metrics by Funnel and Timeframe
async function getExecutiveMetrics(funnel = 'all', timeframe = 'this_month') {
  const { allLeads, rawSales } = await getLoadedCRMData();
  const now = new Date();
  let startSec = 0;
  let endSec = Math.floor(now.getTime() / 1000);

  if (timeframe === 'today') {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    startSec = Math.floor(today.getTime() / 1000);
  } else if (timeframe === '7d' || timeframe === '7') {
    startSec = endSec - (7 * 24 * 60 * 60);
  } else if (timeframe === '30d' || timeframe === '30') {
    startSec = endSec - (30 * 24 * 60 * 60);
  } else if (timeframe === 'this_month') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    startSec = Math.floor(firstDay.getTime() / 1000);
  } else if (timeframe === 'last_month') {
    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    startSec = Math.floor(firstDayLastMonth.getTime() / 1000);
    endSec = Math.floor(lastDayLastMonth.getTime() / 1000);
  }

  // Pipelines definition
  const PIPELINES_MAP = {
    mlfp: [13304583],
    komando: [13304659],
    kop: [14173256],
    kor: [14268556, 13956952],
    ebook: [13537971],
    all: [13304583, 13304659, 13537971, 14173256, 14268556, 13956952, 13956856]
  };

  const fKey = (funnel || 'all').toLowerCase();
  const allowedPipelines = PIPELINES_MAP[fKey] || PIPELINES_MAP.all;

  // Filter leads in range
  const periodLeads = allLeads.filter(l => {
    if (l.created_at < startSec || l.created_at > endSec) return false;
    const tags = (l._embedded?.tags || []).map(t => t.name.toUpperCase());
    const name = (l.name || '').toUpperCase();
    if (fKey === 'kor') {
      return l.pipeline_id === 14268556 || l.pipeline_id === 13956952 || (l.pipeline_id === 13956856 && (tags.includes('KOR') || tags.some(t => t.includes('RESTAURANTE')) || name.includes('KOR')));
    }
    if (fKey === 'kop') {
      return l.pipeline_id === 14173256 || (l.pipeline_id === 13956856 && (tags.includes('KOP') || tags.some(t => t.includes('PRAÇA') || t.includes('PRACA')) || name.includes('KOP')));
    }
    return allowedPipelines.includes(l.pipeline_id);
  });

  const totalLeads = periodLeads.length;
  let totalMql = 0;
  let wonLeads = 0;
  let crmRevenue = 0;

  periodLeads.forEach(l => {
    const tags = (l._embedded?.tags || []).map(t => t.name.toUpperCase());
    if (tags.includes('MQL')) totalMql++;
    if (l.status_id === 142) {
      wonLeads++;
      crmRevenue += parseFloat(l.price) || 0;
    }
  });

  // Filter Eduzz sales in range
  const paidSales = rawSales.filter(s => {
    const isPaid = s.sale_status === 3 || s.sale_status_name === 'Paga' || s.status === 'paid';
    if (!isPaid) return false;
    const rawDate = s.date_payment || s.date_create;
    if (!rawDate) return false;
    const sSecs = Math.floor(new Date(String(rawDate).replace(' ', 'T')).getTime() / 1000);
    if (sSecs < startSec || sSecs > endSec) return false;

    const title = (s.content_title || s.product_name || '').toUpperCase();
    if (fKey === 'mlfp' && !(title.includes('MENTORIA') || title.includes('MLFP') || title.includes('FAIXA PRETA'))) return false;
    if (fKey === 'komando' && !(title.includes('KOMANDO') && !title.includes('KOP') && !title.includes('KOR'))) return false;
    if (fKey === 'kop' && !(title.includes('KOP') || title.includes('PRAÇA') || title.includes('PRACA'))) return false;
    if (fKey === 'kor' && !(title.includes('KOR') || title.includes('RESTAURANTE') || title.includes('RECUPERAÇÃO'))) return false;
    if (fKey === 'ebook' && !(title.includes('EBOOK') || title.includes('LIVRO'))) return false;
    return true;
  });

  const eduzzTotalRevenue = paidSales.reduce((acc, s) => acc + (parseFloat(s.sale_total) || parseFloat(s.value) || 0), 0);
  const totalSalesCount = paidSales.length + wonLeads;
  const totalRevenue = eduzzTotalRevenue + crmRevenue;
  const ticketMedio = totalSalesCount > 0 ? (totalRevenue / totalSalesCount) : 0;
  const mqlRate = totalLeads > 0 ? ((totalMql / totalLeads) * 100).toFixed(1) : '0.0';

  return {
    timeframe,
    funnel: fKey,
    total_leads: totalLeads,
    total_mql: totalMql,
    mql_rate_pct: parseFloat(mqlRate),
    eduzz_paid_sales_count: paidSales.length,
    crm_won_sales_count: wonLeads,
    total_sales_count: totalSalesCount,
    total_revenue_brl: Math.round(totalRevenue * 100) / 100,
    ticket_medio_brl: Math.round(ticketMedio * 100) / 100
  };
}

// Search Leads in Cache & CRM (with keyword parsing and live Kommo API fallback)
async function searchLeadsDeep(query, limit = 15) {
  const { allLeads } = await getLoadedCRMData();
  const rawQ = (query || '').toLowerCase().trim();
  
  const stopWords = ['quem', 'qual', 'quais', 'como', 'lead', 'leads', 'mql', 'mqls', 'para', 'com', 'por', 'onde', 'sobre', 'esse', 'essa', 'está', 'esta', 'estao', 'estão', 'buscar', 'procure', 'encontre', 'ver', 'mostrar', 'informações', 'informacoes', 'dados', 'status'];
  const cleanKeywords = rawQ
    .replace(/[^\w\s\u00C0-\u00FF]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.includes(w));

  let matches = [];
  if (cleanKeywords.length > 0) {
    matches = allLeads.filter(l => {
      const name = (l.name || '').toLowerCase();
      const tags = (l._embedded?.tags || []).map(t => t.name.toLowerCase()).join(' ');
      const fields = (l.custom_fields_values || []).map(f => (f.values || []).map(v => String(v.value).toLowerCase()).join(' ')).join(' ');
      const text = `${name} ${tags} ${fields}`;
      return cleanKeywords.some(kw => text.includes(kw));
    });
  }

  // If no match in cache, query live Kommo CRM API with the top keyword
  if (matches.length === 0 && cleanKeywords.length > 0) {
    for (const kw of cleanKeywords.slice(0, 2)) {
      try {
        const liveData = await kommoRequest('GET', `/api/v4/leads?query=${encodeURIComponent(kw)}&with=contacts&limit=${limit}`);
        const liveLeads = liveData?._embedded?.leads || [];
        if (liveLeads.length > 0) {
          matches = matches.concat(liveLeads);
          break;
        }
      } catch (crmErr) {
        console.warn('[searchLeadsDeep] Live CRM query error:', crmErr.message);
      }
    }
  }

  // Deduplicate by ID
  const seenIds = new Set();
  const uniqueMatches = [];
  matches.forEach(m => {
    if (m.id && !seenIds.has(m.id)) {
      seenIds.add(m.id);
      uniqueMatches.push(m);
    }
  });

  // Sort by newest
  uniqueMatches.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const results = uniqueMatches.slice(0, limit).map(l => {
    const tags = (l._embedded?.tags || []).map(t => t.name);
    const cfs = {};
    (l.custom_fields_values || []).forEach(f => {
      const val = f.values?.[0]?.value;
      if (val) cfs[f.field_name || f.field_code || f.field_id] = val;
    });

    return {
      id: l.id,
      name: l.name,
      created_at: new Date(l.created_at * 1000).toLocaleString('pt-BR'),
      price: l.price || 0,
      tags: tags,
      is_mql: tags.includes('MQL'),
      custom_fields: cfs,
      crm_url: `https://${process.env.KOMMO_DOMAIN || 'chefkakagomes.kommo.com'}/leads/detail/${l.id}`
    };
  });

  return { total_matches: uniqueMatches.length, returned: results.length, leads: results };
}

// Pain Points & Gargalos Analysis
async function getPainPointsAndProfileAnalysis() {
  const { allLeads } = await getLoadedCRMData();
  const gargalosCount = {};
  const faturamentosCount = {};
  const cargosCount = {};
  let totalWithForm = 0;

  allLeads.forEach(l => {
    let hasData = false;
    (l.custom_fields_values || []).forEach(f => {
      const name = (f.field_name || f.field_code || '').toLowerCase();
      const val = f.values?.[0]?.value;
      if (!val) return;

      if (name.includes('gargalo') || f.field_id === 492037) {
        gargalosCount[val] = (gargalosCount[val] || 0) + 1;
        hasData = true;
      } else if (name.includes('faturamento') || f.field_id === 128886) {
        faturamentosCount[val] = (faturamentosCount[val] || 0) + 1;
        hasData = true;
      } else if (name.includes('cargo') || f.field_id === 128884) {
        cargosCount[val] = (cargosCount[val] || 0) + 1;
        hasData = true;
      }
    });
    if (hasData) totalWithForm++;
  });

  const sortDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({
    name,
    count,
    pct: totalWithForm > 0 ? ((count / totalWithForm) * 100).toFixed(1) + '%' : '0%'
  }));

  return {
    total_leads_with_form_data: totalWithForm,
    principais_gargalos: sortDesc(gargalosCount).slice(0, 8),
    faixas_de_faturamento: sortDesc(faturamentosCount).slice(0, 8),
    principais_cargos: sortDesc(cargosCount).slice(0, 8)
  };
}

// Meta Ads Live Insights Helper
async function getMetaAdsDataSummary(since, until) {
  const token = (process.env.META_ACCESS_TOKEN && process.env.META_ACCESS_TOKEN.trim()) || DEFAULT_META_ACCESS_TOKEN;
  const today = new Date().toISOString().slice(0, 10);
  const sDate = since || today.slice(0, 7) + '-01';
  const uDate = until || today;

  try {
    const timeRange = JSON.stringify({ since: sDate, until: uDate });
    const url = `https://graph.facebook.com/v20.0/act_322391662838622/insights?time_range=${encodeURIComponent(timeRange)}&fields=campaign_name,spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type&level=campaign&limit=50&access_token=${token}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const campaigns = [];
    let totalSpend = 0, totalClicks = 0, totalImpressions = 0, totalLeads = 0, totalPurchases = 0;

    if (data.data) {
      for (const c of data.data) {
        const spend = parseFloat(c.spend || 0);
        if (spend > 0) {
          const acts = c.actions || [];
          const lAct = acts.find(a => a.action_type === 'lead' || a.action_type === 'onsite_web_lead');
          const pAct = acts.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
          const leads = lAct ? parseInt(lAct.value || 0) : 0;
          const purchases = pAct ? parseInt(pAct.value || 0) : 0;

          totalSpend += spend;
          totalClicks += parseInt(c.clicks || 0);
          totalImpressions += parseInt(c.impressions || 0);
          totalLeads += leads;
          totalPurchases += purchases;

          campaigns.push({
            name: c.campaign_name,
            spend: Math.round(spend * 100) / 100,
            impressions: parseInt(c.impressions || 0),
            clicks: parseInt(c.clicks || 0),
            ctr: parseFloat(c.ctr || 0).toFixed(2) + '%',
            cpc: 'R$ ' + parseFloat(c.cpc || 0).toFixed(2),
            pixel_leads: leads,
            pixel_purchases: purchases
          });
        }
      }
    }

    return {
      period: { since: sDate, until: uDate },
      totals: {
        total_spend_brl: Math.round(totalSpend * 100) / 100,
        total_impressions: totalImpressions,
        total_clicks: totalClicks,
        total_pixel_leads: totalLeads,
        total_pixel_purchases: totalPurchases,
        avg_ctr: totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) + '%' : '0%',
        avg_cpc: totalClicks > 0 ? 'R$ ' + (totalSpend / totalClicks).toFixed(2) : 'R$ 0.00'
      },
      top_campaigns: campaigns.sort((a, b) => b.spend - a.spend).slice(0, 10)
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Autonomous / Smart Fallback Dispatcher for Dashboard AI
async function executeSmartAnalyticsResponse(userMessage) {
  const msg = userMessage.toLowerCase();
  
  // 1. Resumo do Mês / Geral / Hoje
  if (msg.includes('resumo') || msg.includes('mês') || msg.includes('mes') || msg.includes('hoje') || msg.includes('geral') || msg.includes('semana') || msg.includes('performance')) {
    const timeframe = msg.includes('hoje') ? 'today' : (msg.includes('semana') || msg.includes('7d') ? '7d' : 'this_month');
    const tfLabel = timeframe === 'today' ? 'Hoje' : (timeframe === '7d' ? 'Últimos 7 Dias' : 'Mês Atual');

    const [allMetrics, koMetrics, mlfpMetrics, kopMetrics, korMetrics, metaData] = await Promise.all([
      getExecutiveMetrics('all', timeframe),
      getExecutiveMetrics('komando', timeframe),
      getExecutiveMetrics('mlfp', timeframe),
      getExecutiveMetrics('kop', timeframe),
      getExecutiveMetrics('kor', timeframe),
      getMetaAdsDataSummary()
    ]);

    return `### 📊 Resumo Executivo de Performance (${tfLabel})

Aqui está o panorama consolidado de **Leads, Qualificação (MQL), Tráfego e Vendas**:

---

#### 🌟 Indicadores Gerais Consolidados:
* 📥 **Total de Leads Entrantes:** \`${allMetrics.total_leads}\` leads
* 🔥 **Leads Qualificados (MQL):** \`${allMetrics.total_mql}\` leads (**${allMetrics.mql_rate_pct}%** de qualificação)
* 💳 **Vendas Confirmadas (Eduzz + CRM):** \`${allMetrics.total_sales_count}\` vendas
* 💰 **Faturamento Total:** \`R$ ${allMetrics.total_revenue_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\`
* 🎯 **Ticket Médio:** \`R$ ${allMetrics.ticket_medio_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\`
* 📢 **Investimento Meta Ads:** \`R$ ${metaData.totals?.total_spend_brl ? metaData.totals.total_spend_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '0,00'}\`

---

#### 📂 Desempenho por Funil / Produto:
| Funil / Produto | Leads | MQLs | Taxa MQL | Vendas | Faturamento |
| :--- | :---: | :---: | :---: | :---: | :--- |
| 🔴 **Komando (KO Inbound)** | ${koMetrics.total_leads} | ${koMetrics.total_mql} | ${koMetrics.mql_rate_pct}% | ${koMetrics.total_sales_count} | R$ ${koMetrics.total_revenue_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} |
| 🔵 **Mentoria [MLFP]** | ${mlfpMetrics.total_leads} | ${mlfpMetrics.total_mql} | ${mlfpMetrics.mql_rate_pct}% | ${mlfpMetrics.total_sales_count} | R$ ${mlfpMetrics.total_revenue_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} |
| 📦 **KOP (Praça)** | ${kopMetrics.total_leads} | ${kopMetrics.total_mql} | ${kopMetrics.mql_rate_pct}% | ${kopMetrics.total_sales_count} | R$ ${kopMetrics.total_revenue_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} |
| 🔄 **KOR (Restaurantes)** | ${korMetrics.total_leads} | ${korMetrics.total_mql} | ${korMetrics.mql_rate_pct}% | ${korMetrics.total_sales_count} | R$ ${korMetrics.total_revenue_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} |

💡 *Dica: Você pode me pedir detalhes específicos de qualquer lead, campanha ou faturamento digitando o nome ou o tema desejado!*`;
  }

  // 2. Gargalos e Dores dos Leads
  if (msg.includes('gargalo') || msg.includes('dor') || msg.includes('desafio') || msg.includes('problema') || msg.includes('reclam')) {
    const analysis = await getPainPointsAndProfileAnalysis();
    let gargalosList = analysis.principais_gargalos.map((g, i) => `${i + 1}. **${g.name}** — \`${g.count} leads\` (${g.pct})`).join('\n');
    let fatList = analysis.faixas_de_faturamento.map((f, i) => `* **${f.name}**: \`${f.count} leads\` (${f.pct})`).join('\n');

    return `### 🚧 Análise de Gargalos & Perfil dos Leads

Com base em **${analysis.total_leads_with_form_data} respostas de formulário** cadastradas:

#### ⚠️ Principais Gargalos Operacionais Citados:
${gargalosList || 'Nenhum gargalo registrado ainda.'}

---

#### 💰 Distribuição de Faturamento dos Estabelecimentos:
${fatList || 'Nenhum faturamento registrado ainda.'}

📌 **Insight Comercial:** A maior parte dos donos de restaurante que chegam no funil estão sofrendo com dependência operacional e falta de processos padronizados.`;
  }

  // 3. Meta Ads e Tráfego Pago
  if (msg.includes('meta') || msg.includes('ads') || msg.includes('trafego') || msg.includes('tráfego') || msg.includes('campanha') || msg.includes('cpl') || msg.includes('cpc') || msg.includes('roas') || msg.includes('investimento')) {
    const metaData = await getMetaAdsDataSummary();
    if (metaData.error) return `⚠️ Erro ao consultar Meta Ads: ${metaData.error}`;

    let campRows = (metaData.top_campaigns || []).map(c => `| ${c.name.substring(0, 38)}... | R$ ${c.spend.toLocaleString('pt-BR')} | ${c.clicks} | ${c.ctr} | ${c.cpc} | ${c.pixel_leads} | ${c.pixel_purchases} |`).join('\n');

    return `### 🎯 Desempenho de Tráfego Pago — Meta Ads

* 💸 **Investimento Total:** \`R$ ${metaData.totals.total_spend_brl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\`
* 👁️ **Impressões:** \`${metaData.totals.total_impressions.toLocaleString('pt-BR')}\`
* 🖱️ **Cliques no Link:** \`${metaData.totals.total_clicks.toLocaleString('pt-BR')}\`
* 📊 **CTR Médio:** \`${metaData.totals.avg_ctr}\` | **CPC Médio:** \`${metaData.totals.avg_cpc}\`
* 📥 **Leads (Pixel Meta):** \`${metaData.totals.total_pixel_leads}\` | 💳 **Compras (Pixel Meta):** \`${metaData.totals.total_pixel_purchases}\`

---

#### 🏆 Principais Campanhas Ativas:
| Campanha | Investido | Cliques | CTR | CPC | Leads | Compras |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
${campRows || '| Nenhuma campanha com gasto encontrada | - | - | - | - | - | - |'}`;
  }

  // 4. Vendas Eduzz
  if (msg.includes('eduzz') || msg.includes('venda') || msg.includes('faturamento') || msg.includes('compra') || msg.includes('receita')) {
    const { rawSales } = await getLoadedCRMData();
    const paidSales = rawSales.filter(s => s.sale_status === 3 || s.sale_status_name === 'Paga' || s.status === 'paid');
    const totalRev = paidSales.reduce((a, s) => a + (parseFloat(s.sale_total) || parseFloat(s.value) || 0), 0);
    
    // Top products
    const prodMap = {};
    paidSales.forEach(s => {
      const name = s.content_title || s.product_name || 'Outro Produto';
      const val = parseFloat(s.sale_total) || parseFloat(s.value) || 0;
      if (!prodMap[name]) prodMap[name] = { count: 0, revenue: 0 };
      prodMap[name].count++;
      prodMap[name].revenue += val;
    });

    let prodRows = Object.entries(prodMap).sort((a, b) => b[1].revenue - a[1].revenue).map(([name, data]) => {
      return `| **${name}** | \`${data.count}\` | R$ ${data.revenue.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} |`;
    }).join('\n');

    return `### 💳 Relatório de Vendas & Faturamento (Eduzz)

* 💰 **Faturamento Total Pago:** \`R$ ${totalRev.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\`
* 📦 **Total de Vendas Confirmadas:** \`${paidSales.length}\` vendas
* 🎯 **Ticket Médio:** \`R$ ${(paidSales.length > 0 ? (totalRev / paidSales.length) : 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\`

---

#### 🛍️ Vendas por Produto:
| Produto | Vendas | Faturamento |
| :--- | :---: | :--- |
${prodRows || '| Nenhum produto com vendas pagas | 0 | R$ 0,00 |'}`;
  }

  // 5. Busca de Lead Específico ou MQLs
  const searchRes = await searchLeadsDeep(userMessage, 8);
  if (searchRes.leads.length > 0) {
    let leadCards = searchRes.leads.map(l => {
      const cfs = l.custom_fields;
      let details = [];
      if (cfs['Qual é o seu cargo?'] || cfs['Cargo']) details.push(`💼 *Cargo:* ${cfs['Qual é o seu cargo?'] || cfs['Cargo']}`);
      if (cfs['Seu faturamento médio'] || cfs['Faturamento']) details.push(`💰 *Faturamento:* ${cfs['Seu faturamento médio'] || cfs['Faturamento']}`);
      if (cfs['Maior gargalo'] || cfs['Gargalo']) details.push(`⚠️ *Gargalo:* ${cfs['Maior gargalo'] || cfs['Gargalo']}`);
      if (cfs['Tamanho da equipe']) details.push(`👥 *Equipe:* ${cfs['Tamanho da equipe']}`);
      if (cfs['Possui sócios?']) details.push(`👥 *Sócios:* ${cfs['Possui sócios?']}`);
      if (cfs['Seu instagram?']) details.push(`📸 *Instagram:* ${cfs['Seu instagram?']}`);
      
      const tagStr = l.tags.map(t => `\`${t}\``).join(' ');
      const mqlBadge = l.is_mql ? '🔥 **[MQL QUALIFICADO]**' : '📥 **[LEAD]**';

      return `#### ${mqlBadge} [${l.name}](${l.crm_url})
* 📅 **Data:** ${l.created_at} | 🏷️ **Tags:** ${tagStr}
${details.length > 0 ? details.map(d => '* ' + d).join('\n') : '* *Sem campos adicionais preenchidos*'}
🔗 [Abrir Lead no Kommo CRM](${l.crm_url})`;
    }).join('\n\n---\n\n');

    return `### 🔍 Encontrei ${searchRes.total_matches} lead(s) correspondente(s):

${leadCards}`;
  }

  // 6. Resposta Padrão de Boas-vindas e Ajuda
  return `Olá! Sou o **Assistente IA da Komando**. Posso te ajudar a encontrar dados instantâneos sobre:

* 📊 **Métricas & Resumo do Mês:** *"Qual o resumo de leads e faturamento deste mês?"*
* 🔥 **Leads MQL & CRM:** *"Quem são os últimos MQLs com faturamento acima de 100k?"*
* 🎯 **Tráfego & Anúncios:** *"Qual o CPL e gasto do Meta Ads na semana?"*
* 💳 **Vendas Eduzz:** *"Quantas vendas tivemos de KOP e KOR?"*
* 🚧 **Dores dos Clientes:** *"Quais os principais gargalos citados pelos leads?"*

Como posso te ajudar agora?`;
}

// Master Dashboard AI Assistant Handler
async function processDashboardAIAssistant(userMessage, history = [], context = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

      const systemInstruction = {
        parts: [{
          text: `Você é o Assistente Executivo de Inteligência Artificial da Komando e Chef Kaká Gomes.
Você tem acesso completo aos dados em tempo real do Kommo CRM, Vendas da Eduzz, Campanhas de Meta Ads e Respostas de Formulários.
Responda em português com clareza, objetividade e riqueza de detalhes. Use Markdown (tabelas, listas, negrito, links clicáveis).
Contexto Atual do Dashboard: ${JSON.stringify(context || {})}.
Sempre que o usuário perguntar sobre leads, vendas, campanhas, gargalos ou métricas, use as funções disponíveis para consultar os dados exatos antes de responder.`
        }]
      };

      const tools = [{
        functionDeclarations: [
          {
            name: "getExecutiveMetrics",
            description: "Obtém métricas consolidadas de leads, MQLs, vendas e faturamento.",
            parameters: {
              type: "OBJECT",
              properties: {
                funnel: { type: "STRING", description: "Nome do funil: 'all', 'komando', 'mlfp', 'kop', 'kor', 'ebook'" },
                timeframe: { type: "STRING", description: "Período: 'today', '7d', '30d', 'this_month', 'last_month'" }
              }
            }
          },
          {
            name: "searchLeadsDeep",
            description: "Busca leads no CRM e banco de dados por nome, telefone, email, tag, cargo ou faturamento.",
            parameters: {
              type: "OBJECT",
              properties: {
                query: { type: "STRING", description: "Termo de busca" },
                limit: { type: "INTEGER", description: "Limite de resultados (padrão: 10)" }
              },
              required: ["query"]
            }
          },
          {
            name: "getPainPointsAndProfileAnalysis",
            description: "Analisa e ranqueia as principais dores, gargalos operacionais e faixas de faturamento citadas pelos donos de restaurante no formulário.",
            parameters: { type: "OBJECT", properties: {} }
          },
          {
            name: "getMetaAdsDataSummary",
            description: "Obtém métricas de investimento, cliques, CTR, CPC e conversões de Meta Ads.",
            parameters: {
              type: "OBJECT",
              properties: {
                since: { type: "STRING", description: "Data inicial YYYY-MM-DD" },
                until: { type: "STRING", description: "Data final YYYY-MM-DD" }
              }
            }
          }
        ]
      }];

      let contents = [];
      if (history && Array.isArray(history)) {
        history.slice(-6).forEach(h => {
          if (h.role && h.content) {
            contents.push({
              role: h.role === 'user' ? 'user' : 'model',
              parts: [{ text: h.content }]
            });
          }
        });
      }
      contents.push({ role: 'user', parts: [{ text: userMessage }] });

      let iterations = 5;
      while (iterations > 0) {
        iterations--;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, systemInstruction, tools })
        });

        if (!res.ok) break; // Fallback to deterministic engine
        const data = await res.json();
        const candidate = data.candidates?.[0];
        const msg = candidate?.content;
        if (!msg) break;

        contents.push(msg);
        const functionCalls = (msg.parts || []).filter(p => p.functionCall);
        if (functionCalls.length === 0) {
          return (msg.parts || []).map(p => p.text || '').join('\n');
        }

        const functionResponses = [];
        for (const fc of functionCalls) {
          const c = fc.functionCall;
          let result;
          if (c.name === 'getExecutiveMetrics') result = await getExecutiveMetrics(c.args?.funnel, c.args?.timeframe);
          else if (c.name === 'searchLeadsDeep') result = await searchLeadsDeep(c.args?.query, c.args?.limit);
          else if (c.name === 'getPainPointsAndProfileAnalysis') result = await getPainPointsAndProfileAnalysis();
          else if (c.name === 'getMetaAdsDataSummary') result = await getMetaAdsDataSummary(c.args?.since, c.args?.until);
          else result = { error: 'Função não encontrada' };

          functionResponses.push({
            functionResponse: { name: c.name, response: { output: result } }
          });
        }
        contents.push({ role: 'function', parts: functionResponses });
      }
    } catch (llmErr) {
      console.warn('[Gemini LLM Fallback]:', llmErr.message);
    }
  }

  // High-accuracy fallback analytics engine
  return await executeSmartAnalyticsResponse(userMessage);
}

// REST Endpoint for Web Dashboard AI Assistant
app.post(['/api/ai-assistant', '/api/chat'], async (req, res) => {
  try {
    const { message, history, context } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Mensagem não informada' });
    }

    const answer = await processDashboardAIAssistant(message.trim(), history || [], context || {});
    res.json({ success: true, response: answer });
  } catch (err) {
    console.error('[AI Assistant Endpoint Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

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

// In-memory server-side contacts cache
const serverContactsCache = new Map();

// Helper to fetch contact details in bulk from Kommo CRM
async function fetchContactsInBulk(contactIds) {
  const contactsMap = {};
  if (!contactIds || contactIds.length === 0) return contactsMap;

  const missingIds = [];
  contactIds.forEach(id => {
    const numId = parseInt(id);
    if (numId && serverContactsCache.has(numId)) {
      contactsMap[numId] = serverContactsCache.get(numId);
    } else if (numId) {
      missingIds.push(numId);
    }
  });

  if (missingIds.length === 0) return contactsMap;

  const batchSize = 100;
  for (let i = 0; i < missingIds.length; i += batchSize) {
    const batch = missingIds.slice(i, i + batchSize);
    const query = batch.map(id => `filter[id][]=${id}`).join('&');
    try {
      const res = await kommoRequest('GET', `/api/v4/contacts?${query}&limit=250`);
      const contacts = res?._embedded?.contacts || [];
      contacts.forEach(c => {
        let phone = '';
        let email = '';
        const cfValues = c.custom_fields_values || [];
        cfValues.forEach(f => {
          const fn = String(f.field_name || '').toLowerCase();
          const fc = String(f.field_code || '').toUpperCase();
          if (f.field_id === 110074 || f.field_id === 110080 || fc === 'PHONE' || fn.includes('tel') || fn.includes('phone') || fn.includes('whats') || fn.includes('cel')) {
            phone = f.values?.[0]?.value || phone;
          }
          if (f.field_id === 110076 || fc === 'EMAIL' || fn.includes('mail')) {
            email = f.values?.[0]?.value || email;
          }
        });
        const contactObj = { id: c.id, name: c.name || 'Sem Nome', phone, email, custom_fields_values: cfValues };
        contactsMap[c.id] = contactObj;
        serverContactsCache.set(c.id, contactObj);
      });
    } catch(e) {
      console.error(`Error fetching contacts batch:`, e.message);
    }
    if (i + batchSize < missingIds.length) {
      await new Promise(r => setTimeout(r, 100));
    }
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
    const cUpper = String(cargo || '').toUpperCase();
    const isAux = cUpper.includes('AUXILIAR') || cUpper.includes('AJUDANTE') || cUpper.includes('BUSCO EVOLUÇÃO') || cUpper.includes('BUSCO EVOLUCAO');
    let isMql = tags.includes('MQL');
    if (lead.pipeline_id === PIPELINES.MLFP && isAux) {
      isMql = false; // Auxiliares da MLFP não entram como MQL
    } else if (lead.pipeline_id === PIPELINES.KO_INBOUND || lead.pipeline_id === PIPELINES.KO_EBOOKS) {
      isMql = isKomandoQualified(cargo, faturamento);
    } else if (!isMql) {
      if (lead.pipeline_id === PIPELINES.MLFP) {
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

// ============================================================
//  AGENTE DE GESTÃO DE TRÁFEGO
// ============================================================
// Coleta as duas contas de anúncios, compara com a média móvel de 7 dias e
// manda um resumo no Telegram duas vezes por dia.
//
// A ordenação é sempre por CPL. A análise de agosto/2026 mostrou que CTR
// (r = −0,08) e retenção de vídeo (r = +0,20) não preveem custo por lead —
// a campanha de melhor CTR e menor CPC da conta gerou 2 leads a R$ 1.482.
// Por isso nenhum alerta aqui dispara por métrica de topo de funil.

const CONTAS_TRAFEGO = [
  { id: 'act_322391662838622', nome: 'Distribuição' },
  { id: 'act_202384504675778', nome: 'Anunciante' }
];

// Cada funil tem um objetivo diferente e por isso uma métrica diferente.
// Medir tudo por lead era errado: KOR e KOP vendem, engajamento busca alcance.
//   'lead'        — mede cadastro e CPL
//   'venda'       — mede compra, CPA e ROAS
//   'engajamento' — mede interação e custo por interação; não tem meta de conversão
const OBJETIVO_FUNIL = {
  komando: 'lead',
  mlfp: 'lead',
  kor: 'venda',
  kop: 'venda',
  ebook: 'venda',
  recuperacao: 'venda',
  engajamento: 'engajamento',
  outros: 'nenhum'
};

// Teto de CPL. Komando: R$ 866 de receita por lead ÷ 3 (meta ROAS 3×).
const TETO_CPL = { komando: 289, mlfp: null };

// ROAS abaixo disso em funil de venda vira alerta
const ROAS_MINIMO = 1.0;

// Verba mínima para um criativo ser considerado testado (≈3 leads ao CPL médio).
// Não é usada no resumo diário — num único dia quase todo criativo fica abaixo
// disso, e o alerta viraria ruído. Serve de referência para análise de período.
const VERBA_MINIMA_TESTE = 450;

const ACOES_LEAD = ['offsite_conversion.fb_pixel_lead', 'lead', 'onsite_web_lead', 'leadgen_grouped'];
const ACOES_COMPRA = ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase', 'onsite_web_purchase'];
const ACOES_ENGAJAMENTO = ['post_engagement', 'page_engagement'];
const ACOES_CURTIDA = ['onsite_conversion.post_net_like'];


// valor=true lê action_values (receita) em vez de actions (contagem)
function _valorAcao(linha, tipos, valor) {
  const m = {};
  ((valor ? linha.action_values : linha.actions) || []).forEach(a => { m[a.action_type] = parseFloat(a.value) || 0; });
  for (const t of tipos) if (m[t] !== undefined) return m[t];
  return 0;
}

// Datas no fuso de Brasília (UTC−3), independentemente do fuso do servidor
function dataBrasilia(diasAtras = 0) {
  const agora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  agora.setUTCDate(agora.getUTCDate() - diasAtras);
  return agora.toISOString().slice(0, 10);
}

async function _insightsConta(contaId, since, until, nivel, tentativa = 1) {
  const token = (process.env.META_ACCESS_TOKEN && process.env.META_ACCESS_TOKEN.trim()) || DEFAULT_META_ACCESS_TOKEN;
  const params = new URLSearchParams({
    time_range: JSON.stringify({ since, until }),
    fields: 'campaign_name,ad_name,spend,impressions,clicks,ctr,actions,action_values',
    level: nivel,
    limit: '500',
    access_token: token
  });
  const r = await fetch(`https://graph.facebook.com/v20.0/${contaId}/insights?${params}`);
  const j = await r.json();
  if (j.error) {
    if (tentativa <= 3) {
      await new Promise(res => setTimeout(res, tentativa * 5000));
      return _insightsConta(contaId, since, until, nivel, tentativa + 1);
    }
    console.error(`[Tráfego] ${contaId} falhou: ${j.error.message}`);
    return [];
  }
  return j.data || [];
}

// Coleta as duas contas e agrega por funil e por criativo
async function coletarTrafego(since, until) {
  const linhas = [];
  for (const conta of CONTAS_TRAFEGO) {
    const camp = await _insightsConta(conta.id, since, until, 'campaign');
    const ads = await _insightsConta(conta.id, since, until, 'ad');
    camp.forEach(l => linhas.push({ ...l, conta: conta.nome, nivel: 'campanha' }));
    ads.forEach(l => linhas.push({ ...l, conta: conta.nome, nivel: 'anuncio' }));
  }

  const funis = {};
  const criativos = {};
  let gasto = 0, leads = 0, impressoes = 0, cliques = 0;

  linhas.filter(l => l.nivel === 'campanha').forEach(l => {
    const g = parseFloat(l.spend) || 0;
    const le = _valorAcao(l, ACOES_LEAD);
    const co = _valorAcao(l, ACOES_COMPRA);
    const rc = _valorAcao(l, ACOES_COMPRA, true);
    const en = _valorAcao(l, ACOES_ENGAJAMENTO);
    const cu = _valorAcao(l, ACOES_CURTIDA);
    const f = classifyCampaignFunnel(l.campaign_name);
    if (!funis[f]) funis[f] = { gasto: 0, leads: 0, compras: 0, receita: 0, engajamentos: 0, curtidas: 0, campanhas: [] };
    funis[f].gasto += g;
    funis[f].leads += le;
    funis[f].compras += co;
    funis[f].receita += rc;
    funis[f].engajamentos += en;
    funis[f].curtidas += cu;
    funis[f].campanhas.push({ nome: l.campaign_name, conta: l.conta, gasto: g, leads: le, compras: co, receita: rc });
    gasto += g; leads += le;
    impressoes += parseInt(l.impressions) || 0;
    cliques += parseInt(l.clicks) || 0;
  });

  linhas.filter(l => l.nivel === 'anuncio').forEach(l => {
    const k = `${l.conta}|${l.ad_name || '(sem nome)'}`;
    if (!criativos[k]) criativos[k] = { nome: l.ad_name || '(sem nome)', conta: l.conta, gasto: 0, leads: 0 };
    criativos[k].gasto += parseFloat(l.spend) || 0;
    criativos[k].leads += _valorAcao(l, ACOES_LEAD);
  });

  return {
    periodo: { since, until },
    gasto, leads, impressoes, cliques,
    cpl: leads ? gasto / leads : null,
    funis,
    criativos: Object.values(criativos)
  };
}

// Média diária dos 7 dias anteriores, para comparação
async function referencia7Dias(ateOntem) {
  const fim = ateOntem;
  const d = new Date(fim + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 6);
  const ini = d.toISOString().slice(0, 10);
  const base = await coletarTrafego(ini, fim);
  return {
    gastoDia: base.gasto / 7,
    leadsDia: base.leads / 7,
    cpl: base.cpl,
    cplPorFunil: Object.fromEntries(
      Object.entries(base.funis).map(([f, v]) => [f, v.leads ? v.gasto / v.leads : null])
    )
  };
}

// Regras de alerta — nenhuma dispara por CTR ou CPC
function analisarTrafego(hoje, ref) {
  const alertas = [];

  for (const [funil, v] of Object.entries(hoje.funis)) {
    if (v.gasto < 50) continue;
    const objetivo = OBJETIVO_FUNIL[funil] || 'nenhum';

    // Marca e alcance não têm meta de conversão — nunca alertam por isso
    if (objetivo === 'engajamento' || objetivo === 'nenhum') continue;

    if (objetivo === 'venda') {
      if (v.compras === 0) {
        alertas.push({ peso: v.gasto, txt: `*${funil}*: R$ ${v.gasto.toFixed(0)} gastos, nenhuma venda` });
        continue;
      }
      const roas = v.gasto ? v.receita / v.gasto : 0;
      if (roas < ROAS_MINIMO) {
        alertas.push({ peso: v.gasto, txt: `*${funil}*: ROAS ${roas.toFixed(2)}× — abaixo do ponto de equilíbrio` });
      }
      continue;
    }

    // objetivo === 'lead'
    if (v.leads === 0) {
      alertas.push({ peso: v.gasto, txt: `*${funil}*: R$ ${v.gasto.toFixed(0)} gastos, nenhum lead` });
      continue;
    }
    const cpl = v.gasto / v.leads;
    const teto = TETO_CPL[funil];
    if (teto && cpl > teto) {
      alertas.push({ peso: v.gasto, txt: `*${funil}*: CPL R$ ${cpl.toFixed(0)} — acima do teto de R$ ${teto}` });
    } else {
      const cplRef = ref.cplPorFunil[funil];
      if (cplRef && cpl > cplRef * 1.8) {
        alertas.push({ peso: v.gasto, txt: `*${funil}*: CPL R$ ${cpl.toFixed(0)}, ${((cpl / cplRef - 1) * 100).toFixed(0)}% acima da média de 7d` });
      }
    }
  }

  // Criativos com verba consumida e nenhum lead
  hoje.criativos
    .filter(c => c.gasto >= 100 && c.leads === 0)
    .sort((a, b) => b.gasto - a.gasto)
    .slice(0, 3)
    .forEach(c => alertas.push({ peso: c.gasto, txt: `Criativo *${c.nome}*: R$ ${c.gasto.toFixed(0)} sem lead` }));

  // maior dinheiro em risco primeiro
  alertas.sort((a, b) => b.peso - a.peso);

  const melhores = hoje.criativos
    .filter(c => c.leads > 0)
    .map(c => ({ ...c, cpl: c.gasto / c.leads }))
    .sort((a, b) => a.cpl - b.cpl)
    .slice(0, 3);

  return { alertas, melhores };
}

const ICONE_FUNIL = { komando: '🔴', kop: '📦', kor: '🔄', recuperacao: '♻️', mlfp: '🔵', ebook: '📚', engajamento: '📲', outros: '⚪' };

function montarMensagemTrafego(tipo, hoje, ref, analise) {
  const brl = v => v == null ? '—' : 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  // menorEhMelhor: no CPL, cair é bom; no gasto, é só informativo
  const delta = (a, b, menorEhMelhor) => {
    if (!b || !a) return '—';
    const p = (a / b - 1) * 100;
    const sinal = `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`;
    if (!menorEhMelhor) return sinal;
    return `${sinal} ${p <= 0 ? '✅' : '⚠️'}`;
  };
  const [ano, mes, dia] = hoje.periodo.since.split('-');
  const dataFmt = `${dia}/${mes}`;

  const cab = tipo === 'manha'
    ? `📊 *Tráfego · ontem (${dataFmt})*\n_fechamento do dia_`
    : `📊 *Tráfego · hoje (${dataFmt})*\n_parcial até agora_`;

  const linhas = [cab, ''];

  // ROAS só faz sentido sobre a verba dos funis de venda. Dividir a receita
  // pelo gasto total incluiria os funis de lead e produziria um número falso.
  const deVenda = Object.entries(hoje.funis).filter(([f]) => OBJETIVO_FUNIL[f] === 'venda');
  const gastoVenda = deVenda.reduce((s, [, v]) => s + v.gasto, 0);
  const totalCompras = deVenda.reduce((s, [, v]) => s + (v.compras || 0), 0);
  const totalReceita = deVenda.reduce((s, [, v]) => s + (v.receita || 0), 0);

  let totalTxt = `*Total* ${brl(hoje.gasto)} · ${hoje.leads} leads · CPL ${brl(hoje.cpl)}`;
  if (gastoVenda > 0) {
    const roasVenda = totalReceita / gastoVenda;
    totalTxt += `\n*Vendas* ${totalCompras} · receita ${brl(totalReceita)} · ROAS ${roasVenda.toFixed(2)}× _(sobre ${brl(gastoVenda)} de funil de venda)_`;
  }
  linhas.push(totalTxt);
  if (ref && ref.gastoDia) {
    linhas.push(`_vs média 7d · gasto ${delta(hoje.gasto, ref.gastoDia, false)} · CPL ${delta(hoje.cpl, ref.cpl, true)}_`);
  }
  linhas.push('');

  const funisOrd = Object.entries(hoje.funis)
    .filter(([, v]) => v.gasto >= 1)
    .sort((a, b) => b[1].gasto - a[1].gasto);

  if (funisOrd.length) {
    linhas.push('*Por funil*');
    funisOrd.forEach(([f, v]) => {
      const ico = ICONE_FUNIL[f] || '⚪';
      const objetivo = OBJETIVO_FUNIL[f] || 'nenhum';
      let corpo;

      if (objetivo === 'venda') {
        const roas = v.gasto ? v.receita / v.gasto : 0;
        const cpa = v.compras ? brl(v.gasto / v.compras) : '—';
        corpo = `${v.compras} venda${v.compras === 1 ? '' : 's'} · CPA ${cpa} · ROAS ${roas.toFixed(2)}×`;
      } else if (objetivo === 'engajamento') {
        const cpe = v.engajamentos ? (v.gasto / v.engajamentos) : null;
        corpo = `${v.engajamentos.toLocaleString('pt-BR')} interações · ${cpe ? 'R$ ' + cpe.toFixed(2) : '—'}/interação`;
        if (v.curtidas) corpo += ` · ${v.curtidas} curtidas`;
      } else if (objetivo === 'lead') {
        const cpl = v.leads ? brl(v.gasto / v.leads) : '—';
        corpo = `${v.leads} lead${v.leads === 1 ? '' : 's'} · CPL ${cpl}`;
      } else {
        // funil sem objetivo definido: só o gasto, sem métrica de conversão
        corpo = '_sem objetivo definido_';
      }

      linhas.push(`${ico} ${f} · ${brl(v.gasto)} · ${corpo}`);
    });
    // nota só aparece quando há campanha de engajamento no período
    if (funisOrd.some(([f]) => OBJETIVO_FUNIL[f] === 'engajamento')) {
      linhas.push('_engajamento é medido por interação: visitas ao perfil e seguidores não vêm na API de Anúncios._');
    }
    linhas.push('');
  }

  if (analise.alertas.length) {
    linhas.push('⚠️ *Precisa de atenção*');
    analise.alertas.slice(0, 5).forEach(a => linhas.push(`• ${a.txt}`));
    linhas.push('');
  }

  if (analise.melhores.length) {
    linhas.push('🏆 *Melhores criativos*');
    analise.melhores.forEach(c => linhas.push(`• ${c.nome} · ${c.leads} lead${c.leads === 1 ? '' : 's'} · ${brl(c.cpl)}`));
    linhas.push('');
  }

  if (!hoje.gasto) {
    linhas.push('_Nenhum investimento registrado no período._');
  }

  return linhas.join('\n');
}

async function executarRelatorioTrafego(tipo, diaForcado) {
  // manhã: fecha o dia anterior · noite: parcial do dia corrente
  // diaForcado permite conferir uma data específica sem esperar o cron
  const dia = diaForcado || (tipo === 'manha' ? dataBrasilia(1) : dataBrasilia(0));
  const hoje = await coletarTrafego(dia, dia);
  let ref = null;
  try { ref = await referencia7Dias(dataBrasilia(1)); } catch (e) { console.error('[Tráfego] referência 7d falhou:', e.message); }
  const analise = analisarTrafego(hoje, ref || { cplPorFunil: {} });
  return montarMensagemTrafego(tipo, hoje, ref, analise);
}

// 09:00 de Brasília = 12:00 UTC
app.get(['/api/cron/trafego-manha', '/api/reports/trafego-manha'], async (req, res) => {
  try {
    const msg = await executarRelatorioTrafego('manha');
    await sendTelegram(process.env.TELEGRAM_CHAT_ID_TRAFEGO || process.env.TELEGRAM_CHAT_ID, msg);
    res.json({ success: true, tipo: 'manha', preview: msg });
  } catch (err) {
    console.error('[Cron Tráfego manhã]', err);
    await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Tráfego manhã]*\n${err.message}`).catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// 22:00 de Brasília = 01:00 UTC do dia seguinte
app.get(['/api/cron/trafego-noite', '/api/reports/trafego-noite'], async (req, res) => {
  try {
    const msg = await executarRelatorioTrafego('noite');
    await sendTelegram(process.env.TELEGRAM_CHAT_ID_TRAFEGO || process.env.TELEGRAM_CHAT_ID, msg);
    res.json({ success: true, tipo: 'noite', preview: msg });
  } catch (err) {
    console.error('[Cron Tráfego noite]', err);
    await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Tráfego noite]*\n${err.message}`).catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pré-visualização sem enviar nada ao Telegram
app.get('/api/trafego/preview', async (req, res) => {
  try {
    const tipo = req.query.tipo === 'noite' ? 'noite' : 'manha';
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : null;
    res.type('text/plain').send(await executarRelatorioTrafego(tipo, dia));
  } catch (err) {
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

// ============================================================
//  API: PAINEL EXECUTIVO TRÁFEGO X COMERCIAL (SEMANAL & ANUAL)
// ============================================================
app.get('/api/traffic-sales-weekly', async (req, res) => {
  let token = (process.env.META_ACCESS_TOKEN && process.env.META_ACCESS_TOKEN.trim()) || DEFAULT_META_ACCESS_TOKEN;
  const targetMonth = req.query.month || new Date().toISOString().slice(0, 7); // e.g. "2026-08"
  const funnelFilter = (req.query.funnel || 'all').toLowerCase(); // 'all', 'mlfp', 'komando', 'kop', 'kor', 'ebook'

  try {
    const [yearStr, monthStr] = targetMonth.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10); // 1-12

    // Quantidade de dias no mês
    const daysInMonth = new Date(year, month, 0).getDate();

    // Definição padrão das 5 semanas do mês
    const weekRanges = [
      { id: 'w1', name: 'Semana 1 (01- 05)', startDay: 1, endDay: 5 },
      { id: 'w2', name: 'Semana 2 (06- 12)', startDay: 6, endDay: 12 },
      { id: 'w3', name: 'Semana 3 (13 - 19)', startDay: 13, endDay: 19 },
      { id: 'w4', name: 'Semana 4 (20 - 26)', startDay: 20, endDay: 26 },
      { id: 'w5', name: `Semana 5 (27 - ${daysInMonth})`, startDay: 27, endDay: daysInMonth }
    ];

    // Formatar datas YYYY-MM-DD
    const pad = n => String(n).padStart(2, '0');
    const weeksConfig = weekRanges.map(w => ({
      ...w,
      since: `${year}-${pad(month)}-${pad(w.startDay)}`,
      until: `${year}-${pad(month)}-${pad(w.endDay)}`
    }));

    // Mapeamento de funis e pipelines do Kommo CRM
    const PIPELINE_MAP = {
      mlfp: [13304583],
      komando: [13304659],
      kop: [14173256],
      kor: [14268556, 13956952],
      ebook: [13537971],
      all: [13304583, 13304659, 13537971, 14173256, 14268556, 13956952]
    };
    const activePipelines = PIPELINE_MAP[funnelFilter] || PIPELINE_MAP.all;

    // Carregar leads do cache
    const allLeads = await lerCache('all_leads.json', []);
    const commercialLeads = allLeads.filter(l => {
      const tags = (l._embedded?.tags || []).map(t => t.name.toUpperCase());
      const name = (l.name || '').toUpperCase();
      if (funnelFilter === 'kor') {
        return l.pipeline_id === 14268556 || l.pipeline_id === 13956952 || 
          (l.pipeline_id === 13956856 && (tags.includes('KOR') || tags.some(t => t.includes('RESTAURANTE')) || name.includes('KOR')));
      }
      if (funnelFilter === 'kop') {
        return l.pipeline_id === 14173256 || 
          (l.pipeline_id === 13956856 && (tags.includes('KOP') || tags.some(t => t.includes('PRAÇA') || t.includes('PRACA')) || name.includes('KOP')));
      }
      return activePipelines.includes(l.pipeline_id) || (funnelFilter === 'all' && l.pipeline_id === 13956856);
    });

    // Carregar vendas Eduzz do cache
    const rawSales = await lerCache('eduzz_sales_raw.json', []);
    const paidSales = rawSales.filter(s => s.sale_status === 3 || s.sale_status_name === 'Paga' || s.status === 'paid');

    // 1. Processar cada semana em paralelo (Meta Ads + CRM)
    const weeksData = await Promise.all(weeksConfig.map(async (w) => {
      const timeRange = JSON.stringify({ since: w.since, until: w.until });
      let spend = 0;
      let impressions = 0;
      let clicks = 0;
      let metaPurchases = 0;
      let metaPurchaseValue = 0;

      try {
        const campUrl = `https://graph.facebook.com/v20.0/act_322391662838622/insights?time_range=${encodeURIComponent(timeRange)}&fields=campaign_name,spend,impressions,clicks,actions,action_values&level=campaign&limit=100&access_token=${token}`;
        let resp = await fetch(campUrl);
        let data = await resp.json();
        if (data.error && data.error.code === 200 && token !== DEFAULT_META_ACCESS_TOKEN) {
          const fallbackUrl = `https://graph.facebook.com/v20.0/act_322391662838622/insights?time_range=${encodeURIComponent(timeRange)}&fields=campaign_name,spend,impressions,clicks,actions,action_values&level=campaign&limit=100&access_token=${DEFAULT_META_ACCESS_TOKEN}`;
          resp = await fetch(fallbackUrl);
          data = await resp.json();
        }
        if (data.data) {
          for (const c of data.data) {
            const fType = classifyCampaignFunnel(c.campaign_name);
            let includeCamp = false;
            if (funnelFilter === 'all') {
              includeCamp = true;
            } else if (fType === funnelFilter) {
              includeCamp = true;
            }

            if (includeCamp) {
              spend += parseFloat(c.spend || 0);
              impressions += parseInt(c.impressions || 0, 10);
              clicks += parseInt(c.clicks || 0, 10);

              // Extrair compras e valores de compra do Meta Pixel
              const actions = c.actions || [];
              const actionValues = c.action_values || [];

              const pAct = actions.find(a => 
                a.action_type === 'purchase' || 
                a.action_type === 'offsite_conversion.fb_pixel_purchase' || 
                a.action_type === 'omni_purchase' ||
                a.action_type === 'onsite_web_purchase'
              );
              const pCount = pAct ? parseInt(pAct.value || 0, 10) : 0;
              metaPurchases += pCount;

              const pValAct = actionValues.find(a => 
                a.action_type === 'purchase' || 
                a.action_type === 'offsite_conversion.fb_pixel_purchase' || 
                a.action_type === 'omni_purchase' ||
                a.action_type === 'onsite_web_purchase'
              );
              const pVal = pValAct ? parseFloat(pValAct.value || 0) : (pCount * (fType === 'kor' ? 97 : (fType === 'kop' ? 97 : 0)));
              metaPurchaseValue += pVal;
            }
          }
        }
      } catch (e) {
        console.error(`[Traffic Weekly] Error fetching Meta for week ${w.name}:`, e.message);
      }

      // Filtrar leads no intervalo de segundos
      const startSec = Math.floor(new Date(`${w.since}T00:00:00-03:00`).getTime() / 1000);
      const endSec = Math.floor(new Date(`${w.until}T23:59:59-03:00`).getTime() / 1000);

      const wLeads = commercialLeads.filter(l => l.created_at >= startSec && l.created_at <= endSec);

      let agendadas = 0;
      let comparecidas = 0;
      let vendas = 0;
      let faturamento = 0;
      let noShow = 0;

      wLeads.forEach(l => {
        const tags = (l._embedded?.tags || []).map(t => t.name.toUpperCase());
        const sId = l.status_id;
        const price = parseFloat(l.price) || 0;

        if (sId === 102599003 || sId === 109107608 || tags.includes('REUNIÃO AGENDADA') || tags.includes('AGENDOU')) {
          agendadas++;
        }
        if (sId === 102599203 || sId === 108066768 || tags.includes('REUNIÃO REALIZADA') || tags.includes('COMPARECEU')) {
          comparecidas++;
        }
        if (sId === 108291644 || tags.includes('NO SHOW') || tags.includes('NÃO COMPARECEU')) {
          noShow++;
        }
        if (sId === 142) {
          vendas++;
          faturamento += price > 0 ? price : (funnelFilter === 'mlfp' ? 2997 : (funnelFilter === 'komando' ? 1000 : 97));
        }
      });

      // Também computar faturamento Eduzz pago nesta semana para o produto
      paidSales.forEach(s => {
        const title = (s.content_title || s.product_name || '').toUpperCase();
        let matchesProduct = false;
        if (funnelFilter === 'all') matchesProduct = true;
        else if (funnelFilter === 'mlfp' && (title.includes('MENTORIA') || title.includes('MLFP') || title.includes('FAIXA PRETA'))) matchesProduct = true;
        else if (funnelFilter === 'komando' && title.includes('KOMANDO') && !title.includes('KOP') && !title.includes('KOR')) matchesProduct = true;
        else if (funnelFilter === 'kop' && (title.includes('KOP') || title.includes('PRAÇA') || title.includes('PRACA'))) matchesProduct = true;
        else if (funnelFilter === 'kor' && (title.includes('KOR') || title.includes('RESTAURANTE') || title.includes('RECUPERAÇÃO') || title.includes('RECUPERACAO'))) matchesProduct = true;
        else if (funnelFilter === 'ebook' && (title.includes('EBOOK') || title.includes('LIVRO'))) matchesProduct = true;

        if (matchesProduct) {
          const rawDate = s.date_payment || s.date_create;
          if (rawDate) {
            const sSecs = Math.floor(new Date(String(rawDate).replace(' ', 'T')).getTime() / 1000);
            if (sSecs >= startSec && sSecs <= endSec) {
              const val = parseFloat(s.sale_total) || parseFloat(s.value) || 0;
              if (val > 0) faturamento += val;
            }
          }
        }
      });

      // Para produtos de venda direta (KOP, KOR, EBOOK) ou consolidação, incluir vendas do Pixel da Meta
      if (funnelFilter === 'kop' || funnelFilter === 'kor' || funnelFilter === 'ebook') {
        vendas = metaPurchases > 0 ? metaPurchases : vendas;
        faturamento = metaPurchaseValue > 0 ? metaPurchaseValue : faturamento;
      } else if (funnelFilter === 'all') {
        vendas += metaPurchases;
        faturamento += metaPurchaseValue;
      }

      const cpl = wLeads.length > 0 ? (spend / wLeads.length) : 0;
      const cpa = agendadas > 0 ? (spend / agendadas) : 0;
      const cpr = comparecidas > 0 ? (spend / comparecidas) : 0;
      const cac = vendas > 0 ? (spend / vendas) : 0;
      const roas = spend > 0 ? (faturamento / spend) : 0;
      const ticketMedio = vendas > 0 ? (faturamento / vendas) : 0;
      const noShowPct = agendadas > 0 ? (noShow / agendadas) * 100 : 0;

      return {
        id: w.id,
        name: w.name,
        since: w.since,
        until: w.until,
        investimento: Math.round(spend * 100) / 100,
        impressions,
        clicks,
        leads: wLeads.length,
        agendadas,
        comparecidas,
        vendas,
        faturamento: Math.round(faturamento * 100) / 100,
        noShow,
        noShowPct: Math.round(noShowPct * 10) / 10,
        cpl: Math.round(cpl * 100) / 100,
        cpa: Math.round(cpa * 100) / 100,
        cpr: Math.round(cpr * 100) / 100,
        cac: Math.round(cac * 100) / 100,
        ticketMedio: Math.round(ticketMedio * 100) / 100,
        roas: Math.round(roas * 100) / 100
      };
    }));

    // 2. Totais do Mês
    const monthTotals = {
      investimento: Math.round(weeksData.reduce((acc, w) => acc + w.investimento, 0) * 100) / 100,
      leads: weeksData.reduce((acc, w) => acc + w.leads, 0),
      agendadas: weeksData.reduce((acc, w) => acc + w.agendadas, 0),
      comparecidas: weeksData.reduce((acc, w) => acc + w.comparecidas, 0),
      vendas: weeksData.reduce((acc, w) => acc + w.vendas, 0),
      faturamento: Math.round(weeksData.reduce((acc, w) => acc + w.faturamento, 0) * 100) / 100,
      noShow: weeksData.reduce((acc, w) => acc + w.noShow, 0)
    };
    monthTotals.noShowPct = monthTotals.agendadas > 0 ? Math.round((monthTotals.noShow / monthTotals.agendadas) * 1000) / 10 : 0;
    monthTotals.cpl = monthTotals.leads > 0 ? Math.round((monthTotals.investimento / monthTotals.leads) * 100) / 100 : 0;
    monthTotals.cpa = monthTotals.agendadas > 0 ? Math.round((monthTotals.investimento / monthTotals.agendadas) * 100) / 100 : 0;
    monthTotals.cpr = monthTotals.comparecidas > 0 ? Math.round((monthTotals.investimento / monthTotals.comparecidas) * 100) / 100 : 0;
    monthTotals.cac = monthTotals.vendas > 0 ? Math.round((monthTotals.investimento / monthTotals.vendas) * 100) / 100 : 0;
    monthTotals.ticketMedio = monthTotals.vendas > 0 ? Math.round((monthTotals.faturamento / monthTotals.vendas) * 100) / 100 : 0;
    monthTotals.roas = monthTotals.investimento > 0 ? Math.round((monthTotals.faturamento / monthTotals.investimento) * 100) / 100 : 0;

    // 3. Criativos Campeões do Mês (Meta Ads)
    const monthSince = `${year}-${pad(month)}-01`;
    const monthUntil = `${year}-${pad(month)}-${pad(daysInMonth)}`;
    const monthTimeRange = JSON.stringify({ since: monthSince, until: monthUntil });

    let championCreatives = [];
    try {
      const adUrl = `https://graph.facebook.com/v20.0/act_322391662838622/insights?time_range=${encodeURIComponent(monthTimeRange)}&fields=ad_name,ad_id,campaign_name,spend,impressions,clicks,actions,action_values&level=ad&limit=100&access_token=${token}`;
      let adResp = await fetch(adUrl);
      let adData = await adResp.json();
      if (adData.error && adData.error.code === 200 && token !== DEFAULT_META_ACCESS_TOKEN) {
        const fallbackAdUrl = `https://graph.facebook.com/v20.0/act_322391662838622/insights?time_range=${encodeURIComponent(monthTimeRange)}&fields=ad_name,ad_id,campaign_name,spend,impressions,clicks,actions,action_values&level=ad&limit=100&access_token=${DEFAULT_META_ACCESS_TOKEN}`;
        adResp = await fetch(fallbackAdUrl);
        adData = await adResp.json();
      }

      const rawAds = adData.data || [];
      championCreatives = rawAds
        .filter(a => {
          if (funnelFilter === 'all') return true;
          return classifyCampaignFunnel(a.campaign_name) === funnelFilter;
        })
        .map(a => {
          const spend = parseFloat(a.spend || 0);
          const actions = a.actions || [];
          const actionValues = a.action_values || [];

          const metaLeadsAction = actions.find(act => 
            act.action_type === 'lead' || 
            act.action_type === 'offsite_conversion.fb_pixel_lead' || 
            act.action_type === 'onsite_web_lead'
          );
          const metaLeads = metaLeadsAction ? parseInt(metaLeadsAction.value || 0, 10) : 0;

          const metaPurchAction = actions.find(act => 
            act.action_type === 'purchase' || 
            act.action_type === 'offsite_conversion.fb_pixel_purchase' || 
            act.action_type === 'omni_purchase' ||
            act.action_type === 'onsite_web_purchase'
          );
          const metaPurchases = metaPurchAction ? parseInt(metaPurchAction.value || 0, 10) : 0;

          const metaPurchValAction = actionValues.find(act => 
            act.action_type === 'purchase' || 
            act.action_type === 'offsite_conversion.fb_pixel_purchase' || 
            act.action_type === 'omni_purchase' ||
            act.action_type === 'onsite_web_purchase'
          );
          const metaPurchaseVal = metaPurchValAction ? parseFloat(metaPurchValAction.value || 0) : (metaPurchases * 97);

          const impressions = parseInt(a.impressions || 0, 10);
          const cpl = metaLeads > 0 ? (spend / metaLeads) : 0;
          const cac = metaPurchases > 0 ? (spend / metaPurchases) : 0;

          // Sugestão e análise de melhorias automática baseada no desempenho
          let melhorias = 'Manter monitoramento constante de frequência e custo.';
          if (metaPurchases >= 5) {
            melhorias = `⭐ Campeão de Vendas (${metaPurchases} vendas, ROAS ${spend > 0 ? (metaPurchaseVal / spend).toFixed(2) : 0}x): Escalar orçamento e criar variações de gancho.`;
          } else if (metaPurchases > 0) {
            melhorias = `Venda validada (${metaPurchases} vendas, CAC R$ ${cac.toFixed(2)}): Manter e otimizar criativo para reduzir custo por compra.`;
          } else if (metaLeads >= 10 && cpl < 15) {
            melhorias = '⭐ Criativo campeão de leads: criar 3 variações mantendo a mesma copy e testando novos ganchos visuais.';
          } else if (metaLeads >= 5) {
            melhorias = 'Usar a mesma copy, com design nativo e testar variações de fundo para reduzir CPL.';
          } else if (impressions > 5000 && metaLeads === 0 && metaPurchases === 0) {
            melhorias = 'Alta visualização com baixa conversão: trocar o primeiro frame (gancho nos 3s) e a CTA final.';
          } else if (spend > 50 && metaLeads === 0 && metaPurchases === 0) {
            melhorias = 'Gasto sem conversão: pausar e substituir por variação mais direta.';
          } else {
            melhorias = 'Testar variações de design mantendo a estrutura da copy.';
          }

          return {
            id: a.ad_id,
            nome: a.ad_name,
            campanha: a.campaign_name,
            funnel: classifyCampaignFunnel(a.campaign_name),
            investimento: Math.round(spend * 100) / 100,
            impressoes: impressions,
            leads: metaLeads,
            vendas: metaPurchases,
            faturamento: Math.round(metaPurchaseVal * 100) / 100,
            cpl: Math.round(cpl * 100) / 100,
            cac: Math.round(cac * 100) / 100,
            melhorias,
            link: `https://www.facebook.com/ads/library/?id=${a.ad_id}`
          };
        })
        .filter(a => a.investimento > 0 || a.leads > 0 || a.vendas > 0)
        .sort((a, b) => {
          if (b.vendas !== a.vendas) return b.vendas - a.vendas;
          if (b.leads !== a.leads) return b.leads - a.leads;
          return b.investimento - a.investimento;
        })
        .slice(0, 10);
    } catch (adErr) {
      console.error('[Traffic Weekly] Error fetching ads:', adErr.message);
    }

    // 4. Resumo Anual Mês a Mês
    const monthsNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const annualSummary = monthsNames.map((name, idx) => {
      const mNum = idx + 1;
      const mPrefix = `${year}-${pad(mNum)}`;
      
      let faturamentoMes = 0;
      if (mNum === month) {
        faturamentoMes = monthTotals.faturamento;
      } else {
        // Vendas do mês no Eduzz
        paidSales.forEach(s => {
          const title = (s.content_title || s.product_name || '').toUpperCase();
          let matchesProduct = false;
          if (funnelFilter === 'all') matchesProduct = true;
          else if (funnelFilter === 'mlfp' && (title.includes('MENTORIA') || title.includes('MLFP') || title.includes('FAIXA PRETA'))) matchesProduct = true;
          else if (funnelFilter === 'komando' && title.includes('KOMANDO') && !title.includes('KOP') && !title.includes('KOR')) matchesProduct = true;
          else if (funnelFilter === 'kop' && (title.includes('KOP') || title.includes('PRAÇA') || title.includes('PRACA'))) matchesProduct = true;
          else if (funnelFilter === 'kor' && (title.includes('KOR') || title.includes('RESTAURANTE') || title.includes('RECUPERAÇÃO') || title.includes('RECUPERACAO'))) matchesProduct = true;
          else if (funnelFilter === 'ebook' && (title.includes('EBOOK') || title.includes('LIVRO'))) matchesProduct = true;

          if (matchesProduct) {
            const rawDate = s.date_payment || s.date_create;
            if (rawDate && String(rawDate).startsWith(mPrefix)) {
              faturamentoMes += parseFloat(s.sale_total) || parseFloat(s.value) || 0;
            }
          }
        });

        // Faturamento de CRM
        commercialLeads.forEach(l => {
          const lDate = new Date(l.created_at * 1000).toISOString().slice(0, 7);
          if (lDate === mPrefix && l.status_id === 142) {
            faturamentoMes += parseFloat(l.price) || (funnelFilter === 'mlfp' ? 2997 : 1000);
          }
        });
      }

      // Se for o mês corrente selecionado, usar o valor do mês
      const investido = (mNum === month) ? monthTotals.investimento : (mNum < month ? (funnelFilter === 'mlfp' ? 6000 : 3000) : 0);
      const roas = investido > 0 ? (faturamentoMes / investido) : 0;

      return {
        mes: name,
        mesNum: mNum,
        investimento: Math.round(investido * 100) / 100,
        faturamento: Math.round(faturamentoMes * 100) / 100,
        roas: Math.round(roas * 100) / 100,
        status: faturamentoMes >= investido && investido > 0 ? 'Lucrativo' : (investido > 0 ? 'Em maturação' : 'Pendente')
      };
    });

    res.json({
      success: true,
      month: targetMonth,
      monthName: monthsNames[month - 1] + ' ' + year,
      funnel: funnelFilter,
      weeks: weeksData,
      totals: monthTotals,
      championCreatives,
      annual: annualSummary
    });
  } catch (err) {
    console.error('[Traffic Sales Weekly API Error]:', err);
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

// GreatPages & Generic Webhook Endpoint for KOR Page (Funil de Recuperação)
// URLs: POST /api/kor-webhook, POST /api/webhook/greatpages-kor, POST /api/greatpages-kor, POST /api/webhook/kor
app.post(['/api/kor-webhook', '/api/webhook/greatpages-kor', '/api/greatpages-kor', '/api/webhook/kor', '/api/webhook/kor-webhook'], async (req, res) => {
  let gsRow = null;
  try {
    const data = req.body || {};
    console.log('[KOR Webhook] Received payload:', JSON.stringify(data));

    const name = getFlexibleValue(data, ['Seu_nome_completo', 'seu_nome_completo', 'nome', 'name', 'full_name', 'Nome', 'first_name', 'nome_completo']) || 'Lead KOR';
    const email = getFlexibleValue(data, ['Seu_melhor_e_mail', 'seu_melhor_e_mail', 'email', 'e-mail', 'e_mail', 'email_address', 'E-mail', 'Email']).toLowerCase().trim();
    const rawPhone = getFlexibleValue(data, ['Seu_WhatsApp_com_DDD', 'seu_whatsapp_com_ddd', 'whatsapp', 'whats', 'telefone', 'phone', 'celular', 'tel', 'WhatsApp', 'phone_number']);
    const phone = rawPhone.replace(/[^0-9+]/g, '');
    const instagram = getFlexibleValue(data, ['Seu_instagram', 'seu_instagram', 'Instagram', 'instagram', 'insta', 'user_instagram', 'Seu instagram?']);
    const faturamento = getFlexibleValue(data, ['Seu_faturamento_medio', 'seu_faturamento_medio', 'faturamento', 'faturamento_medio', 'faturamento_mensal', 'renda', 'receita', 'Qual_seu_faturamento_medio_mensal']);
    const socios = getFlexibleValue(data, ['Possui_socios', 'possui_socios', 'socios', 'tem_socios', 'Possui sócios?', 'possui_socio']);
    const gargalo = getFlexibleValue(data, ['Maior_gargalo', 'maior_gargalo', 'gargalo', 'desafio', 'principal_desafio', 'Por_que_buscou_a_Komando']);
    const cargo = getFlexibleValue(data, ['Cargo', 'cargo', 'perfil', 'funcao', 'profissao', 'Qual_seu_cargo', 'Qual é o seu cargo?']);
    const equipe = getFlexibleValue(data, ['equipe', 'Equipe', 'tamanho_da_equipe', 'numero_colaboradores']);
    const lider = getFlexibleValue(data, ['lider', 'Líder', 'possui_lider_operacional']);

    const utm_source = getFlexibleValue(data, ['utm_source', 'UTM_Source', 'source', 'Source']);
    const utm_medium = getFlexibleValue(data, ['utm_medium', 'UTM_Medium', 'medium', 'Medium']);
    const utm_campaign = getFlexibleValue(data, ['utm_campaign', 'UTM_Campaign', 'campaign', 'Campaign']);
    const utm_content = getFlexibleValue(data, ['utm_content', 'UTM_Content', 'content', 'Content']);
    const utm_term = getFlexibleValue(data, ['utm_term', 'UTM_Term', 'term', 'Term']);
    const ab_variant = getFlexibleValue(data, ['ab_variant', 'abVariant', 'ab_test', 'variant', 'pagina_variante', 'variante']) || '';

    // KOR Qualification Logic (Cargo + Faturamento >= 100k)
    const isPartner = isPartnerOrOwner(cargo, '');
    const isOver100k = isFaturamentoAbove50k(faturamento, '');
    const korIsMql = isPartner || isOver100k;
    const korTag = korIsMql ? 'MQL' : 'Downsell';
    console.log(`[KOR Webhook] Qualification: Cargo="${cargo}", Fat="${faturamento}", isMQL=${korIsMql}`);

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
      equipe: equipe,
      lider: lider,
      utm_source: utm_source,
      utm_medium: utm_medium,
      utm_campaign: utm_campaign,
      utm_content: utm_content,
      utm_term: utm_term,
      ab_variant: ab_variant
    });
    gsRow = gsResult?.row;
    console.log(`[KOR Webhook] Lead saved FIRST to Google Sheets KOR tab (row: ${gsRow || 'N/A'})`);

    const customFields = [];
    if (cargo) customFields.push({ field_id: 128884, values: [{ value: cargo }] });
    if (instagram) customFields.push({ field_id: 311994, values: [{ value: String(instagram) }] });
    if (faturamento) customFields.push({ field_id: 128886, values: [{ value: String(faturamento) }] });
    if (socios) customFields.push({ field_id: 128888, values: [{ value: String(socios) }] });
    if (gargalo) customFields.push({ field_id: 492037, values: [{ value: String(gargalo) }] });
    if (equipe) customFields.push({ field_id: 492035, values: [{ value: String(equipe) }] });
    if (lider) customFields.push({ field_id: 492039, values: [{ value: String(lider) }] });
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
        name: `[KOR] ${name}`,
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
    console.log('[KOR Webhook] Kommo response:', JSON.stringify(result));

    // Update Google Sheets status in KOR tab
    if (gsRow) await updateGoogleSheetsStatus('KOR', gsRow, 'Processado', leadId);

    // KOR leads do NOT send thread notifications (notifications reserved for Komando)
    console.log(`[KOR Webhook] Lead KOR ${leadId} processed in CRM and Sheets. Thread notification skipped (KOR notifications disabled).`);

    res.status(200).json({ success: true, message: 'Lead KOR created successfully', lead_id: leadId, data: result });
  } catch (err) {
    console.error('[KOR Webhook] Error:', err.message);
    if (gsRow) await updateGoogleSheetsStatus('KOR', gsRow, 'Erro CRM', '');

    // Send Telegram alert on error
    try {
      await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, `🚨 *[Erro Webhook KOR]*\nLinha na Planilha: ${gsRow || 'N/A'}\nErro: ${err.message}`);
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

// ============================================================================
// POST /api/kor-upsell (Pós-Compra K.O.R: Pré-Qualificação de Faturamento & Sócios)
// ============================================================================
app.options('/api/kor-upsell', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/api/kor-upsell', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const data = req.body || {};
    console.log('[KOR Upsell] Received payload:', JSON.stringify(data));

    const name = getFlexibleValue(data, ['nome', 'name', 'Nome', 'client_name']) || 'Comprador KOR';
    const email = getFlexibleValue(data, ['email', 'e-mail', 'Email', 'E-mail']).toLowerCase().trim();
    const rawPhone = getFlexibleValue(data, ['telefone', 'phone', 'whatsapp', 'celular', 'WhatsApp']);
    const phone = rawPhone.replace(/[^0-9+]/g, '');
    const cargo = getFlexibleValue(data, ['cargo', 'Cargo', 'funcao']) || 'Comprador KOR';
    const faturamento = getFlexibleValue(data, ['faturamento', 'Faturamento', 'faturamento_mensal']);
    const socios = getFlexibleValue(data, ['socios', 'Socios', 'Possui_socios']);

    const utm_source = getFlexibleValue(data, ['utm_source', 'Source']);
    const utm_medium = getFlexibleValue(data, ['utm_medium', 'Medium']);
    const utm_campaign = getFlexibleValue(data, ['utm_campaign', 'Campaign']);
    const utm_content = getFlexibleValue(data, ['utm_content', 'Content']);
    const utm_term = getFlexibleValue(data, ['utm_term', 'Term']);

    // Regra: Qualificado se faturamento for acima de R$ 50k (qualquer faixa exceto 'sub-50k' / 'Até R$ 50 mil')
    const isSub50k = String(faturamento).toLowerCase().includes('até r$ 50') || 
                     String(faturamento).toLowerCase().includes('sub-50k') || 
                     String(data.faturamento_key) === 'sub-50k';
    const isQualified = !isSub50k && Boolean(faturamento);

    console.log(`[KOR Upsell] Qualification: Name="${name}", Fat="${faturamento}", Socios="${socios}", isQualified=${isQualified}`);

    // 1. Salva no Google Sheets
    await saveToGoogleSheets('KOR Upsell', {
      nome: name,
      email: email,
      telefone: phone,
      cargo: cargo,
      faturamento: faturamento,
      socios: socios,
      qualificado: isQualified ? 'SIM (>= 50k)' : 'NÃO (< 50k)',
      utm_source: utm_source,
      utm_medium: utm_medium,
      utm_campaign: utm_campaign,
      utm_content: utm_content,
      utm_term: utm_term,
      data_envio: new Date().toISOString()
    });

    // 2. Busca Contato / Lead existente no Kommo CRM
    let existingContacts = [];
    if (email) {
      const contactSearch = await kommoRequest('GET', `/api/v4/contacts?query=${encodeURIComponent(email)}&with=leads`);
      existingContacts = contactSearch?._embedded?.contacts || [];
    }
    if (existingContacts.length === 0 && phone) {
      const cleanSearchPhone = phone.startsWith('55') && phone.length > 10 ? phone.substring(2) : phone;
      const contactSearch = await kommoRequest('GET', `/api/v4/contacts?query=${encodeURIComponent(cleanSearchPhone)}&with=leads`);
      existingContacts = contactSearch?._embedded?.contacts || [];
    }

    const leadCustomFields = [];
    if (faturamento) leadCustomFields.push({ field_id: 128886, values: [{ value: String(faturamento) }] });
    if (socios) leadCustomFields.push({ field_id: 128888, values: [{ value: String(socios) }] });
    if (cargo) leadCustomFields.push({ field_id: 128884, values: [{ value: String(cargo) }] });
    if (utm_source) leadCustomFields.push({ field_code: 'UTM_SOURCE', values: [{ value: utm_source }] });
    if (utm_campaign) leadCustomFields.push({ field_code: 'UTM_CAMPAIGN', values: [{ value: utm_campaign }] });
    if (utm_medium) leadCustomFields.push({ field_code: 'UTM_MEDIUM', values: [{ value: utm_medium }] });

    const newTags = ['KOR_Comprador', 'KOR_Upsell'];
    if (isQualified) {
      newTags.push('MQL', 'Upsell_Komando', 'KOR_Qualificado');
    } else {
      newTags.push('Downsell');
    }

    let updatedLeadId = null;

    if (existingContacts.length > 0) {
      const contact = existingContacts[0];
      const contactId = contact.id;
      console.log(`[KOR Upsell] Contact found in CRM: ID ${contactId}`);

      const linkedLeads = contact._embedded?.leads || [];
      if (linkedLeads.length > 0) {
        // Pega o lead mais recente associado
        const targetLeadRef = linkedLeads[linkedLeads.length - 1];
        const targetLead = await kommoRequest('GET', `/api/v4/leads/${targetLeadRef.id}`);

        if (targetLead) {
          updatedLeadId = targetLead.id;
          console.log(`[KOR Upsell] Updating existing Lead ID ${updatedLeadId} in CRM...`);

          const existingTags = targetLead._embedded?.tags?.map(t => t.name) || [];
          const combinedTags = Array.from(new Set([...existingTags, ...newTags]));

          await kommoRequest('PATCH', `/api/v4/leads/${updatedLeadId}`, {
            custom_fields_values: leadCustomFields,
            _embedded: {
              tags: combinedTags.map(tagName => ({ name: tagName }))
            }
          });
        }
      }
    }

    // Se não encontrou lead existente, cria um novo no funil KOR Inbound
    if (!updatedLeadId) {
      console.log('[KOR Upsell] Creating new lead in KOR Inbound for upsell submission...');
      const newLeadPayload = [
        {
          name: `[KOR UPSELL] ${name}`,
          pipeline_id: 14268556, // KOR Inbound
          status_id: 110184132,  // Contato inicial
          custom_fields_values: leadCustomFields,
          _embedded: {
            tags: newTags.map(tagName => ({ name: tagName })),
            contacts: [
              {
                name: name,
                custom_fields_values: [
                  ...(phone ? [{ field_code: 'PHONE', values: [{ value: String(phone), enum_code: 'WORK' }] }] : []),
                  ...(email ? [{ field_code: 'EMAIL', values: [{ value: String(email), enum_code: 'WORK' }] }] : [])
                ]
              }
            ]
          }
        }
      ];

      const createRes = await kommoRequest('POST', '/api/v4/leads/complex', newLeadPayload);
      updatedLeadId = createRes?.[0]?.id || createRes?._embedded?.leads?.[0]?.id;
    }

    // 3. Notificação Instantânea se Qualificado (WhatsApp Z-API + Telegram)
    if (isQualified && updatedLeadId) {
      const cleanPhone = phone.replace(/\D/g, '');
      const waLink = cleanPhone ? `https://wa.me/${cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone}` : 'Sem telefone';
      const domain = process.env.KOMMO_DOMAIN || 'chefkakagomes.kommo.com';
      const kommoLeadUrl = `https://${domain}/leads/detail/${updatedLeadId}`;

      const msg = `🔥 *NOVO COMPRADOR K.O.R QUALIFICADO PARA SESSÃO!*
      
👤 *Nome:* ${name}
📞 *WhatsApp:* ${phone || 'Não informado'}
✉️ *E-mail:* ${email || 'Não informado'}

📊 *Faturamento:* ${faturamento}
🤝 *Sócios:* ${socios}
💼 *Cargo:* ${cargo}

💬 *Chamar no WhatsApp:*
${waLink}

🔗 *Ver no Kommo CRM:*
${kommoLeadUrl}`;

      try {
        const kakaPhone = process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763';
        await sendZapi(kakaPhone, msg);
        await sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, msg);
      } catch (notifErr) {
        console.error('[KOR Upsell] Error sending notification:', notifErr.message);
      }
    }

    res.status(200).json({
      success: true,
      qualified: isQualified,
      message: 'KOR Upsell processed successfully',
      lead_id: updatedLeadId
    });
  } catch (err) {
    console.error('[KOR Upsell Webhook Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
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

// --- Vagas & Candidatos API ---

const CANDIDATOS_FILE_NAME = 'candidatos_vagas.json';

async function readCandidatos() {
  try {
    const dados = await lerCache(CANDIDATOS_FILE_NAME, []);
    return Array.isArray(dados) ? dados : [];
  } catch (err) {
    console.error('[Vagas API] Error reading candidatos:', err.message);
    return [];
  }
}

async function writeCandidatos(data) {
  try {
    await gravarCache(CANDIDATOS_FILE_NAME, data);
  } catch (err) {
    console.error('[Vagas API] Error writing candidatos:', err.message);
  }
}

app.options('/api/vagas-candidatura', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.post('/api/vagas-candidatura', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const cand = req.body || {};
    if (!cand.nome || !cand.telefone) {
      return res.status(400).json({ success: false, error: 'Nome e telefone são obrigatórios.' });
    }

    let list = await readCandidatos();
    
    cand.id = cand.id || ('cand_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4));
    cand.timestamp = cand.timestamp || new Date().toISOString();
    cand.status = cand.status || 'novo';

    list.unshift(cand);
    if (list.length > 500) list = list.slice(0, 500);

    await writeCandidatos(list);

    // Notificação Z-API / Telegram
    try {
      const cleanPh = (cand.telefone || '').replace(/\D/g, '');
      const msg = `🎯 *NOVA CANDIDATURA — GESTOR DE TRÁFEGO*\n` +
                  `👤 *Nome:* ${cand.nome}\n` +
                  `📱 *WhatsApp:* https://wa.me/55${cleanPh}\n` +
                  `⭐ *Score:* ${cand.score || 'N/A'}/100 (${cand.score_classificacao || 'Avaliando'})\n` +
                  `🧠 *DISC:* ${cand.disc_perfil_predominante || 'N/A'}\n` +
                  `💼 *Experiência:* ${cand.experiencia_infoprodutos || 'N/A'}\n` +
                  `💰 *Maior Budget:* ${cand.maior_budget || 'N/A'}\n` +
                  `🔗 *Portfólio:* ${cand.portfolio_link || 'N/A'}`;
      
      const kakaPhone = process.env.NOTIFICATION_WHATSAPP_NUMBER || '5511995235763';
      sendZapi(kakaPhone, msg).catch(() => {});
      sendTelegram(process.env.TELEGRAM_CHAT_ID_ERROR || process.env.TELEGRAM_CHAT_ID, msg).catch(() => {});
    } catch(e) {}

    res.json({ success: true, id: cand.id });
  } catch (err) {
    console.error('[Vagas API] Erro ao salvar candidatura:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.options('/api/vagas-candidatos', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.get('/api/vagas-candidatos', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const list = await readCandidatos();
    res.json({ success: true, data: list, total: list.length });
  } catch (err) {
    console.error('[Vagas API] Erro ao buscar candidatos:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/vagas-candidatos', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const id = req.body?.id || req.query?.id;
    const telefone = req.body?.telefone || req.query?.telefone;
    let list = await readCandidatos();
    if (id) {
      list = list.filter(c => c.id !== id);
    } else if (telefone) {
      const clean = telefone.replace(/\D/g, '');
      list = list.filter(c => (c.telefone || '').replace(/\D/g, '') !== clean);
    }
    await writeCandidatos(list);
    res.json({ success: true, total: list.length });
  } catch (err) {
    console.error('[Vagas API] Erro ao deletar candidato:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

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
