// Custom express-session store backed by the same better-sqlite3 connection
// the rest of the app already uses. Avoids pulling in connect-sqlite3's
// `sqlite3` (node-gyp/tar) dependency chain just to persist session cookies.

const session = require('express-session');
const { db } = require('./index');

const DAY_MS = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this._get = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
    this._upsert = db.prepare(`
      INSERT INTO sessions (sid, data, expires) VALUES (@sid, @data, @expires)
      ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
    `);
    this._destroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._prune = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this._pruneTimer = setInterval(() => {
      try { this._prune.run(Date.now()); } catch (_) {}
    }, 60 * 60 * 1000);
    this._pruneTimer.unref();
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) { this._destroy.run(sid); return cb(null, null); }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && typeof sessionData.cookie.maxAge === 'number'
        ? sessionData.cookie.maxAge : DAY_MS;
      this._upsert.run({ sid, data: JSON.stringify(sessionData), expires: Date.now() + maxAge });
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try { this._destroy.run(sid); cb(null); } catch (e) { cb(e); }
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}

module.exports = SqliteSessionStore;
