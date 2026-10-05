# Performance assessment — low fps on the 2017 MacBook (2026-10-05)

## Machine

MacBook Pro 2017: Core i5-7360U (2 cores, 2.3 GHz), Intel Iris Plus 640,
built-in 2560×1600 Retina display. This is the low end of what the game has
to run on, and every number below was measured on it.

## Method

- **Sim:** `node tools/sim-profile.js 6000 world 12345 82 400` (The World,
  default lobby) and `... 6000 large 12345 50 40`, plus a `node --cpu-prof`
  run of the World match for per-function self time.
- **Render:** Browser pane (Chromium), World map, default lobby, seed 12345,
  fog off, canvas 2048×1536 (DPR 2), map-fit zoom, around tick 1,500–1,700
  (93 nations alive, 331 structures, 236 trade ships). Frames driven by hand
  and paced to 16.7 ms, one `Game.tick()` every 6th frame, with the
  `Render.*` / `UI.update*` methods wrapped in timers.
- Not measurable here: GPU fill time and real frame pacing. Safari was not
  tested; the render figures are Chromium's.

## Findings

### 1. The sim takes most of the frame budget on this CPU

A tick runs on the main thread, so a tick longer than ~16 ms is a dropped
frame, ten times a second.

| Tick time (ms), 6,000 ticks | mean | p50 | p95 | p99 | max | ticks > 50 ms |
|---|---|---|---|---|---|---|
| The World, 82 nations + 400 tribes | 58.6 | 39.0 | 154 | 363 | 584 | 2,202 |
| Large procedural, 50 + 40 | 24.1 | 16.2 | 58 | 160 | 529 | 423 |

In the browser, early game only (ticks 400–1,500, World): mean 19.6, p95
51.5, max 272.

On The World the sim uses more than half of each 100 ms turn by mid-game.
That alone holds the game well under 60 fps, and the p99/max ticks are
visible freezes.

The earlier perf docs quote much lower figures (max 73 ms, 0.15 µs per sea
tile). Those do not hold on this machine: a full-guard sea search here costs
300–500 ms, about 2 µs per tile. The 2026-09-24 code, re-run here on its
then-smaller map, also peaked at 419 ms from the same trade search, so this
is not a recent regression. The maps have since grown 4× in area.

Where the time goes (World, 3,000 ticks, 162 s of CPU, self time):

| Share | Function | What it is |
|---|---|---|
| 25.6% | `seaPath` + `crossTieBreaker` (`seapath.js`) | Water A*. Also every one of the 20 worst ticks, via `updatePortTrade` (first-time trade routes) |
| 10.4% | `detQuantize` (`shared.js:164`) | `toPrecision(12)` string round-trip behind `Game.det.log/exp/pow` |
| 6.2% | `det.log` / `det.exp` / `det.pow` wrappers | Same call path |
| 7.6% | `fortInRange` (`combat.js:266`) | Walks every building on the map for every tile conquered |
| 7.1% | `AI.nearestDist` (`ai.js:2276`) | Bot naval target ranking |
| 3.4% | `attackTickFraction` | Per-tile attack pacing |
| 3.3% | `enclosedRegion` (`annex.js`) | Annexation flood fill |
| 3.2% | `pathPos` (`warships.js:62`) | Allocates an `{x, y}` per call |

`largeTerritoryBonus` calls `det.log` twice per conquered tile, and one of
the two is on a constant (`LARGE_TERRITORY_MIDPOINT`).

### 2. Territory repaint costs ~10 ms per frame (hidden tab; see correction)

**Correction, same day:** the figures in this section were taken while the
Browser pane's tab was hidden (`document.hidden`). Re-run with the tab
visible using `Perf.bench` (docs/perf-tools.md), same match state, canvas
1306×1418: `flushLayerPuts` 1.2 ms, `refreshLayer` 1.7 ms, `Render.draw`
mean 5.8–6.3 ms, p95 15–23 ms. So the tile pipeline is about 3 ms of a 6 ms
draw, not 10 of 13, and the 10× in the isolated test below is likely
inflated the same way. R1 is still the largest single render item, but its
size has to be confirmed from a real-screen report before it is ranked
above the sim work.

