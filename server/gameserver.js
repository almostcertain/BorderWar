// GameServer: lobby, intent relay and turn loop (docs/multiplayer-architecture.md §6).
// THE SERVER NEVER SIMULATES: this file never requires js/game/*, js/ai.js,
// js/map.js, Runner or Executor. It buckets intents into turns and relays them.
'use strict';

const Protocol = require('../js/net/protocol.js');
const Client = require('./client');
const log = require('./log');

// A player's name for log lines. Usernames come straight off the wire, so
// control characters (a newline would forge a log line) are stripped and the
// length capped.
function who(client) {
  const name = String(client.username).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32);
  return name + ' (#' + client.clientID + ')';
}

// How often the ACTIVE-phase liveness sweep runs (see _sweepLiveness).
const LIVENESS_SWEEP_INTERVAL_MS = 3000;

// Per-client intent cap per turn window, reset every endTurn(). Stops
// malformed or flooding traffic; it is not a security control (D2).
const MAX_INTENTS_PER_CLIENT_PER_TURN = 20;

class GameServer {
  constructor(gameID) {
    this.gameID = gameID;
    this._tag = 'game ' + gameID; // log prefix
    this._startedAt = null;       // Date.now() when start() ran, for the end-of-game duration

    // Protocol.GAME_PHASE.{LOBBY, ACTIVE, FINISHED} — reused from protocol.js
    // rather than redefined here (§9 MP-2.2: "Protocol.GAME_PHASE already has
    // {LOBBY, ACTIVE, FINISHED} — use it, don't redefine it").
    this.stage = Protocol.GAME_PHASE.LOBBY;

    // clientID (string) -> Client, in join order (Map insertion order).
    // start() relies on that order when building gameStartInfo.players.
    this.clients = new Map();

    // The full turn log. NEVER pruned — sendStartGameMsg-equivalent catch-up
    // (rejoinClient) and the eventual game record both read the whole thing.
    this.turns = [];

    // Current turn's intent buffer, cleared by endTurn.
    this.intents = [];

    // Sequential counter assigned in join order, stringified for the wire
    // (every clientID field in protocol.js is typed 'str').
    this.nextClientId = 0;

    // Built by start(); null until then. Kept (not just used and discarded)
    // because rejoinClient's catch-up `start` message needs the exact same
    // object every client already has.
    this.gameStartInfo = null;

    // The lobby creator: the first client to join, set once in joinClient.
    // No transfer-host mechanic: if the creator leaves before starting,
    // nobody can start the lobby (accepted v1 limitation).
    this.creatorClientId = null;

    // Whether this lobby is listed in GET /lobbies. Set only from the
    // creator's own `join.public`, so a later joiner can't flip it.
    this.isPublic = false;

    // Rotating open lobbies: set once by configureAutoLobby(), before any
    // client can join. An auto lobby is always public and runs the
    // min-players/countdown/fill-up logic in _maybeAdvanceAutoLobby.
    // autoConfig is { mapSize, tribes, difficulty, maxNations }; maxNations is
    // total Nation slots, and each human takes one a bot would otherwise fill.
    this.isAutoLobby = false;
    this.autoConfig = null;
    // Called once, from start(), the moment this auto lobby actually starts
    // — GameManager uses it to spawn the replacement lobby (the "rotating"
    // half of this feature). Never set for a manually-hosted lobby.
    this._onAutoStart = null;
    // Countdown-to-start setTimeout id and the epoch ms it fires at (sent to
    // clients for the Join screen's countdown). Both null when not running.
    this._autoStartTimerID = null;
    this._autoStartAt = null;

    this._turnIntervalID = null;

    // MP-3.4: the ACTIVE-phase ping-timeout sweep, started/stopped alongside
    // the turn interval in start()/end() — see _sweepLiveness.
    this._livenessIntervalID = null;

    // When an ACTIVE match last had no connected player, or null while anyone
    // is connected. Drives the abandoned-match cleanup in _sweepLiveness.
    this._emptySince = null;

    // MP-3.5: clientID -> winnerId, one vote per client. See recordWinnerVote.
    this.winnerVotes = new Map();

    // turnNumber -> Map(clientID -> hash) for turns with an outstanding
    // tally. _tallyHashes deletes the entry, so this never grows unbounded.
    this.hashReports = new Map();

    // Clients already sent a `desync` message, so each is told once per match.
    this.desyncFlagged = new Set();

    // Highest turn _tallyHashes has resolved. recordHash drops reports for
    // turns at or below it, so a straggler can't start an entry that never clears.
    this._hashTalliedThrough = -1;
  }

