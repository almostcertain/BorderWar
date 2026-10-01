const Game = {
  // Cross-engine deterministic math for the simulation.
  //
  // `+ - * /` and Math.sqrt are IEEE-754 operations: every conforming engine
  // must return the correctly-rounded result, so they are bit-identical on
  // Chrome, Firefox and Safari alike. Math.pow, Math.exp, Math.log and
  // Math.hypot are NOT — ECMA-262 leaves them implementation-approximated, and
  // V8, SpiderMonkey and JavaScriptCore genuinely disagree in the last ulp on
  // ordinary inputs. Under deterministic lockstep that is fatal: a one-bit
  // difference in a troop cap feeds the growth curve, which feeds the attack
  // loop, which amplifies it until two clients hold different maps — silently,
  // with no error anywhere.
  //
  // So every hazardous call in the sim goes through here, and the result is
  // quantized to 12 significant digits (see detQuantize). Doubles carry ~15-17
  // significant digits and the contested bits sit around digit 16, so cutting
  // at 12 collapses the disagreement with four digits of margin while staying
  // far more precise than any balance number in this file needs.
  //
  // There is deliberately no det.sqrt: Math.sqrt is already exact everywhere,
  // so wrapping it would throw away precision and time for nothing.
  // Integer-exponent Math.pow(2, n) is exempt too; see unitCost.
  //
  // The one remaining hole — two engines landing either side of a quantization
  // boundary — is astronomically unlikely and is what the state hash (MP-0.5)
  // is for. This turns that hash into a backstop rather than the only defence,
  // which is all OpenFront itself has.
  det: {
    pow(base, exponent) { return detQuantize(Math.pow(base, exponent)); },
    exp(x) { return detQuantize(Math.exp(x)); },
    // Computed as sqrt(dx*dx + dy*dy) rather than by calling Math.hypot: the
    // two multiplies, the add and the sqrt are all IEEE-exact, so this form is
    // already identical on every engine before the quantizer even runs. The
    // quantize stays as belt-and-braces and to keep every det.* member
    // behaving the same way. Where a call site is hot enough that the round-trip
    // shows up (map.js's spawn-separation loop), inline the sqrt form directly
    // instead — it is exact on its own.
    hypot(dx, dy) { return detQuantize(Math.sqrt(dx * dx + dy * dy)); },
    // Only consumer is largeTerritoryBonus's log-scaled sigmoid (attack
    // pacing) — same quantize-after-native approach as pow/exp above, for
    // the same reason: a custom deterministic Taylor series isn't needed
    // when rounding off the last few contested digits already agrees.
    log(x) { return detQuantize(Math.log(x)); }
  },

  players: [],
  // Live land/beachhead fronts. Every attack carries an `id` minted from
  // nextAttackId below — see that counter's comment for why, and for what
  // consolidation does to an id.
  attacks: [],
  // Monotonic entity-id counters, in the same shape (and for the same reason)
  // as nextRailId/nextTrainId further down: a plain integer on the object
  // literal, reset in init(), consumed as `this.nextAttackId++`. Incremented
  // only from inside tick()-reachable sim code, so every client mints the same
  // id for the same entity on the same turn.
  //
  // These exist for the wire (MP-1.2, docs/multiplayer-architecture.md §4).
  // `cancel_attack`, `cancel_boat` and `move_warship` name their targets by id
  // because an object reference cannot cross a socket, and because every
  // client has to resolve the same id to the same entity or the fleet that
  // moves here is not the fleet that moves there. OpenFront's own units carry
  // a `UnitImpl.id` from `nextUnitID++` on the GameImpl for exactly this.
  //
  // An id is never reused inside a match and never renumbered. An entity's id
  // therefore *ends* — an attack folded into another by launchAttack's
  // consolidation, a boat that landed, a warship that sank — and an intent
  // naming a dead id resolves to nothing. That is the correct outcome, not an
  // error: it resolves to nothing identically on every client, which is all
  // lockstep asks. See Executor's `_attack`/`_boat`/`_warship` lookups.
  //
  // Ids start at 1 so 0 is never a valid entity, and a falsy-id bug shows up
  // as a dropped intent rather than as a silent hit on entity zero.
  nextAttackId: 1,
  boats: [],
  nextBoatId: 1,
  // tile -> { type, tile, built, progress, buildTime, level, upgrading,
  // station, rails, lastTrainAt }. Owner is whoever holds the tile. `built`
  // is false until `progress` reaches `buildTime`, during which it doesn't
  // count toward units/maxTroops — see build() and updateConstruction().
  // Once built, `level` starts at 1 and climbs one at a time through
  // upgrade() — reusing the same progress/buildTime pair for the upgrade
  // timer, gated by `upgrading` instead of `built`. See UNITS' cost comment
  // for why unitsOwned is a sum of levels rather than a headcount.
  // `station`/`rails`/`lastTrainAt` belong to the rail network — see the
  // "Rail network & trains" section near the end of this file.
  buildings: new Map(),
  // One entry per rail edge between two stations: { id, a, b, tiles }, tiles
  // running from a to b inclusive. Kept flat (rather than only living inside
  // each building's `rails` map) purely so Render can draw every line once
  // without walking the building map and dividing by two.
  railroads: [],
  nextRailId: 1,
  // Trains currently in transit — see spawnTrainFrom/stepTrains.
  trains: [],
  nextTrainId: 1,
  // Trade ships currently in transit between two Ports — see
  // updatePortTrade/stepTradeShips in the "Ports & trade ships" section.
  tradeShips: [],
  // Warships currently in play — see the "Warships" section near the end of
  // this file for their build/combat/patrol logic. Each carries an `id` — see
  // nextAttackId above for the scheme.
  warships: [],
  nextWarshipId: 1,
  // In-flight warship shells — see warshipShootAt (spawns one) and
  // stepShells (advances/resolves them). Unlike Fx's gold popups these aren't
  // pure presentation: the target only actually takes damage/sinks once its
  // shell arrives, not the instant the warship fires.
  shells: [],
  // Short-lived intercept-confirmation rings — pure presentation, spawned by
  // stepSAMs on a successful kill and aged/culled there, same idea as
  // nukeBlasts below but small and quick since it's marking a kill, not a
  // detonation.
  samFlashes: [],
  // Fields on Game that are pure presentation and must be SKIPPED by the
  // deterministic state hash (MP-0.5), which consults this list by name.
  //
  // Unlike the gold popups — which were viewer-relative and therefore had to
  // leave Game entirely, see js/fx.js — these two are pushed unconditionally
  // and read nothing about who is watching, so every client produces them
  // identically and they are safe to keep as sim-resident state. They are
  // excluded from the hash only because hashing them buys nothing: they are
  // floating-point screen positions with no influence on any rule, so the
  // digest would be paying for entries that can never reveal a real
  // divergence the gameplay fields don't already reveal.
  //
  // Adding a field here is a claim that it is provably gameplay-irrelevant:
  // nothing in the simulation may branch on it, read it back, or derive a
  // value from it. If in doubt, leave it out — a slightly slower hash is
  // cheap, a desync the hash was told to ignore is not.
  // nationCount/placements (MP-3.5 defeat screen) join the list for the same
  // reason: both are derived, write-once-per-player bookkeeping that nothing
  // in the sim ever reads back — only UI.checkEndGame does — even though
  // eliminatePlayer computes placements off shared, Game.me-blind player
  // state so every client would agree on it anyway.
  COSMETIC_STATE: ['nukeBlasts', 'samFlashes', 'nationCount', 'placements'],
  // Per-tick sea-route scratch (see tick() and nearestCoastPath). Empty and
  // false between ticks.
  _inTick: false,
  _coastPathMemo: new Map(),
  alliances: [],
  requests: [],
  lastRequestAt: new Map(),
  me: 0,
  rng: null,
  running: false,
  // Global, Game.me-blind win-condition result (MP-3.5). null until tick()
  // decides a winner; then the winning player's id, set exactly once and
  // never overwritten. Computed identically off shared player state on every
  // client — see tick()'s post-elimination-sweep block below — so it reaches
  // the same value on the same turn everywhere, unlike the old client-local
  // (and Game.me-relative) UI.checkEndGame this replaces.
  winnerId: null,
  // True from init() until the spawn phase's timed deadline elapses (see
  // tickSpawnPhase/SPAWN_PHASE_TURNS) — not until any human taps, which is
  // MP-3.2's fix: under 2+ humans the first tap can no longer end the phase
  // for everyone else. chooseSpawn() only claims the caller's own disc.
  spawning: false,
  dirty: true,
  // Tile indices whose owner changed since Render last rebuilt the tile
  // canvas, plus each one's own neighbors (their border-edge shading can
  // change even though their owner didn't) — lets Render recolor just the
  // affected pixels instead of the whole map every time a single tile
  // changes hands. `dirty` (above) is reserved for whole-canvas rebuilds
  // (first paint) where every tile, including never-touched water/neutral
  // ground, needs its initial color.
  dirtyTiles: null,

  // The repaint queue is a deduping tile set that is filled and drained every
  // single frame, and during a real push it reached 42,000 entries in one
  // tick (measured, Extra Large). As a Set that meant thousands of add()s per
  // tick plus a multi-hundred-KB backing store handed to the collector every
  // frame — the largest single source of GC churn in the game, and it is
  // render bookkeeping, not simulation state (nothing hashes it; see
  // net/hash.js).
  //
  // A flag byte per tile does the deduping instead, and a plain array holds
  // the order. Neither is reallocated: clear() walks the list to reset only
  // the bytes actually set, and the list keeps its capacity between frames,
  // so a steady state costs zero allocation. Keeps the Set surface the
  // renderer already uses — add/size/clear and for..of.
  makeDirtyTiles(size) {
    return {
      flag: new Uint8Array(size),
      list: [],
      count: 0,
      get size() { return this.count; },
      add(i) {
        if (this.flag[i]) return;
        this.flag[i] = 1;
        this.list[this.count++] = i;
      },
      clear() {
        const f = this.flag, l = this.list, n = this.count;
        for (let k = 0; k < n; k++) f[l[k]] = 0;
        this.count = 0;
      },
      *[Symbol.iterator]() {
        for (let k = 0; k < this.count; k++) yield this.list[k];
      }
    };
  },

  // The sim's one and only timestep. Under deterministic lockstep every
  // client has to advance the world by the exact same amount on the exact
  // same turn, so nothing in the simulation may ever see a wall-clock `dt`:
  // tick() steps by this constant and nothing else, and how often it is
  // called is a scheduling question for main.js, not a simulation input.
  // Numerically 1/TICKS_PER_SEC — that constant stays as the ticks->seconds
  // conversion the ported OpenFront formulas are written in terms of.
  TICK_DT: 0.1,
  // Integer turn counter, the sim's authoritative clock. Incremented exactly
  // once per tick() and never derived from anything else, so two clients that
  // have processed the same number of turns hold the same value bit-for-bit.
  ticks: 0,
  // Derived, never stored: accumulating `elapsed += dt` drifts (adding 0.1 ten
  // times gives 0.9999999999999999, not 1) and the drift is a function of how
  // many times you added, which is exactly the kind of history-dependence a
  // lockstep sim can't afford. Multiplying out from the integer instead gives
  // every client the same float from the same turn number.
  //
  // This is a getter — assigning to it silently does nothing (the file is not
  // in strict mode), so advance `ticks` instead.
  get elapsed() { return this.ticks * this.TICK_DT; },
  // Render-only clock: elapsed plus the fixed-timestep accumulator's current
  // leftover (see main.js's loop) so animations read a continuously
  // advancing time instead of snapping forward once per 0.1s tick — ticks
  // stay fixed-step for sim determinism, this just keeps drawing smooth
  // between them. Never read this for anything that affects simulation.
  renderElapsed: 0,
  nbuf: new Int32Array(4),
  abuf: new Int32Array(4),   // separate scratch so adjacency checks can't clobber nbuf
  pbuf: new Int32Array(4),   // and another, for frontier scoring inside those same loops
  bbuf: new Int32Array(4),   // scratch for setOwner's own border bookkeeping
  bbuf2: new Int32Array(4),  // nested scratch updateBorderTile uses per-neighbour, so it can't clobber bbuf mid-update

  // Real OpenFront dimensions, not estimates. Their featured "World" map — the
  // default/flagship map, rank 1 in their own catalogue — ships in three
  // official resolutions in resources/maps/world/manifest.json: map16x
  // (500x250), map4x (1000x500) and the full map (2000x1000), each exactly
  // double the last. small/medium/large are those three verbatim, one tier
  // down from their old names (the old small, a quarter-res guess with no
  // official OpenFront asset to match, is gone rather than kept as a fourth
  // tier — three real, verbatim sizes beat three real ones plus a guess).
  // All three land at a clean 2:1 aspect ratio as a result — the real map's
  // own ratio — replacing the arbitrary 1.6 this used to hold constant at.
  //
  // A full-commitment push still takes a few thousand tiles whatever the map,
  // so the same logic as before holds: on a small map one blow swallows a
  // fifth of the world and the match is over in minutes, while on large —
  // now genuinely their scale, not merely proportioned to look like it — the
  // same decisive push is a few percent of the board, keeping individual
  // attacks quick while wars run long. Generation at 2000x1000 (2M tiles)
  // measured ~700ms one-time cost; per-tick simulation cost is driven by
  // player/attack count, not tile count, so it stays flat regardless of size.
  MAP_SIZES: {
    small:  { width:  500, height: 250 },   // OpenFront's World, map16x
    medium: { width: 1000, height: 500 },   // OpenFront's World, map4x
    large:  { width: 2000, height: 1000 }   // OpenFront's World, full resolution
  },

  // gameStartInfo is {gameID, seed, config:{map?,mapSize,bots,tribes,
  // difficulty?}, players:[{clientID,username,playerId}]} — the exact shape
  // LocalServer.start and server/gameserver.js's start() both produce
  // (docs/multiplayer-architecture.md §4, §9 Phase 2). myPlayerId is a plain
  // integer, the caller's job to compute (main.js resolves it from
  // myClientID); this function never needs to know clientIDs or the network
  // layer exist.
  init(gameStartInfo, myPlayerId) {
    gameStartInfo = gameStartInfo || {};
    const config = gameStartInfo.config || {};
    const seed = gameStartInfo.seed >>> 0;
    this.rng = mulberry32(seed);
    // Nation tier for the whole match (economy.js NATION_DIFFICULTY, ai.js
    // PROFILES). Set on every init so a previous match's tier can't leak in;
    // anything unrecognised — including a lobby that sends none — is Medium.
    this.difficulty = this.DIFFICULTIES.includes(config.difficulty) ? config.difficulty : this.DEFAULT_DIFFICULTY;
    // Fog of war (docs/fog-of-war.md): a match option, off unless the config
    // says exactly true. Every fog rule is gated on this, so fog off is the
    // game as it always was.
    this.fog = config.fogOfWar === true;

    // `map: 'world'` selects OpenFront's real, baked "World" coastline
    // instead of a procedural one; `mapSize` is meaningless for it (the real
    // map has one fixed resolution, 2000x1000 — the same as MAP_SIZES.large)
    // and is ignored. Every other value (including none) is the procedural
    // generator, keyed by mapSize and shaped by the lobby's mapGen knobs.
    if (config.map === 'world') {
      if (!GameMap.worldData) {
        throw new Error('Game.init: map "world" selected but GameMap.worldData was not preloaded (see js/net/worldmap.js)');
      }
      this.sizeKey = 'world';
      GameMap.loadWorld(GameMap.worldData.bytes, GameMap.worldData.manifest);
    } else {
      const sizeKey = config.mapSize;
      const size = this.MAP_SIZES[sizeKey] || this.MAP_SIZES.medium;
      this.sizeKey = sizeKey in this.MAP_SIZES ? sizeKey : 'medium';
      GameMap.generate(size.width, size.height, seed, config.mapGen);
    }

    // Player id space: 0..H-1 are humans, one per roster entry (real
    // usernames, not a hardcoded 'You'), H..H+botCount-1 are Nations, the
    // rest are Tribes — matching the order OpenFront lists them in
    // (Bots/Tribes are "the other" type, distinct from Nations). Only the
    // Nations and Tribes get an algorithmic spawn here — humans pick their
    // own afterward, OpenFront-style, so they aren't placed until
    // chooseSpawn() runs.
    const roster = Array.isArray(gameStartInfo.players) ? gameStartInfo.players : [];
    const H = roster.length;
    const botCount = config.bots | 0;
    const tribeCount = config.tribes | 0;
    const total = H + botCount + tribeCount;
    // One findSpawns call, sized for humans too, even though humans don't get
    // placed here (see below) — this is what MP-3.2 needs a fallback tile for
    // every human at the spawn-phase deadline. Both allocations (the human
    // reserves and the NPC spawns) come off the same continuous, deterministic
    // rng stream, so every client partitions the returned array identically:
    // the first H tiles are reserved for humans (roster order == playerId
    // order), the rest go to NPCs exactly as before this change.
    const allSpawns = GameMap.findSpawns(H + botCount + tribeCount, this.rng);
    this.humanReserveTiles = allSpawns.slice(0, H);
    const npcSpawns = allSpawns.slice(H);

    // Each human is placed by its own roster entry's `.playerId` field, not
    // by array position — today the server always hands out contiguous
    // 0..H-1 in join order so the two coincide, but binding to the field is
    // the more correct read.
    const rosterByPlayerId = new Map();
    for (const entry of roster) if (entry) rosterByPlayerId.set(entry.playerId, entry);

    this.players = [];
    this.attacks = [];
    this.nextAttackId = 1;
    this.boats = [];
    this.nextBoatId = 1;
    this.dirtyTiles = this.makeDirtyTiles(GameMap.owner.length);
    this.buildings = new Map();
    this.railroads = [];
    this.nextRailId = 1;
    this.trains = [];
    this.nextTrainId = 1;
    this.tradeShips = [];
    this._portRoutes = new Map();
    this.warships = [];
    this.nextWarshipId = 1;
    // Client-local presentation only, so it is cleared alongside the sim's own
    // per-match state but deliberately does not live on it — see js/fx.js.
    Fx.reset();
    this.shells = [];
    this.samFlashes = [];
    this.nukes = [];
    this.nukeBlasts = [];
    // MIRV (ticket #28): the "mothership" missile in flight, before it
    // splits into individual MIRVWarhead nukes — see nukes.js's launchMirv/
    // stepMirvs. Kept out of this.nukes entirely (not SAM-interceptable —
    // see stepMirvs' own comment) rather than folded into it, so a plain
    // `this.nukes.length` check (stepSAMs, drawNukes) never has to
    // special-case a shape it can't act on. mirvsLaunched is a lifetime,
    // whole-match counter (not per-player) — Config.ts's own MIRV cost rises
    // with EVERY player's launches, not just the buyer's own, see unitCost.
    this.mirvs = [];
    this.mirvsLaunched = 0;
    // Irradiated land — see detonateNuke/falloutDefenseModifier. Tile
    // indices, always unowned land (GameImpl's own setFallout throws if the
    // tile has an owner) — cleared the instant anyone actually captures one.
    this.fallout = new Set();
    this.alliances = [];
    this.requests = [];
    this.lastRequestAt = new Map();
    // Defensive fallback to 0 if myPlayerId is not a valid integer in range
    // — singleplayer-safe, not expected to ever actually trigger (main.js
    // always resolves a real index from the roster it just built `total`
    // from).
    this.me = (Number.isInteger(myPlayerId) && myPlayerId >= 0 && myPlayerId < total) ? myPlayerId : 0;
    this.ticks = 0;
    this.renderElapsed = 0;

    // How many of this.players are humans (indices 0..humanCount-1) — stored
    // rather than recomputed so tickSpawnPhase's NPC loop and the deadline
    // auto-placement loop below both know where "NPC" starts without
    // re-deriving it from the roster every call.
    this.humanCount = H;
    // Separate, unconditional turn counter for the spawn phase. Game.ticks
    // (and Game.elapsed, which is derived from it) is incremented only inside
    // tick()'s post-spawning body — by design, see the getter's own comment —
    // so it stays frozen at 0 for the entire spawn phase and can never drive
    // a spawn-phase deadline. tickSpawnPhase() increments this one instead,
    // once per call, which happens exactly once per turn while this.spawning
    // is true.
    this.spawnPhaseTicks = 0;
    // Per D1: a solo player has nobody to wait for, so singleplayer keeps the
    // short window; any match with more than one human gets the long one so
    // every human has a real chance to place before the deadline.
    this.SPAWN_PHASE_TURNS = H > 1 ? 150 : 100;

    for (let p = 0; p < total; p++) {
      const isHuman = p < H;
      const isTribe = !isHuman && p >= H + botCount;
      const isBot = !isHuman && !isTribe;
      let name, color, startTroops;
      if (isHuman) {
        const entry = rosterByPlayerId.get(p);
        name = (entry && typeof entry.username === 'string' && entry.username) ? entry.username : ('Player ' + p);
        color = PLAYER_COLORS[p % PLAYER_COLORS.length];
        startTroops = this.START_TROOPS_HUMAN;
      } else if (isTribe) {
        const t = p - H - botCount;
        name = tribeName(t); color = TRIBE_COLORS[t % TRIBE_COLORS.length];
        startTroops = this.START_TROOPS_TRIBE;
      } else {
        // Nations. Name/color indexing is shifted by H so the first bot
        // (now at index H, whatever H is) is still BOT_NAMES[0] / the same
        // color the first bot always got, regardless of how many humans
        // are ahead of it in the id space. PLAYER_COLORS/BOT_NAMES have 64
        // entries each — enough for the 60-bot UI ceiling plus a few humans
        // — and still wrap with `%` rather than growing further, a
        // pre-existing, accepted, purely cosmetic fallback if that's ever
        // exceeded.
        name = BOT_NAMES[(p - H) % BOT_NAMES.length];
        color = PLAYER_COLORS[(p - H + 1) % PLAYER_COLORS.length];
        startTroops = this.nationDifficulty().startTroops;
      }
      this.players.push({
        id: p,
        name, color,
        isBot,
        isTribe,
        isHuman,
        troops: startTroops * this.POP_SCALE,
        gold: this.START_GOLD,
        // Structures held, by type. Kept as a running count rather than derived
        // from the buildings map because maxTroops reads it on every player
        // every tick, and again 120 times over inside peakGrowthRatio's scan.
        // Only counts COMPLETED structures — one still under construction
        // doesn't grant its pop bonus yet. See buildings' `built` flag.
        units: { city: 0, fort: 0, factory: 0, port: 0 },
        // Lifetime count of this player's own builds, by type — never
        // decremented. What unitCost actually prices against; see its comment.
        unitsBuilt: { city: 0, fort: 0, factory: 0, port: 0 },
        // Under-construction structures this player has committed gold to but
        // that haven't finished yet. Folded into unitCost alongside `units` so
        // queuing several at once still prices each one higher than the last —
        // without this, price doubling would only bite once the first of a
        // batch actually completes, since `units` itself stays put till then.
        unitsPending: { city: 0, fort: 0, factory: 0, port: 0 },
        tiles: new Set(),
        // Owned tiles with at least one non-owned neighbour — kept in sync by
        // setOwner's border bookkeeping. refreshFrontier scans this instead
        // of all of `tiles` so rescanning a front costs perimeter, not area.
        borderTiles: new Set(),
        alive: true,
        allies: new Set(),
        // How each nation feels about every other, on OpenFront's [-100, 100]
        // scale. Absent means Neutral. Only the bots read it, but the human
        // carries one too so nothing has to special-case player 0.
        relations: new Map(),
        // Who this player refuses to trade with — see the Embargoes section
        // of game/diplomacy.js.
        embargoes: new Map(),
        lastEmbargoAllAt: -Infinity,
        // Nation AI bookkeeping: who has already cost us the one-off
        // embargo relation hit (AI.updateRelationsFromEmbargoes).
        embargoMalusFrom: new Set(),
        // recipientId -> Game.elapsed of the last gold OR troop donation sent
        // to them. OpenFront's PlayerImpl.sentDonations is a single list shared
        // by both donation types (canDonateGold and canDonateTroops both walk
        // it), so one cooldown table covers both here too — see
        // game/diplomacy.js's DONATE_COOLDOWN.
        lastDonationAt: new Map(),
        // Enemies this player has marked, as { at: Game.elapsed, id } —
        // see the Target marking section of game/diplomacy.js.
        targets: [],
        traitorUntil: 0,
        betrayals: 0,
        // When and by whom a fresh front (land or boat) last opened on this
        // player — AI.freshFrontLocked stops other nations piling on at once.
        frontOpenedAt: -Infinity,
        frontOpenedBy: -1,
        nextThink: 1 + this.rng() * 4,
        // TribeExecution's per-tribe rolls (see TribeAI.rollTraits), drawn here
        // from the seeded rng so every client rolls the same values.
        tribeTraits: isTribe ? TribeAI.rollTraits() : null,
        // A Nation's AiAttackBehavior rolls (see AI.rollTraits).
        aiTraits: isBot ? AI.rollTraits() : null,
        // Naval targeting runs a BFS instead of a map scan, so it thinks on a
        // deliberately coarser cadence than nextThink's land decisions.
        nextNavalThink: 5 + this.rng() * 10,
        // Landmass id -> tick until which navalThink skips it, after a sea
        // route there failed (AI.NAVAL_NO_ROUTE_TICKS).
        navalNoRoute: new Map()
      });
    }

    // Team modes (game/teams.js). A no-op for FFA.
    this.setupTeams(config, H, botCount);
    // Fog of war vision state (game/vision.js). Allocates nothing with fog
    // off. Before the first claim below, which already reveals.
    this.initVision();

    // Spawn-pick phase: every Nation/Tribe claims a provisional starting disc
    // immediately, then keeps re-rolling it to a new nearby spot every
    // couple of seconds — "still deciding" — until the timed spawn-phase
    // deadline hits (SPAWN_PHASE_TURNS, below). spawnCenters is each NPC's
    // anchor; jumps stay within SPAWN_JUMP_RADIUS of it so a nation wobbles
    // around one general area instead of roaming the map. Driven by
    // tick() -> tickSpawnPhase, same as normal simulation, just gated on
    // `spawning` instead of `running`.
    this.spawnCenters = new Array(total).fill(-1);
    this.nextSpawnJumpAt = new Array(total).fill(0);
    for (let p = H; p < total; p++) {
      this.spawnCenters[p] = npcSpawns[p - H];
      this.claimStart(npcSpawns[p - H], p);
      this.nextSpawnJumpAt[p] = this.SPAWN_JUMP_MIN + this.rng() * (this.SPAWN_JUMP_MAX - this.SPAWN_JUMP_MIN);
    }

    this.spawning = true;
    this.running = false;
    this.winnerId = null;
    // Nations only — humans + bots, never tribes — is what "5th out of 32"
    // on the defeat screen counts against. Fixed for the whole match: it
    // never shrinks as nations die, so a placement recorded mid-match still
    // reads correctly once the match is long over.
    this.nationCount = H + botCount;
    // playerId -> finishing place (1 = last nation standing), filled in by
    // eliminatePlayer as nations die. A nation still alive has no entry —
    // the eventual winner never gets one, since it never dies.
    this.placements = new Map();
    this.dirty = true;
  },

  // The one place a nation's `alive` flips to false — both the tile/troop
  // sweep in tick() and annexRegion's wipe-out route call this instead of
  // setting p.alive directly, so every elimination also records the
  // placement the defeat screen (UI.checkEndGame) reads: how many nations
  // (tribes excluded — they were never contestants) were still alive,
  // including this one, at the moment it went out. Guarded by p.alive so a
  // player already eliminated can't be double-counted or overwrite its
  // placement.
  eliminatePlayer(p) {
    if (!p.alive) return;
    if (!p.isTribe) {
      let aliveCount = 0;
      for (const q of this.players) {
        if (!q.isTribe && q.alive) aliveCount++;
      }
      this.placements.set(p.id, aliveCount);
    }
    p.alive = false;
  },

  // Same no-reason/reason shape as buildBlockReason: null means the tap is
  // good, a string is what the spawn banner should say back.
  spawnBlockReason(tile) {
    if (!this.spawning) return 'Game already started';
    if (tile < 0 || !GameMap.isLand(tile)) return 'Choose a land tile';
    // "Unclaimed" already means "not currently held by anyone, human or
    // NPC" — so two humans picking distinct legal spots never collide, and a
    // human re-picking a tile inside their own current disc will (harmlessly)
    // be told it's claimed by themselves. Not worth special-casing.
    if (GameMap.owner[tile] !== NEUTRAL) return 'Already claimed';
    const w = GameMap.width, x = tile % w, y = (tile / w) | 0;
    // Same 90-of-121 density gate findSpawns uses for its own candidates, so a
    // player-chosen capital can't land somewhere findSpawns itself would have
    // rejected — a sliver of coast too thin to hold a real starting disc.
    if (GameMap.landAround(x, y, 5) < 90) return 'Not enough land here';
    return null;
  },

  canChooseSpawn(tile) { return !this.spawnBlockReason(tile); },

  // `playerId` defaults to this.me so the existing single-player call sites
  // (ui.js's spawn tap, the Hash harness) are unchanged, but the actor is a
  // parameter because under lockstep the sim may not ask who is *viewing* —
  // a spawn arrives stamped with whose it is (MP-1.2's Executor passes the
  // clientID-resolved player and never the view pointer). The default is the
  // last remaining Game.me read on this path and disappears with MP-1.5.
  //
  // MP-3.2: this only claims (or re-claims) the caller's own provisional
  // disc — it does NOT end the spawn phase any more. Ending it that way was
  // the exact bug this task exists to fix: under two or more humans, the
  // first one to tap would flip `spawning` false for everyone, locking out
  // anyone who hadn't placed yet. The phase now ends only via the tick-driven
  // deadline in tickSpawnPhase, for every human at once, regardless of how
  // many have already placed — so a human can call this any number of times
  // before the deadline (a re-pick after already placing) and it keeps
  // working, the same unclaimAll-then-claimStart pattern jumpSpawnPreview
  // already uses for NPCs, just triggered by a player's tap instead of a
  // timer.
  chooseSpawn(tile, playerId) {
    if (!this.canChooseSpawn(tile)) return false;
    const id = playerId === undefined ? this.me : playerId;
    // A re-pick: drop the old claim before claiming the new one, same as
    // jumpSpawnPreview's own retract-then-reclaim. spawnBlockReason's
    // "unclaimed" check already means "not currently held by anyone, human
    // or NPC" — two humans picking distinct legal spots never collide, and a
    // human re-picking a tile they already hold is (harmlessly) told it's
    // "already claimed" by themselves, not worth special-casing.
    if (this.players[id].tiles.size > 0) this.unclaimAll(id);
    this.claimStart(tile, id);
    return true;
  },

  // How often, in seconds, an NPC's provisional spawn disc jumps to a new
  // nearby spot — randomized per-jump between these two so 30 nations don't
  // all move in lockstep.
  SPAWN_JUMP_MIN: 1,
  SPAWN_JUMP_MAX: 2,
  // How far from its anchor (spawnCenters[p]) a jump can land, in tiles —
  // keeps the wobble inside one general area instead of roaming the map.
  SPAWN_JUMP_RADIUS: 10,

  // Un-claims everything `playerId` currently holds. Only ever used to
  // retract a provisional spawn-preview disc immediately before claiming a
  // new one elsewhere — see jumpSpawnPreview.
  unclaimAll(playerId) {
    const p = this.players[playerId];
    for (const t of Array.from(p.tiles)) this.setOwner(t, NEUTRAL);
  },

  // Retracts this NPC's current preview disc and claims a fresh one within
  // SPAWN_JUMP_RADIUS of its anchor. Candidate spots are held to the same
  // land-density-and-neutrality bar a human's own spawnBlockReason enforces,
  // so the preview never lands somewhere a real capital couldn't; falls back
  // to re-claiming the anchor itself if nothing better turns up nearby.
  jumpSpawnPreview(playerId) {
    const center = this.spawnCenters[playerId];
    const w = GameMap.width, h = GameMap.height;
    const cx = center % w, cy = (center / w) | 0;
    const r = this.SPAWN_JUMP_RADIUS;
    let target = center;
    for (let attempt = 0; attempt < 20; attempt++) {
      const nx = cx + Math.floor((this.rng() * 2 - 1) * r);
      const ny = cy + Math.floor((this.rng() * 2 - 1) * r);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const tile = GameMap.idx(nx, ny);
      if (!GameMap.isLand(tile) || GameMap.owner[tile] !== NEUTRAL) continue;
      if (GameMap.landAround(nx, ny, 5) < 90) continue;
      target = tile;
      break;
    }
    this.unclaimAll(playerId);
    this.claimStart(target, playerId);
  },

  // Advances every NPC's spawn-preview jump clock, then advances the spawn
  // phase's own turn counter and ends the phase once the deadline hits. This
  // is the only thing tick() drives while spawning — no simulation (gold,
  // growth, attacks) runs until the phase is over.
  //
  // The NPC loop starts at `this.humanCount`, not the old hardcoded `1`. That
  // `1` was a leftover from before MP-3.1 generalized player construction to
  // H humans at indices 0..H-1 — it happened to be harmless for H===1 (there
  // was only ever one human, at index 0, to skip) but under H>1 it let this
  // loop call jumpSpawnPreview on the *second* human, which unconditionally
  // unclaims and re-randomizes that player's tiles — silently destroying and
  // relocating a second human's chosen capital every 1-2 seconds for as long
  // as the spawn phase ran. This is exactly the bug MP-3.2 exists to fix.
  tickSpawnPhase() {
    for (let p = this.humanCount; p < this.players.length; p++) {
      // Tribes hold a fixed spot — only Nations (bots) wobble their
      // provisional disc during the countdown.
      if (this.players[p].isTribe) continue;
      this.nextSpawnJumpAt[p] -= this.TICK_DT;
      if (this.nextSpawnJumpAt[p] <= 0) {
        this.jumpSpawnPreview(p);
        this.nextSpawnJumpAt[p] = this.SPAWN_JUMP_MIN + this.rng() * (this.SPAWN_JUMP_MAX - this.SPAWN_JUMP_MIN);
      }
    }

    this.spawnPhaseTicks++;
    if (this.spawnPhaseTicks >= this.SPAWN_PHASE_TURNS) {
      // Deadline hit: anyone who never sent (or whose intent never arrived)
      // a spawn is auto-placed at their reserved tile from init(). A human
      // who already placed is untouched — tiles.size > 0 skips them.
      for (let p = 0; p < this.humanCount; p++) {
        if (this.players[p].tiles.size === 0) this.claimStart(this.humanReserveTiles[p], p);
      }
      this.spawning = false;
      this.running = true;
      // No explicit NPC "freeze" needed: the instant spawning is false,
      // tick()'s own top guard means tickSpawnPhase (and jumpSpawnPreview)
      // is simply never called again.
    }
  },

  claimStart(center, playerId) {
    // Radius 5 against a squared cutoff of 29 (~radius 5.39, rather than the
    // exact r*r=25) rasterizes as a smooth 5/7/9/11/11/11/11/11/9/7/5-wide
    // blob — wide enough that the per-row taper is only ever 1-2 tiles, so it
    // reads as round rather than faceted. (Plain dx*dx+dy*dy<=r*r at a small
    // radius sticks a tile out on all four cardinal sides — the middle row
    // outgrows its neighbors by 2+ — which reads as a four-pointed/triangular
    // shape instead of round.) This 97-tile disc puts a fresh spawn's cap at
    // ~13.1k, a bit above the 12.1k OpenFront opens with, traded for a
    // rounder starting territory.
    const r = 5;
    const rSq = 29;
    const w = GameMap.width;
    const cx = center % w, cy = (center / w) | 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > rSq) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= GameMap.height) continue;
        const i = GameMap.idx(nx, ny);
        if (GameMap.owner[i] === NEUTRAL) this.setOwner(i, playerId);
      }
    }
  },

  setOwner(i, newOwner) {
    const old = GameMap.owner[i];
    if (old >= 0) this.players[old].tiles.delete(i);
    GameMap.owner[i] = newOwner;
    // A cached sea route starts from its owner's coast as it stood when found.
    if (this._coastPathMemo.size) this._coastPathMemo.clear();
    if (newOwner >= 0) {
      this.players[newOwner].tiles.add(i);
      // GameImpl's own conquer() unconditionally clears fallout the instant
      // a tile is actually captured by a real player — "decontaminated" by
      // resettlement — regardless of whether it had any to begin with. Only
      // gated on a real capture (newOwner >= 0), not every ownership change
      // this function handles — reverting to NEUTRAL (e.g. an eliminated
      // player's tiles, or unclaimAll's spawn-phase churn) must NOT clear
      // fallout, since an irradiated tile sitting unclaimed is exactly the
      // steady state the mechanic depends on.
      this.fallout.delete(i);
      // Fog of war: territory reveals the map around it (game/vision.js).
      if (this.fog) this.visionTileGained(i, newOwner);
    }

    // Border bookkeeping: only tile i and its immediate neighbours can have
    // moved in or out of border status. A neighbour's own owner didn't
    // change here, and i was "not that owner" both before and after unless
    // it's old or newOwner, so no third party's border status is affected —
    // only those two players' sets need rechecking, over just these tiles.
    const bb = this.bbuf;
    const bn = GameMap.neighbors(i, bb);
    const n0 = bn > 0 ? bb[0] : -1, n1 = bn > 1 ? bb[1] : -1,
          n2 = bn > 2 ? bb[2] : -1, n3 = bn > 3 ? bb[3] : -1;
    this.updateBorderTile(old, i);
    this.updateBorderTile(newOwner, i);
    if (n0 >= 0) { this.updateBorderTile(old, n0); this.updateBorderTile(newOwner, n0); }
    if (n1 >= 0) { this.updateBorderTile(old, n1); this.updateBorderTile(newOwner, n1); }
    if (n2 >= 0) { this.updateBorderTile(old, n2); this.updateBorderTile(newOwner, n2); }
    if (n3 >= 0) { this.updateBorderTile(old, n3); this.updateBorderTile(newOwner, n3); }

    // A structure belongs to whoever holds the ground under it. Routing capture
    // through the one function that moves a tile means a city changes hands the
    // instant its tile does — no separate bookkeeping to fall out of step, and
    // the pop cap it grants follows the front automatically. This does NOT
    // touch unitsBuilt — OpenFront's own PlayerImpl.captureUnit only reassigns
    // ownership and never calls recordUnitConstructed, so a captured city
    // moves the pop bonus and the current-holdings count (units), but not the
    // lifetime-built count unitCost actually prices against. See unitCost.
    const b = this.buildings.get(i);
    if (b) {
      if (!b.built) {
        if (old >= 0) {
          const op = this.players[old];
          op.unitsPending[b.type] = Math.max(0, this.unitsPending(op, b.type) - 1);
        }
        // Defensive Fort under construction is destroyed outright, same as a
        // finished one below — a strongpoint doesn't hand its half-built
        // fortifications to the attacker either. Reverting to unclaimed
        // (newOwner < 0, e.g. an eliminated player's tiles going NEUTRAL)
        // also has nobody left to finish the site, so it's lost the same way.
        if (b.type === 'fort' || newOwner < 0) {
          this.buildings.delete(i);
        } else {
          // Overrun mid-construction: the half-finished structure isn't lost
          // — the attacker inherits the build site and it keeps ticking
          // toward completion under the new flag, same as OpenFront's own
          // captureUnit transferring a functioning structure whole.
          // updateConstruction reads ownership fresh off the tile (see its
          // own comment), so nothing else needs to move here but the pending
          // count. The original builder's sunk gold still stays sunk — only
          // the unfinished structure itself, not a refund, changes hands.
          const np = this.players[newOwner];
          np.unitsPending[b.type] = this.unitsPending(np, b.type) + 1;
        }
      } else if (b.type === 'fort') {
        // Defensive Fort is destroyed, not captured, once the enemy pushes
        // through its tile — a strongpoint that falls doesn't hand its
        // fortifications to the attacker. Deliberate divergence from
        // OpenFront's own captureUnit (which transfers every unit type
        // uniformly, City/Factory/Port included), per user request.
        // unitsBuilt (lifetime, pricing) is untouched, same as a captured
        // structure — only the current holding disappears. Floored at 0 so a
        // stale/uninitialized count can never go negative and underprice the
        // owner's next build (see unitCost).
        if (old >= 0) {
          const op = this.players[old];
          op.units[b.type] = Math.max(0, this.unitsOwned(op, b.type) - b.level);
        }
        this.buildings.delete(i);
      } else {
        // Overrun mid-upgrade: the level in progress is lost the same way a
        // fresh build site is above — the attacker inherits the city at its
        // CURRENT level, not the level it was climbing to, and the original
        // owner's sunk gold stays sunk. This does not delete the building
        // (unlike the !b.built branch) since it's already a functioning,
        // captured structure regardless.
        if (b.upgrading) {
          b.upgrading = false;
          b.progress = 0;
          if (old >= 0) {
            const op = this.players[old];
            op.unitsPending[b.type] = Math.max(0, this.unitsPending(op, b.type) - 1);
          }
        }
        // A structure's full level moves with it, per OpenFront's own
        // captureUnit — see the UNITS comment on why units[type] is a sum of
        // levels rather than a headcount. Floored at 0 so a stale/
        // uninitialized count can never go negative and underprice the
        // owner's next build (see unitCost).
        if (old >= 0) {
          const op = this.players[old];
          op.units[b.type] = Math.max(0, this.unitsOwned(op, b.type) - b.level);
        }
        if (newOwner >= 0) {
          const np = this.players[newOwner];
          np.units[b.type] = this.unitsOwned(np, b.type) + b.level;
        }
      }
    }
    // Border shading depends on a tile's neighbors too (see Render.paintTile),
    // so a change here can shift how up to 4 neighboring pixels should look
    // even though their own owner didn't move.
    const w = GameMap.width, h = GameMap.height, x = i % w, y = (i / w) | 0;
    this.dirtyTiles.add(i);
    if (x > 0) this.dirtyTiles.add(i - 1);
    if (x < w - 1) this.dirtyTiles.add(i + 1);
    if (y > 0) this.dirtyTiles.add(i - w);
    if (y < h - 1) this.dirtyTiles.add(i + w);
  },

  // Recomputes whether `tile` counts as a border tile for `playerId` — owned
  // by them with at least one neighbour NOT owned by them — and updates
  // their borderTiles set to match. Called by setOwner on the tile that
  // changed hands and each of its neighbours, for whichever of old/newOwner
  // they belong to; `playerId` may be NEUTRAL/WATER (< 0), which has no set
  // to touch. Uses bbuf2 rather than bbuf since setOwner is still holding a
  // neighbour list of its own in bbuf while it calls this.
  updateBorderTile(playerId, tile) {
    if (playerId < 0) return;
    const player = this.players[playerId];
    if (GameMap.owner[tile] !== playerId) { player.borderTiles.delete(tile); return; }
    const nb = this.bbuf2;
    const n = GameMap.neighbors(tile, nb);
    let isBorder = false;
    for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] !== playerId) { isBorder = true; break; }
    if (isBorder) player.borderTiles.add(tile); else player.borderTiles.delete(tile);
  },

  // --- Entity lookup by id ---------------------------------------------------
  //
  // The id -> object direction of the scheme documented at nextAttackId. Every
  // one of these returns null rather than undefined when the id names nothing,
  // and none of them throws or falls back to "the nearest one": an id that has
  // ended (an attack consolidated away, a boat that landed, a sunk warship)
  // must resolve to nothing, and must do so identically on every client. The
  // Executor turns that null into a silently dropped intent.
  //
  // Linear scans. Attacks and boats are bounded by the player count and
  // MAX_BOATS_PER_PLAYER, warships by MAX_WARSHIPS_PER_PLAYER, and these run
  // once per cancel/move intent — not per tick — so an index would be pure
  // bookkeeping to keep in sync for no measurable gain. Same call made for
  // allianceBetween above.
  attackById(id) {
    for (const a of this.attacks) if (a.id === id) return a;
    return null;
  },

  boatById(id) {
    for (const b of this.boats) if (b.id === id) return b;
    return null;
  },

  warshipById(id) {
    for (const w of this.warships) if (w.id === id) return w;
    return null;
  },

  // One simulation turn. Takes no argument by design — see TICK_DT: the step
  // is a constant of the simulation, not something the caller gets to vary.
  tick() {
    if (this.spawning) { this.tickSpawnPhase(); return; }
    if (!this.running) return;
    this.ticks++;

    // See SEA_PATH_NODE_BUDGET_PER_TICK (naval.js): bounds how much seaPath
    // work this tick's port/warship/AI updates below are allowed to start.
    // Both it and the coast-path memo (nearestCoastPath) only apply while
    // _inTick is set: outside tick() — intents applied just before it, and
    // client-local UI such as the radial menu's Boat check — searches run
    // unbudgeted and uncached, so one client's UI can never spend budget or
    // plant a cached path that another client's sim doesn't see.
    this._seaPathSearchesThisTick = 0;
    this._seaPathNodesThisTick = 0;
    this._coastPathMemo.clear();
    this._inTick = true;

    for (const p of this.players) {
      if (!p.alive) continue;

      // No cap and no decay: a treasury is a store, not a population.
      p.gold += this.goldPerSecond(p) * this.TICK_DT;

      // The cap governs the home reserve. Troops already marching are outside
      // it, so sending an army frees the room it occupied to refill — the
      // pressure not to over-commit comes from being weak while they are away,
      // not from an accounting penalty.
      const room = this.maxTroops(p);
      if (p.troops < room) {
        p.troops = Math.min(room, p.troops + this.growthPerSecond(p) * this.TICK_DT);
      } else if (p.troops > room) {
        // Losing land lowers the cap, and the population has to follow it down.
        // Without this a shrinking nation keeps the army its former empire
        // supported, so conquest never actually weakens anyone. OpenFront has
        // no separate decay for this — troopIncreaseRate's own
        // min(troops+toAdd, max) clamps straight to the cap, and toAdd's
        // magnitude (tens to low thousands) is negligible next to any
        // realistic overshoot, so in practice it's an instant snap on the very
        // next tick, not a bleed. A prior version invented a gradual 0.5/s
        // decay here with no OpenFront counterpart; this replaces it.
        p.troops = room;
      }
    }

    this.updateConstruction();

    this.resolveOpposingFronts();

    for (let a = this.attacks.length - 1; a >= 0; a--) {
      if (!this.stepAttack(this.attacks[a])) this.attacks.splice(a, 1);
    }

    if (this.ticks % this.ANNEX_SWEEP_TICKS === 0) this.checkAnnexations();

    this.stepBoats();
    this.updateFactoryStations();
    this.stepTrains();
    this.updatePortTrade();
    this.stepTradeShips();
    this.stepWarships();
    this.stepShells();
    // Must run before stepSAMs/stepNukes: a MIRV that splits this tick has
    // to land its fresh MIRVWarhead entries in this.nukes before either one
    // runs, so a warhead can be shot down or can detonate the very same tick
    // its parent missile arrives, rather than getting one free tick of
    // immunity purely from array-processing order.
    this.stepMirvs();
    // Must run before stepNukes: a nuke a SAM successfully intercepts this
    // tick has to be removed from this.nukes before stepNukes' own duration
    // check gets a chance to detonate the same object.
    this.stepSAMs();
    this.stepNukes();

    for (const p of this.players) {
      if (p.alive && p.tiles.size === 0 && p.troops < 20) this.eliminatePlayer(p);
    }

    // Win condition (MP-3.5), computed here — not in UI — because it has to
    // land on the same turn for every client. This runs off the `alive`
    // sweep just above and Game.fallout/GameMap.landTiles, none of which
    // depend on Game.me, so every client evaluates it identically. Decided
    // exactly once: once winnerId is set, later ticks skip straight past
    // this block (the `this.winnerId === null` guard) so a later tick can
    // never recompute or overwrite it.
    //
    // Deliberately does NOT special-case isDisconnected players: per MP-3.4,
    // a disconnected player's nation keeps existing and keeps being
    // simulated, so if it still holds territory it is a legitimate sole
    // survivor or a legitimate blocker of someone else's 95% threshold,
    // exactly as if they were still playing.
    // Team games win per team instead — see checkTeamWin in game/teams.js.
    if (this.teams) this.checkTeamWin();
    else if (this.winnerId === null) {
      // Counted in a loop rather than collected with filter(): this runs on
      // every tick of every match, and the array it used to build was thrown
      // away again immediately.
      let aliveCount = 0, lastAlive = null;
      for (const p of this.players) {
        if (p.alive && p.tiles.size > 0) { aliveCount++; lastAlive = p; }
      }
      if (aliveCount === 1) {
        this.winnerId = lastAlive.id;
      } else {
        // OpenFront's WinCheckExecution excludes irradiated land from the
        // denominator: numTilesWithoutFallout = numLandTiles -
        // numTilesWithFallout(). Radiated ground isn't required to win — it
        // just shrinks the total a player needs to own, same as this port's
        // Game.fallout Set. Checked against every player, not just Game.me
        // — the old UI.checkEndGame only ever tested the local human.
        // Threshold is the win threshold (90, same as
        // Teams.WIN_PERCENT), cross-multiplied like hasWon() (issue #33).
        const tilesNeededDenominator = GameMap.landTiles - this.fallout.size;
        if (tilesNeededDenominator > 0) {
          for (const p of this.players) {
            if (p.tiles.size * 100 > tilesNeededDenominator * 90) {
              this.winnerId = p.id;
              break;
            }
          }
        }
      }
      // Flips at most once, on the exact tick winnerId is decided, so this
      // tick still finishes its own body (diplomacy/AI below) normally and
      // every SUBSEQUENT tick — on every client — hits tick()'s own
      // `if (!this.running) return` guard identically.
      if (this.winnerId !== null) this.running = false;
    }

    // A boat belonging to a nation that just died has nobody left to receive
    // its troops or spoils — refunding it would be meaningless, so it's
    // simply dropped, the same way a dead nation's pending alliance offers
    // are dropped in updateDiplomacy just below.
    for (let i = this.boats.length - 1; i >= 0; i--) {
      if (!this.players[this.boats[i].attacker].alive) this.boats.splice(i, 1);
    }
    // Same treatment for a dead nation's warships — nobody left to crew them.
    for (let i = this.warships.length - 1; i >= 0; i--) {
      if (!this.players[this.warships[i].owner].alive) this.warships.splice(i, 1);
    }

    // After the death sweep, so a nation that fell this tick takes its
    // alliances and pending offers with it.
    this.updateDiplomacy();

    AI.update();
    TribeAI.update();

    this._inTick = false;
    this._coastPathMemo.clear();
  },

  // Dev-only: jumps the match forward by running tick() back-to-back instead
  // of waiting in realtime. Every tick is the same fixed TICK_DT the main
  // loop drives, so this produces the exact economy/AI/combat a played-out
  // match would — just compressed into one synchronous burst. No-ops before
  // the human has spawned, same as tick() itself (this.running is false
  // until then).
  //
  // Counted in whole ticks rather than by accumulating seconds: the sim's
  // clock IS the tick count now (see TICK_DT), so "300 seconds" is exactly
  // 3000 turns, with no float loop counter to drift the burst a tick long or
  // short. Under lockstep this is the same shape as replaying a turn list.
  //
  // NO SHIELD. There used to be a `humanShielded` flag here that froze every
  // attack, boat and capture aimed at `Game.me` for the duration of the burst,
  // so the human could not lose ground while the sim ran blind. It is gone
  // (MP-1.4): every one of its branches tested `=== this.me` inside the
  // simulation, which is precisely the player-relative branching Phase 0
  // removed everywhere else, and it was the last of that class in this file.
  // A sim that behaves differently depending on who is watching it desyncs.
  // The cost is real and accepted: a burst can now cost the human territory,
  // in a dev-only tool.
  //
  // MP-1.5 replaces this bare tick loop with LocalServer.burst(turns), which
  // pushes the same number of turns through the ordinary intent/turn pipeline
  // instead of reaching past it into Game.tick.
  fastForward(seconds) {
    const turns = Math.round(seconds / this.TICK_DT);
    for (let t = 0; t < turns && this.running; t++) this.tick();
  },

};
