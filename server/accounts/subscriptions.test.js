// Subscriptions, verified names and public-lobby gating (docs/monetization.md MO-5).
// node --test server/accounts/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');

const dbModule = require('./db');
const subscriptions = require('./subscriptions');
const names = require('./names');
const wallet = require('./wallet');
const admin = require('./admin');
const routes = require('./routes');
const GameManager = require('../gamemanager');
const Protocol = require('../../js/net/protocol.js');

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1.8e12;
const FAST = { N: 1 << 10, r: 8, p: 1 };
const PASS = 'test-only-Sb52-pass';

function setup() {
  const db = dbModule.open(':memory:');
  const ins = db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)');
  ins.run('a@b.co', 'x', 'Ada', 1);
  ins.run('c@d.co', 'x', 'Cy', 1);
  return db;
}

test('fold: case, tags, accents, look-alikes and separators fold together', () => {
  const ada = names.fold('Ada Lovelace');
  for (const v of ['ADA_LOVELACE', '[XY] Ada Lovelace', 'Ádá Lövelace', 'Ad4 L0velace', 'Аda Lovelace', 'Ada|ovelace', 'adalovelace']) {
    assert.strictEqual(names.fold(v), ada, v);
  }
  assert.strictEqual(names.fold('Iron'), names.fold('lron'));
  assert.strictEqual(names.fold('Warn'), names.fold('Wam'));
  assert.notStrictEqual(names.fold('Ada'), names.fold('Adam'));
  assert.strictEqual(names.fold('[AB] ___'), '');
});

test('startPeriod grants the tier BB once per payment and sets the tier', () => {
  const db = setup();
  assert.strictEqual(subscriptions.activeTier(db, 1, T0), null);
  subscriptions.startPeriod(db, 1, 'warden', T0 + 30 * DAY, { provider: 'paddle', ref: 'txn_1', now: T0 });
  subscriptions.startPeriod(db, 1, 'warden', T0 + 30 * DAY, { provider: 'paddle', ref: 'txn_1', now: T0 });
  assert.strictEqual(wallet.balances(db, 1).bb, 700);
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + DAY), 'warden');
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + 30 * DAY), null);   // lapsed
  // Renewal: next period, next payment.
  subscriptions.startPeriod(db, 1, 'warden', T0 + 60 * DAY, { provider: 'paddle', ref: 'txn_2', now: T0 + 30 * DAY });
  assert.strictEqual(wallet.balances(db, 1).bb, 1400);
  assert.throws(() => subscriptions.startPeriod(db, 1, 'emperor', T0, { now: T0 }));
  db.close();
});

test('cancel runs to the end of the period; end stops now', () => {
  const db = setup();
  subscriptions.startPeriod(db, 1, 'scout', T0 + 30 * DAY, { now: T0 });
  subscriptions.cancel(db, 1, T0 + DAY);
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + 2 * DAY), 'scout');
  assert.strictEqual(subscriptions.summary(db, 1, T0 + 2 * DAY).status, 'canceled');
  subscriptions.end(db, 1, T0 + 3 * DAY);
  assert.strictEqual(subscriptions.activeTier(db, 1, T0 + 3 * DAY), null);
  assert.deepStrictEqual(subscriptions.summary(db, 1, T0 + 3 * DAY), { tier: 'scout', status: 'ended', periodEnd: T0 + 3 * DAY, active: false, manageable: false });
  db.close();
});

test('names: reserve needs a subscription, blocks others, held 60 days after lapse', () => {
  const db = setup();
  assert.deepStrictEqual(names.reserve(db, 1, 'Ada', T0), { ok: false, error: 'not-subscribed' });
  subscriptions.startPeriod(db, 1, 'scout', T0 + 30 * DAY, { now: T0 });
  assert.deepStrictEqual(names.reserve(db, 1, '[XY] Ada', T0), { ok: true });
  assert.strictEqual(names.verifiedName(db, 1, T0), 'Ada');
  assert.strictEqual(names.ownerOf(db, 'ADA', T0), 1);
  assert.strictEqual(names.ownerOf(db, 'Bob', T0), null);

  subscriptions.startPeriod(db, 2, 'scout', T0 + 30 * DAY, { now: T0 });
  assert.deepStrictEqual(names.reserve(db, 2, 'ada', T0), { ok: false, error: 'taken' });

  // Lapsed: no badge, but nobody else can take it inside the grace period.
  const lapse = T0 + 30 * DAY;
  assert.strictEqual(names.verifiedName(db, 1, lapse + DAY), null);
  assert.strictEqual(names.ownerOf(db, 'Ada', lapse + 59 * DAY), 1);
  assert.strictEqual(names.ownerOf(db, 'Ada', lapse + 61 * DAY), null);
  db.close();
});

