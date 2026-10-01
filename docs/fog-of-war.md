# Fog of war (design)

Status: **design agreed, nothing built.** No ticket numbers yet. This doc is the
source for the tickets; update it as decisions change.

A match option. When it is on, the map starts black, each nation sees only what
it has discovered, and the sea is explored with a new Scout unit. When it is
off, the game plays exactly as it does today.

## Decisions

| Topic | Decision |
|---|---|
| Unexplored map | True black. Terrain, territory, structures and units are all hidden. |
| Discovery | Permanent. Once an area is discovered you see it live for the rest of the match. |
| Exploring the sea | Scouts only. Warships, boats and trade ships reveal nothing. |
| Scout | A new naval unit, available once you have a Port. Cheap and unarmed. |
| Spawning | Random and fixed when fog is on. Nobody picks a spawn. |
| Nukes | Can be fired into undiscovered areas. The blast reveals nothing. |
| Bots | Bound by the same fog as humans. |
| Radio Tower | Planned follow-up: a cheap building that reveals an area around it, mainly for landlocked nations. |
| Shared vision | Teammates always share. Allies share while allied and keep what they learned. |

One consequence of permanent discovery: a Scout or Radio Tower has no further
use once its surroundings are revealed. The tower is in effect a one-off
"reveal this area" purchase. That only changes if discovery later stops being
permanent.

## Rules

### What reveals the map

- **Your territory**, plus a sight radius beyond your border. Expanding on land
  reveals land. This is the only source a landlocked nation has until the
  Radio Tower exists.
- **Scouts**, in a radius around the scout as it sails.
- **Radio Towers** (follow-up), in a larger radius around the tower, once, when
  construction finishes.
- **Allies and teammates**, as above.

Nothing else reveals: not warships, invasion boats, trade ships, trains, or
nuke blasts.

### Meeting a nation

You have **met** a nation once any of its land has been inside your discovered
area, or once it has attacked you (a land attack, a boat landing or a nuke
hit). Being attacked tells you who it was but does not reveal their land.

Diplomacy needs contact. Alliance requests, embargoes, donations and target
marks only work on nations you have met.

### What is blocked on undiscovered tiles

- Invasion boats: the landing coast must be discovered.
- Warships: can only be built toward, or ordered to, discovered water.
- The nation menu and hover panel show nothing.
- Land attacks and annexing need no rule. They only ever touch your border,
  which is always inside your sight radius.
- Nukes are the exception. Any tile is a legal target.

### Scouts

- Bought from the build bar like a warship. Needs a built Port. Only offered
  in fog matches.
- Sent by clicking anywhere, including into the black. It sails toward the
  click and stops at the closest water it can reach. If the click turns out
  to be land, it stops off that coast.
- An order is never refused because of what is under the fog. A refusal would
  tell the player whether a black tile is land or water.
- Can be selected and redirected like warships.
- Unarmed. Enemy warships shoot it. It lasts until sunk.
- Capped per nation, like boats (3) and warships (6).

### Spawning

- Every human is placed on a random spawn at the start. These are the
  "reserve" tiles the game already generates for players who don't pick in
  time, so this reuses existing behaviour.
- The `spawn` action is refused in fog matches.
- Bots stop "wobbling" their provisional spawn during the countdown. A moving
  spawn would smear their discovered area across every spot they tried.
- The countdown stays, shortened, so players can find themselves on the map.

### Nukes

- Humans can fire blind at any tile. Your own missile is drawn over the fog;
  the result on the ground is not.
- The inbound-nuke alert still fires. If you have not met the launcher it
  reads "Unknown nation" until the nuke lands, at which point you have met
  them.
- Bots only nuke what they have discovered.

### What the player sees

- The leaderboard lists only nations you have met, plus a count of unknown
  ones.
- Labels, structures, boats, ships, trains and fronts are drawn only inside
  your discovered area. This includes your own units, apart from your nukes.
- The fog lifts for everyone when the match ends.
- Spectators and replays see the whole map.

## Known limits

- **Not cheat-proof.** Multiplayer is lockstep, so every client holds the
  whole map and the fog is a filter over it. A modified client can see
  everything. Fine for solo, bots and casual lobbies; not for ranked play.
- **Trade is unchanged in the first version.** Ports still pick partners
  across the whole map, including nations you have not met. The ships are
  simply not drawn in the fog. See open questions.
- **Scouts know the way.** A scout's route is computed on the real map, so it
  steers around continents the player has not seen. The player only learns
  what is revealed along the route.

## Technical design

### Config

