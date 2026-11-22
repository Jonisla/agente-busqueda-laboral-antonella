const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

let puppeteer = null;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {}

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function getBrowserExecutablePath() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getPhotoPath() {
  const photoFile = path.join(__dirname, '..', 'public', 'assets', 'foto-antonella.jpg');
  return fs.existsSync(photoFile) ? photoFile : null;
}

function getPhotoBase64() {
  const photoFile = getPhotoPath();
  if (photoFile) {
    const buf = fs.readFileSync(photoFile);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  return null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeTailoredData(profile, tailored) {
  const headline =
    tailored?.headline || 'Recepcionista Administrativa | Admisión en Salud y Atención al Cliente';
  const summary =
    tailored?.summary ||
    'Recepcionista y administrativa con sólida experiencia en atención al público, admisión de pacientes, gestión de turnos, validación de obras sociales y carga de datos en sistemas informáticos. Destacada por mi rapidez y precisión operativa, trato cálido y resolutivo en entornos de alta demanda, y excelente predisposición para el trabajo en equipo.';

  const skillGroup1Title = tailored?.skillGroup1?.title || 'Recepción, Salud y Atención';
  const skillGroup1Items = tailored?.skillGroup1?.items || profile.coreSkills.saludYRecepcion;

  const skillGroup2Title = tailored?.skillGroup2?.title || 'Administración y Sistemas';
  const skillGroup2Items = tailored?.skillGroup2?.items || profile.coreSkills.administracionYSistemas;

  const experiences = tailored?.experiences || [
    {
      company: 'UPA 4 (Unidad de Pronta Atención)',
      period: '2022 – Presente',
      role: 'Recepcionista de Guardia, Admisión y Gestión Administrativa',
      bullets: profile.experiences[0].highlights
    },
    {
      company: 'Programa Buenos Aires Vacunate',
      period: '2021 – 2022',
      role: 'Administrativa de Admisión, Registro en Sistema y Logística',
      bullets: profile.experiences[1].highlights
    },
    {
      company: 'Inpacont S.A.',
      period: '2017 – Presente',
      role: 'Auxiliar Operativa y de Servicios Generales',
      bullets: profile.experiences[2].highlights
    }
  ];

  return {
    headline,
    summary,
    skillGroup1Title,
    skillGroup1Items,
    skillGroup2Title,
    skillGroup2Items,
    experiences
  };
}

/**
 * Construye el HTML A4 del CV adaptado de Antonella
 */
function buildCVHtml(profile, tailored, options = { includePhoto: true }) {
  const photoBase64 = options.includePhoto !== false ? getPhotoBase64() : null;
  const data = normalizeTailoredData(profile, tailored);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <title>CV - ${escapeHtml(profile.fullName)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    @page {
      size: A4;
      margin: 0;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #1e293b;
      background: #ffffff;
      width: 210mm;
      height: 297mm;
      padding: 13mm 15mm 12mm 15mm;
      line-height: 1.42;
      font-size: 9.7pt;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding-bottom: 13px;
      border-bottom: 2.5px solid #0f4c81;
      margin-bottom: 13px;
    }

    .header-left { flex: 1; }

    .name {
      font-size: 21pt;
      font-weight: 800;
      color: #0f2942;
      letter-spacing: -0.4px;
      text-transform: uppercase;
      line-height: 1.1;
      margin-bottom: 5px;
    }

    .headline {
      font-size: 11.2pt;
      font-weight: 700;
      color: #0f4c81;
      margin-bottom: 9px;
    }

    .contact-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
      font-size: 9pt;
      color: #334155;
    }

    .contact-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .contact-label {
      font-weight: 700;
      color: #0f4c81;
    }

    .photo-wrap {
      width: 96px;
      height: 96px;
      border-radius: 50%;
      overflow: hidden;
      border: 2.5px solid #0f4c81;
      box-shadow: 0 3px 10px rgba(15, 76, 129, 0.16);
      flex-shrink: 0;
      background: #f8fafc;
    }

    .photo-wrap img {
      width: 108%;
      height: 115%;
      object-fit: cover;
      object-position: center 14%;
      margin-left: -4%;
    }

    .section { margin-bottom: 13px; }

    .section-title {
      font-size: 10.2pt;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.7px;
      color: #0f4c81;
      border-bottom: 1.5px solid #cbd5e1;
      padding-bottom: 3px;
      margin-bottom: 8px;
    }

    .profile-box {
      background: #f8fafc;
      border-left: 3.5px solid #0f4c81;
      padding: 9px 13px;
      border-radius: 0 6px 6px 0;
      color: #1e293b;
      font-size: 9.6pt;
      text-align: justify;
    }

    .skills-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 11px;
    }

    .skill-card {
      background: #f1f5f9;
      border-radius: 6px;
      padding: 8px 11px;
      border-top: 2.5px solid #0f4c81;
    }

    .skill-card-title {
      font-size: 9.4pt;
      font-weight: 700;
      color: #0f2942;
      margin-bottom: 5px;
    }

    .skill-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 6px;
    }

    .skill-tag {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      color: #1e293b;
      font-size: 8.5pt;
      font-weight: 500;
      padding: 2px 7px;
      border-radius: 4px;
    }

    .exp-item { margin-bottom: 10px; }
    .exp-item:last-child { margin-bottom: 0; }

    .exp-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 3px;
    }

    .exp-role-company {
      font-size: 10pt;
      color: #0f2942;
    }

    .exp-role { font-weight: 700; }
    .exp-company { font-weight: 600; color: #0f4c81; }

    .exp-period {
      font-size: 8.8pt;
      font-weight: 600;
      color: #475569;
      background: #f1f5f9;
      padding: 1px 8px;
      border-radius: 10px;
      white-space: nowrap;
    }

    .exp-bullets {
      list-style: none;
      padding-left: 0;
    }

    .exp-bullets li {
      position: relative;
      padding-left: 13px;
      margin-bottom: 3px;
      font-size: 9.3pt;
      color: #334155;
    }

    .exp-bullets li::before {
      content: "•";
      position: absolute;
      left: 1px;
      top: 0;
      color: #0f4c81;
      font-weight: bold;
    }

    .bottom-grid {
      display: grid;
      grid-template-columns: 1.25fr 0.75fr;
      gap: 14px;
    }

    .edu-item { margin-bottom: 6px; }
    .edu-degree { font-weight: 700; color: #0f2942; font-size: 9.4pt; }
    .edu-inst { font-size: 8.9pt; color: #475569; }

    .info-list {
      list-style: none;
      font-size: 9pt;
      color: #334155;
    }

    .info-list li { margin-bottom: 4px; }
    .info-list strong { color: #0f2942; }

    .footer {
      position: fixed;
      bottom: 8mm;
      left: 15mm;
      right: 15mm;
      border-top: 1px solid #e2e8f0;
      padding-top: 4px;
      display: flex;
      justify-content: space-between;
      font-size: 8pt;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="name">${escapeHtml(profile.fullName)}</div>
      <div class="headline">${escapeHtml(data.headline)}</div>
      <div class="contact-bar">
        <span class="contact-item"><span class="contact-label">Tel / WhatsApp:</span> ${escapeHtml(profile.phone)}</span>
        <span class="contact-item"><span class="contact-label">Email:</span> ${escapeHtml(profile.email)}</span>
        <span class="contact-item"><span class="contact-label">Ubicación:</span> ${escapeHtml(profile.location)}</span>
      </div>
    </div>
    ${
      photoBase64
        ? `<div class="photo-wrap"><img src="${photoBase64}" alt="Antonella Solange Fernández" /></div>`
        : ''
    }
  </div>

  <div class="section">
    <div class="section-title">Perfil Profesional</div>
    <div class="profile-box">${escapeHtml(data.summary)}</div>
  </div>

  <div class="section">
    <div class="section-title">Competencias y Habilidades Clave</div>
    <div class="skills-grid">
      <div class="skill-card">
        <div class="skill-card-title">${escapeHtml(data.skillGroup1Title)}</div>
        <div class="skill-tags">
          ${data.skillGroup1Items.map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}
        </div>
      </div>
      <div class="skill-card">
        <div class="skill-card-title">${escapeHtml(data.skillGroup2Title)}</div>
        <div class="skill-tags">
          ${data.skillGroup2Items.map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('')}
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Experiencia Laboral</div>
    ${data.experiences
      .map(
        (exp) => `
      <div class="exp-item">
        <div class="exp-header">
          <div class="exp-role-company">
            <span class="exp-role">${escapeHtml(exp.role)}</span> — <span class="exp-company">${escapeHtml(exp.company)}</span>
          </div>
          <div class="exp-period">${escapeHtml(exp.period)}</div>
        </div>
        <ul class="exp-bullets">
          ${(exp.bullets || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>
      </div>
    `
      )
      .join('')}
  </div>

  <div class="bottom-grid">
    <div class="section">
      <div class="section-title">Educación y Formación</div>
      ${profile.education
        .map(
          (ed) => `
        <div class="edu-item">
          <div class="edu-degree">${escapeHtml(ed.degree)}</div>
          <div class="edu-inst">${escapeHtml(ed.institution)} (${escapeHtml(ed.period)})</div>
        </div>
      `
        )
        .join('')}
    </div>

    <div class="section">
      <div class="section-title">Disponibilidad y Datos</div>
      <ul class="info-list">
        <li><strong>Zonas:</strong> CABA y GBA Zona Oeste</li>
        <li><strong>Disponibilidad:</strong> Inmediata (Full-time / Part-time)</li>
        <li><strong>Sistemas:</strong> Plataformas de Salud, Turnos, Excel, Word</li>
      </ul>
    </div>
  </div>

  <div class="footer">
    <span>${escapeHtml(profile.fullName)} — ${escapeHtml(data.headline)}</span>
    <span>Tel: ${escapeHtml(profile.phone)} | ${escapeHtml(profile.email)}</span>
  </div>
</body>
</html>`;
}

/**
 * Generador PDF nativo ultraliviano con PDFKit (para servidores VPS gratuitos sin Chrome)
 */
function generatePDFWithPDFKit(filePath, profile, tailored, options = { includePhoto: true }) {
  return new Promise((resolve, reject) => {
    const data = normalizeTailoredData(profile, tailored);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const photoPath = options.includePhoto !== false ? getPhotoPath() : null;

    // Header
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f2942').text(profile.fullName.toUpperCase(), 40, 40, {
      width: photoPath ? 410 : 515
    });
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f4c81').text(data.headline, {
      width: photoPath ? 410 : 515
    });
    doc.moveDown(0.35);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#334155')
      .text(`Tel / WhatsApp: ${profile.phone}   |   Email: ${profile.email}`, {
        width: photoPath ? 410 : 515
      });
    doc.text(`Ubicación: ${profile.location}`, {
      width: photoPath ? 410 : 515
    });

    if (photoPath) {
      try {
        doc.save();
        doc.circle(508, 74, 38).clip();
        doc.image(photoPath, 468, 34, { width: 80 });
        doc.restore();
        doc.circle(508, 74, 38).lineWidth(2).strokeColor('#0f4c81').stroke();
      } catch (e) {}
    }

    doc.y = Math.max(doc.y + 12, 122);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).lineWidth(2).strokeColor('#0f4c81').stroke();
    doc.y += 12;

    const drawSectionHeader = (title) => {
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0f4c81').text(title.toUpperCase(), 40, doc.y);
      doc.y += 2;
      doc.moveTo(40, doc.y).lineTo(555, doc.y).lineWidth(1).strokeColor('#cbd5e1').stroke();
      doc.y += 7;
    };

    // Perfil Profesional
    drawSectionHeader('Perfil Profesional');
    doc.font('Helvetica').fontSize(9.5).fillColor('#1e293b').text(data.summary, 40, doc.y, {
      width: 515,
      align: 'justify'
    });
    doc.y += 12;

    // Competencias
    drawSectionHeader('Competencias y Habilidades Clave');
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0f2942').text(`${data.skillGroup1Title}: `, 40, doc.y, {
      continued: true
    });
    doc.font('Helvetica').fillColor('#334155').text(data.skillGroup1Items.join(' • '));
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0f2942').text(`${data.skillGroup2Title}: `, 40, doc.y, {
      continued: true
    });
    doc.font('Helvetica').fillColor('#334155').text(data.skillGroup2Items.join(' • '));
    doc.y += 12;

    // Experiencia Laboral
    drawSectionHeader('Experiencia Laboral');
    for (const exp of data.experiences) {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#0f2942')
        .text(`${exp.role} — `, 40, doc.y, { continued: true })
        .fillColor('#0f4c81')
        .text(`${exp.company}`, { continued: true })
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#64748b')
        .text(`   (${exp.period})`);
      doc.y += 3;

      for (const b of exp.bullets || []) {
        doc.font('Helvetica').fontSize(9.2).fillColor('#334155').text(`•  ${b}`, 48, doc.y, {
          width: 505
        });
        doc.y += 2;
      }
      doc.y += 7;
    }

    // Educación
    drawSectionHeader('Educación y Disponibilidad');
    for (const ed of profile.education) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9.3)
        .fillColor('#0f2942')
        .text(`${ed.degree}`, 40, doc.y, { continued: true })
        .font('Helvetica')
        .fillColor('#475569')
        .text(` — ${ed.institution} (${ed.period})`);
      doc.y += 3;
    }
    doc.y += 4;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#0f2942')
      .text('Zonas de búsqueda: ', 40, doc.y, { continued: true })
      .font('Helvetica')
      .fillColor('#334155')
      .text('CABA y GBA Zona Oeste   |   Disponibilidad: Inmediata');

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function sanitizeFilename(text) {
  return String(text || 'General')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 45);
}

/**
 * Genera el archivo PDF en disco (usa Chrome local si está disponible, o PDFKit nativo en VPS)
 */
async function generateTailoredPDF(profile, tailored, jobTitle = 'Recepcionista_Administrativa', options = { includePhoto: true }) {
  const outDir = path.join(__dirname, '..', 'public', 'generated-cvs');
  fs.mkdirSync(outDir, { recursive: true });

  const html = buildCVHtml(profile, tailored, options);
  const safeRole = sanitizeFilename(jobTitle);
  const timestamp = Date.now().toString().slice(-5);
  const fileName = `CV_Antonella_Fernandez_${safeRole}_${timestamp}.pdf`;
  const filePath = path.join(outDir, fileName);

  const executablePath = getBrowserExecutablePath();

  if (puppeteer && executablePath && process.env.USE_LIGHT_PDF !== 'true') {
    try {
      const browser = await puppeteer.launch({
        executablePath,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
        await page.pdf({
          path: filePath,
          format: 'A4',
          printBackground: true,
          pageRanges: '1'
        });
      } finally {
        await browser.close();
      }
    } catch (err) {
      console.warn('Usando generador PDFKit liviano de respaldo:', err.message);
      await generatePDFWithPDFKit(filePath, profile, tailored, options);
    }
  } else {
    await generatePDFWithPDFKit(filePath, profile, tailored, options);
  }

  return {
    fileName,
    filePath,
    publicUrl: `/generated-cvs/${fileName}`,
    html
  };
}

module.exports = {
  buildCVHtml,
  generateTailoredPDF
};