test('names: renaming waits 30 days, but a change of case does not', () => {
  const db = setup();
  subscriptions.startPeriod(db, 1, 'scout', T0 + 90 * DAY, { now: T0 });
  names.reserve(db, 1, 'Ada', T0);
  assert.deepStrictEqual(names.reserve(db, 1, 'ADA', T0 + DAY), { ok: true });
  assert.strictEqual(names.verifiedName(db, 1, T0 + DAY), 'ADA');
  const r = names.reserve(db, 1, 'Grace', T0 + DAY);
  assert.strictEqual(r.error, 'too-soon');
  assert.strictEqual(r.until, T0 + 30 * DAY);
  assert.deepStrictEqual(names.reserve(db, 1, 'Grace', T0 + 31 * DAY), { ok: true });
  assert.strictEqual(names.ownerOf(db, 'Ada', T0 + 31 * DAY), null);   // the old one is free again
  assert.strictEqual(names.release(db, 'grace'), true);
  assert.strictEqual(names.ownerOf(db, 'Grace', T0 + 31 * DAY), null);
  db.close();
});

test('admin subscribe and unsubscribe', () => {
  const db = setup();
  assert.strictEqual(admin.subscribe(db, 'nobody@x.co', 'scout', 30), null);
  const out = admin.subscribe(db, 'a@b.co', 'sovereign', 30, () => T0);
  assert.match(out, /^Sovereign until .* Border Bucks: 1600\. Verified name: Ada$/);
  // Extending stacks onto the current end.
  admin.subscribe(db, 'a@b.co', 'sovereign', 30, () => T0 + DAY);
  assert.strictEqual(subscriptions.get(db, 1).period_end, T0 + 60 * DAY);
  assert.strictEqual(wallet.balances(db, 1).bb, 3200);
  assert.match(admin.unsubscribe(db, 'a@b.co', () => T0 + 2 * DAY), /60 days/);
  assert.strictEqual(admin.exportUser(db, 'a@b.co', () => T0 + 2 * DAY).subscription.status, 'ended');
  db.close();
});

// --- HTTP ---------------------------------------------------------------------

async function startServer() {
  let t = T0;
  const accounts = routes.create({ dbPath: ':memory:', scrypt: FAST, now: () => t });
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
    return { get: (r) => call('GET', r), post: (r, b) => call('POST', r, b || {}), cookie: () => cookie };
  }
  return { accounts, browser, advance(ms) { t += ms; }, close: () => { server.close(); accounts.close(); } };
}

test('routes: /api/me shows the subscription; reserved names are refused to others', async () => {
  const s = await startServer();
  const a = s.browser();
  await a.post('register', { email: 'ada@example.com', password: PASS, displayName: 'Ada' });
  let me = (await a.get('me')).body.user;
  assert.strictEqual(me.subscription, null);
  assert.strictEqual(me.verifiedName, null);

  admin.subscribe(s.accounts.db, 'ada@example.com', 'warden', 30, () => T0);
  me = (await a.get('me')).body.user;
  assert.deepStrictEqual(me.subscription, { tier: 'warden', status: 'active', periodEnd: T0 + 30 * DAY, active: true, manageable: false });
  assert.strictEqual(me.verifiedName, 'Ada');
  assert.strictEqual(me.wallet.bb, 700);

  const b = s.browser();
  assert.strictEqual((await b.post('register', { email: 'bob@example.com', password: PASS, displayName: 'ADA' })).body.error, 'name-taken');
  await b.post('register', { email: 'bob@example.com', password: PASS, displayName: 'Bob' });
  assert.strictEqual((await b.post('profile', { displayName: 'Ad4' })).body.error, 'name-taken');

  // The subscriber's own rename is reserved, subject to the 30 days.
  const soon = await a.post('profile', { displayName: 'Lovelace' });
  assert.strictEqual(soon.body.error, 'name-too-soon');
  s.advance(16 * DAY); await a.get('me'); await b.get('me');   // keep the sessions alive
  s.advance(15 * DAY);
  admin.subscribe(s.accounts.db, 'ada@example.com', 'warden', 30, () => T0 + 31 * DAY);
  assert.strictEqual((await a.post('profile', { displayName: 'Lovelace' })).status, 200);
  assert.strictEqual((await a.get('me')).body.user.verifiedName, 'Lovelace');
  assert.strictEqual((await b.post('profile', { displayName: 'Ada' })).status, 200);   // freed

  const id = s.accounts.identityForRequest({ headers: { cookie: a.cookie() } });
  assert.deepStrictEqual(id, { userId: 1, packs: [], tier: 'warden', verifiedName: 'Lovelace' });
  assert.strictEqual(s.accounts.identityForRequest({ headers: {} }), null);
  s.close();
});

