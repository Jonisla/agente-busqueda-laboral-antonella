const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const {
  sendEmailApplication,
  loadSentContacts,
  saveSentContacts,
  BLOCKED_PHONES,
  alreadyContactedInHistory
} = require('./auto-applicant');

const {
  restoreAuthDir,
  trackFile,
  trackDelete,
  flushNow,
  clearRemoteAuth
} = require('./wa-auth-sync');

// Baileys guarda cada llave como "<tipo>-<id>.json" saneando "/" y ":"
const fixFileName = (file) => String(file || '').replace(/\//g, '__').replace(/:/g, '-');

const DEFAULT_BA_CHANNELS = [
  {
    name: 'EMPLEOS ARGENTINA (CABA, Ciudadela y GBA)',
    code: '0029VbBm7Ab5a24BnFW9rw3b',
    url: 'https://whatsapp.com/channel/0029VbBm7Ab5a24BnFW9rw3b'
  },
  {
    name: 'C.A.O.L. Empleos AMBA Oeste BsAs',
    code: '0029Vb7F3kE7tkjFV8DMI92a',
    url: 'https://whatsapp.com/channel/0029Vb7F3kE7tkjFV8DMI92a'
  },
  {
    name: 'Café y RRHH (Empleos Zona Oeste y GBA)',
    code: '0029Vb6Jl6JKrWQrPOC1VD2D',
    url: 'https://whatsapp.com/channel/0029Vb6Jl6JKrWQrPOC1VD2D'
  },
  {
    name: 'Empleos CABA - GBA (Contacto Directo)',
    code: '0029Vb83szT545v4nDoM973u',
    url: 'https://whatsapp.com/channel/0029Vb83szT545v4nDoM973u'
  },
  {
    name: 'Busca y Encontrá — Empleos CABA y GBA',
    code: '0029Vb4PJWwAzNbzehTAaJ1L',
    url: 'https://whatsapp.com/channel/0029Vb4PJWwAzNbzehTAaJ1L'
  },
  {
    name: 'Atención al Cliente y Empleos CABA',
    code: '0029Vb63wuI4CrfoPU9Kl61n',
    url: 'https://whatsapp.com/channel/0029Vb63wuI4CrfoPU9Kl61n'
  },
  {
    name: 'Búsquedas Laborales CABA y PBA',
    code: '0029VbA6KUn0lwgwbmehUA2g',
    url: 'https://whatsapp.com/channel/0029VbA6KUn0lwgwbmehUA2g'
  },
  {
    name: 'Laburo y Estudio — Vacantes GBA y CABA',
    code: '0029Vasef0J2ZjCnWbWLYb1T',
    url: 'https://whatsapp.com/channel/0029Vasef0J2ZjCnWbWLYb1T'
  },
  {
    name: 'Recursos Humanos en Argentina (Vacantes)',
    code: '0029Vb7k5tWH5JLpEfTVui2j',
    url: 'https://whatsapp.com/channel/0029Vb7k5tWH5JLpEfTVui2j'
  },
  {
    name: 'Bolsa de Trabajo de Argentina (AMBA / CABA)',
    code: '0029VaKrYMRFsn0hi3yTds1Z',
    url: 'https://whatsapp.com/channel/0029VaKrYMRFsn0hi3yTds1Z'
  },
  {
    name: 'Avisos de Empleo CABA',
    code: '0029VbCr3VUJENy0DD6sk01K',
    url: 'https://whatsapp.com/channel/0029VbCr3VUJENy0DD6sk01K'
  },
  {
    name: 'CV By Sol | Empleos Argentina (AMBA)',
    code: '0029VbCpYbg1Hspteu34Yf1C',
    url: 'https://whatsapp.com/channel/0029VbCpYbg1Hspteu34Yf1C'
  },
  {
    name: 'Empleos de Hoy (Argentina)',
    code: '0029VaFOyZz002T7tDo1va1M',
    url: 'https://whatsapp.com/channel/0029VaFOyZz002T7tDo1va1M'
  },
  {
    name: 'Argentina Jobs (Difusión Laboral)',
    code: '0029VaoTd6DFsn0Zy5b9R00w',
    url: 'https://whatsapp.com/channel/0029VaoTd6DFsn0Zy5b9R00w'
  },
  {
    name: 'Búsquedas HR - Argentina',
    code: '0029Vb3VL71C1FuHz2YnV02F',
    url: 'https://whatsapp.com/channel/0029Vb3VL71C1FuHz2YnV02F'
  }
];

class WhatsAppJobAssistant {
  constructor({ onOfferDetected }) {
    this.onOfferDetected = onOfferDetected;
    this.sock = null;
    this.status = 'disconnected'; // disconnected | qr | connected | connecting
    this.qrDataUrl = null;
    this.connectedUser = null;
    this.monitoredChats = new Map(); // id -> { id, name, type, enabled }
    this.sentMessageIds = new Set(); // IDs de mensajes enviados por el propio bot para jamás procesarlos
    this.lastProcessedText = '';
    this.lastProcessedTime = 0;
    this.authDir = path.join(__dirname, '..', 'data', 'wa-auth');
    this.configPath = path.join(__dirname, '..', 'data', 'wa-config.json');
    this.reconnectTimer = null;
    this.starting = null;
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (Array.isArray(raw.monitoredIds)) {
          this.savedMonitoredIds = new Set(raw.monitoredIds);
        } else {
          this.savedMonitoredIds = new Set();
        }
        this.autoMonitorKeywords = raw.autoMonitorKeywords !== false;
        this.autoApplyEnabled = raw.autoApplyEnabled !== false;
        this.notifyNumber = raw.notifyNumber || '120363415618148219@g.us';
      } else {
        this.savedMonitoredIds = new Set(['120363415618148219@g.us']);
        this.autoMonitorKeywords = true;
        this.autoApplyEnabled = true;
        this.notifyNumber = '120363415618148219@g.us';
      }
    } catch (e) {
      this.savedMonitoredIds = new Set(['120363415618148219@g.us']);
      this.autoMonitorKeywords = true;
      this.autoApplyEnabled = true;
      this.notifyNumber = '120363415618148219@g.us';
    }
  }

  saveConfig() {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(
          {
            monitoredIds: Array.from(this.savedMonitoredIds),
            autoMonitorKeywords: this.autoMonitorKeywords,
            autoApplyEnabled: this.autoApplyEnabled,
            notifyNumber: this.notifyNumber
          },
          null,
          2
        )
      );
    } catch (e) {
      console.error('Error guardando config WA:', e.message);
    }
  }

  getState() {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      connectedUser: this.connectedUser,
      notifyNumber: this.notifyNumber,
      autoMonitorKeywords: this.autoMonitorKeywords,
      autoApplyEnabled: this.autoApplyEnabled,
      monitoredChats: Array.from(this.monitoredChats.values())
    };
  }

  /**
   * Reporte de estado que se responde en el grupo al escribir "@verificar".
   * Los datos del radar los inyecta server.js con getRuntimeStats().
   */
  buildStatusReport() {
    const stats = (this.getRuntimeStats && this.getRuntimeStats()) || {};
    const seconds = Math.floor(process.uptime());
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const uptime = [days ? `${days}d` : null, hours ? `${hours}h` : null, `${minutes}m`]
      .filter(Boolean)
      .join(' ');

    const memory = Math.round(process.memoryUsage().rss / 1024 / 1024);

    let lastRadar = 'todavía sin ciclos';
    if (stats.radarLastRun) {
      lastRadar = new Date(stats.radarLastRun).toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    const connected = this.status === 'connected';
    const number = this.connectedUser?.id ? this.connectedUser.id.split(':')[0] : '—';

    const lines = [
      '🟢 *BOT ACTIVO Y FUNCIONANDO*',
      '',
      `⏱ Encendido hace: *${uptime}*`,
      `${connected ? '📱' : '🔴'} WhatsApp: *${connected ? `conectado (${number})` : this.status}*`,
      `🛰 Último ciclo del radar: *${lastRadar}*`,
      `🔎 Ofertas vistas en total: *${stats.seenOffers ?? 0}*`,
      `📄 Ofertas procesadas: *${stats.processedOffers ?? 0}* · CVs enviados: *${stats.appliedOffers ?? 0}*`,
      `📬 Reclutadores contactados: *${stats.emailsSent ?? 0}* mails · *${stats.phonesSent ?? 0}* WhatsApp`,
      `💾 Memoria: *${memory} MB*`
    ];

    if (stats.commit) lines.push(`🔖 Versión: *${stats.commit}*`);
    lines.push('', '_Escribí "@verificar" cuando quieras para volver a chequear._');

    return lines.join('\n');
  }

  /** Envía un texto plano al chat/grupo de reportes (sin CV). */
  async sendTextToNotify(text) {
    if (!this.sock || this.status !== 'connected') return false;

    const targets = String(this.notifyNumber || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let delivered = false;

    for (const target of targets) {
      const jid = target.includes('@') ? target : `${target.replace(/\D/g, '')}@s.whatsapp.net`;
      try {
        const sent = await this.sock.sendMessage(jid, { text });
        if (sent?.key?.id) this.sentMessageIds.add(sent.key.id);
        delivered = true;
      } catch (e) {
        console.error(`Error enviando mensaje a ${jid}:`, e.message);
      }
    }

    // Si no se pudo entregar en el grupo, mandarlo al chat propio para no perder el aviso
    if (!delivered && this.sock.user?.id) {
      try {
        const sent = await this.sock.sendMessage(this.sock.user.id, { text });
        if (sent?.key?.id) this.sentMessageIds.add(sent.key.id);
        delivered = true;
      } catch (e) {
        console.error('No se pudo enviar el aviso al chat propio:', e.message);
      }
    }

    return delivered;
  }

  async start() {
    if (this.starting) return this.starting;
    if (
      this.status === 'connecting' ||
      this.status === 'connected' ||
      this.status === 'qr'
    ) {
      // Ya hay un socket activo (aunque esté esperando escaneo): no abrir otro
      return this.getState();
    }

    this.starting = this._start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async _start() {
    this.status = 'connecting';
    fs.mkdirSync(this.authDir, { recursive: true });

    // Restaurar la sesión guardada en Supabase ANTES de leer credenciales locales
    try {
      await restoreAuthDir(this.authDir);
    } catch (e) {
      console.error('[WA-AUTH] No se pudo restaurar la sesión:', e.message);
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // Espejar a Supabase cada cambio de credenciales y de llaves
    const persistKey = (type, id, value) => {
      const name = fixFileName(`${type}-${id}.json`);
      if (value === null || value === undefined) trackDelete(name);
      else trackFile(this.authDir, name);
    };

    const originalKeysSet = state.keys.set.bind(state.keys);
    state.keys.set = async (data) => {
      await originalKeysSet(data);
      try {
        for (const type of Object.keys(data || {})) {
          const bucket = data[type] || {};
          for (const id of Object.keys(bucket)) persistKey(type, id, bucket[id]);
        }
      } catch (e) {
        console.error('[WA-AUTH] Error encolando llaves:', e.message);
      }
    };

    const originalSaveCreds = saveCreds;
    const persistCreds = async () => {
      await originalSaveCreds();
      trackFile(this.authDir, 'creds.json');
    };
    const silentLogger = pino({ level: 'silent' });
    let version = [2, 3000, 1023223821];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) version = latest.version;
    } catch (e) {}

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger)
      },
      logger: silentLogger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    this.sock.ev.on('creds.update', persistCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.status = 'qr';
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
      }

      if (connection === 'open') {
        this.status = 'connected';
        this.qrDataUrl = null;
        this.connectedUser = {
          id: this.sock.user?.id,
          name: this.sock.user?.name || 'WhatsApp Conectado'
        };
        console.log('WhatsApp conectado como:', this.connectedUser.id);
        // Asegurar que la sesión quede guardada en Supabase cuanto antes
        flushNow().catch(() => {});
        await this.refreshGroups();
        this.subscribeDefaultChannels();
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        this.status = 'disconnected';
        this.qrDataUrl = null;
        this.connectedUser = null;

        if (statusCode === DisconnectReason.loggedOut) {
          try {
            fs.rmSync(this.authDir, { recursive: true, force: true });
          } catch (e) {}
          // El dispositivo fue desvinculado: borrar también la sesión remota
          clearRemoteAuth().catch(() => {});
          console.log('[WA] Sesión cerrada por WhatsApp (loggedOut). Se requiere escanear QR nuevamente.');
        } else if (shouldReconnect) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.start();
          }, 4000);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        try {
          await this.handleIncomingMessage(msg);
        } catch (err) {
          console.error('Error procesando mensaje WA:', err.message);
        }
      }
    });

    return this.getState();
  }

  async refreshGroups() {
    if (!this.sock || this.status !== 'connected') return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [id, meta] of Object.entries(groups)) {
        const subject = meta.subject || id;
        this.monitoredChats.set(id, {
          id,
          name: subject,
          type: 'group',
          enabled: this.savedMonitoredIds.has(id)
        });

        // Auto-detectar el grupo de reportes si su nombre refiere a Antonella
        // (ej: "Empleos Anto", "Búsqueda laboral Anto", "Trabajo Anto")
        const looksLikeAntoGroup =
          /anto/i.test(subject) && /empleo|laburo|trabajo|cv|b[uú]squeda/i.test(subject);
        if (looksLikeAntoGroup && id !== this.notifyNumber) {
          this.notifyNumber = id;
          this.saveConfig();
          console.log(`🎯 Grupo exclusivo detectado automáticamente: "${subject}" (${id})`);
        }
      }
    } catch (e) {
      console.error('No se pudieron listar grupos:', e.message);
    }

    // Aviso si el grupo de reportes configurado no está entre los grupos de esta cuenta
    if (
      this.notifyNumber &&
      this.notifyNumber.endsWith('@g.us') &&
      !this.monitoredChats.has(this.notifyNumber)
    ) {
      console.warn(
        `[WA] El grupo de reportes (${this.notifyNumber}) no está en esta cuenta. ` +
          'Agregá este número al grupo "Empleos Anto" o configurá otro desde el panel.'
      );
    }
  }

  /**
   * Se suscribe automáticamente a los Canales de WhatsApp de Bolsas de Trabajo de Buenos Aires (AMBA Oeste / CABA)
   */
  async subscribeDefaultChannels() {
    if (!this.sock || this.status !== 'connected') return;
    for (const ch of DEFAULT_BA_CHANNELS) {
      try {
        await this.followChannelByCodeOrUrl(ch.code, ch.name);
      } catch (e) {
        console.warn(`No se pudo vincular canal ${ch.name}:`, e.message);
      }
    }
  }

  async followChannelByCodeOrUrl(inputUrlOrCode, fallbackName = 'Canal Empleos BA') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp no está conectado todavía.');
    }
    const raw = String(inputUrlOrCode || '').trim();
    const match = raw.match(/channel\/([A-Za-z0-9]+)/i);
    const code = match ? match[1] : raw.replace(/[^A-Za-z0-9]/g, '');
    if (!code) throw new Error('Código de canal inválido.');

    let jid = null;
    let name = fallbackName;

    if (typeof this.sock.newsletterMetadata === 'function') {
      const meta = await this.sock.newsletterMetadata('invite', code);
      jid = meta?.id;
      name = meta?.thread_metadata?.name?.text || meta?.name || fallbackName;
    }

    if (jid) {
      if (typeof this.sock.newsletterFollow === 'function') {
        try {
          await this.sock.newsletterFollow(jid);
        } catch (e) {}
      }
      this.savedMonitoredIds.add(jid);
      this.monitoredChats.set(jid, {
        id: jid,
        name: `📢 ${name}`,
        type: 'channel',
        url: `https://whatsapp.com/channel/${code}`,
        enabled: true
      });
      this.saveConfig();
      console.log(`✅ Canal de WhatsApp activo: ${name} (${jid})`);
      return { id: jid, name, code };
    }
    return null;
  }

  toggleChatMonitor(chatId, enabled, name = '') {
    if (enabled) {
      this.savedMonitoredIds.add(chatId);
    } else {
      this.savedMonitoredIds.delete(chatId);
    }
    const existing = this.monitoredChats.get(chatId) || {
      id: chatId,
      name: name || chatId,
      type: chatId.endsWith('@newsletter') ? 'channel' : 'group'
    };
    existing.enabled = enabled;
    this.monitoredChats.set(chatId, existing);
    this.saveConfig();
    return this.getState();
  }

  async handleIncomingMessage(msg) {
    if (!msg.message) return;
    const msgId = msg.key?.id;
    if (msgId && this.sentMessageIds.has(msgId)) return;

    const remoteJid = msg.key.remoteJid || '';
    if (remoteJid === 'status@broadcast') return;

    // Ignorar siempre documentos (como los PDFs que envía el bot)
    if (msg.message.documentMessage || msg.message.documentWithCaptionMessage) return;

    // Extraer texto del mensaje o caption de imagen
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    const hasImage = Boolean(msg.message.imageMessage);

    // Registrar el canal o grupo si aparece en el tráfico
    if (remoteJid.endsWith('@newsletter') || remoteJid.endsWith('@g.us')) {
      if (!this.monitoredChats.has(remoteJid)) {
        this.monitoredChats.set(remoteJid, {
          id: remoteJid,
          name: msg.pushName || (remoteJid.endsWith('@newsletter') ? `Canal (${remoteJid.slice(0, 10)})` : remoteJid),
          type: remoteJid.endsWith('@newsletter') ? 'channel' : 'group',
          enabled: this.savedMonitoredIds.has(remoteJid)
        });
      }
    }

    // Evitar cualquier mensaje generado por el propio bot
    if (
      text.includes('🎯 *MATCH LABORAL PARA ANTONELLA*') ||
      text.includes('CV adaptado para:') ||
      text.includes('POSTULAR POR WHATSAPP (1 CLIC)') ||
      text.includes('Abajo te adjunto el CV en PDF')
    ) {
      return;
    }

    // Si en el grupo Empleos Anto pegan un link de Canal de WhatsApp (https://whatsapp.com/channel/...), lo agregamos automáticamente
    const channelLinkMatch = text.match(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9]+)/i);
    if (channelLinkMatch && (remoteJid.endsWith('@g.us') || msg.key.fromMe)) {
      try {
        const added = await this.followChannelByCodeOrUrl(channelLinkMatch[1], 'Nuevo Canal de Empleos');
        if (added) {
          const confirmMsg = await this.sock.sendMessage(remoteJid, {
            text: `✅ *Canal de Bolsa de Trabajo agregado y monitoreado en vivo:*\n📢 *${added.name}*\nApenas publiquen una oferta para Antonella, les mando el CV adaptado acá.`
          });
          if (confirmMsg?.key?.id) this.sentMessageIds.add(confirmMsg.key.id);
        }
      } catch (e) {
        console.error('Error agregando canal por link:', e.message);
      }
      return;
    }

    // Comando de estado: "@verificar", "!estado", "#ping" → responde con el reporte del bot
    const isStatusCommand = /(^|\s)[@!#/](verificar|estado|status|ping)\b/i.test(text);
    if (isStatusCommand && (remoteJid.endsWith('@g.us') || msg.key.fromMe)) {
      try {
        const report = this.buildStatusReport();
        const sent = await this.sock.sendMessage(remoteJid, { text: report });
        if (sent?.key?.id) this.sentMessageIds.add(sent.key.id);
      } catch (e) {
        console.error('Error respondiendo @verificar:', e.message);
      }
      return;
    }

    // En chats personales, SOLO procesar si el usuario puso explícitamente #cv / #empleo
    // En el Grupo Exclusivo de Alertas (de Joni y Anto), procesar cualquier oferta o flyer que reenvíen ahí
    // En Canales/Grupos de bolsas de trabajo monitoreados, procesar cuando parece oferta laboral
    const isDedicatedAlertGroup =
      remoteJid.endsWith('@g.us') && String(this.notifyNumber || '').includes(remoteJid);
    const hasTriggerTag = /#cv|#empleo|#oferta/i.test(text);
    const isMonitoredChannelOrGroup =
      this.savedMonitoredIds.has(remoteJid) ||
      (remoteJid.endsWith('@newsletter') && this.autoMonitorKeywords);

    const looksLikeJobOffer =
      /cv|curriculum|currículum|buscamos|búsqueda|busqueda|recepcionista|administrativ|secretaria|admisión|admision|atención al cliente|data entry|vacante|puesto|enviar mail|asunto|horario|remuneración|sueldo|zona/i.test(
        text
      ) ||
      ((isMonitoredChannelOrGroup || isDedicatedAlertGroup) && hasImage);

    const shouldProcess =
      hasTriggerTag ||
      (isDedicatedAlertGroup && looksLikeJobOffer) ||
      (isMonitoredChannelOrGroup && (remoteJid.endsWith('@newsletter') || remoteJid.endsWith('@g.us')) && looksLikeJobOffer);

    if (!shouldProcess) return;

    // Anti-duplicado si llega el mismo aviso dos veces seguidas en menos de 60 segundos
    const fingerprint = (text || 'img').slice(0, 120);
    if (fingerprint === this.lastProcessedText && Date.now() - this.lastProcessedTime < 60000) {
      return;
    }
    this.lastProcessedText = fingerprint;
    this.lastProcessedTime = Date.now();

    let imageBuffer = null;
    let imageMimeType = 'image/jpeg';

    if (hasImage) {
      try {
        imageBuffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: pino({ level: 'silent' }),
            reuploadRequest: this.sock.updateMediaMessage
          }
        );
        imageMimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
      } catch (e) {
        console.error('No se pudo descargar imagen del flyer WA:', e.message);
      }
    }

    const cleanText = text.replace(/#cv|#empleo|#oferta/gi, '').trim();
    const sourceLabel = remoteJid.endsWith('@newsletter')
      ? 'Canal de WhatsApp'
      : remoteJid.endsWith('@g.us')
      ? this.monitoredChats.get(remoteJid)?.name || 'Grupo de WhatsApp'
      : 'WhatsApp (Reenviado)';

    if (this.onOfferDetected) {
      const result = await this.onOfferDetected({
        text: cleanText,
        imageBuffer,
        imageMimeType,
        source: sourceLabel
      });

      // Siempre enviamos el reporte al grupo Empleos Anto (con el score), para que vean qué se detectó
      // Auto-aplicación (enviar CV al reclutador) solo si score >= 65 o fue pedido con #cv
      if (result && result.isJobOffer !== false) {
        const score = result.analysis?.matchScore || 0;
        if (score < 60 && !hasTriggerTag) {
          // Score bajo: solo notificamos en el grupo sin enviar CV al reclutador
          const job = result.analysis?.jobDetails || {};
          const lowScoreMsg =
            `⚠️ *OFERTA DETECTADA PERO MATCH BAJO (${score}%)*\n\n` +
            `📌 *Puesto:* ${job.title || 'Recepcionista / Administrativa'}\n` +
            `📍 *Zona:* ${job.location || 'Buenos Aires'}\n` +
            `💡 *Motivo:* ${result.analysis?.matchReason || 'No coincide suficientemente con el perfil de Antonella'}\n\n` +
            `📄 _El CV no se envió automáticamente. Si querés forzar el envío, reenviá el aviso con #cv._`;
          const sent = await this.sock.sendMessage(remoteJid, { text: lowScoreMsg });
          if (sent?.key?.id) this.sentMessageIds.add(sent.key.id);
        } else {
          // Score bueno o pedido con #cv: enviamos el CV adaptado y el reporte completo
          await this.sendReadyApplicationToUser(result);
        }
      }
    }
  }

  /**
   * Envía automáticamente el CV en PDF al WhatsApp del reclutador si el número es real y no fue contactado antes
   */
  async autoSendWhatsAppToRecruiter(record) {
    const job = record?.analysis?.jobDetails || {};
    const msgs = record?.analysis?.applicationMessages || {};
    const pdf = record?.pdf;
    const phone = String(job.contactPhone || '').replace(/\D/g, '');

    if (!phone || phone.length < 10) {
      return { sent: false, reason: 'El aviso no incluye número de WhatsApp' };
    }
    if (BLOCKED_PHONES.has(phone)) {
      return { sent: false, reason: 'Número de prueba o propio ignorado' };
    }
    if (!this.sock || this.status !== 'connected') {
      return { sent: false, reason: 'WhatsApp desconectado' };
    }

    const history = loadSentContacts();
    if (history.phones[phone]) {
      return {
        sent: false,
        alreadySent: true,
        reason: `Ya se había enviado CV al WhatsApp +${phone} el ${new Date(history.phones[phone].sentAt).toLocaleDateString('es-AR')}`
      };
    }

    // Doble verificación contra el historial de ofertas (persiste en Render)
    if (alreadyContactedInHistory(null, phone)) {
      return {
        sent: false,
        alreadySent: true,
        reason: `Ya se había enviado CV al WhatsApp +${phone} (verificado en historial de ofertas)`
      };
    }

    try {
      const check = await this.sock.onWhatsApp(phone);
      const exists = Array.isArray(check) && check[0]?.exists;
      const recruiterJid = exists ? check[0].jid : `${phone}@s.whatsapp.net`;

      if (!exists) {
        return { sent: false, reason: `El número +${phone} no tiene cuenta activa de WhatsApp` };
      }

      const introText =
        msgs.whatsappText ||
        `Hola! Qué tal? Mi nombre es Antonella Solange Fernández, vi la búsqueda de *${job.title || 'Recepcionista / Administrativa'}* y me interesa postularme. Cuento con experiencia comprobable desde 2021 en recepción, atención al público, admisión, turnos y sistemas informáticos (actualmente en UPA 4). Resido en Ciudadela (límite con CABA) con disponibilidad inmediata. Adjunto mi CV actualizado. Muchas gracias!`;

      const sent1 = await this.sock.sendMessage(recruiterJid, { text: introText });
      if (sent1?.key?.id) this.sentMessageIds.add(sent1.key.id);

      if (pdf?.filePath && fs.existsSync(pdf.filePath)) {
        const sent2 = await this.sock.sendMessage(recruiterJid, {
          document: fs.readFileSync(pdf.filePath),
          mimetype: 'application/pdf',
          fileName: `CV_Antonella_Solange_Fernandez.pdf`,
          caption: `CV - Antonella Solange Fernández (${job.title || 'Postulación'})`
        });
        if (sent2?.key?.id) this.sentMessageIds.add(sent2.key.id);
      }

      history.phones[phone] = {
        sentAt: new Date().toISOString(),
        jobTitle: job.title
      };
      saveSentContacts(history);

      return {
        sent: true,
        recipient: `+${phone}`
      };
    } catch (err) {
      console.error(`Error auto-enviando WA al reclutador +${phone}:`, err.message);
      return { sent: false, reason: err.message };
    }
  }

  async sendReadyApplicationToUser(record, targetJidOverride = null) {
    if (!this.sock || this.status !== 'connected') return;

    // Asegurar que el perfil esté disponible (si no, cargarlo)
    if (!record.profile) {
      try {
        const fs = require('fs');
        const path = require('path');
        const profilePath = path.join(__dirname, '..', 'data', 'antonella-profile.json');
        record.profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      } catch (e) {
        console.error('Error cargando perfil:', e.message);
      }
    }

    // Soporta múltiples números separados por coma o el Grupo Exclusivo Empleos Anto (@g.us)
    const rawTargets = targetJidOverride
      ? [targetJidOverride]
      : String(this.notifyNumber || '120363415618148219@g.us')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

    const targetJids = rawTargets.map((t) => {
      if (t.includes('@')) return t;
      return `${t.replace(/\D/g, '')}@s.whatsapp.net`;
    });

    const { analysis, pdf } = record;
    const job = analysis.jobDetails || {};
    const msgs = analysis.applicationMessages || {};

    // 1. Ejecutar auto-postulación si autoApplyEnabled está activo y el match >= 65%
    let waAutoResult = null;
    let emailAutoResult = null;

    console.log(`[AUTO-APPLY] autoApplyEnabled=${this.autoApplyEnabled}, score=${analysis.matchScore}, contactEmail=${job.contactEmail}, contactPhone=${job.contactPhone}, hasProfile=${!!record.profile}`);

    if (this.autoApplyEnabled && (analysis.matchScore >= 65 || record.forceAutoApply)) {
      if (job.contactPhone) {
        console.log(`[AUTO-APPLY] Enviando WhatsApp al reclutador: ${job.contactPhone}`);
        waAutoResult = await this.autoSendWhatsAppToRecruiter(record);
        console.log(`[AUTO-APPLY] WhatsApp result:`, JSON.stringify(waAutoResult));
      }
      if (job.contactEmail && record.profile) {
        console.log(`[AUTO-APPLY] Enviando Email al reclutador: ${job.contactEmail}`);
        emailAutoResult = await sendEmailApplication({
          toEmail: job.contactEmail,
          subject: job.emailSubject || msgs.emailSubject || `CV - ${job.title} - Antonella Solange Fernández`,
          bodyText: msgs.emailBody,
          pdfPath: pdf?.filePath,
          pdfFileName: `CV_Antonella_Solange_Fernandez.pdf`,
          profile: record.profile
        });
        console.log(`[AUTO-APPLY] Email result:`, JSON.stringify(emailAutoResult));
      } else if (job.contactEmail && !record.profile) {
        console.log(`[AUTO-APPLY] No se pudo enviar email: falta perfil`);
        emailAutoResult = { sent: false, reason: 'Falta perfil de Antonella' };
      }
    } else {
      console.log(`[AUTO-APPLY] Auto-apply desactivado o score < 65% (${analysis.matchScore})`);
    }

    // Persistir el flag "applied" en el historial
    if (record.applied) {
      try {
        const fs = require('fs');
        const path = require('path');
        const HISTORY_PATH = path.join(__dirname, '..', 'data', 'offers-history.json');
        if (fs.existsSync(HISTORY_PATH)) {
          const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
          const idx = history.findIndex(h => h.id === record.id);
          if (idx !== -1) {
            history[idx].applied = true;
            fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(0, 100), null, 2));
          }
        }
      } catch (e) {
        console.error('Error persistiendo applied:', e.message);
      }
    }

    // 2. Armar el reporte de envío para el grupo "Empleos Anto 🤪"
    const deliveryLines = [];
    if (waAutoResult?.sent) {
      deliveryLines.push(`✅ *CV ENVIADO AUTOMÁTICAMENTE POR WHATSAPP A:* ${waAutoResult.recipient}`);
      record.applied = true;
    } else if (job.contactPhone) {
      const waLink = `https://wa.me/${job.contactPhone}?text=${encodeURIComponent(msgs.whatsappText || '')}`;
      deliveryLines.push(
        `📲 *WhatsApp del aviso (+${job.contactPhone}):* ${waAutoResult?.reason || 'Listo para enviar'}\n👉 ${waLink}`
      );
    }

    if (emailAutoResult?.sent) {
      deliveryLines.push(
        `✅ *CV ENVIADO AUTOMÁTICAMENTE POR EMAIL A:* ${emailAutoResult.recipient}\n   • *Asunto usado:* ${emailAutoResult.subject}`
      );
      record.applied = true;
    } else if (job.contactEmail) {
      deliveryLines.push(
        `📧 *Email del aviso:* ${job.contactEmail} (Asunto: *${job.emailSubject || msgs.emailSubject}*)\n   _(${emailAutoResult?.reason || 'Listo para enviar'})_`
      );
    }

    if (job.applyUrl) {
      deliveryLines.push(`🔗 *Portal / Link de la oferta:* ${job.applyUrl}`);
    }

    if (deliveryLines.length === 0) {
      deliveryLines.push(`ℹ️ _El aviso no especificó teléfono ni email de texto (ver flyer o link)._`);
    }

    const headerBanner =
      waAutoResult?.sent || emailAutoResult?.sent
        ? `🚀 *POSTULACIÓN AUTOMÁTICA REALIZADA (${analysis.matchScore}% Match)*`
        : `🎯 *NUEVA OFERTA DETECTADA PARA ANTONELLA (${analysis.matchScore}% Match)*`;

    const summaryMsg =
      `${headerBanner}\n\n` +
      `📌 *Puesto:* ${job.title || 'Recepcionista / Administrativa'}\n` +
      `🏢 *Origen / Empresa:* ${record.source || job.company || 'Canal Bolsa de Trabajo BA'}\n` +
      `📍 *Zona:* ${job.location || 'CABA / GBA Oeste'}\n` +
      `💡 *Detalle:* ${analysis.matchReason || 'Perfil compatible'}\n\n` +
      `📬 *REPORTE DE ENVÍO DEL CV:*\n` +
      `${deliveryLines.join('\n\n')}\n\n` +
      `📄 *Abajo te dejo copia del CV en PDF que se preparó/envió para esta búsqueda:*`;

    const pdfBuffer = pdf?.filePath && fs.existsSync(pdf.filePath) ? fs.readFileSync(pdf.filePath) : null;

    for (const jid of targetJids) {
      try {
        const sent1 = await this.sock.sendMessage(jid, { text: summaryMsg });
        if (sent1?.key?.id) this.sentMessageIds.add(sent1.key.id);

        if (pdfBuffer) {
          const sent2 = await this.sock.sendMessage(jid, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: pdf.fileName,
            caption: `CV adaptado para: ${job.title}`
          });
          if (sent2?.key?.id) this.sentMessageIds.add(sent2.key.id);
        }
      } catch (e) {
        console.error(`Error enviando alerta WA a ${jid}:`, e.message);
      }
    }
  }

  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {}
    }
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.connectedUser = null;
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (e) {}
    // Borrar la sesión persistida para que el próximo inicio pida QR limpio
    await clearRemoteAuth().catch(() => {});
    return this.getState();
  }
}

module.exports = {
  WhatsAppJobAssistant
};
