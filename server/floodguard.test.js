// cd server && npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const { AddressGuard, MessageBudget, WindowCounter, addressKey } = require('./floodguard');
const GameManager = require('./gamemanager');
const Protocol = require('../js/net/protocol.js');

// --- addressKey ----------------------------------------------------------------

test('addressKey: IPv4 as is, mapped IPv4 unwrapped, loopback and unknown exempt', () => {
  assert.strictEqual(addressKey('203.0.113.7'), '203.0.113.7');
  assert.strictEqual(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.strictEqual(addressKey('127.0.0.1'), null);
  assert.strictEqual(addressKey('::1'), null);
  assert.strictEqual(addressKey('::ffff:127.0.0.1'), null);
  assert.strictEqual(addressKey(undefined), null);
  assert.strictEqual(addressKey(''), null);
});

test('addressKey: IPv6 collapses to its /64, however it is written', () => {
  const a = addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  assert.strictEqual(a, '2001:db8:1:2');
  assert.strictEqual(addressKey('2001:0DB8:0001:0002::1'), a);
  assert.strictEqual(addressKey('2001:db8:1:2::'), a);
  assert.strictEqual(addressKey('2001:db8::5'), '2001:db8:0:0');
  assert.notStrictEqual(addressKey('2001:db8:1:3::1'), a);
});

// --- AddressGuard ----------------------------------------------------------------

test('AddressGuard: caps concurrent sockets per address and frees them on release', () => {
  const g = new AddressGuard({ openPerAddress: 2, newPerWindow: 100 });
  assert.strictEqual(g.admit('203.0.113.1'), null);
  assert.strictEqual(g.admit('203.0.113.1'), null);
  assert.strictEqual(g.admit('203.0.113.1'), 'open');
  assert.strictEqual(g.admit('203.0.113.2'), null);   // someone else is unaffected
  g.release('203.0.113.1');
  assert.strictEqual(g.admit('203.0.113.1'), null);
});

test('AddressGuard: caps new sockets per window per address', () => {
  let t = 0;
  const g = new AddressGuard({ now: () => t, openPerAddress: 100, newPerWindow: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) { assert.strictEqual(g.admit('203.0.113.1'), null); g.release('203.0.113.1'); }
  assert.strictEqual(g.admit('203.0.113.1'), 'rate');
  assert.strictEqual(g.admit('203.0.113.2'), null);
  t += 1000;
  assert.strictEqual(g.admit('203.0.113.1'), null);
});

test('AddressGuard: one flooding address cannot use up the global budget', () => {
  let t = 0;
  const g = new AddressGuard({ now: () => t, openPerAddress: 1000, newPerWindow: 5, globalPerSecond: 8 });
  for (let i = 0; i < 50; i++) g.admit('203.0.113.1');   // 5 admitted, 45 refused
  // 3 of the 8 global slots are left for everyone else.
  assert.strictEqual(g.admit('203.0.113.2'), null);
  assert.strictEqual(g.admit('203.0.113.3'), null);
  assert.strictEqual(g.admit('203.0.113.4'), null);
  assert.strictEqual(g.admit('203.0.113.5'), 'busy');
  t += 1000;
  assert.strictEqual(g.admit('203.0.113.5'), null);
});

test('AddressGuard: exempt addresses are never counted', () => {
  const g = new AddressGuard({ openPerAddress: 1 });
  for (let i = 0; i < 10; i++) assert.strictEqual(g.admit('127.0.0.1'), null);
  for (let i = 0; i < 10; i++) assert.strictEqual(g.admit(undefined), null);
});

// --- MessageBudget / WindowCounter --------------------------------------------------

test('MessageBudget: a burst passes, a flood is dropped then kicked, a pause refills', () => {
  let t = 0;
  const b = new MessageBudget({ now: () => t, capacity: 10, perSecond: 10, kickAfter: 5 });
  for (let i = 0; i < 10; i++) assert.strictEqual(b.take(), 'ok');
  for (let i = 0; i < 5; i++) assert.strictEqual(b.take(), 'drop');
  assert.strictEqual(b.take(), 'kick');
  t += 1000;
  assert.strictEqual(b.take(), 'ok');
});

test('MessageBudget: normal play never drops', () => {
  let t = 0;
  const b = new MessageBudget({ now: () => t });
  // The intent cap's worst case: 20 intents every 100 ms turn, for a minute.
  for (let turn = 0; turn < 600; turn++) {
    for (let i = 0; i < 20; i++) assert.strictEqual(b.take(), 'ok');
    t += 100;
  }
});

test('WindowCounter: limits per key per window', () => {
  let t = 0;
  const w = new WindowCounter({ now: () => t, max: 2, windowMs: 1000 });
  assert.strictEqual(w.hit('a'), true);
  assert.strictEqual(w.hit('a'), true);
  assert.strictEqual(w.hit('a'), false);
  assert.strictEqual(w.hit('b'), true);
  t += 1000;
  assert.strictEqual(w.hit('a'), true);
});

// --- GameManager ---------------------------------------------------------------------

function fakeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.raw = [];
  ws.send = (s) => ws.raw.push(s);
  ws.close = () => { ws.readyState = 3; };
  ws.errors = () => ws.raw.map((s) => JSON.parse(s)).filter((m) => m.type === 'error').map((m) => m.error);
  return ws;
}

function setup() {
  const manager = new GameManager({});
  function connect(ip) {
    const ws = fakeSocket();
    manager.handleConnection(ws, ip);
    return ws;
  }
  function join(ip, gameID) {
    const ws = connect(ip);
    ws.emit('message', JSON.stringify(Protocol.msg.join(gameID, 'P', 'pid-' + Math.random())));
    return ws;
  }
  function close() {
    for (const game of manager.games.values()) game.end('test over');
    clearInterval(manager._reapIntervalID);
  }
  return { manager, connect, join, close };
}

test('manager: one address is capped per game; others and loopback are not', () => {
  const s = setup();
  const cap = GameManager.MAX_CLIENTS_PER_ADDRESS_PER_GAME;
  for (let i = 0; i < cap; i++) assert.deepStrictEqual(s.join('203.0.113.1', 'G1').errors(), []);
  assert.deepStrictEqual(s.join('203.0.113.1', 'G1').errors(), ['server-busy']);
  assert.deepStrictEqual(s.join('203.0.113.2', 'G1').errors(), []);
  assert.deepStrictEqual(s.join('127.0.0.1', 'G1').errors(), []);
  assert.deepStrictEqual(s.join(undefined, 'G1').errors(), []);
  s.close();
});

test('manager: one address is capped on lobbies it started', () => {
  const s = setup();
  const cap = GameManager.MAX_LOBBIES_PER_ADDRESS;
  for (let i = 0; i < cap; i++) assert.deepStrictEqual(s.join('203.0.113.1', 'L' + i).errors(), []);
  assert.deepStrictEqual(s.join('203.0.113.1', 'Lx').errors(), ['server-busy']);
  assert.strictEqual(s.manager.getGame('Lx'), null);
  // Joining a lobby someone else started is not starting one.
  assert.deepStrictEqual(s.join('203.0.113.1', 'L0').errors(), []);
  assert.deepStrictEqual(s.join('203.0.113.2', 'Ly').errors(), []);
  s.close();
});

test('manager: rejoins are rate limited per address', () => {
  const s = setup();
  s.join('203.0.113.9', 'G1');
  s.manager.getGame('G1').start({ seed: 1 });
  const cap = GameManager.MAX_REJOINS_PER_ADDRESS_PER_MINUTE;
  for (let i = 0; i < cap; i++) {
    const ws = s.connect('203.0.113.1');
    ws.emit('message', JSON.stringify(Protocol.msg.rejoin('G1', 0, 'pid')));
    assert.deepStrictEqual(ws.errors(), []);
  }
  const over = s.connect('203.0.113.1');
  over.emit('message', JSON.stringify(Protocol.msg.rejoin('G1', 0, 'pid')));
  assert.deepStrictEqual(over.errors(), ['server-busy']);
  s.close();
});

test('manager: a socket that never sends a first message is closed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  const ws = s.connect('203.0.113.1');
  t.mock.timers.tick(9 * 1000);
  assert.strictEqual(ws.readyState, 1);
  t.mock.timers.tick(2 * 1000);
  assert.strictEqual(ws.readyState, 3);
  assert.deepStrictEqual(ws.errors(), ['timeout']);
  s.close();
});