// --- Lobby --------------------------------------------------------------------

function fakeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.raw = [];
  ws.send = (m) => ws.raw.push(m);
  ws.close = () => { ws.readyState = 3; };
  ws.of = (type) => ws.raw.map((m) => JSON.parse(m)).filter((m) => m.type === type);
  ws.last = (type) => ws.of(type).pop();
  return ws;
}

function lobbySetup(owners) {
  const manager = new GameManager({ names: { ownerOf: (n) => owners[names.fold(n)] || null } });
  let pid = 0;
  function join(gameID, username, identity, isPublic) {
    const ws = fakeSocket();
    manager.handleConnection(ws, undefined, [], identity || null);
    ws.emit('message', JSON.stringify(Protocol.msg.join(gameID, username, 'pid-test-' + (pid++), false, isPublic)));
    return ws;
  }
  function close() {
    for (const game of manager.games.values()) game.end('test over');
    clearInterval(manager._reapIntervalID);
  }
  return { manager, join, close };
}

const ADA = { userId: 1, tier: 'scout', verifiedName: 'Ada', packs: [] };

test('lobby: a reserved name is refused to anyone but its owner, whose entry is verified', () => {
  const s = lobbySetup({ ada: 1 });
  const imposter = s.join('G1', '[XY] ADA', null);
  assert.strictEqual(imposter.last('error').error, 'name-taken');
  const otherAccount = s.join('G1', 'Ada', { userId: 2, tier: 'scout', verifiedName: 'Bob', packs: [] });
  assert.strictEqual(otherAccount.last('error').error, 'name-taken');

  const a = s.join('G1', '[XY] Ada', ADA);
  const b = s.join('G1', 'Bob', null);
  const players = b.last('lobby_info').lobby.players;
  assert.strictEqual(players[0].verified, 'scout');
  assert.strictEqual('verified' in players[1], false);
  s.manager.getGame('G1').start({ seed: 1 });
  assert.strictEqual(a.last('start').gameStartInfo.players[0].verified, 'scout');

  // Owner playing under another name: allowed, but no badge.
  const s2 = lobbySetup({ ada: 1 });
  const c = s2.join('G2', 'Someone', ADA);
  assert.strictEqual('verified' in c.last('lobby_info').lobby.players[0], false);
  s.close();
  s2.close();
});

test('lobby: public needs a subscription and respects the tier limit', () => {
  const s = lobbySetup({});
  assert.strictEqual(s.join('P1', 'Guest', null, true).last('error').error, 'subscription-required');
  assert.strictEqual(s.join('P2', 'Free', { userId: 5, tier: null, verifiedName: null, packs: [] }, true).last('error').error, 'subscription-required');
  assert.strictEqual(s.join('P3', 'Guest', null, false).last('error'), undefined);   // private is fine

  const scout = { userId: 1, tier: 'scout', verifiedName: null, packs: [] };
  assert.strictEqual(s.join('P4', 'Ada', scout, true).last('error'), undefined);
  assert.strictEqual(s.manager.getGame('P4').isPublic, true);
  assert.strictEqual(s.join('P5', 'Ada', scout, true).last('error').error, 'public-limit');
  // Joining someone else's public lobby needs nothing.
  assert.strictEqual(s.join('P4', 'Guest', null, true).last('error'), undefined);

  const warden = { userId: 2, tier: 'warden', verifiedName: null, packs: [] };
  assert.strictEqual(s.join('W1', 'Cy', warden, true).last('error'), undefined);
  assert.strictEqual(s.join('W2', 'Cy', warden, true).last('error'), undefined);
  assert.strictEqual(s.join('W3', 'Cy', warden, true).last('error').error, 'public-limit');
  s.close();

  // Without accounts (no `names`), nothing is gated, as before.
  const open = new GameManager({});
  const ws = fakeSocket();
  open.handleConnection(ws, undefined);
  ws.emit('message', JSON.stringify(Protocol.msg.join('O1', 'Ada', 'pid-test-x', false, true)));
  assert.strictEqual(open.getGame('O1').isPublic, true);
  for (const game of open.games.values()) game.end('test over');
  clearInterval(open._reapIntervalID);
});