  // --- Roster ------------------------------------------------------------

  // `client` is an already-constructed Client(ws); `opts` is
  // { username, spectator } from the validated `join` message. Rejects once
  // the game has left LOBBY. A spectator gets a roster slot and receives
  // turns but is left out of gameStartInfo.players (see start()).
  joinClient(client, opts) {
    opts = opts || {};

    if (this.stage !== Protocol.GAME_PHASE.LOBBY) {
      log.warn(this._tag, 'rejected join from "' + String(opts.username).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32)
        + '": game already started');
      Client.closeWithError(client.ws, 'game-already-started',
        'Game "' + this.gameID + '" has already left the lobby; no mid-game joins (MP-2.2 scope — see MP-3.4/4.1 for later join/reconnect work).');
      return null;
    }

    const numericId = this.nextClientId++;
    const clientID = String(numericId);
    client.clientID = clientID;
    client.username = opts.username;
    client.spectator = !!opts.spectator;
    client.active = true;
    this.clients.set(clientID, client);

    // First successful joiner becomes the creator/host. An auto lobby has
    // no host and stays public whatever a joiner's join.public says.
    if (this.creatorClientId === null) {
      this.creatorClientId = clientID;
      if (!this.isAutoLobby) this.isPublic = !!opts.public;
    }

