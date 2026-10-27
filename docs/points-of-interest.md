# Points of interest

Fixed map features that are worth holding. First slice: **Gold Deposits** and
**Mountain Passes**, on procedural maps only, behind a Create Game toggle.

Sim code: `js/game/poi.js`. Rendering: `Render.drawPOIs` in `js/render.js`.

## Rules

- **Control** is ownership of the POI's own tile. It changes hands when that
  tile is conquered. Unowned land holds nothing.
- **Gold Deposit:** its owner earns `POI_GOLD_PER_SEC` (500) extra gold per
  second, on top of the flat 1,000. Flat, never runs out.
- **Mountain Pass:** a permanent ruin fort. Tiles within `POI_FORT_RANGE` (15)
  of the pass that belong to the pass's owner get the same defense as a built
  fort (`FORT_DEF_MULT`, `FORT_SPEED_MULT`). It can't be nuked, sold or
  destroyed, and it counts as a fort for `fortInRange`, so bots don't build a
  second fort on top of it.

## Placement

Runs in `Game.init` after spawns are found, procedural maps only, and only when
`config.pointsOfInterest === true`. It draws from its own rng
(`mulberry32(seed ^ POI_SEED_SALT)`), so turning POIs on doesn't shift any
other random roll, and turning them off is the game exactly as before.

- Counts scale with land: gold `landTiles / 40000`, passes `landTiles / 90000`,
  each clamped (see `poiCounts`).
- Every POI keeps `POI_SPAWN_CLEAR` tiles from every starting spawn, and a
  spacing from other POIs that shrinks if the map is crowded.
- A **pass** is a non-mountain land tile with mountains on both sides along
  one axis (within `PASS_REACH`) and open land along the other axis: a gap in
  a range. Flat maps may get few or none.
- Humans can't pick a spawn within `POI_SPAWN_CLEAR` of a POI, so nobody
  starts sitting on one.

## Bots

`AI.poiPull` multiplies a neighbour's attack score when that neighbour holds
a POI close to the bot's land (`POI_AI_REACH`). Gold deposits pull harder than
passes. Unowned POIs need no pull: free-land expansion already takes them.

## Open questions for later slices

- Depleting deposits, or diminishing returns for holding many.
- Hand-placed POIs on the real-world maps.
- More types (uranium, oil, straits; see the brainstorm in the ticket).
