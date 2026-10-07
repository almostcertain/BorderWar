// GameManager: gameID -> GameServer (docs/multiplayer-architecture.md §6).
// Single Node process; GameManager is the seam where sharding would go.
// A connection's first message must be a valid `join` or `rejoin`; anything
// else closes it cleanly with a Protocol.msg.error and never crashes the process.
'use strict';

const Protocol = require('../js/net/protocol.js');
const Client = require('./client');
const GameServer = require('./gameserver');
const log = require('./log');

// How often the periodic reap runs (reap also runs inline on disconnect).
const REAP_INTERVAL_MS = 5000;

// How often the heartbeat line prints, and only while a match is ACTIVE.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Rotating open lobbies: one entry per map size, cycled in order.
// `maxNations` is total Nation slots (bots + humans). small is excluded as
// too cramped. Counts match the singleplayer defaults for each size
// (js/main.js's BOTS_FOR_SIZE/TRIBES_FOR_SIZE).
const AUTO_LOBBY_ROTATION = [
  { mapSize: 'medium', maxNations: 46, tribes: 225 },
  { mapSize: 'large', maxNations: 82, tribes: 400 }
];
const AUTO_LOBBY_DIFFICULTY = 'medium';

class GameManager {
  // Ceiling on concurrent LOBBY/ACTIVE games, so a flood of `join`s naming
  // fresh gameIDs can't grow the Map without bound. Joining an existing
  // lobby is never blocked.
  static MAX_CONCURRENT_GAMES = 100;

  // `opts.buildID`: when set, a join/rejoin must carry this same build id or it
  // is refused with `version-mismatch` (lockstep needs every client on one build).
  constructor(opts) {
    this.buildID = opts && opts.buildID;
    this.games = new Map(); // gameID -> GameServer

    // Set by beginDrain(): the server is about to stop. No new lobbies, no
    // new matches; matches already ACTIVE play out (and can be rejoined).
    this.draining = false;

    // unref() so this timer alone never keeps a Node process (or a test
    // script) alive — it's a housekeeping sweep, not load-bearing work.
    this._reapIntervalID = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    if (typeof this._reapIntervalID.unref === 'function') this._reapIntervalID.unref();

    // Which AUTO_LOBBY_ROTATION entry the next auto lobby uses; wrapped with
    // `%` in _spawnAutoLobby.
    this._autoLobbyRotationIndex = 0;
    this._spawnAutoLobby();
  }

  // Create the one open, host-less public lobby this server always keeps
  // available. Fresh gameID every time, so a stale cached join code can't
  // land in a different lobby.
  _spawnAutoLobby() {
    if (this.draining) return;
    const entry = AUTO_LOBBY_ROTATION[this._autoLobbyRotationIndex % AUTO_LOBBY_ROTATION.length];
    this._autoLobbyRotationIndex++;

    const gameID = 'OPEN-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const game = new GameServer(gameID);
    game.configureAutoLobby({
      mapSize: entry.mapSize,
      tribes: entry.tribes,
      difficulty: AUTO_LOBBY_DIFFICULTY,
      maxNations: entry.maxNations
    }, () => this._onAutoLobbyStarted(gameID));
    this.games.set(gameID, game);
    log.info('game ' + gameID, 'open rotating lobby created (' + entry.mapSize + ', up to '
      + entry.maxNations + ' players)');
  }

  // The auto lobby just started: spawn its replacement so one open lobby is
  // always waiting. The started game stays in `this.games` untouched.
  _onAutoLobbyStarted(oldGameID) {
    log.info('game ' + oldGameID, 'open lobby started - rotating in a replacement');
    this._spawnAutoLobby();
  }

  // Stop taking new games ahead of a shutdown (server/index.js drain()).
  // Every lobby is closed with a message, the open lobby included, and from
  // here on a `join` is refused. ACTIVE matches are left alone. One-way.
  beginDrain() {
    if (this.draining) return;
    this.draining = true;
    for (const [gameID, game] of this.games) {
      if (game.stage !== Protocol.GAME_PHASE.LOBBY) continue;
      const sockets = Array.from(game.clients.values(), (c) => c.ws);
      game.end('server draining'); // FINISHED first, so the closes below don't advance the lobby
      this.games.delete(gameID);
      for (const ws of sockets) Client.closeWithError(ws, GameManager.RESTARTING_ERROR, GameManager.RESTARTING_MESSAGE);
      log.info('game ' + gameID, 'lobby closed (server draining)');
    }
  }

