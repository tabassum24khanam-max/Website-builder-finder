// OpenStreetMap Overpass API — find businesses by category in an area
// No API key, no bot detection, includes a built-in "no website" filter.

const CATEGORY_TAGS = {
  'Restaurants':  [['amenity', 'restaurant'], ['amenity', 'fast_food']],
  'Cafes':        [['amenity', 'cafe'], ['amenity', 'coffee_shop']],
  'Barbershops':  [['shop', 'hairdresser'], ['amenity', 'barber']],
  'Salons':       [['shop', 'beauty']],
  'Clinics':      [['amenity', 'clinic'], ['amenity', 'doctors']],
  'Gyms':         [['leisure', 'fitness_centre'], ['leisure', 'sports_centre']],
  'Bakeries':     [['shop', 'bakery'], ['shop', 'pastry']],
  'Pharmacies':   [['amenity', 'pharmacy']],
  'Dental':       [['amenity', 'dentist']],
  'Hotels':       [['tourism', 'hotel'], ['tourism', 'motel'], ['tourism', 'guest_house']],
  'Car Repair':   [['shop', 'car_repair'], ['craft', 'car_repair']],
  'Law Offices':  [['office', 'lawyer']],
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function geocode(query) {
  // accept-language=en gives consistent English place names (vital for building
  // clean Serper queries from a geocoded area, e.g. a Saudi zip → "Al Rawdah").
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1&accept-language=en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'LeadHunter/2.0 (lead-discovery)', 'Accept-Language': 'en' } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    display: data[0].display_name,
    address: data[0].address || {},
  };
}

// Robust geocode: Nominatim is spelling/format sensitive (e.g. "Ibn Khaldun,
// Riyadh" fails but "13211, Saudi Arabia" resolves exactly). Try the most
// specific phrasings first and fall back to broader ones. `precision` tells the
// caller how tight a distance filter is safe — a city-level hit must not trim
// far-side neighborhoods, a zip/neighborhood hit can be filtered tightly.
async function geocodeBest({ neighborhood, city, zip, country }) {
  neighborhood = (neighborhood || '').trim();
  city = (city || '').trim();
  zip = (zip || '').trim();
  country = (country || '').trim();
  const C = country ? `, ${country}` : '';

  // [query, precision] — precision: 'precise' (zip/neighborhood) | 'city'
  const variants = [];
  if (neighborhood && city) variants.push([`${neighborhood}, ${city}${C}`, 'precise']);
  if (zip && city)          variants.push([`${zip}, ${city}${C}`, 'precise']);
  if (zip && country)       variants.push([`${zip}${C}`, 'precise']);
  if (zip)                  variants.push([`${zip}`, 'precise']);
  if (neighborhood && country) variants.push([`${neighborhood}${C}`, 'precise']);
  if (city && country)      variants.push([`${city}${C}`, 'city']);
  if (city)                 variants.push([`${city}`, 'city']);
  if (country)              variants.push([`${country}`, 'country']);

  const seen = new Set();
  for (const [v, precision] of variants) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const g = await geocode(v);
      if (g) return { ...g, precision, query: v };
    } catch {}
  }
  return null;
}

async function overpassQuery(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        // Overpass returns 406 without a UA
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LeadHunter/2.0 (lead-discovery)' },
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} from ${endpoint}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

function buildUnion(tagPairs, radius, lat, lng, noWebsiteOnly) {
  const websiteFilter = noWebsiteOnly ? '["website"!~"."]["contact:website"!~"."]' : '';
  return tagPairs
    .map(([k, v]) => `nwr["${k}"="${v}"]${websiteFilter}(around:${radius},${lat},${lng});`)
    .join('');
}

