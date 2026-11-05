// Verified names (docs/monetization.md §4.1). A subscriber reserves their
// display name; nobody else may play under anything that folds to the same
// string. The only code that reads or writes `reserved_names`.
'use strict';

const subscriptions = require('./subscriptions');

const GRACE_MS = 60 * 24 * 60 * 60 * 1000;     // kept after a subscription lapses
const RENAME_MS = 30 * 24 * 60 * 60 * 1000;    // between changes of a verified name

// Cyrillic and Greek letters that look like Latin ones, and digits/symbols
// commonly swapped for letters. Applied after lower-casing.
const LOOKALIKE = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
  'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'l', '|': 'l', 'i': 'l'
};

// "[TAG] name" -> "name": the clan tag is not part of the reserved name.
function stripTag(username) {
  return String(username || '').replace(/^\s*\[[A-Za-z0-9]{0,5}\]\s*/, '');
}

// Lower case, accents dropped, look-alikes mapped, everything that is not a
// letter or digit removed. "Ad4_Lovelace" and "ADA lovelace" fold the same.
function fold(name) {
  const s = stripTag(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let out = '';
  for (const ch of s) {
    const m = LOOKALIKE[ch] || ch;
    if (/[a-z0-9]/.test(m)) out += m;
  }
  // "rn" reads as "m" in many fonts.
  return out.replace(/rn/g, 'm');
}

function row(db, userId) {
  return db.prepare('SELECT * FROM reserved_names WHERE user_id = ?').get(userId) || null;
}

// A reservation holds while its owner is subscribed and for GRACE_MS after the
// subscription ends.
function holds(db, r, now) {
  const sub = subscriptions.get(db, r.user_id);
  return !!sub && sub.period_end + GRACE_MS > now;
}

// The user id holding the name, or null if it is free.
function ownerOf(db, name, now) {
  const f = fold(name);
  if (!f) return null;
  const r = db.prepare('SELECT * FROM reserved_names WHERE folded = ?').get(f);
  if (!r) return null;
  if (holds(db, r, now)) return r.user_id;
  db.prepare('DELETE FROM reserved_names WHERE user_id = ?').run(r.user_id);
  return null;
}

// The account's verified name while it is subscribed, else null.
function verifiedName(db, userId, now) {
  if (!subscriptions.activeTier(db, userId, now)) return null;
  const r = row(db, userId);
  return r ? r.display_name : null;
}

// Reserves `name` for a subscriber. Returns {ok: true} or {ok: false, error}
// with error 'not-subscribed', 'taken', 'too-soon' (with `until`) or 'invalid'.
// Re-reserving the same folded name (a change of case) is always allowed.
function reserve(db, userId, name, now) {
  if (!subscriptions.activeTier(db, userId, now)) return { ok: false, error: 'not-subscribed' };
  const display = stripTag(name).trim();
  const f = fold(display);
  if (!f) return { ok: false, error: 'invalid' };
  const owner = ownerOf(db, display, now);
  if (owner !== null && owner !== userId) return { ok: false, error: 'taken' };
  const mine = row(db, userId);
  if (mine && mine.folded === f) {
    db.prepare('UPDATE reserved_names SET display_name = ? WHERE user_id = ?').run(display, userId);
    return { ok: true };
  }
  if (mine && now - mine.reserved_at < RENAME_MS) return { ok: false, error: 'too-soon', until: mine.reserved_at + RENAME_MS };
  db.prepare('INSERT INTO reserved_names (user_id, folded, display_name, reserved_at) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(user_id) DO UPDATE SET folded = excluded.folded, display_name = excluded.display_name, reserved_at = excluded.reserved_at')
    .run(userId, f, display, now);
  return { ok: true };
}

// Owner override: frees a name at once (an abusive one). Returns whether one was held.
function release(db, name) {
  const f = fold(name);
  return !!f && Number(db.prepare('DELETE FROM reserved_names WHERE folded = ?').run(f).changes) > 0;
}

module.exports = { GRACE_MS, RENAME_MS, stripTag, fold, ownerOf, verifiedName, reserve, release };
