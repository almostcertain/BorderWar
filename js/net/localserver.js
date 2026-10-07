// The singleplayer server (docs/multiplayer-architecture.md §2, §5, §6).
//
// Singleplayer runs THROUGH the multiplayer code path: the client always
// talks to 'a server', and in singleplayer that server is this object, in the
// same page. One game loop, one intent pipeline, one turn queue.
//
// It is not a simulation. Like the real server (§1) it never calls Game.tick
// and never reads Game state; it relays.
//
// `turnsExecuted` is the piece of state that matters: see the backpressure
// note on turnComplete.
//
// Date.now() is allowed here, in the pump's gate only, because that is
// scheduling (when a turn is emitted), not simulation (what is in it).
const LocalServer = {

  // --- Tuning ----------------------------------------------------------------

  // The pump period. Much finer than TURN_INTERVAL_MS: the pump polls the
  // turn clock, so emission lands within 5 ms of its due time and the
  // backpressure gate is re-checked promptly after a slow frame.
  PUMP_INTERVAL_MS: 5,

  // How far ahead of the client the pump may run *during a burst only*
  // (OpenFront's MAX_REPLAY_BACKLOG_TURNS). See burst().
  MAX_REPLAY_BACKLOG_TURNS: 60,

  // --- Connection state ------------------------------------------------------

  // The client's two callbacks, handed over by Transport.connect().
  // `onmessage` is the analogue of a WebSocket's onmessage.
  onconnect: null,
  onmessage: null,

  // Running between start() and stop(). Guards double-start (which would leave
  // an orphaned interval emitting turns into a dead game) and makes stop()
  // idempotent.
  running: false,

  // setInterval handle for the pump.
  _pumpID: null,

  // --- Match state -----------------------------------------------------------

  // The full turn log, retained for the match: a rejoin is fast-forwarded
  // with it and it is the game record. Index i holds turnNumber i, which
  // Runner.addTurn depends on.
  turns: [],

  // Intents accumulated since the last emission, in arrival order. Emptied into
  // the next turn by endTurn. Arrival order IS execution order, on every client;
  // that is why a turn is an ordered list.
  intents: [],

  // How many turns the client has reported finishing, via turnComplete().
  // Compared against turns.length — see endTurn.
  turnsExecuted: 0,

  // Wall clock at the last emission, for the pump's gate. Not simulation time;
  // the sim's clock is its tick count (Game.TICK_DT) and is not visible here.
  turnStartTime: 0,

  // The gameStartInfo synthesized by start(), kept so a rejoin can be answered
  // with the same one. §4's shape.
  gameStartInfo: null,

  // The clientID this server stamps intents with. The literal is the
  // fallback; start() re-reads Executor.LOCAL_CLIENT_ID at call time, so
  // this file's definition does not depend on executor.js having loaded.
  clientID: 'local',

  // Hashes the client has reported, turnNumber -> hash. With one client
  // there is nothing to compare against; they are only recorded.
  hashes: new Map(),

  // Cap on the above. A long match at HASH_INTERVAL 10 is ~1 entry per second;
  // a two-hour match is 7200 entries, which is nothing, but the map is
  // unbounded in principle and this file has no idea how long a match runs.
  MAX_HASHES: 100000,

  // Set by a `winner` message from the client. The match is over at that point
  // and the pump stops — the real server moves to GamePhase.FINISHED here.
  winner: null,

  // --- Burst / speed ---------------------------------------------------------
  //
  // `speed` scales the wall-clock gate: 2 means a turn every 50 ms.
  //
  // `burst(n)` emits n turns as fast as the client can drain them, ignoring
  // the clock but not backpressure: it only relaxes the gate to 'less than
  // MAX_REPLAY_BACKLOG_TURNS behind'. Unbounded slack would freeze the tab
  // and then leave a very long catch-up.
  speed: 1,
  _burstRemaining: 0,

  // Pause. The sim advances only when a turn arrives, so holding the pump
  // is the whole implementation. Intents sent while paused stay buffered
  // and land in the first turn after resuming. Singleplayer only.
  paused: false,

  // --- Replay ----------------------------------------------------------------
  //
  // Playing back a recorded match (js/replay.js, docs/replays.md). When set,
  // by start() from `opts.replay`, it is
  //
  //   { gameStartInfo, myClientID, count, byTurn: Map(turnNumber -> intents) }
  //
  // `start` then carries the recorded gameStartInfo and clientID, endTurn
  // takes intents from `byTurn`, and the pump stops after `count` turns.
  // Intents and the `winner` vote from the watching client are dropped.
  // Speed, pause and burst work as they do live.
  replay: null,

  // --- Lifecycle -------------------------------------------------------------

  // Begin a match. `opts` carries what the real server would have put in
  // gameStartInfo (§4):
  //
  //   { gameID, seed, mapSize, bots, tribes, difficulty, username }
  //
  // Emits `start` immediately, then a `turn` every TURN_INTERVAL_MS.
  start(opts) {
    if (this.running) this.stop();
    opts = opts || {};

    this.reset();
    this.running = true;
    if (typeof Executor !== 'undefined' && typeof Executor.LOCAL_CLIENT_ID === 'string') {
      this.clientID = Executor.LOCAL_CLIENT_ID;
    }

    this.replay = opts.replay || null;
    this.gameStartInfo = this.replay ? this.replay.gameStartInfo : {
      gameID: typeof opts.gameID === 'string' ? opts.gameID : 'local',
      seed: opts.seed >>> 0,
      config: {
        map: opts.map === 'world' ? 'world' : 'procedural',
        mapSize: opts.mapSize || 'medium',
        mapGen: Protocol.normalizeMapGen(opts.mapGen),
        bots: opts.bots | 0,
        tribes: opts.tribes | 0,
        // Singleplayer only for now: the host lobby sends none, and Game.init
        // reads a missing one as Medium.
        difficulty: opts.difficulty,
        // Issue #31. Game.init (via Teams.normalize) treats anything but
        // 'team' as free-for-all.
        gameMode: opts.gameMode === 'team' ? 'team' : 'ffa',
        playerTeams: opts.playerTeams,
        // Fog of war (docs/fog-of-war.md): a strict boolean, off by default.
        fogOfWar: opts.fogOfWar === true
      },
      players: [{
        clientID: this.clientID,
        username: typeof opts.username === 'string' ? opts.username : 'You',
        // The human is player 0 in this codebase's id space (game/core.js's init:
        // 0 is human, 1..bots are Nations, the rest Tribes). MP-3.1 is where
        // this stops being a constant.
        playerId: 0
      }]
    };

    // The connection is announced before any message is delivered on it, so
    // the client's onconnect can do its setup before `start` arrives.
    this.turnStartTime = Date.now();
    if (this.onconnect) this.onconnect();

    // `turns: []` — a fresh match has no catch-up backlog. A rejoin is the
    // case where this is non-empty; see onMessage's `rejoin`.
    this._emit(Protocol.msg.start([], this.gameStartInfo, this.replay ? this.replay.myClientID : this.clientID));

    this._pumpID = setInterval(() => this._pump(), this.PUMP_INTERVAL_MS);
  },

  // Tear the connection down. Idempotent — the pump must never outlive the
  // match that started it, and stop() is reachable from several places
  // (Transport.disconnect, a restart, a `winner`).
  stop() {
    this.running = false;
    if (this._pumpID !== null) {
      clearInterval(this._pumpID);
      this._pumpID = null;
    }
  },

  // Wipe match state for a new game. Does NOT clear onconnect/onmessage: those
  // are transport wiring, installed once by Transport.connect and outliving any
  // single match on it — the same rule as Runner.reset and onHash.
  reset() {
    this.turns = [];
    this.intents = [];
    this.turnsExecuted = 0;
    this.turnStartTime = 0;
    this.gameStartInfo = null;
    this.hashes = new Map();
    this.winner = null;
    this.speed = 1;
    this._burstRemaining = 0;
    this.paused = false;
    this.replay = null;
  },

  // Hold or release the pump. Resuming restarts the turn clock so the first
  // turn after a long pause is one interval away rather than due immediately.
  setPaused(paused) {
    paused = !!paused;
    if (this.paused && !paused) this.turnStartTime = Date.now();
    this.paused = paused;
  },

  // --- Client -> server ------------------------------------------------------

  // The socket's `send`, seen from the server side. Validated at the
  // boundary exactly as the real server validates, so a malformed message
  // fails in singleplayer too. Returns true if the message was accepted.
  onMessage(clientMsg) {
    if (Protocol.validateMessage(clientMsg, 'c2s') !== null) return false;

    switch (clientMsg.type) {
      case 'intent':
        // The server stamps the author; the client never sends its own id.
        // The Executor resolves the acting player from the stamp.
        if (this.replay) return true; // a replay's turns are already written
        this.intents.push(Protocol.stamp(clientMsg.intent, this.clientID));
        return true;

      case 'hash':
        if (this.hashes.size < this.MAX_HASHES) {
          this.hashes.set(clientMsg.turnNumber, clientMsg.hash);
        }
        return true;

      case 'rejoin':
        // Reply `start` with turns.slice(lastTurn) (§4), as the real server
        // does, so the client-side rejoin path is exercised locally too.
        this._emit(Protocol.msg.start(
          this.turns.slice(clientMsg.lastTurn),
          this.gameStartInfo,
          this.clientID
        ));
        return true;

      case 'winner':
        // Client-voted game end. One client, so one vote decides. The pump
        // stops: the match is finished and further turns would be simulated
        // against an ended game.
        if (this.replay) return true; // the viewer may still scrub back
        this.winner = clientMsg.winner;
        this.stop();
        return true;

      case 'ping':
        return true;

      default:
        // Unreachable while validateMessage covers MESSAGES, and deliberately
        // silent if it ever is not — an unknown message is dropped at the
        // boundary, never thrown past it.
        return false;
    }
  },

  // The client has finished executing one turn. THIS IS THE BACKPRESSURE
  // SIGNAL. Without it the pump emits on the wall clock alone, and once the
  // sim costs more than TURN_INTERVAL_MS per turn the queue grows without
  // bound. With it, turns are emitted at TURN_INTERVAL_MS or slower, never
  // faster than the client consumes them. It also makes burst() safe and
  // main.js's drain loop terminate.
  turnComplete() {
    this.turnsExecuted++;
  },

  // --- The pump --------------------------------------------------------------

  // Fires every PUMP_INTERVAL_MS. Decides whether a turn is due, and emits it.
  //
  //   the clock gate         is this turn due yet? Skipped by a burst.
  //   the backpressure gate  has the client finished the last one? Never
  //                          skipped; a burst only widens the allowed backlog.
  _pump() {
    if (!this.running || this.paused) return;

    // A replay has a last turn. Past it there is nothing to emit, burst or not.
    if (this.replay && this.turns.length >= this.replay.count) {
      this._burstRemaining = 0;
      return;
    }

    if (this._burstRemaining > 0) {
      // Burst: emit as many turns as the backlog allows this tick. Bounded on
      // both sides — by the remaining count and by the backlog cap — so this
      // loop always terminates and never emits more than asked.
      while (this._burstRemaining > 0 &&
             (this.turns.length - this.turnsExecuted) < this.MAX_REPLAY_BACKLOG_TURNS &&
             !(this.replay && this.turns.length >= this.replay.count)) {
        this._burstRemaining--;
        this.endTurn();
      }
      // A burst does not also emit a clocked turn in the same pump tick, and
      // it leaves the clock reset behind it (endTurn sets turnStartTime), so
      // normal cadence resumes cleanly the moment the burst drains.
      return;
    }

    // Clock gate. `speed` divides the interval; at speed 1 this is exactly
    // OpenFront's `now > lastTurn + turnIntervalMs`.
    const interval = Protocol.TURN_INTERVAL_MS / (this.speed > 0 ? this.speed : 1);
    if (Date.now() <= this.turnStartTime + interval) return;

    // Backpressure gate. Strict at speed 1: everything emitted so far has been
    // executed. Above 1 a small backlog (up to `speed` turns) is allowed, or the
    // client's frame rate caps the speed-up regardless of the clock.
    if (this.turns.length - this.turnsExecuted >= Math.max(1, Math.round(this.speed))) return;

    this.endTurn();
  },

  // Close the current turn and ship it: build it from the buffered intents,
  // push it to the log, clear the buffer, broadcast. The turn number is
  // `this.turns.length`, which keeps Runner's `turns[i].turnNumber === i`.
  //
  // Public and gate-free on purpose (every gate lives in _pump), so it can
  // be single-stepped and tested without a wall clock.
  endTurn() {
    const intents = this.replay ? (this.replay.byTurn.get(this.turns.length) || []) : this.intents;
    const turn = Protocol.turn(this.turns.length, intents);
    this.turns.push(turn);
    this.intents = [];
    this.turnStartTime = Date.now();
    this._emit(Protocol.msg.turn(turn));
    return turn;
  },

  // Emit N turns as fast as the client drains them, ignoring the clock but
  // not the backlog cap. Each turn goes through the ordinary pipeline, so a
  // burst is indistinguishable from having played those turns. Additive:
  // a second call queues more.
  burst(n) {
    n = n | 0;
    if (n <= 0) return;
    this._burstRemaining += n;
  },

  // Run the pump now instead of waiting for its next 5 ms tick. main.js calls
  // this between turns while a replay is seeking, so a long jump is limited by
  // how fast the sim runs rather than by one backlog's worth of turns a frame.
  pumpNow() { this._pump(); },

  // Turns still queued to emit in the current burst. For tests and for a
  // progress indicator.
  burstRemaining() { return this._burstRemaining; },

  // Abandon a burst in progress. Turns already emitted stay emitted — they are
  // history, and the client has or will execute them.
  cancelBurst() { this._burstRemaining = 0; },

  // --- Server -> client ------------------------------------------------------

  // The socket's inbound edge, seen from the server side. Validated on the
  // way out so a shape mismatch surfaces here, not on a real connection.
  //
  // A throwing client handler must not kill the pump (or escape endTurn
  // with `intents` already cleared): caught, reported, carried on.
  _emit(msg) {
    if (Protocol.validateMessage(msg, 's2c') !== null) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('LocalServer refused to emit a malformed message', msg);
      }
      return;
    }
    if (!this.onmessage) return;
    try {
      this.onmessage(msg);
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('LocalServer.onmessage threw', e);
      }
    }
  }
};

// Dual export, as in the rest of net/ (see net/protocol.js's footer).
if (typeof module !== 'undefined' && module.exports) module.exports = LocalServer;
