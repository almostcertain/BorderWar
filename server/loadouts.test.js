// cd server && npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');

const loadouts = require('./loadouts');
const GameManager = require('./gamemanager');
const GameServer = require('./gameserver');
const Protocol = require('../js/net/protocol.js');

const PID_A = '3f2b8c1e-0d4a-4b6f-9a77-5e1c2d3f4a5b';
const PID_B = 'p-mabc1234-k9x8y7z6';
const TITLE = { title: 'title_veteran', emblem: null, banner: null };
const FULL = { title: 'title_champion', emblem: 'emblem_crown', banner: 'banner_iron' };

// --- Store --------------------------------------------------------------------

test('store: keeps a cleaned loadout, drops unknown and wrong-type ids', () => {
  const s = loadouts.createStore();
  assert.deepStrictEqual(s.set(PID_A, FULL), FULL);
  assert.deepStrictEqual(s.get(PID_A), FULL);
  assert.deepStrictEqual(s.set(PID_A, { title: 'emblem_crown', emblem: 'nope', banner: 'banner_iron', extra: 1 }),
    { title: null, emblem: null, banner: 'banner_iron' });
  assert.strictEqual(s.get(PID_B), null);
  // Nothing equipped clears the entry.
  assert.strictEqual(s.set(PID_A, { title: null, emblem: 'title_veteran', banner: 7 }), null);
  assert.strictEqual(s.get(PID_A), null);
  assert.strictEqual(s.size, 0);
});

test('store: entries expire after the TTL since their last write', () => {
  let t = 1000;
  const s = loadouts.createStore({ ttlMs: 100, now: () => t });
  s.set(PID_A, TITLE);
  s.set(PID_B, TITLE);
  t += 60;
  s.set(PID_A, TITLE);          // rewritten: its clock restarts
  t += 60;
  assert.strictEqual(s.get(PID_B), null);
  assert.deepStrictEqual(s.get(PID_A), TITLE);
  t += 40;
  assert.strictEqual(s.get(PID_A), null);
  // A write sweeps expired entries without waiting for a read.
  s.set(PID_A, TITLE);
  t += 100;
  s.set(PID_B, TITLE);
  assert.strictEqual(s.size, 1);
});

test('store: the cap evicts the oldest write', () => {
  const s = loadouts.createStore({ max: 3 });
  for (const id of ['aaaaaaaa1', 'aaaaaaaa2', 'aaaaaaaa3']) s.set(id, TITLE);
  s.set('aaaaaaaa1', TITLE);    // now the newest
  s.set('aaaaaaaa4', TITLE);
  assert.strictEqual(s.size, 3);
  assert.strictEqual(s.get('aaaaaaaa2'), null);
  assert.deepStrictEqual(s.get('aaaaaaaa1'), TITLE);
  assert.deepStrictEqual(s.get('aaaaaaaa4'), TITLE);
});

test('defaults: about 6 hours and 20,000 entries', () => {
  assert.strictEqual(loadouts.TTL_MS, 6 * 60 * 60 * 1000);
  assert.strictEqual(loadouts.MAX_ENTRIES, 20000);
});

// --- Route --------------------------------------------------------------------

