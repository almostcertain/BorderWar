// Daily Challenge leaderboard (server/daily.js, server/dailyreplay.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dbModule = require('./accounts/db');
const daily = require('./daily');
const DailyCore = require('../js/daily-core.js');

const BUILD = 'test-build';
const NOW = DailyCore.EPOCH + 13.5 * DailyCore.DAY_MS;   // midday of day 14, a Saturday
const TODAY = 14;

// A daily's gameStartInfo, built as LocalServer.start builds it.
function startInfo(day) {
  const ctx = vm.createContext({});
  for (const f of ['js/game/shared.js', 'js/net/protocol.js', 'js/daily-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
  }
  return JSON.parse(vm.runInContext(`(() => { const c = DailyCore.challenge(${day}).config; return JSON.stringify({
    gameID: 'local', seed: c.seed >>> 0,
    config: { map: Protocol.normalizeMap(c.map), mapSize: c.mapSize, mapGen: Protocol.normalizeMapGen(c.mapGen), bots: c.bots, tribes: c.tribes,
      difficulty: c.difficulty, gameMode: 'ffa', fogOfWar: c.fogOfWar, pointsOfInterest: c.pointsOfInterest },
    players: [{ clientID: 'local', username: 'Ironvale', playerId: 0 }] }); })()`, ctx));
}

function replay(day, turnCount, edit) {
  const r = { format: 'borderwar-replay', version: 1, id: 'rtest', startedAt: 1, savedAt: 2, build: BUILD,
    gameStartInfo: startInfo(day), myClientID: 'local', myPlayerId: 0, turnCount, turns: [], hashes: [], result: null };
  if (edit) edit(r);
  return r;
}

function setup(checker) {
  const db = dbModule.open(':memory:');
  const add = db.prepare("INSERT INTO users (email, pass_hash, display_name, tag, created_at) VALUES (?, 'x', ?, ?, 0)");
  add.run('a@test.invalid', 'Ironvale', 'IV');
  add.run('b@test.invalid', 'Marrowby', '');
  const route = daily.create({
    db, build: BUILD, now: () => NOW, checker,
    userIdForRequest: (req) => req.headers['x-user'] ? Number(req.headers['x-user']) : null
  });
  const server = http.createServer((req, res) => route.handle(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ db, server, port: server.address().port })));
}

