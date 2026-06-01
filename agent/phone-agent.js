// Agentic phone-number hunter.
//
// Instead of a single snippet scan, this runs an AI agent loop: the model
// decides what to search or open next (just like a human researching a number),
// executes the tools, and loops until it finds a direct mobile/landline or
// exhausts its step budget. The whole thing is wrapped in a hard 45-second cap
// so it never blocks the pipeline.
//
// Tools available to the agent:
//   search_google(query)  — Serper /search, returns top results
//   open_page(url)        — HTTP GET, returns readable page text (scripts stripped)
//
// Good sources the agent knows to try:
//   • Knowledge graph (often has the number directly)
//   • Instagram bio (most Saudi small businesses put their WhatsApp there)
//   • Delivery apps: Talabat, Jahez, HungerStation, Mrsool
//   • The business website's contact / about page
//   • Local directories (cafesriyadh.com, etc.)

const { OpenAI } = require('openai');
const {
  serper, httpGet, withTimeout,
  bestPhone, pickPhone, isStrongPhone,
  getCountryCode, cleanSearchName,
} = require('./util');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 20000, maxRetries: 0 });

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_google',
      description: 'Search Google to find contact info. Use targeted queries: "BusinessName City phone", "BusinessName instagram", "BusinessName talabat", "BusinessName jahez", etc.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'Open a web page and read its text. Good for: Instagram profile bios (direct https://www.instagram.com/HANDLE/), Linktree pages, Talabat/Jahez/HungerStation/Mrsool listings, the business website contact page.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full https:// URL' } },
        required: ['url'],
      },
    },
  },
];

async function runTool(toolName, args, serperKey, country) {
  if (toolName === 'search_google') {
    const data = await withTimeout(
      serper('/search', { q: String(args.query || ''), gl: getCountryCode(country), hl: 'en', num: 5 }, serperKey, 8000),
      8000, null
    );
    if (!data) return 'Search timed out.';
    const kg = data.knowledgeGraph;
    let out = '';
    if (kg) {
      out += `=== KNOWLEDGE GRAPH: ${kg.title || ''} ===\n`;
      if (kg.phoneNumber) out += `Phone: ${kg.phoneNumber}\n`;
      if (kg.address) out += `Address: ${kg.address}\n`;
      out += '\n';
    }
    out += (data.organic || []).slice(0, 5).map((r, i) =>
      `[${i + 1}] ${r.title}\n    URL: ${r.link}\n    ${r.snippet || ''}`
    ).join('\n\n');
    return out || 'No results.';
  }

  if (toolName === 'open_page') {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) return 'Invalid URL — must start with https://';
    const html = await withTimeout(
      httpGet(url, { timeoutMs: 7000, maxRedirects: 3, maxBytes: 80000 }),
      7000, null
    );
    if (!html) return 'Page load failed or timed out.';
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 3500);
    return text || 'Page appears empty.';
  }

  return 'Unknown tool.';
}

async function findPhone({ name, city, country, website, instagramHandle }, log) {
  const serperKey = process.env.SERPER_API_KEY;
  const oaiKey = process.env.OPENAI_API_KEY;
  if (!serperKey || !oaiKey || oaiKey === 'sk-paste-your-key-here') return null;

  const sn = cleanSearchName(name);
  const loc = [city, country].filter(Boolean).join(', ');

  const prompt = `You are a research agent finding the direct phone number for a local business.

Business: "${name}"${sn !== name ? ` (search as "${sn}")` : ''}
Location: ${loc}
Website: ${website || 'unknown'}
Instagram: ${instagramHandle ? `@${instagramHandle} — open https://www.instagram.com/${instagramHandle}/` : 'unknown'}

Goal: find a DIRECT mobile or local landline. Avoid 800/920 call-center numbers unless that's all you can find.

Research order (stop as soon as you find a real direct number):
1. Google search: "${sn} ${city} phone" — check the knowledge graph phone and top results
2. Their Instagram bio (open the profile URL above if known)
3. Delivery apps: try searching "${sn} talabat" or "${sn} jahez" or "${sn} hungerstation"
4. Their website contact/about page (if website known)
5. Any relevant directory listing

After your research steps, output ONLY the phone number (e.g. "+966 55 322 2224") or "NOT_FOUND". No other text.`;

  const messages = [{ role: 'user', content: prompt }];
  const candidates = [];

  for (let step = 0; step < 6; step++) {
    let resp;
    try {
      resp = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages,
        tools: TOOLS,
        tool_choice: step < 5 ? 'auto' : 'none', // force final answer on last step
        max_tokens: 180,
        temperature: 0.1,
      });
    } catch (e) {
      log(`📞 Phone agent step ${step} error: ${e.message}`);
      break;
    }

    const msg = resp.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      const text = (msg.content || '').trim();
      if (text && text !== 'NOT_FOUND') {
        const ph = bestPhone(text);
        if (ph) {
          log(`📞 Phone agent answer: ${ph}`);
          candidates.push({ raw: ph, weight: 5 });
        }
      }
      break;
    }

    for (const tc of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        log(`📞 ${tc.function.name}(${JSON.stringify(args).slice(0, 80)})`);
        result = await withTimeout(
          runTool(tc.function.name, args, serperKey, country),
          9000, 'Tool timed out.'
        );
        // harvest phone candidates from tool output
        const phones = (result || '').match(/\+?\d[\d\s().\-]{6,18}\d/g) || [];
        for (const p of phones) {
          if (isStrongPhone(p)) candidates.push({ raw: p, weight: 1 });
        }
      } catch (e) { result = `Error: ${e.message}`; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: (result || '').slice(0, 4000) });
    }
  }

  return pickPhone(candidates) || null;
}

module.exports = { findPhone };
