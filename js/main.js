(() => {
  const canvas = document.getElementById('game');
  Render.setup(canvas);
  Input.setup(canvas);
  Radial.setup();
  UI.setup();

  // How long one frame may spend advancing the simulation before it has to
  // hand the frame back to the renderer (docs/multiplayer-architecture.md §5).
  //
  // Under lockstep the sim is driven by TURN ARRIVAL, not by elapsed time, so
  // the loop below has no accumulator and no dt: it drains whatever turns the
  // server has sent. Almost always that is zero or one turn and the budget is
  // never reached. It exists for the case where a pile of turns arrives at
  // once — a rejoin backlog (MP-4.1) or the debug burst — where executing the
  // whole queue in one frame would freeze the tab for as long as the backlog
  // is deep. This is the thing OpenFront buys instead by running its sim in a
  // Web Worker; §8 divergence #2 explains why we take the budget instead.
  const SIM_BUDGET_MS = 8;

  // performance.now() at the moment the most recent turn finished executing.
  // Only ever used for render smoothing — see Game.renderElapsed below.
  let lastTurnAt = 0;

  // A bigger board on its own barely lengthens a match: the same handful of
  // conquests still decides it. What stretches a game is more nations, so each
  // one you beat is a smaller share of the world — which is how OpenFront's
  // large maps stay long. These defaults follow the map size, and are just
  // defaults; the field stays editable.
  //
  // OpenFront itself doesn't tie a bot/player count to map size at all —
  // config.bots() is a free host setting regardless of which map is loaded —
  // so there's no real number to port here. Rescaled from the old defaults to
  // match MAP_SIZES' now-real dimensions (small shrank; large and xlarge grew
  // substantially), capped at 31 to stay within PLAYER_COLORS/BOT_NAMES' 32
  // entries (31 bots + the human).
  const BOTS_FOR_SIZE = { small: 5, medium: 10, large: 20, xlarge: 31 };

  // Tribes are OpenFront's low-effort filler (openfront.wiki/Bots): weak and
  // half-capped individually, so a map can carry more of them than Nations
  // without the early game turning into an unbeatable wall. Roughly double
  // the Nation count at each size, same free-editable-field treatment.
  const TRIBES_FOR_SIZE = { small: 8, medium: 16, large: 32, xlarge: 50 };

  const sizeSelect = document.getElementById('mapSize');
  const botInput = document.getElementById('botCount');
  const tribeInput = document.getElementById('tribeCount');
  sizeSelect.addEventListener('change', () => {
    botInput.value = BOTS_FOR_SIZE[sizeSelect.value] || 9;
    tribeInput.value = TRIBES_FOR_SIZE[sizeSelect.value] || 16;
  });

  // --- Multiplayer lobby (MP-2.3) --------------------------------------------
  //
  // Host and Join are two more paths through the exact same Transport/
  // onConnect/onServerMessage pipeline as singleplayer's start() below — §2's
  // rule holds here too: still one connect(), one onConnect, one
  // onServerMessage. All that differs is `local:false` plus a real gameID,
  // and — for Host only — who is allowed to call Transport.sendStartGame
  // afterward. Singleplayer's own start() is untouched below except for one
  // added line resetting `myRole`, so a mode switch back to Singleplayer
  // after visiting Host/Join cannot leave lobby state stale.

  // Which lobby panel (if any) is in play, purely so onServerMessage knows
  // where to route a `lobby_info`/`error`. Never sent anywhere.
  let myRole = 'sp'; // 'sp' | 'host' | 'join'

  // Whether THIS connection's clientID is the game's recorded creator, per
  // the most recent `lobby_info`. Gates the host panel's Start button and
  // startHostedGame's own guard below; the server enforces the real rule
  // independently (GameServer.handleStartGame), so this is UI affordance,
  // not the authority.
  let iAmHost = false;

  // Cosmetic randomness for a join code — not simulation state, so plain
  // Math.random is fine here (§7.4 restricts Game.rng to sim code only, not
  // UI-local ids like this one). Excludes 0/O/1/I so a code read aloud over
  // voice chat is not ambiguous.
  function randomGameID() {
    const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += CHARS[(Math.random() * CHARS.length) | 0];
    return s;
  }

  // True from the moment a lobby connection is issued until the match starts
  // (or the player leaves / the link dies). Scopes Transport's link-status
  // callback below to the lobby — once a match is running, reconnect is
  // Transport's own business and the lobby screen is long gone.
  let inLobby = false;
  let lobbyLinkOpened = false; // did this lobby's socket ever open?

  Transport.onStatus = function(status) {
    if (!inLobby) return;
    if (status === 'open') {
      lobbyLinkOpened = true;
      // The roster arrives with the server's first lobby_info, right after this.
      UI.setLobbyStatus(myRole, 'Connected — joining lobby…', true);
    } else if (status === 'lost') {
      // A lobby has nothing to resume (the server refuses a rejoin before a
      // match starts), so stop Transport's retries and put the forms back.
      // A server `error` already on screen (e.g. game already started) is
      // more specific than this, so it is left alone.
      const wasOpen = lobbyLinkOpened;
      leaveLobby();
      if (!document.getElementById('lobbyError').textContent) {
        UI.setLobbyError(wasOpen
          ? 'Lost connection to the server.'
          : "Couldn't reach the multiplayer server. Is it running? (node server/index.js)");
      }
    }
  };

  function leaveLobby() {
    inLobby = false;
    lobbyLinkOpened = false;
    myRole = 'sp';
    iAmHost = false;
    Transport.disconnect();
    UI.hideLobby();
  }

  function hostLobby() {
    const gameID = randomGameID();
    const username = UI.getHostUsername() || 'Host';
    myRole = 'host';
    iAmHost = false; // confirmed once this connection's own lobby_info arrives
    inLobby = true;
    lobbyLinkOpened = false;

    Transport.disconnect();
    Runner.reset();
    UI.showHostLobby(gameID);

    Transport.connect(onConnect, onServerMessage, {
      local: false,
      gameID: gameID,
      username: username
    });
  }

  function joinLobby() {
    const info = UI.getJoinInputs();
    if (!info.code) { UI.setLobbyError('Enter a join code.'); return; }
    myRole = 'join';
    iAmHost = false;
    inLobby = true;
    lobbyLinkOpened = false;

    Transport.disconnect();
    Runner.reset();
    UI.showJoinLobby();

    Transport.connect(onConnect, onServerMessage, {
      local: false,
      gameID: info.code,
      username: info.username || 'Player'
    });
  }

  // Host only. The button this calls from is hidden/disabled for anyone
  // whose last lobby_info said otherwise (UI.updateLobbyFromInfo), and the
  // server independently re-checks authorship (GameServer.handleStartGame)
  // — this `if` is belt-and-braces, not the actual gate.
  function startHostedGame() {
    if (!iAmHost) return;
    Transport.sendStartGame(UI.getHostConfig());
  }

  document.getElementById('hostCreateBtn').addEventListener('click', hostLobby);
  document.getElementById('hostStartBtn').addEventListener('click', startHostedGame);
  document.getElementById('joinBtn').addEventListener('click', joinLobby);
  document.getElementById('hostLeaveBtn').addEventListener('click', leaveLobby);
  document.getElementById('joinLeaveBtn').addEventListener('click', leaveLobby);

  // The link is up. Nothing has arrived on it yet — `start` is the next thing
  // to be delivered — so this is where the things that must be empty *before*
  // the first turn lands get emptied. LocalServer.start announces the
  // connection before it emits anything, precisely so this can happen first.
  function onConnect() {
    Runner.reset();
    Executor.reset();
  }

  // Everything a server says to us (§4's server->client table). Two messages
  // matter in Phase 1; `lobby_info` and `error` are MP-2.3's additions, live
  // only on a real (non-local) connection — LocalServer never emits either.
  function onServerMessage(msg) {
    if (!msg) return;

    if (msg.type === 'lobby_info') {
      // `lobby.creatorClientId` is compared against the id THIS message says
      // we are (`msg.myClientID`), never against Transport.myClientID read
      // separately — both are set from the same field by Transport.connect's
      // `deliver` wrapper before this handler runs, but comparing within one
      // message is one fewer place for the two to ever disagree.
      const lobby = msg.lobby || {};
      iAmHost = !!lobby.creatorClientId && lobby.creatorClientId === msg.myClientID;
      UI.updateLobbyFromInfo(lobby, myRole, iAmHost, msg.myClientID);
      return;
    }

    if (msg.type === 'error') {
      // e.g. `not-host` (a non-creator tried start_game) or `already-started`
      // — §4's `error` message. Surfaced on whichever lobby panel is open;
      // harmless if none is (the element simply sits hidden with old text).
      UI.setLobbyError(msg.message || msg.error || 'Server error.');
      return;
    }

    if (msg.type === 'start') {
      // MP-4.1: a reconnected socket's own `start` is a catch-up backlog, not
      // a fresh match — Transport._wireSocket tags exactly the first `start`
      // a rejoined socket receives with `__rejoin` (see its doc comment).
      // Everything below this branch (Game.init, Executor.setRoster,
      // Render.onMapReady, UI.reset/enterSpawnSelect) exists to stand up a
      // match from nothing, which is precisely what must NOT happen here:
      // this client's Game/Runner/Executor state is exactly where it was the
      // instant the socket died — untouched, because nothing in the
      // reconnect path calls Runner.reset()/Executor.reset()/Game.init — and
      // the server sent turns.slice(lastTurn) on that assumption. All that is
      // needed is to queue what arrived for the frame-budgeted drain loop
      // below to work through, same as a fresh start's own backlog line does.
      if (msg.__rejoin) {
        if (Array.isArray(msg.turns)) for (const t of msg.turns) Runner.addTurn(t);
        return;
      }

      inLobby = false; // the match is starting; the lobby screen is done

      // The match's configuration comes back from the server rather than being
      // read out of the DOM controls here. In singleplayer LocalServer merely
      // echoes what start() handed it, so the values are the same either way —
      // but the client is written against gameStartInfo from the beginning, so
      // MP-2.2 changes who fills that object in and nothing on this side.
      const info = msg.gameStartInfo || {};

      // clientID -> playerId. One entry today; MP-3.1 is where it stops being
      // one. Installed before any intent can be applied, because an intent
      // whose author cannot be resolved is dropped (executor.js).
      Executor.setRoster(info.players);

      // Which roster entry is us: compared against `msg.myClientID` (this
      // message's own field), never a separately-read Transport.myClientID —
      // same reasoning as the `lobby_info` handler above. A roster entry not
      // found (should not happen in practice) falls back to player 0 rather
      // than throwing; Game.init's own defensive clamp covers the same case
      // a second time.
      const rosterEntries = Array.isArray(info.players) ? info.players : [];
      const myEntry = rosterEntries.find(function(p) { return p && p.clientID === msg.myClientID; });
      const myPlayerId = myEntry ? myEntry.playerId : 0;

      Game.init(info, myPlayerId);
      Render.onMapReady();
      Render.centerOnMap();
      UI.reset();
      UI.enterSpawnSelect();

      // The catch-up backlog. Empty at a fresh start; non-empty after a rejoin
      // (§4), and the drain loop below is what works through it.
      if (Array.isArray(msg.turns)) for (const t of msg.turns) Runner.addTurn(t);

      lastTurnAt = performance.now();
      document.getElementById('overlay').classList.add('hidden');
      document.getElementById('endOverlay').classList.add('hidden');
      return;
    }

    if (msg.type === 'turn') {
      Runner.addTurn(msg.turn);
      return;
    }

    if (msg.type === 'desync') {
      // MP-4.2: the server's hash tally (GameServer._tallyHashes) flagged
      // this client. Diagnostic only, per the task spec — this handler does
      // not disconnect, roll back, or otherwise act on the sim; it just
      // surfaces what happened so a player (or someone reading devtools)
      // knows this client's state has drifted from the rest of the match.
      const detail = 'turn ' + msg.turn + ': your hash ' + msg.yourHash
        + (msg.correctHash === null
          ? ' — active clients could not agree on a plurality hash ('
            + msg.totalActiveClients + ' reporting)'
          : ' != plurality hash ' + msg.correctHash + ' ('
            + msg.clientsWithCorrectHash + '/' + msg.totalActiveClients + ' agreed)');
      console.warn('[desync] ' + detail, msg);
      UI.showDesyncWarning('Desync detected at turn ' + msg.turn
        + ' — your simulation no longer matches the other players.');
      return;
    }
  }

  function start() {
    const bots = Math.max(2, Math.min(31, parseInt(botInput.value, 10) || 9));
    const tribes = Math.max(0, Math.min(80, parseInt(tribeInput.value, 10) || 0));
    const mapSize = sizeSelect.value;

    // A new match is a new connection. Tearing the old one down first stops a
    // previous match's LocalServer pump from outliving it and emitting turns
    // into a game that has been re-initialised underneath it.
    inLobby = false;
    myRole = 'sp';
    Transport.disconnect();
    Runner.reset();

    // Everything below the lobby is settings a real server would have decided
    // and put in gameStartInfo; LocalServer synthesizes it from these instead.
    // `local: true` is the only line in the client that knows which kind of
    // server this is (§2) — MP-2.3's lobby is what will set it false.
    Transport.connect(onConnect, onServerMessage, {
      local: true,
      gameID: 'local',
      username: 'You',
      seed: (Math.random() * 1e9) | 0,
      mapSize: mapSize,
      bots: bots,
      tribes: tribes
    });
  }

  // §5's loop. The sim advances because a turn arrived, never because time
  // passed: `Runner.executeNextTurn` applies one turn's intents and takes
  // exactly one Game.tick, and `Transport.turnComplete` is the backpressure
  // signal that lets the server emit the next one (see LocalServer.turnComplete
  // — it is what stops singleplayer running away from itself, and what makes
  // the debug burst client-paced).
  function loop(now) {
    requestAnimationFrame(loop);
    if (!Render.tileCanvas) return;

    const budgetEnd = performance.now() + SIM_BUDGET_MS;
    while (Runner.pendingTurns() > 0 && performance.now() < budgetEnd) {
      Runner.executeNextTurn();
      Transport.turnComplete();
      lastTurnAt = performance.now();
    }

    // MP-4.1: catch-up progress. Purely a readout of what the drain loop just
    // above already did — this owns no logic of its own, only whether a
    // "catching up" banner is visible and what it says. Not reconnect-
    // specific in how it's driven (it's just whatever pendingTurns() is left
    // after this frame's budget-limited pass), but a same-tick backlog is
    // always ≤1 turn in ordinary play, so in practice this only ever shows
    // during the kind of multi-hundred-turn backlog a rejoin produces.
    UI.updateCatchup(Runner.pendingTurns());

    // Smooth clock for animation only. Wall-clock time since the last executed
    // turn, CLAMPED TO ONE TICK: the sim's authoritative state is whatever the
    // last turn produced, and an animation that ran past it would be
    // extrapolating a future the server has not sent yet. Under jitter — or
    // whenever a turn is a few ms late — this sits still for a frame instead,
    // which is correct and is the trade §5 asks for.
    const since = (performance.now() - lastTurnAt) / 1000;
    Game.renderElapsed = Game.elapsed + Math.max(0, Math.min(Game.TICK_DT, since));

    Render.draw();
    UI.update();
    // MP-3.5: Game.running is what BECOMES false the instant a winner is
    // decided (see Game.tick()), so gating this call on Game.running would
    // stop calling checkEndGame at the exact moment it's needed — including
    // for a client that goes !running on the very same tick the winner was
    // set. Game.winnerId is the real trigger; checkEndGame's own
    // endGameHandled latch (see ui.js) keeps it a one-shot from here on.
    if (Game.winnerId !== null) UI.checkEndGame();
  }

  document.getElementById('startBtn').addEventListener('click', start);
  document.getElementById('restartBtn').addEventListener('click', () => {
    document.getElementById('endOverlay').classList.add('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    // The lobby that fed the finished match is gone; don't show its stale code.
    inLobby = false;
    myRole = 'sp';
    UI.hideLobby();
    // The finished match's player still exists until Game.init() runs again,
    // which would otherwise leave the debug panel floating over this menu.
    document.getElementById('debugPanel').classList.add('hidden');
    document.getElementById('debugToggle').classList.add('hidden');
  });

  requestAnimationFrame(loop);
})();
