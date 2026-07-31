// Single source of truth for plan limits — checked server-side before every
// search starts. Never trust a client-sent tier or ai_mode flag; always look
// the user's subscription up in the DB.

const TIERS = {
  free: {
    label: 'Free',
    price: 0,
    lifetimeSearches: 5,   // total, ever — not per month
    monthlySearches: null,
    maxRadiusKm: 5,
    radiusOptions: [1, 2, 5],
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
    researchRoundsPerSearch: 20,  // server-side cap to prevent runaway loops
    aiSearchesPerMonth: 20,
  },
};

function getTier(name) {
  return TIERS[name] || TIERS.free;
}

module.exports = { TIERS, getTier };