| Per frame (paced, with ticks) | ms |
|---|---|
| `Render.draw` + `UI.update`, mean / p50 / p90 / p99 | 13.1 / 6.4 / 33.1 / 49.1 |
| — `releaseTiles` → `flushLayerPuts` | **10.3** |
| — `enqueueDirty` (flushes the previous turn's leftovers) | 2.7 |
| — `drawLayer` + `refreshLayer` | 2.0 |
| — `drawBoats` | 1.2 |
| — `drawStructures` + `drawStructureDots` | 1.4 |
| — `drawTradeShips` | 0.5 |
| — `drawLabels` | 0.1 |
| `UI.update` | 0.5 |

About 1,300 tiles change per tick, spread over ~12 of the 128 map chunks per
frame. Each of those chunks gets a `putImageData` into `tileCanvas` and then
a `createImageBitmap` back out of it. `tileCanvas` is a GPU-backed canvas, so
that is a texture upload followed by a read-back, per chunk, per frame.

Isolated test on this machine, 12 chunks per frame:

| Path | ms per frame (mean / p90) |
|---|---|
| GPU canvas: put, then bitmap (what the game does) | 22.8 / 40.1 |
| CPU canvas (`willReadFrequently: true`): put, then bitmap | 2.0 / 4.1 |
| Bitmap straight from the `ImageData`, no canvas | 2.0 / 3.9 |

The timings include waiting for the bitmap, so they overstate main-thread
cost, but the ratio is about 10×.

Everything else in `draw` is small. Labels and structures, the subject of
the two earlier render passes, are no longer a factor.

### 3. Retina fill cost is unmeasured

The canvas renders at 2× on Retina (up to 2560×1600, 4.1 M pixels) on an
integrated GPU. The pane can't time GPU work, so whether this matters needs
the fps counter on the real screen (Options → Show FPS, with and without Low
graphics).

### 4. Side finding: procedural large map takes ~42 s to generate

`Game.init` for a large procedural map took 41.8 s headless here (The World
loads in 0.9 s). Load time, not frame rate, but worth a ticket.

## Tasks

Ordered by value for effort. "Neutral" means the sim's results must not
change (verify with `sim-harness.js compare`). "Changes sim" means goldens
need re-recording, which is the user's call.

### Render (no sim files touched)

| # | Task | Expected | Size |
|---|---|---|---|
| R1 | Stop round-tripping tile and hover chunks through a GPU canvas: create `tileCtx`/`hoverCtx` with `willReadFrequently: true`, or build chunk bitmaps straight from the `ImageData`. Re-measure with the method above | Up to ~3 ms per frame in a visible tab (see correction in finding 2); confirm on the real screen first | S |
| R2 | Extend Show FPS to also show sim ms per tick and draw ms per frame, so real-device and Safari numbers can be read without a profiler | Enables R3 and checks every other task on the real screen | S |
| R3 | Measure on the Retina screen with and without Low graphics (needs R2). If the gap is large, add an automatic step-down (e.g. 1.5× then 1×) when fps stays low | Unknown until measured | S + M |
| R4 | `enqueueDirty` repaints the whole previous turn in one frame when a turn arrives early (2.7 ms avg, bursty). Cap or spread it | Smaller spikes | S |
| R5 | `drawBoats` (1.2 ms with 62 boats) and `drawStructureDots` (0.7 ms): cull and batch | ~1–1.5 ms | S |

### Sim, neutral

| # | Task | Expected | Size |
|---|---|---|---|
| S1 | `largeTerritoryBonus`: compute `det.log(LARGE_TERRITORY_MIDPOINT)` once, and reuse the result per tile count within a tick. Review other per-tile `det.*` calls in `combat.js` the same way | Up to ~15% of sim time | S |
| S2 | `fortInRange`: keep built forts in a per-owner list (or coarse grid) maintained on build/destroy/capture, instead of scanning `Game.buildings` | ~7% | S–M |
| S3 | `seaPath` inner loop: precomputed tile x/y, inline shore penalty and tie-breaker, typed-array target test instead of a `Set` | Cheaper every search, including the spikes | M |
| S4 | `AI.nearestDist`: precompute coast-sample coordinates once per `navalThink` | ~5% | S |
| S5 | `pathPos` and `warshipAcquireTarget`: no per-call allocation, coarse range reject first | ~3–5% | S |
| S6 | Re-profile `stepAttack` and `checkAnnexations` after S1/S2 and ticket what remains | — | S |

### Sim, changes behaviour

| # | Task | Expected | Size |
|---|---|---|---|
| S7 | Make trade-route searches resumable across ticks, as the Scout search already is (`seaTowardRun`), so no tick pays more than the node budget | Removes the 300–500 ms freezes | M |
| S8 | Coarse-grid water pathfinding (half-resolution search, then refine), as OpenFront does | ~4× fewer nodes on every sea search | L |

### Larger bets (only if the above isn't enough)

| # | Task | Notes |
|---|---|---|
| B1 | Run the sim in a Web Worker so a slow tick never blocks a frame | Render reads sim state directly today, so this needs a state hand-off design. L |
| B2 | Lower the default lobby on The World for weak machines (82 nations + 400 tribes) | Product decision, not code |
| B3 | Procedural large map generation time (finding 4) | Separate ticket |

## Suggested order

R2 is done (docs/perf-tools.md). Next S1 and S2 (small, about a fifth off
each tick), then S7 for the freezes and S3–S5. R1 and R3 wait on a
performance report copied from the real screen.
