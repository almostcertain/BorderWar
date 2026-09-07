// Enough distinct hues to fill a crowded Extra Large map without two nations
// sharing a colour. Ordered so that the first handful stay far apart, which is
// what a small game actually sees.
const PLAYER_COLORS = [
  [ 90, 160, 255], [235,  90,  90], [ 95, 205, 130], [245, 175,  70],
  [190, 120, 240], [ 80, 215, 215], [240, 130, 195], [175, 190,  95],
  [130, 145, 235], [225, 120,  60], [110, 200, 175], [205,  95, 150],
  [140, 210, 255], [255, 140, 110], [ 70, 170,  95], [215, 200,  90],
  [155,  95, 210], [ 60, 165, 185], [255, 175, 210], [125, 150,  70],
  [ 95, 110, 200], [190,  85,  45], [150, 225, 200], [235, 145, 175],
  [175, 205, 255], [200,  70,  95], [125, 235, 145], [205, 150,  60],
  [225, 175, 255], [ 45, 130, 150], [255, 205, 130], [ 90, 125, 115]
];

const BOT_NAMES = [
  'Varra', 'Kessel', 'Dorne', 'Ashfall', 'Mirek', 'Solane', 'Torvik', 'Halcyon',
  'Brackwater', 'Ondar', 'Vesper', 'Karth', 'Selvane', 'Cadros', 'Umbra', 'Feltmark',
  'Nyral', 'Hastrel', 'Drakemoor', 'Iselle', 'Corvane', 'Ptarmis', 'Weldenreach', 'Oskaia',
  'Tanvar', 'Ryndel', 'Jocelan', 'Almace', 'Verdholt', 'Sarnis', 'Kolveig', 'Enthara'
];

// OpenFront calls this player type "Bots" internally and shows them in-game
// as "Tribes" (openfront.wiki/Bots, openfront.wiki/Tribes) — filler AI that
// nibbles a few tiles at a time, never builds, never allies, never sails.
// Their real names are "two randomly-generated words"; these two banks are
// combined with a coprime stride (gcd(7,16)=1, and 6i=13 mod 16 has no
// solution) so no index ever pairs a word with itself.
const TRIBE_NAME_A = [
  'Grey', 'Ash', 'Old', 'Stone', 'Salt', 'Elm', 'Reed', 'Moss',
  'Flint', 'Thorn', 'Bramble', 'Hollow', 'Fen', 'Bluff', 'Marsh', 'Wren'
];
const TRIBE_NAME_B = [
  'Hollow', 'Warren', 'Reach', 'Hold', 'Camp', 'Fen', 'Bluff', 'Marsh',
  'Glade', 'Watch', 'Vale', 'Ridge', 'Bend', 'Crag', 'Mire', 'Yard'
];
function tribeName(i) {
  return TRIBE_NAME_A[i % 16] + ' ' + TRIBE_NAME_B[(i * 7 + 3) % 16];
}

// Muted, low-saturation earth tones — deliberately duller than PLAYER_COLORS'
// vivid hues so a tribe reads as wilderness-to-be-conquered at a glance,
// distinct from the Nations actually contesting the map.
const TRIBE_COLORS = [
  [150, 140, 120], [130, 120, 100], [110, 100,  85], [160, 150, 130],
  [120, 115,  95], [140, 125, 105], [100,  95,  80], [155, 140, 115],
  [125, 110,  90], [145, 135, 115], [115, 105,  90], [135, 120, 100],
  [105, 100,  90], [150, 130, 105], [120, 110, 100], [140, 130, 110],
  [110, 115, 100], [130, 125, 110], [145, 140, 125], [100, 105,  95]
];

// Troop counts, never wider than four digits: 9999 -> 10k -> 999k -> 1.2M.
function formatCount(n) {
  n = Math.max(0, Math.floor(n));
  if (n < 10000) return String(n);
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  if (n < 1e7) return (n / 1e6).toFixed(1) + 'M';
  return Math.round(n / 1e6) + 'M';
}

// Same bucket scheme as formatCount, but capped one digit tighter — a front
// marker sits right on the battle line, where a wide number crowds the
// terrain around it, so 3 digits is the ceiling here instead of 4.
function formatCountTight(n) {
  n = Math.max(0, Math.floor(n));
  if (n < 1000) return String(n);
  if (n < 1e6) return Math.min(999, Math.round(n / 1000)) + 'k';
  if (n < 1e7) return (n / 1e6).toFixed(1) + 'M';
  return Math.round(n / 1e6) + 'M';
}

