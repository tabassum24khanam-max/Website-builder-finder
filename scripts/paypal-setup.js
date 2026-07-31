// One-time setup: creates the PayPal Product + Starter/Pro billing plans,
// and registers the webhook, via the API instead of clicking through the
// dashboard by hand.
//
// Usage: set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox first!) and
// APP_BASE_URL (e.g. https://your-app.up.railway.app), then:
//   node scripts/paypal-setup.js
// Paste everything it prints into Railway → Variables.

require('dotenv').config();
const { createProductAndPlans, createWebhook } = require('../agent/paypal-client');

(async () => {
  const live = process.env.PAYPAL_MODE === 'live';
  console.log(`Mode: ${live ? '⚠️  LIVE — this will be real money' : 'sandbox'}`);

  const { productId, plans } = await createProductAndPlans();
  console.log('\nProduct created:', productId);

  const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  let webhookId = null;
  if (baseUrl) {
    const webhook = await createWebhook(`${baseUrl}/api/billing/webhook`);
    webhookId = webhook.id;
    console.log('Webhook registered:', webhookId, '→', `${baseUrl}/api/billing/webhook`);
  } else {
    console.log('⚠️  APP_BASE_URL not set — skipped webhook registration, add it manually in the PayPal dashboard.');
  }

  console.log('\nAdd these to Railway → Variables:');
  console.log('PAYPAL_PLAN_ID_STARTER=' + plans.starter);
  console.log('PAYPAL_PLAN_ID_PRO=' + plans.pro);
  if (webhookId) console.log('PAYPAL_WEBHOOK_ID=' + webhookId);
})().catch(e => {
  console.error('FAILED:', e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  process.exit(1);
});
