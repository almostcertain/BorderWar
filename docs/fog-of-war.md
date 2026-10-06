# Fog of war (design)

Status: **built and on `main`, not yet playtested by a person.** Tasks 1 to
11 are done (11, the Radio Tower, was added afterwards). No ticket numbers. Where the build differs from the
design below, "As built" near the end says how.

A match option. When it is on, the map starts black, each nation sees only what
it has discovered, and the sea is explored with a new Scout unit. When it is
off, the game plays exactly as it does today.

## Decisions

| Topic | Decision |
|---|---|
| Unexplored map | True black. Terrain, territory, structures and units are all hidden. |
| Discovery | Permanent. Once an area is discovered you see it live for the rest of the match. |
| Exploring the sea | Scouts and warships. Invasion boats and trade ships reveal nothing. |
| Scout | A new naval unit, available once you have a Port. Unarmed. Costs 25k, capped at 2 per nation. Cannot be disbanded for now. |
| Spawning | Random and fixed when fog is on. Nobody picks a spawn. The countdown is 5 seconds. |
| Nukes | Can be fired into undiscovered areas. The blast reveals nothing. |
| Bots | Bound by the same fog as humans. |
| Radio Tower | A cheap building that reveals a wide area around it once, when it finishes. Mainly for landlocked nations, which cannot launch Scouts. 50k for the first, 50k more for each one after, capped at 250k. |
| Shared vision | Teammates always share. Allies share while allied and keep what they learned. |
| Contact | One-sided. Meeting a nation does not make it meet you. Allies share the map but not their contacts. |
| Trade | Ports only trade between two nations that have both met each other. Rail income inside your own network is unaffected. |
| Leaderboard | The top 3 nations are always shown, met or not. Below that, only nations you have met. |
| Eliminated players | See the whole map, like spectators. |
| Lobby map preview | Hidden in fog matches. |

One consequence of permanent discovery: a Scout or Radio Tower has no further
use once its surroundings are revealed. The tower is in effect a one-off
"reveal this area" purchase. That only changes if discovery later stops being
permanent.

## Rules

### What reveals the map

- **Your territory**, plus a sight radius beyond your border. Expanding on land
  reveals land.
- **Scouts**, in a radius around the scout as it sails.
- **Warships**, in a smaller radius around the warship as it sails.
- **Radio Towers**, in a larger radius around the tower, once, when
  construction finishes.
- **Allies and teammates**, as above.

Nothing else reveals: not invasion boats, trade ships, trains, or nuke
blasts.

Warships and scouts do different jobs. A warship can only be ordered to
discovered water, so it pushes the edge of the map outward a step at a time.
A scout can be sent straight into the black.

### Meeting a nation

You have **met** a nation once any of its land has been inside your discovered
area, or once it has attacked you (a land attack, a boat landing or a nuke
hit). Being attacked tells you who it was but does not reveal their land.

Diplomacy needs contact. Alliance requests, embargoes, donations and target
marks only work on nations you have met.

Contact is one-sided. If you have met a nation that has not met you, your
alliance request, donation or embargo reaches it as coming from "Unknown
nation", and it still has not met you. It can accept or decline the request.
Accepting forms the alliance, and the two of you have then met.

Allies do not share contacts. You meet your ally, not the nations your ally
has met. In practice the shared map does most of this anyway: any nation
whose land lies inside your ally's discovered area is now inside yours, so
you meet it by the ordinary rule. What is not passed on is a contact your
ally only has from being attacked.

Trade needs contact on both sides. Two nations' Ports trade only once each
has met the other. An alliance always satisfies this, because accepting one
makes both sides meet; opening trade early is one of the benefits of allying.
The same rule applies to trains stopping at another nation's stations.

Your own rail network is not affected. Trains running between your own
cities and factories earn as they do today, whether or not you have met
anyone.

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
- Costs 25k. Capped at 2 per nation (boats are capped at 3, warships at 6).
- Cannot be disbanded for now. A scout with nothing left to reveal keeps its
  slot until it is sunk.

### Spawning

- Every human is placed on a random spawn at the start. These are the
  "reserve" tiles the game already generates for players who don't pick in
  time, so this reuses existing behaviour.
