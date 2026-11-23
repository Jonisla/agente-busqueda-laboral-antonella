const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

const SENT_CONTACTS_PATH = path.join(__dirname, '..', 'data', 'sent-contacts.json');
const SEEN_PORTAL_IDS_PATH = path.join(__dirname, '..', 'data', 'seen-portal-offers.json');

const sentCache = { phones: {}, emails: {} };
const seenCache = new Set();
const pushedSeen = new Set();

function readLocal(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {}
  return fallback;
}

function writeLocal(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {}
}

async function supabaseRequest(method, table, { query = '', body, prefer } = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${table}: HTTP ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

async function init() {
  const localSent = readLocal(SENT_CONTACTS_PATH, { phones: {}, emails: {} });
  Object.assign(sentCache.phones, localSent.phones || {});
  Object.assign(sentCache.emails, localSent.emails || {});
  readLocal(SEEN_PORTAL_IDS_PATH, []).forEach((id) => seenCache.add(id));

  if (!ENABLED) {
    console.log('[STORE] Supabase no configurado, usando archivos locales');
    return;
  }

  try {
    const rows = await supabaseRequest('GET', 'sent_contacts', { query: '?select=kind,value,sent_at' });
    for (const row of rows) {
      const bucket = row.kind === 'phone' ? sentCache.phones : sentCache.emails;
      bucket[row.value] = { sentAt: row.sent_at };
    }
    const seenRows = await supabaseRequest('GET', 'seen_offers', { query: '?select=id' });
    for (const row of seenRows) {
      seenCache.add(row.id);
      pushedSeen.add(row.id);
    }
    console.log(`[STORE] Cargados ${rows.length} contactos y ${seenRows.length} ofertas desde Supabase`);
  } catch (err) {
    console.error('[STORE] Error cargando desde Supabase:', err.message);
  }
}

function loadSentContacts() {
  return sentCache;
}

function saveSentContacts(data) {
  const newRows = [];
  for (const kind of ['emails', 'phones']) {
    const bucket = data[kind] || {};
    for (const value of Object.keys(bucket)) {
      if (!sentCache[kind][value]) {
        sentCache[kind][value] = bucket[value];
        newRows.push({
          kind: kind === 'emails' ? 'email' : 'phone',
          value,
          sent_at: bucket[value].sentAt || new Date().toISOString()
        });
      }
    }
  }

  writeLocal(SENT_CONTACTS_PATH, sentCache);

  if (ENABLED && newRows.length) {
    supabaseRequest('POST', 'sent_contacts', {
      body: newRows,
      prefer: 'resolution=merge-duplicates'
    }).catch((err) => console.error('[STORE] Error guardando contactos:', err.message));
  }
}

function loadSeenPortalIds() {
  return new Set(seenCache);
}

function saveSeenPortalIds(set) {
  const newIds = [];
  for (const id of set) {
    seenCache.add(id);
    if (!pushedSeen.has(id)) {
      pushedSeen.add(id);
      newIds.push({ id });
    }
  }

  writeLocal(SEEN_PORTAL_IDS_PATH, Array.from(seenCache).slice(-1000));

  if (ENABLED && newIds.length) {
    supabaseRequest('POST', 'seen_offers', {
      body: newIds,
      prefer: 'resolution=merge-duplicates'
    }).catch((err) => console.error('[STORE] Error guardando ofertas vistas:', err.message));
  }
}

module.exports = {
  init,
  loadSentContacts,
  saveSentContacts,
  loadSeenPortalIds,
  saveSeenPortalIds
};
