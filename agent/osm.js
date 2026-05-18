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
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'LeadHunter/2.0 (lead-discovery)' } });
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

async function overpassQuery(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
    const geo = await geocode(q);
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
      return parseElements({ elements }, category, limit, log);
    }
    log(`⚠️  No no-website results found. Widening to ALL businesses in this category...`);
  }

  // 4. Fallback: get ALL businesses in the category (with or without website)
  const union = buildUnion(tagPairs, radius, lat, lng, false);
  const query = `[out:json][timeout:40];(${union});out tags center qt ${Math.max(limit * 3, 150)};`;
  log(`🔍 OSM query (all ${category} in ${radius_km}km)...`);
  const data = await overpassQuery(query);
  return parseElements(data, category, limit, log);
}

function parseElements(data, category, limit, log) {
  const elements = (data.elements || []).filter(el => el.tags?.name);
  log(`📊 Found ${elements.length} named businesses on OpenStreetMap`);

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

module.exports = { findBusinessesOSM, geocode };
