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
        this.notifyNumber = raw.notifyNumber || '5491165307320, 5491139130073';
      } else {
        this.savedMonitoredIds = new Set();
        this.autoMonitorKeywords = true;
        this.notifyNumber = '5491165307320, 5491139130073';
      }
    } catch (e) {
      this.savedMonitoredIds = new Set();
      this.autoMonitorKeywords = true;
      this.notifyNumber = '5491165307320, 5491139130073';
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
      monitoredChats: Array.from(this.monitoredChats.values())
    };
  }

  async start() {
    if (this.status === 'connecting' || this.status === 'connected') {
      return this.getState();
    }

    this.status = 'connecting';
    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
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

    this.sock.ev.on('creds.update', saveCreds);

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
        this.refreshGroups();
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
        } else if (shouldReconnect) {
          setTimeout(() => this.start(), 4000);
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

        // Auto-detectar el grupo creado con Antonella si se llama "Empleos Anto", "Busqueda Laboral", "Trabajo Anto", etc.
        if (
          /empleos?\s*anto|b[uú]squeda\s*laboral|trabajo\s*anto|cv\s*anto/i.test(subject) &&
          !this.notifyNumber.includes('@g.us')
        ) {
          this.notifyNumber = id;
          this.saveConfig();
          console.log(`🎯 Grupo exclusivo detectado automáticamente: "${subject}" (${id})`);
        }
      }
    } catch (e) {
      console.error('No se pudieron listar grupos:', e.message);
    }
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

      // Si el match es bueno (>= 60) o fue pedido con #cv / reenviado por Joni o Antonella, enviamos el CV PDF adaptado a los dos por WhatsApp
      if (result && (result.analysis?.matchScore >= 60 || hasTriggerTag || isSelfChat)) {
        await this.sendReadyApplicationToUser(result);
      }
    }
  }

  async sendReadyApplicationToUser(record, targetJidOverride = null) {
    if (!this.sock || this.status !== 'connected') return;

    // Soporta múltiples números separados por coma (ej: el de Antonella y el tuyo) o IDs de grupo (@g.us)
    const rawTargets = targetJidOverride
      ? [targetJidOverride]
      : String(this.notifyNumber || '5491165307320')
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

    let oneClickSection = '';
    if (job.contactPhone) {
      const waLink = `https://wa.me/${job.contactPhone}?text=${encodeURIComponent(msgs.whatsappText || '')}`;
      oneClickSection += `\n📲 *POSTULAR POR WHATSAPP (1 CLIC):*\n${waLink}\n_(Tocá el link, se abre el chat con el mensaje ya escrito, solo adjuntale el PDF de acá abajo)_`;
    }
    if (job.contactEmail) {
      oneClickSection += `\n\n📧 *POSTULAR POR EMAIL:*\n• *Para:* ${job.contactEmail}\n• *Asunto:* ${job.emailSubject || msgs.emailSubject}`;
    }
    if (job.applyUrl) {
      oneClickSection += `\n\n🔗 *LINK DE LA OFERTA:*\n${job.applyUrl}`;
    }

    const summaryMsg =
      `🎯 *MATCH LABORAL PARA ANTONELLA (${analysis.matchScore}%)*\n\n` +
      `📌 *Puesto:* ${job.title || 'Recepcionista / Administrativa'}\n` +
      `📍 *Zona:* ${job.location || 'Buenos Aires'}\n` +
      `💡 *Por qué aplica:* ${analysis.matchReason || 'Perfil compatible'}\n` +
      `${oneClickSection}\n\n` +
      `📄 *Abajo te adjunto el CV en PDF ya modificado y adaptado para este puesto:*`;

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
    return this.getState();
  }
}

module.exports = {
  WhatsAppJobAssistant
};
