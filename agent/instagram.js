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

  // 4. Targeted Serper search as a last resort.
  if (!result.handle && process.env.SERPER_API_KEY) {
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

async function searchInstagram(name, city, country, log) {
  const loc = [city, country].filter(Boolean).join(' ');
  const data = await serper('/search', {
    q: `${cleanSearchName(name)} ${loc} site:instagram.com`,
    gl: getCountryCode(country), hl: 'en', num: 10,
  }, process.env.SERPER_API_KEY, 10000);

  for (const r of (data.organic || [])) {
    const m = (r.link || '').match(/instagram\.com\/([A-Za-z0-9._]{2,30})\/?/i);
    if (!m || !verifyHandle(m[1], name)) continue;
    const snippet = `${r.title || ''} ${r.snippet || ''}`;
    log(`📸 Verified Instagram: @${m[1]}`);
    return {
      handle: m[1],
      url: `https://www.instagram.com/${m[1]}/`,
      followers: parseFollowers(snippet),
      posts: parsePosts(snippet),
      bio: snippet.slice(0, 300),
    };
  }
  return null;
}

module.exports = { findInstagram };
