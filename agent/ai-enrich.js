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

const {
  serper, httpGet, withTimeout,
  bestPhone, pickPhone, isValidPhone, isStrongPhone,
  verifyHandle, getCountryCode, cleanSearchName, isSocialOrDirectory,
  normalizeForMatch, cleanUrl, extractEmail, trackCost,
} = require('./util');
// AI mode wants the provider's most capable tool-use model (getAI 'deep'):
// human-level judgment for deciding which number truly belongs to the business,
// rejecting switchboards/wrong-region numbers, confirming the right Instagram.
// On OpenAI it auto-falls-back to the cheap model if the key can't access the
// frontier one; on DeepSeek deep and fast are the same model.
const { getAI } = require('./ai-client');

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
      const r = await httpGet('https://r.jina.ai/' + url, { timeoutMs: 20000, maxBytes: 200000, headers: { 'X-Return-Format': 'text' } });
      if (r && r.length > text.length) text = r.replace(/\s+/g, ' ').trim();
    } catch {}
  }
  return text.slice(0, 4000);
}

async function runTool(toolName, args, serperKey, country, log) {
  if (toolName === 'search_google') {
    const data = await withTimeout(serper('/search', { q: String(args.query || ''), gl: getCountryCode(country), hl: 'en', num: 10 }, serperKey, 8000), 28000, null);
    if (!data) return 'Search timed out.';
    let out = '';
    const kg = data.knowledgeGraph;
    if (kg) { out += `KNOWLEDGE PANEL: ${kg.title || ''}\n`; if (kg.phoneNumber) out += `Phone: ${kg.phoneNumber}\n`; if (kg.website) out += `Website: ${kg.website}\n`; if (kg.address) out += `Address: ${kg.address}\n`; out += '\n'; }
    out += (data.organic || []).slice(0, 10).map((r, i) => `[${i + 1}] ${r.title}\n    ${r.link}\n    ${r.snippet || ''}`).join('\n\n');
    return out || 'No results.';
  }
  if (toolName === 'open_page') {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) return 'Invalid URL — must start with http(s)://';
    const text = await withTimeout(renderedGet(url), 26000, '');
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
    // Reverse containment (name ⊃ host) needs a LONG host core — a 5-char host
    // like "boots" matching inside "bootsbonesbbq" gave Boots&Bones BBQ the UK
    // pharmacy's site. Forward containment keeps the 6-char probe.
    return nc.length >= 4 && (hc.includes(nc.slice(0, 6)) || (hc.length >= 6 && nc.includes(hc.slice(0, 6))));
  } catch { return false; }
}

// Harvest contact candidates from whatever text the agent has read so far.
// `srcIdx` identifies WHICH tool result the value came from, so consensus can
// demand the same number on two DIFFERENT pages (one page repeating its own
// digits proves nothing).
function harvest(text, name, cc, store, srcIdx = 0) {
  for (const p of (text.match(/\+?\(?\d[\d\s().\-]{6,18}\d/g) || [])) {
    if (isValidPhone(p, cc)) store.phones.push({ raw: p, weight: 1, src: srcIdx });
  }
  for (const m of text.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})/gi)) {
    const h = m[1]; if (!IG_RESERVED.has(h.toLowerCase()) && verifyHandle(h, name) && !store.ig) store.ig = h;
  }
  for (const m of text.matchAll(/tiktok\.com\/@([A-Za-z0-9._]{2,30})/gi)) {
    const h = m[1]; if (!['video', 'tag', 'music', 'discover', 'foryou', 'live'].includes(h.toLowerCase()) && verifyHandle(h, name) && !store.tt) store.tt = h;
  }
  if (!store.site) {
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      if (looksLikeOwnSite(m[0], name)) { store.site = cleanUrl(m[0]); break; }
    }
  }
}

