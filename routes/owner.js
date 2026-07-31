const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { q, db } = require('../db');
const { requireOwner, isGuestEmail } = require('../middleware/auth');
const { TIERS } = require('../db/tiers');
const serperPool = require('../agent/serper-pool');
const paypal = require('../agent/paypal-client');

const router = express.Router();

router.get('/stats', requireOwner, (req, res) => {
  const totalUsers = q.countRealUsers.get().n;
  const totalGuests = q.countGuestUsers.get().n;

  const activeByTier = { free: 0, starter: 0, pro: 0 };
  for (const row of q.countSubsByTierStatus.all()) {
    if (row.status === 'active') activeByTier[row.tier] = (activeByTier[row.tier] || 0) + row.n;
  }
  const mrr = activeByTier.starter * TIERS.starter.price + activeByTier.pro * TIERS.pro.price;

  res.json({
    totalUsers,
    totalGuests,
    activeByTier,
    mrr: Math.round(mrr * 100) / 100,
    totalSearches: q.countAllSearches.get().n,
    totalLeads: q.countAllLeads.get().n,
    totalMessages: q.listContacts.all().length,
  });
});

router.get('/users', requireOwner, (req, res) => {
  const rows = q.listUsersForOwner.all().map(u => ({ ...u, isGuest: isGuestEmail(u.email) }));
  res.json(rows);
});

router.get('/messages', requireOwner, (req, res) => {
  res.json(q.listContacts.all());
});

// Answers "is this actually working right now" for the two external services
// that silently degrade instead of erroring loudly: Serper (falls back to
// OpenStreetMap) and PayPal (a bad Plan/Webhook ID just makes checkout fail
// for customers with no signal to the owner). Every PayPal check is a live
// API call against the currently-configured credentials, not just "is the
// env var set" — a Plan ID from the wrong sandbox/live app IS set, but wrong.
router.get('/billing-health', requireOwner, async (req, res) => {
  const serper = serperPool.poolStatus();

  const paypalConfigured = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  const paypalMode = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
  const checks = { starter: null, pro: null, webhook: null };

  if (paypalConfigured) {
    const planChecks = await Promise.all(['starter', 'pro'].map(async (tier) => {
      const envVar = `PAYPAL_PLAN_ID_${tier.toUpperCase()}`;
      const planId = process.env[envVar];
      if (!planId) return [tier, { ok: false, error: `${envVar} not set` }];
      try {
        const plan = await paypal.getPlan(planId);
        return [tier, { ok: plan.status === 'ACTIVE', status: plan.status, name: plan.name }];
      } catch (e) {
        return [tier, { ok: false, error: e.message }];
      }
    }));
    for (const [tier, result] of planChecks) checks[tier] = result;

    if (!process.env.PAYPAL_WEBHOOK_ID) {
      checks.webhook = { ok: false, error: 'PAYPAL_WEBHOOK_ID not set' };
    } else {
      try {
        const hook = await paypal.getWebhook(process.env.PAYPAL_WEBHOOK_ID);
        checks.webhook = { ok: true, url: hook.url };
      } catch (e) {
        checks.webhook = { ok: false, error: e.message };
      }
    }
  }

  res.json({
    serper,
    paypal: { configured: paypalConfigured, mode: paypalMode, ...checks },
  });
});

// Snapshots the live database via SQLite's online backup API rather than
// copying the file directly — the app runs in WAL mode, so a raw file copy
// while users are actively searching could grab it mid-write or miss
// committed-but-not-yet-checkpointed rows. db.backup() is safe under
// concurrent writes and always yields a consistent point-in-time copy.
// Meant for migrating to a new Railway project/volume, not routine backups.
router.get('/backup', requireOwner, async (req, res) => {
  const tmpPath = path.join(os.tmpdir(), `leadhunter-backup-${Date.now()}-${Math.round(Math.random() * 1e9)}.db`);
  try {
    await db.backup(tmpPath);
    const stamp = new Date().toISOString().slice(0, 10);
    res.download(tmpPath, `leadhunter-backup-${stamp}.db`, () => {
      fs.unlink(tmpPath, () => {}); // best-effort cleanup regardless of download outcome
    });
  } catch (e) {
    fs.unlink(tmpPath, () => {});
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
});

// One-click equivalent of scripts/paypal-setup.js, run server-side so the
// (possibly live) PAYPAL_CLIENT_SECRET never has to leave Railway to set up
// a fresh environment. IMPORTANT: this CREATES a new Product + Starter/Pro
// Plans + webhook subscription every time it's called — it does not look up
// or reuse existing ones. Re-running it against an environment that already
// has working Plan IDs just creates duplicates; it's meant for first-time
// setup or spinning up a new Railway project (e.g. flipping to PAYPAL_MODE=live).
router.post('/paypal-setup', requireOwner, async (req, res) => {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    return res.status(400).json({ error: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set in this environment.' });
  }

  try {
    const { productId, plans } = await paypal.createProductAndPlans();

    let webhookId = null;
    const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    if (baseUrl) {
      const webhook = await paypal.createWebhook(`${baseUrl}/api/billing/webhook`);
      webhookId = webhook.id;
    }

    res.json({
      success: true,
      mode: process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox',
      productId,
      planIdStarter: plans.starter,
      planIdPro: plans.pro,
      webhookId,
      webhookUrl: baseUrl ? `${baseUrl}/api/billing/webhook` : null,
      webhookSkippedReason: baseUrl ? null : 'APP_BASE_URL not set — register the webhook manually in the PayPal dashboard.',
    });
  } catch (e) {
    res.status(502).json({ error: 'PayPal setup failed: ' + e.message, detail: e.body || null });
  }
});

module.exports = router;
