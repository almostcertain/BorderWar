# Firefox software-canvas slowdown (profile 2026-10-31)

Local "Play now" in Firefox on Windows (Ryzen 7 7800X3D), atlas style, fog on, mid zoom.

## What the profile showed

- Content main thread saturated: ~20 fps, median `draw()` ~38 ms, p90 75 ms, max 120 ms.
- ~90% of samples are under `draw()` → `drawImage`, running **in the content process through Skia's CPU
  bitmap filters** (`SkBitmapProcState`, `S32_alpha_D32_filter_DX`). The GPU process is idle. The
  2026-10-27 North America profile (see `perf-north-america-options.md`) had GPU canvas, so
  Firefox falls back to a software canvas only some of the time.
- Sim is under 5%. Nothing to fix there.
- Cost by pass, near-zoom frame (share of `draw()`): sharp relief 15%, terrain glyphs 15%, base relief
  layer 14%, territory (two passes) 17%, fog 12%, paper 11%, far glyphs 5%.

In software every full-screen pass costs canvas pixels, so a 4K HiDPI canvas is ~4× a 1080p one.

## Changes (render-only)

- Base relief layer skipped once the sharp-relief squares cover the view (`chunksCover`); unpadded
  squares are drawn on whole pixels so no seam shows through.
- Ground layer skipped at zoom blend ≥0.99, far glyphs at ≥0.95 (both under 3% alpha by then).
- `noteDrawTime`: if 70% of 90 consecutive draws take over 28 ms and the canvas is HiDPI, drop to
  one pixel per CSS pixel (same as the Low graphics option) for the rest of the page.

## Open

- If the slow draws happen at dpr 1, the auto step does nothing. Next lever would be a sub-1 render scale.
- Why Firefox falls back to software is unconfirmed (candidates: canvas size limits, accelerated
  draw-target count). `about:support` → Graphics → Canvas on the slow run would say.
