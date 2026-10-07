// Wire protocol: the one file the browser client and the Node server both
// load (docs/multiplayer-architecture.md §4). Only intents and turns cross
// the wire, so their shapes live here, once.
//
// PURITY CONTRACT: this file must reference no game state and no browser.
// No Game, GameMap, Render, UI, Fx, DOM, window, timers, Math.random or
// Date. It is data plus pure functions, which is what lets the server
// `require()` it unchanged. Do not add legality checks (see the SCOPE note
// above the validators).
const Protocol = {

  // --- Shared constants ------------------------------------------------------

  // One turn per 100 ms. This is Game.TICK_DT (0.1 s) in milliseconds: one
  // turn is exactly one Game.tick() call, so the two must move together.
  // Not asserted here, because that would mean touching Game.
  TURN_INTERVAL_MS: 100,

  // Turns between client hash reports (Hash.compute()). The server tallies
  // turn T-10's hashes every 10 turns and flags the minority.
  HASH_INTERVAL: 10,

  // GameServer's phases, from OpenFront's GameServer.ts. Carried here rather
  // than in the server so lobby UI (MP-2.3) can name them without duplicating
  // the strings.
  GAME_PHASE: { LOBBY: 'LOBBY', ACTIVE: 'ACTIVE', FINISHED: 'FINISHED' },

  // NEUTRAL from map.js, repeated as a literal because importing it would
  // mean depending on the game. An `attack` may target unclaimed land.
  NEUTRAL_TARGET: -1,

  // Grammar sanity ceilings, NOT game rules: they reject a garbled or
  // hostile message at the schema boundary. Each is far above anything the
  // game can produce.
  MAX_TILE_INDEX: 1 << 24,      // 16.7M — 8x the largest map
  MAX_PLAYER_ID: 4095,
  MAX_TROOPS: 1e12,
  MAX_UNIT_IDS: 1024,           // cap on move_warship's unitIds[]
  MAX_STRING: 256,              // usernames, ids, error text

  // Unit types `build_unit` accepts, in build-menu order. One intent for
  // all of them: 'spend gold to put <unit> at <tile>'. The Executor picks
  // the Game.* method.
  UNIT_TYPES: [
    'city', 'factory', 'port', 'fort', 'warship',
    'silo', 'atombomb', 'hydrogenbomb', 'sam', 'mirv', 'scout', 'drill', 'radio'
  ],

  // The procedural generator's lobby knobs, carried as config.mapGen on
  // `start_game` and in gameStartInfo (js/map.js's resolveGenOptions reads
  // them; docs/procedural-maps.md describes each). The first value of each is
  // the default.
  MAP_GEN: {
    landform: ['random', 'continent', 'twin', 'continents', 'archipelago', 'pangaea', 'inland'],
    land: ['normal', 'scarce', 'abundant'],
    terrain: ['normal', 'flat', 'rugged', 'alpine'],
    rivers: ['normal', 'none', 'few', 'many'],
    coast: ['normal', 'smooth', 'jagged']
  },

  // A whitelisted copy of `mapGen`: every knob present, anything unknown
  // replaced by its default, nothing extra passed through.
  normalizeMapGen(mapGen) {
    const src = mapGen && typeof mapGen === 'object' ? mapGen : {};
    const out = {};
    for (const key of Object.keys(this.MAP_GEN)) {
      const values = this.MAP_GEN[key];
      out[key] = values.includes(src[key]) ? src[key] : values[0];
    }
    return out;
  },

  // --- Field type vocabulary -------------------------------------------------
  //
  // Each entry is a pure predicate returning null (valid) or a fragment of an
  // error message, which validate() prefixes with the field name. Kept small
  // on purpose, so the table cannot grow game rules.
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

    // Id of a live sim entity: an attack, a boat, a warship. Ids, because
    // object references cannot cross the wire.
    entityId(v, P) {
      if (!Number.isInteger(v)) return 'must be an integer entity id';
      if (v < 0) return 'must be a non-negative entity id';
      if (v > P.MAX_TILE_INDEX) return 'entity id out of range';
      return null;
    },

    // Absolute troop count; the ratio slider stays client-local (§4).
    // Non-integer is allowed: troops is a float in the sim.
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

    // OpenFront's embargo "start" | "stop" action.
    embargoAction(v) {
      return v === 'start' || v === 'stop' ? null : 'must be "start" or "stop"';
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

    // A structured payload whose shape is owned elsewhere (gameStartInfo,
    // lobby). Checked only as 'a plain JSON object'; the server defines the rest.
    obj(v) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
      return null;
    }
  },

  // --- Intents ---------------------------------------------------------------
  //
  // Every intent maps 1:1 to a Game.* call; `from` records the original call
  // site.
  //
  // Wire names mix snake_case (`cancel_attack`, `build_unit`) with camelCase
  // (`allianceRequest`, `breakAlliance`). The inconsistency is deliberate and
  // on the wire. Do not tidy it.
  //
  // fastForward and the debug gold/nuke buttons are singleplayer-only and are
  // hard disabled in multiplayer rather than converted to intents.
  //
  // donate_gold / donate_troops send an absolute amount, resolved client-side,
  // so every client applies the same number.
  INTENTS: {
    spawn: {
      fields: { tile: 'tile' },
      from: 'ui.js:350 Game.chooseSpawn',
      openfront: 'SpawnIntentSchema'
    },
    attack: {
      // targetID may be NEUTRAL_TARGET for unclaimed land. `tile` is the
      // tapped tile, so the sim can scope the attack to the landmass touched
      // (see Game.launchAttack's landmassId comment).
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
    move_scout: {
      // Fog of war (docs/fog-of-war.md). Same shape as move_warship but a
      // separate intent: a Scout may be sent to any tile, a warship may not.
      fields: { unitIds: 'entityIdList', tile: 'tile' },
      from: 'Game.moveScouts',
      openfront: null
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
    embargo: {
      fields: { targetID: 'playerId', action: 'embargoAction' },
      from: 'radial.js Game.setEmbargo',
      openfront: 'EmbargoIntentSchema'
    },
    embargo_all: {
      fields: { action: 'embargoAction' },
      from: 'radial.js Game.setEmbargoAll',
      openfront: 'EmbargoAllIntentSchema'
    },
    donate_gold: {
      // `gold` reuses the `troops` field type — both are the same shape (a
      // finite non-negative number bounded by MAX_TROOPS), and adding a
      // same-shaped `gold` type would just be another name for it.
      fields: { recipient: 'playerId', gold: 'troops' },
      from: 'radial.js Game.donateGold',
      openfront: 'DonateGoldIntentSchema (recipient there is nullable-amount; here amount is always sent, see the note above)'
    },
    donate_troops: {
      fields: { recipient: 'playerId', troops: 'troops' },
      from: 'radial.js Game.donateTroops',
      openfront: 'DonateTroopIntentSchema (same nullable-amount note)'
    },
    targetPlayer: {
      // Ticket #30. Upstream's camelCase name, kept like allianceRequest's.
      fields: { target: 'playerId' },
      from: 'radial.js Game.targetPlayer',
      openfront: 'TargetPlayerIntentSchema'
    },
    mark_disconnected: {
      // Server-authored. A disconnected player's nation stays in the sim, and
      // every client has to learn of it on the same tick.
      fields: { isDisconnected: 'bool' },
      from: null,
      openfront: 'MarkDisconnectedIntentSchema'
    }
  },

  // Fields every intent may carry beyond its own. clientID is
  // server-stamped, never client-sent. Optional here because the same
  // validator runs before stamping (client) and after (Executor).
  INTENT_COMMON: { type: 'str', clientID: 'str' },

  // --- Messages --------------------------------------------------------------
  //
  // §4's two tables in one map, keyed by wire type; `dir` is the direction.
  // `ping` goes both ways. validateMessage takes an optional direction to
  // reject a message travelling the wrong way.
  MESSAGES: {
    // Client -> Server
    join: {
      dir: 'c2s',
      fields: { gameID: 'str', username: 'str', persistentID: 'str' },
      optional: { spectator: 'bool', public: 'bool', build: 'str' },
      notes: 'lobby only; the server assigns clientID. `public` (MP-5.1, narrow '
        + 'scope: issue #9) is only honored from the creator\'s own join — see '
        + 'GameServer.joinClient — the same "first joiner wins" rule as '
        + 'creatorClientId, so a later joiner cannot flip a lobby public/private.'
    },
    rejoin: {
      dir: 'c2s',
      fields: { gameID: 'str', lastTurn: 'uint', persistentID: 'str' },
      optional: { build: 'str' },
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
        + 'the match. `config` bundles {map, mapSize, mapGen, seed, bots, tribes} — the host\'s '
        + 'own map/bot/tribe controls (`map` is \'world\' or \'procedural\'; '
        + '`mapSize`, `mapGen` (see MAP_GEN) and `seed` only mean anything for the latter) — because v1 has no live '
        + 'lobby-settings sync to '
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
  // Small factories producing plain, JSON-safe object literals. An optional
  // field is omitted, never set to undefined, so every object survives a JSON
  // round trip unchanged.
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
    moveScout(unitIds, tile) { return { type: 'move_scout', unitIds: unitIds.slice(), tile: tile }; },
    annexRegion(tile) { return { type: 'annex_region', tile: tile }; },
    allianceRequest(recipient) { return { type: 'allianceRequest', recipient: recipient }; },
    allianceReject(requestor) { return { type: 'allianceReject', requestor: requestor }; },
    allianceAccept(requestor) { return { type: 'allianceAccept', requestor: requestor }; },
    allianceExtension(recipient) { return { type: 'allianceExtension', recipient: recipient }; },
    breakAlliance(recipient) { return { type: 'breakAlliance', recipient: recipient }; },
    embargo(targetID, action) { return { type: 'embargo', targetID: targetID, action: action }; },
    embargoAll(action) { return { type: 'embargo_all', action: action }; },
    targetPlayer(target) { return { type: 'targetPlayer', target: target }; },
    donateGold(recipient, gold) { return { type: 'donate_gold', recipient: recipient, gold: gold }; },
    donateTroops(recipient, troops) { return { type: 'donate_troops', recipient: recipient, troops: troops }; },
    markDisconnected(isDisconnected) { return { type: 'mark_disconnected', isDisconnected: isDisconnected }; }
  },

  msg: {
    // Client -> Server
    // `build` is the client's build id (tools/build-info.js); the server refuses
    // a join/rejoin whose build differs from its own, since lockstep needs one build.
    join(gameID, username, persistentID, spectator, isPublic, build) {
      const m = { type: 'join', gameID: gameID, username: username, persistentID: persistentID };
      if (spectator !== undefined) m.spectator = !!spectator;
      if (isPublic !== undefined) m.public = !!isPublic;
      if (build !== undefined) m.build = build;
      return m;
    },
    rejoin(gameID, lastTurn, persistentID, build) {
      const m = { type: 'rejoin', gameID: gameID, lastTurn: lastTurn, persistentID: persistentID };
      if (build !== undefined) m.build = build;
      return m;
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

  // Server-side stamping. A copy, never a mutation: the caller's intent
  // may be referenced elsewhere.
  stamp(intent, clientID) {
    const out = {};
    for (const k in intent) if (Object.prototype.hasOwnProperty.call(intent, k)) out[k] = intent[k];
    out.clientID = clientID;
    return out;
  },

  // --- Validation ------------------------------------------------------------
  //
  // SCOPE: these validators check SHAPE AND GRAMMAR ONLY (known type,
  // required fields, JS types, finite numbers in sane ranges, no unexpected
  // fields).
  //
  // They must NOT judge whether a move is LEGAL IN THE CURRENT GAME. That
  // belongs to the Executor, which runs the Game.*BlockReason validators
  // inside the simulation:
  //
  //   1. Legality checks need Game, and one `Game.` reference here crashes
  //      the server on require.
  //   2. The rules already exist, once, in js/game/. A second copy would drift.
  //
  // Grammar failure: drop at the boundary. Legality failure: drop silently in
  // the Executor, on every client identically.

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

    // No unexpected extras: an unread field is a version mismatch or a
    // client trying something, and is better rejected loudly.
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
  // Every intent inside must be well-formed and carry its stamped clientID.
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

// Dual export. Loaded two ways:
//   - the browser, via index.html's loader, where `const Protocol` is a global;
//   - Node, via `require('../js/net/protocol.js')` from server/.
// Guarded on `module` so the browser does not throw. Other net/ modules
// copy this pattern.
if (typeof module !== 'undefined' && module.exports) module.exports = Protocol;
