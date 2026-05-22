// Website analyzer — fetches the site and uses OpenAI to classify it
const https = require('https');
const http = require('http');
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Returns: { status, summary }
// status: 'none' | 'good' | 'outdated' | 'menu_only' | 'linktree' | 'social_only' | 'basic'
async function analyzeWebsite(url, businessName, log) {
  if (!url || url.trim() === '') return { status: 'none', summary: 'No website listed.' };

  const lower = url.toLowerCase();
  if (/instagram\.com|facebook\.com/.test(lower)) return { status: 'social_only', summary: 'Website is a social media page, not a real website.' };
  if (/linktr\.ee|linktree|bio\.link|beacons\.ai/.test(lower)) return { status: 'linktree', summary: 'Website is just a Linktree / bio link page.' };

  log(`🌐 Analyzing website: ${url}`);

  let html = '';
  try {
    html = await fetchPage(url);
    html = html.slice(0, 12000); // Limit to first 12k chars
  } catch (err) {
    return { status: 'none', summary: `Could not load website: ${err.message}` };
  }

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{
        role: 'user',
        content: `You are analyzing a local business website for a lead generation tool.

Business name: "${businessName}"
Website URL: ${url}
Website HTML (truncated):
${html}

Classify this website into ONE of these categories:
- "good": Modern, professional site with clear services, contact info, working navigation
- "basic": Simple functional site but minimal design/content, maybe just a landing page
- "outdated": Clearly old design, broken elements, or not mobile-friendly
- "menu_only": Site is literally just a menu/PDF/food images with no booking or contact
- "linktree": Just links to social media, not a real website
- "social_only": URL goes to Instagram/Facebook/TikTok page

Also write a 1-sentence summary of what the site is.

Respond in JSON: { "status": "...", "summary": "..." }`
      }],
      response_format: { type: 'json_object' },
      max_tokens: 150,
      temperature: 0.2,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return { status: result.status || 'basic', summary: result.summary || '' };
  } catch (_) {
    return { status: 'basic', summary: 'Website exists but could not be analyzed.' };
  }
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html',
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next = res.headers.location;
        if (next.startsWith('/')) {
          try { const u = new URL(url); next = `${u.protocol}//${u.host}${next}`; } catch (_) {}
        }
        return fetchPage(next).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; if (data.length > 200000) res.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Looks for a contact/manager phone on the business website
async function findOwnerPhone(websiteUrl, log) {
  if (!websiteUrl) return null;
  const base = websiteUrl.replace(/\/$/, '');

  const CONTACT_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/team', '/staff', '/management'];

  for (const path of CONTACT_PATHS) {
    try {
      const html = await fetchPage(base + path);
      const phones = extractPhones(html);
      if (phones.length) {
        if (log) log(`📞 Owner phone found at ${path}: ${phones[0]}`);
        return phones[0];
      }
    } catch (_) {}
  }

  // Fall back to main page
  try {
    const html = await fetchPage(websiteUrl);
    const phones = extractPhones(html);
    if (phones.length) return phones[0];
  } catch (_) {}

  return null;
}

function extractPhones(html) {
  const phones = [];
  const seen = new Set();

  const telRe = /href="tel:([^"]+)"/gi;
  let m;
  while ((m = telRe.exec(html)) !== null) {
    const p = decodeURIComponent(m[1]).replace(/\s+/g, '').trim();
    if (p && !seen.has(p)) { seen.add(p); phones.push(p); }
  }

  if (!phones.length) {
    // Strip tags first to avoid matching across attributes
    const text = html.replace(/<[^>]+>/g, ' ');
    const re = /(?<![.\d])(\+?[\d]{1,3}[\s.\-]?(?:\([\d]{1,4}\)[\s.\-]?)?[\d]{3,4}[\s.\-]?[\d]{3,4}[\s.\-]?[\d]{0,4})(?![.\d])/g;
    while ((m = re.exec(text)) !== null) {
      const p = m[1].replace(/\s+/g, ' ').trim();
      const digits = p.replace(/\D/g, '');
      if (digits.length >= 7 && !seen.has(p)) {
        seen.add(p);
        phones.push(p);
        if (phones.length >= 3) break;
      }
    }
  }

  return phones;
}

module.exports = { analyzeWebsite, findOwnerPhone };
