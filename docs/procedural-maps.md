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

Every landform is made of **plates**: seed points that each grow one landmass under a radial falloff. With more than
one plate, every tile belongs to its nearest plate and a strait is sunk along the borders, so landmasses never fuse
and crossing one takes a naval landing. A slow warp field bends each plate's outline into peninsulas and bays, and
makes the straits meander.

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
2. Per tile: elevation noise, then the plate falloff at the warped point, strait slopes, inner sea or lakes, and an
   ocean border. The roughness field (terrain tiers) is built alongside, unchanged.
3. Multi-plate maps: `balancePlates` shifts each plate's elevation so each covers a similar share of its own cell,
   then strait tiles are sunk out of reach.
4. `findSeaLevel` searches for the sea level that hits the land target. Single-plate maps measure the largest
   landmass, multi-plate maps measure all land that survives pruning.
5. Prune specks, carve rivers, classify terrain, then shore distances and water components as before.

## Determinism

Generation is sim code and runs on every client. Per-seed choices come from `GameMap.seedHash` (never `Game.rng`),
and the maths sticks to `+ - * /`, `sqrt` and `floor`, with no trig or `pow`. Directions use the tan-half-angle trick
from `rangeShape`.

## Cost

Generation time is close to the old generator's (about 4–5 s at large in Node). Pangaea is the slowest, at about
6–7.5 s at large, because of the lake field and the larger land area in the sea-level search.
