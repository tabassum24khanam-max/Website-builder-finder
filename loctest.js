require('dotenv').config();
const { findBusinessesSerper } = require('./agent/serper-places');
const { haversineKm } = require('./agent/util');
const LOCS = [
  ['Al Rawdah', 'Riyadh', 'Saudi Arabia'], ['Manhattan', 'New York', 'United States'],
  ['Shoreditch', 'London', 'United Kingdom'], ['Le Marais', 'Paris', 'France'],
  ['Kreuzberg', 'Berlin', 'Germany'], ['Indiranagar', 'Bangalore', 'India'],
  ['Bondi', 'Sydney', 'Australia'], ['Shibuya', 'Tokyo', 'Japan'],
  ['Gracia', 'Barcelona', 'Spain'], ['Vila Madalena', 'Sao Paulo', 'Brazil'],
];
(async () => {
  console.log('\nLOCALITY                        CENTER             results  maxDist  ALL LOCAL?');
  console.log('-'.repeat(86));
  for (const [hood, city, country] of LOCS) {
    let center = null;
    const cap = m => { const x = String(m).match(/(?:center|centre)[^:]*:\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/); if (x) center = { lat: +x[1], lng: +x[2] }; };
    let biz = [];
    try { biz = await findBusinessesSerper({ category: 'cafe', city, neighborhood: hood, country, radiusKm: 3, limit: 15, log: cap }); }
    catch (e) { console.log(`${(hood + ', ' + city).padEnd(31)} ERROR ${e.message}`); continue; }
    const dists = biz.map(b => (center && b.lat && b.lng) ? haversineKm(center.lat, center.lng, b.lat, b.lng) : null).filter(d => d != null);
    const maxD = dists.length ? Math.max(...dists) : 0;
    const allLocal = maxD <= 35;
    const c = center ? `${center.lat.toFixed(3)},${center.lng.toFixed(3)}` : 'NONE';
    console.log(`${(hood + ', ' + city).padEnd(31)} ${c.padEnd(18)} ${String(biz.length).padStart(3)}     ${maxD.toFixed(1).padStart(5)}km   ${allLocal ? '✅ yes' : '❌ LEAK'}`);
  }
})();
