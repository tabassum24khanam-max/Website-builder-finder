// Free web search — no API key, no credits.
//
// DuckDuckGo (and Bing as backup) fetched THROUGH r.jina.ai, a free reader
// proxy that renders pages from its own infrastructure — so datacenter-IP
// blocks on our side don't apply. Output is shaped exactly like a Serper
// /search response ({ organic: [{title, link, snippet}] }) so every existing
// call site can use it as a drop-in fallback when Serper credits run out.
//
// Keyless r.jina.ai is rate-limited (~20 req/min) — fine for sequential
// per-business enrichment; a tiny retry/backoff handles the occasional 429.

const https = require('https');

function get(url, timeoutMs = 22000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/plain, text/markdown, */*' },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; if (d.length > 300000) res.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
      res.on('close', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Decode DDG redirect links (//duckduckgo.com/l/?uddg=<enc>) and Bing wrappers.
function cleanLink(href) {
  if (!href) return null;
  try {
    if (/duckduckgo\.com\/l\/\?/i.test(href)) {
      const m = href.match(/[?&]uddg=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    if (/bing\.com\/ck\/a/i.test(href)) {
      const m = href.match(/[?&]u=a1([^&]+)/);
      if (m) { try { return Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch {} }
    }
  } catch {}
  if (/^https?:\/\//i.test(href)) return href;
  return null;
}

const SKIP_HOSTS = /duckduckgo\.com|bing\.com\/(images|videos|maps|news|search)|microsoft\.com|go\.microsoft/i;

// Parse jina's markdown rendering of a results page: "## [Title](link)" headers
// followed by snippet text until the next header/link block.
function parseMarkdownResults(md) {
  const out = [];
  const re = /^#{0,4}\s*\[([^\]]{3,200})\]\((https?:\/\/[^)\s]+)\)\s*$/gm;
  const matches = [...md.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const title = matches[i][1].replace(/\*\*/g, '').trim();
    const link = cleanLink(matches[i][2]);
    if (!link || SKIP_HOSTS.test(link)) continue;
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : Math.min(md.length, start + 600);
    const snippet = md.slice(start, end)
      .replace(/!\[[^\]]*\]\([^)]*\)?/g, ' ')        // strip image markdown
      .replace(/!\[[^\]]*\]\(?/g, ' ')               // ...even when unterminated
      .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')   // strip md links, keep text
      .replace(/[#*_>`|]/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    if (out.some(r => r.link === link)) continue;
    out.push({ title, link, snippet });
  }
  return out;
}

// Global ADAPTIVE throttle: the keyless r.jina.ai tier rate-limits (~20/min
// sustained), but bursts often pass. A fixed 3s gap starves concurrent searches
// (every step waits behind the whole queue until its timeout kills it). So:
// start fast (1.5s), double the gap only when jina actually answers 429 (up to
// 6s), and shrink back after a streak of successes.
let _lastCall = 0;
let _chain = Promise.resolve();
let _gapMs = 1500;
let _okStreak = 0;
function noteResult(status) {
  if (status === 429) { _gapMs = Math.min(6000, _gapMs * 2); _okStreak = 0; }
  else if (status === 200 && ++_okStreak >= 4) { _gapMs = Math.max(1200, Math.round(_gapMs * 0.75)); _okStreak = 0; }
}
function throttled(fn) {
  const run = _chain.then(async () => {
    const wait = _lastCall + _gapMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    return fn();
  });
  _chain = run.catch(() => {}); // keep the chain alive after failures
  return run;
}

async function searchOnce(engineUrl) {
  const { status, body } = await throttled(() => get('https://r.jina.ai/' + engineUrl));
  noteResult(status);
  if (status !== 200 || !body) throw new Error(`jina ${status}`);
  return parseMarkdownResults(body);
}

// ── DIRECT DuckDuckGo (no proxy) ─────────────────────────────────────────────
// html.duckduckgo.com often answers datacenter IPs directly (its blocking is
// intermittent). When it does, it's the best engine we have: fast, no third
// party, no shared rate cap. Tried FIRST; jina engines remain the fallback.
let _ddgLast = 0;
async function ddgDirect(query) {
  const wait = _ddgLast + 1200 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _ddgLast = Date.now();
  const { status, body } = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`, 12000);
  if (status !== 200 || !body || !/result__a/.test(body)) throw new Error(`ddg ${status}`);
  const out = [];
  // <a rel="nofollow" class="result__a" href="...">Title</a> … snippet in
  // .result__snippet; hrefs are //duckduckgo.com/l/?uddg= redirects.
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/g;
  const links = [...body.matchAll(linkRe)];
  const snips = [...body.matchAll(snipRe)];
  const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < links.length; i++) {
    const href = links[i][1].startsWith('//') ? 'https:' + links[i][1] : links[i][1];
    const link = cleanLink(href);
    if (!link || SKIP_HOSTS.test(link)) continue;
    if (out.some(r => r.link === link)) continue;
    out.push({ title: strip(links[i][2]).slice(0, 200), link, snippet: strip((snips[i] || [])[1] || '').slice(0, 300) });
  }
  if (!out.length) throw new Error('ddg parsed 0');
  return out;
}

// Public API — Serper-shaped result. Engine order: DIRECT DuckDuckGo (fastest,
// no shared cap), then DDG and Bing through the jina proxy, one retry each.
async function freeSearch(query, { num = 10 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const organic = await ddgDirect(query);
      if (organic.length) return { organic: organic.slice(0, num), source: 'ddg-direct' };
    } catch { if (attempt === 0) await new Promise(r => setTimeout(r, 3000)); }
  }
  const q = encodeURIComponent(query);
  const engines = [
    `https://html.duckduckgo.com/html/?q=${q}&kl=us-en`,
    `https://www.bing.com/search?q=${q}&setlang=en`,
  ];
  for (const url of engines) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const organic = await searchOnce(url);
        if (organic.length) return { organic: organic.slice(0, num), source: url.includes('bing') ? 'bing' : 'ddg' };
      } catch (e) {
        if (attempt === 0) await new Promise(r => setTimeout(r, 2500));
      }
    }
  }
  return { organic: [], source: 'none' };
}

module.exports = { freeSearch };
