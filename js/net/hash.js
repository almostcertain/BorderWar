// Deterministic state digest + the dual-run determinism harness (Task MP-0.5).
//
// Under deterministic lockstep every client runs the same simulation over the
// same turn stream and must arrive at the same state. Nothing on the wire can
// tell us whether that actually happened, so each client digests its own state
// every few turns and the server compares the digests (MP-4.2). A single
// silent divergence permanently splits a match, so this digest is the only
// alarm there is — it has to be both cheap enough to run every ten turns and
// sensitive enough that a real divergence cannot slip past it.
//
// What goes in, per docs/multiplayer-architecture.md §9 MP-0.5, plus MP-3.5's
// widening (see INPUT_FIELDS below):
//   Game.ticks
//   per player: id, alive, tiles.size, round(troops), round(gold)
//   per attack: attacker, target, round(troops)
//   GameMap.owner, sampled every OWNER_STRIDE tiles
//   Game.running, Game.spawning, Game.winnerId
//
// What must never go in: anything named in Game.COSMETIC_STATE, and anything
// on Fx at all. Fx is structurally excluded — it is not part of Game and this
// file never mentions it. Game's own cosmetic residue is excluded by *reading
// Game.COSMETIC_STATE at run time* (see INPUT_FIELDS below) rather than by a
// hardcoded skip list, so the exclusion keeps holding as that list changes.
const Hash = {
  // FNV-1a 32-bit parameters.
  OFFSET_BASIS: 2166136261,
  PRIME: 16777619,

  // Every Game field this digest reads, by name. compute() filters this list
  // against Game.COSMETIC_STATE on each call and drops anything that appears
  // in both, which is what makes the "no cosmetic state in the hash" contract
  // self-enforcing: declaring a field cosmetic removes it from the digest
  // without anyone having to remember to edit this file too. Today the two
  // lists are disjoint, so the filter is a no-op — that is the point. It is a
  // tripwire, not a feature.
  //
  // GameMap.owner is not listed: it does not live on Game, so Game's cosmetic
  // declaration has no jurisdiction over it.
  // MP-3.5: 'running'/'spawning'/'winnerId' close the exact blind spot that
  // let UI-code mutation of Game.running (the pre-MP-3.5 checkEndGame) slip
  // through every prior task's "ok:true, zero divergence" result — the
  // digest never looked at the field being corrupted. Widening this list is
  // the actual fix for that invisibility, not cleanup: without it, the next
  // task that lets non-Runner/Executor code mutate sim state gets the same
  // free pass this one did.
  // Fog of war (game/vision.js): the vision* fields are sim state — bots
  // branch on them — so they are digested too, in fog matches only. With fog
  // off they are null and compute() never reaches them, which leaves a
  // fog-off digest exactly what it was before they existed. 'scouts'
  // (game/scouts.js) is the same: Scouts only exist in fog matches and are
  // only mixed in there. They are the one ship type in the digest because
  // they are the one that writes vision state as it moves.
  INPUT_FIELDS: ['ticks', 'players', 'attacks', 'running', 'spawning', 'winnerId',
    'visionCount', 'visionMet', 'visionShare', 'visionCells', 'visionStamped', 'scouts', 'planes'],

  // Sample every Nth tile of GameMap.owner.
  //
  // Why sample at all: xlarge is 2000x1000 = 2,000,000 tiles and the budget is
  // ~1 ms for the whole digest. Measured on this machine, one FNV round per
  // sampled tile costs ~11 ns — and that is not the multiply, it is the loop
  // itself: an identical loop that only xors is 9.3 ms across the full array
  // and one that only sums is 5.2 ms, so a full 2M-tile scan cannot be brought
  // under ~20 ms by any mixing function. Multi-lane unrolling to break the
  // dependency chain was tried and made no difference, confirming the cost is
  // per-iteration, not per-multiply. Sampling is the only lever.
  //
  // Why sampling does not blind the digest: territory *size* is already
  // covered exactly, not statistically — every owner change moves some
  // player's tiles.size, and that is hashed in full for all 82 players. The
  // tile scan exists to catch the residual case of two clients holding the
  // same per-player tile counts in different *places*, and a stride is plenty
  // for that: real divergence spreads across the map turn on turn and trips a
  // sampled tile long before the ten-turn hash interval elapses.
  //
  // 16 measured at 1.27 ms for the whole digest on xlarge (see the MP-0.5
  // verification run), sampling 125,000 tiles. The players-and-attacks half of
  // the digest measures 0.004 ms of that at 82 players, so the stride is
  // effectively the entire cost knob. A divergence would have to stay
  // permanently confined to a fifteen-tile window to hide from it. Smaller maps
  // are proportionally cheaper: medium (1/16th the tiles) measures 0.16 ms.
  OWNER_STRIDE: 16,

  // Sample every Nth word of the fog-of-war cell grids — see compute(). At 11
  // the vision part of the digest measured 0.1-0.2 ms on the World map with
  // 83 vision groups (three words a cell), against 0.76 ms for the rest.
  VISION_STRIDE: 11,

  // 32-bit unsigned FNV-1a over the simulation state. Pure: no allocation, no
  // clock, no Game.me, no Fx.
  //
  // Everything is mixed numerically. An earlier prototype ran values through
  // String() first, which is where essentially all of its cost was; converting
  // 250k tile owners to strings is not something this can afford at a ten-turn
  // cadence.
  compute() {
    const P = this.PRIME;
    let h = this.OFFSET_BASIS | 0;

    // One FNV-1a round per 32-bit word rather than per byte. Textbook FNV-1a
    // is byte-wise, and this is four times cheaper for the same input — which
    // matters because the tile scan below runs this shape 125,000 times per
    // digest. The price is weaker avalanche in the final round (a change in
    // the top bits of the last word only reaches the top bits of h), and
    // fmix32 at the end of compute() pays it off. Math.imul keeps the multiply
    // in 32 bits; h is left signed between rounds because xor and imul care
    // only about the bit pattern, and the sign is normalised once at the end.
    const u32 = v => { h = Math.imul(h ^ v, P); };

    // Any finite JS number, mixed as sign + two 32-bit words so values past
    // 2^31 (a late-game treasury, a debug gold grant) stay distinguishable
    // instead of wrapping into each other. Non-finite values get their own
    // distinct patterns so a NaN that has crept into troops or gold cannot
    // hash identically to a 0 — a divergence caused by a NaN is exactly the
    // kind this has to catch.
    const num = v => {
      if (!Number.isFinite(v)) { u32(v !== v ? 0x7fc00000 : (v > 0 ? 0x7f800000 : 0xff800000)); return; }
      const neg = v < 0;
      const x = neg ? -v : v;
      u32(x >>> 0);                    // low word (ToUint32 is mod 2^32)
      u32((x / 4294967296) >>> 0);     // high word
      if (neg) u32(0x80000000);
    };

    // Runtime cosmetic-exclusion check — see INPUT_FIELDS.
    const cosmetic = Game.COSMETIC_STATE || [];
    const uses = field => this.INPUT_FIELDS.indexOf(field) !== -1 && cosmetic.indexOf(field) === -1;

    if (uses('ticks')) u32(Game.ticks);
    // MP-3.5: running/spawning are booleans, mixed as 0/1 exactly like
    // p.alive above. winnerId is null until decided; -1 stands in for null
    // (ToUint32 keeps it distinct from any real, non-negative player id, same
    // trick attacks' NEUTRAL target already relies on above) and the real id
    // otherwise — this is a digest input, not wire data, so it never has to
    // satisfy Protocol's playerId type.
    if (uses('running')) u32(Game.running ? 1 : 0);
    if (uses('spawning')) u32(Game.spawning ? 1 : 0);
    if (uses('winnerId')) u32(Game.winnerId === null ? -1 : Game.winnerId);

    if (uses('players')) {
      const players = Game.players;
      u32(players.length);
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        u32(p.id);
        u32(p.alive ? 1 : 0);
        u32(p.tiles.size);
        num(Math.round(p.troops));
        num(Math.round(p.gold));
      }
    }

    if (uses('attacks')) {
      const attacks = Game.attacks;
      u32(attacks.length);
      for (let i = 0; i < attacks.length; i++) {
        const a = attacks[i];
        u32(a.attacker);
        u32(a.target);                 // NEUTRAL is -1; ToUint32 keeps it distinct
        num(Math.round(a.troops));
      }
    }

    // Tile ownership, sampled. Inlined rather than routed through u32 so this
    // stays one tight loop over a typed array with nothing in it but the load
    // and the mix — it is the only part of the digest whose cost scales with
    // map size. `owner` is an Int16Array, so `& 0xffff` is the complete value,
    // sign included, in one round.
    const owner = GameMap && GameMap.owner;
    if (owner) {
      const stride = this.OWNER_STRIDE, len = owner.length;
      for (let i = 0; i < len; i += stride) h = Math.imul(h ^ (owner[i] & 0xffff), P);
    }

    // Fog of war vision state. The three small arrays go in whole: each
    // group's discovered-cell count (so, like tiles.size above, the *size* of
    // every group's discovered area is covered exactly), who has met whom,
    // and who is sharing with whom. The two per-cell grids are sampled like
    // the tile scan, for the same reason and with the same argument: a
    // difference in where rather than how much spreads and trips a sampled
    // word. VISION_STRIDE counts words, not cells, and is a prime larger
    // than any word count a lobby can reach, so it walks through every word
    // of a cell's bitmask instead of landing on the same one each time.
    if (Game.fog) {
      const whole = a => { for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], P); };
      const sampled = a => { for (let i = 0, s = this.VISION_STRIDE; i < a.length; i += s) h = Math.imul(h ^ a[i], P); };
      if (uses('visionCount')) whole(Game.visionCount);
      if (uses('visionMet')) whole(Game.visionMet);
      if (uses('visionShare')) whole(Game.visionShare);
      if (uses('visionCells')) sampled(Game.visionCells);
      if (uses('visionStamped')) sampled(Game.visionStamped);
      // Scouts, in full, the way attacks are above: there are at most two a
      // nation. Who owns each, where it is, where it was sent and what it
      // has left.
      if (uses('scouts')) {
        const scouts = Game.scouts;
        u32(scouts.length);
        for (let i = 0; i < scouts.length; i++) {
          const s = scouts[i];
          u32(s.id);
          u32(s.owner);
          u32(s.path[Math.min(s.path.length - 1, Math.floor(s.pos))]);
          u32(s.destTile);
          u32(s.routing ? 1 : 0);
          num(s.health);
        }
        // The route search in flight, if any: whose it is and how far along.
        const search = Game.scoutSearch;
        u32(search ? search.scoutId : -1);
        u32(search ? search.nodes : 0);
      }
    }

    // Planes (game/paratroopers.js). Mixed only while one is in the air, so a
    // match nobody launches a plane in digests exactly as it did before planes
    // existed. Position is a pure function of born/duration, so those stand
    // in for it.
    if (uses('planes') && Game.planes.length) {
      const planes = Game.planes;
      u32(planes.length);
      for (let i = 0; i < planes.length; i++) {
        const pl = planes[i];
        u32(pl.id);
        u32(pl.owner);
        u32(pl.dst);
        u32(pl.hp);
        num(Math.round(pl.troops));
        num(Math.round(pl.born * 10));
      }
    }

    // fmix32 (murmur3's finalizer). Word-wise FNV leaves the last few inputs
    // under-diffused across the 32 bits; this makes every input bit affect
    // every output bit, so a one-tile or one-gold difference in the very last
    // thing mixed still moves the whole digest rather than a corner of it.
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  },

  // --- Determinism harness ---------------------------------------------------
  //
  // "Dual-sim" means two sequential runs of the one singleton, compared turn
  // by turn — Game and GameMap are object literals, not classes, so a single
  // page cannot hold two live simulations and making it able to is a refactor
  // far outside this task.
  //
  // Running the same code twice and getting the same answer proves close to
  // nothing, so the two runs are made to differ in every way that must not
  // matter and in none that must:
  //   - a different Game.me (view pointer only, since MP-0.2 — set *after*
  //     chooseSpawn, which legitimately uses it to place the human's capital,
  //     so both runs still place the same capital for the same player);
  //   - one run draws (Render.draw + UI.update interleaved with the ticks),
  //     the other never touches the renderer;
  //   - one run goes straight through while the other yields to the event loop
  //     periodically, so any accidental wall-clock dependency has room to show.
  // Identical hash sequences under those conditions is a real result.

  // Turn index -> hash, for whichever run last executed. Kept so a failed run
  // can be picked over afterwards from the console.
  lastRunA: null,
  lastRunB: null,

  // Lowest tile index that would pass Game.spawnBlockReason. Deterministic
  // given the map and the NPC discs init() has already claimed, so both runs
  // pick the same capital without the caller having to supply one.
  firstLegalSpawn() {
    const n = GameMap.owner.length;
    for (let t = 0; t < n; t++) if (Game.spawnBlockReason(t) === null) return t;
    return -1;
  },

  // Hand the main thread back for one macrotask, so timers, rAF and anything
  // else waiting gets a turn and a long verification stays interruptible.
  //
  // MessageChannel rather than setTimeout(0) on purpose. Chrome throttles
  // timers in a hidden or backgrounded tab to one per second, and to one per
  // *minute* after a few minutes there — which does not break the verification
  // but does turn a 3000-turn run into an hour of waiting on nothing. A
  // channel message is an ordinary macrotask and is not clamped that way.
  _yield() {
    return new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  },

  // Game.init (MP-3.1) takes gameStartInfo rather than (bots, tribes, seed,
  // size). The harness only ever needs a single synthetic human — the same
  // shape LocalServer.start produces — so this builds that shape from the
  // harness's own {bots, tribes, seed, size} cfg rather than duplicating it
  // at both call sites below.
  _syntheticGameStartInfo(cfg) {
    return {
      gameID: 'hash-harness',
      seed: cfg.seed,
      config: { map: cfg.map, mapSize: cfg.size, bots: cfg.bots, tribes: cfg.tribes, difficulty: cfg.difficulty, gameMode: cfg.gameMode, playerTeams: cfg.playerTeams, fogOfWar: cfg.fogOfWar },
      players: [{ clientID: 'harness', username: 'Harness', playerId: 0 }]
    };
  },

  // One run. Not part of the public surface — call verifyDeterminism.
  //
  // The tick guard is the awkward but necessary bit: main.js drives Game.tick
  // from its own requestAnimationFrame loop, and this harness yields to the
  // event loop, so without a guard that loop would interleave its own ticks
  // into the run and both sequences would be garbage. Game.tick is wrapped for
  // the duration and restored in verifyDeterminism's finally.
  async _run(cfg) {
    Game.init(this._syntheticGameStartInfo(cfg), 0);
    // init() leaves Game.me at 0, which is who chooseSpawn places (a
    // synthetic single-human roster always places its one human at 0). Both
    // runs must place the same capital, so the divergent Game.me is applied
    // after.
    // A fog match places every human itself in init() and refuses chooseSpawn
    // (docs/fog-of-war.md, "Spawning"), so there is nothing to pick: the
    // capital is already the same in both runs. Same guard as
    // tools/sim-harness.js.
    if (Game.fog) {
      if (Game.players[0].tiles.size === 0) throw new Error('Hash harness: the human has no spawn after init');
    } else if (!Game.chooseSpawn(cfg.spawnTile)) throw new Error('Hash harness: spawn tile ' + cfg.spawnTile + ' rejected');
    Game.me = cfg.me;

    if (cfg.render) {
      Render.onMapReady();
      Render.centerOnMap();
      UI.reset();
      UI.exitSpawnSelect();
    }

    const hashes = new Uint32Array(cfg.turns);
    const t0 = performance.now();
    for (let t = 1; t <= cfg.turns; t++) {
      cfg.tick();
      if (cfg.render && t % cfg.renderEvery === 0) {
        Game.renderElapsed = Game.elapsed;
        Render.draw();
        UI.update();
      }
      // Self-test hook. The negative control injects a divergence through this
      // — a harness that has never caught a failure has not been shown to work.
      if (cfg.perturb) cfg.perturb(t);
      hashes[t - 1] = this.compute();
      if (cfg.yieldEvery && t % cfg.yieldEvery === 0) {
        if (cfg.onProgress) cfg.onProgress(t);
        await this._yield();
      }
    }
    return { hashes, ms: performance.now() - t0 };
  },

  // Run the simulation twice under deliberately different client-local
  // conditions and compare the per-turn hash sequences.
  //
  // Options (all optional):
  //   bots, tribes, seed, size, turns   match setup
  //   fogOfWar                          true runs a fog-of-war match. Spawns are
  //                                     then placed by init() and spawnTile is
  //                                     ignored (reported as -1).
  //   spawnTile                         defaults to firstLegalSpawn()
  //   meA, meB                          the two view pointers; must differ
  //   renderEvery                       draw every Nth turn of run B (1 = every turn)
  //   yieldEvery                        run B awaits a macrotask every Nth turn
  //   yieldEveryA                       same for run A; 0 (the default) means run
  //                                     A goes straight through, which is the
  //                                     point of it. Raise it off 0 only when a
  //                                     very long run has to stay interruptible —
  //                                     a browser-automation harness will kill a
  //                                     script that owns the main thread for a
  //                                     minute. Keep it far coarser than
  //                                     yieldEvery so the two runs still differ.
  //   perturbA, perturbB                fn(turn) run after that run's tick, for
  //                                     negative controls
  //   onProgress                        fn(turn), called at each yield of either run
  //
  // Returns { ok, firstDivergentTurn, ... }. Turn numbers are 1-based: turn 1
  // is the state after the first tick() following the spawn.
  async verifyDeterminism(opts) {
    opts = opts || {};
    const bots = opts.bots != null ? opts.bots : 31;
    const tribes = opts.tribes != null ? opts.tribes : 50;
    const seed = opts.seed != null ? opts.seed : 123456789;
    const size = opts.size || 'large';
    const turns = opts.turns != null ? opts.turns : 3000;
    const meA = opts.meA != null ? opts.meA : 0;
    const meB = opts.meB != null ? opts.meB : Math.min(bots, 1 + bots + tribes - 1);
    const renderEvery = opts.renderEvery != null ? opts.renderEvery : 1;
    const yieldEvery = opts.yieldEvery != null ? opts.yieldEvery : 100;
    const yieldEveryA = opts.yieldEveryA != null ? opts.yieldEveryA : 0;
    const fogOfWar = opts.fogOfWar === true;

    if (meA === meB) throw new Error('Hash harness: meA and meB must differ — differing in nothing proves nothing');

    // Seed the map once up front purely so firstLegalSpawn has a map to scan;
    // each run re-inits from the same seed and gets the same one back. A fog
    // match has no spawn to pick (see _run), so it skips this.
    let spawnTile = -1;
    if (!fogOfWar) {
      Game.init(this._syntheticGameStartInfo({ bots, tribes, seed, size }), 0);
      spawnTile = opts.spawnTile != null ? opts.spawnTile : this.firstLegalSpawn();
      if (spawnTile < 0) throw new Error('Hash harness: no legal spawn tile on this map');
    }

    const realTick = Game.tick;
    let inHarness = false;
    Game.tick = function () { if (inHarness) realTick.call(this); };
    const tick = () => { inHarness = true; try { realTick.call(Game); } finally { inHarness = false; } };

    const base = { bots, tribes, seed, size, turns, spawnTile, tick, renderEvery, fogOfWar };
    let a, b;
    try {
      // Run A: no renderer, no yielding, straight through.
      a = await this._run(Object.assign({}, base, {
        me: meA, render: false, yieldEvery: yieldEveryA,
        perturb: opts.perturbA, onProgress: opts.onProgress
      }));
      this.lastRunA = a.hashes;
      // Run B: renders every turn, and hands the event loop back far more
      // often, so it experiences a completely different wall-clock profile.
      b = await this._run(Object.assign({}, base, {
        me: meB, render: true, yieldEvery,
        perturb: opts.perturbB, onProgress: opts.onProgress
      }));
      this.lastRunB = b.hashes;
    } finally {
      Game.tick = realTick;
    }

    let first = null;
    let count = 0;
    const samples = [];
    for (let i = 0; i < turns; i++) {
      if (a.hashes[i] === b.hashes[i]) continue;
      if (first === null) first = i + 1;
      count++;
      if (samples.length < 5) samples.push({ turn: i + 1, a: a.hashes[i], b: b.hashes[i] });
    }

    return {
      ok: first === null,
      firstDivergentTurn: first,
      divergentTurns: count,
      samples,
      turns, seed, size, bots, tribes, spawnTile, fogOfWar,
      runA: { me: meA, render: false, yieldEvery: yieldEveryA, ms: Math.round(a.ms), finalHash: a.hashes[turns - 1] },
      runB: { me: meB, render: true, renderEvery, yieldEvery, ms: Math.round(b.ms), finalHash: b.hashes[turns - 1] }
    };
  }
};
