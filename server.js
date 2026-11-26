require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const { analyzeOfferAndTailorCV } = require('./src/ai-agent');
const { generateTailoredPDF, buildCVHtml } = require('./src/cv-generator');
const { SEARCH_QUERIES, fetchPortalOffers, fetchOfferDetail } = require('./src/portal-scraper');
const { WhatsAppJobAssistant } = require('./src/whatsapp-bot');
const { init: initStore, loadSeenPortalIds, saveSeenPortalIds } = require('./src/supabase-store');
const { loadSentContacts } = require('./src/auto-applicant');
const {
  MIN_REPORT_SCORE,
  DISCARDED_CONTACT_MIN_HITS,
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
} = require('./src/offer-dedupe');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROFILE_PATH = path.join(__dirname, 'data', 'antonella-profile.json');
const HISTORY_PATH = path.join(__dirname, 'data', 'offers-history.json');
const ENV_PATH = path.join(__dirname, '.env');

function loadProfile() {
  return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveHistory(list) {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(list.slice(0, 100), null, 2));
}

/**
 * Reconstruye el flag "applied" del historial usando los contactos ya enviados
 * (Supabase/local). Así los reportes y el panel reflejan la realidad histórica.
 */
function backfillAppliedFromContacts() {
  try {
    const contacts = loadSentContacts();
    const history = loadHistory();
    let changed = 0;
    for (const record of history) {
      if (record.applied) continue;
      const job = record.analysis?.jobDetails || {};
      const email = String(job.contactEmail || '').trim().toLowerCase();
      const phone = String(job.contactPhone || '').replace(/\D/g, '');
      const sentByEmail = email && contacts.emails && contacts.emails[email];
      const sentByPhone = phone && contacts.phones && contacts.phones[phone];
      if (sentByEmail || sentByPhone) {
        record.applied = true;
        record.appliedAt = (sentByEmail && sentByEmail.sentAt) || (sentByPhone && sentByPhone.sentAt) || new Date().toISOString();
        changed++;
      }
    }
    if (changed) {
      saveHistory(history);
      console.log(`[HISTORY] Backfill applied: ${changed} registro(s) marcados como enviados`);
    }
  } catch (e) {
    console.error('[HISTORY] Error en backfill applied:', e.message);
  }
}

/**
 * Procesa una oferta (desde el panel web, desde un canal/grupo de WhatsApp o desde portales),
 * adapta el CV de Antonella, genera el PDF y la guarda en el historial.
 */
