// Rotates across multiple Serper accounts so one account running out of
// credits doesn't take discovery/enrichment down with it. Set SERPER_API_KEY
// as usual, then add SERPER_API_KEY_2, SERPER_API_KEY_3, ... (any number) as
// backup accounts — no code changes needed, just Railway env vars.
//
// Only quota/auth errors bench a key (that's the failure this exists for);
// a plain network timeout is not the key's fault, so it isn't benched and
// callers see the same immediate failure they did before this existed.

const EventEmitter = require('events');

const KEY_ENV_RE = /^SERPER_API_KEY(_\d+)?$/;

// Returns {name, key} pairs (env var name + trimmed value) in the order
// they're tried — SERPER_API_KEY first, then _2, _3... alphabetically.
// Keeping the name alongside the value is what lets the owner dashboard show
// "SERPER_API_KEY_2 is the one currently in use" instead of just a masked key.
function loadKeyEntries() {
  const seen = new Set();
  return Object.keys(process.env)
    .filter(k => KEY_ENV_RE.test(k))
    .sort((a, b) => (a === 'SERPER_API_KEY' ? -1 : b === 'SERPER_API_KEY' ? 1 : a.localeCompare(b)))
    .map(name => ({ name, key: (process.env[name] || '').trim() }))
    .filter(e => e.key)
    .filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true))); // de-dupe identical values under different names
}

function loadKeys() {
  return loadKeyEntries().map(e => e.key);
}

const dead = new Map(); // key -> reason
const events = new EventEmitter();
let lastAlertedAt = null; // healthy count we last emitted 'low-keys' for — only re-fire on a NEW lower count

const QUOTA_OR_AUTH_RE = /credit|unauthorized|invalid api key|forbidden|exceeded|quota|not enough|401|403/i;
function isQuotaOrAuthError(message) {
  return QUOTA_OR_AUTH_RE.test(message || '');
}

function markDead(key, reason) {
  if (dead.has(key)) return;
  dead.set(key, reason);

  const healthyCount = healthyKeys().length;
  if (healthyCount <= 1 && lastAlertedAt !== healthyCount) {
    lastAlertedAt = healthyCount;
    events.emit('low-keys', { healthyCount, total: loadKeys().length, reason });
  }
}

function healthyKeys() {
  return loadKeys().filter(k => !dead.has(k));
}

function poolStatus() {
  const entries = loadKeyEntries();
  const active = entries.find(e => !dead.has(e.key));
  return {
    total: entries.length,
    healthy: entries.filter(e => !dead.has(e.key)).length,
    active: active ? active.name : null,
    accounts: entries.map(e => ({
      name: e.name,
      masked: e.key.slice(0, 6) + '…',
      status: dead.has(e.key) ? 'dead' : 'healthy',
      reason: dead.get(e.key) || null,
    })),
  };
}

module.exports = { loadKeys, loadKeyEntries, healthyKeys, markDead, isQuotaOrAuthError, poolStatus, events };
