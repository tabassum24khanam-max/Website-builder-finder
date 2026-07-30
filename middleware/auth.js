const { q } = require('../db');

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

module.exports = { requireAuth };
