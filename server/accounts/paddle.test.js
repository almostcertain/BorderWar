// Paddle checkout, webhooks and the shop routes (docs/monetization.md MO-6).
// node --test server/accounts/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');

const dbModule = require('./db');
const paddleModule = require('./paddle');
const paddleEvents = require('./paddle-events');
const paddleSetup = require('./paddle-setup');
const subscriptions = require('./subscriptions');
const wallet = require('./wallet');
const names = require('./names');
const routes = require('./routes');

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1.8e12;
const FAST = { N: 1 << 10, r: 8, p: 1 };
const PASS = 'test-only-Pd73-pass';
const SECRET = 'test-webhook-secret';

// Every shop item has a price id "pri_<sku>".
const SKUS = ['bb_5', 'bb_10', 'bb_20', 'bb_50', 'bb_100', 'scout', 'warden', 'sovereign'];
const CATALOG = {
  skuFor: (id) => (typeof id === 'string' && SKUS.includes(id.slice(4)) ? id.slice(4) : null),
  priceFor: (sku) => (SKUS.includes(sku) ? 'pri_' + sku : null)
};

function setup() {
  const db = dbModule.open(':memory:');
  const ins = db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)');
  ins.run('a@b.co', 'x', 'Ada', 1);
  ins.run('c@d.co', 'x', 'Cy', 1);
  return db;
}

const iso = (t) => new Date(t).toISOString();
const item = (sku) => ({ price: { id: 'pri_' + sku }, quantity: 1 });
function txn(id, skus, extra) {
  return { event_type: 'transaction.completed', data: Object.assign({ id, status: 'completed', customer_id: 'ctm_1', items: skus.map(item) }, extra) };
}
function subTxn(id, sku, start, extra) {
  return txn(id, [sku], Object.assign({
    subscription_id: 'sub_1', origin: 'web', custom_data: { user_id: 1 },
    billing_period: { starts_at: iso(start), ends_at: iso(start + 30 * DAY) }
  }, extra));
}
function subEvent(type, sku, extra) {
  return { event_type: type, data: Object.assign({
    id: 'sub_1', status: 'active', customer_id: 'ctm_1', items: [item(sku)], scheduled_change: null,
    current_billing_period: { starts_at: iso(T0), ends_at: iso(T0 + 30 * DAY) }
  }, extra) };
}
const apply = (db, ev, t) => paddleEvents.apply(db, ev, CATALOG, t || T0);

function sign(raw, secret, ts) {
  return 'ts=' + ts + ';h1=' + crypto.createHmac('sha256', secret).update(ts + ':' + raw).digest('hex');
}

test('signature: valid, wrong secret, stale, tampered, rotated', () => {
  const raw = '{"a":1}';
  const ts = Math.floor(T0 / 1000);
  assert.strictEqual(paddleModule.verifySignature(Buffer.from(raw), sign(raw, SECRET, ts), SECRET, T0), true);
  assert.strictEqual(paddleModule.verifySignature(Buffer.from(raw), sign(raw, 'other', ts), SECRET, T0), false);
  assert.strictEqual(paddleModule.verifySignature(Buffer.from(raw), sign(raw, SECRET, ts - 600), SECRET, T0), false);
  assert.strictEqual(paddleModule.verifySignature(Buffer.from('{"a":2}'), sign(raw, SECRET, ts), SECRET, T0), false);
  const rotated = sign(raw, 'old', ts) + ';' + sign(raw, SECRET, ts).split(';')[1];
  assert.strictEqual(paddleModule.verifySignature(Buffer.from(raw), rotated, SECRET, T0), true);
  assert.strictEqual(paddleModule.verifySignature(Buffer.from(raw), undefined, SECRET, T0), false);
  assert.strictEqual(paddleModule.verifySignature(Buffer.from(raw), 'ts=1;h1=zz', SECRET, T0), false);
  assert.strictEqual(paddleModule.verifySignature(Buffer.from(raw), sign(raw, '', ts), '', T0), false);
});

