// Business discovery + enrichment via Serper.dev.
//
// IMPORTANT (verified against the live API): the /places endpoint returns ONLY
// title, lat/lng, rating, ratingCount, category, cid — NO website, NO phone, NO
// address. So a single /search per business is the REAL source of website /
// phone / address / Instagram, not an optional backfill.

const {
  serper, normalizeForMatch, cleanUrl, isSocialOrDirectory,
  bestPhone, normalizePhone, parseFollowers, verifyHandle, getCountryCode, cleanSearchName,
} = require('./util');

// ── Chain / franchise / SEO-spam fast filter ─────────────────────────────────
// A cheap first pass. The AI scorer adds a general "is this independent?" check
// on top, so this list does not need to cover the whole world.
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
  // explicit branch markers
  if (/\bbranch\b|فرع|فروع|\bno\.?\s*\d+\b|\s#\s*\d+/i.test(name)) return true;
  // marketing/SEO listing junk: pipe-stuffed titles bragging "best/top/leading"
  const pipes = (name.match(/\|/g) || []).length;
  if (pipes >= 2 && /\b(best|top|leading|premium|finest|no\.?\s*1)\b/i.test(name)) return true;
  return false;
}

// ── Step 1: discover businesses (clean query + location + ll + correct gl) ────

async function findBusinessesSerper({ category, location, country, lat, lng, limit = 20, log }) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY not set');

  const locationLabel = [location, country].filter(Boolean).join(', ');
  log(`🔍 Serper Places: "${category}" near ${locationLabel}...`);

  // Clean query — do NOT stuff zip/neighborhood into it (that returns 0 results).
  const body = {
    q: `${category} in ${location}`,
    location: locationLabel || location,
    gl: getCountryCode(country),
    hl: 'en',
  };
  // If we have a precise pin/GPS, bias the search to it.
  if (lat && lng) body.ll = `@${lat},${lng},14z`;

  let raw;
  try {
    raw = await serper('/places', body, apiKey);
  } catch (e) {
    log(`⚠️  Serper Places error: ${e.message}`, 'warn');
    // Retry once with the simplest possible query (most robust).
    raw = await serper('/places', { q: `${category} in ${location}`, gl: getCountryCode(country), hl: 'en' }, apiKey);
  }

  let places = raw.places || [];
  if (!places.length) {
    log('⚠️  No results for that exact spot — retrying with a broader query...', 'warn');
    const retry = await serper('/places', { q: `${category} ${location}`, gl: getCountryCode(country), hl: 'en' }, apiKey).catch(() => ({}));
    places = retry.places || [];
  }
  if (!places.length) {
    log('⚠️  Serper Places returned no results');
    return [];
  }

  log(`📋 Found ${places.length} results — filtering chains...`);

  const businesses = [];
  for (const p of places) {
    const name = (p.title || '').trim();
    if (!name) continue;
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
      instagramHint: null, // filled by enrichBusiness
      mapsUrl: p.cid
        ? `https://www.google.com/maps?cid=${p.cid}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + locationLabel)}`,
    });
    if (businesses.length >= limit) break;
  }

  log(`✅ ${businesses.length} candidate local businesses`);
  return businesses;
}

// ── Step 2: enrich one business with a single /search ────────────────────────
// Fills website, phone, address, and an Instagram hint (handle/followers/bio)
// from the same query — Serper's organic results carry all of it.

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

  for (const r of organic) {
    const link = r.link || '';
    const snippet = `${r.title || ''} ${r.snippet || ''}`;

    // Phone — accept the first strong (real-looking) number from any snippet.
    if (!business.phone) {
      const ph = bestPhone(snippet);
      if (ph) business.phone = normalizePhone(ph);
    }

    // Instagram — first verified business handle (never an influencer/aggregator).
    if (!business.instagramHint) {
      const im = link.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/i);
      if (im && verifyHandle(im[1], business.name)) {
        business.instagramHint = {
          handle: im[1],
          url: `https://www.instagram.com/${im[1]}/`,
          followers: parseFollowers(snippet),
          bio: snippet.slice(0, 300),
        };
      }
    }

    // Website — only accept a domain whose NAME matches the business. Directory
    // pages (coffee guides, listing sites, even banks' "deals" pages) all mention
    // the business name in their snippet but are NOT its website, so matching on
    // the snippet is deliberately avoided — the domain must carry the name.
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
