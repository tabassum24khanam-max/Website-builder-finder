// Business discovery using Serper.dev /places endpoint
// Returns Google Maps-style results: name, phone, address, coords, rating, website
// One API call per search — no scraping, works from cloud IPs

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
];

function isChain(name) {
  const lower = (name || '').toLowerCase();
  for (const chain of CHAIN_DENYLIST) {
    if (lower.includes(chain)) return true;
  }
  if (/\bbranch\b|فرع|فروع|\bno\.\s*\d+|\s#\s*\d+/i.test(name)) return true;
  return false;
}

async function findBusinessesSerper({ category, location, country, radius_km = 5, limit = 20, log }) {
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

  const results = [];
  for (const p of places) {
    const name = p.title || '';
    if (!name) continue;
    if (isChain(name)) {
      log(`⏭️  Chain skipped: ${name}`);
      continue;
    }

    results.push({
      name,
      category,
      address: p.address || null,
      phone: p.phoneNumber || p.phone || null,
      website: p.website || null,
      rating: p.rating || null,
      reviewCount: p.ratingCount || 0,
      lat: p.latitude || null,
      lng: p.longitude || null,
      photoUrl: p.thumbnailUrl || null,
      mapsUrl: p.cid
        ? `https://www.google.com/maps?cid=${p.cid}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + (p.address || fullLocation))}`,
    });

    if (results.length >= limit) break;
  }

  log(`✅ ${results.length} local independent businesses ready for enrichment`);
  return results;
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
          if (parsed.message && !parsed.places) reject(new Error(parsed.message));
          else resolve(parsed);
        } catch (e) { reject(new Error(`Parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
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

module.exports = { findBusinessesSerper };
