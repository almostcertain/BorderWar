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
  which changes when the per-tick sea-path budget runs out.
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

## Applied (option 2): per-tick node budget

`SEA_PATH_BUDGET_PER_TICK` (4 searches) is replaced by
`SEA_PATH_NODE_BUDGET_PER_TICK` (40,000 water tiles explored), with each
search also charged `SEA_PATH_SEARCH_COST` (500) for its fixed arena
reset. A search only starts while the tick is under budget; once started
it runs to its own guard. So worst case = budget + one full search.

Why not abort mid-search: it wastes the work already done, and a route
bigger than the budget would only ever finish when it happened to be first
in a tick. Callers that come earlier in tick order (warship chases every
tick) would starve it.

Search sizes measured on The World (4,579 searches over 3,000 ticks, about
0.15 µs per tile explored):

| Caller | p50 tiles | p99 tiles | max |
|---|---|---|---|
| trade `portRoute` | 10.6k | 175k | 200k (guard) |
| AI `nearestCoastPath` | 4.5k | 34k | 38k |
| captured-ship `nearestOwnedPortRoute` | 272 | 22.6k | 25k |
| warship chase | 31 | 4.8k | 31k |

A/B on the same seed, ticks 300–7,000 (matches diverge after the change,
so whole-tick numbers are indicative only):

| Sea-path time per tick | Old (4 searches) | New (40k tiles) |
|---|---|---|
| max | 41.1 ms | 31.4 ms |
| p99 | 16.3 ms | 12.4 ms |
| ticks over 10 ms | 178 | 113 |
| total | 7.5 s | 5.9 s |

Whole-tick max stayed ~80 ms in both runs. Those spikes come from other
phases (annexation, land attacks), not sea pathing. The remaining
sea-path ceiling is one full-guard search (~30 ms), which only coarse-grid
pathfinding (option 4) or resumable searches would lower.

## Not measured

Real frame pacing and GPU time. Those need a check in a normal browser
window at the player's actual resolution. If the game is slow on a high-DPI
or 4K screen but not at 1280×720, fill cost (option 3, and the full-screen
map `drawImage`) is the likely cause, not JavaScript.

## Follow-up: Firefox profile, large map (2026-09-28)

A real Firefox profile (17 s of play on the large map) answered the "not
measured" question above.

- **Frame rate ~30 fps** (frame interval p50 20 ms, p90 68 ms), yet the page's
  main thread was 60% idle, averaging 11 ms of work per frame. The bottleneck
  was Firefox's GPU-process canvas thread, ~80% busy.
- **Cause: canvas copies.** Firefox copies a CPU-side canvas (anything edited
  with `putImageData`, or small sprite canvases) to the GPU process on *every*
  `drawImage`, whether it changed or not. Each frame that meant the whole
  2000×1000 tile canvas (8 MB) plus every label sprite, costing ~2.4 ms of
  memcpy for tiles and ~2.4 ms for labels on the main thread, with the same
  copies again plus texture allocation in the GPU process. The hover overlay
  added a full 8 MB `putImageData` plus copy on each rebuild.
- **Fix (render.js, render-only):** the tile and hover layers are drawn from
  128×128 `ImageBitmap` chunks (`makeLayer` / `drawLayer`). Bitmaps are
  immutable, so the browser uploads each one once, and only chunks whose
  pixels changed get a new bitmap. Off-screen chunks are skipped. The hover
  overlay now clears, blits and draws only its bounding box. Label sprites
  are stamped from an `ImageBitmap` snapshot taken after each redraw.
- **Still open (sim):** first-time trade-route searches (`portRoute` →
  `seaPath`) cause 25–33 ms turns. They made up about half of all turns over
  20 ms, and they are the visible hitches. Fixing them is a sim change (see
  the resumable-search and coarse-grid options above).
- **Second Firefox profile, after the fix:** ~64 fps, up from ~30. Labels
  dropped from 2.4 ms to 0.16 ms per frame. The tile layer was still copying
  ~2.3 ms per frame, because changed tiles were grouped into one bounding box,
  which on a large map with fronts everywhere covers the whole map and
  re-uploads every chunk. Changes are now tracked per 128×128 chunk
  (`markLayerTile` / `flushLayerPuts`), so only chunks that actually contain
  changed tiles are blitted and re-uploaded.
