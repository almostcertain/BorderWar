// The client's one link to a server, real or local
// (docs/multiplayer-architecture.md §2, §5, §6, §6.1).
//
// Singleplayer runs through the multiplayer code path. `isLocal` routes to
// net/localserver.js; otherwise to a WebSocket. Both speak the same message
// set (§4), so nothing above this file knows which it is attached to.
//
//   sendIntent(intent)          I want to do a thing. It happens ~1 RTT later,
//                               on the same tick, on every client.
//   sendHash(turnNumber, hash)  here is my digest of the world (§4 `hash`).
//   turnComplete()              I have finished executing a turn. Backpressure:
//                               see LocalServer.turnComplete.
//   connect(onconnect, onmessage)  attach.
//
// Everything a server does to the client arrives as one message on `onmessage`.

// Per-browser identity (§6): a UUID generated once and kept in
// localStorage. Sent only inside `join`/`rejoin`; not authentication (D2).
function getPersistentID() {
  const STORAGE_KEY = 'borderwar_persistentID';
  const fallback = () => 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (typeof id === 'string' && id.length > 0) return id;
    id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : fallback();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch (e) {
    // Private browsing / storage disabled / disallowed origin: fall back to a
    // per-page-load id. The only thing lost is MP-4.1's "same browser"
    // recognition across a reload — nothing today depends on persistence.
    return fallback();
  }
}

// The build this page was loaded from (index.html reads it from /buildinfo.json
// at page load, so a tab left open across a server update keeps its old id).
// Undefined if that fetch hasn't landed, which the server treats as a mismatch.
function getBuildID() {
  return (typeof window !== 'undefined' && typeof window.BUILD_ID === 'string' && window.BUILD_ID) || undefined;
}

