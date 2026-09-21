// The singleplayer server (Task MP-1.4, docs/multiplayer-architecture.md §2, §5,
// §6, §9 Phase 1).
//
// A direct port of OpenFront's `src/client/LocalServer.ts` — `start`, `endTurn`,
// `turnComplete`, and the 5 ms pump between them.
//
// WHY THIS FILE EXISTS. §2 is blunt about it: OpenFront runs singleplayer
// *through* the multiplayer code path. There is no second, simpler, direct-
// mutation mode sitting beside the networked one. Instead the client always
// talks to "a server"; in singleplayer that server is this object, in the same
// page, on the same thread, implementing the same three things a socket
// implements — you send it messages, it sends you messages back, and it buckets
// intents into turns on a clock. The client genuinely cannot tell which one it
// is attached to, which is the entire point: one game loop, one intent
// pipeline, one turn queue, forever. The alternative — a singleplayer path that
// mutates Game directly and a multiplayer path that goes through intents — is
// two simulations that will drift apart in behaviour and be debugged twice.
//
// WHAT IT IS NOT. It is not a simulation. Like the real server (§1) it never
// calls Game.tick, never reads Game state, and never decides anything about the
// world. It relays. The whole file could be handed a completely different game
// and would not notice. That is why it may hold `Date.now()` (see below) while
// nothing else in net/ may: nothing it computes reaches the sim.
//
// THE ONE PIECE OF LOCAL STATE THAT MATTERS: `turnsExecuted`. See the
// backpressure note on endTurn — it is what makes singleplayer self-clocking
// and is the reason the debug fast-forward has a home here rather than in a
// bare `Game.tick` loop.
//
// ON `Date.now()`. Every other file in net/ is forbidden the wall clock, because
// a simulation that reads it diverges (§7.5). This one is allowed it, in exactly
// one place — the pump's gate — for the same reason main.js's accumulator was
// allowed it: that is *scheduling*, deciding when a turn is emitted, not
// *simulation*, deciding what is in it. A turn's content is the intents that
// arrived, nothing else. Two clients handed the same turn stream produce the
// same world no matter how fast or slow this object chose to emit it.
//
// Nothing calls this yet. MP-1.5 rewires main.js and ui.js onto Transport, which
// routes here; until then this file sits inert, exactly like runner.js and
// executor.js before it.
const LocalServer = {

  // --- Tuning ----------------------------------------------------------------

  // The pump period. OpenFront's `setInterval(() => this.endTurn(), 5)`.
  //
  // Deliberately much finer than TURN_INTERVAL_MS: the pump is not the turn
  // clock, it is a poll that *checks* the turn clock. At 100 ms it would emit a
  // turn every 100 ms only when the phase happened to line up, and every 200 ms
  // when it did not; at 5 ms the emission lands within 5 ms of its due time. It
  // is also what lets the backpressure gate be re-checked promptly after a slow
  // client frame, instead of the stall costing a whole extra turn interval.
  PUMP_INTERVAL_MS: 5,

  // How far ahead of the client the pump may run *during a burst only*
  // (OpenFront's MAX_REPLAY_BACKLOG_TURNS). See burst().
  MAX_REPLAY_BACKLOG_TURNS: 60,

  // --- Connection state ------------------------------------------------------

  // The client's two callbacks, handed over by Transport.connect(). `onmessage`
  // is the exact analogue of a WebSocket's onmessage — this object's only way
  // of reaching the client, so that swapping in a real socket later changes the
  // producer of these calls and nothing about their consumer.
  onconnect: null,
  onmessage: null,

  // Running between start() and stop(). Guards double-start (which would leave
  // an orphaned interval emitting turns into a dead game) and makes stop()
  // idempotent.
  running: false,

  // setInterval handle for the pump.
  _pumpID: null,

  // --- Match state -----------------------------------------------------------

  // The full turn log, retained for the life of the match, exactly as the real
  // server retains it (§6): it is what a rejoin is fast-forwarded with, and it
  // is the game record. Index i holds turnNumber i — Runner.addTurn depends on
  // that and this is the thing that has to make it true.
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

  // The clientID this server stamps intents with. Single client, single
  // constant, so an intent built in singleplayer is byte-identical in shape to
  // one built in multiplayer and MP-3.1 changes where the id comes from, not
  // what an intent looks like.
  //
  // The literal is the fallback; start() re-reads it from
  // Executor.LOCAL_CLIENT_ID so the two cannot drift apart. Read there rather
  // than written here as `Executor.LOCAL_CLIENT_ID` because that would make
  // this file's *definition* depend on executor.js having already loaded, and
  // every other cross-module reference in net/ is deliberately call-time.
  clientID: 'local',

  // Hashes the client has reported, turnNumber -> hash. In multiplayer the
  // server compares these across clients and shouts (§4 `desync`, MP-4.2);
  // with one client there is nothing to compare against, so they are recorded
  // and nothing more. Recorded rather than dropped because a stored hash
  // sequence is exactly what a future replay-verification mode needs, and
  // because "the hash seam is actually wired end to end" is otherwise
  // untestable from outside.
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
  // OpenFront's replay speed multiplier, which is also — per §5 and MP-1.4 —
  // where the debug fast-forward belongs: "raise the LocalServer interval
  // multiplier rather than calling Game.tick in a bare loop".
  //
  // `speed` scales the wall-clock gate: 2 means a turn every 50 ms. It still
  // respects the clock, so it is the right knob for "play at double speed".
  //
  // `burst(n)` is the fast-forward knob: emit n turns as fast as the client can
  // drain them, ignoring the clock entirely. What it does NOT ignore is
  // backpressure — it just relaxes it from "the client has finished everything"
  // to "the client is less than MAX_REPLAY_BACKLOG_TURNS behind". Some slack is
  // needed or the burst rate collapses to one turn per pump tick (5 ms), but
  // unbounded slack is worse than no gate at all: the pump would push tens of
  // thousands of turns into Runner.turns in a few frames, the client would fall
  // arbitrarily far behind, and the "fast-forward" would be a frozen tab
  // followed by a very long catch-up. A bounded backlog keeps the burst
  // client-paced, which is the property that makes it safe.
  speed: 1,
  _burstRemaining: 0,

  // Pause. The sim advances only when a turn arrives (§5), so holding the pump
  // is the whole implementation: no turns out means no Game.tick, with no
  // client-side flag for the sim to consult. Intents sent while paused stay
  // buffered in `intents` and land in the first turn after resuming. Singleplayer
  // only in effect — a real server owns its own clock and ignores nothing here.
  paused: false,

  // --- Lifecycle -------------------------------------------------------------

  // Begin a match. `opts` carries what the real server would have decided in
  // the lobby and put in gameStartInfo (§4):
  //
  //   { gameID, seed, mapSize, bots, tribes, difficulty, username }
  //
  // Emits `start` immediately, then a `turn` every TURN_INTERVAL_MS.
  //
  // NOTE ON gameStartInfo. Game.init still takes (botCount, tribeCount, seed,
  // sizeKey) and MP-3.1 is the task that changes it to take gameStartInfo. So
  // this carries the fields in their final shape without yet being the thing
  // that consumes them: the config lands under `config`, and `players` is the
  // one-entry roster that Executor.setRoster will be handed once there is more
  // than one of them. Synthesizing it now rather than later means the client's
  // start handler is written against the real shape from the beginning and does
  // not get rewritten when the server appears.
  start(opts) {
    if (this.running) this.stop();
    opts = opts || {};

    this.reset();
    this.running = true;
    if (typeof Executor !== 'undefined' && typeof Executor.LOCAL_CLIENT_ID === 'string') {
      this.clientID = Executor.LOCAL_CLIENT_ID;
    }

    this.gameStartInfo = {
      gameID: typeof opts.gameID === 'string' ? opts.gameID : 'local',
      seed: opts.seed >>> 0,
      config: {
        mapSize: opts.mapSize || 'medium',
        bots: opts.bots | 0,
        tribes: opts.tribes | 0,
        // Singleplayer only for now: the host lobby sends none, and Game.init
        // reads a missing one as Medium.
        difficulty: opts.difficulty
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

    // Order matters and matches OpenFront: the connection is announced before
    // any message is delivered on it, so the client's onconnect can do its
    // setup (Game.init, Runner.reset) before `start` arrives carrying the
    // backlog it is supposed to load.
    this.turnStartTime = Date.now();
    if (this.onconnect) this.onconnect();

    // `turns: []` — a fresh match has no catch-up backlog. A rejoin is the
    // case where this is non-empty; see onMessage's `rejoin`.
    this._emit(Protocol.msg.start([], this.gameStartInfo, this.clientID));

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
  },

  // Hold or release the pump. Resuming restarts the turn clock so the first
  // turn after a long pause is one interval away rather than due immediately.
  setPaused(paused) {
    paused = !!paused;
    if (this.paused && !paused) this.turnStartTime = Date.now();
    this.paused = paused;
  },

  // --- Client -> server ------------------------------------------------------

  // The socket's `send`, seen from the server side. Takes a client->server
  // message (§4's first table) and does what the real server does with it.
  //
  // Validated at the boundary exactly as the real server validates, even though
  // the sender is three files away in the same page: the point of this object
  // is that it is indistinguishable from the networked one, and a shim that is
  // more forgiving than the server is a shim that lets malformed messages
  // through in singleplayer and fails only in multiplayer. Returns true if the
  // message was accepted.
  onMessage(clientMsg) {
    if (Protocol.validateMessage(clientMsg, 'c2s') !== null) return false;

    switch (clientMsg.type) {
      case 'intent':
        // GameServer.handleIntent: the server stamps the author, the client
        // never sends its own id. With one client the stamp is a constant, but
        // it goes on here and not at the sender for the same reason it does in
        // multiplayer — authorship is the one thing a relay is authoritative
        // about (§1), and the Executor resolves the acting player from it.
        this.intents.push(Protocol.stamp(clientMsg.intent, this.clientID));
        return true;

      case 'hash':
        if (this.hashes.size < this.MAX_HASHES) {
          this.hashes.set(clientMsg.turnNumber, clientMsg.hash);
        }
        return true;

      case 'rejoin':
        // The real server replies `start` with turns.slice(lastTurn) (§4). With
        // one local client this cannot happen for the reason it happens on a
        // network — nothing here can drop a connection — but it is implemented
        // because it is nearly free, because it makes the turn log's purpose
        // explicit, and because a client-side rejoin path that has never once
        // executed is a client-side rejoin path that does not work.
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
  // SIGNAL, and it is the most important line in the file.
  //
  // Without it the pump would emit on the wall clock alone and the client would
  // execute whenever it got a frame. Those are two independent rates, and the
  // moment the sim costs more than TURN_INTERVAL_MS per turn — a big map, a
  // slow machine, a background tab — the queue grows without bound and the game
  // slides further behind itself forever, with no signal that anything is
  // wrong. With it, the server is clocked by the client: turns are emitted at
  // TURN_INTERVAL_MS *or slower*, never faster than the client can consume, and
  // a slow machine simply runs the whole match slightly slow, which is exactly
  // what a singleplayer game should do.
  //
  // It is also what makes the burst safe (see burst()) and what makes MP-1.5's
  // drain loop terminate.
  turnComplete() {
    this.turnsExecuted++;
  },

  // --- The pump --------------------------------------------------------------

  // Fires every PUMP_INTERVAL_MS. Decides whether a turn is due, and emits it.
  //
  // Two gates, and they are different in kind:
  //
  //   the clock gate      is this turn *due* yet? Skipped entirely by a burst.
  //   the backpressure    has the client *finished* the last one? Never skipped;
  //   gate                a burst only widens the allowed backlog.
  //
  // Conflating them is the bug to avoid: dropping the clock gate makes the game
  // run as fast as the CPU allows, dropping the backpressure gate makes it run
  // away from the client.
  _pump() {
    if (!this.running || this.paused) return;

    if (this._burstRemaining > 0) {
      // Burst: emit as many turns as the backlog allows this tick. Bounded on
      // both sides — by the remaining count and by the backlog cap — so this
      // loop always terminates and never emits more than asked.
      while (this._burstRemaining > 0 &&
             (this.turns.length - this.turnsExecuted) < this.MAX_REPLAY_BACKLOG_TURNS) {
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

    // Backpressure gate. Strict: everything emitted so far has been executed.
    if (this.turnsExecuted < this.turns.length) return;

    this.endTurn();
  },

  // Close the current turn and ship it. OpenFront's GameServer.endTurn, and
  // §6's four lines:
  //
  //   build the turn from the buffered intents, push it to the log, clear the
  //   buffer, broadcast.
  //
  // The turn number is `this.turns.length` — the index it is about to occupy —
  // which is what guarantees Runner's `turns[i].turnNumber === i` invariant
  // holds from the producing end, with no counter to drift out of step with the
  // array.
  //
  // Deliberately public and deliberately gate-free: every gate lives in _pump.
  // A caller that wants one turn, now, gets one turn, now — which is what makes
  // this testable without a wall clock, and is how MP-1.5 can single-step.
  endTurn() {
    const turn = Protocol.turn(this.turns.length, this.intents);
    this.turns.push(turn);
    this.intents = [];
    this.turnStartTime = Date.now();
    this._emit(Protocol.msg.turn(turn));
    return turn;
  },

  // Emit N turns as fast as the client drains them, ignoring the clock but not
  // the backlog cap. The debug fast-forward's engine (MP-1.5 wires the button
  // to it; MP-1.4 deliberately does not touch ui.js).
  //
  // Note what this is *not*: it is not `for (i < n) Game.tick()`. Every one of
  // these turns goes through the same pipeline as every other turn — bucketed
  // here, queued in Runner, applied by Executor, ticked once. A burst is
  // therefore indistinguishable from having played those turns, which is the
  // property the old bare-loop fastForward could never have.
  //
  // Additive, so two clicks of "skip ahead" queue up rather than the second
  // discarding the first.
  burst(n) {
    n = n | 0;
    if (n <= 0) return;
    this._burstRemaining += n;
  },

  // Turns still queued to emit in the current burst. For tests and for a
  // progress indicator.
  burstRemaining() { return this._burstRemaining; },

  // Abandon a burst in progress. Turns already emitted stay emitted — they are
  // history, and the client has or will execute them.
  cancelBurst() { this._burstRemaining = 0; },

  // --- Server -> client ------------------------------------------------------

  // The socket's inbound edge, seen from the server side.
  //
  // Validated on the way out, which a real server would not bother to do to
  // itself. It is worth it here precisely because this object is a stand-in:
  // the day a WebSocket replaces it, every message the client has ever been
  // written against will have been a well-formed one, and a shape mismatch
  // surfaces now rather than as a mystery on first connect.
  //
  // A throwing client handler must not kill the pump — an exception escaping
  // here would propagate out of the setInterval callback and, worse, out of
  // endTurn leaving `intents` already cleared. Caught, reported, carried on:
  // the same client-local-failure reasoning as Runner's onHash guard.
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

// Dual export, same guarded shape as the rest of net/ — see net/protocol.js's
// footer. server/ has no use for this file (it IS the thing this file stands in
// for) but the footer is uniform across the directory so a file's position in
// it is never a question.
if (typeof module !== 'undefined' && module.exports) module.exports = LocalServer;
