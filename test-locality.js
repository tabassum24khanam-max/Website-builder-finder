// Ad-hoc harness: runs the REAL agent discovery + enrichment + phone-agent for a
// given locality, exactly like the app, and prints what the machine returns.
require('dotenv').config();
const { findBusinessesSerper, enrichBusiness } = require('./agent/serper-places');
const { findPhone } = require('./agent/phone-agent');
const { haversineKm } = require('./agent/util');

const CFG = {
  category: process.env.T_CAT || 'cafe',
  neighborhood: process.env.T_HOOD || 'Ibn Khaldun',
  city: process.env.T_CITY || 'Riyadh',
  zip: process.env.T_ZIP || '13211',
  country: process.env.T_COUNTRY || 'Saudi Arabia',
  radius_km: parseFloat(process.env.T_RADIUS || '3'),
  limit: parseInt(process.env.T_LIMIT || '10', 10),
};

const log = (m, lvl) => console.log(`   ${lvl === 'warn' ? '⚠️ ' : lvl === 'error' ? '❌' : '· '} ${m}`);
let CENTER = null;
// Wrap so we can capture the resolved center from the log line.
const origLog = log;

(async () => {
  console.log(`\n========== ${CFG.category.toUpperCase()} in ${CFG.neighborhood}, ${CFG.city} ${CFG.zip}, ${CFG.country} (≤${CFG.radius_km}km) ==========\n`);
  const t0 = Date.now();

  const captureLog = (m, lvl) => {
    origLog(m, lvl);
    const mm = String(m).match(/Search center(?:\s*\(Google\))?:\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
    if (mm) CENTER = { lat: parseFloat(mm[1]), lng: parseFloat(mm[2]) };
    const pm = String(m).match(/Using map pin:\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
    if (pm) CENTER = { lat: parseFloat(pm[1]), lng: parseFloat(pm[2]) };
  };

  let businesses = [];
  try {
    businesses = await findBusinessesSerper({
      category: CFG.category, city: CFG.city, neighborhood: CFG.neighborhood,
      zip: CFG.zip, country: CFG.country, radiusKm: CFG.radius_km, limit: CFG.limit, log: captureLog,
    });
  } catch (e) { console.log('DISCOVERY ERROR:', e.message); process.exit(1); }

  console.log(`\n📋 Discovery returned ${businesses.length} businesses. Resolved center: ${CENTER ? CENTER.lat.toFixed(4) + ',' + CENTER.lng.toFixed(4) : 'NONE'}\n`);

  const rows = [];
  const N = Math.min(businesses.length, CFG.limit);
  for (let i = 0; i < N; i++) {
    const biz = businesses[i];
    const phoneFromPlaces = biz.phone || null;
    console.log(`\n[${i + 1}/${N}] ${biz.name}`);
    await enrichBusiness(biz, CFG.city, CFG.country, log).catch(e => log('enrich err ' + e.message, 'warn'));
    const phoneAfterEnrich = biz.phone || null;

    let phoneSource = phoneFromPlaces ? 'places' : (phoneAfterEnrich ? 'enrich' : null);

    // Phone-agent fallback when no phone (or toll-free), exactly like the app.
    const isTollFree = biz.phone && /^0?(800|920|8200|9200|1800)/.test(biz.phone.replace(/\D/g, ''));
    if (!biz.phone || isTollFree) {
      const found = await findPhone({ name: biz.name, city: CFG.city, country: CFG.country, website: biz.website, instagramHandle: biz.instagramHint?.handle }, log).catch(() => null);
      if (found) { biz.phone = found; phoneSource = 'phone-agent'; }
    }

    const dist = (CENTER && biz.lat && biz.lng) ? haversineKm(CENTER.lat, CENTER.lng, biz.lat, biz.lng) : null;
    rows.push({
      name: biz.name,
      dist_km: dist == null ? '?' : dist.toFixed(2),
      phone: biz.phone || '—',
      src: phoneSource || '—',
      website: biz.website || '—',
      ig: biz.instagramHint?.handle ? '@' + biz.instagramHint.handle : '—',
      address: biz.address || '—',
      lat: biz.lat, lng: biz.lng,
    });
  }

  console.log('\n\n================= RESULTS TABLE =================');
  rows.forEach((r, i) => {
    console.log(`\n${i + 1}. ${r.name}   [${r.dist_km} km from center]`);
    console.log(`   📞 ${r.phone}   (source: ${r.src})`);
    console.log(`   🌐 ${r.website}`);
    console.log(`   📸 ${r.ig}`);
    console.log(`   📍 ${r.address}   (${r.lat},${r.lng})`);
  });

  const withPhone = rows.filter(r => r.phone !== '—').length;
  const within = rows.filter(r => r.dist_km !== '?' && parseFloat(r.dist_km) <= CFG.radius_km * 1.3).length;
  console.log('\n================= SUMMARY =================');
  console.log(`Businesses:        ${rows.length}`);
  console.log(`With phone number: ${withPhone}/${rows.length}  (${Math.round(withPhone / rows.length * 100)}%)`);
  console.log(`Within ~radius:    ${within}/${rows.length}`);
  console.log(`Center:            ${CENTER ? CENTER.lat.toFixed(5) + ',' + CENTER.lng.toFixed(5) : 'NONE'}`);
  console.log(`Elapsed:           ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`\nMAPS: https://www.google.com/maps/search/?api=1&query=${CENTER ? CENTER.lat + ',' + CENTER.lng : ''}`);
  process.exit(0);
})();