async function startServer(opts) {
  const changes = [];
  const route = loadouts.createRoute(Object.assign({ onChange: (id, e) => changes.push([id, e]) }, opts));
  const server = http.createServer((req, res) => route.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function post(body, headers, raw) {
    const h = Object.assign({ 'Content-Type': 'application/json', Origin: base }, headers);
    for (const k in h) if (h[k] === null) delete h[k];
    const res = await fetch(base + '/api/loadout', { method: 'POST', headers: h, body: raw || JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  return { route, changes, base, post, close: () => server.close() };
}

test('route: stores a loadout and answers {ok:true}', async () => {
  const s = await startServer();
  const r = await s.post({ persistentID: PID_A, equipped: FULL });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });
  assert.deepStrictEqual(s.route.store.get(PID_A), FULL);
  assert.deepStrictEqual(s.changes, [[PID_A, FULL]]);

  // The fallback id shape is accepted too, and all-null clears.
  assert.strictEqual((await s.post({ persistentID: PID_B, equipped: TITLE })).status, 200);
  assert.strictEqual((await s.post({ persistentID: PID_B, equipped: { title: null, emblem: null, banner: null } })).status, 200);
  assert.strictEqual(s.route.store.get(PID_B), null);
  assert.deepStrictEqual(s.changes[2], [PID_B, null]);
  s.close();
});

test('route: unknown and wrong-type cosmetic ids are dropped, not stored', async () => {
  const s = await startServer();
  const r = await s.post({ persistentID: PID_A, equipped: { title: 'title_nope', emblem: 'banner_iron', banner: 'banner_iron' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(s.route.store.get(PID_A), { title: null, emblem: null, banner: 'banner_iron' });
  await s.post({ persistentID: PID_A, equipped: { title: '__proto__', emblem: 'constructor', banner: {} } });
  assert.strictEqual(s.route.store.get(PID_A), null);
  s.close();
});

test('route: bad persistentID or equipped is refused', async () => {
  const s = await startServer();
  const bad = [
    { equipped: TITLE },
    { persistentID: 42, equipped: TITLE },
    { persistentID: '', equipped: TITLE },
    { persistentID: 'short', equipped: TITLE },
    { persistentID: 'x'.repeat(65), equipped: TITLE },
    { persistentID: 'has spaces in it', equipped: TITLE },
    { persistentID: '<script>alert(1)', equipped: TITLE },
    { persistentID: PID_A },
    { persistentID: PID_A, equipped: 'title_veteran' },
    { persistentID: PID_A, equipped: ['title_veteran'] },
    { persistentID: PID_A, equipped: null }
  ];
  for (const body of bad) {
    const r = await s.post(body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.strictEqual(r.body.error, 'invalid');
    assert.strictEqual(typeof r.body.message, 'string');
  }
  assert.strictEqual((await s.post(null, null, 'not json')).status, 400);
  assert.strictEqual((await s.post(null, null, '[1]')).status, 400);
  assert.strictEqual(s.route.store.size, 0);
  assert.deepStrictEqual(s.changes, []);
  s.close();
});

test('route: needs a same-host Origin, a JSON content type, POST and a small body', async () => {
  const s = await startServer();
  const body = { persistentID: PID_A, equipped: TITLE };
  let r = await s.post(body, { Origin: null });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.error, 'invalid');
  assert.strictEqual((await s.post(body, { Origin: 'http://evil.example' })).status, 403);
  r = await s.post(body, { 'Content-Type': 'text/plain' });
  assert.strictEqual(r.status, 415);
  assert.strictEqual(r.body.error, 'invalid');
  assert.strictEqual((await s.post(body, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.strictEqual((await s.post({ persistentID: PID_A, equipped: TITLE, pad: 'x'.repeat(5000) })).status, 413);
  const get = await fetch(s.base + '/api/loadout');
  assert.strictEqual(get.status, 404);
  assert.strictEqual(s.route.store.size, 0);
  s.close();
});

test('route: rate limit per address', async () => {
  let t = 1000;
  const s = await startServer({ now: () => t });
  const body = { persistentID: PID_A, equipped: TITLE };
  for (let i = 0; i < loadouts.POSTS_PER_MINUTE; i++) assert.strictEqual((await s.post(body)).status, 200);
  const r = await s.post(body);
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.error, 'rate-limited');
  t += 60 * 1000;
  assert.strictEqual((await s.post(body)).status, 200);
  s.close();
});

// --- Lobby --------------------------------------------------------------------

// Enough of a ws socket for GameManager/GameServer; records what it is sent.
function fakeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.raw = [];
  ws.send = (s) => ws.raw.push(s);
  ws.close = () => { ws.readyState = 3; };
  ws.of = (type) => ws.raw.map((s) => JSON.parse(s)).filter((m) => m.type === type);
  ws.last = (type) => ws.of(type).pop();
  return ws;
}

// A manager with its route wired the way server/index.js wires it.
function setup() {
  const route = loadouts.createRoute({ onChange: (id, e) => manager.applyLoadout(id, e) });
  const manager = new GameManager({ loadouts: route.store });
  function join(gameID, username, persistentID, spectator) {
    const ws = fakeSocket();
    manager.handleConnection(ws);
    ws.emit('message', JSON.stringify(Protocol.msg.join(gameID, username, persistentID, spectator)));
    return ws;
  }
  // What the route does after validating a POST.
  function post(persistentID, equipped) {
    manager.applyLoadout(persistentID, route.store.set(persistentID, equipped));
  }
  function close() {
    for (const game of manager.games.values()) game.end('test over');
    clearInterval(manager._reapIntervalID);
  }
  return { manager, store: route.store, join, post, close };
}

test('join: picks up a stored loadout; no cosmetics means no key', () => {
  const s = setup();
  s.post(PID_A, FULL);
  const a = s.join('G1', 'Ada', PID_A);
  const b = s.join('G1', 'Bob', PID_B);

  const lobby = b.last('lobby_info').lobby;
  assert.deepStrictEqual(lobby.players, [
    { clientID: '0', username: 'Ada', spectator: false, cosmetics: FULL },
    { clientID: '1', username: 'Bob', spectator: false }
  ]);
  assert.strictEqual('cosmetics' in lobby.players[1], false);
  assert.strictEqual(JSON.stringify(lobby).includes(PID_A), false);   // the id itself never goes out

  const game = s.manager.getGame('G1');
  game.start({ seed: 7 });
  const info = a.last('start').gameStartInfo;
  assert.deepStrictEqual(info.players, [
    { clientID: '0', username: 'Ada', playerId: 0, cosmetics: FULL },
    { clientID: '1', username: 'Bob', playerId: 1 }
  ]);
  assert.strictEqual('cosmetics' in info.players[1], false);
  s.close();
});

test('a roster with no cosmetics is byte-identical to one built without the store', () => {
  const s = setup();
  const a = s.join('G1', 'Ada', PID_A);
  const plain = new GameManager();
  const ws = fakeSocket();
  plain.handleConnection(ws);
  ws.emit('message', JSON.stringify(Protocol.msg.join('G1', 'Ada', PID_A)));
  assert.strictEqual(a.raw[a.raw.length - 1], ws.raw[ws.raw.length - 1]);
  assert.strictEqual(a.raw[a.raw.length - 1].includes('cosmetics'), false);

  s.manager.getGame('G1').start({ seed: 7 });
  plain.getGame('G1').start({ seed: 7 });
  assert.strictEqual(a.raw[a.raw.length - 1], ws.raw[ws.raw.length - 1]);
  assert.strictEqual(a.raw[a.raw.length - 1].includes('cosmetics'), false);
  s.close();
  for (const game of plain.games.values()) game.end('test over');
  clearInterval(plain._reapIntervalID);
});

test('POST after join updates the lobby roster and re-broadcasts', () => {
  const s = setup();
  const a = s.join('G1', 'Ada', PID_A);
  const b = s.join('G1', 'Bob', PID_B);
  const before = b.of('lobby_info').length;
  assert.strictEqual('cosmetics' in b.last('lobby_info').lobby.players[0], false);

  s.post(PID_A, TITLE);
  assert.strictEqual(b.of('lobby_info').length, before + 1);
  assert.strictEqual(a.of('lobby_info').length, before + 2);   // Ada also saw Bob join
  assert.deepStrictEqual(b.last('lobby_info').lobby.players[0].cosmetics, TITLE);
  assert.strictEqual('cosmetics' in b.last('lobby_info').lobby.players[1], false);

  // Same loadout again: nothing to tell anyone.
  s.post(PID_A, TITLE);
  assert.strictEqual(b.of('lobby_info').length, before + 1);
  // Someone not in any lobby: no broadcast.
  s.post('ffffffff-0000-4000-8000-000000000000', FULL);
  assert.strictEqual(b.of('lobby_info').length, before + 1);

  // Unequipping removes the key again.
  s.post(PID_A, { title: null, emblem: null, banner: null });
  assert.strictEqual(b.of('lobby_info').length, before + 2);
  assert.strictEqual('cosmetics' in b.last('lobby_info').lobby.players[0], false);
  s.close();
});

test('POST after the match starts does not change that match', () => {
  const s = setup();
  s.post(PID_A, TITLE);
  const a = s.join('G1', 'Ada', PID_A);
  const game = s.manager.getGame('G1');
  game.start({ seed: 7 });
  const sent = JSON.stringify(game.gameStartInfo);
  const messages = a.raw.length;

  s.post(PID_A, FULL);
  assert.strictEqual(JSON.stringify(game.gameStartInfo), sent);
  assert.deepStrictEqual(game.gameStartInfo.players[0].cosmetics, TITLE);
  assert.strictEqual(a.raw.length, messages);

  // A rejoin is handed that same gameStartInfo.
  const ws = fakeSocket();
  s.manager.handleConnection(ws);
  ws.emit('message', JSON.stringify(Protocol.msg.rejoin('G1', 0, PID_A)));
  assert.strictEqual(JSON.stringify(ws.last('start').gameStartInfo), sent);

  // The next lobby this browser joins gets the new loadout.
  const next = s.join('G2', 'Ada', PID_A);
  assert.deepStrictEqual(next.last('lobby_info').lobby.players[0].cosmetics, FULL);
  s.close();
});

test('spectators show cosmetics in the lobby and stay out of gameStartInfo', () => {
  const s = setup();
  s.post(PID_B, TITLE);
  const a = s.join('G1', 'Ada', PID_A);
  s.join('G1', 'Bob', PID_B, true);
  assert.deepStrictEqual(a.last('lobby_info').lobby.players[1],
    { clientID: '1', username: 'Bob', spectator: true, cosmetics: TITLE });
  s.manager.getGame('G1').start({ seed: 7 });
  assert.deepStrictEqual(a.last('start').gameStartInfo.players, [{ clientID: '0', username: 'Ada', playerId: 0 }]);
  s.close();
});

test('messages carrying cosmetics pass protocol validation', () => {
  const lobby = { gameID: 'G1', creatorClientId: '0', players: [{ clientID: '0', username: 'Ada', spectator: false, cosmetics: FULL }] };
  assert.strictEqual(Protocol.validateMessage(Protocol.msg.lobbyInfo(lobby, '0'), 's2c'), null);
  const info = { gameID: 'G1', seed: 1, config: {}, players: [{ clientID: '0', username: 'Ada', playerId: 0, cosmetics: FULL }] };
  assert.strictEqual(Protocol.validateMessage(Protocol.msg.start([], info, '0'), 's2c'), null);
  assert.strictEqual(typeof GameServer, 'function');
});
