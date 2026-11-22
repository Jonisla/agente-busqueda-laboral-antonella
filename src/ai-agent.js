const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

/**
 * Normaliza un número de teléfono argentino al formato internacional de WhatsApp (54911XXXXXXXX)
 */
function normalizeArgentinePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';

  // Quitar 0 inicial de característica (ej 011)
  if (digits.startsWith('0')) digits = digits.slice(1);

  // Si empieza con 15 y tiene 10 dígitos (15XXXXXXXX -> 11XXXXXXXX)
  if (digits.startsWith('15') && digits.length === 10) {
    digits = '11' + digits.slice(2);
  }

  // Si empieza con 11 y tiene 10 dígitos -> agregar 549
  if (digits.startsWith('11') && digits.length === 10) {
    return '549' + digits;
  }

  // Si empieza con 5411 y tiene 12 dígitos -> insertar el 9
  if (digits.startsWith('5411') && digits.length === 12) {
    return '549' + digits.slice(2);
  }

  // Si ya empieza con 549 y tiene 13 dígitos
  if (digits.startsWith('549') && digits.length >= 12) {
    return digits;
  }

  // Si tiene 8 dígitos (línea móvil de AMBA sin el 11)
  if (digits.length === 8) {
    return '54911' + digits;
  }

  return digits.length >= 10 ? digits : '';
}

/**
 * Motor heurístico local de respaldo (cuando no hay GEMINI_API_KEY o se analiza texto rápido)
 */
