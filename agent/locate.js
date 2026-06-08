// Resolve a pasted location reference to coordinates the search starts from.
// Accepts: a Google Maps link (full or short maps.app.goo.gl / goo.gl/maps),
// a Plus Code (full "7HP8PQF5+HX3" or short "PQF5+HX3 Ar Rawdah, Riyadh"),
// a plain "lat,lng", or any address/place name.

const https = require('https');
const http = require('http');
const { httpGet, serper, getCountryCode, UA } = require('./util');

// ── Open Location Code (Plus Code) encode/decode ─────────────────────────────
const A = '23456789CFGHJMPQRVWX';
const RES = [20, 1, 0.05, 0.0025, 0.000125];

function encodeOLC(lat, lng) {
  let alat = lat + 90, alng = lng + 180, code = '';
  for (let i = 0; i < 5; i++) {
    const di = Math.min(19, Math.floor(alat / RES[i])); alat -= di * RES[i];
    const dj = Math.min(19, Math.floor(alng / RES[i])); alng -= dj * RES[i];
    code += A[di] + A[dj];
  }
  return code; // 10 chars, no separator
}
function decodeOLC(full) {
  const c = full.replace('+', '').toUpperCase();
  let lat = -90, lng = -180, i = 0;
  for (; i < 5 && i * 2 + 1 < c.length; i++) {
    const a = A.indexOf(c[i * 2]), b = A.indexOf(c[i * 2 + 1]);
    if (a < 0 || b < 0) break;
    lat += a * RES[i]; lng += b * RES[i];
  }
  const cell = RES[Math.max(0, i - 1)];
  return { lat: lat + cell / 2, lng: lng + cell / 2 };
}
const PLUS_RE = /\b([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3})\b/i;

// Pull coordinates out of any text (a maps URL or a page body).
function coordsFromText(t) {
  const m =
    t.match(/@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/) ||
    t.match(/!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/) ||
    t.match(/[?&/](?:q|query|ll|sll|center|destination|daddr)=(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/) ||
    t.match(/"latitude"\s*:\s*(-?\d{1,2}\.\d{3,})[\s\S]{0,60}?"longitude"\s*:\s*(-?\d{1,3}\.\d{3,})/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}

// Geocode a place/address to a rough centre (used as the reference for short
// Plus Codes and for plain addresses). Serper→Google first, Nominatim fallback.
async function geocodeText(text, country) {
  if (!text) return null;
  try {
    // anchor with a business term — Serper /places returns nothing for a bare
    // place name, but venues near the area give a reliable centroid.
    const data = await serper('/places', { q: `cafe ${text}`, gl: getCountryCode(country), hl: 'en' }, process.env.SERPER_API_KEY, 8000);
    const pts = (data.places || []).filter(p => p.latitude && p.longitude).slice(0, 5);
    if (pts.length) return { lat: pts.reduce((s, p) => s + p.latitude, 0) / pts.length, lng: pts.reduce((s, p) => s + p.longitude, 0) / pts.length };
  } catch {}
  try {
    const d = await httpGet(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=json&limit=1&accept-language=en`, { timeoutMs: 8000 });
    const j = JSON.parse(d); if (j && j[0]) return { lat: +j[0].lat, lng: +j[0].lon };
  } catch {}
  return null;
}

// Follow redirects (short links) and return the final URL + a slice of the body.
function expandUrl(url, depth = 0) {
  return new Promise(resolve => {
    if (depth > 6) return resolve({ url, body: '' });
    let lib; try { lib = url.startsWith('https') ? https : http; } catch { return resolve({ url, body: '' }); }
    let req;
    try {
      req = lib.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          let next = res.headers.location;
          if (next.startsWith('/')) { try { const p = new URL(url); next = p.origin + next; } catch {} }
          return resolve(expandUrl(next, depth + 1));
        }
        let data = '';
        res.on('data', c => { data += c; if (data.length > 90000) res.destroy(); });
        res.on('end', () => resolve({ url, body: data }));
        res.on('close', () => resolve({ url, body: data }));
      });
    } catch { return resolve({ url, body: '' }); }
    req.on('error', () => resolve({ url, body: '' }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ url, body: '' }); });
  });
}

async function resolveLocation({ q, city, country }) {
  q = (q || '').trim();
  if (!q) return null;

  // 1) plain "lat,lng"
  let m = q.match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
  if (m) return { lat: +m[1], lng: +m[2], label: 'coordinates' };

  // 2) Plus Code (full or short with a locality / typed city as the reference)
  const pc = q.match(PLUS_RE);
  if (pc) {
    const code = pc[1].toUpperCase();
    const after = q.slice(q.indexOf(pc[1]) + pc[1].length).replace(/^[\s,]+/, '').trim();
    const localityText = after || [city, country].filter(Boolean).join(', ');
    const plusIdx = code.indexOf('+');
    let full = code;
    if (plusIdx < 8) { // short code → recover the missing prefix from a reference point
      const ref = await geocodeText(localityText, country);
      if (!ref) return null;
      full = encodeOLC(ref.lat, ref.lng).slice(0, 8 - plusIdx) + code;
    }
    const d = decodeOLC(full);
    if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) return { lat: d.lat, lng: d.lng, label: `Plus Code ${code}` };
    return null;
  }

  // 3) a URL (full maps link, short link, or a business/place link)
  if (/^https?:\/\//i.test(q) || /(maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google)/i.test(q)) {
    const url = /^https?:/i.test(q) ? q : 'https://' + q;
    let c = coordsFromText(url);
    if (c) return { ...c, label: 'map link' };
    const { url: finalUrl, body } = await expandUrl(url);
    c = coordsFromText(finalUrl) || coordsFromText(body);
    if (c) return { ...c, label: 'map link' };
    // last resort: a place name in the resolved URL
    const place = (finalUrl.match(/\/place\/([^/@]+)/) || [])[1];
    if (place) { const g = await geocodeText(decodeURIComponent(place.replace(/\+/g, ' ')), country); if (g) return { ...g, label: 'map link' }; }
    return null;
  }

  // 4) otherwise: treat as an address/place to geocode
  const g = await geocodeText(q, country);
  return g ? { ...g, label: q.slice(0, 40) } : null;
}

module.exports = { resolveLocation };
