// LinkedIn finder — Serper search + verification that result matches business

const https = require('https');
const { normalizeForMatch } = require('./serper-places');

async function findLinkedIn(_page, { name, city, country }, log) {
  const result = { companyUrl: null, ownerName: null, ownerUrl: null };
  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return result;

  log(`💼 Searching LinkedIn for: ${name}`);
  const loc = [city, country].filter(Boolean).join(' ');
  const bizNorm = normalizeForMatch(name);

  // Company page
  try {
    const results = await serperSearch(
      `"${name}" ${loc} site:linkedin.com/company`,
      serperKey, country
    );
    for (const r of results) {
      const m = (r.link || '').match(/linkedin\.com\/company\/([A-Za-z0-9._\-]+)/);
      if (!m) continue;
      const slug = m[1].toLowerCase();
      const slugNorm = slug.replace(/[^a-z0-9]/g, '');
      const titleHas = (r.title || '').toLowerCase().includes(name.toLowerCase().slice(0, Math.min(8, name.length)));
      // Verify: slug matches business or title mentions business
      if (titleHas || (bizNorm && slugNorm.includes(bizNorm.slice(0, Math.min(5, bizNorm.length))))) {
        result.companyUrl = `https://www.linkedin.com/company/${m[1]}`.split('?')[0];
        log(`💼 Company: ${result.companyUrl}`);
        break;
      }
    }
  } catch (_) {}

  // Owner/founder — only if we found a company (otherwise risk of wrong match)
  if (result.companyUrl) {
    try {
      const results = await serperSearch(
        `"${name}" ${loc} owner OR founder OR CEO site:linkedin.com/in`,
        serperKey, country
      );
      for (const r of results) {
        const m = (r.link || '').match(/linkedin\.com\/in\/([A-Za-z0-9._\-]+)/);
        if (!m) continue;
        const titleLower = (r.title || '').toLowerCase();
        const snippetLower = (r.snippet || '').toLowerCase();
        const bizLower = name.toLowerCase();
        // Must mention business name in title or snippet
        if (titleLower.includes(bizLower.slice(0, Math.min(8, bizLower.length))) ||
            snippetLower.includes(bizLower.slice(0, Math.min(8, bizLower.length)))) {
          result.ownerUrl = `https://www.linkedin.com/in/${m[1]}`.split('?')[0];
          const titleName = (r.title || '').split(/\s*[-–|]\s*/)[0].trim();
          result.ownerName = titleName || null;
          log(`💼 Owner: ${result.ownerName || result.ownerUrl}`);
          break;
        }
      }
    } catch (_) {}
  }

  return result;
}

async function serperSearch(query, apiKey, country) {
  const body = JSON.stringify({
    q: query,
    gl: getCountryCode(country),
    hl: 'en',
    num: 5,
  });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'google.serper.dev',
      path: '/search',
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).organic || []); }
        catch (_) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(10000, () => { req.destroy(); resolve([]); });
    req.write(body);
    req.end();
  });
}

function getCountryCode(country) {
  const map = { 'saudi arabia': 'sa', 'uae': 'ae', 'united arab emirates': 'ae',
    'egypt': 'eg', 'kuwait': 'kw', 'bahrain': 'bh', 'qatar': 'qa', 'oman': 'om',
    'jordan': 'jo', 'lebanon': 'lb', 'uk': 'gb', 'united kingdom': 'gb',
    'usa': 'us', 'united states': 'us' };
  return map[(country || '').toLowerCase()] || 'sa';
}

module.exports = { findLinkedIn };
