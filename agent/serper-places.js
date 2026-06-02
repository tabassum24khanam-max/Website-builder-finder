// Business discovery + enrichment via Serper.dev.
//
// IMPORTANT (verified against the live API): the /places endpoint returns ONLY
// title, lat/lng, rating, ratingCount, category, cid — NO website, NO phone, NO
// address. So a single /search per business is the REAL source of website /
// phone / address / Instagram, not an optional backfill.
//
// Locality is enforced two ways, because Serper interprets a bare zip/area
// loosely and will happily return cafes from another city 400km away:
//   1. an `ll` pin from a robust geocode biases results to the area, and
//   2. a HARD haversine distance filter drops anything outside the radius.

const {
  serper, withTimeout, haversineKm, normalizeForMatch, cleanUrl, isSocialOrDirectory,
  bestPhone, pickPhone, normalizePhone, parseFollowers, verifyHandle, getCountryCode, cleanSearchName,
} = require('./util');
const { geocodeBest } = require('./osm');

// ── Chain / franchise / SEO-spam fast filter ─────────────────────────────────
const CHAIN_DENYLIST = [
  'starbucks', 'mcdonald', 'kfc', 'subway', 'burger king', 'pizza hut', 'domino',
  'costa coffee', 'tim horton', 'dunkin', 'baskin', 'shake shack', 'five guys',
  'nando', 'hardee', 'al baik', 'albaik', 'herfy', 'kudu', 'dr. cafe', 'dr cafe',
  'barns', 'the coffee bean', 'caribou coffee', 'pinkberry', 'papa john', 'drcafe', 'half million',
  'little caesar', 'popeyes', 'taco bell', 'wendys', "wendy's", 'applebee',
  'ihop', 'denny', 'dairy queen', 'cold stone', 'krispy kreme', 'cinnabon',
  'gym nation', 'body masters', 'fitness time', 'anytime fitness', "gold's gym",
  'golds gym', 'planet fitness', 'fitness first', 'snap fitness', 'curves',
  'century 21', 're/max', 'remax', 'keller williams', 'coldwell banker',
  'mr biryani', 'mr. biryani', 'biryani house', 'paradise biryani',
];

function isChain(name) {
  const lower = (name || '').toLowerCase();
  if (CHAIN_DENYLIST.some(c => lower.includes(c))) return true;
  if (/\bbranch\b|فرع|فروع|\bno\.?\s*\d+\b|\s#\s*\d+/i.test(name)) return true;
  const pipes = (name.match(/\|/g) || []).length;
  if (pipes >= 2 && /\b(best|top|leading|premium|finest|no\.?\s*1)\b/i.test(name)) return true;
  return false;
}

// ── AI query variant generation ──────────────────────────────────────────────
// Puts the neighborhood directly into `q` (the Serper `location` param ignores
// sub-city areas) and varies the wording for coverage. Never a bare zip alone.

async function generateQueryVariants(category, areaText, country, log) {
  const base = [`${category} in ${areaText}`, `${category} near ${areaText}`];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'sk-paste-your-key-here') return base;

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey, timeout: 15000, maxRetries: 1 });
    const prompt = `Generate 3 short Google Maps search queries to find "${category}" businesses in "${areaText}"${country ? `, ${country}` : ''}.

Rules:
- ALWAYS include the area/neighborhood name "${areaText}" inside every query (vital for local results)
- Never use a bare postal/zip code on its own — always pair it with the area or city name
- Vary the category wording with natural synonyms
- If the area is in an Arabic-speaking country, make one query in Arabic
- Each query must be 3-7 words
- Return ONLY a JSON array of strings, nothing else

Example for cafes in Ibn Khaldun, Riyadh, Saudi Arabia:
["cafes in Ibn Khaldun Riyadh", "coffee shops Ibn Khaldun district Riyadh", "مقاهي حي ابن خلدون الرياض"]`;

    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    });
    const text = (resp.choices[0]?.message?.content || '').trim();
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const variants = JSON.parse(match[0]);
      if (Array.isArray(variants) && variants.length) {
        log(`🧠 AI search variants: ${variants.slice(0, 3).join(' | ')}`);
        return [...variants.slice(0, 3), ...base].filter((v, i, a) => v && a.indexOf(v) === i);
      }
    }
  } catch (e) {
    log(`⚠️  AI query generation failed (${e.message}) — using defaults`, 'warn');
  }
  return base;
}

// ── Geocode via Serper / Google ──────────────────────────────────────────────
// The public Nominatim API blocks/throttles cloud-server IPs (e.g. Railway), so
// backend geocoding silently returned nothing in production — the search center
// became null, the distance filter was disabled, and results came from all over
// the city. Serper hits Google, which works from server IPs, so this is the
// reliable fallback. We average the top places' coords for a stable area center.
async function serperGeocode(query, gl, apiKey, log) {
  if (!query) return null;
  try {
    const data = await serper('/places', { q: query, gl, hl: 'en' }, apiKey, 8000);
    const pts = (data.places || []).filter(p => p.latitude && p.longitude).slice(0, 5);
    if (!pts.length) return null;
    const lat = pts.reduce((s, p) => s + p.latitude, 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p.longitude, 0) / pts.length;
    return { lat, lng };
  } catch (e) {
    if (log) log(`⚠️  Serper geocode failed: ${e.message}`, 'warn');
    return null;
  }
}

