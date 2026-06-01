// Email finder — multi-source: Instagram bio → website (+ /contact) → Hunter.io.
// Each network call is timeout-bounded via the shared httpGet.
const { httpGet, extractEmail, isSocialOrDirectory } = require('./util');

async function findEmail({ name, city, country, website, instagramBio }, log) {
  // 1. From the Instagram bio we already have (free, instant).
  if (instagramBio) {
    const e = extractEmail(instagramBio);
    if (e) { log(`📬 Email from IG bio: ${e}`); return e; }
  }

  // 2. From the business website + its /contact page.
  if (website && !isSocialOrDirectory(website)) {
    for (const url of pagesToTry(website)) {
      let html;
      try { html = await httpGet(url, { timeoutMs: 6000 }); } catch { continue; }
      const e = extractEmail(html);
      if (e) { log(`📬 Email found: ${e}`); return e; }
    }
  }

  // 3. Hunter.io (optional; free tier ~25/month).
  if (process.env.HUNTER_API_KEY && website) {
    try {
      const domain = new URL(website.startsWith('http') ? website : 'https://' + website).hostname;
      const json = JSON.parse(await httpGet(
        `https://api.hunter.io/v2/domain-search?domain=${domain}&limit=3&api_key=${process.env.HUNTER_API_KEY}`,
        { timeoutMs: 8000, headers: { 'Accept': 'application/json' } }));
      for (const e of (json.data?.emails || [])) {
        if (e.value && extractEmail(e.value)) { log(`📬 Email via Hunter: ${e.value}`); return e.value.toLowerCase(); }
      }
    } catch {}
  }

  return null;
}

function pagesToTry(website) {
  try {
    const base = new URL(website.startsWith('http') ? website : 'https://' + website);
    return [website, `${base.origin}/contact`, `${base.origin}/contact-us`];
  } catch {
    return [website];
  }
}

module.exports = { findEmail };
