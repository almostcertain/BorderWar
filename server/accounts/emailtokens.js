// One-time links for email verification and password reset (docs/monetization.md
// MO-1). Like sessions, only the token's SHA-256 is stored. Each token is bound
// to the address it was mailed to, so changing the account's email kills it.
'use strict';

const crypto = require('crypto');

const TTL_MS = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 };

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function create(db, now) {
  now = now || Date.now;
  const insert = db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT user_id, purpose, email, expires_at FROM email_tokens WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM email_tokens WHERE token_hash = ?');
  const removeFor = db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?');
  const removeExpired = db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?');

  return {
    // A new token replaces any earlier one for the same purpose, so only the
    // latest link works. Returns the raw token for the link.
    issue(userId, purpose, email) {
      const token = crypto.randomBytes(32).toString('base64url');
      const t = now();
      removeFor.run(userId, purpose);
      insert.run(hash(token), userId, purpose, email, t, t + TTL_MS[purpose]);
      return token;
    },

    // Uses the token up. Returns {userId, email} or null if unknown, expired
    // or for another purpose.
    consume(token, purpose) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const h = hash(token);
      const row = select.get(h);
      if (!row || row.purpose !== purpose) return null;
      remove.run(h);
      if (row.expires_at <= now()) return null;
      return { userId: row.user_id, email: row.email };
    },

    clear(userId, purpose) { removeFor.run(userId, purpose); },
    prune() { removeExpired.run(now()); }
  };
}

module.exports = { create, TTL_MS };
