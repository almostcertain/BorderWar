// node --test server/accounts/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const dbModule = require('./db');
const passwords = require('./passwords');
const sessionsModule = require('./sessions');
const ratelimit = require('./ratelimit');
const validate = require('./validate');
const routes = require('./routes');

// Cheap scrypt so the suite runs in a blink; the real parameters get one test.
const FAST = { N: 1 << 10, r: 8, p: 1 };
// Throwaway test values, used nowhere else.
const PASS = 'test-only-Xk29-pass';
const PASS2 = 'test-only-Qm47-pass';

test('validate: email', () => {
  assert.strictEqual(validate.email('  Foo@Example.COM '), 'foo@example.com');
  assert.strictEqual(validate.email('nope'), null);
  assert.strictEqual(validate.email('a@b'), null);
  assert.strictEqual(validate.email('a b@c.d'), null);
  assert.strictEqual(validate.email('a'.repeat(250) + '@b.co'), null);
  assert.strictEqual(validate.email(42), null);
});

test('validate: display name, tag, password, settings', () => {
  assert.strictEqual(validate.displayName('  Ada '), 'Ada');
  assert.strictEqual(validate.displayName(''), null);
  assert.strictEqual(validate.displayName('x'.repeat(21)), null);
  assert.strictEqual(validate.displayName('[ABC] Ada'), null);
  assert.strictEqual(validate.displayName('a\u0007b'), null);
  assert.strictEqual(validate.tag('abc'), 'ABC');
  assert.strictEqual(validate.tag(''), '');
  assert.strictEqual(validate.tag('toolong'), null);
  assert.strictEqual(validate.tag('a-b'), null);
  assert.strictEqual(validate.password('short'), null);
  assert.strictEqual(validate.password('Password123'), null);
  assert.strictEqual(validate.password(PASS), PASS);
  assert.strictEqual(validate.password('x'.repeat(129)), null);
  assert.strictEqual(validate.settings({ a: 1 }), '{"a":1}');
  assert.strictEqual(validate.settings([1]), null);
  assert.strictEqual(validate.settings({ a: 'x'.repeat(3000) }), null);
});

test('passwords: hash, verify, rehash on old parameters', async () => {
  const h = await passwords.hash(PASS, FAST);
  assert.match(h, /^scrypt\$1024\$8\$1\$/);
  assert.strictEqual(await passwords.verify(PASS, h), true);
  assert.strictEqual(await passwords.verify(PASS2, h), false);
  assert.strictEqual(await passwords.verify(PASS, 'garbage'), false);
  assert.notStrictEqual(h, await passwords.hash(PASS, FAST));   // fresh salt each time
  assert.strictEqual(passwords.needsRehash(h, FAST), false);
  assert.strictEqual(passwords.needsRehash(h, passwords.DEFAULT_PARAMS), true);
});

test('passwords: production parameters work', async () => {
  const h = await passwords.hash(PASS);
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.strictEqual(await passwords.verify(PASS, h), true);
});

test('db: schema is created once and email is unique', () => {
  const db = dbModule.open(':memory:');
  assert.strictEqual(dbModule.schemaVersion(db), dbModule.LATEST_VERSION);
  const ins = db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)');
  ins.run('a@b.co', 'x', 'A', 1);
  assert.throws(() => ins.run('a@b.co', 'x', 'B', 2));
  db.close();
});

test('sessions: start, lookup, sliding expiry, end', () => {
  const db = dbModule.open(':memory:');
  db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)').run('a@b.co', 'x', 'A', 1);
  let t = 1000;
  const s = sessionsModule.create(db, () => t);
  const token = s.start(1);
  assert.strictEqual(s.userIdFor(token), 1);
  assert.strictEqual(s.userIdFor('wrong'), null);
  assert.strictEqual(s.userIdFor(null), null);
  // The raw token is not what is stored.
  assert.strictEqual(db.prepare('SELECT count(*) n FROM sessions WHERE token_hash = ?').get(token).n, 0);

  // Used again after the refresh interval: expiry slides forward.
  t += sessionsModule.REFRESH_MS + 1;
  assert.strictEqual(s.userIdFor(token), 1);
  t += sessionsModule.MAX_AGE_MS - 10;
  assert.strictEqual(s.userIdFor(token), 1);
  // Left idle past the max age: gone.
  t += sessionsModule.MAX_AGE_MS + 1;
  assert.strictEqual(s.userIdFor(token), null);

  const a = s.start(1), b = s.start(1);
  s.end(a);
  assert.strictEqual(s.userIdFor(a), null);
  assert.strictEqual(s.userIdFor(b), 1);
  s.endAll(1);
  assert.strictEqual(s.userIdFor(b), null);
  db.close();
});

