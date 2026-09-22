// GameServer — the real lobby/relay/turn-loop object, per
// docs/multiplayer-architecture.md §6 and Task MP-2.2. Replaces MP-2.1's
// PlaceholderGame (which gamemanager.js used to instantiate) wholesale.
//
// §1's central rule, restated because it is the one thing every method below
// must keep being true: THE SERVER NEVER SIMULATES. This file never requires
// js/game/*.js, js/ai.js, js/map.js or any Runner/Executor — it only buckets
// intents into turns and relays them. Every client runs the identical sim
// over the identical turn stream and reaches the identical state on its own.
'use strict';

const Protocol = require('../js/net/protocol.js');
const Client = require('./client');
const log = require('./log');

// A player's name for log lines. Usernames come straight off the wire, so
// control characters (a newline would forge a log line) are stripped and the
// length capped.
function who(client) {
  const name = String(client.username).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32);
  return name + ' (#' + client.clientID + ')';
}

// MP-3.4: how often the ACTIVE-phase liveness sweep runs (see _sweepLiveness).
// A few seconds is plenty of granularity for detecting a 30s timeout — this
// loop is O(clients) per GameServer, same cost class as endTurn's own
// broadcast loop, and only runs while a match is ACTIVE (started in start(),
// stopped in end(), exactly like _turnIntervalID).
const LIVENESS_SWEEP_INTERVAL_MS = 3000;

// MP-4.3: per-client intent cap for one Protocol.TURN_INTERVAL_MS (100 ms)
// window, reset every endTurn() (see Client.intentsThisTurn / endTurn below).
// Per docs/multiplayer-architecture.md D2, this is NOT a security control —
// it exists to stop malformed/flooding traffic (a runaway script, a stuck
// input loop), not a determined cheater, who can still lie freely within the
// intent grammar. Real play is one discrete click per action, so even rapid
// double-clicking or a burst of radial-menu picks stays well under this in a
// single 100 ms window; the OpenFront reference (`ClientMsgRateLimiter.ts`)
// is the shape this follows, not a number ported verbatim.
const MAX_INTENTS_PER_CLIENT_PER_TURN = 20;