// Population readout for the hover panel: one decimal place in the thousands
// (e.g. "7.6k"), matching OpenFront's stat-bar style rather than formatCount's
// rounded-to-nearest-k, which loses too much precision for a bar this small.
function formatPop(n) {
  n = Math.max(0, n);
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

// Treasury readout. Gold runs to six and seven figures long before troops do,
// so it keeps a decimal in the thousands rather than formatCount's rounding —
// at a four-figure income a "612k" display would sit still for whole seconds,
// and a "1.2M" one for a minute and a half.
function formatGold(n) {
  n = Math.max(0, n);
  if (n < 1000) return String(Math.floor(n));
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Collapse the last few, disputed bits of a float onto a value every engine
// agrees on. See Game.det below for why this exists at all; this is just the
// quantizer itself.
//
// Relative (12 significant digits), not a fixed grid. An earlier draft of
// docs/multiplayer-architecture.md called for Math.round(v * 1e9) / 1e9 — that
// is wrong: v * 1e9 passes Number.MAX_SAFE_INTEGER (~9.0e15) as soon as v is
// above roughly 9e6, and maxTroopsRaw/growthPerSecond on a large empire are
// comfortably past that, so a fixed grid silently loses precision exactly
// where the numbers get big. toPrecision holds at every magnitude, and
// ECMA-262 specifies it as correctly rounded, so the quantizer is itself
// deterministic.
//
// NaN and ±Infinity pass straight through — "Infinity".toPrecision() is a
// string that would round-trip fine but there is nothing to quantize, and
// running non-finite values through the string path is pure risk for no gain.
// Zero passes through too, which also preserves -0 (since -0 === 0).
function detQuantize(v) {
  if (!Number.isFinite(v) || v === 0) return v;
  return Number(v.toPrecision(12));
}

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
  // so wrapping it would throw away precision and time for nothing. Math.LN2
  // (LARGE_DEFENDER_DECAY) is likewise left alone — a compile-time constant,
  // not a computed function. Integer-exponent Math.pow(2, n) is exempt too;
  // see unitCost.
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
    hypot(dx, dy) { return detQuantize(Math.sqrt(dx * dx + dy * dy)); }
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
  // In-flight SAM interceptor missiles — see stepSAMs (spawns one, on a
  // precomputed straight-line intercept course) and stepSamMissiles
  // (advances/resolves them). Same fire-and-forget shape as `shells` above.
  samMissiles: [],
  // Short-lived intercept-confirmation rings — pure presentation, spawned by
  // stepSamMissiles on a successful kill and aged/culled there, same idea as
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
  COSMETIC_STATE: ['nukeBlasts', 'samFlashes'],
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
  bbuf: new Int32Array(4),   // scratch for setOwner's own border bookkeeping
  bbuf2: new Int32Array(4),  // nested scratch updateBorderTile uses per-neighbour, so it can't clobber bbuf mid-update

  // Real OpenFront dimensions, not estimates. Their featured "World" map — the
  // default/flagship map, rank 1 in their own catalogue — ships in three
  // official resolutions in resources/maps/world/manifest.json: map16x
  // (500x250), map4x (1000x500) and the full map (2000x1000), each exactly
  // double the last. medium/large/xlarge are those three verbatim. small
  // continues their own halving scheme one step further (no official
  // quarter-res asset exists) rather than reusing our old guessed numbers.
  // All four land at a clean 2:1 aspect ratio as a result — the real map's
  // own ratio — replacing the arbitrary 1.6 this used to hold constant at.
  //
  // A full-commitment push still takes a few thousand tiles whatever the map,
  // so the same logic as before holds: on a small map one blow swallows a
  // fifth of the world and the match is over in minutes, while on xlarge —
  // now genuinely their scale, not merely proportioned to look like it — the
  // same decisive push is a few percent of the board, keeping individual
  // attacks quick while wars run long. Generation at 2000x1000 (2M tiles)
  // measured ~700ms one-time cost; per-tick simulation cost is driven by
  // player/attack count, not tile count, so it stays flat regardless of size.
  MAP_SIZES: {
    small:  { width:  250, height: 125 },
    medium: { width:  500, height: 250 },   // OpenFront's World, map16x
    large:  { width: 1000, height: 500 },   // OpenFront's World, map4x
    xlarge: { width: 2000, height: 1000 }   // OpenFront's World, full resolution
  },

  // gameStartInfo is {gameID, seed, config:{mapSize,bots,tribes},
  // players:[{clientID,username,playerId}]} — the exact shape LocalServer.start
  // and server/gameserver.js's start() both produce (docs/multiplayer-
  // architecture.md §4, §9 Phase 2). myPlayerId is a plain integer, the
  // caller's job to compute (main.js resolves it from myClientID); this
  // function never needs to know clientIDs or the network layer exist.
  init(gameStartInfo, myPlayerId) {
    gameStartInfo = gameStartInfo || {};
    const config = gameStartInfo.config || {};
    const seed = gameStartInfo.seed >>> 0;
    const sizeKey = config.mapSize;
    this.rng = mulberry32(seed);
    const size = this.MAP_SIZES[sizeKey] || this.MAP_SIZES.medium;
    this.sizeKey = sizeKey in this.MAP_SIZES ? sizeKey : 'medium';
    GameMap.generate(size.width, size.height, seed);

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
    this.dirtyTiles = new Set();
    this.buildings = new Map();
    this.railroads = [];
    this.nextRailId = 1;
    this.trains = [];
    this.nextTrainId = 1;
    this.tradeShips = [];
    this.warships = [];
    this.nextWarshipId = 1;
    // Client-local presentation only, so it is cleared alongside the sim's own
    // per-match state but deliberately does not live on it — see js/fx.js.
    Fx.reset();
    this.shells = [];
    this.samMissiles = [];
    this.samFlashes = [];
    this.nukes = [];
    this.nukeBlasts = [];
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
    this.SPAWN_PHASE_TURNS = H > 1 ? 300 : 100;

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
        // are ahead of it in the id space. PLAYER_COLORS/BOT_NAMES still
        // only have 32 entries each and still wrap with `%` rather than
        // growing — a pre-existing, accepted, purely cosmetic limitation
        // once H + enough bots exceeds 32.
        name = BOT_NAMES[(p - H) % BOT_NAMES.length];
        color = PLAYER_COLORS[(p - H + 1) % PLAYER_COLORS.length];
        startTroops = this.START_TROOPS_BOT;
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
        units: { city: 0, fort: 0 },
        // Lifetime count of this player's own builds, by type — never
        // decremented. What unitCost actually prices against; see its comment.
        unitsBuilt: { city: 0, fort: 0 },
        // Under-construction structures this player has committed gold to but
        // that haven't finished yet. Folded into unitCost alongside `units` so
        // queuing several at once still prices each one higher than the last —
        // without this, price doubling would only bite once the first of a
        // batch actually completes, since `units` itself stays put till then.
        unitsPending: { city: 0, fort: 0 },
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
        traitorUntil: 0,
        betrayals: 0,
        nextThink: 1 + this.rng() * 4,
        // Naval targeting runs a BFS instead of a map scan, so it thinks on a
        // deliberately coarser cadence than nextThink's land decisions.
        nextNavalThink: 5 + this.rng() * 10
      });
    }

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
    this.dirty = true;
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
        // structure — only the current holding disappears.
        if (old >= 0) this.players[old].units[b.type] -= b.level;
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
        // levels rather than a headcount.
        if (old >= 0) this.players[old].units[b.type] -= b.level;
        if (newOwner >= 0) this.players[newOwner].units[b.type] += b.level;
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

  // --- Structures ----------------------------------------------------------
  // OpenFront's build menu. City is the first entry; the rest of their list
  // (port, defence post, silo, SAM, warship, the bombs) slots in here as each
  // is built, which is why this is a table rather than a special case.
  //
  // Cost follows their unitInfo exactly: min(maxCost, 2^n * baseCost), where
  // n is verbatim their costWrapper's own reduce — min(unitsOwned(type),
  // unitsConstructed(type)) — not unitsOwned alone. unitsConstructed is a
  // separate lifetime counter (Player.numUnitsConstructed in their source)
  // that only increments on this player's own buildUnit()/upgradeUnit()
  // calls; capturing a unit reassigns ownership and nothing else, so it can
  // raise unitsOwned without ever touching unitsConstructed. The min() is
  // what that buys: capturing cities you never built cannot itself inflate
  // your price past what your own build history already set as the ceiling,
  // though it can let a currently-owned count that fell behind (from losing
  // a built city) climb back up toward that same ceiling. Every one you
  // build OR upgrade doubles the price of the next until it plateaus, so a
  // self-built/upgraded run costs 125k, 250k, 500k, 1M, then 1M forever —
  // verified against their PlayerImpl.upgradeUnit, which calls the exact same
  // recordUnitConstructed() a fresh build does.
  //
  // `unitsOwned` (units[type] below) is therefore a SUM OF LEVELS, not a
  // headcount — verbatim PlayerImpl.unitsOwned: a built unit contributes its
  // level, a still-under-construction one contributes a flat 1. A second city
  // and a first city upgraded to level 2 cost, and are worth, exactly the
  // same. See maxTroopsRaw, which spends that same sum on the pop bonus.
  //
  // buildTime is seconds of construction after placement, ticked in
  // Game.tick — see updateConstruction. Chosen short enough to stay a visible
  // pause rather than a real commitment; the gold cost is already the real
  // one. OpenFront's own upgrades are instant (UpgradeStructureExecution has
  // no tick phase at all) — the timer here is this game's own addition, so
  // upgrading reuses buildTime rather than a ported duration.
  UNITS: [
    {
      type: 'city', name: 'City', icon: '🏙', hotkey: '1',
      baseCost: 125000, maxCost: 1000000, buildTime: 8, upgradable: true
    },
    // OpenFront's UnitType.Factory: same cost curve as City, and the same
    // constructionDuration ratio (both 2*10 ticks in their config — 1:1 —
    // which is why this reuses city's own non-ported buildTime dial rather
    // than inventing a different one). Their costWrapper actually pools
    // Factory's count together with Port (see Port's own entry below, added
    // later) rather than pricing against its own count alone — costGroup
    // below is what wires that in. What a Factory actually DOES — recruiting
    // nearby cities into a rail network and running trains between them for
    // gold — lives in the "Rail network & trains" section below, hooked in
    // through updateConstruction() the instant one finishes.
    {
      type: 'factory', name: 'Factory', icon: '🏭', hotkey: '2',
      baseCost: 125000, maxCost: 1000000, buildTime: 8, upgradable: true,
      costGroup: ['factory', 'port']
    },
    // OpenFront's UnitType.Port: same exponential cost curve as City/Factory,
    // but Config.ts's real costWrapper for Port explicitly pools its count
    // together with Factory (costWrapper(fn, UnitType.Port, UnitType.Factory))
    // rather than pricing against its own count alone — building either one
    // makes the next Port OR Factory more expensive. See unitCost's costGroup
    // handling below, and the Factory entry's own comment (written before
    // Port existed) noting this was the one deliberate gap left to close once
    // Port arrived. constructionDuration is 5*10 ticks in their config (2.5x
    // City/Factory's own 2*10) but buildTime here is this game's own pacing
    // dial, not a literal tick port (see the class comment above), so this
    // just reuses the same 8s City/Factory already use as fellow members of
    // the upgradable/exponential family.
    {
      type: 'port', name: 'Port', icon: '⚓', hotkey: '3',
      baseCost: 125000, maxCost: 1000000, buildTime: 8, upgradable: true,
      costGroup: ['factory', 'port']
    },
    // OpenFront's UnitType.DefensePost. Cost curve is LINEAR (not exponential):
    // (n+1)*50k, capped at 250k — first fort is 50k, second 100k, fifth+ is 250k.
    // defensePostRange=30, defensePostDefenseBonus=5x, defensePostSpeedBonus=3x,
    // constructionDuration=5*10 ticks. Not upgradable. See FORT_* constants and
    // fortInRange() below for the combat hooks, and tileCost()/stepAttack() for
    // where those bonuses fire.
    {
      type: 'fort', name: 'Defense Fort', icon: '🛡', hotkey: '4',
      baseCost: 50000, maxCost: 250000, buildTime: 5, upgradable: false, linear: true
    },
    // OpenFront's UnitType.Warship: cost is LINEAR like Fort (not pooled with
    // anything else) — Config.ts's real costWrapper is
    // `(numUnits+1)*250_000` capped at 1_000_000. Not upgradable (OpenFront
    // has no warship upgrade path either). Placed on WATER near the player's
    // own coast rather than on owned land — see warshipBlockReason/
    // buildWarship in the "Warships" section below, which this entry's
    // buildTime is NOT read by: a warship spawns instantly (matching
    // OpenFront's own SpawnExecution, which has no construction phase for
    // units the way City/Factory/Port/Fort do here), it's carried only so
    // the build-bar hint text has a number to show.
    // `action: true` marks a UNITS entry that is never placed on a land tile
    // via the normal buildBlockReason/build path and never lands in
    // Game.buildings — AI.economy's generic cost-group loop skips these
    // (see its own comment) and gives each its own purchase call instead
    // (buildWarship / launchNuke). Warship predates this flag; it's added
    // retroactively here to close a real latent gap the flag's own
    // introduction (for the two nuke types just below) surfaced: without it,
    // economy()'s generic loop was quietly attempting
    // Game.build(p.id, 'warship', buildSite(p)) every cycle — buildTime:0
    // meant a hit would silently plant a phantom "warship" entry in
    // Game.buildings that instantly completed and incremented
    // units.warship, inflating the REAL buildWarship price curve (unitCost
    // sums unitsOwned+unitsPending) with builds that never touched the
    // fleet at all. Never actually observed misfiring in practice — buildSite
    // only offers a tile once a nation already has land, by which point a
    // bot's real Port-gated Warship purchase below usually wins the cycle
    // first — but a latent bug wasn't worth leaving in place while adding two
    // more UNITS entries in exactly the same danger zone.
    {
      type: 'warship', name: 'Warship', icon: '🚢', hotkey: '5',
      baseCost: 250000, maxCost: 1000000, buildTime: 0, upgradable: false, linear: true, action: true
    },
    // OpenFront's UnitType.MissileSilo: cost is FLAT — Config.ts's real
    // costWrapper is `() => 1_000_000` with the numUnits argument ignored
    // entirely, unlike every cost curve above (exponential City/Factory/Port,
    // linear Fort/Warship) — a 2nd or 5th Silo costs exactly what the 1st
    // did. See unitCost's `flat` handling. Their config marks it
    // upgradable:true, but no per-level effect for it surfaced anywhere in
    // Config.ts/MissileSiloExecution.ts/UnitImpl.ts while porting (unlike
    // City, where a level directly feeds maxTroops) — rather than invent a
    // fabricated bonus, this is deliberately NOT upgradable here, the same
    // narrowed-scope call already made for Fort and Warship. Placement is the
    // ordinary own-land buildBlockReason/build path (territoryBound, exactly
    // like City) — nothing structure-specific to add there. What it actually
    // DOES — hosting nuke launches on a cooldown — lives in the "Missile
    // Silo & Nukes" section below.
    {
      type: 'silo', name: 'Missile Silo', icon: '🚀', hotkey: '6',
      baseCost: 1000000, maxCost: 1000000, buildTime: 8, upgradable: false, flat: true
    },
    // OpenFront's UnitType.AtomBomb/HydrogenBomb: also flat-cost (see Silo's
    // own comment on the `flat` curve), and `action: true` for the same
    // reason Warship is — a bomb click means "launch one at this tile from my
    // nearest ready Silo," not "place one exactly here," resolved through
    // resolveNukeLaunch/launchNuke rather than buildBlockReason/build. See
    // the "Missile Silo & Nukes" section for the launch/flight/detonation
    // logic and nukeMagnitudes for the inner/outer blast radii each type
    // ports from Config.ts. buildTime carried only for build-bar consistency,
    // same as Warship's own comment — a nuke launches the instant it's
    // ordered, no construction phase.
    {
      type: 'atombomb', name: 'Atom Bomb', icon: '☢', hotkey: '7',
      baseCost: 750000, maxCost: 750000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    {
      type: 'hydrogenbomb', name: 'Hydrogen Bomb', icon: '💥', hotkey: '8',
      baseCost: 5000000, maxCost: 5000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // OpenFront's UnitType.SAMLauncher — the defensive interceptor the
    // "Missile Silo & Nukes" section's own class comment flagged as
    // deliberately deferred ("SAM Launcher... left for a later pass"), now
    // ported against the real SAMLauncherExecution.ts/SAMMissileExecution.ts/
    // Config.ts source. Named "SAM Launcher" rather than reusing "Missile
    // Silo" even though the user described it that way — this game already
    // has a structure called Missile Silo (the offensive nuke launcher
    // above), and OpenFront itself treats these as two entirely separate
    // buildings with separate names, so keeping them separate here avoids a
    // straight naming collision. Cost is LINEAR like Fort — their real
    // costWrapper is `min(3_000_000, (numUnits+1)*1_500_000)`: first SAM
    // 1.5M, second+ pinned at the 3M cap. Territory-bound placement (own
    // land only) needs no special-casing, same as City/Fort/Silo. What it
    // actually DOES — charges, range-per-level, and shooting down incoming
    // nukes — lives in the "SAM Launcher & Interceptors" section below.
    {
      type: 'sam', name: 'SAM Launcher', icon: '📡', hotkey: '9',
      baseCost: 1500000, maxCost: 3000000, buildTime: 8, upgradable: true, linear: true
    }
  ],

  unitDef(type) { return this.UNITS.find(u => u.type === type) || null; },

  // Sum of levels across this player's built structures of `type`, plus a
  // flat 1 for each one still under construction — see the UNITS comment.
  unitsOwned(p, type) { return (p && p.units && p.units[type]) || 0; },

  // Lifetime count of this player's own builds/upgrades of `type` — never
  // decremented, whether by losing the unit or by it being captured away.
  unitsBuilt(p, type) { return (p && p.unitsBuilt && p.unitsBuilt[type]) || 0; },

  // Still-under-construction structures this player has paid for. See the
  // field comment on Player.unitsPending.
  unitsPending(p, type) { return (p && p.unitsPending && p.unitsPending[type]) || 0; },

  unitCost(p, type) {
    const def = this.unitDef(type);
    if (!def) return Infinity;
    // Silo/AtomBomb/HydrogenBomb: costWrapper's callback ignores numUnits
    // entirely in Config.ts, so the price never moves regardless of how many
    // you've bought — no n/costGroup accounting applies at all. See the
    // UNITS entries' own comments.
    if (def.flat) return def.baseCost;
    // Committed = finished-and-owned plus still-building — so queuing a
    // second one before the first finishes still prices at the doubled rate,
    // not the base rate `units` alone would show until completion.
    // costGroup (Port/Factory — see their UNITS entries) sums this same
    // per-type min() across every type in the group instead of just this
    // one, matching Config.ts's real costWrapper reduce: building either one
    // raises the price of both, not just its own kind.
    const types = def.costGroup || [type];
    let n = 0;
    for (const t of types) {
      const committed = this.unitsOwned(p, t) + this.unitsPending(p, t);
      n += Math.min(committed, this.unitsBuilt(p, t));
    }
    // Fort uses a LINEAR curve: (n+1)*baseCost, capped at maxCost.
    // City/factory/port use the exponential: 2^n * baseCost, capped at maxCost.
    //
    // This Math.pow is deliberately NOT routed through Game.det: base 2 with a
    // small non-negative integer exponent is exactly representable, so every
    // engine returns the identical double with no approximation involved. It
    // is the one exempt case in the determinism audit (architecture doc §7.2)
    // — leave it alone rather than "fixing" it.
    return def.linear
      ? Math.min(def.maxCost, (n + 1) * def.baseCost)
      : Math.min(def.maxCost, Math.pow(2, n) * def.baseCost);
  },

  // Why a structure cannot go here, for the UI to say out loud. null when it
  // can, in the same shape as allianceBlockReason.
  //
  // OpenFront marks a City territoryBound, which is the only placement rule
  // there is: your own land, and not on top of something already standing.
  buildBlockReason(playerId, type, tile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    if (!this.unitDef(type)) return 'Unknown structure';
    if (tile < 0 || GameMap.owner[tile] !== playerId) return 'Your own land only';
    if (this.buildings.has(tile)) return 'Already built here';
    // OpenFront's UnitType.Port is territoryBound AND requires an ocean
    // shore tile — a Port sitting one tile inland could never actually touch
    // water for a trade ship to sail from. The placement UI snaps a click
    // near the coast onto the nearest valid tile first (see
    // nearestOwnedCoastNear), so this only fires for a tap too far inland to
    // snap at all.
    if (type === 'port' && !GameMap.isCoastal(tile)) return 'Ports must be on the coast';
    if (p.gold < this.unitCost(p, type)) return 'Not enough gold';
    return null;
  },

  canBuild(playerId, type, tile) { return !this.buildBlockReason(playerId, type, tile); },

  build(playerId, type, tile) {
    if (!this.canBuild(playerId, type, tile)) return false;
    const p = this.players[playerId];
    const def = this.unitDef(type);
    p.gold -= this.unitCost(p, type);   // priced before any count goes up
    // Placed immediately, but not functional until `built` flips — see
    // updateConstruction. `progress`/`buildTime` are what the small bar drawn
    // in Render.drawStructures reads. `level` is set once construction
    // completes, matching UnitImpl's own default of 1.
    // station/rails/lastTrainAt are only ever touched for city/factory types
    // (see the "Rail network & trains" section) but are cheap enough to carry
    // on every building rather than special-case the record shape by type.
    this.buildings.set(tile, {
      type, tile, built: false, progress: 0, buildTime: def.buildTime, level: 0, upgrading: false,
      station: false, rails: new Map(), lastTrainAt: -Infinity,
      // Port-only fields (see "Ports & trade ships"), carried on every
      // building for the same reason station/rails/lastTrainAt are: cheaper
      // to always have the slot than to special-case the record shape.
      tradeRejections: 0, lastTradeCheckAt: -Infinity,
      // Silo-only (see "Missile Silo & Nukes"), carried on every building for
      // the same reason as the Port fields above.
      lastLaunchAt: -Infinity,
      // SAM-only (see "SAM Launcher & Interceptors"). samQueue holds one
      // timestamp per charge currently reloading — UnitImpl's real
      // _missileTimerQueue — capacity-capped at `level` (isInCooldown there
      // is verbatim `queue.length === level`), so a level-2 SAM can have two
      // independent charges reloading on their own clocks at once.
      // samRangeUpgrade holds the in-progress range ramp after a level-up
      // (null once settled) — see dynamicSamRange.
      samQueue: [], samRangeUpgrade: null
    });
    // The lifetime counter unitCost actually prices against — see unitCost's
    // comment. Only this call site and upgrade() touch it; setOwner()'s
    // capture path deliberately does not.
    p.unitsBuilt[type] = this.unitsBuilt(p, type) + 1;
    p.unitsPending[type] = this.unitsPending(p, type) + 1;
    return true;
  },

  // Why an existing structure can't be upgraded right now, for the UI to say
  // out loud — same null-or-reason shape as buildBlockReason. Priced and
  // gated exactly like a fresh build (see UNITS' cost comment): the next
  // level costs whatever unitCost says the next unit of this type costs,
  // because a level and a unit are the same pricing pool.
  upgradeBlockReason(playerId, tile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    const b = this.buildings.get(tile);
    if (!b) return 'Nothing built here';
    if (GameMap.owner[tile] !== playerId) return 'Your own land only';
    const def = this.unitDef(b.type);
    if (!def || !def.upgradable) return 'Cannot be upgraded';
    if (!b.built) return 'Still under construction';
    if (b.upgrading) return 'Already upgrading';
    if (p.gold < this.unitCost(p, b.type)) return 'Not enough gold';
    return null;
  },

  canUpgrade(playerId, tile) { return !this.upgradeBlockReason(playerId, tile); },

  upgrade(playerId, tile) {
    if (!this.canUpgrade(playerId, tile)) return false;
    const p = this.players[playerId];
    const b = this.buildings.get(tile);
    const def = this.unitDef(b.type);
    p.gold -= this.unitCost(p, b.type);   // priced before the level goes up
    b.upgrading = true;
    b.progress = 0;
    b.buildTime = def.buildTime;   // the upgrade timer, reusing the same bar
    // Same two counters a fresh build touches — an in-flight upgrade prices
    // the next build/upgrade higher immediately, exactly like a queued build
    // does, and unitsBuilt's ceiling climbs the moment gold is committed.
    p.unitsBuilt[b.type] = this.unitsBuilt(p, b.type) + 1;
    p.unitsPending[b.type] = this.unitsPending(p, b.type) + 1;
    return true;
  },

  // Advances every structure still under construction OR mid-upgrade, and
  // hands the level increase to its owner — units[type] += 1, unlocking
  // whatever it grants (a city's pop cap) — the instant its timer runs out.
  // A fresh build's first level and an upgrade's next level are the same
  // += 1 here, since units[type] is a sum of levels, not a headcount — see
  // the UNITS comment. Ownership is read fresh off the tile rather than
  // cached on the building, so a structure captured mid-upgrade (or a Fort
  // captured mid-build) never reaches here at all: setOwner() unwinds that
  // in-flight progress on capture instead of letting it finish under a new
  // flag. A non-Fort captured mid-*build*, though, is deliberately left
  // alone by setOwner() and DOES keep ticking here — reading ownership off
  // the tile is exactly what lets it finish under its new owner with no
  // other bookkeeping.
  updateConstruction() {
    for (const b of this.buildings.values()) {
      if (!b.built) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.built = true;
        b.level = 1;
        const owner = GameMap.owner[b.tile];
        if (owner < 0) continue;
        const p = this.players[owner];
        p.unitsPending[b.type] = Math.max(0, this.unitsPending(p, b.type) - 1);
        p.units[b.type] = this.unitsOwned(p, b.type) + 1;
        // Joining the rail network is a one-time event on first completion —
        // see the "Rail network & trains" section. An upgrade (the branch
        // below) never re-triggers it.
        this.onStructureCompleted(b);
      } else if (b.upgrading) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.upgrading = false;
        // UnitImpl.increaseLevel: a SAM's range doesn't jump instantly on
        // upgrade, it ramps smoothly (see dynamicSamRange) — captured before
        // b.level++ so the ramp starts from whatever range is actually in
        // effect right now (mid-ramp or settled), matching the real source's
        // own chained-upgrade behavior rather than resetting hard each time.
        // The freshly gained charge slot also starts consumed/reloading
        // immediately, exactly like a real launch — increaseLevel pushes the
        // queue the same way for SAMLauncher.
        if (b.type === 'sam') {
          b.samRangeUpgrade = {
            startAt: this.elapsed,
            startRange: this.dynamicSamRange(b, this.elapsed),
            targetLevel: b.level + 1
          };
          b.samQueue.push(this.elapsed);
        }
        b.level++;
        const owner = GameMap.owner[b.tile];
        if (owner < 0) continue;
        const p = this.players[owner];
        p.unitsPending[b.type] = Math.max(0, this.unitsPending(p, b.type) - 1);
        p.units[b.type] = this.unitsOwned(p, b.type) + 1;
      }
    }
  },

  // --- Population model, after OpenFront -----------------------------------
  // Cap:         2 * (tiles^0.6 * 1000 + 50000) + cities * 25000
  // Growth/tick: (10 + pop^0.73 / 4) * (1 - pop / maxPop)     at 10 ticks/sec
  //
  // The 0.73 exponent means growth depends on absolute population, so the curve
  // only keeps its shape at OpenFront's magnitudes. Their maps are far larger
  // than ours, and lifting their numbers wholesale would put armies in the
  // hundreds of thousands on a 25k-tile map — a single push would swallow it.
  // So the maths is done in OpenFront units and converted back through
  // POP_SCALE. The (1 - pop/max) term is scale-free and the P^0.73 term is
  // evaluated on the unscaled figure, so the curve — including its 42% peak —
  // is preserved exactly while the magnitudes suit this map.
  // OpenFront keeps troops internally at 10x what it shows: startManpower is
  // 25,000 and reads as 2.5k, a fresh spawn's cap is ~121,000 and reads as
  // 12.1k. Scaling by 0.1 therefore makes our raw numbers equal the figures
  // their UI puts on screen, so pacing can be compared directly.
  POP_SCALE: 0.1,
  TICKS_PER_SEC: 10,
  // 1.0 = OpenFront's own rate, exactly. Their msPerTick is 100, the same tick
  // this game runs on, so no correction is needed. Kept as a named dial only
  // because match length is sensitive to it.
  GROWTH_TIME_SCALE: 1.0,
  TILE_POP_EXPONENT: 0.6,
  TILE_POP_COEF: 1000,
  BASE_POP: 50000,
  // Raw OpenFront units (Config.cityTroopIncrease(), verified against their
  // live source), so through POP_SCALE a city is worth +25k troops on the
  // readout — about twice a fresh spawn's whole cap. Was ported at 25,000, a
  // 10x transcription error caught in an audit against their actual config.
  // Paid out per LEVEL, not per city — verbatim their maxTroops(), which sums
  // city.level() across every built city before multiplying by this. A city
  // upgraded to level 3 is worth exactly what three level-1 cities would be.
  CITY_POP_INCREASE: 250000,

  // OpenFront's startManpower(): 25,000 for a human, 10,000 for a Bot, and
  // 12,500 / 18,750 / 25,000 / 31,250 for a Nation by difficulty. The rival
  // nations here play like Nations rather than the simple bots, so they take
  // the Medium figure. Both convert through POP_SCALE, which leaves the opening
  // fill ratio identical to OpenFront's — a human still starts at 19.6% of cap.
  START_TROOPS_HUMAN: 25000,
  START_TROOPS_BOT: 18750,
  // OpenFront's real Bot startManpower — this is what Tribes take, not the
  // Nation-Medium figure above (openfront.wiki/Bots, "Bots start with
  // 10,000 troops" vs. 25,000 for a human).
  START_TROOPS_TRIBE: 10000,

  // OpenFront's maxTroops()/troopIncreaseRate() scale a Nation's cap and
  // growth by its difficulty, on top of the raw tile/city formula — Medium is
  // 0.75x cap and 0.95x growth, verified against their config source. Applied
  // wherever the rival nations here are trading as Nation-Medium, matching
  // START_TROOPS_BOT above. Human (isBot false) gets neither, exactly as their
  // Human branch applies no multiplier at all.
  NATION_TROOP_CAP_MULT: 0.75,
  NATION_GROWTH_MULT: 0.95,

  // OpenFront's Bot-specific caps, verbatim from openfront.wiki/Bots: "Bots
  // are limited to half the normal maximum population" and "Bots grow 30%
  // slower than human players" (toAdd *= 0.7). Independent of the Nation
  // multipliers above — Tribes are the "simple Bot" type Nations are not.
  TRIBE_TROOP_CAP_MULT: 0.5,
  TRIBE_GROWTH_MULT: 0.7,

  // `cityLevels` is the sum of levels across the player's built cities (what
  // unitsOwned(p, 'city') already tracks), not a count of cities — see the
  // UNITS comment.
  maxTroopsRaw(tiles, cityLevels) {
    return 2 * (this.det.pow(tiles, this.TILE_POP_EXPONENT) * this.TILE_POP_COEF + this.BASE_POP)
      + (cityLevels || 0) * this.CITY_POP_INCREASE;
  },

  maxTroops(p) {
    const raw = this.maxTroopsRaw(p.tiles.size, this.unitsOwned(p, 'city'));
    const mult = p.isTribe ? this.TRIBE_TROOP_CAP_MULT : (p.isBot ? this.NATION_TROOP_CAP_MULT : 1);
    return raw * mult * this.POP_SCALE;
  },

  // Troops currently committed to this player's in-flight attacks. They have
  // left the home reserve but are still very much part of the nation.
  marchingTroops(playerId) {
    let n = 0;
    for (const a of this.attacks) if (a.attacker === playerId) n += a.troops;
    for (const b of this.boats) if (b.attacker === playerId) n += b.troops;
    return n;
  },

  // Reserve plus everyone on campaign. Reported where the whole nation's
  // strength is the question; it is NOT what drives growth.
  totalTroops(p) { return p.troops + this.marchingTroops(p.id); },

  // Absolute troops/sec a player is currently gaining, for both simulation
  // and the HUD readout to consume identically.
  // Fill ratio at which growth peaks — the level worth sitting at rather than
  // banking past. It lands at ~42% (OpenFront's documented figure) but drifts a
  // little with cap because of the constant `10 +` term, so it is solved from
  // the curve rather than hardcoded. Cached per cap; the scan is far too costly
  // to repeat every frame.
  peakGrowthRatio(p) {
    const max = this.maxTroops(p);
    if (this._peakCap && Math.abs(max - this._peakCap) / this._peakCap < 0.02) {
      return this._peakRatio;
    }
    // id -1 owns no attacks, so the probe's growth reads off its troops alone
    // rather than picking up this player's marching forces. isBot has to carry
    // over too — maxTroops(probe) recomputes the cap from scratch, and if the
    // Nation-Medium multiplier below dropped out here the probe would scan a
    // different (larger) cap than the player it's standing in for.
    const probe = { tiles: p.tiles, troops: 0, id: -1, units: p.units, isBot: p.isBot, isTribe: p.isTribe };
    let bestR = 0.42, best = -1;
    for (let r = 0.15; r <= 0.75; r += 0.005) {
      probe.troops = r * max;
      const g = this.growthPerSecond(probe);
      if (g > best) { best = g; bestR = r; }
    }
    this._peakCap = max;
    this._peakRatio = bestR;
    return bestR;
  },

  // Growth reads the home reserve alone — troops out on campaign have left the
  // population that reproduces, exactly as OpenFront's troopIncreaseRate works
  // off player.troops(). Committing an army therefore drops you back down the
  // curve, and if that puts you under the ~42% peak your regrowth accelerates.
  // Keying this to the reserve is also what keeps the bar, the colour and the
  // rate all describing the same number.
  growthPerSecond(p) {
    const max = this.maxTroops(p);
    const pop = p.troops;
    if (pop >= max) return 0;
    const rawPop = pop / this.POP_SCALE;
    let perTick = (10 + this.det.pow(rawPop, 0.73) / 4) * (1 - pop / max);
    // OpenFront's troopIncreaseRate applies the same Medium-difficulty scalar
    // to growth that maxTroops applies to the cap — a second, independent cut
    // on top of the smaller max, not implied by it. Tribes get their own
    // (larger) cut instead — see TRIBE_GROWTH_MULT.
    if (p.isTribe) perTick *= this.TRIBE_GROWTH_MULT;
    else if (p.isBot) perTick *= this.NATION_GROWTH_MULT;
    return perTick * this.POP_SCALE * this.TICKS_PER_SEC * this.GROWTH_TIME_SCALE;
  },

  // --- Economy -------------------------------------------------------------
  // Gold is the second resource, and everything built later is priced in it.
  //
  // OpenFront does not pay gold for holding land: population is split by a
  // slider into troops and WORKERS, and income is derived from the worker half
  // (plus ports, trade and the rest of the structure layer). None of that
  // exists here yet — there is no worker split and nothing to build — so this
  // first step is deliberately the simplest thing that is still true of every
  // nation: a flat rate, identical for everyone, paid every tick you are alive.
  //
  // Keeping it flat matters for what comes next. When income becomes a function
  // of workers or of what you have built, the difference between two nations'
  // treasuries will be the whole point; starting from a rate nobody can
  // influence gives that change a clean baseline to be measured against.
  //
  // The number itself is a dial, not a ported constant. It is set so a match
  // accumulates a treasury worth spending — about 600k over a ten-minute game,
  // which is the order of magnitude OpenFront's structures are priced in — so
  // that when costs arrive they can be taken from their config directly rather
  // than re-derived. Gold is NOT scaled by POP_SCALE: that factor exists to
  // shrink armies to this map's size, and prices have no such constraint.
  START_GOLD: 0,
  GOLD_PER_SEC: 1000,

  // Per-player so the worker-derived formula can replace the body without
  // touching a single call site, exactly as growthPerSecond is shaped.
  //
  // Income is gated on holding land, not on the `alive` flag. A nation whose
  // last tile has been taken can stay technically alive for a while — the death
  // sweep also wants its troops under 20 — and a rump state with an army in the
  // field and no country left has nothing to tax. Land is the test the
  // leaderboard already applies to decide who is still in the game.
  goldPerSecond(p) {
    return p && p.alive && p.tiles.size > 0 ? this.GOLD_PER_SEC : 0;
  },

  // --- Diplomacy, after OpenFront ------------------------------------------
  // OpenFront states these in ticks at 10/sec; they are seconds here because
  // that is what Game.elapsed counts. traitorDuration 30*10, allianceDuration
  // 300*10, allianceRequestDuration 20*10, allianceRequestCooldown 30*10, and
  // allianceExtensionPromptOffset 300 — a renewal window 30s before expiry.
  TRAITOR_DURATION: 30,
  ALLIANCE_DURATION: 300,
  ALLIANCE_REQUEST_DURATION: 20,
  ALLIANCE_REQUEST_COOLDOWN: 30,
  ALLIANCE_EXTEND_WINDOW: 30,

  isTraitor(p) { return !!p && this.elapsed < p.traitorUntil; },

  areAllied(a, b) {
    return a >= 0 && b >= 0 && a !== b && this.players[a].allies.has(b);
  },

  // Alliances are bounded by the nation count, so a flat scan beats any index.
  allianceBetween(a, b) {
    for (const al of this.alliances) {
      if ((al.a === a && al.b === b) || (al.a === b && al.b === a)) return al;
    }
    return null;
  },

  pendingRequest(fromId, toId) {
    return this.requests.find(r => r.from === fromId && r.to === toId) || null;
  },

  relation(p, otherId) { return p.relations.get(otherId) || 0; },

  adjustRelation(p, otherId, delta) {
    p.relations.set(otherId, Math.max(-100, Math.min(100, this.relation(p, otherId) + delta)));
  },

  // OpenFront's canSendAllianceRequest. A request already coming the other way
  // is not a blocker but a shortcut — requestAlliance accepts it rather than
  // opening a mirror-image request nobody needs to answer.
  canRequestAlliance(fromId, toId) {
    if (fromId === toId || fromId < 0 || toId < 0) return false;
    const from = this.players[fromId], to = this.players[toId];
    if (!from || !to || !from.alive || !to.alive) return false;
    // Tribes never answer — they run no diplomacy() pass at all (TribeAI has
    // no equivalent), so a request against one would just sit until it times
    // out. Block it up front instead of leaving a dead offer on the table.
    if (from.isTribe || to.isTribe) return false;
    if (this.areAllied(fromId, toId)) return false;
    if (this.pendingRequest(fromId, toId)) return false;
    if (this.pendingRequest(toId, fromId)) return true;
    const last = this.lastRequestAt.get(fromId + ':' + toId);
    return last === undefined || this.elapsed - last >= this.ALLIANCE_REQUEST_COOLDOWN;
  },

  // Why a peace offer is unavailable, for the radial menu to show. null when it
  // is available.
  allianceBlockReason(fromId, toId) {
    const to = this.players[toId];
    if (to && to.isTribe) return 'Tribes do not ally';
    if (this.areAllied(fromId, toId)) return null;
    if (this.pendingRequest(fromId, toId)) return 'Offer already pending';
    if (this.pendingRequest(toId, fromId)) return null;
    const last = this.lastRequestAt.get(fromId + ':' + toId);
    if (last !== undefined) {
      const wait = this.ALLIANCE_REQUEST_COOLDOWN - (this.elapsed - last);
      if (wait > 0) return 'Wait ' + Math.ceil(wait) + 's';
    }
    return null;
  },

  requestAlliance(fromId, toId) {
    if (!this.canRequestAlliance(fromId, toId)) return false;
    const incoming = this.pendingRequest(toId, fromId);
    if (incoming) { this.acceptAlliance(incoming); return true; }
    this.lastRequestAt.set(fromId + ':' + toId, this.elapsed);
    this.requests.push({ from: fromId, to: toId, createdAt: this.elapsed });
    return true;
  },

  dropRequest(req) {
    const i = this.requests.indexOf(req);
    if (i >= 0) this.requests.splice(i, 1);
  },

  dropRequestsBetween(x, y) {
    const a = this.pendingRequest(x, y), b = this.pendingRequest(y, x);
    if (a) this.dropRequest(a);
    if (b) this.dropRequest(b);
  },

  rejectAlliance(req) { this.dropRequest(req); },

  acceptAlliance(req) {
    this.dropRequest(req);
    if (this.areAllied(req.from, req.to)) return false;
    const a = this.players[req.from], b = this.players[req.to];
    if (!a || !b || !a.alive || !b.alive) return false;

    a.allies.add(b.id);
    b.allies.add(a.id);
    a.relations.set(b.id, 100);
    b.relations.set(a.id, 100);
    this.alliances.push({
      a: a.id, b: b.id, createdAt: this.elapsed,
      expiresAt: this.elapsed + this.ALLIANCE_DURATION,
      extendA: false, extendB: false
    });
    // A deal signed while the armies are already in the field has to recall
    // them, or the front carries on eating your new ally's land. Boats are
    // deliberately NOT recalled here — OpenFront's own TransportShipExecution
    // doesn't cancel an in-flight invasion when peace is signed either; it
    // still takes its one landing tile for free on arrival, then just brings
    // the rest of the troops home instead of attacking further (see
    // resolveLanding's areAllied branch).
    this.cancelAttacksBetween(a.id, b.id);
    return true;
  },

  cancelAttacksBetween(x, y) {
    for (let i = this.attacks.length - 1; i >= 0; i--) {
      const at = this.attacks[i];
      if ((at.attacker === x && at.target === y) || (at.attacker === y && at.target === x)) {
        this.players[at.attacker].troops += Math.max(0, at.troops);
        this.attacks.splice(i, 1);
      }
    }
  },

  removeAlliance(al) {
    const i = this.alliances.indexOf(al);
    if (i >= 0) this.alliances.splice(i, 1);
    this.players[al.a].allies.delete(al.b);
    this.players[al.b].allies.delete(al.a);
  },

  // OpenFront marks the breaker a traitor unless the other side already is one,
  // so unpicking an alliance with someone who has just stabbed a third party
  // costs nothing. Letting an alliance lapse never marks anyone either — only
  // this, a deliberate break, does.
  breakAlliance(breakerId, otherId) {
    const al = this.allianceBetween(breakerId, otherId);
    if (!al) return false;
    const breaker = this.players[breakerId], other = this.players[otherId];

    this.removeAlliance(al);

    if (!this.isTraitor(other)) {
      breaker.traitorUntil = this.elapsed + this.TRAITOR_DURATION;
      breaker.betrayals++;
    }

    // The betrayed party writes you off entirely; everyone who can see the
    // border takes note. That standing cost is most of what makes betrayal a
    // decision rather than a free tempo gain.
    this.adjustRelation(other, breakerId, -100);
    for (const [neighbourId] of AI.borderTargets(breaker, true)) {
      if (neighbourId < 0 || neighbourId === otherId) continue;
      this.adjustRelation(this.players[neighbourId], breakerId, -40);
    }
    return true;
  },

  extendWindowOpen(al) {
    return al.expiresAt - this.elapsed <= this.ALLIANCE_EXTEND_WINDOW;
  },

  // Renewal takes both signatures. One side asking alone does nothing but tell
  // the other that the offer is on the table; the alliance still lapses.
  requestExtension(playerId, otherId) {
    const al = this.allianceBetween(playerId, otherId);
    if (!al || !this.extendWindowOpen(al)) return false;
    if (al.a === playerId) al.extendA = true; else al.extendB = true;
    if (al.extendA && al.extendB) {
      al.extendA = al.extendB = false;
      al.expiresAt = this.elapsed + this.ALLIANCE_DURATION;
    }
    return true;
  },

  agreedToExtend(al, playerId) {
    return al.a === playerId ? al.extendA : al.extendB;
  },

  // True when the other side has asked to renew and this player has not
  // answered — OpenFront's onlyOneAgreedToExtend, from one side's point of view.
  awaitingExtension(al, playerId) {
    if (al.extendA === al.extendB) return false;
    return !this.agreedToExtend(al, playerId);
  },

  // OpenFront's decayRelations: 0.05 a tick toward zero, every tick, for every
  // player. At 10 ticks/sec that is half a point a second, so the -40 a
  // betrayal earns you with the neighbours is forgotten in about 80 seconds and
  // the -100 with the injured party in rather longer. Grudges fade; that is
  // what stops a long match calcifying into permanent enemies.
  RELATION_DECAY_PER_SEC: 0.5,

  decayRelations(p) {
    const step = this.RELATION_DECAY_PER_SEC * this.TICK_DT;
    for (const [id, r] of p.relations) {
      if (Math.abs(r) <= step * 2) p.relations.set(id, 0);
      else p.relations.set(id, r - Math.sign(r) * step);
    }
  },

  updateDiplomacy() {
    for (const p of this.players) if (p.alive) this.decayRelations(p);

    for (let i = this.requests.length - 1; i >= 0; i--) {
      const r = this.requests[i];
      if (!this.players[r.from].alive || !this.players[r.to].alive ||
          this.elapsed - r.createdAt > this.ALLIANCE_REQUEST_DURATION) {
        this.requests.splice(i, 1);
      }
    }
    for (let i = this.alliances.length - 1; i >= 0; i--) {
      const al = this.alliances[i];
      // Expiry is silent: no traitor mark, no relation hit.
      if (!this.players[al.a].alive || !this.players[al.b].alive ||
          this.elapsed >= al.expiresAt) {
        this.removeAlliance(al);
      }
    }
  },

  // openfront.wiki/Retreating: ordered instantly by the X next to an attack,
  // but the troops don't actually leave the field for RETREAT_DELAY (their 20
  // ticks, 2s at 10/sec) — stepAttack stops conquering the moment this flips,
  // and the survivors return to the reserve once the timer runs out. Docked
  // ATTACK_RETREAT_MALUS if the front was pushing on another player; walking
  // away from empty land costs nothing.
  RETREAT_DELAY: 2,
  ATTACK_RETREAT_MALUS: 0.25,

  canRetreatAttack(a) { return !!a && !a.retreating; },

  retreatAttack(a) {
    if (!this.canRetreatAttack(a)) return false;
    a.retreating = true;
    a.retreatAt = this.elapsed + this.RETREAT_DELAY;
    return true;
  },

  // Recalls a boat already at sea. Rather than the artificial tick delay a
  // land front needs, the boat just reverses along the route it already
  // sailed — the crossing itself supplies the wait — and pays the same
  // ATTACK_RETREAT_MALUS on reaching home if it was headed at another player.
  canRetreatBoat(b) { return !!b && !b.retreating; },

  retreatBoat(b) {
    if (!this.canRetreatBoat(b)) return false;
    b.retreating = true;
    return true;
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

  // Launches an attack from `attacker` against every tile of `targetId` that
  // touches their border. targetId may be NEUTRAL for unclaimed land.
  launchAttack(attackerId, targetId, troops) {
    const attacker = this.players[attackerId];
    if (troops < 20 || attacker.troops < troops) return false;
    if (targetId === attackerId) return false;
    // A peace deal holds the border shut. Attacking an ally means breaking the
    // alliance first, and wearing the traitor mark for it.
    if (this.areAllied(attackerId, targetId)) return false;
    // Marching on someone answers their proposal, as OpenFront's
    // AttackExecution.rejectIncomingAllianceRequests does.
    if (targetId >= 0) this.dropRequestsBetween(attackerId, targetId);

    // Every existing attack against this target — including a boat-landed
    // beachhead on another landmass entirely — consolidates into one shared
    // siege pool, exactly like OpenFront's AttackExecution: all of them fold
    // their troops into a single survivor, which then re-scans the
    // attacker's CURRENT full border (refreshFrontier already looks across
    // every tile the attacker owns, not just one landmass) so the combined
    // pool pushes on every front it touches. Without that rescan a mainland
    // click just topped up the island beachhead's existing queue and the
    // mainland front never actually started — refreshing here is the fix.
    // A retreating front is on its way out — folding a fresh push into it
    // would just re-arm troops already committed to leaving, so it's skipped
    // here and a brand new attack is opened alongside it instead.
    let survivor = null;
    for (let i = this.attacks.length - 1; i >= 0; i--) {
      const at = this.attacks[i];
      if (at.attacker !== attackerId || at.target !== targetId || at.retreating) continue;
      if (survivor === null) survivor = at;
      else { survivor.troops += at.troops; this.attacks.splice(i, 1); }
    }
    // The survivor is an existing attack object, mutated in place, so it keeps
    // the id it was born with — a fresh id here would silently invalidate every
    // cancel_attack already in flight against this front, which is the one
    // thing consolidation must not do. The attacks folded *into* it lose their
    // ids permanently; a cancel_attack naming one of those simply resolves to
    // nothing, on every client alike. See nextAttackId.
    if (survivor) {
      survivor.troops += troops;
      attacker.troops -= troops;
      this.refreshFrontier(survivor);
      return true;
    }

    // Minted before the frontier check, so a launch that finds no border to
    // push on burns an id. Harmless: every client runs this same code path
    // with the same state and burns the same id on the same turn, and ids are
    // deliberately never reused (see nextAttackId).
    const a = { id: this.nextAttackId++, attacker: attackerId, target: targetId, troops, progress: 0,
                heapTile: [], heapPrio: [], seen: new Set(), popPrio: 0,
                noiseSeed: (this.rng() * 1e9) | 0 };
    if (!this.refreshFrontier(a)) return false;

    attacker.troops -= troops;
    this.attacks.push(a);
    return true;
  },

  // --- Naval invasions -------------------------------------------------------
  // Ported against OpenFront's actual TransportShipExecution/TransportShipUtils
  // source (github.com/openfrontio/OpenFrontIO), not guessed. A boat is a
  // travel phase bolted onto the front of the same conquest-wave machinery
  // land attacks already use above: it crosses open water, and on arrival
  // takes the landing tile for free before opening a normal attack from
  // there — see resolveLanding below for the exact arrival branching, which
  // mirrors TransportShipExecution.tick's PathStatus.COMPLETE case tile for
  // tile, malus included.

  // OpenFront moves a transport ship exactly 1 tile per tick (ticksPerMove=1
  // in TransportShipExecution), and their msPerTick is 100 — the same 10
  // ticks/sec this file already runs on (see TICKS_PER_SEC), so this is a
  // straight port, not a re-tuned dial: 10 tiles/sec.
  BOAT_SPEED: 10,

  // TransportShipExecution's malusForRetreat: landing back on your own land
  // (the target tile changed hands again while the boat was crossing) loses
  // 25% of the troops rather than refunding them in full.
  BOAT_RETREAT_MALUS: 0.25,

  // A sea route that never reaches its target should fail fast rather than
  // walk the whole ocean — caps how many water tiles a single search visits.
  SEA_PATH_GUARD: 200000,

  // Config.boatMaxNumber().
  MAX_BOATS_PER_PLAYER: 3,

  // SpatialQuery.closestReachableShore's default maxDist: OpenFront doesn't
  // require the exact tapped tile to be a shore — it lands at the nearest
  // actual coastal tile of the same owner, so a click a little inland from
  // the coast still invades sensibly instead of failing.
  NEAREST_COAST_MAX_DIST: 50,

  // Terrain-agnostic BFS (Manhattan-ordered, ignores land/water) from `tile`
  // out to the nearest tile that is coastal AND owned by whoever owns `tile`
  // — matches SpatialQuery.bfsNearest's approach exactly: it's a geometric
  // "closest shore" search, not a walkable-path search. Returns `tile`
  // itself unchanged when it's already coastal (the common case).
  //
  // A tile of open water has no owner of its own to match against — OpenFront
  // resolves a water click to TerraNullius (unclaimed), so this does the
  // same: right-clicking the ocean targets the nearest unclaimed shore near
  // that point, not a specific nation.
  nearestOwnedCoast(tile) {
    // isCoastal only means anything for land — a water tile bordering more
    // water would otherwise short-circuit here and "land" on itself.
    if (GameMap.isLand(tile) && GameMap.isCoastal(tile)) return tile;
    const rawOwner = GameMap.owner[tile];
    const owner = rawOwner === WATER ? NEUTRAL : rawOwner;
    const w = GameMap.width;
    const tx = tile % w, ty = (tile / w) | 0;
    const maxDist = this.NEAREST_COAST_MAX_DIST;
    const seen = new Set([tile]);
    const queue = [tile];
    const nb = new Int32Array(4);
    let head = 0, best = -1, bestDist = Infinity;
    while (head < queue.length) {
      const i = queue[head++];
      const ix = i % w, iy = (i / w) | 0;
      const dist = Math.abs(ix - tx) + Math.abs(iy - ty);
      if (dist < bestDist && GameMap.owner[i] === owner && GameMap.isCoastal(i)) {
        best = i; bestDist = dist;
      }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // How close a Port placement click has to land to the player's own coast
  // to snap onto it (see nearestOwnedCoastNear) — deliberately much tighter
  // than NEAREST_COAST_MAX_DIST above (a boat target snapping across half
  // the map to the "nearest" shore still makes sense; a building silently
  // teleporting that far from where you tapped would not).
  PORT_SNAP_MAX_DIST: 6,

  // Same terrain-agnostic BFS shape as nearestOwnedCoast, but for placing a
  // Port: searches out from `fromTile` (which may be water, another
  // player's land, or unclaimed — wherever the cursor happens to be) for the
  // nearest tile that is land, coastal, AND already owned by `playerId`
  // specifically — never "whoever owns the clicked tile," which is what
  // nearestOwnedCoast derives instead and why this needed its own version.
  // Returns -1 if nothing qualifies within maxDist, or if fromTile is off
  // the map (-1 in from screenToTile).
  nearestOwnedCoastNear(playerId, fromTile, maxDist) {
    if (fromTile < 0) return -1;
    if (GameMap.owner[fromTile] === playerId && GameMap.isLand(fromTile) && GameMap.isCoastal(fromTile)) {
      return fromTile;
    }
    const w = GameMap.width;
    const tx = fromTile % w, ty = (fromTile / w) | 0;
    const seen = new Set([fromTile]);
    const queue = [fromTile];
    const nb = new Int32Array(4);
    let head = 0, best = -1, bestDist = Infinity;
    while (head < queue.length) {
      const i = queue[head++];
      const ix = i % w, iy = (i / w) | 0;
      const dist = Math.abs(ix - tx) + Math.abs(iy - ty);
      if (dist < bestDist && GameMap.owner[i] === playerId && GameMap.isLand(i) && GameMap.isCoastal(i)) {
        best = i; bestDist = dist;
      }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // Ported against OpenFront's actual AStarWater/SmoothingWaterTransformer
  // source (github.com/openfrontio/OpenFrontIO), not guessed. The old
  // seaPath was an unweighted multi-source BFS — correct, but on a
  // 4-directional grid an unweighted search has no reason to prefer one
  // shortest path over another, so ties resolved in queue order and routes
  // came out as long straight runs hugging the coastline. OpenFront's real
  // pathfinder fixes that with three independent levers, all reproduced
  // below:
  //  1. A per-tile cost keyed on distance-from-shore (GameMap.shoreDist) —
  //     hugging the coast is expensive, a band a few tiles out is free, deep
  //     water carries a small penalty of its own. See shoreCostPenalty.
  //  2. A weighted heuristic (SEA_HEURISTIC_WEIGHT > 1) plus a small
  //     cross-product tie-breaker that biases ties toward the straight
  //     source-goal line. On a cardinal-only grid that turns ties into an
  //     alternating staircase instead of one long run per axis.
  //  3. A Bresenham re-trace over the result (retraceWaterLine) that pulls
  //     each straight-enough stretch taut into a true diagonal line,
  //     decomposed into whichever cardinal tile of each diagonal step is
  //     actually deep enough water — the direct source of the organic
  //     diagonal/stair-step look, not just the search's tie-breaking.
  //
  // Terrain-agnostic BFS distance is still what nearestOwnedCoast /
  // isCoastal use elsewhere — this is specifically the open-water crossing.

  // OpenFront's AStarWater cost constants: 100 per tile moved, scaled up so
  // the magnitude penalty buckets (below) stay whole numbers.
  SEA_COST_SCALE: 100,

  // Weight >1 trades A*'s optimality guarantee for a much more directed
  // search — matches AStarWater's own default. A plain unweighted A* (or
  // BFS) explores every tied shortest path equally, which is what produced
  // the ruler-straight, coast-hugging routes this replaced.
  SEA_HEURISTIC_WEIGHT: 5,

  // AStarWater.getMagnitudePenalty verbatim: tiles under 3 from shore are
  // heavily taxed, 3-10 out is the free "sweet spot", beyond that a small
  // penalty for open blue water.
  shoreCostPenalty(dist) {
    if (dist < 3) return 10 * this.SEA_COST_SCALE;
    if (dist <= 10) return 0;
    return this.SEA_COST_SCALE;
  },

  // Weighted A* over WATER tiles, seeded from every water tile adjacent to
  // `sourceTiles`, stopping the instant it pops a water tile adjacent to
  // `targetTile`. Returns the path as a tile sequence (water tiles, ending
  // on targetTile itself) or null if `targetTile` isn't coastal at all or no
  // route is found within the guard.
  seaPath(sourceTiles, targetTile) {
    const owner = GameMap.owner, shoreDist = GameMap.shoreDist, w = GameMap.width;
    const nb = new Int32Array(4);

    const targetNb = GameMap.neighbors(targetTile, nb);
    const targetWater = new Set();
    for (let k = 0; k < targetNb; k++) if (owner[nb[k]] === WATER) targetWater.add(nb[k]);
    if (targetWater.size === 0) return null;

    const starts = [];
    for (const land of sourceTiles) {
      const n = GameMap.neighbors(land, nb);
      for (let k = 0; k < n; k++) if (owner[nb[k]] === WATER) starts.push(nb[k]);
    }
    if (starts.length === 0) return null;

    // Fast reject: two water tiles can only connect if they share a
    // waterComponentId (see GameMap.computeWaterComponents, same adjacency
    // this A* moves through below). Without this, a target on a separate
    // sea or a landlocked lake made the search below exhaust its entire
    // reachable side of the map — up to SEA_PATH_GUARD tiles — just to
    // prove there's no route; measured live at 20-40ms for a single call,
    // repeated across every boat/warship/trade-ship repath on the map, this
    // was the game's main remaining source of hitching.
    const wc = GameMap.waterComponentId;
    const targetComponents = new Set();
    for (const t of targetWater) targetComponents.add(wc[t]);
    if (!starts.some(s => targetComponents.has(wc[s]))) return null;

    const goalX = targetTile % w, goalY = (targetTile / w) | 0;

    // Cross-product tie-breaker needs one reference line — the start closest
    // to the goal, so the bias points along the route actually being sailed
    // rather than an arbitrary one among the attacker's coastal launch points.
    let s0 = starts[0], bestD = Infinity;
    for (const s of starts) {
      const sx = s % w, sy = (s / w) | 0;
      const d = Math.abs(sx - goalX) + Math.abs(sy - goalY);
      if (d < bestD) { bestD = d; s0 = s; }
    }
    const dxGoal = goalX - (s0 % w), dyGoal = goalY - ((s0 / w) | 0);
    const crossNorm = Math.max(1, Math.abs(dxGoal) + Math.abs(dyGoal));
    const COST_SCALE = this.SEA_COST_SCALE, BASE_COST = COST_SCALE, weight = this.SEA_HEURISTIC_WEIGHT;
    const crossTieBreaker = (nx, ny) => {
      const dxN = nx - goalX, dyN = ny - goalY;
      const cross = Math.abs(dxGoal * dyN - dyGoal * dxN);
      return Math.floor((cross * (COST_SCALE - 1)) / crossNorm / crossNorm);
    };

    // Binary min-heap over (tile, priority) as parallel arrays — plain and
    // uncached, since seaPath only runs once per boat launch, not per tick.
    const heapId = [], heapPri = [];
    const heapPush = (id, pri) => {
      let i = heapId.length;
      heapId.push(id); heapPri.push(pri);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heapPri[p] <= heapPri[i]) break;
        [heapId[p], heapId[i]] = [heapId[i], heapId[p]];
        [heapPri[p], heapPri[i]] = [heapPri[i], heapPri[p]];
        i = p;
      }
    };
    const heapPop = () => {
      const top = heapId[0];
      const lastId = heapId.pop(), lastPri = heapPri.pop();
      if (heapId.length > 0) {
        heapId[0] = lastId; heapPri[0] = lastPri;
        let i = 0;
        const n = heapId.length;
        while (true) {
          let l = i * 2 + 1, r = l + 1, smallest = i;
          if (l < n && heapPri[l] < heapPri[smallest]) smallest = l;
          if (r < n && heapPri[r] < heapPri[smallest]) smallest = r;
          if (smallest === i) break;
          [heapId[smallest], heapId[i]] = [heapId[i], heapId[smallest]];
          [heapPri[smallest], heapPri[i]] = [heapPri[i], heapPri[smallest]];
          i = smallest;
        }
      }
      return top;
    };

    const gScore = new Map(), cameFrom = new Map(), closed = new Set();
    for (const s of starts) {
      if (gScore.has(s)) continue;
      gScore.set(s, 0);
      cameFrom.set(s, -1);
      const sx = s % w, sy = (s / w) | 0;
      const h = weight * BASE_COST * (Math.abs(sx - goalX) + Math.abs(sy - goalY));
      heapPush(s, h);
    }

    let found = -1, guard = this.SEA_PATH_GUARD;
    while (heapId.length > 0 && guard-- > 0) {
      const current = heapPop();
      if (closed.has(current)) continue;
      closed.add(current);
      if (targetWater.has(current)) { found = current; break; }

      const currentG = gScore.get(current);
      const n = GameMap.neighbors(current, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (owner[j] !== WATER || closed.has(j)) continue;
        const tentativeG = currentG + BASE_COST + this.shoreCostPenalty(shoreDist[j]);
        if (!gScore.has(j) || tentativeG < gScore.get(j)) {
          gScore.set(j, tentativeG);
          cameFrom.set(j, current);
          const jx = j % w, jy = (j / w) | 0;
          const h = weight * BASE_COST * (Math.abs(jx - goalX) + Math.abs(jy - goalY));
          heapPush(j, tentativeG + h + crossTieBreaker(jx, jy));
        }
      }
    }
    if (found < 0) return null;

    const waterPath = [];
    let cur = found;
    while (cur !== -1) { waterPath.push(cur); cur = cameFrom.get(cur); }
    waterPath.reverse();
    waterPath.push(targetTile);
    return this.smoothSeaPath(waterPath);
  },

  // Straightens the A* result into diagonal-looking runs without changing
  // its tile-density — render.js's boat trail and stepBoats' pos/BOAT_SPEED
  // both treat every path[] entry as one tile of travel, so smoothing has to
  // fill in every intermediate tile of the straightened line rather than
  // collapse to sparse corner waypoints. Two passes, loose then strict,
  // mirror SmoothingWaterTransformer's own two line-of-sight passes; the
  // deep local-A*-refinement pass it also runs near the two endpoints isn't
  // ported — shoreCostPenalty already keeps seaPath itself off the shore
  // near departure and arrival, which is what that pass exists to patch up.
  smoothSeaPath(path) {
    if (path.length <= 3) return path;
    const target = path[path.length - 1];
    let water = path.slice(0, -1);
    water = this.losSmoothSeaPath(water, 2);
    water = this.losSmoothSeaPath(water, 3);
    water.push(target);
    return water;
  },

  // Binary-searches, from each kept waypoint, the farthest later waypoint
  // with a clear (deep-enough) straight line to it, then replaces everything
  // in between with that literal line — retraceWaterLine's Bresenham walk —
  // so a wavy A* detour collapses into one taut diagonal stretch.
  losSmoothSeaPath(path, minShoreDist) {
    if (path.length <= 2) return path;
    const result = [path[0]];
    let current = 0;
    while (current < path.length - 1) {
      let lo = current + 1, hi = path.length - 1, farthest = lo;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.seaLineOfSight(path[current], path[mid], minShoreDist)) { farthest = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (farthest > current + 1) {
        const trace = this.retraceWaterLine(path[current], path[farthest], minShoreDist);
        for (let i = 1; i < trace.length - 1; i++) result.push(trace[i]);
      }
      current = farthest;
      result.push(path[current]);
    }
    return result;
  },

  seaLineOfSight(from, to, minShoreDist) {
    return this.retraceWaterLine(from, to, minShoreDist) !== null;
  },

  // Bresenham line from `from` to `to`, decomposing each diagonal step of
  // the ideal line into whichever of its two cardinal sub-tiles is passable
  // (falls back to the other), since this grid only has cardinal edges —
  // exactly SmoothingWaterTransformer's canSee/tracePath. Returns the full
  // tile sequence (inclusive of both ends) or null the moment the line
  // crosses land or water shallower than `minShoreDist`.
  retraceWaterLine(from, to, minShoreDist) {
    const w = GameMap.width, owner = GameMap.owner, shoreDist = GameMap.shoreDist;
    const passable = t => owner[t] === WATER && shoreDist[t] >= minShoreDist;

    let x = from % w, y = (from / w) | 0;
    const x1 = to % w, y1 = (to / w) | 0;
    const dx = Math.abs(x1 - x), dy = Math.abs(y1 - y);
    const sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
    let err = dx - dy;

    if (!passable(from)) return null;
    const tiles = [from];

    while (!(x === x1 && y === y1)) {
      const e2 = 2 * err;
      const moveX = e2 > -dy, moveY = e2 < dx;
      if (moveX && moveY) {
        x += sx; err -= dy;
        const mid = y * w + x;
        if (passable(mid)) {
          tiles.push(mid);
          y += sy; err += dx;
        } else {
          x -= sx; err += dy;
          y += sy; err += dx;
          const alt = y * w + x;
          if (!passable(alt)) return null;
          tiles.push(alt);
          x += sx; err -= dy;
        }
      } else if (moveX) {
        x += sx; err -= dy;
      } else {
        y += sy; err += dx;
      }
      const tile = y * w + x;
      if (!passable(tile)) return null;
      tiles.push(tile);
    }
    return tiles;
  },

  // seaPath, seeded from just the attacker's own coastal tiles rather than
  // their whole territory — only those can ever border open water. Scanning
  // attacker.borderTiles instead of attacker.tiles is exactly equivalent (a
  // WATER neighbour makes a tile coastal AND a border tile, by definition —
  // coastal tiles are a subset of border tiles) but perimeter-sized instead
  // of area-sized. This runs from navalInvasionBlockReason, which the radial
  // menu calls to decide whether to grey out the Boat option, so a full
  // territory scan here was a hitch on every check against a large empire,
  // not just an actual boat launch.
  nearestCoastPath(attackerId, targetTile) {
    const attacker = this.players[attackerId];
    const coastal = [];
    for (const t of attacker.borderTiles) if (GameMap.isCoastal(t)) coastal.push(t);
    if (coastal.length === 0) return null;
    return this.seaPath(coastal, targetTile);
  },

  // Why a boat cannot launch at `tile` right now, for the radial menu's Boat
  // slot to say out loud — same null-or-reason shape as buildBlockReason and
  // allianceBlockReason. `tile` doesn't need to be a shore itself; this
  // resolves it exactly the way launchNavalInvasion will (nearestOwnedCoast).
  navalInvasionBlockReason(attackerId, tile, troops) {
    const attacker = this.players[attackerId];
    if (!attacker || !attacker.alive) return 'Nation defeated';
    if (troops < 20 || attacker.troops < troops) return 'Not enough troops';
    if (this.boats.filter(b => b.attacker === attackerId).length >= this.MAX_BOATS_PER_PLAYER) {
      return 'Boat limit reached';
    }
    const landingTile = this.nearestOwnedCoast(tile);
    if (landingTile < 0) return 'No coast nearby';
    const targetOwner = GameMap.owner[landingTile];
    if (targetOwner === attackerId) return 'Already yours';
    if (this.areAllied(attackerId, targetOwner)) return 'Allied';
    if (!this.nearestCoastPath(attackerId, landingTile)) return 'No sea route';
    return null;
  },

  canLaunchNavalInvasion(attackerId, tile, troops) {
    return !this.navalInvasionBlockReason(attackerId, tile, troops);
  },

  // Sends a boat carrying `troops` from the attacker's nearest coast toward
  // the nearest actual coastal tile near `targetTile` (see nearestOwnedCoast
  // — the tap doesn't have to land exactly on a shore tile). Troops leave the
  // home reserve immediately, exactly like launchAttack, and count against
  // the pop cap via marchingTroops until the boat lands — so committing to an
  // invasion reads on the HUD exactly like committing to a land attack.
  launchNavalInvasion(attackerId, targetTile, troops) {
    if (this.navalInvasionBlockReason(attackerId, targetTile, troops)) return false;

    const landingTile = this.nearestOwnedCoast(targetTile);
    const targetOwner = GameMap.owner[landingTile];
    const path = this.nearestCoastPath(attackerId, landingTile);

    // Marching on someone answers their proposal, same as launchAttack.
    if (targetOwner >= 0) this.dropRequestsBetween(attackerId, targetOwner);

    const attacker = this.players[attackerId];
    attacker.troops -= troops;
    // `target` is fixed here and never re-read at arrival — OpenFront's own
    // TransportShipExecution stores the target once at launch too, so a boat
    // still attacks the nation it was sent against even if the landing tile
    // itself changes hands again before it arrives.
    this.boats.push({ id: this.nextBoatId++, attacker: attackerId, target: targetOwner, troops, path, pos: 0, landingTile });
    return true;
  },

  // Advances every boat along its path; arrival is handled by resolveLanding.
  // A recalled boat runs this in reverse instead — sailing back down the same
  // route toward pos 0 — and hands the troops home once it gets there.
  stepBoats() {
    for (let i = this.boats.length - 1; i >= 0; i--) {
      const b = this.boats[i];
      if (b.retreating) {
        b.pos -= this.BOAT_SPEED * this.TICK_DT;
        if (b.pos > 0) continue;
        const attacker = this.players[b.attacker];
        const malus = b.target >= 0 ? this.ATTACK_RETREAT_MALUS : 0;
        attacker.troops += b.troops * (1 - malus);
        this.boats.splice(i, 1);
        continue;
      }
      b.pos += this.BOAT_SPEED * this.TICK_DT;
      if (b.pos < b.path.length - 1) continue;
      this.resolveLanding(b);
      this.boats.splice(i, 1);
    }
  },

  // Mirrors TransportShipExecution.tick's PathStatus.COMPLETE branch exactly.
  resolveLanding(boat) {
    const attacker = this.players[boat.attacker];
    const tile = boat.landingTile;

    // The landing tile is already ours again (recaptured some other way
    // while the boat was crossing) — OpenFront treats this as a retreat and
    // tolls it: 25% of the troops are lost, not refunded in full.
    if (GameMap.owner[tile] === boat.attacker) {
      attacker.troops += boat.troops * (1 - this.BOAT_RETREAT_MALUS);
      return;
    }

    // The landing tile itself is always taken for free — no fight, no troop
    // cost — exactly like OpenFront's unconditional conquer() on arrival.
    this.setOwner(tile, boat.attacker);

    // An alliance can form mid-crossing; OpenFront doesn't recall the boat
    // for it, it just changes what happens on arrival. The landing tile is
    // still taken either way (that conquer() above already ran) — only the
    // remaining troops differ: home in full rather than pressing an attack.
    if (this.areAllied(boat.attacker, boat.target)) {
      attacker.troops += boat.troops;
      return;
    }

    // A normal attack, seeded from the landing tile's own border — it's real
    // owned territory now (setOwner just ran), so no special-casing is needed
    // anywhere else; touchesPlayer already sees it.
    // A beachhead is a real attack and gets a real attack id — the boat's own
    // id dies with the landing, and the front it opens is separately
    // cancellable from that moment on.
    const a = { id: this.nextAttackId++, attacker: boat.attacker, target: boat.target, troops: boat.troops, progress: 0,
                heapTile: [], heapPrio: [], seen: new Set(), popPrio: 0,
                noiseSeed: (this.rng() * 1e9) | 0 };
    const nb = this.nbuf;
    const n = GameMap.neighbors(tile, nb);
    for (let k = 0; k < n; k++) {
      const j = nb[k];
      if (GameMap.owner[j] === boat.target && !a.seen.has(j)) {
        a.seen.add(j);
        this.heapPush(a, j, this.frontierPriority(0, j, a));
      }
    }
    // The target no longer holds anything touching the beachhead (lost it to
    // a third party while the boat was crossing) — the free tile is still
    // ours; the rest of the troops simply garrison it rather than vanish.
    if (a.heapTile.length > 0) this.attacks.push(a);
    else attacker.troops += boat.troops;
  },

  // One simulation turn. Takes no argument by design — see TICK_DT: the step
  // is a constant of the simulation, not something the caller gets to vary.
  tick() {
    if (this.spawning) { this.tickSpawnPhase(); return; }
    if (!this.running) return;
    this.ticks++;

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

    this.stepBoats();
    this.updateFactoryStations();
    this.stepTrains();
    this.updatePortTrade();
    this.stepTradeShips();
    this.stepWarships();
    this.stepShells();
    // Must run before stepNukes: a nuke a SAM successfully intercepts this
    // tick has to be removed from this.nukes before stepNukes' own duration
    // check gets a chance to detonate the same object.
    this.stepSAMs();
    this.stepSamMissiles();
    this.stepNukes();

    for (const p of this.players) {
      if (p.alive && p.tiles.size === 0 && p.troops < 20) p.alive = false;
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
    if (this.winnerId === null) {
      const alive = this.players.filter(p => p.alive && p.tiles.size > 0);
      if (alive.length === 1) {
        this.winnerId = alive[0].id;
      } else {
        // OpenFront's WinCheckExecution excludes irradiated land from the
        // denominator: numTilesWithoutFallout = numLandTiles -
        // numTilesWithFallout(). Radiated ground isn't required to win — it
        // just shrinks the total a player needs to own, same as this port's
        // Game.fallout Set. Checked against every player, not just Game.me
        // — the old UI.checkEndGame only ever tested the local human.
        const tilesNeededDenominator = GameMap.landTiles - this.fallout.size;
        if (tilesNeededDenominator > 0) {
          for (const p of this.players) {
            if (p.tiles.size / tilesNeededDenominator > 0.95) {
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

  DEFENSE_WEIGHT: 1.6,
  DEFENDER_LOSS: 0.55,

  // What being marked a traitor costs, from OpenFront's config:
  // traitorDefenseDebuff 0.5, traitorSpeedDebuff 0.8.
  //
  // Note where these land. Neither touches a defence stat — both are applied to
  // the ATTACKER's side of the ledger, so a traitor is cheaper and quicker to
  // carve up. And they apply to every attacker on the map, not only the nation
  // that was betrayed: the whole world smells blood.
  TRAITOR_DEFENSE_DEBUFF: 0.5,
  TRAITOR_SPEED_DEBUFF: 0.8,

  // There is deliberately no penalty on the attacker's own size here. One
  // existed while conquest cost rose without limit against a stronger defender;
  // with OpenFront's clamped cost it became a second tax on scale on top of the
  // growth curve's own, and swept measurably worse — 5 of 8 matches resolving
  // against 8 of 8 without it, and slower. Anti-snowball now comes entirely
  // from the population curve refilling large empires more slowly.

  // --- How fast a front advances -------------------------------------------
  // OpenFront meters advance in two independent layers, confirmed against
  // their live source (attackTilesPerTick + attackLogic's tilesPerTickUsed):
  //
  //   budget (per tick)   : within((5*attack/defence)*2, 0.01, 0.5) * border * 3
  //   per-tile cost        : within(defence/(5*attack), 0.2, 1.5) * terrain
  //
  // The budget sets how much advance a front can spend this tick, proportional
  // to the WIDTH OF THE FRONT — a broad border pours through, a narrow one
  // trickles, however large the army behind it. It saturates at its 0.5
  // ceiling once the attack is merely 5% of the defender's strength, so past
  // that point it stops rewarding further overmatch (OpenFront's own intent:
  // it exists to stall hopeless attacks, not to reward blowouts).
  //
  // What actually produces a curbstomp sweep is the SECOND, independent ratio
  // on the per-tile cost — the same comparison inverted, with its own floor.
  // Near parity it's already at its 0.2 floor, so an attack that has clearly
  // outnumbered its defender spends the SAME budget on many more tiles in one
  // tick, rather than one. This was missing entirely until an audit against
  // the real source turned it up — see tileSpeedRatio.
  //
  // ATTACK_RATE_SCALE is a calibration factor with no counterpart in their
  // code. Their constants composed literally finish a push in well under a
  // second here, which cannot be what their game does, so some piece of how
  // they meter troops per tick is missing from what their published config
  // shows. The shape below is theirs; this scalar sets the clock.
  ATTACK_RATE_SCALE: 0.2,

  // Unclaimed land needs the same calibration ATTACK_RATE_SCALE applies, for
  // the same reason: composed literally, borderTiles * 2 per tick swallowed a
  // 700-tile expansion in under a second, which is nothing like the deliberate
  // creep OpenFront shows. Running it unscaled was the overcorrection to an
  // earlier state where it was far too slow.
  //
  // Originally pinned to what was then believed to be the PVP ceiling
  // (0.5*border*3*ATTACK_RATE_SCALE = 0.30*border, i.e. NEUTRAL_RATE_SCALE =
  // 1.5*ATTACK_RATE_SCALE), so empty ground could never outpace an
  // overwhelming attack. tileSpeedRatio raises that true ceiling roughly 5x
  // (the 0.2 floor dividing rather than a flat 1.0), so the pin is no longer
  // load-bearing — neutral sits comfortably under it either way — but the
  // value itself is unchanged; only the reasoning that once justified it is.
  // Rate stays proportional to the width of the front, so a push still
  // accelerates as the blob broadens — it just starts from a watchable speed.
  // Measured: a half-commit opening grab takes ~5.6s and a full commit ~8s,
  // against 0.9s and 1.3s before. Match length is untouched (629s -> 645s mean
  // over six seeds, all resolving), because how fast the bots fill the map is
  // gated by troop accumulation and their think cadence, not by advance speed.
  NEUTRAL_RATE_SCALE: 0.15,

  // --- Large-player rebalancing ---------------------------------------------
  // Straight from OpenFront's attackLogic, verified against their live source
  // and explained in their own history: issue "Fix attack meta for large
  // players" ("Large players have too much of an advantage causing
  // snowballing in the mid-late game"), closed by PR "Update attack meta" —
  // "In earlier versions the game slowed to a crawl toward the end game
  // because attacks between large players were incredibly slow. As a kind of
  // hack, I increased the attack strength & speed of larger players... but
  // large players could completely crush smaller players. This PR completely
  // flips the meta: instead of giving large players an attack bonus, they are
  // given a defense debuff."
  //
  // A DEFENDER past ~150k tiles gets weaker on both fronts — cheaper to chip
  // away at (tileCost) and faster to lose ground to (tileSpeedRatio) — a
  // sigmoid ramp, not a cliff, bottoming out at a 0.7x floor. An ATTACKER past
  // 100k tiles keeps a separate, smaller efficiency edge (different exponents:
  // 0.7 on its own troop cost, 0.6 on speed) — the "more elegant formula"
  // their own PR description said was still to come.
  //
  // This was treated as a no-op here previously — our old maps never got
  // remotely close to either threshold, so the terms were dropped rather than
  // ported. Now that xlarge is genuinely OpenFront's own World-map scale
  // (~650k land tiles, ported directly from their manifest), a dominant
  // nation can cross both thresholds for real, and a defender who's grown
  // that large keeps their FULL defensive strength under the old code with no
  // corresponding debuff — which reads exactly like a small attacker's front
  // going near-stall against them, because until now it genuinely was: the
  // half of this mechanic that weakens the defender simply didn't exist.
  LARGE_DEFENDER_MIDPOINT: 150000,
  LARGE_DEFENDER_DECAY: Math.LN2 / 50000,
  LARGE_ATTACKER_THRESHOLD: 100000,

  sigmoid(value, decayRate, midpoint) {
    return 1 / (1 + this.det.exp(-decayRate * (value - midpoint)));
  },

  // 0.7-1.0. 1.0 (no effect) for any defender well under the threshold — true
  // of every nation on small/medium maps and most on large/xlarge too, so this
  // stays a rare, late-game-only effect rather than a constant tax. Shared by
  // both tileCost and tileSpeedRatio, exactly as OpenFront's
  // largeDefenderAttackDebuff and largeDefenderSpeedDebuff are the same
  // formula applied in two places.
  largeDefenderMultiplier(defenderTiles) {
    const sig = 1 - this.sigmoid(defenderTiles, this.LARGE_DEFENDER_DECAY, this.LARGE_DEFENDER_MIDPOINT);
    return 0.7 + 0.3 * sig;
  },

  // Separate attacker-side edge, only past 100k tiles — two different
  // exponents on the same ratio, matching largeAttackBonus (0.7, troop cost)
  // and largeAttackerSpeedBonus (0.6, speed) exactly.
  largeAttackerLossMult(attackerTiles) {
    return attackerTiles > this.LARGE_ATTACKER_THRESHOLD
      ? this.det.pow(this.LARGE_ATTACKER_THRESHOLD / attackerTiles, 0.7) : 1;
  },
  largeAttackerSpeedMult(attackerTiles) {
    return attackerTiles > this.LARGE_ATTACKER_THRESHOLD
      ? this.det.pow(this.LARGE_ATTACKER_THRESHOLD / attackerTiles, 0.6) : 1;
  },

  // Pure per-tick budget — how much advance a front can spend this tick. The
  // traitor speedup does NOT live here: OpenFront's traitorSpeedDebuff
  // multiplies tilesPerTickUsed, the per-tile COST charged against this
  // budget, not the budget itself. That distinction matters once the per-tile
  // cost also carries its own troop-ratio term (tileSpeedRatio, below) — the
  // two would otherwise double up. See tileSpeedRatio for where it's applied.
  attackTilesPerTick(attackTroops, defenceTroops, borderTiles, isNeutral) {
    if (isNeutral) return borderTiles * 2 * this.NEUTRAL_RATE_SCALE;
    const r = (5 * attackTroops / Math.max(1, defenceTroops)) * 2;
    const clamped = Math.min(0.5, Math.max(0.01, r));
    return clamped * borderTiles * 3 * this.ATTACK_RATE_SCALE;
  },

  // The budget above saturates at its 0.5 ceiling once the attack is merely
  // 5% of the defender's strength — past that point it stops rewarding
  // further overmatch, by design (OpenFront's own comment: it exists to stall
  // hopeless attacks, not to reward blowouts). What actually makes a curbstomp
  // sweep fast is a SECOND, independent ratio on the other side of the ledger:
  // OpenFront's tilesPerTickUsed scales the per-tile COST by
  // within(defenderTroops / (5*attackTroops), 0.2, 1.5) — the same comparison
  // inverted, with its own floor and ceiling. Near parity this is already at
  // its 0.2 floor (tiles cost a fifth as much as normal), so a front that has
  // truly outnumbered its defender processes many tiles from the same budget
  // in a single tick instead of one. Without this, ours had no mechanism to
  // accelerate beyond the budget's own ceiling at all — a real gap, not a
  // calibration one, and the direct cause of pushes never visibly snowballing
  // the way OpenFront's do against an overwhelmed defender.
  //
  // Read live inside the tile loop (both troops arguments deplete tile by
  // tile), exactly as OpenFront recomputes defender.troops() and troopCount
  // fresh on every iteration rather than once per tick.
  tileSpeedRatio(liveResist, attackTroops, defenderIsTraitor, defenderTiles, attackerTiles) {
    const ratio = Math.min(1.5, Math.max(0.2, liveResist / (5 * Math.max(1, attackTroops))));
    const large = this.largeDefenderMultiplier(defenderTiles) * this.largeAttackerSpeedMult(attackerTiles);
    return defenderIsTraitor ? ratio * large * this.TRAITOR_SPEED_DEBUFF : ratio * large;
  },

  // What a defender is worth against a particular attacker: the home reserve
  // plus anything already committed to a front facing them. Troops standing on
  // a front are still fighting that opponent, so an army thrown at someone must
  // get through it — reading the home reserve alone made a nation that had just
  // committed everything the cheapest possible target, however large the force
  // it held on the border. Troops committed elsewhere deliberately do not
  // count: over-extending on one front really does leave the others thin.
  defenceStrength(defender, attackerId) {
    let n = defender.troops;
    for (const a of this.attacks) {
      // A retreating counter-push has already pulled out of this fight.
      if (a.attacker === defender.id && a.target === attackerId && !a.retreating) n += a.troops;
    }
    return n;
  },

  // What the defender pays per tile lost, as a share of what the attacker
  // spent taking it — an engagement costs both sides.
  //
  // This was once keyed to the base cost instead, because scaling losses with
  // the defender's own multiplier made a populous nation bleed in proportion
  // to its size and collapse exponentially. That only bit when attacks
  // resolved instantly and the whole decay landed inside two seconds. Now that
  // a front takes half a minute to move, the same proportional attrition plays
  // out gradually and the defender can regrow, reinforce or counter while it
  // happens. Without it a defender simply out-regrows the damage and every
  // border sets into a permanent trench line.
  // OpenFront: defenderTroopLoss = defender.troops() / defender.numTilesOwned().
  // The defender sheds their own average garrison with each tile, so losing the
  // whole country costs them exactly their whole army — no more, no less.
  defenderLossPerTile(defender) {
    return defender.troops / Math.max(1, defender.tiles.size);
  },

  // Defense fort constants, ported from OpenFront's Config.ts:
  // defensePostRange=30, defensePostDefenseBonus=5, defensePostSpeedBonus=3.
  // A built fort within FORT_RANGE tiles of a contested tile multiplies the
  // attacker's troop cost (FORT_DEF_MULT) and movement cost (FORT_SPEED_MULT).
  FORT_RANGE: 30,
  FORT_DEF_MULT: 5,
  FORT_SPEED_MULT: 3,

  // True when a fully-built fort owned by `ownerId` is within FORT_RANGE
  // tiles (Euclidean) of `tile`. Iterates all buildings — typically <100
  // total — so this is cheap relative to the per-tile attack loop cost.
  // `includePending` also counts a fort still under construction — the combat
  // hooks below never pass it (an unfinished fort grants no bonus yet), but
  // AI.fortSite does, so a bot doesn't queue a second fort a few tiles from
  // one it already started this same minute.
  fortInRange(tile, ownerId, includePending) {
    const w = GameMap.width, tx = tile % w, ty = (tile / w) | 0;
    const r2 = this.FORT_RANGE * this.FORT_RANGE;
    for (const [bt, b] of this.buildings) {
      if (b.type !== 'fort' || (!b.built && !includePending)) continue;
      if (GameMap.owner[bt] !== ownerId) continue;
      const bx = bt % w, by = (bt / w) | 0;
      const dx = tx - bx, dy = ty - by;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  },

  // Terrain magnitude and speed, straight from OpenFront's attackLogic switch.
  // Indexed by PLAINS / HIGHLAND / MOUNTAIN.
  TERRAIN_MAG: [80, 100, 120],
  TERRAIN_SPEED: [16.5, 20, 25],

  // Movement cost of a tile relative to plains, from the paired speed values:
  // 1.00 plains, 1.21 highland, 1.52 mountain. Charged against the advance
  // budget per tile, so a front genuinely bogs down crossing high ground
  // instead of sweeping at one uniform rate.
  terrainMoveCost(tile) {
    return this.TERRAIN_SPEED[GameMap.terrain[tile]] / this.TERRAIN_SPEED[0];
  },

  // Roughness of the advancing edge. Without it every tile at a given distance
  // carries an identical priority, the wave leaves the heap in lockstep, and a
  // push across open ground reads as a straight staircase.
  //
  // The noise is sampled from a smooth field rather than rolled per tile.
  // Independent per-tile randomness does produce a ragged edge, but it also
  // scrambles the order faster than terrain's cost can accumulate over the
  // dozen-odd tiles of a push — measured at amplitude 4 it flattened mountain
  // resistance from 21% to 46%, and at 8 it inverted. Coherent noise moves
  // whole stretches of the line together instead, so the front grows lobes and
  // bays while rough ground still turns it.
  FRONT_JITTER: 3.2,
  FRONT_NOISE_SCALE: 0.09,

  frontierPriority(reached, tile, a) {
    const w = GameMap.width;
    const n = Noise.fractal((tile % w) * this.FRONT_NOISE_SCALE,
                            ((tile / w) | 0) * this.FRONT_NOISE_SCALE, a.noiseSeed, 3);
    return reached + this.terrainMoveCost(tile) + n * this.FRONT_JITTER;
  },

  // Troops spent to take one tile, following OpenFront's attackLogic:
  //
  //   currentLoss = within(defence / attack, 0.6, 2) * mag * 0.8
  //   altLoss     = 1.3 * defenderTroopLoss * (mag / 100)
  //   total       = 0.6 * currentLoss + 0.4 * altLoss
  //
  // The clamp at 2 is what we were missing most. Our old cost rose without
  // limit as the defender outweighed the attack, so pushing into anyone
  // stronger burned troops for almost no ground. OpenFront caps that penalty,
  // and blends in a term keyed to the defender's troops-per-tile density
  // rather than the ratio, so a big thinly-garrisoned nation is cheap to carve
  // into however large its total army.
  //
  // Strength counted is defenceStrength(): home reserve plus whatever is
  // committed against this same attacker. The mag term is in OpenFront's troop
  // units so it converts through POP_SCALE; the density term is already ours.
  // Unclaimed land, OpenFront's TerraNullius branch: the attacker simply pays
  // mag/5 per tile (mag/10 for their simple Bot type, which our rival nations
  // are not). No ratio, no defender strength — empty ground just costs a flat
  // toll. At Plains mag 80 that is 16 troops a tile before scaling.
  neutralTileCost(terrain) {
    return (this.TERRAIN_MAG[terrain || 0] / 5) * this.POP_SCALE;
  },

  // Config.ts's falloutDefenseModifier(falloutRatio) = 5 - falloutRatio*2:
  // taking irradiated land costs 5x while fallout is rare on the map,
  // easing down to 2.5x once a large share of it has been nuked. See
  // Game.fallout (set in detonateNuke, cleared in setOwner on capture) and
  // the "Missile Silo & Nukes" section's own comment on why this — not
  // converting the land to water — is OpenFront's actual default-ruleset
  // behavior.
  falloutDefenseModifier() {
    const ratio = GameMap.landTiles > 0 ? this.fallout.size / GameMap.landTiles : 0;
    return 5 - ratio * 2;
  },

  // Real attackLogic applies this same modifier to BOTH troop cost (mag) and
  // per-tile speed (tileCost) — but its terra-nullius branch computes speed
  // as within(2000*tileCost/attackTroops, 5, 100), i.e. inversely
  // proportional to the attacking force's committed troops, while the troop
  // COST side (mag/5) stays flat regardless of force size. Our engine's
  // NEUTRAL_RATE_SCALE budget has no troop term at all, so porting the flat
  // 5x-2.5x multiplier onto move cost alone made pushes into fallout crawl
  // at the same fixed pace no matter how large the committed army was — a
  // small force and a huge one took equally forever, which is exactly what
  // the user reported ("lasts a very long time") and not what OpenFront
  // actually does (a big army shrugs off the terrain and burns through it
  // fast, still paying the full flat troop cost per tile, so the whole push
  // is short and decisive). This reuses that shape — bigger a.troops erases
  // more of the speed penalty — without touching the flat troop-cost side or
  // the calibrated non-fallout NEUTRAL_RATE_SCALE pacing.
  FALLOUT_SPEED_TROOPS: 3000,
  falloutSpeedMult(troops) {
    const full = this.falloutDefenseModifier();
    return 1 + (full - 1) * (this.FALLOUT_SPEED_TROOPS / (this.FALLOUT_SPEED_TROOPS + Math.max(0, troops)));
  },

  // `tile` is optional; pass it from stepAttack to enable the fort bonus.
  tileCost(attacker, defender, attackTroops, terrain, tile) {
    let mag = this.TERRAIN_MAG[terrain || 0];
    // Fallout: unconditional in real attackLogic (no `defender.isPlayer()`
    // gate the way DefensePost's own bonus below has) — fitting, since a
    // fallout tile is by construction always unowned (GameImpl's setFallout
    // throws otherwise), so it only ever actually matters against the
    // neutral-land branch just below in practice.
    if (tile !== undefined && this.fallout.has(tile)) mag *= this.falloutDefenseModifier();
    // Unclaimed land: OpenFront's "simple Bot" type pays half toll (mag/10)
    // that a human or Nation pays (mag/5) — Tribes are that simple Bot type.
    if (!defender) return (mag / (attacker.isTribe ? 10 : 5)) * this.POP_SCALE;

    // openfront.wiki/Bots: "if (attacker.type() == Human && defender.type()
    // == Bot) mag *= 0.8" — a 20% troop-loss discount for the human attacking
    // a Tribe specifically. Nations get no such discount fighting a Tribe.
    // Keyed off the attacker's *type*, not off Game.me: under lockstep every
    // client runs this same tileCost, so a per-viewer branch here would make
    // the very first human-vs-Tribe attack diverge between clients.
    if (defender.isTribe && attacker.isHuman) mag *= 0.8;

    // Defense fort: troop cost to take a tile inside the fort's range is 5x,
    // matching Config.defensePostDefenseBonus in OpenFront's attackLogic.
    if (tile !== undefined && this.fortInRange(tile, defender.id)) mag *= this.FORT_DEF_MULT;

    const strength = this.defenceStrength(defender, attacker.id);
    const ratio = Math.min(2, Math.max(0.6, strength / Math.max(1, attackTroops)));
    // Large-player terms apply only to currentLoss, not altLoss — matching
    // OpenFront exactly, where largeDefenderAttackDebuff and largeAttackBonus
    // multiply into currentAttackerLoss alone.
    const largeDef = this.largeDefenderMultiplier(defender.tiles.size);
    const largeAtk = this.largeAttackerLossMult(attacker.tiles.size);
    const currentLoss = ratio * mag * 0.8 * largeDef * largeAtk * this.POP_SCALE;
    const density = strength / Math.max(1, defender.tiles.size);
    const altLoss = 1.3 * density * (mag / 100);
    // OpenFront applies traitorMod to both loss terms before blending them, so
    // scaling the blend is the same arithmetic in one place.
    const traitorMod = this.isTraitor(defender) ? this.TRAITOR_DEFENSE_DEBUFF : 1;
    return (0.6 * currentLoss + 0.4 * altLoss) * traitorMod;
  },

  // Two nations pushing into each other are one battle, not two independent
  // ones. Their committed forces meet and destroy each other, so blunting an
  // attack costs the attacker the troops it stopped and whichever side has
  // anything left is the one still advancing. Without this the two pushes pass
  // straight through one another, each holding its full strength and each
  // drawing its own counter on the same stretch of border.
  resolveOpposingFronts() {
    for (let i = 0; i < this.attacks.length; i++) {
      const a = this.attacks[i];
      // A retreating front has already stopped fighting — its troops are
      // walking home, not contesting the ground a counter-push meets them on.
      if (a.target < 0 || a.troops <= 0 || a.retreating) continue;
      for (let j = i + 1; j < this.attacks.length; j++) {
        const b = this.attacks[j];
        if (b.target < 0 || b.troops <= 0 || b.retreating) continue;
        if (a.attacker !== b.target || b.attacker !== a.target) continue;
        const clash = Math.min(a.troops, b.troops);
        a.troops -= clash;
        b.troops -= clash;
        if (a.troops <= 0) break;
      }
    }
  },

  // --- Conquest frontier: a cheapest-first priority queue ------------------
  // OpenFront keeps its `toConquer` set as a priority queue, and that choice is
  // what gives fronts their shape. A plain FIFO advances in strict distance
  // order, so the wave crosses a ridge at the same moment it crosses a meadow
  // and terrain only changes the bill. Ordering by accumulated movement cost
  // instead lets a push bulge through open ground and lag against high country,
  // which is where the ragged, map-following fronts come from.
  heapPush(a, tile, prio) {
    const T = a.heapTile, P = a.heapPrio;
    let i = T.length;
    T.push(tile); P.push(prio);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (P[parent] <= P[i]) break;
      const t = T[parent]; T[parent] = T[i]; T[i] = t;
      const p = P[parent]; P[parent] = P[i]; P[i] = p;
      i = parent;
    }
  },

  heapPop(a) {
    const T = a.heapTile, P = a.heapPrio;
    const top = T[0], topPrio = P[0], last = T.length - 1;
    T[0] = T[last]; P[0] = P[last];
    T.pop(); P.pop();
    let i = 0;
    const n = T.length;
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let small = i;
      if (l < n && P[l] < P[small]) small = l;
      if (r < n && P[r] < P[small]) small = r;
      if (small === i) break;
      const t = T[small]; T[small] = T[i]; T[i] = t;
      const p = P[small]; P[small] = P[i]; P[i] = p;
      i = small;
    }
    a.popPrio = topPrio;
    return top;
  },

  // Rebuilds an attack's queue from the attacker's *current* border with the
  // target. The queue is a snapshot of a border that moves under it, and a
  // slow advance drains it faster than conquests refill it, so without this an
  // attack aborts with most of its troops unspent and every front churns
  // without ever breaking. Returns false when the two no longer touch at all.
  //
  // Scans attacker.borderTiles (owned tiles with a non-owned neighbour, kept
  // live by setOwner/updateBorderTile) rather than every tile the attacker
  // owns — only a border tile can possibly neighbour the target, so this is
  // exactly equivalent, just perimeter-sized instead of area-sized. A launch
  // (or troop top-up) against a sprawling empire used to re-walk its entire
  // territory synchronously on every click; this is the fix for that hitch.
  refreshFrontier(a) {
    const attacker = this.players[a.attacker];
    const seen = new Set(), nb = this.nbuf;
    a.heapTile = []; a.heapPrio = []; a.seen = seen;
    for (const i of attacker.borderTiles) {
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] === a.target && !seen.has(j)) {
          seen.add(j);
          this.heapPush(a, j, this.frontierPriority(0, j, a));
        }
      }
    }
    return a.heapTile.length > 0;
  },

  // Once a nation is down to scraps, grinding out the remainder tile by tile
  // costs the attacker real time for a foregone conclusion, and leaves confetti
  // on the map. OpenFront's own threshold is 100 tiles. Tiles go to whichever
  // neighbour touches them, the attacker winning any tie, so a nation boxed in
  // by three rivals is carved up rather than teleporting to whoever landed last.
  DEAD_DEFENDER_TILES: 100,

  handleDeadDefender(defenderId, attackerId) {
    const defender = this.players[defenderId];
    const attacker = this.players[attackerId];
    const nb = this.abuf;

    // Spoils. The land is divided among every neighbour that touches it, but a
    // treasury cannot be split along a border — it goes whole to the nation
    // that landed the killing blow. That asymmetry is the point: a rival who
    // has been hoarding is worth finishing off yourself rather than leaving to
    // the vultures, and the reward for it arrives as gold, which the population
    // curve cannot claw back the way it does conquered land.
    // OpenFront's conquerGoldAmount halves the spoils specifically when the
    // player being conquered is Human — Bot/Nation kills pay out in full. So
    // the branch is on the *defender's type*, not on whether the defender is
    // the viewing client: with several humans in a lockstep match "the human"
    // is no longer a single id, and a per-viewer branch would hand different
    // clients different treasuries.
    if (attacker) {
      attacker.gold += defender.isHuman ? defender.gold / 2 : defender.gold;
      defender.gold = 0;
    }

    // Several passes: a tile with no living neighbour this round may gain one
    // as the carve-up proceeds inward.
    for (let pass = 0; pass < 6 && defender.tiles.size; pass++) {
      let changed = false;
      for (const i of [...defender.tiles]) {
        let claim = -1;
        const n = GameMap.neighbors(i, nb);
        for (let k = 0; k < n; k++) {
          const o = GameMap.owner[nb[k]];
          if (o === attackerId) { claim = attackerId; break; }
          if (o >= 0 && o !== defenderId && claim < 0) claim = o;
        }
        if (claim >= 0) { this.setOwner(i, claim); changed = true; }
      }
      if (!changed) break;
    }
    // Anything still landlocked among its own kind falls to the attacker.
    for (const i of [...defender.tiles]) this.setOwner(i, attackerId);
  },

  // True when `tile` has a 4-neighbour already owned by `playerId`, i.e. taking
  // it would keep that player's territory contiguous.
  touchesPlayer(tile, playerId) {
    const nb = this.abuf;
    const n = GameMap.neighbors(tile, nb);
    for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] === playerId) return true;
    return false;
  },

  // True when `playerId` already holds any land on the same landmass as
  // `tile` — the right test for "is this a normal land attack, not a naval
  // one," regardless of exactly which tile got clicked. A per-tile
  // touchesPlayer check is too strict here: attacking neutral or enemy land
  // has always worked by clicking anywhere on it, with the whole contiguous
  // border expanding from wherever the attacker actually touches it — not
  // just the one pixel that happens to be tapped. That matters most right at
  // the start of a match, when a nation is a ~49-tile dot easy to miss by a
  // tile at the default whole-map zoom.
  onSameLandmass(playerId, tile) {
    const p = this.players[playerId];
    if (!p) return false;
    const id = GameMap.landmassId[tile];
    for (const t of p.tiles) if (GameMap.landmassId[t] === id) return true;
    return false;
  },

  // Flood-fills the connected component of same-owner tiles containing
  // `startTile` and tests whether it is fully enclosed by `byPlayerId`'s
  // territory: walking outward from it can only ever land on more of the
  // same owner (interior) or on byPlayerId (a wall) — reaching open water,
  // unclaimed land, a third player, or the map edge means there's a gap and
  // it's not enclosed. Ported against OpenFront's actual
  // PlayerExecution.isSurrounded/isEnclosed source (github.com/openfrontio/
  // OpenFrontIO), collapsed from their two-stage cheap-filter-then-confirm
  // design into one walk since this runs on demand (a click, a bot's
  // decision) rather than continuously across every player every tick.
  // Unclaimed land disqualifies too, not just water — that looks stricter
  // than OpenFront's isEnclosed alone, but matches what actually happens in
  // real matches: their cheap prefilter already rejects any unowned
  // neighbour before the lenient flood-fill ever gets a chance to run.
  // Returns the region's tiles (annexable) or null (not enclosed).
  //
  // `seen`/`run` are how enclosedPocketsOf below walks many pockets in one
  // sweep without paying for the same ground twice: `seen` maps a tile to the
  // id of the walk that reached it, so every tile is expanded at most once
  // across the whole sweep. Meeting a tile stamped by an *earlier* walk means
  // this pocket has already been walked from another contact point and
  // rejected there — an accepted pocket is a whole connected component, so it
  // can never be touching this one — and this walk fails with it.
  enclosedRegion(startTile, byPlayerId, seen, run) {
    const target = GameMap.owner[startTile];
    if (target < 0 || target === byPlayerId) return null;

    if (!seen) {
      seen = this._annexSeen || (this._annexSeen = new Map());
      seen.clear();
      run = 0;
    }
    seen.set(startTile, run);
    const region = [startTile];
    const stack = [startTile];
    const nb = this.abuf;

    while (stack.length) {
      const tile = stack.pop();
      const n = GameMap.neighbors(tile, nb);
      if (n < 4) return null; // touches the map edge
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        const o = GameMap.owner[j];
        if (o === target) {
          const walk = seen.get(j);
          if (walk === run) continue;
          if (walk !== undefined) return null; // already walked, already rejected
          seen.set(j, run);
          region.push(j);
          stack.push(j);
          continue;
        }
        if (o === byPlayerId) continue; // part of the wall
        return null; // water, unclaimed land, or a third player: a gap
      }
    }
    return region;
  },

  // Every pocket of `targetId` that `byPlayerId`'s land walls in, not just the
  // one under a cursor. A nuke leaves its blast as a scatter of survivors
  // among unclaimed irradiated ground, so resettling that ground turns what is
  // left of the defender there into dozens of one- and two-tile pockets —
  // annexing them one tap at a time was miserable, and this is what lets a
  // single tap take the lot.
  //
  // Contact points are collected off our own border (borderTiles, kept live
  // by setOwner) rather than off the defender's tile set or our own full
  // territory, since a pocket is by definition something our land touches —
  // only a border tile can have a neighbour of a different owner — and the
  // shared seen/run map keeps the sweep linear in the defender's tiles no
  // matter how much of our border touches them. This runs from the hover
  // renderer on essentially every frame territory changes anywhere on the
  // map while the cursor rests on another nation, so scanning all of `me`'s
  // tiles instead of just its border was a per-frame hitch of its own for a
  // large empire. Uses nbuf so the abuf enclosedRegion walks on can't
  // clobber it mid-scan.
  enclosedPocketsOf(targetId, byPlayerId) {
    const me = this.players[byPlayerId];
    if (targetId < 0 || targetId === byPlayerId || !me) return [];
    const seen = new Map(), nb = this.nbuf, regions = [];
    let run = 0;
    for (const i of me.borderTiles) {
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] !== targetId || seen.has(j)) continue;
        const region = this.enclosedRegion(j, byPlayerId, seen, ++run);
        if (region) regions.push(region);
      }
    }
    return regions;
  },

  // Hands every one of those pockets over at once. All of them are found
  // before any of them changes hands, since annexRegion/setOwner rewrite the
  // very tile sets enclosedPocketsOf scans. Returns the tiles taken.
  annexEnclosedPockets(targetId, byPlayerId) {
    const regions = this.enclosedPocketsOf(targetId, byPlayerId);
    let taken = 0;
    for (const r of regions) { taken += r.length; this.annexRegion(r, byPlayerId); }
    return taken;
  },

  // Instantly hands every tile of an enclosed region to byPlayerId — no
  // troops, no siege ticks, per OpenFront's annexation rule that a fully
  // surrounded territory falls for free the moment it's attacked. If this
  // was the loser's entire remaining territory, their treasury moves with
  // it too (same halved-for-human rule handleDeadDefender uses below), since
  // regular tile loss never transfers gold and a full wipe otherwise
  // silently drops it.
  //
  // A combat death catches itself next tick: maxTroops falls with every tile
  // lost, so by the time the last one goes troops are already near zero and
  // the p.troops < 20 sweep below finishes the job. Annexation skips combat
  // entirely, so that path never fires here — a 0-tile player's floor is
  // BASE_POP, not zero, so their troops would actually climb from wherever
  // annexation left them and they'd sit "alive" forever. Elimination is
  // finalized here instead of left to the sweep.
  annexRegion(tiles, byPlayerId) {
    if (tiles.length === 0) return;
    const loser = this.players[GameMap.owner[tiles[0]]];
    const wipesThem = loser.tiles.size === tiles.length;

    for (const t of tiles) this.setOwner(t, byPlayerId);

    if (wipesThem) {
      const winner = this.players[byPlayerId];
      // Same half-spoils rule as the conquest path above, and keyed the same
      // way — on the loser being human-controlled, never on it being the
      // viewing client, which a lockstep sim must not know about.
      winner.gold += loser.isHuman ? loser.gold / 2 : loser.gold;
      loser.gold = 0;
      loser.troops = 0;
      loser.alive = false;
    }
  },

  stepAttack(a) {
    const attacker = this.players[a.attacker];

    // Ordered to retreat: no further conquest, just waiting out RETREAT_DELAY
    // before the survivors are handed back to the reserve.
    if (a.retreating) {
      if (this.elapsed < a.retreatAt) return true;
      const malus = a.target >= 0 ? this.ATTACK_RETREAT_MALUS : 0;
      attacker.troops += a.troops * (1 - malus);
      return false;
    }

    const defender = a.target >= 0 ? this.players[a.target] : null;
    const nb = this.nbuf;

    // Tiles earned this tick, carried as a fraction so slow fronts still creep
    // forward rather than stalling on a rounded-down zero. The live queue is
    // this front's width, which is what OpenFront's rate is proportional to.
    const borderTiles = a.heapTile.length;
    const resist = defender ? this.defenceStrength(defender, a.attacker) : 0;
    const rate = this.attackTilesPerTick(a.troops, resist, borderTiles, !defender);
    // `progress` is measured in plains-equivalent tiles; rough ground simply
    // costs more of it, so the same budget carries a front further across open
    // country than up a ridge.
    a.progress += rate * this.TICK_DT * this.TICKS_PER_SEC;

    let guard = 20000;
    while (guard-- > 0) {
      if (a.heapTile.length === 0) break;

      // Cheapest reachable ground first, so the wave is ordered by how hard the
      // country is to cross rather than by raw distance from the border.
      const tile = a.heapTile[0];

      if (GameMap.owner[tile] !== a.target) { this.heapPop(a); continue; }

      // The queue was built from a border that may since have moved — a
      // counter-attack can retake the tiles this wave advanced through. Without
      // re-checking contact, the wave rolls on into enemy land and leaves a
      // disconnected snake of territory behind their front. Forgetting the tile
      // rather than dropping it lets the wave pick it up again if the front
      // fights its way back into contact.
      if (!this.touchesPlayer(tile, a.attacker)) { a.seen.delete(tile); this.heapPop(a); continue; }

      // Skipped tiles above cost no movement; only ground actually taken does.
      // Terrain sets the baseline; tileSpeedRatio is what lets an overwhelming
      // push blow through several tiles' worth of budget in one go instead of
      // creeping at the terrain rate regardless of how lopsided the fight is.
      const liveResist = defender ? this.defenceStrength(defender, a.attacker) : 0;
      const speedRatio = defender
        ? this.tileSpeedRatio(liveResist, a.troops, this.isTraitor(defender), defender.tiles.size, attacker.tiles.size)
        : 1;
      // Defense fort: movement cost into protected tiles is 3x, matching
      // Config.defensePostSpeedBonus in OpenFront's attackLogic.
      const fortMult = (defender && this.fortInRange(tile, defender.id)) ? this.FORT_SPEED_MULT : 1;
      // Fallout: falloutSpeedMult (see its own comment) instead of the flat
      // falloutDefenseModifier tileCost's troop-cost side still uses below —
      // this side scales down as the attacking force grows, so a strong push
      // clears irradiated ground quickly instead of crawling forever.
      const falloutMult = this.fallout.has(tile) ? this.falloutSpeedMult(a.troops) : 1;
      const move = this.terrainMoveCost(tile) * speedRatio * fortMult * falloutMult;
      if (a.progress < move) break;

      const cost = this.tileCost(attacker, defender, a.troops, GameMap.terrain[tile], tile);
      if (a.troops < cost) { a.troops = 0; break; }

      this.heapPop(a);
      const reached = a.popPrio;
      a.progress -= move;
      a.troops -= cost;
      if (defender) {
        defender.troops = Math.max(0, defender.troops - this.defenderLossPerTile(defender));
      }
      this.setOwner(tile, a.attacker);

      if (defender && defender.tiles.size > 0 && defender.tiles.size <= this.DEAD_DEFENDER_TILES) {
        this.handleDeadDefender(a.target, a.attacker);
        break;
      }

      const n = GameMap.neighbors(tile, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (GameMap.owner[j] === a.target && !a.seen.has(j)) {
          a.seen.add(j);
          this.heapPush(a, j, this.frontierPriority(reached, j, a));
        }
      }
    }

    if (a.troops <= 0) {
      attacker.troops += Math.max(0, a.troops);
      return false;
    }

    // Queue spent but troops left: re-scan the live border and keep pressing.
    // Only when the two genuinely no longer touch does the attack end.
    if (a.heapTile.length === 0 && !this.refreshFrontier(a)) {
      attacker.troops += Math.max(0, a.troops);
      return false;
    }
    return true;
  },

  // Live attack fronts, used for both rendering and AI target scoring.
  frontierTilesOf(playerId) {
    let n = 0;
    for (const a of this.attacks) if (a.attacker === playerId) n += a.heapTile.length;
    return n;
  },

  // --- Rail network & trains ------------------------------------------------
  // Ported against OpenFront's actual FactoryExecution / TrainStationExecution
  // / TrainExecution / RailNetworkImpl / TrainStation / Config.ts source
  // (github.com/openfrontio/OpenFrontIO), not guessed, with deliberate scope
  // cuts made and noted where they happen:
  //  - Rails connect ANY nearby City/Factory (own, enemy, or neutral) exactly
  //    like the real RailNetworkImpl.connectToNearbyStations/
  //    computeGhostRailPaths, which apply no owner filter at all to the
  //    physical network. Trade is likewise open with everyone by default
  //    (tradeRel, mirroring TrainStation.tradeAvailable minus the embargo
  //    check this game doesn't have) — a bot's factory will happily route a
  //    train to your city, paying BOTH of you, exactly like
  //    TradeStationStopHandler's two-way payout. Only the "team" tier is
  //    missing from trainGold's rate table, since there's no team system
  //    here, only alliance (self/ally/other).
  //  - No minimum connection range. OpenFront's own RailNetworkImpl skips a
  //    candidate closer than trainStationMinRange (15 tiles), which sounds
  //    like a reasonable "don't draw a silly one-tile stub" guard but has a
  //    sharp edge: a Factory built close beside the very Cities it exists to
  //    connect can end up isolated from all of them while they connect to
  //    each other instead, because they're near enough to fail ITS distance
  //    check but still just far enough apart to pass each other's. Since
  //    this game's whole point for a Factory is "connect the cities near
  //    it," leaving it possible for the nearest ones to be exactly the ones
  //    it refuses to link is a bug here even though it's just an edge case
  //    in OpenFront's own much bigger world map — so this game drops the
  //    minimum entirely instead of porting it.
  //  - Rails are strictly horizontal/vertical, laid as a single elbow bend
  //    (one straight leg each way) rather than OpenFront's diagonal-capable
  //    weighted AStar.Rail — an explicit style choice for this game (real
  //    rail-map look, no diagonals) rather than a fidelity simplification.
  //    See orthogonalPath.
  //
  // A Factory becomes a station the instant it finishes construction, and it
  // recruits every City within range into the network too — even ones built
  // long before it (FactoryExecution.createStation). A City built later
  // checks the reverse: is a Factory already close enough to plug it in. A
  // City the network never reaches just never spawns or earns anything —
  // only a Factory ever originates a train (see updateFactoryStations),
  // exactly like OpenFront's own City/Port stations, which are trade
  // destinations only and never spawnTrains themselves.
  //
  // Range/hop constants below are lifted verbatim from Config.ts's
  // trainStationMaxRange/railroadMaxSize and RailNetworkImpl's own
  // maxConnectionDistance — unscaled, because MAP_SIZES already ports
  // OpenFront's real map dimensions tile-for-tile, so their absolute tile
  // radii need no rescaling to mean the same thing here.
  TRAIN_STATION_MAX_RANGE: 110,
  RAILROAD_MAX_TILES: Math.round(110 * 1.4142),   // trainStationMaxRange() * 1.4142
  RAIL_MAX_CONNECTION_HOPS: 4,

  tileDistSq(a, b) {
    const w = GameMap.width;
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  },

  // Fires once, the instant a city or factory finishes construction (see
  // updateConstruction) — never on capture and never on upgrade.
  onStructureCompleted(b) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    if (b.type === 'factory') {
      this.becomeStation(b);
      for (const other of this.buildings.values()) {
        if (other === b || other.station || !other.built) continue;
        // Fort is a defensive-only structure — never a rail station, matching
        // previewFactoryConnections' own city/factory/port-only filter (this
        // loop previously had no type filter at all, so a Fort near a
        // completing Factory silently became a station despite the preview
        // never showing that line).
        if (other.type !== 'city' && other.type !== 'factory' && other.type !== 'port') continue;
        if (this.tileDistSq(b.tile, other.tile) <= range * range) this.becomeStation(other);
      }
    } else if (b.type === 'city' || b.type === 'port') {
      // PortExecution.createStation checks the identical condition City's
      // own TrainStationExecution does — join only if a Factory is already
      // in range — so Port rides the same branch rather than a copy of it.
      for (const other of this.buildings.values()) {
        if (other.type !== 'factory' || !other.built) continue;
        if (this.tileDistSq(b.tile, other.tile) <= range * range) { this.becomeStation(b); break; }
      }
    }
  },

  // Marks `b` a station and links it into whatever nearby same-owner stations
  // it can reach — see linkStationToNetwork. Idempotent: a station recruited
  // twice (a City in range of two different Factories, say) only runs the
  // linking pass once.
  becomeStation(b) {
    if (b.station) return;
    b.station = true;
    this.linkStationToNetwork(b);
  },

  // RailNetworkImpl.connectToNearbyStations, minus the "snap onto the middle
  // of an existing rail" refinement (connectToExistingRails) — a real but
  // rare optimization OpenFront uses to keep dense networks from crossing
  // themselves; skipping it just means two stations occasionally get a
  // slightly longer point-to-point rail instead of branching off an existing
  // one partway along. Also minus their minimum-range skip — see the class
  // comment for why that's dropped rather than ported. Still skips a
  // candidate already reachable within RAIL_MAX_CONNECTION_HOPS hops, so the
  // graph stays sparse rather than fully meshed — a new station still gets a
  // link to its actual nearest neighbours, just not to every station in
  // range.
  linkStationToNetwork(station) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    const candidates = [];
    for (const other of this.buildings.values()) {
      if (!other.station || other === station) continue;
      const d = this.tileDistSq(station.tile, other.tile);
      if (d > range * range) continue;
      candidates.push({ b: other, d });
    }
    candidates.sort((x, y) => x.d - y.d);

    for (const { b: other } of candidates) {
      const hops = this.stationHopDistance(station.tile, other.tile, this.RAIL_MAX_CONNECTION_HOPS);
      if (hops !== -1) continue;
      this.connectStations(station, other);
    }
  },

  // Read-only preview of the rail lines a hypothetical new station at `tile`
  // would draw to EXISTING stations — shared by both previewFactoryConnections
  // and previewCityConnections, since linkStationToNetwork treats a fresh
  // City-that-just-qualified and a fresh Factory identically once each is
  // actually becoming a station. No owner filter, matching linkStationToNetwork
  // (own/enemy/neutral stations all preview) — see the class comment. Same
  // hop-dedup linkStationToNetwork applies for real: a candidate already
  // within RAIL_MAX_CONNECTION_HOPS-1 hops of one this preview already
  // "linked" is skipped, since it would be reachable through that neighbour
  // once the new station's own edge to it exists (the -1 accounts for that
  // one extra hop through the new hub).
  previewStationLinks(tile) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    const lines = [];

    const stationCandidates = [];
    for (const other of this.buildings.values()) {
      if (!other.station || !other.built) continue;
      if (this.tileDistSq(tile, other.tile) > range * range) continue;
      stationCandidates.push(other);
    }
    stationCandidates.sort((a, b) => this.tileDistSq(tile, a.tile) - this.tileDistSq(tile, b.tile));

    const linked = [];
    for (const other of stationCandidates) {
      const alreadyReachable = linked.some(s =>
        this.stationHopDistance(other.tile, s.tile, this.RAIL_MAX_CONNECTION_HOPS - 1) !== -1);
      if (alreadyReachable) continue;
      const path = this.orthogonalPath(tile, other.tile);
      if (path) { lines.push(path); linked.push(other); }
    }

    return lines;
  },

  // Read-only preview of what placing a Factory at `tile` would connect to —
  // Render's placement ghost calls this to draw candidate rail lines before
  // the player commits. Mirrors onStructureCompleted's factory branch
  // against the REAL, unmutated rail graph rather than actually building
  // anything: previewStationLinks covers the "link to nearby EXISTING
  // stations" half, and the loop below covers the other half a Factory does
  // that a City/Port never does — recruiting non-station City/Factory/Port
  // buildings in range, own/enemy/neutral alike (see the class comment). In
  // the common case (nothing nearby connected yet) each one's own real
  // linkStationToNetwork call finds the new factory as its nearest station
  // and links straight to it, so every one of them gets a preview line too,
  // without the hop-dedup pass (it doesn't apply until a candidate is
  // already a station). The type filter here has to list every recruitable
  // type explicitly, unlike onStructureCompleted's own factory branch (no
  // filter at all) — a real gap that once meant a Port sitting near a
  // freshly-placed Factory drew no preview line even though it would
  // actually join the network the instant that Factory finished building.
  previewFactoryConnections(tile) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    const lines = this.previewStationLinks(tile);

    for (const other of this.buildings.values()) {
      if (other.station || !other.built) continue;
      if (other.type !== 'city' && other.type !== 'factory' && other.type !== 'port') continue;
      if (this.tileDistSq(tile, other.tile) > range * range) continue;
      const path = this.orthogonalPath(tile, other.tile);
      if (path) lines.push(path);
    }

    return lines;
  },

  // Read-only preview of what placing a City (or a Port — see
  // onStructureCompleted, which treats them identically for station-joining)
  // at `tile` would connect to. Unlike a Factory, neither one recruits
  // anyone — per onStructureCompleted's shared branch it doesn't even join
  // the network itself unless a Factory (own, enemy, or neutral — see the
  // class comment) is ALREADY within range, so this returns no lines at all
  // (nothing to preview) until that condition is met, then defers to the
  // same previewStationLinks a Factory placement uses.
  previewCityConnections(tile) {
    const range = this.TRAIN_STATION_MAX_RANGE;
    let factoryInRange = false;
    for (const other of this.buildings.values()) {
      if (other.type !== 'factory' || !other.built) continue;
      if (this.tileDistSq(tile, other.tile) <= range * range) { factoryInRange = true; break; }
    }
    return factoryInRange ? this.previewStationLinks(tile) : [];
  },

  // BFS over the existing rail graph, capped at maxHops — RailNetworkImpl's
  // own distanceFrom, used only to decide whether a NEW link is worth adding
  // (see linkStationToNetwork), not for train routing (findStationPath below
  // is uncapped).
  stationHopDistance(fromTile, toTile, maxHops) {
    if (fromTile === toTile) return 0;
    const visited = new Set([fromTile]);
    let frontier = [fromTile];
    for (let dist = 1; dist <= maxHops; dist++) {
      const next = [];
      for (const t of frontier) {
        const b = this.buildings.get(t);
        if (!b) continue;
        for (const n of b.rails.keys()) {
          if (n === toTile) return dist;
          if (!visited.has(n)) { visited.add(n); next.push(n); }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    return -1;
  },

  // Builds one rail edge between two stations along an axis-aligned elbow
  // path (see orthogonalPath) and records it on both stations' adjacency
  // plus the flat railroads[] list Render draws from. No-op if no clear
  // orthogonal corridor exists in either bend orientation, or the path would
  // run longer than RAILROAD_MAX_TILES — mirrors RailNetworkImpl.connect's
  // own path.length < railroadMaxSize guard. Each station's rails Map stores
  // the small waypoint list itself (2 or 3 tiles: station, optional elbow,
  // station) — cheap to keep in full, unlike a per-cell walk would be —
  // oriented FROM that station, so buildTrainRoute can concatenate hops
  // directly without re-deriving direction.
  connectStations(a, b) {
    if (a.rails.has(b.tile)) return false;
    const waypoints = this.orthogonalPath(a.tile, b.tile);
    if (!waypoints || this.pathLength(waypoints) > this.RAILROAD_MAX_TILES) return false;
    const id = this.nextRailId++;
    this.railroads.push({ id, a: a.tile, b: b.tile, waypoints });
    a.rails.set(b.tile, waypoints);
    b.rails.set(a.tile, [...waypoints].reverse());
    return true;
  },

  // Every tile along a horizontal run at fixed y from x0 to x1, or a
  // vertical run at fixed x from y0 to y1 (caller guarantees exactly one of
  // x0===x1 / y0===y1 holds) — true the instant one of them isn't land.
  straightClear(x0, y0, x1, y1) {
    const w = GameMap.width;
    if (y0 === y1) {
      const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      for (let x = lo; x <= hi; x++) if (!GameMap.isLand(y0 * w + x)) return false;
    } else {
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      for (let y = lo; y <= hi; y++) if (!GameMap.isLand(y * w + x0)) return false;
    }
    return true;
  },

  // The land counterpart of retraceWaterLine's diagonal Bresenham walk, but
  // deliberately NOT diagonal: builds a single-bend "elbow" path between two
  // stations, one straight horizontal leg and one straight vertical leg, so
  // every rail this game draws runs strictly up/down or left/right — a
  // classic rail-map look rather than OpenFront's own diagonal-capable
  // AStar.Rail (see the class comment). Tries horizontal-then-vertical
  // first, then vertical-then-horizontal, since a water obstacle might block
  // one bend but not the other; returns null only if both do. Two stations
  // already sharing a row or column degenerate to a single straight leg with
  // no elbow at all.
  orthogonalPath(from, to) {
    const w = GameMap.width;
    const ax = from % w, ay = (from / w) | 0, bx = to % w, by = (to / w) | 0;
    if (ax === bx || ay === by) {
      return this.straightClear(ax, ay, bx, by) ? [from, to] : null;
    }
    const elbowH = GameMap.idx(bx, ay);   // horizontal leg first: from -> (bx,ay) -> to
    if (this.straightClear(ax, ay, bx, ay) && this.straightClear(bx, ay, bx, by)) {
      return [from, elbowH, to];
    }
    const elbowV = GameMap.idx(ax, by);   // vertical leg first: from -> (ax,by) -> to
    if (this.straightClear(ax, ay, ax, by) && this.straightClear(ax, by, bx, by)) {
      return [from, elbowV, to];
    }
    return null;
  },

  // Sum of Euclidean segment lengths across a waypoint list — for
  // axis-aligned legs this equals each leg's tile count, so it plays the
  // same role landLine's path.length used to for the RAILROAD_MAX_TILES cap.
  pathLength(waypoints) {
    let len = 0;
    for (let i = 0; i + 1 < waypoints.length; i++) {
      len += Math.sqrt(this.tileDistSq(waypoints[i], waypoints[i + 1]));
    }
    return len;
  },

  // Shortest hop path of station TILES from `fromTile` to `toTile` over the
  // full rail graph — unlike stationHopDistance this has no cap, since a
  // train has to reach wherever its destination actually is. Plays the role
  // of PathFinding.Stations at this game's scale (a handful of stations per
  // empire, not the thousands OpenFront's real maps can carry).
  findStationPath(fromTile, toTile) {
    if (fromTile === toTile) return [fromTile];
    const cameFrom = new Map([[fromTile, -1]]);
    const queue = [fromTile];
    let head = 0;
    while (head < queue.length) {
      const t = queue[head++];
      const b = this.buildings.get(t);
      if (!b) continue;
      for (const n of b.rails.keys()) {
        if (cameFrom.has(n)) continue;
        cameFrom.set(n, t);
        if (n === toTile) {
          const path = [n];
          let cur = t;
          while (cur !== -1) { path.push(cur); cur = cameFrom.get(cur); }
          path.reverse();
          return path;
        }
        queue.push(n);
      }
    }
    return null;
  },

  // --- Trains ----------------------------------------------------------------
  // trainSpawnRate/trainGold ported verbatim from Config.ts — neither is
  // scaled by POP_SCALE, matching GOLD_PER_SEC's own comment that gold prices
  // have no such constraint. TRAIN_SPEED follows the same conversion
  // BOAT_SPEED already documents: OpenFront moves a train 2 tiles per tick
  // (TrainExecution's own `speed = 2`) at their 10-ticks/sec, i.e. 20
  // tiles/sec — a straight port, not a re-tuned dial.
  TRAIN_SPEED: 20,
  TRAIN_SPAWN_COOLDOWN: 1,        // seconds; ticksCooldown=10 @ 10 ticks/sec
  // Config.ts's trainGold baseGold per relation. Real source also has a
  // "team" tier (25000, same as "other") but this game has no team system,
  // only alliance — see tradeRel. Note "self" pays the LEAST: OpenFront
  // deliberately rewards trading across borders more than trading with your
  // own cities, which is what makes bots' trains actually go somewhere
  // interesting instead of only ever shuttling gold to themselves.
  TRAIN_GOLD_SELF_BASE: 10000,
  TRAIN_GOLD_OTHER_BASE: 25000,
  TRAIN_GOLD_ALLY_BASE: 35000,
  TRAIN_GOLD_FREE_STOPS: 9,
  TRAIN_GOLD_DIST_PENALTY: 5000,
  TRAIN_GOLD_FLOOR: 5000,

  // Config.ts's trainSpawnRate: hyperbolic decay, midpoint at 10 factories.
  // Returned as a 1-in-N chance, consumed by updateFactoryStations below.
  trainSpawnRate(numFactories) {
    return (numFactories + 10) * 15;
  },

  // PlayerImpl.canTrade, minus the embargo check (not ported — this game has
  // no embargo mechanic) — so trade is open with everyone by default,
  // including active enemies, exactly like the real game's default state.
  // Only alliance bumps the rate; there's no "team" tier here (no team
  // system), so it collapses OpenFront's four-way self/team/ally/other split
  // into three.
  tradeRel(a, b) {
    if (a === b) return 'self';
    return this.areAllied(a, b) ? 'ally' : 'other';
  },

  // Config.ts's trainGold. No penalty for the first 9 stops on a trip; each
  // one after costs 5000, floored at 5000. `stopsVisited` is the count
  // BEFORE this stop, matching TradeStationStopHandler reading
  // tradeStopsVisited() before stationReached() increments it — see
  // stepTrains.
  trainGold(stopsVisited, rel) {
    const base = rel === 'ally' ? this.TRAIN_GOLD_ALLY_BASE
      : rel === 'self' ? this.TRAIN_GOLD_SELF_BASE
      : this.TRAIN_GOLD_OTHER_BASE;
    const penalty = Math.max(0, stopsVisited - this.TRAIN_GOLD_FREE_STOPS) * this.TRAIN_GOLD_DIST_PENALTY;
    return Math.max(this.TRAIN_GOLD_FLOOR, base - penalty);
  },

  // unitCount(UnitType.Factory) — a built headcount, not the sum-of-levels
  // unitsOwned uses for cost/pop, since a level-3 factory should spawn like
  // one factory feeding three rolls (see updateFactoryStations' `b.level`
  // loop), not count as three factories toward the spawn-rate denominator.
  factoryCount(p) {
    let n = 0;
    for (const b of this.buildings.values()) {
      if (b.type === 'factory' && b.built && GameMap.owner[b.tile] === p.id) n++;
    }
    return n;
  },

  // Cluster.hasAnyTradeDestination + randomTradeDestination collapsed into
  // one reservoir-sampling BFS: walk the rail graph from `station` and
  // sample among reachable City OR Port stations (TradeStationStopHandler
  // covers both in the real source — see stepTrains) of ANY owner — own,
  // allied, or enemy alike, matching tradeAvailable's default-open (no
  // embargo ported) behavior. This is what makes a bot's factory route
  // trains to a human player's cities/ports (and vice versa) whenever rails
  // happen to connect them, not just its own. Live ownership, not whoever
  // owned a station when the rail was laid, is why a captured factory can
  // immediately start trading with its new owner's other stations over
  // rails an old regime built.
  pickTrainDestination(station) {
    const visited = new Set([station.tile]);
    let frontier = [station.tile];
    let chosen = null, seen = 0;
    while (frontier.length) {
      const next = [];
      for (const t of frontier) {
        const b = this.buildings.get(t);
        if (!b) continue;
        for (const n of b.rails.keys()) {
          if (visited.has(n)) continue;
          visited.add(n);
          next.push(n);
          const nb = this.buildings.get(n);
          if (nb && (nb.type === 'city' || nb.type === 'port')) {
            seen++;
            if (this.rng() * seen < 1) chosen = nb;
          }
        }
      }
      frontier = next;
    }
    return chosen;
  },

  // Expands a station-hop path into the FULL waypoint list a train actually
  // travels — each hop's small elbow path (station, optional bend, station;
  // see connectStations) concatenated end to end, skipping each segment's
  // repeated leading tile — plus `cum`, the cumulative straight-line
  // distance at every waypoint including the elbow bends, and `stops`, the
  // cumulative distance recorded only at each intermediate/final STATION for
  // stepTrains' arrival check (a bend is geometry, not a place a train stops
  // or earns anything). Distance rather than a per-tile array index is what
  // lets a train travel (and Render draw it, via trainTilePos) along the
  // real orthogonal legs instead of snapping tile-to-tile.
  buildTrainRoute(stationTiles) {
    const waypoints = [stationTiles[0]];
    const cum = [0];
    const stops = [];
    for (let i = 0; i + 1 < stationTiles.length; i++) {
      const from = this.buildings.get(stationTiles[i]);
      const seg = from.rails.get(stationTiles[i + 1]);
      if (!seg) return null;
      // seg[0] === stationTiles[i], already the last waypoint pushed.
      for (let k = 1; k < seg.length; k++) {
        cum.push(cum[cum.length - 1] + Math.sqrt(this.tileDistSq(waypoints[waypoints.length - 1], seg[k])));
        waypoints.push(seg[k]);
      }
      stops.push({ dist: cum[cum.length - 1], tile: stationTiles[i + 1] });
    }
    return { waypoints, cum, stops };
  },

  // Continuous tile-space position of a train along its route, for Render to
  // project onto the screen — walking `cum` to find which straight leg
  // `pos` currently falls in, rather than indexing a discrete per-tile
  // path, so the dot glides smoothly along the real horizontal/vertical
  // segments (and pivots cleanly at each elbow) drawRailroads renders.
  trainTilePos(t) {
    const w = GameMap.width, cum = t.cum, wp = t.waypoints;
    let i = 0;
    while (i < cum.length - 2 && t.pos >= cum[i + 1]) i++;
    const segLen = cum[i + 1] - cum[i];
    const frac = segLen > 0 ? Math.min(1, (t.pos - cum[i]) / segLen) : 1;
    const a = wp[i], b = wp[i + 1];
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    return { x: ax + (bx - ax) * frac, y: ay + (by - ay) * frac };
  },

  spawnTrain(station, destStation, ownerId) {
    const stationTiles = this.findStationPath(station.tile, destStation.tile);
    if (!stationTiles || stationTiles.length < 2) return false;
    const route = this.buildTrainRoute(stationTiles);
    if (!route) return false;
    this.trains.push({
      id: this.nextTrainId++, owner: ownerId,
      waypoints: route.waypoints, cum: route.cum, stops: route.stops,
      pos: 0, nextStop: 0, stopsVisited: 0
    });
    return true;
  },

  // TrainStationExecution.tick, run for every built factory station every
  // tick. Only rolls once the cooldown since its last train has elapsed,
  // then retries every tick after that until a roll lands — matching their
  // own "lastSpawnTick + ticksCooldown" gate followed by an unconditional
  // per-tick shouldSpawnTrain() call. The destination is picked BEFORE
  // rolling (hasAnyTradeDestination is checked first in the real source too)
  // so an empire with nowhere to trade never burns a roll on it.
  updateFactoryStations() {
    for (const b of this.buildings.values()) {
      if (b.type !== 'factory' || !b.station) continue;
      if (this.elapsed - b.lastTrainAt < this.TRAIN_SPAWN_COOLDOWN) continue;
      const owner = GameMap.owner[b.tile];
      const p = this.players[owner];
      if (!p || !p.alive) continue;

      const dest = this.pickTrainDestination(b);
      if (!dest) continue;

      const spawnRate = this.trainSpawnRate(this.factoryCount(p));
      let roll = false;
      for (let i = 0; i < b.level; i++) {
        if (this.rng() < 1 / spawnRate) { roll = true; break; }
      }
      if (!roll) continue;

      if (this.spawnTrain(b, dest, owner)) b.lastTrainAt = this.elapsed;
    }
  },

  // TrainExecution.tick's per-tick advance, folded together with
  // stationReached/TradeStationStopHandler — every stop the train's `pos`
  // crosses this tick pays out (or not) in the same pass, so a train moving
  // fast enough to cross two close-together stations in one tick still pays
  // both instead of only the one nearest the end of the step.
  stepTrains() {
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i];
      t.pos += this.TRAIN_SPEED * this.TICK_DT;

      while (t.nextStop < t.stops.length && t.pos >= t.stops[t.nextStop].dist) {
        const stop = t.stops[t.nextStop++];
        const b = this.buildings.get(stop.tile);
        // FactoryStopHandler is a no-op in the real source — only City and
        // Port use TradeStationStopHandler and actually pay out. Station
        // owner is read live at arrival, not whoever owned it when the train
        // departed (same capture-friendly rule as pickTrainDestination).
        if (b && (b.type === 'city' || b.type === 'port')) {
          const stationOwnerId = GameMap.owner[stop.tile];
          const rel = this.tradeRel(t.owner, stationOwnerId);
          const gold = this.trainGold(t.stopsVisited, rel);
          // TradeStationStopHandler: the train's own player always earns the
          // trip's gold, and if the station belongs to someone else, THEY
          // separately earn the same amount — a real two-way payout, not a
          // toll, which is why a foreign train rolling through your city is
          // a good thing for you.
          const trainP = this.players[t.owner];
          if (trainP) trainP.gold += gold;
          if (stationOwnerId !== t.owner) {
            const stationP = this.players[stationOwnerId];
            if (stationP) stationP.gold += gold;
          }
          t.stopsVisited++;
          // Recorded for every station owner alike, whoever they are. The
          // renderer shows the local viewer only their own payouts (a payout
          // at a foreign or allied city isn't the player's money to watch tick
          // up) — but that filter belongs at draw time, not here: a sim branch
          // on Game.me would make this line compute differently on every
          // client. See js/fx.js.
          Fx.goldPopup(stop.tile, gold, stationOwnerId);
        }
      }

      if (t.nextStop >= t.stops.length) this.trains.splice(i, 1);
    }
  },

  // --- Ports & trade ships ----------------------------------------------------
  // Ported against OpenFront's actual PortExecution / TradeShipExecution /
  // Config.ts source (github.com/openfrontio/OpenFrontIO), not guessed.
  // A Port is placed on the coast (buildBlockReason) and, once built, rolls
  // every PORT_TRADE_CHECK_INTERVAL for a trade ship to another player's
  // Port — matching PortExecution's own "only check every 10 ticks" gate at
  // this game's 10 ticks/sec. A spawned ship sails the real weighted A*
  // water route (seaPath, the same pathfinder invasion boats use) to its
  // chosen destination and pays BOTH ports' owners on arrival — see
  // stepTradeShips' complete-equivalent branch.
  //
  // Deliberate scope cuts, noted where they happen:
  //  - tradingPorts() drops the real source's "water component" pre-filter
  //    (a cheap flood-fill labelling used purely to skip candidates on an
  //    unreachable sea before even trying to path to them) since this game
  //    has no such labelling built for water tiles. updatePortTrade does the
  //    equivalent check the honest way instead — a real seaPath call at
  //    spawn time — which is slower per-candidate but exactly as correct,
  //    and only runs once per successful spawn roll rather than continuously.
  //  - The captured-trade-ship redirect (TradeShipExecution's wasCaptured
  //    branch, re-targeting the ship's new owner's nearest tradeable Port) IS
  //    ported — see warshipChaseTradeShip's capture branch and
  //    nearestOwnedPortRoute below in the Warships section. The other
  //    capture case — one Port capturing the other mid-crossing, collapsing
  //    the trip into "trading with yourself" — is still handled too,
  //    matching the real early-return for it.
  //  - goldMultiplierFor (host-cheats / lobby-creator gold multiplier) has no
  //    counterpart here, so tradeShipGold omits it entirely rather than
  //    hardcoding a multiplier of 1 for a system that doesn't exist.

  // Config.ts's tradeShipShortRangeDebuff() — trading with a Port under this
  // many tiles away earns sharply less (see tradeShipGold's sigmoid), and
  // tradingPorts' proximity/ally bonus weighting explicitly skips it too.
  TRADE_SHIP_SHORT_RANGE_DEBUFF: 300,
  // How often (seconds) each built Port re-checks whether to spawn a trade
  // ship — PortExecution's own "(ticks + offset) % 10 !== 0" collapses to a
  // flat 1-second cadence at this game's fixed 10 ticks/sec, so the random
  // per-port offset that avoids every Port rolling on the same tick in their
  // variable-rate engine isn't needed here.
  PORT_TRADE_CHECK_INTERVAL: 1,
  // Config.ts's tradeShipSpawnRate: baseSpawnRate's sigmoid midpoint (500
  // trade ships on the whole map = 50% of the real per-roll odds) and decay
  // rate, both lifted verbatim.
  TRADE_SHIP_SPAWN_MIDPOINT: 400,
  TRADE_SHIP_SPAWN_DECAY: Math.LN2 / 50,

  manhattanDist(a, b) {
    const w = GameMap.width;
    const ax = a % w, ay = (a / w) | 0, bx = b % w, by = (b / w) | 0;
    return Math.abs(ax - bx) + Math.abs(ay - by);
  },

  // Config.ts's tradeShipSpawnRate verbatim: returned as a 1-in-N chance.
  // baseSpawnRate falls toward 0 as the map's total trade-ship count climbs
  // (throttling runaway spawning once trade is already busy), and the
  // "pity timer" rejectionModifier raises the odds after each consecutive
  // miss so a quiet Port doesn't go dry forever.
  tradeShipSpawnRate(rejections, numTradeShips) {
    const baseSpawnRate = 1 - this.sigmoid(numTradeShips, this.TRADE_SHIP_SPAWN_DECAY, this.TRADE_SHIP_SPAWN_MIDPOINT);
    const rejectionModifier = 1 / (rejections + 1);
    return Math.floor((100 * rejectionModifier) / baseSpawnRate);
  },

  // Config.ts's tradeShipGold: a sigmoid climbing from a small base near 0
  // distance up toward a ~75k plateau, plus a flat 50-gold-per-tile term on
  // top — concave at first, a sharp S through the mid-range, effectively
  // linear beyond it. `dist` is the real sea route length in tiles (the
  // trade ship's path.length - 1), same measure OpenFront's own
  // tilesTraveled counts. goldMultiplierFor is not ported — see class
  // comment.
  tradeShipGold(dist) {
    const debuff = this.TRADE_SHIP_SHORT_RANGE_DEBUFF;
    return Math.floor(75000 / (1 + this.det.exp(-0.03 * (dist - debuff))) + 50 * dist);
  },

  // Config.ts's proximityBonusPortsNb: how many of the nearest candidate
  // Ports (once sorted by distance in tradingPorts) get the extra proximity
  // weight — a third of the total, floored at 4, never more than there are
  // candidates to begin with.
  proximityBonusPortsNb(totalPorts) {
    return Math.min(totalPorts, Math.max(4, Math.round(totalPorts / 3)));
  },

  // PortExecution.tradingPorts: every other living player's built Port,
  // weighted into a flat array so a plain random index pick over it
  // reproduces the real probability distribution — a Port appears once per
  // level (a bigger Port is a bigger trade partner), a second time if it's
  // one of the closer candidates (proximityBonusPortsNb) or allied, but
  // never for either bonus if it's under the short-range debuff distance
  // (matching the real source's `!tooClose` guard on both bonuses).
  tradingPorts(port) {
    const ownerId = GameMap.owner[port.tile];
    const candidates = [];
    for (const b of this.buildings.values()) {
      if (b.type !== 'port' || !b.built || b === port) continue;
      const oid = GameMap.owner[b.tile];
      if (oid < 0 || oid === ownerId) continue;
      const op = this.players[oid];
      if (!op || !op.alive) continue;
      candidates.push(b);
    }
    candidates.sort((a, c) => this.manhattanDist(port.tile, a.tile) - this.manhattanDist(port.tile, c.tile));

    const bonusCount = this.proximityBonusPortsNb(candidates.length);
    const weighted = [];
    for (let i = 0; i < candidates.length; i++) {
      const other = candidates[i];
      const expanded = new Array(other.level).fill(other);
      weighted.push(...expanded);
      const tooClose = this.manhattanDist(port.tile, other.tile) < this.TRADE_SHIP_SHORT_RANGE_DEBUFF;
      if (!tooClose && i < bonusCount) weighted.push(...expanded);
      if (!tooClose && this.areAllied(ownerId, GameMap.owner[other.tile])) weighted.push(...expanded);
    }
    return weighted;
  },

  // PortExecution.shouldSpawnTradeShip: one roll per level, first success
  // wins and resets the pity counter; every miss (whether or not the Port
  // gets a hit on a later level this same call) increments it for next time.
  shouldSpawnTradeShip(b) {
    const numTradeShips = this.tradeShips.length;
    for (let i = 0; i < b.level; i++) {
      const spawnRate = this.tradeShipSpawnRate(b.tradeRejections, numTradeShips);
      if (this.rng() < 1 / spawnRate) {
        b.tradeRejections = 0;
        return true;
      }
      b.tradeRejections++;
    }
    return false;
  },

  // Rolls every built Port for a fresh trade ship. On a hit, picks a
  // weighted destination (tradingPorts) and only actually commits once a
  // real sea route to it exists — see the class comment on why that replaces
  // the real source's water-component pre-filter. A few attempts guard
  // against one unlucky pick (an allied bonus entry, say, whose sea lane
  // happens to be blocked) wasting an entire successful roll.
  updatePortTrade() {
    for (const b of this.buildings.values()) {
      if (b.type !== 'port' || !b.built) continue;
      if (this.elapsed - b.lastTradeCheckAt < this.PORT_TRADE_CHECK_INTERVAL) continue;
      b.lastTradeCheckAt = this.elapsed;

      const owner = GameMap.owner[b.tile];
      const p = this.players[owner];
      if (!p || !p.alive) continue;

      if (!this.shouldSpawnTradeShip(b)) continue;

      const candidates = this.tradingPorts(b);
      if (candidates.length === 0) continue;

      for (let attempt = 0; attempt < 3; attempt++) {
        const dest = candidates[Math.floor(this.rng() * candidates.length)];
        const path = this.seaPath([b.tile], dest.tile);
        if (path) {
          this.tradeShips.push({ owner, srcPort: b.tile, dstPort: dest.tile, path, pos: 0 });
          break;
        }
      }
    }
  },

  // Advances every trade ship along its sea route; arrival pays both ports'
  // (current) owners the same amount each — TradeShipExecution.complete's
  // real two-way payout, not a split, exactly like a train reaching a City
  // (see stepTrains). Re-checked every tick rather than only at spawn: if
  // one Port captures the other mid-crossing the trip becomes "trading with
  // yourself" and is cancelled without a payout, matching the real source's
  // early-return for that exact case (see class comment on what isn't
  // ported alongside it).
  stepTradeShips() {
    for (let i = this.tradeShips.length - 1; i >= 0; i--) {
      const s = this.tradeShips[i];
      if (GameMap.owner[s.srcPort] === GameMap.owner[s.dstPort]) {
        this.tradeShips.splice(i, 1);
        continue;
      }

      s.pos += this.BOAT_SPEED * this.TICK_DT;
      if (s.pos < s.path.length - 1) continue;

      const srcP = this.players[GameMap.owner[s.srcPort]];
      const dstP = this.players[GameMap.owner[s.dstPort]];
      const gold = this.tradeShipGold(s.path.length - 1);
      // Recorded for both ports' owners unconditionally; the renderer filters
      // to the local viewer — see stepTrains' identical note and js/fx.js.
      if (srcP) {
        srcP.gold += gold;
        Fx.goldPopup(s.srcPort, gold, GameMap.owner[s.srcPort]);
      }
      if (dstP) {
        dstP.gold += gold;
        Fx.goldPopup(s.dstPort, gold, GameMap.owner[s.dstPort]);
      }

      this.tradeShips.splice(i, 1);
    }
  },

  // --- Warships ----------------------------------------------------------
  // Ported against OpenFront's actual WarshipExecution/MoveWarshipExecution/
  // ShellExecution source (github.com/openfrontio/OpenFrontIO), not guessed
  // — see feedback-openfront-source-porting memory for the fetch approach.
  // Deliberately narrowed scope, matching how every other structure in this
  // file was ported (see the UNITS/rail-network comments above): no
  // port-docking/repair retreat, no passive healing, no veterancy. A
  // Warship spawns at full health, fights until it sinks, and is gone —
  // simpler than the real source's health-management state machine, and not
  // something the user asked for. Everything actually requested — visual
  // presence, stealing unfriendly trade ships, shooting down invasion boats,
  // shift-drag select + click-to-relocate, patrolling an assigned area,
  // health, and warship-vs-warship combat — is ported for real. Purchase
  // placement itself is a deliberate, explicit divergence from OpenFront
  // (whose own Warship is territory-bound like any other structure, no Port
  // required) — see resolveWarshipLaunch's own comment.
  //
  // Movement reuses seaPath (the same weighted A* boats/trade ships already
  // use) rather than a new pathfinder: seaPath's sourceTiles/targetTile
  // arguments only ever need each endpoint's own water neighbours, which
  // works identically whether the endpoint is a coastal land tile (boats)
  // or open water (a warship roaming free) — see its own comment. A warship
  // is stored the same shape a boat/trade ship already is — {path, pos} — so
  // Game.pathPos below reads all three uniformly.
  WARSHIP_MAX_HEALTH: 1000,               // Config.ts UnitType.Warship.maxHealth
  WARSHIP_TARGET_RANGE: 130,              // warshipTargettingRange() — engagement/detection radius
  WARSHIP_PATROL_RANGE: 100,              // warshipPatrolRange() — wander radius around patrolTile
  WARSHIP_SHELL_COOLDOWN: 2,              // warshipShellAttackRate()=20 ticks @ 10 ticks/sec
  // No OpenFront equivalent — its ShellExecution resolves damage the instant
  // it fires. Slowed well below the "one shell in flight" pace (130/75≈1.73s)
  // so shells read as a travel-time projectile rather than a fast hit-scan;
  // a target can now have more than one shell in flight toward it at once.
  WARSHIP_SHELL_SPEED: 25,
  WARSHIP_CAPTURE_DIST: 5,                // huntDownTradeShip's manhattan capture distance
  // BOAT_SPEED's own comment: 10 ticks/sec, 1 tile/tick is the ported rate
  // for every ship type in this file, warships included — OpenFront has no
  // separate, slower warshipSpeed of its own.
  WARSHIP_SPEED: 10,
  // No OpenFront equivalent. A trade ship also moves at BOAT_SPEED === 10,
  // so a warship at plain WARSHIP_SPEED can only ever match it tile-for-tile
  // — any route that isn't perfectly direct (coastline detour, chase
  // starting off-axis) means it never actually closes the gap and follows
  // forever. Applied only in warshipChaseTradeShip, not patrol, so patrol
  // wandering keeps its original pace.
  WARSHIP_CHASE_SPEED_MULT: 1.5,
  WARSHIP_REPATH_INTERVAL: 5,             // seconds between patrol-wander waypoint picks
  WARSHIP_CHASE_REPATH: 1.5,              // seconds between trade-ship-chase path refreshes
  WARSHIP_SNAP_MAX_DIST: 8,               // AI.warshipSite's own coast-to-water snap distance
  MAX_WARSHIPS_PER_PLAYER: 6,             // keeps per-tick seaPath calls (patrol/chase) bounded

  // Float tile-space position of anything shaped like a boat/trade ship/
  // warship — {path: [tile,...], pos: float index along it} — interpolating
  // between the two path tiles straddling `pos`. Same technique render.js's
  // drawBoats/drawTradeShips already use inline for their pixel position;
  // this is the game-logic (range-check) equivalent, shared by all three.
  pathPos(entity) {
    const path = entity.path, w = GameMap.width;
    const idx = Math.min(path.length - 1, Math.floor(entity.pos));
    const frac = Math.min(1, entity.pos - idx);
    const a = path[idx], c = path[Math.min(idx + 1, path.length - 1)];
    const ax = a % w, ay = (a / w) | 0, cx = c % w, cy = (c / w) | 0;
    return { x: ax + (cx - ax) * frac, y: ay + (cy - ay) * frac };
  },

  // Terrain-agnostic BFS from `fromTile` out to the nearest actual WATER
  // tile — no ownership requirement, unlike nearestOwnedCoastNear/Port's own
  // coast snap, since a warship's destination can be anywhere at sea, not
  // just water touching the player's own territory. A click already on
  // water returns unchanged. Reuses NEAREST_COAST_MAX_DIST as the search cap
  // — the same "a target snapping a good distance to the nearest usable spot
  // still makes sense" reasoning that constant's own comment already gives
  // for the boat-landing-tile case.
  nearestWaterNear(fromTile, maxDist) {
    if (fromTile < 0) return -1;
    if (GameMap.owner[fromTile] === WATER) return fromTile;
    const w = GameMap.width;
    const tx = fromTile % w, ty = (fromTile / w) | 0;
    const seen = new Set([fromTile]);
    const queue = [fromTile];
    const nb = new Int32Array(4);
    let head = 0, best = -1, bestDist = Infinity;
    while (head < queue.length) {
      const i = queue[head++];
      const ix = i % w, iy = (i / w) | 0;
      const dist = Math.abs(ix - tx) + Math.abs(iy - ty);
      if (dist < bestDist && GameMap.owner[i] === WATER) { best = i; bestDist = dist; }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // Same terrain-agnostic BFS shape as nearestWaterNear, but hunting for a
  // WATER tile that touches the player's own coastline specifically — used
  // only by AI.warshipSite to pick a sensible coastal patrol destination for
  // a bot, not by the player-facing purchase flow any more (see
  // resolveWarshipLaunch below: a player click can land anywhere).
  nearestOwnedWaterNear(playerId, fromTile, maxDist) {
    if (fromTile < 0) return -1;
    const w = GameMap.width;
    const nb = new Int32Array(4);
    const touchesOwnCoast = (i) => {
      if (GameMap.owner[i] !== WATER) return false;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] === playerId && GameMap.isLand(nb[k])) return true;
      return false;
    };
    if (touchesOwnCoast(fromTile)) return fromTile;
    const tx = fromTile % w, ty = (fromTile / w) | 0;
    const seen = new Set([fromTile]);
    const queue = [fromTile];
    let head = 0, best = -1, bestDist = Infinity;
    while (head < queue.length) {
      const i = queue[head++];
      const ix = i % w, iy = (i / w) | 0;
      const dist = Math.abs(ix - tx) + Math.abs(iy - ty);
      if (dist < bestDist && touchesOwnCoast(i)) { best = i; bestDist = dist; }
      if (dist >= maxDist) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (!seen.has(j)) { seen.add(j); queue.push(j); }
      }
    }
    return best;
  },

  // How many of a player's own Ports (nearest-first, by straight-line
  // distance to the destination — the same cheap metric OpenFront's own
  // WarshipExecution.findNearestPort uses) to try a real seaPath from before
  // giving up on a launch order. More than one matters because the single
  // nearest Port in a straight line can sit on a different, landlocked body
  // of water from the clicked destination.
  WARSHIP_LAUNCH_PORT_ATTEMPTS: 4,

  // Resolves what a Warship purchase click actually means: which of the
  // player's own Ports it launches from, and the route it sails to get to
  // wherever was clicked — explicit user design request (2026-08-19): "you
  // should not have to click on the coast," a Warship "can only be
  // purchased if a port exists, period," and it "should spawn from the
  // nearest available port that you own" and "pathfind to the location that
  // you click on." Not an OpenFront port — their own Warship placement is
  // territory-bound like every other structure, with no Port requirement —
  // this is a deliberate divergence, same category as the Fort-capture-
  // destroys-outright change noted elsewhere in project memory.
  //
  // Returns { ok:false, reason } or { ok:true, port, dest, path }. Shared by
  // warshipBlockReason (a dry run for the UI) and buildWarship (which
  // re-runs it rather than threading the result through, matching how
  // canBuild/build already double up on buildBlockReason elsewhere in this
  // file — a single discrete click is cheap enough to check twice).
  resolveWarshipLaunch(playerId, clickTile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return { ok: false, reason: 'Nation defeated' };

    const ports = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'port' && b.built && GameMap.owner[b.tile] === playerId) ports.push(b);
    }
    if (ports.length === 0) return { ok: false, reason: 'Build a Port first' };

    if (this.warships.filter(w => w.owner === playerId).length >= this.MAX_WARSHIPS_PER_PLAYER) {
      return { ok: false, reason: 'Warship limit reached' };
    }
    if (p.gold < this.unitCost(p, 'warship')) return { ok: false, reason: 'Not enough gold' };

    const dest = this.nearestWaterNear(clickTile, this.NEAREST_COAST_MAX_DIST);
    if (dest < 0) return { ok: false, reason: 'No open water there' };

    ports.sort((a, c) => this.tileDistSq(a.tile, dest) - this.tileDistSq(c.tile, dest));
    for (let i = 0; i < Math.min(ports.length, this.WARSHIP_LAUNCH_PORT_ATTEMPTS); i++) {
      const path = this.seaPath([ports[i].tile], dest);
      if (path) return { ok: true, port: ports[i], dest, path };
    }
    return { ok: false, reason: 'No sea route there' };
  },

  // Finds `playerId`'s own nearest built Port reachable by sea from
  // `fromTile` — same nearest-first-then-verify-with-seaPath approach as
  // resolveWarshipLaunch just above, reused here for TradeShipExecution's
  // wasCaptured redirect (see warshipChaseTradeShip): a freshly captured
  // trade ship reroutes to the capturing player's own nearest tradeable Port
  // instead of finishing its old voyage to an enemy/neutral one. Returns
  // null if that player owns no Port, or none of the nearest few connect by
  // sea from here.
  nearestOwnedPortRoute(playerId, fromTile) {
    const ports = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'port' && b.built && GameMap.owner[b.tile] === playerId) ports.push(b);
    }
    if (ports.length === 0) return null;
    ports.sort((a, c) => this.tileDistSq(a.tile, fromTile) - this.tileDistSq(c.tile, fromTile));
    for (let i = 0; i < Math.min(ports.length, this.WARSHIP_LAUNCH_PORT_ATTEMPTS); i++) {
      const path = this.seaPath([fromTile], ports[i].tile);
      if (path) return { port: ports[i], path };
    }
    return null;
  },

  // Why a Warship purchase click can't be carried out, for the UI to say out
  // loud — same null-or-reason shape as buildBlockReason.
  warshipBlockReason(playerId, clickTile) {
    return this.resolveWarshipLaunch(playerId, clickTile).reason || null;
  },

  canBuildWarship(playerId, clickTile) { return !this.warshipBlockReason(playerId, clickTile); },

  // Spawns instantly (see the UNITS comment on why buildTime isn't read
  // here) at full health, right at whichever owned Port resolveWarshipLaunch
  // picked, immediately sailing the resolved route out to the clicked
  // destination — which becomes its patrol center the moment it arrives,
  // exactly like a player-issued moveWarships relocation (see warshipPatrol).
  buildWarship(playerId, clickTile) {
    const r = this.resolveWarshipLaunch(playerId, clickTile);
    if (!r.ok) return false;
    const p = this.players[playerId];
    p.gold -= this.unitCost(p, 'warship');
    p.unitsBuilt.warship = this.unitsBuilt(p, 'warship') + 1;
    p.units.warship = this.unitsOwned(p, 'warship') + 1;
    this.warships.push({
      id: this.nextWarshipId++,
      owner: playerId,
      path: r.path, pos: 0,
      patrolTile: r.dest,
      health: this.WARSHIP_MAX_HEALTH, maxHealth: this.WARSHIP_MAX_HEALTH,
      target: null, targetKind: null,
      lastShellAt: -Infinity, lastPathAt: this.elapsed
    });
    return true;
  },

  // Player-issued relocation (UI's shift-drag select, then a plain click) —
  // MoveWarshipExecution's real job, minus the water-component connectivity
  // check (this game has no such precomputed labelling; a failed seaPath
  // below does the same job for an unreachable body of water). A click that
  // isn't already water snaps to the nearest one, same leniency
  // resolveWarshipLaunch gives a purchase click and for the same reason —
  // the player shouldn't need to land exactly on water pixel-for-pixel.
  // Also becomes the new patrol center once it arrives, exactly like
  // OpenFront's own patrolTile field — see warshipPatrol.
  // `playerId` — whose fleet this order is — defaults to this.me for the
  // existing ui.js call site, for the same reason chooseSpawn's does: the
  // ownership check below is a real rule of the sim, and a rule may not be
  // decided by which client is looking. MP-1.2's Executor passes the actor
  // resolved from the intent's stamped clientID.
  moveWarships(list, clickTile, playerId) {
    const owner = playerId === undefined ? this.me : playerId;
    const tile = this.nearestWaterNear(clickTile, this.NEAREST_COAST_MAX_DIST);
    if (tile < 0) return false;
    let moved = false;
    for (const w of list) {
      if (!this.warships.includes(w) || w.owner !== owner) continue;
      const idx = Math.min(w.path.length - 1, Math.floor(w.pos));
      const curTile = w.path[idx];
      const path = this.seaPath([curTile], tile);
      if (!path) continue;
      w.path = path;
      w.pos = 0;
      w.patrolTile = tile;
      w.lastPathAt = this.elapsed;
      moved = true;
    }
    return moved;
  },

  // Config.ts's ShellExecution.effectOnTarget with baseDamage=250 (so the
  // (roll-1)*25+200 multiplier IS the damage) and the veterancy bonus term
  // dropped — this game has no veterancy system. A 1-6 roll, 200-325 damage.
  warshipShellDamage() {
    const roll = 1 + Math.floor(this.rng() * 6);
    return (roll - 1) * 25 + 200;
  },

  // WarshipExecution.findBestTarget: transport ship (boat) beats warship
  // beats trade ship, nearest of whichever tier wins, "unfriendly" meaning
  // not this warship's own owner and not allied to them (this game has no
  // canAttackPlayer beyond that). Only called when `w` has no target already.
  warshipAcquireTarget(w, pos, rangeSq) {
    let best = null, bestDist = Infinity;
    for (const b of this.boats) {
      if (b.attacker === w.owner || this.areAllied(w.owner, b.attacker)) continue;
      const bp = this.pathPos(b);
      const d = (bp.x - pos.x) ** 2 + (bp.y - pos.y) ** 2;
      if (d <= rangeSq && d < bestDist) { best = b; bestDist = d; }
    }
    if (best) { w.target = best; w.targetKind = 'boat'; return; }

    best = null; bestDist = Infinity;
    for (const ow of this.warships) {
      if (ow === w || ow.owner === w.owner || this.areAllied(w.owner, ow.owner)) continue;
      const op = this.pathPos(ow);
      const d = (op.x - pos.x) ** 2 + (op.y - pos.y) ** 2;
      if (d <= rangeSq && d < bestDist) { best = ow; bestDist = d; }
    }
    if (best) { w.target = best; w.targetKind = 'warship'; return; }

    best = null; bestDist = Infinity;
    for (const s of this.tradeShips) {
      if (s.owner === w.owner || this.areAllied(w.owner, s.owner)) continue;
      const sp = this.pathPos(s);
      const d = (sp.x - pos.x) ** 2 + (sp.y - pos.y) ** 2;
      if (d <= rangeSq && d < bestDist) { best = s; bestDist = d; }
    }
    if (best) { w.target = best; w.targetKind = 'tradeship'; }
  },

  // Priority 1/2 targets (boat, warship): the warship holds its ground and
  // fires on cooldown rather than closing in — matches real WarshipExecution,
  // which never moves toward either, only toward a trade ship (priority 3).
  // Unlike the real ShellExecution (which resolves damage the instant it
  // fires), this spawns a travelling shell (see the "Shells" section below)
  // and defers the actual effect to its impact — render.js draws it as a
  // blinking dot so a kill is visibly earned, not instant. A boat has no
  // health of its own in this game (see the "Naval invasions" section), so
  // its shell simply sinks it outright on arrival, same as a target that
  // "can't be oneshotted" being skipped in the real ShellExecution — there's
  // no partial-damage state to track. A warship target keeps taking shell
  // damage every cooldown until it sinks (stepWarships removes it at 0 hp).
  // w.target/targetKind are left alone here — warshipTick's own validity
  // check next tick (arr.includes + health>0) naturally clears them once the
  // shell actually lands and the target is gone, so there's nothing to do
  // for the firing warship itself until then.
  warshipShootAt(w) {
    if (this.elapsed - w.lastShellAt < this.WARSHIP_SHELL_COOLDOWN) return;
    w.lastShellAt = this.elapsed;
    const from = this.pathPos(w);
    const to = this.pathPos(w.target);
    const dist = this.det.hypot(to.x - from.x, to.y - from.y);
    this.shells.push({
      ownerId: w.owner,
      from, to,
      born: this.elapsed,
      duration: Math.max(0.15, dist / this.WARSHIP_SHELL_SPEED),
      targetKind: w.targetKind,
      target: w.target,
      damage: w.targetKind === 'warship' ? this.warshipShellDamage() : null
    });
  },

  // Priority 3 (huntDownTradeShip): the only target type a warship actually
  // chases. Repathed on a cooldown rather than every tick — a full seaPath
  // call per warship per tick would be far too expensive with a real fleet
  // in play (see the class comment on why patrol wandering does the same).
  // "Capture" is OpenFront's real PlayerImpl.captureUnit plus
  // TradeShipExecution's wasCaptured branch: unit.setOwner(this) — the trade
  // ship now flies the capturing player's colours (see render.js's
  // drawTradeShips, which colours strictly off `ship.owner`) — and then
  // reroutes to the capturing player's own nearest tradeable Port
  // (nearestOwnedPortRoute) instead of finishing its old voyage, so the
  // payout on arrival (stepTradeShips) lands with its new owner rather than
  // whoever it was originally sailing toward. If that player owns no
  // reachable Port (e.g. captured by a warship whose last Port has since
  // fallen), it just keeps its old route/destination under new colours,
  // same as before this redirect existed.
  warshipChaseTradeShip(w, curTile) {
    const target = w.target;
    const tIdx = Math.min(target.path.length - 1, Math.floor(target.pos));
    const targetTile = target.path[tIdx];
    if (this.manhattanDist(curTile, targetTile) <= this.WARSHIP_CAPTURE_DIST) {
      target.owner = w.owner;
      const route = this.nearestOwnedPortRoute(w.owner, targetTile);
      if (route) {
        target.dstPort = route.port.tile;
        target.path = route.path;
        target.pos = 0;
      }
      w.target = null; w.targetKind = null;
      return;
    }
    if (!w.path || w.pos >= w.path.length - 1 || this.elapsed - w.lastPathAt >= this.WARSHIP_CHASE_REPATH) {
      const path = this.seaPath([curTile], targetTile);
      if (path) { w.path = path; w.pos = 0; }
      w.lastPathAt = this.elapsed;
    }
    w.pos = Math.min(w.path.length - 1, w.pos + this.WARSHIP_SPEED * this.WARSHIP_CHASE_SPEED_MULT * this.TICK_DT);
  },

  // Bounded rejection sample for a water tile within patrol range of
  // `w.patrolTile` — a light version of WarshipExecution.randomTile (which
  // escalates its search radius over hundreds of attempts); missing here
  // just means trying again next WARSHIP_REPATH_INTERVAL, so there's no
  // need for that machinery. Returns -1 on a run of bad luck.
  warshipPickPatrolWaypoint(w) {
    const mw = GameMap.width, mh = GameMap.height;
    const cx = w.patrolTile % mw, cy = (w.patrolTile / mw) | 0;
    const range = this.WARSHIP_PATROL_RANGE;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = cx + Math.floor((this.rng() * 2 - 1) * range);
      const y = cy + Math.floor((this.rng() * 2 - 1) * range);
      if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
      const tile = GameMap.idx(x, y);
      if (GameMap.owner[tile] === WATER) return tile;
    }
    return -1;
  },

  // No target: wander within patrol range of patrolTile, exactly like
  // WarshipExecution.patrol(). Also where a fresh moveWarships() relocation
  // order actually plays out — that just seeds w.path/patrolTile directly,
  // so once it arrives this same "arrived → pick a new nearby waypoint"
  // logic takes over from the new center with no special-casing needed.
  warshipPatrol(w, curTile) {
    const arrived = !w.path || w.pos >= w.path.length - 1;
    if (arrived) {
      if (this.elapsed - w.lastPathAt >= this.WARSHIP_REPATH_INTERVAL) {
        const dest = this.warshipPickPatrolWaypoint(w);
        if (dest >= 0) {
          const path = this.seaPath([curTile], dest);
          if (path) { w.path = path; w.pos = 0; }
        }
        w.lastPathAt = this.elapsed;
      }
      return;
    }
    w.pos = Math.min(w.path.length - 1, w.pos + this.WARSHIP_SPEED * this.TICK_DT);
  },

  // Revalidates (and, if empty, re-acquires) a target every tick, then hands
  // off to combat/chase/patrol — see WarshipExecution.tick's own priority
  // chain (transport ship > warship > trade ship > patrol), reproduced here.
  warshipTick(w) {
    const idx = Math.min(w.path.length - 1, Math.floor(w.pos));
    const curTile = w.path[idx];
    const pos = this.pathPos(w);
    const rangeSq = this.WARSHIP_TARGET_RANGE * this.WARSHIP_TARGET_RANGE;

    if (w.target) {
      const kind = w.targetKind;
      const arr = kind === 'boat' ? this.boats : kind === 'warship' ? this.warships : this.tradeShips;
      let ok = arr.includes(w.target) && (kind !== 'warship' || w.target.health > 0);
      if (ok) {
        const tp = this.pathPos(w.target);
        const d = (tp.x - pos.x) ** 2 + (tp.y - pos.y) ** 2;
        const ownerOf = kind === 'boat' ? w.target.attacker : w.target.owner;
        ok = d <= rangeSq && ownerOf !== w.owner && !this.areAllied(w.owner, ownerOf);
      }
      if (!ok) { w.target = null; w.targetKind = null; }
    }

    if (!w.target) this.warshipAcquireTarget(w, pos, rangeSq);

    if (w.targetKind === 'boat' || w.targetKind === 'warship') {
      this.warshipShootAt(w);
      return;
    }
    if (w.targetKind === 'tradeship') {
      this.warshipChaseTradeShip(w, curTile);
      return;
    }
    this.warshipPatrol(w, curTile);
  },

  // Advances every in-flight shell (see warshipShootAt) and resolves impact
  // once its travel time elapses: a boat target is spliced from this.boats
  // outright, a warship target takes the shell's precomputed damage (its own
  // 0-hp sinking is handled by stepWarships below, same as before this
  // deferral existed). Guarded with arr.includes/health>0 since the target
  // may already be gone by the time this shell lands — sunk by a different
  // shell, or (boat) already spent invading — in which case it's just a
  // no-op fizzle. render.js's drawShells reads shell.from/to/born/duration
  // directly to interpolate + blink the projectile; nothing here owns that.
  stepShells() {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      if (this.elapsed - s.born < s.duration) continue;
      if (s.targetKind === 'boat') {
        const bi = this.boats.indexOf(s.target);
        if (bi >= 0) this.boats.splice(bi, 1);
      } else if (s.targetKind === 'warship') {
        if (this.warships.includes(s.target) && s.target.health > 0) {
          s.target.health -= s.damage;
        }
      }
      this.shells.splice(i, 1);
    }
  },

  // Sinks anything at 0 hp (no refund, no port to recall to — see the class
  // comment on what's deliberately not ported), decrementing units.warship
  // so unitCost's price curve reflects the fleet actually still afloat.
  // unitsBuilt is left untouched, same treatment losing a captured structure
  // gets — see the UNITS comment on why it never decrements.
  stepWarships() {
    for (let i = this.warships.length - 1; i >= 0; i--) {
      const w = this.warships[i];
      if (w.health <= 0) {
        this.warships.splice(i, 1);
        const owner = this.players[w.owner];
        if (owner) owner.units.warship = Math.max(0, this.unitsOwned(owner, 'warship') - 1);
        continue;
      }
      this.warshipTick(w);
    }
  },

  // --- Missile Silo & Nukes -----------------------------------------------
  // Ported against OpenFront's real MissileSiloExecution/NukeExecution/
  // Config.ts source (github.com/openfrontio/OpenFrontIO), not guessed — see
  // feedback-openfront-source-porting memory for the fetch approach. Scoped
  // down from the real source the same way every other structure in this
  // file has been (see the UNITS/Warship section comments above), per an
  // explicit user scoping decision this session: only Missile Silo, Atom
  // Bomb, and Hydrogen Bomb are ported here. SAM Launcher (the defensive
  // interceptor) was deferred at the time this comment was first written but
  // has since been added — see the "SAM Launcher & Interceptors" section
  // below, right after stepNukes. MIRV (the multi-warhead mega-nuke) is
  // still deliberately left for a later pass. Alliance-breaking
  // (NukeExecution.maybeBreakAlliances' weighted-tile-count threshold) is
  // also not ported; a nuke strike has no diplomatic side effect here.
  //
  // Purchase/targeting follows the same "click anywhere, launch from the
  // nearest ready structure" UX Warship's resolveWarshipLaunch already
  // established (see that function's own comment) — real OpenFront's own
  // nuke targeting works this way natively (any tile is a valid target,
  // Player.canBuild resolves which Silo actually launches it), so this one
  // needed no divergence note the way Warship's port-requirement did.
  //
  // A nuke is a wholly new entity shape, not reusing the boat/warship/
  // trade-ship {path, pos} convention Game.pathPos reads — a missile flies
  // in a straight line over anything (terrain, water, the map's whole
  // pathfinding graph) rather than following a route, so it only ever needs
  // its fixed from/to endpoints and a travel duration, exactly like a
  // Warship's own shell (see warshipShootAt/stepShells) but slower and far
  // more destructive on arrival.

  // Config.ts's nukeMagnitudes(): inner = guaranteed-destroyed radius, outer
  // = the falling-off "radiating" edge (see nukeBlastTiles). Tile radii,
  // not ticks — no rescaling needed, since MAP_SIZES already ports
  // OpenFront's real map dimensions tile-for-tile (see TRAIN_STATION_MAX_
  // RANGE's own comment making the identical point). MIRV's own magnitude
  // (12/18) isn't carried here — no MIRV in this pass.
  NUKE_MAGNITUDES: {
    atombomb: { inner: 12, outer: 30 },
    hydrogenbomb: { inner: 80, outer: 100 }
  },
  // Config.ts's nukeSpeed(): both bomb types return 10 in their own per-tick
  // scale, which converts to 100 tiles/sec via TICKS_PER_SEC exactly like
  // BOAT_SPEED's own "1 tile/tick" comment. Slowed well below that ported
  // rate so a nuke's flight is visible on screen instead of near-instant,
  // while still reading as dramatically faster than a boat/warship.
  NUKE_SPEED: { atombomb: 45, hydrogenbomb: 45 },
  // Config.ts's SiloCooldown(): 90 ticks, converted through TICKS_PER_SEC.
  SILO_COOLDOWN: 9,
  // No OpenFront equivalent — purely how long the render-only shockwave
  // effect (see detonateNuke's push to nukeBlasts) stays on screen.
  NUKE_BLAST_FX_DURATION: 1.2,

  // Config.ts's nukeDeathFactor with the MIRVWarhead branch dropped (no MIRV
  // in this pass) — the AtomBomb/HydrogenBomb branch is the same formula
  // for both types regardless: 5x the target's current troops, divided by
  // however many owned tiles they have left. Called once per impacted tile
  // in detonateNuke's loop, with `humans`/`tilesLeft` shrinking each
  // iteration, so the same nuke hurts more per-tile against a nation that's
  // already small than one that's still large — verbatim their own
  // diminishing-effect loop.
  nukeDeathFactor(humans, tilesLeft) {
    return (5 * humans) / Math.max(1, tilesLeft);
  },

  // Resolves what a nuke-purchase click actually means: which of the
  // player's own built, off-cooldown Silos launches it, and the target tile
  // (unlike Warship's resolveWarshipLaunch, a nuke's destination is never
  // snapped — any tile, land, water, even a tile the player's own nation
  // holds, is a legal target, matching real OpenFront exactly). Returns
  // { ok:false, reason } or { ok:true, silo, dst }. Shared by
  // nukeBlockReason (a dry run for the UI) and launchNuke.
  resolveNukeLaunch(playerId, nukeType, clickTile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return { ok: false, reason: 'Nation defeated' };
    if (clickTile < 0) return { ok: false, reason: 'Off the map' };

    const silos = [];
    for (const b of this.buildings.values()) {
      if (b.type === 'silo' && b.built && GameMap.owner[b.tile] === playerId) silos.push(b);
    }
    if (silos.length === 0) return { ok: false, reason: 'Build a Missile Silo first' };

    const ready = silos.filter(s => this.elapsed - s.lastLaunchAt >= this.SILO_COOLDOWN);
    if (ready.length === 0) return { ok: false, reason: 'Silo reloading' };

    if (p.gold < this.unitCost(p, nukeType)) return { ok: false, reason: 'Not enough gold' };

    // Nearest ready Silo by straight-line distance — a missile has no route
    // to fail, unlike a Warship's seaPath, so there's nothing to fall back
    // through a second/third candidate for.
    ready.sort((a, c) => this.tileDistSq(a.tile, clickTile) - this.tileDistSq(c.tile, clickTile));
    return { ok: true, silo: ready[0], dst: clickTile };
  },

  nukeBlockReason(playerId, nukeType, clickTile) {
    return this.resolveNukeLaunch(playerId, nukeType, clickTile).reason || null;
  },

  canLaunchNuke(playerId, nukeType, clickTile) { return !this.nukeBlockReason(playerId, nukeType, clickTile); },

  // Spawns instantly (matching SpawnExecution, same as buildWarship) at the
  // resolved Silo's tile, flying a straight line to the clicked destination.
  // Puts the launching Silo on cooldown immediately, exactly like
  // resolveWarshipLaunch's own MissileSilo.launch() call.
  launchNuke(playerId, nukeType, clickTile) {
    const r = this.resolveNukeLaunch(playerId, nukeType, clickTile);
    if (!r.ok) return false;
    const p = this.players[playerId];
    p.gold -= this.unitCost(p, nukeType);
    r.silo.lastLaunchAt = this.elapsed;

    const w = GameMap.width;
    const from = { x: r.silo.tile % w, y: (r.silo.tile / w) | 0 };
    const to = { x: clickTile % w, y: (clickTile / w) | 0 };
    const dist = this.det.hypot(to.x - from.x, to.y - from.y);
    this.nukes.push({
      ownerId: playerId, nukeType,
      src: r.silo.tile, dst: clickTile,
      from, to,
      born: this.elapsed,
      duration: Math.max(0.3, dist / this.NUKE_SPEED[nukeType]),
      // SAMTargetingSystem's targetedBySam flag, ported for stepSAMs (see
      // "SAM Launcher & Interceptors") — set the instant a SAM commits a
      // charge to this nuke, so a second SAM never also claims it.
      targetedBySAM: false
    });
    return true;
  },

  // Debug-panel nuke — fires a nuke straight into this.nukes from an
  // explicit source/destination pair, skipping every resolveNukeLaunch check
  // (Silo built, cooldown, gold). Backs UI's two-click "Debug Nuke"/"Debug
  // H-Bomb" buttons (see ui.js's armDebugNuke/onTap 'debugnuke' branch), but
  // also callable straight from the browser console since Game is a plain
  // top-level const, not module-scoped:
  //   Game.debugNuke('atombomb', 1000, 1234)
  //   Game.debugNuke('hydrogenbomb', 1000, 1234, ownerId)
  // owner defaults to the first living non-tribe bot (so your own SAMs treat
  // it as hostile, same as a real attack) and falls back to the human player
  // if no such bot exists — letting srcTile/dstTile be any two tiles at all (own
  // territory included) is what makes this useful for testing SAM defenses
  // without waiting on a bot to build a Silo and choose to strike.
  debugNuke(nukeType, srcTile, dstTile, ownerId = null) {
    const w = GameMap.width;
    if (ownerId == null) {
      // "Not me" was only ever a stand-in for "not the human" — express it
      // that way so even this debug helper stays independent of which client
      // is viewing, and picks the same owner everywhere.
      ownerId = this.players.findIndex(p => p && p.alive && !p.isTribe && !p.isHuman);
      if (ownerId < 0) ownerId = this.players.findIndex(p => p && p.isHuman);
    }
    if (!this.players[ownerId]) { console.warn('[debugNuke] no such player', ownerId); return false; }

    const from = { x: srcTile % w, y: (srcTile / w) | 0 };
    const to = { x: dstTile % w, y: (dstTile / w) | 0 };
    const dist = this.det.hypot(to.x - from.x, to.y - from.y);
    this.nukes.push({
      ownerId, nukeType,
      src: srcTile, dst: dstTile,
      from, to,
      born: this.elapsed,
      duration: Math.max(0.3, dist / this.NUKE_SPEED[nukeType]),
      targetedBySAM: false
    });
    return true;
  },

  // The "radiating" blast footprint: a flood fill out from the impact tile,
  // solid within the inner radius and a 50/50 coin flip per tile in the band
  // between inner and outer — Config.ts's real rand.chance(2) — so the
  // crater's edge burns outward unevenly instead of stopping in a hard-edged
  // circle. Verbatim NukeExecution.tilesToDestroy's non-waterNukes branch
  // (this game has no waterNukes toggle, so the smooth-irregular-boundary
  // water-nuke branch isn't ported). A tile only joins the set by being
  // reached as a passing neighbour of one already in it, exactly like the
  // real mg.bfs call — the coin flip can sever connectivity and leave an
  // isolated pocket beyond it untouched, which is a faithful reproduction of
  // the real shape, not a bug.
  nukeBlastTiles(dst, magnitude) {
    const inner2 = magnitude.inner * magnitude.inner;
    const outer2 = magnitude.outer * magnitude.outer;
    const result = new Set([dst]);
    const queue = [dst];
    const nb = new Int32Array(4);
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (result.has(j)) continue;
        const d2 = this.tileDistSq(dst, j);
        if (d2 > outer2) continue;
        if (d2 > inner2 && this.rng() >= 0.5) continue;
        result.add(j);
        queue.push(j);
      }
    }
    return result;
  },

  // Ported against NukeExecution.detonate(). Order matters: buildings are
  // destroyed FIRST, reading ownership straight off GameMap.owner before
  // anything below overwrites it; then tiles are unclaimed and irradiated —
  // the "radiating land" the user asked for, which turned out to mean
  // OpenFront's real fallout mechanic, not a literal water crater: the land
  // survives, unowned, and stays fully capturable — just brutally expensive
  // to retake until someone actually does (see falloutDefenseModifier); then
  // troop losses are applied using the POST-irradiation tile counts
  // (tilesBeforeNuke = numTilesOwned() + numImpactedTiles, verbatim their
  // own detonate()); then finally anything afloat within the full outer-
  // radius circle sinks — a stricter, luck-free circle than the
  // probabilistic "radiating" land-destroy shape above, matching how the
  // real source's separate mg.units() sweep uses a flat
  // euclideanDistSquared test with no rand.chance involved, and how a
  // structure can therefore be destroyed by this circle even on a tile the
  // land-destroy coin flip happened to spare.
  detonateNuke(nuke) {
    const dst = nuke.dst;
    const magnitude = this.NUKE_MAGNITUDES[nuke.nukeType];
    const outer2 = magnitude.outer * magnitude.outer;
    const w = GameMap.width;
    const dstX = dst % w, dstY = (dst / w) | 0;
    const withinOuter = (pos) => (pos.x - dstX) ** 2 + (pos.y - dstY) ** 2 < outer2;

    // 1. Every building within the full outer-radius circle, owner read
    // fresh before step 2 below can touch GameMap.owner.
    for (const [tile, b] of this.buildings) {
      if (this.tileDistSq(dst, tile) >= outer2) continue;
      const owner = GameMap.owner[tile];
      if (owner >= 0) {
        const op = this.players[owner];
        if (b.built) op.units[b.type] = Math.max(0, this.unitsOwned(op, b.type) - b.level);
        else op.unitsPending[b.type] = Math.max(0, this.unitsPending(op, b.type) - 1);
      }
      this.buildings.delete(tile);
    }

    // 2. Unclaim + irradiate the "radiating" land-destroy set. Real
    // GameImpl.queueWaterConversion only actually turns land to water under
    // a `waterNukes` ruleset toggle this game doesn't model — its default
    // (and this port's) behavior is `setFallout(tile, true)` instead: the
    // land itself survives, unowned and radioactive, still fully capturable
    // — just at falloutDefenseModifier's steep troop/speed multiplier (see
    // tileCost/stepAttack) until someone actually resettles it, which
    // GameImpl's own conquer() clears instantly (ported in setOwner above).
    const toDestroy = this.nukeBlastTiles(dst, magnitude);
    const tilesPerPlayer = new Map();
    for (const tile of toDestroy) {
      const owner = GameMap.owner[tile];
      if (owner >= 0) {
        this.players[owner].tiles.delete(tile);
        tilesPerPlayer.set(owner, (tilesPerPlayer.get(owner) || 0) + 1);
        GameMap.owner[tile] = NEUTRAL;
      }
      // Fallout applies to every LAND tile in the blast, owned or not —
      // verbatim queueWaterConversion's own mg.isLand(tile) guard, which has
      // no ownership condition. `owner !== WATER` is this game's isLand
      // check (already-relinquished-to-NEUTRAL tiles above still count).
      if (owner !== WATER) this.fallout.add(tile);
      this.dirtyTiles.add(tile);
    }

    // 3. Diminishing troop losses — the player's home reserve, their
    // outgoing attacks, and their in-transit invasion boats all take the
    // same per-tile nukeDeathFactor hit, each reading/writing live so the
    // loss compounds exactly like the real per-tile loop does.
    for (const [ownerId, numImpactedTiles] of tilesPerPlayer) {
      const p = this.players[ownerId];
      let tilesLeft = p.tiles.size + numImpactedTiles;
      for (let i = 0; i < numImpactedTiles; i++) {
        p.troops = Math.max(0, p.troops - this.nukeDeathFactor(p.troops, tilesLeft));
        for (const a of this.attacks) {
          if (a.attacker !== ownerId) continue;
          a.troops = Math.max(0, a.troops - this.nukeDeathFactor(a.troops, tilesLeft));
        }
        for (const bt of this.boats) {
          if (bt.attacker !== ownerId) continue;
          bt.troops = Math.max(0, bt.troops - this.nukeDeathFactor(bt.troops, tilesLeft));
        }
        tilesLeft--;
      }
    }

    // 4. Anything afloat within the same full outer-radius circle sinks
    // outright, own fleet included — no owner immunity, matching the real
    // source's unconditional mg.units() sweep.
    for (let i = this.warships.length - 1; i >= 0; i--) {
      if (withinOuter(this.pathPos(this.warships[i]))) this.warships.splice(i, 1);
    }
    for (let i = this.boats.length - 1; i >= 0; i--) {
      if (withinOuter(this.pathPos(this.boats[i]))) this.boats.splice(i, 1);
    }
    for (let i = this.tradeShips.length - 1; i >= 0; i--) {
      if (withinOuter(this.pathPos(this.tradeShips[i]))) this.tradeShips.splice(i, 1);
    }

    // Ephemeral shockwave for render.js's drawNukeBlasts — not gameplay
    // state, just aged out and pruned by stepNukes below.
    this.nukeBlasts.push({ x: dstX, y: dstY, inner: magnitude.inner, outer: magnitude.outer, born: this.elapsed });
  },

  // Advances every in-flight nuke (straight-line, see launchNuke) and
  // detonates it once its travel duration elapses. A nuke intercepted by a
  // SAM this same tick never reaches here at all — stepSamMissiles (called
  // first, see Game.tick) already spliced it out of this.nukes — so this
  // still needs no interception check of its own; every nuke still in the
  // array by the time this runs is one that got through. Also prunes spent
  // shockwave effects, the only other thing this system leaves lying around.
  stepNukes() {
    for (let i = this.nukes.length - 1; i >= 0; i--) {
      const n = this.nukes[i];
      if (this.elapsed - n.born < n.duration) continue;
      this.nukes.splice(i, 1);
      this.detonateNuke(n);
    }
    for (let i = this.nukeBlasts.length - 1; i >= 0; i--) {
      if (this.elapsed - this.nukeBlasts[i].born > this.NUKE_BLAST_FX_DURATION) this.nukeBlasts.splice(i, 1);
    }
  },

  // --- SAM Launcher & Interceptors ------------------------------------------
  // Ported against OpenFront's real SAMLauncherExecution.ts/
  // SAMMissileExecution.ts/Config.ts source (github.com/openfrontio/
  // OpenFrontIO), not guessed — see feedback-openfront-source-porting memory.
  //
  // Charges: verbatim UnitImpl's own model. A SAM's `samQueue` holds one
  // elapsed-time entry per charge currently mid-reload, capacity-capped at
  // its `level` — `queue.length === level` means fully saturated (no free
  // charge), exactly matching real UnitImpl.isInCooldown(). A level-2 SAM
  // therefore has two independent SAM_COOLDOWN timers, not one shared one:
  // firing both at once (two nukes converging in the same tick) reloads them
  // back-to-back rather than serially, and firing just one leaves the other
  // charge free to answer a second launch immediately. Leveling up doesn't
  // hand over its new charge for free either — increaseLevel pushes a fresh
  // queue entry the same way a real launch does, so the extra capacity has
  // to reload once before it's usable (see updateConstruction's upgrade
  // branch, which does the equivalent push).
  //
  // Range: samRange(level) is their exact rational curve, asymptotically
  // approaching SAM_MAX_RANGE (150 tiles, unscaled — see NUKE_MAGNITUDES'
  // own comment on why OpenFront's map dimensions need no rescaling here):
  // level 1 = 70, level 3 = 90, level 5 = 102. It also doesn't jump the
  // instant an upgrade completes — dynamicSamRange ramps it linearly over
  // SAM_UPGRADE_RAMP seconds, matching their own samLauncherState/
  // dynamicSamRange pair.
  //
  // Targeting/interception is the one piece that couldn't be a literal
  // port: the real SAMTargetingSystem walks a nuke's discretized per-tile
  // trajectory (from its own ParabolaUniversalPathFinder) looking for a tile
  // both in range and reachable in time. This game's nukes don't have that
  // — Game.launchNuke gives a nuke only fixed from/to endpoints and a
  // born/duration pair, a continuous straight-line flight (see that
  // section's own comment on why). samSolveIntercept below is the
  // continuous-time equivalent of the same question — algebraically solving
  // "where do these two constant-velocity paths meet" instead of stepping
  // tile by tile — which is exactly as precise while fitting this game's own
  // data shape.

  SAM_MAX_RANGE: 150,
  // Config.ts's SAMCooldown(): 90 ticks, same conversion SILO_COOLDOWN's own
  // comment already explains (TICKS_PER_SEC=10) — and, tellingly, the exact
  // same raw value as SiloCooldown, so the two structures share a cooldown
  // pace even though nothing in the real source ties them together.
  SAM_COOLDOWN: 9,
  // Config.ts's samUpgradeDuration(): floor(SAMCooldown()/2) ticks, in this
  // file's own seconds scale rather than raw ticks.
  SAM_UPGRADE_RAMP: 4.5,
  // Config.ts's defaultSamMissileSpeed(): 12 tiles/tick raw = 120 tiles/sec,
  // a 1.2x ratio over their own raw nukeSpeed (100 tiles/sec — see
  // NUKE_SPEED's comment). Applied to THIS game's own slowed-down NUKE_SPEED
  // (45, not the raw 100) to preserve that same 1.2x ratio rather than the
  // real absolute number, same reasoning NUKE_SPEED's own comment gives for
  // why it was slowed in the first place.
  SAM_MISSILE_SPEED: 54,
  // No OpenFront equivalent, same as NUKE_BLAST_FX_DURATION just above it —
  // purely how long the intercept-confirmation ring (see stepSamMissiles)
  // stays on screen.
  SAM_FLASH_FX_DURATION: 0.5,

  samRange(level) {
    return this.SAM_MAX_RANGE - 480 / (level + 5);
  },

  // Config.ts's dynamicSamRange: while a level-up is still ramping (see
  // updateConstruction's `b.samRangeUpgrade` hook), the effective range
  // slides linearly from whatever range was actually in effect the instant
  // the upgrade landed, up to the new level's — otherwise it's just the
  // static value for the current level. `now` is passed explicitly (rather
  // than always reading this.elapsed) so stepSAMs' intercept solve can ask
  // "what will the range be at the tick the interceptor actually arrives",
  // matching the real source's own ticks+expTicks lookahead — the ramp
  // formula is a pure function of elapsed-since-upgrade, so it extrapolates
  // correctly into the future with no special-casing needed.
  //
  // Clamped on BOTH ends, not just the upper one: render.js reads this with
  // Game.renderElapsed, which only tracks Game.elapsed frame-by-frame inside
  // main.js's normal animation loop (see renderElapsed's own comment) — but
  // Game.fastForward() drives many ticks through Game.tick() directly,
  // without ever touching renderElapsed. An upgrade whose `startAt` lands
  // mid-burst leaves renderElapsed sitting BEFORE state.startAt until the
  // next real animation frame catches up, which un-clamped produced a large
  // negative `elapsed` here — extrapolating the ramp backwards into a
  // negative range and crashing ctx.arc's radius in drawStructures (caught
  // live via a fastForward-shaped repro while verifying this feature).
  // Clamping elapsed<=0 to the pre-upgrade startRange is the correct
  // behavior anyway, not just a crash guard: from that reader's-clock
  // perspective the ramp hasn't started yet.
  dynamicSamRange(b, now) {
    const state = b.samRangeUpgrade;
    if (!state) return this.samRange(b.level);
    const elapsed = now - state.startAt;
    if (elapsed <= 0) return state.startRange;
    if (elapsed >= this.SAM_UPGRADE_RAMP) return this.samRange(state.targetLevel);
    const targetRange = this.samRange(state.targetLevel);
    return state.startRange + (targetRange - state.startRange) * elapsed / this.SAM_UPGRADE_RAMP;
  },

  // Solves "where do these two constant-velocity paths meet" — the
  // continuous-time equivalent of SAMTargetingSystem's per-tile trajectory
  // walk (see the section comment above). `samPos` is fixed; the nuke moves
  // along its own fixed from/to line. An interceptor launched THIS INSTANT
  // at SAM_MISSILE_SPEED needs travel time t solving
  // |nukePos(now+t) - samPos| = SAM_MISSILE_SPEED * t — a standard
  // turret-lead-the-target quadratic in t. Returns the smallest positive
  // root and the meeting point, or null if the nuke's already gone, the
  // quadratic has no positive real root (SAM_MISSILE_SPEED can't catch it in
  // time), or the meeting point would land at-or-after the nuke's own
  // detonation.
  samSolveIntercept(samPos, nuke, now) {
    const remaining = nuke.born + nuke.duration - now;
    if (remaining <= 0) return null;
    const dx = nuke.to.x - nuke.from.x, dy = nuke.to.y - nuke.from.y;
    const vx = dx / nuke.duration, vy = dy / nuke.duration;
    const u = (now - nuke.born) / nuke.duration;
    const px = nuke.from.x + dx * u, py = nuke.from.y + dy * u;
    const rx = px - samPos.x, ry = py - samPos.y;
    const speed2 = this.SAM_MISSILE_SPEED * this.SAM_MISSILE_SPEED;
    const a = (vx * vx + vy * vy) - speed2;
    const bq = 2 * (rx * vx + ry * vy);
    const cq = rx * rx + ry * ry;
    let t;
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(bq) < 1e-9) return null;
      t = -cq / bq;
    } else {
      const disc = bq * bq - 4 * a * cq;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      const t1 = (-bq + sq) / (2 * a), t2 = (-bq - sq) / (2 * a);
      t = Infinity;
      if (t1 > 1e-6) t = Math.min(t, t1);
      if (t2 > 1e-6) t = Math.min(t, t2);
      if (!isFinite(t)) return null;
    }
    // A hair of margin before the nuke's own detonation, not exactly on it —
    // avoids a same-tick float-coincidence race between stepSamMissiles'
    // resolution and stepNukes' own duration check.
    if (t <= 0 || t >= remaining - 0.01) return null;
    return { t, x: px + vx * t, y: py + vy * t };
  },

  // Config.ts's SAMTargetingSystem.computeTargetScore, translated off this
  // game's own nuke shape (dst/nukeType/born/duration rather than a
  // trajectory array) — a tiebreaker for which nuke a multi-charge SAM fires
  // at first when several are interceptable the same tick: Hydrogen Bombs
  // outrank Atom Bombs, impacts closer to the SAM outrank farther ones, and
  // soon-to-land nukes edge out ones with more time left. The real source
  // calls this "only a very minor tiebreaker" since every candidate here is
  // already guaranteed interceptable — it just orders which charge answers
  // which nuke first, not whether an interception happens at all.
  samTargetScore(b, cand) {
    const w = GameMap.width;
    const dstX = cand.nuke.dst % w, dstY = (cand.nuke.dst / w) | 0;
    const samX = b.tile % w, samY = (b.tile / w) | 0;
    const distToSam = Math.abs(dstX - samX) + Math.abs(dstY - samY);
    const typeBonus = cand.nuke.nukeType === 'hydrogenbomb' ? 70001 : 0;
    const distanceBonus = Math.max(0, 200000 - distToSam * 1000);
    const remaining = (cand.nuke.born + cand.nuke.duration) - this.elapsed;
    const urgencyBonus = Math.max(0, 10000 - remaining * this.TICKS_PER_SEC * 100);
    return typeBonus + distanceBonus + urgencyBonus;
  },

  // Config.ts's SAMLauncherExecution.tick, adapted to this game's continuous
  // clock: reload any charges whose SAM_COOLDOWN has elapsed, settle a
  // finished range ramp, then — while a charge remains free — fire at
  // whichever interceptable, not-already-targeted enemy nuke scores highest.
  // "Interceptable" means samSolveIntercept finds a real future meeting
  // point AND that point sits inside the SAM's dynamic range at the tick the
  // interceptor would actually arrive (dynamicSamRange called with a future
  // `now`, matching the real source's own lookahead — see its own comment).
  // Allied nukes are skipped outright rather than porting the real source's
  // narrow endgame exception (only intercept an ally's nuke once a winner
  // already exists and they're on the same team) — this game has no
  // team/winner system for that exception to hook into. A SAM can fire more
  // than one charge in the same tick, exactly like the real source's own
  // `for (target of targets) { if (cooldown) break; launch }` loop — a
  // level-2+ SAM with several nukes converging on it isn't limited to one
  // shot per tick.
  stepSAMs() {
    const w = GameMap.width;
    for (const b of this.buildings.values()) {
      if (b.type !== 'sam' || !b.built) continue;

      while (b.samQueue.length && this.elapsed - b.samQueue[0] >= this.SAM_COOLDOWN) b.samQueue.shift();
      if (b.samRangeUpgrade && this.elapsed - b.samRangeUpgrade.startAt >= this.SAM_UPGRADE_RAMP) {
        b.samRangeUpgrade = null;
      }
      if (b.samQueue.length >= b.level) continue;

      const ownerId = GameMap.owner[b.tile];
      if (ownerId < 0) continue;
      const samPos = { x: b.tile % w + 0.5, y: ((b.tile / w) | 0) + 0.5 };

      const candidates = [];
      for (const n of this.nukes) {
        if (n.targetedBySAM || n.ownerId === ownerId || this.areAllied(ownerId, n.ownerId)) continue;
        const solved = this.samSolveIntercept(samPos, n, this.elapsed);
        if (!solved) continue;
        const distSq = (solved.x - samPos.x) ** 2 + (solved.y - samPos.y) ** 2;
        const range = this.dynamicSamRange(b, this.elapsed + solved.t);
        if (distSq > range * range) continue;
        candidates.push({ nuke: n, solved, score: 0 });
      }
      if (!candidates.length) continue;
      for (const c of candidates) c.score = this.samTargetScore(b, c);
      candidates.sort((x, y) => y.score - x.score);

      for (const c of candidates) {
        if (b.samQueue.length >= b.level) break;
        b.samQueue.push(this.elapsed);
        c.nuke.targetedBySAM = true;
        this.samMissiles.push({
          ownerId,
          from: samPos, to: { x: c.solved.x, y: c.solved.y },
          born: this.elapsed, duration: Math.max(0.05, c.solved.t),
          target: c.nuke
        });
      }
    }
  },

  // Advances every in-flight SAM interceptor (see stepSAMs) and resolves the
  // kill once its precomputed intercept time elapses. Unlike stepShells'
  // guarded fizzle, the target is always still in this.nukes at that point —
  // samSolveIntercept only ever commits to an intercept that lands strictly
  // before the nuke's own detonation (with a small safety margin — see its
  // own comment), and targetedBySAM prevents any other SAM from
  // double-claiming the same nuke — so there's nothing to validate here.
  // Must run before stepNukes in Game.tick so a killed nuke never also
  // detonates the same frame. render.js's drawSamMissiles reads
  // from/to/born/duration directly, same as drawShells.
  stepSamMissiles() {
    for (let i = this.samMissiles.length - 1; i >= 0; i--) {
      const m = this.samMissiles[i];
      if (this.elapsed - m.born < m.duration) continue;
      this.samMissiles.splice(i, 1);
      const ni = this.nukes.indexOf(m.target);
      if (ni >= 0) {
        this.nukes.splice(ni, 1);
        this.samFlashes.push({ x: m.to.x, y: m.to.y, born: this.elapsed });
      }
    }
    for (let i = this.samFlashes.length - 1; i >= 0; i--) {
      if (this.elapsed - this.samFlashes[i].born > this.SAM_FLASH_FX_DURATION) this.samFlashes.splice(i, 1);
    }
  }
};
