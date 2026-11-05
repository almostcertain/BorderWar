// Subscriptions (docs/monetization.md §4). The only code that writes the
// `subscriptions` table. A payment webhook (paddle-events.js) or the admin
// command line calls `startPeriod` once per paid period; it grants that
// period's Border Bucks.
'use strict';

const ShopDefs = require('../../js/shop-defs.js');
const wallet = require('./wallet');

// status: 'active' (renews), 'canceled' (runs to period_end, then stops),
// 'ended' (stopped early: refund, provider cancel or admin).
function get(db, userId) {
  return db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId) || null;
}

// The account holding a provider's subscription id, or null.
function userForRef(db, provider, ref) {
  if (!ref) return null;
  const r = db.prepare('SELECT user_id FROM subscriptions WHERE provider = ? AND provider_ref = ?').get(provider, ref);
  return r ? r.user_id : null;
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
  return {
    tier: s.tier, status: s.status, periodEnd: Number(s.period_end), active: activeTier(db, userId, now) !== null,
    manageable: s.provider !== 'admin' && !!s.provider_customer
  };
}

function upsert(db, userId, f) {
  db.prepare('INSERT INTO subscriptions (user_id, tier, status, period_end, provider, provider_ref, provider_customer, paid_tier, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, status = excluded.status, '
    + 'period_end = MAX(subscriptions.period_end, excluded.period_end), provider = excluded.provider, '
    + "provider_ref = CASE WHEN excluded.provider_ref <> '' THEN excluded.provider_ref ELSE subscriptions.provider_ref END, "
    + "provider_customer = CASE WHEN excluded.provider_customer <> '' THEN excluded.provider_customer ELSE subscriptions.provider_customer END, "
    + "paid_tier = CASE WHEN excluded.paid_tier <> '' THEN excluded.paid_tier ELSE subscriptions.paid_tier END, "
    + 'updated_at = excluded.updated_at')
    .run(userId, f.tier, f.status, f.periodEnd, f.provider, f.subscriptionRef || '', f.customer || '', f.paidTier || '', f.now);
}

// A paid period has started (a new subscription, a renewal or an upgrade).
// `ref` identifies the payment, so the same event twice grants BB once.
// opts: { provider, ref, subscriptionRef, customer, now, bb } — `bb` overrides
// the tier's monthly amount (an upgrade's difference). Returns wallet.apply's result.
function startPeriod(db, userId, tier, periodEnd, opts) {
  const def = ShopDefs.tier(tier);
  if (!def) throw new Error('unknown tier ' + tier);
  const t = opts.now;
  const provider = String(opts.provider || 'admin');
  db.exec('SAVEPOINT sub_start');
  try {
    upsert(db, userId, { tier, status: 'active', periodEnd, provider, subscriptionRef: opts.subscriptionRef, customer: opts.customer, paidTier: tier, now: t });
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

// The provider reports the subscription's state (no payment, so no BB).
// A higher tier applies at once; a lower one waits for the next paid period,
// since this one was paid at the higher rate.
// f: { tier, status: 'active'|'canceled', periodEnd, provider, subscriptionRef, customer, now }
function sync(db, userId, f) {
  if (!ShopDefs.tier(f.tier)) throw new Error('unknown tier ' + f.tier);
  const cur = activeTier(db, userId, f.now);
  const tier = cur && ShopDefs.tier(cur).rank > ShopDefs.tier(f.tier).rank ? cur : f.tier;
  upsert(db, userId, Object.assign({}, f, { tier, paidTier: '' }));
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

module.exports = { get, userForRef, activeTier, summary, startPeriod, sync, cancel, end };
