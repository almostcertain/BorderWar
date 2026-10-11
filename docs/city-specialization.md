# City specialization

A City that reaches level 3 can be given one specialization: a permanent
bonus that makes that city do something a plain city does not. It is the
reason to build tall. A city level and a new city come out of the same price
pool and are worth the same troop cap, so without this there is no difference
between one level-3 city and three level-1 cities.

This first version ships four simple specializations, each a single modifier
on a system that already exists. Area effects (Citadel, Staging Ground) and
unit unlocks (Airborne, for paratroopers) are meant to slot into the same
table later.

## Rules

- **Who can specialize:** the owner of a finished City at level 3 or higher
  (`SPEC_MIN_LEVEL`) that has no specialization yet. Never blocks play: an
  unspecialized level-3 city is just a city.
- **Permanent:** one specialization per city, for the rest of the match. No
  re-spec.
- **Survives capture:** whoever takes the city takes the specialization.
  It is lost only when the city itself is destroyed (nuke, Battle Royale
  circle).
- **Scales with level:** every effect is per city level, so the city stays
  worth upgrading after the pick.
- **Instant:** no build time.

## Fee

`SPEC_BASE_COST * 2^n`, uncapped: 250k, 500k, 1M, 2M, 4M, ...

`n` is shared across all four types, so a first Trade Hub costs the same as a
second Metropolis. It is `min(specializations held, specializations bought)`,
the same rule `unitCost` uses for structures:

- a captured specialized city does not raise the captor's price past what
  their own purchases allow;
- losing one lowers the price again.

## The four specializations

| Type | Effect | Dial |
|---|---|---|
| Metropolis | Each level of this city adds extra troop cap on top of a normal city level's 25k | `METROPOLIS_POP_PER_LEVEL` (+15k per level) |
| Trade Hub | Every train stop at this city pays more, to the train's owner and to the station's owner alike | `TRADEHUB_GOLD_PER_LEVEL` (+25% per level) |
| Treasury | Flat gold income | `TREASURY_GOLD_PER_LEVEL` (+500 gold/s per level) |
| Garrison Town | Faster troop growth for the whole nation | `GARRISON_GROWTH_PER_LEVEL` (+5% per level), total capped at `GARRISON_GROWTH_CAP` (+50%) |

At level 3 that is +45k cap, x1.75 train stops, +1,500 gold/s, or +15%
growth. Metropolis and Garrison Town work anywhere. Trade Hub rewards picking
a city on a busy rail line. Treasury is the economy pick for a nation with no
rail.

The numbers are first guesses and are expected to move in playtesting.

## How it works in the sim

Code is `js/game/specialize.js`.

- A building record carries `spec` (null, or one of the type names).
- `Game.specialize(playerId, tile, spec)` is the only way to set it, reached
  through the `specialize_structure` intent (`tile`, `spec`).
- Each player carries `spec`, the per-type sum of levels of the specialized
  cities they hold, plus `held`. `updateSpecTotals()` rebuilds these from the
  buildings map at the top of every tick, so capture, destruction and
  level-ups need no bookkeeping of their own. The cost is a bonus that follows
  a change of hands one tick late.
- `specsBought` on the player is the lifetime purchase count the fee uses.
- Readers: `maxTroops` (Metropolis), `growthPerSecond` (Garrison Town),
  `goldPerSecond` (Treasury), `stepTrains` (Trade Hub, read off the building).

## Bots

Nations only; Tribes never specialize.

- **Going tall:** a bot aims for one specialization per
  `AI.SPEC_CITY_LEVELS` city levels it holds. While it is short of that and
  has no city ready to specialize, its city purchases upgrade its
  highest-level city instead of founding a new one. The price and troop cap
  are identical either way.
- **Buying:** when it holds an unspecialized city at level 3+ and can afford
  the fee over its savings reserve, it specializes.
- **Picking:** Trade Hub if the city is a rail station with at least two
  lines; otherwise whichever of Metropolis, Garrison Town and Treasury it
  holds the fewest levels of.

## UI

- An eligible city of yours shows a pulsing gold star beside its level.
  A specialized city (anyone's) shows its specialization icon there instead.
- Tapping your own level-3+ city with nothing armed opens the chooser: the
  four options with their effect at the city's current level, and the fee.
  For an already specialized city it shows what it has.

## Not in this version

- Area effects (Citadel, Staging Ground, Supply Depot, Watchtower).
- Airborne (paratroopers), which is waiting on its own branch.
- Specializations for other structures.
- Any cap other than the fee.
