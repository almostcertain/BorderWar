# Frame-rate profile — The World, mid-match (2026-09-24)

## Method

Browser pane, The World (2000×1000), default lobby (82 bots, 483 players at
start). Advanced 3,300 ticks (~9.5 min game time) to a mid/late state: 48 →
35 nations alive, ~650k owned tiles, 229 cities, 166 forts, 65 ports, ~340
trade ships in flight. Canvas 1280×720, dpr 1.

No `requestAnimationFrame` in the pane, so frames were driven by hand
(`Game.tick()` every 6th frame, `Render.draw()` + `UI.update()` every frame),
with every `Render.draw*` / `UI` / `Game` / `AI` method wrapped in timers.

**Caveat found along the way:** back-to-back frames with no idle time make
the GPU fall behind, and the stall surfaces inside whichever call next
touches a canvas (here `putImageData` in `releaseTiles`, which read as 6 ms
per frame). With a 16 ms gap between frames, as a real rAF loop gives, that
cost disappears. Measure render work paced, not in a tight loop.

## Per-frame CPU cost (paced)

| Part | ms / frame |
|---|---|
| `Render.draw` total | **3.5** |
| — `drawStructures` | 1.8 |
| — `drawLabels` (incl. one label-sweep slice) | 0.6 |
| — trade ships, trains, fronts, boats, warships, rails | ~0.7 |
| — territory reveal (`releaseTiles`, paced) | small |
| `Game.tick` (amortised, 10 Hz over 60 fps) | 0.65 |
| `UI.update` | 0.1 |

Steady-state CPU is ~4.5 ms of a 16.7 ms frame. **The average frame is not
CPU-bound at this resolution.** Frame-rate problems come from (a) sim-tick
spikes and (b) GPU/fill cost, which the pane can't measure.

## Sim tick spikes — the hitches

1,500 unwrapped ticks: p50 2.7 ms, p90 6.2, p99 13.5, max 48.8. 84 ticks >
8 ms (the main loop's `SIM_BUDGET_MS`), 12 > 16 ms. Each >16 ms tick is at
least one dropped frame.

What the slow ticks were doing (instrumented run):

| Cause | Share of slow ticks | Typical size |
|---|---|---|
| **Trade route search** (`updatePortTrade → portRoute → seaPath`) | large majority | 10–45 ms, worst seen ~85 ms (instrumented) |
| Bot naval planning (`AI.navalThink → nearestCoastPath → seaPath`) | some | 5–11 ms |
| Annexation (`checkAnnexations → enclosedPocketsOf`) | some | ~7 ms |

### Why trade routing still spikes

`portRoute` caches routes, but the cache is capped at
`PORT_ROUTE_CACHE_MAX = 1024` entries (each direction stored separately;
since raised, see Applied below).
With 65 ports there are ~2,080 port pairs (4,160 directed), so the cache
sits full and evicts constantly. Over 600 ticks: 129 uncached trade
searches, 15 failed, median 0.9 ms, max 23.5 ms, 335 ms total. The budget
(`SEA_PATH_BUDGET_PER_TICK`) counts searches rather than work, so several
long searches can land in one tick.

## Rendering observations

- `drawStructures` is the largest render cost. The fort and SAM range
  circles are drawn for **every** fort/SAM on the map with no off-screen
  cull (the icon pass below does cull), each with a translucent fill plus a
  dashed stroke. 166 forts means 166 large alpha-blended circles per frame
  when zoomed out, which is GPU fill as much as CPU.
- Territory reveal uploads one bounding box around all tiles changed that
  frame (avg ~450k px, ~¼ of the map, because fronts are scattered).
  Splitting into 32/64 px chunks made no measurable difference to CPU time.
  It may still matter on a weak GPU (upload bandwidth), but unproven.
- Label placement sweep: ~0.3 ms/frame amortised. Troop numbers themselves
  are negligible.

## Options

| # | Change | Expected gain | Trade-off / risk | Sim change? |
|---|---|---|---|---|
| 1 | Raise route cache cap (e.g. 8192) and store one direction per pair; store paths as `Int32Array` | Removes most trade searches after early game, so most of the big hitches go | Memory: roughly 10–20 MB at the cap on The World | Yes (budget use shifts). Re-record goldens |
| 2 | Per-tick **node** budget for `seaPath` instead of a search count (doc `perf-world-map-hitching.md` rec. 5) | Hard ceiling on any tick's path cost, including naval AI | Trade ships / invasions occasionally start a tick or two later | Yes. Re-record |
| 3 | Cull off-screen fort/SAM range circles; skip them entirely below a zoom threshold | Up to ~1–1.5 ms CPU zoomed in, plus GPU fill zoomed out | Ranges invisible when very zoomed out (could keep for own/selected only) | No |
| 4 | Coarse-grid water pathfinding (rec. 6 in the hitching doc) | ~4× cheaper every sea search | Largest change; route shapes shift | Yes. Re-record |
| 5 | Halve troop-number / label refresh | Negligible (<0.3 ms) | Labels lag growth | No |

Recommended order: 1 and 3 first (small and local), then 2 if hitches
remain.

## Applied (options 1 and 3)

- **Route cache:** `PORT_ROUTE_CACHE_MAX` 1024 → 4096, and each port pair
  is now stored once (keyed min/max tile, direction read off the route's
  last tile) instead of once per direction. With the cap removed, the
  new storage is behaviour-identical to the old across all 12 golden
  scenarios (checked with the route cache excluded from the digest). The
  goldens were re-recorded because the bigger cap means fewer re-searches,
  which changes when `SEA_PATH_BUDGET_PER_TICK` runs out.
  Replaying the same stream of route requests through a shadow copy of
  the old cache (The World, ~80 ports): 852 vs 1,223 searches
  (−30%) mid-game, 651 vs 1,224 (−47%) later, as the cache fills.
- **Range circles:** fort and SAM range circles that are wholly
  off-screen are skipped. Zoomed in: 3 circles drawn instead of 163.
  Nothing changes on screen.

Remaining >16 ms ticks on that match (44 in 1,500), by dominant phase:
first-time trade searches 20, `checkAnnexations` 13, `stepAttack` 11.
Next levers: the per-tick node budget (option 2), then coarse-grid
pathfinding (option 4) for first-time routes, plus a separate look at
annexation.

## Not measured

Real frame pacing and GPU time. Those need a check in a normal browser
window at the player's actual resolution. If the game is slow on a high-DPI
or 4K screen but not at 1280×720, fill cost (option 3, and the full-screen
map `drawImage`) is the likely cause, not JavaScript.
