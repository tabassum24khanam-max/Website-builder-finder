// Instagram finder — strict handle verification, data from Serper snippets only.
// Never calls instagram.com directly (that hangs on cloud IPs). Prefers a handle
// already discovered during enrichment; only spends an extra search if needed.

const {
  serper, httpGet, verifyHandle, parseFollowers, parsePosts,
  bestPhone, extractEmail, normalizePhone, getCountryCode, cleanSearchName,
} = require('./util');

async function findInstagram({ name, city, country, websiteUrl, hint }, log) {
  const result = {
    handle: null, url: null, followers: null, posts: null,
    postsPerMonth: null, lastPost: null, bio: null, phoneFromBio: null, emailFromBio: null,
  };

  // 1. Handle already found during enrichment (no extra Serper query needed).
  if (hint && hint.handle && verifyHandle(hint.handle, name)) {
    result.handle = hint.handle;
    result.url = hint.url || `https://www.instagram.com/${hint.handle}/`;
    result.followers = hint.followers || null;
    result.bio = hint.bio || null;
  }

  // 2. The Maps "website" is itself an Instagram page.
  if (!result.handle && websiteUrl) {
    const m = websiteUrl.match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/i);
    if (m && verifyHandle(m[1], name)) {
      result.handle = m[1];
      result.url = `https://www.instagram.com/${m[1]}/`;
    }
  }

  // 3. Scrape the business website (if any) for an Instagram link.
  if (!result.handle && websiteUrl && !/instagram\.com/i.test(websiteUrl)) {
    try {
      const html = await httpGet(websiteUrl, { timeoutMs: 6000 });
      for (const m of html.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})/gi)) {
        if (verifyHandle(m[1], name)) {
          result.handle = m[1];
          result.url = `https://www.instagram.com/${m[1]}/`;
          log(`📸 Instagram found on website: @${m[1]}`);
          break;
        }
      }
    } catch {}
  }

  // 4. Targeted search as a last resort (works keyless — serper() degrades to
  //    the free DDG/Bing engine when the key is missing or out of credits).
  if (!result.handle) {
    try {
      const found = await searchInstagram(name, city, country, log);
      if (found) Object.assign(result, found);
    } catch {}
  }

  if (!result.handle) {
    log(`📸 No verified Instagram for ${name}`);
    return result;
  }

  // Mine the bio/snippet for a phone + email (bios often list both).
  if (result.bio) {
    result.phoneFromBio = normalizePhone(bestPhone(result.bio));
    result.emailFromBio = extractEmail(result.bio);
    if (result.phoneFromBio) log(`📞 Phone from IG bio: ${result.phoneFromBio}`);
    if (result.emailFromBio) log(`📬 Email from IG bio: ${result.emailFromBio}`);
  }

  return result;
}

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'about', 'help', 'legal', 'press', 'api', 'blog', 'developers', 'privacy', 'safety', 'support', 'directory', 'challenge', 'popular', 'web', 'emails', 'session']);

// Generic words that don't identify a specific business (so they can't be used
// to confirm a handle for a non-Latin / short name).
const IG_STOPWORDS = new Set([
  'coffee', 'cafe', 'cafes', 'café', 'roastery', 'roasters', 'roaster', 'specialty',
  'speciality', 'espresso', 'tea', 'restaurant', 'shop', 'bar', 'house', 'the', 'and',
  'co', 'company', 'riyadh', 'jeddah', 'saudi', 'arabia', 'sa',
  // industry + geo generics — a match on these proves NOTHING about identity
  // (the "Lavi Nails" → @novanailsmadison bug: "nails" matched a different salon)
  'nails', 'nail', 'salon', 'salons', 'studio', 'hair', 'beauty', 'barber', 'barbershop',
  'lash', 'lashes', 'brows', 'dental', 'dentist', 'dentistry', 'clinic', 'medical', 'doctor',
  'pizza', 'pizzeria', 'grill', 'kitchen', 'bakery', 'deli', 'eatery', 'diner', 'lounge',
  'city', 'jersey', 'york', 'downtown', 'street', 'avenue', 'group', 'center', 'centre',
  'قهوة', 'مقهى', 'كافيه', 'كوفي', 'مختصة', 'مختص', 'محمصة', 'شاي', 'مطعم', 'الرياض', 'جدة', 'السعودية', 'حي', 'روست',
]);

// Distinctive (brand-identifying) tokens of a name: drops generic words; keeps
// Arabic tokens ≥3 chars and Latin tokens ≥4 chars.
function distinctiveTokens(name) {
  return (name || '').split(/[\s|/()،,.\-]+/).map(w => w.trim()).filter(w => {
    if (!w || IG_STOPWORDS.has(w.toLowerCase())) return false;
    return /[^\x00-\x7F]/.test(w) ? w.length >= 3 : w.length >= 4;
  });
}
function nameTokenInText(name, text) {
  if (!text) return false;
  return distinctiveTokens(name).some(w => text.includes(w));
}

async function searchInstagram(name, city, country, log) {
  const loc = [city, country].filter(Boolean).join(' ');
  // A NATURAL query ("Name City instagram") returns the actual profile; a
  // `site:instagram.com` query returns nothing via Serper/Google (verified).
  // Like a human researcher, retry with a different phrasing when the first
  // query surfaces nothing usable — the second angle often does.
  const queries = [
    `${cleanSearchName(name) || name} ${loc} instagram`,
    `${cleanSearchName(name) || name} ${city || ''} instagram profile`.replace(/\s+/g, ' ').trim(),
  ];
  for (const q of queries) {
    const found = await searchInstagramOnce(q, name, country, log).catch(() => null);
    if (found) return found;
  }
  return null;
}

async function searchInstagramOnce(q, name, country, log) {
  const data = await serper('/search', {
    q, gl: getCountryCode(country), hl: 'en', num: 10,
  }, process.env.SERPER_API_KEY, 10000);

  for (const r of (data.organic || [])) {
    const snippet = `${r.title || ''} ${r.snippet || ''}`;

    // Handle from the profile URL first, else the "Name (@handle) • Instagram" form.
    const um = (r.link || '').match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/i);
    let handle = (um && !IG_RESERVED.has(um[1].toLowerCase())) ? um[1] : null;
    if (!handle) {
      const tm = snippet.match(/\(@([A-Za-z0-9._]{2,30})\)/);
      if (tm) handle = tm[1];
    }
    if (!handle || IG_RESERVED.has(handle.toLowerCase())) continue;

    // Accept on a verified Latin name-core match (≥4-char core), OR — for
    // non-Latin/Arabic names that can't be core-matched — when a distinctive
    // (brand, non-generic) token of the name appears in the result text. This
    // recovers اريكة/شاي وريد while rejecting هدج→@jadeel.sa and ARA→@arabica.
    if (!verifyHandle(handle, name) && !nameTokenInText(name, snippet)) continue;
    log(`📸 Verified Instagram: @${handle}`);
    return {
      handle,
      url: `https://www.instagram.com/${handle}/`,
      followers: parseFollowers(snippet),
      posts: parsePosts(snippet),
      bio: snippet.slice(0, 300),
    };
  }
  return null;
}

module.exports = { findInstagram };
