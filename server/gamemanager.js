// GameManager — gameID -> GameServer, per docs/multiplayer-architecture.md §6:
// "Single Node process. GameManager holds gameID -> GameServer. OpenFront's
// master/worker sharding (Master.ts, Worker.ts) is a scale-out concern; note
// the seam (GameManager is the shard boundary) and skip it."
//
// MP-2.2: replaces MP-2.1's PlaceholderGame (one hardcoded 'default' lobby,
// no message parsing) with real join-based routing. A fresh connection's
// first message must be a `join` (or, best-effort, a `rejoin` — see the long
// comment on GameServer.rejoinClient for the identity gap that leaves open)
// — parsed and validated with Protocol.validateMessage *before* anything else
// touches it. Anything else as a first message (garbage JSON, wrong type,
// fails validation) closes the connection cleanly with a Protocol.msg.error
// and never crashes the process.
'use strict';

const Protocol = require('../js/net/protocol.js');
const Client = require('./client');
const GameServer = require('./gameserver');
const log = require('./log');

// How often the periodic sweep below runs. This is the "periodically" half
// of the reap requirement (the other half — reap on disconnect — happens
// immediately, inline, in _wire's close handler). 5s is arbitrary and cheap:
// this loop is O(games), and there are never many concurrent games on a
// self-hosted box (§6.1).
const REAP_INTERVAL_MS = 5000;

// How often the heartbeat line prints, and only while a match is ACTIVE.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

class GameManager {
  // A ceiling on concurrently-existing games (LOBBY/ACTIVE combined —
  // FINISHED ones are reaped promptly and don't count). §6.1's own framing
  // ("never many concurrent games on a self-hosted box") was true by
  // assumption while nothing but the developer could reach this server;
  // once it's reachable from the open internet, a flood of `join`s each
  // naming a fresh gameID would otherwise grow this Map without bound —
  // each entry is cheap, but not free, and this server has no other backstop
  // for that. 100 is generous headroom over anything "low traffic" implies,
  // while still being a real ceiling rather than no ceiling at all. Joining
  // an *existing* lobby is never affected — see the check's own comment.
  static MAX_CONCURRENT_GAMES = 100;

  constructor() {
    this.games = new Map(); // gameID -> GameServer

    // unref() so this timer alone never keeps a Node process (or a test
    // script) alive — it's a housekeeping sweep, not load-bearing work.
    this._reapIntervalID = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    if (typeof this._reapIntervalID.unref === 'function') this._reapIntervalID.unref();
  }

  createGame(gameID) {
    if (this.games.has(gameID)) return this.games.get(gameID);
    const game = new GameServer(gameID);
    this.games.set(gameID, game);
    log.info('game ' + gameID, 'lobby created');
    return game;
  }

