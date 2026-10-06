// In-memory rate limits for the account routes (AU-2, docs/accounts-auth.md
// §4). Lost on restart, which is fine: they slow down guessing, nothing more.
'use strict';

// At most `max` hits per `windowMs` for each key (an IP).
function window(max, windowMs, now) {
  now = now || Date.now;
  const hits = new Map();   // key -> { start, count }
  return {
    // Counts the hit and returns whether it is allowed.
    take(key) {
      const t = now();
      if (hits.size > 10000) {
        for (const [k, h] of hits) if (t - h.start >= windowMs) hits.delete(k);
      }
      let h = hits.get(key);
      if (!h || t - h.start >= windowMs) { h = { start: t, count: 0 }; hits.set(key, h); }
      h.count++;
      return h.count <= max;
    }
  };
}

// After `max` failures in a row for a key (an email), refuse for `lockMs`.
function lockout(max, lockMs, now) {
  now = now || Date.now;
  const fails = new Map();   // key -> { count, until }
  return {
    locked(key) {
      const f = fails.get(key);
      if (!f || !f.until) return false;
      if (now() < f.until) return true;
      fails.delete(key);
      return false;
    },
    fail(key) {
      if (fails.size > 10000) {
        const t = now();
        for (const [k, f] of fails) if (f.until && t >= f.until) fails.delete(k);
        if (fails.size > 10000) fails.clear();
      }
      const f = fails.get(key) || { count: 0, until: 0 };
      f.count++;
      if (f.count >= max) f.until = now() + lockMs;
      fails.set(key, f);
    },
    clear(key) { fails.delete(key); }
  };
}

module.exports = { window, lockout };