- The `spawn` action is refused in fog matches.
- Bots stop "wobbling" their provisional spawn during the countdown. A moving
  spawn would smear their discovered area across every spot they tried.
- The countdown stays, shortened to 5 seconds, so players can find themselves
  on the map.

### Nukes

- Humans can fire blind at any tile. Your own missile is drawn over the fog;
  the result on the ground is not.
- The inbound-nuke alert still fires. If you have not met the launcher it
  reads "Unknown nation" until the nuke lands, at which point you have met
  them.
- Bots only nuke what they have discovered.

### What the player sees

- The leaderboard always shows the top 3 nations by name, met or not, so
  nobody loses to a nation they never heard of. Below the top 3 it lists only
  nations you have met, plus a count of unknown ones. Appearing in the top 3
  is not contact: diplomacy with an unmet leader is still blocked.
- Labels, structures, boats, ships, trains and fronts are drawn only inside
  your discovered area. This includes your own units, apart from your nukes.
  Your warships and scouts are always visible because they reveal the water
  around them. Your trade ships and invasion boats are not drawn while they
  cross undiscovered water.
- The fog lifts for everyone when the match ends.
- Spectators and replays see the whole map. So does an eliminated player,
  from the moment they are eliminated. In team games this lets a dead player
  tell living teammates what they see; that is accepted.
- The lobby's map preview is hidden when fog is on, in the singleplayer and
  host panels and for players who join. On the World map the geography is
  common knowledge anyway; the preview is still hidden for consistency.

## Known limits

- **Not cheat-proof.** Multiplayer is lockstep, so every client holds the
  whole map and the fog is a filter over it. A modified client can see
  everything. Fine for solo, bots and casual lobbies; not for ranked play.
- **Port trade starts slow.** Ports only trade once both nations have met, so
  a nation that has met nobody earns no Port income, and fog matches will have
  a weaker early economy than fog-off ones. Rail income from your own cities
  and factories still works from the start. Trade ships are still not drawn
  in the fog.
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
  `cells * ceil(groups / 32)` words). `Game.isDiscovered(playerId, tile)` is
  one bit test. Cell-major layout makes the "met" check below cheap.
- **Reveal on ownership change.** `setOwner` (`core.js:703`) is the single
  path for territory changes. When a group gains a tile in a cell it has not
  yet stamped from, stamp a disc of cells around it. A second bitmask records
  "already stamped", so the cost after the first tile in a cell is one test.
- **Reveal from scouts and warships.** Stamp a disc each time one enters a
  new cell. The warship stamp is in `stepWarships` and gated on `Game.fog`.
- **Sharing.** When an alliance forms, OR each side's *own-sighted* cells
  (`visionOwn`: stamped by its own border, scouts, ships or radio, not shown
  by an ally) into the other. While it lasts, each stamp is applied to allied
  groups too. Vision is direct only: an ally's ally's sight never reaches you.
- **Met.** Per player, a bitmask of groups that have met them. Updated in two
  places: when a cell is revealed (scan its 64 tiles for owners), and in
  `setOwner` (`cellGroups[cell] & ~metBy[newOwner]`, a few word operations).
  Also set directly when an attack, landing or nuke hit is resolved.
- **Iteration order.** Typed arrays indexed by cell and by group id only. No
  Map or Set iteration.

Starting values, all tuning dials: cell 8 tiles, border sight 3 cells, scout
sight 5 cells, warship sight 3 cells, radio tower sight 12 cells.

#### As built (task 2)

All state is top-level on `Game`, `null`/`0` in a fog-off match, and only
`vision.js` writes it.

