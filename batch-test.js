// Instrumented batch tester: runs the REAL discovery + enrichment + phone-agent
// for a list of worldwide localities, counts every Serper call and OpenAI token,
// and reports the measured $ cost per test. Network is intercepted at the source
// (Node https for Serper, global fetch for OpenAI) so the numbers are real.
require('dotenv').config();
process.env.COST_TRACK = '1'; // make the agent tally OpenAI token usage into global.__cost

// ── Pricing (USD) ────────────────────────────────────────────────────────────
const PRICE = {
  oaiIn: 0.15 / 1e6,   // gpt-4o-mini input  $0.15 / 1M tokens
  oaiOut: 0.60 / 1e6,  // gpt-4o-mini output $0.60 / 1M tokens
  serper: 0.001,       // Serper.dev ~ $50 / 50,000 credits = $0.001 / call
};

// ── Counters (global + per-test) ─────────────────────────────────────────────
const C = { serper: 0, pages: 0, oaiCalls: 0, inTok: 0, outTok: 0 };
const reset = () => Object.keys(C).forEach(k => (C[k] = 0));

// Intercept Node https (Serper + page opens go through https.request/get).
const https = require('https');
const origReq = https.request;
https.request = function (opts, ...rest) {
  try {
    const host = typeof opts === 'string' ? new URL(opts).hostname : (opts.hostname || opts.host || '');
    if (host.includes('serper')) C.serper++; else if (host) C.pages++;
  } catch {}
  return origReq.call(this, opts, ...rest);
};

// OpenAI usage is read from the SDK's own `usage` field (global.__cost), since
// the SDK doesn't route through globalThis.fetch on this Node/SDK version.
const oaiSnapshot = () => ({ ...(global.__cost || { i: 0, o: 0, n: 0 }) });

// Require agent modules AFTER patching so they use the intercepted clients.
const { findBusinessesSerper, enrichBusiness } = require('./agent/serper-places');
const { findPhone } = require('./agent/phone-agent');
const { haversineKm } = require('./agent/util');

const cost = () => C.serper * PRICE.serper + C.inTok * PRICE.oaiIn + C.outTok * PRICE.oaiOut;
const money = n => '$' + n.toFixed(4);

// ── Test set: 10 worldwide + 1 in the user's Riyadh locality ──────────────────
const ALL = [
  { tag: '🇯🇵 Tokyo',       cat: 'coffee shop',     hood: 'Shibuya',          city: 'Tokyo',        zip: '150-0002', country: 'Japan' },
  { tag: '🇦🇪 Dubai',       cat: 'specialty coffee',hood: 'Jumeirah',         city: 'Dubai',        zip: '',         country: 'United Arab Emirates' },
  { tag: '🇨🇦 Toronto',     cat: 'cafe',            hood: 'Kensington Market', city: 'Toronto',     zip: 'M5T',      country: 'Canada' },
  { tag: '🇦🇺 Sydney',      cat: 'cafe',            hood: 'Surry Hills',      city: 'Sydney',       zip: '2010',     country: 'Australia' },
  { tag: '🇪🇸 Barcelona',   cat: 'café',            hood: 'Gràcia',           city: 'Barcelona',    zip: '08012',    country: 'Spain' },
  { tag: '🇳🇱 Amsterdam',   cat: 'koffiebar',       hood: 'Jordaan',          city: 'Amsterdam',    zip: '1015',     country: 'Netherlands' },
  { tag: '🇹🇷 Istanbul',    cat: 'coffee',          hood: 'Kadıköy',          city: 'Istanbul',     zip: '34710',    country: 'Turkey' },
  { tag: '🇧🇷 São Paulo',   cat: 'cafeteria',       hood: 'Vila Madalena',    city: 'São Paulo',    zip: '05433',    country: 'Brazil' },
  { tag: '🇿🇦 Cape Town',   cat: 'coffee shop',     hood: 'Woodstock',        city: 'Cape Town',    zip: '7925',     country: 'South Africa' },
  { tag: '🇲🇽 Mexico City',  cat: 'cafetería',       hood: 'Roma Norte',       city: 'Mexico City',  zip: '06700',    country: 'Mexico' },
  { tag: '🇸🇦 Riyadh (YOURS)', cat: 'cafe',          hood: 'Ibn Khaldun',      city: 'Riyadh',       zip: '13211',    country: 'Saudi Arabia' },
];