async function processNewOffer({ text = '', imageBuffer = null, imageMimeType = 'image/jpeg', source = 'Manual / Canal WA', includePhoto = true }) {
  const profile = loadProfile();
  const existingHistory = loadHistory();
  const seen = loadSeenPortalIds();

  // Huellas persistentes (Supabase/local): sobreviven al deploy y al tope de 100 registros
  const textKey = textFingerprint(text);
  const imageKey = imageFingerprint(imageBuffer);
  if (hasFreshFingerprint(seen, 'fp:text', textKey)) {
    console.log('[DEDUP] Aviso ya procesado (misma huella de texto) - se ignora');
    return null;
  }
  if (hasFreshFingerprint(seen, 'fp:image', imageKey)) {
    console.log('[DEDUP] Flyer ya procesado (misma imagen) - se ignora');
    return null;
  }

  // Deduplicación por huella del aviso: si es el mismo texto que ya se procesó,
  // no se vuelve a generar CV ni a notificar al grupo.
  const duplicate = findDuplicateOffer({ text, history: existingHistory });
  if (duplicate) {
    console.log(`[DEDUP] Aviso ya procesado (${duplicate.id}, ${new Date(duplicate.createdAt).toLocaleString('es-AR')}) - se ignora`);
    return null;
  }

  // Deduplicación por título detectado (avisos parecidos con texto levemente distinto)
  const titleMatch = text.match(/(?:Puesto|Búsqueda|Buscamos|Vacante)[:\s]*([^\n\r.]+)/i);
  const detectedTitle = titleMatch ? titleMatch[1].trim().toLowerCase().slice(0, 60) : '';
  if (detectedTitle) {
    const isDuplicate = existingHistory.some(h => {
      const existingTitle = (h.analysis?.jobDetails?.title || '').toLowerCase().slice(0, 60);
      // Considerar duplicado si el título es muy similar y fue procesado en las últimas 24 horas
      const timeDiff = Date.now() - new Date(h.createdAt).getTime();
      return existingTitle.includes(detectedTitle.slice(0, 30)) && timeDiff < 24 * 60 * 60 * 1000;
    });
    if (isDuplicate) {
      console.log(`[DEDUP] Oferta duplicada detectada: "${detectedTitle}" - saltando procesamiento`);
      return null;
    }
  }

  const analysis = await analyzeOfferAndTailorCV({
    text,
    imageBuffer,
    imageMimeType,
    profile
  });

  const jobDetails = analysis?.jobDetails || {};
  const contactKey = contactFingerprint(jobDetails);
  const discardKey = discardContactKey(jobDetails);

  // Mismo contacto + mismo puesto ya procesado (aunque el texto venga redactado distinto)
  if (hasFreshFingerprint(seen, 'fp:contact', contactKey)) {
    console.log('[DEDUP] Mismo contacto y puesto ya procesados (huella persistida) - se ignora');
    return null;
  }
  const sameContact = findDuplicateByContact({ job: jobDetails, history: existingHistory });
  if (sameContact) {
    console.log(`[DEDUP] Mismo contacto y puesto ya procesados (${sameContact.id}) - se ignora`);
    return null;
  }

  // Contacto ya revisado y descartado por match bajo: no se vuelve a molestar
  if (hasFreshFingerprint(seen, 'fp:discard', discardKey)) {
    console.log('[DEDUP] Contacto ya descartado por match bajo (huella persistida) - se ignora');
    return null;
  }
  const discarded = findDiscardedContact({ job: jobDetails, history: existingHistory, minScore: MIN_REPORT_SCORE });
  if (discarded) {
    console.log(
      `[DEDUP] Contacto ya descartado por match bajo (${discarded.id}, ${discarded.analysis?.matchScore}%) - se ignora`
    );
    return null;
  }

  const jobTitle = jobDetails.title || 'Recepcionista_Administrativa';
  const pdf = await generateTailoredPDF(profile, analysis.tailoredCV, jobTitle, { includePhoto });

  const record = {
    id: 'offer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    source,
    rawText: text,
    fingerprint: {
      text: textKey,
      contact: contactKey,
      image: imageKey
    },
    analysis,
    profile,
    pdf: {
      fileName: pdf.fileName,
      filePath: pdf.filePath,
      publicUrl: pdf.publicUrl
    },
    applied: false
  };

  const history = loadHistory();
  history.unshift(record);
  saveHistory(history);

  // Persistir huellas (Supabase/local) para no volver a avisar del mismo aviso/contacto
  const textSeenKey = fingerprintSeenKey('fp:text', textKey);
  const contactSeenKey = fingerprintSeenKey('fp:contact', contactKey);
  const imageSeenKey = fingerprintSeenKey('fp:image', imageKey);
  if (textSeenKey) seen.add(textSeenKey);
  if (contactSeenKey) seen.add(contactSeenKey);
  if (imageSeenKey) seen.add(imageSeenKey);
  if (discardKey && Number(analysis?.matchScore || 0) < MIN_REPORT_SCORE) {
    const strikes = countDiscardedContacts({ job: jobDetails, history: existingHistory, minScore: MIN_REPORT_SCORE }) + 1;
    if (strikes >= DISCARDED_CONTACT_MIN_HITS) {
      seen.add(fingerprintSeenKey('fp:discard', discardKey));
      console.log(`[DEDUP] Contacto ${discardKey} bloqueado: ${strikes} avisos con match bajo`);
    }
  }
  saveSeenPortalIds(seen);

  return record;
}

// Inicializar asistente de WhatsApp
const waAssistant = new WhatsAppJobAssistant({
  onOfferDetected: async ({ text, imageBuffer, imageMimeType, source }) => {
    console.log(`[WA] Nueva oferta detectada desde ${source}`);
    return await processNewOffer({ text, imageBuffer, imageMimeType, source, includePhoto: true });
  }
});

// Estadísticas del radar que se muestran con "@verificar" en el grupo
const radarStats = { lastRun: null, lastNewOffers: 0, lastSent: 0, lastSkipped: 0, cycles: 0 };

waAssistant.getRuntimeStats = () => {
  let contacts = { emails: {}, phones: {} };
  try {
    contacts = loadSentContacts() || contacts;
  } catch (e) {}

  let history = [];
  try {
    history = loadHistory() || [];
  } catch (e) {}

  return {
    radarLastRun: radarStats.lastRun,
    radarNewOffers: radarStats.lastNewOffers,
    radarLastSent: radarStats.lastSent,
    radarSkipped: radarStats.lastSkipped,
    radarCycles: radarStats.cycles,
    seenOffers: loadSeenPortalIds().size,
    processedOffers: history.length,
    appliedOffers: history.filter((h) => h && h.applied).length,
    emailsSent: Object.keys(contacts.emails || {}).length,
    phonesSent: Object.keys(contacts.phones || {}).length,
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7)
  };
};

