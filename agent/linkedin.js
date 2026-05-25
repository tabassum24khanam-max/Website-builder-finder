// LinkedIn finder — no browser/Playwright needed, uses Serper.dev Google search

const https = require('https');

async function findLinkedIn(_page, { name, city, country }, log) {
  const result = { companyUrl: null, ownerName: null, ownerUrl: null };

  const serperKey = process.env.SERPER_API_KEY;
  if (!serperKey) return result;

  log(`💼 Searching LinkedIn for: ${name}`);
  const loc = [city, country].filter(Boolean).join(' ');

  // Company page
  try {
    const results = await serperSearch(
      `"${name}" ${loc} site:linkedin.com/company`,
      serperKey, country
    );
    for (const r of results) {
      const m = (r.link || '').match(/linkedin\.com\/company\/([A-Za-z0-9._\-]+)/);
      if (m) {
        result.companyUrl = `https://www.linkedin.com/company/${m[1]}`.split('?')[0];
        log(`💼 Company: ${result.companyUrl}`);
        break;
      }
    }
  } catch (_) {}

  // Owner/founder profile
  try {
    const results = await serperSearch(
      `"${name}" ${loc} owner OR founder OR CEO site:linkedin.com/in`,
      serperKey, country
    );
    for (const r of results) {
      const m = (r.link || '').match(/linkedin\.com\/in\/([A-Za-z0-9._\-]+)/);
      if (m) {
        result.ownerUrl = `https://www.linkedin.com/in/${m[1]}`.split('?')[0];
        // Extract real name from result title (e.g. "Ahmed Al-Rashid - Owner - Cafe Name | LinkedIn")
        const titleName = (r.title || '').split(/\s*[-–|]\s*/)[0].trim();
        result.ownerName = titleName || m[1].replace(/-\d+$/, '').replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase()).trim() || null;
        log(`💼 Owner: ${result.ownerName || result.ownerUrl}`);
        break;
      }
    }
  } catch (_) {}

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
