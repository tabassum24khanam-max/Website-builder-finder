// Astoria test — fully FREE stack (no Serper credits, no Google Places key):
//   discovery  : OpenStreetMap Overpass around the exact intersection node
//   enrichment : the real aiEnrich agent (search auto-falls back to DDG/Bing
//                via r.jina.ai), phone/IG/TikTok/website validated
// Usage: T_CAT=Cafes T_N=10 node astoria-test.js
require('dotenv').config();
const { findBusinessesOSM } = require('./agent/osm');
const { isChain } = require('./agent/serper-places');
const { aiEnrich } = require('./agent/ai-enrich');
const { haversineKm, withTimeout } = require('./agent/util');

const CENTER = { lat: 40.76197, lng: -73.92538 }; // Broadway & 31st St, Astoria (Overpass node)
const CAT = process.env.T_CAT || 'Cafes';
const N = parseInt(process.env.T_N || '10', 10);

(async () => {
  const t0 = Date.now();
  console.log(`\n===== ${CAT} within 5km of Broadway & 31st St, Astoria (FREE stack) =====\n`);

  const all = await findBusinessesOSM({
    category: CAT, location: 'Astoria, Queens, NY', country: 'United States',
    lat: CENTER.lat, lng: CENTER.lng, radius_km: 5, limit: 80, noWebsiteOnly: false,
    log: m => console.log('   · ' + m),
  });

  // real product filters: chains out, sort nearest-first
  const kept = all
    .filter(b => b.lat && b.lng)
    .map(b => ({ ...b, dist: haversineKm(CENTER.lat, CENTER.lng, b.lat, b.lng) }))
    .filter(b => b.dist <= 5)
    .filter(b => { const c = isChain(b.name); if (c) console.log('   ⏭️  chain skipped: ' + b.name); return !c; })
    .sort((a, b) => a.dist - b.dist);

  console.log(`\n   ${kept.length} independent candidates in radius — enriching nearest ${N} with the AI agent…\n`);

  const rows = [];
  for (const b of kept.slice(0, N)) {
    const r = await withTimeout(
      aiEnrich({ name: b.name, city: 'Astoria, Queens NY', country: 'United States', website: b.website || null }, () => {}),
      48000, null) || { phone: null, instagram: null, tiktok: null, website: b.website || null };
    rows.push({
      name: b.name, dist: b.dist,
      phone: r.phone || b.phone || '',
      ig: r.instagram || '', tt: r.tiktok || '',
      site: r.website || b.website || '',
      osmPhone: b.phone || '', osmSite: b.website || '',
    });
    const last = rows[rows.length - 1];
    console.log(`  ✓ ${b.name}  [${b.dist.toFixed(2)}km]`);
    console.log(`     📞 ${last.phone || '—'}   📸 ${last.ig ? '@' + last.ig : '—'}   🎵 ${last.tt ? '@' + last.tt : '—'}   🌐 ${last.site || 'no website'}`);
  }

  console.log(`\n===== SUMMARY (${Math.round((Date.now() - t0) / 1000)}s) =====`);
  const got = k => rows.filter(r => r[k]).length;
  console.log(`businesses: ${rows.length} | phone: ${got('phone')} | instagram: ${got('ig')} | tiktok: ${got('tt')} | has-website: ${got('site')}`);
  console.log(`all within 5km: ${rows.every(r => r.dist <= 5) ? 'YES' : 'NO'}`);
  require('fs').writeFileSync(`/tmp/astoria-${CAT}.json`, JSON.stringify(rows, null, 1));
})();
