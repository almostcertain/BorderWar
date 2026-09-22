// Wire protocol — the one file the browser client and the Node server both load
// (Task MP-1.1, docs/multiplayer-architecture.md §4).
//
// Under deterministic lockstep the server never simulates: it buckets *intents*
// into a Turn every TURN_INTERVAL_MS and broadcasts it, and every client runs
// the identical simulation over the identical turn stream. Nothing else crosses
// the wire. That makes the message and intent shapes the single interface
// between the two halves of the system, and the cheapest possible place to be
// wrong. So they live here, once, and both sides read the same definitions
// rather than two copies that drift.
//
// PURITY CONTRACT — this file must reference no game state and no browser.
// No Game, no GameMap, no Render, no UI, no Fx, no DOM, no window, no timers,
// no Math.random, no Date. It is data plus pure functions over its arguments.
// That is precisely what lets `require()` pull it into the server process
// unchanged (§3: "written to work under both a browser global and
// module.exports"). It is also the property most likely to be broken by
// accident, because "just check the tile is actually land" always looks like a
// helpful addition here. It is not. See validateIntent's comment on scope.
//
// Nothing uses this module yet. MP-1.2 (Executor), MP-1.3 (GameRunner) and
// MP-1.4 (Transport/LocalServer) are its consumers; MP-1.1 is definitions only.
const Protocol = {

  // --- Shared constants ------------------------------------------------------

  // One turn per 100 ms, from OpenFront's Config.msPerTick() === 100.
  //
  // This is not an independent knob: it is Game.TICK_DT (0.1 s, fixed in
  // MP-0.1) expressed in milliseconds, because in lockstep one turn is exactly
  // one Game.tick() call. §1: "They are the same number — one turn is exactly
  // one existing Game.tick(0.1) call." If one ever moves, the other must move
  // with it or the sim's internal clock stops matching the wire's.
  //
  // Deliberately not asserted against Game.TICK_DT here — that would mean
  // touching Game, and the purity contract above forbids it. The check belongs
  // in the Runner (MP-1.3), which legitimately sees both.
  TURN_INTERVAL_MS: 100,

  // Turns between client hash reports, per MP-4.2. The client digests its own
  // state with Hash.compute() every HASH_INTERVAL turns and sends it up; the
  // server tallies turn T-10's hashes every 10 turns and flags the minority.
  // 10 turns = 1 s of game time at the interval above.
  HASH_INTERVAL: 10,

  // GameServer's phases, from OpenFront's GameServer.ts. Carried here rather
  // than in the server so lobby UI (MP-2.3) can name them without duplicating
  // the strings.
  GAME_PHASE: { LOBBY: 'LOBBY', ACTIVE: 'ACTIVE', FINISHED: 'FINISHED' },

  // NEUTRAL from map.js, repeated as a literal because importing it would mean
  // depending on the game. An `attack` may legally target unclaimed land, and
  // this is the sentinel that says so on the wire. OpenFront's
  // AttackIntentSchema uses a nullable id for the same purpose; a numeric
  // sentinel is the right port here because this game's player ids are already
  // numeric indices into Game.players and NEUTRAL is already -1.
  NEUTRAL_TARGET: -1,

  // Grammar sanity ceilings. These are NOT game rules — they exist so a
  // garbled or hostile message is rejected at the schema boundary (MP-4.3)
  // instead of reaching the sim as a 2^40-tile index. Every one is far above
  // anything the game can actually produce: xlarge is 2,000,000 tiles, the
  // player roster tops out near 120 (31 bots + 80 tribes + humans), and a
  // late-game treasury of troops is in the millions.
  MAX_TILE_INDEX: 1 << 24,      // 16.7M — 8x the largest map
  MAX_PLAYER_ID: 4095,
  MAX_TROOPS: 1e12,
  MAX_UNIT_IDS: 1024,           // cap on move_warship's unitIds[]
  MAX_STRING: 256,              // usernames, ids, error text

  // Structure types Game.build/buildWarship/launchNuke accept, in the order
  // they appear in game/structures.js's build menu. `build_unit` is one intent covering
  // all three call sites (§4 lists ui.js:403/426/492 against it) because on
  // the wire they are the same act: "spend gold to put <unit> at <tile>".
  // Which Game.* method that becomes is the Executor's business (MP-1.2).
  UNIT_TYPES: [
    'city', 'factory', 'port', 'fort', 'warship',
    'silo', 'atombomb', 'hydrogenbomb', 'sam'
  ],

  // --- Field type vocabulary -------------------------------------------------
  //
  // Each entry is a pure predicate returning null (valid) or a fragment of an
  // error message, which validate() prefixes with the field name. Keeping the
  // vocabulary this small is deliberate: every intent field in §4 is a tile
  // index, a player id, an entity id, a troop count, a unit name or a boolean,
  // and a table that cannot express more than that cannot quietly grow game
  // rules into it.
  FIELD_TYPES: {
    // Tile index into GameMap.owner.
    tile(v, P) {
      if (!Number.isInteger(v)) return 'must be an integer tile index';
      if (v < 0) return 'must be a non-negative tile index';
      if (v > P.MAX_TILE_INDEX) return 'tile index out of range';
      return null;
    },

    // Index into Game.players.
    playerId(v, P) {
      if (!Number.isInteger(v)) return 'must be an integer player id';
      if (v < 0) return 'must be a non-negative player id';
      if (v > P.MAX_PLAYER_ID) return 'player id out of range';
      return null;
    },

    // A player id that may also be NEUTRAL (-1) — attack targets only.
    targetId(v, P) {
      if (!Number.isInteger(v)) return 'must be an integer player id';
      if (v < P.NEUTRAL_TARGET) return 'must be a player id or ' + P.NEUTRAL_TARGET + ' (neutral)';
      if (v > P.MAX_PLAYER_ID) return 'player id out of range';
      return null;
    },

    // Id of a live sim entity — an attack, a boat, a warship.
    //
    // NOTE for MP-1.2: attacks, boats and warships do not carry ids in the sim
    // today (Game.retreatAttack takes the attack *object*, moveWarships takes a
    // list of warship objects). §4 specifies ids on the wire because object
    // references cannot cross it and must be identical on every client. Minting
    // those ids deterministically is the Executor's task, not this file's; the
    // shape is fixed here so that work has something to aim at.
    entityId(v, P) {
      if (!Number.isInteger(v)) return 'must be an integer entity id';
      if (v < 0) return 'must be a non-negative entity id';
      if (v > P.MAX_TILE_INDEX) return 'entity id out of range';
      return null;
    },

    // Absolute troop count. OpenFront sends absolute counts, not a ratio —
    // §4: the troop-ratio slider stays client-local and its value travels
    // inside attack.troops. Non-integer is allowed: Game.players[].troops is a
    // float and ui.js floors it at the call site, so the wire does not need to
    // care which side of that floor a value is on.
    troops(v, P) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a finite number';
      if (v < 0) return 'must be non-negative';
      if (v > P.MAX_TROOPS) return 'troop count out of range';
      return null;
    },

    // One of UNIT_TYPES.
    unit(v, P) {
      if (typeof v !== 'string') return 'must be a string';
      if (P.UNIT_TYPES.indexOf(v) === -1) return 'unknown unit type "' + v + '"';
      return null;
    },

    bool(v) {
      return typeof v === 'boolean' ? null : 'must be a boolean';
    },

    // Non-empty array of entity ids. Non-empty matters: a move_warship naming
    // no warships is a bug on the sending side, and silently applying nothing
    // on every client hides it.
    entityIdList(v, P) {
      if (!Array.isArray(v)) return 'must be an array';
      if (v.length === 0) return 'must not be empty';
      if (v.length > P.MAX_UNIT_IDS) return 'too many ids (max ' + P.MAX_UNIT_IDS + ')';
      for (let i = 0; i < v.length; i++) {
        const err = P.FIELD_TYPES.entityId(v[i], P);
        if (err) return '[' + i + '] ' + err;
      }
      return null;
    },

    // Non-empty short string — gameID, username, persistentID, clientID.
    str(v, P) {
      if (typeof v !== 'string') return 'must be a string';
      if (v.length === 0) return 'must not be empty';
      if (v.length > P.MAX_STRING) return 'too long (max ' + P.MAX_STRING + ' chars)';
      return null;
    },

    // Turn number / any counter.
    uint(v, P) {
      if (!Number.isInteger(v)) return 'must be an integer';
      if (v < 0) return 'must be non-negative';
      return null;
    },

    // A 32-bit unsigned digest from Hash.compute(), or null when a turn
    // carries no hash (§4 types it `number|null`).
    hashValue(v) {
      if (v === null) return null;
      if (!Number.isInteger(v)) return 'must be an integer hash or null';
      if (v < 0 || v > 0xffffffff) return 'must be a uint32 hash';
      return null;
    },

    // A structured payload whose interior shape is owned elsewhere —
    // gameStartInfo (§4, built by GameServer.start) and lobby (built by the
    // lobby broadcast). Checked as "a plain JSON object" and no further, on
    // purpose: those shapes are the server's to define in MP-2.2, and
    // re-declaring them here would create a second authority to keep in sync.
    obj(v) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
      return null;
    }
  },

  // --- Intents ---------------------------------------------------------------
  //
  // The fifteen intents of §4. Every one already exists as a direct Game.*
  // call from ui.js / radial.js; the mapping is 1:1, and `from` records the
  // call site so MP-1.5's rewiring has a checklist.
  //
  // Wire names are OpenFront's own wherever OpenFront has the intent
  // (src/core/Schemas.ts). That is why the table mixes snake_case
  // (`cancel_attack`, `build_unit`, `move_warship`) with camelCase
  // (`allianceRequest`, `breakAlliance`) — the inconsistency is upstream's and
  // is kept deliberately so a future reader diffing against OpenFront source
  // finds the same strings. Do not tidy it. `annex_region` is the one intent
  // with no OpenFront equivalent: it is this game's own mechanic, and it is
  // named in the snake_case house style of the majority.
  //
  // Deliberately absent, per §4: targetPlayer, emoji, quick_chat, donate_gold,
  // donate_troops, embargo, embargo_all, delete_unit, kick_player, toggle_pause,
  // update_game_config. None has a mechanic in this game. fastForward and the
  // debug gold/nuke buttons are singleplayer-only and are hard disabled in
  // multiplayer rather than converted to intents.
  INTENTS: {
    spawn: {
      fields: { tile: 'tile' },
      from: 'ui.js:350 Game.chooseSpawn',
      openfront: 'SpawnIntentSchema'
    },
    attack: {
      // targetID may be NEUTRAL_TARGET for unclaimed land, matching
      // Game.launchAttack's own contract ("targetId may be NEUTRAL").
      // `tile` is a deliberate deviation from OpenFront's own AttackIntentSchema
      // (which carries no tile): it is the tapped tile, there so the sim can
      // scope the attack to the landmass actually touched rather than every
      // border the attacker shares with targetID across the whole map — see
      // Game.launchAttack's landmassId comment for why.
      fields: { targetID: 'targetId', troops: 'troops', tile: 'tile' },
      from: 'ui.js:530 Game.launchAttack',
      openfront: 'AttackIntentSchema (targetID nullable there; -1 here; no tile field there)'
    },
    cancel_attack: {
      fields: { attackID: 'entityId' },
      from: 'ui.js:791 Game.retreatAttack',
      openfront: 'CancelAttackIntentSchema'
    },
    boat: {
      fields: { dst: 'tile', troops: 'troops' },
      from: 'radial.js:137 Game.launchNavalInvasion',
      openfront: 'BoatAttackIntentSchema'
    },
    cancel_boat: {
      fields: { boatID: 'entityId' },
      from: 'ui.js:792 Game.retreatBoat',
      openfront: 'CancelBoatIntentSchema'
    },
    build_unit: {
      // One intent for three call sites — Game.build (structures),
      // Game.buildWarship, Game.launchNuke. See UNIT_TYPES.
      fields: { unit: 'unit', tile: 'tile' },
      from: 'ui.js:403/426/492 Game.buildWarship / Game.launchNuke / Game.build',
      openfront: 'BuildUnitIntentSchema'
    },
    upgrade_structure: {
      fields: { tile: 'tile' },
      from: 'ui.js:465 Game.upgrade',
      openfront: 'UpgradeStructureIntentSchema'
    },
    move_warship: {
      fields: { unitIds: 'entityIdList', tile: 'tile' },
      from: 'ui.js:447 Game.moveWarships',
      openfront: 'MoveWarshipIntentSchema (single unitId there; a list here — '
        + 'this game shift-selects a fleet and moves it as one order)'
    },
    annex_region: {
      // Ours. The click carries only a tile; the Executor re-derives the target
      // nation from GameMap.owner[tile] exactly as ui.js does today, which is
      // deterministic on every client and so needs nothing more on the wire.
      fields: { tile: 'tile' },
      from: 'ui.js:522 Game.annexEnclosedPockets / Game.annexRegion',
      openfront: null
    },
    allianceRequest: {
      fields: { recipient: 'playerId' },
      from: 'radial.js:122 Game.requestAlliance',
      openfront: 'AllianceRequestIntentSchema'
    },
    allianceReject: {
      fields: { requestor: 'playerId' },
      from: 'ui.js:845 Game.rejectAlliance',
      openfront: 'AllianceRequestReplyIntentSchema (accept:false)'
    },
    allianceAccept: {
      // OpenFront folds accept and reject into one reply intent with a boolean.
      // §4 keeps them explicit — two names read far better at the call site and
      // in a turn log than one name plus a flag, and the wire cost is nil.
      fields: { requestor: 'playerId' },
      from: 'ui.js:844 Game.acceptAlliance',
      openfront: 'AllianceRequestReplyIntentSchema (accept:true)'
    },
    allianceExtension: {
      fields: { recipient: 'playerId' },
      from: 'ui.js:868 / radial.js:114 Game.requestExtension',
      openfront: 'AllianceExtensionIntentSchema'
    },
    breakAlliance: {
      fields: { recipient: 'playerId' },
      from: 'radial.js:107 Game.breakAlliance',
      openfront: 'BreakAllianceIntentSchema'
    },
    mark_disconnected: {
      // New — no current call site. Paired with the server's 30 s lastPing
      // timeout (MP-4.1/§9 Phase 4): a disconnected player's nation keeps
      // existing in the sim, and every client has to learn that on the same
      // tick, so it travels as an intent like anything else.
      fields: { isDisconnected: 'bool' },
      from: null,
      openfront: 'MarkDisconnectedIntentSchema'
    }
  },

  // Fields every intent may carry beyond its own, and their types.
  //
  // clientID is server-stamped, never client-sent: GameServer.handleIntent does
  // `const stamped = { ...intent, clientID: actor.clientID }` (§4). It is
  // optional here rather than required because the same validator runs on both
  // sides of that stamping — the client validates before sending (no clientID)
  // and the Executor validates what came back in a Turn (clientID present).
  INTENT_COMMON: { type: 'str', clientID: 'str' },

  // --- Messages --------------------------------------------------------------
  //
  // §4's two tables in one map, keyed by wire type, with `dir` recording the
  // direction. `ping` appears in both directions with no payload, which is why
  // one table works at all; validateMessage takes an optional direction so a
  // side that cares can still reject a message travelling the wrong way.
  MESSAGES: {
    // Client -> Server
    join: {
      dir: 'c2s',
      fields: { gameID: 'str', username: 'str', persistentID: 'str' },
      optional: { spectator: 'bool' },
      notes: 'lobby only; the server assigns clientID'
    },
    rejoin: {
      dir: 'c2s',
      fields: { gameID: 'str', lastTurn: 'uint', persistentID: 'str' },
      notes: 'server replies `start` with turns.slice(lastTurn)'
    },
    intent: {
      dir: 'c2s',
      fields: { intent: 'intent' },
      notes: 'the payload is validated by validateIntent'
    },
    hash: {
      dir: 'c2s',
      fields: { turnNumber: 'uint', hash: 'hashValue' },
      notes: 'every HASH_INTERVAL turns; desync detection (MP-4.2)'
    },
    winner: {
      dir: 'c2s',
      fields: { winner: 'playerId' },
      notes: 'client-voted game end'
    },
    start_game: {
      dir: 'c2s',
      fields: { config: 'obj' },
      notes: 'MP-2.3: the lobby creator asks the server to leave LOBBY and begin '
        + 'the match. `config` bundles {mapSize, bots, tribes} — the host\'s own '
        + 'map/bot/tribe controls — because v1 has no live lobby-settings sync to '
        + 'non-host clients (architecture doc §9: "joiners see a read-only '
        + 'roster"), so the simplest correct design is to carry the config here '
        + 'rather than a separate settings-sync message. The server (GameServer.'
        + 'handleStartGame) checks the sender is creatorClientId and stage is '
        + 'LOBBY before honoring it; anyone else gets an `error` back, never a '
        + 'started match.'
    },

    // Server -> Client
    lobby_info: {
      dir: 's2c',
      fields: { lobby: 'obj', myClientID: 'str' },
      notes: 'broadcast while in the Lobby phase'
    },
    prestart: {
      dir: 's2c',
      fields: { mapSize: 'str', seed: 'uint' },
      notes: 'lets clients generate the map before the first turn arrives'
    },
    start: {
      dir: 's2c',
      fields: { turns: 'turnList', gameStartInfo: 'obj', myClientID: 'str' },
      notes: 'turns is the catch-up backlog — empty at a fresh start'
    },
    turn: {
      dir: 's2c',
      fields: { turn: 'turn' },
      notes: 'every TURN_INTERVAL_MS'
    },
    desync: {
      dir: 's2c',
      fields: {
        turn: 'uint',
        correctHash: 'hashValue',
        clientsWithCorrectHash: 'uint',
        totalActiveClients: 'uint',
        yourHash: 'hashValue'
      },
      notes: 'sent once to a client in the hash minority (MP-4.2)'
    },
    error: {
      dir: 's2c',
      fields: { error: 'str' },
      optional: { message: 'str' },
      notes: 'e.g. error:"full-lobby"'
    },

    // Both directions, no payload.
    ping: {
      dir: 'both',
      fields: {},
      notes: 'client sends every 5 s to keep lastPing fresh'
    }
  },

  // --- Constructors ----------------------------------------------------------
  //
  // Small factories producing plain, JSON-safe object literals — no classes, no
  // prototypes, no undefined values (JSON.stringify silently drops those, so an
  // optional field is *omitted* rather than set to undefined; that is what makes
  // every constructed object survive a JSON round trip unchanged).
  //
  // They exist so call sites read as intent names rather than object literals,
  // and so a typo'd field name is a missing function instead of a message that
  // validates as "unknown field".
  intent: {
    spawn(tile) { return { type: 'spawn', tile: tile }; },
    attack(targetID, troops, tile) { return { type: 'attack', targetID: targetID, troops: troops, tile: tile }; },
    cancelAttack(attackID) { return { type: 'cancel_attack', attackID: attackID }; },
    boat(dst, troops) { return { type: 'boat', dst: dst, troops: troops }; },
    cancelBoat(boatID) { return { type: 'cancel_boat', boatID: boatID }; },
    buildUnit(unit, tile) { return { type: 'build_unit', unit: unit, tile: tile }; },
    upgradeStructure(tile) { return { type: 'upgrade_structure', tile: tile }; },
    // The list is copied, not aliased: a caller passing
    // Array.from(UI.selectedWarships) must not be able to mutate an intent
    // that has already been queued for a turn.
    moveWarship(unitIds, tile) { return { type: 'move_warship', unitIds: unitIds.slice(), tile: tile }; },
    annexRegion(tile) { return { type: 'annex_region', tile: tile }; },
    allianceRequest(recipient) { return { type: 'allianceRequest', recipient: recipient }; },
    allianceReject(requestor) { return { type: 'allianceReject', requestor: requestor }; },
    allianceAccept(requestor) { return { type: 'allianceAccept', requestor: requestor }; },
    allianceExtension(recipient) { return { type: 'allianceExtension', recipient: recipient }; },
    breakAlliance(recipient) { return { type: 'breakAlliance', recipient: recipient }; },
    markDisconnected(isDisconnected) { return { type: 'mark_disconnected', isDisconnected: isDisconnected }; }
  },

  msg: {
    // Client -> Server
    join(gameID, username, persistentID, spectator) {
      const m = { type: 'join', gameID: gameID, username: username, persistentID: persistentID };
      if (spectator !== undefined) m.spectator = !!spectator;
      return m;
    },
    rejoin(gameID, lastTurn, persistentID) {
      return { type: 'rejoin', gameID: gameID, lastTurn: lastTurn, persistentID: persistentID };
    },
    intent(intent) { return { type: 'intent', intent: intent }; },
    hash(turnNumber, hash) { return { type: 'hash', turnNumber: turnNumber, hash: hash }; },
    winner(winner) { return { type: 'winner', winner: winner }; },
    startGame(config) { return { type: 'start_game', config: config }; },

    // Server -> Client
    lobbyInfo(lobby, myClientID) { return { type: 'lobby_info', lobby: lobby, myClientID: myClientID }; },
    prestart(mapSize, seed) { return { type: 'prestart', mapSize: mapSize, seed: seed }; },
    start(turns, gameStartInfo, myClientID) {
      return { type: 'start', turns: turns.slice(), gameStartInfo: gameStartInfo, myClientID: myClientID };
    },
    turn(turn) { return { type: 'turn', turn: turn }; },
    desync(turn, correctHash, clientsWithCorrectHash, totalActiveClients, yourHash) {
      return {
        type: 'desync', turn: turn, correctHash: correctHash,
        clientsWithCorrectHash: clientsWithCorrectHash,
        totalActiveClients: totalActiveClients, yourHash: yourHash
      };
    },
    error(error, message) {
      const m = { type: 'error', error: error };
      if (message !== undefined) m.message = message;
      return m;
    },

    // Both directions.
    ping() { return { type: 'ping' }; }
  },

  // A Turn: { turnNumber, intents: [ { ...intent, clientID } ], hash? }.
  // `hash` is omitted rather than nulled when absent, so the common case costs
  // nothing on the wire and the round trip is exact either way.
  turn(turnNumber, intents, hash) {
    const t = { turnNumber: turnNumber, intents: intents.slice() };
    if (hash !== undefined) t.hash = hash;
    return t;
  },

  // Server-side stamping, from GameServer.handleIntent:
  //   const stamped = { ...intent, clientID: actor.clientID }
  // A copy, never a mutation — the caller's intent may already be referenced by
  // something else, and an intent that changes identity after validation is a
  // whole class of bug this avoids for one allocation.
  stamp(intent, clientID) {
    const out = {};
    for (const k in intent) if (Object.prototype.hasOwnProperty.call(intent, k)) out[k] = intent[k];
    out.clientID = clientID;
    return out;
  },

  // --- Validation ------------------------------------------------------------
  //
  // SCOPE — read this before adding anything.
  //
  // These validators check SHAPE AND GRAMMAR ONLY: the type is known, required
  // fields are present, their JS types are right, numbers are finite and inside
  // sane ranges, non-empty arrays are non-empty, and no unexpected field rode
  // along. That is the whole job.
  //
  // They must NOT judge whether a move is LEGAL IN THE CURRENT GAME — whether
  // the tile is yours, whether you can afford the city, whether a peace deal
  // blocks the attack. That belongs to MP-1.2's Executor, which re-runs the
  // existing Game.*BlockReason validators inside the simulation, where the
  // state actually is and where every client reaches the same verdict on the
  // same tick. Two reasons the split matters:
  //
  //   1. Legality checks need Game, and this file must stay pure so the server
  //      can load it (see the header). One `Game.` reference here and the
  //      server crashes on require.
  //   2. Those rules already exist, once, in js/game/. A second copy here would
  //      drift from the first, and the version that disagreed with the sim
  //      would be the one rejecting the player's legitimate click.
  //
  // Grammar failure means the message is malformed or hostile: drop it at the
  // boundary (MP-4.3). Legality failure means the player asked for something
  // the game state does not allow: drop it silently in the Executor, on every
  // client identically. Different failures, different places.

  // Shared shape checker. `spec` is { fields, optional }; `common` names fields
  // allowed on anything of this kind (e.g. `type`). Returns null or a string.
  _validateShape(obj, spec, common, label) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return label + ' must be an object';
    }
    const fields = spec.fields || {};
    const optional = spec.optional || {};

    for (const name in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, name)) continue;
      if (!Object.prototype.hasOwnProperty.call(obj, name) || obj[name] === undefined) {
        return label + ' missing required field "' + name + '"';
      }
      const err = this._checkField(obj[name], fields[name], name, label);
      if (err) return err;
    }

    for (const name in optional) {
      if (!Object.prototype.hasOwnProperty.call(optional, name)) continue;
      if (!Object.prototype.hasOwnProperty.call(obj, name) || obj[name] === undefined) continue;
      const err = this._checkField(obj[name], optional[name], name, label);
      if (err) return err;
    }

    // No unexpected extras. Strictness here is cheap insurance: an intent that
    // carries a field nobody reads is either a version mismatch between the two
    // halves of this file's consumers or a client trying something, and both are
    // better as a loud rejection than as a field that silently does nothing.
    for (const name in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, name)) continue;
      if (Object.prototype.hasOwnProperty.call(fields, name)) continue;
      if (Object.prototype.hasOwnProperty.call(optional, name)) continue;
      if (common && Object.prototype.hasOwnProperty.call(common, name)) continue;
      return label + ' has unexpected field "' + name + '"';
    }

    return null;
  },

  // One field against one type name. The three structural types (intent, turn,
  // turnList) recurse rather than living in FIELD_TYPES, because they are
  // defined in terms of the validators below them.
  _checkField(value, type, name, label) {
    if (type === 'intent') {
      const err = this.validateIntent(value);
      return err ? label + ' field "' + name + '": ' + err : null;
    }
    if (type === 'turn') {
      const err = this.validateTurn(value);
      return err ? label + ' field "' + name + '": ' + err : null;
    }
    if (type === 'turnList') {
      if (!Array.isArray(value)) return label + ' field "' + name + '" must be an array';
      for (let i = 0; i < value.length; i++) {
        const err = this.validateTurn(value[i]);
        if (err) return label + ' field "' + name + '"[' + i + ']: ' + err;
      }
      return null;
    }
    const check = this.FIELD_TYPES[type];
    // Reaching here means the tables above name a type this file does not
    // define — a coding error in this file, not bad input. Say so plainly
    // rather than passing the value through unchecked.
    if (!check) return label + ' field "' + name + '" has unknown schema type "' + type + '"';
    const err = check(value, this);
    return err ? label + ' field "' + name + '" ' + err : null;
  },

  // Returns null when `intent` is a well-formed intent, otherwise a short
  // human-readable reason. Grammar only — see the scope note above.
  validateIntent(intent) {
    if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
      return 'intent must be an object';
    }
    if (typeof intent.type !== 'string' || intent.type.length === 0) {
      return 'intent missing "type"';
    }
    const spec = Object.prototype.hasOwnProperty.call(this.INTENTS, intent.type)
      ? this.INTENTS[intent.type] : null;
    if (!spec) return 'unknown intent type "' + intent.type + '"';

    // clientID, when present, must still be a sane string — it is stamped by
    // the server and read by the Executor to resolve the acting player.
    if (Object.prototype.hasOwnProperty.call(intent, 'clientID') && intent.clientID !== undefined) {
      const err = this.FIELD_TYPES.str(intent.clientID, this);
      if (err) return 'intent "' + intent.type + '" field "clientID" ' + err;
    }

    return this._validateShape(intent, spec, this.INTENT_COMMON, 'intent "' + intent.type + '"');
  },

  // Returns null when `turn` matches { turnNumber, intents[], hash? }.
  // Every intent inside must itself be well-formed and carry its stamped
  // clientID — a turn is what the server produced, not what a client proposed.
  //
  // Checked longhand rather than through _validateShape because `intents` is an
  // array of things validated by a different function, and adding a schema type
  // for "array of stamped intents" that only this one call site uses would buy
  // nothing but indirection.
  validateTurn(turn) {
    if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) return 'turn must be an object';

    if (!Number.isInteger(turn.turnNumber) || turn.turnNumber < 0) {
      return 'turn "turnNumber" must be a non-negative integer';
    }
    if (!Array.isArray(turn.intents)) return 'turn "intents" must be an array';
    for (let i = 0; i < turn.intents.length; i++) {
      const it = turn.intents[i];
      const err = this.validateIntent(it);
      if (err) return 'turn intents[' + i + ']: ' + err;
      if (typeof it.clientID !== 'string' || !it.clientID) {
        return 'turn intents[' + i + '] missing stamped "clientID"';
      }
    }
    if (Object.prototype.hasOwnProperty.call(turn, 'hash') && turn.hash !== undefined) {
      const err = this.FIELD_TYPES.hashValue(turn.hash, this);
      if (err) return 'turn "hash" ' + err;
    }
    for (const name in turn) {
      if (!Object.prototype.hasOwnProperty.call(turn, name)) continue;
      if (name === 'turnNumber' || name === 'intents' || name === 'hash') continue;
      return 'turn has unexpected field "' + name + '"';
    }
    return null;
  },

  // Returns null when `msg` is a well-formed protocol message. Pass `dir`
  // ('c2s' or 's2c') to also reject a message arriving from the wrong side —
  // the server calls it with 'c2s', the client with 's2c'.
  validateMessage(msg, dir) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return 'message must be an object';
    if (typeof msg.type !== 'string' || msg.type.length === 0) return 'message missing "type"';
    const spec = Object.prototype.hasOwnProperty.call(this.MESSAGES, msg.type)
      ? this.MESSAGES[msg.type] : null;
    if (!spec) return 'unknown message type "' + msg.type + '"';
    if (dir && spec.dir !== 'both' && spec.dir !== dir) {
      return 'message "' + msg.type + '" is ' + spec.dir + ', not expected here';
    }
    return this._validateShape(msg, spec, { type: 'str' }, 'message "' + msg.type + '"');
  }
};

// Dual export. This file is loaded two ways and must work under both:
//   - the browser, via index.html's document.write loader, where the top-level
//     `const Protocol` above is the global the rest of js/ reaches for, exactly
//     like Game / GameMap / Hash;
//   - Node, via `require('../js/net/protocol.js')` from server/, where that
//     const is module-scoped and this line is the only way out.
// Guarded on `module` so the browser, which has no such binding, does not throw
// on the reference. §3 specifies this shape; it is the first file in the
// codebase to use it, so later net/ modules shared with the server should copy
// this pattern verbatim rather than inventing another.
if (typeof module !== 'undefined' && module.exports) module.exports = Protocol;
