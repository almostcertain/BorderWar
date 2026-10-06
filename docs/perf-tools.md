# Performance tools

How to measure the game. Findings live in the dated `perf-*.md` docs; this
is only the toolbox.

## In the game (`js/perf.js`, client-only)

`Perf` times the sim and the renderer from outside. It never writes sim
state, and it loads after the sim files, so the goldens don't see it.

**Show FPS** (Options) now reads `58 fps · sim 12/45 ms · draw 4.1 ms`:
frame rate, mean/worst turn over the last 5 s, mean draw over the last 2 s.
A turn longer than ~16 ms is a dropped frame.

**Copy performance report** (Options) copies `Perf.text()` to the clipboard
(and prints it to the console): browser, screen and canvas size, match
state, then mean/p50/p95/p99/max for frame interval, sim ms per turn, draw
ms and UI ms, plus counts of frames over 33/50/100 ms. This is the way to
get numbers from a player's own machine: play for a minute, pause, open
Options from the menu or the console, copy, paste. The series hold the last
20 s of frames and 2 min of turns, and reset when a new match starts.

Console API:

| Call | What it does |
|---|---|
| `Perf.report()` / `Perf.text()` | The report as an object / as text |
| `Perf.reset()` | Clear the series |
| `Perf.detail(true)` | Wrap `Render.draw*`, `UI.update*` and the sim's tick phases in timers; reports then include a per-method breakdown (ms per frame, ms per turn). `false` restores the originals. A row includes the rows it calls |
| `Perf.advance(toTick, budgetMs)` | Singleplayer: run the match forward without drawing (takes the first legal spawn if needed). Returns the tick reached; call again until it gets there |
| `await Perf.bench({frames, turnEvery, paceMs, detail})` | Singleplayer: a fixed hand-paced run (default 300 frames at 16.7 ms, one turn every 6th frame, detail on). Returns the report, also kept as `Perf.last` |

`advance` and `bench` send turns through the normal pipeline
(`LocalServer.endTurn` → Runner → Executor), never a bare `Game.tick`.

### Measuring in the Browser pane

The pane has no working `requestAnimationFrame`, so the real loop does not
run there. Use:

    Perf.advance(1500)            // repeat until it returns 1500
    await Perf.bench({ frames: 240 })
    Perf.text(Perf.last)

In a bench report `frame ms` is the work done per frame (turn + draw + UI),
not a frame interval.

Rules that have bitten before:

- **The tab must be visible.** With the pane hidden, canvas uploads measured
  about 8× slower (`flushLayerPuts` 10 ms hidden, 1.2 ms visible). The report
  flags `TAB HIDDEN`; discard those runs.
- **Frames must be paced.** Back to back, the GPU falls behind and the stall
  lands in whichever call touches a canvas next. `bench` paces for you.
- GPU fill time is invisible to these timers. Only a real-screen fps reading
  shows it: compare reports with Low graphics on and off.
- Use the same seed, map, lobby and tick for a before/after.

## Headless sim (`tools/`)

    node tools/sim-profile.js 6000 world 12345 82 400 --json=before.json
    # ...change the sim...
    node tools/sim-profile.js 6000 world 12345 82 400 --vs=before.json

`sim-profile.js` prints tick percentiles, total time per phase and the worst
20 ticks. `--json=FILE` saves the summary; `--vs=FILE` prints a before/now
table against a saved one and says whether the final state hash matches. A
matching hash means the change was behaviour-neutral and the timings compare
like for like. Compare only runs from the same machine, and keep the saved
files out of the repo.

For per-function self time, without the phase wrappers:

    node --cpu-prof --cpu-prof-dir=/tmp/prof tools/sim-profile.js 3000 world 12345 82 400
    node tools/cpu-top.js /tmp/prof

Reference lobbies: The World default is 82 nations + 400 tribes; large
procedural is usually profiled at 50 + 40.
