# Step 3 STOP report

Step 3 is complete. Step 4 has not started. No git commands were run.
Rail, seapath, and naval were extracted using exact byte ranges, preserving
all property names, bodies, leading comments, whitespace, and line endings.
Each new file has the required Object.assign(Game, ...) wrapper.

## Per-file verification

Both tools passed after each extraction, before the next extraction began.
Manifest preflight checks also passed against all eight existing goldens
before each move. No goldens were re-recorded or modified in Step 3.

1. rail.js: 570 verbatim lines plus 5 wrapper lines = 575 lines.
   Core after extraction: 3,366 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (17 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 70.85s
   ```

2. seapath.js: 301 verbatim lines plus 5 wrapper lines = 306 lines.
   Core after extraction: 3,065 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (18 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 70.84s
   ```

3. naval.js: 265 verbatim lines plus 5 wrapper lines = 270 lines.
   Core after extraction: 2,800 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (19 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 72.25s
   ```

All checks exited 0. All checkpoints, final state digests, action counters,
and entity peaks matched the existing goldens. Each suite made 44,000 tick
calls across eight scenarios, including spawn-phase and post-victory calls.
Actual simulation ticks totaled 36,007. No simulation behavior was overridden.

Suite peaks remain 62 trade ships, 2 SAM missiles, 55 shells, and 29 trains.
All 13 action counters remain nonzero and match the recorded totals.

## Byte and scope verification

Reinserting the three extracted bodies into their original positions exactly
reproduces the pre-Step-3 core. Reassembling that with the shared code and
previously extracted domain bodies reproduces the frozen game.orig.js
byte-for-byte. No simulation code was rewritten or reformatted.

SHA-256 checks confirmed that all eight goldens, all verification tools, the
frozen baseline, shared.js, and the four existing domain files are unchanged.
Removing the three new loader entries in memory recovered the original
index.html hash, confirming that no unrelated HTML edits occurred.

The loader's game entries now follow the plan's order:
shared, core, seapath, naval, rail, trade, warships, nukes, sam.
Its existing comments still describe this ordering correctly.

## Files touched and final line counts

- js/game/core.js: 2,800
- js/game/rail.js: 575
- js/game/seapath.js: 306
- js/game/naval.js: 270
- index.html: 217; loader entries only
- docs/game-split-step3-manifest.json: 38
- docs/game-split-step3-report.md: 131

## Manifest

The complete manifest below is also saved in
docs/game-split-step3-manifest.json. `recorded` is the unchanged manifest
embedded in each golden; `current` lists every currently loaded source file.
All ten files outside js/game/ retain their recorded SHA-256 values.

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
    "js/game/core.js": "546c6fc8c8024abe24a57f119b365695b52cadafc6d23c2a7fcea80338c84ca0",
    "js/game/seapath.js": "d117bd5c5069972d0b182053202bb8834bb0d3f443651579eb16d5e111cd4e78",
    "js/game/naval.js": "283232bc82181aea36e1839b3184daccff620917b2ff95ee8f6077931e9e738a",
    "js/game/rail.js": "cd8a7dcd9cd5b00aa86fe0221962e19f37b7615cba5259e9f36a39ffe477495a",
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

Naval originally occupied two sections separated by seapath. Extracting
seapath first made the two naval sections contiguous; both were moved with
their original comments. The tick method and its leading comments remain
in core, as do the mutable state declarations and tick order.

No bugs, scenario changes, or unresolved check failures were encountered.
No verification-tool changes or baseline updates were needed.
