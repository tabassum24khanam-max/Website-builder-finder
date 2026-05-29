// Business discovery + enrichment via Serper.dev.
//
// IMPORTANT (verified against the live API): the /places endpoint returns ONLY
// title, lat/lng, rating, ratingCount, category, cid — NO website, NO phone, NO
// address. So a single /search per business is the REAL source of website /
// phone / address / Instagram, not an optional backfill.

const {
  serper, withTimeout, normalizeForMatch, cleanUrl, isSocialOrDirectory,
  bestPhone, normalizePhone, parseFollowers, verifyHandle, getCountryCode, cleanSearchName,
} = require('./util');

// ── Chain / franchise / SEO-spam fast filter ─────────────────────────────────
const CHAIN_DENYLIST = [
  'starbucks', 'mcdonald', 'kfc', 'subway', 'burger king', 'pizza hut', 'domino',
  'costa coffee', 'tim horton', 'dunkin', 'baskin', 'shake shack', 'five guys',
  'nando', 'hardee', 'al baik', 'albaik', 'herfy', 'kudu', 'dr. cafe', 'dr cafe',
  'barns', 'the coffee bean', 'caribou coffee', 'pinkberry', 'papa john',
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

// ── AI query variant generation ────────────────────────────────────────────────
// Uses gpt-4o-mini to generate 3 neighborhood-aware search queries.
// The key insight: Serper `location` param ignores sub-city areas (neighborhoods,
// districts, zip codes). Putting the neighborhood in `q` is the ONLY way to get
// local results. A human searching "cafes in Ibn Khaldun, Riyadh" on Google Maps
// gets correct results; "cafes" + location="Ibn Khaldun, Riyadh" does not.

async function generateQueryVariants(category, searchContext, country, log) {
  const base = [
    `${category} in ${searchContext}`,
    `${category} near ${searchContext}`,
  ];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'sk-paste-your-key-here') return base;

  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey, timeout: 15000, maxRetries: 1 });

    const prompt = `Generate 3 short Google Maps search queries to find "${category}" businesses in "${searchContext}"${country ? `, ${country}` : ''}.

Rules:
- Always include the neighborhood/district name inside the query (vital for local results)
- Vary the category wording with natural synonyms
- If the location is in an Arabic-speaking country, add one query in Arabic
- Each query must be 3-7 words
- Return ONLY a valid JSON array of strings, nothing else

Example output for cafes in Ibn Khaldun, Riyadh, Saudi Arabia:
["cafes in Ibn Khaldun Riyadh", "coffee shops Ibn Khaldun district", "مقاهي حي ابن خلدون الرياض"]`;

    const resp = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    });

    const text = (resp.choices[0]?.message?.content || '').trim();
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const variants = JSON.parse(match[0]);
      if (Array.isArray(variants) && variants.length >= 1) {
        log(`🧠 AI search variants: ${variants.slice(0, 3).join(' | ')}`);
        // AI variants first (they include neighborhood), then base fallbacks
        return [...variants.slice(0, 3), ...base].filter((v, i, a) => a.indexOf(v) === i);
      }
    }
  } catch (e) {
    log(`⚠️  AI query generation failed (${e.message}) — using defaults`, 'warn');
  }

  return base;
}

// ── Step 1: discover businesses ────────────────────────────────────────────────
// neighborhood (from the "Street / Neighborhood" form field) is separate from
// location (city) because Serper's `location` param ignores sub-city areas.
// We put the neighborhood into `q` via AI-generated variants instead.

