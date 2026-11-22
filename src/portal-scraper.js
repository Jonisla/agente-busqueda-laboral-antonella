const crypto = require('crypto');
const cheerio = require('cheerio');

const SEARCH_QUERIES = [
  {
    id: 'recepcionista-salud-caba',
    label: 'Recepcionista Clínica / Salud (CABA)',
    url: 'https://ar.computrabajo.com/trabajo-de-recepcionista-salud-en-capital-federal'
  },
  {
    id: 'recepcionista-oeste',
    label: 'Recepcionista / Administrativa (GBA Oeste)',
    url: 'https://ar.computrabajo.com/trabajo-de-recepcionista-en-gba-oeste'
  },
  {
    id: 'admision-caba',
    label: 'Admisión / Guardia / Consultorio (CABA)',
    url: 'https://ar.computrabajo.com/trabajo-de-admision-en-capital-federal'
  },
  {
    id: 'atencion-cliente-oeste',
    label: 'Atención al Cliente / Administración (GBA Oeste)',
    url: 'https://ar.computrabajo.com/trabajo-de-administrativa-en-gba-oeste'
  }
];

async function fetchPortalOffers(queryId = 'all') {
  const targets =
    queryId === 'all' ? SEARCH_QUERIES : SEARCH_QUERIES.filter((q) => q.id === queryId);

  const results = [];

  for (const target of targets) {
    try {
      const res = await fetch(target.url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'es-AR,es;q=0.9'
        }
      });

      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      $('article.box_offer').each((i, el) => {
        if (i >= 6) return;
        const titleEl = $(el).find('h2 a.js-o-link').first();
        const title = titleEl.text().trim();
        const href = titleEl.attr('href');
        if (!title) return;

        const fullUrl = href?.startsWith('http')
          ? href
          : `https://ar.computrabajo.com${href || ''}`;

        const company =
          $(el).find('p.dIB a, p.fs16').first().text().trim() || 'Empresa / Institución en Buenos Aires';
        const location =
          $(el).find('p.fs16 span').last().text().trim() || target.label;
        const snippet =
          $(el).find('p.mb10, p.fc_aux').text().trim() ||
          `Búsqueda activa de ${title} en ${location}.`;

        results.push({
          id: crypto.createHash('md5').update(fullUrl || title).digest('hex').slice(0, 14),
          source: 'Computrabajo BA',
          categoryLabel: target.label,
          title,
          company,
          location,
          snippet,
          url: fullUrl
        });
      });
    } catch (err) {
      console.error(`Error consultando ${target.label}:`, err.message);
    }
  }

  return results;
}

async function fetchOfferDetail(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'es-AR,es;q=0.9'
      }
    });
    if (!res.ok) return '';
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = $('h1').first().text().trim();
    const desc = $('div[div-link="oferta"], .box_detail').text().replace(/\s+/g, ' ').trim();
    return `${title}\n\n${desc}\n\nLink para postular: ${url}`;
  } catch (err) {
    return `Link de la oferta: ${url}`;
  }
}

module.exports = {
  SEARCH_QUERIES,
  fetchPortalOffers,
  fetchOfferDetail
};