test('catalog: reads tagged prices across pages, ignores others', async () => {
  const pages = {
    '/prices?status=active&per_page=200': { data: [
      { id: 'pri_a', custom_data: { borderwar_sku: 'bb_5' } },
      { id: 'pri_x', custom_data: null },
      { id: 'pri_y', custom_data: { borderwar_sku: 'nonsense' } }
    ], meta: { pagination: { has_more: true, next: 'https://sandbox-api.paddle.com/prices?after=pri_y' } } },
    '/prices?after=pri_y': { data: [{ id: 'pri_b', custom_data: { borderwar_sku: 'warden' } }], meta: { pagination: { has_more: false } } }
  };
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    const path = url.replace('https://sandbox-api.paddle.com', '');
    return { ok: true, status: 200, json: async () => pages[path] };
  };
  const p = paddleModule.create({ apiKey: 'k', clientToken: 't', webhookSecret: 's', fetch });
  assert.strictEqual(p.ready(), false);
  await p.loadCatalog();
  assert.strictEqual(p.priceFor('bb_5'), 'pri_a');
  assert.strictEqual(p.priceFor('warden'), 'pri_b');
  assert.strictEqual(p.skuFor('pri_b'), 'warden');
  assert.strictEqual(p.priceFor('scout'), null);
  assert.strictEqual(p.ready(), true);
  assert.deepStrictEqual(seen, ['Bearer k', 'Bearer k']);
  assert.strictEqual(paddleModule.create({ apiKey: 'k' }).configured, false);
});

test('pack purchase grants BB once', () => {
  const db = setup();
  const ev = txn('txn_1', ['bb_20'], { custom_data: { user_id: 2 } });
  assert.match(apply(db, ev), /user 2: bb_20/);
  assert.match(apply(db, ev), /repeat/);
  assert.strictEqual(wallet.balances(db, 2).bb, 2200);
  assert.strictEqual(apply(db, txn('txn_2', ['bb_5'], { custom_data: { user_id: 99 } })), 'no-user');
  assert.strictEqual(apply(db, txn('txn_3', [], { custom_data: { user_id: 2 } })), 'nothing of ours');
  db.close();
});

test('subscription: first payment, renewal by subscription id, verified name', () => {
  const db = setup();
  apply(db, subTxn('txn_1', 'scout', T0));
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + DAY), 'scout');
  assert.strictEqual(wallet.balances(db, 1).bb, 300);
  assert.strictEqual(names.verifiedName(db, 1, T0), 'Ada');
  const row = subscriptions.get(db, 1);
  assert.strictEqual(row.provider_ref, 'sub_1');
  assert.strictEqual(row.provider_customer, 'ctm_1');
  assert.strictEqual(subscriptions.summary(db, 1, T0).manageable, true);

  // Renewals carry no custom_data of ours; the subscription id finds the account.
  apply(db, subTxn('txn_2', 'scout', T0 + 30 * DAY, { custom_data: null, origin: 'subscription_recurring' }), T0 + 30 * DAY);
  assert.strictEqual(wallet.balances(db, 1).bb, 600);
  assert.strictEqual(subscriptions.get(db, 1).period_end, T0 + 60 * DAY);
  db.close();
});

test('upgrade grants the difference whichever event arrives first', () => {
  for (const updatedFirst of [true, false]) {
    const db = setup();
    apply(db, subTxn('txn_1', 'scout', T0));
    const updated = subEvent('subscription.updated', 'sovereign');
    const charge = subTxn('txn_2', 'sovereign', T0, { origin: 'subscription_update', custom_data: null });
    if (updatedFirst) { apply(db, updated, T0 + DAY); apply(db, charge, T0 + DAY); }
    else { apply(db, charge, T0 + DAY); apply(db, updated, T0 + DAY); }
    assert.strictEqual(subscriptions.activeTier(db, 1, T0 + DAY), 'sovereign');
    assert.strictEqual(wallet.balances(db, 1).bb, 1600, 'updatedFirst=' + updatedFirst);
    db.close();
  }
});

test('downgrade waits for the next paid period', () => {
  const db = setup();
  apply(db, subTxn('txn_1', 'sovereign', T0));
  apply(db, subEvent('subscription.updated', 'scout'), T0 + DAY);
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + DAY), 'sovereign');
  apply(db, subTxn('txn_2', 'scout', T0 + 30 * DAY, { custom_data: null, origin: 'subscription_recurring' }), T0 + 30 * DAY);
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + 31 * DAY), 'scout');
  assert.strictEqual(wallet.balances(db, 1).bb, 1900);
  db.close();
});