function call(env, method, route, user, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { host: '127.0.0.1:' + env.port, origin: 'http://127.0.0.1:' + env.port };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (user) headers['x-user'] = String(user);
    const req = http.request({ host: '127.0.0.1', port: env.port, method, path: '/api/daily/' + route, headers }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Stands in for the replay check: resolves with whatever the test queued.
function fakeChecker() {
  const results = [];
  return {
    calls: 0,
    check() { this.calls++; return Promise.resolve(results.shift()); },
    push(r) { results.push(r); }
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('submit: sign-in, build and day are checked before any re-run', async () => {
  const fake = fakeChecker();
  const env = await setup(fake);
  try {
    const rec = { build: BUILD };
    assert.strictEqual((await call(env, 'POST', 'submit', null, { day: TODAY, replay: rec })).status, 401);
    assert.strictEqual((await call(env, 'POST', 'submit', 1, { day: TODAY, replay: { build: 'old' } })).status, 409);
    assert.strictEqual((await call(env, 'POST', 'submit', 1, { day: TODAY - 2, replay: rec })).status, 400);
    assert.strictEqual((await call(env, 'POST', 'submit', 1, { day: TODAY + 1, replay: rec })).status, 400);
    assert.strictEqual(fake.calls, 0);
  } finally { env.server.close(); }
});

test('board: the server-checked score is stored, ranked and only ever raised', async () => {
  const fake = fakeChecker();
  const env = await setup(fake);
  const ok = (score) => ({ ok: true, result: { score, won: false, secs: 700, place: 4, nations: 47, peak: 12.5, title: 'Defeated', turns: 7000 } });
  try {
    fake.push(ok(1500));
    let r = await call(env, 'POST', 'submit', 1, { day: TODAY, claimed: 1500, replay: { build: BUILD } });
    assert.deepStrictEqual([r.status, r.body.status], [202, 'checking']);
    await settle();
    fake.push(ok(900));
    await call(env, 'POST', 'submit', 2, { day: TODAY - 1, claimed: 900, replay: { build: BUILD } });
    fake.push(ok(2000));
    await call(env, 'POST', 'submit', 2, { day: TODAY, claimed: 2000, replay: { build: BUILD } });
    await settle();

    let b = (await call(env, 'GET', 'board', 1)).body;
    assert.strictEqual(b.day, TODAY);
    assert.strictEqual(b.total, 2);
    assert.deepStrictEqual(b.top.map((x) => [x.rank, x.name, x.score]), [[1, 'Marrowby', 2000], [2, '[IV] Ironvale', 1500]]);
    assert.strictEqual(b.me.rank, 2);
    assert.deepStrictEqual(b.check, { status: 'done', message: null, score: 1500 });
    assert.strictEqual((await call(env, 'GET', 'board?day=' + (TODAY - 1), 1)).body.total, 1);

    // A claim that can't beat the stored best is not re-run.
    const before = fake.calls;
    r = await call(env, 'POST', 'submit', 1, { day: TODAY, claimed: 1400, replay: { build: BUILD } });
    assert.strictEqual(r.body.status, 'kept');
    assert.strictEqual(fake.calls, before);

    // A claim that turns out lower on the server doesn't replace the stored score.
    fake.push(ok(1000));
    await call(env, 'POST', 'submit', 1, { day: TODAY, claimed: 5000, replay: { build: BUILD } });
    await settle();
    b = (await call(env, 'GET', 'board', 1)).body;
    assert.strictEqual(b.me.score, 1500);

    fake.push({ ok: false, message: 'Not Daily Challenge #14.' });
    await call(env, 'POST', 'submit', 1, { day: TODAY, claimed: 5000, replay: { build: BUILD } });
    await settle();
    b = (await call(env, 'GET', 'board', 1)).body;
    assert.deepStrictEqual(b.check, { status: 'rejected', message: 'Not Daily Challenge #14.', score: null });
    assert.strictEqual((await call(env, 'GET', 'board', null)).body.me, null);

    env.db.prepare('DELETE FROM users WHERE id = 2').run();
    assert.strictEqual((await call(env, 'GET', 'board', 1)).body.total, 1);
  } finally { env.server.close(); }
});

test('checker: re-runs a real replay and rejects tampered ones', { timeout: 240000 }, async () => {
  const checker = daily.createChecker({ timeoutMs: 200000 });
  // No inputs: the player is placed at random and overrun by the bots.
  const real = await checker.check(replay(TODAY, 3000), TODAY);
  assert.strictEqual(real.ok, true, real.message);
  const r = real.result;
  assert.strictEqual(r.title, 'Defeated');
  assert.strictEqual(r.won, false);
  assert.ok(r.secs >= DailyCore.MIN_SECS && r.turns < 3000);

  const wrongDay = await checker.check(replay(TODAY - 1, 3000), TODAY);
  assert.deepStrictEqual(wrongDay, { ok: false, message: 'Not Daily Challenge #14.' });
  const edited = await checker.check(replay(TODAY, 3000, (x) => { x.gameStartInfo.config.bots = 2; }), TODAY);
  assert.strictEqual(edited.ok, false);
  const badHash = await checker.check(replay(TODAY, 3000, (x) => { x.hashes = [[100, 12345]]; }), TODAY);
  assert.deepStrictEqual(badHash, { ok: false, message: 'This match was played on a different version of the game.' });
  const broken = await checker.check({ format: 'nope' }, TODAY);
  assert.strictEqual(broken.ok, false);
});