const START = parseInt(process.env.T_START || '0', 10);
const COUNT = parseInt(process.env.T_COUNT || String(ALL.length), 10);
const LIMIT = parseInt(process.env.T_LIMIT || '3', 10);
const RADIUS = parseFloat(process.env.T_RADIUS || '3');
const TESTS = ALL.slice(START, START + COUNT);

const quiet = () => {}; // silence the agent's own logging; we only want the summary

(async () => {
  const totals = { serper: 0, oaiCalls: 0, inTok: 0, outTok: 0, cost: 0 };
  const lines = [];

  for (const t of TESTS) {
    reset();
    const oaiBase = oaiSnapshot();
    let center = null;
    const cap = (m) => { const mm = String(m).match(/center(?:\s*\(Google\))?:\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/); if (mm) center = { lat: +mm[1], lng: +mm[2] }; };

    let biz = [];
    try {
      biz = await findBusinessesSerper({ category: t.cat, city: t.city, neighborhood: t.hood, zip: t.zip, country: t.country, radiusKm: RADIUS, limit: LIMIT, log: cap });
    } catch (e) { lines.push(`${t.tag.padEnd(20)}  DISCOVERY ERROR: ${e.message}`); continue; }

    const N = Math.min(biz.length, LIMIT);
    let phones = 0, inRadius = 0;
    const detail = [];
    for (let i = 0; i < N; i++) {
      const b = biz[i];
      await enrichBusiness(b, t.city, t.country, quiet).catch(() => {});
      const tollFree = b.phone && /^0?(800|92[05]|9200)/.test((b.phone || '').replace(/\D/g, '').replace(/^966/, ''));
      if (!b.phone || tollFree) {
        const f = await findPhone({ name: b.name, city: t.city, country: t.country, website: b.website, instagramHandle: b.instagramHint?.handle }, quiet).catch(() => null);
        if (f) b.phone = f;
      }
      if (b.phone) phones++;
      const d = (center && b.lat && b.lng) ? haversineKm(center.lat, center.lng, b.lat, b.lng) : null;
      if (d != null && d <= RADIUS * 1.3) inRadius++;
      detail.push(`      • ${(b.name || '').slice(0, 34).padEnd(34)} ${d == null ? '  ?  ' : (d.toFixed(2) + 'km').padStart(6)}  ${b.phone || '—'}`);
    }

    const oaiNow = oaiSnapshot();
    C.inTok = oaiNow.i - oaiBase.i; C.outTok = oaiNow.o - oaiBase.o; C.oaiCalls = oaiNow.n - oaiBase.n;
    const c = cost();
    totals.serper += C.serper; totals.oaiCalls += C.oaiCalls; totals.inTok += C.inTok; totals.outTok += C.outTok; totals.cost += c;
    lines.push(`${t.tag.padEnd(20)} ${center ? (center.lat.toFixed(3) + ',' + center.lng.toFixed(3)).padEnd(18) : 'NO CENTER       '.padEnd(18)} pins:${inRadius}/${N}  phones:${phones}/${N}  | ${C.serper} serper, ${C.inTok + C.outTok} tok  = ${money(c)}`);
    detail.forEach(d => lines.push(d));
    await new Promise(r => setTimeout(r, 1500)); // be a polite neighbor to the geocoders between tests
  }

  console.log('\n================== RESULTS (locality + phones + measured cost) ==================\n');
  lines.forEach(l => console.log(l));
  const n = TESTS.length;
  console.log('\n================== COST ==================');
  console.log(`Tests run:        ${n}  (limit ${LIMIT} businesses each)`);
  console.log(`Serper calls:     ${totals.serper}  → ${money(totals.serper * PRICE.serper)}`);
  console.log(`OpenAI tokens:    ${totals.inTok} in + ${totals.outTok} out → ${money(totals.inTok * PRICE.oaiIn + totals.outTok * PRICE.oaiOut)}`);
  console.log(`OpenAI calls:     ${totals.oaiCalls}`);
  console.log(`-----------------------------------------`);
  console.log(`TOTAL:            ${money(totals.cost)}`);
  console.log(`PER TEST avg:     ${money(totals.cost / n)}   (${Math.round(totals.serper / n)} serper + ${Math.round((totals.inTok + totals.outTok) / n)} tok)`);
  console.log(`PER BUSINESS avg: ${money(totals.cost / (n * LIMIT))}`);
  process.exit(0);
})();
