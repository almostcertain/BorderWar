# Paratroopers — feature spec

Status: **built** on `paratrooper` (2026-10-05); §8 notes what the build changed. Q15 decided: capitals are protected. Q1, Q2, Q7 decided (2026-10-05); one plane with three roles decided (2026-10-05); allies targetable, checked at arrival (2026-10-05); pilot cost, 0% slider stop and ally-despawn refund decided (2026-10-05). The rest of §9 still uses proposed defaults.
Branch: `paratrooper`.

## 1. Summary

A level 2+ City can launch a **transport plane**. There is one plane unit
with one icon, and what it does depends on how many troops the player loads
onto it with the existing attack-ratio slider. That gives it three roles:

1. **Scout.** In fog-of-war matches, a plane uncovers the map along its flight path and around its drop zone.
2. **Decoy.** Every plane looks the same to other players, whether it carries an army or nothing. Enemy anti-air can't tell them apart, so cheap or empty planes soak up shots meant for the real invasion.
3. **Invasion.** A loaded plane drops its troops inside enemy territory. The drop tile is taken and a normal attack opens from it, pushing outward from inside the enemy.

The plane flies in a straight line over any borders. Every level 2+ building
along the way that isn't allied has a short-range anti-air gun that may shoot
at it. The plane survives a few hits. If it's shot down, every troop aboard is
lost.

The invasion role is the air version of the naval invasion
(`js/game/naval.js`): same troop accounting, same "take the landing tile, then
open a normal attack" arrival. The difference is that the drop zone can be
anywhere inland, not only on a coast.

## 2. Player-facing rules

### Launching

| # | Rule |
|---|------|
| R1 | A City at **level 2 or higher** unlocks a plane. Level 1 cities can't launch. Each city holds **at most one ready plane** at a time. |
| R1a | When the plane is sent, that city's **cooldown starts immediately** (at launch, not when the plane arrives or crashes). When it ends, the city gets its next plane. |
| R2 | A plane button appears **above the city** on the map. It's sized for touch and is only shown on the player's own level 2+ cities. |
| R3 | **The slider decides the load.** The plane carries `floor(troops × ratio)` troops, the same figure shown next to the slider, taken from the player's troop count. If that's below `PARA_MIN_TROOPS`, the plane flies **empty** and acts as a pure scout/decoy. There's no separate mode picker; the role falls out of the load. |
| R3a | **Every plane costs 1 troop for the pilot**, on top of its load. An empty plane therefore costs exactly 1 troop. The pilot is never refunded, because planes are one-way. |
| R3b | The slider gets a **0% stop**, so a player can always send an empty plane however large their army is. |
| R4 | Tapping the button enters **targeting mode**. The cursor changes to a crosshair, and the next tap/click on the map picks the destination. Esc, right-click or a Cancel chip leaves targeting mode without launching. The targeting banner says what's being sent ("Plane · 12,400 troops" or "Plane · empty (scout/decoy)") and updates live with the slider. |

### Targeting

| # | Rule |
|---|------|
| R5 | **Any tile can be a destination, including undiscovered tiles under fog.** This follows the Scout rule from `docs/fog-of-war.md`: an order must never refuse because of what's under the fog, since that would reveal the terrain. |
| R6 | The only launch-time refusals are ones that reveal nothing: no ready plane, the player's plane limit reached, or a **discovered** tile that is the player's own or a teammate's ("Your own land", "Teammate"). |
| R7 | **Allies can be targeted.** Alliance status is **only checked when the plane arrives**. If the two nations are still allied at that moment (neither has betrayed the other), the plane **despawns** and no drop happens. If the alliance has been broken by then (the existing betrayal flow), the drop goes ahead as a normal invasion. This lets a player send a plane at an ally and break the alliance while it's in the air. Teammates still can't be targeted at all. |
| R8 | **Only land a player could claim can be invaded.** A drop needs land owned by a non-allied nation at arrival. Water, unowned land and the player's own land are never dropped on (§3 Arrival). |

### Flight and anti-air

