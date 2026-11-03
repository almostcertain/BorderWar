// Admin live watch: GameManager.mintWatchTicket and the observer connection.
// cd server && npm test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const GameManager = require('./gamemanager');
const GameServer = require('./gameserver');
const Protocol = require('../js/net/protocol.js');

function fakeSocket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.raw = [];
  ws.send = (s) => ws.raw.push(s);
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  ws.of = (type) => ws.raw.map((s) => JSON.parse(s)).filter((m) => m.type === type);
  return ws;
}

function setup() {
  const manager = new GameManager();
  function connect(msg) {
    const ws = fakeSocket();
    manager.handleConnection(ws);
    ws.emit('message', JSON.stringify(msg));
    return ws;
  }
  const join = (gameID, name, pid) => connect(Protocol.msg.join(gameID, name, pid));
  const watch = (gameID, ticket) => connect(Protocol.msg.join(gameID, 'watch:' + ticket, 'p-watch'));
  function close() {
    for (const game of manager.games.values()) game.end('test over');
    clearInterval(manager._reapIntervalID);
  }
  return { manager, join, watch, close };
}

test('watch: no ticket for a lobby or an unknown game', () => {
  const s = setup();
  s.join('G1', 'Ada', 'p-a');
  assert.strictEqual(s.manager.mintWatchTicket('G1'), null);
  assert.strictEqual(s.manager.mintWatchTicket('NOPE'), null);
  s.close();
});

test('watch: an observer gets the log and new turns but is not a client', () => {
  const s = setup();
  const a = s.join('G1', 'Ada', 'p-a');
  s.join('G1', 'Bob', 'p-b');
  const game = s.manager.getGame('G1');
  game.start({ seed: 7 });
  game.endTurn();

  const ticket = s.manager.mintWatchTicket('G1');
  assert.ok(ticket);
  const w = s.watch('G1', ticket);
  const start = w.of('start')[0];
  assert.strictEqual(start.myClientID, GameServer.OBSERVER_CLIENT_ID);
  assert.strictEqual(start.turns.length, 1);
  assert.strictEqual(start.gameStartInfo.players.length, 2);

  game.endTurn();
  assert.strictEqual(w.of('turn').length, 1);

  // Invisible: no roster slot, not counted, no hash vote, nothing sent to players.
  assert.strictEqual(game.clients.size, 2);
  assert.strictEqual(game.observers.size, 1);
  assert.strictEqual(a.of('lobby_info').every((m) => m.lobby.players.length <= 2), true);
  assert.strictEqual(JSON.stringify(a.raw).includes('watch'), false);

  w.emit('message', JSON.stringify(Protocol.msg.ping()));
  assert.strictEqual(w.of('ping').length, 1);

  w.close();
  assert.strictEqual(game.observers.size, 0);
  s.close();
});

test('watch: a ticket is only good for its own game, and a forged one is refused', () => {
  const s = setup();
  for (const id of ['G1', 'G2']) {
    s.join(id, 'Ada', 'p-' + id);
    s.join(id, 'Bob', 'p-b' + id);
    s.manager.getGame(id).start({ seed: 7 });
  }
  const ticket = s.manager.mintWatchTicket('G1');

  const wrongGame = s.watch('G2', ticket);
  assert.strictEqual(wrongGame.of('error')[0].error, 'bad-watch-ticket');
  assert.strictEqual(s.manager.getGame('G2').observers.size, 0);

  const forged = s.watch('G1', 'f'.repeat(32));
  assert.strictEqual(forged.of('error')[0].error, 'bad-watch-ticket');
  assert.strictEqual(s.manager.getGame('G1').observers.size, 0);
  s.close();
});

test('watch: an expired ticket is refused', () => {
  const s = setup();
  s.join('G1', 'Ada', 'p-a');
  s.join('G1', 'Bob', 'p-b');
  s.manager.getGame('G1').start({ seed: 7 });
  const ticket = s.manager.mintWatchTicket('G1');
  s.manager._watchTickets.get(ticket).expires = Date.now() - 1;
  assert.strictEqual(s.watch('G1', ticket).of('error')[0].error, 'bad-watch-ticket');
  s.close();
});
