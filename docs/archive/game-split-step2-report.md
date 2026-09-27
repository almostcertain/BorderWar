# Step 2 STOP report

Step 2 is complete. Step 3 has not started. No git commands were run.
All game changes were verbatim extractions, with the required extension
wrappers and loader updates. The frozen baseline remains unchanged.

## Manifest amendment and pre-move verification

Every golden now records a SHA-256 manifest of every source file loaded by
the harness. It hashes and executes the same captured bytes. The manifest
contains noise, map, fx, every loaded game and net script, and ai.

Before simulating each scenario, compare rejects any changed, added, or
removed manifest entry outside js/game/, identifying the file in its error.
Missing manifests also fail. Game source hashes are retained for provenance
but allowed to change during extraction; parity and runtime checks cover them.

The manifest test uses in-memory fixtures without editing protected files or
goldens. It proved rejection for each of the ten protected source files, added
and removed files, and missing manifest entries. It also proved the Game-file
exception and acceptance of unchanged input.

```text
MANIFEST GATE TESTS OK (10 protected-file mutations; added/removed/missing entries; game-file exemptions; unchanged input)
PARITY OK (309 properties)
MANIFEST RECORDED (12 loaded files, 10 protected files outside js/game/)
RECORD OK (8 scenarios, 44000 ticks), 70.99s
MANIFEST OK (12 loaded files, 10 protected files outside js/game/)
COMPARE OK (8 scenarios, 44000 ticks), 71.08s
```

No code moved during this recording/verification phase. All eight goldens had
identical manifests. Their SHA-256 hashes then remained unchanged throughout
the four extractions; no post-extraction re-recording occurred.

The negative control failed before extraction, with exit code 1:

```text
DIVERGENCE small-12345 tick 500: expected 737467258, got 2888358365
```

The same negative-control failure was confirmed on the final split.

## Per-file extraction results

