// Single source of truth for plan limits — checked server-side before every
// search starts. Never trust a client-sent tier or ai_mode flag; always look
// the user's subscription up in the DB.

// Full universal option lists — the UI always shows all of these, but greys
// out / labels the ones above the caller's tier so upgrading feels concrete
// ("this exact option unlocks on Pro") instead of options just disappearing.
const ALL_RADIUS_OPTIONS_KM = [1, 2, 5, 10, 20, 50];
const ALL_COUNT_OPTIONS = [3, 6, 10, 20, 30, 40, 50];

const TIERS = {
  free: {
    label: 'Free',
    price: 0,
    lifetimeSearches: 5,   // total, ever — not per month
    monthlySearches: null,
    maxRadiusKm: 5,
    radiusOptions: [1, 2, 5],
    maxCount: 6,
    countOptions: [3, 6],
    researchRoundsPerSearch: 3,
    aiSearchesPerMonth: 0,  // no AI for free
  },
  starter: {
    label: 'Starter',
    price: 9,
    lifetimeSearches: null,
    monthlySearches: 60,
    maxRadiusKm: 20,
    radiusOptions: [1, 2, 5, 10, 20],
    maxCount: 20,
    countOptions: [3, 6, 10, 20],
    researchRoundsPerSearch: 5,
    aiSearchesPerMonth: 5,
  },
  pro: {
    label: 'Pro',
    price: 19.99,
    lifetimeSearches: null,
    monthlySearches: 150,
    maxRadiusKm: 50,
    radiusOptions: [1, 2, 5, 10, 20, 50],
    maxCount: 50,
    countOptions: [3, 6, 10, 20, 30, 40, 50],
    researchRoundsPerSearch: 20,  // server-side cap to prevent runaway loops
    aiSearchesPerMonth: 20,
  },
};

// Which tier first unlocks each radius/count value — used by the frontend to
// label locked options ("50 km — Pro") instead of just hiding them.
function tierRequiredFor(value, allOptions, tierOrder = ['free', 'starter', 'pro']) {
  for (const t of tierOrder) {
    if (TIERS[t][allOptions === ALL_RADIUS_OPTIONS_KM ? 'radiusOptions' : 'countOptions'].includes(value)) return t;
  }
  return 'pro';
}

function getTier(name) {
  return TIERS[name] || TIERS.free;
}

module.exports = { TIERS, getTier, ALL_RADIUS_OPTIONS_KM, ALL_COUNT_OPTIONS, tierRequiredFor };
