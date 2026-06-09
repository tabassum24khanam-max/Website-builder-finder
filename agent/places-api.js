// Business discovery using Google Places API (New)
// One API call returns name, phone, address, website, coords, photo — no scraping

const https = require('https');

const PLACES_BASE = 'https://places.googleapis.com/v1';

// Known chains to reject regardless of what the AI finds
const CHAIN_DENYLIST = [
  'starbucks', 'mcdonald', 'kfc', 'subway', 'burger king', 'pizza hut',
  'domino', 'costa coffee', 'tim horton', 'dunkin', 'baskin', 'shake shack',
  'five guys', 'nando', 'hardee', 'al baik', 'albaik', 'herfy', 'kudu',
  'gym nation', 'body masters', 'fitness time', 'anytime fitness',
  "gold's gym", 'planet fitness', 'fitness first', 'snap fitness',
  'curves for women', 'crossfit interval', 'interval plus crossfit',
  'the coffee bean', 'caribou coffee', 'pinkberry', 'robeks',
  'papa john', 'little caesar', 'popeyes', 'taco bell', 'wendys',
  'applebee', 'ihop', 'denny', 'outback steakhouse', 'chillis',
  'steak n shake', 'sonic drive', 'dairy queen', 'cold stone',
  'century 21', 're/max', 'keller williams', 'coldwell banker',
  'chipotle', 'panera', 'chick-fil-a', 'chickfila', 'sweetgreen', 'pret a manger',
  "gregory's coffee", 'gregorys coffee', 'blue bottle', 'bluestone lane', 'joe & the juice',
  '7-eleven', 'crumbl', 'white castle', 'le pain quotidien', 'paris baguette', 'tous les jours',
  'wingstop', 'bareburger', 'dos toros', 'dig inn', 'juice press', 'playa bowls', 'jollibee',
  'panda express', 'olive garden', 'red lobster', 'cheesecake factory', 'buffalo wild wings',
  'chopt', 'auntie anne', 'jamba juice', 'pollo loco',
];

function isChain(name) {
  const lower = (name || '').toLowerCase();
  for (const chain of CHAIN_DENYLIST) {
    if (lower.includes(chain)) return true;
  }
  // "Branch" / "فرع" in the name almost always means a franchise location
  if (/\bbranch\b|فرع|فروع|\bno\.\s*\d+|\s#\s*\d+/i.test(name)) return true;
  return false;
}

async function findBusinessesPlaces({ category, location, country, lat, lng, radius_km = 5, limit = 20, log }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not set in environment');

  const fullLocation = `${location}${country ? ', ' + country : ''}`;
  log(`🔍 Google Places: "${category}" near ${fullLocation}...`);

  // Resolve coordinates if not provided
  let centerLat = lat, centerLng = lng;
  if (!centerLat || !centerLng) {
    const coords = await geocodeCity(location, country, apiKey);
    centerLat = coords.latitude;
    centerLng = coords.longitude;
    log(`📍 Geocoded to ${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}`);
  }

  const requestBody = {
    textQuery: `local independent ${category} in ${fullLocation}`,
    maxResultCount: Math.min(limit * 2, 20),
    languageCode: 'en',
    locationBias: {
      circle: {
        center: { latitude: centerLat, longitude: centerLng },
        radius: (radius_km || 5) * 1000,
      },
    },
  };

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.nationalPhoneNumber',
    'places.internationalPhoneNumber',
    'places.websiteUri',
    'places.rating',
    'places.userRatingCount',
    'places.location',
    'places.photos',
    'places.types',
    'places.businessStatus',
  ].join(',');

  let data;
  try {
    data = await postJson(`${PLACES_BASE}/places:searchText`, requestBody, {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    });
  } catch (e) {
    throw new Error(`Google Places API error: ${e.message}`);
  }

  if (!data.places || !data.places.length) {
    log('⚠️  Google Places returned no results');
    return [];
  }

  log(`📋 Places found ${data.places.length} businesses — filtering chains...`);

  const filtered = [];
  for (const place of data.places) {
    const name = place.displayName?.text || place.displayName || '';
    if (!name) continue;
    if (place.businessStatus === 'CLOSED_PERMANENTLY') continue;
    if (isChain(name)) {
      log(`⏭️  Chain skipped: ${name}`);
      continue;
    }
    filtered.push({ place, name });
    if (filtered.length >= limit) break;
  }

  log(`✅ ${filtered.length} local independent businesses`);

  // Fetch photo CDN URLs concurrently (non-blocking on failure)
  const results = await Promise.all(filtered.map(async ({ place, name }) => {
    let photoUrl = null;
    if (place.photos && place.photos[0]) {
      try {
        photoUrl = await fetchPhotoUrl(place.photos[0].name, apiKey);
      } catch (_) {}
    }

    return {
      name,
      category,
      address: place.formattedAddress || null,
      phone: place.nationalPhoneNumber || place.internationalPhoneNumber || null,
      website: place.websiteUri || null,
      rating: place.rating || null,
      reviewCount: place.userRatingCount || 0,
      lat: place.location?.latitude || null,
      lng: place.location?.longitude || null,
      photoUrl,
      mapsUrl: place.id
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${place.id}`
        : null,
    };
  }));

  return results;
}

async function geocodeCity(location, country, apiKey) {
  const body = {
    textQuery: `${location}${country ? ', ' + country : ''}`,
    maxResultCount: 1,
  };
  try {
    const data = await postJson(`${PLACES_BASE}/places:searchText`, body, {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.location',
    });
    if (data.places?.[0]?.location) return data.places[0].location;
  } catch (_) {}
  return { latitude: 24.7136, longitude: 46.6753 }; // Riyadh fallback
}

async function fetchPhotoUrl(photoName, apiKey) {
  // skipHttpRedirect=true → returns JSON with photoUri (CDN URL, no key needed)
  const url = `${PLACES_BASE}/${photoName}/media?maxHeightPx=600&maxWidthPx=800&skipHttpRedirect=true&key=${apiKey}`;
  const data = await getJson(url);
  return data.photoUri || null;
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed);
        } catch (e) { reject(new Error(`Parse error: ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error: ${d.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

module.exports = { findBusinessesPlaces };