`gameStartInfo.config.fogOfWar` (boolean), whitelisted in `LocalServer.start`
and `GameServer.start` the same way `gameMode` is (see `docs/team-modes.md`).
A checkbox in the singleplayer and host panels. The auto lobby stays off.
`Game.init` reads it into `Game.fog`. Every rule below is gated on `Game.fog`,
so a fog-off match runs the same code path as today.

### Vision state (`js/game/vision.js`, new)

Vision is sim state, because bots branch on it. It must be deterministic and
it goes in the desync hash.

- **Vision groups.** Humans and Nations each get a group. In team games a
  team is one group. Tribes get none: they only ever act on their own border,
  so they are never gated.
- **Coarse grid.** Discovery is tracked per cell of 8x8 tiles, not per tile.
  On the large map (2000x1000) that is 31,250 cells. Per-tile tracking for
  ~110 groups would cost about 27 MB; the cell grid costs about 0.5 MB.
- **Layout.** One bitmask of groups per cell (`Uint32Array`,
  `cells * ceil(groups / 32)` words). `Game.isDiscovered(group, tile)` is one
  bit test. Cell-major layout makes the "met" check below cheap.
- **Reveal on ownership change.** `setOwner` (`core.js:703`) is the single
  path for territory changes. When a group gains a tile in a cell it has not
  yet stamped from, stamp a disc of cells around it. A second bitmask records
  "already stamped", so the cost after the first tile in a cell is one test.
- **Reveal from scouts.** Stamp a disc each time a scout enters a new cell.
- **Sharing.** When an alliance forms, OR each side's cells into the other.
  While it lasts, each stamp is applied to allied groups too.
- **Met.** Per player, a bitmask of groups that have met them. Updated in two
  places: when a cell is revealed (scan its 64 tiles for owners), and in
  `setOwner` (`cellGroups[cell] & ~metBy[newOwner]`, a few word operations).
  Also set directly when an attack, landing or nuke hit is resolved.
- **Iteration order.** Typed arrays indexed by cell and by group id only. No
  Map or Set iteration.

Starting values, all tuning dials: cell 8 tiles, border sight 3 cells, scout
sight 5 cells, radio tower sight 12 cells.

### Hash and goldens

- Add vision state and `Game.scouts` to `Hash.INPUT_FIELDS` (`js/net/hash.js`)
  so a vision desync is caught.
- **The goldens will need a re-record.** `tools/sim-harness.js` digests every
  non-cosmetic field on `Game` and checks the source hash of `js/ai.js`, so
  new state fields and the bot changes fail `compare` even with fog off. Before
  re-recording, confirm fog-off neutrality by checking that the map-ownership
  digest (`ownerFNV`) still matches the current goldens for every scenario.
  Re-record only when asked, and add at least one fog-on scenario then.

### Spawn (`js/game/core.js`)

In `init`, when `Game.fog`: claim `humanReserveTiles[p]` for each human
straight away, skip `jumpSpawnPreview` in `tickSpawnPhase`, shorten
`SPAWN_PHASE_TURNS` (starting value 30 turns, 3 s), and have
`spawnBlockReason` return a reason so the `spawn` intent is refused. Skipping
the wobble changes the rng stream relative to a fog-off match with the same
seed, which is expected: it is a different mode.

### Scout (`js/game/scouts.js`, new)

- `UNITS` entry `scout` with `action: true`, like `warship`, so the generic
  bot build loop skips it. Cheap flat cost (starting value 25k).
- `Game.scouts`: `{ id, owner, path, pos, destTile, health }`. Stepped in
  `tick()` next to `stepWarships`. Movement reuses the warship path model.
- Launch reuses the `build_unit` intent (`unit: 'scout'`, `tile` =
  destination), the same shape a warship purchase uses.
- New intent `move_scout` (`unitIds`, `tile`), kept separate from
  `move_warship` so warship rules stay untouched.
- **Destination resolution** must not leak. `resolveWarshipLaunch` refuses
  with "No open water there" or "No sea route there"; a scout cannot. It
  needs a "closest reachable water" search: run the sea A* toward the click
  and, if the goal is unreachable or the node budget runs out, take the best
  node reached. This is new work in `seapath.js` and has to respect
  `SEA_PATH_NODE_BUDGET_PER_TICK`.
- Add scouts to `warshipAcquireTarget` so enemy warships engage them.

### Gating (sim)

All in the existing "block reason" functions, so humans and bots share one
rule and the UI gets its message for free:

- `navalInvasionBlockReason`: landing tile not discovered -> `'Undiscovered'`.
- `resolveWarshipLaunch`, `moveWarships`: destination not discovered.
- `canRequestAlliance`, `embargoBlockReason`, `canDonate`, target marks: the
  other nation not met.
- `nukeBlockReason`: no change.

### Rendering (`js/render.js`)

