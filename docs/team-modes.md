# Team game modes (issue #31)

Ported from OpenFront: `Game.ts` (GameMode, ColoredTeams, Duos/Trios/Quads/HumansVsNations),
`TeamAssignment.ts`, `GameImpl.addPlayers`, `PlayerImpl.isOnSameTeam/isFriendly/canBuild`,
`WinCheckExecution.checkWinnerTeam`, `TrainStation.rel`, and the client theme's `teamColors`.
Code: `js/game/teams.js`.

## Config

`gameStartInfo.config` carries two extra fields, so every lockstep client builds the same teams:

- `gameMode`: `'ffa'` (default; anything unrecognised) or `'team'`.
- `playerTeams`: a team count (the menus offer 2-7), or `'Duos'`, `'Trios'`, `'Quads'`,
  `'Humans Vs Nations'`.

Both are whitelisted by `LocalServer.start` and `GameServer.start`. The auto lobby stays FFA.
Singleplayer and the host panel each have a Mode select, plus a Teams select that appears
when Teams is picked.

## Rules

- **Team list** (`resolveTeamsList`): Red, Blue, then Yellow, Green, Purple, Orange, Teal as
  the count grows. 8 or more teams are named "Team N". Duos/Trios/Quads use
  `max(2, ceil(players / 2|3|4))` teams. Humans vs Nations uses Humans and Nations.
- **Assignment** (`assignTeams`): humans first, in roster order, then nations in shuffled
  order (drawn from `Game.rng`). Upstream seeds the shuffle from the first nation's id. Each
  player goes to the emptiest team that still has room. For Duos/Trios/Quads it's the
  fullest team with room instead, so teams fill one at a time. Max team size is
  `ceil(players / teams)`. Clans, friends and matchmaker pins don't exist here.
- **Tribes** are OpenFront's Bot team: they have no team, are never anyone's teammate and
  can't win.
- **Friendliness**: at init, each teammate goes into every other teammate's `allies` set,
  with no Alliance record. So every existing `areAllied` / `p.allies` check (attacks, boats,
  port trade, SAMs, warships, annexation, AI targeting, donations) treats teammates as
  friendly. Without a record, the pairing can't expire, be broken or be renegotiated. Also:
  - Peace offers to a teammate are blocked ("Teammate"). Nation AI never tries to betray
    one.
  - Nukes can't target a teammate's land, or land within the outer blast radius of a
    teammate's structure (upstream exempts MIRVs from the second rule).
  - Rail stops on a teammate's station pay the "team" rate, which equals the "other" rate
    (25k base), not the alliance rate. That matches upstream.
  - Embargo-all skips teammates.
- **Win** (`checkTeamWin`): a team wins when its combined land passes **80%** of non-fallout
  land. That's OpenFront's current `PERCENT_TILES_OWNED_TO_WIN`, which upstream uses for
  FFA and teams alike, with overtime off. This port's FFA check keeps its own 95%; issue #33
  covers changing that. Like the FFA check, a team also wins if it's the only one left
  holding land and no tribe survives. `Game.winnerTeam` is set, and `winnerId` is the
  team's largest member, so the existing winner vote and hash work unchanged.
- **Colours**: base colours come from upstream `teamColors`. Members take variations of
  their team colour: a small hue spread, ±10% saturation and ±18 lightness, following
  `generateTeamColors`. This is done in HSL with a triangle wave rather than LCH with
  `Math.sin`. It only affects appearance.
- **HUD**: team standings appear above the leaderboard. 👥 marks teammates on the map and
  in the leaderboard. The hover panel shows the team, and the end screen names the winning
  team.

## Determinism / goldens

The sim-harness digest covers every data key on `Game` and every field on every player.
To keep FFA's digest unchanged, the constants live on a separate `Teams` global, and
`Game.teams`, `Game.winnerTeam` and `p.team` only exist in team games. FFA makes no extra
rng draws. The golden scenario `teams4-small-12345` covers team mode: 4 teams, and Red
wins at about tick 2400.

## Not ported

Team spawn areas (`teamSpawnArea`), clans and friend grouping, ranked 2v2 rules, the
disconnected-teammate troop rules, nuking teammates after the game ends, and the lobby's
live team preview.