  // Periodic "still alive" line, printed only while at least one match is
  // ACTIVE so an idle server stays quiet. Started by server/index.js once the
  // port is bound; unref'd like the reap timer.
  startHeartbeat() {
    const id = setInterval(() => {
      let active = 0, players = 0, turn = 0;
      for (const game of this.games.values()) {
        if (game.stage !== Protocol.GAME_PHASE.ACTIVE) continue;
        active++;
        for (const c of game.clients.values()) if (c.active && !c.spectator) players++;
        turn = Math.max(turn, game.turns.length);
      }
      if (active === 0) return;
      log.info('server', 'heartbeat: ' + active + ' active game' + (active === 1 ? '' : 's')
        + ', ' + players + ' player' + (players === 1 ? '' : 's') + ', turn ' + turn);
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof id.unref === 'function') id.unref();
    this._heartbeatIntervalID = id;
  }

  getGame(gameID) {
    return this.games.get(gameID) || null;
  }

  removeGame(gameID) {
    this.games.delete(gameID);
  }

  // Reap FINISHED games and empty LOBBY-phase games. Called immediately on
  // every disconnect (see _wire) and periodically by the interval above, so
  // both "call end() and it goes away shortly after" and "everyone
  // disconnects from a lobby and it goes away immediately" are covered.
  reap() {
    for (const [gameID, game] of this.games) {
      if (game.stage === Protocol.GAME_PHASE.FINISHED) {
        this.games.delete(gameID);
        log.info('game ' + gameID, 'reaped (finished)');
      } else if (game.stage === Protocol.GAME_PHASE.LOBBY && game.clients.size === 0) {
        this.games.delete(gameID);
        log.info('game ' + gameID, 'reaped (empty lobby)');
      }
    }
  }

  // Entry point from server/index.js: a freshly-upgraded WebSocket, nothing
  // parsed yet. Waits for exactly one message and routes off it.
  handleConnection(ws) {
    ws.once('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        log.warn('server', 'rejected connection: first message was not valid JSON');
        Client.closeWithError(ws, 'bad-json', 'First message must be valid JSON.');
        return;
      }

      const err = Protocol.validateMessage(msg, 'c2s');
      if (err) {
        log.warn('server', 'rejected connection: invalid first message (' + err + ')');
        Client.closeWithError(ws, 'bad-first-message', err);
        return;
      }
      if (msg.type !== 'join' && msg.type !== 'rejoin') {
        log.warn('server', 'rejected connection: first message was "' + msg.type + '", not join/rejoin');
        Client.closeWithError(ws, 'bad-first-message',
          'first message must be "join" or "rejoin", got "' + msg.type + '"');
        return;
      }

      if (msg.type === 'rejoin') {
        const game = this.getGame(msg.gameID);
        if (!game) {
          log.warn('game ' + msg.gameID, 'rejected rejoin: no such game');
          Client.closeWithError(ws, 'no-such-game', 'Game "' + msg.gameID + '" does not exist.');
          return;
        }
        // rejoinClient may itself close the connection (nothing-to-rejoin);
        // a null return means it already did, and there is nothing to wire.
        const clientID = game.rejoinClient(ws, msg.lastTurn);
        if (clientID === null) return;
        this._wire(game, ws, clientID);
        return;
      }

      // join
      if (!this.games.has(msg.gameID) && this.games.size >= GameManager.MAX_CONCURRENT_GAMES) {
        // Gates only the creation of a brand-new lobby — joining one that
        // already exists is never blocked by this, no matter how many other
        // games are running, since it adds one client to an existing
        // Map entry rather than a new one. See MAX_CONCURRENT_GAMES' own
        // comment for why this exists at all now.
        log.warn('server', 'rejected join to "' + msg.gameID + '": at the '
          + GameManager.MAX_CONCURRENT_GAMES + '-game limit');
        Client.closeWithError(ws, 'server-busy', 'Too many games in progress. Try again shortly.');
        return;
      }
      const game = this.createGame(msg.gameID);
      const client = new Client(ws);
      const clientID = game.joinClient(client, { username: msg.username, spectator: msg.spectator });
      if (clientID === null) return; // joinClient already closed/errored it (mid-game join)
      this._wire(game, ws, clientID);
    });
  }

  // Everything after the first message: dispatch subsequent client->server
  // messages to the game, and remove the client from the roster (without
  // touching the turn loop or any other client) on disconnect.
  _wire(game, ws, clientID) {
    ws.on('message', (raw) => this._handleMessage(game, clientID, raw));
    ws.on('close', () => {
      game.removeClient(clientID);
      this.reap();
    });
  }

  _handleMessage(game, clientID, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // malformed post-join traffic: dropped silently, never crashes
    }
    if (Protocol.validateMessage(msg, 'c2s') !== null) return; // grammar-only rejection (MP-4.3 scope)

    const client = game.clients.get(clientID);
    if (!client) return; // disconnected between the event queue and now

    // MP-3.4 liveness: any inbound message at all proves the connection is
    // alive, not just the dedicated 5s `ping` below — a client mid-`intent`
    // is obviously connected even if its next scheduled ping hasn't fired
    // yet, and trusting every message type is more robust than trusting only
    // the heartbeat. GameServer's timeout sweep reads `lastPing` against
    // Protocol's 30s window; `isAlive` is reset here too so a client that had
    // already been marked timed-out (and had a synthesized disconnect intent
    // injected for it — see GameServer._sweepLiveness) doesn't keep looking
    // disconnected forever if traffic from it resumes. That does not undo the
    // disconnect already applied to the sim (MP-4.1's job, not this one's) —
    // it only stops the roster bookkeeping from re-flagging a client the
    // sweep has already finished processing.
    client.isAlive = true;
    client.lastPing = Date.now();

    switch (msg.type) {
      case 'intent':
        game.handleIntent(msg.intent, client);
        break;
      case 'start_game':
        // MP-2.3: the one new per-connection message this task adds. All the
        // actual logic (creator check, LOBBY-stage check, error reply) lives
        // in GameServer.handleStartGame (server/gameserver.js) — this is
        // pure dispatch, exactly like the 'intent' case above, and is the
        // minimum possible touch to this file to make that message reachable
        // at all (this switch is the only place a per-connection message
        // ever reaches a GameServer instance).
        game.handleStartGame(msg.config, client);
        break;
      case 'ping':
        // MP-3.4: the liveness update above is the whole handler — a `ping`
        // carries no other payload and needs no reply beyond the server's
        // own outbound `ping` (Transport handles that independently). Split
        // out from hash/winner below so this case's comment doesn't have to
        // keep disclaiming two unrelated future tasks.
        break;
      case 'hash':
        // MP-4.2: record this client's reported hash for the turn it names;
        // GameServer.endTurn drives the actual tally every HASH_INTERVAL
        // turns (GameServer._tallyHashes) once enough round trips have
        // passed for reports to have arrived.
        game.recordHash(msg.turnNumber, msg.hash, client);
        break;
      case 'winner':
        // MP-3.5: split out from the former shared hash/winner no-op case,
        // the same way 'ping' was split out in MP-3.4 (see that case's own
        // comment) — this one now has real behavior (GameServer.recordWinnerVote)
        // and no longer needs to share a case whose comment used to disclaim
        // two unrelated future tasks.
        game.recordWinnerVote(msg.winner, client);
        break;
      case 'join':
      case 'rejoin':
        // Already joined on this connection; this task has no concept of a
        // second join/rejoin mid-connection, so it's dropped rather than
        // acted on.
        break;
      default:
        break;
    }
  }
}

module.exports = GameManager;
