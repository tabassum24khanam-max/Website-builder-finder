// Instagram finder — strict handle verification + data from Serper snippet
// (Avoids direct instagram.com HTTP calls which hang on cloud IPs)

const https = require('https');
const http = require('http');
const { normalizeForMatch } = require('./serper-places');

const BAD_HANDLES = new Set([
  'p', 'explore', 'reel', 'tv', 'stories', 'reels', 'accounts', 'about',
  'help', 'legal', 'press', 'api', 'blog', 'developer', 'developers',
  'privacy', 'safety', 'support', 'directory', 'challenge',
]);

// Common food bloggers / city influencers — never accept these as business handles
const INFLUENCER_KEYWORDS = [
  'foodie', 'foodies', 'food_', '_food', 'eats', 'munchies', 'reviews',
  'blogger', 'influencer', 'guide', 'magazine', 'magaz', 'critic',
  'yummy', 'tasty', 'delicious', 'hungry', 'cravings', 'topfood',
];

function isInfluencerHandle(handle) {
  const lower = handle.toLowerCase();
  return INFLUENCER_KEYWORDS.some(k => lower.includes(k));
}

// Strict check: handle must contain a significant chunk of the business name
function verifyHandle(handle, businessName) {
  if (!handle || !businessName) return false;
  if (BAD_HANDLES.has(handle.toLowerCase())) return false;
  if (isInfluencerHandle(handle)) return false;

  const bizNorm = normalizeForMatch(businessName);
  const handleNorm = handle.toLowerCase().replace(/[._]/g, '');

  if (!bizNorm || bizNorm.length < 3) return true;

  // Take the strongest token from the business name
  const minMatch = Math.min(5, bizNorm.length);
  const bizStart = bizNorm.slice(0, minMatch);

  if (handleNorm.includes(bizStart)) return true;
  if (bizNorm.includes(handleNorm.slice(0, Math.min(5, handleNorm.length)))) return true;

  return false;
}

async function findAndAnalyzeInstagram(_page, { name, city, country, websiteUrl }, log) {
  const result = {
    handle: null, url: null, followers: null, posts: null,
    postsPerMonth: null, lastPost: null, bio: null, phoneFromBio: null, emailFromBio: null,
  };

  // 1. Website URL is itself an Instagram page
  if (websiteUrl) {
    const m = websiteUrl.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/);
    if (m && verifyHandle(m[1], name)) {
      result.handle = m[1];
      result.url = `https://www.instagram.com/${m[1]}/`;
    }
  }

  // 2. Scrape website HTML for Instagram link
  if (!result.handle && websiteUrl) {
    try {
      const html = await fetchUrl(websiteUrl);
      const matches = [...html.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})/g)];
      for (const m of matches) {
        if (verifyHandle(m[1], name)) {
          result.handle = m[1];
          result.url = `https://www.instagram.com/${m[1]}/`;
          log(`📸 Instagram found on website: @${m[1]}`);
          break;
        }
      }
    } catch (_) {}
  }

  // 3. Serper.dev — strict verification on each candidate
  if (!result.handle) {
    const serperKey = process.env.SERPER_API_KEY;
    if (serperKey) {
      try {
        const found = await searchInstagramSerper(name, city, country, serperKey, log);
        if (found) {
          Object.assign(result, found);
        }
      } catch (_) {}
    }
  }

  if (!result.handle) {
    log(`📸 No verified Instagram found for ${name}`);
    return result;
  }

  // Extract phone/email from bio if we got it from the search snippet
  if (result.bio) {
    result.phoneFromBio = extractPhone(result.bio);
    result.emailFromBio = extractEmail(result.bio);
    if (result.phoneFromBio) log(`📞 Phone from IG bio: ${result.phoneFromBio}`);
    if (result.emailFromBio) log(`📬 Email from IG bio: ${result.emailFromBio}`);
  }

  return result;
}

async function searchInstagramSerper(businessName, city, country, apiKey, log) {
  const loc = [city, country].filter(Boolean).join(' ');
  const body = JSON.stringify({
    q: `"${businessName}" ${loc} site:instagram.com`,
    gl: getCountryCode(country),
    hl: 'en',
    num: 10,
  });

  const data = await serperRequest('/search', body, apiKey);
  const results = data.organic || [];

  for (const r of results) {
    const m = (r.link || '').match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/);
    if (!m) continue;
    const handle = m[1];
    if (!verifyHandle(handle, businessName)) {
      continue;
    }

    log(`📸 Verified Instagram: @${handle}`);

    // Extract stats from the search snippet — Google indexes this info from Instagram
    const snippet = `${r.title || ''} ${r.snippet || ''}`;
    const stats = parseInstagramSnippet(snippet);

    return {
      handle,
      url: `https://www.instagram.com/${handle}/`,
      ...stats,
    };
  }

  return null;
}

function parseInstagramSnippet(snippet) {
  const result = { followers: null, posts: null, bio: null };

  const fm = snippet.match(/([\d,.]+\s*[kKmM]?)\s*Followers?/);
  if (fm) result.followers = parseNumber(fm[1]);

  const pm = snippet.match(/([\d,.]+)\s*Posts?/);
  if (pm) result.posts = parseNumber(pm[1]);

  // Bio is typically: "<bio text> · <handle> on Instagram" or after stats
  // Try: text after "Posts -" or before "Followers"
  const bioM = snippet.match(/Posts?\s*[-–—•·]\s*(.+?)(?:\s*[·•]|$)/);
  if (bioM) result.bio = bioM[1].trim().slice(0, 300);

  return result;
}

function extractPhone(text) {
  if (!text) return null;
  // Saudi/UAE/global patterns: +966 5X XXX XXXX, 05X XXX XXXX, +1 etc.
  const m = text.match(/(\+?\d{1,4}[\s\-().]{0,2}\d{1,4}[\s\-().]{0,2}\d{3,4}[\s\-().]{0,2}\d{3,4})/);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return m[1].trim();
}

function extractEmail(text) {
  if (!text) return null;
  const m = text.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,7}\b/);
  return m ? m[0].toLowerCase() : null;
}

async function serperRequest(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'google.serper.dev',
      path,
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
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html',
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next = res.headers.location;
        if (next.startsWith('/')) {
          try { const u = new URL(url); next = `${u.protocol}//${u.host}${next}`; } catch (_) {}
        }
        return fetchUrl(next).then(resolve).catch(reject);
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 200000) res.destroy(); });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseNumber(str) {
  const s = String(str).replace(/[,\s]/g, '').toLowerCase().trim();
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

module.exports = { findAndAnalyzeInstagram, verifyHandle };
