// End-of-match report: how the player's share of the map moved against the
// strongest rival, a few headline numbers, and a result to share. Client-only;
// it reads sim state and writes none (docs/retention-pack.md §3).
const MatchStats = {
  SAMPLE_TICKS: 50,     // one point on the chart every 5 s of match time
  MAX_POINTS: 720,      // an hour; past that every other point is dropped
  RANK_AFTER_S: 60,

  active: false,
  ended: null,          // the summary, once the match is over for this player
  _me: 0,
  _nextAt: 0,
  _every: 50,
  _t0: -1,              // Game.elapsed when the spawn phase ended
  _series: [],          // [seconds, my land %, strongest rival's land %] triples, flat
  _peakPct: 0,
  _bestRank: 0,
  _peakTroops: 0,

  // Call after Game.init. Replays, the admin watch and the tutorial get no report.
  begin(myPlayerId) {
    this.active = !(Replay.active || Watch.active || Tutorial.active);
    this.ended = null;
    this._me = myPlayerId;
    this._nextAt = 0;
    this._every = this.SAMPLE_TICKS;
    this._t0 = -1;
    this._series.length = 0;
    this._peakPct = 0;
    this._bestRank = 0;
    this._peakTroops = 0;
    document.getElementById('endStats').classList.add('hidden');
  },

  // Once per executed turn.
  sample() {
    if (!this.active || this.ended || Game.spawning) return;
    if (this._t0 < 0) this._t0 = Game.elapsed;
    if (Game.ticks < this._nextAt) return;
    this._nextAt = Game.ticks + this._every;
    this._point();
  },

  _point() {
    const me = Game.players[this._me];
    if (!me || !GameMap.landTiles) return;
    const mine = me.alive ? me.tiles.size : 0;
    let rival = 0, ahead = 0;
    for (const p of Game.players) {
      if (p === me || !p.alive || p.isTribe) continue;
      const n = p.tiles.size;
      if (n > rival) rival = n;
      if (n > mine) ahead++;
    }
    const pct = mine * 100 / GameMap.landTiles;
    if (pct > this._peakPct) this._peakPct = pct;
    // Everyone starts level, so a rank means nothing in the first minute.
    if (me.alive && Game.elapsed - this._t0 >= this.RANK_AFTER_S && (this._bestRank === 0 || ahead + 1 < this._bestRank)) this._bestRank = ahead + 1;
    if (me.troops > this._peakTroops) this._peakTroops = me.troops;

    const s = this._series;
    s.push(Game.elapsed - this._t0, pct, rival * 100 / GameMap.landTiles);
    if (s.length >= this.MAX_POINTS * 3) {
      for (let i = 0, o = 0; i < s.length; i += 6, o += 3) { s[o] = s[i]; s[o + 1] = s[i + 1]; s[o + 2] = s[i + 2]; }
      s.length = Math.ceil(s.length / 6) * 3;
      this._every *= 2;
    }
  },

  // The match is over for this player (UI.showEnd). The first call settles
  // the numbers; a later one (Game Over after Defeated) only redraws.
  onEnd(title) {
    if (!this.active) return;
    if (!this.ended) {
      this._point();
      const me = Game.players[this._me];
      const won = title === 'Victory';
      const fell = Game.placements.get(this._me);
      let place = won ? 1 : fell !== undefined ? fell : null;
      if (place === null && me && title === this.LEFT) {
        // Walking out counts as falling now: every nation still alive outlasts you.
        place = 0;
        for (const p of Game.players) if (p.alive && !p.isTribe) place++;
      } else if (place === null && me) {
        let ahead = 0;
        for (const p of Game.players) if (p !== me && p.alive && !p.isTribe && p.tiles.size > me.tiles.size) ahead++;
        place = Math.max(2, ahead + 1);
      }
      this.ended = {
        won: won,
        secs: Math.max(0, Math.round(Game.elapsed - Math.max(0, this._t0))),
        peakPct: this._peakPct,
        bestRank: won ? 1 : this._bestRank || place,
        place: place,
        nations: Game.nationCount,
        peakTroops: this._peakTroops,
        difficulty: Game.difficulty
      };
      Daily.onEnd(this.ended);
    }
    if (title !== this.LEFT) this.render();
  },

  // The player left a match that was still undecided (main.js leaveMatch).
  // Only a daily keeps a result from that.
  LEFT: 'Left',
  abandon() {
    if (this.active && !this.ended && Daily.active && !Game.spawning && Game.winnerId === null) this.onEnd(this.LEFT);
  },

  clock(secs) {
    const m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  },

  ordinal(n) {
    const t = n % 100;
    return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  },

  render() {
    const e = this.ended, el = document.getElementById('endStats');
    if (!e) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const cell = (label, value) => '<div><b>' + value + '</b><small>' + label + '</small></div>';
    document.getElementById('endStatGrid').innerHTML =
      cell('Time', this.clock(e.secs)) +
      cell('Peak land', e.peakPct.toFixed(e.peakPct < 10 ? 1 : 0) + '%') +
      cell('Best rank', '#' + e.bestRank) +
      cell('Finished', this.ordinal(e.place) + ' of ' + e.nations);
    document.getElementById('endDaily').innerHTML = Daily.endHtml();
    document.getElementById('endDaily').classList.toggle('hidden', !Daily.active);
    this.drawChart(document.getElementById('endChart'));
  },

  // My share as a filled area in my nation's colour, the strongest rival's as
  // a dashed line in the panel's text colour.
  drawChart(canvas) {
    const s = this._series, n = s.length / 3;
    const wrap = canvas.parentNode;
    wrap.classList.toggle('hidden', n < 3);
    if (n < 3) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 256, h = canvas.clientHeight || 84;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    let top = 5;
    for (let i = 0; i < s.length; i += 3) top = Math.max(top, s[i + 1], s[i + 2]);
    top *= 1.12;
    const span = Math.max(1, s[s.length - 3]);
    const X = i => 1 + (s[i * 3] / span) * (w - 2);
    const Y = v => h - 1 - (v / top) * (h - 6);
    const ink = getComputedStyle(canvas).color;
    const me = Game.players[this._me];
    const col = me ? me.color : [80, 140, 255];
    const rgb = col[0] + ',' + col[1] + ',' + col[2];
    document.getElementById('endChartKey').style.setProperty('--me', 'rgb(' + rgb + ')');

    c.globalAlpha = 0.25;
    c.strokeStyle = ink;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, h - 0.5);
    c.lineTo(w, h - 0.5);
    c.stroke();
    c.globalAlpha = 1;

    c.beginPath();
    c.moveTo(X(0), h - 1);
    for (let i = 0; i < n; i++) c.lineTo(X(i), Y(s[i * 3 + 1]));
    c.lineTo(X(n - 1), h - 1);
    c.closePath();
    c.fillStyle = 'rgba(' + rgb + ',0.45)';
    c.fill();
    c.beginPath();
    for (let i = 0; i < n; i++) i ? c.lineTo(X(i), Y(s[i * 3 + 1])) : c.moveTo(X(i), Y(s[i * 3 + 1]));
    c.strokeStyle = 'rgb(' + rgb + ')';
    c.lineWidth = 2;
    c.lineJoin = 'round';
    c.stroke();

    c.beginPath();
    for (let i = 0; i < n; i++) i ? c.lineTo(X(i), Y(s[i * 3 + 2])) : c.moveTo(X(i), Y(s[i * 3 + 2]));
    c.setLineDash([4, 3]);
    c.strokeStyle = ink;
    c.globalAlpha = 0.7;
    c.lineWidth = 1.5;
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
  },

  SITE: 'https://borderwar.io/',

  resultLine(e) {
    return e.won
      ? 'Victory in ' + this.clock(e.secs) + ', holding ' + Math.round(e.peakPct) + '% of the map'
      : 'Finished ' + this.ordinal(e.place) + ' of ' + e.nations + ' nations, peaking at ' +
        e.peakPct.toFixed(e.peakPct < 10 ? 1 : 0) + '% of the map';
  },

  shareText() {
    const e = this.ended;
    if (!e) return '';
    if (Daily.active) return Daily.shareText();
    return 'BorderWar: ' + this.resultLine(e) + '.\n' + this.SITE;
  },

  // The phone's share sheet where there is one, otherwise the clipboard.
  share(text, btn) {
    const label = btn.textContent;
    const done = msg => {
      btn.textContent = msg;
      setTimeout(() => { btn.textContent = label; }, 1600);
    };
    const copy = () => {
      if (!navigator.clipboard) { done('Copy not available'); return; }
      navigator.clipboard.writeText(text).then(() => done('Copied to clipboard'), () => done('Copy not available'));
    };
    const touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    if (touch && navigator.share) navigator.share({ text: text }).catch(copy);
    else copy();
  },

  setup() {
    const btn = document.getElementById('endShareBtn');
    btn.addEventListener('click', () => this.share(this.shareText(), btn));
  }
};
