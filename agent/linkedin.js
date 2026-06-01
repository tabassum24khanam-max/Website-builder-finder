// LinkedIn finder — Serper search + verification that the result matches the
// business. Most small local businesses have no LinkedIn; returning nothing is
// the normal, correct outcome (better empty than a wrong company).

const { serper, normalizeForMatch, getCountryCode, cleanSearchName } = require('./util');

async function findLinkedIn({ name, city, country }, log) {
  const result = { companyUrl: null, ownerName: null, ownerUrl: null };
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return result;

  const sn = cleanSearchName(name);
  const nameCore = normalizeForMatch(sn);
  const namePrefix = sn.toLowerCase().slice(0, Math.min(8, sn.length));

  // Very short/generic names ("ON", "Drip") can't be matched reliably — any
  // LinkedIn hit would be a guess (this produced the wrong "Future Link for
  // Technology" match for "ON"). Better to return nothing than a wrong company.
  if (nameCore.length < 4) {
    log(`💼 Skipping LinkedIn for "${name}" — name too generic to match reliably`);
    return result;
  }

  log(`💼 Searching LinkedIn for: ${name}`);
  const loc = [city, country].filter(Boolean).join(' ');

  // Company page
  try {
    const data = await serper('/search', { q: `${sn} ${loc} site:linkedin.com/company`, gl: getCountryCode(country), hl: 'en', num: 5 }, apiKey, 9000);
    for (const r of (data.organic || [])) {
      const m = (r.link || '').match(/linkedin\.com\/company\/([A-Za-z0-9._\-]+)/i);
      if (!m) continue;
      const slugCore = m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
      const titleHas = (r.title || '').toLowerCase().includes(namePrefix);
      if (titleHas || (nameCore && nameCore.length >= 3 && slugCore.includes(nameCore.slice(0, Math.min(5, nameCore.length))))) {
        result.companyUrl = `https://www.linkedin.com/company/${m[1]}`.split('?')[0];
        log(`💼 Company: ${result.companyUrl}`);
        break;
      }
    }
  } catch {}

  // Owner/founder — only if we found a verified company (avoids wrong people).
  if (result.companyUrl) {
    try {
      const data = await serper('/search', { q: `${sn} ${loc} owner OR founder OR CEO site:linkedin.com/in`, gl: getCountryCode(country), hl: 'en', num: 5 }, apiKey, 9000);
      for (const r of (data.organic || [])) {
        const m = (r.link || '').match(/linkedin\.com\/in\/([A-Za-z0-9._\-]+)/i);
        if (!m) continue;
        const blob = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
        if (blob.includes(namePrefix)) {
          result.ownerUrl = `https://www.linkedin.com/in/${m[1]}`.split('?')[0];
          result.ownerName = (r.title || '').split(/\s*[-–|]\s*/)[0].trim() || null;
          log(`💼 Owner: ${result.ownerName || result.ownerUrl}`);
          break;
        }
      }
    } catch {}
  }

  return result;
}

module.exports = { findLinkedIn };
