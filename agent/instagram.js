// Instagram finder — no browser/Playwright needed
// Priority: website link → Serper.dev Google search → HTTP meta scrape

const https = require('https');
const http = require('http');

const BAD_HANDLES = new Set([
  'p', 'explore', 'reel', 'tv', 'stories', 'reels', 'accounts', 'about',
  'help', 'legal', 'press', 'api', 'blog', 'developer', 'developers',
  'privacy', 'safety', 'support', 'directory', 'challenge',
]);

async function findAndAnalyzeInstagram(_page, { name, city, country, websiteUrl }, log) {
  const result = {
    handle: null, url: null, followers: null, posts: null,
    postsPerMonth: null, lastPost: null, bio: null,
  };

  // 1. Website URL is itself an Instagram page
  if (websiteUrl) {
    const m = websiteUrl.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/);
    if (m && !BAD_HANDLES.has(m[1].toLowerCase())) {
      result.handle = m[1];
      result.url = `https://www.instagram.com/${m[1]}/`;
    }
  }

  // 2. Scrape website HTML for Instagram link
  if (!result.handle && websiteUrl) {
    try {
      const html = await fetchUrl(websiteUrl);
      const m = html.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?(?:"|'|<|\s|\/)/);
      if (m && !BAD_HANDLES.has(m[1].toLowerCase())) {
        result.handle = m[1];
        result.url = `https://www.instagram.com/${m[1]}/`;
        log(`📸 Instagram found on website: @${m[1]}`);
      }
    } catch (_) {}
  }

  // 3. Serper.dev Google search
  if (!result.handle) {
    const serperKey = process.env.SERPER_API_KEY;
    if (serperKey) {
      try {
        const loc = [city, country].filter(Boolean).join(' ');
        const handle = await searchInstagramSerper(`"${name}" ${loc}`, serperKey, country);
        if (handle) {
          result.handle = handle;
          result.url = `https://www.instagram.com/${handle}/`;
          log(`📸 Found via Serper: @${handle}`);
        }
      } catch (_) {}
    }
  }

  if (!result.handle) return result;

  // 4. Scrape Instagram profile meta (no browser — HTTP only)
  log(`📸 Analyzing @${result.handle}...`);
  try {
    const profile = await scrapeInstagramMeta(result.handle);
    Object.assign(result, profile);
  } catch (_) {}

  return result;
}

async function searchInstagramSerper(query, apiKey, country) {
  const results = await serperSearch(`${query} site:instagram.com`, apiKey, country);
  for (const r of results) {
    // Check the direct link
    const linkM = (r.link || '').match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/);
    if (linkM && !BAD_HANDLES.has(linkM[1].toLowerCase())) return linkM[1];

    // Check snippet/title for @handle mentions
    const text = `${r.title || ''} ${r.snippet || ''}`;
    const textM = text.match(/instagram\.com\/([A-Za-z0-9._]{2,30})|@([A-Za-z0-9._]{2,30})/);
    if (textM) {
      const handle = textM[1] || textM[2];
      if (handle && !BAD_HANDLES.has(handle.toLowerCase())) return handle;
    }
  }
  return null;
}

async function scrapeInstagramMeta(handle) {
  const result = { followers: null, posts: null, postsPerMonth: null, lastPost: null, bio: null };

  try {
    const html = await fetchUrl(`https://www.instagram.com/${handle}/`, {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Accept-Language': 'en-US,en;q=0.9',
    });

    // Meta description often: "X Followers, Y Following, Z Posts — See Instagram..."
    const desc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1]
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i)?.[1]
      || '';

    const fm = desc.match(/([\d,.]+[kKmM]?)\s*Followers?/i);
    if (fm) result.followers = parseNumber(fm[1]);

    const pm = desc.match(/([\d,.]+[kKmM]?)\s*Posts?/i);
    if (pm) result.posts = parseNumber(pm[1]);

    // Title format: "username (@handle) • X Followers, Y Following, Z Posts"
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    if (!result.followers) {
      const tf = title.match(/([\d,.]+[kKmM]?)\s*Followers?/i);
      if (tf) result.followers = parseNumber(tf[1]);
    }

    // Bio from meta
    const bioM = desc.match(/^(.+?)\s*[-–•]\s*[\d,]+ Followers/i);
    if (bioM) result.bio = bioM[1].trim();
  } catch (_) {}

  return result;
}

async function serperSearch(query, apiKey, country) {
  const body = JSON.stringify({
    q: query,
    gl: country ? getCountryCode(country) : 'sa',
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

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html',
        ...extraHeaders,
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next = res.headers.location;
        if (next.startsWith('/')) {
          try { const u = new URL(url); next = `${u.protocol}//${u.host}${next}`; } catch (_) {}
        }
        return fetchUrl(next, extraHeaders).then(resolve).catch(reject);
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 200000) res.destroy(); });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseNumber(str) {
  const s = String(str).replace(/,/g, '').toLowerCase().trim();
  if (s.endsWith('k')) return Math.round(parseFloat(s) * 1000);
  if (s.endsWith('m')) return Math.round(parseFloat(s) * 1000000);
  return parseInt(s) || null;
}

function getCountryCode(country) {
  const map = { 'saudi arabia': 'sa', 'uae': 'ae', 'united arab emirates': 'ae',
    'egypt': 'eg', 'kuwait': 'kw', 'bahrain': 'bh', 'qatar': 'qa', 'oman': 'om',
    'jordan': 'jo', 'lebanon': 'lb', 'uk': 'gb', 'united kingdom': 'gb',
    'usa': 'us', 'united states': 'us' };
  return map[(country || '').toLowerCase()] || 'sa';
}

module.exports = { findAndAnalyzeInstagram };
