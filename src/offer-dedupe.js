const crypto = require('crypto');

/**
 * Política de notificación:
 *  - MIN_REPORT_SCORE: debajo de este match no se manda NADA al grupo (solo log).
 *  - MIN_AUTOAPPLY_SCORE: debajo de este match no se postula automáticamente.
 *  - DEDUPE_WINDOW_DAYS: ventana en días para considerar un aviso/contacto como "ya visto".
 */
const MIN_REPORT_SCORE = Number(process.env.MIN_REPORT_SCORE || 60);
const MIN_AUTOAPPLY_SCORE = Number(process.env.MIN_AUTOAPPLY_SCORE || 65);
const DEDUPE_WINDOW_DAYS = Number(process.env.DEDUPE_WINDOW_DAYS || 30);
const DEDUPE_WINDOW_MS = DEDUPE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Huella del texto del aviso: dos reposts idénticos (aunque cambie el id del portal
 * o el canal los vuelva a publicar) producen la misma huella.
 */
function textFingerprint(text) {
  const normalized = normalizeText(text);
  if (normalized.length < 25) return '';
  return crypto.createHash('sha1').update(normalized.slice(0, 900)).digest('hex');
}

/**
 * Huella del destino de la postulación: mismo contacto + mismo puesto.
 * No incluye la zona porque suele venir escrita distinto ("CABA", "CABA (Caba)", "Capital").
 */
function contactFingerprint(job = {}) {
  const contact = normalizeEmail(job.contactEmail) || normalizePhone(job.contactPhone);
  if (!contact) return '';
  return `${contact}|${normalizeText(job.title)}`;
}

function fingerprintsOf(record) {
  const job = record?.analysis?.jobDetails || {};
  return {
    text: record?.fingerprint?.text || textFingerprint(record?.rawText || ''),
    contact: record?.fingerprint?.contact || contactFingerprint(job)
  };
}

function isRecent(record) {
  const created = new Date(record?.createdAt || 0).getTime();
  if (!created) return false;
  return Date.now() - created <= DEDUPE_WINDOW_MS;
}

/**
 * Huella del flyer (imagen). Los avisos que son solo imagen no tienen texto ni
 * contacto que permita deduplicarlos, así que se usa el hash del archivo.
 */
function imageFingerprint(imageBuffer) {
  if (!imageBuffer || !imageBuffer.length) return '';
  return crypto.createHash('sha1').update(imageBuffer).digest('hex');
}

/**
 * Huellas persistentes en el set de "ofertas vistas" (Supabase), con fecha embebida
 * para que caduquen solas aunque el historial de 100 registros se recicle.
 */
function fingerprintSeenKey(prefix, key) {
  if (!key) return '';
  return `${prefix}:${key}:${Date.now()}`;
}

function hasFreshFingerprint(seen, prefix, key) {
  if (!key || !seen) return false;
  const head = `${prefix}:${key}:`;
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  for (const id of seen) {
    if (typeof id !== 'string' || !id.startsWith(head)) continue;
    const savedAt = Number(id.slice(head.length));
    if (!savedAt || savedAt >= cutoff) return true;
  }
  return false;
}

/** Mismo aviso ya procesado (misma huella de texto). */
function findDuplicateOffer({ text, history = [] }) {
  const textKey = textFingerprint(text);
  if (!textKey) return null;
  for (const item of history) {
    if (!isRecent(item)) continue;
    if (fingerprintsOf(item).text === textKey) return item;
  }
  return null;
}

/** Mismo contacto y mismo puesto ya procesado (aunque el texto venga redactado distinto). */
function findDuplicateByContact({ job, history = [] }) {
  const contactKey = contactFingerprint(job);
  if (!contactKey) return null;
  for (const item of history) {
    if (!isRecent(item)) continue;
    if (fingerprintsOf(item).contact === contactKey) return item;
  }
  return null;
}

/**
 * Contacto (email o teléfono) que ya se revisó y se descartó por match bajo varias veces.
 * Evita volver a avisar de lugares que no valen la pena, sin bloquear a la primera.
 */
const DISCARDED_CONTACT_MIN_HITS = Number(process.env.DISCARDED_CONTACT_MIN_HITS || 2);

/** Clave estable del contacto (sin puesto) para recordar que ya se descartó. */
function discardContactKey(job = {}) {
  return normalizeEmail(job.contactEmail) || normalizePhone(job.contactPhone);
}

function countDiscardedContacts({ job, history = [], minScore = MIN_REPORT_SCORE }) {
  const email = normalizeEmail(job.contactEmail);
  const phone = normalizePhone(job.contactPhone);
  if (!email && !phone) return 0;

  let hits = 0;
  for (const item of history) {
    if (!isRecent(item) || item.applied) continue;
    const score = Number(item.analysis?.matchScore || 0);
    if (score >= minScore) continue;
    const previous = item.analysis?.jobDetails || {};
    const sameEmail = email && normalizeEmail(previous.contactEmail) === email;
    const samePhone = phone && normalizePhone(previous.contactPhone) === phone;
    if (sameEmail || samePhone) hits++;
  }
  return hits;
}

function findDiscardedContact({ job, history = [], minScore = MIN_REPORT_SCORE }) {
  if (countDiscardedContacts({ job, history, minScore }) < DISCARDED_CONTACT_MIN_HITS) return null;
  const email = normalizeEmail(job.contactEmail);
  const phone = normalizePhone(job.contactPhone);
  return history.find((item) => {
    if (!isRecent(item) || item.applied) return false;
    if (Number(item.analysis?.matchScore || 0) >= minScore) return false;
    const previous = item.analysis?.jobDetails || {};
    return (email && normalizeEmail(previous.contactEmail) === email) ||
      (phone && normalizePhone(previous.contactPhone) === phone);
  }) || null;
}

module.exports = {
  MIN_REPORT_SCORE,
  MIN_AUTOAPPLY_SCORE,
  DEDUPE_WINDOW_DAYS,
  DISCARDED_CONTACT_MIN_HITS,
  normalizeText,
  normalizeEmail,
  normalizePhone,
  textFingerprint,
  contactFingerprint,
  imageFingerprint,
  discardContactKey,
  countDiscardedContacts,
  fingerprintSeenKey,
  hasFreshFingerprint,
  findDuplicateOffer,
  findDuplicateByContact,
  findDiscardedContact
};
