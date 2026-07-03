// TikTok finder — same philosophy as the Instagram finder: a natural Google
// search ("Name City tiktok") and STRICT name verification, so we never attach
// the wrong account. A wrong handle is worse than none.

const { serper, verifyHandle, getCountryCode, cleanSearchName } = require('./util');

const TT_RESERVED = new Set(['video', 'tag', 'music', 'discover', 'foryou', 'following', 'live', 'explore', 'search', 'about', 'legal', 'business', 'upload', 'login']);

async function findTikTok({ name, city, country, hint }, log) {
  if (hint) return { handle: hint.replace(/^@/, ''), url: `https://www.tiktok.com/@${hint.replace(/^@/, '')}` };
  // Works keyless — serper() degrades to the free DDG/Bing engine.
  const apiKey = process.env.SERPER_API_KEY;

  const loc = [city, country].filter(Boolean).join(' ');
  // Retry with a second phrasing when the first query surfaces nothing — the
  // same adaptive behavior a human researcher uses.
  const queries = [
    `${cleanSearchName(name) || name} ${loc} tiktok`,
    `${cleanSearchName(name) || name} ${city || ''} tiktok account`.replace(/\s+/g, ' ').trim(),
  ];
  for (const q of queries) {
    const hit = await findTikTokOnce(q, name, country, apiKey, log).catch(() => null);
    if (hit) return hit;
  }
  return { handle: null, url: null };
}

async function findTikTokOnce(q, name, country, apiKey, log) {
  const data = await serper('/search', {
    q, gl: getCountryCode(country), hl: 'en', num: 10,
  }, apiKey, 9000).catch(() => null);
  if (!data) return null;

  for (const r of (data.organic || [])) {
    const snippet = `${r.title || ''} ${r.snippet || ''}`;
    const um = (r.link || '').match(/tiktok\.com\/@([A-Za-z0-9._]{2,30})/i);
    let handle = (um && !TT_RESERVED.has(um[1].toLowerCase())) ? um[1] : null;
    if (!handle) { const tm = snippet.match(/\(@([A-Za-z0-9._]{2,30})\)/); if (tm) handle = tm[1]; }
    if (!handle || TT_RESERVED.has(handle.toLowerCase())) continue;
    // STRICT: the HANDLE itself must match the business name. (Snippet matching is
    // unsafe on TikTok — a reviewer's video about the cafe mentions its name but
    // the handle is the reviewer's, e.g. @quicktourguy for "Seven Beans".)
    if (!verifyHandle(handle, name)) continue;
    if (log) log(`🎵 TikTok: @${handle}`);
    return { handle, url: `https://www.tiktok.com/@${handle}` };
  }
  return null; // miss → caller tries the next query phrasing
}

module.exports = { findTikTok };
