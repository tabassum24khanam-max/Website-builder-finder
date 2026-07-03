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

// Global min-interval throttle: the keyless r.jina.ai tier allows ~20 req/min.
// A full search fires dozens of lookups (enrich + Instagram + TikTok + backfill
// + phone agent per business); without pacing they 429 and fields come back
// empty. All calls are serialized ≥3s apart.
let _lastCall = 0;
let _chain = Promise.resolve();
function throttled(fn) {
  const run = _chain.then(async () => {
    const wait = _lastCall + 3000 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    return fn();
  });
  _chain = run.catch(() => {}); // keep the chain alive after failures
  return run;
}

async function searchOnce(engineUrl) {
  const { status, body } = await throttled(() => get('https://r.jina.ai/' + engineUrl));
  if (status !== 200 || !body) throw new Error(`jina ${status}`);
  return parseMarkdownResults(body);
}

// Public API — Serper-shaped result. Tries DDG, then Bing, with one retry each
// (429s happen on the keyless tier).
async function freeSearch(query, { num = 10 } = {}) {
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