const Transport = {

  // Route selector. True routes every call to LocalServer, in this page; false
  // routes to a WebSocket (MP-2.2). Set by connect() from its options, and the
  // default is local because that is the only route that exists today.
  isLocal: true,

  // Attached between connect() and disconnect().
  connected: false,

  // The client's inbound handler, installed by connect(). Held so that both
  // routes have exactly one place to deliver to, and so a message arriving
  // after disconnect can be dropped rather than reaching a torn-down client.
  onmessage: null,

  // Our own clientID once the server has told us (`start`/`lobby_info`).
  // Informational: the server stamps intents, never the client.
  myClientID: null,

  // The socket, once there is one. Named now so the seam is visible.
  ws: null,

  // Messages sent while `ws` exists but is not yet OPEN (the gap between
  // `new WebSocket(url)` and its `open` event). Flushed in arrival order the
  // moment the socket opens, right after `join` goes out — see connectRemote.
  _sendBuffer: [],

  // The 5 s keepalive ping's interval handle, remote mode only. Cleared on
  // disconnect and on the socket's own close.
  _pingIntervalID: null,

  // Client-only latency readout: when the last keepalive went out and the
  // round trip the server's echo measured (null until the first echo).
  _pingSentAt: null,
  rtt: null,

  _sendPing() {
    this._pingSentAt = performance.now();
    this.send(Protocol.msg.ping());
  },

  // --- Automatic reconnect ----------------------------------------------------
  //
  // {gameID, username, spectator} from the last connectRemote() call: what a
  // reconnect needs. Cleared by disconnect(); null means not reconnectable.
  _lastRemoteOpts: null,

  // deliver() from connect(), stashed so _reconnect can hand a rejoined
  // socket's messages to the same wrapper a fresh join uses.
  _deliver: null,

  // Reconnect attempts since a reconnect last proved itself: reset when a
  // rejoin's `start` backlog arrives (not merely when a socket opens), and
  // by every fresh connectRemote().
  _reconnectAttempts: 0,

  // A dead server or a reaped game must not be retried forever. Five tries
  // rides out a several-second blip.
  MAX_RECONNECT_ATTEMPTS: 5,

  // setTimeout handle for a pending reconnect, so disconnect() can cancel one
  // that has not fired yet (the player bails out to the menu mid-backoff).
  _reconnectTimerID: null,

  // Optional link-state listener: 'open' when a socket opens, 'lost' when
  // one dies without a clean close (including a server never reached). A
  // deliberate disconnect() emits nothing.
  onStatus: null,

  _emitStatus(status) {
    if (typeof this.onStatus !== 'function') return;
    try { this.onStatus(status); } catch (e) { console.error('Transport.onStatus threw', e); }
  },

  // --- Connecting ------------------------------------------------------------

  // Attach to a server and start a match.
  //
  //   onconnect()        called once the link is up, before any message.
  //   onmessage(msg)     every server->client message (§4's second table).
  //   opts               { local, gameID, seed, mapSize, bots, tribes, difficulty,
  //                        username, spectator }
  //                      `local` defaults to true. Locally the rest are lobby
  //                      settings LocalServer turns into gameStartInfo. Remotely
  //                      only gameID/username/spectator matter (`join`, §4).
  //
  // Also points Runner.onHash here. Runner.reset does not clear it: it is
  // connection wiring and outlives a match.
  connect(onconnect, onmessage, opts) {
    opts = opts || {};
    this.isLocal = opts.local !== false;
    this.onmessage = typeof onmessage === 'function' ? onmessage : null;
    this.myClientID = null;

    const deliver = (msg) => {
      // Learn our own id the moment the server states it, before handing the
      // message on — a client handler is entitled to read Transport.myClientID
      // while processing the very message that carried it.
      if (msg && typeof msg.myClientID === 'string') this.myClientID = msg.myClientID;
      if (this.onmessage) this.onmessage(msg);
    };

    Runner.onHash = (turnNumber, hash) => this.sendHash(turnNumber, hash);

    if (!this.isLocal) {
      this.connectRemote(onconnect, deliver, opts);
      return;
    }

    LocalServer.onconnect = () => {
      this.connected = true;
      if (typeof onconnect === 'function') onconnect();
    };
    LocalServer.onmessage = deliver;
    LocalServer.start(opts);
  },

  // Detach. Idempotent. Leaves Runner.onHash pointed here — a hash computed
  // after a disconnect is dropped by send() below rather than by unwiring the
  // seam, so that a reconnect does not have to remember to re-wire it.
  disconnect() {
    this.connected = false;

    // An intentional disconnect has nothing to reconnect to. Cleared
    // unconditionally so a stale timer can't fire _reconnect() against the
    // next connection's gameID.
    if (this._reconnectTimerID !== null) {
      clearTimeout(this._reconnectTimerID);
      this._reconnectTimerID = null;
    }
    this._lastRemoteOpts = null;
    this._reconnectAttempts = 0;

    if (this.isLocal) {
      LocalServer.stop();
    } else {
      if (this._pingIntervalID !== null) {
        clearInterval(this._pingIntervalID);
        this._pingIntervalID = null;
      }
      this._sendBuffer = [];
      if (this.ws) {
        // No listeners removed: the socket is discarded, and a late event finds
        // `this.ws` elsewhere or `connected === false` and does nothing.
        try { this.ws.close(1000, 'client disconnect'); } catch (e) { /* already closing */ }
        this.ws = null;
      }
    }
  },

  // --- Client -> server ------------------------------------------------------

  // The one outbound funnel. Both routes go through here so that "what does the
  // client send" has a single answer, and so the drop-when-detached rule is
  // stated once.
  send(msg) {
    if (!this.connected) return false;
    if (this.isLocal) return LocalServer.onMessage(msg) === true;
    return this._wsSend(msg);
  },

  // The socket half of send(), with the buffered-while-connecting queue.
  // `connected` is set true as soon as connectRemote is called, so anything
  // sent before the socket is OPEN is queued here rather than dropped.
  // Returns true either way ('accepted').
  _wsSend(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        return true;
      } catch (e) {
        return false;
      }
    }
    this._sendBuffer.push(msg);
    return true;
  },

  // Ask for something to happen. The ONLY way a player action reaches the
  // sim: the server buffers the intent, it comes back inside a turn, and
  // Runner->Executor applies it on the same tick everywhere (~100 ms input
  // latency, by design). No clientID here: the server stamps it.
  sendIntent(intent) {
    return this.send(Protocol.msg.intent(intent));
  },

  // Report our digest of the world. Runner calls this via onHash every
  // HASH_INTERVAL turns; the server compares clients (§4 `desync`).
  // LocalServer just records it.
  sendHash(turnNumber, hash) {
    return this.send(Protocol.msg.hash(turnNumber, hash));
  },

  // 'I have finished executing a turn.' Called by main.js's drain loop
  // after each Runner.executeNextTurn. Backpressure: LocalServer will not
  // emit the next turn until it arrives (see LocalServer.turnComplete).
  // Not a message; it has no wire representation.
  turnComplete() {
    if (!this.connected) return;
    if (this.isLocal) LocalServer.turnComplete();
  },

  // Vote that the game is over (§4 `winner`). The client decides — UI's end
  // check does — and the server records it.
  sendWinner(winner) {
    return this.send(Protocol.msg.winner(winner));
  },

  // Ask for everything from `lastTurn` onward (§4 `rejoin`); the server
  // answers with a `start` carrying turns.slice(lastTurn). The automatic
  // path (_reconnect/_wireSocket) sends its own `rejoin` and does not use
  // this; it stays callable by hand.
  sendRejoin(gameID, lastTurn, persistentID) {
    return this.send(Protocol.msg.rejoin(gameID, lastTurn, persistentID));
  },

  // Host only: ask the server to leave LOBBY and begin the match
  // (`start_game`). The server checks the sender is the creator; a
  // non-host call comes back as an `error` message.
  sendStartGame(config) {
    return this.send(Protocol.msg.startGame(config));
  },

  // Public lobby browser: a plain HTTP GET, since it runs before any
  // socket exists. Resolves to [] (never rejects) on any failure.
  fetchLobbyList() {
    const httpBase = (location.protocol === 'https:' ? 'https://' : 'http://') + location.host;
    return fetch(httpBase + '/lobbies')
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => (Array.isArray(list) ? list : []))
      .catch(() => []);
  },

  // --- The WebSocket seam ----------------------------------------------------
  //
  //   - DERIVE THE URL FROM `location`, never a hardcoded scheme: `ws://`
  //     works in every local test and fails only over HTTPS (the tunnelled
  //     deployment, §6.1), where a secure page can't open an insecure socket.
  //   - `join` on open (§4), carrying gameID, username and the persistentID;
  //     the server assigns and returns a clientID.
  //   - JSON.parse on message, Protocol.validateMessage(msg, 's2c') at the
  //     boundary, drop anything that fails.
  //   - a send buffer for intents issued before the socket opens, a 5 s
  //     `ping`, and reconnect-with-rejoin.
  //
  // `opts` is `{ gameID, username, spectator }`.
  connectRemote(onconnect, onmessage, opts) {
    opts = opts || {};
    const gameID = opts.gameID;
    const username = opts.username;
    const spectator = !!opts.spectator;
    const isPublic = !!opts.public;
    const persistentID = getPersistentID();

    // Remembered so an unexpected close can reconnect on its own (see
    // _scheduleReconnect/_reconnect). A fresh connectRemote() is never a
    // recovery, so the attempt counter and any leftover timer are cleared.
    this._lastRemoteOpts = { gameID: gameID, username: username, spectator: spectator };
    this._deliver = onmessage;
    this._reconnectAttempts = 0;
    if (this._reconnectTimerID !== null) {
      clearTimeout(this._reconnectTimerID);
      this._reconnectTimerID = null;
    }

    // Never a bare 'ws://': see the block comment above.
    const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const url = wsBase + '/ws';

    this._sendBuffer = [];
    this.ws = new WebSocket(url);

    // Set true before the handshake completes, so the pre-open send buffer
    // is reachable through send() (see _wsSend).
    this.connected = true;

    this._wireSocket(this.ws, {
      firstMessage: Protocol.msg.join(gameID, username, persistentID, spectator, isPublic, getBuildID()),
      isRejoin: false,
      // 'The link is up': the lobby has been reached, the match has not
      // started. Reconnects never pass this (see _reconnect).
      onOpenOnce: onconnect
    });
  },

  // Attach the open/message/close/error handlers. Shared by connectRemote
  // (a fresh join) and _reconnect (an automatic rejoin). `ws` is already
  // assigned to `this.ws`, with `connected = true`. `config`:
  //
  //   firstMessage  the join/rejoin message, sent the instant the socket
  //                 opens and ahead of anything in _sendBuffer: the server
  //                 requires it as the literal first message.
  //   isRejoin      true only for _reconnect's socket. Tags the first `start`
  //                 this socket receives with `__rejoin: true` (client-local,
  //                 never sent) so main.js queues the backlog instead of
  //                 re-initializing the match. Also where _reconnectAttempts
  //                 resets to 0.
  //   onOpenOnce    called once after the handshake setup. connectRemote
  //                 passes `onconnect`; _reconnect omits it, because that
  //                 reset would discard the state a rejoin must keep.
  _wireSocket(ws, config) {
    let sawStart = false; // only the FIRST `start` on this socket gets tagged

    ws.onopen = () => {
      this._wsSend(config.firstMessage);

      const buffered = this._sendBuffer;
      this._sendBuffer = [];
      for (let i = 0; i < buffered.length; i++) this._wsSend(buffered[i]);

      // The 5 s keepalive §6.1 asks for. Server-side, this is what keeps
      // GameServer's lastPing fresh (MP-3.4's disconnect timeout reads it).
      this._sendPing();
      this._pingIntervalID = setInterval(() => this._sendPing(), 5000);

      if (typeof config.onOpenOnce === 'function') config.onOpenOnce();
      this._emitStatus('open');
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return; // a discarded socket's late message
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return; // malformed JSON on the wire: dropped, never thrown (MP-4.3)
      }
      if (Protocol.validateMessage(msg, 's2c') !== null) {
        // Same treatment as LocalServer._emit gives its own output — logged,
        // not thrown, so one bad message cannot take the connection down.
        if (typeof console !== 'undefined' && console.error) {
          console.error('Transport dropped a malformed s2c message', msg);
        }
        return;
      }

      if (config.isRejoin && !sawStart && msg.type === 'start') {
        sawStart = true;
        msg.__rejoin = true; // see isRejoin's doc above
        this._reconnectAttempts = 0;
      }

      // The server echoes each keepalive; the gap is the round-trip time the
      // Options "Show FPS / ping" readout displays. Not a sim message.
      if (msg.type === 'ping') {
        if (this._pingSentAt !== null) this.rtt = Math.round(performance.now() - this._pingSentAt);
        return;
      }

      // This page is on an older build than the server. Retrying would be
      // refused the same way, so drop the reconnect target (the close that
      // follows then schedules nothing) and let the error reach the UI.
      // Likewise when the server says it is going down for a restart.
      if (msg.type === 'error' && (msg.error === 'version-mismatch' || msg.error === 'server-restarting')) this._lastRemoteOpts = null;

      if (this._deliver) this._deliver(msg);
    };

    ws.onclose = (event) => {
      // disconnect() nulls this.ws before its socket's close event fires. Without
      // this guard that late event would flip `connected` off (and stop the ping)
      // on whatever connection replaced it — e.g. leaving a lobby and hosting again.
      if (this.ws !== ws) return;
      this.connected = false;
      this.rtt = null;
      if (this._pingIntervalID !== null) {
        clearInterval(this._pingIntervalID);
        this._pingIntervalID = null;
      }

      // A CLEAN close (code 1000) is a real end: our own disconnect(), or
      // the server closing us on purpose. Anything else is a drop, which
      // _scheduleReconnect recovers from. (A rejected rejoin closes with 1008.)
      if (event && event.code === 1000) return;

      this._emitStatus('lost');
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // Nothing to do: `error` is always followed by `close`, where
      // teardown and reconnect scheduling happen.
    };
  },

  // Back off, then try again, up to MAX_RECONNECT_ATTEMPTS. Called only from
  // a socket's own onclose (via _wireSocket), so it always represents "the
  // link just dropped", never a fresh user-initiated connect.
  _scheduleReconnect() {
    // Nothing to rejoin: either this connection was always local, or
    // disconnect() already cleared the target (see disconnect()'s comment) —
    // either way there is no gameID to send a rejoin for.
    if (!this._lastRemoteOpts) return;

    if (this._reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('Transport: giving up reconnecting to "' + this._lastRemoteOpts.gameID
          + '" after ' + this._reconnectAttempts + ' attempts');
      }
      return;
    }

    this._reconnectAttempts++;
    // Exponential backoff capped at 8s: 1s, 2s, 4s, 8s, 8s.
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 8000);
    this._reconnectTimerID = setTimeout(() => {
      this._reconnectTimerID = null;
      this._reconnect();
    }, delay);
  },

  // Open a new socket to the same gameID and rejoin:
  // `Protocol.msg.rejoin(gameID, Runner.currTurn, persistentID)`.
  // Runner.currTurn is the turnNumber of the next turn we have not seen.
  // The server answers with `start` carrying the missing backlog, which
  // _wireSocket tags __rejoin.
  //
  // Does NOT call connect() or connectRemote(): both reset Runner/Executor,
  // exactly the state a rejoin must preserve.
  _reconnect() {
    if (!this._lastRemoteOpts) return; // disconnect() raced this timer — bail
    const opts = this._lastRemoteOpts;
    const persistentID = getPersistentID();

    const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const url = wsBase + '/ws';

    this._sendBuffer = [];
    this.ws = new WebSocket(url);
    this.connected = true;

    this._wireSocket(this.ws, {
      firstMessage: Protocol.msg.rejoin(opts.gameID, Runner.currTurn, persistentID, getBuildID()),
      isRejoin: true
      // no onOpenOnce — see _wireSocket's doc on why a reconnect must not
      // fire main.js's onConnect.
    });
  },

  // Read-only alias for debugging and any future UI.
  getPersistentID
};

// Dual export, same guarded shape as the rest of net/ — see net/protocol.js's
// footer. server/ has no use for a client transport, but the footer is uniform
// across the directory so a file's position in it is never a question.
if (typeof module !== 'undefined' && module.exports) module.exports = Transport;
