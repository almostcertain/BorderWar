// Currency balances (docs/monetization.md §6, MO-2). The only code that changes
// a balance. Every change is a ledger row; `wallets` caches the sum.
'use strict';

const CURRENCIES = ['bb', 'marks'];
const MAX_AMOUNT = 1000000;

const known = (c) => CURRENCIES.includes(c);

function balances(db, userId) {
  const out = { bb: 0, marks: 0 };
  for (const r of db.prepare('SELECT currency, balance FROM wallets WHERE user_id = ?').all(userId)) {
    if (known(r.currency)) out[r.currency] = Number(r.balance);
  }
  return out;
}

// Adds `delta` (negative to take away) as one ledger row.
// opts: { reason, source, ref, now, allowNegative }
// - A non-empty (source, ref) is applied once only, so a retried payment
//   webhook changes nothing: the second call returns {ok: true, duplicate: true}.
// - A take-away that would go below zero is refused ({ok: false, error:
//   'insufficient'}) unless allowNegative (a refund of BB already spent).
// Uses a savepoint, so it can run inside a caller's transaction.
function apply(db, userId, currency, delta, opts) {
  opts = opts || {};
  if (!known(currency)) throw new Error('unknown currency ' + currency);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_AMOUNT) throw new Error('bad amount');
  const source = String(opts.source || 'admin').slice(0, 40);
  const ref = String(opts.ref || '').slice(0, 200);
  const reason = String(opts.reason || '').slice(0, 200);
  const t = (opts.now || Date.now)();

  db.exec('SAVEPOINT wallet_apply');
  try {
    if (ref && db.prepare('SELECT 1 FROM ledger WHERE source = ? AND ref = ?').get(source, ref)) {
      db.exec('RELEASE wallet_apply');
      return { ok: true, duplicate: true, balance: balances(db, userId)[currency] };
    }
    const before = balances(db, userId)[currency];
    const after = before + delta;
    if (after < 0 && delta < 0 && !opts.allowNegative) {
      db.exec('RELEASE wallet_apply');
      return { ok: false, error: 'insufficient', balance: before };
    }
    db.prepare('INSERT INTO ledger (user_id, currency, delta, balance_after, reason, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, currency, delta, after, reason, source, ref, t);
    db.prepare('INSERT INTO wallets (user_id, currency, balance) VALUES (?, ?, ?) '
      + 'ON CONFLICT(user_id, currency) DO UPDATE SET balance = excluded.balance').run(userId, currency, after);
    db.exec('RELEASE wallet_apply');
    return { ok: true, balance: after };
  } catch (e) {
    db.exec('ROLLBACK TO wallet_apply');
    db.exec('RELEASE wallet_apply');
    throw e;
  }
}

// Newest first.
function history(db, userId, limit) {
  return db.prepare('SELECT currency, delta, balance_after, reason, source, ref, created_at FROM ledger '
    + 'WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, Math.max(1, Math.min(1000, limit || 50)))
    .map((r) => ({
      currency: r.currency, delta: Number(r.delta), balanceAfter: Number(r.balance_after),
      reason: r.reason, source: r.source, ref: r.ref, createdAt: Number(r.created_at)
    }));
}

// True when the cached balances match the ledger sums. For tests and audits.
function consistent(db, userId) {
  const sums = { bb: 0, marks: 0 };
  for (const r of db.prepare('SELECT currency, SUM(delta) AS s FROM ledger WHERE user_id = ? GROUP BY currency').all(userId)) {
    sums[r.currency] = Number(r.s);
  }
  const b = balances(db, userId);
  return b.bb === sums.bb && b.marks === sums.marks;
}

module.exports = { CURRENCIES, MAX_AMOUNT, known, balances, apply, history, consistent };
