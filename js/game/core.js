const Game = {
  // Cross-engine deterministic math for the simulation.
  //
  // `+ - * /` and Math.sqrt are IEEE-754 operations and bit-identical on
  // every engine. Math.pow, Math.exp, Math.log and Math.hypot are NOT: engines
  // disagree in the last ulp, and under lockstep a one-bit difference
  // grows into a desync.
  //
  // So every hazardous call in the sim goes through here, with the result
  // quantized to 12 significant digits (see detQuantize); the contested bits
  // sit around digit 16.
  //
  // There is deliberately no det.sqrt. Integer-exponent Math.pow(2, n) is
  // exempt too; see unitCost. Two engines landing either side of a
  // quantization boundary is what the state hash is for.
  det: {
    pow(base, exponent) { return detQuantize(Math.pow(base, exponent)); },
    exp(x) { return detQuantize(Math.exp(x)); },
    // sqrt(dx*dx + dy*dy), not Math.hypot: every step is IEEE-exact. The
    // quantize is belt-and-braces. A hot call site may inline the sqrt form
    // directly (map.js's spawn-separation loop does).
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
  // Monotonic entity-id counters, reset in init() and incremented only from
  // sim code, so every client mints the same id for the same entity.
  //
  // They exist for the wire: `cancel_attack`, `cancel_boat` and
  // `move_warship` name their targets by id.
  //
  // An id is never reused or renumbered. An intent naming an id that has
  // ended (attack consolidated, boat landed, warship sunk) resolves to
  // nothing, identically on every client. Ids start at 1 so 0 is never a
  // valid entity.
  nextAttackId: 1,
  boats: [],
  nextBoatId: 1,
  // tile -> { type, tile, built, progress, buildTime, level, upgrading,
  // station, rails, lastTrainAt }. Owner is whoever holds the tile. `built`
  // is false until `progress` reaches `buildTime`; until then it doesn't
  // count toward units/maxTroops. `level` starts at 1 and climbs through
  // upgrade(), which reuses progress/buildTime, gated by `upgrading`.
  // `station`/`rails`/`lastTrainAt` belong to the rail network (rail.js).
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
  // Fields on Game that are pure presentation and are SKIPPED by the
  // deterministic state hash, which consults this list by name. These are
  // pushed unconditionally (not viewer-relative), so they are safe to keep
  // on Game.
  //
  // Adding a field here is a claim that it is provably gameplay-irrelevant:
  // nothing in the simulation may branch on it, read it back, or derive a
  // value from it. If in doubt, leave it out.
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
  // Win-condition result, Game.me-blind. null until tick() decides a
  // winner; then the winning player's id, set exactly once and identically
  // on every client.
  winnerId: null,
  // True from init() until the spawn phase's timed deadline elapses (see
  // tickSpawnPhase/SPAWN_PHASE_TURNS) — not until any human taps, which is
  // MP-3.2's fix: under 2+ humans the first tap can no longer end the phase
  // for everyone else. chooseSpawn() only claims the caller's own disc.
  spawning: false,
  dirty: true,
  // Tile indices whose owner changed since Render last rebuilt the tile
  // canvas, plus each one's neighbours (their border shading can change).
  // `dirty` (above) is for whole-canvas rebuilds.
  dirtyTiles: null,

  // The repaint queue: a deduping tile set filled and drained every frame.
  // A flag byte per tile does the deduping and a plain array holds the
  // order; neither is reallocated, so steady state allocates nothing (a Set
  // here was the game's largest source of GC churn). Keeps the Set surface
  // the renderer uses: add/size/clear and for..of. Not sim state.
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

  // The sim's one and only timestep. Nothing in the simulation may ever
  // see a wall-clock `dt`: tick() steps by this constant, and how often it
  // is called is main.js's scheduling. Numerically 1/TICKS_PER_SEC.
  TICK_DT: 0.1,
  // Integer turn counter, the sim's authoritative clock. Incremented exactly
  // once per tick() and never derived from anything else, so two clients that
  // have processed the same number of turns hold the same value bit-for-bit.
  ticks: 0,
  // Derived, never stored: accumulating `elapsed += dt` drifts with how
  // many times you added. Multiplying out from the integer gives every
  // client the same float.
  //
  // This is a getter; assigning to it silently does nothing. Advance
  // `ticks` instead.
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

  // The World map's three resolutions (500x250, 1000x500, 2000x1000), all
  // 2:1. A full-commitment push takes a few thousand tiles whatever the
  // map, so small matches end in minutes while large ones run long.
  // Per-tick cost follows player and attack count, not tile count.
  MAP_SIZES: {
    small:  { width: 1000, height: 500 },   // was 500x250 (OpenFront's map16x)
    medium: { width: 1500, height: 750 },   // was 1000x500 (OpenFront's map4x)
    large:  { width: 2000, height: 1000 }   // OpenFront's World, full resolution
  },

  // gameStartInfo is {gameID, seed, config:{map?,mapSize,bots,tribes,
  // difficulty?}, players:[{clientID,username,playerId}]}, the shape
  // LocalServer.start and server/gameserver.js's start() both produce.
  // myPlayerId is a plain integer the caller computes.
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

    // Player id space: 0..H-1 are humans (one per roster entry),
    // H..H+botCount-1 are Nations, the rest are Tribes. Only Nations and
    // Tribes get an algorithmic spawn here; humans pick theirs in
    // chooseSpawn().
    const roster = Array.isArray(gameStartInfo.players) ? gameStartInfo.players : [];
    const H = roster.length;
    const botCount = config.bots | 0;
    const tribeCount = config.tribes | 0;
    const total = H + botCount + tribeCount;
    // One findSpawns call, sized for humans too: each human needs a
    // fallback tile at the spawn-phase deadline. Everything comes off the
    // same rng stream, so every client partitions the array identically:
    // the first H tiles are reserved for humans (roster order), the rest
    // go to NPCs.
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
    // MIRV: the mothership in flight, before it splits into warheads (see
    // nukes.js's launchMirv/stepMirvs). Kept out of this.nukes because it
    // is not SAM-interceptable. mirvsLaunched is a whole-match counter:
    // MIRV cost rises with every player's launches (see unitCost).
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
    // Turn counter for the spawn phase. Game.ticks stays at 0 for the
    // whole spawn phase, so it cannot drive the deadline;
    // tickSpawnPhase() increments this once per turn instead.
    this.spawnPhaseTicks = 0;
    // Per D1: a solo player has nobody to wait for, so singleplayer keeps the
    // short window; any match with more than one human gets the long one so
    // every human has a real chance to place before the deadline.
    // Fog matches place everyone at once, so the countdown is only there for
    // players to find themselves on the map: 5 s (docs/fog-of-war.md).
    this.SPAWN_PHASE_TURNS = this.fog ? 50 : (H > 1 ? 150 : 100);

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
        // Nations. Name/colour indexing is shifted by H so the first bot is
        // always BOT_NAMES[0], however many humans precede it. Wraps with
        // `%` if the tables run out (cosmetic).
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
    // Fog of war's Scouts (game/scouts.js): an empty list every match.
    this.initScouts();
    // Battle Royale (game/drill.js): no Drill until someone places one.
    this.initDrill();

    // Spawn-pick phase: every Nation/Tribe claims a provisional starting
    // disc, then re-rolls it to a nearby spot every couple of seconds until
    // the deadline (SPAWN_PHASE_TURNS). spawnCenters is each NPC's anchor;
    // jumps stay within SPAWN_JUMP_RADIUS of it.
    this.spawnCenters = new Array(total).fill(-1);
    this.nextSpawnJumpAt = new Array(total).fill(0);
    // Fog matches: nobody picks. Every human starts on the reserve tile that
    // would otherwise only be the fallback at the deadline.
    if (this.fog) for (let p = 0; p < H; p++) this.claimStart(this.humanReserveTiles[p], p);
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

  // The one place a nation's `alive` flips to false. Also records the
  // placement the defeat screen reads: how many nations (tribes excluded)
  // were still alive, including this one. Guarded by p.alive so it can't
  // run twice for one player.
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
    if (this.fog) return 'Spawns are random in fog of war';
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

  // `playerId` defaults to this.me only for local callers; the Executor
  // always passes the clientID-resolved player.
  //
  // This only claims (or re-claims) the caller's own provisional disc. It
  // does NOT end the spawn phase: that happens only at the tick-driven
  // deadline in tickSpawnPhase, for every human at once, so a human can
  // re-pick any number of times before then.
  chooseSpawn(tile, playerId) {
    if (!this.canChooseSpawn(tile)) return false;
    const id = playerId === undefined ? this.me : playerId;
    // A re-pick: drop the old claim before claiming the new one.
    // spawnBlockReason's 'unclaimed' check means not held by anyone, so a
    // human re-picking a tile they already hold is refused, harmlessly.
    if (this.players[id].tiles.size > 0) this.unclaimAll(id);
    this.claimStart(tile, id);
    // A solo player has nobody to wait for: the match starts the moment they
    // place their capital, no countdown.
    if (this.humanCount === 1) this.endSpawnPhase();
    return true;
  },

  // Deadline auto-placement for anyone who never picked, then the match goes
  // live. No explicit NPC "freeze" needed: the instant spawning is false,
  // tick()'s own top guard means tickSpawnPhase (and jumpSpawnPreview) is
  // simply never called again.
  endSpawnPhase() {
    for (let p = 0; p < this.humanCount; p++) {
      if (this.players[p].tiles.size === 0) this.claimStart(this.humanReserveTiles[p], p);
    }
    this.spawning = false;
    this.running = true;
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

  // Advances every NPC's spawn-preview jump clock, then the spawn phase's
  // turn counter, and ends the phase at the deadline. The only thing tick()
  // drives while spawning.
  //
  // The NPC loop must start at `this.humanCount`: jumpSpawnPreview
  // unclaims and re-randomizes a player's tiles, which would destroy a
  // human's chosen capital.
  tickSpawnPhase() {
    for (let p = this.humanCount; p < this.players.length; p++) {
      // Fog matches: nobody wobbles. Vision is live during the countdown, so a
      // moving spawn would leave a trail of discovered cells and contacts.
      if (this.fog) break;
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
      this.endSpawnPhase();
    }
  },

  claimStart(center, playerId) {
    // Radius 5 against a squared cutoff of 29 (not r*r=25) rasterizes as a
    // round 97-tile blob; a plain r*r cutoff at this radius sticks a tile
    // out on all four sides. Puts a fresh spawn's cap at ~13.1k.
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
      // A capture by a real player clears fallout on the tile. Only on a
      // real capture (newOwner >= 0): reverting to NEUTRAL must NOT clear
      // it, since irradiated unclaimed land is the mechanic's steady state.
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

    // A structure belongs to whoever holds the ground under it, so a city
    // changes hands the instant its tile does. This moves the pop bonus and
    // the current-holdings count (units), but NOT unitsBuilt, the lifetime
    // count unitCost prices against.
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
          // Overrun mid-construction: the attacker inherits the build site
          // and it keeps ticking under the new flag. updateConstruction reads
          // ownership off the tile, so only the pending count moves here. The
          // builder's gold stays sunk.
          const np = this.players[newOwner];
          np.unitsPending[b.type] = this.unitsPending(np, b.type) + 1;
        }
      } else if (b.type === 'fort') {
        // A Fort is destroyed, not captured, when the enemy takes its tile
        // (deliberate design choice). unitsBuilt is untouched; only the
        // current holding disappears. Floored at 0 so a stale count can
        // never go negative and underprice the owner's next build.
        if (old >= 0) {
          const op = this.players[old];
          op.units[b.type] = Math.max(0, this.unitsOwned(op, b.type) - b.level);
        }
        this.buildings.delete(i);
      } else {
        // Overrun mid-upgrade: the level in progress is lost. The attacker
        // gets the city at its CURRENT level and the owner's gold stays
        // sunk. The building is not deleted.
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

  // Recomputes whether `tile` is a border tile for `playerId` (owned by
  // them with at least one neighbour not theirs) and updates their
  // borderTiles set. `playerId` may be NEUTRAL/WATER (< 0), which has no
  // set. Uses bbuf2: setOwner is still holding a neighbour list in bbuf.
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
  // Each returns null when the id names nothing. None throws or falls back
  // to 'the nearest one': an ended id must resolve to nothing, identically
  // on every client. Linear scans; the lists are small and these run once
  // per cancel/move intent, not per tick.
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
    // work this tick may start. The budget and the coast-path memo
    // (nearestCoastPath) apply only while _inTick is set. Outside tick()
    // (intents, client-local UI) searches run unbudgeted and uncached, so
    // one client's UI can never spend budget or plant a cached path that
    // another client's sim doesn't see.
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
        // Losing land lowers the cap, and the population snaps down to it at
        // once (no gradual decay), or conquest would never weaken anyone.
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
    // Fog of war's Scouts (game/scouts.js). None can exist with fog off.
    if (this.fog) this.stepScouts();
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
    // Battle Royale's closing circle (game/drill.js). Before the elimination
    // sweep and win check, so land the circle takes settles both this tick.
    this.stepDrill();

    for (const p of this.players) {
      if (p.alive && p.tiles.size === 0 && p.troops < 20) this.eliminatePlayer(p);
    }

    // Win condition, computed in the sim so it lands on the same turn for
    // every client; nothing here depends on Game.me. Decided exactly once
    // (the `this.winnerId === null` guard).
    //
    // isDisconnected players are NOT special-cased: their nation is still
    // simulated and can win or block a win.
    // Team games win per team (checkTeamWin in game/teams.js). With a
    // Drill (Battle Royale) neither mode uses the land share (checkDrillWin).
    if (this.teams) this.checkTeamWin();
    else if (this.drill) { if (this.winnerId === null) this.checkDrillWin(); }
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
        // Irradiated land is excluded from the denominator: it shrinks the
        // total a player needs to own. Checked against every player. The
        // threshold is the win threshold (as Teams.WIN_PERCENT),
        // cross-multiplied like hasWon().
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

  // Dev-only: jumps the match forward by running tick() back-to-back.
  // Counted in whole ticks. No-ops before the match is running.
  //
  // There is no shield for the human: the sim may not branch on Game.me,
  // so a burst can cost them territory. The debug button uses
  // LocalServer.burst(turns) instead, which goes through the ordinary
  // turn pipeline.
  fastForward(seconds) {
    const turns = Math.round(seconds / this.TICK_DT);
    for (let t = 0; t < turns && this.running; t++) this.tick();
  },

};