// --- ENDPOINTS API ---

app.get('/api/status', (req, res) => {
  const profile = loadProfile();
  res.json({
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    geminiKeyMasked: process.env.GEMINI_API_KEY
      ? process.env.GEMINI_API_KEY.slice(0, 6) + '...' + process.env.GEMINI_API_KEY.slice(-4)
      : '',
    hasGmailConfig: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    hasBrevoKey: Boolean(process.env.BREVO_API_KEY),
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7),
    gmailUser: process.env.GMAIL_USER || '',
    profile,
    whatsapp: waAssistant.getState(),
    portalCategories: SEARCH_QUERIES
  });
});

app.post('/api/config/gmail', (req, res) => {
  const { gmailUser, gmailAppPassword } = req.body;
  process.env.GMAIL_USER = (gmailUser || '').trim();
  process.env.GMAIL_APP_PASSWORD = (gmailAppPassword || '').replace(/\s+/g, '');

  let envContent = '';
  if (fs.existsSync(ENV_PATH)) {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
  }
  const lines = envContent
    .split('\n')
    .filter((l) => !l.startsWith('GMAIL_USER=') && !l.startsWith('GMAIL_APP_PASSWORD='));
  if (process.env.GMAIL_USER) lines.push(`GMAIL_USER=${process.env.GMAIL_USER}`);
  if (process.env.GMAIL_APP_PASSWORD) lines.push(`GMAIL_APP_PASSWORD=${process.env.GMAIL_APP_PASSWORD}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n').trim() + '\n');

  res.json({
    ok: true,
    hasGmailConfig: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  });
});

app.post('/api/config/gemini-key', (req, res) => {
  const { apiKey } = req.body;
  process.env.GEMINI_API_KEY = (apiKey || '').trim();

  let envContent = '';
  if (fs.existsSync(ENV_PATH)) {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
  }
  const lines = envContent.split('\n').filter((l) => !l.startsWith('GEMINI_API_KEY='));
  if (process.env.GEMINI_API_KEY) {
    lines.push(`GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n').trim() + '\n');

  res.json({ ok: true, hasGeminiKey: Boolean(process.env.GEMINI_API_KEY) });
});

app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

app.post('/api/history/:id/toggle-applied', (req, res) => {
  const history = loadHistory();
  const item = history.find((h) => h.id === req.params.id);
  if (item) {
    item.applied = !item.applied;
    saveHistory(history);
  }
  res.json({ ok: true, item });
});

app.delete('/api/history/:id', (req, res) => {
  const history = loadHistory().filter((h) => h.id !== req.params.id);
  saveHistory(history);
  res.json({ ok: true });
});

// Analizar aviso (texto y/o imagen de flyer) y generar CV PDF adaptado
app.post('/api/analyze', upload.single('flyer'), async (req, res) => {
  try {
    const text = req.body.text || '';
    const includePhoto = req.body.includePhoto !== 'false';
    const source = req.body.source || 'Canal de WhatsApp / Manual';
    const imageBuffer = req.file ? req.file.buffer : null;
    const imageMimeType = req.file ? req.file.mimetype : 'image/jpeg';

    if (!text.trim() && !imageBuffer) {
      return res.status(400).json({ error: 'Pegá el texto del aviso o subí la imagen/flyer del canal de WhatsApp.' });
    }

    const record = await processNewOffer({
      text,
      imageBuffer,
      imageMimeType,
      source,
      includePhoto
    });

    if (!record) {
      return res.status(200).json({ skipped: true, reason: 'Oferta duplicada - ya fue procesada anteriormente' });
    }

    res.json(record);
  } catch (err) {
    console.error('Error en /api/analyze:', err);
    res.status(500).json({ error: err.message });
  }
});

// Regenerar un CV editado manualmente por el usuario antes de enviarlo
app.post('/api/regenerate-cv/:id', async (req, res) => {
  try {
    const history = loadHistory();
    const record = history.find((h) => h.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'Oferta no encontrada' });

    const { tailoredCV, includePhoto = true } = req.body;
    if (tailoredCV) {
      record.analysis.tailoredCV = tailoredCV;
    }

    const profile = loadProfile();
    const pdf = await generateTailoredPDF(
      profile,
      record.analysis.tailoredCV,
      record.analysis.jobDetails?.title || 'Recepcionista',
      { includePhoto }
    );

    record.pdf = {
      fileName: pdf.fileName,
      filePath: pdf.filePath,
      publicUrl: pdf.publicUrl
    };
    saveHistory(history);

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vista previa HTML del CV base o de una oferta
app.get('/api/cv-preview', (req, res) => {
  const profile = loadProfile();
  const html = buildCVHtml(profile, null, { includePhoto: req.query.photo !== 'false' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Buscar ofertas en vivo en portales de Buenos Aires (CABA y GBA Oeste)
app.get('/api/portals/search', async (req, res) => {
  try {
    const queryId = req.query.category || 'all';
    const offers = await fetchPortalOffers(queryId);
    res.json({ offers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/portals/adapt', async (req, res) => {
  try {
    const { title, company, location, snippet, url } = req.body;
    const fullDetail = url ? await fetchOfferDetail(url) : '';
    const combinedText = `Puesto: ${title}\nEmpresa: ${company}\nUbicación: ${location}\nDescripción: ${snippet}\n${fullDetail}`;

    const record = await processNewOffer({
      text: combinedText,
      source: `Portal Web (${location || 'Buenos Aires'})`,
      includePhoto: true
    });

    if (!record) {
      return res.status(200).json({ skipped: true, reason: 'Oferta duplicada - ya fue procesada anteriormente' });
    }

    if (url && !record.analysis.jobDetails.applyUrl) {
      record.analysis.jobDetails.applyUrl = url;
    }

    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINTS WHATSAPP ---
app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    const state = await waAssistant.start();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  const state = await waAssistant.disconnect();
  res.json(state);
});

app.get('/api/whatsapp/state', (req, res) => {
  res.json(waAssistant.getState());
});

app.post('/api/whatsapp/toggle-chat', (req, res) => {
  const { chatId, enabled, name } = req.body;
  const state = waAssistant.toggleChatMonitor(chatId, Boolean(enabled), name);
  res.json(state);
});

app.post('/api/whatsapp/config', (req, res) => {
  const { notifyNumber, autoMonitorKeywords, autoApplyEnabled } = req.body;
  if (notifyNumber) {
    waAssistant.notifyNumber = String(notifyNumber)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
  }
  if (typeof autoMonitorKeywords === 'boolean') waAssistant.autoMonitorKeywords = autoMonitorKeywords;
  if (typeof autoApplyEnabled === 'boolean') waAssistant.autoApplyEnabled = autoApplyEnabled;
  waAssistant.saveConfig();
  res.json(waAssistant.getState());
});

app.post('/api/whatsapp/add-channel', async (req, res) => {
  try {
    const { url, name } = req.body;
    const added = await waAssistant.followChannelByCodeOrUrl(url, name || 'Canal Empleos BA');
    res.json({ ok: true, added, state: waAssistant.getState() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Endpoint de prueba para enviar email
app.post('/api/test-email', async (req, res) => {
  try {
    const { sendEmailApplication } = require('./src/auto-applicant');
    const profile = loadProfile();
    const result = await sendEmailApplication({
      toEmail: req.body.toEmail || 'afernand1995@gmail.com',
      subject: 'Prueba de email desde Render',
      bodyText: 'Este es un email de prueba para verificar que el envío funciona en Render.',
      pdfPath: null,
      pdfFileName: null,
      profile
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send-record/:id', async (req, res) => {
  try {
    const history = loadHistory();
    const record = history.find((h) => h.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'Oferta no encontrada' });
    if (waAssistant.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp no está conectado. Escaneá el QR primero.' });
    }
    console.log(`[API] send-record llamado para ${req.params.id}, score=${record.analysis?.matchScore}, autoApply=${waAssistant.autoApplyEnabled}`);
    await waAssistant.sendReadyApplicationToUser(record);
    console.log(`[API] send-record completado para ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3456;

// --- RADAR AUTOMÁTICO 24/7 EN SEGUNDO PLANO ---
function normalizeOfferPart(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function offerDedupKey(of) {
  return `key:${normalizeOfferPart(of.title)}|${normalizeOfferPart(of.company)}|${normalizeOfferPart(of.location)}`;
}

// El radar solo avisa al grupo ofertas con buen match; el resto se descarta en silencio
// (processNewOffer ya deduplica avisos y contactos repetidos).
const MIN_RADAR_SCORE = Number(process.env.MIN_RADAR_SCORE || 70);

async function runAutomaticRadarCycle() {
  if (waAssistant.status !== 'connected') return;
  try {
    const seen = loadSeenPortalIds();
    const offers = await fetchPortalOffers('all');
    let sentCount = 0;
    let newOffers = 0;
    let skipped = 0;

    for (const of of offers) {
      const dedupKey = offerDedupKey(of);
      if (seen.has(of.id) || seen.has(dedupKey)) continue;
      seen.add(of.id);
      seen.add(dedupKey);
      newOffers++;
      saveSeenPortalIds(seen);

      // Procesamos hasta 2 ofertas nuevas por ciclo para no saturar WhatsApp
      if (sentCount >= 2) continue;

      const fullDetail = of.url ? await fetchOfferDetail(of.url) : '';
      const combinedText = `Puesto: ${of.title}\nEmpresa: ${of.company}\nUbicación: ${of.location}\nDescripción: ${of.snippet}\n${fullDetail}`;
      const record = await processNewOffer({
        text: combinedText,
        source: `Radar Automático (${of.location || 'BA'})`,
        includePhoto: true
      });

      // null = aviso duplicado o contacto ya descartado: no se avisa nada
      if (!record) {
        skipped++;
        continue;
      }
      if (of.url && !record.analysis.jobDetails.applyUrl) {
        record.analysis.jobDetails.applyUrl = of.url;
      }

      const score = Number(record.analysis?.matchScore || 0);
      if (score >= MIN_RADAR_SCORE) {
        await waAssistant.sendReadyApplicationToUser(record);
        sentCount++;
      } else {
        skipped++;
        console.log(`[RADAR] Descartada sin notificar (match ${score}% < ${MIN_RADAR_SCORE}%): ${of.title}`);
      }
    }
    saveSeenPortalIds(seen);

    radarStats.lastRun = Date.now();
    radarStats.lastNewOffers = newOffers;
    radarStats.lastSent = sentCount;
    radarStats.lastSkipped = skipped;
    radarStats.cycles++;
    if (skipped > 0) {
      console.log(`[RADAR] Ciclo #${radarStats.cycles}: ${newOffers} nuevas, ${sentCount} notificadas, ${skipped} descartadas`);
    }
  } catch (err) {
    console.error('Error en ciclo de Radar Automático:', err.message);
  }
}

// Ejecutar radar automático cada 5 minutos
setInterval(runAutomaticRadarCycle, 5 * 60 * 1000);

// Mantener despierto el servidor en Render (ping cada 5 minutos)
setInterval(async () => {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || 'https://agente-busqueda-laboral-antonella.onrender.com';
  if (externalUrl) {
    try {
      await fetch(`${externalUrl}/api/status`);
    } catch (e) {}
  }
}, 5 * 60 * 1000);

// Latido automático en el grupo para saber que el bot sigue vivo (12 h por defecto)
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS || 12);
if (HEARTBEAT_HOURS > 0) {
  setInterval(async () => {
    if (waAssistant.status !== 'connected') return;
    try {
      await waAssistant.sendTextToNotify(waAssistant.buildStatusReport());
      console.log('[WA] Latido de estado enviado al grupo');
    } catch (e) {
      console.error('Error enviando latido al grupo:', e.message);
    }
  }, HEARTBEAT_HOURS * 60 * 60 * 1000);
}

app.listen(PORT, async () => {
  await initStore();
  backfillAppliedFromContacts();
  console.log(`\n========================================================`);
  console.log(`🚀 Agente de Búsqueda Laboral (Antonella) corriendo en:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`========================================================\n`);

  // Reconectar WhatsApp automáticamente al arrancar (la sesión se restaura desde Supabase).
  // Si no hay sesión guardada, queda en estado "qr" esperando el escaneo.
  waAssistant.start().catch((e) => console.error('[WA] No se pudo iniciar automáticamente:', e.message));

  // Si todavía no hay ejemplos en el historial, generamos el CV maestro optimizado de muestra
  const history = loadHistory();
  if (history.length === 0) {
    try {
      const exampleResult = await processNewOffer({
        text: `BÚSQUEDA ACTIVA - CENTRO MÉDICO EN RAMOS MEJÍA / CABA
Buscamos Recepcionista / Admisión de Pacientes para clínica y consultorios externos.
Tareas: Recepción de pacientes, validación de obras sociales y prepagas, asignación de turnos, carga de datos en sistema y atención telefónica.
Zona: Ramos Mejía / Liniers (a metros de estación).
Enviar CV actualizado por mail a rrhh.centromedico@gmail.com con ASUNTO: RECEPCIONISTA SALUD o por WhatsApp al 11-4455-6677.`,
        source: 'Ejemplo Canal Bolsa de Trabajo BA',
        includePhoto: true
      });
      if (exampleResult) {
        console.log('✅ CV Maestro inicial de muestra generado con éxito.');
      }
    } catch (e) {
      console.error('Error generando ejemplo inicial:', e.message);
    }
  }
});
