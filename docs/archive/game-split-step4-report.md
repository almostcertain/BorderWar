# Step 4 STOP report

Step 4 is complete. Step 5 has not started. No git commands were run.
Annex, attacks, and combat were extracted by copying exact byte ranges.
Property names, bodies, leading comment blocks, whitespace, and line endings
were preserved. Only the required wrappers and loader entries were added.

## Per-file verification

Both tools passed after each extraction, before the next extraction began.
Protected-file manifest checks passed against all eight goldens before each
move. No goldens were re-recorded or modified.

1. annex.js: 242 verbatim lines plus 5 wrapper lines = 247 lines;
   9 properties. Core after extraction: 2,558 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (20 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 111.68s
   ```

2. attacks.js: 410 verbatim lines plus 5 wrapper lines = 415 lines;
   15 properties from four separately checked ranges.
   Core after extraction: 2,148 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (21 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 98.91s
   ```

3. combat.js: 446 verbatim lines plus 5 wrapper lines = 451 lines;
   38 properties. Core after extraction: 1,702 lines.

   ```text
   PARITY OK (309 properties)
   MANIFEST OK (22 loaded files, 10 protected files outside js/game/)
   COMPARE OK (8 scenarios, 44000 ticks), 96.51s
   ```

All verification runs exited 0. Every checkpoint, final digest, action
counter, and entity peak matched the existing goldens. The 44,000 tick-call
budget includes spawn-phase and post-victory calls; actual simulation ticks
totaled 36,007. The simulation was not forced to continue after victory.
Each suite remained below the approximately three-minute budget.

Suite peaks remain 62 trade ships, 2 SAM missiles, 55 shells, and 29 trains.
All 13 action counters remain nonzero and match their recorded totals.

## Four attacks regions and ownership notes

The attacks body was independently checked against the concatenation of
these exact ranges in tools/baseline/game.orig.js:

- Lines 1638-1667: RETREAT_DELAY through retreatBoat, with leading comments.
- Lines 1697-1766: launchAttack, including its own leading comment block.
- Lines 2938-3086: resolveOpposingFronts through handleDeadDefender, including
  the opposing-fronts comments and conquest-frontier section comments.
- Lines 3329-3489: stepAttack and frontierTilesOf, including the latter's
  leading comment. stepAttack has no separate leading comment in the baseline.

The four copied ranges contain 30, 70, 149, and 161 lines respectively.
Their concatenation equals the unwrapped attacks.js body byte-for-byte.
The last two ranges became adjacent after annex extraction, but were still
copied and verified separately. Entity lookup methods and their comments
stayed in core between the first two original attacks regions.

The plan's ownership was followed even where another placement might seem
natural. No boundary was adjusted for tidiness:

- FRONT_TERRAIN_MAG, frontRand, and frontierPriority remain in combat.js,
  although the conquest-frontier heap in attacks.js uses them.
- ATTACK_TICK_BUDGET, ATTACKER_LOSS_BASE, and ATTACKER_LOSS_PER_DENSITY remain
  in combat.js despite their attack-related names.
- resolveOpposingFronts, DEAD_DEFENDER_TILES, and handleDeadDefender remain
  in attacks.js despite their combat-resolution roles.
- canRetreatBoat and retreatBoat remain in attacks.js, as specified, rather
  than being reassigned to naval.js.

## Byte and scope verification

Reinserting the extracted bodies at their original positions reproduces the
pre-Step-4 core exactly. Reassembling all prior extractions then reproduces
the complete frozen baseline byte-for-byte, including all comments.

SHA-256 checks confirmed that all eight goldens, verification tools, the
baseline, shared helpers, and previously extracted domain files are unchanged.
Removing the three new loader entries in memory recovered the original
index.html hash, proving no other HTML text changed.

The loader follows the plan's order: shared, core, attacks, combat, annex,
seapath, naval, rail, trade, warships, nukes, sam. Its existing comments remain
accurate. State declarations, entity lookups, tick, and fastForward stay in core.

## Files touched and final line counts

- js/game/core.js: 1,702
- js/game/annex.js: 247
- js/game/attacks.js: 415
- js/game/combat.js: 451
- index.html: 217; loader entries only
- docs/game-split-step4-manifest.json: 41
- docs/game-split-step4-report.md: 159

## Manifest

The complete manifest below is also saved in
docs/game-split-step4-manifest.json. `recorded` is the unchanged manifest in
each golden. `current` covers all 22 currently loaded files. All ten files
outside js/game/ have exactly their recorded SHA-256 values.

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
    "js/game/core.js": "368633cacfa4b9b622b7a1b60a2fab391eae016cb40ba83e4079fdd0489426aa",
    "js/game/attacks.js": "8762822e0cdab93033b587a12fcb0be1ef2c822023d1dce17253be459815d7e5",
    "js/game/combat.js": "641cc7e8108f2c93d609b59179a71b85aec7123228e461369470f69e6c0fef9e",
    "js/game/annex.js": "1a22c23684da21d416d013655c7a720a0508e5ae8afe94386b60ea4e609d8130",
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

No simulation bugs or unresolved verification failures were encountered.
No scenario tuning, verification-tool changes, or baseline updates were needed.
The ownership choices noted above were preserved rather than changed.
