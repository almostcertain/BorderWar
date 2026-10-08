// js/progress.js — achievement tracking and storage (client-only,
// docs/metaprogression.md §5.2, §6.1). Reads sim state and never writes it:
// per-match working state lives here, not on Game.
const Progress = {
  KEY: 'borderwar_progress',
  TICKS_PER_MIN: 600,

  state: { v: 1, unlocked: {}, counters: { wins: 0 }, equipped: { title: null, emblem: null, banner: null } },

  // UI hooks: onUnlock(id) after a new unlock, onChange() after every save.
  onUnlock: null,
  onChange: null,

  // Ids earned in the current match, in order.
  matchEarned: [],

  // The current match's summary: plain facts, filled in as the match runs and
  // judged by evaluate(). null when the match is not tracked.
  match: null,

  _on: false,
  _me: 0,
  _live: false,     // the spawn phase is over and the start tile was looked for
  _dead: false,     // my nation fell; only the winner is still awaited
  _winCounted: false,
  _tick: 0,
  _elapsed: 0,      // Game.elapsed at the last tracked tick
  _slowAt: 0,
  _peakTiles: 0,
  _start: -1,       // my starting tile, or -1 if it could not be told
  _alive: null,     // Uint8Array by player id, as of the last tracked tick
  _allied: null,    // Uint8Array by player id: ever in an alliance with me
  _boats: [],       // my boats as of the last tracked tick
  _boatFrom: new Int32Array(8),     // landmass each sailed from, -1 unknown
  _boatForeign: new Uint8Array(8),  // its landing tile was not mine yet
  _nb: new Int32Array(4),
  _silos: [],       // tiles of my finished Silos
  _siloMark: [],    // per Silo: launches already stamped with _elapsed, -1 = not mine
  _siloUnits: 0,

  // --- Storage ---------------------------------------------------------------

  init() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch (e) { /* ignore */ }
    this.state = this._clean(raw);
    this._checkCounters();
  },

  save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
    if (this.onChange) this.onChange();
    this._push(true);
  },

  // --- Account sync (docs/metaprogression.md §2.5, §6.4) ---------------------

  OWNER_KEY: 'borderwar_progress_owner',
  _pushing: false,
  _again: false,

  // Call whenever Account.user may have changed. A cache left by another
  // account (or by one now signed out) is dropped, never merged or uploaded.
  accountChanged() {
    if (typeof Account === 'undefined' || !Account.available) return;
    this.sendLoadout();
    const uid = Account.user ? String(Account.user.id) : null;
    let owner = null;
    try { owner = localStorage.getItem(this.OWNER_KEY); } catch (e) { /* ignore */ }
    if (owner && owner !== uid) {
      try { localStorage.removeItem(this.OWNER_KEY); } catch (e) { /* ignore */ }
      this._adopt(null);
    }
    // Without the loadout, so the account's own choice is the one adopted.
    if (uid) this._push(false);
  },

  // Sends this browser's progress and adopts the merged reply. `withEquipped`
  // makes the local loadout replace the account's.
  _push(withEquipped) {
    if (typeof Account === 'undefined' || !Account.user) return;
    if (this._pushing) { this._again = true; return; }
    this._pushing = true;
    const uid = Account.user.id;
    const body = { unlocked: this.state.unlocked, counters: this.state.counters };
    if (withEquipped) body.equipped = this.state.equipped;
    Account.saveProgress(body).then(res => {
      if (!Account.user || Account.user.id !== uid) return;
      // Merged with the state as it is now: an unlock may have landed meanwhile.
      const merged = ProgressDefs.merge(ProgressDefs.sanitize(this.state), ProgressDefs.sanitize(res));
      if (withEquipped) merged.equipped = this.state.equipped;
      this._adopt(merged);
      try { localStorage.setItem(this.OWNER_KEY, String(uid)); } catch (e) { /* ignore */ }
    }, () => { /* offline or signed out: the next change retries */ }).then(() => {
      this._pushing = false;
      if (this._again) { this._again = false; this._push(true); }
    });
  },

  // Replaces local state without echoing it back to the server.
  _adopt(raw) {
    this.state = this._clean(raw);
    try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
    this._checkCounters();
    if (this.onChange) this.onChange();
    this.sendLoadout();
  },

  _def(id) {
    const A = ProgressDefs.ACHIEVEMENTS;
    return Object.prototype.hasOwnProperty.call(A, id) ? A[id] : null;
  },

  _n(id, fallback) {
    const def = this._def(id);
    return def && Number.isFinite(def.n) ? def.n : fallback;
  },

  // A well-formed state from whatever was stored. Unknown ids are dropped.
  _clean(raw) {
    const has = Object.prototype.hasOwnProperty;
    const s = { v: 1, unlocked: {}, counters: {}, equipped: {} };
    const ok = raw && typeof raw === 'object';
    const unlocked = ok && raw.unlocked && typeof raw.unlocked === 'object' ? raw.unlocked : {};
    const counters = ok && raw.counters && typeof raw.counters === 'object' ? raw.counters : {};
    const equipped = ok && raw.equipped && typeof raw.equipped === 'object' ? raw.equipped : {};
    for (const id of Object.keys(ProgressDefs.ACHIEVEMENTS)) {
      if (has.call(unlocked, id) && Number.isFinite(unlocked[id]) && unlocked[id] > 0) s.unlocked[id] = unlocked[id];
    }
    for (const c of ProgressDefs.COUNTERS) {
      const v = has.call(counters, c) ? counters[c] : 0;
      s.counters[c] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    }
    for (const type of ProgressDefs.COSMETIC_TYPES) {
      const id = has.call(equipped, type) ? equipped[type] : null;
      const def = typeof id === 'string' && has.call(ProgressDefs.COSMETICS, id) ? ProgressDefs.COSMETICS[id] : null;
      s.equipped[type] = def && def.type === type ? id : null;
    }
    return s;
  },

  // --- Unlocks ---------------------------------------------------------------

  has(id) { return Object.prototype.hasOwnProperty.call(this.state.unlocked, id); },

  unlock(id) {
    const def = this._def(id);
    if (!def || def.enabled === false || this.has(id)) return false;
    this.state.unlocked[id] = Date.now();
    this.matchEarned.push(id);
    this.save();
    if (this.onUnlock) this.onUnlock(id);
    return true;
  },

  bump(counter, by) {
    if (!ProgressDefs.COUNTERS.includes(counter)) return;
    const add = by === undefined ? 1 : by;
    if (!Number.isFinite(add) || add <= 0) return;
    this.state.counters[counter] = (this.state.counters[counter] || 0) + add;
    this.save();
    this._checkCounters();
  },

  _checkCounters() {
    const A = ProgressDefs.ACHIEVEMENTS;
    for (const id of Object.keys(A)) {
      const def = A[id];
      if (def.counter && (this.state.counters[def.counter] || 0) >= def.n) this.unlock(id);
    }
  },

  list() {
    const A = ProgressDefs.ACHIEVEMENTS, out = [];
    for (const id of Object.keys(A)) {
      const def = A[id];
      if (def.enabled === false) continue;
      out.push({
        id, def,
        unlockedAt: this.has(id) ? this.state.unlocked[id] : null,
        progress: def.counter
          ? { have: Math.min(this.state.counters[def.counter] || 0, def.n), need: def.n }
          : null
      });
    }
    return out;
  },

  // --- Judging a match (pure) ------------------------------------------------

  // A win that counts (R2): any multiplayer win, or a singleplayer one in a
  // match at least SP_MIN_NATIONS big and SP_MIN_DIFFICULTY hard.
  isWin(m) {
    if (!m || !m.won) return false;
    if (!m.singleplayer) return true;
    const order = ['easy', 'medium', 'hard'];
    return m.nations >= ProgressDefs.SP_MIN_NATIONS &&
      order.indexOf(m.difficulty) >= order.indexOf(ProgressDefs.SP_MIN_DIFFICULTY);
  },

  // Every achievement id the summary earns. Non-win achievements have no R2
  // minimum; replays and the tutorial never produce a summary at all (R3).
  evaluate(m) {
    const out = [];
    if (!m) return out;
    if (m.nationKills > 0) out.push('first_blood');
    if (m.peakLandPct >= this._n('landlord', 25)) out.push('landlord');
    if (m.seaLanding) out.push('sea_legs');
    if (m.allied) out.push('pact');
    if (m.nukes >= this._n('scorched', 10)) out.push('scorched');
    if (m.samKills >= this._n('iron_dome', 5)) out.push('iron_dome');
    if (m.betrayed) out.push('betrayed');
    if (m.lastOut) out.push('so_close');

    const bigMp = !m.singleplayer && m.humans >= ProgressDefs.MP_MIN_HUMANS;
    if (bigMp && m.place !== null && m.place <= 3) out.push('mp_podium');

    if (!this.isWin(m)) return out;
    out.push('victory');
    if (bigMp) out.push('mp_champion');
    if (m.difficulty === 'hard' && m.bots > 0) out.push('win_hard');
    if (m.map === 'world') out.push('win_world');
    // The world map is the same 2000x1000 grid as procedural large.
    if (m.size === 'large' || m.map === 'world') out.push('win_large');
    if (m.battleRoyale) out.push('win_br');
    if (m.fog) out.push('win_fog');
    if (m.team) out.push('win_team');
    if (m.nukes === 0) out.push('clean_hands');
    // Teammates are not an alliance, but a team win is not a lone one either.
    if (!m.allied && !m.team) out.push('lone_wolf');
    if (m.ticks < this._n('blitz', 15) * this.TICKS_PER_MIN) out.push('blitz');
    if (m.fellBelow) out.push('comeback');
    if (m.startKnown && !m.startLost) out.push('fortress');
    if (m.drillMine) out.push('driller');
    return out;
  },

  // --- Tracking a match ------------------------------------------------------

  // info: { info: gameStartInfo, myPlayerId, singleplayer }. Call after
  // Game.init and after Replay/Tutorial know whether this match is theirs.
  beginMatch(info) {
    this._readCosmetics(info);
    this.matchEarned.length = 0;
    this.match = null;
    this._on = false;
    this._boats.length = 0;
    this._silos.length = 0;
    this._siloMark.length = 0;
    if (Replay.active || Tutorial.active) return;

    const me = Game.players[Game.me];
    if (!me) return;
    const gsi = info && info.info;
    this._gameID = !this._single(info) && gsi && typeof gsi.gameID === 'string' ? gsi.gameID : null;
    const count = Game.players.length;
    this._me = Game.me;
    this._live = false;
    this._dead = false;
    this._winCounted = false;
    this._tick = Game.ticks;
    this._elapsed = Game.elapsed;
    this._slowAt = 0;
    this._peakTiles = 0;
    this._start = -1;
    this._siloUnits = 0;
    this._alive = new Uint8Array(count);
    for (let i = 0; i < count; i++) this._alive[i] = Game.players[i].alive ? 1 : 0;
    this._allied = new Uint8Array(count);

    this.match = {
      singleplayer: !!(info && info.singleplayer),
      humans: Game.humanCount,
      bots: Game.nationCount - Game.humanCount,
      nations: Game.nationCount,
      difficulty: Game.difficulty,
      map: Game.sizeKey === 'world' ? 'world' : 'procedural',
      size: Game.sizeKey,
      fog: !!Game.fog,
      team: !!Game.teams,

      ticks: 0,
      over: false,          // a winner was decided
      alive: true,
      won: false,
      place: null,          // 1 = winner; null while alive and undecided
      lastOut: false,       // nobody was eliminated after me
      battleRoyale: false,
      drillMine: false,

      nationKills: 0,       // nations certainly eliminated by me
      peakLandPct: 0,
      fellBelow: false,     // dropped under comeback's n% after holding twice that
      allied: false,        // ever in an alliance (teammates do not count)
      seaLanding: false,
      nukes: 0,             // launched by me, MIRVs included
      samKills: 0,
      startKnown: false,
      startLost: false,
      betrayed: false       // eliminated by a nation I had been allied with
    };
    this._on = true;
  },

  // After every executed turn (main.js). Free when the match is not tracked.
  // A fault here must not stall the turn loop: it ends tracking instead.
  sample() {
    if (!this._on || Game.spawning) return;
    try {
      this._sample();
    } catch (e) {
      this._on = false;
      console.error('Progress: tracking stopped', e);
    }
  },

  _sample() {
    const me = Game.players[this._me];
    if (!me) return;
    if (!this._live) { this._live = true; this._findStart(me); }

    const t = Game.ticks;
    if (t !== this._tick) {
      if (!this._dead) this._track(me, t);
      this._tick = t;
      this._elapsed = Game.elapsed;
    }
    if (Game.winnerId !== null) {
      this._settle(me, true);
      this._on = false;
    }
  },

  // One tick's worth of watching. O(players + small lists), no allocation
  // except on the rare ticks a Silo list is rebuilt or a SAM fires.
  _track(me, t) {
    const m = this.match, id = this._me;
    const now = Game.elapsed, prev = this._elapsed;
    m.ticks = t;

    // Land share.
    const tiles = me.tiles.size, land = GameMap.landTiles;
    if (tiles > this._peakTiles && land > 0) {
      this._peakTiles = tiles;
      m.peakLandPct = tiles * 100 / land;
      if (m.peakLandPct >= this._n('landlord', 25)) this.unlock('landlord');
    }
    const low = this._n('comeback', 2);
    if (!m.fellBelow && tiles * 100 < land * low && this._peakTiles * 100 >= land * low * 2) m.fellBelow = true;
    if (this._start >= 0 && !m.startLost && GameMap.owner[this._start] !== id) m.startLost = true;

    // Alliances. Game.alliances, not me.allies: that set also holds teammates.
    const als = Game.alliances;
    for (let i = 0; i < als.length; i++) {
      const al = als[i];
      const other = al.a === id ? al.b : al.b === id ? al.a : -1;
      if (other < 0) continue;
      this._allied[other] = 1;
      if (!m.allied) { m.allied = true; this.unlock('pact'); }
    }

    this._trackDeaths(m, id, now);
    this._trackBoats(m, id);
    this._trackNukes(m, me, id, t, now, prev);
    this._trackSams(m, id, now);

    if (!me.alive) {
      this._dead = true;
      this._settle(me, false);
    }
  },

  // Who died this tick, and who is to blame. The sim records no killer; the
  // only trace is Fx.killPopups, one per killing blow, stamped with the tick
  // and the killer but not the victim. So a kill is credited only when the
  // counts leave no doubt.
  _trackDeaths(m, id, now) {
    const P = Game.players, alive = this._alive;
    let deadNations = 0, deadTribes = 0, meDied = false;
    for (let i = 0; i < P.length; i++) {
      if (!alive[i] || P[i].alive) continue;
      alive[i] = 0;
      if (i === id) meDied = true;
      if (P[i].isTribe) deadTribes++; else deadNations++;
    }
    const deaths = deadNations + deadTribes;
    if (deaths === 0) return;

    const pops = Fx.killPopups;
    let all = 0, mine = 0, othersWereAllies = true;
    for (let i = pops.length - 1; i >= 0 && pops[i].born === now; i--) {
      // A living victim always has gold. A blow that paid nothing retook the
      // stray tiles of a nation already dead, which is no death at all.
      if (!(pops[i].amount > 0)) continue;
      all++;
      const by = pops[i].ownerId;
      if (by === id) mine++;
      else if (!(by >= 0 && this._allied[by])) othersWereAllies = false;
    }
    if (all > deaths) return;
    // My blows beyond what the tribes that died could account for hit nations.
    if (mine > deadTribes) {
      m.nationKills += mine - deadTribes;
      this.unlock('first_blood');
    }
    // Every death has its blow, so mine is among the ones that are not mine.
    if (meDied && all === deaths && othersWereAllies) m.betrayed = true;
  },

  // A boat of mine that left Game.boats landed if it reached the end of its
  // path un-recalled (stepBoats' own test) and the landing tile became mine.
  _trackBoats(m, id) {
    const boats = Game.boats, mine = this._boats, from = this._boatFrom, foreign = this._boatForeign;
    for (let i = 0; i < mine.length; i++) {
      const b = mine[i];
      if (boats.indexOf(b) >= 0) continue;
      if (b.retreating || b.pos < b.path.length - 1) continue;
      if (!foreign[i] || GameMap.owner[b.landingTile] !== id) continue;
      const to = GameMap.landmassId[b.landingTile];
      if (from[i] >= 0 && to >= 0 && from[i] !== to && !m.seaLanding) {
        m.seaLanding = true;
        this.unlock('sea_legs');
      }
    }
    // Rebuilt in place. A boat already known keeps the landmass it sailed
    // from; Game.boats keeps its order, so j never overtakes i.
    let n = 0;
    for (let i = 0; i < boats.length && n < foreign.length; i++) {
      const b = boats[i];
      if (b.attacker !== id) continue;
      const j = mine.indexOf(b);
      from[n] = j >= 0 ? from[j] : this._departure(b, id);
      foreign[n] = GameMap.owner[b.landingTile] !== id ? 1 : 0;
      mine[n++] = b;
    }
    mine.length = n;
  },

  // The landmass a new boat sailed from: path[0] is the water tile next to
  // my coast. -1 if my land beside it is on no single landmass.
  _departure(b, id) {
    const nb = this._nb, n = GameMap.neighbors(b.path[0], nb);
    let lm = -1;
    for (let k = 0; k < n; k++) {
      if (GameMap.owner[nb[k]] !== id) continue;
      const here = GameMap.landmassId[nb[k]];
      if (lm >= 0 && here !== lm) return -1;
      lm = here;
    }
    return lm;
  },

  _countAt(queue, at) {
    let n = 0;
    for (let i = 0; i < queue.length; i++) if (queue[i] === at) n++;
    return n;
  },

  // My launches this turn. An intent runs before the tick, so its nuke and
  // its Silo slot are both stamped with the previous tick's clock. Two
  // witnesses, because either can be gone by now: the nuke (shot down on its
  // first tick) or the Silo (destroyed). Anything the tick itself stamps
  // (a Silo upgrade, a bot's launch) carries the new clock and is not counted.
  _trackNukes(m, me, id, t, now, prev) {
    let seen = 0;
    const nukes = Game.nukes;
    for (let i = 0; i < nukes.length; i++) {
      const n = nukes[i];
      if (n.ownerId === id && n.born === prev && n.nukeType !== 'mirvwarhead') seen++;
    }
    const mirvs = Game.mirvs;
    for (let i = 0; i < mirvs.length; i++) {
      if (mirvs[i].ownerId === id && mirvs[i].born === prev) seen++;
    }

    const silos = this._silos, marks = this._siloMark;
    let fired = 0;
    for (let i = 0; i < silos.length; i++) {
      if (marks[i] < 0) continue;
      const b = Game.buildings.get(silos[i]);
      if (b && b.type === 'silo') fired += Math.max(0, this._countAt(b.siloQueue, prev) - marks[i]);
    }

    const launched = Math.max(seen, fired);
    if (launched > 0) {
      m.nukes += launched;
      if (m.nukes >= this._n('scorched', 10)) this.unlock('scorched');
    }

    // Re-mark for the next turn. units.silo moves whenever a Silo is gained,
    // lost or levelled; the once-a-second rebuild covers a same-tick swap.
    const units = me.units.silo || 0;
    if (units !== this._siloUnits || (units > 0 && t >= this._slowAt)) {
      this._siloUnits = units;
      this._slowAt = t + 10;
      silos.length = 0;
      marks.length = 0;
      if (units > 0) {
        for (const b of Game.buildings.values()) {
          if (b.type !== 'silo' || !b.built || GameMap.owner[b.tile] !== id) continue;
          silos.push(b.tile);
          marks.push(this._countAt(b.siloQueue, now));
        }
      }
    } else {
      for (let i = 0; i < silos.length; i++) {
        const b = Game.buildings.get(silos[i]);
        marks[i] = b && b.type === 'silo' && GameMap.owner[silos[i]] === id ? this._countAt(b.siloQueue, now) : -1;
      }
    }
  },

  // Nukes my SAMs shot down this tick: each kill stamps the SAM's queue with
  // the tick's clock. A SAM flash this tick is the cheap sign that any fired.
  _trackSams(m, id, now) {
    const fl = Game.samFlashes;
    if (!fl.length || fl[fl.length - 1].born !== now) return;
    let kills = 0;
    for (const b of Game.buildings.values()) {
      if (b.type !== 'sam' || !b.built || GameMap.owner[b.tile] !== id) continue;
      let c = this._countAt(b.samQueue, now);
      // A level-up finishing this tick stamps the queue once too.
      if (c > 0 && b.samRangeUpgrade && b.samRangeUpgrade.startAt === now) c--;
      kills += c;
    }
    if (kills > 0) {
      m.samKills += kills;
      if (m.samKills >= this._n('iron_dome', 5)) this.unlock('iron_dome');
    }
  },

  // The sim does not keep a human's starting tile. In fog it is the reserve
  // tile; otherwise it is worked out from the starting disc (Game.claimStart:
  // every unclaimed tile within sqrt(29) of the centre), and left unknown,
  // which rules Fortress out for the match, unless exactly one tile fits.
  _findStart(me) {
    const m = this.match, id = this._me;
    const w = GameMap.width, h = GameMap.height;
    let start = -1;
    if (Game.fog) {
      const t = Game.humanReserveTiles ? Game.humanReserveTiles[id] : -1;
      if (t >= 0 && GameMap.owner[t] === id) start = t;
    } else if (me.tiles.size > 0 && me.tiles.size <= 97) {
      const tiles = Array.from(me.tiles);
      const fits = [];
      for (const c of tiles) {
        const cx = c % w, cy = (c / w) | 0;
        let ok = true;
        for (const t of tiles) {
          const dx = (t % w) - cx, dy = ((t / w) | 0) - cy;
          if (dx * dx + dy * dy > 29) { ok = false; break; }
        }
        if (ok) fits.push(c);
      }
      if (fits.length === 1) {
        start = fits[0];
      } else if (fits.length > 1) {
        // A clipped disc fits several centres. The real one left nothing
        // unclaimed (-1, NEUTRAL) inside its own disc.
        let found = -1, n = 0;
        for (const c of fits) {
          const cx = c % w, cy = (c / w) | 0;
          let ok = true;
          for (let dy = -5; dy <= 5 && ok; dy++) {
            for (let dx = -5; dx <= 5; dx++) {
              const x = cx + dx, y = cy + dy;
              if (dx * dx + dy * dy > 29 || x < 0 || y < 0 || x >= w || y >= h) continue;
              if (GameMap.owner[y * w + x] === -1) { ok = false; break; }
            }
          }
          if (ok) { found = c; n++; }
        }
        if (n === 1) start = found;
      }
    }
    this._start = start;
    m.startKnown = start >= 0;
  },

  // Fills in the result and awards what the summary earns. Runs when my
  // nation falls and again when the winner is decided: a team can win after
  // I am out, and So Close needs the end. Each award is still made once.
  _settle(me, over) {
    const m = this.match, id = this._me;
    m.over = over;
    m.alive = me.alive;
    m.ticks = Game.ticks;
    m.battleRoyale = !!Game.drill;
    m.drillMine = !!Game.drill && Game.drill.ownerId === id;
    m.won = over && (Game.winnerTeam ? Game.teamOf(id) === Game.winnerTeam : Game.winnerId === id);

    const fell = Game.placements.get(id);
    if (m.won) {
      m.place = 1;
    } else if (!me.alive) {
      m.place = fell === undefined ? null : fell;
    } else if (over) {
      let ahead = 0;
      for (const p of Game.players) {
        if (p !== me && p.alive && !p.isTribe && p.tiles.size > me.tiles.size) ahead++;
      }
      m.place = Math.max(2, 1 + ahead);
    }

    m.lastOut = false;
    if (over && !me.alive && fell !== undefined) {
      m.lastOut = true;
      for (const v of Game.placements.values()) if (v < fell) { m.lastOut = false; break; }
    }

    const earned = this.evaluate(m);
    for (let i = 0; i < earned.length; i++) this.unlock(earned[i]);
    if (this.isWin(m) && !this._winCounted) {
      this._winCounted = true;
      if (this._firstWin(this._gameID)) this.bump('wins', 1);
    }
  },

  _single(info) { return !!(info && info.singleplayer); },

  // A multiplayer match replays from turn 0 after a page reload, so its win
  // would be met twice. False if `gameID` was already counted on this browser.
  GAMES_KEY: 'borderwar_progress_games',
  _firstWin(gameID) {
    if (!gameID) return true;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(this.GAMES_KEY) || '[]'); } catch (e) { /* ignore */ }
    if (!Array.isArray(seen)) seen = [];
    if (seen.indexOf(gameID) !== -1) return false;
    seen.push(gameID);
    try { localStorage.setItem(this.GAMES_KEY, JSON.stringify(seen.slice(-30))); } catch (e) { /* ignore */ }
    return true;
  },

  // Ends tracking for this match (the debug panel was opened).
  disqualify() { this._on = false; this.match = null; },

  // --- Cosmetics (docs/metaprogression.md §4, §6.3) --------------------------

  _cosmetics: [],   // by playerId: {title, emblem, banner} or undefined

  // The roster carries other players' loadouts in multiplayer and in replays
  // of it; a local match has only this browser's own.
  _readCosmetics(info) {
    this._cosmetics.length = 0;
    const gsi = info && info.info;
    const players = (gsi && gsi.players) || [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || !Number.isInteger(p.playerId) || !p.cosmetics) continue;
      this._cosmetics[p.playerId] = ProgressDefs.sanitize({ equipped: p.cosmetics }).equipped;
    }
    if (this._single(info) && !Replay.active && Number.isInteger(info.myPlayerId) && info.myPlayerId >= 0) {
      this._cosmetics[info.myPlayerId] = this.loadout();
    }
  },

  _cosmetic(playerId, type) {
    const c = this._cosmetics[playerId];
    const id = c ? c[type] : null;
    return id ? ProgressDefs.COSMETICS[id] : null;
  },

  // '' when the player has none.
  titleOf(playerId) { const c = this._cosmetic(playerId, 'title'); return c ? c.name : ''; },
  emblemOf(playerId) { const c = this._cosmetic(playerId, 'emblem'); return c ? c.glyph : ''; },
  bannerOf(playerId) { const c = this._cosmetics[playerId]; return (c && c.banner) || ''; },
  titleName(id) { const c = id ? ProgressDefs.COSMETICS[id] : null; return c && c.type === 'title' ? c.name : ''; },

  // This browser's equipped items, minus any it has not unlocked.
  loadout() { return ProgressDefs.equippable(ProgressDefs.sanitize(this.state)); },

  // The achievement that unlocks a cosmetic, or null.
  unlockerOf(cosmeticId) {
    const A = ProgressDefs.ACHIEVEMENTS;
    for (const id of Object.keys(A)) if (A[id].unlocks === cosmeticId && A[id].enabled !== false) return id;
    return null;
  },

  owns(cosmeticId) {
    const by = this.unlockerOf(cosmeticId);
    return !!by && this.has(by);
  },

  // `id` null clears the slot.
  equip(type, id) {
    if (ProgressDefs.COSMETIC_TYPES.indexOf(type) === -1) return;
    if (id !== null) {
      const c = Object.prototype.hasOwnProperty.call(ProgressDefs.COSMETICS, id) ? ProgressDefs.COSMETICS[id] : null;
      if (!c || c.type !== type || !this.owns(id)) return;
    }
    this.state.equipped[type] = id;
    this.save();
    this.sendLoadout();
  },

  // Tells the game server what to show other players (POST /api/loadout,
  // keyed by the browser id `join` already carries). Best effort.
  sendLoadout() {
    if (typeof Account === 'undefined' || !Account.available || typeof Transport === 'undefined') return;
    const body = { persistentID: Transport.getPersistentID(), equipped: this.loadout() };
    fetch('api/loadout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => { /* offline: sent again on the next change */ });
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = Progress;