| # | Rule |
|---|------|
| R9 | The plane takes off from **the city whose button was pressed** and flies in a straight line to the destination, crossing any borders and water on the way. |
| R10 | **Scout vision:** in fog matches, the plane reveals the area around itself as it flies, and the area around its destination on arrival. Revealed land stays discovered, the same as Scout ship vision. |
| R11 | **Every level 2+ building has anti-air.** That covers every upgradable type: City, Factory, Port, Silo, SAM. Forts can't be upgraded, so they never get it. |
| R12 | Anti-air range is **small at level 2 and grows with each level** (§6). |
| R13 | **Allied nations and teammates never shoot** at the player's planes. **Neutral and enemy nations do**, including when the plane is only passing over them on the way to someone else. While such a plane is inside a building's range, the building **has a chance to fire** at it on its own reload timer. A hit costs the plane one point of health. |
| R14 | A plane has a **health bar** and survives several hits. At 0 health it crashes and **all troops aboard are lost**. |
| R15 | **Decoy rule:** other players see every plane identically. Same icon, same size, no troop count, no destination line. Only the owner (and their teammates) sees what's aboard and where it's going. Anti-air targeting never considers load, so an empty plane draws fire exactly like a full one. |

### Arrival

| # | Rule |
|---|------|
| R16 | A loaded plane that reaches **hostile-owned land** takes the drop tile for free, the same way a boat takes its landing tile. A normal attack against that nation then opens from the drop tile and behaves exactly like any border push: same combat, same terrain costs, can be retreated, can merge with other fronts. |
| R16a | **A drop zone is never taken for free.** A drop lands as a one-tile island inside enemy land, and the "surrounded land falls for free" rule (`annex.js`) would otherwise hand it to whoever surrounds it: straight back to the defender, or to a third nation that conquers the land around it (seen in testing). So the pocket holding a drop tile its lander still owns can't be annexed, whether or not the paratroopers are still attacking. Anyone who wants it has to attack it across the border. Once the drop tile itself is lost in combat, that pocket is ordinary land again. |
| R17 | Planes are **one-way.** On arrival the plane is gone, whether it dropped troops, flew empty or couldn't drop. |

## 3. Flight

- **Path:** a straight line from the source city's tile to the destination tile. No pathfinding is needed.
- **Speed:** `PARA_SPEED` tiles/sec (§6). Position is stored as a fraction of the trip, like a nuke, so it's cheap to compute every tick.
- **Troops in flight:** they count as marching troops toward the pop cap, exactly like a boat's do. An empty plane carries none; its 1-troop pilot is spent at launch.
- **Plane supply:** each level 2+ city holds one ready plane. Launching uses it and starts that city's `PARA_COOLDOWN` straight away, and the next plane is ready when the cooldown ends. A city can therefore have its next plane ready while its previous one is still in the air.
- **Player limit:** at most `MAX_PLANES_PER_PLAYER` planes in the air per player at once, empty planes included.
- **New level 2 city:** a city starts with its plane ready the moment it reaches level 2.
- **No recall.** Once launched, a plane can't be turned back (to be confirmed, §9 Q6).
- **Vision (fog only):** each tick, the plane reveals `PLANE_SIGHT` vision cells around its position via `revealAround`. That only does work when the plane enters a new vision cell, the same as the Scout ship's `cell` tracking. On arrival it reveals the same radius around the destination.

### Arrival (mirrors `resolveLanding`)

The **target nation is whoever owns the destination tile at arrival**. Unlike
a boat, it isn't fixed at launch, because under fog the player may not know
who owns the tile when they launch.

1. **Empty plane:** reveal around the destination (fog only); the plane is removed. Nothing else happens.
2. **Destination is an ally's land and the alliance still holds:** the plane despawns. No drop, no attack and no embargo, so the ally isn't provoked. Troops go home minus `BOAT_RETREAT_MALUS` (25%).
3. **Destination is water, unowned land, the player's own land, or a teammate's land:** no drop. Troops go home minus `BOAT_RETREAT_MALUS` (25%), the same toll as a boat that lands on its own shore.
4. **Destination is owned by a nation that isn't allied** (including a former ally whose alliance was broken mid-flight): the attacker takes the drop tile, applies the temporary embargo (`embargoOnAttack`) and marks the two nations as met under fog. It then opens an attack seeded from the drop tile's neighbours that the target owns.
5. **The target owns nothing next to the drop tile** (an isolated single tile): the tile is kept, and the troops garrison it (returned to the pool).