| Field | Shape | Meaning |
|---|---|---|
| `visionGroupOf` | `Int16Array[players]` | Player id to group id, `-1` for tribes. Everyone but tribes gets their own group, in player-id order (teammates share through `visionShare`, not a common group). |
| `visionCells` | `Uint32Array[cells * visionWords]` | Groups that have discovered each cell. |
| `visionStamped` | same | Groups that have already stamped border sight from a tile in the cell. |
| `visionShare` | `Uint32Array[groups * visionWords]` | The bits a group's stamp sets: its own, its teammates' and its current allies' (an ally of a teammate is not included). Rebuilt from `Game.alliances` whenever one forms or ends. |
| `visionMet` | `Uint32Array[players * visionWords]` | Groups that have met each player. |
| `visionCount` | `Uint32Array[groups]` | Cells each group has discovered. Changes exactly when the group's discovered set does, so render uses it as a revision counter. |
| `visionCellsW`, `visionCellsH`, `visionGroups`, `visionWords` | numbers | Grid size, group count, words per bitmask. |

Cell index is `cy * visionCellsW + cx`; a group's bit is word `g >>> 5`, bit
`g & 31`.

API (read-only unless marked):

- `Game.isDiscovered(playerId, tile)`: true with fog off and for tribes.
- `Game.hasMet(a, b)`: has `a` met `b`. True with fog off, for `a === b`, for
  teammates, and when `a` is a tribe. A tribe as `b` is met like any other
  land owner. False if either id is not a player.
- `Game.visionGroup(playerId)`: group id, or `-1` (tribe, not a player, fog
  off).
- `Game.visionCellOf(tile)`: cell index, for noticing a unit has changed cell.
- `Game.revealAround(playerId, tile, radiusCells)` (sim only): reveal a disc
  to the player's group and its current allies. Scouts, warships and the
  radio tower call this with `VISION_SIGHT_SCOUT` / `_WARSHIP` / `_RADIO`.
- `Game.markMet(observerId, subjectId)` (sim only): the attack half of
  contact. Called from `launchAttack`, `resolveLanding` and `detonateNuke`.

Choices made while building:

- A disc of radius `r` cells is every cell with `dx*dx + dy*dy <= r*r + r`
  (radius `r + 0.5`), so small discs are round rather than a plus shape.
- Contact belongs to the vision group, so a team shares its contacts as well
  as its map. Allies still do not.
- Sharing is direct. When A and B ally, each gets the other's whole map as it
  stands, including what B was given by an earlier ally C; after that A gets
  B's new stamps but not C's.
- Vision is live during the spawn countdown, so until task 3 fixes spawns a
  bot's wobbling provisional spawn (and a human re-picking) leaves a trail of
  discovered cells and contacts.
- An alliance forming scans the whole grid once (a few ms on the large map).
  Everything else is proportional to what is newly revealed.

### Hash and goldens

- Add vision state and `Game.scouts` to `Hash.INPUT_FIELDS` (`js/net/hash.js`)
  so a vision desync is caught. Vision state is in (task 2), only when fog is
  on: `visionCount`, `visionMet` and `visionShare` whole, the two cell grids
  sampled every `Hash.VISION_STRIDE` words. A fog-off digest is unchanged.
- `node tools/sim-harness.js fog` checks fog-on matches: each scenario twice
  in fresh contexts with identical hashes, the vision invariants, the contact
  and sharing rules, and that a fog-off match allocates nothing. `--perturb`
  is its negative control. `node tools/sim-harness.js neutral` checks fog-off
  behaviour against a pre-fog baseline.
- **The goldens will need a re-record.** `tools/sim-harness.js` digests every
  non-cosmetic field on `Game` and checks the source hash of `js/ai.js`, so
  new state fields and the bot changes fail `compare` even with fog off. Before
  re-recording, confirm fog-off neutrality by checking that the map-ownership
  digest (`ownerFNV`) still matches the current goldens for every scenario.
  Re-record only when asked, and add at least one fog-on scenario then.

### Spawn (`js/game/core.js`)

In `init`, when `Game.fog`: claim `humanReserveTiles[p]` for each human
straight away, skip `jumpSpawnPreview` in `tickSpawnPhase`, shorten
`SPAWN_PHASE_TURNS` to 50 turns (5 s), and have
`spawnBlockReason` return a reason so the `spawn` intent is refused. Skipping
the wobble changes the rng stream relative to a fog-off match with the same
seed, which is expected: it is a different mode.

### Scout (`js/game/scouts.js`, new)

