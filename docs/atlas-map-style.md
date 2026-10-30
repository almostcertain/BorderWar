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

## Notes

- Step 1 only swaps the colours `paintTile` uses (`Render.buildPalette`), so it
  costs nothing per frame.
- Steps 2 and 4 add static layers baked once per map. Land and water never
  change mid-match, so only the territory wash is repainted as borders move.
- For the blend (step 4) the territory layer becomes translucent over a static
  base: paper when far, relief when near, with zoom setting the mix.
