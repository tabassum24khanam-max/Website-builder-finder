// Rotates across multiple Serper accounts so one account running out of
// credits doesn't take discovery/enrichment down with it. Set SERPER_API_KEY
// as usual, then add SERPER_API_KEY_2, SERPER_API_KEY_3, ... (any number) as
// backup accounts — no code changes needed, just Railway env vars.
//
// Only quota/auth errors bench a key (that's the failure this exists for);
// a plain network timeout is not the key's fault, so it isn't benched and
// callers see the same immediate failure they did before this existed.

const KEY_ENV_RE = /^SERPER_API_KEY(_\d+)?$/;

function loadKeys() {
  return Object.keys(process.env)
    .filter(k => KEY_ENV_RE.test(k))
    .sort((a, b) => (a === 'SERPER_API_KEY' ? -1 : b === 'SERPER_API_KEY' ? 1 : a.localeCompare(b)))
    .map(k => (process.env[k] || '').trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

const dead = new Map(); // key -> reason

const QUOTA_OR_AUTH_RE = /credit|unauthorized|invalid api key|forbidden|exceeded|quota|not enough|401|403/i;
function isQuotaOrAuthError(message) {
  return QUOTA_OR_AUTH_RE.test(message || '');
}

function markDead(key, reason) {
  if (!dead.has(key)) dead.set(key, reason);
}

function healthyKeys() {
  return loadKeys().filter(k => !dead.has(k));
}

function poolStatus() {
  const all = loadKeys();
  return {
    total: all.length,
    healthy: all.length - dead.size,
    dead: all.filter(k => dead.has(k)).map(k => ({ key: k.slice(0, 6) + '…', reason: dead.get(k) })),
  };
}

module.exports = { loadKeys, healthyKeys, markDead, isQuotaOrAuthError, poolStatus };