test('manager: a flooding socket is dropped, a normal one is not', () => {
  const s = setup();
  const ws = s.join('203.0.113.1', 'G1');
  ws.terminate = () => { ws.readyState = 3; };
  const ping = JSON.stringify(Protocol.msg.ping());
  for (let i = 0; i < 100; i++) ws.emit('message', ping);
  assert.strictEqual(ws.readyState, 1);
  for (let i = 0; i < 2000; i++) ws.emit('message', ping);
  assert.strictEqual(ws.readyState, 3);
  s.close();
});

// A real socket: ws emits 'error' before closing on a bad frame, and with no
// listener that used to throw out of the process.
test('manager: a malformed or oversized frame closes the socket without throwing', async () => {
  const s = setup();
  const server = http.createServer();
  const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 1024 });
  wss.on('connection', (ws) => s.manager.handleConnection(ws, '203.0.113.1'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'ws://127.0.0.1:' + server.address().port + '/ws';

  const closed = (client) => new Promise((resolve) => {
    client.on('error', () => {});
    client.on('close', resolve);
  });

  const bad = new WebSocket(url);
  const badClosed = closed(bad);
  bad.on('open', () => bad._socket.write(Buffer.from([0xFF, 0x80, 0, 0, 0, 0])));
  await badClosed;

  const big = new WebSocket(url);
  const bigClosed = closed(big);
  big.on('open', () => big.send('x'.repeat(4096)));
  await bigClosed;

  for (const c of wss.clients) c.terminate();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => server.close(r));
  s.close();
});
