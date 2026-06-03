// agent/util.js — shared helpers: hard timeouts, safe HTTP, Serper calls, and
// text extraction (phones, emails, Instagram handles, follower counts).
// Centralized here so every network call has a timeout and we never duplicate
// (or forget) the redirect cap that previously let requests hang forever.

const https = require('https');
const http = require('http');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Timeouts ─────────────────────────────────────────────────────────────────

// Race a promise against a timer. On timeout (or rejection) resolve to `fallback`
// so a single slow/dead step can never block the pipeline.
function withTimeout(promise, ms, fallback = null) {
  let timer;
  const guard = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([
    Promise.resolve(promise).then(v => { clearTimeout(timer); return v; })
                            .catch(() => { clearTimeout(timer); return fallback; }),
    guard,
  ]);
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Great-circle distance in km between two lat/lng points. Used to hard-filter
// discovery results to the searched locality (Serper returns nationwide matches
// for a bare zip — this is what keeps Dammam out of a Riyadh search).
function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => typeof v !== 'number' || isNaN(v))) return Infinity;
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── HTTP GET (redirect-capped, byte-capped, timed) ───────────────────────────

function httpGet(url, { timeoutMs = 8000, maxRedirects = 4, maxBytes = 250000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (u) => {
      let lib;
      try { lib = u.startsWith('https') ? https : http; } catch { return reject(new Error('bad url')); }
      let req;
      try {
        req = lib.get(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', ...headers } }, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (redirects++ >= maxRedirects) return reject(new Error('too many redirects'));
            let next = res.headers.location;
            if (next.startsWith('/')) { try { const p = new URL(u); next = `${p.protocol}//${p.host}${next}`; } catch {} }
            return go(next);
          }
          let data = '';
          res.setEncoding('utf8');
          res.on('data', c => { data += c; if (data.length > maxBytes) res.destroy(); });
          res.on('end', () => resolve(data));
          res.on('close', () => resolve(data));
        });
      } catch (e) { return reject(e); }
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    };
    go(url);
  });
}

// ── Serper POST (single, timeout-guarded entry point) ────────────────────────

