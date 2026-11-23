const fs = require('fs');
const path = require('path');

const SENT_CONTACTS_PATH = path.join(__dirname, '..', 'data', 'sent-contacts.json');

const BLOCKED_PHONES = new Set([
  '5491165307320', // Antonella
  '5491139130073', // Joni
  '5491144556677', // Ejemplo demo
  '5491155443322', // Ejemplo demo
  '5491167891234', // Ejemplo demo
  '5491133228899'  // Ejemplo demo
]);

const BLOCKED_EMAILS = new Set([
  'antonellasolangefernandez095@gmail.com',
  'jonisla28@gmail.com',
  'rrhh.centromedico@gmail.com',
  'seleccion@clinicacaballito.com.ar',
  'rrhh@empresaoeste.com.ar',
  'talento@gestiondatosba.com'
]);

const SENDER_EMAIL = 'afernand1995@gmail.com';
const SENDER_NAME = 'Antonella Solange Fernández';

function loadSentContacts() {
  try {
    if (fs.existsSync(SENT_CONTACTS_PATH)) {
      return JSON.parse(fs.readFileSync(SENT_CONTACTS_PATH, 'utf8'));
    }
  } catch (e) {}
  return { phones: {}, emails: {} };
}

function saveSentContacts(data) {
  fs.mkdirSync(path.dirname(SENT_CONTACTS_PATH), { recursive: true });
  fs.writeFileSync(SENT_CONTACTS_PATH, JSON.stringify(data, null, 2));
}

/**
 * Verifica si ya se envió un CV a este email o teléfono consultando el historial de ofertas
 */
function alreadyContactedInHistory(email, phone) {
  try {
    const historyPath = path.join(__dirname, '..', 'data', 'offers-history.json');
    if (fs.existsSync(historyPath)) {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      for (const item of history) {
        if (item.applied) {
          const itemEmail = (item.analysis?.jobDetails?.contactEmail || '').toLowerCase().trim();
          const itemPhone = (item.analysis?.jobDetails?.contactPhone || '').replace(/\D/g, '');
          if (email && itemEmail === email.toLowerCase().trim()) return true;
          if (phone && itemPhone === phone.replace(/\D/g, '')) return true;
        }
      }
    }
  } catch (e) {}
  return false;
}

/**
 * Envía automáticamente el CV en PDF por Email al reclutador usando Brevo (HTTP API)
 * Render bloquea SMTP saliente, por eso usamos la API HTTPS de Brevo (puerto 443)
 */
async function sendEmailApplication({ toEmail, subject, bodyText, pdfPath, pdfFileName, profile }) {
  const cleanEmail = String(toEmail || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { sent: false, reason: 'No hay email en el aviso' };
  }
  if (BLOCKED_EMAILS.has(cleanEmail)) {
    return { sent: false, reason: 'Email de prueba o propio ignorado' };
  }

  const history = loadSentContacts();
  if (history.emails[cleanEmail]) {
    return {
      sent: false,
      alreadySent: true,
      reason: `Ya se había enviado CV a ${cleanEmail} el ${new Date(history.emails[cleanEmail].sentAt).toLocaleDateString('es-AR')}`
    };
  }

  if (alreadyContactedInHistory(cleanEmail, null)) {
    return {
      sent: false,
      alreadySent: true,
      reason: `Ya se había enviado CV a ${cleanEmail} (verificado en historial de ofertas)`
    };
  }

  const brevoApiKey = process.env.BREVO_API_KEY;
  if (!brevoApiKey) {
    return {
      sent: false,
      needsConfig: true,
      reason: 'Falta configurar BREVO_API_KEY para envío automático de correos. Generá una API key en Brevo y agregala en Render.'
    };
  }

  try {
    const payload = {
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      replyTo: { email: SENDER_EMAIL },
      to: [{ email: cleanEmail }],
      subject: subject || `CV - ${profile.fullName}`,
      textContent: bodyText
    };

    if (pdfPath && fs.existsSync(pdfPath)) {
      payload.attachment = [{
        name: pdfFileName || 'CV_Antonella_Solange_Fernandez.pdf',
        content: fs.readFileSync(pdfPath).toString('base64')
      }];
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoApiKey,
        'Content-Type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.message || `HTTP ${response.status}`);
    }

    console.log(`[EMAIL] Enviado a ${cleanEmail}, messageId: ${result.messageId}`);

    history.emails[cleanEmail] = {
      sentAt: new Date().toISOString(),
      subject
    };
    saveSentContacts(history);

    return {
      sent: true,
      recipient: cleanEmail,
      subject,
      messageId: result.messageId
    };
  } catch (err) {
    console.error(`[EMAIL ERROR] ${cleanEmail}: ${err.message}`);
    return {
      sent: false,
      reason: `Error Brevo: ${err.message}`
    };
  }
}

module.exports = {
  sendEmailApplication,
  loadSentContacts,
  saveSentContacts,
  BLOCKED_PHONES,
  BLOCKED_EMAILS,
  alreadyContactedInHistory
};