- A fog layer at cell resolution (250x125 for the large map), drawn scaled
  over the map with smoothing so the 8-tile cells read as a soft edge. Updated
  incrementally as the viewer's group reveals cells.
- Every entity pass (`drawStructures`, `drawBoats`, `drawTradeShips`,
  `drawWarships`, `drawTrains`, `drawFronts`, `drawLabels`, `drawDiploBadges`,
  `drawNukes`) culls on `Game.isDiscovered`. The viewer's own nukes are exempt.
- Hit-testing (`findStructureNear`, `findBoatNear`, the hover highlight)
  ignores undiscovered tiles.
- Render reads vision state and never writes it.
- Performance check on the large map, using heap and allocation metrics.

### UI (`js/ui.js`, `js/radial.js`, `js/input.js`)

- Lobby checkbox, plumbed through `main.js` like `gameMode`.
- Build bar: Scout (and later Radio Tower) shown only in fog matches.
- Scout send: with Scout selected, a click anywhere sends one. Selection and
  redirect follow the warship pattern.
- Leaderboard, hover panel, radial menu and alerts filter on "met".
- Spawn banner replaced by a "you start here" message; camera centres on the
  player's spawn.

### Bots (`js/ai.js`)

Much of the bot logic is already border-based (`borderTargets`, `think`,
`assistAllies`, the Tribe AI), so it needs no change. What does:

- `navalThink`: skip `coastSample` tiles the bot has not discovered. **Without
  scouts, a fog-mode bot never invades overseas beyond its sight radius**, so
  this change and bot scouting ship together.
- `nukeTarget`: only structures and tiles the bot has discovered.
- `maybeRetaliate` / `retaliationTarget`: only against met nations, onto
  discovered tiles.
- Diplomacy and donations (`maybeSendRequests`, `allianceDecision`,
  `maybeDonate`, embargo handling): covered by the sim gates above; check that
  each call site tolerates a refusal.
- `economy`: buy a scout when the bot has a Port and undiscovered coast
  remains, up to the cap.
- New scout routine: pick the nearest undiscovered `coastSample` to the home
  coast, with ties broken by `Game.rng`.
- Later: build Radio Towers when landlocked.

### Radio Tower (follow-up)

`UNITS` entry `radio`, placed on owned land through the ordinary `build` path.
Cheap, not upgradable, only in fog matches. On completion it stamps one large
disc. Discovery survives the tower being captured or destroyed.

## Tasks

| # | Task | Files | Depends on |
|---|---|---|---|
| 1 | Fog toggle in config and lobby | `protocol.js`, `localserver.js`, `gameserver.js`, `main.js`, `ui.js`, `index.html`, `core.js` | none |
| 2 | Vision state: groups, cell grid, territory reveal, met, sharing, hash | `vision.js` (new), `core.js`, `diplomacy.js`, `teams.js`, `hash.js` | 1 |
| 3 | Random fixed spawn in fog matches | `core.js`, `ui.js` | 1 |
| 4 | Fog rendering and entity culling | `render.js` | 2 |
| 5 | Scout unit in the sim, including leak-free destination search | `scouts.js` (new), `structures.js`, `seapath.js`, `warships.js`, `protocol.js`, `executor.js` | 2 |
| 6 | Scout controls and build bar | `ui.js`, `input.js`, `render.js` | 4, 5 |
| 7 | Action gating in the sim | `naval.js`, `warships.js`, `diplomacy.js` | 2 |
| 8 | Hide unmet nations in leaderboard, hover, radial, alerts | `ui.js`, `radial.js` | 2, 4 |
| 9 | Bots respect fog and use scouts | `ai.js` | 5, 7 |
| 10 | Verification: fog-off neutrality, two-client determinism with fog on, large-map performance | `tools/`, `hash.js` | all |
| 11 | Radio Tower (follow-up) | `structures.js`, `vision.js`, `ui.js`, `render.js`, `ai.js` | 2, 4 |

After tasks 1 and 2, three tracks can run side by side: display (4, 8),
scouts (5, 6) and rules and bots (7, 9). Tasks 2 and 3 both edit `core.js`,
and 4 and 6 both edit `render.js`, so those pairs should not run at the same
time.

Biggest risks: task 9 (bot behaviour is spread across many functions, and
bots that explore badly make the mode feel empty) and the destination search
in task 5 (new pathfinding behaviour under a per-tick budget).

## Open questions

- **Trade and contact.** Should a Port only trade with nations its owner has
  met? It is more consistent, but it changes the economy in fog matches.
  First version: no change.
- **Scout price and cap.** Starting values are 25k and 3.
- **Sight radii.** Starting values above; they need playtesting on small and
  large maps.
- **Countdown length** before the match starts, now that nobody is picking.
