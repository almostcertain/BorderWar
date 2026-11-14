// Daily Challenge: one singleplayer match a day, the same map, rules and bots
// for every player, with a score, a personal best and a play streak, synced to
// the account when signed in, and a global board the server checks by re-running
// the replay. The match itself is an ordinary singleplayer one
// (docs/retention-pack.md §2, docs/daily-leaderboard.md).
const Daily = {
  KEY: 'borderwar_daily',
  // Settings, scoring and sync rules are shared with the server: js/daily-core.js.
  get DAY_MS() { return DailyCore.DAY_MS; },
  get EPOCH() { return DailyCore.EPOCH; },
  get MIN_SECS() { return DailyCore.MIN_SECS; },

  state: { streak: 0, bestStreak: 0, last: 0, days: {} },
  active: false,        // the match on screen is a daily
  day: 0,               // which one
  result: null,         // this match's entry, once it has ended
  _pending: 0,
  _void: false,
  host: null,           // { start(config) }, set by main.js

  today() { return DailyCore.dayAt(Date.now()); },
  challenge(day) { return DailyCore.challenge(day); },
  score(e) { return DailyCore.score(e); },

  init() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch (e) { /* ignore */ }
    this.state = DailyCore.sanitize(raw, this.today());
  },

  save() {
    this._store();
    Progress.sync();
  },

  _store() {
    DailyCore._trim(this.state);
    try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
  },

  // The account's copy after a sync (merged with ours), or null to forget this
  // browser's copy because it belongs to an account that is no longer signed in.
  adopt(raw) {
    if (raw === undefined) return;
    this.state = raw === null ? DailyCore.sanitize(null)
      : DailyCore.merge(this.state, DailyCore.sanitize(raw, this.today()));
    this._store();
    if (this.state.bestStreak > 0) Progress.raise('dailyStreak', this.state.bestStreak);
    this.renderRow();
  },

  // The streak as it stands now: it lapses once a whole day is missed.
  streak() {
    return this.state.last >= this.today() - 1 ? this.state.streak : 0;
  },

  entry(day) { return this.state.days[day] || null; },

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
    Progress.unlock('daily_played');
    if (res.won) Progress.unlock('daily_win');
    Progress.raise('dailyStreak', st.bestStreak);
    this.submit(res);
  },

  // --- Global leaderboard (docs/daily-leaderboard.md) ------------------------
  // The server re-runs the replay and keeps the score it computes itself.

  POLL_MS: 4000,
  POLL_FOR_MS: 8 * 60000,
  // { day, status: 'guest'|'checking'|'kept'|'done'|'rejected'|'error', message, rank, total, best }
  post: null,
  _poll: 0,

  submit(res) {
    clearTimeout(this._poll);
    this.post = null;
    if (typeof Account === 'undefined' || !Account.available) return;
    const day = this.day;
    if (!Account.user) { this.post = { day, status: 'guest' }; return; }
    const replay = Replay.snapshot();
    if (!replay) return;
    this.post = { day, status: 'checking' };
    fetch('api/daily/submit', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, claimed: res.score, replay })
    }).then(r => r.json().catch(() => ({})).then(d => {
      if (!r.ok) throw new Error(d.message || 'Could not reach the leaderboard.');
      return d;
    })).then(d => {
      if (d.status === 'kept') this.post = { day, status: 'kept' };
      this._watch(day, Date.now());
    }, e => {
      this.post = { day, status: 'error', message: e.message };
      this._showPost();
    });
    this._showPost();
  },

  // Polls the board until the server has checked the submitted replay.
  _watch(day, since) {
    this.fetchBoard(day).then(b => {
      if (!this.post || this.post.day !== day) return;
      const c = b.check, mine = b.me;
      if (this.post.status === 'checking' && c && c.status === 'checking' && Date.now() - since < this.POLL_FOR_MS) {
        this._poll = setTimeout(() => this._watch(day, since), this.POLL_MS);
        return;
      }
      if (this.post.status === 'checking' && c && c.status === 'rejected') this.post = { day, status: 'rejected', message: c.message };
      else if (this.post.status === 'checking' && !(c && c.status === 'done')) this.post = { day, status: 'error', message: 'Still checking. Look at the board later.' };
      else this.post = { day, status: this.post.status === 'kept' ? 'kept' : 'done', rank: mine && mine.rank, total: b.total, best: mine && mine.score };
      this._showPost();
    }, () => {
      if (this.post && this.post.status === 'checking') this._poll = setTimeout(() => this._watch(day, since), this.POLL_MS * 2);
    });
  },

  postText() {
    const p = this.post;
    if (!p) return '';
    switch (p.status) {
      case 'guest': return 'Sign in to put your score on the global board.';
      case 'checking': return 'Checking your match for the global board…';
      case 'kept': return p.rank ? 'Global board: #' + p.rank + ' of ' + p.total + ' with your best of ' + this.fmt(p.best) + '.' : 'Your best today is already on the global board.';
      case 'done': return p.rank ? 'Global board: #' + p.rank + ' of ' + p.total + ' today.' : 'Posted to the global board.';
      default: return p.message || 'Could not post to the global board.';
    }
  },

  _showPost() {
    const el = document.getElementById('endDailyBoard');
    if (el) el.textContent = this.postText();
    if (!document.getElementById('dailyOverlay').classList.contains('hidden')) this.loadBoard(this._boardDay);
  },

  fetchBoard(day) {
    return fetch('api/daily/board?day=' + day, { credentials: 'same-origin', cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('board ' + r.status)));
  },

  _boardDay: 0,

  loadBoard(day) {
    const wrap = document.getElementById('dailyBoard');
    if (typeof Account === 'undefined' || !Account.available) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    this._boardDay = day;
    const today = this.today();
    document.getElementById('dailyBoardToday').classList.toggle('on', day === today);
    document.getElementById('dailyBoardYesterday').classList.toggle('on', day !== today);
    document.getElementById('dailyBoardYesterday').classList.toggle('hidden', today <= 1);
    const list = document.getElementById('dailyBoardList');
    this.fetchBoard(day).then(b => {
      if (this._boardDay !== day) return;
      list.innerHTML = this.boardHtml(b);
    }, () => { list.innerHTML = '<div class="dbEmpty">The leaderboard can\'t be reached right now.</div>'; });
  },

  boardHtml(b) {
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const line = (r, me) => '<div class="dbRow' + (me ? ' me' : '') + '"><span class="dbRank">' + r.rank + '</span>' +
      '<span class="dbName">' + esc(r.name) + '</span>' +
      '<span class="dbHow">' + (r.won ? 'Won ' + MatchStats.clock(r.secs) : MatchStats.ordinal(r.place) + '/' + r.nations) + '</span>' +
      '<span class="dbScore">' + this.fmt(r.score) + '</span></div>';
    let html = '';
    if (!b.top.length) html = '<div class="dbEmpty">No scores yet' + (b.day === b.today ? ' today. Be the first.' : '.') + '</div>';
    const mine = b.me;
    for (const r of b.top) html += line(r, mine && r.rank === mine.rank);
    if (mine && mine.rank > b.top.length) html += '<div class="dbGap">…</div>' + line(mine, true);
    const c = b.check;
    if (c && c.status === 'checking') html += '<div class="dbNote">Checking your latest result…</div>';
    else if (c && c.status === 'rejected') html += '<div class="dbNote">Your last result wasn\'t posted: ' + esc(c.message) + '</div>';
    else if (!Account.user) html += '<div class="dbNote">Sign in to put your scores on the board.</div>';
    if (b.total > b.top.length) html += '<div class="dbNote">' + this.fmt(b.total) + ' players on this board.</div>';
    return html;
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
      ' · ' + this.streakText() + '</small>' +
      (this.post && this.post.day === this.day ? '<small id="endDailyBoard">' + this.postText() + '</small>' : '');
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
    this.loadBoard(day);
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
    document.getElementById('dailyBoardToday').addEventListener('click', () => this.loadBoard(this.today()));
    document.getElementById('dailyBoardYesterday').addEventListener('click', () => this.loadBoard(this.today() - 1));
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
