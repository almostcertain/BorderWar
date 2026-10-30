# Atlas map style

An optional map look styled after hand-coloured antique atlases. Zoomed out it
reads as a political map (watercolour nations, inked coasts, lettered names);
zoomed in it crossfades to a terrain atlas (relief, mountain and forest
symbols, town names), the way Crusader Kings swaps map modes by zoom.

Render-only: nothing here touches the sim, the wire or the goldens. Classic
stays the default until the Atlas style has been playtested.

Mockup: the "BorderWar Atlas Style" artifact (interactive zoom demo).

## Steps

Each step is playable on its own. Switch styles in Options → Map style.

| # | Step | What to playtest |
|---|------|------------------|
| 1 | **Parchment palette.** Paper land toned by terrain, grey-green sea, inked coastline, muted nation washes, dark-ink borders. | Can you still tell nations apart and find your own? Do fronts read? |
| 2 | **Paper finish.** Paper grain and vignette, ripple lines along coasts, watercolour edge darkening inside borders, fog drawn as blank parchment (terra incognita). | Does it feel like paper without getting muddy? Frame rate on the large map. |
| 3 | **Atlas lettering.** Nation names in spaced old-style capitals, curved, in ink; troop numbers restyled to match. | Are names readable at every zoom and over every nation colour? |
| 4 | **Terrain layer and zoom blend.** A baked relief layer; as you zoom in, the political paper fades to terrain and the nation colour thins to a wash and a border band. | Is the switch point right? Does terrain help you plan attacks? |
| 5 | **Map symbols up close.** Mountain, hill and forest glyphs on the terrain layer; structures as atlas symbols; town names fade in as nation names fade out. | Clutter vs. clarity at close zoom; can you still click structures? |
| 6 | **Ornaments.** Compass rose and rhumb lines at sea, a cartouche with map name and turn, scale bar, ships drawn as galleons. | Fun or noise? Candidates for cosmetic unlocks. |
| 7 | **Performance pass.** Large map (2000x1000) and Firefox; decide whether Atlas becomes the default. | Frame rate and memory against Classic. |

## Status

- Step 1 done. Step 2 done: on the large map Atlas draws no slower than
  Classic (bench draw 3.8 ms vs 4.1 ms per frame); `drawPaper` is ~0.01 ms of
  CPU, but its GPU fill isn't measured, so check real fps on a weak machine.
- Step 3 done: names in letter-spaced capitals in a system serif (Palatino,
  else Georgia; no font download), ink with a paper halo, troops in italic.
  Long names on big labels curve; names with icons stay straight. Label
  redraws cost about 0.3 ms more per frame than Classic (medium map bench).
- Step 4 done: in Atlas the territory layer is see-through over two fixed
  bases, paper (`groundLayer`) and relief (`reliefLayer`), crossfaded between
  `NEAR_FROM` and `NEAR_TO` px per tile. Nation colour keeps the same
  strength at every zoom (fading it read as the map changing darkness). Relief is the terrain tiers blurred, roughened with noise and
  lit from the north-west. Large map: bases build in ~190 ms; drawing costs
  ~0.5–1 ms more per frame than Classic (labels included).

## Notes

- Step 1 only swaps the colours `paintTile` uses (`Render.buildPalette`), so it
  costs nothing per frame.
- Step 2: coast ripples are baked into the sea colours (`seaDistance`). The
  inner border band is a second ring in `paintTile`, so in Atlas `showTile`
  repaints two rings around a changed tile instead of one. Grain, mottling
  and vignette are pattern fills in `drawPaper`. Fog uses `fogColor()`.
- Steps 2 and 4 add static layers baked once per map. Land and water never
  change mid-match, so only the territory wash is repainted as borders move.
- For the blend (step 4) the territory layer becomes translucent over a static
  base: paper when far, relief when near, with zoom setting the mix.
