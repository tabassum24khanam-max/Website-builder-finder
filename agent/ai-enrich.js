// AI enrichment agent — the human-like alternative to Serper enrichment.
//
// For one business it runs an LLM agent loop that researches contact info the
// way a person would: it searches Google, opens the most promising page
// (the business's site, its Google listing, Instagram, a delivery/directory
// page), READS it, and repeats until it has the phone, Instagram, and website.
//
// Two tools:
//   search_google(query) — Serper /search (titles, links, snippets, KG)
//   open_page(url)       — fetch + RENDER a page to readable text. Plain httpGet
//                          can't read JS-heavy pages (Maps, many sites); when the
//                          raw fetch is thin we fall back to r.jina.ai, a free
//                          renderer that runs a real browser, so the agent can
//                          "read the page" like a human.
//
// Everything it returns is validated (phone shape + corroboration, handle match)
// so the AI can't invent data — it may only report what it actually saw.

const { OpenAI } = require('openai');
const {
  serper, httpGet, withTimeout,
  bestPhone, pickPhone, isValidPhone, isStrongPhone,
  verifyHandle, getCountryCode, cleanSearchName, isSocialOrDirectory,
  normalizeForMatch, cleanUrl, extractEmail, trackCost,
} = require('./util');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 0 });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'about', 'help', 'popular', 'web']);

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_google',
      description: 'Search Google for the business. Use targeted queries like "NAME CITY phone", "NAME instagram", "NAME official website", "NAME talabat".',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'Open and READ a web page (rendered). Good for the business website/contact page, its Instagram profile URL, a delivery listing (Talabat/Jahez/HungerStation), or a directory page.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
];

function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Fetch a page as readable text. Raw fetch first; if it comes back thin (JS app,
// blocked), render it through r.jina.ai (free headless renderer).
async function renderedGet(url) {
  let text = '';
  try { text = stripHtml(await httpGet(url, { timeoutMs: 7000, maxBytes: 120000 })); } catch {}
  if (text.length < 250) {
    try {
      const r = await httpGet('https://r.jina.ai/' + url, { timeoutMs: 12000, maxBytes: 200000, headers: { 'X-Return-Format': 'text' } });
      if (r && r.length > text.length) text = r.replace(/\s+/g, ' ').trim();
    } catch {}
  }
  return text.slice(0, 4000);
}

async function runTool(toolName, args, serperKey, country, log) {
  if (toolName === 'search_google') {
    const data = await withTimeout(serper('/search', { q: String(args.query || ''), gl: getCountryCode(country), hl: 'en', num: 6 }, serperKey, 8000), 8000, null);
    if (!data) return 'Search timed out.';
    let out = '';
    const kg = data.knowledgeGraph;
    if (kg) { out += `KNOWLEDGE PANEL: ${kg.title || ''}\n`; if (kg.phoneNumber) out += `Phone: ${kg.phoneNumber}\n`; if (kg.website) out += `Website: ${kg.website}\n`; if (kg.address) out += `Address: ${kg.address}\n`; out += '\n'; }
    out += (data.organic || []).slice(0, 6).map((r, i) => `[${i + 1}] ${r.title}\n    ${r.link}\n    ${r.snippet || ''}`).join('\n\n');
    return out || 'No results.';
  }
  if (toolName === 'open_page') {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) return 'Invalid URL — must start with http(s)://';
    const text = await withTimeout(renderedGet(url), 14000, '');
    return text || 'Page could not be read.';
  }
  return 'Unknown tool.';
}

// A URL is the business's OWN website only if it isn't a social/directory/QR
// page AND its domain matches the business name. This rejects QR shortlinks
// (uqr.to) and directory pages (dlilsa.com) the AI might mistake for a website.
function looksLikeOwnSite(url, name) {
  if (!url || isSocialOrDirectory(url)) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const hc = host.replace(/\.[a-z.]+$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const nc = normalizeForMatch(name);
    return nc.length >= 4 && (hc.includes(nc.slice(0, 6)) || nc.includes(hc.slice(0, 6)));
  } catch { return false; }
}

