// Website analyzer — fetches the site and uses OpenAI to classify it.
// Every network/AI call is timeout-bounded so a dead site can never hang a run.
const { OpenAI } = require('openai');
const { httpGet, normalizePhone } = require('./util');

// timeout/maxRetries are critical: the SDK default is a 10-MINUTE timeout with 2
// retries (~30 min worst case) — that was the source of the multi-minute hangs.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 1 });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// status: 'none' | 'good' | 'basic' | 'outdated' | 'menu_only' | 'linktree' | 'social_only'
async function analyzeWebsite(url, businessName, log) {
  if (!url || url.trim() === '') return { status: 'none', summary: 'No website listed.' };

  const lower = url.toLowerCase();
  if (/instagram\.com|facebook\.com|tiktok\.com/.test(lower)) return { status: 'social_only', summary: 'Link goes to a social media page, not a real website.' };
  if (/linktr\.ee|linktree|bio\.link|beacons\.ai|lnk\.bio/.test(lower)) return { status: 'linktree', summary: 'Link is just a Linktree / bio-link page.' };

  log(`🌐 Analyzing website: ${url}`);

  let html = '';
  try {
    html = (await httpGet(url, { timeoutMs: 8000 })).slice(0, 12000);
  } catch (err) {
    // Could not load — treat as effectively no usable website (strong lead).
    return { status: 'none', summary: `Site did not load (${err.message}).` };
  }
  if (!html || html.replace(/<[^>]+>/g, '').trim().length < 40) {
    return { status: 'basic', summary: 'Site loaded but has almost no content.' };
  }

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{
        role: 'user',
        content: `You are analyzing a local business website for a lead-generation tool.

Business name: "${businessName}"
Website URL: ${url}
Website HTML (truncated):
${html}

Classify into ONE category:
- "good": modern, professional site with clear services, contact info, working navigation
- "basic": simple functional site, minimal design/content, maybe just a landing page
- "outdated": clearly old design, broken elements, or not mobile-friendly
- "menu_only": literally just a menu/PDF/food images, no booking or contact
- "linktree": just links to social media, not a real website
- "social_only": URL is actually an Instagram/Facebook/TikTok page

Also write a 1-sentence summary.
Respond in JSON: { "status": "...", "summary": "..." }`,
      }],
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0.2,
    });
    const result = JSON.parse(response.choices[0].message.content);
    return { status: result.status || 'basic', summary: result.summary || '' };
  } catch {
    return { status: 'basic', summary: 'Website exists but could not be analyzed.' };
  }
}

// Look for a contact/manager phone on the business website. Capped to a few
// pages with small per-request timeouts so this step stays a couple of seconds.
async function findOwnerPhone(websiteUrl, log) {
  if (!websiteUrl) return null;
  const base = websiteUrl.replace(/\/$/, '');
  const pages = [websiteUrl, base + '/contact', base + '/contact-us'];

  for (const url of pages) {
    let html;
    try { html = await httpGet(url, { timeoutMs: 6000 }); } catch { continue; }
    // Only trust explicit tel: links. Scanning page text picks up IDs, prices,
    // coordinates and analytics numbers (e.g. "1298199463"), yielding wrong
    // phones — better to return nothing than a wrong number.
    for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
      const p = normalizePhone(decodeURIComponent(m[1]));
      if (p) { if (log) log(`📞 Phone on website: ${p}`); return p; }
    }
  }
  return null;
}

module.exports = { analyzeWebsite, findOwnerPhone };
