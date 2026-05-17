// Email finder — multi-source: website contact page, Instagram bio, DDG search, Hunter.io
const https = require('https');
const http = require('http');

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,7}\b/g;
const BAD_DOMAINS = new Set([
  'example.com','yourdomain.com','test.com','domain.com','sentry.io',
  'google.com','apple.com','microsoft.com','amazon.com','duckduckgo.com',
  'wixpress.com','squarespace.com','wordpress.com','shopify.com',
  'schema.org','w3.org','openstreetmap.org',
]);

async function findEmail({ name, city, country, website, instagramBio }, log) {
  const candidates = new Set();

  // 1. Extract from Instagram bio if we have it
  if (instagramBio) {
    for (const e of (instagramBio.match(EMAIL_RE) || [])) {
      if (isGood(e)) candidates.add(e.toLowerCase());
    }
  }

  // 2. Scrape website contact page
  if (website && !/instagram|facebook|linkedin/.test(website)) {
    try {
      const html = await fetchPage(website);
      for (const e of (html.match(EMAIL_RE) || [])) {
        if (isGood(e)) candidates.add(e.toLowerCase());
      }
      // Also try /contact URL
      if (candidates.size === 0) {
        const base = new URL(website.startsWith('http') ? website : 'https://' + website);
        const contactHtml = await fetchPage(`${base.origin}/contact`).catch(() => '');
        for (const e of (contactHtml.match(EMAIL_RE) || [])) {
          if (isGood(e)) candidates.add(e.toLowerCase());
        }
      }
    } catch (_) {}
  }

  // 3. DuckDuckGo search for email
  if (candidates.size === 0) {
    try {
      const q = encodeURIComponent(`"${name}" ${city || ''} ${country || ''} email contact`);
      const html = await fetchPage(`https://html.duckduckgo.com/html/?q=${q}`, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
        'Referer': 'https://duckduckgo.com/',
      });
      for (const e of (html.match(EMAIL_RE) || [])) {
        if (isGood(e)) candidates.add(e.toLowerCase());
      }
    } catch (_) {}
  }

  // 4. Hunter.io (optional, free tier: 25/month)
  if (candidates.size === 0 && process.env.HUNTER_API_KEY && website) {
    try {
      const domain = new URL(website.startsWith('http') ? website : 'https://' + website).hostname;
      const hunterUrl = `https://api.hunter.io/v2/domain-search?domain=${domain}&limit=3&api_key=${process.env.HUNTER_API_KEY}`;
      const json = JSON.parse(await fetchPage(hunterUrl));
      for (const e of (json.data?.emails || [])) {
        if (e.value && isGood(e.value)) candidates.add(e.value.toLowerCase());
      }
    } catch (_) {}
  }

  const email = [...candidates][0] || null;
  if (email) log(`📬 Email found: ${email}`);
  return email;
}

function isGood(email) {
  const lower = email.toLowerCase();
  return !BAD_DOMAINS.has(lower.split('@')[1]) &&
    !lower.includes('@2x') &&
    !lower.endsWith('.png') &&
    !lower.endsWith('.jpg') &&
    lower.includes('@');
}

function fetchPage(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html',
        ...extraHeaders,
      },
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchPage(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 300000) res.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = { findEmail };