- `UNITS` entry `scout` with `action: true`, like `warship`, so the generic
  bot build loop skips it. Flat cost 25k. `MAX_SCOUTS_PER_PLAYER: 2`.
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
  other nation not met. Only the sender is checked. `acceptAlliance` is not
  gated, and marks both sides as met.
- `canTrade` (`diplomacy.js`): refused unless each nation has met the other.
  Both `tradingPorts` (`trade.js`) and the train station check (`rail.js:391`)
  go through it. The rail check passes a train's own stations before it
  reaches `canTrade`, so own-network income needs no change.
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

- Lobby checkbox, plumbed through `main.js` like `gameMode`. While it is
  ticked the map preview (`refreshMapPreview`, `#quickJoinMap`) is hidden,
  for the host and for joiners.
- Build bar: Scout (and later Radio Tower) shown only in fog matches.
- Scout send: with Scout selected, a click anywhere sends one. Selection and
  redirect follow the warship pattern.
- Hover panel, radial menu and alerts filter on "met". An alert about an
  unmet sender (request, donation, embargo, inbound nuke) names "Unknown
  nation".
- Leaderboard: top 3 always named; the rest filter on "met", with a count of
  unknown nations. Row actions are disabled for an unmet nation in the top 3.
- Eliminated viewer: the fog layer and all "met" filters switch off, the same
  as for a spectator.
- Spawn banner replaced by a "you start here" message; camera centres on the
  player's spawn.

### Bots (`js/ai.js`)

Much of the bot logic is already border-based (`borderTargets`, `think`,
`assistAllies`, the Tribe AI), so it needs no change. What does:

- `navalThink`: skip `coastSample` tiles the bot has not discovered. **Without
  scouts, a fog-mode bot barely invades overseas**: it sees only its border
  sight and whatever its warships happen to pass. So this change and bot
  scouting ship together.
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
- Build Radio Towers when landlocked (see "Radio Tower (task 11)").

### Radio Tower

`UNITS` entry `radio`, placed on owned land through the ordinary `build` path.
Cheap, not upgradable, only in fog matches. On completion it stamps one large
disc. Discovery survives the tower being captured or destroyed.

## As built

Where the build differs from, or had to interpret, the design above. Task 2's
notes are under "Vision state".

### Lobby (task 1)

- Players who join a hosted lobby see only a roster and a status line, with
  no settings and no preview, so there was nothing to hide for them. The auto
  lobby is always fog off.

### Spawn (task 3)

- The camera opens centred on the player's spawn at about 100 tiles across
  the shorter screen side.
- A tap during the countdown flashes "Spawns are random in fog of war".
- Teammates can start far apart, because spawns are random.

### Gating (task 7)

- The clicked tile is checked before any terrain lookup, as well as the
  resolved landing or destination tile, so a refusal never says whether a
  black tile is land, water or coast. The reason is `'Undiscovered'`.
- Contact refusals read `'Not met'`.
- "Embargo all" skips nations the sender has not met.
- The donation gate is redundant in practice: donating needs an alliance, and
  an alliance makes both sides meet.

### Scouts (task 5)

- **An order does no pathfinding.** Buying or moving a scout only records the
  tile; the route is found in `stepScouts`, so an order cannot be refused for
  terrain by construction.
- **The route search is spread over ticks**, 20,000 tiles a slice, inside
  `SEA_PATH_NODE_BUDGET_PER_TICK`. The design's single capped search often
  could not get a scout round its own continent (167 of 200 test voyages
  arrived on the World map; sliced, 198 of 200). One search runs at a time
  across all nations; other scouts wait. A scout sits still while its route
  is found.
- The search has its own arena: about 23 MB on a 2000x1000 map, allocated on
  the first scout search of a fog match.
- A click on land or a lake resolves to the nearest tile of the scout's own
  sea within 256 tiles; beyond that it sails toward the best tile seen and
  retries.
- Launch Port: the nearest to the click in a straight line. Terrain is used
  to pick the Port only when the click is water the buyer has discovered.
- Health 400, so two warship shells sink one. Warships rank targets boat,
  warship, scout, trade ship. A nuke blast sinks scouts as it does warships.
- An eliminated owner's scouts are removed on the next tick. Losing the last
  Port changes nothing, as for warships.
