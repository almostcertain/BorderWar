// Applies a verified Paddle webhook event to the database (docs/monetization.md
// MO-6). Every grant is keyed by a Paddle id, so a retried or repeated event
// changes nothing. Returns a short outcome string for the log.
'use strict';

const ShopDefs = require('../../js/shop-defs.js');
const wallet = require('./wallet');
const subscriptions = require('./subscriptions');
const names = require('./names');

const DAY = 24 * 60 * 60 * 1000;

function time(iso, fallback) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : fallback;
}

// custom_data.user_id from our checkout, else the account already holding
// the subscription (renewals and portal changes).
function userFor(db, data) {
  const id = Number(data.custom_data && data.custom_data.user_id);
  if (Number.isSafeInteger(id) && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return id;
  const subId = data.subscription_id || (typeof data.id === 'string' && data.id.startsWith('sub_') ? data.id : null);
  return subscriptions.userForRef(db, 'paddle', subId);
}

function skuOf(item, catalog) {
  const price = item && item.price;
  if (!price) return null;
  const sku = catalog.skuFor(price.id) || (price.custom_data && price.custom_data.borderwar_sku);
  return ShopDefs.BB_PACKS[sku] || ShopDefs.tier(sku) ? sku : null;
}

function transactionCompleted(db, data, catalog, now, log) {
  const userId = userFor(db, data);
  if (userId === null) { log.warn('paddle', 'transaction ' + data.id + ' has no account; adjust by hand'); return 'no-user'; }
  const done = [];
  for (const item of data.items || []) {
    const sku = skuOf(item, catalog);
    if (!sku) continue;
    const pack = ShopDefs.BB_PACKS[sku];
    if (pack) {
      const qty = Math.max(1, Math.min(10, Number(item.quantity) || 1));
      const r = wallet.apply(db, userId, 'bb', pack.bb * qty, {
        source: 'paddle', ref: data.id + ':' + item.price.id, reason: '$' + pack.price + ' Border Bucks pack', now: () => now
      });
      done.push(sku + (r.duplicate ? ' (repeat)' : ''));
      continue;
    }
    // A subscription payment: first, renewal, or an upgrade's prorated charge.
    const def = ShopDefs.tier(sku);
    const period = data.billing_period || {};
    let bb;
    if (data.origin === 'subscription_update') {
      const sub = subscriptions.get(db, userId);
      const paid = sub && sub.status !== 'ended' ? ShopDefs.tier(sub.paid_tier) : null;
      bb = Math.max(0, def.monthlyBB - (paid ? paid.monthlyBB : 0));
    }
    const r = subscriptions.startPeriod(db, userId, sku, time(period.ends_at, now + 30 * DAY), {
      provider: 'paddle', ref: data.id, subscriptionRef: data.subscription_id || '', customer: data.customer_id || '', now, bb
    });
    const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
    names.reserve(db, userId, user.display_name, now);
    done.push(sku + (r.duplicate ? ' (repeat)' : ''));
  }
  return done.length ? 'user ' + userId + ': ' + done.join(', ') : 'nothing of ours';
}

function subscriptionChanged(db, data, catalog, now, log) {
  const userId = userFor(db, data);
  if (userId === null) { log.warn('paddle', 'subscription ' + data.id + ' has no account'); return 'no-user'; }
  if (data.status === 'canceled' || data.status === 'paused') {
    subscriptions.end(db, userId, time(data.canceled_at || data.paused_at, now));
    return 'user ' + userId + ': ended';
  }
  const sku = skuOf((data.items || [])[0], catalog);
  if (!ShopDefs.tier(sku)) return 'nothing of ours';
  const canceling = data.scheduled_change && data.scheduled_change.action === 'cancel';
  const period = data.current_billing_period || {};
  subscriptions.sync(db, userId, {
    tier: sku, status: canceling ? 'canceled' : 'active', periodEnd: time(period.ends_at, now),
    provider: 'paddle', subscriptionRef: data.id, customer: data.customer_id || '', now
  });
  return 'user ' + userId + ': ' + sku + (canceling ? ' (canceling)' : '');
}

// An approved full refund or chargeback takes back the BB that payment gave.
// A partial one is left for the owner (admin.js adjust), since how much BB it
// is worth is a judgement call.
function adjustment(db, data, now, log) {
  if (data.status !== 'approved' || (data.action !== 'refund' && data.action !== 'chargeback')) return 'ignored';
  const txn = String(data.transaction_id || '');
  if (!txn) return 'ignored';
  const rows = db.prepare("SELECT user_id, SUM(delta) AS bb FROM ledger WHERE source = 'paddle' AND currency = 'bb' AND delta > 0 "
    + "AND (ref = ? OR substr(ref, 1, ?) = ?) GROUP BY user_id").all('sub:' + txn, txn.length + 1, txn + ':');
  if (!rows.length) return 'nothing granted';
  const full = (data.items || []).length > 0 && data.items.every((i) => i.type === 'full');
  if (!full) {
    log.warn('paddle', 'partial ' + data.action + ' ' + data.id + ' on ' + txn + ' for user ' + rows[0].user_id + ': adjust BB by hand');
    return 'partial';
  }
  for (const r of rows) {
    wallet.apply(db, r.user_id, 'bb', -Number(r.bb), {
      source: 'paddle', ref: data.action + ':' + data.id, reason: data.action + ' of ' + txn, allowNegative: true, now: () => now
    });
  }
  return 'user ' + rows[0].user_id + ': took back ' + rows[0].bb + ' BB';
}

function apply(db, event, catalog, now, log) {
  log = log || { info() {}, warn() {}, error() {} };
  const data = event && event.data;
  if (!data || typeof event.event_type !== 'string') return 'malformed';
  switch (event.event_type) {
    case 'transaction.completed':
      return transactionCompleted(db, data, catalog, now, log);
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.activated':
    case 'subscription.resumed':
    case 'subscription.canceled':
    case 'subscription.paused':
      return subscriptionChanged(db, data, catalog, now, log);
    case 'adjustment.created':
    case 'adjustment.updated':
      return adjustment(db, data, now, log);
    default:
      return 'ignored';
  }
}

module.exports = { apply };
