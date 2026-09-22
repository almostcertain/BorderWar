// The client's one link to a server, real or local
// (Task MP-1.4, docs/multiplayer-architecture.md §2, §5, §6, §6.1, §9 Phase 1).
//
// Ported from OpenFront's `src/client/Transport.ts`.
//
// WHY THIS FILE EXISTS. §2, the single most important structural move: OpenFront
// runs singleplayer through the multiplayer code path, and this is the object
// that makes that true. It carries an `isLocal` flag; when set it routes to
// net/localserver.js, and when clear it routes to a WebSocket. Both sides speak
// the identical message set (§4) through the identical four calls below, so
// every consumer above this line — ui.js, radial.js, main.js — is written once
// and never learns which one it is attached to. There is no "singleplayer mode"
// branch anywhere above this file, and that is the point: a parallel direct-
// mutation path is the failure mode this whole design exists to avoid.
//
// THE FOUR CALLS. Everything the client does to a server is one of these:
//
//   sendIntent(intent)          I want to do a thing. It happens ~1 RTT later,
//                               on the same tick, on every client.
//   sendHash(turnNumber, hash)  here is my digest of the world (§4 `hash`).
//   turnComplete()              I have finished executing a turn. Backpressure —
//                               see LocalServer.turnComplete, which is where the
//                               whole mechanism is explained.
//   connect(onconnect, onmessage)  attach.
//
// Everything a server does to the client arrives as one message on `onmessage`.
//
// THE WEBSOCKET PATH — implemented in MP-2.3, against the real server MP-2.1/
// MP-2.2 built. See connectRemote at the bottom for the implementation and
// getPersistentID just below for the one piece of client identity this file
// adds. §6 and §6.1 specified what had to go there, in advance, including —
// from §6.1 — that the socket URL must be *derived from `location`* and never
// hardcode `ws://`, because a page served over HTTPS through a tunnel cannot
// open an insecure socket, and that failure appears only in the tunnelled
// configuration, i.e. never during local testing. That derivation is exactly
// as written down; see connectRemote.
//
// MP-1.5 already rewired ui.js/radial.js to send intents and main.js to drain
// Runner and call turnComplete, all through this file's `isLocal` branch. This
// task adds the other branch; every consumer above Transport is unchanged.

