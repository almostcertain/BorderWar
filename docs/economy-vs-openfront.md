# Economy vs OpenFront — why gold feels slower (ticket #11)

Investigation only; no sim code changed. Compared against OpenFront `main`
(`src/core/configuration/Config.ts`, `src/core/execution/PortExecution.ts`),
fetched 2026-09-22.

## What already matches

| Thing | OpenFront | BorderWar |
|---|---|---|
| Turn clock | `msPerTick() = 100` | `TURN_INTERVAL_MS = 100` |
| Passive income | `goldAdditionRate`: 100/tick humans & nations (50 for tribes) = 1,000/s | `GOLD_PER_SEC = 1000` for everyone |
| City / Port / Factory cost | `min(1M, 2^n × 125k)` | same |
| Silo / Atom / Hydrogen | 1M / 750k / 5M | same |
| Train payout | self 10k / other 25k / ally 35k, −5k per stop past 9, floor 5k | same |
| Conquest spoils | full treasury (half if the loser is human) | same |

Passive income, prices and train payouts are not the problem. (Tribes earn
1,000/s here vs 500/s in OpenFront, which only makes killing them *more*
lucrative for us.)

## Cause 1 (main one): trade-ship payouts are not scaled to map size

`tradeShipGold(dist)` is ported verbatim:

    75,000 / (1 + e^(−0.03·(dist − 300))) + 50·dist

The 300-tile "short range debuff" is an absolute tile count tuned for
OpenFront's full-resolution maps (World is 2000×1000). Our map sizes are
OpenFront's World downsampled:

| Size | Dimensions | Scale vs OpenFront |
|---|---|---|
| small | 250×125 | 1/8 |
| medium | 500×250 | 1/4 |
| large | 1000×500 | 1/2 |
| xlarge | 2000×1000 | 1 (full) |

So the same geographic route is 4× shorter on medium and falls into the
penalty zone:

| Route length (tiles) | Gold per ship |
|---|---|
| 50 | 2.5k |
| 100 | 5.2k |
| 200 | 13.6k |
| 300 | 52.5k |
| 400 | 91k |
| 600 | 105k |

Example: a route that is 400 tiles in OpenFront pays ~91k there. On our
medium map it is 100 tiles and pays ~5k — **about 17× less**. On large the
same route pays ~13.6k (~7× less). Only xlarge pays like OpenFront. Shorter
trips don't compensate, because spawn odds (not travel time) cap how many
ships a port sends.

Trade ships are a major mid-game income source in OpenFront, so this alone
explains most of the "slower economy" feel on anything below xlarge.

## Cause 2 (smaller): missing early-game spawn boosts

OpenFront added saturation curves we haven't ported:

- `tradeShipSaturation`: ~1.45× spawn odds while the world fleet is small
  (~1.2× actual spawns after the pity timer). Our formula is the older
  one (sigmoid midpoint 400; theirs is now 330 plus the boost and a 0.25
  plateau).
- `trainSaturation`: up to 1.5× train spawns for the first trains, decaying
  to ~1× around 5 trains.

Both specifically make the *opening* economy faster, which is where "feels
slow" is most noticeable.

## Cause 3 (structural): fewer trade partners

OpenFront public lobbies run 50+ players plus nations. Our lobbies have
5–31 nations. Foreign trade (trade ships, and trains paying 25k per foreign
stop) scales with how many partners you have, so fewer players means less
of it. Not a bug; worth knowing when comparing.

## Recommended fix

1. Scale trade-ship distance to OpenFront-equivalent tiles:
   `effectiveDist = dist × (2000 / GameMap.width)` in `tradeShipGold`, and
   compare `TRADE_SHIP_SHORT_RANGE_DEBUFF` against the same scaled distance
   in `tradingPorts`. xlarge is unchanged; medium/large pay like OpenFront.
2. Port the current `tradeShipSaturation` and `trainSaturation` curves.

Both are sim changes (goldens re-recorded). Rail ranges (`trainStationMaxRange`
110) have the same unscaled-tiles pattern but it makes our networks *denser*,
not poorer, so it isn't part of this ticket.
