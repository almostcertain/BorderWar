# Bot difficulty (ticket #5)

Singleplayer's menu has an Easy / Medium / Hard picker. It sets
`config.difficulty` in the game start info; `Game.init` stores it as
`Game.difficulty`. Anything missing or unrecognised is **Medium**, so the
multiplayer host lobby (which sends no difficulty yet) is unchanged.

Difficulty applies to Nations (`isBot`) only. Tribes and humans ignore it.

## Two halves

| Half | Where | What it moves |
| --- | --- | --- |
| Strength | `Game.NATION_DIFFICULTY` (`js/game/economy.js`) | Starting troops, troop cap, troop growth. OpenFront's real figures. |
| Behaviour | `AI.PROFILES` (`js/ai.js`) | How fast and how aggressively a Nation plays. Our own tuning. |

| | Easy | Medium | Hard |
| --- | --- | --- | --- |
| Start troops (raw) | 12,500 | 18,750 | 25,000 |
| Troop cap / growth | 0.5x / 0.9x | 0.75x / 0.95x | 1.0x / 1.0x |
| Think gap (land / naval) | 1.6x slower | baseline | 0.7x (faster) |
| Fresh nation attack / free-land grab | 40% / 30% | 55% / 35% | 65% / 45% of troops |
| Confused alliance answers | 1 in 10 | 1 in 20 | never |
| Betrays an ally under 1/n of its army | 1/20, no opportunist stabs | 1/10 | 1/5 |
| Nukes | never (no Silos built) | 1 in 8 per cycle | 1 in 5 per cycle |
| Hydrogen bomb, when worthy | - | 1 in 4 | 1 in 3 |
| Most Atom Bombs in one strike, to beat SAM cover | - | 3 | 5 |
| Nuke back at a nation overrunning it (#20) | never | 1 in 2 per cycle | every cycle |

Retaliation (`AI.maybeRetaliate`) fires when a Nation lost at least 0.5% of
its land (5 tiles minimum) since its last economy cycle while a non-Tribe
nation is attacking it, and it has a ready Silo and an Atom Bomb's gold. It
runs before the cycle's spending, targets the attacker with the most troops
committed, and aims just behind that attacker's side of the front
(`AI.retaliationTarget`), scoring aim points so the blast stays off its own
land and off any ally's land or structures. With no clean aim point it holds
fire.

## Nukes against SAM cover

All tiers that fire (`js/ai.js`, "Nukes against SAM cover"). A SAM kills any
hostile nuke in range while it has a charge, so a single bomb at a covered
target is wasted. Before this, bots lost nearly every warhead once SAMs were
up (87 of 88 in the `late-medium-24680` match).

- `AI.predictSalvo` flies a planned strike ahead of time against every SAM
  the Nation knows of (range, charges, reloads; third parties under the flight
  path included).
- `AI.nukeTarget` prices each structure in bombs and picks the most priority
  per bomb: an open City can beat a covered Silo. If nothing in the top six
  can be reached it takes any structure one bomb gets to, then open ground.
- A blast destroys every structure inside its outer radius, so `AI.standoff`
  tries aim points short of the target, outside the cover. A Hydrogen Bomb's
  blast is wider than a low-level SAM's range, so it can kill the SAM itself
  that way. A Hydrogen Bomb is never fired into cover and never where the
  blast would reach the Nation's own side (`AI.blastSafe`).
- Otherwise it fires one bomb more than the cover has charges, all in the
  same tick (`AI.fireSalvo`), up to the tier's `salvo`. Short of gold or Silo
  slots it holds fire and banks for the salvo (`p.aiSalvo`, read by
  `savingsGoal` / `savingsReserve`).
- If a strike is shot down anyway (a SAM in the fog, cover that changed
  mid-flight), the Nation remembers cover over that spot for 3 minutes
  (`p.aiCover`) and sends more next time. `Game.noteNukeShot` (`sam.js`)
  records the loss on the player.
- Retaliation (`AI.retaliationTarget`) uses the same prediction.

Measured over the same matches afterwards: 1 of 54 shot down without fog,
14 of 50 with fog (was 58 of 70), where unseen SAMs are still a real risk.

Bots still almost never hold the 5M a Hydrogen Bomb costs: they keep one Atom
Bomb's price in reserve and spend the rest. That is unchanged.

## Trade network

All tiers (`js/ai.js`, "Trade network"). Bots used to place Cities and
Factories on random tiles and Ports on the first coast in their tile list.

- **Factory** (`AI.factorySite`): goes where it links the most train-stop
  value (own stop 1, another nation's 2.5, an ally's 3.5, matching train
  gold), checked against the real rail rule (in range and reachable by a
  straight or one-bend track). Never built where it would link nothing.
- **City** (`AI.citySite`): inside a Factory's reach, else beside another
  City so one Factory can later serve both. Off the border first.
- **Port** (`AI.portSite`): the coast with the best average trade-ship gold,
  which rises steeply with distance to the partner Port, among Ports on the
  same body of water it is allowed to trade with. A Factory in reach is a
  bonus, hostile land nearby a penalty. No Port on a lake with no partners.
- The shared Factory/Port budget buys two Ports per Factory
  (`PORTS_PER_FACTORY`): a ship pays both ends several times a train stop.

Measured over nine matches (three seeds each of small, medium, large): bot
trade income up about two thirds in total, gold per trade ship up from about
79k to about 117k, no unlinked Factories (was 16 of 67). Two of the nine
matches came out lower; matches diverge a lot once anything changes.

## Rules for changing this

- **Medium is the baseline.** Every Medium value is the constant it replaced,
  and a Medium match is bit-identical to before this feature (verified against
  the old goldens: every checkpoint hash, owner map and action count matched).
- Profile knobs must not add or remove `Game.rng` draws for Medium.
- Easy/Hard have their own goldens (`medium-easy-67890`, `medium-hard-12345`,
  `late-medium-easy-24680`, `late-medium-hard-24680`), so tuning either tier
  means re-recording those; say why in the commit.

## Not done

- Multiplayer: no lobby picker; hosted games run Medium.
- OpenFront's fourth tier, Impossible.
- Hard is faster and more aggressive, not smarter; it does not port
  OpenFront's difficulty-specific targeting.
