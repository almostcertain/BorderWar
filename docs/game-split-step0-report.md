# Step 0 STOP report

Step 0 is complete. Step 1 has not started. No game source or loader changes
were made, and no git commands were run. Source inspection used targeted
searches and sed line ranges; the verification tools load source into Node VM
contexts as required by the plan.

## Acceptance outputs

```text
PARITY OK (309 properties)
RECORD OK (8 scenarios, 44000 ticks), 66.15s
RECORD OK (8 scenarios, 44000 ticks), 66.68s
REPEAT RECORD OK (8 byte-identical golden files)
COMPARE OK (8 scenarios, 44000 ticks), 65.52s
```

The two recordings' eight JSON files matched byte for byte, checked with
SHA-256. The unperturbed comparison exited 0. The negative control,
`node tools/sim-harness.js compare --perturb`, exited 1 with:

```text
DIVERGENCE small-12345 tick 500: expected 2569892756, got 2691497406
```

`js/game.js` and its frozen baseline copy have identical SHA-256:
`C08BB4CEE96A2D2C34B50CB4611A79A68ED3B0E63904C0F4EFCFA63E560487F5`.
Parity used the unchanged current game as the pre-extraction candidate.

## Scenarios and runtime

Each scenario has one synthetic human, eight nation bots, and twelve tribes.
The human uses Hash.firstLegalSpawn and the existing synthetic game-start helper.
The late scenario grants each nation bot 100,000,000 gold immediately after
setup via the debug panel's same `p.gold += amount` operation.

Final compare output (requested calls, actual simulation ticks, wall runtime):

- small-12345: 6,000 calls; 3,858 ticks; 1.16s.
- small-67890: 6,000 calls; 2,210 ticks; 0.93s.
- medium-12345: 6,000 calls; 4,765 ticks; 3.68s.
- medium-67890: 6,000 calls; 3,897 ticks; 2.11s.
- large-12345: 6,000 calls; 5,900 ticks; 14.36s.
- large-67890: 6,000 calls; 5,900 ticks; 7.65s.
- xlarge-12345: 2,000 calls; 1,900 ticks; 18.11s.
- late-medium-24680: 6,000 calls; 3,691 ticks; 17.53s.

Total: 44,000 tick calls, 32,121 actual simulation ticks, 880 checkpoints.
The suite takes about 66 seconds, below the approximately three-minute budget.

## Coverage counts

These are real method invocations counted by transparent runtime wrappers;
they are not necessarily successful actions. All three full runs matched.

- launchAttack: 3,181
- launchNavalInvasion: 314
- resolveLanding: 205
- annexRegion: 645
- acceptAlliance: 65
- breakAlliance: 36
- build: 938
- upgrade: 97
- spawnTrain: 773
- stepTradeShips: 32,121
- buildWarship: 83
- warshipShootAt: 15,850
- launchNuke: 34
- detonateNuke: 5
- stepSamMissiles: 32,121

## Files added and line counts

- tools/baseline/game.orig.js: 5,416
- tools/split-common.js: 38
- tools/verify-split.js: 72
- tools/sim-harness.js: 76
- tools/golden/small-12345.json: 514
- tools/golden/small-67890.json: 514
- tools/golden/medium-12345.json: 514
- tools/golden/medium-67890.json: 514
- tools/golden/large-12345.json: 514
- tools/golden/large-67890.json: 514
- tools/golden/xlarge-12345.json: 194
- tools/golden/late-medium-24680.json: 515
- docs/game-split-step0-report.md: 100

## Observations

Spawn selection is followed by the existing 100-call spawn phase. Several
matches then reach their normal win condition early. The harness keeps calling
tick for the requested budget and records the actual simulation tick count;
it does not override the win condition or force the simulation to continue.
No scenario tuning or game-code fixes were needed to achieve coverage.

Goldens contain hashes every 50 calls, a final full-owner-array FNV-1a digest,
and SHA-256 over stable serialization of all Game data fields except the named
cosmetic fields. Map/Set iteration order is preserved and object keys sorted.
No browser stubs were necessary. Wall time is used only for reporting; attempts
to consume Math.random or Date inside the simulation context throw.