- The `UNITS` entry is marked `fogOnly` and has no hotkey; `buildScout`
  refuses with fog off.

### Rendering (task 4)

- **`Render.fogActive()`** is the single switch: false with fog off, once the
  match is over, for an eliminated viewer, and for a viewer with no vision
  group. `Render.canSee(tile)` is the per-tile test. The UI gates every
  filter on these.
- **The layer has one pixel per cell corner** (251x126 on the large map), not
  per cell, so undiscovered cells are fully opaque and the soft edge sits
  inside the outermost discovered cells. Clear sight is therefore about 2
  cells past the border with a fading third, not 3.
- The fog colour is the canvas backdrop (`FOG_COLOR`, `#060a14`), so the map
  edge does not show as an outline.
- In fog matches labels, badges, front numbers and popups are drawn over the
  fog and culled by their anchor tile. A nation's label (name and troops) is
  anchored and sized by its largest *discovered* stretch of land, so a
  neighbour mostly in the black is still named on the strip that shows
  (changed 2026-10-05: it used to wait for the centre of the whole nation to
  be discovered, which left a phone, with no hover, unable to read a
  neighbour's troops). A strip too thin for the normal sizing rule is
  lettered at the minimum size once it is big enough on screen
  (`FOG_LABEL_MIN_SPAN`); the label gives no hint of the hidden land's size.
- The placement ghost is drawn over the fog, since nukes and scouts aim
  blind. A warship ghost is refused unless the hovered tile and its
  destination are both discovered.
- Blasts and SAM flashes are culled on their centre. The incoming-nuke target
  ring is always drawn. "Own" missiles means the viewer's, not teammates'.
- **There is no spectator mode.** A client that is not on the roster is
  treated as player 0 and gets that player's fog. Replays were added later
  (`docs/replays.md`): a replay shows the whole map unless the viewer asks
  for one player's fog (`Replay.revealAll`).

### UI (tasks 6 and 8)

- **Leaderboard.** Six rows as today: the top 3, then met nations in rank
  order, the viewer always present, then "+N unknown nations". Rows show
  their true rank among all nations. An unmet top-3 row shows name and land
  share only, not gold or status icons. Tribes are in the ranking, so early
  on the top 3 can be tribes. Teams: the top 3 teams always, lower teams only
  if a member is met, then "+N unknown teams".
- A plain tap on an undiscovered tile does nothing.
- An unmet nation's boat in discovered water shows no hover panel.
- **Camera jumps.** A front chip jumps to a visible contested tile if the
  front's centre is in the black. An own boat in the black jumps to its
  landing tile. Someone else's boat still in the black does not jump and
  flashes "Not in sight yet".
- **Scout controls.** Hotkey E, fog matches only. The ghost colour comes only
  from `scoutBlockReason`, which never depends on terrain. The route is never
  drawn; a diamond marks the clicked destination for the owner. Shift-click
  and shift-drag select scouts with warships. A mixed order sends scouts
  anywhere and warships only to discovered water.
- Known rough edges: the "No trade" badge also shows when the other nation
  has not met the viewer; an inbound boat's chip (labelled "Unknown nation")
  appears from launch, before the boat is visible; a nuke that raises the
  alert but hits none of the viewer's tiles leaves the launcher unknown; the
  nuke alert row still jumps the camera to the impact point.

### Bots (task 9)

- **Beaches, not `coastSample`.** `coastSample` is the 12 northernmost coastal
  tiles of each landmass, so a fog bot could see an island's near shore and
  still have nothing to target. Fog matches use `AI.fogCoast()`: one ocean
  coast tile per vision cell, at most 24 per landmass. Both `navalThink` and
  scouting use it. Lake shores are left out, so lake islands are never
  fog-mode naval targets.
- A bot knows where the sample beaches are and nothing about what is on them.
- **Scouts.** One on Easy, two otherwise. Bought after the normal build order
  and exempt from the savings reserve. Launched from an ocean Port and sent
  to the nearest undiscovered beach to the home coast, ties by `Game.rng`. An
  idle scout is redirected before a new one is bought. A beach that cannot be
  reached, or lies within 80 tiles of where a scout was lost, is written off.
  A replacement waits 2 minutes. Three failed voyages retire a scout.
- An alliance offer from an unmet nation is answered blind (`strangerDecision`).
  `handleEmbargoes` skips unmet nations. SAM savings count only Silos the bot
  can see. Nukes and retaliation aim only at discovered tiles of met nations.
- Bots do not use warships to explore.
- **Measured against fog-off on the same seeds** (`tools/fog-activity.js`):
  land war is unchanged. Overseas invasions run at about half until Ports and
  scouts arrive (a Port is a bot's second purchase, so scouts appear around
  tick 2500 to 3000), then 80 to 90% on small and World maps and about half
  on medium and on large with 60 bots. No invasion check is refused as
  undiscovered any more.
- **Weak case: one giant continent.** The scout route search cannot round the
  continent inside its 200k-node guard, so about 40% of voyages fail, bots
  retire scouts, and the median nation discovers 38% of the map. Fixing it is
  a `scouts.js` change.
- Most bot scouts are eventually sunk by warships (about 95% on big maps).

### Verification (task 10)

What was checked on the final code, in a Chromium pane (no Firefox there):

- `sim-harness.js neutral` and `fog` both pass. `Hash.verifyDeterminism` takes
  `fogOfWar: true` and skips the spawn step in a fog match. Fog-on and fog-off
  dual runs agree in the browser, a flipped vision bit is caught at the turn it
  is flipped, and three browser runs end on the same hash as the same scenario
  in node (`fog-small-12345`, `fog-medium-67890`, `fog-late-medium-24680`).
- Three two-client matches on the node server (two FFA, one Teams): every hash
  compared between the two clients matched (301, 800 and 1196 of them), and
  the server flagged nothing. A client that has been eliminated (no fog) stays in
  step with one that is still fogged.
- Elimination and the end of the match lift the fog in FFA and Teams. A fog
  match after a fog-off one, and the reverse, start clean.
- Large map, 82 bots and 400 tribes, 6000 ticks: a tick averages 2.9 ms with
  fog and 3.4 ms without, worst 28 and 29 ms. The scout route search costs at
  most 4 ms in a tick. `Hash.compute` goes from 0.8 to 1.0 ms. The search arena
  is 21.7 MB and the vision grids 0.7 MB.
- Not caused by fog, but found while measuring: on The World the annexation
  sweep (every 20 ticks) costs 60 to 80 ms a time for about the first 100
  seconds of a match, fog on or off.

Fixed in this task (render and UI only):

- The City, Factory and Port ghost drew its rail link through the black
  whenever the real map had land all the way, so sweeping the cursor showed
  land from water up to 110 tiles from a station. `Render.fogRailPreview` now
  only counts discovered land, and a City or Port needs a Factory the viewer
  can see.
- With a structure armed, the hint line read "Tap to upgrade this City" over a
  hidden enemy City of the same type.
- The leaderboard kept the previous match's standings through the next match's
  countdown.
- Join Lobby sent the click event as the join code (not a fog bug; it stopped
  anyone joining by code).

Known leaks left in, both in sim code:

- **Boat wedge.** On a discovered tile the wedge reads "Undiscovered" when the
  nearest coast it would land on is hidden, and "No coast nearby" when there is
  none within 50 tiles. The difference says whether there is coast in the
  black. A plain tap on land you do not border flashes the same reasons.
  Fixing it means making `nearestOwnedCoast` skip tiles the attacker has not
  discovered, which changes where a boat goes.
- **Warship order.** The same, weaker: a click on discovered land whose
  nearest water is hidden reads "Undiscovered".

Not checked: real Firefox, a rejoin during a fog match, a real touch device,
and a bot launching a nuke in a two-client match (bot nukes were covered by
the dual run, 111 launches a run).

### Radio Tower (task 11)

- `UNITS` entry `radio`, last in the table, marked `fogOnly` but not `action`:
  it goes through the ordinary `build` intent and sits in `Game.buildings`.
  Hotkey R, fog matches only.
- **Price.** Linear like the Fort: 50k, 100k, 150k, 200k, then 250k. Builds
  in 5 seconds. Not upgradable.
- **The reveal** is one `revealAround` with `VISION_SIGHT_RADIO` (12 cells,
  about 100 tiles) in `updateConstruction`, when the tower finishes. It goes
  to whoever owns the tile at that moment, so a tower overrun while it is
  being built reveals for its captor. A finished tower that is captured
  changes hands like a City and reveals nothing more. Allies get the reveal
  through the usual sharing.
- **Refused where it would show nothing.** `buildBlockReason` returns
  "Nothing left to uncover here" when every cell of the disc is already
  discovered (`Game.visionHiddenAround`). The answer depends only on the
  builder's own discovered area, so it leaks nothing. With fog off the reason
  is "Fog of war matches only".
- **Placement ghost.** A dashed ring shows the disc the tower would uncover.
  It is centred on the vision cell, not the tile, because discovery is per
  cell.
- **Bots** (`AI.buyRadio`). Only a nation with no shore on the ocean buys
  towers; the rest explore by Scout. One at a time, at most 3 a match, not
  held back by the savings reserve. The site is the best of about 8 border
  tiles spread round the border, and nothing is bought unless it uncovers at
  least 60 cells. No rng is drawn. The generic build loop skips `fogOnly`
  entries, so a fog-off match never reaches any of this.
- **Checks.** `sim-harness.js fog` has a `fog-radio` test (price, own land,
  nothing shown until built, the whole disc on completion, the refusal, bots
  only when landlocked, refused with fog off), and each scenario reports how
  many towers bots built. `neutral` still passes.
- Not done: a tower has no use once built, and there is no way to remove one.
  It keeps its tile and can be captured.

## Tasks

| # | Task | Files | Depends on |
|---|---|---|---|
| 1 | Fog toggle in config and lobby | `protocol.js`, `localserver.js`, `gameserver.js`, `main.js`, `ui.js`, `index.html`, `core.js` | none |
| 2 | Vision state: groups, cell grid, territory reveal, met, sharing, hash | `vision.js` (new), `core.js`, `diplomacy.js`, `teams.js`, `hash.js` | 1 |
| 3 | Random fixed spawn in fog matches | `core.js`, `ui.js` | 1 |
| 4 | Fog rendering and entity culling | `render.js` | 2 |
| 5 | Scout unit in the sim, including leak-free destination search; warships reveal as they sail | `scouts.js` (new), `structures.js`, `seapath.js`, `warships.js`, `protocol.js`, `executor.js` | 2 |
| 6 | Scout controls and build bar | `ui.js`, `input.js`, `render.js` | 4, 5 |
| 7 | Action gating in the sim, including trade only between nations that have met each other | `naval.js`, `warships.js`, `diplomacy.js` | 2 |
| 8 | Hide unmet nations in leaderboard (top 3 always shown), hover, radial, alerts; "Unknown nation" senders; full map for eliminated players | `ui.js`, `radial.js`, `render.js` | 2, 4 |
| 9 | Bots respect fog and use scouts | `ai.js` | 5, 7 |
| 10 | Verification: fog-off neutrality, two-client determinism with fog on, large-map performance | `tools/`, `hash.js` | all |
| 11 | Radio Tower | `structures.js`, `vision.js`, `protocol.js`, `ui.js`, `render.js`, `ai.js` | 2, 4 |

After tasks 1 and 2, three tracks can run side by side: display (4, 8),
scouts (5, 6) and rules and bots (7, 9). Tasks 2 and 3 both edit `core.js`,
and 4 and 6 both edit `render.js`, so those pairs should not run at the same
time.

Biggest risks: task 9 (bot behaviour is spread across many functions, and
bots that explore badly make the mode feel empty) and the destination search
in task 5 (new pathfinding behaviour under a per-tick budget).

## Open questions

- **Sight radii.** Starting values above; they need playtesting on small and
  large maps. The warship radius (3 cells) is set below the scout's (5) so
  the scout stays worth buying.
- **Invasion boats.** Written above as "reveal nothing", so your own boats
  are not drawn while they cross undiscovered water. The alternative is that
  they reveal like warships.
