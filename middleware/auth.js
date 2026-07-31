const { q } = require('../db');
const { v4: uuid } = require('uuid');

// Every auto-created guest gets an unreachable @leadhunter.local address —
// this suffix is also how we recognize "this session is a guest, not a real
// login" elsewhere (isGuest(), the /claim upgrade route).
const GUEST_EMAIL_SUFFIX = '@leadhunter.local';
function isGuestEmail(email) {
  return typeof email === 'string' && email.endsWith(GUEST_EMAIL_SUFFIX);
}

// Creates a free-tier account with no email/password and logs the current
// session into it. Shared by optionalAuth (API routes) and POST /api/auth/guest
// (the frontend's silent first-visit call) so there's one place this happens.
function provisionGuest(req) {
  const guestId = uuid();
  const guestEmail = `guest-${guestId}${GUEST_EMAIL_SUFFIX}`;

  q.insertUser.run({ id: guestId, email: guestEmail, password_hash: '' });
  q.insertSubscription.run({
    id: uuid(),
    user_id: guestId,
    tier: 'free',
    status: 'active',
    period_start: new Date().toISOString(),
  });

  req.session.userId = guestId;
  return q.getUserById.get(guestId);
}

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

  try {
    req.user = provisionGuest(req);
    next();
  } catch (e) {
    res.status(500).json({ error: 'Failed to provision guest account.' });
  }
}

module.exports = { requireAuth, optionalAuth, provisionGuest, isGuestEmail };