test('ratelimit: window and lockout', () => {
  let t = 0;
  const w = ratelimit.window(2, 1000, () => t);
  assert.strictEqual(w.take('ip'), true);
  assert.strictEqual(w.take('ip'), true);
  assert.strictEqual(w.take('ip'), false);
  assert.strictEqual(w.take('other'), true);
  t = 1000;
  assert.strictEqual(w.take('ip'), true);

  const l = ratelimit.lockout(2, 500, () => t);
  l.fail('e');
  assert.strictEqual(l.locked('e'), false);
  l.fail('e');
  assert.strictEqual(l.locked('e'), true);
  t += 500;
  assert.strictEqual(l.locked('e'), false);
  l.fail('e'); l.clear('e'); l.fail('e');
  assert.strictEqual(l.locked('e'), false);
});

// --- HTTP ---------------------------------------------------------------------

async function startServer(opts) {
  const accounts = routes.create(Object.assign({ dbPath: ':memory:', scrypt: FAST }, opts));
  const server = http.createServer((req, res) => accounts.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // One browser: remembers the session cookie between calls.
  function browser() {
    let cookie = '';
    async function call(method, route, body, headers) {
      const h = Object.assign({}, cookie ? { Cookie: cookie } : {},
        method === 'POST' ? { 'Content-Type': 'application/json', Origin: base } : {}, headers);
      for (const k in h) if (h[k] === null) delete h[k];
      const res = await fetch(base + '/api/' + route, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json(), setCookie: set };
    }
    return { get: (r) => call('GET', r), post: (r, b, h) => call('POST', r, b || {}, h) };
  }

  return { accounts, browser, base, close: () => { server.close(); accounts.close(); } };
}

test('routes: register, me, logout, login', async () => {
  const s = await startServer();
  const b = s.browser();
  assert.deepStrictEqual((await b.get('me')).body, { user: null });

  const reg = await b.post('register', { email: ' Ada@Example.com', password: PASS, displayName: 'Ada', tag: 'abc' });
  assert.strictEqual(reg.status, 200);
  assert.strictEqual(reg.body.user.email, 'ada@example.com');
  assert.strictEqual(reg.body.user.displayName, 'Ada');
  assert.strictEqual(reg.body.user.tag, 'ABC');
  assert.match(reg.setCookie, /^bw_session=[\w-]{43}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  assert.strictEqual(reg.body.user.pass_hash, undefined);
  assert.strictEqual((await b.get('me')).body.user.email, 'ada@example.com');

  assert.strictEqual((await b.post('logout')).status, 200);
  assert.deepStrictEqual((await b.get('me')).body, { user: null });

  const bad = await b.post('login', { email: 'ada@example.com', password: PASS2 });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.body.error, 'bad-credentials');
  const unknown = await b.post('login', { email: 'nobody@example.com', password: PASS });
  assert.deepStrictEqual(unknown.body, bad.body);   // never says which field was wrong

  const ok = await b.post('login', { email: 'ADA@example.com', password: PASS });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await b.get('me')).body.user.displayName, 'Ada');
  s.close();
});

test('routes: register rejects bad input and taken emails', async () => {
  const s = await startServer();
  const b = s.browser();
  assert.strictEqual((await b.post('register', { email: 'nope', password: PASS })).body.error, 'invalid');
  assert.strictEqual((await b.post('register', { email: 'a@b.co', password: 'short' })).body.error, 'invalid');
  // Three sign-ups an hour per address: the two failures above used two.
  assert.strictEqual((await b.post('register', { email: 'a@b.co', password: PASS })).status, 200);
  assert.strictEqual((await b.post('register', { email: 'c@d.co', password: PASS })).body.error, 'rate-limited');
  s.close();

  const s2 = await startServer();
  const b2 = s2.browser();
  await b2.post('register', { email: 'a@b.co', password: PASS });
  const dup = await s2.browser().post('register', { email: 'A@b.co', password: PASS2 });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.body.error, 'email-taken');
  assert.strictEqual((await s2.browser().post('register', { email: 'e@f.co', password: 'Password123' })).body.error, 'invalid');
  s2.close();
});

