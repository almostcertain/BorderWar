// js/watch.js — admin live watch (docs/admin-watch.md). Client-only.
//
// The admin page opens /?watch=<ticket>&game=<id>. The match is joined as an
// observer: the server sends the whole turn log, then each new turn, and this
// client replays them. It is not on the roster, sends no intents, and the other
// players are never told. "View as" and "Whole map" are view state only.

const Watch = {
  active: false,
  gameID: null,
  ticket: null,
  viewAs: 0,
  revealAll: true,
  status: '',
  // Set by main.js, which owns connections.
  host: null,

  MAX_RETRIES: 30,
  _retries: 0,
  _failed: false,
  _retryTimer: null,
  _savedMaxReconnects: null,

  start(gameID, ticket) {
    Replay.finish();
    this.stop();
    this.active = true;
    this.gameID = gameID;
    this.ticket = ticket;
    this.revealAll = true;
    this.viewAs = 0;
    this.status = 'Connecting…';
    this._retries = 0;
    this._failed = false;
    // Transport's own reconnect is a `rejoin` as a player; this reconnects as an observer.
    this._savedMaxReconnects = Transport.MAX_RECONNECT_ATTEMPTS;
    Transport.MAX_RECONNECT_ATTEMPTS = 0;
    document.body.classList.add('replaying', 'watching');
    this.host.connect(gameID, ticket);
  },

  stop() {
    if (this._retryTimer !== null) clearTimeout(this._retryTimer);
    this._retryTimer = null;
    if (this._savedMaxReconnects !== null) Transport.MAX_RECONNECT_ATTEMPTS = this._savedMaxReconnects;
    this._savedMaxReconnects = null;
    this.active = false;
    this.gameID = this.ticket = null;
    document.body.classList.remove('replaying', 'watching');
    document.getElementById('watchBar').classList.add('hidden');
  },

  // main.js's `start` handler, once the match is initialised.
  onMatchReady() {
    this._retries = 0;
    this.status = '';
    if (!Game.players[this.viewAs]) this.viewAs = 0;
    Game.me = this.viewAs;
  },

  // Follow another player. Game.me is never read by the sim.
  setView(playerId) {
    if (!this.active || !Game.players[playerId]) return;
    this.viewAs = playerId;
    Game.me = playerId;
    UI.reset();
    if (Game.spawning) UI.enterSpawnSelect();
  },

  // Transport.onStatus: a dropped socket starts the match over from the full log.
  onLinkLost() {
    if (!this.active || this._failed || this._retryTimer !== null) return;
    if (this._retries >= this.MAX_RETRIES) { this.status = 'Connection lost'; return; }
    this._retries++;
    this.status = 'Reconnecting…';
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this.active) this.host.connect(this.gameID, this.ticket);
    }, 2000);
  },

  // A server `error`: the ticket expired, or the match is over and reaped.
  onError(msg) {
    this.status = msg.message || msg.error || 'Server error';
    this._failed = true;
  }
};