class GameServer {
  constructor(gameID) {
    this.gameID = gameID;
    this._tag = 'game ' + gameID; // log prefix
    this._startedAt = null;       // Date.now() when start() ran, for the end-of-game duration

    // Protocol.GAME_PHASE.{LOBBY, ACTIVE, FINISHED} — reused from protocol.js
    // rather than redefined here (§9 MP-2.2: "Protocol.GAME_PHASE already has
    // {LOBBY, ACTIVE, FINISHED} — use it, don't redefine it").
    this.stage = Protocol.GAME_PHASE.LOBBY;

    // Roster — clientID (string) -> Client. Iteration order is Map insertion
    // order, i.e. join order; start() and endTurn() both rely on that for
    // building gameStartInfo.players and for broadcast order (broadcast order
    // has no protocol meaning, but join order is the one guarantee it's
    // possible to make without extra bookkeeping).
    this.clients = new Map();

    // The full turn log. NEVER pruned — sendStartGameMsg-equivalent catch-up
    // (rejoinClient) and the eventual game record both read the whole thing.
    this.turns = [];

    // Current turn's intent buffer, cleared by endTurn.
    this.intents = [];

    // Sequential integer counter, assigned in join order, stringified for the
    // wire (every clientID-shaped field in protocol.js — INTENT_COMMON.clientID,
    // MESSAGES.start's myClientID, validateTurn's stamped clientID — is typed
    // 'str'). NOTE: this also doubles as the provisional `playerId` in
    // gameStartInfo.players below, because Game.init in the browser only
    // understands one human today (playerId 0). MP-3.1 owns the real
    // clientID -> playerId id-space once multi-human roster construction
    // lands; until then "join order" is the whole allocation scheme, on
    // purpose — no need for anything fancier per the task spec.
    this.nextClientId = 0;

    // Built by start(); null until then. Kept (not just used and discarded)
    // because rejoinClient's catch-up `start` message needs the exact same
    // object every client already has.
    this.gameStartInfo = null;

    // MP-2.3: the lobby creator. Set exactly once, in joinClient, the first
    // time a client successfully joins — "first one in owns the Start
    // button" is the whole rule (see joinClient below). There is
    // deliberately no transfer-host mechanic: if the creator disconnects
    // before starting, the lobby simply has no one left who can start it,
    // which is an accepted v1 limitation, not a bug to route around here.
    this.creatorClientId = null;

    // Issue #9: whether this lobby is listed in GET /lobbies. Only ever set
    // from the creator's own `join.public` (see joinClient) — same
    // first-joiner-wins rule as creatorClientId, so a later joiner can't flip
    // a lobby public/private after the fact. Defaults false (private,
    // matching architecture doc D4's v1 default).
    this.isPublic = false;

    this._turnIntervalID = null;

    // MP-3.4: the ACTIVE-phase ping-timeout sweep, started/stopped alongside
    // the turn interval in start()/end() — see _sweepLiveness.
    this._livenessIntervalID = null;

    // When an ACTIVE match last had no connected player, or null while anyone
    // is connected. Drives the abandoned-match cleanup in _sweepLiveness.
    this._emptySince = null;

    // MP-3.5: clientID -> winnerId, one vote per client. See recordWinnerVote.
    this.winnerVotes = new Map();

    // MP-4.2: turnNumber -> Map(clientID -> hash), one entry per turn that
    // still has an outstanding tally. A turn's entry is deleted the moment
    // _tallyHashes processes it (see that method) — there is never a need to
    // look at a turn's raw per-client hashes twice, so nothing here grows
    // without bound.
    this.hashReports = new Map();

    // MP-4.2: clientID -> true, once a client has been sent a `desync`
    // message. Checked by _tallyHashes so a client stuck in the minority (or
    // everyone, in the strict-majority-disagreement case) is told exactly
    // once for the whole match, per the task spec, rather than re-notified
    // every subsequent 10-turn check.
    this.desyncFlagged = new Set();

    // MP-4.2: the highest turn number _tallyHashes has already resolved.
    // recordHash uses this to drop a hash report that arrives for a turn
    // already tallied (a straggler past its window) instead of letting it
    // start a hashReports entry that would otherwise never be cleaned up.
    this._hashTalliedThrough = -1;
  }

  // --- Roster ------------------------------------------------------------

  // `client` is an already-constructed Client(ws) (GameManager builds it —
  // this method doesn't need to know how connections are constructed, only
  // how they join a roster). `opts` is { username, spectator } straight off
  // the validated `join` message.
  //
  // Rejects (closes the connection with a Protocol.msg.error) once the game
  // has left LOBBY — no mid-game joins in this task. Spectator support is a
  // documented stretch, not required: a spectator here still gets a roster
  // slot and receives turns, it's simply excluded from gameStartInfo.players
  // (see start()) since it has no nation to attach to.
  joinClient(client, opts) {
    opts = opts || {};

    if (this.stage !== Protocol.GAME_PHASE.LOBBY) {
      log.warn(this._tag, 'rejected join from "' + String(opts.username).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32)
        + '": game already started');
      Client.closeWithError(client.ws, 'game-already-started',
        'Game "' + this.gameID + '" has already left the lobby; no mid-game joins (MP-2.2 scope — see MP-3.4/4.1 for later join/reconnect work).');
      return null;
    }

    const numericId = this.nextClientId++;
    const clientID = String(numericId);
    client.clientID = clientID;
    client.username = opts.username;
    client.spectator = !!opts.spectator;
    client.active = true;
    this.clients.set(clientID, client);

    // First successful joiner becomes the creator/host. Deliberately the
    // whole rule — no explicit transfer mechanic (see the constructor note).
    if (this.creatorClientId === null) {
      this.creatorClientId = clientID;
      this.isPublic = !!opts.public;
    }