## 4. Anti-air

Anti-air is a new step, `stepAntiAir`, in a new module `js/game/paratroopers.js`. It's modelled on `stepSAMs` in `sam.js`.

- **What has a gun:** any structure that is built, at level ≥ 2, with `def.upgradable`, on a tile the building's owner holds.
- **What it shoots at:** planes whose owner is not this building's owner, not an ally and not a teammate. Neutral nations fire too.
- **When a shot can happen:** at most once per `AA_RELOAD` seconds per building, and only while a valid plane is inside `aaRange(level)`. If several planes are in range, it targets the lowest-health one, and on a tie the one that launched first (stable order). Load never enters the choice (R15).
- **Whether it hits:** each shot hits with probability `AA_HIT_CHANCE`, rolled on `Game.rng`.
- **Damage:** a hit takes 1 point of health. At 0 the plane is removed and its troops are deleted. Nothing is refunded.
- **SAM Launchers:** these are already anti-nuke. They also shoot planes at their normal level-based anti-air range. Their nuke charges stay separate.
- **Visuals:** tracer and hit effects go in a cosmetic list, `aaFlashes`, added to `Game.COSMETIC_STATE`, the same pattern as `samFlashes`.

## 5. How the three roles play

- **Scout:** set the slider to 0% and fly an empty plane deep into the fog. It costs 1 troop for the pilot plus the city's cooldown, and anything it flies over stays discovered. It still risks being shot down, but losing an empty plane costs only the pilot and the cooldown.
- **Decoy:** launch empty planes from several cities toward the same area just before (or alongside) the loaded one. Enemy guns have one reload each, and a shot spent on a decoy can't be spent on the real plane. The defender can't tell which plane matters until a drop happens.
- **Invasion:** set the slider high and send one heavy plane. More troops don't make the plane tougher, so a big load is a bigger gamble: the whole army is lost if the plane goes down. Decoys and route choice are how a player protects it.

## 6. Tunables (proposed starting values)

| Constant | Value | Notes |
|---|---|---|
| `PARA_MIN_LEVEL` | 2 | City level needed to launch |
| `PARA_MIN_TROOPS` | 20 | Smallest load that drops. Below this the plane flies empty (same minimum as boats) |
| `PILOT_COST` | 1 troop | Paid on every launch, never refunded |
| `PARA_SPEED` | 15 tiles/s | Faster than a boat (10), much slower than a nuke (45) |
| `PARA_COOLDOWN` | 20 s | Per city, starts the moment its plane is sent |
| `MAX_PLANES_PER_PLAYER` | 3 | Same as `MAX_BOATS_PER_PLAYER`. Empty planes count |
| `PLANE_HP` | 3 | Hits needed to bring a plane down. Same for every load |
| `PLANE_SIGHT` | 5 vision cells | Same as `VISION_SIGHT_SCOUT` |
| `aaRange(level)` | `6 + 4 × (level − 2)` tiles | 6 at L2, 10 at L3, 14 at L4… capped at `AA_MAX_RANGE` = 30 |
| `AA_RELOAD` | 1.5 s | Per building |
| `AA_HIT_CHANCE` | 0.35 | Per shot |
| Gold cost | none | Costs troops only: load + pilot (see Q3) |

Rough feel: a plane that clips one L2 city's 6-tile radius at 15 tiles/s spends
about 0.8 s inside it, so it takes at most one shot. A plane flying over a
dense, upgraded core takes several shots and probably goes down, unless
decoys arrive first and use up those guns' reloads.

## 7. UI

- **City button:** a small round plane icon that floats above each of the player's own level 2+ cities. On cooldown it shows a radial timer until the next plane is ready.
  - The button stays at least 40 px (CSS) across at every zoom level.
  - It shows whenever structure icons do (`Render.structureIconsShown`), and is hidden when zoomed far out, where icons turn into dots. To launch, zoom in. (The draft's radial-menu fallback wasn't built: the radial menu only opens on other nations, not your own city.)
