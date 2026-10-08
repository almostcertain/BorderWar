// Deterministic state digest + the dual-run determinism harness.
//
// Each client digests its own sim state every few turns and the server
// compares the digests. This is the only desync alarm, so it must be cheap
// enough to run every ten turns and sensitive enough to catch a real
// divergence.
//
// What goes in (see INPUT_FIELDS):
//   Game.ticks
//   per player: id, alive, tiles.size, round(troops), round(gold)
//   per attack: attacker, target, round(troops)
//   GameMap.owner, sampled every OWNER_STRIDE tiles
//   Game.running, Game.spawning, Game.winnerId
//
// What must never go in: anything in Game.COSMETIC_STATE (read at run time,
// not a hardcoded skip list), and anything on Fx.
const Hash = {
  // FNV-1a 32-bit parameters.
  OFFSET_BASIS: 2166136261,
  PRIME: 16777619,

  // Every Game field this digest reads, by name. compute() drops any that
  // also appear in Game.COSMETIC_STATE, so declaring a field cosmetic removes
  // it from the digest automatically. GameMap.owner is not listed: it does
  // not live on Game.
  //
  // 'running'/'spawning'/'winnerId' are here so non-sim code mutating them
  // is caught.
  // Fog of war (game/vision.js): the vision* fields and 'scouts' are sim
  // state and are digested in fog matches only; with fog off compute() never
  // reaches them, so a fog-off digest is unchanged.
  // 'drill' (game/drill.js) likewise: mixed only once a Drill exists.
  INPUT_FIELDS: ['ticks', 'players', 'attacks', 'running', 'spawning', 'winnerId',
    'visionCount', 'visionMet', 'visionShare', 'visionCells', 'visionStamped', 'scouts', 'drill', 'drillDead'],

  // Sample every Nth tile of GameMap.owner. A full scan of the 2M-tile large
  // map costs ~20 ms whatever the mixing function; the budget is ~1 ms.
  //
  // Sampling does not blind the digest: territory *size* is covered exactly
  // by every player's tiles.size. The scan only catches equal counts in
  // different places, and real divergence spreads onto a sampled tile well
  // inside the hash interval.
  //
  // 16 measured 1.27 ms for the whole digest on the large map.
  OWNER_STRIDE: 16,

  // Sample every Nth word of the fog-of-war cell grids — see compute(). At 11
  // the vision part of the digest measured 0.1-0.2 ms on the World map with
  // 83 vision groups (three words a cell), against 0.76 ms for the rest.
  VISION_STRIDE: 11,

  // 32-bit unsigned FNV-1a over the simulation state. Pure: no allocation,
  // no clock, no Game.me, no Fx. Everything is mixed numerically; going
  // through String() is far too slow.
  compute() {
    const P = this.PRIME;
    let h = this.OFFSET_BASIS | 0;

    // One FNV-1a round per 32-bit word, not per byte: four times cheaper.
    // The weaker avalanche in the last round is paid off by fmix32 at the
    // end. Math.imul keeps the multiply in 32 bits; the sign is normalised
    // once at the end.
    const u32 = v => { h = Math.imul(h ^ v, P); };

    // Any finite JS number, mixed as sign + two 32-bit words so values past
    // 2^31 stay distinguishable. Non-finite values get their own patterns,
    // so a NaN in troops or gold cannot hash like a 0.
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
    // running/spawning are mixed as 0/1. winnerId is null until decided;
    // -1 stands in for null, distinct from any real player id.
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

    // Tile ownership, sampled. Inlined as one tight loop over a typed
    // array: the only part whose cost scales with map size. `owner` is an
    // Int16Array, so `& 0xffff` is the complete value.
    const owner = GameMap && GameMap.owner;
    if (owner) {
      const stride = this.OWNER_STRIDE, len = owner.length;
      for (let i = 0; i < len; i += stride) h = Math.imul(h ^ (owner[i] & 0xffff), P);
    }

    // Fog of war vision state. The three small arrays go in whole (each
    // group's discovered-cell count, who has met whom, who shares with
    // whom). The two per-cell grids are sampled like the tile scan.
    // VISION_STRIDE counts words and is a prime larger than any word count
    // a lobby can reach, so it walks through every word of a cell's bitmask.
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

    // The Drill record, whole: every field is an integer. Nothing is mixed
    // while there is none.
    const drill = Game.drill;
    if (drill && uses('drill')) {
      u32(drill.ownerId);
      u32(drill.tile);
      u32(drill.placedTick);
      u32(drill.startTick);
      u32(drill.endTick);
      u32(drill.r0);
      num(drill.r);
      num(drill.rPrev);
    }
    // The dead zone (BR-3), by its exact size in tiles and in land tiles.
    // Not scanned: which tiles are dead is fixed by the record above (the
    // complement of the circle), so the counts are what can drift.
    if (drill && uses('drillDead')) {
      u32(Game.drillDeadTiles);
      u32(Game.drillDeadLand);
    }

    // fmix32 (murmur3's finalizer): makes every input bit affect every
    // output bit, so a difference in the last thing mixed moves the whole digest.
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  },

  // --- Determinism harness ---------------------------------------------------
  //
  // Two sequential runs of the one singleton, compared turn by turn. The runs
  // differ in every way that must not matter:
  //   - a different Game.me (set *after* chooseSpawn, so both runs place the
  //     same capital);
  //   - one run draws (Render.draw + UI.update between ticks), the other
  //     never touches the renderer;
  //   - one run goes straight through, the other yields to the event loop.

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

  // Hand the main thread back for one macrotask. MessageChannel, not
  // setTimeout(0): Chrome throttles timers in a hidden tab to one a second
  // or worse, which would stretch a long run to an hour.
  _yield() {
    return new Promise(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    });
  },

  // Builds the single-human gameStartInfo Game.init takes (the shape
  // LocalServer.start produces) from the harness's {bots, tribes, seed, size}.
  _syntheticGameStartInfo(cfg) {
    return {
      gameID: 'hash-harness',
      seed: cfg.seed,
      config: { map: cfg.map, mapSize: cfg.size, bots: cfg.bots, tribes: cfg.tribes, difficulty: cfg.difficulty, gameMode: cfg.gameMode, playerTeams: cfg.playerTeams, fogOfWar: cfg.fogOfWar },
      players: [{ clientID: 'harness', username: 'Harness', playerId: 0 }]
    };
  },

  // One run. Not public: call verifyDeterminism. Game.tick is wrapped for
  // the duration (restored in verifyDeterminism's finally), or main.js's
  // own loop would interleave ticks while this yields.
  async _run(cfg) {
    Game.init(this._syntheticGameStartInfo(cfg), 0);
    // init() leaves Game.me at 0, which is who chooseSpawn places. Both
    // runs must place the same capital, so the divergent Game.me is applied
    // after. A fog match places every human in init() and refuses
    // chooseSpawn (docs/fog-of-war.md, 'Spawning'), so there is nothing to pick.
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
  //   fogOfWar                          true runs a fog match; spawnTile is
  //                                     then ignored (reported as -1)
  //   spawnTile                         defaults to firstLegalSpawn()
  //   meA, meB                          the two view pointers; must differ
  //   renderEvery                       draw every Nth turn of run B
  //   yieldEvery                        run B awaits a macrotask every Nth turn
  //   yieldEveryA                       same for run A; 0 (default) runs straight
  //                                     through. Raise it only to keep a very
  //                                     long run interruptible, and keep it far
  //                                     coarser than yieldEvery.
  //   perturbA, perturbB                fn(turn) run after that run's tick, for
  //                                     negative controls
  //   onProgress                        fn(turn), called at each yield
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