async function aiEnrich({ name, city, country, website, instagramHandle }, log) {
  // Any AI provider works (DeepSeek/OpenAI) — the search tool itself is keyless.
  const serperKey = process.env.SERPER_API_KEY;
  const ai = getAI('deep', { timeoutMs: 30000 });
  if (!ai) return { phone: null, instagram: instagramHandle || null, tiktok: null, website: website || null };

  const cc = getCountryCode(country);
  const sn = cleanSearchName(name);
  const loc = [city, country].filter(Boolean).join(', ');
  const store = { phones: [], ig: instagramHandle || null, tt: null, site: website || null };
  let seenDigits = '';

  const prompt = `You are an expert local-business researcher. Work to the standard of a meticulous human analyst and find the CONTACT INFO for ONE specific business.

Business: "${name}"${sn !== name ? ` (search as "${sn}")` : ''}
Location: ${loc}
${website ? `Known website: ${website}` : ''}${instagramHandle ? `\nKnown Instagram: @${instagramHandle}` : ''}

Find four things, most important first:
1) DIRECT PHONE — a mobile or local landline that belongs to THIS business at THIS location.
2) Official INSTAGRAM @handle.
3) Official TIKTOK @handle.
4) The business's OWN website (its own domain — not a directory, menu, QR-link, or social page).

METHOD — do this like a careful human, not one quick search:
- Search, then OPEN and READ the most authoritative page: the business's own site/contact page, then its Instagram profile, then a Talabat/Jahez/HungerStation listing, then a directory.
- CROSS-CHECK every number. Trust it more if it appears on the business's OWN site/Instagram, or on 2+ independent sources that clearly refer to THIS business.
- REJECT a number if it likely isn't theirs: a shared building/tower/mall switchboard, a DIFFERENT branch in another city, a different business that shares the name, or a generic call-centre (800 / 920 / 9200) when a direct line exists. Check the area code fits ${city}.
- Confirm the Instagram is genuinely THIS business (name + city match in the bio/posts), not a same-named account elsewhere.
- Only report a value you ACTUALLY SAW in a tool result. Never invent, complete, or recall a number from memory. If unsure, return null.

When finished, reply with ONLY this JSON (no prose):
{"phone": "<number or null>", "instagram": "<@handle or null>", "tiktok": "<@handle or null>", "website": "<url or null>"}`;

  const messages = [{ role: 'user', content: prompt }];
  let model = ai.model;

  for (let step = 0; step < 8; step++) {
    let resp;
    const callOpts = { messages, tools: TOOLS, tool_choice: step < 7 ? 'auto' : 'none', max_tokens: 350, temperature: 0.1 };
    try {
      resp = await ai.client.chat.completions.create({ model, ...callOpts });
    } catch (e) {
      // Frontier model not accessible on this key → fall back to the cheap one.
      if (model !== ai.fallbackModel && /model|not.?found|does not exist|no access|unsupported|permission|invalid/i.test(e.message || '')) {
        if (log) log(`🤖 ${model} unavailable — using ${ai.fallbackModel}`);
        model = ai.fallbackModel;
        try { resp = await ai.client.chat.completions.create({ model, ...callOpts }); }
        catch (e2) { if (log) log(`🤖 AI enrich error: ${e2.message}`); break; }
      } else { if (log) log(`🤖 AI enrich step ${step} error: ${e.message}`); break; }
    }
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
          if (j.tiktok && !store.tt) {
            const h = String(j.tiktok).replace(/^@/, '').replace(/.*tiktok\.com\/@?/, '').replace(/\/.*$/, '');
            if (h && verifyHandle(h, name)) store.tt = h;
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
        result = await withTimeout(runTool(tc.function.name, args, serperKey, country, log), 32000, 'Tool timed out.');
      } catch (e) { result = `Error: ${e.message}`; }
      seenDigits += (result || '').replace(/\D/g, '');
      store._src = (store._src || 0) + 1;
      harvest(result || '', name, cc, store, store._src);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: (result || '').slice(0, 4000) });
    }
  }

  // Phone: a final answer the agent corroborated (weight 5) wins. Without one,
  // require CONSENSUS among harvested numbers — the same digits seen on ≥2 of
  // the pages/results read. A singleton scraped off one page is too often a
  // different branch in another city or a neighbouring listing's line.
  let phoneCands = store.phones;
  if (!phoneCands.some(c => (c.weight || 1) >= 5)) {
    const srcs = new Map(); // last9 → set of DISTINCT tool results it appeared in
    for (const c of phoneCands) {
      const k = String(c.raw).replace(/\D/g, '').slice(-9);
      if (!srcs.has(k)) srcs.set(k, new Set());
      srcs.get(k).add(c.src || 0);
    }
    phoneCands = phoneCands.filter(c => (srcs.get(String(c.raw).replace(/\D/g, '').slice(-9)) || new Set()).size >= 2);
  }

  return {
    phone: pickPhone(phoneCands, cc) || null,
    instagram: store.ig || null,
    tiktok: store.tt || null,
    website: store.site || null,
  };
}

module.exports = { aiEnrich };