async function findBusinessesSerper({ category, location, neighborhood, country, lat, lng, limit = 20, log }) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY not set');

  const gl = getCountryCode(country);
  // Full context for AI and geocoding: "Ibn Khaldun, Riyadh" or just "Riyadh"
  const searchContext = neighborhood ? `${neighborhood}, ${location}` : location;
  const locationLabel = [location, country].filter(Boolean).join(', ');

  log(`🔍 Generating search queries for "${category}" near ${searchContext}...`);

  // AI generates neighborhood-aware query variants in parallel with geocoding
  const [queries, geoResult] = await Promise.all([
    withTimeout(
      generateQueryVariants(category, searchContext, country, log),
      14000, [`${category} in ${searchContext}`, `${category} near ${searchContext}`]
    ),
    // Geocode the full context (neighborhood+city) for a precise `ll` pin
    (lat || lng) ? Promise.resolve(null) : withTimeout(
      (async () => {
        const { geocode } = require('./osm');
        const geoQuery = `${searchContext}${country ? ', ' + country : ''}`;
        return await geocode(geoQuery);
      })(),
      5000, null
    ),
  ]);

  let pinLat = lat, pinLng = lng;
  if (!pinLat && !pinLng && geoResult) {
    pinLat = geoResult.lat;
    pinLng = geoResult.lng;
    log(`📍 Geocoded: ${geoResult.lat},${geoResult.lng} (${(geoResult.display || '').slice(0, 50)})`);
  }

  const seen = new Map(); // deduplicate by lowercased name
  const businesses = [];

  for (const q of queries) {
    if (businesses.length >= limit) break;

    const baseBody = { q, location: locationLabel, gl, hl: 'en' };
    if (pinLat && pinLng) baseBody.ll = `@${pinLat},${pinLng},14z`;

    for (let page = 1; page <= 4; page++) {
      if (businesses.length >= limit) break;

      const body = page === 1 ? baseBody : { ...baseBody, page };
      let raw;
      try {
        raw = await serper('/places', body, apiKey);
      } catch (e) {
        log(`⚠️  Serper error (q="${q}" page ${page}): ${e.message}`, 'warn');
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
        if (isChain(name)) { log(`⏭️  Chain/listing skipped: ${name}`); continue; }
        businesses.push({
          name,
          category: p.category || category,
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
        });
      }

      if (places.length < 10) break; // fewer than 10 means no more pages
    }
  }

  if (!businesses.length) {
    log('⚠️  Serper Places returned no results');
    return [];
  }

  log(`✅ ${businesses.length} candidate local businesses`);
  return businesses.slice(0, limit);
}

// ── Step 2: enrich one business with a single /search ────────────────────────
// Fills website, phone, address, and an Instagram hint from the same query.

async function enrichBusiness(business, location, country, log) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return business;

  log(`🔎 Enriching ${business.name}...`);

  const loc = [location, country].filter(Boolean).join(' ');
  let data;
  try {
    data = await serper('/search', { q: `${cleanSearchName(business.name)} ${loc}`, gl: getCountryCode(country), hl: 'en', num: 9 }, apiKey, 10000);
  } catch (e) {
    log(`⚠️  Enrichment search failed for ${business.name}: ${e.message}`, 'warn');
    return business;
  }

  // Knowledge graph (when present) is the most authoritative source.
  const kg = data.knowledgeGraph || {};
  if (!business.phone && kg.phoneNumber) business.phone = normalizePhone(kg.phoneNumber);
  if (!business.website && kg.website && !isSocialOrDirectory(kg.website)) business.website = cleanUrl(kg.website);
  if (!business.address && kg.address) business.address = kg.address;

  const nameCore = normalizeForMatch(business.name);
  const organic = data.organic || [];

  // Reserved Instagram paths that are never a handle.
  const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'about', 'help', 'legal', 'press']);

  for (const r of organic) {
    const link = r.link || '';
    const snippet = `${r.title || ''} ${r.snippet || ''}`;

    if (!business.phone) {
      const ph = bestPhone(snippet);
      if (ph) business.phone = normalizePhone(ph);
    }

    // Instagram handle — check URL first, then title/snippet.
    // Titles like "HAI Coffee (@hai.coffee.riyadh) • Instagram photos and videos"
    // are the PRIMARY way Google indexes IG reels/posts, not profile URLs.
    if (!business.instagramHint) {
      let igHandle = null, igUrl = null;

      // From URL path
      const um = link.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/i);
      if (um && !IG_RESERVED.has(um[1].toLowerCase())) {
        igHandle = um[1];
        igUrl = `https://www.instagram.com/${um[1]}/`;
      }

      // From title/snippet: "Name (@handle) •" or "Name (@handle) on Instagram"
      if (!igHandle) {
        const tm = snippet.match(/\(@([A-Za-z0-9._]{2,30})\)/);
        if (tm) {
          igHandle = tm[1];
          igUrl = `https://www.instagram.com/${tm[1]}/`;
        }
      }

      if (igHandle && verifyHandle(igHandle, business.name)) {
        business.instagramHint = {
          handle: igHandle,
          url: igUrl,
          followers: parseFollowers(snippet),
          bio: snippet.slice(0, 300),
        };
      }
    }

    // Website — only accept a domain whose name matches the business.
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

  if (business.website) log(`🌐 Website: ${business.website}`);
  if (business.phone) log(`📞 Phone: ${business.phone}`);
  if (business.instagramHint) log(`📸 Instagram: @${business.instagramHint.handle}${business.instagramHint.followers ? ` (${business.instagramHint.followers.toLocaleString()} followers)` : ''}`);

  return business;
}

module.exports = { findBusinessesSerper, enrichBusiness, isChain };
