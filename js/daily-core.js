// Daily Challenge rules shared by the browser and the server: the day's
// settings, the score, the per-turn tracking that scores a match, and the
// merge used to sync daily progress to accounts. The server re-runs submitted
// replays through these same functions (docs/daily-leaderboard.md), so a
// change here changes both sides at once. Reads sim state, never writes it.
const DailyCore = {
  DAY_MS: 86400000,
  EPOCH: Date.UTC(2026, 10, 1),   // day 1 is 1 Nov 2026, UTC
  KEEP_DAYS: 60,

  // Nations and tribes per size, at the Solo screen's density.
  COUNTS: { small: [20, 100], medium: [46, 225] },
  // By UTC weekday, Sunday first. Saturday is the long one.
  WEEK: [
    { difficulty: 'hard', size: 'small' }, { difficulty: 'easy', size: 'small' },
    { difficulty: 'medium', size: 'small' }, { difficulty: 'medium', size: 'small' },
    { difficulty: 'medium', size: 'small' }, { difficulty: 'hard', size: 'small' },
    { difficulty: 'medium', size: 'medium' }
  ],
  LANDFORMS: ['continent', 'twin', 'continents', 'archipelago', 'pangaea', 'inland'],
  LANDFORM_NAMES: { continent: 'Continent', twin: 'Twin continents', continents: 'Continents', archipelago: 'Archipelago', pangaea: 'Pangaea', inland: 'Inland sea' },
  TERRAINS: ['normal', 'normal', 'flat', 'rugged', 'alpine'],
  RIVERS: ['normal', 'normal', 'few', 'many'],

  WIN_POINTS: 1000,
  SPEED_POINTS: 1000,   // for a win, less one point per 3 s of match time
  LAND_POINTS: 20,      // per 1% of the map held at the player's peak
  OUTLAST_POINTS: 15,   // per nation that fell before the player did
  MIN_SECS: 120,        // a loss shorter than this is not a result
  SAMPLE_TICKS: 50,     // peak land is read this often

  // Needs mulberry32 and Protocol, which both the page and the server's sim
  // context have.
  challenge(day) {
    const rnd = mulberry32(Math.imul(day, 0x9E3779B1) ^ 0xB0DE4);
    const seed = Math.floor(rnd() * 0x100000000);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const weekday = new Date(this.EPOCH + (day - 1) * this.DAY_MS).getUTCDay();
    const base = this.WEEK[weekday];
    const landform = pick(this.LANDFORMS);
    const mapGen = Protocol.normalizeMapGen({ landform: landform, terrain: pick(this.TERRAINS), rivers: pick(this.RIVERS) });
    const fog = rnd() < 0.35;
    const counts = this.COUNTS[base.size];
    const tags = [this.LANDFORM_NAMES[landform], base.difficulty[0].toUpperCase() + base.difficulty.slice(1)];
    if (base.size === 'medium') tags.push('Big map');
    if (fog) tags.push('Fog of war');
    return {
      day: day, label: tags.join(' · '),
      config: {
        seed: seed, map: 'procedural', mapSize: base.size, mapGen: mapGen,
        bots: counts[0], tribes: counts[1], difficulty: base.difficulty,
        gameMode: 'ffa', fogOfWar: fog, pointsOfInterest: true
      }
    };
  },

  dayAt(ms) { return Math.floor((ms - this.EPOCH) / this.DAY_MS) + 1; },

  score(e) {
    let s = Math.round(e.peakPct * this.LAND_POINTS) + Math.max(0, e.nations - e.place) * this.OUTLAST_POINTS;
    if (e.won) s += this.WIN_POINTS + Math.max(0, this.SPEED_POINTS - Math.floor(e.secs / 3));
    return s;
  },

  // --- Scoring a match ---------------------------------------------------------
  // step() once per executed turn, settle() once when the match ends for the
  // player. `title` is the end card's: 'Victory', 'Defeated', 'Game Over' or 'Left'.

  tracker() { return { t0: -1, nextAt: 0, peakPct: 0 }; },

  step(tr, Game, GameMap, me) {
    if (Game.spawning) return;
    if (tr.t0 < 0) tr.t0 = Game.elapsed;
    if (Game.ticks < tr.nextAt) return;
    tr.nextAt = Game.ticks + this.SAMPLE_TICKS;
    this.peak(tr, Game, GameMap, me);
  },

  peak(tr, Game, GameMap, me) {
    const p = Game.players[me];
    if (!p || !p.alive || !GameMap.landTiles) return;
    const pct = p.tiles.size * 100 / GameMap.landTiles;
    if (pct > tr.peakPct) tr.peakPct = pct;
  },

  settle(tr, Game, GameMap, me, title) {
    this.peak(tr, Game, GameMap, me);
    const p = Game.players[me];
    const won = title === 'Victory';
    const fell = Game.placements.get(me);
    let place = won ? 1 : fell !== undefined ? fell : null;
    if (place === null && p && title === 'Left') {
      // Walking out counts as falling now: every nation still alive outlasts you.
      place = 0;
      for (const q of Game.players) if (q.alive && !q.isTribe) place++;
    } else if (place === null && p) {
      let ahead = 0;
      for (const q of Game.players) if (q !== p && q.alive && !q.isTribe && q.tiles.size > p.tiles.size) ahead++;
      place = Math.max(2, ahead + 1);
    }
    return {
      won: won,
      secs: Math.max(0, Math.round(Game.elapsed - Math.max(0, tr.t0))),
      peakPct: tr.peakPct,
      place: place,
      nations: Game.nationCount
    };
  },

  // The end card's title for this turn, or null while the match goes on for
  // the player. Same order as UI.checkEndGame: a loss is seen first.
  endTitle(Game, me) {
    const p = Game.players[me];
    if (p && !p.alive) return 'Defeated';
    if (Game.winnerId === null) return null;
    return Game.winnerId === me ? 'Victory' : 'Game Over';
  },

  // --- Daily progress (account sync) --------------------------------------------
  // { streak, bestStreak, last, days: { <day>: { score, won, secs, place, nations, peak, tries } } }

  _int(v, max) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0; },

  // A clean copy from untrusted input. Days after `today` (when given) are dropped.
  sanitize(raw, today) {
    const out = { streak: 0, bestStreak: 0, last: 0, days: {} };
    if (!raw || typeof raw !== 'object') return out;
    const cap = typeof today === 'number' && today > 0 ? today : 1e6;
    const I = (v, max) => this._int(v, max);
    if (raw.days && typeof raw.days === 'object') {
      for (const k in raw.days) {
        if (!Object.prototype.hasOwnProperty.call(raw.days, k) || !/^[1-9]\d{0,5}$/.test(k) || +k > cap) continue;
        const d = raw.days[k];
        if (!d || typeof d !== 'object' || typeof d.score !== 'number' || !isFinite(d.score)) continue;
        out.days[k] = {
          score: I(d.score, 1e5), won: d.won === true, secs: I(d.secs, 1e6), place: I(d.place, 1e4),
          nations: I(d.nations, 1e4), peak: Math.round(Math.min(100, Math.max(0, +d.peak || 0)) * 10) / 10,
          tries: Math.max(1, I(d.tries, 1e4))
        };
      }
    }
    out.last = Math.min(I(raw.last, 1e6), cap);
    out.streak = Math.min(I(raw.streak, 1e6), out.last);
    out.bestStreak = Math.max(out.streak, Math.min(I(raw.bestStreak, 1e6), cap));
    this._trim(out);
    return out;
  },

  _trim(s) {
    const keys = Object.keys(s.days).map(Number).sort((a, b) => a - b);
    while (keys.length > this.KEEP_DAYS) delete s.days[keys.shift()];
  },

  // Two sanitized copies into a new one. Repeat-safe: merging the result with
  // either input again changes nothing.
  merge(a, b) {
    const out = { streak: 0, bestStreak: 0, last: Math.max(a.last, b.last), days: {} };
    for (const src of [a, b]) {
      for (const k in src.days) {
        const d = src.days[k], have = out.days[k];
        if (!have) { out.days[k] = Object.assign({}, d); continue; }
        const tries = Math.max(have.tries, d.tries);
        if (d.score > have.score) out.days[k] = Object.assign({}, d);
        out.days[k].tries = tries;
      }
    }
    // Days played on two devices can join into one run neither copy saw.
    let run = 0;
    for (let d = out.last; d > 0 && out.days[d]; d--) run++;
    for (const src of [a, b]) if (src.last === out.last && src.streak > run) run = src.streak;
    out.streak = out.last > 0 ? run : 0;
    out.bestStreak = Math.max(a.bestStreak, b.bestStreak, out.streak);
    this._trim(out);
    return out;
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = DailyCore;
