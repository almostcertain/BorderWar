# Plan — Split `js/game.js` into modules

> **Status:** Ready to delegate (drafted 2026-09-20). Architect: Claude. Implementer: any agent.
> **Goal:** Cut agent token cost and make the sim navigable, with **zero behavior change**.
> `js/game.js` is 5,416 lines / 275 KB and holds a single object literal, `const Game = { … }`,
> with ~310 top-level properties. Every other file uses it only through `Game.x`.

---

## 1. Decisions (settled; don't reopen these mid-task)

**S1 — Pure move-only refactor.** Every property keeps the same name, body, comments and
formatting. Don't rename anything, fix bugs, reword comments or reformat. If you find a bug,
note it in your report and leave it alone.

**S2 — Stay on classic scripts and extend `Game` with `Object.assign`.** `js/game/core.js`
declares `const Game = { … }`. Each domain file does this:

```js
// js/game/sam.js — SAM Launchers & interceptors.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  …verbatim properties…
});
```

Rejected alternatives: ES modules and classes. Both would change load timing, the
`document.write` loader, and `this` semantics. This approach leaves all ~500 external
`Game.x` call sites untouched, needs no build step and costs nothing at runtime.

**S3 — `core.js` owns all mutable state and the tick order.** All state fields (`players`,
`attacks`, `boats`, `buildings`, `warships`, … `COSMETIC_STATE`), `init`, the spawn phase,
`setOwner`/`updateBorderTile`, entity lookup by id, `tick` and `fastForward` stay in core.
The order of systems inside `tick()` is part of determinism, so it has to be readable in one
place. Domain files hold only constants and methods.

**S4 — Rules for extension files.**
- No getters or setters. `Object.assign` would evaluate them. The only one, `elapsed`, stays in core.
- No top-level `const`, `let`, `function` or `class` declarations. Classic scripts share one
  global scope, so a duplicate name is a load-time `SyntaxError`, and a new global is scope creep.
- A property's leading comment block moves with it.