- **Slider:** the existing attack-ratio slider, with a new 0% stop (it currently starts at 5%). At 0%, land attacks and boats are refused with the existing "Not enough troops" reason, and planes fly empty. The readout next to the slider shows "(empty)" at 0%.
- **Targeting mode** (`input.js`): a crosshair cursor, plus a hover tint. Discovered hostile land is green, and discovered own/teammate land is red with the reason. Allied land is amber with "Allied: drop only happens if the alliance is broken before arrival". Undiscovered tiles get a neutral tint, because the cursor mustn't reveal anything. The banner shows the load, with a Cancel button so touch players have a way out without Esc.
- **The plane** (`render.js`): one sprite for every plane. The owner sees a small troop count under it and a dashed line to the destination. Everyone else sees the bare sprite only. A health bar shows for everyone once it has taken damage.
- **Anti-air range** (`render.js`): while aiming a plane, a faint red ring around every visible gun that would fire on it (level 2+ structures of anyone not the player or an ally), so a route can be picked around them. Hidden otherwise. (The draft showed the player's own guns instead; the guns that threaten the plane are what aiming needs.)
- **Notifications:** for the owner, "Plane shot down (−N troops)" or "Plane shot down (empty)", and "Drop failed: troops returned" when no drop happened. "Drop cancelled: still allied" when a plane despawns over an ally. For the defender, "Enemy plane shot down" without the load, and "Enemy paratroopers landed".

## 8. Implementation notes

- **New sim module** `js/game/paratroopers.js`: `paraBlockReason`, `launchPlane(playerId, cityTile, destTile, troops)`, `stepPlanes`, `stepAntiAir`, `resolvePlaneArrival`. It adds `Game.planes` (an array, in insertion order) and `nextPlaneId`. Each city building gets a `paraReadyAt` timestamp (or equivalent) for its cooldown. A plane record is `{ id, owner, srcTile, destTile, troops, hp, born, duration, cell }`. `troops` is 0 for an empty plane.
- **Tick order** in `core.js`: `stepAntiAir` runs before `stepPlanes`, so a plane shot down this tick never also arrives this tick. This is the same reasoning as SAM running before nukes.
- **Reuse:** the drop and a boat's landing share `openBeachhead` in `naval.js`, extracted from `resolveLanding`. Each successful drop records its tile in `Game.dropZones` (pruned each tick once the tile changes hands), which is what `airdropHolds` (R16a) looks for.
- **Where it lives:** sim in `js/game/paratroopers.js`; the annexation exemption hooks into `enclosedPocketsOf`/`sweepPocketsOf` in `annex.js`; plane troops count in `marchingTroops` (`economy.js`); tick order in `core.js`. UI in `ui.js` (city buttons, aiming bar, toasts), `render.js` (planes, tracers, rings, aim ghost); wire intent `launch_plane` in `js/net/`; outcome toasts via `Fx.planeEvent`.
- **Verified:** matches that never launch a plane play out identically to before (`sim-harness neutral`; the only flagged difference is `aaFlashes` joining `COSMETIC_STATE`). Fog checks pass. Two runs with planes in flight produce identical hashes.
- **Front merging:** check that `refreshFrontier` doesn't fold the inland drop into the attacker's main front against the same target too early. The boat code sets `landmassId` from the landing tile. An inland drop shares a landmass with the main front, so it may need its own front identity.
- **Alliance check:** `resolvePlaneArrival` reads `areAllied(owner, destOwner)` at arrival only. Launch never checks it, and nothing in flight cancels a plane when an alliance forms or breaks.
- **Fog safety:** `paraBlockReason` must never look at terrain or ownership for an undiscovered destination (R5). The Scout ship's `resolveScoutLaunch` is the model.
- **Decoy and lockstep:** every client holds the full sim state, including each plane's `troops`. Hiding the load from other players is a render rule only. A modified client could read it, which is the same trust level as fog of war today. `render.js` and the notifications must only show `troops` for planes owned by `Game.me` or a teammate.
- **Multiplayer:** a new player intent (`launch_plane`: city tile, destination tile, troops) carried through `js/net/`. The troop count is absolute, not the ratio, the same as the existing attack intent. Read `docs/multiplayer-architecture.md` first.
- **Determinism:** randomness only from `Game.rng`. Buildings are iterated in `Game.buildings` Map order and planes in array order.
- **Goldens:** this is a deliberate sim change, so don't run `compare` for it and don't re-record. Because bots don't use the feature, the recorded matches never launch a plane anyway.
- **AI** (`ai.js`): not in scope. Bots don't use planes yet (Q7).

## 9. Open questions

| # | Question | Proposed default |
|---|---|---|
| Q1 | "Generated at level 2": unlock or stockpile? | **Decided:** unlock. One ready plane per city at a time, and the cooldown for the next plane starts when the previous one is sent. |
| Q2 | Can neutral third parties' anti-air shoot a plane that's just passing over them on the way to someone else? | **Decided:** yes. Neutral nations shoot, allies don't. |
| Q3 | Should a plane cost gold as well as troops? | No, troops only. An empty plane costs 1 troop for the pilot. |
| Q4 | Can you drop on unclaimed wilderness or tribe land, or only on nations? | Any hostile-owned land including tribes. Not unclaimed land, which boats and border pushes already handle. |
| Q5 | Does damage kill troops on board (each hit loses some troops), or does health only decide whether it crashes? | Health only. All troops are lost on crash, none are lost from partial damage. |
| Q6 | Can a plane in flight be recalled? | No. |
| Q7 | Should bots use planes in this ticket? | **Decided:** no, not yet. |
| Q8 | Does a SAM Launcher shoot planes as well as nukes? | Yes, at its normal anti-air range (§4). |
| Q9 | If the source city is captured mid-flight, does the plane continue? | Yes. It's already airborne. |
| Q10 | Does a higher city level shorten the cooldown? | No, flat `PARA_COOLDOWN` for now. |
| Q11 | How does a player send an empty plane late in a match, when 5% of their army is well over 20 troops? | **Decided:** the slider gets a 0% stop, and an empty plane costs 1 troop for the pilot. |
| Q12 | The fog-only Scout ship already exists. Keep it alongside the plane? | Keep it. The ship is persistent and sea-only; the plane is a one-way, cooldown-limited flyover. |
| Q13 | Should planes fly back to their city after arriving instead of being one-way? | No, one-way (R17). A return trip would double the scouting value and the anti-air exposure. |
| Q14 | When a plane despawns over a still-allied destination, what happens to its troops? | **Decided:** they come home minus 25%, the same as any other failed drop. |
| Q15 | A drop that grows bigger than the player's homeland becomes their "main" territory, and the existing rule lets any surrounded piece smaller than the main one fall for free. A landlocked homeland can then be annexed outright by whoever surrounds it (seen in testing). Keep it, or protect the piece holding the player's capital? | **Decided:** protect the capital. Each nation's capital is the centre of its starting disc (`p.capital`). The piece holding it can't be annexed while the nation still owns that tile; the largest piece stays protected too. This applies to every match, planes or not. |

## 10. Acceptance checklist

- [ ] The button appears only on own level 2+ cities and is tappable on a phone-width viewport.
- [ ] A city holds one ready plane; its cooldown starts at launch, and the next plane is available when it ends.
- [ ] The slider sets the load, and has a 0% stop. Below `PARA_MIN_TROOPS` the plane flies empty. Every launch costs 1 troop for the pilot. HUD and banner match.
- [ ] At 0%, land attacks and boats are refused with "Not enough troops".
- [ ] Under fog, any tile can be targeted, and no refusal or cursor tint reveals what's under the fog.
- [ ] In fog matches, a plane reveals the map along its path and around its destination.
- [ ] Other players see the same plane whether it's empty or loaded, with no troop count or destination line.
- [ ] Allied anti-air never fires at your plane; neutral anti-air does, even when you're only passing over.
- [ ] Discovered own and teammate tiles are refused with their reason. Allied tiles can be targeted.
- [ ] A plane sent at an ally despawns on arrival if the alliance still holds, without provoking the ally, and its troops come home minus 25%.
- [ ] Breaking the alliance while the plane is in the air makes the drop go ahead as a normal invasion.
- [ ] The plane flies straight, crosses borders and water, and shows a health bar after its first hit.
- [ ] Level 2+ buildings fire. Level 1 buildings and Forts never do. Range visibly grows per level.
- [ ] A shot-down plane removes its troops permanently.
- [ ] A loaded plane landing on hostile land takes the tile and opens an attack that can be retreated. Landing anywhere else returns the troops minus 25%.
- [ ] No console errors in the `borderwar` preview on the `large` map.