    log.info(this._tag, who(client) + ' joined'
      + (client.spectator ? ' as spectator' : '')
      + (clientID === this.creatorClientId && !this.isAutoLobby ? ' (host)' : '')
      + ' - ' + this.clients.size + ' in lobby');
    this._broadcastLobbyInfo();
    this._maybeAdvanceAutoLobby();
    return clientID;
  }

  // Best-effort rejoin: no identity reunification. The `rejoin` message
  // carries a persistentID, but the server keeps no persistentID -> roster
  // mapping and (per D2) could not verify one anyway. So this replies `start`
  // with turns.slice(lastTurn) under a FRESH clientID: the client catches up
  // but does not resume control of its old nation.
  rejoinClient(ws, lastTurn) {
    if (this.stage === Protocol.GAME_PHASE.LOBBY) {
      log.warn(this._tag, 'rejected rejoin: game has not started');
      Client.closeWithError(ws, 'nothing-to-rejoin',
        'Game "' + this.gameID + '" has not started yet — send join, not rejoin.');
      return null;
    }

    const client = new Client(ws);
    const numericId = this.nextClientId++;
    const clientID = String(numericId);
    client.clientID = clientID;
    client.username = 'rejoined-' + clientID;
    client.spectator = false;
    client.active = true;
    this.clients.set(clientID, client);
    log.info(this._tag, who(client) + ' rejoined from turn ' + (Number.isInteger(lastTurn) ? lastTurn : 0));

    const turnNumber = (Number.isInteger(lastTurn) && lastTurn >= 0) ? lastTurn : 0;
    this._send(ws, Protocol.msg.start(this.turns.slice(turnNumber), this.gameStartInfo, clientID));
    return clientID;
  }

  // Remove a connection, or mark it disconnected once a match is ACTIVE.
  // Called on socket close and by _sweepLiveness, so both behave the same.
  // Must never throw.
  //
  // LOBBY and FINISHED: hard-delete, broadcast updated lobby info.
  // ACTIVE: keep the roster entry and hand off to _disconnectClient, which
  // injects a server-authored mark_disconnected(true) intent into the turn
  // stream for every client's Executor to apply.
  removeClient(clientID) {
    const client = this.clients.get(clientID);
    if (!client) return;

    if (this.stage === Protocol.GAME_PHASE.ACTIVE) {
      this._disconnectClient(client, 'connection closed');
      return;
    }

    client.active = false;
    this.clients.delete(clientID);
    log.info(this._tag, who(client) + ' left - ' + this.clients.size + ' in lobby');
    // Roster-changed broadcast (MP-2.3). _broadcastLobbyInfo no-ops once the
    // game has left LOBBY, so this is a no-op for a FINISHED-phase removal.
    this._broadcastLobbyInfo();
    // A departure can drop an auto lobby below its min-player threshold,
    // which must cancel an in-flight countdown.
    this._maybeAdvanceAutoLobby();
  }

  // The one place that marks a client disconnected during an active match.
  // Idempotent: `client.active` goes false here and a second call is a no-op.
  _disconnectClient(client, reason) {
    if (!client.active) return;
    client.active = false;
    log.info(this._tag, who(client) + ' disconnected (' + reason + ')');

    const intent = Protocol.stamp(Protocol.intent.markDisconnected(true), client.clientID);
    this.intents.push(intent);
  }

  // Periodic ping-timeout sweep. The interval only runs while ACTIVE, so
  // there is no stage check here. Already-disconnected clients are skipped.
  _sweepLiveness() {
    const now = Date.now();
    let anyActive = false;
    for (const client of this.clients.values()) {
      if (!client.active) continue;
      if (now - client.lastPing > GameServer.disconnectedTimeout) {
        this._disconnectClient(client, 'timed out, no ping for '
          + Math.round(GameServer.disconnectedTimeout / 1000) + 's');
      } else {
        anyActive = true;
      }
    }

    // A match with nobody connected would tick empty turns forever. Give
    // people a window to reconnect, then end it; GameManager.reap() removes
    // FINISHED games.
    if (anyActive) {
      this._emptySince = null;
    } else if (this._emptySince === null) {
      this._emptySince = now;
    } else if (now - this._emptySince > GameServer.abandonedTimeout) {
      this.end('abandoned, nobody connected for '
        + Math.round(GameServer.abandonedTimeout / 1000) + 's');
    }
  }

  // --- Intents -------------------------------------------------------------

  // Grammar-only validation (Protocol.validateIntent); the server cannot
  // check legality. Protocol.stamp then overwrites clientID with this
  // connection's server-assigned one, so a client cannot forge authorship.
  handleIntent(rawIntent, client) {
    const err = Protocol.validateIntent(rawIntent);
    if (err) return false; // malformed — dropped silently, never thrown

    // Over the per-turn cap: dropped silently, like a malformed intent.
    if (client.intentsThisTurn >= MAX_INTENTS_PER_CLIENT_PER_TURN) return false;
    client.intentsThisTurn++;

    const stamped = Protocol.stamp(rawIntent, client.clientID);
    this.intents.push(stamped);
    return true;
  }

  // --- Winner vote ------------------------------------------------------------
  //
  // Each client computes Game.winnerId itself and casts it as a vote (§4
  // `winner`); the server tallies a strict majority of active clients.
  // Votes are keyed by clientID, so a resend overwrites rather than counting twice.
  recordWinnerVote(winnerId, client) {
    if (!client || !client.active) return; // stale/disconnected vote — never counts

    this.winnerVotes.set(client.clientID, winnerId);

    // Tally against CURRENTLY active clients on every vote, so a client that
    // disconnects after voting leaves both the numerator and the denominator.
    const activeClients = Array.from(this.clients.values()).filter(c => c.active);
    if (activeClients.length === 0) return;

    const counts = new Map();
    for (const c of activeClients) {
      const v = this.winnerVotes.get(c.clientID);
      if (v === undefined) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }

    const majority = activeClients.length / 2;
    for (const [winner, count] of counts) {
      if (count > majority) {
        // Sim player ids: humans occupy 0..H-1 (see start()); anything higher
        // is an AI nation.
        const human = this.gameStartInfo && this.gameStartInfo.players.find((p) => p.playerId === winner);
        const label = human ? String(human.username).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32) : 'AI nation ' + winner;
        this.end('won by ' + label + ' (' + count + '/' + activeClients.length + ' votes)');
        break;
      }
    }
  }

  // --- Desync detection -------------------------------------------------------
  //
  // Every client reports Hash.compute() every Protocol.HASH_INTERVAL turns.
  // The server cannot know which hash is correct; the plurality among the
  // reports is the only signal.

  // Record one client's hash for one turn. A report for a turn already
  // tallied is dropped (see _hashTalliedThrough).
  recordHash(turnNumber, hash, client) {
    if (!client || !client.active) return;
    if (!Number.isInteger(turnNumber) || turnNumber < 0) return;
    if (turnNumber <= this._hashTalliedThrough) return;

    let reports = this.hashReports.get(turnNumber);
    if (!reports) {
      reports = new Map();
      this.hashReports.set(turnNumber, reports);
    }
    reports.set(client.clientID, hash);
  }

  // Tally the hashes for `turnNumber`. endTurn() calls this HASH_INTERVAL
  // turns after the turn was produced, so every report that is coming has
  // arrived.
  //
  // If the most-reported hash has a STRICT majority of reporting active
  // clients, everyone who reported something else is flagged. With no strict
  // majority, every reporting client is flagged. Each client is told once per
  // match (this.desyncFlagged is never cleared: a diverged client can't recover).
  _tallyHashes(turnNumber) {
    if (turnNumber > this._hashTalliedThrough) this._hashTalliedThrough = turnNumber;

    const reports = this.hashReports.get(turnNumber);
    this.hashReports.delete(turnNumber);
    if (!reports || reports.size === 0) return; // nobody reported — nothing to tally

    // Only ever act against clients still active — a disconnected client's
    // stale report neither counts toward the tally nor can be notified (no
    // live socket), same "active" filter recordWinnerVote already uses.
    const counts = new Map(); // hash value -> count
    let totalReporting = 0;
    for (const [clientID, hash] of reports) {
      const client = this.clients.get(clientID);
      if (!client || !client.active) continue;
      counts.set(hash, (counts.get(hash) || 0) + 1);
      totalReporting++;
    }
    if (totalReporting === 0) return;

    let bestHash = null, bestCount = -1;
    for (const [hash, count] of counts) {
      if (count > bestCount) { bestHash = hash; bestCount = count; }
    }
    const hasStrictMajority = bestCount * 2 > totalReporting;

    for (const [clientID, hash] of reports) {
      const client = this.clients.get(clientID);
      if (!client || !client.active) continue;
      if (this.desyncFlagged.has(clientID)) continue;

      // Normal case (a trusted plurality exists): flag only the clients that
      // disagree with it. Messy case (no strict majority): flag everyone —
      // nobody's hash can be called "correct" over anyone else's.
      const flag = hasStrictMajority ? (hash !== bestHash) : true;
      if (!flag) continue;

      this.desyncFlagged.add(clientID);
      log.warn(this._tag, 'DESYNC: ' + who(client) + ' hash differs at turn ' + turnNumber
        + (hasStrictMajority
          ? ' (' + bestCount + '/' + totalReporting + ' clients agree on the other hash)'
          : ' (no majority among ' + totalReporting + ' clients)'));
      this._send(client.ws, Protocol.msg.desync(
        turnNumber,
        hasStrictMajority ? bestHash : null,
        hasStrictMajority ? bestCount : 0,
        totalReporting,
        hash
      ));
    }
  }

  // --- Lobby (MP-2.3) --------------------------------------------------------

  // Broadcast the roster to everyone while in LOBBY; a no-op afterwards.
  // The `lobby` shape is defined here (protocol.js only checks it is an
  // object): game, host, roster. Spectators are included, unlike in
  // gameStartInfo.players.
  _broadcastLobbyInfo() {
    if (this.stage !== Protocol.GAME_PHASE.LOBBY) return;

    const lobby = {
      gameID: this.gameID,
      creatorClientId: this.creatorClientId,
      players: Array.from(this.clients.values()).map((c) => ({
        clientID: c.clientID,
        username: c.username,
        spectator: c.spectator
      }))
    };

    // Auto-lobby-only fields for the Join screen; omitted for manual lobbies.
    if (this.isAutoLobby) {
      lobby.isAuto = true;
      lobby.mapSize = this.autoConfig.mapSize;
      lobby.seed = this.autoSeed;
      lobby.minPlayers = GameServer.autoLobbyMinPlayers;
      lobby.maxPlayers = this.autoConfig.maxNations;
      lobby.autoStartAt = this._autoStartAt; // null while no countdown is running
    }

    for (const client of this.clients.values()) {
      this._send(client.ws, Protocol.msg.lobbyInfo(lobby, client.clientID));
    }
  }

  // --- Rotating open lobbies --------------------------------------------
  //
  // Called whenever the human roster changes; a no-op for manual lobbies and
  // once the lobby has left LOBBY. Checked in this order because 'full' must
  // beat 'still counting down': at maxNations, start now; at minPlayers,
  // start a one-shot countdown if none is running; below minPlayers, cancel
  // any countdown.
  _maybeAdvanceAutoLobby() {
    if (!this.isAutoLobby || this.stage !== Protocol.GAME_PHASE.LOBBY) return;

    const humanCount = Array.from(this.clients.values()).filter((c) => !c.spectator).length;

    if (humanCount >= this.autoConfig.maxNations) {
      this._clearAutoStartTimer();
      this._startAutoLobby();
      return;
    }
    if (humanCount >= GameServer.autoLobbyMinPlayers) {
      if (this._autoStartTimerID === null) {
        this._autoStartAt = Date.now() + GameServer.autoLobbyCountdownMs;
        this._autoStartTimerID = setTimeout(() => this._startAutoLobby(), GameServer.autoLobbyCountdownMs);
        this._broadcastLobbyInfo(); // tell everyone the countdown just started
      }
    } else {
      this._clearAutoStartTimer();
    }
  }

  // Cancels an in-flight countdown, if any, and tells the lobby so a
  // displayed countdown disappears rather than freezing on a stale value.
  // Idempotent — safe to call whether or not a timer is actually running.
  _clearAutoStartTimer() {
    if (this._autoStartTimerID === null) return;
    clearTimeout(this._autoStartTimerID);
    this._autoStartTimerID = null;
    this._autoStartAt = null;
    this._broadcastLobbyInfo();
  }

  // Fires from the countdown or from the fill-up branch. Re-checks stage
  // and the min-player floor, since both can change before a timer fires; a
  // stale timer must be a silent no-op. AI nation count is computed here:
  // maxNations minus one per human who showed up.
  _startAutoLobby() {
    this._autoStartTimerID = null;
    this._autoStartAt = null;
    if (this.stage !== Protocol.GAME_PHASE.LOBBY) return;

    const humanCount = Array.from(this.clients.values()).filter((c) => !c.spectator).length;
    if (humanCount < GameServer.autoLobbyMinPlayers) return;

    const bots = Math.max(0, this.autoConfig.maxNations - humanCount);
    this.start({
      mapSize: this.autoConfig.mapSize,
      bots: bots,
      tribes: this.autoConfig.tribes,
      difficulty: this.autoConfig.difficulty,
      seed: this.autoSeed,
      fogOfWar: true
    });
  }

  // Called once by GameManager right after constructing an auto lobby,
  // before any client can join. `onStart` is invoked once, from start().
  configureAutoLobby(config, onStart) {
    this.isAutoLobby = true;
    this.isPublic = true;
    this.autoConfig = config;
    // Picked now, not at start(), so the menu can preview the exact map this
    // lobby will play (Math.random is fine here: server-side, outside the sim).
    this.autoSeed = Math.floor(Math.random() * 0x100000000) >>> 0;
    this._onAutoStart = onStart;
  }

  // Handler for the `start_game` message. Two checks: the sender must be
  // the recorded creator and the game must still be in LOBBY. Failures get an
  // `error` message on the still-open connection, never a closed socket.
  handleStartGame(config, client) {
    if (!client || client.clientID !== this.creatorClientId) {
      this._send(client && client.ws, Protocol.msg.error(
        'not-host', 'Only the lobby creator can start the match.'));
      return;
    }
    if (this.stage !== Protocol.GAME_PHASE.LOBBY) {
      this._send(client.ws, Protocol.msg.error(
        'already-started', 'This game has already left the lobby.'));
      return;
    }
    this.start(config);
  }

  // --- Lifecycle -----------------------------------------------------------

  // Build gameStartInfo in the shape LocalServer.start synthesizes:
  // { gameID, seed, config, players: [{ clientID, username, playerId }] }.
  // No LOBBY/creator gate of its own beyond the stage check, so tests can
  // call it directly; real traffic arrives via handleStartGame.
  start(config) {
    if (this.stage !== Protocol.GAME_PHASE.LOBBY) return; // no-op; already started/finished
    config = config || {};

    const seed = Number.isInteger(config.seed)
      ? (config.seed >>> 0)
      : (Math.floor(Math.random() * 0x100000000) >>> 0);

    const players = [];
    for (const client of this.clients.values()) {
      if (client.spectator) continue;
      players.push({
        clientID: client.clientID,
        username: client.username,
        // Roster position, not the clientID counter: Game.init places humans
        // in slots 0..H-1, and clientIDs stop being contiguous the moment
        // anyone leaves and re-joins the lobby.
        playerId: players.length
      });
    }

    this.gameStartInfo = {
      gameID: this.gameID,
      seed: seed,
      config: {
        // Whitelisted like difficulty below: an unrecognized value (or none)
        // is the existing procedural generator, never trusted through as-is.
        map: config.map === 'world' ? 'world' : 'procedural',
        mapSize: config.mapSize || 'medium',
        // The procedural generator's knobs (Protocol.MAP_GEN), whitelisted.
        mapGen: Protocol.normalizeMapGen(config.mapGen),
        bots: Number.isInteger(config.bots) ? config.bots : 0,
        tribes: Number.isInteger(config.tribes) ? config.tribes : 0,
        // Unknown values fall back to Medium in Game.init as well; whitelisted
        // here so the broadcast gameStartInfo only ever carries a real tier.
        difficulty: ['easy', 'medium', 'hard'].includes(config.difficulty) ? config.difficulty : 'medium',
        // Issue #31: team modes, in OpenFront's shape (js/game/teams.js).
        // Whitelisted here too, so every client is handed the same teams.
        gameMode: config.gameMode === 'team' ? 'team' : 'ffa',
        playerTeams: GameServer.normalizePlayerTeams(config.playerTeams),
        // Fog of war (docs/fog-of-war.md): a strict boolean. The auto lobby
        // always turns it on (_startAutoLobby).
        fogOfWar: config.fogOfWar === true
      },
      players: players
    };

    this.stage = Protocol.GAME_PHASE.ACTIVE;
    this._startedAt = Date.now();
    const cfg = this.gameStartInfo.config;
    log.info(this._tag, 'started: ' + players.length + ' player' + (players.length === 1 ? '' : 's')
      + (this.clients.size > players.length ? ' + ' + (this.clients.size - players.length) + ' spectator(s)' : '')
      + ', map ' + (cfg.map === 'world' ? 'world' : cfg.mapSize + ' ' + cfg.mapGen.landform) + ', ' + cfg.bots + ' bots, ' + cfg.tribes + ' tribes, '
      + cfg.difficulty + ' difficulty');
    this._turnIntervalID = setInterval(() => this.endTurn(), Protocol.TURN_INTERVAL_MS);
    // MP-3.4: liveness sweep runs for exactly the ACTIVE-phase lifetime,
    // stopped alongside the turn interval in end() below.
    this._livenessIntervalID = setInterval(() => this._sweepLiveness(), LIVENESS_SWEEP_INTERVAL_MS);

    // `myClientID` is per-recipient — everything else in the message is
    // identical for everyone, so gameStartInfo/turns are built once above and
    // reused for every send.
    for (const client of this.clients.values()) {
      this._send(client.ws, Protocol.msg.start(this.turns, this.gameStartInfo, client.clientID));
    }

    // Tell GameManager this auto lobby started so it can spawn a replacement.
    // Fires once: start() is guarded by its LOBBY-stage check.
    if (this._onAutoStart) this._onAutoStart();
  }

  // §6's four lines, unchanged: snapshot the buffered intents into a turn,
  // push it to the (never-pruned) log, clear the buffer, broadcast.
  endTurn() {
    const pastTurn = Protocol.turn(this.turns.length, this.intents);
    this.turns.push(pastTurn);
    this.intents = [];

    const msg = Protocol.msg.turn(pastTurn);
    for (const client of this.clients.values()) {
      this._send(client.ws, msg);
      // MP-4.3: this turn's window has closed — reset the per-client intent
      // cap (Client.intentsThisTurn) for the next one.
      client.intentsThisTurn = 0;
    }

    // Every HASH_INTERVAL turns, tally the hashes for the turn HASH_INTERVAL
    // turns ago (see _tallyHashes). Skipped for turn 0.
    if (pastTurn.turnNumber > 0 && pastTurn.turnNumber % Protocol.HASH_INTERVAL === 0) {
      this._tallyHashes(pastTurn.turnNumber - Protocol.HASH_INTERVAL);
    }
  }

  // Stop the interval(s) and transition to FINISHED. Idempotent. `reason` is
  // only for the log line.
  end(reason) {
    this._clearAutoStartTimer(); // defensive: never leaves a dangling setTimeout behind
    if (this.stage === Protocol.GAME_PHASE.ACTIVE) {
      const secs = this._startedAt === null ? 0 : Math.round((Date.now() - this._startedAt) / 1000);
      log.info(this._tag, 'ended: ' + (reason || 'ended')
        + ' - ' + Math.floor(secs / 60) + 'm' + String(secs % 60).padStart(2, '0') + 's, '
        + this.turns.length + ' turns');
    }
    if (this._turnIntervalID !== null) {
      clearInterval(this._turnIntervalID);
      this._turnIntervalID = null;
    }
    if (this._livenessIntervalID !== null) {
      clearInterval(this._livenessIntervalID);
      this._livenessIntervalID = null;
    }
    this.stage = Protocol.GAME_PHASE.FINISHED;
  }

  // --- Outbound --------------------------------------------------------------

  // Validated on the way out, as LocalServer._emit does, so a malformed
  // message fails loudly here instead of reaching a client.
  _send(ws, msg) {
    if (Protocol.validateMessage(msg, 's2c') !== null) {
      log.error(this._tag, 'refused to send a malformed message: ' + JSON.stringify(msg));
      return;
    }
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      // Socket died between the readyState check and send() — routine under
      // a flaky connection, not a crash.
    }
  }
}

// How long a client can stay silent before _sweepLiveness treats it as
// disconnected. Static and read at sweep time so tests can lower it.
GameServer.disconnectedTimeout = 30000;

// How long an ACTIVE match may have no connected players before the server
// ends it and lets it be reaped. Static, like disconnectedTimeout, so a test
// can shorten it.
GameServer.abandonedTimeout = 2 * 60 * 1000;

// Rotating open lobbies; static so tests can shorten the countdown. With
// autoLobbyMinPlayers 1, the first human starts the countdown and empty
// slots fill with AI nations when it runs out.
GameServer.autoLobbyMinPlayers = 1;
GameServer.autoLobbyCountdownMs = 20 * 1000;

// Issue #31: OpenFront's TeamCountConfig — a team count, or one of its named
// modes. Mirrors Teams.normalize in js/game/teams.js (which the server does
// not load); anything else becomes 2 teams.
GameServer.normalizePlayerTeams = function (pt) {
  if (['Duos', 'Trios', 'Quads', 'Humans Vs Nations'].includes(pt)) return pt;
  if (Number.isInteger(pt) && pt >= 2 && pt <= 64) return pt;
  return 2;
};

module.exports = GameServer;
