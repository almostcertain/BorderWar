// The turn queue, and the loop that turns it into simulation
// (Task MP-1.3, docs/multiplayer-architecture.md §5, §9 Phase 1).
//
// This is the analogue of OpenFront's `GameRunner` (src/core/GameRunner.ts):
// `turns[]`, `currTurn`, `addTurn`, and `executeNextTurn` — which is their
// `executeNextTick` — applying one turn's intents and then advancing the sim by
// exactly one tick.
//
// WHY THIS FILE EXISTS. Today main.js drives Game.tick from the local wall
// clock: elapsed time accumulates, ticks come out. Under deterministic lockstep
// that is precisely backwards. **The sim is driven by turn arrival, not by
// elapsed time.** The server (or, in singleplayer, MP-1.4's LocalServer) buckets
// intents into a Turn every TURN_INTERVAL_MS and broadcasts it; every client
// executes the identical turn stream from the identical seed and lands in the
// identical state. If a client ticked because 100 ms had passed rather than
// because a turn had arrived, it would run ahead of everyone else and desync
// inside a second. So the only place in the codebase that may call Game.tick
// during a match is executeNextTurn below, once per turn, unconditionally.
//
// THE ONE INVARIANT: one turn in, exactly one tick out, in turn order, never
// twice. Every rule in this file exists to protect that. An off-by-one here
// does not look like a bug locally — the game plays fine — it looks like every
// other client in the match disagreeing with this one about the world.
//
// DELIBERATE DIVERGENCE FROM OPENFRONT (§8 divergence #2): OpenFront runs the
// sim inside a Web Worker (src/core/worker/Worker.worker.ts) and ships
// GameUpdateViewData back to the renderer, so a long catch-up burst can never
// block the page. We execute on the main thread, because this codebase is built
// on shared globals (Game, GameMap, Render, UI all reach into each other) and
// the worker split would be a large refactor with no correctness benefit. What
// the worker buys — a frozen tab during a big rejoin backlog — is bought
// instead by the frame-budgeted drain in main.js (MP-1.5, §5): the loop calls
// executeNextTurn in a `while (pendingTurns() > 0 && now < budgetEnd)` and
// gives the frame back when the budget runs out. That is why this module never
// schedules itself.
//
// WHAT THIS FILE MUST NOT DO
//
// 1. NEVER DRIVE ITSELF. No requestAnimationFrame, no setInterval, no
//    setTimeout, no recursion into executeNextTurn. This module is pure logic
//    over a queue; something else pumps it. Two pumps would double-tick, and a
//    self-scheduling runner could not be frame-budgeted by its caller at all.
// 2. NO Game.me, NO WALL CLOCK, NO Math.random, NO DOM. Identical constraints
//    to the Executor, for the identical reason — see the three rules at the top
//    of net/executor.js. Nothing below reads client-local state; the hash
//    callback is the one client-local thing here and it is a seam, not sim.
// 3. NEVER INVENT A TURN. See the continuity policy on addTurn.
//
// Nothing calls this yet, and that is correct: MP-1.4 (Transport/LocalServer)
// feeds addTurn and wires onHash, MP-1.5 rewires main.js to pump it. Until then
// main.js still ticks off the wall clock and this file sits inert.
const Runner = {

  // The turn stream, in execution order. Index i always holds the turn whose
  // turnNumber is i — addTurn is what guarantees that, and executeNextTurn
  // relies on it for the hash cadence.
  turns: [],

  // How far through `turns` we have executed. Also, therefore, the turnNumber
  // of the next turn to execute, and the count of turns already executed —
  // MP-1.4's LocalServer backpressure (`turnsExecuted === turns.length`, §5)
  // is exactly `pendingTurns() === 0`.
  currTurn: 0,

  // --- Hash emission seam ----------------------------------------------------
  //
  // Every HASH_INTERVAL turns the client digests its whole simulation state and
  // reports it, so the server can compare clients and shout when two of them
  // stop agreeing (§4 `hash`/`desync`, MP-4.2). That report is a *network*
  // action, and Transport does not exist until MP-1.4 — so rather than stub a
  // Transport global here and have MP-1.4 delete it, the runner calls out
  // through a plain callback that MP-1.4 points at Transport.sendHash.
  //
  //   Runner.onHash = (turnNumber, hash) => Transport.sendHash(turnNumber, hash);
  //
  // Null means "nobody is listening", which is the correct singleplayer default
  // and costs one branch per turn. Note the asymmetry that makes this safe: the
  // hash is *computed* deterministically (Hash.compute reads only sim state) but
  // *delivered* client-locally. Nothing the callback does may feed back into the
  // sim; if it ever needs to, it is an intent, not a callback.
  onHash: null,

  // --- Re-entrancy guard -----------------------------------------------------
  //
  // OpenFront's GameRunner carries the same flag. executeNextTurn hands control
  // to two pieces of code that could plausibly call back into it — the intent
  // handlers (via Executor -> Game) and onHash (via Transport, and in tests via
  // anything) — and a re-entrant call would consume the *next* turn from inside
  // the current one. The visible damage is currTurn racing ahead of the ticks
  // actually taken: two turns consumed, and either one or two ticks depending
  // on where the re-entry landed. That is the invariant broken, silently, and
  // it would surface later as a desync with no trail back here. So a nested
  // call refuses and returns false, exactly as if the queue were empty.
  isExecuting: false,

  // Turns that arrived ahead of their slot, keyed by turnNumber. See addTurn.
  outOfOrder: new Map(),

  // Cap on the above. A well-behaved transport never puts anything in here at
  // all (both TCP and the LocalServer deliver in order), so a buffer that grows
  // without bound means something upstream is broken and we would rather drop
  // than exhaust memory holding turns whose gap is never going to fill.
  MAX_OUT_OF_ORDER: 1024,

  // --- Queue -----------------------------------------------------------------

  // Turns still queued and not yet executed. main.js's drain loop condition.
  pendingTurns() {
    const n = this.turns.length - this.currTurn;
    return n > 0 ? n : 0;
  },

  // Accept one turn from the server. Returns true if it (or, with it, anything
  // buffered behind it) was queued for execution.
  //
  // TURN-NUMBER CONTINUITY POLICY. `turns[i].turnNumber === i` must hold, with
  // no gaps and no reordering, because the turn number is what the hash cadence
  // and the server's desync comparison are keyed on, and because two clients
  // that applied the same intents in a different order are not running the same
  // simulation. Four cases:
  //
  //   turnNumber === turns.length  the next slot. Append. The only common case.
  //   turnNumber <  turns.length   a duplicate or a stale re-delivery. DROP.
  //                                Appending it would execute a turn twice, and
  //                                overwriting the slot would either rewrite
  //                                history we already executed or silently swap
  //                                a turn we are about to. Both are worse than
  //                                ignoring a turn we demonstrably already have.
  //   turnNumber >  turns.length   a gap: turns arrived out of order, or one was
  //                                lost. HOLD it in `outOfOrder` and flush the
  //                                moment the missing turns land. This keeps the
  //                                turn without ever executing it early, which
  //                                is the whole requirement.
  //   malformed                    DROP, per Protocol.validateTurn.
  //
  // WHAT WE DELIBERATELY DO NOT DO is fill a gap with empty turns to keep
  // moving. OpenFront does that, but only in ClientGameRunner while catching up
  // against a turn backlog it has *already been sent in full* by the `start`
  // message — it is padding a list it can see the end of, not guessing at
  // turns it never received. Inventing an empty turn where the server sent a
  // non-empty one is a guaranteed desync, and a silent one: this client simply
  // never applies somebody's attack. So recovering a genuinely lost turn is a
  // transport-layer job (request it again, or rejoin — MP-4.x), and the runner's
  // contract is the narrow, checkable one: it executes what it was given, in
  // order, or it stalls. A stalled runner is visible; a fabricated turn is not.
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

  // Execute exactly one turn: apply its intents in the order the server
  // bucketed them, then advance the simulation by one tick. Returns false when
  // there was nothing to execute (or when re-entered), true when a turn ran.
  //
  // Straight from §5, which is OpenFront's GameRunner.executeNextTick. The
  // shape is worth stating plainly because every part of it is load-bearing:
  //
  //   - intents BEFORE the tick, so an action issued on turn N is visible to
  //     the sim's own stepping on turn N, identically everywhere;
  //   - Game.tick() with NO argument — the timestep is fixed at Game.TICK_DT
  //     (MP-0.1); passing a measured dt is what made the old loop
  //     wall-clock-dependent and is the single change Phase 0 existed for;
  //   - EXACTLY ONE tick, unconditionally, never zero and never two. Not "catch
  //     up if we are behind" — being behind is handled by executing more turns,
  //     which is the caller's drain loop, not by ticking harder here;
  //   - currTurn incremented as the turn is taken, before any of it runs, so a
  //     handler that throws (it shouldn't — Executor.apply never does) cannot
  //     leave the same turn queued to run again.
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
          // A transport that throws must not abort a turn that has already been
          // applied and ticked — there is no way to un-tick it, and a client
          // that skipped the rest of this function while its neighbours did not
          // is the desync we are trying to detect. Report and carry on. This is
          // a client-local branch on a client-local failure; nothing in the sim
          // reads it, so it cannot diverge anything (executor.js rule 2).
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

  // Wipe the queue for a new match. Game.init() resets the simulation; this
  // resets the thing that drives it, and the two must happen together — a fresh
  // sim fed a previous match's turn tail would apply somebody else's intents to
  // strangers and then disagree with every other client about why.
  //
  // Deliberately does NOT clear onHash: that is transport wiring, set up once
  // when the connection is made and outliving any single match on it.
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

// Dual export, same guarded shape as the rest of net/ — see net/protocol.js's
// footer. The server never simulates (§1) so it has no use for the runner, but
// the footer is uniform across the directory so a file's position in it is
// never a question.
if (typeof module !== 'undefined' && module.exports) module.exports = Runner;
