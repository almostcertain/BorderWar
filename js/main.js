(() => {
  const canvas = document.getElementById('game');
  Render.setup(canvas);
  Input.setup(canvas);
  Radial.setup();
  UI.setup();
  Tutorial.setup();

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

  // The same budget while a replay is seeking (js/replay.js). A jump is a
  // long run of turns the viewer is waiting on, so the sim gets most of the
  // frame and the picture drops to a few frames a second until it arrives.
  const SEEK_BUDGET_MS = 48;

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
  // so there's no real number to port here. The editable field's ceiling
  // (js/ui.js's getHostConfig, and start() below) is BOT_CAP/TRIBE_CAP, sized
  // so PLAYER_COLORS/BOT_NAMES (js/game/shared.js) has at least one entry per
  // bot plus up to 4 humans.
  const BOT_CAP = 100;
  const TRIBE_CAP = 400;

  // The real World map (js/game/core.js's Game.init, 2000x1000) seeds far
  // more Nations/Tribes than the old procedural large defaults, following
  // OpenFront's actual World map. Procedural large is the same 2000x1000
  // grid, so it shares these numbers rather than keeping a separate, sparser
  // default.
  const WORLD_BOTS = 82;
  const WORLD_TRIBES = 400;

  // Nations/Tribes per tile, taken from World/large (2000x1000) — the density
  // that feels right. Every other size's default is that same density applied
  // to its own tile count, so halving width and height (quartering the tile
  // count) quarters the counts too. Tribes stay roughly quadruple the Nation
  // count at every size, as before — OpenFront's low-effort filler
  // (openfront.wiki/Bots), weak and half-capped individually.
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

  // The "Map Size" row and the map options box only mean anything for the
  // procedural generator — the real World map has one fixed resolution
  // (js/game/core.js's Game.init). Hiding them rather than disabling them, so
  // a host who picked World can't be confused by controls that would silently
  // do nothing.
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

    Transport.connect(onConnect, onServerMessage, {
      local: false,
      gameID: code,
      username: info.username || 'Player'
    });
  }

  // Issue #9 (public lobby browser) + the main menu redesign's hero card
  // (#quickJoin — issue #12's open lobby is now the primary CTA, not tucked
  // inside the Join tab). Polling, not a pushed update, to match this
  // server's existing shape — GET /lobbies (server/index.js) is a stateless
  // snapshot, no per-connection subscription to maintain.
  //
  // Runs whenever the menu is on screen and no lobby connection is in
  // flight — no longer gated to the "join by code" tab being selected, since
  // the hero card must stay live regardless of which secondary tab is open.
  // Stopped by joinLobby/hostLobby/start (a connection is about to replace
  // whatever this was polling for) and resumed by leaveLobby/the restart
  // button (back on the menu with nothing connected).
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
    const entry = lastLobbyList.find((e) => e.isAuto);
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
  });

  // Starts as soon as the menu does — the hero card has nothing to show
  // until the first poll resolves.
  startLobbyListPolling();

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
      // Mid-match the lobby error is hidden, so say it where it can't be missed.
      if ((msg.error === 'version-mismatch' || msg.error === 'server-restarting') && !inLobby) alert(msg.message);
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

        // The catch-up backlog. Empty at a fresh start; non-empty after a
        // rejoin (§4), and the drain loop below is what works through it.
        if (Array.isArray(msg.turns)) for (const t of msg.turns) Runner.addTurn(t);

        lastTurnAt = performance.now();
        document.getElementById('overlay').classList.add('hidden');
        document.getElementById('endOverlay').classList.add('hidden');
        sendPresence();
      };

      // World is normally already preloaded well before this point (fetched
      // the moment it was selected, or eagerly at startup) — this await is a
      // safety net for a fast host/slow joiner, not the common path. A failed
      // fetch (bad path, offline, server not serving maps/) must not leave
      // the player stuck on a menu that looks like Start did nothing.
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

    // Everything below the lobby is settings a real server would have decided
    // and put in gameStartInfo; LocalServer synthesizes it from these instead.
    // `local: true` is the only line in the client that knows which kind of
    // server this is (§2) — MP-2.3's lobby is what will set it false.
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
  // passed: `Runner.executeNextTurn` applies one turn's intents and takes
  // exactly one Game.tick, and `Transport.turnComplete` is the backpressure
  // signal that lets the server emit the next one (see LocalServer.turnComplete
  // — it is what stops singleplayer running away from itself, and what makes
  // the debug burst client-paced).
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
    }
    Replay.frame();

    // MP-4.1: catch-up progress. Purely a readout of what the drain loop just
    // above already did — this owns no logic of its own, only whether a
    // "catching up" banner is visible and what it says. Not reconnect-
    // specific in how it's driven (it's just whatever pendingTurns() is left
    // after this frame's budget-limited pass), but a same-tick backlog is
    // always ≤1 turn in ordinary play, so in practice this only ever shows
    // during the kind of multi-hundred-turn backlog a rejoin produces.
    // A replay's own bar says where a seek has got to.
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
    // Called every frame, unconditionally: checkEndGame now also has to
    // notice this client's own defeat the instant it happens, which can be
    // long before Game.winnerId is decided (see its own comment in ui.js).
    // Its endGameHandled/lossShown latches make each half of that a one-shot.
    UI.checkEndGame();
  }

  document.getElementById('startBtn').addEventListener('click', start);
  document.getElementById('restartBtn').addEventListener('click', backToMenu);

  // The in-game Exit button. A match still being played takes two clicks, the
  // second within EXIT_ARM_MS; a decided one leaves on the first. Replays
  // have their own Exit on the replay bar, and this one is hidden there.
  const EXIT_ARM_MS = 3000;
  const exitBtn = document.getElementById('exitBtn');
  let exitArmTimer = 0;
  function disarmExit() {
    clearTimeout(exitArmTimer);
    exitBtn.classList.remove('armed');
    exitBtn.textContent = 'Exit';
  }
  exitBtn.addEventListener('click', () => {
    if (Game.winnerId === null && !exitBtn.classList.contains('armed')) {
      exitBtn.classList.add('armed');
      exitBtn.textContent = 'Exit match?';
      exitArmTimer = setTimeout(disarmExit, EXIT_ARM_MS);
      return;
    }
    disarmExit();
    Tutorial.stop();
    Transport.disconnect();
    Runner.reset();
    backToMenu();
  });

  // From a finished match, or out of a replay, to the main menu.
  function backToMenu() {
    Replay.finish();
    document.getElementById('endOverlay').classList.add('hidden');
    document.getElementById('overlay').classList.remove('hidden');
    // The lobby that fed the finished match is gone; don't show its stale code.
    inLobby = false;
    myRole = 'sp';
    UI.hideLobby();
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
  // it has heard from lately. The id is random, made per page load and stored
  // nowhere. Tutorials count; replays, the menu and hidden tabs don't.
  const PRESENCE_MS = 30000;
  const presenceID = Array.from(crypto.getRandomValues(new Uint8Array(8)),
    (b) => b.toString(16).padStart(2, '0')).join('');
  let presenceOff = false;
  function sendPresence() {
    if (presenceOff || document.hidden) return;
    if (!Transport.connected || !Transport.isLocal || Replay.active) return;
    if (!document.getElementById('overlay').classList.contains('hidden')) return;
    fetch('presence', { method: 'POST', body: presenceID, credentials: 'omit', cache: 'no-store' })
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
