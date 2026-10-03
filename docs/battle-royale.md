# Battle Royale — The Drill

Status: spec, not started. Branch: `feature/battle-royale`.

## Purpose

A late-game ender for stalemates, and a win route for small, turtled nations
with a strong economy. One player builds **The Drill**; a circle centred on it
closes in over ~10 minutes, and everything outside it is permanently destroyed.
Last nation standing wins.

## Decisions (agreed 2026-10-02)

| Topic | Decision |
|---|---|
| Counterplay | **Unstoppable.** Once placed, the circle closes regardless of what happens to the Drill or its owner. |
| Limit | **One Drill per match.** The first placement locks it out for everyone. |
| Win rule | **Last nation standing** (last team in team games). The land-share win is switched off the moment a Drill is placed. |
| Unlock | **Cost is the only gate.** No match timer, no tech prerequisite. |
| Circle size | Starts just large enough to cover the farthest land tile from the Drill (nothing dies on frame one); closes continuously to zero — no safe zone, no pause. |
| Duration | ~10 minutes of shrinking, continuous all the way to zero. |
| Warning | Global banner + target circle shown on placement, then a countdown before shrinking starts. |
| Bots | Bots can build the Drill. |

## Proposed defaults (not yet confirmed — see Open questions)

- **Cost:** 20M flat (confirmed). Tunable constant.
- **Countdown:** 90 s from placement to first shrink.
- **Shrink:** radius falls linearly from start radius to zero over 600 s, without stopping.
- **Drill structure:** permanent and indestructible; nukes don't remove it,
  capture doesn't remove it. It's a marker, not a target (the circle is
  unstoppable anyway). The tile under it is capturable like any other.
- **Placement:** on the builder's own land tile, instant (no build time — the
  countdown is the telegraph).

## Mechanics

### The circle
- State: `drill = { ownerId, tile, cx, cy, placedTick, startTick, r0 }`, plus
  the derived current radius. `null` until placed.
- Radius is computed per tick from `(tick - startTick)` in integer/fixed-point
  math; inside/outside tests compare squared integer distances. No floats in
  the hot path (determinism, and `Game.det` wrappers where floats are unavoidable).
- Each tick only the **annulus between the previous and the new radius** is
  processed, so the cost is proportional to land lost that tick, not map size
  (large map is 2M tiles).

### The dead zone (outside the circle)
A new permanent tile state, separate from existing fallout (fallout is
recapturable; this isn't).
- Land tiles: owner set to NEUTRAL, marked dead. Dead tiles can't be
  attacked, annexed, settled, built on, nuked for effect, or crossed by rail.
- Structures on dead tiles are destroyed (cities, ports, silos, SAMs, forts, factories).
- Units outside the circle are destroyed: boats, invasions in transit,
  warships, trains, scouts. Nukes already in flight still land; a blast on
  dead tiles has no effect.
- Troops: a nation's troops drop in proportion to land lost (same rule as
  losing land to a nuke), so a nation squeezed out entirely dies.
- A nation with no land left is eliminated through the normal `eliminatePlayer` path.
- Pathing (sea A*, attack frontier, annex) treats dead tiles as impassable.

### Win condition
- Once a Drill is placed, the land-share win check is skipped.
- FFA: the match ends when one nation is left alive. Tribes don't count and
  don't block the win. Alliances don't share the win.
- Teams: the match ends when only one team has members alive.
- **Circle fully closed:** if more than one nation is still alive when the last
  land tile dies, the nation that held the most land on the previous tick wins
  (ties: more troops, then lower player id — deterministic). Teams: the team
  with the most combined land wins. The match always ends by the 10-minute mark.

### Fog of war
The fog branch isn't merged. When it is, the circle, the dead zone and the
Drill's location are visible to everyone regardless of fog.

