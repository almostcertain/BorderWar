# Multiplayer Architecture — BorderWar

> **STATUS (2026-09-07): Phases 0–4 complete.** Deterministic lockstep multiplayer works
> end-to-end over a real server. Deployment (domain + Cloudflare Tunnel, §6.1) not yet
> executed. The task-by-task record is in `docs/multiplayer-build-log.md`.

## Quick reference

Read this first; open the numbered sections only for the part you're changing.

- **Model (§1):** lockstep. Server never simulates; it buckets intents into a `Turn`
  every 100 ms and broadcasts. One turn = one `Game.tick()`. Bots, Tribes and the map
  all run/generate on every client from the seed.
- **One code path (§2):** singleplayer runs through the same pipeline via `LocalServer`.
  Never add a separate direct-mutation path.
- **Files (§3):** `js/net/` — `protocol.js` (shapes + validation, copied to
  `server/protocol.js`), `transport.js` (WS or LocalServer), `localserver.js`,
  `runner.js` (turn queue), `executor.js` (the only sim mutation entry), `hash.js`.
  `server/` — `index.js`, `gamemanager.js`, `gameserver.js`, `client.js`.
- **Wire (§4):** JSON, OpenFront message names. Server stamps `clientID` on intents.
  New player actions need an intent type in `protocol.js` and a case in `executor.js`.
- **Client loop (§5):** sim driven by turn arrival under a ~8 ms budget; render is free-running.
- **Server (§6):** single process, in-memory turn log (restart kills matches),
  `persistentID` per browser, no accounts. Host's client is not special.
- **Decisions (§0) and divergences (§8)** are settled — don't relitigate them.

Target: match OpenFront.io's networking model as closely as this codebase allows.
Grounded in real OpenFront source (`src/core/Schemas.ts`, `src/client/Transport.ts`,
`src/client/LocalServer.ts`, `src/client/ClientGameRunner.ts`, `src/core/GameRunner.ts`,
`src/server/GameServer.ts`, `src/server/DesyncDetector.ts`, `src/core/configuration/Config.ts`),
fetched 2026-08-30 per the verbatim-fetch practice in `feedback-openfront-source-porting`.

---

## 0. Decisions taken

Settled by the project owner on 2026-08-30. These are answers, not open questions —
do not relitigate them mid-build. Anything that contradicts one of these is a bug in the
task, not a judgement call.

**D1 — The spawn phase becomes a fixed timed window, in singleplayer too.**
Matches ship the same start flow in both modes. Durations follow OpenFront's own
(`numSpawnPhaseTurns()`): **100 turns (10 s) singleplayer, 150 turns (15 s) multiplayer (originally 300 / 30 s, shortened by request)**
— the two modes share the mechanic, not the duration, because a solo player has nobody to
wait for. Explicitly rejected: keeping the current "match begins the instant the human
clicks" flow for singleplayer only. Two start flows would reintroduce exactly the
split-codebase problem the whole design exists to avoid. Drives **MP-3.2**.

**D2 — Client-side cheating is an accepted risk.**
The client is authoritative over its own view of the world, as in OpenFront. We validate
intent *authorship* and *grammar* and nothing more. Do not add anti-cheat scope, and do
not describe the rate limiting in MP-4.3 as a security control — it stops malformed and
impersonated traffic, not a determined cheater. Revisit only if ranked or competitive
play is ever on the table.

**D3 — Self-hosted on the owner's machine. No cloud.**
See §6.1. This is a deployment choice only; it does not touch the architecture.
Drives **MP-2.4** and a wire-origin detail in **MP-2.1**.

**D4 — Private lobbies only for v1, plus two opt-in public exceptions.**
Host creates a game, shares the `gameID` as a join code, friends join, host starts. No
matchmaking, no accounts. Two narrow, later exceptions to that default (see MP-5.1 below):
issue #9 lets a host flag their own lobby public so it appears in a list on the Join
screen, still host-initiated; issue #12 adds a single always-open, host-less lobby the
server itself creates, fills, and auto-starts on a timer, then replaces. Neither adds
accounts or matchmaking in the OpenFront `Master.ts`/`MapPlaylist.ts` sense — there is no
scheduler picking maps on a fixed cadence, just one rotating slot.