  activeGameCount() {
    let n = 0;
    for (const game of this.games.values()) if (game.stage === Protocol.GAME_PHASE.ACTIVE) n++;
    return n;
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

  // Backs GET /lobbies: only public LOBBY-stage games. Host name is the
  // creator's username, falling back to 'Host'.
  listPublicLobbies() {
    const out = [];
    for (const game of this.games.values()) {
      if (!game.isPublic || game.stage !== Protocol.GAME_PHASE.LOBBY) continue;

      // An auto lobby has no human host, so the Join screen gets map/slot info
      // and a countdown instead. entry.host stays undefined so js/ui.js's
      // renderPublicLobbies can tell the two kinds apart.
      const entry = { gameID: game.gameID, playerCount: game.clients.size, isAuto: !!game.isAutoLobby };
      if (game.isAutoLobby) {
        entry.mapSize = game.autoConfig.mapSize;
        // No seed here: auto games run with fog, so the menu must not preview the map.
        entry.minPlayers = GameServer.autoLobbyMinPlayers;
        entry.maxPlayers = game.autoConfig.maxNations;
        entry.autoStartAt = game._autoStartAt; // null while no countdown is running
      } else {
        const host = game.clients.get(game.creatorClientId);
        entry.host = (host && host.username) || 'Host';
      }
      out.push(entry);
    }
    return out;
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
      } else if (game.stage === Protocol.GAME_PHASE.LOBBY && game.clients.size === 0 && !game.isAutoLobby) {
        // An auto lobby is meant to sit open and empty, so it is exempt from
        // the empty-lobby reap.
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

      if (this.buildID && msg.build !== this.buildID) {
        log.warn('server', 'rejected ' + msg.type + ': client build ' + msg.build + ' != server build ' + this.buildID);
        Client.closeWithError(ws, 'version-mismatch',
          'BorderWar has been updated. Refresh the page (Ctrl+Shift+R) to play.');
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
      if (this.draining) {
        log.warn('server', 'rejected join to "' + msg.gameID + '": server draining');
        Client.closeWithError(ws, GameManager.RESTARTING_ERROR, GameManager.RESTARTING_MESSAGE);
        return;
      }
      if (!this.games.has(msg.gameID) && this.games.size >= GameManager.MAX_CONCURRENT_GAMES) {
        // Gates only the creation of a new lobby; see MAX_CONCURRENT_GAMES.
        log.warn('server', 'rejected join to "' + msg.gameID + '": at the '
          + GameManager.MAX_CONCURRENT_GAMES + '-game limit');
        Client.closeWithError(ws, 'server-busy', 'Too many games in progress. Try again shortly.');
        return;
      }
      const game = this.createGame(msg.gameID);
      const client = new Client(ws);
      const clientID = game.joinClient(client, { username: msg.username, spectator: msg.spectator, public: msg.public });
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

    // Liveness: any inbound message proves the connection is alive, not
    // just `ping`. GameServer's sweep reads `lastPing`. Resetting `isAlive`
    // stops the roster re-flagging a client whose traffic resumes; it does
    // not undo a disconnect already applied to the sim.
    client.isAlive = true;
    client.lastPing = Date.now();

    switch (msg.type) {
      case 'intent':
        game.handleIntent(msg.intent, client);
        break;
      case 'start_game':
        // Pure dispatch; the creator and stage checks live in
        // GameServer.handleStartGame.
        game.handleStartGame(msg.config, client);
        break;
      case 'ping':
        // The liveness update above is the whole handler. The echo only lets
        // the client time the round trip for its ping readout; the client drops
        // it before the sim sees it.
        try { client.ws.send(JSON.stringify(Protocol.msg.ping())); } catch (e) { /* socket closing */ }
        break;
      case 'hash':
        // Record the hash; GameServer.endTurn tallies every HASH_INTERVAL turns.
        game.recordHash(msg.turnNumber, msg.hash, client);
        break;
      case 'winner':
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

// What a player is told when the server is draining or stopping. The client
// (js/net/transport.js, js/main.js) keys off the error code.
GameManager.RESTARTING_ERROR = 'server-restarting';
GameManager.RESTARTING_MESSAGE = 'The server is restarting for an update. Try again in a few minutes.';

module.exports = GameManager;
