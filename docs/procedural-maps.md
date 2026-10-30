# Procedural maps

How `GameMap.generate` (js/map.js) builds a map, and what the lobby's map options do.

## Lobby options

These show under **Map** when **Procedural** is picked, in both Singleplayer and Host. They travel as
`gameStartInfo.config.mapGen` (whitelisted by `Protocol.normalizeMapGen` on the server and the local server). The
preview's **Seed** goes out as `config.seed`, so the match is the map in the preview. **New map** rerolls the seed.

| Knob | Values (default first) | Effect |
|---|---|---|
| Landform | Random, Continent, Twin Continents, Continents, Archipelago, Pangaea, Inland Sea | Overall shape (below). Random picks one per seed, weighted by `LANDFORM_WEIGHTS`. |
| Land | Normal, Scarce, Abundant | ×1 / ×0.65 / ×1.35 on the landform's land share, capped at 70% of the grid. Match length scales with it. |
| Terrain | Normal, Flat, Rugged, Alpine | Highland/mountain share of land (`TERRAIN_SHARES`). Normal drifts a little by seed. |
| Rivers | Normal, None, Few, Many | Rivers per landmass ×1 / 0 / ½ / 2. Many also reaches further upstream. |
| Coastline | Normal, Smooth, Jagged | Octaves and contrast of the elevation noise, plus how far continent outlines are bent. |

A missing or unknown value falls back to the default, so older clients, auto lobbies and the golden harness still
get a map. Auto lobbies send no options and get Random.

## Landforms

Every landform is made of **plates**: seed points that each grow one landmass. With more than one plate, every tile
belongs to its nearest plate and a strait is sunk along the borders, so landmasses never fuse and crossing one takes a
naval landing. A slow warp field bends each plate's outline into bays, and makes the straits meander.

**Spines.** Each plate (except Inland Sea's ring) grows along a *spine*: a bent centre line running both ways from the
plate's centre, with a width that tapers toward the tips, plus a few side branches (`growSpines`, tuned per landform in
`SPINE`). Land falls off with distance from the spine in tiles, not as a share of local width, so thin arms survive as
peninsulas and isthmuses instead of drowning. This replaces the old oval falloff, which made every landmass a blob.
Plate distances are computed on the warp grid (`plateField`) and read back bilinearly; each grid cell keeps a short
list of the plates that can be nearest there, so per-tile cost doesn't grow with plate count.

| Landform | Plates | Land | Notes |
|---|---|---|---|
| Continent | 1, off-centre, out of round | 40% | The old single-continent map, with more shape variety. |
| Twin Continents | 2, equal | 40% | The old twin map. Strait width varies by seed. |
| Continents | 3–5, uneven | 40% | Spread by best-candidate sampling. |
| Archipelago | 14–28, uneven | 28% | Islands of mixed size with narrow channels. Naval-heavy. |
| Pangaea | 1, reaching the edges | 58% | Lakes and inland seas cut by a second noise field. |
| Inland Sea | 1, ring | 40% | A central sea opened to the ocean by one channel. |

Plate positions, sizes and counts are fractions of the map, not tile counts, so a seed draws the same shapes at every
map size. The lobby preview relies on this: it runs the real generator at 400×200 on its own `GameMap` copy.

## Pipeline

1. `resolveGenOptions` fills defaults and resolves Random. `landformPlan` places the plates.
2. Per tile: elevation noise, then the spine falloff at the warped point, strait slopes, inner sea or lakes, an ocean
   border, and tectonic lift and rifts. The roughness field (terrain tiers) is built alongside; belts are added to it
   once the loop ends.
3. Multi-plate maps: `balancePlates` shifts each plate's elevation so each covers a similar share of its own cell,
   then strait tiles are sunk out of reach.
4. `findSeaLevel` searches for the sea level that hits the land target. Single-plate maps measure the largest
   landmass, multi-plate maps measure all land that survives pruning.
5. Prune specks, carve rivers, classify terrain, then shore distances and water components as before.

## Tectonics (mountain ranges)

A second, independent set of 7�11 **tectonic plates** covers the map, each drifting a seed-chosen way (`tectonics`).
Where two close in, a **mountain belt** rises along their border, offset onto one side like the Andes. Where they part,
a **rift** sinks the land, which leaves gulfs, rift lakes and long inland seas. A slow noise varies each belt's width
and strength along its length, so ranges have gaps (passes) and rifts come in pieces.

Belts raise the roughness field, so the mountain and highland tiers gather along them. Inside a belt, ridged noise
stretched along the border breaks the range into parallel ridges with valleys between, and a soft cap stops crossing
belts merging into one solid block. Belts at sea lift the seabed a little, which can raise island arcs. Tier
*shares* are unchanged (the Terrain knob still sets them); only *where* mountains go changes. Rivers drain off
roughness, so they run down from the ranges. Belt and rift strength are smooth, so they're computed on the warp grid
(`tectonicGrid`); only the ridge texture is per tile, and only inside belts. Constants are in `TECTONIC`.

## Climate and biomes (looks only)

`Render.computeClimate` (js/render.js) gives every land tile one of ten biomes: ice, tundra, taiga, cold steppe,
forest, grassland, steppe, rainforest, savanna, desert. It is client-only and never touches the sim.

- **Latitude.** Procedural maps take a latitude window from the seed (`GameMap.seed`): some are mostly tropical,
  others reach a frozen north. Baked maps use rough real windows (`BAKED_LAT`).
- **Temperature** falls with latitude and with height (highland, mountain).
- **Rainfall.** Each row's prevailing wind (trade winds from the east, westerlies, polar easterlies) carries humidity
  in from the sea. Land wrings it out slowly and ranges much faster, so the far side of a range is dry (rain
  shadow). That's scaled by a latitude rain curve (`LAT_RAIN`): wet tropics, dry subtropics, wet mid-latitudes.

Classic colours unclaimed ground by biome (`BIOME_CLASSIC`; mountains grey, snowy in cold biomes). Atlas washes the
paper faintly and colours the zoomed-in relief by biome (`BIOME_ATLAS`): snowlines drop in cold climates, and wet
biomes get woods on low ground as well as highland (`BIOME_TREES`, tree marks included). The lobby preview uses the
Classic colours.

## Determinism

Generation is sim code and runs on every client. Per-seed choices come from `GameMap.seedHash` (never `Game.rng`),
and the maths sticks to `+ - * /`, `sqrt` and `floor`, with no trig or `pow`. Directions use the tan-half-angle trick
from `rangeShape`.

## Cost

Generation time is close to the old generator's (about 4–5 s at large in Node). Pangaea is the slowest, at about
6–7.5 s at large, because of the lake field and the larger land area in the sea-level search.
