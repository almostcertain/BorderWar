# Replays

Added 2026-10-04. This is the client half of MP-5.2 in `multiplayer-build-log.md`
("the retained turn log plus the seed is already a complete replay"). Nothing in
the sim or on the server changed.

## What a replay is

A match is fully determined by its `gameStartInfo` and its turn stream
(`multiplayer-architecture.md` §1). A replay is those two things saved:

```
{ format: 'borderwar-replay', version: 1, id, startedAt, savedAt, build,
  gameStartInfo, myClientID, myPlayerId,
  turnCount,                 // turns played
  turns:  [[turnNumber, intents], ...],   // only turns that carried intents
  hashes: [[turnNumber, hash], ...],      // one Hash.compute() per 100 turns
  result }                   // end-screen title, or null if unfinished
```

Bots, tribes and the map come from the seed, so a solo match is a few KB. Size
grows only with what human players did.

## Recording (`js/replay.js`, top section)

Every client records its own match, solo or multiplayer. `main.js`'s `start`
handler calls `Replay.begin`, and the turns are read off `Runner.turns` when a
save is taken. Saves happen every 30 s, on `pagehide`, when the end screen shows
and when the match is left. Matches under 300 turns (30 s) are not kept.

Storage is IndexedDB (`borderwar_replays`), newest ten kept. A replay can also
be downloaded as a `.json` file and loaded back from the Replays tab. Files are
checked by `Replay.validate` (which runs every turn through
`Protocol.validateTurn`) before they are stored or played.

## Playback

Playback is a local connection whose `LocalServer` feeds the recorded turns
instead of bucketing live intents (`LocalServer.replay`). Everything downstream
is the ordinary pipeline: Runner, Executor, one `Game.tick()` per turn. There is
no second sim path.

- The `start` message carries the recorded `gameStartInfo` and the recorder's
  `clientID`, so `main.js` resolves the same `myPlayerId` it did live.
- While `Replay.active`, intents and the `winner` vote are dropped by
  `LocalServer`, and `UI.onTap`, `Radial.open` and the build hotkeys return
  early. `body.replaying` hides the build bar, ratio slider, diplomacy banner,
  pause button and debug panel. The debug panel matters: its gold buttons write
  to the sim directly.
- Pause and speed are `LocalServer.setPaused` and `LocalServer.speed`.
- "View as" sets `Game.me`, which the sim never reads. "Whole map" is
  `Replay.revealAll`, read by `Render.fogActive`.

### Seeking

Forward is `LocalServer.burst`. Backward restarts the match from turn 0 and
bursts to the target, because the sim only runs forward and has no snapshot or
restore. While a seek runs, `main.js` gives the sim 48 ms of each frame (instead
of 8) and refills the turn queue itself through `LocalServer.pumpNow`.

Measured 2026-10-04 in the Browser pane:

| Map | Sim cost | Rewinding to the 20 minute mark |
| --- | --- | --- |
| Procedural small (1000x500, 122 nations) | about 0.8 ms a turn | about 10 s |
| The World (2000x1000, 483 nations) | 4.3 to 5.8 ms a turn | about 60 to 70 s |

The fix for the large-map case is keyframes: snapshot the whole sim every few
minutes of game time and restore the nearest one. That needs a serialise and
restore for all of `Game`, `GameMap` and the bot state, including the rng, which
today is a closure with no readable state (`mulberry32` in `game/shared.js`).
Not done.

## Version drift

A replay only plays back correctly on the build that recorded it: any sim
change alters what the same turns produce. The record carries the build id, the
list marks other builds "older version", and playback compares its own hashes
with the recorded ones and shows a banner at the first mismatch. Debug gold and
debug nukes in a solo match also cause a mismatch, since they bypass the turn
stream.

## Not covered

- Server-side storage and shareable links.
- Spectator view with no player selected. The viewer always follows one player
  (the recorder by default) because the leaderboard and HUD need one.