**S5 — The agent never runs git.** The owner creates the branch and commits at each STOP
point. (Claude's `.claude/settings.json` already denies git writes. Codex follows the same rule.)

---

## 2. Target layout

The line ranges are approximate and taken from the 2026-09-20 file. **Ownership is defined
by property name.** `tools/verify-split.js` (§3) is the final check that nothing was lost.

| File | ≈Lines | Contents (first … last property, plus leading comments) |
|---|---|---|
| `js/game/shared.js` | 124 | Everything above `const Game`: `PLAYER_COLORS`, `BOT_NAMES`, `TRIBE_NAME_A/B`, `tribeName`, `TRIBE_COLORS`, `formatCount`, `formatCountTight`, `formatPop`, `formatGold`, `mulberry32`, `detQuantize`. Top-level globals, moved as-is. |
| `js/game/core.js` | 940 | `det` … `updateBorderTile` (state, dirty tiles, `MAP_SIZES`, `init`, spawn phase, `setOwner`) · `attackById`, `boatById`, `warshipById` · `tick`, `fastForward` |
| `js/game/structures.js` | 380 | `UNITS` … `updateConstruction` (section "Structures") |
| `js/game/economy.js` | 175 | `POP_SCALE` … `goldPerSecond` (sections "Population model" and "Economy") |
| `js/game/diplomacy.js` | 230 | `TRAITOR_DURATION` … `updateDiplomacy` |
| `js/game/attacks.js` | 370 | `RETREAT_DELAY` … `retreatBoat` · `launchAttack` · `resolveOpposingFronts` … `handleDeadDefender` (conquest frontier heap) · `stepAttack`, `frontierTilesOf` |
| `js/game/combat.js` | 470 | `DEFENSE_WEIGHT` … `tileCost` (attack math, large-player rebalancing, forts, terrain, fallout) |
| `js/game/annex.js` | 240 | `touchesPlayer` … `annexRegion` |
| `js/game/seapath.js` | 290 | `SEA_COST_SCALE` … `retraceWaterLine` (A* water pathing and smoothing) |
| `js/game/naval.js` | 280 | `BOAT_SPEED` … `nearestOwnedCoastNear` · `nearestCoastPath` … `resolveLanding` (boats, coast lookup, invasions) |
| `js/game/rail.js` | 570 | `TRAIN_STATION_MAX_RANGE` … `stepTrains` (sections "Rail network" and "Trains") |
| `js/game/trade.js` | 200 | `TRADE_SHIP_SHORT_RANGE_DEBUFF` … `stepTradeShips` |
| `js/game/warships.js` | 500 | `WARSHIP_MAX_HEALTH` … `stepWarships` (includes `pathPos`, `nearestWaterNear`, shells) |
| `js/game/nukes.js` | 410 | `NUKE_MAGNITUDES` … `stepNukes` |
| `js/game/sam.js` | 250 | `SAM_MAX_RANGE` … `stepSamMissiles` |

The loader list in `index.html` replaces `'game'` with `'game/shared', 'game/core', 'game/structures',
'game/economy', 'game/diplomacy', 'game/attacks', 'game/combat', 'game/annex', 'game/seapath',
'game/naval', 'game/rail', 'game/trade', 'game/warships', 'game/nukes', 'game/sam'`. `shared` and
`core` must come first. The rest attach methods that resolve at call time, so their order doesn't
matter, but keep this order anyway. Update the loader comment to match.

Nothing on the server `require`s `game.js` (only `net/protocol.js`), so `server/` doesn't change.
Don't touch `ai.js`, `render.js`, `ui.js`, `input.js`, `radial.js`, `main.js` or `js/net/*`.

---

## 3. Verification tools (build these first, before moving any code)

A move-only refactor passes when two independent checks both pass after every extraction.

### 3.1 `tools/verify-split.js` — property parity (static)
Zero dependencies, Node only.
1. Load the frozen baseline `tools/baseline/game.orig.js` into one `vm` context and the split
   files (in loader order) into another. Stub `GameMap`, `Fx`, `AI` and `TribeAI` as empty objects. Nothing runs at load time.
2. Assert that `Game` has the **same key set** in both contexts.
3. For every key, compare the property descriptors: data vs accessor must match. Functions must
   match on `fn.toString()`, byte for byte. Getters are compared on the getter's `toString()`.
   Data values are compared by deep equality, handling `Map` and typed arrays.
4. Assert that the set of **global names** each context defines is the same, apart from the
   expected differences.
5. Print `PARITY OK (<n> properties)` or list every mismatch and exit non-zero.

Verbatim moves keep `toString()` identical, so this check catches dropped, duplicated, edited
or reformatted members.

### 3.2 `tools/sim-harness.js` — golden-trace determinism (runtime)
Zero dependencies, Node only. It runs the real simulation headless.
1. Parse the loader array from `index.html` and load the entries up to and including `ai` into a `vm`
   context, skipping `render`, `input`, `ui`, `radial` and `main`. A split then shows up in the harness
   without editing it. Stub browser globals only if a sim file actually touches them. `game.js` itself
   only calls `Fx.*`, which is cosmetic.
2. Set up matches the same way `Hash`'s dual-run harness does (`js/net/hash.js`,
   `firstLegalSpawn` / the cfg → `gameStartInfo` block): one synthetic human, fixed seed, then `tick()` N times.
3. Record a trace. Every 50 ticks, store `Hash.compute()`. At the end, store a **strong digest**
   too: FNV over the full `GameMap.owner` array, plus a stable serialization (sorted keys, `Map`/`Set`
   expanded) of every `Game` state field except `COSMETIC_STATE`.
4. **Scenarios.** Keep the whole suite under about 3 minutes. Use at least small, medium and large ×
   2 seeds, around 6,000 ticks each, plus one xlarge run of around 2,000 ticks. Add a *late-game* scenario
   that gives bots gold early, using the same path as the debug panel's gold grant (find it in
   `main.js`/`ui.js`), so silos, nukes, SAMs and warships show up within the tick budget.