test('cancel scheduled, then canceled; unknown subscription', () => {
  const db = setup();
  apply(db, subTxn('txn_1', 'warden', T0));
  apply(db, subEvent('subscription.updated', 'warden', { scheduled_change: { action: 'cancel', effective_at: iso(T0 + 30 * DAY) } }), T0 + DAY);
  assert.strictEqual(subscriptions.summary(db, 1, T0 + DAY).status, 'canceled');
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + DAY), 'warden');
  apply(db, subEvent('subscription.canceled', 'warden', { status: 'canceled', canceled_at: iso(T0 + 30 * DAY) }), T0 + 30 * DAY);
  assert.strictEqual(subscriptions.summary(db, 1, T0 + 30 * DAY).status, 'ended');
  assert.strictEqual(apply(db, subEvent('subscription.updated', 'warden', { id: 'sub_other' })), 'no-user');
  db.close();
});

test('refunds: full takes the BB back once; partial is left to the owner', () => {
  const db = setup();
  apply(db, txn('txn_1', ['bb_50'], { custom_data: { user_id: 2 } }));
  wallet.apply(db, 2, 'bb', -5000, { source: 'store' });            // spent most of it
  const adj = (id, type, status) => ({ event_type: 'adjustment.updated', data: {
    id, action: 'refund', status, transaction_id: 'txn_1', items: [{ type }] } });
  assert.strictEqual(apply(db, adj('adj_0', 'full', 'pending_approval')), 'ignored');
  assert.strictEqual(apply(db, adj('adj_1', 'partial', 'approved')), 'partial');
  assert.strictEqual(wallet.balances(db, 2).bb, 750);
  assert.match(apply(db, adj('adj_2', 'full', 'approved')), /took back 5750/);
  apply(db, adj('adj_2', 'full', 'approved'));
  assert.strictEqual(wallet.balances(db, 2).bb, -5000);
  assert.ok(wallet.consistent(db, 2));
  // A subscription payment's BB goes too.
  apply(db, subTxn('txn_9', 'scout', T0));
  apply(db, { event_type: 'adjustment.created', data: { id: 'adj_3', action: 'chargeback', status: 'approved', transaction_id: 'txn_9', items: [{ type: 'full' }] } });
  assert.strictEqual(wallet.balances(db, 1).bb, 0);
  assert.strictEqual(apply(db, { event_type: 'payout.paid', data: {} }), 'ignored');
  assert.strictEqual(apply(db, {}), 'malformed');
  db.close();
});

test('setup script makes what is missing and skips what exists', async () => {
  const calls = [];
  let n = 0;
  const fake = {
    listPrices: async () => [{ id: 'pri_old', custom_data: { borderwar_sku: 'bb_5' } }],
    api: async (method, path, body) => { calls.push({ method, path, body }); return { data: { id: 'x_' + (n++) } }; }
  };
  const lines = [];
  assert.strictEqual(await paddleSetup.run(fake, (s) => lines.push(s)), 7);
  assert.ok(lines[0].includes('have   bb_5'));
  const prices = calls.filter((c) => c.path === '/prices').map((c) => c.body);
  const warden = prices.find((p) => p.custom_data.borderwar_sku === 'warden');
  assert.deepStrictEqual(warden.unit_price, { amount: '599', currency_code: 'USD' });
  assert.deepStrictEqual(warden.billing_cycle, { interval: 'month', frequency: 1 });
  const pack = prices.find((p) => p.custom_data.borderwar_sku === 'bb_100');
  assert.deepStrictEqual(pack.unit_price, { amount: '10000', currency_code: 'USD' });
  assert.strictEqual(pack.billing_cycle, undefined);
});

// --- HTTP ---------------------------------------------------------------------

