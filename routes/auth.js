const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { q } = require('../db');
const { provisionGuest, isGuestEmail, isOwnerEmail } = require('../middleware/auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

function publicUser(user) {
  return { id: user.id, email: user.email, isGuest: isGuestEmail(user.email), isOwner: isOwnerEmail(user.email) };
}

// Called once on first page load when there's no session yet. Silently gives
// the visitor a free-tier account with no email/password required — this is
// what lets "5 free searches, no signup" actually work end to end. If a
// session already exists (guest or real), it's a no-op that just echoes it back.
router.post('/guest', (req, res) => {
  const existingId = req.session && req.session.userId;
  if (existingId) {
    const user = q.getUserById.get(existingId);
    if (user) return res.json({ success: true, user: publicUser(user), subscription: q.getSubscriptionByUserId.get(user.id) });
  }

  try {
    const user = provisionGuest(req);
    res.json({ success: true, user: publicUser(user), subscription: q.getSubscriptionByUserId.get(user.id) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to start a session.' });
  }
});

router.post('/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (q.getUserByEmail.get(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const id = uuid();
  // bcrypt.hash is the only await in this handler — a second request for the
  // SAME email can (and, under any real concurrency, eventually will) pass
  // the getUserByEmail check above before this one finishes hashing. Without
  // this try/catch, the second insertUser.run() throws a synchronous SQLite
  // UNIQUE-constraint error inside an async handler with nothing to catch
  // it — Node treats that as an unhandled rejection and crashes the entire
  // process, dropping every other connected user, not just these two requests.
  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    q.insertUser.run({ id, email, password_hash });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists.' });
    return res.status(500).json({ error: 'Could not create the account.' });
  }
  q.insertSubscription.run({ id: uuid(), user_id: id, tier: 'free', status: 'active' });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = id;
    res.json({ success: true, user: publicUser({ id, email }) });
  });
});

// Turns the CURRENT guest session into a real login — same user id, same
// subscription row, same search/lead history, just with an email+password
// attached now. This is the "Sign up to save your leads" path; it's different
// from /signup because /signup always creates a brand-new (empty) account.
router.post('/claim', async (req, res) => {
  const userId = req.session && req.session.userId;
  const currentUser = userId && q.getUserById.get(userId);
  if (!currentUser || !isGuestEmail(currentUser.email)) {
    return res.status(400).json({ error: 'No guest session to upgrade. Use signup instead.' });
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (q.getUserByEmail.get(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  // Same race as /signup (see its comment) — bcrypt.hash's await leaves a gap
  // for two claims/signups racing on the same email to both pass the check
  // above before either writes; catch it here instead of crashing the process.
  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    q.updateUserCredentials.run({ id: currentUser.id, email, password_hash });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that email already exists.' });
    return res.status(500).json({ error: 'Could not save the account.' });
  }
  res.json({ success: true, user: publicUser({ id: currentUser.id, email }) });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = q.getUserByEmail.get(email);
  const ok = user && await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = user.id;
    res.json({ success: true, user: publicUser(user) });
  });
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.json({ success: true });
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

router.get('/me', (req, res) => {
  const userId = req.session && req.session.userId;
  const user = userId && q.getUserById.get(userId);
  if (!user) return res.json({ user: null });
  const subscription = q.getSubscriptionByUserId.get(user.id);
  res.json({ user: publicUser(user), subscription });
});

module.exports = router;
