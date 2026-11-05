// Subscriptions (docs/monetization.md §4). The only code that writes the
// `subscriptions` table. A payment webhook (MO-6) or the admin command line
// calls `startPeriod` once per paid period; it grants that period's Border Bucks.
'use strict';

const ShopDefs = require('../../js/shop-defs.js');
const wallet = require('./wallet');

// status: 'active' (renews), 'canceled' (runs to period_end, then stops),
// 'ended' (stopped early: refund or admin).
function get(db, userId) {
  return db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId) || null;
}

// The tier id while benefits apply, else null.
function activeTier(db, userId, now) {
  const s = get(db, userId);
  if (!s || s.status === 'ended' || s.period_end <= now || !ShopDefs.tier(s.tier)) return null;
  return s.tier;
}

// For /api/me: null when there has never been one.
function summary(db, userId, now) {
  const s = get(db, userId);
  if (!s) return null;
  return { tier: s.tier, status: s.status, periodEnd: Number(s.period_end), active: activeTier(db, userId, now) !== null };
}

// A paid period has started (a new subscription, a renewal or an upgrade).
// `ref` identifies the payment, so the same event twice grants BB once.
// opts: { provider, ref, now, bb } — `bb` overrides the tier's monthly amount
// (an upgrade's prorated difference). Returns the wallet.apply result.
function startPeriod(db, userId, tier, periodEnd, opts) {
  const def = ShopDefs.tier(tier);
  if (!def) throw new Error('unknown tier ' + tier);
  const t = opts.now;
  const provider = String(opts.provider || 'admin');
  db.exec('SAVEPOINT sub_start');
  try {
    db.prepare('INSERT INTO subscriptions (user_id, tier, status, period_end, provider, provider_ref, updated_at) '
      + "VALUES (?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, status = 'active', "
      + 'period_end = MAX(subscriptions.period_end, excluded.period_end), provider = excluded.provider, '
      + 'provider_ref = excluded.provider_ref, updated_at = excluded.updated_at')
      .run(userId, tier, periodEnd, provider, String(opts.ref || ''), t);
    const bb = opts.bb === undefined ? def.monthlyBB : opts.bb;
    const r = bb > 0
      ? wallet.apply(db, userId, 'bb', bb, { source: provider, ref: opts.ref ? 'sub:' + opts.ref : '', reason: def.name + ' subscription', now: () => t })
      : { ok: true };
    db.exec('RELEASE sub_start');
    return r;
  } catch (e) {
    db.exec('ROLLBACK TO sub_start');
    db.exec('RELEASE sub_start');
    throw e;
  }
}

// Stops renewing; benefits last until period_end.
function cancel(db, userId, now) {
  return Number(db.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE user_id = ? AND status = 'active'")
    .run(now, userId).changes) > 0;
}

// Stops now. The verified name's grace period counts from here.
function end(db, userId, now) {
  return Number(db.prepare("UPDATE subscriptions SET status = 'ended', period_end = MIN(period_end, ?), updated_at = ? WHERE user_id = ?")
    .run(now, now, userId).changes) > 0;
}

module.exports = { get, activeTier, summary, startPeriod, cancel, end };
