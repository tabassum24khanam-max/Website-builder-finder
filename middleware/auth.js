const { q } = require('../db');
const { v4: uuid } = require('uuid');

// Blocks the request unless a valid session is present. Looks the user up
// fresh on every request (not just trusting the session blob) so a deleted
// account is locked out immediately.
function requireAuth(req, res, next) {
  const userId = req.session && req.session.userId;
  if (!userId) return res.status(401).json({ error: 'Log in to continue.' });

  const user = q.getUserById.get(userId);
  if (!user) {
    return req.session.destroy(() => res.status(401).json({ error: 'Log in to continue.' }));
  }
  req.user = user;
  next();
}

// Auto-creates a guest free-tier account if no session exists. Otherwise like requireAuth.
// Guests can use free tier without email/password; later they can upgrade by adding creds.
function optionalAuth(req, res, next) {
  const userId = req.session && req.session.userId;

  if (userId) {
    // Existing session — validate it
    const user = q.getUserById.get(userId);
    if (!user) {
      return req.session.destroy(() => next()); // Fall through to guest creation
    }
    req.user = user;
    return next();
  }

  // No session — auto-create guest account
  const guestId = uuid();
  const guestEmail = `guest-${guestId}@leadhunter.local`;

  try {
    q.insertUser.run({ id: guestId, email: guestEmail, password_hash: '' });
    const subId = uuid();
    q.insertSubscription.run({
      id: subId,
      user_id: guestId,
      tier: 'free',
      status: 'active',
      period_start: new Date().toISOString(),
    });

    req.session.userId = guestId;
    const user = q.getUserById.get(guestId);
    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Failed to provision guest account.' });
  }
}

module.exports = { requireAuth, optionalAuth };
