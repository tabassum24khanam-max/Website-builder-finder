// Business discovery using Serper.dev /places endpoint + enrichment
// If /places returns incomplete data (no phone/website), we run one extra
// /search query per business to fill in the gaps.

const https = require('https');

const CHAIN_DENYLIST = [
  'starbucks', 'mcdonald', 'kfc', 'subway', 'burger king', 'pizza hut',
  'domino', 'costa coffee', 'tim horton', 'dunkin', 'baskin', 'shake shack',
  'five guys', 'nando', 'hardee', 'al baik', 'albaik', 'herfy', 'kudu',
  'gym nation', 'body masters', 'fitness time', 'anytime fitness',
  "gold's gym", 'planet fitness', 'fitness first', 'snap fitness',
  'curves for women', 'the coffee bean', 'caribou coffee', 'pinkberry',
  'papa john', 'little caesar', 'popeyes', 'taco bell', 'wendys',
  'applebee', 'ihop', 'denny', 'dairy queen', 'cold stone creamery',
  'century 21', 're/max', 'keller williams', 'coldwell banker',
  'mr biryani', 'mr. biryani', 'biryani house', 'paradise biryani',
  'bombay chowpatty', 'spicy spices',
];

function isChain(name) {
  const lower = (name || '').toLowerCase();
  for (const chain of CHAIN_DENYLIST) {
    if (lower.includes(chain)) return true;
  }
  // "Branch" / "فرع" / branch numbers
  if (/\bbranch\b|فرع|فروع|\bno\.\s*\d+|\s#\s*\d+/i.test(name)) return true;
  // Marketing chain listings: name with 2+ "|" separators and "best/top/leading"
  const pipes = (name.match(/\|/g) || []).length;
  if (pipes >= 2 && /\b(best|top|leading|premium|finest)\b/i.test(name)) return true;
  return false;
}

async function findBusinessesSerper({ category, location, country, limit = 20, log }) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY not set');

  const fullLocation = `${location}${country ? ', ' + country : ''}`;
  log(`🔍 Serper Places: "${category}" in ${fullLocation}...`);

  const body = JSON.stringify({
    q: `${category} in ${fullLocation}`,
    gl: getCountryCode(country),
    hl: 'en',
  });

  const rawResults = await serperRequest('/places', body, apiKey);
  const places = rawResults.places || [];

  if (!places.length) {
    log('⚠️  Serper Places returned no results');
    return [];
  }

  log(`📋 Found ${places.length} results — filtering chains...`);

  const businesses = [];
  for (const p of places) {
    const name = p.title || '';
    if (!name) continue;
    if (isChain(name)) {
      log(`⏭️  Chain skipped: ${name}`);
      continue;
    }
    businesses.push({
      name,
      category,
      address: p.address || null,
      phone: normalizePhone(p.phoneNumber || p.phone),
      website: cleanUrl(p.website),
      rating: p.rating || null,
      reviewCount: p.ratingCount || 0,
      lat: p.latitude || null,
      lng: p.longitude || null,
      photoUrl: p.thumbnailUrl || null,
      mapsUrl: p.cid
        ? `https://www.google.com/maps?cid=${p.cid}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + (p.address || fullLocation))}`,
    });
    if (businesses.length >= limit) break;
  }

  log(`✅ ${businesses.length} local independent businesses found`);
  return businesses;
}