function analyzeWithLocalEngine(rawText, profile) {
  const text = String(rawText || '').trim();
  const lower = text.toLowerCase();

  // Extraer email
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const contactEmail = emailMatch ? emailMatch[0] : '';

  // Extraer teléfono de Argentina (ej: 11-1234-5678, +54 9 11 1234 5678, 1122334455, 15-xxxx-xxxx)
  const phoneRegex = /(?:\+?54\s*9?\s*)?(?:0?11|15)[\s.-]*\d{4}[\s.-]*\d{4}/g;
  const phoneMatches = text.match(phoneRegex) || [];
  const rawPhone = phoneMatches.find((p) => !p.includes('6530')) || '';
  const contactPhone = normalizeArgentinePhone(rawPhone);

  // Extraer link si hay
  const urlMatch = text.match(/https?:\/\/[^\s)]+/i);
  const applyUrl = urlMatch ? urlMatch[0] : '';

  // Detectar asunto solicitado ("asunto: ...", "ref: ...")
  const subjectMatch = text.match(/(?:asunto|referencia|ref)\s*[:\-]\s*([^\n\r.,;]+)/i);
  const cleanedSubject = subjectMatch
    ? subjectMatch[1].replace(/\s+(?:o por|por whatsapp|al whatsapp|enviando).*$/i, '').trim()
    : '';

  // Detectar zona
  const zonasOeste = [
    'ciudadela', 'ramos mejia', 'ramos mejía', 'haedo', 'moron', 'morón', 'castelar',
    'ituzaingo', 'ituzaingó', 'san justo', 'caseros', 'tres de febrero', 'santos lugares',
    'villa luzuriaga', 'lomas del mirador', 'zona oeste', 'gba oeste', 'hurlingham', 'merlo', 'moreno'
  ];
  const zonasCaba = [
    'caba', 'capital federal', 'liniers', 'devoto', 'villa del parque', 'flores', 'floresta',
    'caballito', 'almagro', 'palermo', 'belgrano', 'microcentro', 'centro', 'once', 'balvanera',
    'congreso', 'recoleta', 'colegiales', 'chacarita', 'paternal', 'villa urquiza', 'villa crespo',
    'boedo', 'parque patricios', 'mataderos', 'villa luro', 'monte castro', 'nuñez', 'núñez', 'retiro', 'puerto madero'
  ];
  const zonasLejanas = ['la plata', 'pilar', 'escobar', 'tigre', 'quilmes', 'berazategui', 'florencio varela', 'ezeiza', 'cañuelas'];

  let detectedZone = 'Buenos Aires (AMBA)';
  let zoneValid = true;

  for (const z of zonasOeste) {
    if (lower.includes(z)) {
      detectedZone = `GBA Zona Oeste (${z.charAt(0).toUpperCase() + z.slice(1)})`;
      break;
    }
  }
  for (const z of zonasCaba) {
    if (lower.includes(z)) {
      detectedZone = `CABA (${z.charAt(0).toUpperCase() + z.slice(1)})`;
      break;
    }
  }
  if (lower.includes('remoto') || lower.includes('home office') || lower.includes('teletrabajo')) {
    detectedZone = 'Remoto / Home Office';
  }
  for (const z of zonasLejanas) {
    if (lower.includes(z)) {
      detectedZone = `Zona alejada (${z.toUpperCase()})`;
      zoneValid = false;
    }
  }

  // Detectar categoría del puesto
  const isSalud = /clinica|clínica|sanatorio|hospital|consultorio|paciente|salud|médic|medic|odontol|estética|estetica|laboratorio|obra social|prepaga|guardia|admisión|admision|secretaria médica|turnos/i.test(text);
  const isDataEntry = /data entry|carga de datos|ingreso de datos|tipeo|digitador|validación de datos|backoffice|registro/i.test(text);
  const isAdmin = /administrativ|recepcionista|recepción|secretaria|oficina|facturación|planillas|excel|archivos|asistente/i.test(text);
  const isAtencion = /atención al cliente|atencion al cliente|atención al público|comercial|ventas|local|cajera|caja|call center|telefonista|asesora/i.test(text);

  let category = 'admin_recepcion';
  let detectedTitle = 'Recepcionista / Administrativa';
  let score = 74;

  if (isSalud) {
    category = 'salud';
    detectedTitle = 'Recepcionista de Salud y Admisión de Pacientes';
    score = 95;
  } else if (isDataEntry) {
    category = 'data_entry';
    detectedTitle = 'Operadora de Data Entry y Gestión Administrativa';
    score = 90;
  } else if (isAdmin) {
    category = 'admin_recepcion';
    detectedTitle = 'Recepcionista Administrativa y Atención Integral';
    score = 86;
  } else if (isAtencion) {
    category = 'atencion_comercial';
    detectedTitle = 'Atención al Cliente y Recepción Comercial';
    score = 82;
  } else {
    score = 55;
  }

  if (!zoneValid) score = Math.max(25, score - 40);

  // Construir CV adaptado según categoría detectada
  let tailoredCV;
  if (category === 'salud') {
    tailoredCV = {
      headline: 'Recepcionista de Clínica, Guardia y Admisión | Gestión Sanitaria',
      summary:
        'Recepcionista administrativa de salud con sólida trayectoria comprobable desde 2021 en admisión de pacientes, atención de guardia e internación, gestión de turnos, validación de obras sociales/prepagas y manejo de historias clínicas digitales. Destacada por mi templanza, rapidez en sistemas informáticos y trato empático con pacientes, familiares y equipo médico.',
      skillGroup1: {
        title: 'Admisión y Gestión en Salud',
        items: [
          'Admisión de Pacientes y Guardia',
          'Validación de Obras Sociales / Prepagas',
          'Asignación de Turnos y Agendas Médicas',
          'Historias Clínicas y Derivaciones',
          'Triage Administrativo e Internación',
          'Trato Empático con Pacientes'
        ]
      },
      skillGroup2: {
        title: 'Sistemas y Administración',
        items: [
          'Sistemas de Gestión de Salud',
          'Carga Ágil de Datos Filiatorios',
          'Atención Telefónica y Presencial',
          'Paquete Office (Excel / Word)',
          'Control de Documentación Clínica',
          'Trabajo bajo Presión'
        ]
      },
      experiences: [
        {
          company: 'UPA 4 (Unidad de Pronta Atención)',
          period: '2022 – Presente',
          role: 'Recepcionista de Guardia, Admisión e Internación',
          bullets: [
            'Atención y admisión integral de pacientes en guardia y consultorios: validación de DNI, obras sociales/coberturas e ingreso rápido al sistema informático.',
            'Gestión administrativa de turnos, pases a salas de internación y coordinación de derivaciones médicas a centros de mayor complejidad.',
            'Carga precisa de datos filiatorios, administración de historias clínicas digitales y control estricto de ingresos y altas.',
            'Atención telefónica y presencial a pacientes y familiares, brindando orientación clara y contención en entornos de alta demanda.'
          ]
        },
        {
          company: 'Programa Buenos Aires Vacunate',
          period: '2021 – 2022',
          role: 'Administrativa de Admisión y Registro Sanitario',
          bullets: [
            'Recepción, admisión y validación masiva de pacientes en plataforma digital de salud bajo protocolos estrictos.',
            'Control administrativo de trazabilidad de insumos sanitarios, planillas operativas y organización del flujo de atención.'
          ]
        },
        {
          company: 'Inpacont S.A.',
          period: '2017 – Presente',
          role: 'Auxiliar Operativa y Cumplimiento de Protocolos',
          bullets: [
            'Ejecución metódica de protocolos operativos y normativas de bioseguridad e higiene institucional.'
          ]
        }
      ]
    };
  } else if (category === 'data_entry') {
    tailoredCV = {
      headline: 'Especialista en Data Entry, Carga de Datos y Gestión Administrativa',
      summary:
        'Operadora de ingreso y validación de datos con más de 4 años de experiencia comprobable en carga masiva de registros, actualización de bases de datos, control documental digital y manejo ágil de plataformas web y Excel. Destacada por mi velocidad de tipeo, alta precisión, confidencialidad y organización metódica.',
      skillGroup1: {
        title: 'Procesamiento y Carga de Datos',
        items: [
          'Data Entry y Carga Masiva',
          'Validación y Control de Registros',
          'Actualización de Bases de Datos',
          'Digitalización Documental',
          'Trazabilidad de Información',
          'Alta Velocidad y Precisión de Tipeo'
        ]
      },
      skillGroup2: {
        title: 'Herramientas y Operaciones',
        items: [
          'Excel y Planillas de Cálculo',
          'Plataformas Web y Sistemas CRM/ERP',
          'Gestión de Archivos Digitales',
          'Auditoría de Calidad de Datos',
          'Confidencialidad de Información',
          'Cumplimiento de Objetivos'
        ]
      },
      experiences: [
        {
          company: 'UPA 4 (Unidad de Pronta Atención)',
          period: '2022 – Presente',
          role: 'Operadora de Ingreso de Datos y Gestión Documental',
          bullets: [
            'Carga y procesamiento continuo de datos filiatorios y registros operativos en el sistema informático institucional con alto nivel de exactitud.',
            'Administración, actualización y auditoría de historias clínicas digitales, ingresos, altas y derivaciones en tiempo real.',
            'Verificación estricta de calidad e integridad de los datos ingresados en entornos de alta exigencia operativa.'
          ]
        },
        {
          company: 'Programa Buenos Aires Vacunate',
          period: '2021 – 2022',
          role: 'Operadora de Validación de Datos en Plataforma Digital',
          bullets: [
            'Carga y validación masiva de datos de ciudadanos en plataforma web oficial, asegurando velocidad y cero errores de registro.',
            'Registro sistemático en planillas de control y trazabilidad documental de stock e insumos.'
          ]
        },
        {
          company: 'Inpacont S.A.',
          period: '2017 – Presente',
          role: 'Auxiliar de Procesos Operativos',
          bullets: [
            'Cumplimiento riguroso de procedimientos operativos y estándares de control interno.'
          ]
        }
      ]
    };
  } else if (category === 'atencion_comercial') {
    tailoredCV = {
      headline: 'Recepcionista y Atención al Cliente | Gestión Administrativa y Comercial',
      summary:
        'Representante de atención al público y recepcionista con sólida trayectoria atendiendo alto volumen de personas de forma presencial y telefónica. Experiencia comprobable en recepción, gestión de agendas y turnos, carga en sistemas informáticos, control de stock y resolución ágil de consultas con excelente presencia, puntualidad y vocación de servicio.',
      skillGroup1: {
        title: 'Atención al Público y Recepción',
        items: [
          'Atención Presencial y Telefónica',
          'Recepción y Orientación al Cliente',
          'Resolución Ágil de Consultas',
          'Manejo de Agendas y Turnos',
          'Comunicación Clara y Empática',
          'Excelente Presencia y Puntualidad'
        ]
      },
      skillGroup2: {
        title: 'Administración y Operativa',
        items: [
          'Manejo de Sistemas Informáticos',
          'Paquete Office (Excel / Word)',
          'Control de Stock e Insumos',
          'Registro de Operaciones Diarias',
          'Organización y Orden Operativo',
          'Trabajo en Equipo bajo Presión'
        ]
      },
      experiences: [
        {
          company: 'UPA 4 (Unidad de Pronta Atención)',
          period: '2022 – Presente',
          role: 'Recepcionista y Atención Integral al Público',
          bullets: [
            'Recepción presencial y telefónica de alto caudal diario de personas, brindando orientación, asesoramiento y resolución inmediata de consultas.',
            'Carga ágil de datos en sistema informático, coordinación de agendas/turnos y seguimiento administrativo de cada caso.',
            'Manejo de situaciones de alta demanda con cordialidad, paciencia y enfoque resolutivo.'
          ]
        },
        {
          company: 'Programa Buenos Aires Vacunate',
          period: '2021 – 2022',
          role: 'Asistente de Recepción, Atención al Público y Logística',
          bullets: [
            'Recepción y asistencia dinámica al público, validación de datos en sistema digital y organización de filas y turnos.',
            'Control de stock, recepción de insumos y registro diario en planillas operativas.'
          ]
        },
        {
          company: 'Inpacont S.A.',
          period: '2017 – Presente',
          role: 'Auxiliar Operativa y de Servicios',
          bullets: [
            'Mantenimiento del orden operativo y cumplimiento de estándares de calidad en instalaciones.'
          ]
        }
      ]
    };
  } else {
    tailoredCV = {
      headline: 'Recepcionista Administrativa | Gestión de Turnos, Sistemas y Atención al Público',
      summary:
        'Recepcionista y auxiliar administrativa con más de 4 años de experiencia comprobable en recepción, atención telefónica y presencial, carga de datos en sistemas de gestión, manejo de agendas/turnos, validación documental y control de planillas. Me destaco por mi organización, puntualidad, rapidez de aprendizaje informático y trato cordial.',
      skillGroup1: {
        title: 'Recepción y Administración',
        items: [
          'Recepción Corporativa y de Salud',
          'Gestión de Agendas y Turnos',
          'Atención Telefónica y Presencial',
          'Control Documental y Archivos',
          'Validación de Datos y Coberturas',
          'Redacción y Correo Electrónico'
        ]
      },
      skillGroup2: {
        title: 'Sistemas y Herramientas',
        items: [
          'Sistemas de Gestión Informática',
          'Carga de Datos (Data Entry)',
          'Microsoft Excel y Word',
          'Plataformas Digitales Web',
          'Control de Stock y Logística',
          'Desempeño Eficiente bajo Presión'
        ]
      },
      experiences: [
        {
          company: 'UPA 4 (Unidad de Pronta Atención)',
          period: '2022 – Presente',
          role: 'Recepcionista y Administrativa de Gestión',
          bullets: [
            'Recepción principal, atención telefónica y presencial, admisión en sistema informático y validación de documentación y obras sociales.',
            'Coordinación administrativa de turnos, agendas, pases internos y seguimiento de registros digitales.',
            'Carga precisa de datos, gestión de archivos e informes diarios en entorno de alta exigencia.'
          ]
        },
        {
          company: 'Programa Buenos Aires Vacunate',
          period: '2021 – 2022',
          role: 'Administrativa de Registro y Logística Operativa',
          bullets: [
            'Validación y carga masiva de datos en plataforma digital, control de turnos y atención directa al público.',
            'Gestión administrativa de stock, trazabilidad de insumos y carga de reportes diarios.'
          ]
        },
        {
          company: 'Inpacont S.A.',
          period: '2017 – Presente',
          role: 'Auxiliar Operativa',
          bullets: [
            'Cumplimiento metódico de tareas operativas y protocolos de orden institucional.'
          ]
        }
      ]
    };
  }

  const finalSubject = cleanedSubject
    ? cleanedSubject
    : `CV - ${detectedTitle} - Antonella Solange Fernández`;

  const whatsappText = `Hola! Qué tal? Mi nombre es Antonella Fernández, vi la búsqueda de *${detectedTitle}* y me interesa muchísimo postularme. Cuento con experiencia comprobable desde 2021 en recepción, atención al público, manejo de sistemas informáticos, gestión de turnos/admisión y tareas administrativas (actualmente en UPA 4). Resido en Ciudadela (límite con CABA) con disponibilidad inmediata. Adjunto mi CV actualizado. Muchas gracias!`;

  const emailBody = `Estimados,\n\nMe dirijo a ustedes con el fin de postularme a la búsqueda de ${detectedTitle}.\n\nCuento con sólida experiencia comprobable en recepción, atención presencial y telefónica, admisión, validación de obras sociales/documentación, gestión de turnos y carga de datos en sistemas informáticos (desempeñándome desde 2022 a la actualidad en UPA 4 y previamente en el programa Buenos Aires Vacunate).\n\nResido en Ciudadela (a minutos de CABA y Zona Oeste) y cuento con disponibilidad inmediata.\n\nAdjunto mi CV actualizado en formato PDF y quedo a entera disposición para una entrevista.\n\nSaludos cordiales,\nAntonella Solange Fernández\nTel / WhatsApp: ${profile.phone}\nEmail: ${profile.email}`;

  return {
    isJobOffer: true,
    matchScore: score,
    matchReason: isSalud
      ? '¡Match Ideal! Su experiencia en UPA 4 y Vacunate encaja directo con búsquedas de recepción/admisión en salud.'
      : `Buena coincidencia para su perfil de ${detectedTitle} en ${detectedZone}.`,
    jobDetails: {
      title: detectedTitle,
      company: 'Búsqueda Laboral Detectada',
      location: detectedZone,
      zoneValid,
      schedule: 'A convenir',
      contactEmail,
      emailSubject: finalSubject,
      contactPhone,
      applyUrl
    },
    tailoredCV,
    applicationMessages: {
      whatsappText,
      emailSubject: finalSubject,
      emailBody
    },
    usedEngine: 'local-smart-rules'
  };
}