**Out of scope for v1, per D2/D4 and §4:** accounts, matchmaking, public lobby lists,
chat, emoji, gold/troop donation, embargoes, player reports, telemetry, anti-cheat.
Each is cheap to add on this architecture *after* v1 ships and expensive to add during it.

---

## 1. The model

**Deterministic lockstep. The server never simulates.**

OpenFront's server is a turn relay plus a lobby. It collects *intents* from clients,
buckets them into a `Turn` every 100 ms, and broadcasts the turn to everyone. Every
client runs the identical simulation over the identical turn stream from the identical
seed and arrives at the identical state. Nothing but intents crosses the wire — no tile
data, no player state, no snapshots, no deltas.

Consequences that drive every task below:

- Bots and Tribes run **on every client**, not on the server. They are part of the sim.
- The map is generated from the seed on every client. It is never transmitted.
- A player's action is not applied when they click it. It is sent as an intent, comes
  back in a turn ~1 RTT later, and is applied by every client on the same tick.
- Anything non-deterministic anywhere in the sim splits the game permanently.
- Cheating is possible in principle (every client holds full state); OpenFront accepts
  this and only validates intent *authorship*. We do the same.

**Turn rate.** OpenFront's `Config.msPerTick()` is `100`. This game's `main.js` already
steps the sim at a fixed `STEP = 0.1`. They are the same number — one turn is exactly
one existing `Game.tick(0.1)` call. That correspondence is the reason this port is
tractable at all; preserve it.

---

## 2. The single most important structural move

OpenFront runs **singleplayer through the multiplayer code path**. `Transport` has an
`isLocal` flag; when set it instantiates `LocalServer`, which implements the same
interface as the socket: it buckets intents on a `setInterval`, emits `{type:"turn"}`
messages back into the same `onmessage` handler, and the client cannot tell the
difference. There is exactly one game loop, one intent pipeline, one turn queue.

We do the same. Phase 1 below converts the *existing singleplayer game* to run on the
intent/turn pipeline with a `LocalServer` shim, with no network involved. That phase is
independently shippable and testable, and once it lands, adding the real server is
mostly transport plumbing.

Do not build a parallel "multiplayer mode" beside the existing direct-mutation
singleplayer path. That is the failure mode this design exists to avoid.

---

## 3. Target file layout

```
js/
  net/
    protocol.js      Message + intent shapes, validation, one shared file (browser + node)
    transport.js     Transport: WebSocket or LocalServer, buffering, reconnect, ping
    localserver.js   LocalServer: singleplayer turn bucketer, same interface as socket
    runner.js        GameRunner: turn queue, executes turns into the sim, emits hashes
    executor.js      applyIntent(intent) -> mutates Game; the ONLY sim mutation entry
    hash.js          Deterministic state digest
  game/              The simulation, split out of the former js/game.js (see
                     docs/archive/game-split-plan.md). One `Game` singleton, extended per domain
                     with Object.assign; loaded in this order:
    shared.js        Top-level globals (PLAYER_COLORS, formatCount, mulberry32, detQuantize, ...)
    core.js          `const Game = {...}`: all mutable state, init, spawn phase, setOwner, tick order
    structures.js    UNITS table, build/upgrade/construction
    economy.js       Population model, gold
    diplomacy.js     Alliances, traitors, relations
    attacks.js       Attack lifecycle and the conquest frontier
    combat.js        Attack math, forts, terrain, fallout
    annex.js         Region annexation
    seapath.js       A* water pathing
    naval.js         Boats, coast lookup, invasions
    rail.js          Rail network and trains
    trade.js         Trade ships
    warships.js      Warships and shells
    nukes.js         Nukes and detonation
    sam.js           SAM launchers and interceptors
  ...existing files (ai.js, map.js, render.js, ui.js, ...)
tools/
  sim-harness.js     Headless golden-trace determinism suite (node tools/sim-harness.js compare)
  golden/            Recorded goldens for the harness
server/
  index.js           HTTP static + WS upgrade, single process
  gamemanager.js     gameID -> GameServer
  gameserver.js      Lobby/Active/Finished, roster, turn interval, broadcast, desync
  client.js          Per-connection: clientID, persistentID, ws, hashes, lastPing
  package.json       one dep: ws
docs/
  multiplayer-architecture.md   (this file)
```

`index.html` loads `js/net/*.js` via the existing `document.write` cache-bust list.
`server/protocol.js` is a copy of `js/net/protocol.js` written to work under both a
browser global and `module.exports` (a top-level object literal, with a guarded
`module.exports` at the bottom).

