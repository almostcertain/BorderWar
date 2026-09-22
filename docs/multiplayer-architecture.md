# Multiplayer Architecture — BorderWar

> **STATUS (2026-09-07): All 22 tasks across Phases 0–4 complete.** Deterministic
> lockstep multiplayer works end-to-end — verified live over a real server with real
> browser clients, including two humans playing a full match together, reconnect,
> desync detection, and basic flood hardening. Server also hardened for open-internet
> exposure (path traversal, connection/lobby caps) ahead of real-world playtesting.
> Next step is deployment: a domain (shortlist: `lastfront.io`, `borderwar.io`) fronted
> by a Cloudflare Tunnel per §6.1 — not yet executed. See §9 for the full task-by-task
> record and §10 for the phase summary.

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
                     docs/game-split-plan.md). One `Game` singleton, extended per domain
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
  verify-split.js    One-off parity check for the js/game/ split; it needs the frozen pre-split
                     js/game.js at tools/baseline/game.orig.js, which was deleted after Step 6
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
| `join` | `gameID, username, persistentID, spectator?` | lobby only; server assigns clientID |
| `rejoin` | `gameID, lastTurn, persistentID` | reconnect; server replies `start` with `turns.slice(lastTurn)` |
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
| `annex_region` | `tile` | `ui.js:513` `Game.annexRegion` — this game's own, no OpenFront equivalent |
| `allianceRequest` | `recipient` | `radial.js:122` |
| `allianceReject` | `requestor` | `ui.js:845` |
| `allianceAccept` | `requestor` | `ui.js:844` — OpenFront folds accept into request; keep explicit |
| `allianceExtension` | `recipient` | `ui.js:868`, `radial.js:114` |
| `breakAlliance` | `recipient` | `radial.js:107` |
| `mark_disconnected` | `isDisconnected` | new |

Deliberately **not** ported now: `targetPlayer`, `emoji`, `quick_chat`, `donate_gold`,
`donate_troops`, `embargo`, `embargo_all`, `delete_unit`, `kick_player`, `toggle_pause`,
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

Audited `js/game.js`, `js/ai.js`, `js/map.js`, `js/noise.js`. Good news first: the sim
already uses a single seeded `mulberry32` stream, calls no `Math.random`, reads no clock,
and runs at a fixed step. The remaining hazards are specific and few.

### 7.1 Sim state that branches on `Game.me` — hard desyncs

These make the simulation *player-relative*, which under lockstep means every client
computes a different game. All must become "is this player human-controlled" rather than
"is this player me".

| Site | Code | Effect |
|---|---|---|
| `game.js:2325` | `if (defender.isTribe && attacker.id === this.me) mag *= 0.8` | tile cost differs per client — desyncs on the first attack any human makes on a Tribe |
| `game.js:2456` | `attacker.gold += defenderId === this.me ? defender.gold / 2 : defender.gold` | gold spoils differ per client |
| `game.js:2579` | `winner.gold += loser === this.players[this.me] ? loser.gold / 2 : loser.gold` | same, elimination path |
| `game.js:4109` | `findIndex((p, id) => id !== this.me && ...)` | debug-nuke owner selection |
| `game.js:430, 1333, 1780, 1833, 1931, 2572` | `this.humanShielded && ... === this.me` | fast-forward shield; MP-disabled |
| `game.js:3720` | `w.owner !== this.me` in `moveWarships` | order-authorship check; becomes the intent's `clientID` -> `playerId` |

`game.js:3257, 3461, 3465` push `goldPopups` gated on `=== this.me`. These are **cosmetic
only** (read solely by `render.js`) so they do not desync the sim, but they must be
excluded from the state hash and are better moved out of `Game` into a per-client event
stream (see Task MP-0.4).

### 7.2 Cross-engine float hazards

`+ - * /` and `Math.sqrt` are IEEE-754 exact and identical everywhere. `Math.pow`,
`Math.exp`, `Math.log`, `Math.hypot` are **not** specified to the last ulp and do differ
between V8, SpiderMonkey and JavaScriptCore. Two players on Chrome and Firefox can
diverge on a single last-bit difference that then amplifies through the attack loop.

Call sites in sim code:

- `game.js:731` `Math.pow(2, n)` — integer exponent, exact, safe
- `game.js:962` `Math.pow(tiles, 0.6)` — **hazard** (troop cap)
- `game.js:1025` `Math.pow(rawPop, 0.73)` — **hazard** (growth)
- `game.js:2093` `Math.exp(...)` — **hazard** (sigmoid)
- `game.js:2112, 2116` `Math.pow(..., 0.7 / 0.6)` — **hazard**
- `game.js:3343` `Math.exp(...)` — **hazard** (trade ship value)
- `game.js:3796, 4078, 4116` `Math.hypot` — **hazard**
- `game.js:2999, 3155, 4409`, `map.js:63` `Math.sqrt` — safe
- `map.js:362` `Math.hypot` — **hazard** (map generation; a differing map is a total desync)

OpenFront ships this same exposure and relies purely on hash-based detection. We can do
better cheaply, because the list is nine lines long: route them through
`Game.det.pow/exp/hypot` wrappers that quantize the result so last-ulp disagreements
collapse. The astronomically unlikely exact-boundary case is still caught by the hash,
so keep hash detection regardless.

**Quantize with `Number(v.toPrecision(12))`, not a fixed grid.** An earlier draft of this
document said `Math.round(v * 1e9) / 1e9`; that is wrong and was corrected on 2026-08-30
before implementation. `v * 1e9` exceeds `Number.MAX_SAFE_INTEGER` (~9.0e15) once `v` is
above roughly 9e6 — and `Math.pow(rawPop, 0.73)` on a large empire is comfortably past
that — so the fixed grid silently loses precision exactly where the numbers get big.
`toPrecision` quantizes *relatively*, so it holds at every magnitude, and ECMA-262
specifies it as correctly rounded, making it deterministic in its own right. Doubles carry
~15–17 significant digits and the last-ulp noise sits around digit 16, so trimming to 12
collapses the noise with a wide margin. Non-finite values and zero must pass through
untouched rather than being run through `toPrecision`.

### 7.3 Iteration order

`p.tiles` (`Set`), `Game.buildings` (`Map`), `lastRequestAt` (`Map`) iterate in insertion
order, which is deterministic **provided every client performs the same insertions and
deletions in the same order** — which lockstep guarantees. No change needed, but it is a
standing rule: never seed a sim-affecting iteration from anything client-local
(hover state, selection, camera, DOM order).

### 7.4 RNG discipline

`Game.rng` is the sim's only entropy source and must be consumed *only* from sim code, in
a fixed order. `render.js` and `ui.js` currently call it zero times — keep it that way.
If a cosmetic effect ever needs randomness, give it a separate unseeded generator.

### 7.5 Time

`performance.now()` appears only in `input.js`, `render.js`, `ui.js`, `radial.js`,
`main.js` — never in `game.js` or `ai.js`. Correct as-is. `Game.elapsed` must become a
derived value of an integer tick counter (Task MP-0.1).

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

