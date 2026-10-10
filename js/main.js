(() => {
  const canvas = document.getElementById('game');
  Progress.init();
  Render.setup(canvas);
  Input.setup(canvas);
  Radial.setup();
  UI.setup();
  Tutorial.setup();

  // How long one frame may spend advancing the sim before handing back to the
  // renderer (docs/multiplayer-architecture.md §5). Turns normally arrive one
  // at a time; the budget matters for a backlog (a rejoin, the debug burst).
  const SIM_BUDGET_MS = 8;

  // The same budget while a replay is seeking (js/replay.js). A jump is a
  // long run of turns the viewer is waiting on, so the sim gets most of the
  // frame and the picture drops to a few frames a second until it arrives.
  const SEEK_BUDGET_MS = 48;

  // performance.now() at the moment the most recent turn finished executing.
  // Only ever used for render smoothing — see Game.renderElapsed below.
  let lastTurnAt = 0;

  // More nations, not a bigger board, is what lengthens a match, so the
  // default counts follow map size. The fields stay editable up to
  // BOT_CAP/TRIBE_CAP, sized so PLAYER_COLORS/BOT_NAMES (js/game/shared.js)
  // has an entry per bot plus up to 4 humans.
  const BOT_CAP = 100;
  const TRIBE_CAP = 400;

  // World (2000x1000) counts. Procedural large is the same grid and shares them.
  const WORLD_BOTS = 82;
  const WORLD_TRIBES = 400;

  // Nations/Tribes per tile, taken from World/large. Every other size gets
  // the same density for its own tile count. Tribes stay roughly quadruple
  // the Nation count.
  const LARGE_TILES = Game.MAP_SIZES.large.width * Game.MAP_SIZES.large.height;
  const BOT_DENSITY = WORLD_BOTS / LARGE_TILES;
  const TRIBE_DENSITY = WORLD_TRIBES / LARGE_TILES;

  const BOTS_FOR_SIZE = { large: WORLD_BOTS };
  const TRIBES_FOR_SIZE = { large: WORLD_TRIBES };
  for (const key of ['small', 'medium']) {
    const tiles = Game.MAP_SIZES[key].width * Game.MAP_SIZES[key].height;
    BOTS_FOR_SIZE[key] = Math.max(1, Math.round(tiles * BOT_DENSITY));
    TRIBES_FOR_SIZE[key] = Math.max(1, Math.round(tiles * TRIBE_DENSITY));
  }

  const sizeSelect = document.getElementById('mapSize');
  const mapTypeSelect = document.getElementById('mapType');
  const botInput = document.getElementById('botCount');
  const tribeInput = document.getElementById('tribeCount');
  const difficultySelect = document.getElementById('difficulty');

  // Singleplayer and the host lobby panel share the same size -> defaults
  // behavior, so both map selects are wired through here.
  function bindSizeDefaults(select, bots, tribes) {
    select.addEventListener('change', () => {
      bots.value = BOTS_FOR_SIZE[select.value] || 9;
      tribes.value = TRIBES_FOR_SIZE[select.value] || 16;
    });
  }
  bindSizeDefaults(sizeSelect, botInput, tribeInput);
  bindSizeDefaults(document.getElementById('hostMapSize'),
    document.getElementById('hostBotCount'), document.getElementById('hostTribeCount'));

  // Map Size and the map options box only apply to the procedural
  // generator, so they are hidden (not disabled) when World is picked.
  function applyMapTypeDefaults(mapType, sizeRow, sizeSelect, bots, tribes, prefix) {
    const isWorld = mapType.value === 'world';
    sizeRow.classList.toggle('hidden', isWorld);
    document.getElementById(prefix ? prefix + 'MapGenBox' : 'mapGenBox').classList.toggle('hidden', isWorld);
    if (!isWorld) UI.refreshMapPreview(prefix);
    if (isWorld) {
      bots.value = WORLD_BOTS;
      tribes.value = WORLD_TRIBES;
    } else {
      bots.value = BOTS_FOR_SIZE[sizeSelect.value] || 9;
      tribes.value = TRIBES_FOR_SIZE[sizeSelect.value] || 16;
    }
  }
  function bindMapType(mapType, sizeRow, sizeSelect, bots, tribes, prefix) {
    mapType.addEventListener('change', () => {
      applyMapTypeDefaults(mapType, sizeRow, sizeSelect, bots, tribes, prefix);
      if (mapType.value === 'world') {
        // Preload eagerly the moment World is actually chosen, rather than
        // waiting for Start — see js/net/worldmap.js. Failure is surfaced
        // when Start is actually pressed (the 'start' handler below); this
        // fire-and-forget call just avoids an unhandled-rejection warning.
        WorldMapLoader.ensure().catch(() => {});
      }
    });
    // Without this the fields would sit at their static HTML values (9/16)
    // instead of the selected map's actual defaults until the player touches
    // the dropdown themselves.
    applyMapTypeDefaults(mapType, sizeRow, sizeSelect, bots, tribes, prefix);
    // Browsers can restore the select's last value on reload or back/forward
    // after this runs, without a change event; re-sync once the page shows.
    window.addEventListener('pageshow', () => applyMapTypeDefaults(mapType, sizeRow, sizeSelect, bots, tribes, prefix));
  }
  bindMapType(mapTypeSelect, document.getElementById('mapSizeRow'), sizeSelect, botInput, tribeInput, '');
  bindMapType(document.getElementById('hostMapType'), document.getElementById('hostMapSizeRow'),
    document.getElementById('hostMapSize'), document.getElementById('hostBotCount'), document.getElementById('hostTribeCount'), 'host');

  // Procedural is the default selection in both panels (index.html), but a
  // browser can restore World on reload or back/forward without a change
  // event — start fetching it then rather than waiting for Start. Failure is
  // surfaced later, when Start is actually pressed.
  window.addEventListener('pageshow', () => {
    if (mapTypeSelect.value === 'world' || document.getElementById('hostMapType').value === 'world') {
      WorldMapLoader.ensure().catch(() => {});
    }
  });

  // --- Multiplayer lobby ------------------------------------------------------
  //
  // Host and Join go through the same Transport/onConnect/onServerMessage
  // pipeline as singleplayer's start(): `local:false` plus a real gameID.

  // Which lobby panel (if any) is in play, purely so onServerMessage knows
  // where to route a `lobby_info`/`error`. Never sent anywhere.
  let myRole = 'sp'; // 'sp' | 'host' | 'join'

  // Whether this connection is the game's creator, per the latest
  // `lobby_info`. UI affordance only; the server enforces the real rule
  // (GameServer.handleStartGame).
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
  let fromQuickJoin = false; // entered via the main menu's open-game card

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
    // Joined from the main menu's open-game card: return there, not to the
    // join-by-code form that was opened only to host the lobby panel.
    if (fromQuickJoin) {
      fromQuickJoin = false;
      document.getElementById('modeBack').click();
    }
    // Back on the menu — the hero card is relevant again regardless of which
    // secondary tab happens to be selected, so this no longer checks which
    // one that is (contrast the old join-tab-only polling this replaced).
    startLobbyListPolling();
  }

  function hostLobby() {
    const gameID = randomGameID();
    const username = UI.getPlayerName() || 'Host';
    myRole = 'host';
    iAmHost = false; // confirmed once this connection's own lobby_info arrives
    fromQuickJoin = false;
    inLobby = true;
    lobbyLinkOpened = false;
    stopLobbyListPolling();

    Replay.finish();
    Transport.disconnect();
    Runner.reset();
    UI.showHostLobby(gameID);

    Progress.sendLoadout();
    Transport.connect(onConnect, onServerMessage, {
      local: false,
      gameID: gameID,
      username: username,
      public: UI.isPublicLobby()
    });
  }

  function joinLobby(gameIDOverride) {
    if (gameIDOverride) document.getElementById('joinCode').value = gameIDOverride;
    const info = UI.getJoinInputs();
    const code = gameIDOverride || info.code;
    if (!code) { UI.setLobbyError('Enter a join code.'); return; }
    myRole = 'join';
    iAmHost = false;
    fromQuickJoin = false;
    inLobby = true;
    lobbyLinkOpened = false;
    stopLobbyListPolling();

    Replay.finish();
    Transport.disconnect();
    Runner.reset();
    UI.showJoinLobby();

    Progress.sendLoadout();
    Transport.connect(onConnect, onServerMessage, {
      local: false,
      gameID: code,
      username: info.username || 'Player'
    });
  }

  // Public lobby list and the hero card (#quickJoin): polls GET /lobbies.
  // Runs whenever the menu is on screen with no lobby connection in flight.
  // Stopped by joinLobby/hostLobby/start, resumed by leaveLobby/restart.
  let lobbyListIntervalID = null;
  let lastLobbyList = [];
  const LOBBY_LIST_POLL_MS = 4000;

  // Dev only (?debug): a fake open game standing in for the server's, so the
  // menu's map preview can be checked without a running server. Not joinable.
  let debugLobby = null;
  const debugBtn = document.getElementById('quickJoinDebugBtn');
  if (/[?&]debug\b/.test(location.search)) {
    debugBtn.classList.remove('hidden');
    debugBtn.addEventListener('click', () => {
      debugLobby = {
        gameID: 'DEBUG', isAuto: true, debugFake: true, mapSize: 'medium',
        seed: Math.floor(Math.random() * 0x100000000),
        playerCount: 0, minPlayers: 2, maxPlayers: 8
      };
      refreshLobbyList();
    });
  }

  function refreshLobbyList() {
    Transport.fetchLobbyList().then((list) => {
      lastLobbyList = list;
      UI.renderQuickJoin(debugLobby || list.find((entry) => entry.isAuto) || null);
      UI.renderPublicLobbies(list.filter((entry) => !entry.isAuto), (gameID) => joinLobby(gameID));
    });
  }

  function startLobbyListPolling() {
    stopLobbyListPolling();
    refreshLobbyList();
    lobbyListIntervalID = setInterval(refreshLobbyList, LOBBY_LIST_POLL_MS);
  }

  function stopLobbyListPolling() {
    if (lobbyListIntervalID !== null) {
      clearInterval(lobbyListIntervalID);
      lobbyListIntervalID = null;
    }
  }

  document.getElementById('lobbyListRefreshBtn').addEventListener('click', refreshLobbyList);

  // The hero card's own button ("Play now") — joins whichever lobby the last
  // poll found flagged `isAuto` (GameManager always keeps exactly one). With
  // none to join (server down, or between restarts) it starts a singleplayer
  // match instead, on whatever the Solo vs bots form currently says, so the
  // menu's loudest button always leads to a game.
  document.getElementById('quickJoinBtn').addEventListener('click', () => {
    if (debugLobby) return;
    quickJoin(lastLobbyList.find((e) => e.isAuto));
  });

  function quickJoin(entry) {
    if (!entry) { start(); return; }
    // joinLobby()'s in-progress UI lives inside #joinMode (#joinLobby), which
    // is only visible while the Play with friends screen is open (UI.setupLobby's
    // click handler toggles each mode body's `hidden` class) — open it first
    // so the join doesn't connect into a panel nobody can see.
    document.querySelector('.modeTab[data-mode="friends"]').click();
    document.getElementById('modeTitle').textContent = 'Open game';
    joinLobby(entry.gameID);
    fromQuickJoin = true;
    UI.showJoinLobbyMap();
    UI.showOpenLobby(entry);
  }

  // Starts as soon as the menu does — the hero card has nothing to show
  // until the first poll resolves.
  startLobbyListPolling();

  // Host only. The server re-checks authorship; this `if` is belt-and-braces.
  function startHostedGame() {
    if (!iAmHost) return;
    Transport.sendStartGame(UI.getHostConfig());
  }

  document.getElementById('hostCreateBtn').addEventListener('click', hostLobby);
  document.getElementById('hostStartBtn').addEventListener('click', startHostedGame);
  // Wrapped: passed directly, the click event would arrive as gameIDOverride
  // and be sent to the server as the join code.
  document.getElementById('joinBtn').addEventListener('click', () => joinLobby());
  document.getElementById('hostLeaveBtn').addEventListener('click', leaveLobby);
  document.getElementById('joinLeaveBtn').addEventListener('click', leaveLobby);

  // Invite links (UI.copyLobbyCode) look like https://borderwar.io/?join=CODE.
  // Opening one lands straight in that lobby. The param is stripped afterwards
  // so a refresh or a copied address bar doesn't re-join a dead lobby.
  const inviteMatch = /[?&]join=([A-Za-z0-9_-]{1,32})/.exec(location.search);
  if (inviteMatch) {
    history.replaceState(null, '', location.pathname);
    document.querySelector('.modeTab[data-mode="friends"]').click();
    joinLobby(inviteMatch[1].toUpperCase());
  }

  // The link is up. Nothing has arrived on it yet — `start` is the next thing
  // to be delivered — so this is where the things that must be empty *before*
  // the first turn lands get emptied. LocalServer.start announces the
  // connection before it emits anything, precisely so this can happen first.
  function onConnect() {
    Runner.reset();
    Executor.reset();
    // Transport.connect has just pointed Runner.onHash at itself. Replay sits
    // in front: it keeps hashes while recording and checks them while playing.
    const sendHash = Runner.onHash;
    Runner.onHash = (turnNumber, hash) => {
      Replay.onHash(turnNumber, hash);
      sendHash(turnNumber, hash);
    };
  }

  // --- Replays (js/replay.js, docs/replays.md) --------------------------------
  //
  // A replay is one more path through the same connect/onConnect/
  // onServerMessage pipeline: a local connection whose LocalServer feeds
  // recorded turns. Replay calls back here because this file owns connections.
  Replay.host = {
    connect(feed) {
      inLobby = false;
      myRole = 'sp';
      stopLobbyListPolling();
      Transport.disconnect();
      Runner.reset();
      Transport.connect(onConnect, onServerMessage, { local: true, replay: feed });
    },
    exit() {
      Transport.disconnect();
      Runner.reset();
      Replay.stop();
      backToMenu();
    }
  };

  // --- Tutorial (js/tutorial.js, docs/tutorial.md) ----------------------------
  //
  // A singleplayer match with a fixed configuration, started the way start()
  // starts one. Tutorial calls back here because this file owns connections.
  Tutorial.host = {
    start(config) {
      inLobby = false;
      myRole = 'sp';
      stopLobbyListPolling();
      Replay.finish();
      Transport.disconnect();
      Runner.reset();
      Transport.connect(onConnect, onServerMessage, Object.assign({
        local: true,
        gameID: 'local',
        username: UI.getPlayerName() || 'You'
      }, config));
    },
    exit() {
      Transport.disconnect();
      Runner.reset();
      backToMenu();
    }
  };

  // Everything a server says to us (§4's server->client table). Two messages
  // matter in Phase 1; `lobby_info` and `error` are MP-2.3's additions, live
  // only on a real (non-local) connection — LocalServer never emits either.
  function onServerMessage(msg) {
    if (!msg) return;

    if (msg.type === 'lobby_info') {
      // Compare `lobby.creatorClientId` against this message's own
      // `msg.myClientID`, not a separately-read Transport.myClientID.
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
      // Mid-match the lobby error is hidden, so say it where it can't be missed.
      if ((msg.error === 'version-mismatch' || msg.error === 'server-restarting') && !inLobby) alert(msg.message);
      return;
    }

    if (msg.type === 'start') {
      // A reconnected socket's first `start` (tagged `__rejoin` by
      // Transport._wireSocket) is a catch-up backlog, not a fresh match. Local
      // Game/Runner/Executor state is still where it was when the socket died,
      // so only queue the turns; do NOT run the fresh-match setup below.
      if (msg.__rejoin) {
        if (Array.isArray(msg.turns)) for (const t of msg.turns) Runner.addTurn(t);
        return;
      }

      inLobby = false; // the match is starting; the lobby screen is done

      // The match's configuration comes from gameStartInfo, never the DOM
      // controls. In singleplayer LocalServer echoes what start() handed it.
      const info = msg.gameStartInfo || {};

      // clientID -> playerId. One entry today; MP-3.1 is where it stops being
      // one. Installed before any intent can be applied, because an intent
      // whose author cannot be resolved is dropped (executor.js).
      Executor.setRoster(info.players);

      // Which roster entry is us, by `msg.myClientID` (as in `lobby_info`
      // above). Falls back to player 0 if not found.
      const rosterEntries = Array.isArray(info.players) ? info.players : [];
      const myEntry = rosterEntries.find(function(p) { return p && p.clientID === msg.myClientID; });
      const myPlayerId = myEntry ? myEntry.playerId : 0;

      const beginMatch = function() {
        Game.init(info, myPlayerId);
        Render.onMapReady();
        Render.centerOnMap();
        UI.reset();
        UI.enterSpawnSelect();

        Tutorial.matchReady();

        // A fresh match is recorded; a replay being played is not. Nor is a
        // tutorial: its free gold is not in the turns (js/tutorial.js).
        if (Replay.active) Replay.onMatchReady();
        else if (!Tutorial.active) Replay.begin(info, msg.myClientID, myPlayerId);
        Progress.beginMatch({ info: info, myPlayerId: myPlayerId, singleplayer: Transport.isLocal });

        // The catch-up backlog. Empty at a fresh start; non-empty after a
        // rejoin (§4), and the drain loop below is what works through it.
        if (Array.isArray(msg.turns)) for (const t of msg.turns) Runner.addTurn(t);

        lastTurnAt = performance.now();
        const cfg = info.config || {};
        presenceMatch = {
          map: cfg.map === 'world' ? 'world' : cfg.mapSize, mode: cfg.gameMode,
          bots: cfg.bots, tribes: cfg.tribes, tutorial: Tutorial.active, at: lastTurnAt
        };
        document.getElementById('overlay').classList.add('hidden');
        document.getElementById('endOverlay').classList.add('hidden');
        sendPresence();
      };

      // World is normally preloaded already; this await is a safety net. A
      // failed fetch must not leave the player on a menu that looks dead.
      if (info.config && info.config.map === 'world') {
        WorldMapLoader.ensure().then(beginMatch).catch(function(err) {
          console.error('Failed to load the World map', err);
          UI.setLobbyError('Failed to load the World map: ' + err.message);
          document.getElementById('overlay').classList.add('hidden');
        });
      } else {
        beginMatch();
      }
      return;
    }

    if (msg.type === 'turn') {
      Runner.addTurn(msg.turn);
      return;
    }

    if (msg.type === 'desync') {
      // The server's hash tally flagged this client. Diagnostic only: surface
      // it, don't disconnect or touch the sim.
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
    const bots = Math.max(2, Math.min(BOT_CAP, parseInt(botInput.value, 10) || 9));
    const tribes = Math.max(0, Math.min(TRIBE_CAP, parseInt(tribeInput.value, 10) || 0));
    const mapSize = sizeSelect.value;
    const mode = UI.getModeConfig('');
    const procedural = mapTypeSelect.value !== 'world';
    const gen = UI.getMapGenConfig('');

    // A new match is a new connection. Tearing the old one down first stops a
    // previous match's LocalServer pump from outliving it and emitting turns
    // into a game that has been re-initialised underneath it.
    inLobby = false;
    myRole = 'sp';
    stopLobbyListPolling();
    Replay.finish();
    Transport.disconnect();
    Runner.reset();

    // LocalServer synthesizes gameStartInfo from these settings.
    // `local: true` is the only line that knows which kind of server this is (§2).
    Transport.connect(onConnect, onServerMessage, {
      local: true,
      gameID: 'local',
      username: UI.getPlayerName() || 'You',
      // Procedural maps use the seed the options preview was drawn from.
      seed: procedural ? gen.seed : (Math.random() * 1e9) | 0,
      map: procedural ? 'procedural' : 'world',
      mapSize: mapSize,
      mapGen: gen.mapGen,
      bots: bots,
      tribes: tribes,
      difficulty: difficultySelect.value,
      gameMode: mode.gameMode,
      playerTeams: mode.playerTeams,
      fogOfWar: mode.fogOfWar
    });
  }

  // §5's loop. The sim advances because a turn arrived, never because time
  // passed: Runner.executeNextTurn applies one turn and takes exactly one
  // Game.tick, and Transport.turnComplete is the backpressure signal that
  // lets the server emit the next.
  let lastPanFrameAt = 0;
  // Battery saver (see loop). 30 ms sits between one and two 60 Hz frames, so
  // the cap lands on 30 fps whatever the display's refresh rate.
  const SAVER_FRAME_MS = 30, CAM_SETTLE_MS = 250;
  let lastDrawAt = 0, lastCamMoveAt = 0, lastCamX = 0, lastCamY = 0, lastCamScale = 0, lastPlaceHover = -1;

  function loop(now) {
    requestAnimationFrame(loop);
    // Perf.bench drives turns and frames itself (js/perf.js).
    if (!Render.tileCanvas || Perf.benching) return;

    // Clamped so a tab-switch's huge gap doesn't fling the camera on return.
    const panDt = lastPanFrameAt ? Math.min(0.1, (now - lastPanFrameAt) / 1000) : 0;
    lastPanFrameAt = now;
    Input.updateKeyPan(panDt);

    // A seeking replay refills the queue itself between turns rather than
    // waiting on LocalServer's 5 ms pump, up to the turn it is heading for.
    const seeking = Replay.seeking();
    const budgetEnd = performance.now() + (seeking ? SEEK_BUDGET_MS : SIM_BUDGET_MS);
    while (performance.now() < budgetEnd) {
      if (Runner.pendingTurns() === 0) {
        if (!seeking || Runner.currTurn >= Replay.seekTarget) break;
        LocalServer.pumpNow();
        if (Runner.pendingTurns() === 0) break;
      }
      const turnStart = performance.now();
      Runner.executeNextTurn();
      Transport.turnComplete();
      lastTurnAt = performance.now();
      Perf.simTurn(lastTurnAt - turnStart);
      // Per turn, not per frame: a backlog runs many ticks in one frame and
      // achievement tracking must see each one (js/progress.js).
      Progress.sample();
    }
    Replay.frame();

    // Catch-up banner: a readout of what the drain loop left pending. Only
    // visible during a rejoin-sized backlog. A replay shows its own seek bar.
    UI.updateCatchup(Replay.active ? 0 : Runner.pendingTurns());

    // Battery saver: the sim moves 10 times a second, so drawing at the full
    // display rate mostly repaints the same picture. Draw every other frame
    // instead, except while something is following the player's hand, where
    // the lost frames show: the camera moving, a finger or button down on the
    // map, a build dragged off the bar, or the placement ghost being aimed.
    if (Options.get('saveBattery')) {
      const cam = Render.cam;
      if (UI.barDrag || Input.pointers.size || UI.placeHover !== lastPlaceHover ||
          cam.x !== lastCamX || cam.y !== lastCamY || cam.scale !== lastCamScale) {
        lastCamX = cam.x; lastCamY = cam.y; lastCamScale = cam.scale;
        lastPlaceHover = UI.placeHover;
        lastCamMoveAt = now;
      }
      if (now - lastCamMoveAt > CAM_SETTLE_MS && now - lastDrawAt < SAVER_FRAME_MS) return;
    }
    lastDrawAt = now;

    // Smooth clock for animation only. Wall-clock time since the last executed
    // turn, CLAMPED TO ONE TICK: the sim's authoritative state is whatever the
    // last turn produced, and an animation that ran past it would be
    // extrapolating a future the server has not sent yet. Under jitter — or
    // whenever a turn is a few ms late — this sits still for a frame instead,
    // which is correct and is the trade §5 asks for.
    const since = (performance.now() - lastTurnAt) / 1000;
    Game.renderElapsed = Game.elapsed + Math.max(0, Math.min(Game.TICK_DT, since));

    const drawStart = performance.now();
    Render.draw();
    const drawEnd = performance.now();
    UI.update();
    Tutorial.frame();
    UI.updateReplayBar();
    Perf.drawn(now, drawEnd - drawStart, performance.now() - drawEnd);
    Options.perfFrame(now);
    // Every frame: checkEndGame must notice this client's own defeat at once,
    // often long before Game.winnerId is set. Its latches make each half one-shot.
    UI.checkEndGame();
  }

  document.getElementById('startBtn').addEventListener('click', start);
  document.getElementById('endMenuBtn').addEventListener('click', backToMenu);
  document.getElementById('endTutorialBtn').addEventListener('click', () => {
    document.getElementById('endOverlay').classList.add('hidden');
    Tutorial.start();
  });
  // Straight into the next open lobby; the menu's list is stale after a match,
  // so ask the server afresh.
  document.getElementById('restartBtn').addEventListener('click', () => {
    backToMenu();
    Transport.fetchLobbyList()
      .catch(() => [])
      .then((list) => { lastLobbyList = list; quickJoin(list.find((e) => e.isAuto)); });
  });

  // Leaves the match for the main menu. Exit lives in the in-game menu
  // (js/ui.js), which asks for a second click while a match is still undecided.
  function leaveMatch() {
    document.getElementById('gameMenu').classList.add('hidden');
    Tutorial.stop();
    Transport.disconnect();
    Runner.reset();
    backToMenu();
  }

  const gmExit = document.getElementById('gmExit');
  gmExit.addEventListener('disarm', () => {
    gmExit.classList.remove('armed');
    gmExit.textContent = 'Exit match';
  });
  gmExit.addEventListener('click', () => {
    if (Game.winnerId === null && !gmExit.classList.contains('armed')) {
      gmExit.classList.add('armed');
      gmExit.textContent = 'Exit match?';
      return;
    }
    leaveMatch();
  });

  // From a finished match, or out of a replay, to the main menu.
  function backToMenu() {
    Replay.finish();
    document.getElementById('endOverlay').classList.add('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    // The lobby that fed the finished match is gone; don't show its stale code.
    inLobby = false;
    myRole = 'sp';
    fromQuickJoin = false;
    UI.hideLobby();
    // Land on the home screen, not the setup screen the match was started
    // from. Leaving a replay stays on the Replays list it was picked from.
    if (document.getElementById('overlay').dataset.mode !== 'replay') {
      document.getElementById('modeBack').click();
    }
    startLobbyListPolling();
    // The finished match's player still exists until Game.init() runs again,
    // which would otherwise leave the debug panel floating over this menu.
    document.getElementById('debugPanel').classList.add('hidden');
    document.getElementById('debugToggle').classList.add('hidden');
    // The Replays tab may be the one showing, and the list has just changed.
    UI.refreshReplayList();
  }

  // --- Singleplayer presence (server/presence.js) ------------------------------
  //
  // A singleplayer match never opens a socket, so the server can't see it.
  // While one is on screen, say so every 30 s; the admin page counts the pages
  // it has heard from lately, with the match's settings. The id is random, made
  // per page load and stored nowhere; no account name is sent. Tutorials count;
  // replays, the menu and hidden tabs don't.
  const PRESENCE_MS = 30000;
  const presenceID = Array.from(crypto.getRandomValues(new Uint8Array(8)),
    (b) => b.toString(16).padStart(2, '0')).join('');
  let presenceOff = false;
  let presenceMatch = null; // what the admin page lists for this match
  function sendPresence() {
    if (presenceOff || document.hidden) return;
    if (!Transport.connected || !Transport.isLocal || Replay.active) return;
    if (!document.getElementById('overlay').classList.contains('hidden')) return;
    const m = presenceMatch || {};
    const body = JSON.stringify({
      id: presenceID, map: m.map, mode: m.mode, bots: m.bots, tribes: m.tribes,
      tutorial: !!m.tutorial, age: m.at ? Math.round((performance.now() - m.at) / 1000) : 0
    });
    fetch('presence', { method: 'POST', body: body, credentials: 'omit', cache: 'no-store' })
      .then((r) => {
        // Not there at all (the static dev server): stop asking. Anything else
        // is a server that will be back.
        if (r.status === 404 || r.status === 405 || r.status === 501) presenceOff = true;
      })
      .catch(() => { /* offline, or the server is restarting */ });
  }
  setInterval(sendPresence, PRESENCE_MS);
  document.addEventListener('visibilitychange', sendPresence);

  requestAnimationFrame(loop);
})();