test('routes: cross-site and non-JSON posts are refused', async () => {
  const s = await startServer();
  const b = s.browser();
  const body = { email: 'a@b.co', password: PASS };
  assert.strictEqual((await b.post('register', body, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await b.post('register', body, { Origin: null })).status, 403);
  assert.strictEqual((await b.post('register', body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await b.post('register', { email: 'a@b.co', password: PASS, pad: 'x'.repeat(5000) })).status, 413);
  assert.strictEqual((await b.get('nothing')).status, 404);
  assert.strictEqual(s.accounts.db.prepare('SELECT count(*) n FROM users').get().n, 0);
  s.close();
});

test('routes: Secure cookie on an https origin', async () => {
  const s = await startServer();
  // What a request through the tunnel looks like: https Origin, same Host.
  const host = s.base.slice('http://'.length);
  const res = await fetch(s.base + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://' + host },
    body: JSON.stringify({ email: 'a@b.co', password: PASS })
  });
  assert.match(res.headers.get('set-cookie'), /; Secure$/);
  s.close();
});

test('routes: login rate limit and per-email lockout', async () => {
  let t = 1e12;
  const s = await startServer({ now: () => t });
  const b = s.browser();
  await b.post('register', { email: 'a@b.co', password: PASS });
  await b.post('logout');
  for (let i = 0; i < 10; i++) {
    assert.strictEqual((await b.post('login', { email: 'a@b.co', password: PASS2 })).status, 401);
  }
  // 11th in the same minute: the per-address limit.
  assert.strictEqual((await b.post('login', { email: 'a@b.co', password: PASS })).status, 429);
  // A minute later the address is clear but the email is still locked.
  t += 61 * 1000;
  const locked = await b.post('login', { email: 'a@b.co', password: PASS });
  assert.strictEqual(locked.status, 429);
  assert.strictEqual(locked.body.error, 'rate-limited');
  t += 15 * 60 * 1000;
  assert.strictEqual((await b.post('login', { email: 'a@b.co', password: PASS })).status, 200);
  s.close();
});

test('routes: profile update', async () => {
  const s = await startServer();
  const b = s.browser();
  assert.strictEqual((await b.post('profile', { displayName: 'X' })).status, 401);
  await b.post('register', { email: 'a@b.co', password: PASS });
  assert.strictEqual((await b.get('me')).body.user.displayName, 'Player');
  const up = await b.post('profile', { displayName: 'Ada', tag: 'xy', settings: { uiScale: 1.2 } });
  assert.deepStrictEqual(up.body.user, { id: 1, email: 'a@b.co', displayName: 'Ada', tag: 'XY', settings: { uiScale: 1.2 } });
  // Omitted fields are kept.
  assert.strictEqual((await b.post('profile', { tag: '' })).body.user.displayName, 'Ada');
  assert.strictEqual((await b.post('profile', { displayName: '[X] Ada' })).status, 400);
  s.close();
});

test('routes: change email and password, sign out everywhere, delete', async () => {
  const s = await startServer();
  const b = s.browser(), other = s.browser();
  await b.post('register', { email: 'a@b.co', password: PASS });
  await other.post('login', { email: 'a@b.co', password: PASS });

  assert.strictEqual((await b.post('email', { password: PASS2, email: 'new@b.co' })).status, 403);
  assert.strictEqual((await b.post('email', { password: PASS, email: 'new@b.co' })).body.user.email, 'new@b.co');

  // Changing the password ends every other session and keeps this one.
  assert.strictEqual((await b.post('password', { current: PASS, next: 'short' })).status, 400);
  assert.strictEqual((await b.post('password', { current: PASS, next: PASS2 })).status, 200);
  assert.strictEqual((await b.get('me')).body.user.email, 'new@b.co');
  assert.deepStrictEqual((await other.get('me')).body, { user: null });
  assert.strictEqual((await other.post('login', { email: 'new@b.co', password: PASS })).status, 401);
  assert.strictEqual((await other.post('login', { email: 'new@b.co', password: PASS2 })).status, 200);

  await other.post('logout-all');
  assert.deepStrictEqual((await b.get('me')).body, { user: null });

  await b.post('login', { email: 'new@b.co', password: PASS2 });
  assert.strictEqual((await b.post('delete-account', { password: PASS })).status, 403);
  assert.strictEqual((await b.post('delete-account', { password: PASS2 })).status, 200);
  assert.strictEqual(s.accounts.db.prepare('SELECT count(*) n FROM users').get().n, 0);
  assert.strictEqual(s.accounts.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  s.close();
});

test('routes: a login with old scrypt parameters is re-hashed', async () => {
  const db = dbModule.open(':memory:');
  const old = await passwords.hash(PASS, { N: 1 << 9, r: 8, p: 1 });
  db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)').run('a@b.co', old, 'A', 1);
  const s = await startServer({ db, dbPath: undefined });
  assert.strictEqual((await s.browser().post('login', { email: 'a@b.co', password: PASS })).status, 200);
  const stored = db.prepare('SELECT pass_hash FROM users WHERE id = 1').get().pass_hash;
  assert.match(stored, /^scrypt\$1024\$/);
  assert.strictEqual(await passwords.verify(PASS, stored), true);
  s.close();
});

test('admin: export, reset password, revoke sessions', async () => {
  const admin = require('./admin');
  const db = dbModule.open(':memory:');
  const hash = await passwords.hash(PASS, FAST);
  db.prepare('INSERT INTO users (email, pass_hash, display_name, tag, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('a@b.co', hash, 'A', 'TAG', '{"lowGfx":true}', 1000);
  db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)').run('c@d.co', hash, 'C', 1000);
  db.prepare('INSERT INTO matches (game_id, ended_at, duration_turns, map, mode, nation_count) VALUES (?, ?, ?, ?, ?, ?)')
    .run('g1', 5000, 300, 'large', 'ffa', 8);
  db.prepare('INSERT INTO match_players (match_id, user_id, player_id, result, place) VALUES (1, 1, 3, ?, 2)').run('loss');
  const s = sessionsModule.create(db, () => 2000);
  const token = s.start(1);
  s.start(2);

  assert.strictEqual(admin.exportUser(db, 'nobody@b.co'), null);
  const out = admin.exportUser(db, ' A@B.co ', () => 9000);
  assert.deepStrictEqual(out.account, {
    id: 1, email: 'a@b.co', displayName: 'A', tag: 'TAG', settings: { lowGfx: true }, createdAt: '1970-01-01T00:00:01.000Z'
  });
  assert.strictEqual(out.sessions.length, 1);
  assert.deepStrictEqual(out.matches.map(m => [m.gameId, m.result, m.place]), [['g1', 'loss', 2]]);
  // No secrets in an export.
  assert.doesNotMatch(JSON.stringify(out), /scrypt|pass_hash|token/i);

  assert.strictEqual(await admin.resetPassword(db, 'nobody@b.co', FAST), null);
  const temp = await admin.resetPassword(db, 'a@b.co', FAST);
  const stored = db.prepare('SELECT pass_hash FROM users WHERE id = 1').get().pass_hash;
  assert.strictEqual(await passwords.verify(temp, stored), true);
  assert.strictEqual(await passwords.verify(PASS, stored), false);
  assert.strictEqual(s.userIdFor(token), null);

  assert.strictEqual(admin.revokeSessions(db, 'nobody@b.co'), null);
  s.start(1);
  assert.strictEqual(admin.revokeSessions(db, 'a@b.co'), 1);
  assert.strictEqual(admin.revokeSessions(db, null), 1);
  db.close();
});

test('backup: one file a day, oldest pruned, restorable', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const backup = require('./backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-backup-'));
  const db = dbModule.open(':memory:');
  db.prepare('INSERT INTO users (email, pass_hash, display_name, created_at) VALUES (?, ?, ?, ?)').run('a@b.co', 'x', 'A', 1);
  const DAY = 24 * 60 * 60 * 1000;
  let t = Date.UTC(2026, 0, 1, 12);

  const first = backup.run(db, dir, () => t, 3);
  assert.strictEqual(path.basename(first), 'borderwar-2026-01-01.db');
  assert.strictEqual(backup.run(db, dir, () => t, 3), null);   // same day: nothing new
  for (let i = 0; i < 4; i++) { t += DAY; backup.run(db, dir, () => t, 3); }
  assert.deepStrictEqual(fs.readdirSync(dir).sort(),
    ['borderwar-2026-01-03.db', 'borderwar-2026-01-04.db', 'borderwar-2026-01-05.db']);

  const copy = dbModule.open(path.join(dir, 'borderwar-2026-01-05.db'));
  assert.strictEqual(copy.prepare('SELECT email FROM users').get().email, 'a@b.co');
  copy.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Progress (docs/metaprogression.md §5.2, §6.4) ------------------------------

const ProgressDefs = require('../../js/progress-defs.js');
const NO_LOADOUT = { title: null, emblem: null, banner: null };

test('progress: sanitize keeps only known, well-formed entries', () => {
  for (const junk of [null, undefined, 42, 'x', [], [1, 2], { unlocked: 'no', counters: 7, equipped: [] }]) {
    assert.deepStrictEqual(ProgressDefs.sanitize(junk), ProgressDefs.empty());
  }
  const clean = ProgressDefs.sanitize({
    v: 99, extra: true,
    unlocked: { victory: 1000.9, sea_legs: 5000, not_real: 1000, pact: 'soon', founder: -1, landlord: Infinity,
      wins_5: 0, toString: 5, __proto__: 5 },
    counters: { wins: 7.8, losses: 3 },
    equipped: { title: 'emblem_anchor', emblem: 'emblem_anchor', banner: 'banner_nope', hat: 'title_veteran' }
  }, 3000);
  assert.deepStrictEqual(clean, {
    v: 1,
    unlocked: { victory: 1000, sea_legs: 3000 },   // a date in the future is pulled back to now
    counters: { wins: 7 },
    equipped: { title: null, emblem: 'emblem_anchor', banner: null }
  });
  for (const bad of [-1, NaN, '7', null, {}]) {
    assert.deepStrictEqual(ProgressDefs.sanitize({ counters: { wins: bad } }).counters, {});
  }
  assert.deepStrictEqual(ProgressDefs.sanitize({ counters: { wins: 1e12 } }).counters, { wins: 1e6 });
  assert.deepStrictEqual(ProgressDefs.sanitize(clean), clean);
});

test('progress: merge is a union with the earlier date and larger counter', () => {
  const a = { unlocked: { victory: 500, pact: 900 }, counters: { wins: 3 }, equipped: { title: 'title_veteran', emblem: null, banner: null } };
  const b = { unlocked: { victory: 700, sea_legs: 100 }, counters: { wins: 9 }, equipped: { title: null, emblem: 'emblem_anchor', banner: null } };
  const before = JSON.stringify([a, b]);
  const ab = ProgressDefs.merge(a, b), ba = ProgressDefs.merge(b, a);
  assert.deepStrictEqual(ab.unlocked, { victory: 500, pact: 900, sea_legs: 100 });
  assert.deepStrictEqual(ab.counters, { wins: 9 });
  assert.deepStrictEqual(ab.equipped, b.equipped);
  assert.deepStrictEqual(ba.equipped, a.equipped);
  assert.deepStrictEqual(ba.unlocked, ab.unlocked);
  assert.deepStrictEqual(ba.counters, ab.counters);
  assert.strictEqual(JSON.stringify([a, b]), before);   // inputs untouched
  // Repeating a merge changes nothing.
  assert.deepStrictEqual(ProgressDefs.merge(ab, b), ab);
  assert.deepStrictEqual(ProgressDefs.merge(a, a), Object.assign({ v: 1 }, a));
  assert.deepStrictEqual(ProgressDefs.merge(null, undefined), ProgressDefs.empty());
});

test('progress: an equipped item is cleared unless its achievement is unlocked', () => {
  const equipped = { title: 'title_veteran', emblem: 'emblem_anchor', banner: 'banner_iron' };
  assert.deepStrictEqual(ProgressDefs.equippable({ unlocked: { sea_legs: 1, victory: 1 }, equipped }),
    { title: null, emblem: 'emblem_anchor', banner: null });
  assert.deepStrictEqual(ProgressDefs.equippable({ unlocked: {}, equipped }), NO_LOADOUT);
  assert.deepStrictEqual(ProgressDefs.equippable(null), NO_LOADOUT);
  // Every cosmetic has exactly one achievement that unlocks it.
  const unlockers = Object.values(ProgressDefs.ACHIEVEMENTS).map(a => a.unlocks).filter(Boolean);
  assert.deepStrictEqual(unlockers.slice().sort(), Object.keys(ProgressDefs.COSMETICS).sort());
});

test('db: an existing version 1 database gains the progress columns', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, display_name TEXT NOT NULL,
      tag TEXT NOT NULL DEFAULT '', settings_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
    INSERT INTO users (email, pass_hash, display_name, settings_json, created_at) VALUES ('a@b.co', 'x', 'A', '{"k":1}', 1);`);
  dbModule.migrate(db);
  assert.strictEqual(dbModule.schemaVersion(db), dbModule.LATEST_VERSION);
  const row = db.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.strictEqual(row.email, 'a@b.co');
  assert.strictEqual(row.settings_json, '{"k":1}');
  assert.strictEqual(row.progress_json, '{}');
  assert.strictEqual(row.equipped_json, '{}');
  dbModule.migrate(db);   // nothing left to do
  assert.strictEqual(dbModule.schemaVersion(db), dbModule.LATEST_VERSION);
  db.close();
});

test('routes: progress needs a session and the usual POST checks', async () => {
  const s = await startServer();
  const b = s.browser();
  const get = await b.get('progress');
  assert.strictEqual(get.status, 401);
  assert.strictEqual(get.body.error, 'unauthorized');
  assert.strictEqual((await b.post('progress', { unlocked: { victory: 5 } })).status, 401);
  await b.post('register', { email: 'a@b.co', password: PASS });
  assert.deepStrictEqual((await b.get('progress')).body, { unlocked: {}, counters: {}, equipped: NO_LOADOUT });
  assert.strictEqual((await b.post('progress', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await b.post('progress', {}, { 'Content-Type': 'text/plain' })).status, 415);
  // /api/me stays as it was.
  assert.deepStrictEqual(Object.keys((await b.get('me')).body.user), ['id', 'email', 'displayName', 'tag', 'settings']);
  s.close();
});

test('routes: progress merges, drops junk and is repeat-safe', async () => {
  let t = 10000;
  const s = await startServer({ now: () => t });
  const b = s.browser();
  await b.post('register', { email: 'a@b.co', password: PASS });

  const first = { unlocked: { victory: 500, sea_legs: 600, bogus: 1 }, counters: { wins: 3, bogus: 9 },
    equipped: { title: 'title_veteran', emblem: 'emblem_anchor', banner: 'emblem_anchor' } };
  const want = { unlocked: { victory: 500, sea_legs: 600 }, counters: { wins: 3 },
    equipped: { title: null, emblem: 'emblem_anchor', banner: null } };   // title_veteran is still locked
  const r1 = await b.post('progress', first);
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(r1.body, want);
  const row = () => JSON.stringify(s.accounts.db.prepare('SELECT progress_json, equipped_json FROM users WHERE id = 1').get());
  const stored = row();
  t += 5000;
  assert.deepStrictEqual((await b.post('progress', first)).body, want);
  assert.strictEqual(row(), stored);
  assert.deepStrictEqual((await b.get('progress')).body, want);

  // A later date and a smaller counter lose; a loadout left out is kept.
  const r2 = await b.post('progress', { unlocked: { victory: 900, wins_5: 800 }, counters: { wins: 1 } });
  assert.deepStrictEqual(r2.body, { unlocked: { victory: 500, sea_legs: 600, wins_5: 800 }, counters: { wins: 3 }, equipped: want.equipped });
  // A loadout that is sent replaces the stored one whole.
  const r3 = await b.post('progress', { counters: { wins: 5 }, equipped: { title: 'title_veteran' } });
  assert.deepStrictEqual(r3.body.equipped, { title: 'title_veteran', emblem: null, banner: null });
  assert.deepStrictEqual(r3.body.counters, { wins: 5 });
  assert.deepStrictEqual((await b.post('progress', { equipped: NO_LOADOUT })).body.equipped, NO_LOADOUT);
  // A date in the future is stored as the server's now.
  assert.strictEqual((await b.post('progress', { unlocked: { pact: 9e12 } })).body.unlocked.pact, t);

  // A second device signing in sees the same copy; another account sees none of it.
  const other = s.browser();
  await other.post('login', { email: 'a@b.co', password: PASS });
  assert.deepStrictEqual((await other.get('progress')).body, (await b.get('progress')).body);
  const stranger = s.browser();
  await stranger.post('register', { email: 'c@d.co', password: PASS2 }, { 'CF-Connecting-IP': null });
  assert.deepStrictEqual((await stranger.get('progress')).body.unlocked, {});

  const admin = require('./admin');
  assert.deepStrictEqual(admin.exportUser(s.accounts.db, 'a@b.co').progress, (await b.get('progress')).body);
  s.close();
});
