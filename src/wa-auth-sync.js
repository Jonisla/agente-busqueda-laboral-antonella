/**
 * Persistencia de la sesión de WhatsApp (Baileys) en Supabase Storage.
 *
 * Render (plan free) no tiene disco persistente: data/wa-auth se borra en cada
 * reinicio/deploy y WhatsApp vuelve a pedir QR. Este módulo espeja los archivos
 * de autenticación a un bucket privado de Supabase y los restaura al arrancar,
 * así el agente se reconecta solo sin escanear nada.
 */

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
const BUCKET = process.env.WA_AUTH_BUCKET || 'wa-auth';

const DEBOUNCE_MS = 1500;
const BATCH_SIZE = 6;

// name -> ruta del archivo local (o null para borrar en remoto)
const pending = new Map();
let timer = null;
let busy = false;
let bucketReady = false;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra
  };
}

function objectUrl(name) {
  return `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`;
}

async function ensureBucket() {
  if (!ENABLED) return false;
  if (bucketReady) return true;

  try {
    const listRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, { headers: headers() });
    if (!listRes.ok) throw new Error(`list buckets HTTP ${listRes.status}`);

    const buckets = await listRes.json();
    if (Array.isArray(buckets) && buckets.some((b) => b.id === BUCKET || b.name === BUCKET)) {
      bucketReady = true;
      return true;
    }

    const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
    });

    if (!createRes.ok) {
      throw new Error(`create bucket HTTP ${createRes.status} ${await createRes.text()}`);
    }

    console.log(`[WA-AUTH] Bucket "${BUCKET}" creado en Supabase`);
    bucketReady = true;
    return true;
  } catch (err) {
    console.error('[WA-AUTH] Error preparando bucket:', err.message);
    return false;
  }
}

async function listFiles() {
  const names = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        prefix: '',
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' }
      })
    });

    if (!res.ok) throw new Error(`list HTTP ${res.status} ${await res.text()}`);

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      if (row && row.name) names.push(row.name);
    }

    if (rows.length < limit) break;
    offset += limit;
  }

  return names;
}

async function downloadFile(name) {
  const res = await fetch(objectUrl(name), { headers: headers() });
  if (!res.ok) throw new Error(`download ${name} HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadFile(name, buffer) {
  const res = await fetch(objectUrl(name), {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': 'no-cache'
    }),
    body: buffer
  });

  if (!res.ok) throw new Error(`upload ${name} HTTP ${res.status} ${await res.text()}`);
}

async function deleteFile(name) {
  const res = await fetch(objectUrl(name), { method: 'DELETE', headers: headers() });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete ${name} HTTP ${res.status}`);
  }
}

/**
 * Descarga la sesión guardada en Supabase al directorio local.
 * Debe llamarse ANTES de useMultiFileAuthState().
 */
async function restoreAuthDir(dir) {
  fs.mkdirSync(dir, { recursive: true });

  if (!ENABLED) {
    console.log('[WA-AUTH] Supabase no configurado: la sesión quedará solo en disco local');
    return 0;
  }

  if (!(await ensureBucket())) return 0;

  try {
    const names = await listFiles();
    if (!names.length) {
      console.log('[WA-AUTH] Todavía no hay sesión guardada en Supabase');
      return 0;
    }

    let restored = 0;
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = names.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (name) => {
          const buffer = await downloadFile(name);
          fs.writeFileSync(path.join(dir, name), buffer);
        })
      );
      restored += results.filter((r) => r.status === 'fulfilled').length;
    }

    console.log(`[WA-AUTH] Sesión restaurada desde Supabase: ${restored}/${names.length} archivo(s)`);
    return restored;
  } catch (err) {
    console.error('[WA-AUTH] Error restaurando sesión:', err.message);
    return 0;
  }
}

function schedule() {
  if (!ENABLED || timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush().catch((err) => console.error('[WA-AUTH] Error en flush:', err.message));
  }, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
}

async function flush() {
  if (!ENABLED) return;
  if (busy) {
    schedule();
    return;
  }

  const entries = Array.from(pending.entries());
  if (!entries.length) return;

  pending.clear();
  busy = true;

  try {
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async ([name, filePath]) => {
          if (filePath === null) return deleteFile(name);
          const buffer = fs.readFileSync(filePath);
          return uploadFile(name, buffer);
        })
      );
    }
  } finally {
    busy = false;
    if (pending.size) schedule();
  }
}

/** Encola la subida de un archivo local de la sesión. */
function trackFile(dir, name) {
  if (!ENABLED || !name) return;
  pending.set(name, path.join(dir, name));
  schedule();
}

/** Encola el borrado remoto de un archivo de la sesión. */
function trackDelete(name) {
  if (!ENABLED || !name) return;
  pending.set(name, null);
  schedule();
}

/** Sube ya lo pendiente (útil al cerrar o al terminar un login). */
async function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

/** Borra toda la sesión remota (logout real / dispositivo desvinculado). */
async function clearRemoteAuth() {
  if (!ENABLED) return;
  pending.clear();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  try {
    if (!(await ensureBucket())) return;
    const names = await listFiles();
    if (!names.length) return;

    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = names.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((name) => deleteFile(name)));
    }
    console.log(`[WA-AUTH] Sesión remota eliminada (${names.length} archivo/s)`);
  } catch (err) {
    console.error('[WA-AUTH] Error borrando sesión remota:', err.message);
  }
}

module.exports = {
  ENABLED,
  BUCKET,
  restoreAuthDir,
  trackFile,
  trackDelete,
  flushNow,
  clearRemoteAuth
};
