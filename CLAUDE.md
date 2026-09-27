# Project rules

## Committing

When a task is finished, always end your final message by asking whether to commit and push it (e.g. "Want me to commit and push this?"). Do this every time, for every completed task, including small ones.

- Ask; don't commit or push until the user says yes. A yes to "commit and push" covers both steps.
- When committing, stage only the files touched for that task (`git add <path>`, never `git add -A`) — parallel sessions can leave unrelated edits in the tree.
- Push with a plain `git push` of the current branch. If it's rejected, stop and tell the user; never force-push to get past it.
- Never tag, force-push, or run other destructive git commands unless explicitly asked.

## Tickets and the board

Work comes from the GitHub project board (the BorderWar project, owner `almostcertain`). A human verifies every ticket, so nothing of mine goes to Done.

- Pick the top card in **Ready**. When starting it, move it to **In progress**; when the work is pushed, move it to **In review**. The user moves it out of In review themselves.
- Never move a card to Done and never close an issue.
- Don't put closing keywords (`Closes`, `Fixes`, `Resolves`) in commit messages or PR descriptions. GitHub would close the issue and the board would move the card to Done. Reference it as `Refs #N` instead.

## Determinism (multiplayer is lockstep)

Every client runs the same simulation from the same seed and inputs, so the sim must produce identical results everywhere. The sim is `js/game/*.js`, `js/ai.js`, `js/map.js` and `js/noise.js`.

- Randomness comes only from the seeded `Game.rng` (mulberry32). Never use `Math.random`, `Date.now` or `performance.now` in sim code.
- Keep iteration order stable: no iterating over anything whose order can differ between clients.
- Rendering, input and UI (`render.js`, `input.js`, `ui.js`, `radial.js`, `fx.js`) may be non-deterministic, but must never write sim state. Purely visual state belongs in the cosmetic set (`Game.COSMETIC_STATE`), which the goldens ignore.

## Sim changes and golden tests

`tools/golden/` holds recorded sim outputs, and `node tools/sim-harness.js compare` checks the current sim against them.

- Run `compare` after any change to sim code. Render- or UI-only changes don't need it.
- If it fails and the change wasn't meant to alter the sim, it's a bug. Fix it.
- If the change is meant to alter sim behaviour, run `node tools/sim-harness.js record` to re-record, and say in the commit message that goldens were re-recorded and why.
- Never re-record just to make a failing compare pass.
- The harness hashes the sim source files, so any byte change to them (even a comment) fails `compare`. Don't make cosmetic edits to sim files.

## Verifying changes

For anything visible in the game, start the `borderwar` preview (`.claude/launch.json`) and check the console for errors before calling it done. Never run dev servers via Bash.

- Test performance work on the `large` map (2000x1000, formerly named xlarge). The Browser pane has no `requestAnimationFrame`, so don't trust unpaced frame times; use allocation/heap metrics instead.

## Where code goes

- Simulation logic goes in the module for its subsystem under `js/game/` (`combat.js`, `structures.js`, `nukes.js`, and so on). Don't grow `core.js` with subsystem logic.
- Rendering goes in `render.js`; input and UI go in `input.js`, `ui.js` and `radial.js`.
- Networking is `js/net/` on the client and `server/` on the host. Before changing either, read the Quick reference at the top of `docs/multiplayer-architecture.md`, then only the sections you need. Task IDs cited in code (`MP-3.4`, `§9 Phase 1`) are in `docs/multiplayer-build-log.md`.
- Finished project records live in `docs/archive/`. Old comments citing `docs/game-split-*.md` mean `docs/archive/game-split-*.md`.

### Module map

Use it to jump to the right file; grep for the method name rather than reading big files whole.

- `js/game/` (sim, one `Game` object extended per file): `shared.js` globals and helpers · `core.js` state, init, spawn phase, tick order, `Game.det` float wrappers · `structures.js` UNITS table, build/upgrade · `economy.js` population, gold · `diplomacy.js` alliances, relations · `attacks.js` attack lifecycle, conquest frontier · `combat.js` attack math, forts, terrain · `annex.js` · `seapath.js` water A* · `naval.js` boats, invasions · `rail.js` · `trade.js` · `warships.js` · `nukes.js` · `sam.js`
- `js/ai.js` (sim): bots. Diplomacy and donations near the top, then strategic savings, `economy` (build choices), nukes and retaliation, build-site pickers, then attack targeting.
- `js/map.js` (sim): map generation, world-map loading, terrain, rivers, spawns. `js/noise.js`: seeded noise.
- `js/render.js`: canvas drawing: tiles and territory reveal, camera, structures and icons, placement previews, fronts, boats, labels.
- `js/ui.js`: DOM panels: build bar, hover panel, `onTap` (click actions), leaderboard, alerts, banners, end screen, lobby screens.
- `js/input.js` mouse, keys, touch · `js/radial.js` right-click nation menu · `js/fx.js` client-only effects · `js/main.js` boot, game loop, multiplayer lobby wiring.
- `js/net/`: `protocol.js` intent shapes and validation · `executor.js` intent to sim (the only mutation path) · `runner.js` turn queue · `transport.js` · `localserver.js` · `hash.js` state digest · `worldmap.js` world map fetch.
- `server/`: `index.js` HTTP and WS · `gamemanager.js` · `gameserver.js` lobby and turn loop · `client.js` · `log.js`.
- `tools/`: `sim-harness.js` goldens · `sim-profile.js` headless tick profiler.

## Communication

The user is producer-level on this project. Keep replies short: what changed, why it matters, and anything risky or needing their decision. Put technical depth in docs (`docs/`), not in chat, unless they ask a technical question directly. Keep the rigor in the work itself (verification, tests), and compress only the report.
