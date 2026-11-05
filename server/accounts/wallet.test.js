// Currency balances (docs/monetization.md MO-2).
// node --test server/accounts/
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dbModule = require('./db');
const wallet = require('./wallet');
const admin = require('./admin');

function setup() {
  const db = dbModule.open(':memory:');
  const ins = db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)');
  ins.run('a@b.co', 'x', 'A', 1);
  ins.run('c@d.co', 'x', 'C', 1);
  return db;
}

test('new accounts start at zero', () => {
  const db = setup();
  assert.deepStrictEqual(wallet.balances(db, 1), { bb: 0, marks: 0 });
  db.close();
});

test('grant and spend keep ledger and balance in step', () => {
  const db = setup();
  assert.deepStrictEqual(wallet.apply(db, 1, 'bb', 500, { source: 'paddle', ref: 'txn_1', reason: 'pack 5' }), { ok: true, balance: 500 });
  assert.deepStrictEqual(wallet.apply(db, 1, 'bb', -200, { source: 'store', reason: 'flag' }), { ok: true, balance: 300 });
  wallet.apply(db, 1, 'marks', 40, { source: 'match' });
  assert.deepStrictEqual(wallet.balances(db, 1), { bb: 300, marks: 40 });
  assert.deepStrictEqual(wallet.balances(db, 2), { bb: 0, marks: 0 });
  const h = wallet.history(db, 1);
  assert.strictEqual(h.length, 3);
  assert.strictEqual(h[0].currency, 'marks');           // newest first
  assert.strictEqual(h[2].ref, 'txn_1');
  assert.strictEqual(h[1].balanceAfter, 300);
  assert.ok(wallet.consistent(db, 1));
  db.close();
});

test('the same payment reference is applied once', () => {
  const db = setup();
  wallet.apply(db, 1, 'bb', 1050, { source: 'paddle', ref: 'txn_9' });
  const again = wallet.apply(db, 1, 'bb', 1050, { source: 'paddle', ref: 'txn_9' });
  assert.deepStrictEqual(again, { ok: true, duplicate: true, balance: 1050 });
  // Same ref from another source is a different event.
  assert.strictEqual(wallet.apply(db, 1, 'bb', 10, { source: 'admin', ref: 'txn_9' }).balance, 1060);
  assert.strictEqual(wallet.history(db, 1).length, 2);
  db.close();
});

test('spending more than the balance is refused unless allowed', () => {
  const db = setup();
  wallet.apply(db, 1, 'bb', 100, { source: 'admin' });
  assert.deepStrictEqual(wallet.apply(db, 1, 'bb', -101, { source: 'store' }), { ok: false, error: 'insufficient', balance: 100 });
  assert.strictEqual(wallet.history(db, 1).length, 1);
  // A refund of BB already spent may go negative.
  assert.strictEqual(wallet.apply(db, 1, 'bb', -500, { source: 'paddle', ref: 'refund_1', allowNegative: true }).balance, -400);
  assert.ok(wallet.consistent(db, 1));
  db.close();
});

test('bad input throws and changes nothing', () => {
  const db = setup();
  assert.throws(() => wallet.apply(db, 1, 'gold', 5, {}));
  assert.throws(() => wallet.apply(db, 1, 'bb', 0, {}));
  assert.throws(() => wallet.apply(db, 1, 'bb', 1.5, {}));
  assert.throws(() => wallet.apply(db, 1, 'bb', wallet.MAX_AMOUNT + 1, {}));
  assert.throws(() => wallet.apply(db, 99, 'bb', 5, {}));      // no such user (foreign key)
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
  // Still usable afterwards, including inside a caller's transaction.
  db.exec('BEGIN');
  wallet.apply(db, 1, 'bb', 5, {});
  db.exec('ROLLBACK');
  assert.deepStrictEqual(wallet.balances(db, 1), { bb: 0, marks: 0 });
  db.close();
});

test('deleting the account removes its wallet and ledger', () => {
  const db = setup();
  wallet.apply(db, 1, 'bb', 5, {});
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM wallets').get().n, 0);
  db.close();
});

test('admin: adjust, report, export', () => {
  const db = setup();
  assert.strictEqual(admin.adjustWallet(db, 'nobody@x.co', 'bb', 5, 'n'), null);
  assert.deepStrictEqual(admin.adjustWallet(db, 'A@b.co', 'bb', 700, 'gift'), { bb: 700, marks: 0 });
  assert.deepStrictEqual(admin.adjustWallet(db, 'a@b.co', 'bb', -900, 'chargeback'), { bb: -200, marks: 0 });
  assert.match(admin.walletReport(db, 'a@b.co'), /^Border Bucks: -200 {3}Marks: 0\n.*-900 bb {2}-> -200 {2}admin {2}"chargeback"/);
  const exp = admin.exportUser(db, 'a@b.co');
  assert.deepStrictEqual(exp.wallet, { bb: -200, marks: 0 });
  assert.strictEqual(exp.ledger.length, 2);
  assert.match(exp.ledger[0].createdAt, /^\d{4}-/);
  assert.deepStrictEqual(admin.listUsers(db).users.find((u) => u.id === 1).wallet, { bb: -200, marks: 0 });
  db.close();
});
