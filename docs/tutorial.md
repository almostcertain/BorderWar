# Tutorial and hover descriptions

Added 2026-10-05. Client only: nothing in the sim or on the server changed.

## Tutorial (`js/tutorial.js`)

"New here? Play the tutorial" on the main menu starts a normal singleplayer
match with a fixed configuration (`Tutorial.CONFIG`: small procedural map,
`twin` landform, seed 20261005, 3 easy nations, 40 tribes, fog off) and shows a
coach panel as the first thing in the HUD. Same layout on a phone; the wording
switches between "Right-click" and "Press and hold" on `(pointer: coarse)`.

The steps, in order: expand, attack ratio, City, attack a neighbour, alliance,
Port, boat, Warship, Missile Silo, Atom Bomb, then a closing card. Placing the
capital comes first but is prompted through the spawn banner
(`Tutorial.SPAWN_HINT`), because the HUD is hidden until then.

### How a step works

Each entry in `Tutorial.STEPS` is `{ title, text(touch), glow, gold, done(me) }`.

- `done(me)` reads the sim and says whether the player has done the thing.
  `Tutorial.frame` (called from `main.js`'s loop after `UI.update`) polls it
  every frame, latches it, and advances on the next frame.
- `glow` is a selector; that element pulses (`.tutGlow`) while the step is up.
- `gold` names a unit type. See below.

The tutorial never sends an intent. The player's own taps go down the ordinary
pipeline, so adding a step is adding an entry: no new game code.

"Skip step" advances without the condition, so nothing can wedge a player (a
landlocked capital, a refused alliance). "Exit" returns to the menu.

### Freeze while reading

The match is held whenever the panel is waiting on the player, so the nations
do not grow or attack while a newcomer reads. It is `LocalServer`'s ordinary
pause (scheduling only, invisible to the sim), driven each frame by
`Tutorial.shouldFreeze`. The match runs:

- for `ACT_RUN_MS` (4 s) after the player taps the map or an order reaches the
  server. Orders sent while held are buffered and land on the first turn after.
  A bare tap counts because a held match regrows no troops, so a player whose
  tap was refused for too few would otherwise be stuck;
- for `STEP_RUN_MS` (2.5 s) after a step completes, to watch it land;
- while any of the player's buildings is under construction (the Warship and
  Atom Bomb steps wait on one);
- on the closing card, and after the tutorial ends.

The player's own Pause (button or P) is kept apart as `Tutorial.userPaused`:
`UI.togglePause` hands off to `Tutorial.togglePause` during a tutorial, and the
button shows only the player's pause, never the freeze.

### The free gold (the one sim write)

A first match cannot afford a Missile Silo in the few minutes a tutorial should
take. While a step with `gold` is up and not yet done, the player's treasury is
raised to that unit's current price each frame. This writes `player.gold`
directly, outside the intent pipeline, exactly like the debug gold buttons
(`ui.js`, DEBUG BYPASS #1), and is gated the same way on `Transport.isLocal`.

Consequences:

- Singleplayer only, by construction. Never start a tutorial on a networked
  transport.
- A tutorial match cannot be reproduced from its turns, so `main.js` does not
  call `Replay.begin` for it. No replay is saved and the end screen offers none.
- Gold stops being free when the closing card appears or a step is skipped
  past.

### Wiring

`main.js` owns connections, so it gives the tutorial `Tutorial.host`
(`start(config)`, `exit()`), the same pattern as `Replay.host`. Its `start`
handler calls `Tutorial.matchReady()` for every match; only a match that
`Tutorial.start()` just asked for becomes a tutorial.

## Hover descriptions (`UI.setupTips` in `js/ui.js`)

Any element with `data-tip` gets a description card on mouse hover, with
optional `data-tip-title` and `data-tip-key` (hotkey). One delegated
`pointerover` listener on the document drives it.

- Build bar: text comes from `UI.UNIT_TIPS`, keyed by unit type, written into
  the buttons by `rebuildBuildBar`. A new `Game.UNITS` entry needs a line there.
  Numbers are read from the sim's constants.
- Radial menu: each slot in `radial.js` carries a `tip`.
- Fixed HUD (troop bar, gold, growth, ratio, Pause, Music, Options): attributes
  in `index.html`.

Mouse only. Touch has no hover; phone players learn the same things from the
tutorial.
