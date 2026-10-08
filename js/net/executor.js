// Intent -> simulation. The one and only path by which a player action
// mutates the game (docs/multiplayer-architecture.md §9 Phase 1).
//
// A validated intent arrives, an actor is resolved from it, and one Game.*
// method is called. Anything needing per-tick behaviour belongs in js/game/,
// not here. This code runs identically on every client from identical
// inputs; every rule below follows from that.
//
// THE THREE RULES
//
// 1. NEVER READ Game.me. It is a view pointer and differs on every client.
//    The actor is always resolved from the intent's server-stamped
//    `clientID` and passed explicitly to Game methods.
//
// 2. NOTHING NON-DETERMINISTIC. No Date, performance.now, Math.random, DOM
//    or rendering. Use Game.rng if randomness is ever needed.
//
// 3. REJECTION IS SILENT AND IDENTICAL. Bad grammar, an unknown entity id,
//    an illegal move, an unresolvable client: all drop, all return false,
//    none throw. A throw would abort the turn on one client and not another.
//
// LEGALITY IS NOT REIMPLEMENTED HERE. js/game/ owns the rules, in the
// *BlockReason validators and the mutators that call them. This file owns
// AUTHORSHIP only: that the actor cancelling an attack is the one who
// launched it.
const Executor = {

  // --- clientID -> playerId --------------------------------------------------
  //
  // Built from the server's `gameStartInfo.players` ([{clientID, username,
  // playerId}], §4), the same list on every client, which is what makes it
  // safe to consult inside the simulation.
  clientToPlayer: new Map(),

  // The stand-in clientID a single-player session stamps with, so intents built
  // before MP-3.1 still look exactly like intents built after it. MP-1.4's
  // LocalServer is the intended user.
  LOCAL_CLIENT_ID: 'local',

  // clientID -> index into Game.players, or -1 when it names nobody.
  // With no roster installed there is one human and they are player 0. Once
  // setRoster has been called, an unknown clientID resolves to -1 and its
  // intent is dropped.
  playerFor(clientID) {
    if (typeof clientID !== 'string' || clientID.length === 0) return -1;
    if (this.clientToPlayer.size === 0) return 0;
    const id = this.clientToPlayer.get(clientID);
    return id === undefined ? -1 : id;
  },

  // Install the roster. `entries` is any iterable of { clientID, playerId }.
  // Replaces wholesale: a partially-applied roster would desync.
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

  // A tile index that exists on THIS map. Protocol can only bound the
  // number against MAX_TILE_INDEX (it must not touch GameMap), so the
  // map-relative check lands here. A bounds check on a wire value, not a
  // game rule: without it launchNuke would fly a missile off the map.
  _tileOnMap(tile) {
    return Number.isInteger(tile) && tile >= 0
      && !!GameMap.owner && tile < GameMap.owner.length;
  },

  // --- Entity resolution -----------------------------------------------------
  //
  // Each returns the entity or null: the id never existed, has ended, or
  // belongs to someone else. All three drop the intent, identically on every
  // client. Ownership is checked here, not in Game.retreatAttack/retreatBoat,
  // because the AI calls those with objects it already owns.
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
  // `(playerId, intent) -> boolean`. The boolean is 'did the simulation
  // change'; nothing in the sim branches on it, and a false is not an error.
  HANDLERS: {

    // Game.chooseSpawn, with the actor passed explicitly (its Game.me
    // default must never be taken from here).
    spawn(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      return Game.chooseSpawn(it.tile, playerId);
    },

    // Game.launchAttack. targetID may be Protocol.NEUTRAL_TARGET (-1) for
    // unclaimed land. launchAttack does the legality checks. The troop count
    // is absolute; the ratio slider is client-local (§4).
    //
    // `it.tile` is resolved to a landmassId here, from map data every client
    // has. An off-map tile just means no scoping, not a reject.
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

    // Game.launchNavalInvasion. The wire carries the raw clicked tile and
    // the sim resolves the landing tile, identically on every client.
    boat(playerId, it) {
      if (!Executor._tileOnMap(it.dst)) return false;
      return Game.launchNavalInvasion(playerId, it.dst, it.troops);
    },

    // ui.js:792 Game.retreatBoat.
    cancel_boat(playerId, it) {
      const b = Executor._boat(it.boatID, playerId);
      return b ? Game.retreatBoat(b) : false;
    },

    // One wire intent, several Game methods: spend gold to put <unit> at
    // <tile>. Click snapping (rail, coast, tap-to-upgrade) stays client-side;
    // the Executor takes the tile it is given.
    build_unit(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      // Warship: buildWarship picks the launching Port and the sea route, so
      // the tile is a destination, not a placement.
      if (it.unit === 'warship') return Game.buildWarship(playerId, it.tile);
      // Scout (game/scouts.js): the tile is where to send it. buildScout
      // never looks at what the tile is, and refuses in a fog-off match.
      if (it.unit === 'scout') return Game.buildScout(playerId, it.tile);
      // Atom/Hydrogen bomb: "strike here", resolved to the nearest ready Silo
      // by resolveNukeLaunch. Any tile is a legal target, own territory
      // included, matching OpenFront.
      if (it.unit === 'atombomb' || it.unit === 'hydrogenbomb') {
        return Game.launchNuke(playerId, it.unit, it.tile);
      }
      // MIRV: a mothership that splits into warheads on arrival (see
      // nukes.js), so it has its own Game method.
      if (it.unit === 'mirv') {
        return Game.launchMirv(playerId, it.tile);
      }
      // The Drill (Battle Royale, game/drill.js): placed on the builder's own
      // land, instantly, never in Game.buildings. drillBlockReason holds the
      // one-per-match rule, so a second placement by anyone is refused here.
      if (it.unit === 'drill') return Game.placeDrill(playerId, it.tile);
      // Everything else is an ordinary territory-bound structure.
      return Game.build(playerId, it.unit, it.tile);
    },

    // ui.js:465 Game.upgrade. upgradeBlockReason covers ownership, whether the
    // type upgrades at all, still-building, already-upgrading and gold.
    upgrade_structure(playerId, it) {
      if (!Executor._tileOnMap(it.tile)) return false;
      return Game.upgrade(playerId, it.tile);
    },

    // Game.moveWarships. The fleet arrives as ids. Ids that name nothing
    // (sunk since the click) or someone else's ship are dropped from the list
    // rather than failing the order. An order left with no ships is dropped
    // before it can spend a seaPath.
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

    // Game.moveScouts (game/scouts.js). Same id handling as move_warship.
    // A Scout may be sent to any tile, discovered or not.
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

    // Game.annexEnclosedPockets. The wire carries only the tapped tile; the
    // target nation is re-derived from GameMap.owner here.
    //
    // Returns whether any ground changed hands. The two guards only avoid
    // walking the defender's territory for a tap that cannot annex anything.
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

    // Game.rejectAlliance. The wire names the *requestor*; the request is
    // looked up from the pair and must be addressed to the actor. A request
    // that has lapsed resolves to null and the intent drops.
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

    // Server-authored. An intent rather than client-local bookkeeping
    // because a disconnected player's nation stays in the simulation and
    // every client has to learn of it on the same tick. Records the flag on
    // the player, as plain sim state.
    mark_disconnected(playerId, it) {
      const p = Game.players[playerId];
      if (!p) return false;
      if (p.isDisconnected === !!it.isDisconnected) return false;
      p.isDisconnected = !!it.isDisconnected;
      return true;
    }
  },

  // --- Entry point -----------------------------------------------------------

  // Apply one server-stamped intent (`{ ...intent, clientID }`) to the
  // simulation. Returns true if the sim changed, false if the intent was
  // dropped for any reason. Never throws. Order: grammar, then the actor,
  // then the handler, where js/game/ decides legality.
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
    // Unreachable while HANDLERS covers Protocol.INTENTS. Kept so an intent
    // nobody handles fails silently rather than as a TypeError mid-turn.
    if (!handler) return false;

    return handler(playerId, stampedIntent) === true;
  },

  // Apply every intent of one turn, in the order the server bucketed them
  // (the same on every client). Runner calls this and then ticks the sim
  // once. Returns how many intents changed the sim.
  applyTurn(turn) {
    if (!turn || !Array.isArray(turn.intents)) return 0;
    let applied = 0;
    for (let i = 0; i < turn.intents.length; i++) {
      if (this.apply(turn.intents[i])) applied++;
    }
    return applied;
  }
};

// Dual export, as in the rest of net/ (see net/protocol.js's footer).
if (typeof module !== 'undefined' && module.exports) module.exports = Executor;
