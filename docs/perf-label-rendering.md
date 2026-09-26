# Label and structure rendering — early World game (2026-09-26)

## Report

On a 2017 MacBook Pro (Intel Iris 640, Safari, Retina), frame rate and map
panning dropped sharply once nation names and troop counts appeared early in a
World match (82 nations, 400 tribes).

The previous attempt (PR #38, reverted) also capped tiles conquered per tick.
That was a sim change: it slowed pushes and changed AI behaviour. **Everything
here is render/UI only.** No sim files touched, goldens not affected.

## Method

Built-in browser pane (Chromium) on the same MacBook, viewport 1440×900 at DPR
2, so the canvas is 2880×1800, the same as the Retina screen. World map,
default lobby, fixed seed, advanced to about 150 s of game time (~62 labels
visible at map-fit zoom, ~270 structures).

The pane throttles rAF while hidden, so frames were driven by hand: one
`Game.tick()` every 6th frame, `Render.draw()` + `UI.update()` every frame,
**paced to 16.7 ms** (back-to-back frames make GPU stalls surface in random
calls; see `perf-frame-rate-profile.md`). Old and new label code were swapped
in alternately on the same live match for the A/B.

Caveat: this measures CPU in Chromium. Safari's outlined canvas text is known
to be slower than Chromium's, and GPU time isn't visible to these timers, so
the real gain on Safari needs checking on the machine itself.

## What was expensive

Per frame, before:

| Source | Font changes | Text draws |
|---|---|---|
| `drawLabels` (45–62 labels) | ~140–160 | ~185–215 |
| `drawStructures` level numbers (~230 structures) | ~210 | ~420 |

Every label was fully re-lettered every frame (3 font changes, 2 measures, 2
outlined strokes + 2 fills). Every structure level number was too. Structure
discs and glyphs were rebuilt from paths every frame as well.

## Changes

1. **Label sprites** (`Render.drawLabels`, `renderLabelSprite`). Each nation's
   label (icons, name, troops) is drawn once into its own small canvas and
   stamped with `drawImage`. Redrawn only when something changes:
   - new label, rename, or icon change: next frame;
   - troop count or size change: at most every `LABEL_REFRESH_MS` (500 ms) per
     label, shown scaled meanwhile;
   - at most `LABEL_REDRAW_MAX` (8) redraws per frame, oldest first.

   Why the count cap: the first stamp of a just-redrawn sprite costs ~0.5 ms
   (handing the changed bitmap to the GPU), about 7× the redraw itself
   (0.07 ms). Stamping an unchanged sprite costs ~0.003 ms.
   Text widths come from one measuring context with a fixed font, so the
   main canvas's font never changes for labels.
2. **Level number sprites** (`levelBadge`): one bitmap per level × font size.
3. **Structure icon sprites** (`structureSprite`, `paintStructureIcon`): one
   bitmap per type × owner × built at the current icon size. While the zoom is
   changing, icons are drawn directly (as before), and sprites are built once
   the size has held for 10 frames. Caches are cleared on a new map.
4. **Low graphics** checkbox on the start screen (remembered per browser):
   renders at 1 canvas pixel per CSS pixel instead of 2 on Retina, so a quarter
   of the pixels. That's GPU fill and upload work, which these CPU timers can't
   see, so its gain has to be judged on the device.

## Results (Chromium, paced, same match state)

| Per frame | Before | After |
|---|---|---|
| Frame (draw + UI), mean | 11.0–14.5 ms | 5.4–6.8 ms |
| Frame, 90th percentile | 25–43 ms | 9–10 ms |
| Text draws | ~248 | ~17 |
| `drawStructures` | 2.8 ms | 1.6 ms |
| `drawLabels` (incl. sweep slice) | 4.7–5.9 ms | 2.7–3.7 ms |

The old path's big 90th-percentile frames were GPU backlog surfacing in
`putImageData` (`releaseTiles` 5–11 ms before, ~1 ms after).

## Trade-offs

- Map-label troop numbers refresh twice a second instead of every frame (the
  HUD's own count is unchanged).
- After a zoom step, labels are briefly drawn scaled (slightly soft) until
  their redraw comes up, then snap crisp.
- When many labels come on screen at once they appear over a few frames
  (8 per frame).
- Memory: one small canvas per visible label (~15–30 KB each) and per
  on-screen structure type/owner. Label sprites unused for ~10 s are dropped.

## Not done / next

- Verify in Safari on the 2017 MacBook, with and without Low graphics.
- The label placement sweep walks one nation per frame. With ~480 players a
  full sweep takes ~8 s at 60 fps, so label positions lag a growing nation.
  Not a frame-rate issue.
- `tools/sim-harness.js compare` fails on a clean `main` with a manifest
  mismatch (`js/net/protocol.js`). The goldens restored by the #38 revert
  carry stale file hashes. Unrelated to this change, but compare can't run
  until they're re-recorded.
