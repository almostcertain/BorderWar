// Intent -> simulation. The one and only path by which a player action
// mutates the game (Task MP-1.2, docs/multiplayer-architecture.md §9 Phase 1).
//
// This is the analogue of OpenFront's Executor/Execution layer
// (src/core/execution/ExecutionManager.ts and the Execution classes it
// creates): a validated intent arrives, an actor is resolved from it, and the
// simulation changes. The deliberate simplification is that OpenFront turns
// each intent into an `Execution` object with its own tick lifecycle that the
// GameImpl runs for as long as it lives (AttackExecution ticks a front for
// minutes), whereas this game already keeps that machinery inside Game itself —
// Game.attacks/boats/warships are stepped by Game.tick — so an intent here maps
// to one call of the existing Game.* method and returns. There is no Execution
// object to build and nothing for this file to schedule. If a future mechanic
// genuinely needs per-tick behaviour of its own, it belongs in js/game/ beside
// stepAttack/stepBoats (attacks.js, naval.js), not here.
//
// WHY THIS FILE EXISTS AT ALL, since a click could obviously just call
// Game.launchAttack directly (and until MP-1.5 still does): under deterministic
// lockstep a click must not mutate anything. It becomes an intent, goes to the
// server, comes back inside a Turn, and is applied by *every* client on the
// same tick. So the mutation has to happen somewhere that runs identically on
// every client from identical inputs. That is here. Every rule below follows
// from that one fact.
//
// THE THREE RULES
//
// 1. NEVER READ Game.me. Game.me is a view pointer — which nation this browser
//    is looking through — and it differs on every client by definition. The
//    actor is always resolved from the intent's server-stamped `clientID`.
//    Reading Game.me here would reintroduce exactly the desync class MP-0.2
//    spent a phase eliminating, and it would do it silently: the game would
//    look perfect on the client that issued the click and be wrong everywhere
//    else. (game/core.js's chooseSpawn and game/warships.js's moveWarships still default to Game.me for
//    their pre-lockstep ui.js callers; this file always passes the actor
//    explicitly so that default is never taken.)
//
// 2. NOTHING NON-DETERMINISTIC. No Date, no performance.now, no Math.random, no
//    DOM, no rendering, no wall clock in any form. Use Game.rng if randomness is
//    ever needed (nothing here needs it). Note that "log a warning" is not
//    exempt: a console call whose *presence* depends on client-local state is
//    fine, but nothing may branch the simulation on it.
//
// 3. REJECTION IS SILENT AND IDENTICAL. Bad grammar, an unknown entity id, an
//    illegal move, an unresolvable client — all drop, all return false, none
//    throw. A throw would abort the turn on one client and not another (the
//    other clients' copies of the same intent might be fine), which splits the
//    match far more thoroughly than the bad intent ever could. Dropping is
//    always safe because every client drops the same intent for the same reason
//    on the same turn.
//
// LEGALITY IS NOT REIMPLEMENTED HERE. js/game/ already owns the rules, in the
// *BlockReason validators (spawnBlockReason, buildBlockReason,
// upgradeBlockReason, navalInvasionBlockReason, allianceBlockReason,
// warshipBlockReason, nukeBlockReason) and in the mutators that call them and
// return false. This file calls those and believes them. A second copy of "can
// you afford a city" here would drift from the first, and the copy that
// disagreed with the sim would be the one refusing a legitimate click. What
// this file *does* own is AUTHORSHIP — that the actor cancelling an attack is
// the one who launched it — because nothing in js/game/ has ever needed to ask
// that question before now.
//
// Nothing calls this yet. MP-1.3 (Runner) drives it from the turn queue and
// MP-1.5 rewires ui.js/radial.js to send intents instead of mutating; until
// then the UI still calls Game.* directly and this file sits inert.
const Executor = {

  // --- clientID -> playerId --------------------------------------------------
  //
  // The seam. A real roster arrives in MP-3.1, built from the server's
  // `gameStartInfo.players` ([{clientID, username, playerId}], §4) — the same
  // list on every client, which is what makes this mapping safe to consult
  // inside the simulation at all. Until then there is exactly one client and it
  // is player 0, so the table is empty and `playerFor` says 0.
  //
  // Kept as an explicit Map with an explicit lookup, rather than a `0` written
  // inline at each of the fifteen dispatch cases, purely so MP-3.1 is one
  // populated table and not a hunt through this file.
  clientToPlayer: new Map(),

  // The stand-in clientID a single-player session stamps with, so intents built
  // before MP-3.1 still look exactly like intents built after it. MP-1.4's
  // LocalServer is the intended user.
  LOCAL_CLIENT_ID: 'local',

  // clientID -> index into Game.players, or -1 when it names nobody.
  //
  // The empty-table fallback is the whole of the current implementation and is
  // deliberately not clever: with no roster there is one human, they are player
  // 0, and every intent that reaches us is theirs. Once setRoster has been
  // called the table is authoritative and an unknown clientID resolves to -1,
  // which drops the intent — a client that is not in the game does not get to
  // move a nation that is.
  playerFor(clientID) {
    if (typeof clientID !== 'string' || clientID.length === 0) return -1;
    if (this.clientToPlayer.size === 0) return 0;
    const id = this.clientToPlayer.get(clientID);
    return id === undefined ? -1 : id;
  },

  // Install the roster (MP-3.1). `entries` is gameStartInfo.players' shape —
  // anything iterable of { clientID, playerId }. Replaces wholesale rather than
  // merging: a partially-applied roster is a desync waiting to happen, and the
  // server sends the complete list every time.
  setRoster(entries) {
    this.clientToPlayer = new Map();
    if (!entries) return;
    for (const e of entries) {
      if (!e || typeof e.clientID !== 'string') continue;
      if (!Number.isInteger(e.playerId)) continue;
      this.clientToPlayer.set(e.clientID, e.playerId);
    }
  },

  // Back to the pre-roster single-client default. Called on a fresh match.
  reset() { this.clientToPlayer = new Map(); },

  // --- Guards ----------------------------------------------------------------

  // A tile index that actually exists on THIS map. Protocol.FIELD_TYPES.tile
  // can only bound the number against MAX_TILE_INDEX — it is forbidden from
  // touching GameMap (its purity contract, so the Node server can require it),
  // and the server does not hold a map anyway. So the map-relative half of the
  // check lands here, where GameMap is in scope and identical on every client.
  //
  // This is a bounds check on a wire value, not a game rule: the rules about
  // *which* real tile you may build on stay in buildBlockReason. Without it a
  // tile index one past the end reaches js/game/ as `GameMap.owner[t] ===
  // undefined`, which most validators handle by accident but launchNuke does
  // not — it would happily fly a missile at coordinates off the map.
  _tileOnMap(tile) {
    return Number.isInteger(tile) && tile >= 0
      && !!GameMap.owner && tile < GameMap.owner.length;
  },

  // --- Entity resolution -----------------------------------------------------
  //
  // Each returns the entity or null. Null covers three cases that are
  // indistinguishable here and should be: the id never existed, the id has
  // ended (an attack folded into another by launchAttack's consolidation, a
  // boat that has landed, a warship that has sunk), or the id belongs to
  // someone else. All three drop the intent, and all three do so on every
  // client at once, because Game.attacks/boats/warships are sim state and are
  // therefore identical everywhere.
  //
  // The ownership half is authorship, not legality — see the header. It is
  // checked here rather than pushed into Game.retreatAttack/retreatBoat because
  // those are also called by the AI with an object it already owns by
  // construction, and giving them an actor argument they would ignore buys
  // nothing.
  _attack(id, playerId) {
    const a = Game.attackById(id);
    return a && a.attacker === playerId ? a : null;
  },

  _boat(id, playerId) {
    const b = Game.boatById(id);
    return b && b.attacker === playerId ? b : null;
  },

  _warship(id, playerId) {
    const w = Game.warshipById(id);
    return w && w.owner === playerId ? w : null;
  },

  _scout(id, playerId) {
    const s = Game.scoutById(id);
    return s && s.owner === playerId ? s : null;
  },

  // --- Dispatch --------------------------------------------------------------
  //
  // One handler per Protocol.INTENTS entry, keyed by wire type, each
  // `(playerId, intent) -> boolean`. The boolean is "did the simulation
  // change", and is for tests and for MP-1.3's turn log — nothing in the sim
  // branches on it, and a false is not an error.
  //
  // The comment on each case names the ui.js/radial.js call site it replaces,
  // matching Protocol.INTENTS' own `from` field, so MP-1.5's rewiring has the
  // same checklist read from both ends.
  HANDLERS: {

    // ui.js:350 Game.chooseSpawn. The actor is passed explicitly; chooseSpawn's
    // own default (Game.me) exists only for the pre-lockstep UI call and must
    // never be taken from here. spawnBlockReason does the rest — game started,
    // land, unclaimed, dense enough to hold a capital.
    spawn(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      return Game.chooseSpawn(it.tile, playerId);
    },

    // ui.js:530 Game.launchAttack. targetID may be Protocol.NEUTRAL_TARGET
    // (-1) for unclaimed land, which is launchAttack's own contract. Everything
    // else — troop floor, treasury, self-attack, an alliance holding the border
    // shut, a frontier that turns out to be empty — is already inside
    // launchAttack and returns false there. The troop count is absolute and
    // arrives on the wire: the ratio slider that produced it is client-local
    // view state (§4) and is not consulted here.
    //
    // `it.tile` is resolved to a landmassId here rather than shipping the id
    // itself: landmassId is derived, deterministic map data every client
    // already has, so sending the raw tile and re-deriving it is one fewer
    // thing that could disagree between clients. An off-map tile just means
    // no scoping (matches the AI's own unscoped calls) rather than a reject —
    // the tile is UI-derived and cannot itself make the attack illegal.
    attack(playerId, it) {
      const landmassId = Executor._tileOnMap(it.tile) ? GameMap.landmassId[it.tile] : null;
      return Game.launchAttack(playerId, it.targetID, it.troops, landmassId);
    },

    // ui.js:791 Game.retreatAttack. A cancel naming an id that has ended is the
    // expected case, not an error — see _attack.
    cancel_attack(playerId, it) {
      const a = Executor._attack(it.attackID, playerId);
      return a ? Game.retreatAttack(a) : false;
    },

    // radial.js:137 Game.launchNavalInvasion. navalInvasionBlockReason resolves
    // the landing tile from `dst` exactly as launchNavalInvasion will, so the
    // wire carries the raw clicked tile and the sim does the snapping — one
    // deterministic resolution on every client rather than one client's answer
    // shipped to the rest.
    boat(playerId, it) {
      if (!Executor._tileOnMap(it.dst)) return false;
      return Game.launchNavalInvasion(playerId, it.dst, it.troops);
    },

    // Game.launchPlane (game/paratroopers.js). Both tiles travel raw; the sim
    // checks the city and never reads the fog under `dst`.
    launch_plane(playerId, it) {
      if (!Executor._tileOnMap(it.city) || !Executor._tileOnMap(it.dst)) return false;
      return Game.launchPlane(playerId, it.city, it.dst, it.troops);
    },

    // ui.js:792 Game.retreatBoat.
    cancel_boat(playerId, it) {
      const b = Executor._boat(it.boatID, playerId);
      return b ? Game.retreatBoat(b) : false;
    },

    // ui.js:403/426/492 — one wire intent, three Game methods, because on the
    // wire all three are the same act: spend gold to put <unit> at <tile>.
    // Which method it becomes is exactly the branch Protocol's UNIT_TYPES
    // comment hands to this file.
    //
    // Note what is NOT here: the snapping ui.js does before it builds
    // (Render.findRailSnapTile for a city, nearestOwnedCoastNear for a port,
    // Render.findStructureNear promoting a tap on an existing structure into an
    // upgrade). Those are click interpretation — one of them literally reads
    // screen pixels — so they stay client-side and the resolved tile is what
    // travels. The Executor takes the tile it is given.
    build_unit(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      // Warship: not territory-bound and not in Game.buildings. buildWarship
      // picks the launching Port and the sea route itself
      // (resolveWarshipLaunch), so the click tile is a destination, not a
      // placement.
      if (it.unit === 'warship') return Game.buildWarship(playerId, it.tile);
      // Scout (fog of war, game/scouts.js): same shape, the tile is where to
      // send it. buildScout never looks at what the tile is, so that an order
      // into the fog cannot be refused for terrain; it refuses outright in a
      // fog-off match.
      if (it.unit === 'scout') return Game.buildScout(playerId, it.tile);
      // Atom/Hydrogen bomb: "strike here", resolved to the nearest ready Silo
      // by resolveNukeLaunch. Any tile is a legal target, own territory
      // included, matching OpenFront.
      if (it.unit === 'atombomb' || it.unit === 'hydrogenbomb') {
        return Game.launchNuke(playerId, it.unit, it.tile);
      }
      // MIRV (ticket #28): same "strike here" click, but it never lands in
      // this.nukes directly (see nukes.js's launchMirv/stepMirvs — it's a
      // mothership missile that splits into MIRVWarhead nukes on arrival),
      // so it gets its own Game method rather than reusing launchNuke.
      if (it.unit === 'mirv') {
        return Game.launchMirv(playerId, it.tile);
      }
      // Everything else is an ordinary territory-bound structure.
      return Game.build(playerId, it.unit, it.tile);
    },

    // ui.js:465 Game.upgrade. upgradeBlockReason covers ownership, whether the
    // type upgrades at all, still-building, already-upgrading and gold.
    upgrade_structure(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      return Game.upgrade(playerId, it.tile);
    },

    // ui.js:447 Game.moveWarships. The fleet arrives as ids because a warship
    // is an object in Game.warships and objects do not cross a wire; ids that
    // name nothing (sunk since the click) or name someone else's ship are
    // dropped from the list rather than failing the whole order, which is what
    // makes a fleet order behave sensibly when one ship dies in the ~100 ms
    // between the click and the turn. An order that resolves to no ships at all
    // is dropped before moveWarships so it cannot spend a seaPath on nothing.
    move_warship(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      const fleet = [];
      for (let i = 0; i < it.unitIds.length; i++) {
        const w = Executor._warship(it.unitIds[i], playerId);
        if (w) fleet.push(w);
      }
      if (fleet.length === 0) return false;
      return Game.moveWarships(fleet, it.tile, playerId);
    },

    // Game.moveScouts (fog of war, game/scouts.js). Same shape and the same
    // id handling as move_warship, kept as its own intent so the rules for
    // warships stay untouched: a Scout may be sent to any tile on the map,
    // discovered or not, land or water.
    move_scout(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      const scouts = [];
      for (let i = 0; i < it.unitIds.length; i++) {
        const s = Executor._scout(it.unitIds[i], playerId);
        if (s) scouts.push(s);
      }
      if (scouts.length === 0) return false;
      return Game.moveScouts(scouts, it.tile, playerId);
    },

    // ui.js:522 Game.annexEnclosedPockets. This game's own mechanic, no
    // OpenFront equivalent. The wire carries only the tapped tile and the
    // target nation is re-derived from GameMap.owner here, exactly as ui.js
    // does today — the map is sim state, so every client derives the same
    // nation, and shipping the id as well would just be a second thing that
    // could disagree with the first.
    //
    // Returns whether any ground actually changed hands. enclosedPocketsOf
    // already refuses a neutral/water/self target and a dead actor, so the two
    // guards here are only about not walking the defender's whole territory for
    // a tap that obviously cannot annex anything.
    annex_region(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      const target = GameMap.owner[it.tile];
      if (target < 0 || target === playerId) return false;
      return Game.annexEnclosedPockets(target, playerId) > 0;
    },

    // radial.js:122 Game.requestAlliance. canRequestAlliance holds the rules,
    // including the one that makes a request against someone who has already
    // asked you an immediate acceptance rather than a mirrored offer.
    allianceRequest(playerId, it) {
      return Game.requestAlliance(playerId, it.recipient);
    },

    // ui.js:845 Game.rejectAlliance. The wire names the *requestor*; the
    // request object itself is looked up from the pair, and it must be a
    // request addressed to the actor — you may only answer your own mail.
    // A request that has already timed out or been answered resolves to null
    // and the intent drops, which is the same no-op every client performs.
    allianceReject(playerId, it) {
      const req = Game.pendingRequest(it.requestor, playerId);
      if (!req) return false;
      Game.rejectAlliance(req);
      return true;
    },

    // ui.js:844 Game.acceptAlliance. Same lookup as allianceReject.
    allianceAccept(playerId, it) {
      const req = Game.pendingRequest(it.requestor, playerId);
      if (!req) return false;
      return Game.acceptAlliance(req);
    },

    // ui.js:868 / radial.js:114 Game.requestExtension. Renewal takes both
    // signatures; one side asking alone only records the offer.
    allianceExtension(playerId, it) {
      return Game.requestExtension(playerId, it.recipient);
    },

    // radial.js:107 Game.breakAlliance. Marks the breaker a traitor and costs
    // them standing with the neighbours — all inside breakAlliance.
    breakAlliance(playerId, it) {
      return Game.breakAlliance(playerId, it.recipient);
    },

    // radial.js Game.setEmbargo — OpenFront's EmbargoExecution. Legality
    // (self, dead, tribe) is embargoBlockReason's.
    embargo(playerId, it) {
      return Game.setEmbargo(playerId, it.targetID, it.action);
    },

    // radial.js Game.setEmbargoAll — EmbargoAllExecution, cooldown included.
    embargo_all(playerId, it) {
      return Game.setEmbargoAll(playerId, it.action);
    },

    // radial.js Game.donateGold — DonateGoldExecution. canDonate (ally gate,
    // cooldown) and the amount clamp (sender's balance) live in Game.donateGold
    // itself, matching every other donate/embargo-style call here.
    donate_gold(playerId, it) {
      return Game.donateGold(playerId, it.recipient, it.gold);
    },

    // radial.js Game.donateTroops — DonateTroopExecution. Same shape as
    // donate_gold; the recipient's headroom under their own troop cap is
    // clamped inside Game.donateTroops.
    donate_troops(playerId, it) {
      return Game.donateTroops(playerId, it.recipient, it.troops);
    },

    // radial.js Game.targetPlayer — TargetPlayerExecution. canTarget (ally
    // gate, spawn phase, cooldown) runs inside Game.targetPlayer.
    targetPlayer(playerId, it) {
      return Game.targetPlayer(playerId, it.target);
    },

    // New in §4 — the one intent with no existing call site (Protocol lists its
    // `from` as null) and, correspondingly, the one with no Game.* method
    // behind it yet. It is an intent rather than client-local bookkeeping
    // because a disconnected player's nation keeps existing in the simulation
    // and every client has to learn that on the same tick, which is precisely
    // what a turn is for.
    //
    // So all it does today is record the flag on the player. Nothing in the sim
    // reads it: MP-4.1 pairs it with the server's 30 s lastPing timeout and
    // decides what a disconnected nation actually does (OpenFront leaves it
    // standing and stops its input). Writing it now means the wire, the
    // Executor and the turn log are complete a phase before the behaviour
    // lands, and the field is plain sim state on Game.players so it will be
    // identical on every client when something finally does read it.
    mark_disconnected(playerId, it) {
      const p = Game.players[playerId];
      if (!p) return false;
      if (p.isDisconnected === !!it.isDisconnected) return false;
      p.isDisconnected = !!it.isDisconnected;
      return true;
    }
  },

  // --- Entry point -----------------------------------------------------------

  // Apply one server-stamped intent — `{ ...intent, clientID }` — to the
  // simulation. Returns true if the sim changed, false if the intent was
  // dropped for any reason at all. Never throws.
  //
  // Order matters: grammar first (cheapest, and a malformed intent has no
  // meaningful actor), then the actor, then the handler. The handler is where
  // legality is decided, by js/game/, not here.
  apply(stampedIntent) {
    // Grammar. Protocol owns shape and range; a failure here means the message
    // was malformed or hostile and it is dropped at the boundary (MP-4.3).
    if (Protocol.validateIntent(stampedIntent) !== null) return false;

    // Actor. A turn's intents always carry a stamped clientID
    // (Protocol.validateTurn enforces it); one that does not has bypassed the
    // server and has no authorship to check, so there is nobody to act as.
    const playerId = this.playerFor(stampedIntent.clientID);
    if (playerId < 0) return false;
    if (!Game.players || !Game.players[playerId]) return false;

    const handler = Object.prototype.hasOwnProperty.call(this.HANDLERS, stampedIntent.type)
      ? this.HANDLERS[stampedIntent.type] : null;
    // Unreachable while HANDLERS covers Protocol.INTENTS — validateIntent has
    // already rejected any type not in that table. Kept because the two tables
    // are edited independently and "an intent nobody handles" must fail the
    // same silent way as everything else rather than as a TypeError mid-turn.
    if (!handler) return false;

    return handler(playerId, stampedIntent) === true;
  },

  // Apply every intent of one turn, in the order the server bucketed them —
  // which is the same order on every client, and is the entire reason a turn is
  // an ordered list rather than a set. MP-1.3's GameRunner calls this and then
  // ticks the sim once; it lives here so the "intents, then exactly one tick"
  // pairing has one obvious home. Returns how many intents changed the sim.
  applyTurn(turn) {
    if (!turn || !Array.isArray(turn.intents)) return 0;
    let applied = 0;
    for (let i = 0; i < turn.intents.length; i++) {
      if (this.apply(turn.intents[i])) applied++;
    }
    return applied;
  }
};

// Dual export, same guarded shape as net/protocol.js — see its footer. Nothing
// in server/ needs the Executor (the server never simulates, §1), but the
// pattern is uniform across net/ so a file can move between the two sides
// without its footer becoming a question.
if (typeof module !== 'undefined' && module.exports) module.exports = Executor;
