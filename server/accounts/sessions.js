// Sessions (AU-2, docs/accounts-auth.md §4). The cookie holds 32 random bytes;
// the database holds only their SHA-256, so a leaked DB file can't be replayed
// as a login.
'use strict';

const crypto = require('crypto');

const COOKIE = 'bw_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Sliding expiry: an active session is pushed out again at most this often,
// so an ordinary request is a read and not a write.
const REFRESH_MS = 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookieHeader(token, secure, maxAgeMs) {
  return COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(maxAgeMs / 1000)
    + (secure ? '; Secure' : '');
}

function create(db, now) {
  now = now || Date.now;

  const insert = db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT user_id, last_seen_at, expires_at FROM sessions WHERE token_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    // Returns the raw token for the cookie; it is not recoverable afterwards.
    start(userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const t = now();
      insert.run(hashToken(token), userId, t, t, t + MAX_AGE_MS);
      return token;
    },

    // The user id for a token, or null if it is unknown or expired.
    userIdFor(token) {
      if (!token) return null;
      const h = hashToken(token);
      const row = select.get(h);
      if (!row) return null;
      const t = now();
      if (row.expires_at <= t) { remove.run(h); return null; }
      if (t - row.last_seen_at >= REFRESH_MS) touch.run(t, t + MAX_AGE_MS, h);
      return row.user_id;
    },

    userIdForRequest(req) { return this.userIdFor(readCookie(req)); },

    end(token) { if (token) remove.run(hashToken(token)); },
    endAll(userId) { removeUser.run(userId); },
    prune() { removeExpired.run(now()); }
  };
}

module.exports = { create, readCookie, cookieHeader, COOKIE, MAX_AGE_MS, REFRESH_MS };
