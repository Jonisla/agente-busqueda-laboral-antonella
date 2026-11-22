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
 * Procesa una oferta (desde el panel web, desde un canal/grupo de WhatsApp o desde portales),
 * adapta el CV de Antonella, genera el PDF y la guarda en el historial.
 */
async function processNewOffer({ text = '', imageBuffer = null, imageMimeType = 'image/jpeg', source = 'Manual / Canal WA', includePhoto = true }) {
  const profile = loadProfile();

  // Deduplicación: no procesar la misma oferta dos veces
  const history = loadHistory();
  const titleMatch = text.match(/(?:Puesto|Búsqueda|Buscamos|Vacante)[:\s]*([^\n\r.]+)/i);
  const detectedTitle = titleMatch ? titleMatch[1].trim().toLowerCase().slice(0, 60) : '';
  if (detectedTitle) {
    const isDuplicate = history.some(h => {
      const existingTitle = (h.analysis?.jobDetails?.title || '').toLowerCase().slice(0, 60);
      const existingSource = h.source || '';
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

  const jobTitle = analysis?.jobDetails?.title || 'Recepcionista_Administrativa';
  const pdf = await generateTailoredPDF(profile, analysis.tailoredCV, jobTitle, { includePhoto });

  const record = {
    id: 'offer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    source,
    rawText: text,
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

  return record;
}

// Inicializar asistente de WhatsApp
const waAssistant = new WhatsAppJobAssistant({
  onOfferDetected: async ({ text, imageBuffer, imageMimeType, source }) => {
    console.log(`[WA] Nueva oferta detectada desde ${source}`);
    return await processNewOffer({ text, imageBuffer, imageMimeType, source, includePhoto: true });
  }
});

// --- ENDPOINTS API ---

app.get('/api/status', (req, res) => {
  const profile = loadProfile();
  res.json({
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    geminiKeyMasked: process.env.GEMINI_API_KEY
      ? process.env.GEMINI_API_KEY.slice(0, 6) + '...' + process.env.GEMINI_API_KEY.slice(-4)
      : '',
    hasGmailConfig: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
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

app.post('/api/whatsapp/send-record/:id', async (req, res) => {
  try {
    const history = loadHistory();
    const record = history.find((h) => h.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'Oferta no encontrada' });
    if (waAssistant.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp no está conectado. Escaneá el QR primero.' });
    }
    await waAssistant.sendReadyApplicationToUser(record);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3456;

// --- RADAR AUTOMÁTICO 24/7 EN SEGUNDO PLANO ---
const SEEN_PORTAL_IDS_PATH = path.join(__dirname, 'data', 'seen-portal-offers.json');

function loadSeenPortalIds() {
  try {
    if (fs.existsSync(SEEN_PORTAL_IDS_PATH)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_PORTAL_IDS_PATH, 'utf8')));
    }
  } catch (e) {}
  return new Set();
}

function saveSeenPortalIds(set) {
  fs.mkdirSync(path.dirname(SEEN_PORTAL_IDS_PATH), { recursive: true });
  fs.writeFileSync(SEEN_PORTAL_IDS_PATH, JSON.stringify(Array.from(set).slice(-300), null, 2));
}

async function runAutomaticRadarCycle() {
  if (waAssistant.status !== 'connected') return;
  try {
    const seen = loadSeenPortalIds();
    const offers = await fetchPortalOffers('all');
    let sentCount = 0;

    for (const of of offers) {
      if (seen.has(of.id)) continue;
      seen.add(of.id);

      // Procesamos hasta 2 ofertas nuevas por ciclo para no saturar WhatsApp
      if (sentCount < 2) {
        const fullDetail = of.url ? await fetchOfferDetail(of.url) : '';
        const combinedText = `Puesto: ${of.title}\nEmpresa: ${of.company}\nUbicación: ${of.location}\nDescripción: ${of.snippet}\n${fullDetail}`;
        const record = await processNewOffer({
          text: combinedText,
          source: `Radar Automático (${of.location || 'BA'})`,
          includePhoto: true
        });
        if (!record) continue;
        if (of.url && !record.analysis.jobDetails.applyUrl) {
          record.analysis.jobDetails.applyUrl = of.url;
        }
        if (record.analysis?.matchScore >= 70) {
          await waAssistant.sendReadyApplicationToUser(record);
          sentCount++;
        }
      }
    }
    saveSeenPortalIds(seen);
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

app.listen(PORT, async () => {
  console.log(`\n========================================================`);
  console.log(`🚀 Agente de Búsqueda Laboral (Antonella) corriendo en:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`========================================================\n`);

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
