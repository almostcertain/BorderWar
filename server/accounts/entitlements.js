// What an account has been sold or given (docs/customization.md §4). The only
// place a pack is granted or checked: the admin command line calls this today,
// and a payment webhook would call `grant` with its own source and reference.
'use strict';

const ProgressDefs = require('../../js/progress-defs.js');

const known = (sku) => typeof sku === 'string' && Object.prototype.hasOwnProperty.call(ProgressDefs.PACKS, sku);

// The account's pack ids, in PACKS order. Retired ids are left out.
function list(db, userId) {
  const rows = db.prepare('SELECT sku FROM entitlements WHERE user_id = ?').all(userId);
  return ProgressDefs.entitlements(rows.map((r) => r.sku));
}

// Every row for one account, for the data export.
function history(db, userId) {
  return db.prepare('SELECT sku, granted_at, source, ref FROM entitlements WHERE user_id = ? ORDER BY granted_at').all(userId);
}

// Repeat-safe: a second grant of the same pack keeps the first row, so a
// retried webhook changes nothing. Returns false for an unknown pack.
function grant(db, userId, sku, source, ref, now) {
  if (!known(sku)) return false;
  db.prepare('INSERT OR IGNORE INTO entitlements (user_id, sku, granted_at, source, ref) VALUES (?, ?, ?, ?, ?)')
    .run(userId, sku, (now || Date.now)(), String(source || 'admin'), String(ref || ''));
  return true;
}

// Returns whether there was anything to take away.
function revoke(db, userId, sku) {
  return Number(db.prepare('DELETE FROM entitlements WHERE user_id = ? AND sku = ?').run(userId, sku).changes) > 0;
}

module.exports = { known, list, history, grant, revoke };