// Harvest contact candidates from whatever text the agent has read so far.
function harvest(text, name, cc, store) {
  for (const p of (text.match(/\+?\(?\d[\d\s().\-]{6,18}\d/g) || [])) {
    if (isValidPhone(p, cc)) store.phones.push({ raw: p, weight: 1 });
  }
  for (const m of text.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})/gi)) {
    const h = m[1]; if (!IG_RESERVED.has(h.toLowerCase()) && verifyHandle(h, name) && !store.ig) store.ig = h;
  }
  if (!store.site) {
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      if (looksLikeOwnSite(m[0], name)) { store.site = cleanUrl(m[0]); break; }
    }
  }
}

async function aiEnrich({ name, city, country, website, instagramHandle }, log) {
  const serperKey = process.env.SERPER_API_KEY;
  const oaiKey = process.env.OPENAI_API_KEY;
  if (!serperKey || !oaiKey) return { phone: null, instagram: instagramHandle || null, website: website || null };

  const cc = getCountryCode(country);
  const sn = cleanSearchName(name);
  const loc = [city, country].filter(Boolean).join(', ');
  const store = { phones: [], ig: instagramHandle || null, site: website || null };
  let seenDigits = '';

  const prompt = `You research a local business like a careful human, to find its CONTACT INFO.

Business: "${name}"${sn !== name ? ` (search as "${sn}")` : ''}
Location: ${loc}
${website ? `Known website: ${website}` : ''}${instagramHandle ? `\nKnown Instagram: @${instagramHandle}` : ''}

Find: 1) a DIRECT phone, 2) the official Instagram @handle, 3) the business's own website.
How: search Google, then OPEN the most promising page (its website/contact page, its Instagram profile, a Talabat/Jahez/HungerStation listing, or a directory) and READ it. Repeat until you have what's findable.

Rules:
- Only report a value you ACTUALLY SAW in a tool result. Never invent or guess.
- Make sure the info belongs to THIS business in ${city}, not a different one.

When finished, reply with ONLY this JSON and nothing else:
{"phone": "<number or null>", "instagram": "<@handle or null>", "website": "<url or null>"}`;

  const messages = [{ role: 'user', content: prompt }];

  for (let step = 0; step < 7; step++) {
    let resp;
    try {
      resp = await openai.chat.completions.create({
        model: MODEL, messages, tools: TOOLS,
        tool_choice: step < 6 ? 'auto' : 'none', max_tokens: 300, temperature: 0.1,
      });
    } catch (e) { if (log) log(`🤖 AI enrich step ${step} error: ${e.message}`); break; }
    trackCost(resp);
    const msg = resp.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      const m = (msg.content || '').match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          // phone — accept only if valid shape AND actually seen in something read
          if (j.phone) {
            const ph = bestPhone(String(j.phone));
            const tail = ph ? ph.replace(/\D/g, '').slice(-7) : '';
            if (ph && isValidPhone(ph, cc) && tail && seenDigits.includes(tail)) store.phones.push({ raw: ph, weight: 5 });
          }
          if (j.instagram && !store.ig) {
            const h = String(j.instagram).replace(/^@/, '').replace(/.*instagram\.com\//, '').replace(/\/.*$/, '');
            if (h && !IG_RESERVED.has(h.toLowerCase()) && verifyHandle(h, name)) store.ig = h;
          }
          if (j.website && !store.site && looksLikeOwnSite(j.website, name)) store.site = cleanUrl(j.website);
        } catch {}
      }
      break;
    }

    for (const tc of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        if (log) log(`🤖 ${tc.function.name}(${JSON.stringify(args).slice(0, 70)})`);
        result = await withTimeout(runTool(tc.function.name, args, serperKey, country, log), 15000, 'Tool timed out.');
      } catch (e) { result = `Error: ${e.message}`; }
      seenDigits += (result || '').replace(/\D/g, '');
      harvest(result || '', name, cc, store);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: (result || '').slice(0, 4000) });
    }
  }

  return {
    phone: pickPhone(store.phones, cc) || null,
    instagram: store.ig || null,
    website: store.site || null,
  };
}

module.exports = { aiEnrich };
