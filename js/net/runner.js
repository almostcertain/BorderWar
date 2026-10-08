// The turn queue, and the loop that turns it into simulation
// (docs/multiplayer-architecture.md §5).
//
// The sim is driven by turn arrival, not elapsed time. executeNextTurn is the
// only place that may call Game.tick during a match.
//
// THE ONE INVARIANT: one turn in, exactly one tick out, in turn order, never
// twice. Breaking it does not show locally; it shows as a desync.
//
// The sim runs on the main thread (§8 divergence #2); main.js's
// frame-budgeted drain loop pumps this.
//
// WHAT THIS FILE MUST NOT DO
// 1. NEVER DRIVE ITSELF. No rAF, timers or recursion into executeNextTurn;
//    two pumps would double-tick.
// 2. NO Game.me, NO WALL CLOCK, NO Math.random, NO DOM (see net/executor.js).
//    The hash callback is the one client-local thing here.
// 3. NEVER INVENT A TURN. See addTurn.
const Runner = {

  // The turn stream, in execution order. Index i always holds the turn whose
  // turnNumber is i — addTurn is what guarantees that, and executeNextTurn
  // relies on it for the hash cadence.
  turns: [],

  // How far through `turns` we have executed: the turnNumber of the next
  // turn to run, and the count already run.
  currTurn: 0,

  // --- Hash emission seam ----------------------------------------------------
  //
  // Every HASH_INTERVAL turns the client digests its sim state and reports it
  // through this callback (Transport points it at Transport.sendHash). Null
  // means nobody is listening, the singleplayer default. The hash is computed
  // deterministically but delivered client-locally: nothing the callback does
  // may feed back into the sim.
  onHash: null,

  // --- Re-entrancy guard -----------------------------------------------------
  //
  // Intent handlers and onHash could call back into executeNextTurn, which
  // would consume the next turn from inside the current one and break the
  // invariant silently. A nested call refuses and returns false.
  isExecuting: false,

  // Turns that arrived ahead of their slot, keyed by turnNumber. See addTurn.
  outOfOrder: new Map(),

  // Cap on the above. A healthy transport delivers in order, so a growing
  // buffer means something upstream is broken: drop rather than exhaust memory.
  MAX_OUT_OF_ORDER: 1024,

  // --- Queue -----------------------------------------------------------------

  // Turns still queued and not yet executed. main.js's drain loop condition.
  pendingTurns() {
    const n = this.turns.length - this.currTurn;
    return n > 0 ? n : 0;
  },

  // Accept one turn from the server. Returns true if it (or anything buffered
  // behind it) was queued for execution.
  //
  // `turns[i].turnNumber === i` must hold, with no gaps or reordering:
  //
  //   turnNumber === turns.length  the next slot. Append.
  //   turnNumber <  turns.length   duplicate or stale re-delivery. DROP.
  //   turnNumber >  turns.length   a gap. HOLD in `outOfOrder` and flush when
  //                                the missing turns land.
  //   malformed                    DROP, per Protocol.validateTurn.
  //
  // Never fill a gap with empty turns: inventing a turn where the server sent
  // a non-empty one is a silent, guaranteed desync. Recovering a lost turn is
  // the transport's job (rejoin). A stalled runner is visible; a fabricated
  // turn is not.
  addTurn(turn) {
    if (Protocol.validateTurn(turn) !== null) return false;

    if (turn.turnNumber < this.turns.length) return false;      // duplicate/stale

    if (turn.turnNumber > this.turns.length) {                  // gap — hold it
      if (this.outOfOrder.size >= this.MAX_OUT_OF_ORDER) return false;
      if (this.outOfOrder.has(turn.turnNumber)) return false;   // duplicate ahead
      this.outOfOrder.set(turn.turnNumber, turn);
      return false;
    }

    this.turns.push(turn);
    // Drain whatever was waiting on this one. A single arrival can release an
    // arbitrarily long run, so this is a loop and not an if.
    while (this.outOfOrder.size > 0) {
      const next = this.outOfOrder.get(this.turns.length);
      if (next === undefined) break;
      this.outOfOrder.delete(this.turns.length);
      this.turns.push(next);
    }
    return true;
  },

  // --- The loop --------------------------------------------------------------

  // Execute exactly one turn: apply its intents in server order, then advance
  // the sim by one tick. Returns false when there was nothing to execute (or
  // when re-entered).
  //
  //   - intents BEFORE the tick, so an action issued on turn N is visible to
  //     the sim's stepping on turn N everywhere;
  //   - Game.tick() with NO argument: the timestep is fixed at Game.TICK_DT;
  //   - EXACTLY ONE tick. Being behind is handled by the caller's drain loop
  //     executing more turns;
  //   - currTurn is incremented before anything runs, so a throwing handler
  //     cannot leave the same turn queued to run again.
  executeNextTurn() {
    if (this.isExecuting) return false;
    if (this.currTurn >= this.turns.length) return false;

    this.isExecuting = true;
    try {
      const turn = this.turns[this.currTurn++];

      Executor.applyTurn(turn);
      Game.tick();

      // Hash cadence. Keyed on turn.turnNumber rather than on a local counter
      // so that every client in the match hashes on the same turns even if one
      // of them joined late — the server compares by turn number.
      if (turn.turnNumber % Protocol.HASH_INTERVAL === 0 && this.onHash) {
        // Computed unconditionally-deterministically, delivered client-locally.
        const h = Hash.compute();
        try {
          this.onHash(turn.turnNumber, h);
        } catch (e) {
          // A throwing transport must not abort a turn that has already been
          // applied and ticked; skipping the rest would itself desync. Report
          // and carry on. Client-local, so nothing in the sim can read it.
          if (typeof console !== 'undefined' && console.error) {
            console.error('Runner.onHash threw on turn ' + turn.turnNumber, e);
          }
        }
      }
      return true;
    } finally {
      this.isExecuting = false;
    }
  },

  // --- Lifecycle -------------------------------------------------------------

  // Wipe the queue for a new match; must happen together with Game.init().
  // Does NOT clear onHash, which is transport wiring that outlives a match.
  reset() {
    this.turns = [];
    this.currTurn = 0;
    this.outOfOrder.clear();
    // Cleared rather than asserted-false: reset() is reachable from a UI
    // "restart" path, and if a previous match somehow died mid-turn we want the
    // new one to start executable rather than permanently wedged.
    this.isExecuting = false;
  }
};

// Dual export, as in the rest of net/ (see net/protocol.js's footer).
if (typeof module !== 'undefined' && module.exports) module.exports = Runner;
