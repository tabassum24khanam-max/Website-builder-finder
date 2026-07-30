// Single source of truth for plan limits — checked server-side before every
// search starts. Never trust a client-sent tier or ai_mode flag; always look
// the user's subscription up in the DB.

const TIERS = {
  free: {
    label: 'Free',
    price: 0,
    lifetimeSearches: 5,   // total, ever — not per month
    monthlySearches: null,
    aiMode: false,
  },
  starter: {
    label: 'Starter',
    price: 9,
    lifetimeSearches: null,
    monthlySearches: 60,
    aiMode: false,
  },
  pro: {
    label: 'Pro',
    price: 19.99,
    lifetimeSearches: null,
    monthlySearches: 150,
    aiMode: true,
  },
};

function getTier(name) {
  return TIERS[name] || TIERS.free;
}

module.exports = { TIERS, getTier };
