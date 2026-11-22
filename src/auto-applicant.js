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
 * Envía automáticamente el CV en PDF por Email al reclutador usando Resend (HTTP API)
 * Render bloquea SMTP saliente, por eso usamos Resend que usa HTTPS (puerto 443)
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

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    return {
      sent: false,
      needsConfig: true,
      reason: 'Falta configurar RESEND_API_KEY para envío automático de correos. Creá una cuenta gratis en resend.com y agregá la API Key en Render.'
    };
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(resendApiKey);

    const attachments = [];
    if (pdfPath && fs.existsSync(pdfPath)) {
      const pdfBuffer = fs.readFileSync(pdfPath);
      attachments.push({
        filename: pdfFileName || 'CV_Antonella_Solange_Fernandez.pdf',
        content: pdfBuffer.toString('base64')
      });
    }

    const result = await resend.emails.send({
      from: 'Antonella Solange Fernández <onboarding@resend.dev>',
      replyTo: 'afernand1995@gmail.com',
      to: [cleanEmail],
      subject: subject || `CV - ${profile.fullName}`,
      text: bodyText,
      attachments: attachments.length > 0 ? attachments : undefined
    });

    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }

    console.log(`[EMAIL] Enviado a ${cleanEmail}, id: ${result.data?.id}`);

    history.emails[cleanEmail] = {
      sentAt: new Date().toISOString(),
      subject
    };
    saveSentContacts(history);

    return {
      sent: true,
      recipient: cleanEmail,
      subject,
      messageId: result.data?.id
    };
  } catch (err) {
    console.error(`[EMAIL ERROR] ${cleanEmail}: ${err.message}`);
    return {
      sent: false,
      reason: `Error Resend: ${err.message}`
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
