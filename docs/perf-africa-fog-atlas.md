# Perf: Africa, fog of war, atlas visuals (Firefox, 2026-11-06)

Source: `Firefox 2026-11-06 08.11 profile.json.gz` (Firefox 158, Windows 11,
NVIDIA GPU, ~120–144 Hz display). 18.8 s of play on the default Africa map
(1948×2032 tiles). Build profiled: `5639052` (line numbers match it; render.js
changes since then are river colouring only, so the findings hold for `main`).

## Headline numbers

| | |
|---|---|
| Frame rate | 85 fps average (66–125 per second) |
| Frame interval | p50 9 ms · p90 21.5 ms · p99 40 ms · max 88 ms |
| Hitches | 99 frames > 25 ms, 19 > 40 ms, 7 > 60 ms |
| Game thread CPU | 78% of a core (60–94% per second) |
| GPU process `CanvasRenderer` | 58% of a core |

Playable, but the main thread has little headroom and the hitches are visible.

## Where the game thread goes (CPU-weighted)

| Share | What |
|---|---|
| ~50% | `draw` |
| 26–28% | of which `drawAtlasTerritory → drawLayer → drawImage(c.bmp)`: a raw memcpy |
| 7% | of which labels (`computeLabelSlice` 6.4%) |
| 2.6% | of which hover highlight; fog 2–4% |
| ~17% | sim (`tick`), about 13 ms per turn |
| 10% | of which `stepAttack`, with `fortInRange` alone 7.7% |
| 2% | of which `checkAnnexations` (average; see spikes) |
| ~27% | browser work with no page JS: paint, layout, waits, plus ~10% more memcpy whose stack was truncated (almost certainly the same drawImage) |

Total memcpy on the game thread: 36%.

## Finding 1: the territory layer is copied on every draw

The ImageBitmap fix from 2026-09-28 (see `perf-north-america-options.md`)
assumed Firefox uploads a bitmap once and reuses it. In this profile it does
not: every `drawImage(c.bmp)` of a tile-layer chunk does a section map + memcpy
in the content process, and a matching memcpy on the GPU process's
`CanvasRenderer` thread (38% of that thread, plus `NtUnmapViewOfSectionEx`).

Scale check: zoomed out on Africa ~250 chunks of 128×128 are on screen
(64 KB each, 16 MB per pass). `drawAtlasTerritory` draws the tile layer twice
whenever the camera is past `NEAR_FROM` (colour wash, then multiply). At
~85 fps that is 1.4–2.8 GB/s, which matches the memcpy time seen.

The `CanvasRenderer` thread also shows Skia raster-pipeline work
(`srcover_rgba_8888`, `evenly_spaced_2_stop_gradient`, `xy_to_radius`): the
remote canvas is compositing at least partly in software, and the radial
gradient (vignette, `render.js` createRadialGradient) is part of it.

Options, cheapest first:

1. **GPU-resident copy per chunk.** When a chunk gets a new bitmap, draw it
   once into a per-chunk canvas that is never touched by putImageData or
   getImageData, then draw that canvas each frame. Canvas-to-canvas draws on
   the remote canvas should stay in the GPU process. Must be confirmed with a
   Firefox profile; the Browser pane (Chromium) can't show it.
2. **One pass instead of two in atlas.** Bake the wash into the multiply
   pass, or draw the tile layer once into an offscreen canvas and composite
   that twice. Halves the copies even if option 1 fails.
3. **Cap drawing at 60 fps on high-refresh displays.** The sim is 10 Hz; on
   a 144 Hz screen we draw ~2× more than a 60 Hz player for little visible
   gain. Battery saver already caps at ~30 fps when the camera is still.

Expected win: most of the 26–36% memcpy share on the game thread, and much of
the GPU process load.

**Status: option 1 implemented** (`Render.chunkCanvases`, `stampChunkCanvas`
in `render.js`). It covers every `drawLayer` layer: tile, hover, relief,
ground. It is on in Firefox only, decided per layer when the layer is built.
Checked in the Browser pane with the flag forced on: all 256 Africa chunks are
pixel-identical to the tile layer, hover works, dispose frees the canvases.
The speed-up itself can only be confirmed in Firefox:

1. Same setup as above (solo Africa, fog on, atlas), zoomed out, ~20 s.
   Capture a Firefox profile.
2. Pass: `memcpy` under `drawLayer → drawImage` mostly gone, and
   `CanvasRenderer` in the GPU process well under 58%.
3. A/B in one session: `Render.chunkCanvases = false` in the console, then
   start a new match (layers read the flag when built).

If Firefox still copies canvas-to-canvas draws, fall back to option 2.

## Finding 2: the hitches are mostly sim spikes

In the 25 worst frames (33–85 ms):

| Share | What |
|---|---|
| 26% | `checkAnnexations` (enclosed-pocket sweeps) |
| 19% | `stepAttack` |
| 18% | territory drawImage (Finding 1) |
| 8% | `drawFog` |
| 4.5% | `stepWarships` |

`checkAnnexations` is cheap on average (2%) but bursty: when it runs a full
sweep it lands a whole frame. Spreading the sweep over ticks, the way trade
routes now search a slice per tick (`2b10e5f`), would flatten those frames.
That is a sim change and has to stay deterministic.

## Finding 3: `fortInRange` is a steady 7.7%

`Game.fortInRange` (`combat.js`) loops over every building for every tile an
attack costs. With many buildings on a big map that adds up to ~1.1 s of the
18.8 s. A per-owner fort list, or a coarse grid of fort positions, would make
it close to free. Same answer for every input, so it should pass the golden
`compare` unchanged.

## Smaller items

- Labels 7%: `computeLabelSlice` / `stepLabels`.
- Hover highlight 2.6%: also a drawLayer path, so Finding 1's fix helps it.
- Layout/reflow ~3% from DOM updates (`updateBuildBar`, MutationCallback).