// ── Step 1: discover businesses ──────────────────────────────────────────────

async function findBusinessesSerper({ category, city, neighborhood, zip, country, lat, lng, radiusKm = 10, limit = 20, log }) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY not set');
  const gl = getCountryCode(country);

  // ── Resolve a precise search center (the linchpin of locality) ──────────────
  let center = null, precision = 'city';
  let resolvedArea = (neighborhood || '').trim(); // best human area label for the query
  if (lat && lng) {
    center = { lat, lng }; precision = 'precise';
    log(`📍 Using map pin: ${(+lat).toFixed(4)}, ${(+lng).toFixed(4)}`);
  } else {
    const geo = await withTimeout(geocodeBest({ neighborhood, city, zip, country }), 8000, null);
    if (geo) {
      center = { lat: geo.lat, lng: geo.lng }; precision = geo.precision;
      const a = geo.address || {};
      if (!city) city = a.city || a.town || a.state || city;
      // Pull the actual district/neighbourhood name (e.g. a zip → "Al Rawdah")
      // so the search queries target it, not the whole city.
      if (!resolvedArea) resolvedArea = a.neighbourhood || a.suburb || a.city_district || a.quarter || a.residential || '';
      log(`📍 Search center: ${geo.lat.toFixed(4)},${geo.lng.toFixed(4)} — ${(geo.display || '').slice(0, 55)} [${precision}]`);
    } else {
      // Nominatim failed (commonly throttled on cloud IPs) — geocode via Google.
      const gq = [neighborhood, zip, city, country].filter(Boolean).join(', ');
      const sgeo = await withTimeout(serperGeocode(gq, gl, apiKey, log), 8000, null);
      if (sgeo) {
        center = sgeo;
        precision = (zip || neighborhood) ? 'precise' : 'city';
        log(`📍 Search center (Google): ${sgeo.lat.toFixed(4)},${sgeo.lng.toFixed(4)} [${precision}]`);
      } else {
        log('⚠️  Could not geocode the location — relying on text query only.', 'warn');
      }
    }
  }

  // Human-readable area for the query text. Prefer the most specific label we
  // have (typed/resolved district → zip+city → city). Never a bare zip alone.
  const areaText =
    [resolvedArea, city].filter(Boolean).join(', ') ||
    (zip && city ? `${zip}, ${city}` : '') ||
    [city, country].filter(Boolean).join(', ') ||
    [zip, country].filter(Boolean).join(' ') ||
    country || 'this area';
  const locationLabel = [city, country].filter(Boolean).join(', ') || country || areaText;

  // Distance budget: respect the user's radius for a precise center; widen for a
  // city-level center so we don't trim far-side neighborhoods; don't filter at
  // all for a country-level guess (it would be meaningless).
  let filterKm = (radiusKm || 10) * 1.3;
  if (precision === 'city') filterKm = Math.max(filterKm, 30);
  if (precision === 'country' || !center) filterKm = Infinity;

  log(`🔍 Discovering "${category}" near ${areaText}${center && filterKm !== Infinity ? ` (≤${Math.round(filterKm)}km)` : ''}...`);

  const queries = await withTimeout(generateQueryVariants(category, areaText, country, log), 16000, [`${category} in ${areaText}`]);

  // ── Fetch: each query × up to 4 pages, dedup, collect with distance ─────────
  const seen = new Map();
  const candidates = [];
  const hardCap = Math.min(limit * 3, 60); // over-fetch; enrichment will drop some

  for (const q of queries) {
    if (candidates.length >= hardCap) break;
    const baseBody = { q, location: locationLabel, gl, hl: 'en' };
    if (center) baseBody.ll = `@${center.lat},${center.lng},14z`;

    for (let page = 1; page <= 4; page++) {
      if (candidates.length >= hardCap) break;
      let raw;
      try {
        raw = await serper('/places', page === 1 ? baseBody : { ...baseBody, page }, apiKey);
      } catch (e) {
        log(`⚠️  Serper error (q="${q}" p${page}): ${e.message}`, 'warn');
        break;
      }
      const places = raw.places || [];
      if (!places.length) break;

      for (const p of places) {
        const name = (p.title || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.set(key, true);

        // HARD locality filter — this is what keeps other cities out.
        let dist = null;
        if (center && p.latitude && p.longitude) {
          dist = haversineKm(center.lat, center.lng, p.latitude, p.longitude);
          if (dist > filterKm) continue;
        }
        if (isChain(name)) { log(`⏭️  Chain/listing skipped: ${name}`); continue; }

        candidates.push({
          dist: dist == null ? 9999 : dist,
          biz: {
            name,
            category: p.category || category,
            searchedCategory: category,
            address: p.address || null,
            phone: normalizePhone(p.phoneNumber || p.phone),
            website: cleanUrl(p.website),
            rating: p.rating || null,
            reviewCount: p.ratingCount || 0,
            lat: p.latitude || null,
            lng: p.longitude || null,
            photoUrl: p.thumbnailUrl || null,
            instagramHint: null,
            mapsUrl: p.cid
              ? `https://www.google.com/maps?cid=${p.cid}`
              : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + locationLabel)}`,
          },
        });
      }
      if (places.length < 10) break; // last page
    }
  }

  if (!candidates.length) {
    log('⚠️  No local results after distance filtering.');
    return [];
  }

  // Closest first = most relevant to the searched locality.
  candidates.sort((a, b) => a.dist - b.dist);
  const businesses = candidates.slice(0, hardCap).map(c => c.biz);
  log(`✅ ${businesses.length} local candidates within range (closest first)`);
  return businesses;
}

// ── Step 2: enrich one business with a single /search ────────────────────────

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'about', 'help', 'legal', 'press', 'api', 'blog', 'developers', 'privacy', 'safety', 'support', 'directory', 'challenge', 'popular', 'web', 'emails', 'session']);

async function enrichBusiness(business, location, country, log) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return business;

  log(`🔎 Enriching ${business.name}...`);

  // Disambiguate generic names ("ON", "Drip") with the category + location so we
  // search the right business, not a random match.
  const catWord = (business.category || '').split(/[,/|]/)[0].trim();
  const loc = [location, country].filter(Boolean).join(' ');
  const query = [cleanSearchName(business.name), catWord, loc].filter(Boolean).join(' ');

  let data;
  try {
    data = await serper('/search', { q: query, gl: getCountryCode(country), hl: 'en', num: 9 }, apiKey, 10000);
  } catch (e) {
    log(`⚠️  Enrichment search failed for ${business.name}: ${e.message}`, 'warn');
    return business;
  }

  // Knowledge graph (when present) is the most authoritative source.
  const kg = data.knowledgeGraph || {};
  if (!business.website && kg.website && !isSocialOrDirectory(kg.website)) business.website = cleanUrl(kg.website);
  if (!business.address && kg.address) business.address = kg.address;

  const nameCore = normalizeForMatch(business.name);
  const organic = data.organic || [];

  // Gather phone candidates from all sources, then pick by consensus (a real
  // number recurs; the wrong toll-free appears once) — fixes the ON Cafe bug.
  const phoneCandidates = [];
  if (business.phone) phoneCandidates.push({ raw: business.phone, weight: 3 });
  if (kg.phoneNumber) phoneCandidates.push({ raw: kg.phoneNumber, weight: 4 });

  for (const r of organic) {
    const link = r.link || '';
    const snippet = `${r.title || ''} ${r.snippet || ''}`;

    const ph = bestPhone(snippet);
    if (ph) {
      // weight the business's own site / a real directory higher than noise
      let host = ''; try { host = new URL(link).hostname.replace(/^www\./, ''); } catch {}
      const ownSite = nameCore && host.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(nameCore.slice(0, Math.min(6, nameCore.length)));
      phoneCandidates.push({ raw: ph, weight: ownSite ? 3 : 1 });
    }

    // Instagram — check URL path first, then the title/snippet "(@handle)" form
    // (Google often indexes a reel, where the handle is only in the title).
    if (!business.instagramHint) {
      let h = null, u = null;
      const um = link.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/i);
      if (um && !IG_RESERVED.has(um[1].toLowerCase())) { h = um[1]; u = `https://www.instagram.com/${um[1]}/`; }
      if (!h) { const tm = snippet.match(/\(@([A-Za-z0-9._]{2,30})\)/); if (tm) { h = tm[1]; u = `https://www.instagram.com/${tm[1]}/`; } }
      if (h && verifyHandle(h, business.name) && !isChain(h)) {
        business.instagramHint = { handle: h, url: u, followers: parseFollowers(snippet), bio: snippet.slice(0, 300) };
        const bioPhone = bestPhone(snippet);
        if (bioPhone) phoneCandidates.push({ raw: bioPhone, weight: 2 }); // IG bio number is reliable
      }
    }

    // Website — only accept a domain whose NAME matches the business (directory
    // pages mention the name in their snippet but are not the business's site).
    if (!business.website && link && !isSocialOrDirectory(link)) {
      try {
        const host = new URL(link).hostname.replace(/^www\./, '');
        const hostCore = host.replace(/\.[a-z.]+$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (nameCore && nameCore.length >= 4 && hostCore.includes(nameCore.slice(0, Math.min(6, nameCore.length)))) {
          business.website = cleanUrl(link);
        }
      } catch {}
    }
  }

  const consensus = pickPhone(phoneCandidates, getCountryCode(country));
  if (consensus) business.phone = consensus;

  if (business.website) log(`🌐 Website: ${business.website}`);
  if (business.phone) log(`📞 Phone: ${business.phone}`);
  if (business.instagramHint) log(`📸 Instagram: @${business.instagramHint.handle}${business.instagramHint.followers ? ` (${business.instagramHint.followers.toLocaleString()} followers)` : ''}`);

  return business;
}

module.exports = { findBusinessesSerper, enrichBusiness, isChain };
