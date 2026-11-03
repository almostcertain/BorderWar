# Admin live watch

An admin can open any running multiplayer match from the admin page and watch it
without the players knowing.

## Flow

1. Admin page, Overview: every ACTIVE game card has a **Watch** button.
2. It calls `POST /admin/watch?game=ID` with the admin token. The server
   (`GameManager.mintWatchTicket`) answers `{ticket}`, or 404 if the game is not
   running. Tickets last 2 hours and work only for that game.
3. The page opens `/?watch=<ticket>&game=<ID>`. `main.js` hands it to
   `Watch.start` (`js/watch.js`) and strips the query string.
4. The client connects as an observer and replays the match like a replay
   (`docs/replays.md`), then follows it live.

## Server

The watcher sends an ordinary `join` whose username is `watch:<ticket>`, so the
wire protocol and `js/net/*` are unchanged. `GameManager._handleWatch` checks the
ticket and calls `GameServer.addObserver`: the socket gets the full turn log in a
`start` message (with `myClientID: 'observer'`), then every turn.

An observer is not a `Client`. It has no roster slot, is absent from
`lobby_info`, `gameStartInfo.players`, the admin page's player list and counts,
the hash tally and the liveness sweep, and never keeps a match alive. Its only
accepted message is `ping`. Observers are closed when the game is reaped.

## Client

- Read-only: `Watch.active` is checked wherever `Replay.active` blocks orders
  (taps, radial menu, build hotkeys, pause, end screen), and `body.replaying`
  hides the build bar and HUD controls. Achievements and replay recording skip it.
- **Whole map** (fog toggle, on by default) is `Watch.revealAll`, read by
  `Render.fogActive`. **View as** picks which player's HUD and fog to follow
  (`Game.me`, never read by the sim). Both are view state only.
- A dropped socket starts the match over from the full log (`Watch.onLinkLost`,
  2 s apart, 30 tries). Transport's own reconnect is switched off while
  watching, since a `rejoin` would appear in the match as a player.

## Not covered

- Rewind or seek; a watcher can only follow forward.
- The admin page does not list who is watching.