## 9. Tasks

Ordered. Each phase is independently verifiable. Phases 0 and 1 need no server and must
leave singleplayer fully playable at every commit.

### Phase 0 — Determinism hardening — ✅ COMPLETE (2026-08-30)

All five tasks implemented and verified. Milestone **M1 reached**: the simulation is
deterministic, and there is now a hash and a harness that prove it.

Implementation facts later tasks need:

- **`Hash.compute()` lives in `js/net/hash.js`** (loader entry `'net/hash'`, after `'game'`).
  FNV-1a, 32-bit, mixed numerically — one round per 32-bit word with a murmur3 `fmix32`
  finalizer. Cosmetic exclusion is evaluated **at run time** by filtering
  `Hash.INPUT_FIELDS` against `Game.COSMETIC_STATE`, so marking a field cosmetic later
  removes it from the digest with no edit to `hash.js`. `Fx` is structurally excluded —
  `hash.js` never references it.
- **Tile sampling stride is 16** (125,000 of 2,000,000 tiles on xlarge) costing **1.27 ms**;
  0.31 ms on large, 0.16 ms on medium. Deliberately over the ~1 ms target: the
  players/attacks half of the digest costs 0.004 ms, so stride is the only cost knob, and
  a full unsampled scan cannot approach 1 ms regardless of hash function (a bare XOR loop
  over the same array costs 9.3 ms — the floor is ~2.5 ns/iteration). Sensitivity was
  judged worth 0.6 ms. MP-4.2 hashes every 10 turns, so this is ~0.13 ms/turn amortised.
- **Known and accepted hash limitation:** a value poked *directly* into `GameMap.owner` at
  an unsampled index does not move the digest. Any ownership change routed through
  `Game.setOwner` does, because `tiles.size` is hashed **exactly** for every player and the
  tile scan only covers the residual case of equal per-player counts in different places.
  Relevant only to test code that writes the array directly.
- **`Hash.verifyDeterminism({bots, tribes, seed, size, turns, meA, meB, perturbA, perturbB, …})`**
  runs two sequential passes of the singleton `Game` and returns `{ok, firstDivergentTurn,
  divergentTurns, samples, …}`. The two passes deliberately differ in everything that must
  *not* matter — different `Game.me`, one pass rendering and one not, different real-time
  pacing — so a pass is meaningful rather than tautological. Use it as the regression gate
  after any task that touches simulation code.
- **Acceptance evidence:** xlarge (2M tiles), 31 bots + 50 tribes (82 players), 3000 turns
  × 2 passes, **zero divergent turns**, both final hashes `2072680626`, 3000 distinct
  hashes across 3000 turns. Negative control: a +1 gold perturbation injected on pass B at
  turn 137 was flagged at turn 137 exactly. Independently re-confirmed at turn 231 in a
  separate 400-turn run.

Yield note for anyone extending the harness: it yields via `MessageChannel`, **not**
`setTimeout(0)`. Chrome throttles timers in a hidden tab to one per second and then one per
minute, which stretched an early acceptance attempt to ~1.2 s/turn.

#### Original task specs (kept for reference)

**MP-0.1 — Integer tick clock**
- Files: `js/game.js`, `js/main.js`
- Replace `Game.tick(dt)` with `Game.tick()` taking no argument; define
  `Game.TICK_DT = 0.1` and use it everywhere `dt` was used inside `tick` and every
  `step*`/`update*` it calls. Add `Game.ticks` (integer, incremented once per tick);
  make `Game.elapsed` a getter returning `this.ticks * Game.TICK_DT`.
- Update `Game.fastForward` and `main.js`'s accumulator to the new signature.
- Done when: a full match plays identically to before, and no function in `game.js` or
  `ai.js` accepts a `dt` parameter.

**MP-0.2 — Remove `Game.me` from the simulation**
- Depends: MP-0.1
- Files: `js/game.js`
- Add `p.isHuman` to the player record at `init` (currently derivable as
  `!isBot && !isTribe`). Replace the sim branches at `game.js:2325`, `2456`, `2579`,
  `4109` with `isHuman` checks. Leave `Game.me` in place purely as a *view* pointer for
  `ui.js` / `render.js`.
- Done when: `grep -n '\.me\b' js/game.js js/ai.js` returns only the declaration, the
  `humanShielded` lines, `moveWarships`' authorship check, and the cosmetic
  `goldPopups` pushes.

**MP-0.3 — Deterministic math wrappers**
- Files: `js/game.js`, `js/map.js`
- Add `Game.det = { pow, exp, hypot }` quantizing via `Number(v.toPrecision(12))` — see
  §7.2 for why a fixed `1e-9` grid is wrong. Route the hazard sites listed in §7.2
  through it. Replace `Math.hypot(a,b)` with `Math.sqrt(a*a+b*b)` where the quantization
  is not otherwise needed (`sqrt` is IEEE-exact, so that form is deterministic outright).
- `map.js`'s `Math.hypot` in the spawn-separation check is the highest-stakes site of the
  nine: map generation runs on every client from the seed, so a one-tile difference there
  desyncs everything immediately rather than subtly.
- Done when: no `Math.pow` / `Math.exp` / `Math.log` / `Math.hypot` call remains in
  `game.js`, `ai.js`, `map.js`, `noise.js` outside the wrapper, except integer-exponent
  `Math.pow`.

**MP-0.4 — Separate cosmetic state from sim state**
- Depends: MP-0.2
- Files: `js/game.js`, `js/render.js`
- Move `goldPopups` off `Game` into an `Fx` collection the sim pushes to through a single
  `Fx.goldPopup(tile, amount, ownerId)` call that filters on `Game.me` at *render* time,
  not at push time. Leave `nukeBlasts` / `samFlashes` in the sim (they are deterministic
  and `me`-independent) but tag them so the hash can skip them.
- Done when: nothing pushed by the sim reads `Game.me`.

**MP-0.5 — State hash + dual-sim harness**
- Depends: MP-0.1 … MP-0.4
- Files: `js/net/hash.js` (new), `index.html`
- FNV-1a over a compact digest: `Game.ticks`, then per player
  `id, alive, tiles.size, round(troops), round(gold)`, then per attack
  `attacker, target, round(troops)`, then `GameMap.owner` sampled every Nth tile
  (N tuned so a full hash stays under ~1 ms on an xlarge map).
- Add a dev harness that runs two `Game` instances from the same seed and turn list in
  one page and asserts hashes match every turn.
- Done when: the harness runs 3000 turns on an xlarge map with 31 bots and 50 tribes
  with zero hash divergence.

### Phase 1 — Intent pipeline + LocalServer — ✅ COMPLETE (2026-08-30)

All five tasks implemented and verified. **This was the commitment point** (§2): singleplayer
now runs entirely on the multiplayer code path, through `Transport` → `LocalServer` →
`Runner` → `Executor` → `Game`, with no network attached yet. Phase 2's server is additive
from here.