No build step. Node's `ws` is the only dependency, matching the project's existing
zero-toolchain constraint.

---

## 4. Wire protocol

Mirror OpenFront's message names and shapes exactly. JSON, not binary — OpenFront's
`zbin` encoding (`src/core/ZbinWire.ts`) is a bandwidth optimization layered on the same
message set, and is a later, optional phase.

### Turn

```js
{ turnNumber: <uint>, intents: [ { ...intent, clientID } ], hash?: <number|null> }
```

Server-stamped `clientID` — the client never sends its own id, exactly as in
`GameServer.handleIntent` (`const stamped = { ...intent, clientID: actor.clientID }`).

### Client -> Server

| type | fields | notes |
|---|---|---|
| `join` | `gameID, username, persistentID, spectator?, build?` | lobby only; server assigns clientID |
| `rejoin` | `gameID, lastTurn, persistentID, build?` | reconnect; server replies `start` with `turns.slice(lastTurn)` |

`build` is the client's build id (`tools/build-info.js`: version + commit, `+` if the tree
was dirty). The page reads it from `/buildinfo.json` at load, so a tab left open across a
server update keeps its old id. The server refuses any `join`/`rejoin` whose `build` is
missing or differs from its own with `error: version-mismatch`; the client stops
reconnecting and tells the player to refresh. Lockstep needs every client on one build.
| `intent` | `intent` | see intent table |
| `ping` | — | every 5 s, keeps `lastPing` fresh |
| `hash` | `turnNumber, hash` | desync detection |
| `winner` | `winner` | client-voted game end |

### Server -> Client

| type | fields | notes |
|---|---|---|
| `lobby_info` | `lobby, myClientID` | broadcast while in Lobby phase |
| `prestart` | `mapSize, seed` | lets clients generate the map before the first turn |
| `start` | `turns[], gameStartInfo, myClientID` | `turns` is the catch-up backlog |
| `turn` | `turn` | every 100 ms |
| `ping` | — | |
| `desync` | `turn, correctHash, clientsWithCorrectHash, totalActiveClients, yourHash` | |
| `error` | `error, message?` | e.g. `full-lobby` |

`gameStartInfo` carries `{ gameID, seed, config: { mapSize, bots, tribes, ... }, players: [{clientID, username, playerId}] }`.
`playerId` is the sim-side index into `Game.players` — assigned by the server at start,
identical on every client. `Game.me` becomes `Game.myPlayerId`, looked up from
`myClientID`.

### Intents

Every one of these already exists as a direct `Game.*` call from `ui.js` / `radial.js`.
The mapping is 1:1. OpenFront names are used where they exist.

