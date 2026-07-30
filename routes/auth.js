const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { q } = require('../db');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

function publicUser(user) {
  return { id: user.id, email: user.email };
}

router.post('/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (q.getUserByEmail.get(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const id = uuid();
  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  q.insertUser.run({ id, email, password_hash });
  q.insertSubscription.run({ id: uuid(), user_id: id, tier: 'free', status: 'active' });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = id;
    res.json({ success: true, user: publicUser({ id, email }) });
  });
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
