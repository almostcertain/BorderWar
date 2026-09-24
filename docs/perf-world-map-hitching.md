# World map hitching — analysis (2026-09-23)

## Method

Headless run of the real sim on The World (2000×1000), seed 12345, 8 bots +
12 tribes, 6000 ticks (10 min of game time), timing every tick and every sim
phase / AI method. Reproduce with:

    node tools/sim-profile.js 6000 world

Measured after d79fe18 (the 4-searches-per-tick seaPath budget).

## Result

| Tick time | ms |
|---|---|
| p50 | 1.8 |
| p95 | 8.3 |
| p99 | **164** |
| max | **617** |

149 ticks over 16 ms, 102 over 50 ms. Every one of the 20 worst ticks is
`AI.navalThink` (bot overseas-invasion planning): 365–615 ms in a single tick.
Nothing else in the sim comes close (land combat `stepAttack` peaks at a few ms).

Where navalThink's time goes (whole run):

| Cost | Total ms | Notes |
|---|---|---|
| `seaPath` A* searches | 13,500 | 421 full searches |
| — of which searches that **failed** | 9,800 | 68 searches, ~144 ms each, all hit the 200k-node guard |
| `onSameLandmass` | 7,600 | 84,000 calls, each scans every tile the bot owns |
| `nearestDist` | 1,060 | |

## Causes

1. **The per-tick budget counts searches, not work.** One World-map search
   costs 5 ms (p50) to 190 ms (worst). Four of the expensive ones in one tick
   is a 600 ms stall; the cap of 4 doesn't prevent that.
2. **Failed searches are the most expensive ones.** A target in the same body
   of water but far away (around a continent) makes A* explore the full
   200,000-node guard before it gives up. These are 16% of searches but 72%
   of search time, and nothing remembers the failure, so the bot tries again
   on its next naval think.
3. **The same route is searched up to three times in a row.** For each
   candidate, navalThink runs `isRouteTooIndirect` → `navalInvasionBlockReason`
   → `launchNavalInvasion`, and each one calls `nearestCoastPath` for the same
   attacker and target. Two of the three are redundant. (They also use up the
   budget, which is why 98 later searches came back null "over budget.")
4. **`onSameLandmass` is O(territory) and is called in a loop.** navalThink
   calls it for every coast sample on every landmass (720 samples × 60
   landmasses), and each call iterates over all of the bot's tiles. On the
   World map a large bot owns tens of thousands of tiles.

## Recommendations (in order of value / risk)

| # | Change | Expected effect | Sim behaviour change? |
|---|---|---|---|
| 1 | Compute the set of landmass IDs the bot holds once per navalThink (or maintain per-player landmass counts in `setOwner`) instead of calling `onSameLandmass` per sample | Removes ~1/3 of navalThink cost | **No.** Goldens should pass unchanged |
| 2 | Cap AI searches by the detour limit: navalThink rejects any route longer than 2.5× straight-line anyway, so pass a node guard derived from that instead of 200k | Failed searches drop from ~144 ms to a few ms; this is most of the spike | Yes: re-record goldens |
| 3 | Memoise `nearestCoastPath` per tick, keyed by (attacker, landing tile), so the check/launch/detour trio runs one search | ~⅔ fewer searches from navalThink | Yes (budget consumption changes): re-record |
| 4 | Negative-cache "no route" per (attacker, target landmass) for ~30 s of game time | Stops retrying known-unreachable targets | Yes: re-record |
| 5 | Replace the "4 searches per tick" budget with a node-expansion budget per tick (deterministic, not wall-clock) | Hard ceiling on per-tick search cost regardless of map | Yes: re-record |
| 6 | Longer term: coarse-grid water pathfinding (OpenFront runs A* on a half-resolution "mini map", then refines) | ~4× fewer nodes on every search, including trade ships and warships | Yes: re-record |

1–3 together should remove nearly all of the measured spikes. They are small,
local changes in `js/ai.js` and `js/game/naval.js`. 4–6 are hardening.

All of these are deterministic (tick- and count-based, never wall-clock), so
lockstep is unaffected.

## Fixes applied (1–3)

- **1:** navalThink collects the bot's landmass IDs once
  (`heldLandmasses`). Verified behaviour-identical against goldens recorded
  from the unmodified tree.
