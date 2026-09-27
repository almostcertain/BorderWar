# Step 1 STOP report

Step 1 is complete. Step 2 has not started. No git commands were run.
The game changes are byte-preserving moves; only the loader block in
index.html was edited. The frozen baseline was retained unchanged.

## Requested coverage update

Removed the stepTradeShips and stepSamMissiles invocation counters from the
harness. Each scenario now records peaks of tradeShips, samMissiles, shells,
and trains, sampled after every Game.tick call (plus their initial lengths).
The suite takes the maximum of each per-scenario peak and fails if any is zero.
The other 13 invocation counters still must be nonzero across the suite.
This observes entity arrays without changing simulation state.

Per-scenario peaks, in order: trade ships / SAM missiles / shells / trains:

- small-12345: 0 / 0 / 0 / 3
- small-67890: 0 / 0 / 0 / 3
- medium-12345: 0 / 0 / 0 / 9
- medium-67890: 0 / 0 / 0 / 2
- large-12345: 6 / 0 / 3 / 6
- large-67890: 6 / 0 / 0 / 5
- xlarge-12345: 0 / 0 / 0 / 1
- late-medium-24680: 62 / 2 / 55 / 29

Suite peaks: 62 trade ships, 2 SAM missiles, 55 shells, 29 trains.
Zeroes in individual scenarios are allowed; no entity's suite peak is zero.

## Verification before the moves

Confirmed js/game.js still had the baseline's exact SHA-256:
`C08BB4CEE96A2D2C34B50CB4611A79A68ED3B0E63904C0F4EFCFA63E560487F5`.
Recorded the updated goldens before changing game files or the loader.

```text
RECORD OK (8 scenarios, 44000 ticks), 72.23s
PARITY OK (309 properties)
COMPARE OK (8 scenarios, 44000 ticks), 75.57s
```

The negative control exited 1 as required:

```text
DIVERGENCE small-12345 tick 500: expected 737467258, got 2888358365
```

## Per-move verification

1. Moved js/game.js to js/game/core.js, all 5,416 lines unchanged, and
   pointed the loader to game/core. Byte equality with the baseline passed.

   ```text
   PARITY OK (309 properties)
   COMPARE OK (8 scenarios, 44000 ticks), 77.55s
   ```

2. Copied exactly original lines 1-124 to js/game/shared.js and retained
   original lines 125-5416 in core.js, using byte slices at line boundaries.
   Updated the loader to load game/shared before game/core and updated its
   comments. Concatenating shared.js and core.js equals the frozen baseline
   byte-for-byte, including comments, whitespace, and line endings.

   ```text
   PARITY OK (309 properties)
   COMPARE OK (8 scenarios, 44000 ticks), 77.15s
   ```

All eight goldens remained unchanged throughout Step 1, verified by SHA-256.
The final split also passed the negative-control test by failing at the same
scenario, tick, and hash values quoted above. Every ordinary check exited 0.
The loader edits were reversed in memory and the original file hash recovered,
confirming no changes outside the intended loader text.

## Files touched and final line counts

- js/game.js: moved; old path no longer exists (originally 5,416 lines).
- js/game/core.js: 5,292 lines.
- js/game/shared.js: 124 lines.
- index.html: 216 lines; loader block only.
- tools/sim-harness.js: 83 lines.
- tools/golden/small-12345.json: 518 lines.
- tools/golden/small-67890.json: 518 lines.
- tools/golden/medium-12345.json: 518 lines.
- tools/golden/medium-67890.json: 518 lines.
- tools/golden/large-12345.json: 518 lines.
- tools/golden/large-67890.json: 518 lines.
- tools/golden/xlarge-12345.json: 198 lines.
- tools/golden/late-medium-24680.json: 519 lines.
- docs/game-split-step1-report.md: 108 lines.

## Observations

All current record/compare runs have identical coverage and peaks. Invocation
totals: launchAttack 3,105; launchNavalInvasion 276; resolveLanding 175;
annexRegion 758; acceptAlliance 63; breakAlliance 44; build 979; upgrade 97;
spawnTrain 970; buildWarship 88; warshipShootAt 15,892; launchNuke 40;
detonateNuke 6.

As in Step 0, the 44,000 tick-call budget includes the spawn phase and calls
after normal match completion. No win conditions or spawn behavior were
overridden. The late-game scenario supplies all four entity types, so no
scenario tuning was needed. The new recordings supersede the old Step 0
goldens; Step 1 comparisons all used these new, pre-move recordings.

No simulation properties, bodies, names, or comments were edited. Shared
globals remain classic-script globals; core still contains all Game properties.
Domain extractions are deferred to the later steps.