/**
 * Analiza un aviso laboral (texto y/o imagen de flyer) usando Google Gemini 2.5 Flash
 * y adapta el CV de Antonella específicamente a esa oferta.
 */
async function analyzeOfferAndTailorCV({ text = '', imageBuffer = null, imageMimeType = 'image/jpeg', profile }) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return analyzeWithLocalEngine(text, profile);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const systemPrompt = `Sos un asistente experto en Recursos Humanos y Empleabilidad en Buenos Aires, Argentina.
Tu misión es ayudar a postular a Antonella Solange Fernández a ofertas laborales publicadas en canales de WhatsApp y portales de empleo.

DATOS REALES DE ANTONELLA (NUNCA INVENTES EMPRESAS NI ESTUDIOS FALSOS):
${JSON.stringify(profile, null, 2)}

INSTRUCCIONES CLAVE:
1. Analizá el aviso laboral (texto y/o imagen flyer).
2. Determiná si es una oferta laboral real (isJobOffer: true/false).
3. Calculá un matchScore (0 a 100) evaluando:
   - Puestos ideales (85-100 pts): Recepcionista (clínicas, sanatorios, consultorios, centros médicos, estética, odontología, empresas), Admisión de pacientes, Guardia/Internación, Secretaria, Administrativa, Data Entry, Atención al cliente, Recepción comercial.
   - Zonas ideales: Ella vive en Ciudadela (pegado a Liniers / Gral. Paz / Ramos Mejía). Le sirven ofertas en CABA (Capital Federal), GBA Zona Oeste y Remoto. Si queda muy lejos (ej: La Plata, Pilar, Quilmes), bajá el matchScore y avisá en matchReason.
4. Extraé con máxima precisión:
   - contactEmail (si hay correo para mandar CV)
   - emailSubject (SI EL AVISO PIDE PONER UN ASUNTO O REFERENCIA ESPECÍFICA, COPIALO EXACTO; si no, armá uno profesional como "CV - [Puesto] - Antonella Fernández")
   - contactPhone (si hay WhatsApp/teléfono para mandar CV, normalizado para Argentina ej "54911XXXXXXXX")
   - applyUrl (si hay link de formulario o portal)
5. ADAPTACIÓN DEL CV (tailoredCV):
   - Ajustá "headline" al título exacto del puesto que buscan en el aviso.
   - Redactá "summary" (4 a 5 líneas) destacando la experiencia real de Antonella en UPA 4 (2022-Actualidad) y Buenos Aires Vacunate (2021-2022) usando las palabras clave del aviso (ej: turnos, obras sociales, recepción, atención telefónica, sistemas, Excel, admisión, atención al público).
   - Armá 2 grupos de competencias ("skillGroup1" y "skillGroup2", cada uno con 6 etiquetas cortas) alineadas al aviso.
   - En "experiences", incluí siempre UPA 4 (2022 – Presente), Programa Buenos Aires Vacunate (2021 – 2022) e Inpacont S.A. (2017 – Presente), redactando las viñetas (bullets) para resaltar las tareas reales de Antonella que más le importen a este reclutador. No pongas tareas de limpieza/niñera si el puesto es administrativo, de salud o recepción comercial.
6. Redactá los mensajes de postulación ("applicationMessages"):
   - "whatsappText": mensaje de 4-5 líneas cálido, directo y profesional en español argentino para mandarle al WhatsApp del reclutador adjuntando el PDF.
   - "emailSubject": el asunto exacto.
   - "emailBody": cuerpo del mail prolijo y persuasivo.

Respondé ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
{
  "isJobOffer": true,
  "matchScore": 92,
  "matchReason": "...",
  "jobDetails": {
    "title": "...",
    "company": "...",
    "location": "...",
    "zoneValid": true,
    "schedule": "...",
    "contactEmail": "...",
    "emailSubject": "...",
    "contactPhone": "...",
    "applyUrl": "..."
  },
  "tailoredCV": {
    "headline": "...",
    "summary": "...",
    "skillGroup1": { "title": "...", "items": ["...", "..."] },
    "skillGroup2": { "title": "...", "items": ["...", "..."] },
    "experiences": [
      {
        "company": "UPA 4 (Unidad de Pronta Atención)",
        "period": "2022 – Presente",
        "role": "...",
        "bullets": ["...", "...", "..."]
      },
      {
        "company": "Programa Buenos Aires Vacunate",
        "period": "2021 – 2022",
        "role": "...",
        "bullets": ["...", "..."]
      },
      {
        "company": "Inpacont S.A.",
        "period": "2017 – Presente",
        "role": "...",
        "bullets": ["..."]
      }
    ]
  },
  "applicationMessages": {
    "whatsappText": "...",
    "emailSubject": "...",
    "emailBody": "..."
  }
}`;

    const contents = [];
    if (imageBuffer) {
      contents.push({
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: imageMimeType || 'image/jpeg'
        }
      });
    }
    contents.push(
      text
        ? `Texto del aviso laboral:\n${text}`
        : 'Analizá la imagen de este flyer de búsqueda laboral en Buenos Aires y extraé todos los datos.'
    );

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
        temperature: 0.25
      }
    });

    const rawJson = response.text;
    const parsed = JSON.parse(rawJson);

    if (parsed?.jobDetails?.contactPhone) {
      parsed.jobDetails.contactPhone = normalizeArgentinePhone(parsed.jobDetails.contactPhone);
    }

    parsed.usedEngine = 'gemini-3.8-flash';
    return parsed;
  } catch (err) {
    console.error('Error en Gemini API, usando motor local inteligente:', err.message);
    const fallback = analyzeWithLocalEngine(text, profile);
    fallback.geminiError = err.message;
    return fallback;
  }
}

module.exports = {
  analyzeOfferAndTailorCV,
  normalizeArgentinePhone
};