async function findBusinessesOSM({ category, location, country, lat, lng, radius_km = 5, limit = 30, noWebsiteOnly = true, log }) {
  // 1. Resolve coordinates if not provided
  if (!lat || !lng) {
    const q = `${location}${country ? ', ' + country : ''}`;
    log(`📍 Geocoding "${q}"...`);
    // Try the full string, then the city alone, then the country — most robust.
    let geo = await geocode(q);
    if (!geo && country) geo = await geocode(location);
    if (!geo && country) geo = await geocode(country);
    if (!geo) throw new Error(`Could not geocode "${q}". Try a more specific location.`);
    lat = geo.lat;
    lng = geo.lng;
    log(`📍 Search center: ${geo.display}`);
  } else {
    log(`📍 Search center: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
  }

  const radius = Math.round(radius_km * 1000);

  // 2. Resolve tag pairs for the category
  let tagPairs = CATEGORY_TAGS[category];
  const isKnownCategory = !!tagPairs;

  if (!tagPairs) {
    // Custom category — search by name match
    const safeName = category.replace(/[\\"]/g, '');
    const websiteFilter = noWebsiteOnly ? '["website"!~"."]' : '';
    const union = `nwr["name"~"${safeName}",i]${websiteFilter}(around:${radius},${lat},${lng});`;
    const query = `[out:json][timeout:40];(${union});out tags center qt ${Math.max(limit * 3, 150)};`;
    log(`🔍 OSM custom search (name~"${category}", radius ${radius_km}km)...`);
    const data = await overpassQuery(query);
    return parseElements(data, category, limit, log);
  }

  // 3. First try: filter for no-website businesses if requested
  if (noWebsiteOnly) {
    const union = buildUnion(tagPairs, radius, lat, lng, true);
    const query = `[out:json][timeout:40];(${union});out tags center qt ${Math.max(limit * 3, 150)};`;
    log(`🔍 OSM query (${tagPairs.length} tag${tagPairs.length>1?'s':''}, ${radius_km}km, no-website filter on)...`);
    const data = await overpassQuery(query);
    const elements = (data.elements || []).filter(el => el.tags?.name);
    log(`📊 OSM returned ${elements.length} named businesses without websites`);
    if (elements.length > 0) {
      return parseElements({ elements }, category, limit, log, lat, lng);
    }
    log(`⚠️  No no-website results found. Widening to ALL businesses in this category...`);
  }

  // 4. Fallback: get ALL businesses in the category (with or without website)
  const union = buildUnion(tagPairs, radius, lat, lng, false);
  const query = `[out:json][timeout:40];(${union});out tags center qt ${Math.max(limit * 3, 150)};`;
  log(`🔍 OSM query (all ${category} in ${radius_km}km)...`);
  const data = await overpassQuery(query);
  return parseElements(data, category, limit, log, lat, lng);
}

function parseElements(data, category, limit, log, centerLat, centerLng) {
  const elements = (data.elements || []).filter(el => el.tags?.name);
  log(`📊 Found ${elements.length} named businesses on OpenStreetMap`);

  // Overpass `qt` output is quadtile order, NOT nearest-first — slicing it raw
  // can drop the businesses closest to the user. Sort by distance to the centre
  // before taking `limit`, so "near me" actually means near.
  if (typeof centerLat === 'number' && typeof centerLng === 'number') {
    const d = el => {
      const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon;
      if (la == null || lo == null) return Infinity;
      const dy = (la - centerLat) * 111.32, dx = (lo - centerLng) * 111.32 * Math.cos(centerLat * Math.PI / 180);
      return dy * dy + dx * dx;
    };
    elements.sort((a, b) => d(a) - d(b));
  }

  return elements.slice(0, limit).map(el => {
    const t = el.tags;
    const elLat = el.lat || el.center?.lat || null;
    const elLng = el.lon || el.center?.lon || null;
    const addrParts = [
      t['addr:housenumber'],
      t['addr:street'],
      t['addr:suburb'] || t['addr:district'] || t['addr:neighbourhood'],
      t['addr:city'] || t['addr:town'] || t['addr:village'],
      t['addr:postcode'],
    ].filter(Boolean);

    return {
      name: t.name,
      category: prettyCategory(t) || category,
      address: addrParts.length ? addrParts.join(', ') : (t['addr:full'] || null),
      phone: t.phone || t['contact:phone'] || t['contact:mobile'] || null,
      website: t.website || t['contact:website'] || t.url || null,
      rating: null,
      reviewCount: 0,
      lat: elLat,
      lng: elLng,
      mapsUrl: elLat && elLng
        ? `https://www.google.com/maps/place/${encodeURIComponent(t.name)}/@${elLat},${elLng},17z`
        : null,
      searchQuery: `${category}`,
      osmId: `${el.type}/${el.id}`,
    };
  });
}

function prettyCategory(t) {
  if (t.cuisine) return t.cuisine + (t.amenity ? ' ' + t.amenity : '');
  return t.amenity || t.shop || t.tourism || t.office || t.leisure || t.craft || null;
}

module.exports = { findBusinessesOSM, geocode, geocodeBest };