function serper(path, body, apiKey, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'google.serper.dev', path, method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.message && !j.places && !j.organic && !j.knowledgeGraph) return reject(new Error(j.message));
          resolve(j);
        } catch (e) { reject(new Error('serper parse error: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('serper timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Name normalization (for matching handles / domains to a business) ────────

const STOPWORDS = /\b(cafe|caffe|coffee|coffeehouse|roastery|roasters|restaurant|resto|bistro|kitchen|grill|bakery|patisserie|sweets|shop|store|salon|barber|barbershop|gym|fitness|club|spa|clinic|dental|dentist|pharmacy|hotel|boutique|the|and|of|for|sa|ksa|uae|llc|co|company|est|trading|group|official)\b/gi;

// Strips punctuation, Arabic (\w is ASCII-only in JS), and generic words, leaving
// the distinctive latin core of a name, e.g. "WOODS Cafe & Roastery" → "woods".
function normalizeForMatch(name) {
  return (name || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(STOPWORDS, ' ')
    .replace(/\s+/g, '')
    .trim();
}

// ── URL helpers ──────────────────────────────────────────────────────────────

function cleanUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { new URL(s); return s.split('#')[0]; } catch { return null; }
}

const SOCIAL_OR_DIRECTORY = /instagram\.com|facebook\.com|fb\.com|tiktok\.com|linkedin\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|snapchat\.com|pinterest\.|threads\.net|whatsapp\.com|wa\.me|t\.me|telegram\.|tripadvisor\.|yelp\.|foursquare\.|zomato\.|trustpilot\.|maps\.google|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app|wikipedia\.org|wikiwand\.|wikidata\.|opentable\.|grubhub\.|doordash\.|ubereats\.|deliveroo\.|talabat\.|hungerstation\.|jahez\.|chefz\.|toyou\.|mrsool\.|swiggy\.|district\.in|noon\.com|amazon\.|booking\.com|agoda\.|expedia\.|hotels\.com|justdial\.|sulekha\.|menupages\.|wafyapp\.|mexil\.|linktr\.ee|bit\.ly|tinyurl\.|restaurants?-world\.|menu-world\.|menu-res\.|restaurant-?guru\.|wheree\.|near-place\.|top10place\.|places-world\.|\.menu-[a-z]+\.|restaurants?-guide\.|goto-where\.|taker\.io|finedinemenu\.|yallaqrcodes\.|mahally\.|mat3am\.|ksarestaurant\.|eyeofriyadh\.|cafesriyadh\.|saudicoffeecrafters\.|wanderboat\.|wanderlog\.|welcomesaudi\.|safarway\.|timeoutriyadh\.|whatsonsaudiarabia\.|qavashop\.|daymarkcoffeeguide\.|houseofsaud\.|the-fork\.|thefork\.|restaurantji\./i;

function isSocialOrDirectory(url) {
  return SOCIAL_OR_DIRECTORY.test(url || '');
}

// ── Phone extraction ─────────────────────────────────────────────────────────

// Pull plausible phone numbers out of free text (search snippets, HTML).
// Validates by digit count (8–15) so review counts, prices, IDs, and years are
// not mistaken for phones. Returns numbers in the order they appear.
function extractPhones(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const re = /\+?\(?\d[\d\s().\-]{6,18}\d/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push(raw.replace(/\s+/g, ' ').trim());
  }
  return out;
}

// A "strong" phone looks like a real number: 10+ digits, or +/00 international.
// This filters out short ID/price/date artifacts that appear in search snippets
// (e.g. "12243-7058") — we prefer returning nothing over a wrong number. Also
// rejects two real-world false positives seen in the wild: decimal ratings
// ("4.5731707") and sequential filler ("1 2 3 4 5 6 7 8 9 10").
function isStrongPhone(raw) {
  const r = String(raw || '');
  if (/^\s*\d{1,3}\.\d{3,}\s*$/.test(r)) return false;                          // decimal / rating, not a phone
  const d = r.replace(/\D/g, '');
  if (/^(\d)\1+$/.test(d)) return false;                                        // all-identical digits
  if (/123456789|234567890|987654321|876543210/.test(d)) return false; // sequential filler (a full 9-run never occurs in a real number)
  const intl = /^\s*\+/.test(r) || d.startsWith('00');
  if (intl) return d.length >= 10 && d.length <= 15;
  return d.length >= 10 && d.length <= 13;
}

function bestPhone(text) { return extractPhones(text).find(isStrongPhone) || null; }

// Pick the most trustworthy phone from weighted candidates {raw, weight}.
// A real business line recurs across sources (its own site, IG bio, several
// directories); a wrong toll-free or a number mistakenly scraped from a busy
// snippet usually appears once. Score = summed source weight, with a penalty
// for toll-free/hotline numbers and a small bonus for mobiles, so a direct
// mobile beats a generic 800/920 call-centre line (the exact ON Cafe bug).
// When `cc` (a Google `gl` country code) is given, candidates that don't fit
// that country's number shape are dropped — this rejects commercial-registration
// / VAT / Maroof IDs that happen to be 10 digits (the Steam Roastery bug).
function pickPhone(candidates, cc) {
  const groups = new Map(); // last-9-digits → { raw, score, digits }
  for (const c of candidates) {
    const raw = c && c.raw;
    if (!isStrongPhone(raw)) continue;
    if (cc && !isValidPhone(raw, cc)) continue; // country-shape gate
    const norm = normalizePhone(raw);
    if (!norm) continue;
    const digits = norm.replace(/\D/g, '');
    const key = digits.slice(-9); // identifies the line across +country/0/spacing
    const g = groups.get(key) || { raw: norm, score: 0, digits };
    g.score += (c.weight || 1);
    if (digits.length > g.digits.length) { g.raw = norm; g.digits = digits; } // keep fullest form
    groups.set(key, g);
  }
  let best = null;
  for (const g of groups.values()) {
    let s = g.score;
    if (isTollFreeNumber(g.raw, cc)) s -= 2;          // toll-free/hotline penalty
    if (/5\d{8}$/.test(g.digits)) s += 1;             // GCC/Saudi mobile shape (harmless elsewhere)
    if (!best || s > best.s) best = { s, raw: g.raw };
  }
  return best ? best.raw : null;
}

// ── Country-aware phone shape validation ─────────────────────────────────────
// gl country code → international dialing prefix, so we can strip it and inspect
// the national significant number.
const DIAL = {
  sa: '966', ae: '971', eg: '20', kw: '965', bh: '973', qa: '974', om: '968', jo: '962', lb: '961',
  gb: '44', us: '1', ca: '1', au: '61', nz: '64',
  fr: '33', de: '49', es: '34', it: '39', pt: '351', nl: '31', be: '32', ch: '41', at: '43', ie: '353',
  se: '46', no: '47', dk: '45', fi: '358', pl: '48', gr: '30', tr: '90',
  in: '91', pk: '92', bd: '880', lk: '94', np: '977',
  sg: '65', my: '60', id: '62', th: '66', ph: '63', za: '27', ng: '234', ke: '254', ma: '212',
  jp: '81', kr: '82', cn: '86', hk: '852', tw: '886', vn: '84',
  br: '55', mx: '52', ar: '54', cl: '56', co: '57', pe: '51', ru: '7', ua: '380', ro: '40',
};

// Reduce any written form (+CC, 00CC, national 0-trunk, spaces/dashes) to the
// bare national significant number for the given country.
function toNational(raw, cc) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  const dial = DIAL[cc];
  if (dial && d.startsWith(dial) && d.length - dial.length >= 6) d = d.slice(dial.length);
  return d.replace(/^0+/, '');
}

// Does this look like a REAL phone for the given country? Permissive for
// unknown countries; strict enough for our test markets to reject IDs/CR/VAT
// numbers that slip past the generic digit-count check.
function isValidPhone(raw, cc) {
  if (!isStrongPhone(raw)) return false;
  const nat = toNational(raw, cc);
  if (!nat || /^(\d)\1+$/.test(nat)) return false; // empty or all-identical digits
  switch (cc) {
    case 'sa': return (nat.length === 9 && /^[1-9]/.test(nat)) || /^800\d{6,7}$/.test(nat);
    case 'ae': return nat.length >= 8 && nat.length <= 9 && /^[1-9]/.test(nat);
    case 'us': case 'ca': return /^[2-9]\d{2}[2-9]\d{6}$/.test(nat); // NANP: area 2-9, exchange 2-9
    case 'gb': return /^[1-9]\d{8,9}$/.test(nat);
    case 'fr': return /^[1-9]\d{8}$/.test(nat);
    case 'de': return /^1[5-7]\d{8,9}$/.test(nat) || /^[2-9]\d{5,9}$/.test(nat); // mobile 15/16/17, else area code
    case 'in': return /^[1-9]\d{7,10}$/.test(nat);
    case 'jp': return /^([789]0\d{8}|[1-9]\d{8,9})$/.test(nat);       // mobile 70/80/90 or landline
    case 'au': return /^[2-478]\d{8}$/.test(nat);                    // 9-digit national (mobile 4x)
    case 'nl': return /^[1-9]\d{8}$/.test(nat);                      // 9-digit national
    case 'es': return /^[6-9]\d{8}$/.test(nat);                      // 9-digit; mobile 6/7
    case 'it': return /^3\d{8,9}$/.test(nat) || /^0\d{8,10}$/.test(nat);
    case 'pt': return /^[239]\d{8}$/.test(nat);
    case 'tr': return /^[2-5]\d{9}$/.test(nat);                      // 10-digit national
    case 'br': return /^[1-9]\d{9,10}$/.test(nat);                   // 10-11 digits
    case 'mx': return /^[1-9]\d{9}$/.test(nat);                      // 10 digits
    case 'za': return /^[1-8]\d{8}$/.test(nat);                      // 9 digits
    case 'ng': return /^[7-9]\d{9}$/.test(nat);
    case 'ke': return /^[17]\d{8}$/.test(nat);
    case 'ma': return /^[5-7]\d{8}$/.test(nat);
    case 'sg': return /^[3689]\d{7}$/.test(nat);                     // 8 digits
    case 'my': return /^[1-9]\d{7,9}$/.test(nat);
    case 'id': return /^[2-9]\d{7,11}$/.test(nat);
    case 'th': return /^[2-9]\d{7,8}$/.test(nat);
    case 'ph': return /^[2-9]\d{8,9}$/.test(nat);
    default: return nat.length >= 8 && nat.length <= 13;
  }
}

// Toll-free / unified call-centre lines (worth a number, but a direct line is
// better — used both to penalise in pickPhone and to trigger the phone agent).
function isTollFreeNumber(raw, cc) {
  const nat = toNational(raw, cc);
  if (!nat) return false;
  if (cc === 'sa') return /^(800|9200|92[05])/.test(nat);
  if (cc === 'us' || cc === 'ca') return /^8(00|33|44|55|66|77|88)/.test(nat);
  if (cc === 'gb') return /^(80|500|808)/.test(nat);
  return /^(1?800|0?800)/.test(nat);
}

// For search queries, prefer the latin core of a (possibly bilingual) name:
// "مقهى ومحمصة وودز (العليا) WOODS Cafe and Roastery (Olaya)" → "WOODS Cafe and Roastery".
// Falls back to the original for non-latin-only names (Arabic/CJK/etc.).
function cleanSearchName(name) {
  if (!name) return '';
  const latin = name
    .replace(/\([^)]*\)/g, ' ')     // drop parentheticals like (Olaya)
    .replace(/[^\x00-\x7F]/g, ' ')  // drop non-ASCII (Arabic, CJK, …)
    .replace(/[|/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return latin.length >= 3 ? latin : name.trim();
}

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/[^\d+\s().\-]/g, '').replace(/\s+/g, ' ').trim();
  // Drop stray/unbalanced parentheses (e.g. a captured "347) 656-8146").
  if ((s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length) s = s.replace(/[()]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/\D/g, '').length >= 8 ? s : null;
}

// ── Email extraction ─────────────────────────────────────────────────────────

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,10}\b/g;
const BAD_EMAIL = /(example\.|yourdomain|@test\.|@domain\.|sentry\.io|wixpress|squarespace\.com|wordpress\.com|shopify\.com|schema\.org|w3\.org|\.png|\.jpg|\.jpeg|\.svg|\.gif|@2x|@3x)/i;

function extractEmail(text) {
  if (!text) return null;
  for (const e of (text.match(EMAIL_RE) || [])) {
    if (!BAD_EMAIL.test(e)) return e.toLowerCase();
  }
  return null;
}

// ── Count parsing ("19.4K" → 19400) ──────────────────────────────────────────

function parseCount(str) {
  if (str == null) return null;
  let s = String(str).replace(/[,\s]/g, '').toLowerCase();
  if (!s) return null;
  if (s.endsWith('k')) return Math.round(parseFloat(s) * 1e3);
  if (s.endsWith('m')) return Math.round(parseFloat(s) * 1e6);
  const n = parseInt(s.replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseFollowers(snippet) {
  const m = (snippet || '').match(/([\d.,]+\s*[KkMm]?)\s*followers/i);
  return m ? parseCount(m[1]) : null;
}

function parsePosts(snippet) {
  const m = (snippet || '').match(/([\d.,]+\s*[KkMm]?)\s*posts/i);
  return m ? parseCount(m[1]) : null;
}

// ── Instagram handle verification ────────────────────────────────────────────

// Reserved Instagram paths that are never a business handle.
const RESERVED_HANDLES = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'about', 'help',
  'legal', 'press', 'api', 'blog', 'developer', 'developers', 'privacy', 'safety',
  'support', 'directory', 'challenge', 'popular', 'web', 'emails', 'session',
]);

// Food bloggers / city influencers / aggregators — never a real business handle.
const INFLUENCER = /foodie|foodies|_food|food_|foods\b|eats\b|munchies|review|blogger|influencer|guide|magazine|magaz|critic|yummy|tasty|delicious|hungry|cravings|topfood|bestof|best_|_diaries|diaries|explore|discover|lifestyle|vlog/i;

function isInfluencerHandle(handle) { return INFLUENCER.test(handle || ''); }

// Strict: the handle must share a meaningful chunk with the business name.
// Better an empty Instagram than a wrong one (a wrong handle is worse than none).
function verifyHandle(handle, businessName) {
  if (!handle) return false;
  const low = handle.toLowerCase();
  if (RESERVED_HANDLES.has(low)) return false;
  if (isInfluencerHandle(low)) return false;

  const n = normalizeForMatch(businessName);
  const h = low.replace(/[._]/g, '');
  // No verifiable Latin core (too short, or a non-Latin/Arabic-only name) — we
  // cannot confirm the handle by name, so reject. A wrong handle (the @drcafeksa
  // / @jadeel.sa case) is worse than none; callers can match non-Latin names by a
  // distinctive name token appearing in the result snippet instead.
  if (!n || n.length < 4) return false;

  const k = Math.min(6, n.length);
  if (h.includes(n.slice(0, k))) return true;                          // handle contains name core
  if (n.includes(h.slice(0, Math.min(6, h.length)))) return true;      // name contains handle core
  return false;
}

// Optional OpenAI token accounting (a no-op unless COST_TRACK is set). Lets a
// test harness total token usage from the SDK's own `usage` field without
// intercepting the transport (the SDK doesn't use globalThis.fetch).
function trackCost(resp) {
  if (!process.env.COST_TRACK || !resp || !resp.usage) return;
  const g = (global.__cost = global.__cost || { i: 0, o: 0, n: 0 });
  g.i += resp.usage.prompt_tokens || 0;
  g.o += resp.usage.completion_tokens || 0;
  g.n += 1;
}

// ── Country → Google `gl` code (worldwide, not Saudi-only) ────────────────────

const COUNTRY_GL = {
  'saudi arabia': 'sa', 'ksa': 'sa', 'uae': 'ae', 'united arab emirates': 'ae', 'emirates': 'ae',
  'egypt': 'eg', 'kuwait': 'kw', 'bahrain': 'bh', 'qatar': 'qa', 'oman': 'om', 'jordan': 'jo',
  'lebanon': 'lb', 'iraq': 'iq', 'syria': 'sy', 'yemen': 'ye', 'palestine': 'ps',
  'united kingdom': 'gb', 'uk': 'gb', 'great britain': 'gb', 'england': 'gb', 'scotland': 'gb',
  'united states': 'us', 'usa': 'us', 'us': 'us', 'america': 'us', 'canada': 'ca', 'mexico': 'mx',
  'brazil': 'br', 'argentina': 'ar', 'chile': 'cl', 'colombia': 'co', 'peru': 'pe',
  'france': 'fr', 'germany': 'de', 'spain': 'es', 'italy': 'it', 'portugal': 'pt',
  'netherlands': 'nl', 'belgium': 'be', 'switzerland': 'ch', 'austria': 'at', 'ireland': 'ie',
  'sweden': 'se', 'norway': 'no', 'denmark': 'dk', 'finland': 'fi', 'poland': 'pl',
  'greece': 'gr', 'turkey': 'tr', 'turkiye': 'tr', 'russia': 'ru', 'ukraine': 'ua', 'romania': 'ro',
  'india': 'in', 'pakistan': 'pk', 'bangladesh': 'bd', 'sri lanka': 'lk', 'nepal': 'np',
  'china': 'cn', 'japan': 'jp', 'south korea': 'kr', 'korea': 'kr', 'taiwan': 'tw', 'hong kong': 'hk',
  'singapore': 'sg', 'malaysia': 'my', 'indonesia': 'id', 'thailand': 'th', 'vietnam': 'vn',
  'philippines': 'ph', 'australia': 'au', 'new zealand': 'nz',
  'south africa': 'za', 'nigeria': 'ng', 'kenya': 'ke', 'ghana': 'gh', 'morocco': 'ma',
  'tunisia': 'tn', 'algeria': 'dz', 'ethiopia': 'et',
};

// gl is only a hint — the `location` string does the heavy geo-targeting — so a
// sensible default ('us') is safe when the country isn't recognized.
function getCountryCode(country) {
  return COUNTRY_GL[(country || '').trim().toLowerCase()] || 'us';
}

module.exports = {
  UA, withTimeout, delay, haversineKm, httpGet, serper,
  normalizeForMatch, cleanUrl, isSocialOrDirectory,
  extractPhones, isStrongPhone, bestPhone, pickPhone, normalizePhone, extractEmail, cleanSearchName,
  isValidPhone, isTollFreeNumber, toNational,
  parseCount, parseFollowers, parsePosts,
  isInfluencerHandle, verifyHandle, getCountryCode, trackCost,
};
