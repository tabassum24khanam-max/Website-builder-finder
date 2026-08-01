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
//
// SECURITY: subscriptionId comes from the client, so it must never be trusted
// as proof of ownership on its own — anyone could POST any ACTIVE
// subscriptionId (their own from a previous account, one glimpsed in
// devtools/a screenshot/a proxy log, etc.) and, without the check below,
// silently attach someone else's real payment to their own account, or let
// N free accounts all claim the same paid subscription. The frontend sets
// custom_id to the caller's own user id at subscription-CREATE time (see
// renderPaypalButton in public/index.html) specifically so this endpoint has
// something from PayPal itself — not the request body — to check ownership
// against. The UNIQUE index on subscriptions.paypal_subscription_id
// (db/index.js) is the second, structural layer of the same defense.
router.post('/confirm', requireAuth, async (req, res) => {
  const subscriptionId = String(req.body.subscriptionId || '');
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' });

  let sub;
  try {
    sub = await paypal.getSubscription(subscriptionId);
  } catch (e) {
    return res.status(502).json({ error: 'Could not verify the subscription with PayPal: ' + e.message });
  }

  if (sub.custom_id !== req.user.id) {
    return res.status(403).json({ error: 'This subscription does not belong to your account.' });
  }

  const tier = planTierById()[sub.plan_id];
  if (!tier) return res.status(400).json({ error: 'Unrecognized plan ID.' });
  if (sub.status !== 'ACTIVE') return res.status(400).json({ error: `Subscription is ${sub.status}, not active yet.` });

  try {
    q.updateSubscriptionTier.run({
      user_id: req.user.id, tier, status: 'active',
      paypal_subscription_id: subscriptionId,
      period_start: new Date().toISOString(),
      period_end: (sub.billing_info && sub.billing_info.next_billing_time) || null,
    });
    // Same reasoning as the ACTIVATED webhook case: a user who previously
    // cancelled and is re-subscribing on the same account must not start
    // their new subscription already sitting at their old AI usage cap.
    q.resetAIUsage.run(req.user.id);
  } catch (e) {
    // Should be unreachable given the custom_id check above — kept as a clean
    // error instead of a 500 in case a race or a future bug still hits the
    // UNIQUE constraint, rather than crashing or leaking a raw SQLite error.
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This subscription is already linked to a different account.' });
    }
    return res.status(500).json({ error: 'Could not save the subscription.' });
  }

  res.json({ success: true, tier });
});

// Self-service cancel from the pricing modal. Downgrades to Free immediately
// so the UI feels instant instead of waiting on the webhook — the webhook's
// own BILLING.SUBSCRIPTION.CANCELLED handler still fires and just re-applies
// the same state, which is harmless (updateSubscriptionTier is idempotent).
router.post('/cancel', requireAuth, async (req, res) => {
  const sub = q.getSubscriptionByUserId.get(req.user.id);
  if (!sub || !sub.paypal_subscription_id || sub.tier === 'free') {
    return res.status(400).json({ error: 'No active paid subscription to cancel.' });
  }

  try {
    await paypal.cancelSubscription(sub.paypal_subscription_id, 'Customer requested cancellation');
  } catch (e) {
    return res.status(502).json({ error: 'Could not cancel with PayPal: ' + e.message });
  }

  q.updateSubscriptionTier.run({
    user_id: req.user.id, tier: 'free', status: 'cancelled',
    paypal_subscription_id: sub.paypal_subscription_id, period_start: null, period_end: null,
  });
  res.json({ success: true });
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
        // A fresh row already starts at 0, but if this user previously
        // cancelled and is now re-subscribing on the SAME account row, their
        // old ai_searches_used would otherwise carry over — someone who used
        // up their AI quota, cancelled, and paid again could start their
        // brand-new subscription already stuck at cap.
        q.resetAIUsage.run(row.user_id);
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
        // Renewal payment cleared — start a fresh monthly counter. Must reset
        // ai_searches_used here too: once period_end is advanced to a real
        // future date (below), the lazy fallback in server.js's
        // resetAIUsageIfNeeded() will never fire for the whole new period
        // (it only resets when period_end has already PASSED) — without this,
        // a customer who used their full AI quota once would never get it
        // back on any future renewal despite paying every month.
        q.resetSearchUsage.run({
          user_id: row.user_id,
          period_start: new Date().toISOString(),
          period_end: (resource.billing_info && resource.billing_info.next_billing_time) || null,
        });
        q.resetAIUsage.run(row.user_id);
        break;
    }
  }

  res.json({ received: true });
});

module.exports = router;