5. **Coverage.** In the harness only, wrap Game methods at runtime to count calls. Never edit the
   source for this. Count at least: `launchAttack`, `launchNavalInvasion`, `resolveLanding`,
   `annexRegion`, `acceptAlliance`, `breakAlliance`, `build`, `upgrade`, `spawnTrain`,
   `stepTradeShips`, `buildWarship`, `warshipShootAt`, `launchNuke`, `detonateNuke`,
   `stepSamMissiles`. `record` must fail if any counter stays at 0 across the suite. Tune the
   scenarios until they all fire.
6. The CLI is `node tools/sim-harness.js record` (writes `tools/golden/*.json`) and
   `node tools/sim-harness.js compare` (exits non-zero on the first divergent checkpoint and prints
   the scenario and tick). `--perturb` adds 1 troop to player 1 at tick 500 as a negative control.

**Phase 0 acceptance.** `record` run twice gives identical goldens. `compare --perturb` **fails**.
`compare` passes. `verify-split.js`, run against a split that is just a copy of the baseline, passes.
A harness that has never been shown to fail hasn't been shown to work.

---

## 4. Steps

Each step ends at a **STOP**. The agent reports and the owner reviews and commits.
Inside a step, run **both** tools after *each* file extraction, not just at the end of the step.

**Owner, before starting:** create branch `refactor/split-game-js` from `main`.

| Step | Work | STOP report |
|---|---|---|
| **0** | Copy `js/game.js` → `tools/baseline/game.orig.js`. Build both tools (§3) and record the goldens. Prove the negative control. | Tool outputs, coverage counts, suite runtime |
| **1** | Move the file to `js/game/core.js` with **unchanged** content. Then move lines above `const Game` into `shared.js`. Update the loader. | Parity plus compare |
| **2** | Extract the leaf systems: `sam`, `nukes`, `warships`, `trade` | Per file: line count, parity, compare |
| **3** | Extract `rail`, `seapath`, `naval` | same |
| **4** | Extract `annex`, `attacks`, `combat` | same |
| **5** | Extract `diplomacy`, `economy`, `structures`. `core.js` should now be about 940 lines. | same, plus final line counts for all files |
| **6** | **In the browser:** (a) `Hash.verifyDeterminism()` from the console on medium passes; (b) play a singleplayer match for a few minutes, including debug gold, building every structure type, a nuke and a naval invasion, and confirm there are no console errors; (c) Tier-1 multiplayer: `cd server && node index.js`, host in one tab, join in another, play 2 minutes, and confirm there is no desync banner. Update the §3 file layout in `docs/multiplayer-architecture.md` and the project status/agent docs if they exist. Delete `tools/baseline/`. Keep `sim-harness.js` and the goldens, which stay useful as a regression suite. | Checklist results |

**Optional step 7** is its own commit. Update prose comments that say "game.js" (`grep -rn "game\.js" js server docs`,
excluding `.claude/`) to name the new file. Comments only. Re-run parity. It will fail
wherever a comment *inside* a method changed, which is expected, so list those keys in the report.

---

## 5. Rules for the implementing agent

- **Stop and report instead of improvising** if any property can't move verbatim. Examples: a
  property whose initializer reads another property during literal evaluation, a check that
  won't go green, or anything that seems to need a code change.
- **Save tokens:** never print or read all of `game.js`/`core.js`. Use `grep -n` to find
  boundaries and `sed -n 'a,bp'` to read or cut ranges. Do the cutting with a script that copies
  exact line ranges. Never re-type code.
- Ignore `.claude/worktrees/`. It holds a stale early copy of the game.
- Don't change `.claude/`, `server/`, or anything else outside `js/game/`, `index.html`'s loader
  block, `tools/`, and `docs/`. The owner handles `.gitignore` if the goldens need it.
- Lockstep invariants still apply to the tools themselves: they only *observe* the sim.
  They never feed wall-clock time, `Math.random` or render state into it.
- **Every STOP report** includes files touched with line counts, the parity output, the compare
  output (scenario count and ticks), coverage counts (step 0), and anything surprising.