- **2:** `seaPath(sources, target, maxSteps)` prunes routes longer than
  `maxSteps` and shrinks its node guard to `maxSteps ×
  SEA_PATH_NODES_PER_STEP` (16). The AI's detour check passes
  `2.5 × straight-line`. Trade-off: about 11% of successful AI routes on The World were
  very long crossings needing 76k–187k nodes; those now count as "too
  indirect" and the bot picks another target.
- **3:** `nearestCoastPath` memoises found routes for the rest of the tick
  (cleared at tick start/end and on any `setOwner`), so check → validate →
  launch runs one search.
- **Also fixed:** the per-tick search budget (d79fe18) was consumed by
  client-local UI (the radial menu's Boat check) and by intents applied
  before `tick()` reset it — a multiplayer desync risk. Budget and memo now
  only apply while `Game._inTick` is set.

Goldens re-recorded. d79fe18 had already changed the sim without
re-recording, so they were failing on main before this change.

After (same run, seed 12345, 6000 ticks):

| Tick time | Before | After |
|---|---|---|
| p50 | 1.8 | 1.6 |
| p99 | 164 | 27 |
| max | 617 | 114 |

## Port trade routing (follow-up)

`updatePortTrade` searched a fresh route every time a port spawned a trade
ship. On The World, 23 of 30 trade searches repeated a port pair already
searched, and single searches cost up to ~105 ms.

Fix: `Game.portRoute(from, to)` caches port-to-port routes for the match.
The route between two fixed tiles only reads water tiles and `shoreDist`,
which never change, so the cache can't go stale. It stores up to 1024
entries, evicting the oldest first so every client evicts the same ones. A cached B→A
route also answers A→B (reversed). Genuine failures are cached. A null
caused by the per-tick budget is not. The cache is only written inside
`tick()`.

Result (seed 12345, 6000 ticks): 4 real searches instead of 30; worst
trade tick 105 → 64 ms (one first-time search); all served routes checked
valid (adjacent water tiles, ending on the destination port).

## Remaining spikes

- **AI naval**, occasionally ~70 ms: up to three capped searches in one
  navalThink. This is now the worst remaining tick. Recommendations 4–6 address it.
- **First-time long trade routes**, ~60 ms, once per port pair per match.
  Recommendation 6 (coarse-grid pathfinding) is what would shrink these.

## Not covered

Rendering was not profiled here. The sim spikes above are large enough to
explain the reported hitching on their own; re-check render cost on the World
map after they are fixed.

# Xlarge, 50 nations — annexation sweep (2026-09-24)

`node tools/sim-profile.js 6000 xlarge 12345 50 40` (profiler now takes bot
and tribe counts).

Every 20 ticks `checkAnnexations` asks, for every player and every enemy it
borders, "is this enemy's ground enclosed?" — a flood fill of the enemy's
component. A landlocked mainland ringed by several nations passes the
enclosed test (then fails the mainland rule), so it was flooded in full once
per bordering player, every sweep: 200–260 ms per sweep.

Fix: one `AnnexSweep` cache per sweep (`js/game/annex.js`). The verdict for a
component depends only on ownership, so the first walk's result is reused by
every other bordering player until an annexation actually happens (which
resets the cache). Passing pockets are still re-walked from the player's own
contact tile so tile order, and therefore the sim, is unchanged.

| | before | after |
|---|---|---|
| `checkAnnexations` total (6000 ticks) | 36,058 ms | 7,882 ms |
| worst sweep | 256 ms | ~50 ms |
| tick p95 / p99 / max | 75 / 184 / 311 ms | 27 / 64 / 162 ms |
| ticks > 50 ms | 335 | 101 |

Goldens: every checkpoint hash, the owner map and event coverage matched in
all 13 scenarios. Only the final state SHA changed, because it hashes the
leftover bytes of the 4-int `abuf` scratch buffer; re-recorded for that.

Remaining spikes (~100–110 ms) are all `AI.navalThink` →
`isRouteTooIndirect` → `seaPath`, i.e. recommendations 4–5 above (negative
route cache, per-tick node budget) not yet done. Both change bot behaviour.