// Per-browser identity (architecture doc §6): "a UUID generated once per
// browser and kept in localStorage (private, never broadcast)". Used only for
// a future rejoin (MP-4.1) to let the server recognize "this is the same
// browser that was just playing" — it plays no role in authentication (D2: no
// accounts) and is never displayed or transmitted anywhere except inside the
// `join`/`rejoin` messages themselves.
//
// A plain module-scope function, not a Transport method: it has nothing to do
// with any connection's state, it is needed once per page (not per connect()
// call), and keeping it here rather than as a "new tiny file" (an option the
// task explicitly allowed) avoids one more entry in index.html's load list for
// something this small.
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

  // Our own clientID once the server has told us (`start`/`lobby_info` carry
  // `myClientID`, §4). Purely informational on this side: the client never
  // stamps its own intents — the server does, and authorship is the one thing
  // a relay is authoritative about (§1).
  myClientID: null,

  // The socket, once there is one. Named now so the seam is visible.
  ws: null,

  // Messages sent while `ws` exists but is not yet OPEN (the gap between
  // `new WebSocket(url)` and its `open` event). Flushed in arrival order the
  // moment the socket opens, right after `join` goes out — see connectRemote.
  _sendBuffer: [],

  // The 5 s keepalive ping's interval handle, remote mode only. Started once
  // the socket opens, cleared on disconnect and on the socket's own close —
  // both paths matter, since a server-initiated close must not leave this
  // ticking against a dead socket.
  _pingIntervalID: null,

  // --- Automatic reconnect (MP-4.1) -------------------------------------------
  //
  // {gameID, username, spectator} from the most recent connectRemote() call —
  // what a reconnect needs to re-open an equivalent connection without the
  // caller (main.js) having to be involved at all. Set at the top of
  // connectRemote, cleared by disconnect() (an intentional disconnect has
  // nothing left to automatically rejoin) and never touched by _reconnect
  // itself. null means "never connected remotely" / "not reconnectable",
  // which _scheduleReconnect and _reconnect both treat as a no-op guard.
  _lastRemoteOpts: null,

  // deliver() from connect() (see connect()'s own comment on why it exists:
  // capturing Transport.myClientID ahead of dispatch). Stashed here so
  // _reconnect can hand a rejoined socket's messages to the exact same
  // wrapper a fresh join uses, without connect() having to know reconnect
  // exists. Set once per connect() call; outlives any number of reconnects
  // on that connection, same lifetime as onHash's wiring.
  _deliver: null,

  // Reconnect attempts since the last time a reconnect actually proved
  // itself (see _wireSocket's isRejoin branch — reset happens the moment a
  // rejoin's own `start` backlog arrives, not merely when a socket opens,
  // because a socket can open against a server that immediately rejects the
  // rejoin). Reset to 0 by every fresh connectRemote() too, since a brand
  // new join is not "recovering" anything.
  _reconnectAttempts: 0,

  // A dead server, or — far more likely for a self-hosted box — a game that
  // is simply gone (process restarted, gameID reaped) must not be retried
  // forever. Five tries is enough to ride out a several-second network blip
  // or tunnel hiccup without spinning on a socket that will never accept a
  // rejoin again.
  MAX_RECONNECT_ATTEMPTS: 5,

  // setTimeout handle for a pending reconnect, so disconnect() can cancel one
  // that has not fired yet (the player bails out to the menu mid-backoff).
  _reconnectTimerID: null,

  // Optional listener for link state, so the lobby screen can say "connecting"
  // or "couldn't reach the server" instead of sitting silently empty. Called
  // with 'open' when a socket opens and 'lost' when one dies without a clean
  // close (which includes a server that was never reachable). A deliberate
  // disconnect() emits nothing. Purely informational — main.js decides what
  // to do about it.
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
  //                      `local` defaults to true. In local mode the rest are
  //                      the lobby settings a real server would have decided,
  //                      which LocalServer synthesizes into gameStartInfo
  //                      instead. In remote mode only gameID/username/
  //                      spectator matter — they are what `join` carries
  //                      (§4); mapSize/bots/tribes have no meaning until the
  //                      host sends `start_game` (MP-2.3), because v1 has no
  //                      lobby-settings sync to non-host clients.
  //
  // WIRING THE HASH SEAM. Runner emits a hash every HASH_INTERVAL turns through
  // a plain callback rather than reaching for a Transport global itself (see
  // runner.js's onHash note — the seam was left null in MP-1.3 precisely so
  // this file could fill it). It is pointed here, once, at connect time, and
  // deliberately not cleared by Runner.reset: it is connection wiring, and it
  // outlives any single match on that connection.
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

    // MP-4.1: an intentional disconnect has nothing left to automatically
    // reconnect to. Cleared unconditionally (cheap even in local mode) so a
    // reconnect timer left over from a previous remote connection can never
    // fire into whatever this connection becomes next — main.js's hostLobby/
    // joinLobby/start all call disconnect() before establishing a new one,
    // and without this a stale timer could fire _reconnect() against the
    // *new* connection's unrelated gameID.
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
        // Deliberately no listeners removed here: the socket is being
        // discarded (this.ws = null right after), and a message that manages
        // to fire on the old object between close() and garbage collection
        // finds `this.ws` already pointing elsewhere or reads `connected ===
        // false` inside onmessage/onclose and does nothing harmful either way.
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

  // The socket half of send(), and the buffered-while-connecting queue a real
  // socket needs and LocalServer does not. `connected` (checked by send()
  // above) is set true as soon as connectRemote is called — before the
  // handshake even completes — precisely so that anything sent in the gap
  // between "the app asked to connect" and "the socket is actually OPEN" (an
  // intent fired the instant a click lands) is queued here rather than
  // dropped by send()'s early return. Returns true either way: "accepted",
  // matching LocalServer.onMessage's contract, whether it went out now or is
  // waiting to.
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

  // Ask for something to happen. This is the ONLY way a player action reaches
  // the simulation, and the latency is not a bug: the intent is buffered by the
  // server, comes back inside a turn, and is applied by Runner->Executor on the
  // same tick on every client. §5's "visible ~100 ms input latency (correct —
  // this is lockstep)".
  //
  // Note what is absent: no clientID. The client never stamps its own — the
  // server does (GameServer.handleIntent), so a client cannot act as anyone but
  // itself no matter what it puts on the wire.
  sendIntent(intent) {
    return this.send(Protocol.msg.intent(intent));
  },

  // Report our digest of the world. Runner calls this via its onHash seam every
  // HASH_INTERVAL turns; the server compares clients and shouts when two of
  // them stop agreeing (§4 `desync`, MP-4.2). With LocalServer there is one
  // client and nothing to compare against, so the report is recorded and no
  // more — but the path is live, which is what makes it work on the day there
  // is a second client rather than the day someone remembers to test it.
  sendHash(turnNumber, hash) {
    return this.send(Protocol.msg.hash(turnNumber, hash));
  },

  // "I have finished executing a turn." Called by main.js's drain loop (MP-1.5)
  // immediately after each Runner.executeNextTurn.
  //
  // This is backpressure, and it is load-bearing: LocalServer will not emit the
  // next turn until it arrives, which is what stops singleplayer running ahead
  // of itself and is what makes the debug fast-forward client-paced instead of
  // a frozen tab. The full argument is on LocalServer.turnComplete.
  //
  // Deliberately NOT a message. It is a local flow-control signal with no wire
  // representation — the real server derives the same information from the turn
  // rate it is already sending, and there is no `turn_complete` in §4. Sending
  // one per turn per client would be pure overhead on a network.
  turnComplete() {
    if (!this.connected) return;
    if (this.isLocal) LocalServer.turnComplete();
  },

  // Vote that the game is over (§4 `winner`). The client decides — UI's end
  // check does — and the server records it.
  sendWinner(winner) {
    return this.send(Protocol.msg.winner(winner));
  },

  // Reconnect and ask for everything from `lastTurn` onward (§4 `rejoin`); the
  // server answers with a `start` carrying turns.slice(lastTurn). Meaningless
  // locally in the sense that nothing can drop the connection, but the path is
  // implemented on both sides.
  //
  // MP-4.1 wires the automatic case through _reconnect/_wireSocket below,
  // which build and send their own `rejoin` message directly rather than
  // routing through this method (they need the freshly-opened socket, which
  // this method's normal send() funnel does not have mid-handshake). This
  // stays callable on its own — e.g. from a console, for a connection that is
  // still up but wants to re-sync — but nothing in this file's automatic path
  // invokes it.
  sendRejoin(gameID, lastTurn, persistentID) {
    return this.send(Protocol.msg.rejoin(gameID, lastTurn, persistentID));
  },

  // Host only (MP-2.3): ask the server to leave LOBBY and begin the match
  // (§4/protocol.js `start_game`). `config` is `{mapSize, bots, tribes}` off
  // the host's own lobby controls. The server is the only authority here —
  // GameServer.handleStartGame checks the sender's clientID against the
  // game's recorded creatorClientId and the LOBBY stage — so calling this as
  // a non-host is harmless: it comes back as an `error` message, same as any
  // other request the server declines, never a started match.
  sendStartGame(config) {
    return this.send(Protocol.msg.startGame(config));
  },

  // --- The WebSocket seam ----------------------------------------------------
  //
  // Implemented (MP-2.3), against the real server MP-2.1/MP-2.2 built.
  //
  // What goes here, from §6 and §6.1:
  //
  //   - DERIVE THE URL FROM `location`. Never a hardcoded scheme:
  //
  //       const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://')
  //                    + location.host;
  //
  //     server/index.js serves the static game and the WS upgrade from the same
  //     origin, so this is always right. The hardcoded `ws://` form works in
  //     every local test and fails only once the game is served over HTTPS
  //     through a Cloudflare Tunnel (§6.1's recommended deployment), where a
  //     browser blocks an insecure socket opened from a secure page. That is
  //     the worst possible time to discover it, which is why it is written down
  //     here rather than left to be got right later.
  //   - `join` on open (§4), carrying gameID, username and the persistentID
  //     kept in localStorage; the server assigns and returns a clientID.
  //   - JSON.parse on message, Protocol.validateMessage(msg, 's2c') at the
  //     boundary, drop anything that fails (MP-4.3) — the same treatment
  //     LocalServer._emit gives its own output.
  //   - a send buffer for intents issued before the socket opens, a 5 s `ping`,
  //     and reconnect-with-rejoin (MP-4.1).
  //
  // `opts` here is `{ gameID, username, spectator }` — see the doc comment on
  // connect() above for why mapSize/bots/tribes are not part of this call in
  // remote mode.
  connectRemote(onconnect, onmessage, opts) {
    opts = opts || {};
    const gameID = opts.gameID;
    const username = opts.username;
    const spectator = !!opts.spectator;
    const persistentID = getPersistentID();

    // MP-4.1: remembered so an unexpected close can reconnect on its own —
    // see _scheduleReconnect/_reconnect below. `_deliver` is the exact
    // wrapper connect() built around `onmessage` (myClientID capture ahead of
    // dispatch, per connect()'s own comment); stashing it here lets a
    // reconnected socket's messages reach the same place a fresh join's do,
    // without _reconnect needing connect() to hand it anything. A fresh
    // connectRemote() call is never itself a "recovery", so the attempt
    // counter and any leftover timer from a previous connection are cleared.
    this._lastRemoteOpts = { gameID: gameID, username: username, spectator: spectator };
    this._deliver = onmessage;
    this._reconnectAttempts = 0;
    if (this._reconnectTimerID !== null) {
      clearTimeout(this._reconnectTimerID);
      this._reconnectTimerID = null;
    }

    // THE DERIVATION. See the block comment above — this is the one line it
    // exists to get right. Never `'ws://' + location.host` on its own: that
    // form is indistinguishable from this one on http://localhost during
    // every local test in this task's verification, and fails only the first
    // time the game is ever served over https:// through a tunnel (§6.1).
    const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    const url = wsBase + '/ws';

    this._sendBuffer = [];
    this.ws = new WebSocket(url);

    // Set true here, before the handshake completes, not in onopen below —
    // see _wsSend's comment on why: it is what makes the pre-open send
    // buffer reachable through the normal send() funnel instead of being
    // dropped by send()'s `if (!this.connected) return false`.
    this.connected = true;

    this._wireSocket(this.ws, {
      firstMessage: Protocol.msg.join(gameID, username, persistentID, spectator),
      isRejoin: false,
      // "the link is up" — mirrors LocalServer.start's onconnect timing
      // (called once the connection exists, before any server message is
      // delivered). The match has not started; the lobby has merely been
      // reached. Reconnects deliberately never pass this (see _reconnect).
      onOpenOnce: onconnect
    });
  },

  // Attach the open/message/close/error handlers a remote connection needs.
  // Shared by connectRemote (a fresh join) and _reconnect below (an automatic
  // rejoin) so the two paths — identical in everything except which message
  // opens the connection and what a `start` reply means once it arrives —
  // cannot drift apart. `ws` is the socket to wire (already assigned to
  // `this.ws` and already `connected = true` by the caller). `config`:
  //
  //   firstMessage  the join/rejoin message to send the instant the socket
  //                 opens, ahead of anything already queued in _sendBuffer —
  //                 the server requires join/rejoin as the literal first
  //                 message on a fresh connection (GameManager.
  //                 handleConnection's `ws.once('message', ...)`), so it
  //                 cannot be allowed to land behind an intent that raced it
  //                 into the buffer.
  //   isRejoin      true only for _reconnect's socket. Tags the *first*
  //                 `start` message this socket ever receives with
  //                 `__rejoin: true` before handing it to `_deliver` — a
  //                 client-local marker, never sent anywhere, that lets
  //                 main.js's onServerMessage tell a catch-up backlog apart
  //                 from a fresh match's `start` and skip Game.init/UI.reset:
  //                 the sim on this path already exists exactly as it was
  //                 when the socket died (nothing here touched Runner or
  //                 Game), and re-initializing it would throw that state
  //                 away instead of resuming it. Also where _reconnectAttempts
  //                 resets to 0 — proof the link is genuinely back, not just
  //                 that a socket opened (a rejoin the server itself rejects,
  //                 e.g. `nothing-to-rejoin`, never reaches this line).
  //   onOpenOnce    called once, right after the handshake send/flush/ping
  //                 setup. connectRemote passes its `onconnect` (main.js's
  //                 onConnect, which resets Runner/Executor for a fresh
  //                 match); _reconnect omits it entirely, because running
  //                 that reset on a rejoin is precisely the bug isRejoin's
  //                 catch-up path exists to avoid.
  _wireSocket(ws, config) {
    let sawStart = false; // only the FIRST `start` on this socket gets tagged

    ws.onopen = () => {
      this._wsSend(config.firstMessage);

      const buffered = this._sendBuffer;
      this._sendBuffer = [];
      for (let i = 0; i < buffered.length; i++) this._wsSend(buffered[i]);

      // The 5 s keepalive §6.1 asks for. Server-side, this is what keeps
      // GameServer's lastPing fresh (MP-3.4's disconnect timeout reads it).
      this._pingIntervalID = setInterval(() => {
        this.send(Protocol.msg.ping());
      }, 5000);

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

      if (this._deliver) this._deliver(msg);
    };

    ws.onclose = (event) => {
      // disconnect() nulls this.ws before its socket's close event fires. Without
      // this guard that late event would flip `connected` off (and stop the ping)
      // on whatever connection replaced it — e.g. leaving a lobby and hosting again.
      if (this.ws !== ws) return;
      this.connected = false;
      if (this._pingIntervalID !== null) {
        clearInterval(this._pingIntervalID);
        this._pingIntervalID = null;
      }

      // MP-4.1: a CLEAN close (code 1000) is a real end, not a drop — either
      // this client called disconnect() itself (which always closes with
      // 1000; see disconnect() above) or the server closed us on purpose
      // (e.g. a rejected rejoin uses 1008, so this branch does not cover
      // that — only an actual 1000 does). Neither wants a reconnect. Anything
      // else — a killed connection, a network blip, a tunnel hiccup, a
      // server process restart — is a drop, and is exactly what
      // _scheduleReconnect exists to recover from.
      if (event && event.code === 1000) return;

      this._emitStatus('lost');
      this._scheduleReconnect();
    };

    ws.onerror = () => {
      // No separate handling: a WebSocket's `error` event is always followed
      // by a `close` event per the WHATWG spec, and that is where teardown
      // (and, now, reconnect scheduling) happens. An `error` with nothing
      // done here is not a silent failure.
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
    // Exponential backoff, capped at 8s: 1s, 2s, 4s, 8s, 8s. Cheap insurance
    // against hammering a server that is actually down (or a game that is
    // actually gone) once a second for no reason — a real blip recovers well
    // inside the cap, and the cap keeps a genuinely dead target from being
    // retried faster than a person would manually anyway.
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 8000);
    this._reconnectTimerID = setTimeout(() => {
      this._reconnectTimerID = null;
      this._reconnect();
    }, delay);
  },

  // Open a brand new socket against the same gameID this connection was last
  // joined to, and rejoin instead of joining: `Protocol.msg.rejoin(gameID,
  // Runner.currTurn, persistentID)`. `Runner.currTurn` (not turns.length, not
  // a separately-tracked counter) is exactly right here — it is both "how far
  // through the queue we have executed" and, by construction (Runner's own
  // continuity policy, see runner.js), the turnNumber of the next turn we
  // have not yet seen. The server answers with `start` carrying
  // turns.slice(lastTurn) — precisely the backlog this client is missing —
  // which _wireSocket tags __rejoin so main.js's onServerMessage queues it
  // into Runner instead of re-initializing the match.
  //
  // Deliberately does NOT call connect() or connectRemote(): both exist to
  // start a *fresh* match (connect()'s onConnect resets Runner/Executor,
  // exactly the state a rejoin must preserve), and both would overwrite
  // _lastRemoteOpts/_deliver with nothing new to offer. A reconnect reuses
  // what connectRemote already captured.
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
      firstMessage: Protocol.msg.rejoin(opts.gameID, Runner.currTurn, persistentID),
      isRejoin: true
      // no onOpenOnce — see _wireSocket's doc on why a reconnect must not
      // fire main.js's onConnect.
    });
  },

  // Exposed read-only, mainly so verification/debugging (and any future UI
  // that wants to display "your device id") can call
  // `Transport.getPersistentID()` without reaching for a module-private
  // function by name. connectRemote above calls the closed-over version
  // directly; this is purely a convenience alias onto the same function.
  getPersistentID
};

// Dual export, same guarded shape as the rest of net/ — see net/protocol.js's
// footer. server/ has no use for a client transport, but the footer is uniform
// across the directory so a file's position in it is never a question.
if (typeof module !== 'undefined' && module.exports) module.exports = Transport;