async function startServer(opts) {
  let t = T0;
  const calls = [];
  const paddle = Object.assign(paddleModule.create({ apiKey: 'k', clientToken: 'test_tok', webhookSecret: SECRET, now: () => t }), CATALOG, {
    ready: () => true,
    portalUrl: async (c, s) => { calls.push(['portal', c, s]); return 'https://portal.example/x'; },
    changePrice: async (s, p, up) => { calls.push(['change', s, p, up]); return {}; }
  });
  const accounts = routes.create(Object.assign({ dbPath: ':memory:', scrypt: FAST, now: () => t, paddle }, opts));
  const server = http.createServer((req, res) => accounts.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  function browser() {
    let cookie = '';
    async function call(method, route, body) {
      const h = Object.assign({}, cookie ? { Cookie: cookie } : {},
        method === 'POST' ? { 'Content-Type': 'application/json', Origin: base } : {});
      const res = await fetch(base + '/api/' + route, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json() };
    }
    return { get: (r) => call('GET', r), post: (r, b) => call('POST', r, b || {}) };
  }
  async function hook(event, signature) {
    const raw = JSON.stringify(event);
    const res = await fetch(base + '/api/paddle/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signature || sign(raw, SECRET, Math.floor(t / 1000)) }, body: raw
    });
    return res.status;
  }
  return { accounts, browser, hook, calls, close: () => { server.close(); accounts.close(); } };
}

test('routes: shop, checkout, webhook, portal, change tier', async () => {
  const s = await startServer();
  assert.deepStrictEqual((await s.browser().get('shop')).body, { open: true, environment: 'sandbox', clientToken: 'test_tok',
    packs: ['bb_5', 'bb_10', 'bb_20', 'bb_50', 'bb_100'], tiers: ['scout', 'warden', 'sovereign'] });
  const a = s.browser();
  assert.strictEqual((await a.post('checkout', { sku: 'bb_5' })).status, 401);
  await a.post('register', { email: 'ada@example.com', password: PASS, displayName: 'Ada' });
  assert.deepStrictEqual((await a.post('checkout', { sku: 'warden' })).body,
    { priceId: 'pri_warden', customData: { user_id: 1 }, email: 'ada@example.com' });
  assert.strictEqual((await a.post('checkout', { sku: 'gold' })).body.error, 'invalid');

  assert.strictEqual(await s.hook(subTxn('txn_1', 'warden', T0), 'ts=1;h1=' + '0'.repeat(64)), 401);
  assert.strictEqual((await a.get('me')).body.user.wallet.bb, 0);
  assert.strictEqual(await s.hook(subTxn('txn_1', 'warden', T0)), 200);
  const me = (await a.get('me')).body.user;
  assert.strictEqual(me.wallet.bb, 700);
  assert.strictEqual(me.subscription.tier, 'warden');
  assert.strictEqual(me.verifiedName, 'Ada');
  assert.strictEqual((await a.post('checkout', { sku: 'scout' })).body.error, 'already-subscribed');

  assert.deepStrictEqual((await a.post('billing-portal')).body, { url: 'https://portal.example/x' });
  assert.deepStrictEqual((await a.post('change-tier', { tier: 'sovereign' })).body, { ok: true, upgrade: true });
  assert.deepStrictEqual((await a.post('change-tier', { tier: 'scout' })).body, { ok: true, upgrade: false });
  assert.deepStrictEqual(s.calls, [['portal', 'ctm_1', 'sub_1'], ['change', 'sub_1', 'pri_sovereign', true], ['change', 'sub_1', 'pri_scout', false]]);
  s.close();
});

test('routes: a sandbox shop is shown only to testers', async () => {
  const s = await startServer({ shopTesters: ['Tester@example.com'] });
  const a = s.browser();
  assert.deepStrictEqual((await a.get('shop')).body, { open: false });
  await a.post('register', { email: 'ada@example.com', password: PASS });
  assert.deepStrictEqual((await a.get('shop')).body, { open: false });
  assert.strictEqual((await a.post('checkout', { sku: 'bb_5' })).body.error, 'shop-closed');
  const t = s.browser();
  await t.post('register', { email: 'tester@example.com', password: PASS });
  assert.strictEqual((await t.get('shop')).body.open, true);
  s.close();

  const none = await startServer({ shopTesters: [] });
  const b = none.browser();
  await b.post('register', { email: 'ada@example.com', password: PASS });
  assert.deepStrictEqual((await b.get('shop')).body, { open: false });
  none.close();
});
