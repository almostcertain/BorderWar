// Match replays (docs/replays.md). Client-only: records nothing the sim reads
// and never writes sim state.
//
// Under lockstep a match is fully determined by its gameStartInfo and its turn
// stream (docs/multiplayer-architecture.md §1), and every client already holds
// both. So a replay is just those two things saved, and playing one back is
// LocalServer feeding the saved turns through the ordinary pipeline instead of
// bucketing live intents (LocalServer.replay). There is no second sim path.
//
// Three parts, top to bottom: recording the match in progress, the store
// (IndexedDB plus file export/import), and the playback controller the replay
// bar drives.
const Replay = {
  FORMAT: 'borderwar-replay',
  VERSION: 1,

  // How many matches the browser keeps. The oldest goes when a new one lands.
  MAX_STORED: 10,
  // Matches shorter than this (30 s) are not worth keeping.
  MIN_TURNS: 300,
  // The recording is re-saved this often while a match runs, so closing the
  // tab mid-match still leaves a replay behind.
  AUTOSAVE_MS: 30000,
  // One state hash kept per this many turns, to check playback against.
  HASH_EVERY: 100,
  // Import sanity ceiling: 10 M turns is eleven days of game time.
  MAX_TURNS: 1e7,

  DB_NAME: 'borderwar_replays',
  STORE: 'replays',

  // Set by main.js, which owns every connection:
  //   connect(feed)  tear down whatever is connected and start LocalServer on `feed`
  //   exit()         leave playback, back to the menu
  host: null,

  // --- Recording --------------------------------------------------------------

  // The match being recorded, or null. Everything but the turns, which are
  // read off Runner when a save is taken.
  rec: null,
  _savedTurn: 0,
  _timer: null,

  // A fresh match has started (main.js's `start` handler). Never called for a
  // match that is itself a replay.
  begin(gameStartInfo, myClientID, myPlayerId) {
    this.finish();
    this.rec = {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      startedAt: Date.now(),
      gameStartInfo: gameStartInfo,
      myClientID: myClientID,
      myPlayerId: myPlayerId,
      hashes: [],
      result: null
    };
    this._savedTurn = 0;
    if (this._timer === null) {
      this._timer = setInterval(() => this.save(), this.AUTOSAVE_MS);
      window.addEventListener('pagehide', () => this.save());
    }
  },

  // The end screen's title ("Victory", "Defeated", ...), for the list.
  noteResult(title) {
    if (!this.rec) return;
    this.rec.result = title;
    this.save(true);
  },

  // Runner's hash seam, both ways: kept while recording, checked while playing.
  onHash(turnNumber, hash) {
    if (this.active) {
      const want = this._hashes.get(turnNumber);
      if (want !== undefined && want !== hash && !this.mismatch) {
        this.mismatch = true;
        UI.showDesyncWarning('This replay no longer matches the game from here on. ' +
          'It was recorded on a different version, or with debug cheats.');
      }
    } else if (this.rec && turnNumber % this.HASH_EVERY === 0) {
      this.rec.hashes.push([turnNumber, hash]);
    }
  },

  // The record as it stands, or null if there is nothing worth keeping yet.
  // Only turns that carry intents are stored; the rest are implied by turnCount.
  snapshot() {
    const rec = this.rec;
    if (!rec || Runner.currTurn < this.MIN_TURNS) return null;
    const count = Runner.currTurn;
    const turns = [];
    for (let i = 0; i < count; i++) {
      const t = Runner.turns[i];
      if (t.intents.length > 0) turns.push([t.turnNumber, t.intents]);
    }
    return {
      format: this.FORMAT,
      version: this.VERSION,
      id: rec.id,
      startedAt: rec.startedAt,
      savedAt: Date.now(),
      build: typeof window.BUILD_ID === 'string' ? window.BUILD_ID : null,
      gameStartInfo: rec.gameStartInfo,
      myClientID: rec.myClientID,
      myPlayerId: rec.myPlayerId,
      turnCount: count,
      turns: turns,
      hashes: rec.hashes.filter((h) => h[0] < count),
      result: rec.result
    };
  },

  // Write the recording to the store if it has grown (or `force`).
  save(force) {
    if (!this.rec || (!force && Runner.currTurn <= this._savedTurn)) return Promise.resolve();
    const record = this.snapshot();
    if (!record) return Promise.resolve();
    this._savedTurn = record.turnCount;
    return this.put(record);
  },

  // The match is over or being left: final save, stop recording.
  finish() {
    if (!this.rec) return;
    this.save();
    this.rec = null;
  },

  // --- Store ------------------------------------------------------------------
  //
  // Every call resolves, never rejects: a browser with storage disabled just
  // has an empty list and saves that go nowhere.

  _db() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(this.STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this._dbPromise;
  },

  _tx(mode, run) {
    return this._db().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, mode);
      const req = run(tx.objectStore(this.STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error);
    }));
  },

  // Newest first.
  list() {
    return this._tx('readonly', (store) => store.getAll())
      .then((all) => all.sort((a, b) => b.savedAt - a.savedAt))
      .catch(() => []);
  },

  put(record) {
    return this._tx('readwrite', (store) => store.put(record))
      .then(() => this.list())
      .then((all) => Promise.all(all.slice(this.MAX_STORED).map((old) => this.remove(old.id))))
      .catch(() => {});
  },

  remove(id) {
    return this._tx('readwrite', (store) => store.delete(id)).catch(() => {});
  },

  // null if `record` is a replay this build can read, otherwise why not.
  // Checked before anything from a file is stored or played.
  validate(record) {
    if (!record || typeof record !== 'object' || record.format !== this.FORMAT) return 'Not a BorderWar replay file.';
    if (record.version !== this.VERSION) return 'This replay was made by a newer version of the game.';
    if (typeof record.id !== 'string' || !record.id) return 'Replay has no id.';
    if (typeof record.myClientID !== 'string' || !record.myClientID) return 'Replay has no player.';
    if (Protocol.validateMessage(Protocol.msg.start([], record.gameStartInfo, record.myClientID), 's2c') !== null) {
      return 'Replay has no valid match settings.';
    }
    if (!Number.isInteger(record.turnCount) || record.turnCount < 1 || record.turnCount > this.MAX_TURNS) {
      return 'Replay has no valid length.';
    }
    if (!Array.isArray(record.turns) || !Array.isArray(record.hashes)) return 'Replay is incomplete.';
    let last = -1;
    for (const entry of record.turns) {
      if (!Array.isArray(entry) || !Number.isInteger(entry[0]) || entry[0] <= last || entry[0] >= record.turnCount ||
          Protocol.validateTurn({ turnNumber: entry[0], intents: entry[1] }) !== null) {
        return 'Replay has a damaged turn.';
      }
      last = entry[0];
    }
    for (const h of record.hashes) {
      if (!Array.isArray(h) || !Number.isInteger(h[0]) || !Number.isInteger(h[1])) return 'Replay has a damaged checksum.';
    }
    return null;
  },

  fileName(record) {
    const d = new Date(record.startedAt || record.savedAt || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return 'borderwar-replay-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  },

  // Hand the record to the browser as a file download.
  download(record) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileName(record);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // Read a replay file. Resolves to the record, rejects with an Error whose
  // message is fit to show the player.
  readFile(file) {
    return file.text().then((text) => {
      let record;
      try { record = JSON.parse(text); } catch (e) { throw new Error('Not a BorderWar replay file.'); }
      const err = this.validate(record);
      if (err) throw new Error(err);
      return record;
    });
  },

  // --- Playback ---------------------------------------------------------------

  SPEEDS: [1, 2, 4, 8],

  // True from play() to stop(). While it is, the connection is a LocalServer
  // feeding `record`'s turns, and nothing the player does reaches the sim.
  active: false,
  record: null,
  // What LocalServer.start is handed as `opts.replay`.
  feed: null,
  _hashes: new Map(),

  speed: 1,
  // What the viewer asked for. LocalServer's own pause is forced off while a
  // seek runs and put back to this when it arrives.
  paused: false,
  // Turn a seek is heading for, or null.
  seekTarget: null,
  // A recorded hash disagreed with playback (see onHash).
  mismatch: false,
  // Whose eyes: a playerId on the roster. Starts as the recorder's.
  viewAs: 0,
  // Fog matches only: show the whole map instead of what `viewAs` had found.
  revealAll: true,
  // A rewind is restarting the match; the camera is kept across it.
  _keepCam: null,

  play(record) {
    const err = this.validate(record);
    if (err) return err;
    this.finish();
    this.record = record;
    const byTurn = new Map();
    for (const entry of record.turns) byTurn.set(entry[0], entry[1]);
    this.feed = {
      gameStartInfo: record.gameStartInfo,
      myClientID: record.myClientID,
      count: record.turnCount,
      byTurn: byTurn
    };
    this._hashes = new Map(record.hashes);
    this.active = true;
    this.speed = 1;
    this.paused = false;
    this.revealAll = true;
    this.viewAs = Number.isInteger(record.myPlayerId) ? record.myPlayerId : 0;
    this._keepCam = null;
    document.body.classList.add('replaying');
    this._restart(0);
    return null;
  },

  stop() {
    this.active = false;
    this.record = null;
    this.feed = null;
    this.seekTarget = null;
    document.body.classList.remove('replaying');
    document.getElementById('desyncBanner').classList.add('hidden');
  },

  // Start the match over and run it forward to `target`.
  _restart(target) {
    this.seekTarget = target;
    this.mismatch = false;
    document.getElementById('desyncBanner').classList.add('hidden');
    this.host.connect(this.feed);
  },

  // main.js's `start` handler, once the replayed match is initialised.
  onMatchReady() {
    Game.me = this.viewAs;
    if (this._keepCam) Object.assign(Render.cam, this._keepCam);
    this._keepCam = null;
    LocalServer.speed = this.speed;
    if (this.seekTarget > 0) LocalServer.burst(this.seekTarget);
  },

  // Turns played so far, and in total.
  turn() { return Runner.currTurn; },
  length() { return this.feed ? this.feed.count : 0; },
  ended() { return this.active && this.seekTarget === null && Runner.currTurn >= this.length(); },
  seeking() { return this.active && this.seekTarget !== null; },

  // Jump to `turn`. Forward runs the turns in between as a burst. Backward
  // has to start the match again from turn 0, because the sim only runs one way.
  seek(turn) {
    if (!this.active) return;
    turn = Math.max(0, Math.min(this.length(), turn | 0));
    if (turn < Runner.currTurn) {
      this._keepCam = Object.assign({}, Render.cam);
      this._restart(turn);
      return;
    }
    this.seekTarget = turn;
    LocalServer.cancelBurst();
    LocalServer.setPaused(false);
    LocalServer.burst(turn - LocalServer.turns.length);
  },

  setPaused(paused) {
    if (!this.active) return;
    // Play at the end starts over.
    if (!paused && this.ended()) { this.paused = false; this.seek(0); return; }
    this.paused = !!paused;
    if (!this.seeking()) LocalServer.setPaused(this.paused);
  },

  cycleSpeed() {
    this.speed = this.SPEEDS[(this.SPEEDS.indexOf(this.speed) + 1) % this.SPEEDS.length];
    LocalServer.speed = this.speed;
  },

  // Follow another player. View state only: Game.me is never read by the sim.
  setView(playerId) {
    if (!this.active || !Game.players[playerId]) return;
    this.viewAs = playerId;
    Game.me = playerId;
    UI.reset();
    if (Game.spawning) UI.enterSpawnSelect();
  },

  // Once a frame from main.js, after the turn drain: notice a seek arriving.
  frame() {
    if (!this.active || this.seekTarget === null) return;
    if (Runner.currTurn < this.seekTarget) return;
    this.seekTarget = null;
    LocalServer.setPaused(this.paused);
  }
};