Implementation facts later tasks need:

- **`js/net/protocol.js`** defines all 15 intents (camelCase constructors on
  `Protocol.intent.*`, e.g. `Protocol.intent.cancelAttack(7)`; snake_case wire names)
  and 12 messages (`Protocol.msg.*`), plus `Protocol.turn()`, `Protocol.stamp()`,
  `TURN_INTERVAL_MS = 100`, `HASH_INTERVAL = 10`, `NEUTRAL_TARGET = -1`. Pure data —
  no reference to `Game`/DOM/timers — so the same file will load under Node in Phase 2.
  `validateIntent`/`validateMessage` are **grammar-only**; legality is the Executor's job.
- **Entity ids exist now.** MP-1.1 surfaced that attacks, boats and warships had none,
  which `cancel_attack`/`cancel_boat`/`move_warship` need to cross the wire. `game.js`
  gained `nextAttackId`/`nextBoatId`/`nextWarshipId` counters (same shape as the existing
  `nextRailId`/`nextTrainId`) and `attackById`/`boatById`/`warshipById` lookups. Attack
  consolidation (`launchAttack` folding a new attack into an existing siege) keeps the
  survivor's original id rather than minting a fresh one, so an outstanding
  `cancel_attack` for an absorbed id resolves to nothing — a clean no-op, not an error,
  identically on every client.
- **`js/net/executor.js`**: `Executor.apply(stampedIntent)` is the **only** path a player
  action mutates the sim. `Executor.clientToPlayer` (Map) + `Executor.setRoster()` is the
  clientID→playerId seam MP-3.1 will populate for real; today it defaults every clientID
  to player 0. Malformed or illegal intents drop silently — never throw, never fall back.
  `Executor.apply` never reads `Game.me`.