    log.info(this._tag, who(client) + ' joined'
      + (client.spectator ? ' as spectator' : '')
      + (clientID === this.creatorClientId ? ' (host)' : '')
      + ' - ' + this.clients.size + ' in lobby');
    this._broadcastLobbyInfo();
    return clientID;
  }

  // Best-effort rejoin against the message §4 (and the shipped
  // js/net/protocol.js) actually define today. Read this before touching it.
  //
  // THE GAP, stated plainly. js/net/protocol.js's `rejoin` message
  // (Protocol.MESSAGES.rejoin) DOES carry a `persistentID` string field —
  // Protocol.msg.rejoin(gameID, lastTurn, persistentID) accepts one as its
  // third argument, and validateMessage requires it. Verified directly
  // against the shipped file (2026-09-06):
  //
  //   node -e "const P=require('./js/net/protocol.js');
  //     console.log(P.MESSAGES.rejoin, P.msg.rejoin.length)"
  //   -> { dir:'c2s', fields:{ gameID:'str', lastTurn:'uint', persistentID:'str' }, ... } 3
  //
  // So the wire is not literally identity-less, and a task description
  // claiming otherwise would be wrong on this specific point — this is not
  // the invented field the task warned against adding; it already exists.
  //
  // What IS still missing, and is genuinely MP-4.1's job, not this one's:
  // this server has no store mapping a claimed persistentID to a previous
  // clientID/roster slot, and — per D2 (client-side cheating is an accepted
  // risk, no accounts, no auth) — no way to verify a presented persistentID
  // actually belongs to the connection presenting it even if such a store
  // existed. Building that trust model, wherever it ends up living (a
  // future protocol addition, a session token, something entirely
  // client-side), is what the architecture doc's task list scopes to
  // js/net/transport.js / js/net/runner.js under MP-4.1.
  //
  // So: this method does NOT attempt identity reunification. It does the one
  // thing §4 actually specifies mechanically for rejoin — "server replies
  // `start` with turns.slice(lastTurn)" — and hands the connection a *fresh*
  // clientID, exactly as if it were a late join that skips the "must be
  // LOBBY" gate. A rejoining browser client would not, today, resume
  // controlling its old nation; it would show up as a new, unrelated roster
  // entry with the turn-log backlog fast-forwarded to it. That is the honest
  // shape of "best-effort" here — flagged, not silently pretended to work.
  rejoinClient(ws, lastTurn) {
    if (this.stage === Protocol.GAME_PHASE.LOBBY) {
      log.warn(this._tag, 'rejected rejoin: game has not started');
      Client.closeWithError(ws, 'nothing-to-rejoin',
        'Game "' + this.gameID + '" has not started yet — send join, not rejoin.');
      return null;
    }

    const client = new Client(ws);
    const numericId = this.nextClientId++;
    const clientID = String(numericId);
    client.clientID = clientID;
    client.username = 'rejoined-' + clientID;
    client.spectator = false;
    client.active = true;
    this.clients.set(clientID, client);
    log.info(this._tag, who(client) + ' rejoined from turn ' + (Number.isInteger(lastTurn) ? lastTurn : 0));

    const turnNumber = (Number.isInteger(lastTurn) && lastTurn >= 0) ? lastTurn : 0;
    this._send(ws, Protocol.msg.start(this.turns.slice(turnNumber), this.gameStartInfo, clientID));
    return clientID;
  }

  // Remove a connection from the roster, or — once a match is ACTIVE — mark
  // it disconnected instead. Called by GameManager on the socket's `close`
  // event (a clean close) and, independently, by _sweepLiveness below (a
  // silent timeout); both funnel through here so the two detection paths
  // produce identical roster/sim behavior. Must never throw — a disconnect
  // mid-match is a routine event, not an error, and the turn loop (and every
  // other client) must keep running exactly as before.
  //
  // LOBBY: unchanged from MP-2.2/2.3 — hard-delete, broadcast updated lobby
  // info. There is no match running yet, so there is no nation to keep alive
  // and nothing for the sim to learn about.
  //
  // ACTIVE: the new path (MP-3.4). Do NOT delete the roster entry — MP-4.1's
  // eventual reconnect needs something to reconnect *to*, and deleting it now
  // would foreclose that. Instead hand off to _disconnectClient, which marks
  // the Client and injects the server-synthesized mark_disconnected(true)
  // intent every client's own Executor will apply identically on the next
  // turn (§1: the server never simulates, it only relays — this is the
  // server authoring an intent on a disconnected client's behalf, but it
  // still rides the exact same turn/broadcast/Executor pipeline as a
  // genuinely client-sent one).
  //
  // FINISHED (or any other stage): nothing meaningful happens to a finished
  // game's roster either way, so this falls through to the same hard-delete
  // LOBBY uses — simplest correct behavior, not a deliberately new rule.
  removeClient(clientID) {
    const client = this.clients.get(clientID);
    if (!client) return;

    if (this.stage === Protocol.GAME_PHASE.ACTIVE) {
      this._disconnectClient(client, 'connection closed');
      return;
    }

    client.active = false;
    this.clients.delete(clientID);
    log.info(this._tag, who(client) + ' left - ' + this.clients.size + ' in lobby');
    // Roster-changed broadcast (MP-2.3). _broadcastLobbyInfo no-ops once the
    // game has left LOBBY, so this is a no-op for a FINISHED-phase removal.
    this._broadcastLobbyInfo();
  }

  // Shared by removeClient's ACTIVE branch (a clean close) and
  // _sweepLiveness (a silent timeout) — the one place that actually marks a
  // client disconnected during an active match, so both detection paths
  // behave identically.
  //
  // Idempotent by construction: `client.active` is the roster-membership flag
  // ("still counted as a live participant"), already set true by
  // joinClient/rejoinClient and never touched anywhere else until this method
  // sets it false. Once false, a second call (e.g. the next sweep tick still
  // seeing this client before its interval-scoped skip) is a guarded no-op —
  // exactly the idempotency the timeout sweep requires.
  _disconnectClient(client, reason) {
    if (!client.active) return;
    client.active = false;
    log.info(this._tag, who(client) + ' disconnected (' + reason + ')');

    const intent = Protocol.stamp(Protocol.intent.markDisconnected(true), client.clientID);
    this.intents.push(intent);
  }

  // MP-3.4: the periodic ping-timeout sweep. Runs only while ACTIVE (started
  // in start(), cleared in end()), so there is no separate stage check here —
  // the interval's own lifecycle already scopes this to "ACTIVE-phase
  // clients", per the task's requirement.
  //
  // A client already disconnected (clean close, or a prior sweep tick) has
  // `active === false` and is skipped outright — see _disconnectClient's own
  // idempotency note. `Date.now() - client.lastPing` is measured against
  // `GameServer.disconnectedTimeout` (a static property, not a captured
  // module constant, specifically so a test can override it for faster
  // iteration without touching shipped source — see that property's comment).
  _sweepLiveness() {
    const now = Date.now();
    let anyActive = false;
    for (const client of this.clients.values()) {
      if (!client.active) continue;
      if (now - client.lastPing > GameServer.disconnectedTimeout) {
        this._disconnectClient(client, 'timed out, no ping for '
          + Math.round(GameServer.disconnectedTimeout / 1000) + 's');
      } else {
        anyActive = true;
      }
    }

    // A match nobody is connected to would otherwise tick empty turns and sit
    // in memory until the server restarts. Give people a window to reconnect
    // (a refresh or a network blip), then end it; GameManager.reap() removes
    // FINISHED games.
    if (anyActive) {
      this._emptySince = null;
    } else if (this._emptySince === null) {
      this._emptySince = now;
    } else if (now - this._emptySince > GameServer.abandonedTimeout) {
      this.end('abandoned, nobody connected for '
        + Math.round(GameServer.abandonedTimeout / 1000) + 's');
    }
  }

  // --- Intents -------------------------------------------------------------

  // Validate with Protocol.validateIntent first — grammar only, exactly as
  // the browser's Executor does; this server never runs Game and never will,
  // so it has no way to check legality and must not try to invent one.
  //
  // The server stamps clientID itself (Protocol.stamp), unconditionally
  // overwriting anything already on the incoming payload. INTENT_COMMON does
  // list `clientID` as an allowed field on an intent — that's so the *same*
  // validateIntent can also check a stamped intent coming back inside a Turn
  // — but an incoming client->server intent must never be trusted to carry
  // its own authorship. A client cannot forge whose action this is: even if
  // it bakes a spoofed clientID into the payload, Protocol.stamp replaces it
  // with this connection's real, server-assigned clientID before the intent
  // ever reaches `this.intents`.
  handleIntent(rawIntent, client) {
    const err = Protocol.validateIntent(rawIntent);
    if (err) return false; // malformed — dropped silently, never thrown

    // MP-4.3: per-client cap for this turn's intent buffer. Over the cap is
    // dropped the same way a malformed intent is — silently, no error to the
    // sender, no disconnect. See MAX_INTENTS_PER_CLIENT_PER_TURN above for
    // why this isn't a security control.
    if (client.intentsThisTurn >= MAX_INTENTS_PER_CLIENT_PER_TURN) return false;
    client.intentsThisTurn++;

    const stamped = Protocol.stamp(rawIntent, client.clientID);
    this.intents.push(stamped);
    return true;
  }

  // --- Winner vote (MP-3.5) -------------------------------------------------
  //
  // Every client computes Game.winnerId itself (sim-side, js/game/*.js) and
  // casts it here as a vote (§4 `winner`) — the server never simulates and
  // has no way to know who won on its own, per §1. This is a straightforward
  // strict-majority-of-active-clients tally, deliberately not full OpenFront
  // WinnerVote fidelity (no weighting, no spectator handling) — same scope
  // trade this project has made elsewhere (rejoin-by-identity, desync
  // tallying) rather than porting every detail.
  //
  // Votes are keyed by clientID so a client that changes its mind (should
  // never happen under lockstep, but nothing stops a resend) overwrites its
  // own prior vote instead of counting twice.
  recordWinnerVote(winnerId, client) {
    if (!client || !client.active) return; // stale/disconnected vote — never counts

    this.winnerVotes.set(client.clientID, winnerId);

    // Tally against CURRENTLY active clients only, every time a vote comes
    // in — not just the votes map's size — so a client that disconnects
    // after voting stops counting toward the denominator (and a disconnected
    // client's own stale vote, if it had one, is excluded from the numerator
    // too, via the `active` filter below). "Active" here reuses the same
    // roster flag MP-3.4 already maintains (joinClient/removeClient/
    // _disconnectClient), so a client that has cleanly left or timed out is
    // excluded exactly the way it already is from _sweepLiveness.
    const activeClients = Array.from(this.clients.values()).filter(c => c.active);
    if (activeClients.length === 0) return;

    const counts = new Map();
    for (const c of activeClients) {
      const v = this.winnerVotes.get(c.clientID);
      if (v === undefined) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }

    const majority = activeClients.length / 2;
    for (const [winner, count] of counts) {
      if (count > majority) {
        // Sim player ids: humans occupy 0..H-1 (see start()); anything higher
        // is an AI nation.
        const human = this.gameStartInfo && this.gameStartInfo.players.find((p) => p.playerId === winner);
        const label = human ? String(human.username).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 32) : 'AI nation ' + winner;
        this.end('won by ' + label + ' (' + count + '/' + activeClients.length + ' votes)');
        break;
      }
    }
  }

  // --- Desync detection (MP-4.2) --------------------------------------------
  //
  // Port of OpenFront's DesyncDetector in shape, not verbatim: every client
  // digests its own sim state (Hash.compute, js/net/hash.js) every
  // Protocol.HASH_INTERVAL turns and reports it up via `hash` (js/net/
  // runner.js's onHash -> Transport.sendHash -> the `hash` case in
  // server/gamemanager.js's dispatch, which calls recordHash below). §1
  // still holds: the server never simulates and has no way to know which
  // hash is "correct" on its own — the plurality among what clients actually
  // report is the only signal there is.

  // Record one client's reported hash for one turn. Pure bookkeeping —
  // _tallyHashes (driven by endTurn, every HASH_INTERVAL turns) is what
  // actually acts on this.
  //
  // A report for a turn number already tallied (a straggler arriving after
  // its window closed) is dropped rather than starting a fresh hashReports
  // entry that would never be cleaned up — see _hashTalliedThrough's
  // constructor comment.
  recordHash(turnNumber, hash, client) {
    if (!client || !client.active) return;
    if (!Number.isInteger(turnNumber) || turnNumber < 0) return;
    if (turnNumber <= this._hashTalliedThrough) return;

    let reports = this.hashReports.get(turnNumber);
    if (!reports) {
      reports = new Map();
      this.hashReports.set(turnNumber, reports);
    }
    reports.set(client.clientID, hash);
  }

  // Tally whatever hashes came in for `turnNumber` and act on them. Called
  // by endTurn() once per HASH_INTERVAL turns, for turnNumber == (the turn
  // just produced) - HASH_INTERVAL — by then every client has had a full
  // HASH_INTERVAL turns' worth of turn-broadcast round trips to have sent
  // its report, so this is "as many reports as are ever going to show up",
  // not a race against slow clients.
  //
  // Grouping rule (per the task spec, restated): the hash value with the
  // most reports is the plurality. If that plurality is also a STRICT
  // majority (more than half of reporting active clients), it's trusted as
  // "correct" and every client that reported something else is flagged. If
  // no hash value reaches a strict majority, the disagreement is too messy
  // to call — no single reported hash can be trusted as "correct" over the
  // others — so every reporting client is flagged instead.
  //
  // A client is only ever told once for the whole match (this.desyncFlagged
  // — never cleared, by design: a client that has already diverged has no
  // way to un-diverge under lockstep, so repeating the notice every 10 turns
  // would be pure noise).
  _tallyHashes(turnNumber) {
    if (turnNumber > this._hashTalliedThrough) this._hashTalliedThrough = turnNumber;

    const reports = this.hashReports.get(turnNumber);
    this.hashReports.delete(turnNumber);
    if (!reports || reports.size === 0) return; // nobody reported — nothing to tally

    // Only ever act against clients still active — a disconnected client's
    // stale report neither counts toward the tally nor can be notified (no
    // live socket), same "active" filter recordWinnerVote already uses.
    const counts = new Map(); // hash value -> count
    let totalReporting = 0;
    for (const [clientID, hash] of reports) {
      const client = this.clients.get(clientID);
      if (!client || !client.active) continue;
      counts.set(hash, (counts.get(hash) || 0) + 1);
      totalReporting++;
    }
    if (totalReporting === 0) return;

    let bestHash = null, bestCount = -1;
    for (const [hash, count] of counts) {
      if (count > bestCount) { bestHash = hash; bestCount = count; }
    }
    const hasStrictMajority = bestCount * 2 > totalReporting;

    for (const [clientID, hash] of reports) {
      const client = this.clients.get(clientID);
      if (!client || !client.active) continue;
      if (this.desyncFlagged.has(clientID)) continue;

      // Normal case (a trusted plurality exists): flag only the clients that
      // disagree with it. Messy case (no strict majority): flag everyone —
      // nobody's hash can be called "correct" over anyone else's.
      const flag = hasStrictMajority ? (hash !== bestHash) : true;
      if (!flag) continue;

      this.desyncFlagged.add(clientID);
      log.warn(this._tag, 'DESYNC: ' + who(client) + ' hash differs at turn ' + turnNumber
        + (hasStrictMajority
          ? ' (' + bestCount + '/' + totalReporting + ' clients agree on the other hash)'
          : ' (no majority among ' + totalReporting + ' clients)'));
      this._send(client.ws, Protocol.msg.desync(
        turnNumber,
        hasStrictMajority ? bestHash : null,
        hasStrictMajority ? bestCount : 0,
        totalReporting,
        hash
      ));
    }
  }

  // --- Lobby (MP-2.3) --------------------------------------------------------

  // Broadcast the current roster to everyone, while still in LOBBY. Called on
  // join and on disconnect (see joinClient/removeClient above) — the two
  // roster-changing events this task covers. A no-op once the game has left
  // LOBBY: ACTIVE/FINISHED games have no lobby screen left to update, and
  // MP-3.4 owns disconnect handling once a match is actually running.
  //
  // `lobby`'s shape is this file's to define (protocol.js's `obj` field type
  // deliberately checks nothing more than "is an object" — see its comment:
  // "those shapes are the server's to define"). Kept small and exactly what
  // the lobby screen needs: which game, who is host (so a client can compare
  // it against its own `myClientID`, itself carried alongside `lobby` rather
  // than inside it, per MESSAGES.lobby_info's own field list), and the
  // roster. Spectators are included here (unlike gameStartInfo.players,
  // which excludes them) because a spectator is still a lobby member people
  // should see waiting.
  _broadcastLobbyInfo() {
    if (this.stage !== Protocol.GAME_PHASE.LOBBY) return;

    const lobby = {
      gameID: this.gameID,
      creatorClientId: this.creatorClientId,
      players: Array.from(this.clients.values()).map((c) => ({
        clientID: c.clientID,
        username: c.username,
        spectator: c.spectator
      }))
    };

    for (const client of this.clients.values()) {
      this._send(client.ws, Protocol.msg.lobbyInfo(lobby, client.clientID));
    }
  }

  // The `start_game` message's handler (MP-2.3, closing the gap MP-2.2 left:
  // "there is no wire message for 'the host wants to start'"). Called by
  // GameManager's per-connection dispatch — see server/gamemanager.js's
  // `_handleMessage`, which added one case for this alongside its existing
  // intent/hash/winner/ping cases and delegates entirely to this method; all
  // the actual authorization/config logic lives here, not there.
  //
  // Authorization is exactly two checks: the sender must BE the recorded
  // creator, and the game must still be in LOBBY. Anything else is rejected
  // cleanly — an `error` message back over the same (still-open) connection,
  // not a closed socket — so a non-host's accidental double-click or a
  // deliberately hostile message doesn't look like a network failure to a
  // legitimate lobby member, and never crashes the server or silently starts
  // the match for the wrong client. Per D2/§9 Phase 4 (MP-4.3), this is
  // authorization hygiene, not a security control: a modified client could
  // still misbehave once a match is running, same as it always could.
  handleStartGame(config, client) {
    if (!client || client.clientID !== this.creatorClientId) {
      this._send(client && client.ws, Protocol.msg.error(
        'not-host', 'Only the lobby creator can start the match.'));
      return;
    }
    if (this.stage !== Protocol.GAME_PHASE.LOBBY) {
      this._send(client.ws, Protocol.msg.error(
        'already-started', 'This game has already left the lobby.'));
      return;
    }
    this.start(config);
  }

  // --- Lifecycle -----------------------------------------------------------

  // Build gameStartInfo in the exact shape LocalServer.start synthesizes
  // (js/net/localserver.js) — `{ gameID, seed, config: { mapSize, bots,
  // tribes }, players: [{ clientID, username, playerId }] }` — from the
  // current roster plus a fresh random seed and whatever map/bot/tribe
  // config is handed in (MP-2.3's lobby UI supplies it for real now, via
  // handleStartGame above; a bare call with a plausible default still works
  // for tests, as it always did).
  //
  // THE OTHER GAP mentioned in an earlier draft of this comment — "there is
  // no wire message for 'the host wants to start'" — is closed: that is
  // `start_game` (protocol.js) plus handleStartGame above, which is the only
  // caller of this method from real traffic. start() itself stays a plain,
  // ungated method (no LOBBY/creator check of its own) precisely so it is
  // still directly callable from tests without going through the wire.
  start(config) {
    if (this.stage !== Protocol.GAME_PHASE.LOBBY) return; // no-op; already started/finished
    config = config || {};

    const seed = Number.isInteger(config.seed)
      ? (config.seed >>> 0)
      : (Math.floor(Math.random() * 0x100000000) >>> 0);

    const players = [];
    for (const client of this.clients.values()) {
      if (client.spectator) continue;
      players.push({
        clientID: client.clientID,
        username: client.username,
        // Roster position, not the clientID counter: Game.init places humans
        // in slots 0..H-1, and clientIDs stop being contiguous the moment
        // anyone leaves and re-joins the lobby.
        playerId: players.length
      });
    }

    this.gameStartInfo = {
      gameID: this.gameID,
      seed: seed,
      config: {
        mapSize: config.mapSize || 'medium',
        bots: Number.isInteger(config.bots) ? config.bots : 0,
        tribes: Number.isInteger(config.tribes) ? config.tribes : 0,
        // Unknown values fall back to Medium in Game.init as well; whitelisted
        // here so the broadcast gameStartInfo only ever carries a real tier.
        difficulty: ['easy', 'medium', 'hard'].includes(config.difficulty) ? config.difficulty : 'medium'
      },
      players: players
    };

    this.stage = Protocol.GAME_PHASE.ACTIVE;
    this._startedAt = Date.now();
    const cfg = this.gameStartInfo.config;
    log.info(this._tag, 'started: ' + players.length + ' player' + (players.length === 1 ? '' : 's')
      + (this.clients.size > players.length ? ' + ' + (this.clients.size - players.length) + ' spectator(s)' : '')
      + ', map ' + cfg.mapSize + ', ' + cfg.bots + ' bots, ' + cfg.tribes + ' tribes, '
      + cfg.difficulty + ' difficulty');
    this._turnIntervalID = setInterval(() => this.endTurn(), Protocol.TURN_INTERVAL_MS);
    // MP-3.4: liveness sweep runs for exactly the ACTIVE-phase lifetime,
    // stopped alongside the turn interval in end() below.
    this._livenessIntervalID = setInterval(() => this._sweepLiveness(), LIVENESS_SWEEP_INTERVAL_MS);

    // `myClientID` is per-recipient — everything else in the message is
    // identical for everyone, so gameStartInfo/turns are built once above and
    // reused for every send.
    for (const client of this.clients.values()) {
      this._send(client.ws, Protocol.msg.start(this.turns, this.gameStartInfo, client.clientID));
    }
  }

  // §6's four lines, unchanged: snapshot the buffered intents into a turn,
  // push it to the (never-pruned) log, clear the buffer, broadcast.
  endTurn() {
    const pastTurn = Protocol.turn(this.turns.length, this.intents);
    this.turns.push(pastTurn);
    this.intents = [];

    const msg = Protocol.msg.turn(pastTurn);
    for (const client of this.clients.values()) {
      this._send(client.ws, msg);
      // MP-4.3: this turn's window has closed — reset the per-client intent
      // cap (Client.intentsThisTurn) for the next one.
      client.intentsThisTurn = 0;
    }

    // MP-4.2: every HASH_INTERVAL turns, tally the hashes reported for the
    // turn HASH_INTERVAL turns ago — see _tallyHashes for why that window
    // (not "right now") is the one that's actually done collecting reports.
    // Skipped for turn 0 (0 % anything === 0, but there is no turn -10).
    if (pastTurn.turnNumber > 0 && pastTurn.turnNumber % Protocol.HASH_INTERVAL === 0) {
      this._tallyHashes(pastTurn.turnNumber - Protocol.HASH_INTERVAL);
    }
  }

  // Stop the interval(s) and transition to FINISHED. Idempotent. `reason` is
  // only for the log line.
  end(reason) {
    if (this.stage === Protocol.GAME_PHASE.ACTIVE) {
      const secs = this._startedAt === null ? 0 : Math.round((Date.now() - this._startedAt) / 1000);
      log.info(this._tag, 'ended: ' + (reason || 'ended')
        + ' - ' + Math.floor(secs / 60) + 'm' + String(secs % 60).padStart(2, '0') + 's, '
        + this.turns.length + ' turns');
    }
    if (this._turnIntervalID !== null) {
      clearInterval(this._turnIntervalID);
      this._turnIntervalID = null;
    }
    if (this._livenessIntervalID !== null) {
      clearInterval(this._livenessIntervalID);
      this._livenessIntervalID = null;
    }
    this.stage = Protocol.GAME_PHASE.FINISHED;
  }

  // --- Outbound --------------------------------------------------------------

  // Validated on the way out for the same reason LocalServer._emit validates
  // (js/net/localserver.js) — this object stands in for "a server" in tests
  // exactly as LocalServer stands in for one in the browser, and a message
  // shape mismatch is better caught here, loudly, than shipped to a client
  // that has only ever been tested against well-formed traffic.
  _send(ws, msg) {
    if (Protocol.validateMessage(msg, 's2c') !== null) {
      log.error(this._tag, 'refused to send a malformed message: ' + JSON.stringify(msg));
      return;
    }
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      // Socket died between the readyState check and send() — routine under
      // a flaky connection, not a crash.
    }
  }
}

// MP-3.4: OpenFront's own `disconnectedTimeout` constant (docs §6/§9's
// MP-3.4 entry) — how long a client can go silent (no message of any kind,
// see gamemanager.js's liveness update) before _sweepLiveness treats it as
// disconnected. A static property on the class, not a module-scoped const,
// so a test can lower it for fast iteration (`GameServer.disconnectedTimeout
// = 500`) without editing shipped source; every GameServer instance reads it
// live off the class at sweep time rather than capturing a value at
// construction.
GameServer.disconnectedTimeout = 30000;

// How long an ACTIVE match may have no connected players before the server
// ends it and lets it be reaped. Static, like disconnectedTimeout, so a test
// can shorten it.
GameServer.abandonedTimeout = 2 * 60 * 1000;

module.exports = GameServer;
