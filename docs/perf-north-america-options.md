# North America early-game frame rate: findings and options

Source: Firefox profile, 2026-10-27 (16 s of early game, North America,
2800x1448 = 4.05M tiles, ~2x the `large` test map; 427 players). Firefox
had GPU-accelerated canvas on (remote CanvasRenderer, NVIDIA driver).

## What the profile shows

Main thread (content process), share of all samples:

| Where | Share | Notes |
|---|---|---|
| `drawImage` in `drawLayer` (tile layer) | ~31% | almost all of it `memcpy` into shared memory for the GPU process |
| `drawImage` in `drawLayer` (hover layer) | ~3% | same path |
| label sprite `drawImage` / render | ~5% | same path, smaller |
| `putImageData` + premultiply (`flushLayerPuts`) | ~4% | CPU pixel push into the tile canvas |
| `ImageBitmap.close` + unmap | ~3% | freeing replaced chunk bitmaps |
| sim `tick` | ~12.5% | `stepAttack` 9%, of which `fortInRange` 4.6%, `largeTerritoryBonus` 1.3%; annex 2% |
| idle | ~16% | |

The GPU-process `CanvasRenderer` thread is ~55% busy, most of it a second
`memcpy` of the same pixels. 891 refresh ticks were "waiting for paint",
i.e. the compositor was behind.

Frames: ~62 fps average, but frame gaps are p50 12.5 ms, p90 29 ms, p99 43
ms. The 146 frames that ran a sim tick spent ~7.4 ms in it, on top of the
draw, so there is a hitch every 100 ms turn.

Measured in the Browser pane on the same map (tick ~50, whole map in view):
**~51 of 264 tile chunks get a new ImageBitmap every frame, ~0.83 Mpx
(3.3 MB) of fresh pixels per frame.** The jittered territory reveal paints a
slice of every active front each frame, so every chunk with a front is
re-bitmapped ~60 times a second. In Firefox each new bitmap is a new upload
to the GPU process. The 128 px chunk bitmaps fixed the "copy unchanged
canvas every frame" problem (2026-09-28); what's left is copying *changed*
chunks far more often than the eye can see.

## Options

### A. Throttle chunk re-uploads (render-only, small)
Cap how often one chunk may get a new bitmap (e.g. every 50-100 ms), and/or
a per-frame upload budget (N chunks, visible ones first). Make the cap
zoom-aware: zoomed out, one chunk is ~40 screen px and 10-15 Hz updates are
invisible; zoomed in on a front, keep it near per-frame.
Expected: 3-6x fewer uploads in the early game. Risk: fronts step a little
when zoomed out. Effort: hours. Sim untouched.

### B. Smaller chunks (render-only, trivial)
64 px chunks (16 KB) instead of 128 px (64 KB): a front touching a chunk
re-uploads a quarter of the pixels. 4x the drawImage calls (1056 on NA), so
it pairs best with A. Effort: a constant plus measuring.

### C. Low-res overview layer when zoomed out (render-only, medium)
Below ~1 screen px per tile, draw from a 2x- or 4x-downsampled tile layer
(4-16x less data to upload and blit), switching to full res when zoomed in.
Effort: a day or two; borders need care so they don't vanish at low res.

### D. WebGL territory renderer (render-only, large)
Upload owner IDs (2 bytes/tile) to a texture with `texSubImage2D` for only
the changed rows, and colour + border-detect in a shader with a palette
texture. Uploads shrink by ~2x per tile and only cover changed tiles;
`putImageData`, premultiply, bitmap churn and the hover layer all go away.
Scales to any map size, helps every browser. Effort: 1-2 weeks; fog, hover
tint, alt view, reveal pacing and the low-gfx path all need porting.

### E. Sim hot spots (sim, behaviour-neutral, small)
- `fortInRange` loops over every building for every tile an attack takes.
  Keep a per-owner fort list (or a coarse grid). ~4.6% of all main-thread
  time, roughly a third of the tick.
- `largeTerritoryBonus` runs `log` + `detQuantize` 4x per conquered tile
  for values that only change with `tiles.size`; memoise by
  `(numTiles, depth)`, which is exact.
- Verify both with `node tools/sim-harness.js compare`.
Expected: sim tick ~7.4 ms -> ~4.5 ms, shrinking the 10 Hz hitch.

### F. Keep the tick and the draw out of the same frame (medium)
Today a turn runs inside the rAF callback and the frame then also draws.
Running the turn in its own task just after a frame (or later, moving the
sim to a Web Worker) stops the two stacking into one 15-25 ms frame. The
worker route is the real fix but large: the renderer reads sim state
directly.

### G. Labels (render-only, small)
Label sprites are re-rendered and re-uploaded often (~5%). Re-render only
when the text or size bucket changes, and cap re-renders per frame.

## Results: A done, B rejected (2026-10-27)

`render.js` `refreshLayer` now throttles the tile layer: a dirty chunk waits
`REFRESH_MS_FAR` (66 ms) between bitmaps when a tile is under 1.5 device
px, `REFRESH_MS_MID` (33 ms) under 3 px, none when zoomed in further, and
`REFRESH_MS_OFFSCREEN` (500 ms) off screen. A chunk coming into view
refreshes on the next frame. The hover layer is not throttled.

Browser pane (Chromium), North America, fog off, ticks 64-148, 60-frame
paced runs alternated in one match:

| Config | Bitmaps/frame | Upload MB/frame | Frame ms (mean) |
|---|---|---|---|
| whole map, no throttle, 128 px | 74-81 | 4.8-5.2 | 17.3-17.6 |
| whole map, throttle, 128 px | 30 | 1.9 | 12.7-13.2 |
| whole map, throttle, 64 px | 65 | 1.1 | 24.8-25.5 |
| whole map, no throttle, 64 px | 54-57 | 0.9-1.0 | 25.2-25.6 |
| zoom 4, no throttle, 128 px | 47-58 | 3.0-3.8 | 17.2-18.2 |
| zoom 4, throttle, 128 px | 11 | 0.7 | 14.8-15.6 |

64 px chunks cut the bytes but quadruple the drawImage calls (1056 on this
map), and the frame cost more than doubled, so chunks stay at 128 px.
Firefox gains are unmeasured until a new Firefox profile.

## Suggested order
A (+B) first, then E. Together they target ~40% of main-thread time for a
few days' work and no gameplay risk. C or D only if larger maps or more bots
are a priority; D is the long-term answer.