1. sam.js: 246 original lines plus 5 wrapper lines = 251 lines.
   Core after extraction: 5,046 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (13 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 78.03s
   ```

2. nukes.js: 408 original lines plus 5 wrapper lines = 413 lines.
   Core after extraction: 4,638 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (14 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 77.24s
   ```

3. warships.js: 501 original lines plus 5 wrapper lines = 506 lines.
   Core after extraction: 4,137 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (15 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 78.45s
   ```

4. trade.js: 201 original lines plus 5 wrapper lines = 206 lines.
   Core after extraction: 3,936 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (16 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 78.33s
   ```

Every extraction copied exact byte ranges, including leading comments, and
passed both tools before the next extraction. Reassembling shared.js, core.js,
and the four extension bodies in original order reproduces game.orig.js
byte-for-byte. No property bodies, names, comments, or formatting changed.

The loader now orders shared, core, trade, warships, nukes, sam before net/ai.
All state and tick-order code remains in core. Each extension only attaches
its properties through Object.assign(Game, ...).

Suite peaks remain 62 trade ships, 2 SAM missiles, 55 shells, and 29 trains.
All 13 required action counters remain nonzero and match the recorded totals.
Every full suite remains below the approximately three-minute runtime budget.

## Files touched and final line counts

- js/game/core.js: 3,936
- js/game/sam.js: 251
- js/game/nukes.js: 413
- js/game/warships.js: 506
- js/game/trade.js: 206
- index.html: 217; loader block only
- tools/sim-harness.js: 107
- tools/test-source-manifest.js: 56
- tools/golden/small-12345.json: 532
- tools/golden/small-67890.json: 532
- tools/golden/medium-12345.json: 532
- tools/golden/medium-67890.json: 532
- tools/golden/large-12345.json: 532
- tools/golden/large-67890.json: 532
- tools/golden/xlarge-12345.json: 212
- tools/golden/late-medium-24680.json: 533
- docs/game-split-step2-manifest.json: 35
- docs/game-split-step2-report.md: 170

## Manifest

The following is also saved in docs/game-split-step2-manifest.json. `recorded`
is the manifest embedded in each golden before extraction. `current` includes
the four newly extracted scripts. All ten protected entries are identical.

```json
{
  "algorithm": "SHA-256",
  "recorded": {
    "js/noise.js": "771b4972b3eb3e4bb421b32b524f2d0e38c57e85c859bf15d0eb565c468bd25e",
    "js/map.js": "8b40bfcb47c2cc8038f3bec1c188ba213688d90389ad7131285847ff3c96973d",
    "js/fx.js": "d3502cb3ec14127531bba8234c28a2874f58bf1aaf73d35349d44dcd6c9d28c5",
    "js/game/shared.js": "8735ad40029c02040e8c69380540fba2534ffa80848fc4bcd1aef5db234e7e92",
    "js/game/core.js": "f001fa0aa018e06115ca595bb4330a5ebcd8890b6ad9192b1822bff40517c52b",
    "js/net/protocol.js": "52ea3fc2e1bb101c1ac9c3523869481c5bc5e33cc49f05a52c9438474cbff10c",
    "js/net/executor.js": "6e9ae3ee5dfeaa0154bd231447ad15e3bec9ad2dfcb61e05e16e472f843818a9",
    "js/net/hash.js": "1b5e81fc440bb437e4e0ee76005e5532393942668d0f0d0cd158d669724a0d90",
    "js/net/runner.js": "2a6e4f6edf6ac090a1b5ac3c8366b020b8162146b0a911bb5925d793208a7e08",
    "js/net/localserver.js": "2dd0a63137143bde0a350b8c3e6d68d3181e99d980704fff74c13fa5426b1cca",
    "js/net/transport.js": "6658b7997bfd5140811d8cc49e9f435edd87d46caa56f9086bdf4f4017003fb5",
    "js/ai.js": "dd771356df7bbca8896ded8a6fcdf7616c2bbfa3ac7cee9f14aa151f5cd9ba1e"
  },
  "current": {
    "js/noise.js": "771b4972b3eb3e4bb421b32b524f2d0e38c57e85c859bf15d0eb565c468bd25e",
    "js/map.js": "8b40bfcb47c2cc8038f3bec1c188ba213688d90389ad7131285847ff3c96973d",
    "js/fx.js": "d3502cb3ec14127531bba8234c28a2874f58bf1aaf73d35349d44dcd6c9d28c5",
    "js/game/shared.js": "8735ad40029c02040e8c69380540fba2534ffa80848fc4bcd1aef5db234e7e92",
    "js/game/core.js": "81d69e19e80e9b2d95dc82d74045679234d4a2c5a910d54ff583b1d92d78d394",
    "js/game/trade.js": "e6ced7357cc896b630aedac24c8c37f4df7659cc3143023caa5f1b57bd262994",
    "js/game/warships.js": "103601237c947358bf7898ad18e31f09f664a43643e0007b0579bde3362c60c8",
    "js/game/nukes.js": "d32e02c7ffdf8605c701ea37bac90f168a5446b102ef5bdff8b9cd2a3ccc6b83",
    "js/game/sam.js": "2c3d56767ecd4f15581e9b59a7b03d69522ae403a8b0ec2e0a3ceae2f2adf565",
    "js/net/protocol.js": "52ea3fc2e1bb101c1ac9c3523869481c5bc5e33cc49f05a52c9438474cbff10c",
    "js/net/executor.js": "6e9ae3ee5dfeaa0154bd231447ad15e3bec9ad2dfcb61e05e16e472f843818a9",
    "js/net/hash.js": "1b5e81fc440bb437e4e0ee76005e5532393942668d0f0d0cd158d669724a0d90",
    "js/net/runner.js": "2a6e4f6edf6ac090a1b5ac3c8366b020b8162146b0a911bb5925d793208a7e08",
    "js/net/localserver.js": "2dd0a63137143bde0a350b8c3e6d68d3181e99d980704fff74c13fa5426b1cca",
    "js/net/transport.js": "6658b7997bfd5140811d8cc49e9f435edd87d46caa56f9086bdf4f4017003fb5",
    "js/ai.js": "dd771356df7bbca8896ded8a6fcdf7616c2bbfa3ac7cee9f14aa151f5cd9ba1e"
  }
}
```

## Observations

The initial read of docs/game-split-plan.md did not contain the stated manifest
amendment in section 3.2 item 6. The explicit user instruction was followed;
the plan file was not edited.

As previously reported, 44,000 ticks means Game.tick calls, including the
spawn phase and calls after normal match completion. Simulation behavior was
not overridden. No scenario tuning, code fixes, or unresolved check failures
were needed. Baseline, shared helpers, AI, map, fx, noise, and net source files
were not modified.
