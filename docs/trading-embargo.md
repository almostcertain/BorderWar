# Trading & embargoes (ticket #14)

Ported from OpenFront's `PlayerImpl` (`addEmbargo` / `stopEmbargo` /
`endTemporaryEmbargo` / `canTrade`), `EmbargoExecution`,
`EmbargoAllExecution`, `AttackExecution`, `PlayerExecution`,
`AllianceRequestExecution`, `TradeShipExecution`, `PortExecution`,
`TrainStation`/`TrainExecution` and `NationExecution`.

## Rules

- Trade is open with everyone by default. If **either** side has an embargo
  on the other, the pair can't trade (`Game.canTrade`).
- Blocked trade means:
  - Ports don't pick the other side's Ports as trade-ship destinations.
  - A trade ship already sailing between them is scrapped, unpaid. A ship a
    warship captured is exempt, because it's heading for its captor's own Port.
  - Trains don't pick the other side's stations as destinations. A train
    whose next station stops trading with it ends its trip there.
- **Manual embargo** (radial north wedge, "Stop trade" / "Trade"): lasts
  until lifted.
- **Stop all / Trade all**: `Game.setEmbargoAll` and the `embargo_all`
  intent exist (every living non-tribe, 10 s cooldown), but the button is
  removed from the UI for now.
- **Automatic embargo:** each attack order, and each boat landing, makes the
  victim stop trading with the attacker for 5 minutes. The timer restarts on
  every new order. It lifts early if the two sides ally. A manual embargo
  is never downgraded to an automatic one, and allying doesn't lift it.
- Tribes never trade and are never embargoed.

## Nation AI

- A nation stops trading with anyone whose relation is below -50 (Hostile).
- It starts again when relation recovers to 0 (Neutral). On Hard it waits
  until +50 (Friendly), as OpenFront's Hard does (`AI.PROFILES.embargoLiftAt`).
  The same check can end an automatic embargo early.
- Being embargoed by someone costs a nation 20 relation toward them, once.
  The 20 comes back when the embargo lifts.

## Not ported

- OpenFront's team-game rule, where Hard nations embargo every other team.
  This game has no teams.
- Event-feed messages ("X stopped trading with you"). The hover panel shows
  "🚫 No trade", and the radial shows who is refusing.

## Wire

Two intents, with OpenFront's own names: `embargo {targetID, action}` and
`embargo_all {action}`. `action` is `"start"` or `"stop"`.