- **`js/net/runner.js`**: `Runner.addTurn`/`pendingTurns()`/`executeNextTurn()`/`reset()`.
  Turn continuity policy: a turn arriving out of order is **held** until the gap fills,
  never gap-filled with a fabricated empty turn — a fabricated turn would be a silent
  desync (this client just never applies somebody's intent), where a stalled Runner is at
  least visible. Recovering a genuinely lost turn is a transport-layer job (MP-4.1
  rejoin), not the Runner's. `Runner.onHash(turnNumber, hash)` fires every `HASH_INTERVAL`
  turns; MP-1.4 wired it to `Transport.sendHash`.
- **`js/net/localserver.js` + `js/net/transport.js`**: `LocalServer` is a self-clocking
  `setInterval` pump gated on **both** the turn interval elapsing and client backpressure
  (`turnComplete()` — without it the pump stalls, which is what stops singleplayer running
  ahead of itself). `LocalServer.burst(n)` emits turns as fast as the client drains them,
  still under backpressure, and is what the debug "Skip to mid-game" button now calls
  instead of a bare `Game.tick()` loop. `Transport.connectRemote` deliberately throws —
  Phase 2 builds it; the throw message points at §6/§6.1 (the `wss://`-from-`location`
  requirement for the self-hosted tunnel).
- **`Game.humanShielded` is gone.** It was the last player-relative (`=== this.me`) branch
  in the simulation — nine sites across `setOwner`, `launchAttack`, the naval-invasion
  block reason, `stepBoats`, `tick`, and the elimination guard. Its removal is a real,
  visible **dev-tool regression, accepted deliberately**: the debug fast-forward burst no
  longer protects the human's territory while it runs blind, and can now eliminate the
  human exactly as it can eliminate anyone else. Confirmed happening live during
  verification (see below). This does not affect real gameplay — the shield only ever
  fired inside `fastForward`.
- **The click latency is real and intentional.** A UI action now produces an intent that
  has provably zero effect on the tick it is sent (ticks and state unchanged
  synchronously) and takes effect once the next turn drains — roughly one `TURN_INTERVAL_MS`
  (100 ms) later under the real rAF loop, measured at ~9.7 turns/sec end to end. This is
  the deliverable, not a defect; do not add client-side prediction or special-case
  singleplayer to bypass it.
- **`main.js`'s loop is turn-driven, not wall-clock-driven** (§5): a fixed ~8 ms
  per-frame sim budget drains `Runner.pendingTurns()`, calling `Transport.turnComplete()`
  after each. `Game.renderElapsed` is wall-clock time since the last executed turn,
  **clamped to one `Game.TICK_DT`**, so animation never extrapolates past authoritative
  state — under jitter it correctly sits still for a frame rather than guessing ahead.
- **Debug-only bypasses that remain outside the Executor, by design**: the gold buttons
  and `Game.debugNuke` have no intent and are gated on `Transport.isLocal` (hidden and
  inert once a real server is attached in Phase 2). These are the sole exceptions to
  "no mutating `Game.*` call outside the Executor."
- **Acceptance evidence**: the regression gate (`Hash.verifyDeterminism` on a 400-turn
  medium match, 6 bots/10 tribes) returns the same final hash, `3231782993`, as it did
  before any of Phase 1's five tasks — the entire intent pipeline was added with zero
  perturbation to the deterministic simulation underneath it.

#### Original task specs (kept for reference)

**MP-1.1 — Protocol module**
- Files: `js/net/protocol.js` (new), `index.html`
- Define every message and intent shape from Section 4 as plain constructors plus a
  `validateIntent(intent)` returning `null` or an error string. Dual-export
  (`window.Protocol` / guarded `module.exports`) so the server can require the same file.

**MP-1.2 — Executor**
- Depends: MP-1.1, MP-0.2
- Files: `js/net/executor.js` (new)
- `Executor.apply(stampedIntent)` maps `clientID -> playerId`, re-runs the existing
  `*BlockReason` validators inside the sim (an intent that arrives invalid is dropped
  silently, identically on every client), then calls the existing `Game.*` method. This
  becomes the **only** path that mutates the sim from player action.
- Done when: every `Game.*` mutating call listed in Section 4 has an `Executor` case.

**MP-1.3 — GameRunner**
- Depends: MP-1.2
- Files: `js/net/runner.js` (new)
- Port `GameRunner`: `turns[]`, `currTurn`, `addTurn`, `pendingTurns`, `executeNextTurn`
  exactly as Section 5. Emits a hash every `HASH_INTERVAL` (10) turns.

**MP-1.4 — Transport + LocalServer**
- Depends: MP-1.3
- Files: `js/net/transport.js`, `js/net/localserver.js` (new)
- `Transport` with an `isLocal` flag, `connect(onconnect, onmessage)`, `sendIntent`,
  `sendHash`, `turnComplete()`. `LocalServer` buckets intents on a `setInterval(…, 5)`
  gated on `Date.now() > turnStartTime + TURN_INTERVAL_MS` and on
  `turnsExecuted === turns.length` backpressure, emits `start` then `turn` messages —
  a direct port of `LocalServer.start` / `endTurn` / `turnComplete`.
- Done when: the debug fast-forward is reimplemented as a LocalServer interval
  multiplier rather than a bare `Game.tick` loop, and `Game.humanShielded` can be deleted.

**MP-1.5 — Rewire UI and the main loop**
- Depends: MP-1.4
- Files: `js/ui.js`, `js/radial.js`, `js/main.js`
- Every mutating `Game.*` call in `ui.js` / `radial.js` becomes
  `Transport.sendIntent({...})`. `main.js` adopts the loop from Section 5.
  `*BlockReason` calls stay in the UI for affordance and preview — advisory there,
  authoritative in the Executor.
- Done when: singleplayer is fully playable, `grep` finds no mutating `Game.*` call
  outside `js/net/executor.js`, and there is a visible ~100 ms input latency (correct —
  this is lockstep).

### Phase 2 — Server — ✅ COMPLETE (2026-09-06)

All four tasks implemented and verified, including a real two-browser-tab match played
over a real, separate Node server process — the first genuine proof that two independent
clients agree on the same simulation over the network, not just in a test harness.

Implementation facts later tasks need:

- **`server/index.js`** (MP-2.1): static file host + WS upgrade at `/ws`, port **8124** by
  default (`PORT` env override — chosen specifically to not collide with `.claude/
  launch.json`'s 8123 static dev server used throughout Phase 0/1). Graceful shutdown on
  `SIGINT`/`SIGTERM` explicitly `ws.terminate()`s every tracked client before closing the
  server — `ws`'s own `WebSocketServer.close()` does **not** terminate already-open
  clients, it only stops accepting new ones; without the explicit terminate loop, shutdown
  hangs forever with any client still connected. Windows' signal emulation hard-kills an
  externally-sent SIGINT/SIGTERM rather than delivering it for handling — this is a
  platform limitation confirmed empirically, not a code defect; the real operational path
  (a person pressing Ctrl+C in an attached console) is unaffected.
- **`server/gamemanager.js` + `server/gameserver.js`** (MP-2.2): a real `GameServer` per
  `gameID` — `Protocol.GAME_PHASE.{LOBBY,ACTIVE,FINISHED}`, a roster (`clients` Map keyed
  by server-assigned `clientID`, sequential integers starting at 0, doubling as the
  provisional `playerId` until MP-3.1 owns the real id-space), a 100ms `setInterval`
  turn-relay loop, and a full turn log that's never pruned. **The server stamps `clientID`
  on every intent itself via `Protocol.stamp` — a client-supplied `clientID` field on an
  intent payload is silently overwritten, never trusted.** Verified by deliberately baking
  a forged `clientID` directly into an intent's own field (not just the outer message) and
  confirming the broadcast still carries the real one. `GameManager.reap()` removes
  `FINISHED` games and empty `LOBBY`-phase games, on disconnect and on a periodic sweep.
- **The `gameStartInfo` shape server and `LocalServer` both produce is identical**:
  `{gameID, seed, config:{mapSize,bots,tribes}, players:[{clientID,username,playerId}]}`.
  This equivalence (§2) is what lets `ui.js`/`main.js` read `msg.gameStartInfo` without
  caring whether the source is `LocalServer` or a real socket.
- **Two protocol gaps found and deliberately left open, not papered over**: (1)
  `Protocol.msg.rejoin(gameID, lastTurn, persistentID)` *does* carry a `persistentID`
  field (an earlier draft of this doc said it didn't — corrected; verify against
  `js/net/protocol.js`'s actual schema, not this prose, if in doubt), but there is still no
  store mapping a claimed `persistentID` to a prior roster slot and no way to authenticate
  the claim (no accounts, per D2) — real reconnect-by-identity is **MP-4.1's job**,
  deliberately not built here. (2) There was no wire message for "the host wants to
  start" — MP-2.3 added exactly one, `start_game` (client→server, carries
  `{mapSize,bots,tribes}`), rather than reusing the existing `'start'` name (already the
  server→client message carrying `gameStartInfo`).
- **Host / lobby-creator**: the first client to successfully join a game becomes its
  `creatorClientId` (recorded once, in `joinClient`). Only that client's `start_game`
  message is honored — anyone else's is rejected with `{type:'error', error:'not-host'}`,
  verified by sending a forged `start_game` directly from a non-host client's console and
  confirming the match did not start. `lobby_info` broadcasts the roster to everyone in
  `LOBBY` phase on join/disconnect, so a joiner's screen shows who else is in the lobby
  before the host presses Start.
- **`js/net/transport.js`'s `connectRemote` is implemented for real** (MP-2.3): derives
  `wss://` vs `ws://` from `location.protocol` (never hardcoded — this is the one thing
  that works in every local test and fails only once served over HTTPS through a tunnel,
  §6.1); sends `join` on socket open; a small send-buffer flushes anything queued before
  the socket reaches `OPEN`; a 5s `ping`; inbound messages validated with
  `Protocol.validateMessage(msg,'s2c')` at the boundary, dropped (not thrown) on failure.
  **Does not** auto-reconnect or auto-fire `rejoin` — that stays MP-4.1's.
- **`persistentID` now exists client-side**: a `localStorage`-backed UUID
  (`crypto.randomUUID()` or a fallback), generated once per browser, read by
  `connectRemote` when joining. Nothing before MP-2.3 needed one.
- **Lobby UI** (`index.html`/`js/ui.js`/`css/style.css`): a mode choice
  (Singleplayer/Host/Join) added *above* the existing singleplayer panel, which is
  **unchanged** — same element ids, same behavior, verified as a regression check *before*
  any multiplayer testing so a break would be caught immediately rather than misattributed.
  Host generates a join code client-side, shows a live roster, and is the only screen with
  a Start button. Join is code + username, read-only roster, no Start button in the DOM at
  all for a non-host.
- **Self-hosting is documented at `server/README.md`** (MP-2.4): three reachability tiers
  (localhost / LAN / Cloudflare Tunnel), each marked honestly by what could actually be
  verified in a sandboxed environment with no second physical machine and no `cloudflared`
  installed — real wire-level proof for tier 1, a bind-address + LAN-IP-connection proof
  (short of an actual second device) for tier 2, and accurate documented-but-untested setup
  steps for tier 3. The two operational caveats from §6.1 (in-memory turn log; host gets no
  special treatment) are written down, with the actual verified `powercfg` command for
  disabling sleep.
- **Known, expected, out-of-scope limitation**: genuine two-human simultaneous *gameplay*
  does not work yet — `Game.init` still only understands one human (player 0); a second
  real client's `clientID`/`playerId` currently aliases onto what the single-player sim
  treats as an AI-controlled bot Nation. This is exactly **MP-3.1**, not a Phase 2 defect.
  What Phase 2 actually proves — and what was independently verified end-to-end over a
  real server with two real browser tabs — is that the wire-level machinery is correct:
  identical `gameStartInfo` from the same seed, identical map generation, unforgeable
  intent stamping, and **byte-identical per-turn hashes on two independent clients across
  36 sampled turns (0 through 350)**, hooked directly off each tab's own `Runner.onHash`.

#### Original task specs (kept for reference)

**MP-2.1 — Server skeleton**
- Depends: MP-1.1
- Files: `server/package.json`, `server/index.js`, `server/gamemanager.js`, `server/client.js`
- Node + `ws`. Serve the static game and accept WS upgrades at `/ws`. `GameManager` maps
  `gameID -> GameServer`, reaps Finished games and empty lobbies.
- Derive the socket URL from `location` (§6.1), never a hardcoded `ws://` — the
  hardcoded form works locally and fails only once tunnelled, which is the worst possible
  time to discover it.

**MP-2.2 — GameServer**
- Depends: MP-2.1
- Files: `server/gameserver.js`
- Phases, roster, `joinClient` / `rejoinClient` / `handleIntent` (stamps `clientID`) /
  `endTurn` / `sendStartGameMsg(ws, lastTurn)` / `start` / `end`, per Section 6.
  `setInterval(endTurn, 100)`. Retain the full turn log.
- Done when: two scripted WS clients can join a lobby, the host starts it, and both
  receive an identical, gapless turn stream.

**MP-2.3 — Lobby UI**
- Depends: MP-2.2
- Files: `index.html`, `js/ui.js`, `css/style.css`
- Overlay gains Singleplayer / Host / Join-by-code. Host sees the existing map size /
  bots / tribes controls plus the roster and a Start button; joiners see a read-only
  roster. Backed by `lobby_info` broadcasts.

**MP-2.4 — Self-hosted deployment (D3)**
- Depends: MP-2.2
- Files: `server/README.md` (new), `.gitignore`
- Document and verify the three reachability tiers in §6.1: localhost, LAN behind a
  Windows Defender inbound rule, and Cloudflare Tunnel. Confirm the `wss://` path works
  end to end through the tunnel — this is the one configuration that cannot be checked
  locally. Note the machine's sleep settings and the in-memory turn log caveat in the
  README so it is not rediscovered mid-playtest.
- Done when: two people on different networks complete a match through the tunnel, and
  `README.md` documents starting the server from cold in under five commands.

### Phase 3 — Multi-human simulation

**MP-3.1 — ✅ COMPLETE (2026-09-06).** Implementation facts MP-3.2 needs:

- **`Game.init(gameStartInfo, myPlayerId)`** fully replaces the old 4-arg signature — no
  back-compat shim, all three call sites (`main.js`, and `js/net/hash.js`'s two internal
  uses) updated in lockstep. `game.js` never references `clientID` or the network layer;
  it only ever sees "how many humans, their usernames, which index is mine."
- **Id space, confirmed by exact regression-hash match**: humans occupy `0..H-1`
  (`H = gameStartInfo.players.length`), placed by each roster entry's own `.playerId`
  field (not array position — today they coincide, but the field is the correct binding).
  Nations occupy `H..H+botCount-1`, Tribes the rest. `BOT_NAMES`/`PLAYER_COLORS` indexing
  is shifted by `H` so the single-human case is provably unchanged: the standing
  regression gate (`Hash.verifyDeterminism({bots:6,tribes:10,seed:123456789,size:'medium',
  turns:400,meA:0,meB:9})`) reproduces the exact same final hash, `3231782993`, it has
  produced since Phase 0.
- **`main.js` computes `myPlayerId`** by matching the roster entry whose `clientID`
  equals `msg.myClientID` (read from the same `'start'` message, not a separately-tracked
  global — matching the existing `lobby_info` handler's own reasoning for the same
  pattern). Falls back to `0` if not found; `Game.init` itself also clamps defensively.
- **`js/net/hash.js` now synthesizes a one-human `gameStartInfo`** internally
  (`_syntheticGameStartInfo`) rather than calling the old signature — this was a
  mandatory fix, not incidental cleanup: the regression harness every task since Phase 0
  has been gated on would otherwise have silently broken the moment `Game.init`'s
  signature changed. `verifyDeterminism`'s external API (options, return shape) is
  unchanged.
- **`PLAYER_COLORS`/`BOT_NAMES` still have exactly 32 entries each and still wrap with
  `%`** rather than growing — a pre-existing, accepted, purely cosmetic limitation once
  `H` humans plus enough bots exceeds 32 total. Not addressed, not this task's job.
- **Verified live over a real two-browser-tab match through the real server**: both
  tabs now construct **two genuine human player slots** (`isHuman:true` at both index 0
  and 1, real usernames) — closing the exact gap Phase 2 disclosed, where a second real
  client's `clientID` used to alias onto an AI-controlled bot. Per-turn hashes matched
  exactly across both tabs for as long as both clients were actively simulating.
- **The pre-existing spawn-phase lock is still live and unaddressed, exactly as
  scoped**: the instant *any one* human calls `chooseSpawn`, `this.spawning` flips to
  `false`/`this.running` to `true` for the whole match, locking out any human who hasn't
  placed yet (`spawnBlockReason` returns `'Game already started'`). Confirmed twice
  independently (once by the implementing agent, once in a from-scratch two-tab
  re-verification) that an unspawned second human's own client-local `UI.checkEndGame`
  eventually decides that player has been defeated (0 tiles) and halts ticking on that
  client alone — a client-local UI side effect of the known limitation, not a
  construction or simulation defect, and **exactly what MP-3.2 exists to fix.**

**MP-3.1 — Roster-driven player construction**
- Depends: MP-2.2
- Files: `js/game.js`
- `Game.init(gameStartInfo)` replaces `init(botCount, tribeCount, seed, sizeKey)`.
  Player id space becomes: `0..H-1` humans (from the roster, in server order), then
  Nations, then Tribes. `GameMap.findSpawns` allocates for NPCs only, as today.
  `Game.myPlayerId` derives from `myClientID`.
- Done when: a 2-human + 9-bot + 16-tribe game constructs identically on both clients
  (assert via hash at turn 0).

**MP-3.2 — Real spawn phase**
- Depends: MP-3.1
- Files: `js/game.js`, `js/ui.js`
- **Settled by D1** — the timed window applies to singleplayer as well. Do not add a
  singleplayer-only "start on click" path; that is the decision that was explicitly
  rejected, not an optimisation left on the table.
- OpenFront runs a fixed-length spawn phase (`numSpawnPhaseTurns()`) during which every
  player places simultaneously and NPC preview discs jump, then the phase ends on a turn
  boundary. This game currently ends it the instant the single human clicks
  (`chooseSpawn` sets `running = true`).
  Rework: `spawn` intents claim a provisional disc; the phase ends at
  `ticks === SPAWN_PHASE_TURNS`; anyone unspawned is auto-placed from `findSpawns`;
  a re-spawn intent before the deadline moves the disc.
- Durations per D1: `SPAWN_PHASE_TURNS` = **100 in singleplayer, 150 in multiplayer**
  (10 s / 15 s). Same mechanic, different duration — a solo player waits for nobody.
- **Trap left by MP-0.1, read before starting.** `Game.ticks` is incremented *after*
  `tick()`'s `spawning` and `!running` early returns, so it stays 0 for the whole spawn
  phase. That is faithful to the `elapsed` behaviour it replaced and correct for MP-0.1,
  but it means the `ticks === SPAWN_PHASE_TURNS` condition above **can never fire** as
  written. OpenFront's turn counter counts every turn from 0, spawn phase included.
  Resolve it explicitly rather than by accident: either move `this.ticks++` above the
  early returns (and re-check every `elapsed` reader for a timer that must not run
  during spawn — alliance expiry, `traitorUntil`, `lastRequestAt`, unit `startAt`), or
  add a separate unconditional turn counter and leave `ticks`/`elapsed` as the
  gameplay clock. The second is lower risk; the first is closer to OpenFront.
- Show a countdown during the window. Without one the singleplayer change reads as the
  game having frozen, which is the most likely way this lands badly with players.
- This is a real gameplay change to singleplayer too, and is the largest single task here.
- Done when: two humans can place capitals in either order; a human who never clicks is
  auto-placed and plays on; and a singleplayer match starts on the countdown, not the click.

**✅ COMPLETE (2026-09-06).** Resolved via the **lower-risk option**: a separate counter,
`Game.spawnPhaseTicks`, incremented once per `tickSpawnPhase()` call (which already runs
exactly once per turn while `spawning`); `Game.ticks`/`elapsed` are untouched and still
freeze at 0 during spawn, exactly as before — no `elapsed`-reader audit was needed.
`SPAWN_PHASE_TURNS = H > 1 ? 150 : 100`, computed in `init()` from the roster size already
available, no new wire field.

A genuine, concrete bug was found and fixed as part of this task, not filed separately:
`tickSpawnPhase()`'s NPC re-roll loop was still hardcoded `for (p = 1; ...)`, a leftover
MP-3.1 missed (it fixed the *analogous* loop inside `init()` but not this one, a separate
function). Under `H > 1` this called `jumpSpawnPreview` on the *second human*, silently
destroying and randomly relocating their chosen capital every 1-2 seconds for the whole
window. Fixed to `for (p = this.humanCount; ...)`, matching the fix already made elsewhere.

**Design, for later tasks to know about:**
- Humans own **zero tiles** at spawn-phase start (not a provisional disc like NPCs) —
  matching the existing UI text ("Tap the map to place your capital") and the existing
  `js/ui.js` banner/tap logic, which needed **no changes** — it was already written
  correctly in anticipation of this rework (see its own comments on `spawnBannerOpen`
  and `onTap` allowing repeated taps). Only a countdown display was added to
  `updateSpawnBanner()`, reading `Game.spawnPhaseTicks`/`Game.SPAWN_PHASE_TURNS` — **not**
  `Game.elapsed`, which stays frozen throughout.
- `Game.init` requests `H` extra candidates from the *same* `GameMap.findSpawns` call
  (`H + botCount + tribeCount`, up from `botCount + tribeCount`) and reserves the first
  `H` as `Game.humanReserveTiles`, in roster order — same deterministic `rng` stream,
  no `map.js` changes, guaranteed non-overlap with NPC placements for free.
- `chooseSpawn(tile, playerId)` no longer touches `spawning`/`running` at all — it only
  claims (or, if the player already holds tiles, unclaims then re-claims — a re-pick)
  the caller's own disc. Its external signature and boolean return contract are
  unchanged; `js/net/executor.js` needed **no changes**.
- The phase ends only inside `tickSpawnPhase()`, once, for every human simultaneously,
  when `spawnPhaseTicks` reaches `SPAWN_PHASE_TURNS`: any human still holding zero tiles
  is auto-placed at their reserved tile, then `spawning=false; running=true` for the
  whole match. NPCs need no explicit "freeze" — `tick()`'s own top guard means
  `tickSpawnPhase` (and `jumpSpawnPreview`) simply stops being called the instant
  `spawning` flips, for free.
- **The standing regression hash changed, correctly, not as a regression**: the harness's
  one early `chooseSpawn` call now only claims a tile rather than ending the phase
  instantly, so ~100 of its 400 test ticks are genuinely spent *inside* the (now real)
  spawn phase rather than in gameplay. The old reference value `3231782993` is gone for
  good; the new one, reproduced independently on a from-scratch run, is **`162295463`**.
  What still holds — and is the actual regression check — is `ok:true` with zero
  divergent turns between the two differently-configured comparison runs.
- **Verified live over a real two-browser-tab match through the real server**: both
  humans independently placed capitals at genuinely distinct tiles (opposite ends of the
  map in one verification run), neither disturbed the other, both survived the full 300-turn
  (30s) window, and — the actual milestone — **per-turn hashes matched exactly across
  every sampled turn from 0 through 500, spanning the entire spawn window and continuing
  seamlessly into real post-spawn gameplay.** This is the first time in the whole project
  two independently-acting humans have played a real match together end to end.

**MP-3.3 — Human-vs-human asymmetries**
- Depends: MP-3.1
- Files: `js/game.js`, `js/ai.js`
- Audit every `isBot` / `isTribe` / `isHuman` branch for correctness with more than one
  human present: troop cap and growth multipliers (`game.js:968, 1030`), the Tribe
  defense discount (`2325`), gold spoils (`2456, 2579`), AI target scoring
  (`ai.js:316, 518, 530, 546, 648, 767`). Bots must treat every human alike and must not
  gang up on `playerId 0` as an artifact of the old layout.

**✅ COMPLETE (2026-09-06).** Clean audit — one four-line comment fix, no functional
change. `game.js`'s type-flag branches were already correct (MP-0.2's earlier work
carried forward through MP-3.1 without incident). More notably, **`js/ai.js` was found
to contain no `isHuman` check and no player-id reference anywhere at all** — `AI.think`'s
scoring formula and every diplomacy function read only troops/tiles/relation/traitor
status/`isTribe`. Bots were never treating "the human" specially to begin with, as an
accidental consequence of the AI never having had a human-specific path — not something
built for this task. Confirmed two ways: a custom mirrored-map harness (bit-identical
scores under a forced tie, with the tie-break traced to geometry/`Set` iteration order,
not player id — consistent with §7.3) and, independently, direct live-state manipulation
plus `AI.think.toString().includes('isHuman') === false`.

Two things checked empirically that the audit couldn't settle by reading code alone,
both clean: a 30-seed × 1200-tick statistical run on a rotationally-symmetric 3-human
ring showed all three roster slots statistically indistinguishable in attacks received,
alliances, and final tiles/troops (differences within 1 standard error); a 200-seed check
of `humanReserveTiles[0..2]` (the auto-placement fallback tiles MP-3.2 introduced) found
no systematic difference in local land density, distance to the nearest NPC spawn, or
distance to map center between roster positions — confirming `findSpawns`' uniform-random
candidate draws don't quietly advantage whoever joins the lobby first.

Fixed comment (`js/ai.js`, `handleExtensions`): no longer says "the human's ally has to
make the first move" — generalized to either side of any alliance, human or not.

The one pre-existing, non-human-specific property surfaced and correctly left alone:
`AI.update`/`TribeAI.update` walk `Game.players` in id order, so a lower-index player's
bot does get first crack at re-evaluating its own targets each tick. This affects
Nations-vs-Nations exactly as much as Nations-vs-humans and produced no measurable bias
in the ring test — a standing, harmless property of iteration order, not a defect.

**MP-3.4 — Disconnect handling**
- Depends: MP-2.2
- Files: `server/gameserver.js`, `js/net/*`, `js/render.js`
- `mark_disconnected` intent plus a 30 s server-side `lastPing` timeout, per
  `GameServer.disconnectedTimeout`. A disconnected player's nation keeps existing and
  keeps being simulated; it simply issues no intents. Render a disconnect marker on the
  leaderboard.

**✅ COMPLETE (2026-09-07).** The doc's file list was stale — the leaderboard actually
lives in `js/ui.js`, not `js/render.js`; no `js/net/*` file needed changes at all (see
below). Confirmed empirically, not just by reading the code, that `js/game.js` needed
**zero** changes: `tick()`'s passive gold/troop growth already gates only on `p.alive`,
and `AI.update()` only ever touches `isBot` players — a disconnected human's nation
already kept accruing gold/troops and holding its territory with no code change, purely
because nobody was sending it intents. A live test with zero input confirmed gold and
troops climbing normally while tiles held steady.

**Design, for MP-4.1 to build on:**
- `mark_disconnected` was already fully wired end-to-end since MP-1.1/1.2 (bidirectional,
  idempotent in `Executor`) — this task's actual gap was entirely server-side: nothing
  was tracking liveness or acting on a timeout. The client has sent a 5s `ping` since
  MP-2.3; the server just wasn't listening.
- **`GameServer.disconnectedTimeout = 30000`** is a *static class property*, not a
  captured module constant — deliberately, so a test (or a future task) can override it
  live without touching shipped source.
- **Clean close and silent timeout now share one path.** `removeClient` branches on
  `this.stage`: `LOBBY`/`FINISHED` keep the original hard-delete + lobby-info broadcast,
  unchanged. `ACTIVE` routes to a new `_disconnectClient(client)`, also called by the new
  periodic `_sweepLiveness()` (every 3s, running only while `ACTIVE` — started/stopped
  alongside the turn interval, so no separate stage check is needed inside it). Both
  paths are idempotent through the same guard: `client.active` flips `false` exactly
  once, and a second call — the next sweep tick, or a `close` event after a timeout
  already fired — is a no-op.
- **The roster entry is never deleted on an `ACTIVE`-phase disconnect** — only marked
  (`client.active = false`). This is deliberate groundwork: MP-4.1 needs something to
  reconnect *to*. Deleting it now would foreclose that.
- **The server synthesizes the intent itself**: `Protocol.stamp(Protocol.intent.
  markDisconnected(true), client.clientID)`, pushed onto `this.intents` exactly like a
  real client-sent intent, riding the next `endTurn()` broadcast so every client's own
  `Executor` applies it identically, on the same turn. The server is the "author" this
  one time, but the relay-only pipeline (§1) is otherwise untouched — this is not a
  side-channel.
- **`mark_disconnected(false)` — reconnect — is untouched, deliberately.** Nothing calls
  it. A disconnected player is expected to stay disconnected for the rest of this task's
  world; `joinClient` still flatly rejects any join once a game has left `LOBBY`, exactly
  as before. That rejection, and giving `mark_disconnected(false)` a real caller, are
  entirely MP-4.1's job.
- **Verified live, real two-tab match**: closing one tab's connection cleanly
  (`Transport.disconnect()`) flips `isDisconnected` to `true` on the *surviving* client's
  own independent simulation — via the normal turn-applied intent, not a side channel —
  while that player's territory and the match itself are both unaffected. The silent-
  timeout path was verified two ways: a scripted `ws` client killed without a close frame
  (end-to-end, through the real pipeline) and a deterministic in-process unit test
  instantiating `GameServer` directly with a stale `lastPing`, confirming the exact
  stamped intent appears in the turn buffer and that three subsequent sweep ticks don't
  re-inject it.

**MP-3.5 — End of game**
- Depends: MP-3.1
- Files: `js/ui.js`, `js/net/*`, `server/gameserver.js`
- `UI.checkEndGame` currently evaluates locally. Move the win condition into the sim so
  every client reaches it on the same turn; the client then sends `winner`, and the
  server ends the game once a majority agree (OpenFront's `WinnerVote`).

**✅ COMPLETE (2026-09-07).** Found two real bugs beyond the task's own description:
(1) `checkEndGame` was setting `Game.running = false` directly from UI code — a violation
of "only `Runner → Executor` mutates `Game`" — which desynced a defeated client's own sim
from everyone else's. (2) `Hash.compute()`'s digest never included `running`/`spawning`,
so this had been invisible to every regression check since Phase 0. Both fixed: win
condition now computed once, globally, inside `Game.tick()` (`Game.winnerId`, `Game.
running=false` set together, deterministically, on every client); `checkEndGame` is now
read-only, fires once per match, and sends one `winner` vote; `running`/`spawning`/
`winnerId` are now in the hash digest. Also fixed a UX gap: a still-alive player who
didn't win previously saw no end screen at all — now shows "Game Over, X won." Server
tallies a strict majority of active (non-disconnected) votes before ending the match.
**New regression reference: `1607881243`** (was `162295463`) — the change is expected,
since the digest now tracks more state; `ok:true`/zero-divergence is what was verified.

### Phase 4 — Resilience

**MP-4.1 — Reconnect and catch-up**
- Depends: MP-2.2
- Files: `js/net/transport.js`, `js/net/runner.js`
- Socket `onclose` (code != 1000) triggers reconnect and `rejoin(turnsSeen)`; the server
  replies `start` with `turns.slice(lastTurn)`; the runner drains the backlog under the
  frame budget, with a "catching up — N turns behind" overlay.
- Done when: killing a client's socket mid-match and letting it reconnect produces a
  matching hash within a few seconds.

**MP-4.2 — Desync detection**
- Depends: MP-0.5, MP-2.2
- Files: `server/gameserver.js`, `js/net/*`
- Port `DesyncDetector` in shape: clients report hashes; the server tallies the hashes
  for turn `T-10` every 10 turns; clients disagreeing with the plurality are told once
  via `desync` and stay flagged; if a strict majority disagrees, everyone is flagged.
- Done when: a client deliberately corrupted mid-match (e.g. `+1000` gold via console)
  is flagged within ~10 turns and the others are not.

**MP-4.3 — Rate limiting and intent authorization**
- Depends: MP-2.2
- Files: `server/gameserver.js`
- Cap intents per client per turn (OpenFront: `ClientMsgRateLimiter.ts`), reject
  malformed intents at the schema boundary, and reject any intent whose implied actor is
  not the sending client.
- **Per D2, this is not a security control** and must not be described as one in code
  comments, commit messages, or UI. It stops malformed and impersonated traffic. A
  modified client can still lie freely within the intent grammar, and that is an accepted
  risk, not an open defect. Do not let this task grow into anti-cheat scope.

### Phase 5 — Optional / later

- **MP-5.1** Public auto-created lobbies on a timer (`Master.ts` + `MapPlaylist.ts` shape).
  Shipped in two slices: host-flagged public lobbies with a browsable list, no
  auto-cycling, under issue #9; and the auto-cycling half itself — a server-created,
  host-less lobby that fills and starts on its own, then rotates in a replacement —
  under issue #12. See the two task write-ups just below.
- **MP-5.2** Game record persistence and replay — the retained turn log plus the seed is
  already a complete replay; add save/load and a replay-mode `LocalServer` that feeds
  archived turns (`LocalServer.replayTurns`).
- **MP-5.3** Binary wire encoding (`zbin` analogue).
- **MP-5.4** Move the sim into a Web Worker.
- **MP-5.5** Spectators (`spectator` flag already in `join`).

**MP-5.1 (partial) — Host-flagged public lobbies + browser (issue #9) — ✅ shipped**
- Depends: MP-2.2, MP-2.3
- Files: `js/net/protocol.js`, `js/net/transport.js`, `server/gamemanager.js`,
  `server/gameserver.js`, `server/index.js`, `index.html`, `js/ui.js`, `js/main.js`,
  `css/style.css`
- Scope, deliberately narrower than the original MP-5.1 bullet above: the host ticks a
  "Public" checkbox before creating a lobby (`join`'s new optional `public` field, honored
  only from the creator's own join — same first-joiner-wins rule as `creatorClientId`, so
  a later joiner can't flip it). The lobby then appears in a list on the Join screen. The
  host is still the one who clicks Start; there is no timer, no auto-cycling, no
  matchmaking, and no accounts — those stay deferred, unlike OpenFront's `Master.ts` /
  `MapPlaylist.ts` model this bullet originally referenced.
- Wire shape: a plain `GET /lobbies` HTTP route on the existing static-file server
  (`server/index.js`), answered from `GameManager.listPublicLobbies()` — `[{gameID, host,
  playerCount}]` for LOBBY-stage games with `isPublic` set. Deliberately **not** a WS
  message type: it needs to work from the Join screen before any socket exists, and a
  stateless snapshot GET needs no per-connection subscription bookkeeping. The client
  (`Transport.fetchLobbyList()`) polls it every 4s while the plain Join form is on screen,
  stopping the moment a connection is issued or another tab is picked, plus a manual
  Refresh button.
- A lobby drops off the list the instant the game leaves LOBBY stage (`start()` flips
  `stage` to `ACTIVE`) — `listPublicLobbies()` filters on stage, no separate cleanup needed.
- No sim files touched (net/server/UI only, none of `js/game/*`, `js/ai.js`, `js/map.js`,
  `js/noise.js`) — no golden re-record.
- Done when: a host-flagged lobby appears in a second client's Join-screen list, clicking
  an entry fills the join code and connects, and the entry disappears once the host starts.
  Verified live over `node server/index.js` with two browser tabs.

**MP-5.1 (full) — Rotating open lobbies (issue #12) — ✅ shipped**
- Depends: MP-5.1 (partial, issue #9)
- Files: `server/gamemanager.js`, `server/gameserver.js`, `js/ui.js`
- The auto-cycling half issue #9 deferred: `GameManager` keeps exactly one host-less,
  always-public lobby open (`_spawnAutoLobby`, called once from the constructor and again
  from `_onAutoLobbyStarted` every time one actually starts), cycling map size through a
  fixed rotation (`AUTO_LOBBY_ROTATION`: small/medium/large — xlarge excluded, it's the
  perf-stress size, not a pick-up-and-play one). `GameServer.configureAutoLobby()` marks
  a lobby `isAutoLobby`, which changes three behaviors: `joinClient` can no longer have its
  `isPublic` flag overridden by a joiner's own `join.public` (first-joiner-wins doesn't
  apply to what has no human host); `GameManager.reap()` no longer deletes it just because
  it's an empty LOBBY-stage game (`listPublicLobbies` still needs it to exist and be
  listed even at zero players); and `_maybeAdvanceAutoLobby` — called on every join/leave —
  drives the fill-or-timer rule from issue #9 verbatim: at `autoConfig.maxNations` human
  players it starts immediately (no bots left to spawn), at `GameServer.autoLobbyMinPlayers`
  (2) it starts a one-shot `GameServer.autoLobbyCountdownMs` (30s) timer, and below that it
  cancels any running timer — so a lobby that dips back under the threshold doesn't still
  fire a few seconds later with too few players. Bot count at start is computed then, not
  stored in `autoConfig`: `maxNations - humanCount`, i.e. humans literally take Nation
  slots a bot would otherwise fill, per issue #9's own phrasing.
- `listPublicLobbies()` and the `lobby_info` broadcast both grew an `isAuto` flag plus
  `mapSize`/`minPlayers`/`maxPlayers`/`autoStartAt` for an auto lobby (`autoStartAt` is
  `null` whenever no countdown is running) — both are the server's own `obj`-typed payload
  shapes (`Protocol.validateMessage` does not look inside them, see that method's own
  comment), so no protocol.js schema change was needed. `js/ui.js` renders an auto lobby's
  Join-screen entry as "Open lobby — <size>" plus a live-ish (4s-polled) countdown instead
  of a host's name, and the in-lobby status line shows "Open lobby — starts once N players
  join." or "Starting in Ns…" instead of the host-flow's default text; the static
  `#joinWaiting` "Waiting for the host to start…" caption (which predates this task and
  assumes a human host) is blanked for an auto lobby rather than left saying something
  false.
- No sim files touched — no golden re-record.
- Done when: the server has exactly one open public lobby at all times, even right after
  one just filled and started; two players joining it triggers a 30s countdown that a
  third player leaving (dropping back below 2) cancels; and hitting `maxNations` players
  starts it immediately with 0 bots. Verified with a scripted two-`GameServer`-instance
  smoke test (timer start/cancel/fire, fill-up, empty-lobby reap survival) and live over
  `node server/index.js` with two real browser tabs: joined the open lobby, watched the
  30s countdown broadcast to both, watched it start into the spawn-phase map with the
  expected bot count, and watched a replacement lobby appear in the list immediately after.

---

## 10. Order-of-work summary

```
Phase 0  determinism        no server, SP stays playable, hash harness green
Phase 1  intent pipeline    no server, SP now runs on the MP code path
Phase 2  server             two scripted clients share a turn stream
Phase 3  multi-human sim    real 2+ player matches
Phase 4  resilience         reconnect, desync detection, rate limiting
Phase 5  optional           public lobbies (partial, #9), replay, binary wire, worker
```

The commitment point is Phase 1: once singleplayer runs through `Transport` /
`GameRunner` / `Executor`, there is one code path and the server is additive. Everything
before that is defensible on its own merits (determinism bugs are real bugs), and
everything after is plumbing.
