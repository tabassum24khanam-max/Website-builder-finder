// One-time setup: creates the PayPal Product + Starter/Pro billing plans via
// the API instead of clicking through the dashboard by hand.
//
// Usage: set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox first!), then:
//   node scripts/paypal-setup.js
// Paste the printed Plan IDs into Railway as PAYPAL_PLAN_ID_STARTER / _PRO.

require('dotenv').config();
const { createProductAndPlans } = require('../agent/paypal-client');

(async () => {
  const live = process.env.PAYPAL_MODE === 'live';
  console.log(`Mode: ${live ? '⚠️  LIVE — this will be real money' : 'sandbox'}`);
  const { productId, plans } = await createProductAndPlans();
  console.log('\nProduct created:', productId);
  console.log('\nAdd these to Railway → Variables:');
  console.log('PAYPAL_PLAN_ID_STARTER=' + plans.starter);
  console.log('PAYPAL_PLAN_ID_PRO=' + plans.pro);
})().catch(e => {
  console.error('FAILED:', e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  process.exit(1);
});
