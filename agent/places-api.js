// Business discovery using Google Places API (New)
// One API call returns name, phone, address, website, coords, photo — no scraping

const https = require('https');
const { haversineKm, isSocialOrDirectory, extractSocialHandle } = require('./util');

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
  // US / NYC national chains (distinctive names only, to avoid false matches)
  'chipotle', 'panera', 'chick-fil-a', 'chickfila', 'sweetgreen', 'pret a manger',
  "gregory's coffee", 'gregorys coffee', 'blue bottle', 'bluestone lane', 'joe & the juice',
  '7-eleven', 'crumbl', 'white castle', 'le pain quotidien', 'paris baguette', 'tous les jours',
  'wingstop', 'bareburger', 'dos toros', 'dig inn', 'juice press', 'playa bowls', 'jollibee',
  'panda express', 'olive garden', 'red lobster', 'cheesecake factory', 'buffalo wild wings',
  'chopt', 'auntie anne', 'jamba juice', 'pollo loco',
  'gong cha', 'heytea', 'joe coffee', 'kung fu tea', 'sharetea', 'coco fresh', 'tiger sugar', 'spot dessert', 'paris baguette',
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

async function findBusinessesPlaces({ category, location, city, neighborhood, zip, country, lat, lng, radius_km = 5, limit = 20, log }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not set in environment');

  const cityLabel = city || location || '';
  const areaText = [neighborhood, cityLabel].filter(Boolean).join(', ') || cityLabel;
  const fullArea = `${areaText}${country ? ', ' + country : ''}`;
  log(`🔍 Google Places: "${category}" in ${fullArea}...`);

  // Center: a map pin if given, else a Google geocode of the area (reliable).
  let centerLat = lat, centerLng = lng;
  if (!centerLat || !centerLng) {
    const coords = await geocodeCity(areaText, country, apiKey);
    centerLat = coords.latitude;
    centerLng = coords.longitude;
    log(`📍 Center: ${centerLat.toFixed(4)}, ${centerLng.toFixed(4)}`);
  }

  const fieldMask = [
    'places.id', 'places.displayName', 'places.formattedAddress',
    'places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.websiteUri',
    'places.rating', 'places.userRatingCount', 'places.location',
    'places.types', 'places.businessStatus', 'nextPageToken',
  ].join(',');

  const rawPlaces = [];

  // POINT-ZERO PASS — searchNearby with rankPreference DISTANCE is the ONLY
  // Google API that returns places strictly nearest-first from a point (text
  // search ranks by prominence and misses small spots near the pin). Run it
  // first whenever we have a pin/geocode; the text pass below tops up.
  const NEARBY_TYPES = {
    'Cafes': ['cafe', 'coffee_shop'], 'Restaurants': ['restaurant'], 'Bakeries': ['bakery'],
    'Barbershops': ['barber_shop', 'hair_salon'], 'Salons': ['beauty_salon', 'nail_salon'],
    'Clinics': ['doctor', 'medical_lab'], 'Dental': ['dental_clinic', 'dentist'],
    'Gyms': ['gym', 'fitness_center'], 'Pharmacies': ['pharmacy', 'drugstore'],
    'Hotels': ['hotel', 'motel'], 'Car Repair': ['car_repair'], 'Law Offices': ['lawyer'],
  };
  const nearbyTypes = NEARBY_TYPES[category];
  if (centerLat && centerLng && nearbyTypes) {
    try {
      const data = await postJson(`${PLACES_BASE}/places:searchNearby`, {
        includedTypes: nearbyTypes,
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        languageCode: 'en',
        locationRestriction: { circle: { center: { latitude: centerLat, longitude: centerLng }, radius: Math.min((radius_km || 5) * 1000, 50000) } },
      }, { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask.replace(',nextPageToken', '') });
      const got = data.places || [];
      if (got.length) log(`🎯 Nearest-first scan: ${got.length} places from point zero`);
      rawPlaces.push(...got);
    } catch (e) { log(`⚠️  Nearby scan failed (${e.message}) — using text search only`, 'warn'); }
  }

  // TEXT PASS — up to 2 pages (≈40 candidates) so we still hit the requested
  // count after chain + locality filtering.
  let pageToken = null;
  for (let page = 0; page < 2; page++) { // 2 pages (≈40 candidates) — keeps cost down
    const requestBody = {
      textQuery: `${category} in ${fullArea}`,
      maxResultCount: 20,
      languageCode: 'en',
      locationBias: {
        circle: {
          center: { latitude: centerLat, longitude: centerLng },
          radius: Math.min((radius_km || 5) * 1000, 50000),
        },
      },
    };
    if (pageToken) requestBody.pageToken = pageToken;
    let data;
    try {
      data = await postJson(`${PLACES_BASE}/places:searchText`, requestBody, {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      });
    } catch (e) {
      if (page === 0) throw new Error(`Google Places API error: ${e.message}`);
      break;
    }
    for (const p of (data.places || [])) rawPlaces.push(p);
    pageToken = data.nextPageToken || null;
    if (!pageToken || rawPlaces.length >= limit * 3) break;
  }

  if (!rawPlaces.length) {
    log('⚠️  Google Places returned no results');
    return [];
  }

  // HARD locality filter — same guarantee as the Serper path: tight when a
  // sub-area was targeted (pin / zip / neighbourhood), wider for a whole city.
  const targeted = !!(lat && lng) || !!zip || !!neighborhood;
  // Small grace over the chosen radius; no 3km floor — 1km must mean 1km.
  const filterKm = targeted ? Math.max((radius_km || 5) * 1.3, 1.2) : 30;

  const out = [];
  const seenIds = new Set(); // nearby + text passes overlap — dedupe by id/name
  for (const place of rawPlaces) {
    const name = place.displayName?.text || place.displayName || '';
    if (!name) continue;
    const dupKey = place.id || name.toLowerCase();
    if (seenIds.has(dupKey)) continue;
    seenIds.add(dupKey);
    if (place.businessStatus === 'CLOSED_PERMANENTLY') continue;
    if (isChain(name)) { log(`⏭️  Chain skipped: ${name}`); continue; }
    const plat = place.location?.latitude, plng = place.location?.longitude;
    if (typeof plat === 'number' && typeof plng === 'number') {
      if (haversineKm(centerLat, centerLng, plat, plng) > filterKm) continue;
    }
    // Some tiny businesses list an Instagram/TikTok link as their Google Maps
    // "website" (no real site) — first-party data, so trust it as a social
    // handle directly instead of letting it masquerade as a website.
    const placeWebsite = place.websiteUri || null;
    const social = placeWebsite && isSocialOrDirectory(placeWebsite) ? extractSocialHandle(placeWebsite) : null;
    out.push({
      name,
      category,
      searchedCategory: category,
      address: place.formattedAddress || null,
      // Authoritative — straight from Google Maps (the number/site you see in the app).
      phone: place.nationalPhoneNumber || place.internationalPhoneNumber || null,
      website: social ? null : placeWebsite,
      rating: place.rating || null,
      reviewCount: place.userRatingCount || 0,
      lat: plat || null,
      lng: plng || null,
      photoUrl: null,
      instagramHint: social?.platform === 'instagram' ? { handle: social.handle, url: `https://www.instagram.com/${social.handle}/` } : null,
      tiktokHint: social?.platform === 'tiktok' ? social.handle : null,
      fromPlaces: true, // tells the pipeline the phone/website are already authoritative
      mapsUrl: place.id
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${place.id}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + fullArea)}`,
    });
    if (out.length >= limit * 3) break;
  }

  // Nearest-first — point zero is the pin, results radiate outward from it.
  out.forEach(b => { b._d = (typeof b.lat === 'number') ? haversineKm(centerLat, centerLng, b.lat, b.lng) : 9999; });
  out.sort((a, b) => a._d - b._d);
  out.forEach(b => delete b._d);

  log(`✅ ${out.length} businesses within the locality (Google Places — phone & website included)`);
  return out;
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
