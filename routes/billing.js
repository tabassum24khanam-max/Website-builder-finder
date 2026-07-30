const express = require('express');
const { q, db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const paypal = require('../agent/paypal-client');

const router = express.Router();

function planTierById() {
  return {
    [process.env.PAYPAL_PLAN_ID_STARTER]: 'starter',
    [process.env.PAYPAL_PLAN_ID_PRO]: 'pro',
  };
}

// Frontend calls this right after the PayPal button's onApprove fires. We
// re-check with PayPal directly rather than trusting the client — this only
// gives instant UI feedback; the webhook below is the actual source of truth
// for the subscription's status going forward (renewals, cancellations).
router.post('/confirm', requireAuth, async (req, res) => {
  const subscriptionId = String(req.body.subscriptionId || '');
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' });

  try {
    const sub = await paypal.getSubscription(subscriptionId);
    const tier = planTierById()[sub.plan_id];
    if (!tier) return res.status(400).json({ error: 'Unrecognized plan ID.' });
    if (sub.status !== 'ACTIVE') return res.status(400).json({ error: `Subscription is ${sub.status}, not active yet.` });

    q.updateSubscriptionTier.run({
      user_id: req.user.id, tier, status: 'active',
      paypal_subscription_id: subscriptionId,
      period_start: new Date().toISOString(),
      period_end: (sub.billing_info && sub.billing_info.next_billing_time) || null,
    });
    res.json({ success: true, tier });
  } catch (e) {
    res.status(502).json({ error: 'Could not verify the subscription with PayPal: ' + e.message });
  }
});

// PayPal calls this directly (no session/cookie) — this is the real source
// of truth for renewals, cancellations, and payment failures.
router.post('/webhook', async (req, res) => {
  let verified = false;
  try { verified = await paypal.verifyWebhookSignature(req.headers, req.body); } catch (_) {}
  if (!verified) return res.status(400).json({ error: 'Signature verification failed' });

  const event = req.body || {};
  const resource = event.resource || {};
  const subscriptionId = resource.id || resource.billing_agreement_id;
  const row = subscriptionId
    ? db.prepare('SELECT user_id FROM subscriptions WHERE paypal_subscription_id = ?').get(subscriptionId)
    : null;

  if (row) {
    const tier = planTierById()[resource.plan_id];
    switch (event.event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        q.updateSubscriptionTier.run({
          user_id: row.user_id, tier: tier || 'starter', status: 'active',
          paypal_subscription_id: subscriptionId,
          period_start: new Date().toISOString(),
          period_end: (resource.billing_info && resource.billing_info.next_billing_time) || null,
        });
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        q.updateSubscriptionTier.run({
          user_id: row.user_id, tier: 'free', status: 'cancelled',
          paypal_subscription_id: subscriptionId, period_start: null, period_end: null,
        });
        break;
      case 'PAYMENT.SALE.COMPLETED':
        // Renewal payment cleared — start a fresh monthly counter.
        q.resetSearchUsage.run({
          user_id: row.user_id,
          period_start: new Date().toISOString(),
          period_end: (resource.billing_info && resource.billing_info.next_billing_time) || null,
        });
        break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
