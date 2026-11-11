// Daily Challenge: one singleplayer match a day, the same map, rules and bots
// for every player, with a score, a personal best and a play streak kept in
// this browser. Client-only: it picks a seed and settings and reads the result
// MatchStats settles; the match itself is an ordinary singleplayer one
// (docs/retention-pack.md §2).
const Daily = {
  KEY: 'borderwar_daily',
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

  state: { v: 1, streak: 0, bestStreak: 0, last: 0, days: {} },
  active: false,        // the match on screen is a daily
  day: 0,               // which one
  result: null,         // this match's entry, once it has ended
  _pending: 0,
  _void: false,
  host: null,           // { start(config) }, set by main.js

  today() { return Math.floor((Date.now() - this.EPOCH) / this.DAY_MS) + 1; },

  // Everything about a day's match follows from its number alone.
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

  init() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.KEY) || 'null');
      if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') {
        this.state.streak = raw.streak | 0;
        this.state.bestStreak = raw.bestStreak | 0;
        this.state.last = raw.last | 0;
        for (const k in raw.days) {
          const d = raw.days[k];
          if (/^\d+$/.test(k) && d && typeof d.score === 'number') this.state.days[k] = d;
        }
      }
    } catch (e) { /* ignore */ }
  },

  save() {
    const keys = Object.keys(this.state.days).map(Number).sort((a, b) => a - b);
    while (keys.length > this.KEEP_DAYS) delete this.state.days[keys.shift()];
    try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
  },

  // The streak as it stands now: it lapses once a whole day is missed.
  streak() {
    return this.state.last >= this.today() - 1 ? this.state.streak : 0;
  },

  entry(day) { return this.state.days[day] || null; },

  score(e) {
    let s = Math.round(e.peakPct * this.LAND_POINTS) + Math.max(0, e.nations - e.place) * this.OUTLAST_POINTS;
    if (e.won) s += this.WIN_POINTS + Math.max(0, this.SPEED_POINTS - Math.floor(e.secs / 3));
    return s;
  },

  start() {
    if (!this.host) return;
    const ch = this.challenge(this.today());
    this._pending = ch.day;
    this.close();
    this.host.start(ch.config);
  },

  // From main.js once Game.init has run: is this match the one start() asked for?
  matchReady() {
    this.active = this._pending > 0;
    this.day = this._pending;
    this._pending = 0;
    this.result = null;
    this._void = false;
  },

  // The debug panel was opened: this attempt no longer counts.
  disqualify() { this._void = true; },

  // From MatchStats, once, with the settled summary.
  onEnd(e) {
    if (!this.active || this.result) return;
    const res = {
      score: this._void ? 0 : this.score(e), won: e.won, secs: e.secs, place: e.place,
      nations: e.nations, peak: Math.round(e.peakPct * 10) / 10
    };
    this.result = res;
    res.short = !e.won && e.secs < this.MIN_SECS;
    if (this._void || res.short) return;
    const st = this.state, old = st.days[this.day];
    res.tries = (old ? old.tries | 0 : 0) + 1;
    res.best = !old || res.score > old.score;
    st.days[this.day] = res.best ? { score: res.score, won: res.won, secs: res.secs, place: res.place, nations: res.nations, peak: res.peak, tries: res.tries }
      : Object.assign(old, { tries: res.tries });
    // Counted against the day that was played, so a match that runs past
    // midnight still extends the streak.
    if (st.last !== this.day) {
      st.streak = st.last === this.day - 1 ? st.streak + 1 : 1;
      st.last = this.day;
      if (st.streak > st.bestStreak) st.bestStreak = st.streak;
    }
    this.save();
    this.renderRow();
  },

  fmt(n) { return String(n).replace(/\B(?=(\d{3})+$)/g, ','); },
  points(n) { return this.fmt(n) + (n === 1 ? ' point' : ' points'); },

  // The end screen's daily block.
  endHtml() {
    const r = this.result;
    if (!this.active || !r) return '';
    if (this._void) return '<b>Daily #' + this.day + '</b><small>Debug tools were used, so this attempt does not count.</small>';
    if (r.short) return '<b>Daily #' + this.day + '</b><small>Too short to count. Last ' + (this.MIN_SECS / 60) + ' minutes to post a result and keep your streak.</small>';
    const best = this.entry(this.day);
    return '<b>Daily #' + this.day + ' · ' + this.points(r.score) + '</b>' +
      '<small>' + (r.best ? (r.tries > 1 ? 'New personal best' : 'First result of the day') : 'Your best today is ' + this.fmt(best.score)) +
      ' · ' + this.streakText() + '</small>';
  },

  streakText() {
    const s = this.streak();
    return s > 0 ? s + '-day streak' : 'No streak yet';
  },

  shareText() {
    const d = this.entry(this.day || this.today()), day = this.day || this.today();
    if (!d) return 'BorderWar Daily #' + day + '\n' + MatchStats.SITE + '?daily';
    const how = d.won ? 'Victory in ' + MatchStats.clock(d.secs)
      : 'Finished ' + MatchStats.ordinal(d.place) + ' of ' + d.nations;
    const s = this.streak();
    return 'BorderWar Daily #' + day + ' (' + this.challenge(day).label + ')\n' +
      how + ' · ' + this.points(d.score) + (s > 1 ? ' · ' + s + '-day streak' : '') +
      '\nSame map for everyone today: ' + MatchStats.SITE + '?daily';
  },

  // --- Menu row and panel ----------------------------------------------------

  countdown() {
    const left = this.EPOCH + this.today() * this.DAY_MS - Date.now();
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
    return h > 0 ? h + 'h ' + m + 'm' : Math.max(1, m) + 'm';
  },

  renderRow() {
    const day = this.today(), d = this.entry(day), s = this.streak();
    document.getElementById('dailyRowTitle').textContent = 'Daily Challenge #' + day;
    document.getElementById('dailyRowSub').textContent = d
      ? 'Done today · best ' + this.fmt(d.score) + ' · new map in ' + this.countdown()
      : this.challenge(day).label;
    const chip = document.getElementById('dailyStreak');
    chip.textContent = s > 0 ? s + '-day streak' : '';
    chip.classList.toggle('hidden', s === 0);
    // Played yesterday but not yet today: the streak is at stake.
    chip.classList.toggle('atRisk', s > 0 && !d);
  },

  open() {
    const day = this.today(), ch = this.challenge(day), d = this.entry(day);
    this.day = this.active ? this.day : day;
    document.getElementById('dailyTitle').textContent = 'Daily Challenge #' + day;
    document.getElementById('dailyLabel').textContent = ch.label;
    const c = ch.config;
    document.getElementById('dailyFacts').textContent =
      c.bots + ' nations · ' + c.tribes + ' tribes · same map and rivals for every player · new map in ' + this.countdown();
    const best = document.getElementById('dailyBest');
    best.innerHTML = d
      ? '<div><b>' + this.fmt(d.score) + '</b><small>Best today</small></div>' +
        '<div><b>' + (d.won ? 'Won in ' + MatchStats.clock(d.secs) : MatchStats.ordinal(d.place) + ' of ' + d.nations) + '</b><small>Result</small></div>' +
        '<div><b>' + d.tries + '</b><small>' + (d.tries === 1 ? 'Attempt' : 'Attempts') + '</small></div>'
      : '<div><b>' + this.streak() + '</b><small>Day streak</small></div>' +
        '<div><b>' + this.state.bestStreak + '</b><small>Longest streak</small></div>' +
        '<div><b>' + Object.keys(this.state.days).length + '</b><small>Days played</small></div>';
    document.getElementById('dailyPlay').textContent = d ? 'Play again to beat ' + this.fmt(d.score) : 'Play today\'s challenge';
    document.getElementById('dailyShare').classList.toggle('hidden', !d);
    document.getElementById('dailyOverlay').classList.remove('hidden');
    // A fog match hides its map until it is explored, here as in the Solo screen.
    const wrap = document.getElementById('dailyMap');
    wrap.classList.toggle('fogged', c.fogOfWar);
    if (!c.fogOfWar && this._painted !== day) {
      this._painted = day;
      UI.paintMap(document.getElementById('dailyMapCanvas'), c.seed, c.mapGen);
    }
  },

  close() { document.getElementById('dailyOverlay').classList.add('hidden'); },

  setup() {
    this.init();
    const overlay = document.getElementById('dailyOverlay');
    document.getElementById('dailyBtn').addEventListener('click', () => this.open());
    document.getElementById('dailyClose').addEventListener('click', () => this.close());
    document.getElementById('dailyPlay').addEventListener('click', () => this.start());
    const share = document.getElementById('dailyShare');
    share.addEventListener('click', () => {
      this.day = this.today();
      MatchStats.share(this.shareText(), share);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) this.close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) this.close();
    });
    this.renderRow();
    // Keeps the countdown and the day number right on a menu left open.
    setInterval(() => {
      if (!document.getElementById('overlay').classList.contains('hidden')) this.renderRow();
    }, 60000);
    // A shared result links here.
    if (/[?&]daily\b/.test(location.search)) {
      history.replaceState(null, '', location.pathname);
      this.open();
    }
  }
};