| Intent `type` | Fields | Current call site |
|---|---|---|
| `spawn` | `tile` | `ui.js:350` `Game.chooseSpawn` |
| `attack` | `targetID, troops` | `ui.js:522` `Game.launchAttack` |
| `cancel_attack` | `attackID` | `ui.js:783` `Game.retreatAttack` |
| `boat` | `dst, troops` | `radial.js:137` `Game.launchNavalInvasion` |
| `cancel_boat` | `boatID` | `ui.js:784` `Game.retreatBoat` |
| `build_unit` | `unit, tile` | `ui.js:403/426/492` build / warship / nuke |
| `upgrade_structure` | `tile` | `ui.js:465` `Game.upgrade` |
| `move_warship` | `unitIds[], tile` | `ui.js:447` `Game.moveWarships` |
| `move_scout` | `unitIds[], tile` | `Game.moveScouts` — fog of war's Scout (`docs/fog-of-war.md`); this game's own. A Scout is bought with `build_unit` (`unit: 'scout'`, `tile` = where to send it) |
| `annex_region` | `tile` | `ui.js:513` `Game.annexRegion` — this game's own, no OpenFront equivalent |
| `allianceRequest` | `recipient` | `radial.js:122` |
| `allianceReject` | `requestor` | `ui.js:845` |
| `allianceAccept` | `requestor` | `ui.js:844` — OpenFront folds accept into request; keep explicit |
| `allianceExtension` | `recipient` | `ui.js:868`, `radial.js:114` |
| `breakAlliance` | `recipient` | `radial.js:107` |
| `donate_gold` | `recipient, gold` | `radial.js` `Game.donateGold` (ticket #29; Donate sub-ring, team games only) |
| `donate_troops` | `recipient, troops` | `radial.js` `Game.donateTroops` (ticket #29) |
| `targetPlayer` | `target` | `radial.js` `Game.targetPlayer` (ticket #30; West wedge, non-allied players) |
| `mark_disconnected` | `isDisconnected` | new |

Deliberately **not** ported now: `emoji`, `quick_chat`,
`embargo`, `embargo_all`, `delete_unit`, `kick_player`, `toggle_pause`,
`update_game_config`. None have a mechanic in this game yet. The troop-ratio slider
stays client-local (it is only ever read at the moment an `attack` intent is built, so
its value travels inside `attack.troops` — this matches OpenFront, which sends absolute
troop counts, not a ratio).

`fastForward` and the debug gold/nuke buttons are **singleplayer-only** and must be hard
disabled in multiplayer, not converted to intents. `Game.humanShielded` likewise.

---

## 5. Client loop

The current loop in `main.js` drives the sim from the local wall clock. That is exactly
what must change: **in lockstep the sim is driven by turn arrival, not by elapsed time.**

```js
function loop(now) {
  requestAnimationFrame(loop);
  // Sim: drain whatever turns have arrived, under a frame time budget so a
  // large catch-up backlog (rejoin) does not freeze the tab.
  const budgetEnd = performance.now() + SIM_BUDGET_MS;   // ~8 ms
  while (Runner.pendingTurns() > 0 && performance.now() < budgetEnd) {
    Runner.executeNextTurn();       // applies intents, then Game.tick()
    Transport.turnComplete();       // LocalServer backpressure, per OpenFront
  }
  // Render: free-running, interpolating off Game.renderElapsed as it does today.
  Render.draw();
  UI.update();
}
```

`Runner.executeNextTurn()` is `GameRunner.executeNextTick` from OpenFront:

```js
executeNextTurn() {
  if (this.currTurn >= this.turns.length) return false;
  const turn = this.turns[this.currTurn++];
  for (const intent of turn.intents) Executor.apply(intent);
  Game.tick();                       // no dt argument — see Task MP-0.1
  if (turn.turnNumber % HASH_INTERVAL === 0) Transport.sendHash(turn.turnNumber, Hash.compute());
  return true;
}
```

`Transport.turnComplete()` is what makes `LocalServer` self-clocking: it only queues the
next turn once the client has finished the previous one, so singleplayer never runs ahead
of itself and the debug fast-forward has a natural home (raise the LocalServer interval
multiplier rather than calling `Game.tick` in a bare loop).

**Render smoothing.** `Game.renderElapsed` must now be driven off the wall clock since
the last executed turn, clamped to one turn's worth, rather than off a local accumulator.
With network jitter it will occasionally sit still for a frame or two; that is correct
and preferable to extrapolating past authoritative state.

---

## 6. Server

Single Node process. `GameManager` holds `gameID -> GameServer`. OpenFront's
master/worker sharding (`src/server/Master.ts`, `Worker.ts`) is a scale-out concern;
note the seam (`GameManager` is the shard boundary) and skip it.

`GameServer` phases, from `GameServer.ts`:

```js
GamePhase = { Lobby: "LOBBY", Active: "ACTIVE", Finished: "FINISHED" }
```

Turn loop, matching `GameServer.endTurn` in shape:

```js
start() {
  this.stage = "started";
  this.gameStartInfo = { gameID, seed, config, players: roster.map(...) };
  this.endTurnIntervalID = setInterval(() => this.endTurn(), TURN_INTERVAL_MS);
  for (const c of this.clients.active()) this.sendStartGameMsg(c.ws, 0);
}

endTurn() {
  const pastTurn = { turnNumber: this.turns.length, intents: this.intents };
  this.turns.push(pastTurn);
  this.intents = [];
  this.checkDesync();
  this.checkDisconnected();
  broadcast({ type: "turn", turn: pastTurn });
}
```

The full turn log is retained for the life of the game — it is what a rejoining or
late-joining client is fast-forwarded with (`turns.slice(lastTurn)` inside the `start`
message), and it is the game record.

Identity: `persistentID` is a UUID generated once per browser and kept in `localStorage`
(private, never broadcast); `clientID` is a short per-game public id the server assigns
and stamps onto intents. No accounts, no auth, no Turnstile.

Lobbies: **private lobbies only** (D4) — the host creates one, gets a join code (the
`gameID`), others join by code, host presses start. OpenFront's public auto-created
lobbies (`Master.ts` + `MapPlaylist.ts`, a new lobby every `gameCreationRate`) are a
later phase and need nothing new architecturally, just a scheduler.

### 6.1 Deployment — self-hosted (D3)

The server runs on the owner's Windows 11 machine. Nothing in the architecture changes:
`GameManager` is the same object whether it is on a laptop or a cloud box, and the
relay does no simulation, so a desktop CPU is wildly over-provisioned for it. The only
real question is reachability, and it has three answers depending on who needs to reach it.

| Scope | Setup | Use when |
|---|---|---|
| **Same machine** | `node server/index.js`, open `http://localhost:PORT` in two tabs | Development, and every automated two-client test |
| **Same house / LAN** | Add an inbound Windows Defender Firewall rule for the port on *private* networks; others use `http://<lan-ip>:PORT` | Local playtesting |
| **Over the internet** | **Cloudflare Tunnel** (`cloudflared`) in front of the local port | Friends elsewhere |

**Use a tunnel, not port forwarding.** Cloudflare Tunnel is the recommendation because it
needs no router configuration, works behind CGNAT (which most residential ISPs now use, and
which makes port forwarding fail outright), does not expose the home IP address, and
terminates HTTPS for free — which sidesteps the mixed-content trap in the next paragraph
entirely. Tailscale is the alternative if the group is fixed and a public URL is unwanted;
port forwarding plus dynamic DNS is strictly more work for a worse result.

**Wire origin.** Because the tunnel serves the page over HTTPS, the WebSocket must be
`wss://`, not `ws://` — a browser blocks an insecure socket opened from a secure page, and
this fails *only* in the tunnelled configuration, so it will not show up in local testing.
Since `server/index.js` serves the static game and the WS upgrade from the same origin,
derive the URL rather than hardcoding a scheme:

```js
const wsBase = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
```

**Two operational consequences worth knowing up front:**

1. **The turn log is in memory.** A server restart, a crash, or the machine sleeping kills
   every in-flight match — there is no persistence and no resume. Acceptable for
   playtesting; it is the thing to fix first (a turn-log flush to disk) if self-hosting
   ever outlives its intended scope. Set the machine's sleep timeout accordingly while
   hosting.
2. **The host's own client gets no special treatment.** It is an ordinary client that
   happens to be on localhost. Do not let "the host is authoritative" creep in anywhere —
   under lockstep nobody is.

---

## 7. Determinism audit of the current codebase

Completed in Phase 0. The audit (with its obsolete `game.js` line numbers) is in
`docs/multiplayer-build-log.md` §7. The standing rules it produced (seeded RNG only,
stable iteration order, no clocks in sim code, `Game.det.*` for `pow`/`exp`/`hypot`)
are in `CLAUDE.md`; the wrappers are `Game.det` in `js/game/core.js`.

---

## 8. Deliberate divergences from OpenFront

State these up front so nobody "fixes" them later:

1. **JSON wire, not `zbin`.** OpenFront binary-encodes with a per-game clientID
   dictionary. Optional Phase 5.
2. **Sim on the main thread, not a Web Worker.** OpenFront runs the sim in
   `Worker.worker.ts` and ships `GameUpdateViewData` to the renderer. This codebase is
   built on shared globals (`Game`, `GameMap`, `Render` all reach into each other), so
   the worker split is a large refactor with no correctness benefit. Time-budgeted
   catch-up (Section 5) covers the one thing the worker buys us. Optional Phase 5.
3. **Single server process, no master/worker sharding** — self-hosted on the owner's
   machine per D3, §6.1.
4. **Private lobbies only** (D4), no matchmaking, no public playlist.
5. **No accounts, cosmetics, clans, reports, telemetry, or archival upload.**
6. **Reduced intent set** (Section 4) — only intents with an existing mechanic.
7. **Rails stay orthogonal**, per the standing note in `feedback-openfront-source-porting`.

---

## 9. Tasks and 10. Order-of-work summary

Moved to `docs/multiplayer-build-log.md`. That file defines the task IDs (`MP-0.1` to
`MP-5.x`) cited in code comments, with implementation notes per phase. Read the relevant
phase there when working on code that cites it.
