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
| Nuke back at a nation overrunning it (#20) | never | 1 in 2 per cycle | every cycle |

Retaliation (`AI.maybeRetaliate`) fires when a Nation lost at least 0.5% of
its land (5 tiles minimum) since its last economy cycle while a non-Tribe
nation is attacking it, and it has a ready Silo and an Atom Bomb's gold. It
runs before the cycle's spending, targets the attacker with the most troops
committed, and aims just behind that attacker's side of the front
(`AI.retaliationTarget`), scoring aim points so the blast stays off its own
land and off any ally's land or structures. With no clean aim point it holds
fire.

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