## Presentation (client only, non-sim)
- Build bar entry (icon, hotkey, cost, disabled after the match's Drill exists, with a reason).
- Placement preview showing the starting circle.
- On placement: global banner ("<Nation> has built The Drill — the world is
  closing in"), alert sound, camera ping.
- Circle overlay: current edge (bright) and the Drill centre marker; dead zone
  drawn as a dark irradiated tint distinct from normal fallout.
- HUD timer: countdown to shrink, then time until full closure.
- Edge warning: tint/pulse on your own territory that will be lost within ~30 s.
- Minimap (if present) shows the circle.
- End screen states the win came from Battle Royale.

## Bots
- **Build:** a bot builds the Drill when it can afford cost plus a reserve and
  the match has stalled (e.g. no nation over X% land after Y minutes, or the
  bot's land share has been flat for Z minutes). Thresholds are tuning constants.
- **Out of scope for v1:** bots moving toward the centre or avoiding building
  in the doomed ring. Follow-up ticket.

## Multiplayer
- Placement is a normal build intent through `js/net/executor.js`; the
  protocol validates the type and the one-per-match rule.
- All new state (drill record, dead set) is included in `js/net/hash.js`.
- Purely visual state (pulses, overlay animation) goes in `Game.COSMETIC_STATE`.

## Goldens
This is a deliberate sim change. Matches without a Drill should behave
the same, but adding a unit type can shift bot build choices, so expect
`compare` differences. Goldens are not re-recorded unless asked.

## Tasks

Status key: `todo` · `in progress` · `done` (agent finished, awaiting human check).
Agents don't commit; the user reviews and commits. Phases run in order; tasks
within a phase run in parallel and touch disjoint files.

### Phase A — foundation (sequential, one agent)

**BR-1 · Drill unit + placement** — `done` · model: opus
- `structures.js`: `drill` UNITS entry, flat 20M, `action`-style placement on
  the builder's own land tile, instant. Block reasons: already placed this
  match, not own land, can't afford.
- `protocol.js` / `executor.js`: intent shape + validation (type, one-per-match).
- Placement creates the `Game.drill` record (BR-2) and spends the gold.
- Done when: a scripted placement in the harness creates the record once; a
  second attempt by anyone is rejected; gold is deducted.

**BR-2 · Circle state + shrink schedule** — `done` · model: opus
- New `js/game/drill.js` (Game extension): constants (`DRILL_COUNTDOWN_S=90`,
  `DRILL_SHRINK_S=600`), `r0` = distance to farthest land tile from the Drill
  (ceil, integer), `drillRadius(tick)` in integer/fixed-point math, linear to 0.
- Hook a `stepDrill()` into the tick order in `core.js` (call only, no logic).
- Register the file in `index.html`, the sim harness's loaded sources and
  `tools/sim-profile.js` if it lists files. Add `drill` to init/reset and to
  `js/net/hash.js`.
- Done when: radius schedule is correct at placement, countdown end, midpoint
  and end; matches with no Drill are unaffected.
- Notes for later tasks (BR-1/BR-2 as built):
  - `js/game/drill.js`: constants `DRILL_COST` (20M), `DRILL_COUNTDOWN_S`,
    `DRILL_SHRINK_S`, `DRILL_FP` (1024 fixed-point units per tile).
  - `Game.drill` (drill.js:34): `{ ownerId, tile, cx, cy, placedTick,
    startTick, endTick, r0, r, rPrev }`. `r0` is whole tiles; `r` (current
    tick) and `rPrev` (previous tick) are fixed-point. The spec's "current
    radius" lives on the record as `drill.r` — `Game.drillRadius` is the
    function, so it can't also be a field.
  - `Game.drillRadius(tick)` (drill.js:107): fixed-point radius at any tick
    (r0 through the countdown, linear to 0 at `endTick`). Render (BR-6) can use
    `drillRadius(...) / DRILL_FP` for drawing; HUD timers use `startTick` /
    `endTick` against `Game.ticks` (10 ticks/s).
  - `Game.drillDist2(tile)` / `Game.drillInside(tile, rFp?)` (drill.js:119/128):
    integer inside test, `dist2 * FP * FP <= r * r`; defaults to `drill.r`,
    true everywhere when no Drill.
  - `Game.stepDrill()` (drill.js:138), called from `core.js` tick() (core.js:975)
    after `stepNukes` and before the elimination sweep and win check. It
    updates `rPrev`/`r`; the commented hook is where BR-3 writes
    `Game.drillPrevLand` (declared null in drill.js:38, reset in `initDrill`)
    and sweeps the annulus `r*r < dist2*FP*FP <= rPrev*rPrev`.
  - `Game.drillBlockReason(playerId, tile)` (drill.js:49) — reasons: Nation
    defeated / The match has not started / The Drill has already been built /
    Your own land only / Not enough gold. BR-5's build bar and placement
    should call it, then send `Protocol.intent.buildUnit('drill', tile)`;
    executor routes it to `Game.placeDrill` (executor.js:272).
  - UNITS `drill` entry (structures.js:214) is `action: true` with no hotkey —
    that flag is what keeps `AI.economy`'s generic loop off it. BR-7 must add
    a dedicated purchase call. `ui.js:280` hides it from the build bar until
    BR-5 (remove that check; there is no `assets/icons/drill.svg` yet).
  - `js/net/hash.js` mixes the record only when `Game.drill` is non-null
    (no-Drill digests unchanged). BR-3 must add the dead-tile set there.
  - No-Drill neutrality: `node tools/sim-harness.js baseline` (on the
    pre-change tree) then `neutral` passed with `UNITS` changing only.

### Phase B — gameplay (parallel, after A)

**BR-3 · Dead zone sim** (tiles, structures, units, troops, pathing) — `done` · model: opus
- Permanent dead-tile set (typed array preferred for perf), in the hash.
- `stepDrill` sweeps only the annulus between last and current radius:
  land tiles → NEUTRAL + dead; structures on them destroyed; boats,
  invasions, warships, trains, scouts outside the circle destroyed;
  troops drop in proportion to land lost; landless nations eliminated via
  `eliminatePlayer`. Radius 0 kills every remaining tile.
- Dead tiles can't be attacked, annexed, settled, built on, railed through,
  or pathed through (`attacks.js`, `annex.js`, `structures.js`, `rail.js`,
  `seapath.js`, `naval.js`, `warships.js`). Nuke blasts on dead tiles: no effect.
- Done when: a harness run with a Drill placed shows land monotonically
  shrinking inside the circle, no ownership ever reappearing outside it, and
  per-tick sweep cost on `large` reported.
- Notes (as built):
  - State (`drill.js`): `Game.drillDead` (drill.js:49) — `Uint8Array` over the
    whole map, 1 = dead, land and water alike; allocated/zeroed in `initDrill`.
    Once the circle has started shrinking it is exactly the complement of the
    circle, so `drillDead[t]` is the "outside?" test everywhere. Counters
    `drillDeadLand` / `drillDeadTiles` (drill.js:51) are what `hash.js` mixes
    (only once a Drill exists); the set itself follows from the record.
  - `Game.drillPrevLand` / `Game.drillPrevTroops` (drill.js:40): `Int32Array`
    / `Float64Array` of length `players.length`, indexed by player id, holding
    `tiles.size` / `troops` as they stood before this tick's sweep. Written by
    `stepDrill` on every tick once a Drill exists (countdown included); null
    before. Read only through `teams.js` `drillLandBefore(id)` /
    `drillTroopsBefore(id)` (teams.js:311/316), which BR-3 adjusted so the
    closure tie-break uses pre-sweep troops.
  - `stepDrill` (drill.js:171) → `drillSweep(outer2, inner2)` (drill.js:223):
    row-wise scan with both circle edges solved per row by `drillIsqrt`, so a
    tick costs rows + killed tiles. Kills `dist2` in `(floor(r²/FP²), floor(rPrev²/FP²)]`
    (whole tiles; `r = 0` kills the centre too). The first sweep's outer bound
    is the whole map (marks the water beyond r0 dead once). `drillKillRun`
    (drill.js:284): mark dead, delete the structure (nuke-style unit/pending
    bookkeeping), `setOwner(t, NEUTRAL)`, drop fallout, add to `dirtyTiles`
    (water too — BR-6 can tint it). Then troops ×= land left / land had for
    the home reserve, that player's attacks and boats (player-id order), rails
    with an end or bend in the dead zone are cut (both stations' `rails` maps
    too), trains on such routes scrapped.
  - `drillKillUnits` (drill.js:314), every tick after the first sweep: boats,
    warships (with `units.warship` decrement), trade ships, scouts (clears
    `scoutSearch`) on a dead tile sink; trains on a dead tile go. Nukes/MIRVs
    in flight carry on. `drillInside` now returns false for every tile at r = 0.
  - Landless nations: troops hit 0 with their last tile, so core.js's existing
    `tiles 0 && troops < 20` sweep calls `eliminatePlayer` the same tick.
  - Blocking: attacks on NEUTRAL skip dead tiles (`attacks.js` refreshFrontier,
    stepAttack's pop and enqueue); boats never land on or pick a dead shore
    (`naval.js` nearestOwnedCoast; a boat whose landing tile dies mid-crossing
    turns back at the retreat toll; beachhead fronts skip dead tiles); sea A*,
    LOS smoothing and Scout search treat dead water as impassable
    (`seapath.js`); rails can't be laid across it (`rail.js` straightClear);
    cached port routes through it are re-searched (`trade.js` portRoute,
    `drillPathDead`); nuke blasts add no fallout on dead tiles (`nukes.js`).
    Annex and build need no change: they only act on owned tiles, and a dead
    tile is NEUTRAL forever (annex already treats NEUTRAL as a gap).
  - Known quirk: an attack's `border` Set can keep a tile that died until it
    is popped (same as a tile a third party takes); it only nudges front
    width, never ownership.
  - Verified (scratch harness, real sim, 8 bots/12 tribes): medium seeds
    12345/67890, large, small teams-4 and teams-2 — every tick: no owned tile,
    structure, boat, warship, trade ship, scout, rail or train in the dead
    zone; no `setOwner(dead, player)` ever; dead land monotonic; full closure
    leaves 0 owned, all land dead, nothing alive. Winner by 9.1–11.5 min after
    placement in every run. Forced simultaneous closure resolves by previous-tick
    land (FFA and teams). Two runs hash-identical. `stepDrill` on large
    (Drill in a corner, r0 = 1756): mean 0.95 ms/tick, p99 2.2 ms, first sweep
    5.9 ms; median heap delta ~0.1 KB/call. Medium: mean 0.45 ms, p99 1.0 ms.

**BR-4 · Win condition** — `done` · model: sonnet
- `core.js` win block / `teams.js`: once `Game.drill` exists, skip the
  land-share win. FFA: last nation alive wins (tribes ignored, alliances
  don't share). Teams: last team alive.
- Full closure: if >1 nation alive when the last land dies, the one with the
  most land on the previous tick wins (ties: more troops, then lower id).
  Teams: most combined land. Needs BR-3 to record previous-tick land counts —
  coordinate via a `Game.drillPrevLand` snapshot written in `stepDrill`
  before the sweep (BR-4 owns reading it; BR-3 owns writing it).
- Done when: harness run with a Drill always ends with a winner by ~11.5 min
  after placement.
- Notes (BR-4 as built):
  - `core.js` win block: with `Game.drill`, FFA calls `Game.checkDrillWin()`; teams'
    `checkTeamWin()` delegates to it first. Both in `game/teams.js`.
  - Standing = alive with land, non-tribe. FFA: one standing nation wins; teams:
    one standing team wins (winnerTeam set, winnerId = its biggest member).
  - Nobody standing (closure): most land before the sweep, then troops (current,
    post-sweep), then lower id; teams use combined land/troops, lowest member id.
    Always picks a winner, so a Drill match cannot stall.
  - `Game.drillLandBefore(id)` is the single reader of `Game.drillPrevLand`
    (array or Map by player id, missing = 0). Adjust there if BR-3's shape differs.
  - Tested with scratch script on injected state (not BR-3's real sweep);
    no-Drill `neutral` passes for small-12345 and teams4.

**BR-5 · Build bar, placement preview, alerts** — `done` · model: sonnet
- `ui.js`: build-bar entry (icon, hotkey, cost, disabled reasons), global
  banner on placement, alert sound if the game has one.
- `render.js`: placement preview drawing the starting circle.
- Done when: in the `borderwar` preview, placing a Drill works end to end with
  no console errors.
- As built: build bar entry (`assets/icons/drill.svg`, hotkey K, shows "Built" once placed);
  `UI.onTap` drill branch uses `Game.drillBlockReason`; ghost circle uses `Render.drillPreviewRadius`
  (per-row land extremes, equals `drillStartRadius`, no map pass); banner `#drillBanner` (8 s) on first sight
  of `Game.drill`; placement ping rings. No alert-sound system exists, so no sound; the ping is rings, not a camera move.

**BR-6 · Circle + dead-zone rendering, HUD timer** — `done` · model: sonnet
- `render.js`: current circle edge, centre marker, dead-zone tint distinct
  from fallout, own-territory edge warning (lost within ~30 s); minimap if any.
- `ui.js`: countdown, then time to full closure.
- Visual-only state in `Game.COSMETIC_STATE`; never write sim state.
- Done when: verified in preview on the `large` map, heap/allocation metrics
  not regressed (no per-frame full-map loops).
- As built: `Render.drawDrill` (edge, centre marker, dead tint, 30 s danger band) + HUD chip `#drillHud`
  (`UI.updateDrillHud`; "YOUR LAND IS NEXT" via 1 Hz `Render.ownLandDoomed` over border tiles). Dead tint is a
  placeholder: all land outside the circle, from low-res land masks built once per map in `Render.brLand()`
  — switch the dead mask there to BR-3's dead set when it exists. No minimap in the game.

**BR-7 · Bots build the Drill** — `done` · model: sonnet
- As built (`ai.js` `maybeDrill`/`drillSite`, called first in `economy`):
  `DRILL_STALL_AFTER` 1500 s match time, `DRILL_STALL_SHARE` 0.5 (no nation
  above 50% of land), `DRILL_RESERVE` 2M gold left after paying, `DRILL_CHANCE`
  1-in-3 per economy cycle (rng drawn only after every other gate passes).
  Stateless: no history, nothing new to hash. Site = own tile nearest the
  centroid of its land. Tribes never build it; nobody once `Game.drill` exists.
- `ai.js`: build when gold ≥ cost + reserve and the match has stalled (no
  nation above a land threshold after N minutes, or own share flat for M
  minutes). Tunable constants; deterministic (Game.rng only).
- Done when: a long harness run on `medium` sees a bot place a Drill in a
  stalled game and not in an early game.

### Phase C — finish (after B)

**BR-8 · Balance + playtest pass** — `done` · model: opus
- Tune countdown, duration, bot thresholds; profile the sweep on `large`
  with `tools/sim-profile.js`; fix any hot spots. Report numbers here.
- Results (as built):
  - **Dead tint is the real dead set.** `render.js` `paintTile` tints dead
    land (`Game.drillDead`, `tintDead`, dark violet) on the tile layer, so
    only tiles the sweep queues in `dirtyTiles` are repainted; no per-frame
    map loop. Dead water gets a single path fill over everything outside the
    circle in `drawDrill`. BR-6's placeholder land mask is gone (`brLand`
    keeps only the 30 s danger mask).
  - **First-sweep hitch: fixed.** The sweep queued every dead water tile for a
    repaint. In the preview on `large` (Drill at 899,219) that was 70k tiles
    and a 15.7 ms frame (normal ~2-3 ms); a Drill near an edge queues ~1M,
    roughly 14x that plus ~12 MB of reveal-queue arrays. `drillKillRun` now
    queues land only (water looks the same).
  - **Human eliminated mid-shrink: not a bug.** Reproduced: the passive human
    was conquered by a bot (`handleDeadDefender`) during the countdown, all
    its land inside the circle. Control: headless `medium` 12345, a passive
    human dies at tick 1012 with or without a Drill.
  - **Match length is capped by construction.** At `endTick` (placement +
    90 s + 600 s) the radius is 0, the sweep kills every land tile, nobody is
    standing, and `checkDrillWin`'s closure rule always picks a winner. About 20
    Drill matches here ended 8.8–11.4 min after placement; the preview run
    ended at 6878 of 6900 ticks.
  - **Sweep cost.** `drillSweep` now keeps each row's live half-width
    (`Game._drillHalf`) and steps it inward instead of two `isqrt` per row
    per tick. Same kills in the same order (final hash identical).
    `node tools/sim-profile.js 8300 large 12345 8 12 --drill=1100` (new
    flag): `stepDrill` mean 0.19 ms, p99 0.43 ms, max 6.7 ms (the first sweep)
    vs BR-3's 0.95 / 2.2 / 5.9. Medium: 0.43 → 0.06 ms mean. The large run's
    worst ticks (50-100 ms) are pre-existing port-trade `seaPath` searches,
    same as without a Drill.
  - **Bots never built the Drill.** No bot banks past ~1.6M (they spend
    everything, base income is 1k/s), so the 22M gate never passed, even in
    an hour-long three-way stalemate (`world` 67890). Fixes in `ai.js`:
    `drillStalled(p)` (25 min passed, nobody above `DRILL_STALL_SHARE`, p not
    the land leader) makes `'drill'` the bot's `savingsGoal` with a reserve of
    cost + 2M; `DRILL_STALL_SHARE` 0.5 → 0.8, because two matches froze for
    30–65 min with the leader at ~77% (short of the 90% win); the land leader
    (ties included) never builds it. Countdown 90 s and shrink 600 s are
    unchanged; nothing in the data argued for moving them.
  - Bot-only long runs (8 bots, 12 tribes, up to 75 min), final constants:

    | Map / seed | Drill placed | Builder | Result |
    |---|---|---|---|
    | medium 12345, 24680; medium-easy 67890 | — | — | normal win 14.8–23.6 min |
    | medium-hard 13579 | 36.9 min | 23% (2nd of 2) | builder won, 8.8 min later (before: frozen 77/23 for 75 min) |
    | large 12345, 22222, 67890 | — | — | normal win 25.2–37.6 min |
    | world 11111 | 42.0 min | 0.4% (6th) | builder won, 11.0 min later |
    | world 12345 | 33.3 min | 8.4% (4th) | builder won, 9.5 min later |
    | world 33333 | 34.5 min | 1.6% (4th) | builder won, 11.2 min later (before: frozen at 76.5%) |
    | world 44444 | 55.8 min | 14.8% (4th) | builder won, 11.4 min later |
    | world 67890 | 39.5 min | 3.3% (5th) | builder won, 10.7 min later |

    Never before 33 min. Deterministic (two runs, same hash).
  - **Open / risky:** the builder won every bot Drill match, including a
    0.4% nation. The circle is centred on its land and bots don't move toward
    the centre or go after the builder (the v1 follow-up). Humans will contest
    the centre, but for bots the Drill is close to a guaranteed win. Bots
    saving for it also stop building for 10–30 min. No harness covers
    matches past 10 min, so this long-game change is checked only by these
    runs.
  - Also: end screen says "last nation standing — Battle Royale" when a Drill
    exists (spec item, was missing); HUD chip reads "Battle Royale over" once
    a winner is set.
  - No-Drill neutrality: `node tools/sim-harness.js neutral` passes, all 12
    scenarios.

**BR-9 · Docs** — `done` · model: haiku
- Add `drill.js` to the module map in `CLAUDE.md`; player-facing help text
  if the game has a help/tutorial panel.

Follow-ups (not v1): bots retreat toward the centre; fog-of-war integration
once that branch merges.

## Open questions
1. **Countdown:** 90 s OK? (building with 90 s)
2. **Indestructible Drill:** confirm it's just a marker (since the circle can't be stopped). (building as a marker)