// Single follow-up Serper search to fill in missing phone / website / Instagram
async function enrichMissingFields(business, location, country, log) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return business;

  const missing = [];
  if (!business.phone) missing.push('phone');
  if (!business.website) missing.push('website');
  if (missing.length === 0) return business;

  log(`🔎 Enriching ${business.name} (missing: ${missing.join(', ')})...`);

  const body = JSON.stringify({
    q: `"${business.name}" ${location}${country ? ' ' + country : ''}`,
    gl: getCountryCode(country),
    hl: 'en',
    num: 8,
  });

  let data;
  try { data = await serperRequest('/search', body, apiKey); }
  catch (_) { return business; }

  // Knowledge graph often has phone + website directly
  const kg = data.knowledgeGraph || {};
  if (!business.phone && kg.phoneNumber) business.phone = normalizePhone(kg.phoneNumber);
  if (!business.website && kg.website) business.website = cleanUrl(kg.website);
  if (!business.address && kg.address) business.address = kg.address;

  // Scan organic results for phone (snippet) + plausible website
  const bizNorm = normalizeForMatch(business.name);
  for (const r of (data.organic || [])) {
    const link = r.link || '';
    const snippet = `${r.title || ''} ${r.snippet || ''}`;

    // Phone from snippet
    if (!business.phone) {
      const phoneM = snippet.match(/(\+?\d{1,4}[\s\-().]{0,2}\d{1,4}[\s\-().]{0,2}\d{3,4}[\s\-().]{0,2}\d{3,4})/);
      if (phoneM) {
        const digits = phoneM[1].replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) business.phone = normalizePhone(phoneM[1]);
      }
    }

    // Website: skip socials + directories, verify domain matches business name
    if (!business.website && link && !isSocialOrDirectory(link)) {
      try {
        const host = new URL(link).hostname.replace(/^www\./, '');
        const hostNorm = host.replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        const snipMatch = snippet.toLowerCase().includes(business.name.toLowerCase().slice(0, Math.min(10, business.name.length)));
        if ((bizNorm && hostNorm.includes(bizNorm.slice(0, Math.min(5, bizNorm.length)))) || snipMatch) {
          business.website = cleanUrl(link);
          log(`🌐 Found website via search: ${business.website}`);
        }
      } catch (_) {}
    }

    if (business.phone && business.website) break;
  }

  return business;
}

function normalizePhone(p) {
  if (!p) return null;
  const s = String(p).trim();
  if (!s) return null;
  // Keep + and digits and common separators, strip everything else
  const cleaned = s.replace(/[^\d+\s().\-]/g, '').trim();
  return cleaned.length >= 7 ? cleaned : null;
}

function cleanUrl(u) {
  if (!u) return null;
  let url = String(u).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); return url; } catch (_) { return null; }
}

function isSocialOrDirectory(url) {
  return /instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|youtube\.com|twitter\.com|x\.com|snapchat\.com|pinterest\.com|tripadvisor\.|yelp\.|foursquare\.|zomato\.|trustpilot\.|google\.[a-z.]+\/maps|maps\.google|wikipedia\.org|wikiwand\.|wikidata\.|yelp\.com|opentable\.|grubhub\.|doordash\.|ubereats\.|talabat\.|hungerstation\.|noon\.com|amazon\.|booking\.com|agoda\.|expedia\.|justdial\.|sulekha\.|menupages\./i.test(url);
}

function normalizeForMatch(name) {
  return (name || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(cafe|restaurant|bistro|kitchen|coffee|coffeehouse|shop|salon|gym|fitness|spa|boutique|store|the|and|of|sa|ksa|uae|al|el|de|la|le|los|las)\b/gi, '')
    .replace(/\s+/g, '')
    .trim();
}

function serperRequest(path, body, apiKey) {
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
        try {
          const parsed = JSON.parse(d);
          if (parsed.message && !parsed.places && !parsed.organic) reject(new Error(parsed.message));
          else resolve(parsed);
        } catch (e) { reject(new Error(`Parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function getCountryCode(country) {
  const map = {
    'saudi arabia': 'sa', 'uae': 'ae', 'united arab emirates': 'ae',
    'egypt': 'eg', 'kuwait': 'kw', 'bahrain': 'bh', 'qatar': 'qa', 'oman': 'om',
    'jordan': 'jo', 'lebanon': 'lb', 'uk': 'gb', 'united kingdom': 'gb',
    'usa': 'us', 'united states': 'us',
  };
  return map[(country || '').toLowerCase()] || 'sa';
}

module.exports = { findBusinessesSerper, enrichMissingFields, normalizeForMatch, isSocialOrDirectory };
