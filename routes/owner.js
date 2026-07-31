const express = require('express');
const { q } = require('../db');
const { requireOwner, isGuestEmail } = require('../middleware/auth');
const { TIERS } = require('../db/tiers');

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

module.exports = router;
