// Player names are user-typed (and, in multiplayer, come from other clients),
// so anything that puts one into innerHTML must go through this.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A bespoke icon from assets/icons/ as inline HTML, in place of emoji (which
// look different on every platform). Sized to the surrounding text by .ic in
// style.css; render.js draws the same files on the map canvas.
function iconHtml(name) {
  return `<img class="ic" src="assets/icons/${name}.svg" alt="" draggable="false">`;
}

// 1 -> '1st', 2 -> '2nd', 11 -> '11th', 21 -> '21st', etc. Only the defeat
// screen's placement line needs this, so it lives here rather than a shared
// utils module.
function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

const UI = {
  ratio: 0.2, // kept equal to DEFAULT_RATIO
  lastLeaderboard: 0,
  lbMobileOpen: false, // phones only: whole board hidden until tapped
  lbOpenTeams: new Set(), // team ids expanded in the leaderboard; collapsed by default
  diplo: null,        // the offer currently on the banner, if any
  dismissed: new Set(),

  placing: null,      // structure type armed for placement, if any
  placeHover: -1,     // tile under the cursor while armed (mouse hover, or a build-bar drag)
  flashText: '',
  flashUntil: 0,

  // Debug-panel nuke: a two-click flow (launch point, then target), so it
  // has its own UI.placing value 'debugnuke'. debugNukeSrc is -1 until the
  // first click. See onTap's 'debugnuke' branch and Game.debugNuke.
  debugNukeType: null,
  debugNukeSrc: -1,
  // Whether the debug panel is expanded; closed by default, toggled by #debugToggle.
  debugOpen: false,

  // The debug button and panel, and Pause, are for development, so they exist only where
  // the page is served from a developer's own machine or home network, never
  // from the live site. Decided once from the address; nothing a player can
  // type into the URL turns it on.
  DEBUG_HOST: /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.*\.localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/
    .test(location.hostname),
  // Singleplayer as well: every debug action writes around the intent
  // pipeline (see the BYPASS notes in setup()).
  debugAllowed() { return this.DEBUG_HOST && Transport.isLocal; },

  // The player's own warships selected by shift-drag or shift-click.
  // Holds object references into Game.warships, so a splice elsewhere
  // can't leave it stale.
  selectedWarships: new Set(),
  // The same for the player's own Scouts (fog matches only; empty otherwise).
  // A selection can hold both kinds: see the order branch in onTap.
  selectedScouts: new Set(),

  DEFAULT_HINT: 'Tap land to attack · right-click or hold for diplomacy/boat · shift-drag to select warships · drag to pan',
  // Fog matches have Scouts to select as well.
  FOG_DEFAULT_HINT: 'Tap land to attack · right-click or hold for diplomacy/boat · shift-drag to select ships · drag to pan',

  // Touch devices get a short one-line version: no right-click or shift-drag.
  TOUCH_HINT: 'Tap land to attack · hold for diplomacy · drag to pan · pinch to zoom',

  // Hotkeys for entries whose Game.UNITS row carries none (the Scout: its row
  // is sim data and was left alone). 'e' for explore; the digits, P and the
  // WASD pan keys are taken.
  EXTRA_HOTKEYS: { scout: 'e', drill: 'k', radio: 'r' },

  // What each build-bar entry is for, shown when the mouse rests on its
  // button (setupTips). Kept here rather than in Game.UNITS: that table is sim
  // data and the goldens hash it. Numbers are read from the sim's constants so
  // a balance change cannot leave a tip behind.
  UNIT_TIPS: {
    city: () => 'Raises your maximum population. Tap one you own to upgrade it. Each City or upgrade costs more than the last.',
    factory: () => 'Lays rail to nearby Cities and runs trains between them. Every train pays gold, and a train to another nation pays both of you.',
    port: () => 'Built on the coast. Sends trade ships to other nations\' Ports, paying both sides gold; longer routes pay more. Needed to launch ships.',
    fort: () => 'Defends your land within ' + Game.FORT_RANGE + ' tiles: it costs attackers ' + Game.FORT_DEF_MULT +
      'x the troops to take and they advance ' + Game.FORT_SPEED_MULT + 'x slower.',
    warship: () => 'Patrols the water where you send it. Sinks enemy boats and warships and captures unfriendly trade ships. Needs a Port. Shift-drag to select, then tap water to move.',
    silo: () => 'Launches your Atom Bombs, Hydrogen Bombs and MIRVs. Reloads for ' + Game.SILO_COOLDOWN +
      's after each launch. Each upgrade adds another missile slot.',
    atombomb: () => 'A nuclear strike launched from your nearest ready Missile Silo. Its blast reaches ' +
      Game.NUKE_MAGNITUDES.atombomb.outer + ' tiles from where it lands. Enemy SAM Launchers can shoot it down.',
    hydrogenbomb: () => 'A far larger nuclear strike: its blast reaches ' + Game.NUKE_MAGNITUDES.hydrogenbomb.outer +
      ' tiles, against the Atom Bomb\'s ' + Game.NUKE_MAGNITUDES.atombomb.outer + '. Needs a Missile Silo.',
    sam: () => 'Shoots down enemy nukes that fly within its range. Reloads for ' + Game.SAM_COOLDOWN +
      's after each shot. Upgrades widen the range and add charges.',
    mirv: () => 'Splits into ' + Game.MIRV_WARHEAD_COUNT + ' warheads that rain down across a huge area. Needs a Missile Silo. The price rises every time anyone launches one.',
    scout: () => 'An unarmed ship that uncovers the map as it sails. Launched from your nearest Port; send it anywhere, even into the dark.',
    drill: () => 'Starts the endgame. After a ' + Game.DRILL_COUNTDOWN_S + 's warning the world closes in on this spot over ' +
      Math.round(Game.DRILL_SHRINK_S / 60) + ' minutes, and the last nation standing wins. One per match, and it cannot be stopped.',
    radio: () => 'Uncovers the map in a wide circle around it once built, then is gone. A way to see past your border without a Port.'
  },

  // Puts the attack ratio back to its default and moves the slider handle and
  // label to match. The browser restores a range input's last value on refresh
  // (and it keeps whatever the player dragged it to across matches), so the DOM
  // can't be trusted to agree with this.ratio — always write both together.
  DEFAULT_RATIO: 0.2,
  resetRatio() {
    this.ratio = this.DEFAULT_RATIO;
    const pct = Math.round(this.ratio * 100);
    document.getElementById('ratio').value = pct;
    document.getElementById('ratioValue').textContent = pct + '%';
    this.updateRatioTroops();
  },

  setup() {
    const slider = document.getElementById('ratio');
    const label = document.getElementById('ratioValue');
    slider.addEventListener('input', () => {
      this.ratio = slider.value / 100;
      label.textContent = slider.value + '%';
      this.updateRatioTroops();
    });
    this.resetRatio();

    document.getElementById('diploYes').addEventListener('click', () => {
      if (this.diplo) { this.diplo.accept(); this.diplo = null; }
    });
    document.getElementById('diploNo').addEventListener('click', () => {
      if (!this.diplo) return;
      // Turning down a renewal leaves no state behind — the alliance simply
      // runs out — so the banner has to remember it was answered.
      this.dismissed.add(this.diplo.key);
      this.diplo.reject();
      this.diplo = null;
    });

    // MP-4.2: click to dismiss the desync banner locally. Purely cosmetic —
    // see UI.showDesyncWarning's comment for why there is nothing to tell
    // the server here.
    document.getElementById('desyncBanner').addEventListener('click', () => {
      document.getElementById('desyncBanner').classList.add('hidden');
    });

    // Delegated rather than bound per-row: the leaderboard's innerHTML is
    // rewritten wholesale every 500ms (see update()), which would drop
    // per-row listeners as fast as they were attached.
    document.getElementById('leaderboard').addEventListener('click', e => {
      if (e.target.closest('.lbToggle')) {
        this.lbMobileOpen = !this.lbMobileOpen;
        this.renderLeaderboard();
        return;
      }
      const row = e.target.closest('.lbTeamRow');
      // Fog: a row marked `unmet` (a leader the viewer has not met) takes no
      // action. Opening a team's roster is the only row action there is today;
      // anything added later (a menu, a camera jump) belongs behind this too.
      if (!row || row.classList.contains('unmet')) return;
      const team = row.dataset.team;
      if (this.lbOpenTeams.has(team)) this.lbOpenTeams.delete(team);
      else this.lbOpenTeams.add(team);
      this.renderLeaderboard();
    });

    this.setupBuildBar();
    this.setupTips();
    this.setupLobby();
    this.setupProgress();
    this.setupNews();
    this.setupAccount();
    this.setupReplays();

    // DEBUG BYPASS #1: dev-only gold cheats. These write straight into the
    // sim, which nothing else in this file may do (every player action is an
    // intent). There is no gold intent (§4), so this would desync a networked
    // match: gated on Transport.isLocal here and by hiding the panel in update().
    for (const btn of document.querySelectorAll('#debugPanel button[data-gold]')) {
      btn.addEventListener('click', () => {
        if (!this.debugAllowed()) return;
        const me = Game.players[Game.me];
        if (me) me.gold += +btn.dataset.gold;
      });
    }

    // 300s of simulated time (3000 turns) lands near a match's midpoint.
    // NOT a bypass: LocalServer.burst emits the turns through the ordinary
    // pipeline, drained as fast as this client can, so the page keeps rendering.
    document.getElementById('debugFastForward').addEventListener('click', () => {
      if (!this.debugAllowed()) return;
      LocalServer.burst(Math.round(300 / Game.TICK_DT));
    });

    // Speed-up: cycles LocalServer.speed, which only shortens the pump's turn
    // gate. Turns still flow through the normal path, so nothing to desync;
    // singleplayer only. Backpressure caps it at what the client can drain.
    document.getElementById('debugSpeed').addEventListener('click', () => {
      if (!this.debugAllowed()) return;
      const steps = [1, 2, 4, 8, 16];
      LocalServer.speed = steps[(steps.indexOf(LocalServer.speed) + 1) % steps.length];
    });

    document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());
    this.initGameMenu();
    document.getElementById('musicBtn').addEventListener('click', () => this.toggleMusic());

    document.getElementById('debugToggle').addEventListener('click', () => {
      this.debugOpen = !this.debugOpen;
      if (this.debugOpen) Progress.disqualify();
    });

    document.getElementById('debugNukeAtom').addEventListener('click', () => this.armDebugNuke('atombomb'));
    document.getElementById('debugNukeHydrogen').addEventListener('click', () => this.armDebugNuke('hydrogenbomb'));
    document.getElementById('debugPeace').addEventListener('click', () => this.armDebugPeace());
    document.getElementById('debugForfeit').addEventListener('click', () => this.debugForfeit());

    // Hotkeys, one digit per structure in bar order, and Escape to disarm.
    // Guarded on the focused element so typing a bot count in the start menu
    // cannot arm a build.
    window.addEventListener('keydown', e => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        // The capture-phase handler in initGameMenu already used this press.
        if (e._menuHandled) return;
        const armed = this.cancelPlacing();
        const selected = this.selectedWarships.size + this.selectedScouts.size > 0;
        this.clearShipSelection();
        // Nothing to put away: Escape opens the menu.
        if (!armed && !selected) this.openGameMenu();
        return;
      }
      if (e.key === 'p' || e.key === 'P') { this.togglePause(); return; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'm') { this.toggleMusic(); return; }
      if (Replay.active) return; // watching: nothing to build
      const u = Game.UNITS.find(x => x.hotkey === e.key);
      if (u) this.togglePlacing(u.type);
      // Only a fog match has the button, so only a fog match has the key.
      else if (Game.fog && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === this.EXTRA_HOTKEYS.scout) {
        this.togglePlacing('scout');
      }
      else if (Game.fog && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === this.EXTRA_HOTKEYS.radio) {
        this.togglePlacing('radio');
      }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === this.EXTRA_HOTKEYS.drill) {
        this.togglePlacing('drill');
      }
    });
  },

  // In-game menu: Escape, or the corner button on touch. Pause is
  // singleplayer-only, so its row shows only where the Pause button would.
  initGameMenu() {
    const menu = document.getElementById('gameMenu');
    const optionsOpen = () => !document.getElementById('optionsOverlay').classList.contains('hidden');
    const pauseRow = document.getElementById('gmPause');
    this.gameMenuEl = menu;
    document.getElementById('menuBtn').addEventListener('click', () => this.openGameMenu());
    document.getElementById('gmResume').addEventListener('click', () => this.closeGameMenu());
    document.getElementById('gmOptions').addEventListener('click', () => Options.open());
    pauseRow.addEventListener('click', () => {
      this.togglePause();
      this.closeGameMenu();
    });
    menu.addEventListener('click', e => { if (e.target === menu) this.closeGameMenu(); });
    // Capture phase, so it runs before Options closes itself on the same press.
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || menu.classList.contains('hidden')) return;
      e._menuHandled = true;
      if (!optionsOpen()) this.closeGameMenu();
    }, true);
  },

  openGameMenu() {
    if (Replay.active || !Game.running || !Game.players[Game.me]) return;
    if (!document.getElementById('overlay').classList.contains('hidden')) return;
    const showPause = this.debugAllowed() && Game.winnerId === null;
    const pauseRow = document.getElementById('gmPause');
    pauseRow.classList.toggle('hidden', !showPause);
    pauseRow.textContent = (Tutorial.active ? Tutorial.userPaused : LocalServer.paused) ? 'Resume game' : 'Pause game';
    this.cancelPlacing();
    Radial.hide();
    this.gameMenuEl.classList.remove('hidden');
  },

  closeGameMenu() {
    this.gameMenuEl.classList.add('hidden');
    document.getElementById('gmExit').dispatchEvent(new Event('disarm'));
  },

  // Singleplayer only, and only while a match is live: LocalServer stops its
  // pump when paused, which freezes the sim since it advances on turn arrival.
  togglePause() {
    if (Replay.active) { Replay.setPaused(Replay.ended() ? false : !Replay.paused); return; }
    if (!this.debugAllowed() || !Game.players[Game.me] || Game.winnerId !== null) return;
    // A tutorial holds the match itself while the player reads; it keeps the
    // player's own pause apart from that (js/tutorial.js).
    if (Tutorial.active) { Tutorial.togglePause(); return; }
    LocalServer.setPaused(!LocalServer.paused);
  },

  // In a match only: the menu has no music to mute, and its own Options
  // checkbox for the same setting.
  toggleMusic() {
    if (!document.getElementById('overlay').classList.contains('hidden')) return;
    Options.set('musicOn', !Options.get('musicOn'));
  },

  // Build-bar icon per unit type, where the file name differs from the type.
  // Game.UNITS keeps its emoji `icon` field (it's sim data, and the goldens
  // hash it); the UI ignores it in favour of assets/icons/.
  UNIT_ICONS: { atombomb: 'nuke', hydrogenbomb: 'hbomb' },

  // Built once from Game.UNITS rather than written into the HTML, so adding a
  // structure to that table is the only edit a new building needs. Only the
  // live parts — cost, count, affordability — are rewritten per frame; redoing
  // the innerHTML at 60Hz would kill :active and the button's own press state.
  setupBuildBar() {
    const bar = document.getElementById('buildBar');
    this._barFog = null;
    this.rebuildBuildBar();

    // The scrollbar is hidden, so a plain vertical wheel scrolls the bar
    // sideways; otherwise a mouse user can't reach buttons past the fold.
    bar.addEventListener('wheel', e => {
      if (e.deltaY === 0 || bar.scrollWidth <= bar.clientWidth) return;
      e.preventDefault();
      bar.scrollLeft += e.deltaY;
    });

    // A single computed mask rather than two independently-toggled classes:
    // CSS can't cheaply combine "fade the left edge" and "fade the right edge"
    // as two separate mask-images layered on one element, so the gradient
    // stops are built here to cover all four fadeLeft/fadeRight combinations.
    const updateFade = () => {
      const fadeLeft = bar.scrollLeft > 1;
      const fadeRight = bar.scrollLeft < bar.scrollWidth - bar.clientWidth - 1;
      const stops = fadeLeft && fadeRight ? 'transparent, black 20px, black calc(100% - 20px), transparent'
        : fadeLeft ? 'transparent, black 20px'
        : fadeRight ? 'black calc(100% - 20px), transparent'
        : 'black, black';
      bar.style.maskImage = `linear-gradient(to right, ${stops})`;
      bar.style.webkitMaskImage = bar.style.maskImage;
    };
    bar.addEventListener('scroll', updateFade);
    new ResizeObserver(updateFade).observe(bar);

    // Drag-to-place. Delegated to the bar rather than bound per button, since
    // rebuildBuildBar replaces the buttons.
    bar.addEventListener('pointerdown', e => this.onBarDown(e));
    bar.addEventListener('pointermove', e => this.onBarMove(e));
    bar.addEventListener('pointerup', e => this.onBarUp(e));
    bar.addEventListener('pointercancel', e => this.onBarUp(e));
    // A rebuilt bar can change width without the bar's own box changing.
    this._updateBarFade = updateFade;
    updateFade();
  },

  // (Re)writes the buttons. fogOnly entries (the Scout) appear only in fog
  // matches, so syncBuildBar redoes this when that changes between matches.
  // The Drill and the Scout swap places so the fog entries sit together;
  // done here because Game.UNITS is sim data the goldens hash.
  rebuildBuildBar() {
    const bar = document.getElementById('buildBar');
    const fog = this._barFog = !!Game.fog;
    const units = Game.UNITS.filter(u => !u.fogOnly || fog);
    const si = units.findIndex(u => u.type === 'scout'), di = units.findIndex(u => u.type === 'drill');
    if (si >= 0 && di >= 0) [units[si], units[di]] = [units[di], units[si]];
    bar.innerHTML = units.map(u => {
      const key = u.hotkey || this.EXTRA_HOTKEYS[u.type] || '';
      const tip = this.UNIT_TIPS[u.type];
      const tipAttr = tip ? ` data-tip-title="${u.name}" data-tip-key="${key}" data-tip="${escapeHtml(tip())}"` : '';
      return `<button class="buildBtn" data-type="${u.type}"${tipAttr}>
         <span class="bbKey">${key}</span>
         <span class="bbIcon">${iconHtml(this.UNIT_ICONS[u.type] || u.type)}</span>
         <span class="bbBody">
           <span class="bbName">${u.name}</span>
           <span class="bbCost"></span>
         </span>
         <span class="bbCount"></span>
       </button>`;
    }).join('');

    this.buildEls = new Map();
    for (const btn of bar.querySelectorAll('.buildBtn')) {
      this.buildEls.set(btn.dataset.type, {
        btn,
        cost: btn.querySelector('.bbCost'),
        count: btn.querySelector('.bbCount')
      });
      btn.addEventListener('click', () => {
        // The click that ends a drag-to-place (mouse only; touch sends none)
        // must not also toggle the button it started on.
        if (this._barDragged) { this._barDragged = false; return; }
        this.togglePlacing(btn.dataset.type);
      });
    }
    if (this._updateBarFade) this._updateBarFade();
  },

  // Hover descriptions: any element with data-tip (optional data-tip-title,
  // data-tip-key). One delegated pointerover handles all of them, because
  // the build bar and radial rewrite their elements and a removed element
  // sends no pointerout. Mouse only.
  TIP_DELAY_MS: 350,

  setupTips() {
    const el = document.getElementById('tip');
    let shownFor = null, timer = 0;
    const hide = () => {
      clearTimeout(timer);
      shownFor = null;
      el.classList.add('hidden');
    };
    const show = target => {
      shownFor = target;
      const d = target.dataset;
      el.innerHTML =
        (d.tipTitle ? `<div class="tipTitle">${escapeHtml(d.tipTitle)}` +
          (d.tipKey ? `<span class="tipKey">${escapeHtml(d.tipKey.toUpperCase())}</span>` : '') + '</div>' : '') +
        `<div class="tipBody">${escapeHtml(d.tip)}</div>`;
      el.classList.remove('hidden');
      // Above the element, centred on it; below instead when there is no room
      // (the buttons along the top edge), and never off either side.
      const r = target.getBoundingClientRect(), m = 6;
      const w = el.offsetWidth, h = el.offsetHeight;
      const x = Math.max(m, Math.min(window.innerWidth - w - m, r.left + r.width / 2 - w / 2));
      const y = r.top - h - m >= m ? r.top - h - m : Math.min(window.innerHeight - h - m, r.bottom + m);
      el.style.left = Math.round(x) + 'px';
      el.style.top = Math.round(y) + 'px';
    };
    document.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      const target = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (target && target === shownFor) return;
      // Already reading one: the next appears at once, as a row of buttons
      // swept across should. From nothing, wait, so tips do not flicker up
      // every time the cursor crosses the HUD on its way somewhere else.
      const wasShown = !el.classList.contains('hidden');
      hide();
      if (!target) return;
      if (wasShown) show(target);
      else timer = setTimeout(() => { if (target.isConnected) show(target); }, this.TIP_DELAY_MS);
    });
    // A press is the player acting on the thing, not asking about it.
    document.addEventListener('pointerdown', hide, true);
    document.documentElement.addEventListener('pointerleave', hide);
    window.addEventListener('blur', hide);
  },

  // Cheap enough for every frame; a no-op unless the match's fog setting
  // differs from what the bar was built for.
  syncBuildBar() {
    if (this._barFog !== !!Game.fog) this.rebuildBuildBar();
  },

  // Drag-to-place: dragging a build button up onto the map arms it and
  // carries the ghost; letting go places it. Mostly for touch. Only an
  // upward drag starts one; sideways still scrolls the bar.
  BAR_DRAG_START: 12,   // px, the same tolerance Input uses for tap-vs-drag
  // A finger covers the spot it is on, so on touch the ghost rides this far
  // above it.
  BAR_DRAG_LIFT: 56,

  onBarDown(e) {
    this._barDragged = false;
    this.barDrag = null;
    const btn = e.target.closest('.buildBtn');
    if (!btn || e.button !== 0 || !Game.running) return;
    this.barDrag = {
      id: e.pointerId, type: btn.dataset.type, btn, x0: e.clientX, y0: e.clientY,
      lift: e.pointerType === 'mouse' ? 0 : this.BAR_DRAG_LIFT, active: false
    };
  },

  onBarMove(e) {
    const d = this.barDrag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.active) {
      const up = d.y0 - e.clientY;
      if (up < this.BAR_DRAG_START || up < Math.abs(e.clientX - d.x0)) return;
      if (this.placing !== d.type) this.togglePlacing(d.type);
      if (this.placing !== d.type) { this.barDrag = null; return; }
      d.active = true;
      // Touch is captured to the button already; a mouse is not, and would
      // stop reporting here the moment it left the bar.
      try { d.btn.setPointerCapture(e.pointerId); } catch {}
    }
    // Put away mid-drag (Escape, or the player died).
    if (this.placing !== d.type) { this.barDrag = null; return; }
    this.placeHover = this.barDragOverMap(e) ? this.placeTileAt(e.clientX, e.clientY - d.lift) : -1;
  },

  onBarUp(e) {
    const d = this.barDrag;
    if (!d || e.pointerId !== d.id) return;
    this.barDrag = null;
    if (!d.active) return;
    this._barDragged = true;
    if (this.placing !== d.type) return;
    // Let go back over the HUD, or the browser took the gesture: put it away.
    if (e.type === 'pointercancel' || !this.barDragOverMap(e)) { this.cancelPlacing(); return; }
    this.onTap(e.clientX, e.clientY - d.lift);
    // A refused placement stays armed for a follow-up tap; with a mouse the
    // hover takes the ghost back over, but touch has none, so it would be
    // left standing where the finger lifted.
    if (d.lift) this.placeHover = -1;
  },

  // Whether the pointer itself (not the lifted ghost) is over the map rather
  // than the HUD.
  barDragOverMap(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return !!el && el.id === 'game';
  },

  // The tile a tap at this screen point would act on with the current build
  // armed: an existing same-type structure nearby (upgrade), else the
  // rail/coast snap, else the tile itself. Mirrors onTap's own resolution so
  // the ghost is honest about what a tap will do.
  placeTileAt(sx, sy) {
    const raw = Render.screenToTile(sx, sy);
    const near = Render.findStructureNear(sx, sy, this.placing) ||
      Game.upgradeTargetNear(Game.me, this.placing, raw);
    if (near) return near.tile;
    const railSnap = this.placing === 'city' ? Render.findRailSnapTile(sx, sy) : -1;
    const base = railSnap >= 0 ? railSnap : raw;
    // Structures keep STRUCTURE_MIN_DIST apart, so a click near one lands on
    // the nearest clear tile (the coast, for a Port). structureSiteNear
    // answers -1 for warships and other non-structures, which get the raw tile.
    const site = Game.structureSiteNear(Game.me, this.placing, base);
    return site >= 0 ? site : base;
  },

  // Puts away whatever build is armed — structure, nuke, warship or the debug
  // nuke. Shared by Escape and right-click. Returns whether anything was armed,
  // so right-click can tell "cancelled a placement" from "nothing to cancel".
  cancelPlacing() {
    const wasArmed = !!this.placing;
    this.placing = null;
    this.placeHover = -1;
    this.debugNukeType = null;
    this.debugNukeSrc = -1;
    return wasArmed;
  },

  // Arming is a toggle: the same button, or the same hotkey, puts it away.
  togglePlacing(type) {
    if (!Game.running) return;
    this.placing = this.placing === type ? null : type;
    this.placeHover = -1;
    this.clearShipSelection();
    if (this.placing) { Radial.hide(); this.hideHoverPanel(); }
  },

  // Arms the debug panel's two-click nuke flow (see Game.debugNuke and
  // onTap's 'debugnuke' branch). Same toggle shape as togglePlacing, but
  // outside Game.UNITS/the build bar entirely, so it carries its own state
  // (debugNukeType/debugNukeSrc) rather than reusing `placing` as the type.
  armDebugNuke(type) {
    if (!Game.running) return;
    // Arms DEBUG BYPASS #2 (see onTap's 'debugnuke' branch) — singleplayer
    // only, for the same reason as the gold buttons: Game.debugNuke has no
    // intent behind it and never will.
    if (!this.debugAllowed()) return;
    if (this.placing === 'debugnuke' && this.debugNukeType === type) {
      this.placing = null;
      this.debugNukeType = null;
      this.debugNukeSrc = -1;
      return;
    }
    this.placing = 'debugnuke';
    this.debugNukeType = type;
    this.debugNukeSrc = -1;
    this.placeHover = -1;
    this.clearShipSelection();
    Radial.hide();
    this.hideHoverPanel();
  },

  // Arms the debug "peace offer" tool: the next tap on a nation makes that
  // nation send you an alliance request. See onTap's 'debugpeace' branch.
  // DEBUG BYPASS #4 — singleplayer only, same reasoning as the gold buttons.
  // Gives up the player's land and eliminates them on the spot, which brings
  // up the defeat screen without playing a match out. The bots carry on.
  debugForfeit() {
    if (!this.debugAllowed() || !Game.running) return;
    const me = Game.players[Game.me];
    if (!me || !me.alive) return;
    for (const tile of [...me.tiles]) Game.setOwner(tile, NEUTRAL);
    me.troops = 0;
    Game.eliminatePlayer(me);
  },

  armDebugPeace() {
    if (!Game.running) return;
    // DEBUG BYPASS #3 — singleplayer only, same reasoning as armDebugNuke.
    if (!this.debugAllowed()) return;
    if (this.placing === 'debugpeace') { this.placing = null; return; }
    this.placing = 'debugpeace';
    this.placeHover = -1;
    this.clearShipSelection();
    Radial.hide();
    this.hideHoverPanel();
  },

  // Empties the ship selection, warships and scouts both.
  clearShipSelection() {
    this.selectedWarships.clear();
    this.selectedScouts.clear();
  },

  // The player's own warships and scouts whose hull falls inside a
  // shift-drag box (CSS-pixel client coordinates). Replaces the previous
  // selection; an empty box clears it. A scout the fog hides can't be picked.
  selectShipsInBox(x0, y0, x1, y1) {
    this.clearShipSelection();
    for (const w of Game.warships) {
      if (w.owner !== Game.me) continue;
      const p = Render.warshipClientPos(w);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) this.selectedWarships.add(w);
    }
    for (const s of Game.scouts) {
      if (s.owner !== Game.me || !Render.canSee(Game.scoutTile(s))) continue;
      const p = Render.scoutClientPos(s);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) this.selectedScouts.add(s);
    }
  },

  // A shift-click (not a drag) on a single ship — replaces the selection with
  // just the nearest one, or clears it if the click didn't land on any.
  selectShipAt(sx, sy) {
    const TAP_RADIUS = 22;   // CSS px, roughly matching the drawn hull size
    let best = null, bestDist = TAP_RADIUS, bestIsScout = false;
    for (const w of Game.warships) {
      if (w.owner !== Game.me) continue;
      const p = Render.warshipClientPos(w);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d <= bestDist) { best = w; bestDist = d; }
    }
    for (const s of Game.scouts) {
      if (s.owner !== Game.me || !Render.canSee(Game.scoutTile(s))) continue;
      const p = Render.scoutClientPos(s);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d <= bestDist) { best = s; bestDist = d; bestIsScout = true; }
    }
    this.clearShipSelection();
    if (best) (bestIsScout ? this.selectedScouts : this.selectedWarships).add(best);
  },

  // --- Fog of war: who the viewer may be told about ---------------------------
  // docs/fog-of-war.md, 'Meeting a nation'. Contact is sim state
  // (Game.hasMet). Everything that names a nation goes through nameOf();
  // everything that shows details or acts on one asks knows() first. Both
  // say yes whenever Render.fogActive() is false.
  UNKNOWN_NATION: 'Unknown nation',

  knows(id) {
    return !Render.fogActive() || Game.hasMet(Game.me, id);
  },

  // `fallback` is what the caller already printed for an id that names no
  // player at all (a debug nuke has no owner).
  nameOf(id, fallback) {
    const p = Game.players[id];
    if (!p) return fallback;
    return this.knows(id) ? p.name : this.UNKNOWN_NATION;
  },

  // Ticket #30: say so when an ally marks a target (our own mark needs no
  // announcement — we just clicked it). Read-only over Player.targets; a mark
  // is identified by who placed it and when, so each one flashes once.
  seenMarks: new Set(),

  announceTargets(me) {
    for (const allyId of me.allies) {
      const ally = Game.players[allyId];
      for (const t of ally.targets) {
        const key = allyId + ':' + t.at;
        if (this.seenMarks.has(key)) continue;
        this.seenMarks.add(key);
        if (Game.elapsed - t.at >= Game.TARGET_DURATION) continue;
        // Fog: allies do not share contacts, so the nation marked may be one
        // we have not met.
        this.flash(this.nameOf(allyId) + ' marked ' + this.nameOf(t.id) + ' as a target', 'target');
      }
    }
  },

  // `icon` (optional) is an assets/icons name shown before the text.
  flash(text, icon) {
    this.flashText = text;
    this.flashIcon = icon || null;
    this.flashUntil = performance.now() + 1600;
  },

  reset() {
    this.diplo = null;
    this.dismissed.clear();
    this.placing = null;
    this.debugOpen = false;
    this.debugNukeType = null;
    this.debugNukeSrc = -1;
    this.placeHover = -1;
    this.clearShipSelection();
    this.syncBuildBar();
    this._scoutReasonTick = -1;
    this.resetRatio();
    this.flashUntil = 0;
    this.spawnFlashUntil = 0;
    this.spawnBannerOpen = false;
    this.spawnSent = false;
    this._frontChipByRef = null;
    this._nukeRowByRef = null;
    this._nukeThreat = null;
    // Cleared here because a restart's Game.init() resets winnerId but not
    // this latch (see checkEndGame).
    this.endGameHandled = false;
    // Cleared alongside endGameHandled for the same reason — see checkEndGame.
    this.lossShown = false;
    document.getElementById('frontsRow').classList.add('hidden');
    document.getElementById('frontsRow').innerHTML = '';
    document.getElementById('diploBanner').classList.add('hidden');
    document.getElementById('nukeAlert').classList.add('hidden');
    document.getElementById('nukeAlert').innerHTML = '';
    document.getElementById('traitorChip').textContent = '';
    // The leaderboard is not redrawn during the spawn countdown (update()
    // returns early), so without this the previous match's standings stay on
    // screen until the new match's first frame after it.
    document.getElementById('leaderboard').innerHTML = '';
    this.lastLeaderboard = 0;
    // A restart shows the menu overlay for a beat before updateCatchup runs,
    // so hide any stale banner now.
    document.getElementById('catchupBanner').classList.add('hidden');
    Radial.hide();
    this.hideHoverPanel();
  },

  // Only the human's own territory hasn't been placed yet — the HUD hides
  // since they own nothing, and a banner takes over prompting the tap that
  // places their capital.
  enterSpawnSelect() {
    document.getElementById('hud').classList.add('hidden');
    const banner = document.getElementById('spawnBanner');
    banner.classList.remove('hidden');
    banner.classList.remove('warn');
    this.spawnBannerOpen = true;
    this.spawnSent = false;
    document.getElementById('spawnBannerText').textContent = Game.fog ? this.SPAWN_FOG_HINT : this.SPAWN_HINT;
    if (Game.fog) this.centerOnOwnSpawn();
  },

  // Fog matches place everyone before the first frame (docs/fog-of-war.md), and
  // the rest of the map is black, so the view opens on the player's own spawn
  // rather than the whole map. Camera only; the sim is read, never written.
  centerOnOwnSpawn() {
    const tile = Game.humanReserveTiles[Game.me];
    if (tile === undefined) return;
    Render.jumpToTile(tile % GameMap.width, (tile / GameMap.width) | 0);
    // About 100 tiles across the shorter side. clampCamera bounds it per frame.
    Render.cam.scale = Math.min(window.innerWidth, window.innerHeight) / 100;
  },

  exitSpawnSelect() {
    this.spawnBannerOpen = false;
    document.getElementById('spawnBanner').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
  },

  // True between the two calls above. A tap only sends a `spawn` intent;
  // the banner comes down when the sim says the spawn phase is over, which
  // update() watches for.
  spawnBannerOpen: false,

  // A spawn intent is in flight; only changes the banner text. A second
  // tap may still send another (first applied wins), so a refused spawn
  // can't wedge the player.
  spawnSent: false,

  SPAWN_HINT: 'Tap the map to place your capital',
  SPAWN_SENT_HINT: 'Placing your capital…',
  // Fog matches: spawns are random and fixed, so there is nothing to tap.
  SPAWN_FOG_HINT: 'You start here',

  flashSpawn(text) {
    this.spawnFlashText = text;
    this.spawnFlashUntil = performance.now() + 1400;
  },

  // Troops the ratio slider commits, shown next to the percent. Same
  // Math.floor(me.troops * this.ratio) the launchers use. Called on slider
  // input and every update().
  updateRatioTroops() {
    const troops = this._meTroops || 0;
    document.getElementById('ratioTroops').textContent =
      '(' + Math.floor(troops * this.ratio).toLocaleString() + ')';
  },

  updateSpawnBanner() {
    const el = document.getElementById('spawnBannerText'), banner = document.getElementById('spawnBanner');
    if (performance.now() < this.spawnFlashUntil) {
      el.textContent = this.spawnFlashText;
      banner.classList.add('warn');
      return;
    }
    banner.classList.remove('warn');
    // Spawn-phase countdown. Game.spawnPhaseTicks drives it; Game.ticks stays
    // at 0 for the whole spawn phase.
    const remaining = Math.max(0, Math.ceil((Game.SPAWN_PHASE_TURNS - Game.spawnPhaseTicks) * Game.TICK_DT));
    const hint = Game.fog ? this.SPAWN_FOG_HINT : this.spawnSent ? this.SPAWN_SENT_HINT
      : Tutorial.active ? Tutorial.SPAWN_HINT : this.SPAWN_HINT;
    // Solo matches start on the tap, so there is no deadline worth showing.
    el.textContent = Game.humanCount > 1 || Game.fog ? hint + ' · ' + remaining + 's' : hint;
  },

  hoverId: -1,
  // The exact tile under the cursor, not just the nation it belongs to —
  // Render needs this to tell a hovered nation's untouched mainland apart
  // from a piece of the same nation that's been cut off and is sitting
  // right there enclosed, since both share the same hoverId.
  hoverTile: -1,

  // Quick-glance stats for the nation under the mouse, after OpenFront's
  // hover-to-inspect bar. Only meaningful with a mouse — touch has no hover
  // state, so Input only calls this for pointerType 'mouse'.
  showHoverPanel(playerId) {
    const p = Game.players[playerId];
    if (!p || !p.alive) { this.hideHoverPanel(); return; }
    // Fog: nothing about a nation we have not met. Land we can see always
    // belongs to one we have, so this is the boat case: a boat sailing through
    // discovered water does not introduce whoever sent it.
    if (!this.knows(playerId)) { this.hideHoverPanel(); return; }
    this.hoverId = playerId;
    const el = document.getElementById('hoverPanel');
    el.classList.remove('hidden');
    document.getElementById('hpSwatch').style.background =
      `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
    const nameEl = document.getElementById('hpName');
    const title = Progress.titleOf(playerId);
    const nameKey = p.name + '\n' + title;
    if (nameEl._key !== nameKey) {
      nameEl._key = nameKey;
      nameEl.textContent = p.name;
      if (title) nameEl.insertAdjacentHTML('beforeend', ` <small class="playerTitle">${escapeHtml(title)}</small>`);
    }
    // Runs every frame (refreshHoverPanel), so only rewritten on a change.
    const subEl = document.getElementById('hpSub');
    const sub =
      (p.isBot ? iconHtml('bot') + ' ' : '') +
      (p.isTribe ? 'Tribe' : '') +
      (p.team ? ' Team ' + escapeHtml(p.team) + (Game.onSameTeam(Game.me, p.id) ? ' (teammate)' : '') : '') +
      (Game.areAllied(Game.me, p.id) && !Game.onSameTeam(Game.me, p.id) ? ' ' + iconHtml('ally') + ' Allied' : '') +
      (Game.isTraitor(p) ? ' ' + iconHtml('traitor') + ' Traitor' : '') +
      (!p.isTribe && p.id !== Game.me && Game.me >= 0 && !Game.canTrade(Game.me, p.id) ? ' ' + iconHtml('embargo') + ' No trade' : '');
    if (subEl._html !== sub) { subEl._html = sub; subEl.innerHTML = sub; }
    this.updateBotFace(p);

    // Same reading as the player's own bar: home reserve against cap, with the
    // marching slice stacked on top so a fully-committed nation still shows as
    // thin at home even while its total army looks large.
    const max = Game.maxTroops(p);
    const marching = Game.marchingTroops(p.id);
    const homePct = Math.max(0, Math.min(100, (p.troops / max) * 100));
    const marchPct = Math.max(0, Math.min(100 - homePct, (marching / max) * 100));
    document.getElementById('hpPopHome').style.width = homePct.toFixed(1) + '%';
    const marchEl = document.getElementById('hpPopMarch');
    marchEl.style.left = homePct.toFixed(1) + '%';
    marchEl.style.width = marchPct.toFixed(1) + '%';
    document.getElementById('hpPopValue').textContent = formatPop(p.troops);
    document.getElementById('hpPopMax').textContent = formatPop(max);

    // Treasuries are public, so a rival's gold is shown. The per-second
    // rate is left out: it is the same formula for everyone.
    document.getElementById('hpGoldValue').textContent = formatGoldTight(p.gold);
  },

  // A bot's opinion of the player as a face: its relations entry, banded the
  // same way its AI reads it (ai.js FRIENDLY / DISTRUSTFUL). Bots only.
  updateBotFace(p) {
    const el = document.getElementById('hpFace');
    if (!p.isBot || Game.me < 0 || p.id === Game.me) { el.textContent = ''; el.dataset.mood = ''; return; }
    const rel = Game.relation(p, Game.me);
    const mood = rel >= AI.FRIENDLY ? 'mood-friendly' : rel >= AI.DISTRUSTFUL ? 'mood-neutral' : 'mood-hostile';
    if (el.dataset.mood !== mood) { el.dataset.mood = mood; el.innerHTML = iconHtml(mood); }
  },

  hideHoverPanel() {
    this.hoverId = -1;
    this.hoverTile = -1;
    document.getElementById('hoverPanel').classList.add('hidden');
  },

  // Called every frame so the panel's live numbers (troops ticking up, tiles
  // lost to an attack) track the same nation without needing the mouse to move.
  refreshHoverPanel() {
    if (this.hoverId < 0) return;
    if (Radial.isOpen()) { this.hideHoverPanel(); return; }
    this.showHoverPanel(this.hoverId);
  },

  onTap(sx, sy) {
    if (Replay.active) return; // watching: a tap is not an order
    if (Game.spawning) {
      const tile = Render.screenToTile(sx, sy);
      if (tile < 0) return;
      // Advisory: the Executor re-runs spawnBlockReason and its verdict
      // counts. Running it here refuses an illegal tap at once, with the reason.
      const reason = Game.spawnBlockReason(tile);
      if (reason) { this.flashSpawn(reason); return; }
      Transport.sendIntent(Protocol.intent.spawn(tile));
      // The banner stays up until the sim leaves the spawn phase — see
      // spawnBannerOpen and update(). Nothing has been placed yet.
      this.spawnSent = true;
      return;
    }
    if (!Game.running) return;

    // Debug two-click nuke: first tap sets the launch point, second fires
    // via Game.debugNuke and disarms. Any tile works for both.
    if (this.placing === 'debugnuke') {
      const tile = Render.screenToTile(sx, sy);
      if (tile < 0) { this.flash('Off the map'); return; }
      if (this.debugNukeSrc < 0) {
        this.debugNukeSrc = tile;
        return;
      }
      // DEBUG BYPASS #2: Game.debugNuke mutates the sim directly (no Silo,
      // cooldown or gold) and has no intent, by design (§4). Singleplayer
      // only: armDebugNuke refuses when the transport is not local.
      if (!this.debugAllowed()) return;
      Game.debugNuke(this.debugNukeType, this.debugNukeSrc, tile);
      this.placing = null;
      this.debugNukeType = null;
      this.debugNukeSrc = -1;
      this.placeHover = -1;
      return;
    }

    // Debug panel's peace-offer tool: tap a nation and it sends you a request.
    // DEBUG BYPASS #3 — writes Game.requests directly, since an alliance intent
    // always names the sender as the acting player and so can only ever be sent
    // as you. Singleplayer only (armDebugPeace refuses otherwise). Stays armed so
    // several nations can be tapped in a row; Esc or the button disarms it.
    if (this.placing === 'debugpeace') {
      if (!this.debugAllowed()) return;
      const tile = Render.screenToTile(sx, sy);
      const owner = tile < 0 ? -1 : GameMap.owner[tile];
      if (owner < 0 || owner === Game.me) { this.flash('Tap another nation'); return; }
      const from = Game.players[owner];
      // The offer timer and cooldown are not what is being tested, so a stale
      // cooldown must not block it — but a tribe or an existing pact still does.
      Game.lastRequestAt.delete(owner + ':' + Game.me);
      if (!Game.requestAlliance(owner, Game.me)) {
        this.flash(from.isTribe ? 'Tribes do not ally'
          : Game.areAllied(owner, Game.me) ? 'Already allied'
          : 'Offer already pending');
      }
      return;
    }

    // Warship: a click means 'launch one toward here'.
    // Game.resolveWarshipLaunch picks the nearest owned Port and snaps the
    // click to open water. No upgrade path, and it spawns instantly.
    if (this.placing === 'warship') {
      const tile = Render.screenToTile(sx, sy);
      const reason = Game.warshipBlockReason(Game.me, tile);
      if (reason) {
        this.flash(reason);
        // Those two reasons are about this click only, so stay armed for
        // another. Anything else (no Port, no gold, fleet capped) can't succeed
        // anywhere right now, so disarm.
        if (reason !== 'No open water there' && reason !== 'No sea route there') {
          this.placing = null;
          this.placeHover = -1;
        }
        return;
      }
      Transport.sendIntent(Protocol.intent.buildUnit('warship', tile));
      this.placing = null;
      this.placeHover = -1;
      return;
    }

    // The Drill (Battle Royale): a click on the player's own land, instant, one
    // per match. Its own reasons (Game.drillBlockReason) rather than
    // buildBlockReason's, since it never lands in Game.buildings. Placement
    // is a normal build_unit intent; the executor routes it to Game.placeDrill.
    if (this.placing === 'drill') {
      const tile = Render.screenToTile(sx, sy);
      const reason = Game.drillBlockReason(Game.me, tile);
      if (reason) {
        this.flash(reason);
        if (reason !== 'Your own land only') { this.placing = null; this.placeHover = -1; }
        return;
      }
      Transport.sendIntent(Protocol.intent.buildUnit('drill', tile));
      this.placing = null;
      this.placeHover = -1;
      return;
    }

    // Scout (fog matches): the click names where to send it, any tile at all,
    // black included. Nothing here may look at the map under the tap: a
    // refusal, or any difference in feedback, would say what an undiscovered
    // tile is. scoutBlockReason is built so that none of its reasons does
    // (gold, Port, cap), which is also why a tile that is off the map is the
    // only refusal that keeps it armed.
    if (this.placing === 'scout') {
      const tile = Render.screenToTile(sx, sy);
      const reason = Game.scoutBlockReason(Game.me, tile);
      if (reason) {
        this.flash(reason);
        if (reason !== 'Off the map') { this.placing = null; this.placeHover = -1; }
        return;
      }
      Transport.sendIntent(Protocol.intent.buildUnit('scout', tile));
      this.placing = null;
      this.placeHover = -1;
      return;
    }

    // Atom/Hydrogen Bomb and MIRV: 'strike here'. Any tile is a legal
    // target; Game.resolveNukeLaunch picks the launch point. The executor
    // routes 'mirv' to Game.launchMirv.
    if (this.placing === 'atombomb' || this.placing === 'hydrogenbomb' || this.placing === 'mirv') {
      const tile = Render.screenToTile(sx, sy);
      const reason = Game.nukeBlockReason(Game.me, this.placing, tile);
      if (reason) {
        this.flash(reason);
        this.placing = null;
        this.placeHover = -1;
        return;
      }
      Transport.sendIntent(Protocol.intent.buildUnit(this.placing, tile));
      this.placing = null;
      this.placeHover = -1;
      return;
    }

    // A selected fleet consumes the next tap as a relocate order, then the
    // selection is dropped. Whether the tap is consumed is decided up front
    // (an intent can't answer): if no reachable water is near the tap, it
    // falls through to a normal attack. Water nearby that no selected ship can
    // route to still consumes the tap; the Executor drops that order.
    //
    // Fog: scouts go wherever the tap was (always consumed). A warship needs
    // discovered water, so it stays put on a tap in the black and the hint
    // line says so.
    if (this.selectedWarships.size || this.selectedScouts.size) {
      const tile = Render.screenToTile(sx, sy);
      // The order names ids, not objects. Ships already sunk are skipped
      // here; the Executor drops any that sink before the turn lands.
      const unitIds = [], scoutIds = [];
      for (const w of this.selectedWarships) if (Game.warshipById(w.id)) unitIds.push(w.id);
      for (const s of this.selectedScouts) if (Game.scoutById(s.id)) scoutIds.push(s.id);
      this.clearShipSelection();
      const reachable = tile >= 0 && Render.canSee(tile) &&
        Game.nearestWaterNear(tile, Game.NEAREST_COAST_MAX_DIST) >= 0;
      let consumed = false;
      if (scoutIds.length && tile >= 0) {
        Transport.sendIntent(Protocol.intent.moveScout(scoutIds, tile));
        consumed = true;
      }
      if (unitIds.length && reachable) {
        // The raw clicked tile travels, not the snapped one: the snap is a rule
        // of the sim (moveWarships does it) and every client must perform it
        // identically rather than trust one client's answer.
        Transport.sendIntent(Protocol.intent.moveWarship(unitIds, tile));
        consumed = true;
      } else if (unitIds.length && scoutIds.length && tile >= 0) {
        this.flash('Warships stay put · they only sail to discovered water');
      }
      if (consumed) return;
    }

    if (this.placing) {
      // A tap anywhere on an existing same-type structure's drawn disc, or
      // within the minimum spacing around it (Game.upgradeTargetNear), upgrades
      // it instead of placing a new one. Checked before screenToTile because
      // the disc extends past its backing tile.
      const existing = Render.findStructureNear(sx, sy, this.placing) ||
        Game.upgradeTargetNear(Game.me, this.placing, Render.screenToTile(sx, sy));
      if (existing) {
        const reason = Game.upgradeBlockReason(Game.me, existing.tile);
        if (reason) { this.flash(reason); return; }
        Transport.sendIntent(Protocol.intent.upgradeStructure(existing.tile));
        this.placing = null;
        this.placeHover = -1;
        return;
      }

      const railSnap = this.placing === 'city' ? Render.findRailSnapTile(sx, sy) : -1;
      const base = railSnap >= 0 ? railSnap : Render.screenToTile(sx, sy);
      // Structures keep a minimum distance apart, so the click lands on the
      // nearest tile of the player's own land that is clear of every other
      // structure — and, for a Port, on the coast (see Game.structureSiteNear).
      // With no such tile nearby the raw one goes through, so the refusal
      // below can say why.
      const site = Game.structureSiteNear(Game.me, this.placing, base);
      const tile = site >= 0 ? site : base;
      const reason = Game.buildBlockReason(Game.me, this.placing, tile);
      if (reason) {
        this.flash(reason);
        // Most refusals stay armed and say why, since near misses are common.
        // A tap off your own land (or off the map) is deliberate, so it cancels.
        if (reason === 'Your own land only') { this.placing = null; this.placeHover = -1; }
        return;
      }
      // The snapped tile is what goes on the wire: findRailSnapTile reads
      // screen pixels, so the snap is click interpretation, not a sim rule.
      Transport.sendIntent(Protocol.intent.buildUnit(this.placing, tile));
      // One build per arming, as OpenFront's menu does — the next city costs
      // double, which should be a decision rather than something you walk into
      // by tapping twice.
      this.placing = null;
      this.placeHover = -1;
      return;
    }

    const tile = Render.screenToTile(sx, sy);
    if (tile < 0) return;
    // Fog: a plain tap on the black does nothing at all. Anything it did would
    // answer what is under it: an attack that starts names the owner, and the
    // quick-boat refusal below only ever fires for land near a coast.
    if (!Render.canSee(tile)) return;
    const target = GameMap.owner[tile];
    if (target === WATER || target === Game.me) return;

    // A patch of their territory walled in by our land falls for free, and
    // every such patch of theirs falls on the same tap (this is what makes
    // post-nuke cleanup bearable).
    //
    // No early return: whatever of theirs still touches our border falls
    // through to the ordinary attack below, which costs nothing if no frontier
    // is left.
    //
    // The intent carries only the tapped tile; the Executor derives the
    // pockets and the target from sim state, so every client agrees.
    if (target >= 0) Transport.sendIntent(Protocol.intent.annexRegion(tile));

    // Land only: expands our whole border with that nation (or neutral land)
    // on the tapped tile's own landmass, so the same enemy on two islands is
    // two fronts (see Game.launchAttack's landmassId). Boats come from the
    // radial, except the quick-boat short hop below.
    //
    // Both intents go out in this order, which is the order they are applied:
    // the annexation resolves before the attack scans the frontier.
    //
    // The troop count is absolute; the slider ratio is client-local (§4).
    const me = Game.players[Game.me];
    const troops = Math.floor(me.troops * this.ratio);

    // Quick boat: a tap on a target we don't touch by land but that is a
    // short sail away sends the radial's `boat` intent. Past
    // QUICK_BOAT_MAX_STEPS it needs the radial. Checked on click, never hover.
    if (!this.touchesByLand(tile, target)) {
      const hop = this.quickBoatCheck(tile, troops);
      if (hop === 'go') { Transport.sendIntent(Protocol.intent.boat(tile, troops)); return; }
      if (hop) { this.flash(hop); return; }
    }
    Transport.sendIntent(Protocol.intent.attack(target, troops, tile));
  },

  // How far (in sea-route tiles, from our nearest coast to the landing tile)
  // a plain tap will send a boat on its own. Boats sail 10 tiles/sec
  // (Game.BOAT_SPEED), so 60 is a ~6s crossing: a strait or a nearby island,
  // not an ocean. The capped search also keeps the click cheap — seaPath's
  // node guard scales with this (SEA_PATH_NODES_PER_STEP × steps).
  QUICK_BOAT_MAX_STEPS: 60,

  // Does any of our border tiles on `tile`'s landmass neighbour `target`?
  // Same scan Game.refreshFrontier does for a landmass-scoped attack, so this
  // is exactly "would the land attack have a frontier". Read-only, and
  // perimeter-sized.
  touchesByLand(tile, target) {
    const lm = GameMap.landmassId[tile];
    const nb = new Int32Array(4);
    for (const i of Game.players[Game.me].borderTiles) {
      if (GameMap.landmassId[i] !== lm) continue;
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) if (GameMap.owner[nb[k]] === target) return true;
    }
    return false;
  },

  // null = not a short hop (fall back to the land attack); 'go' = send the
  // boat; any other string = a short hop that can't launch right now, and why.
  // Advisory only — the Executor re-validates the boat intent a turn later.
  quickBoatCheck(tile, troops) {
    const landing = Game.nearestOwnedCoast(tile);
    if (landing < 0) return null;
    if (!Game.nearestCoastPath(Game.me, landing, this.QUICK_BOAT_MAX_STEPS)) return null;
    return Game.navalInvasionBlockReason(Game.me, tile, troops) || 'go';
  },

  update() {
    const me = Game.players[Game.me];
    if (!me) return;

    // Dev-only cheats: shown for the whole match, hidden before one exists
    // and whenever the transport is not local (see the DEBUG BYPASS notes in
    // setup()). The panel stays closed until the toggle opens it.
    const debugToggle = document.getElementById('debugToggle');
    debugToggle.classList.toggle('hidden', !this.debugAllowed());
    debugToggle.textContent = this.debugOpen ? 'Debug ▾' : 'Debug ▸';
    document.getElementById('debugPanel').classList.toggle('hidden', !this.debugAllowed() || !this.debugOpen);

    const pauseBtn = document.getElementById('pauseBtn');
    pauseBtn.classList.toggle('hidden', !this.debugAllowed() || Game.winnerId !== null);
    // The tutorial's own hold is not the player's pause, and the button only
    // speaks for the player's.
    const paused = Tutorial.active ? Tutorial.userPaused : LocalServer.paused;
    pauseBtn.classList.toggle('paused', paused);
    // Only rewritten on a change: this runs every frame, and replacing the
    // button's contents at 60Hz would reload its icon and break :active.
    if (pauseBtn._paused !== paused) {
      pauseBtn._paused = paused;
      pauseBtn.innerHTML = paused ? iconHtml('play') + ' Resume' : iconHtml('pause') + ' Pause';
    }

    const musicBtn = document.getElementById('musicBtn');
    const musicOn = Options.get('musicOn');
    if (musicBtn._on !== musicOn) {
      musicBtn._on = musicOn;
      musicBtn.innerHTML = iconHtml(musicOn ? 'music' : 'music-off');
    }

    this.syncBuildBar();

    // The HUD stays hidden until the human has claimed a capital — only the
    // banner (and the leaderboard, already outside #hud) is live.
    if (Game.spawning) { this.updateSpawnBanner(); return; }

    // The spawn phase is over. The tap that ended it did so a turn ago and
    // could not know it had worked, so the handoff from banner to HUD happens
    // here, off the simulation's own state, rather than on the click.
    if (this.spawnBannerOpen) this.exitSpawnSelect();
    this.announceTargets(me);

    const max = Game.maxTroops(me);
    const growth = Game.growthPerSecond(me);
    const marching = Game.marchingTroops(me.id);
    // Bar, number, rate and colour all read the home reserve, so they can never
    // disagree. Committing half your troops halves the bar on the spot and puts
    // you lower on the growth curve at the same moment.
    const ratio = Math.min(1, me.troops / max);
    this._meTroops = me.troops;

    document.getElementById('troopValue').textContent = Math.floor(me.troops).toLocaleString();
    document.getElementById('troopCap').textContent = Math.round(max).toLocaleString();
    this.updateRatioTroops();

    // Colour flips at the curve's own optimum (~42%), not at an observed rate
    // delta: conquering land raises the cap, which lifts the rate even past the
    // peak, so a delta-based reading stays green when it should not.
    const peak = Game.peakGrowthRatio(me);

    const growthEl = document.getElementById('troopGrowth');
    if (me.troops >= max - 0.5) {
      growthEl.textContent = 'full';
      growthEl.classList.add('stalled');
    } else {
      growthEl.textContent = '+' + growth.toFixed(0) + '/s';
      growthEl.classList.toggle('stalled', ratio >= peak);
    }

    document.getElementById('popBarPeak').style.left = (peak * 100).toFixed(1) + '%';

    const fillEl = document.getElementById('popBarFill');
    const homePct = ratio * 100;
    fillEl.style.width = homePct.toFixed(1) + '%';

    // Same split as the hover panel's bar: home reserve, then whatever's
    // currently out on campaign stacked right after it, so a nation that's
    // committed half its army reads as exposed here too, not just full.
    const marchPct = Math.max(0, Math.min(100 - homePct, (marching / max) * 100));
    const popMarchEl = document.getElementById('popBarMarch');
    popMarchEl.style.left = homePct.toFixed(1) + '%';
    popMarchEl.style.width = marchPct.toFixed(1) + '%';

    // Exact to the gold while the treasury is small enough for it to matter,
    // abbreviated once it isn't — the same reading formatGold gives everywhere
    // else, so the HUD and the hover panel never disagree about a nation.
    document.getElementById('goldValue').textContent = formatGold(me.gold);

    // A traitor is cheaper and faster to conquer for everyone on the map, so
    // the countdown is the most important number on screen while it runs —
    // an overlay badge on the pop bar rather than its own row, so it costs no
    // layout space the rest of the match (see :empty in style.css).
    const traitorEl = document.getElementById('traitorChip');
    const traitorText = Game.isTraitor(me)
      ? 'TRAITOR ' + Math.ceil(me.traitorUntil - Game.elapsed) + 's' : '';
    if (traitorEl._text !== traitorText) {           // per frame; rewrite only on change
      traitorEl._text = traitorText;
      traitorEl.innerHTML = traitorText ? iconHtml('traitor') + ' ' + traitorText : '';
    }

    this.updateNukeAlert();
    this.updateDonationAlert();
    this.updateDrillHud(me);
    this.updateBanner();
    this.updateBuildBar(me);
    this.updateFronts();
    Radial.refresh();
    this.refreshHoverPanel();

    const now = performance.now();
    if (now - this.lastLeaderboard < 500) return;
    this.lastLeaderboard = now;
    this.renderLeaderboard();
  },

  // `rank` is only passed by the fog leaderboard (see fogLeaderboardHtml).
  // Without it the row is exactly the fog-off one.
  playerRowHtml(p, rank) {
    const pct = (p.tiles.size / GameMap.landTiles * 100).toFixed(1);
    const c = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
    // Fog: a leader we have not met is shown by name and share of the map,
    // which is what the top 3 is there for. Its treasury and status marks are
    // things contact tells you, like the hover panel.
    const unmet = !this.knows(p.id);
    const mark = unmet ? '' : (p.isBot ? iconHtml('bot') : '') +
                 (Game.onSameTeam(Game.me, p.id) ? iconHtml('teammate')
                   : Game.areAllied(Game.me, p.id) ? iconHtml('ally') : '') +
                 (Game.isTraitor(p) ? iconHtml('traitor') : '') +
                 (p.isDisconnected ? iconHtml('disconnected') : '');
    const rankHtml = rank === undefined ? '' : `<div class="lbRank">${rank}</div>`;
    return `<div class="lbRow${p.id === Game.me ? ' me' : ''}${unmet ? ' unmet' : ''}">${rankHtml}
      <div class="lbSwatch" style="background:${c}"></div>
      <div class="lbName">${escapeHtml(p.name)}</div>
      <div class="lbMark">${mark}</div>
      <div class="lbGold">${unmet ? '' : formatGold(p.gold)}</div>
      <div class="lbPct">${pct}%</div>
    </div>`;
  },

  // The line under a fog leaderboard (or a team's roster) that stands for the
  // rows left out. Not a nation, so it has no swatch and takes no clicks.
  unknownRowHtml(n, noun) {
    return `<div class="lbRow lbUnknown">+${n} unknown ${noun}${n === 1 ? '' : 's'}</div>`;
  },

  // FFA: a flat list of the top 6 players by tile count, always expanded —
  // there's no team tier above them to collapse into.
  flatLeaderboardHtml() {
    const ranked = Game.players
      .filter(p => p.alive && p.tiles.size > 0)
      .sort((a, b) => b.tiles.size - a.tiles.size);
    if (Render.fogActive()) return this.fogLeaderboardHtml(ranked);
    return ranked.slice(0, 6).map(p => this.playerRowHtml(p)).join('');
  },

  // Fog of war (docs/fog-of-war.md, "What the player sees"). The top 3 are
  // always named, met or not, so nobody loses to a nation they never heard of.
  // Below them come only nations the viewer has met, and the viewer, to the
  // same six rows as the fog-off list; then one line counting the nations left
  // out for being unknown. Tribes are left out of that count: there can be
  // hundreds, and none of them is a rival for the top.
  //
  // The rows shown are no longer consecutive, so each nation carries its true
  // rank, counted over every nation, unknown ones included. That gives nothing
  // away the unknown count does not, and without it the fourth row would read
  // as fourth place. Tribes are not counted in the rank either (a tribe's row
  // has no number), so rank and unknown count are both in nations. What is
  // still missing between two numbers is a met nation past the six-row cut,
  // which the fog-off list drops without comment too.
  fogLeaderboardHtml(ranked) {
    const TOP = 3, ROWS = 6;
    const rows = [];
    let unknown = 0, mine = null, rank = 0;
    for (let i = 0; i < ranked.length; i++) {
      const p = ranked[i];
      const row = { p, rank: p.isTribe ? '' : ++rank };
      if (p.id === Game.me) mine = row;
      if (i < TOP || this.knows(p.id)) { if (rows.length < ROWS) rows.push(row); }
      else if (!p.isTribe) unknown++;
    }
    // The viewer is always on their own board; past the cut they take the
    // last row.
    if (mine && !rows.includes(mine)) rows[rows.length - 1] = mine;
    return rows.map(r => this.playerRowHtml(r.p, r.rank)).join('') +
      (unknown ? this.unknownRowHtml(unknown, 'nation') : '');
  },

  // Team games: one row per team (largest first), collapsed by default.
  // Clicking a team row (see setup()'s delegated listener) expands its full
  // roster underneath; while collapsed, only your own row still shows there
  // so you can track yourself without expanding your team every time.
  //
  // Fog of war: the same rule as the flat list, a tier up. The top 3 teams
  // are always shown; below them only a team with a member the viewer has
  // met (or the viewer's own), then a count of the unknown teams. Team rows
  // carry their true rank for the same reason nation rows do. An open roster
  // lists the members the viewer has met and counts the rest. A top-3 team
  // with no member met has nothing to list, so it does not open.
  teamLeaderboardHtml() {
    const mine = Game.teamOf(Game.me);
    const fog = Render.fogActive();
    const rows = Game.teams
      .map((t, i) => ({ t, i, tiles: Game.teamTiles(t) }))
      .filter(r => r.tiles > 0)
      .sort((a, b) => b.tiles - a.tiles);
    let unknownTeams = 0;

    return rows.map((r, at) => {
      const c = Teams.baseColor(r.t, r.i);
      const pct = (r.tiles / GameMap.landTiles * 100).toFixed(1);

      const members = Game.players
        .filter(p => p.alive && p.tiles.size > 0 && Game.teamOf(p.id) === r.t)
        .sort((a, b) => b.tiles.size - a.tiles.size);
      const met = fog ? members.filter(p => this.knows(p.id)) : members;
      const unmet = fog && r.t !== mine && met.length === 0;
      if (unmet && at >= 3) { unknownTeams++; return ''; }

      const open = !unmet && this.lbOpenTeams.has(r.t);
      const rankHtml = fog ? `<div class="lbRank">${at + 1}</div>` : '';
      const teamRow = `<div class="lbRow lbTeamRow${r.t === mine ? ' me' : ''}${unmet ? ' unmet' : ''}" data-team="${r.t}">${rankHtml}
        <div class="lbCaret${open ? ' open' : ''}">${unmet ? '' : '&#9656;'}</div>
        <div class="lbSwatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></div>
        <div class="lbName">Team ${escapeHtml(r.t)}</div>
        <div class="lbMark">${iconHtml('teammate')}</div>
        <div class="lbGold"></div>
        <div class="lbPct">${pct}%</div>
      </div>`;

      // Collapsed: just your own row, at the same indent as the full roster,
      // so it doesn't jump position when the team opens or closes.
      const shown = open ? met : met.filter(p => p.id === Game.me);
      const hidden = open ? members.length - met.length : 0;
      const childrenHtml = shown.length || hidden
        ? `<div class="lbChildren">${shown.map(p => this.playerRowHtml(p)).join('')}` +
          `${hidden ? this.unknownRowHtml(hidden, 'nation') : ''}</div>` : '';

      return teamRow + childrenHtml;
    }).join('') + (unknownTeams ? this.unknownRowHtml(unknownTeams, 'team') : '');
  },

  // Phones: the board is hidden behind a tap-to-open toggle so it doesn't
  // cover the map. Wider screens always show it.
  lbCollapsed() {
    return window.matchMedia('(max-width: 700px)').matches && !this.lbMobileOpen;
  },

  renderLeaderboard() {
    const mobile = window.matchMedia('(max-width: 700px)').matches;
    const toggle = mobile
      ? `<div class="lbRow lbToggle"><div class="lbCaret${this.lbMobileOpen ? ' open' : ''}">&#9656;</div>
          <div class="lbName">Leaderboard</div></div>` : '';
    const body = this.lbCollapsed() ? ''
      : Game.isTeamGame() ? this.teamLeaderboardHtml() : this.flatLeaderboardHtml();
    document.getElementById('leaderboard').innerHTML = toggle + body;
  },

  // Cost, count and affordability, plus the hint line under the bar — which is
  // where placement actually explains itself, since an armed build changes what
  // tapping the map does.
  updateBuildBar(me) {
    if (this.placing && !me.alive) this.placing = null;

    // Scouts that have sunk since they were selected.
    for (const sc of this.selectedScouts) if (!Game.scoutById(sc.id)) this.selectedScouts.delete(sc);

    for (const u of Game.UNITS) {
      const els = this.buildEls.get(u.type);
      if (!els) continue;
      const cost = Game.unitCost(me, u.type);
      // A Scout is not a structure, so unitsOwned never sees it. Its badge is
      // afloat/cap, the cap being what stops the next purchase.
      const isScout = u.type === 'scout';
      const owned = isScout ? Game.scoutCount(me.id) : Game.unitsOwned(me, u.type);
      els.cost.textContent = formatGold(cost);
      els.count.textContent = isScout ? (owned ? owned + '/' + Game.MAX_SCOUTS_PER_PLAYER : '') : owned ? '×' + owned : '';
      // Affordability drives the dim, not the disabled attribute: a button you
      // cannot press is also a button that cannot tell you the price.
      const isDrill = u.type === 'drill';
      if (isDrill) els.cost.textContent = Game.drill ? 'Built' : formatGold(cost);
      els.btn.classList.toggle('poor', me.gold < cost);
      els.btn.classList.toggle('armed', this.placing === u.type);
      els.btn.classList.toggle('locked',
        (u.type === 'atombomb' || u.type === 'hydrogenbomb' || u.type === 'mirv') && Game.unitsOwned(me, 'silo') < 1 ||
        (u.type === 'warship' && Game.unitsOwned(me, 'port') < 1) ||
        (isDrill && !!Game.drill) ||
        (isScout && (this.scoutReason() === 'Build a Port first' || this.scoutReason() === 'Scout limit reached')));
    }

    document.getElementById('debugNukeAtom').classList.toggle('armed',
      this.placing === 'debugnuke' && this.debugNukeType === 'atombomb');
    document.getElementById('debugNukeHydrogen').classList.toggle('armed',
      this.placing === 'debugnuke' && this.debugNukeType === 'hydrogenbomb');
    document.getElementById('debugPeace').classList.toggle('armed', this.placing === 'debugpeace');
    const speedBtn = document.getElementById('debugSpeed');
    speedBtn.textContent = `Speed ${LocalServer.speed}x`;
    speedBtn.classList.toggle('armed', LocalServer.speed !== 1);

    const hintEl = document.getElementById('hint');
    if (performance.now() < this.flashUntil) {
      if (!this.flashIcon) { hintEl.textContent = this.flashText; hintEl._flash = null; }
      else if (hintEl._flash !== this.flashIcon + this.flashText) {   // per frame; rewrite only on change
        hintEl._flash = this.flashIcon + this.flashText;
        hintEl.innerHTML = iconHtml(this.flashIcon) + ' ' + escapeHtml(this.flashText);
      }
      hintEl.classList.add('warn');
      return;
    }
    hintEl.classList.remove('warn');
    hintEl._flash = null;
    if (this.placing === 'warship') {
      hintEl.textContent = Game.unitsOwned(me, 'port') < 1
        ? 'Build a Port first to unlock Warships · Esc to cancel'
        : 'Tap anywhere to launch a Warship from your nearest Port · ' +
          formatGold(Game.unitCost(me, 'warship')) + ' gold · Esc to cancel';
    } else if (this.placing === 'drill') {
      hintEl.textContent = Game.drill ? 'The Drill has already been built · Esc to cancel'
        : 'Tap your own land to build The Drill — the world closes in, and the last nation standing wins · ' +
          formatGold(Game.unitCost(me, 'drill')) + ' gold · Esc to cancel';
    } else if (this.placing === 'scout') {
      const reason = this.scoutReason();
      hintEl.textContent = reason === 'Build a Port first' ? 'Build a Port first to unlock Scouts · Esc to cancel'
        : reason ? reason + ' · Esc to cancel'
        : 'Tap anywhere, even into the dark, to send a Scout from your nearest Port · ' +
          formatGold(Game.unitCost(me, 'scout')) + ' gold · Esc to cancel';
    } else if (this.placing === 'radio') {
      hintEl.textContent = 'Tap your own land to place a Radio Tower — it uncovers the map around it once built · ' +
        formatGold(Game.unitCost(me, 'radio')) + ' gold · ' + Game.unitDef('radio').buildTime + 's to build · Esc to cancel';
    } else if (this.placing === 'atombomb' || this.placing === 'hydrogenbomb' || this.placing === 'mirv') {
      const def = Game.unitDef(this.placing);
      const article = this.placing === 'atombomb' ? 'an' : 'a';
      hintEl.textContent = Game.unitsOwned(me, 'silo') < 1
        ? 'Build a Missile Silo first to unlock the ' + def.name + ' · Esc to cancel'
        : 'Tap anywhere to strike with ' + article + ' ' + def.name + ' from your nearest ready Silo · ' +
          formatGold(Game.unitCost(me, this.placing)) + ' gold · Esc to cancel';
    } else if (this.placing === 'debugpeace') {
      hintEl.textContent = '[DEBUG] Tap a nation to make it offer you peace · Esc to cancel';
    } else if (this.placing === 'debugnuke') {
      const def = Game.unitDef(this.debugNukeType);
      hintEl.textContent = this.debugNukeSrc < 0
        ? '[DEBUG] Tap the launch point for the ' + def.name + ' · Esc to cancel'
        : '[DEBUG] Tap the target for the ' + def.name + ' · Esc to cancel';
    } else if (this.placing) {
      const def = Game.unitDef(this.placing);
      // Mouse-only, like placeHover itself (see Input.onHover) — touch just
      // gets the generic placement hint below and learns the upgrade path
      // from the flashed block reason on a tap that lands on one.
      // Fog: a structure on a tile the viewer has not discovered is not there
      // as far as the hint is concerned, or sweeping the cursor over the black
      // would find every hidden City by the line changing to "upgrade".
      const hoverB = this.placeHover >= 0 && Render.canSee(this.placeHover) ? Game.buildings.get(this.placeHover) : null;
      if (hoverB && hoverB.type === this.placing && hoverB.built) {
        hintEl.textContent = 'Tap to upgrade this ' + def.name + ' to level ' + (hoverB.level + 1) +
          ' · ' + formatGold(Game.unitCost(me, this.placing)) + ' gold' +
          (Game.UPGRADE_TIME ? ' · ' + Game.UPGRADE_TIME + 's' : '') + ' · Esc to cancel';
      } else {
        hintEl.textContent = 'Tap your own land to place a ' + def.name +
          ' · ' + formatGold(Game.unitCost(me, this.placing)) + ' gold' +
          ' · ' + def.buildTime + 's to build · Esc to cancel';
      }
    } else if (this.selectedScouts.size) {
      const nw = this.selectedWarships.size, ns = this.selectedScouts.size;
      hintEl.textContent = (nw ? nw + ' warship' + (nw > 1 ? 's' : '') + ', ' : '') +
        ns + ' scout' + (ns > 1 ? 's' : '') + ' selected — tap to send ' +
        (nw ? 'them (warships only to discovered water, scouts anywhere)' : (ns > 1 ? 'them' : 'it') + ' anywhere, even into the dark') +
        ' · shift-drag to reselect · Esc to deselect';
    } else if (this.selectedWarships.size) {
      hintEl.textContent = this.selectedWarships.size + ' warship' + (this.selectedWarships.size > 1 ? 's' : '') +
        ' selected — tap open water to relocate · shift-drag to reselect · Esc to deselect';
    } else {
      hintEl.textContent = window.matchMedia('(pointer: coarse)').matches ? this.TOUCH_HINT
        : Game.fog ? this.FOG_DEFAULT_HINT : this.DEFAULT_HINT;
    }
  },

  // Why a Scout cannot be bought right now, or null. The reasons say nothing
  // about any tile (docs/fog-of-war.md), so any valid tile will do to ask; 0
  // is one. Cached per tick: it walks the buildings and is asked for several
  // times a frame.
  scoutReason() {
    if (this._scoutReasonTick !== Game.ticks) {
      this._scoutReasonTick = Game.ticks;
      this._scoutReason = Game.scoutBlockReason(Game.me, 0);
    }
    return this._scoutReason;
  },

  // Where a front or boat chip sends the camera: the front's centre, or the
  // boat itself. Fog of war: never a spot the viewer has not discovered,
  // since centring the view on the black says where something hidden is.
  //   - A front is along the viewer's own border, so it is in sight; if its
  //     centre happens to fall in the black (a front wrapped round a bay), the
  //     jump goes to a contested tile that is not.
  //   - The viewer's own boat is not drawn while it crosses undiscovered water
  //     (docs/fog-of-war.md), so the jump goes to where they sent it: the
  //     landing tile, discovered or it could not have launched. A recalled one
  //     goes to the coast it is sailing home to.
  //   - Someone else's boat still out in the black is not jumped to at all.
  //     Its landing tile would be in sight, but where it will come ashore is
  //     not something the viewer has seen yet.
  frontJumpTile(kind, ref) {
    const w = GameMap.width;
    if (kind === 'attack') {
      const tile = Render.attackTile(ref);
      if (!tile || Render.canSee(Math.floor(tile.y) * w + Math.floor(tile.x))) return tile;
      for (const t of ref.border) if (Render.canSee(t)) return { x: t % w + 0.5, y: ((t / w) | 0) + 0.5 };
      return null;
    }
    const tile = Render.boatTile(ref);
    // The same point drawBoats and findBoatNear cull on: the centre of the dot.
    if (Render.canSee(Math.floor(tile.y + 0.5) * w + Math.floor(tile.x + 0.5))) return tile;
    if (ref.attacker !== Game.me) { this.flash('Not in sight yet'); return null; }
    const t = ref.retreating ? ref.path[0] : ref.landingTile;
    return Render.canSee(t) ? { x: t % w + 0.5, y: ((t / w) | 0) + 0.5 } : null;
  },

  // Every attack or boat touching the player: ones they sent (with an X to
  // retreat/recall) and ones aimed at them (read-only).
  //
  // Chips are reconciled by the attack/boat object's identity, never
  // rebuilt wholesale: an innerHTML rewrite each frame replaces the X button
  // mid-press and the click never fires. Only the mutable bits are updated
  // in place.
  updateFronts() {
    const el = document.getElementById('frontsRow');
    const items = [];

    for (const a of Game.attacks) {
      if (a.attacker !== Game.me && a.target !== Game.me) continue;
      // Tribes attacking the player are the low-effort filler AI — a chip
      // per Tribe front is noise. Nations attacking the player are real
      // rivals and still get one, same as the player's own pushes.
      if (a.target === Game.me && a.attacker !== Game.me && Game.players[a.attacker].isTribe) continue;
      // Skip ghost entries: a 0-troop attack that resolveOpposingFronts zeroed
      // out this tick and stepAttack hasn't removed yet. They'd flash for one
      // frame then vanish, adding noise without informing the player.
      if (a.troops <= 0 && !a.retreating) continue;
      const mine = a.attacker === Game.me;
      items.push({
        kind: 'attack', ref: a, mine,
        icon: mine ? 'attack' : 'fort',
        troops: a.troops,
        name: this.nameOf(mine ? a.target : a.attacker, 'Unclaimed land'),
        retreating: !!a.retreating
      });
    }
    for (const b of Game.boats) {
      if (b.attacker !== Game.me && b.target !== Game.me) continue;
      if (b.target === Game.me && b.attacker !== Game.me && Game.players[b.attacker].isTribe) continue;
      const mine = b.attacker === Game.me;
      items.push({
        kind: 'boat', ref: b, mine,
        icon: mine ? 'boat' : 'boat-enemy',
        troops: b.troops,
        // Fog: a boat is no contact until it lands, so one inbound from a
        // nation we have not met reads "Unknown nation" for the whole crossing.
        name: this.nameOf(mine ? b.target : b.attacker, 'Unclaimed land'),
        retreating: !!b.retreating
      });
    }

    if (!items.length) {
      el.classList.add('hidden');
      el.innerHTML = '';
      this._frontChipByRef = null;
      return;
    }
    el.classList.remove('hidden');

    const prevByRef = this._frontChipByRef || new Map();
    const nextByRef = new Map();

    for (const it of items) {
      let chip = prevByRef.get(it.ref);
      if (!chip) {
        chip = document.createElement('div');
        chip.innerHTML =
          `<span class="frontIcon">${iconHtml(it.icon)}</span>` +
          `<span class="frontTroops"></span>` +
          `<span class="frontName">${escapeHtml(it.name)}</span>`;
        chip._troopsEl = chip.querySelector('.frontTroops');
        chip._nameEl = chip.querySelector('.frontName');
        chip._name = it.name;
      }
      chip.className = 'frontChip ' + (it.mine ? 'mine' : 'theirs') + (it.retreating ? ' retreating' : '');
      chip._troopsEl.textContent = formatCountTight(it.troops);
      // Fog: "Unknown nation" turns into the name the moment we meet them.
      if (chip._name !== it.name) { chip._name = it.name; chip._nameEl.textContent = it.name; }
      // Stashed on the node (not closed over `it`, which is rebuilt fresh
      // every call) so the listener below always reads this frame's kind/ref
      // even though it was only attached once, back when the chip was made.
      chip._kind = it.kind;
      chip._ref = it.ref;
      if (!chip._jumpBound) {
        chip.addEventListener('click', () => {
          const tile = this.frontJumpTile(chip._kind, chip._ref);
          if (tile) Render.jumpToTile(tile.x, tile.y);
        });
        chip._jumpBound = true;
      }

      // The X only ever needs adding or removing once, right at the moment
      // retreat is ordered — not rebuilt every frame like the text above.
      const wantBtn = it.mine && !it.retreating;
      if (wantBtn && !chip._btnEl) {
        const btn = document.createElement('button');
        btn.className = 'frontClose';
        btn.textContent = '✕';
        // Closes over `it.ref`, not an index. The intent carries the attack's or
        // boat's id; the Executor looks it up and checks we launched it. An id
        // whose attack already ended is dropped there, which is normal.
        btn.addEventListener('click', (e) => {
          // Otherwise this bubbles to the chip's own click listener and jumps
          // the camera to the front in the same gesture that just cancelled it.
          e.stopPropagation();
          if (it.kind === 'attack') Transport.sendIntent(Protocol.intent.cancelAttack(it.ref.id));
          else Transport.sendIntent(Protocol.intent.cancelBoat(it.ref.id));
        });
        chip.appendChild(btn);
        chip._btnEl = btn;
      } else if (!wantBtn && chip._btnEl) {
        chip._btnEl.remove();
        chip._btnEl = null;
      }

      nextByRef.set(it.ref, chip);
    }

    // Drop chips whose attacks have ended.
    for (const [ref, chip] of prevByRef) {
      if (!nextByRef.has(ref)) chip.remove();
    }

    // Re-appending an already-attached node just reorders it in place —
    // cheap, and it never disturbs a node that isn't moving.
    for (const it of items) el.appendChild(nextByRef.get(it.ref));

    this._frontChipByRef = nextByRef;
  },

  // Incoming-nuke warning. Read-only over Game.nukes. A nuke has no id but
  // stays the same object until it is spliced out, so the object is the
  // key: one row per nuke, gone the frame the nuke is.
  updateNukeAlert() {
    const el = document.getElementById('nukeAlert');
    const prev = this._nukeRowByRef || new Map();
    const next = new Map();

    // MIRV: warn on the mothership from launch. Once it splits, the
    // warheads do NOT get rows of their own (see the loop below); 40 rows at
    // once would be noise.
    for (const m of Game.mirvs) {
      if (!this.nukeThreatensMe(m)) continue;
      let row = prev.get(m);
      if (!row) {
        row = document.createElement('div');
        row.className = 'nukeAlertRow';
        row.innerHTML = `<span class="nukeAlertText"></span><span class="nukeAlertTime"></span>`;
        row._textEl = row.querySelector('.nukeAlertText');
        row._timeEl = row.querySelector('.nukeAlertTime');
        // Jumps to the real aim tile (m.dst), not m.to — m.to is now the
        // mid-air separation point the mothership itself is flying toward
        // (see nukes.js's launchMirv), not the ground it threatens.
        row.addEventListener('click', () => Render.jumpToTile(m.dst % GameMap.width, (m.dst / GameMap.width) | 0));
      }
      this.setNukeAlertText(row, 'mirv', 'MIRV', m.ownerId);
      const left = Math.max(0, m.duration - (Game.elapsed - m.born));
      row._timeEl.textContent = Math.ceil(left) + 's';
      next.set(m, row);
    }

    for (const n of Game.nukes) {
      // See this function's own comment on Game.mirvs above — a split
      // MIRV's individual warheads stay off this list entirely.
      if (n.nukeType === 'mirvwarhead') continue;
      if (!this.nukeThreatensMe(n)) continue;
      let row = prev.get(n);
      if (!row) {
        row = document.createElement('div');
        row.className = 'nukeAlertRow';
        row.innerHTML = `<span class="nukeAlertText"></span><span class="nukeAlertTime"></span>`;
        row._textEl = row.querySelector('.nukeAlertText');
        row._timeEl = row.querySelector('.nukeAlertTime');
        row.addEventListener('click', () => Render.jumpToTile(n.to.x, n.to.y));
      }
      if (n.nukeType === 'hydrogenbomb') this.setNukeAlertText(row, 'hbomb', 'Hydrogen Bomb', n.ownerId);
      else this.setNukeAlertText(row, 'nuke', 'Nuke', n.ownerId);
      const left = Math.max(0, n.duration - (Game.elapsed - n.born));
      row._timeEl.textContent = Math.ceil(left) + 's';
      next.set(n, row);
    }

    for (const [ref, row] of prev) if (!next.has(ref)) row.remove();
    for (const row of next.values()) if (row.parentNode !== el) el.appendChild(row);
    el.classList.toggle('hidden', next.size === 0);
    this._nukeRowByRef = next.size ? next : null;
  },

  // The warning's words. Fog of war: a launcher the viewer has not met reads
  // "Unknown nation" (docs/fog-of-war.md, "Nukes") until the hit introduces
  // them, by which time the row is gone. Checked every frame rather than
  // baked in when the row is made, because contact can also come mid-flight
  // (their land comes into view, or the viewer is eliminated and sees
  // everything); the span is only rewritten when the name changes.
  setNukeAlertText(row, icon, what, ownerId) {
    const name = this.nameOf(ownerId, 'unknown');
    if (row._name === name) return;
    row._name = name;
    row._textEl.innerHTML = `${iconHtml(icon)} ${what} incoming from ${escapeHtml(name)}!`;
  },

  // A toast when a teammate donates gold or troops to you. The sim pushes
  // Fx.donationToasts for every recipient; this filters to Game.me and ages
  // rows out after a fixed lifetime.
  updateDonationAlert() {
    const el = document.getElementById('donationAlert');
    const prev = this._donationRowByRef || new Map();
    const next = new Map();
    const life = Fx.DONATION_TOAST_LIFETIME;

    for (const d of Fx.donationToasts) {
      if (d.toId !== Game.me) continue;
      if (Game.elapsed - d.born >= life) continue;
      let row = prev.get(d);
      if (!row) {
        const what = d.kind === 'gold' ? formatGold(d.amount) + ' gold' : Math.round(d.amount) + ' troops';
        row = document.createElement('div');
        row.className = 'donationAlertRow';
        // Fog: only a friendly nation can donate, and an alliance is contact,
        // so the giver is always known today. nameOf() keeps the rule anyway.
        row.innerHTML =
          `<span class="donationAlertText">${iconHtml(d.kind)} +${what} from ${escapeHtml(this.nameOf(d.fromId, 'ally'))}</span>`;
      }
      next.set(d, row);
    }

    for (const [ref, row] of prev) if (!next.has(ref)) row.remove();
    for (const row of next.values()) if (row.parentNode !== el) el.appendChild(row);
    el.classList.toggle('hidden', next.size === 0);
    this._donationRowByRef = next.size ? next : null;
  },

  // Whether a nuke will hit land this client's player owns: its target tile is
  // theirs, or any of their tiles sits inside its outer blast radius. Worked
  // out once per nuke, when it's first seen, and cached against the object —
  // a full-radius scan every frame would be wasteful, and the warning
  // shouldn't flicker as borders shift under the missile. Also read by
  // Render.drawNukes for the target marker. Your own nukes never warn.
  nukeThreatensMe(n) {
    if (Game.me < 0 || n.ownerId === Game.me) return false;
    if (!this._nukeThreat) this._nukeThreat = new WeakMap();
    let hit = this._nukeThreat.get(n);
    if (hit === undefined) {
      hit = GameMap.owner[n.dst] === Game.me;
      const mag = Game.NUKE_MAGNITUDES[n.nukeType];
      if (!hit && mag) {
        const r = mag.outer, r2 = r * r, w = GameMap.width, h = GameMap.height;
        const x0 = Math.max(0, n.to.x - r), x1 = Math.min(w - 1, n.to.x + r);
        const y0 = Math.max(0, n.to.y - r), y1 = Math.min(h - 1, n.to.y + r);
        for (let y = y0; y <= y1 && !hit; y++) {
          const dy = y - n.to.y, row = y * w;
          for (let x = x0; x <= x1; x++) {
            const dx = x - n.to.x;
            if (dx * dx + dy * dy <= r2 && GameMap.owner[row + x] === Game.me) { hit = true; break; }
          }
        }
      }
      this._nukeThreat.set(n, hit);
    }
    return hit;
  },

  // One offer at a time: a peace deal someone has put to you, or an ally asking
  // to renew before the clock runs out. Ignoring either is a valid answer —
  // both simply lapse, and neither costs you anything.
  // Battle Royale: the placement banner (everyone sees it, once, when the
  // Drill record first appears) and the HUD chip counting down to the shrink,
  // then to full closure. Reads the sim only; the "your land is next" flag is
  // refreshed at 1 Hz from the player's border tiles (a few thousand at most,
  // never the whole map) and lives on UI, not Game.
  updateDrillHud(me) {
    const d = Game.drill;
    const chip = document.getElementById('drillHud'), banner = document.getElementById('drillBanner');
    if (!d) {
      if (this._drillSeen) { this._drillSeen = null; this._drillBannerUntil = 0; this._drillDanger = false; }
      chip.classList.add('hidden');
      banner.classList.add('hidden');
      return;
    }
    const tps = Game.TICKS_PER_SEC, now = performance.now();
    if (this._drillSeen !== d) {
      this._drillSeen = d;
      // Join/catch-up replays shouldn't re-announce an old placement.
      if (Game.ticks - d.placedTick < 10 * tps) {
        this._drillBannerUntil = now + 8000;
        document.getElementById('drillBannerText').textContent =
          (d.ownerId === Game.me ? 'You have' : this.nameOf(d.ownerId) + ' has') +
          ' built The Drill — the world is closing in';
        banner.classList.remove('hidden', 'fade');
      }
    }
    if (this._drillBannerUntil) {
      if (now > this._drillBannerUntil) { banner.classList.add('hidden'); this._drillBannerUntil = 0; }
      else if (now > this._drillBannerUntil - 1200) banner.classList.add('fade');
    }

    const t = Game.ticks;
    let text, secs;
    if (t < d.startTick) { text = 'The Drill — shrink begins in'; secs = (d.startTick - t) / tps; }
    else if (t < d.endTick) { text = 'The world is closing — full closure in'; secs = (d.endTick - t) / tps; }
    else { text = 'The circle has closed'; secs = 0; }
    if (now - (this._drillDangerAt || 0) > 1000) {
      this._drillDangerAt = now;
      this._drillDanger = me.alive && Render.ownLandDoomed(me, 30);
    }
    if (this._drillDanger && t >= d.startTick && t < d.endTick) text = 'YOUR LAND IS NEXT — full closure in';
    if (Game.winnerId !== null) { text = 'Battle Royale over'; secs = 0; this._drillDanger = false; }
    const timeText = secs > 0 ? Math.floor(secs / 60) + ':' + String(Math.floor(secs % 60)).padStart(2, '0') : '';
    if (chip._text !== text) { chip._text = text; document.getElementById('drillHudText').textContent = text; }
    if (chip._time !== timeText) { chip._time = timeText; document.getElementById('drillHudTime').textContent = timeText; }
    chip.classList.toggle('danger', !!this._drillDanger && t < d.endTick);
    chip.classList.remove('hidden');
  },

  updateBanner() {
    const el = document.getElementById('diploBanner');
    const state = this.pendingOffer();

    if (!state) {
      this.diplo = null;
      el.classList.add('hidden');
      return;
    }

    // Text carries a live countdown, so it is rewritten every frame; the
    // buttons and the reveal only change when the offer itself does.
    document.getElementById('diploText').textContent = state.text;
    if (!this.diplo || this.diplo.key !== state.key) {
      document.getElementById('diploYes').textContent = state.yes;
      document.getElementById('diploNo').textContent = state.no;
      el.classList.remove('hidden');
    }
    this.diplo = state;
    document.getElementById('diploBarFill').style.width =
      Math.max(0, Math.min(1, state.left / state.span) * 100).toFixed(1) + '%';
  },

  pendingOffer() {
    const req = Game.requests.find(r => r.to === Game.me);
    if (req) {
      return {
        key: 'req:' + req.from + ':' + req.createdAt.toFixed(1),
        // Fog: contact is one-sided, so an offer can come from a nation we
        // have not met. It reads "Unknown nation" and can still be answered;
        // accepting is what introduces them (Game.acceptAlliance).
        text: this.nameOf(req.from) + ' proposes a peace deal',
        yes: 'Accept', no: 'Reject',
        left: Game.ALLIANCE_REQUEST_DURATION - (Game.elapsed - req.createdAt),
        span: Game.ALLIANCE_REQUEST_DURATION,
        // The wire names the requestor, not the request object: the Executor
        // looks the request up again from the pair, and will only let us
        // answer mail addressed to us. A reply that arrives after the offer
        // has lapsed resolves to nothing and drops, identically everywhere.
        accept: () => Transport.sendIntent(Protocol.intent.allianceAccept(req.from)),
        reject: () => Transport.sendIntent(Protocol.intent.allianceReject(req.from))
      };
    }

    // OpenFront prompts 30s out (allianceExtensionPromptOffset). Nations never
    // open a renewal themselves — their own code notes only a human ally can —
    // so in practice this is the expiry warning, and it doubles as the reply
    // when the other side has already asked.
    for (const al of Game.alliances) {
      if (al.a !== Game.me && al.b !== Game.me) continue;
      if (!Game.extendWindowOpen(al) || Game.agreedToExtend(al, Game.me)) continue;
      const otherId = al.a === Game.me ? al.b : al.a;
      const key = 'ext:' + otherId + ':' + al.createdAt.toFixed(1);
      if (this.dismissed.has(key)) continue;
      const name = this.nameOf(otherId);
      return {
        key,
        text: Game.awaitingExtension(al, Game.me)
          ? name + ' wants to renew'
          : 'Peace with ' + name + ' ends in ' + Math.ceil(al.expiresAt - Game.elapsed) + 's',
        yes: 'Renew', no: 'Let lapse',
        left: al.expiresAt - Game.elapsed,
        span: Game.ALLIANCE_EXTEND_WINDOW,
        accept: () => Transport.sendIntent(Protocol.intent.allianceExtension(otherId)),
        reject: () => {}
      };
    }
    return null;
  },

  // Purely reactive: Game.winnerId is set by the sim identically on every
  // client. This only reads sim state, picks which overlay this client
  // shows, and casts this client's one vote.
  //
  // Our own elimination is handled separately: `lossShown` fires as soon as
  // `me.alive` goes false, since winnerId can come much later. The `winner`
  // vote still waits for winnerId; voting null would tell the server the
  // match had ended. `endGameHandled`/`lossShown` are one-shot latches,
  // cleared by reset().
  checkEndGame() {
    const me = Game.players[Game.me];

    if (me && !me.alive && !this.lossShown) {
      this.lossShown = true;
      const place = Game.placements.get(Game.me);
      const text = place
        ? 'You were the ' + ordinal(place) + ' out of ' + Game.nationCount + ' starting nations to fall.'
        : 'Your nation has been wiped off the map.';
      this.showEnd('Defeated', text);
    }

    if (Game.winnerId === null || this.endGameHandled) return;
    this.endGameHandled = true;

    // Battle Royale: once a Drill exists the land-share win is off, so the
    // only way to win is to be the last one standing (docs/battle-royale.md).
    const br = !!Game.drill;
    if (Game.winnerTeam) {
      // Issue #31: a team game is won by the whole team, alive or not.
      if (Game.teamOf(Game.me) === Game.winnerTeam) {
        this.showEnd('Victory', br ? 'Your team is the last one standing — Battle Royale won.' : 'Team ' + Game.winnerTeam + ' controls the world.');
      } else {
        this.showEnd('Game Over', 'Team ' + Game.winnerTeam + (br ? ' is the last team standing — Battle Royale.' : ' has won the game.'));
      }
    } else if (Game.winnerId === Game.me) {
      this.showEnd('Victory', br ? 'You are the last nation standing — Battle Royale won.' : 'You control the world.');
    } else if (!me.alive) {
      // Already shown above, with the placement text — leave it as is.
    } else {
      // Bug #2 (MP-3.5 brief): still alive, but someone else won — the case
      // the old me-relative checks could never reach, so this client used to
      // show nothing at all once the match ended for everyone else.
      const winner = Game.players[Game.winnerId];
      this.showEnd('Game Over', (winner ? winner.name : 'Another player') + (br ? ' is the last nation standing — Battle Royale.' : ' has won the game.'));
    }

    // This client's one vote (§4 `winner`) — sent in every case above,
    // exactly once, regardless of which overlay this client itself shows.
    Transport.sendWinner(Game.winnerId);
  },

  showEnd(title, text) {
    // A replay has no result of its own to announce; its bar shows the end.
    if (Replay.active) return;
    Replay.noteResult(title);
    document.getElementById('endReplayRow').classList.toggle('hidden', !Replay.snapshot());
    document.getElementById('endTitle').textContent = title;
    document.getElementById('endText').textContent = text;
    // #22: a popup over the live map. Each new result (e.g. Victory/Game Over
    // after an earlier Defeated) re-expands it; the minimize button collapses
    // it to just the title so the whole map is inspectable.
    const overlay = document.getElementById('endOverlay');
    const minBtn = document.getElementById('endMinBtn');
    const setMin = (min) => {
      overlay.classList.toggle('minimized', min);
      minBtn.innerHTML = min ? '&#43;' : '&minus;';
      minBtn.title = min ? 'Show' : 'Hide';
    };
    minBtn.onclick = () => setMin(!overlay.classList.contains('minimized'));
    setMin(false);
    overlay.classList.remove('hidden');
    // The winner's victory banner, shown to everyone in the match.
    overlay.dataset.banner = Game.winnerId !== null ? Progress.bannerOf(Game.winnerId) : '';
    this.renderEndEarned();
  },

  // --- What's new (server/news.js) --------------------------------------------

  // The menu link appears only when the server has a post, and is marked
  // unread until this browser has opened that post.
  setupNews() {
    const SEEN_KEY = 'borderwar_news_seen';
    const overlay = document.getElementById('newsOverlay');
    const link = document.getElementById('newsLink');
    const close = () => overlay.classList.add('hidden');
    let post = null;
    link.addEventListener('click', () => {
      if (!post) return;
      document.getElementById('newsTitle').textContent = post.title || "What's new";
      document.getElementById('newsDate').textContent =
        new Date(post.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
      Markup.render(document.getElementById('newsBody'), post.body);
      overlay.classList.remove('hidden');
      link.classList.remove('unread');
      try { localStorage.setItem(SEEN_KEY, String(post.at)); } catch (e) { /* ignore */ }
    });
    document.getElementById('newsClose').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
    fetch('news', { credentials: 'omit', cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(n => {
        if (!n || !n.post || typeof n.post.body !== 'string' || typeof n.post.title !== 'string') return;
        post = n.post;
        let seen = '';
        try { seen = localStorage.getItem(SEEN_KEY) || ''; } catch (e) { /* ignore */ }
        link.classList.toggle('unread', seen !== String(post.at));
        link.classList.remove('hidden');
      })
      .catch(() => { /* no server, no post */ });
  },

  // --- Achievements (js/progress.js, docs/metaprogression.md) ----------------

  setupProgress() {
    const overlay = document.getElementById('achOverlay');
    const close = () => overlay.classList.add('hidden');
    document.getElementById('achLink').addEventListener('click', () => {
      this.renderAchievements();
      overlay.classList.remove('hidden');
    });
    document.getElementById('achClose').addEventListener('click', close);
    for (const tab of document.querySelectorAll('#achTabs button')) {
      tab.addEventListener('click', () => { this.achTab = tab.dataset.tab; this.renderAchievements(); });
    }
    document.getElementById('achLoadout').addEventListener('click', e => {
      const btn = e.target.closest('button[data-type]');
      if (!btn || btn.disabled) return;
      Progress.equip(btn.dataset.type, btn.dataset.id || null);
      this.renderAchievements();
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
    Progress.onUnlock = id => { this.showAchievementToast(id); this.renderEndEarned(); };
  },

  achTab: 'medals',

  renderAchievements() {
    const cosmetics = this.achTab === 'cosmetics';
    for (const tab of document.querySelectorAll('#achTabs button')) tab.classList.toggle('active', tab.dataset.tab === this.achTab);
    document.getElementById('achList').classList.toggle('hidden', cosmetics);
    document.getElementById('achLoadout').classList.toggle('hidden', !cosmetics);
    this.renderLoadout();
    const items = Progress.list();
    const earned = items.filter(it => it.unlockedAt).length;
    document.getElementById('achCount').textContent = earned + ' of ' + items.length + ' earned';
    let html = '';
    for (const group of ProgressDefs.GROUPS) {
      const rows = items.filter(it => it.def.group === group.id);
      if (!rows.length) continue;
      html += `<div class="achGroup">${escapeHtml(group.name)}</div>`;
      for (const it of rows) {
        const got = !!it.unlockedAt;
        const secret = it.def.hidden && !got;
        let sub = secret ? 'Keep playing to find this one.' : it.def.desc;
        const reward = !secret && it.def.unlocks ? ProgressDefs.COSMETICS[it.def.unlocks] : null;
        if (reward) sub += ' Unlocks ' + (reward.type === 'banner' ? 'a victory banner' : reward.type === 'emblem' ? 'the ' + reward.name + ' emblem' : 'the title "' + reward.name + '"') + '.';
        if (got) sub += ' · ' + new Date(it.unlockedAt).toLocaleDateString();
        else if (it.progress) sub += ' · ' + Math.min(it.progress.have, it.progress.need) + '/' + it.progress.need;
        html += `<div class="achRow${got ? ' earned' : ''}" data-group="${group.id}">`
          + `<span class="achMedal" aria-hidden="true">${got ? '★' : '☆'}</span>`
          + `<span class="achText"><b>${escapeHtml(secret ? '???' : it.def.name)}</b><small>${escapeHtml(sub)}</small></span></div>`;
      }
    }
    document.getElementById('achList').innerHTML = html;
    document.getElementById('achGuestNote').classList.toggle('hidden', !Account.available || !!Account.user);
  },

  // One row of choices per cosmetic type; a locked one names what unlocks it.
  renderLoadout() {
    const LABELS = { title: 'Title', emblem: 'Map emblem', banner: 'Victory banner' };
    const NOTES = { title: 'Shown beside your name', emblem: 'Shown on your nation\'s map label', banner: 'Everyone sees it when you win' };
    const eq = Progress.loadout();
    let html = '';
    for (const type of ProgressDefs.COSMETIC_TYPES) {
      html += `<div class="achGroup">${LABELS[type]} <span>${NOTES[type]}</span></div><div class="loadoutRow">`;
      html += `<button type="button" data-type="${type}" data-id="" class="${eq[type] ? '' : 'active'}">None</button>`;
      for (const id of Object.keys(ProgressDefs.COSMETICS)) {
        const c = ProgressDefs.COSMETICS[id];
        if (c.type !== type) continue;
        const by = Progress.unlockerOf(id);
        if (!by) continue;
        const owned = Progress.has(by);
        const def = ProgressDefs.ACHIEVEMENTS[by];
        const tip = owned ? '' : 'Earn ' + (def.hidden ? 'a hidden achievement' : def.name) + ' to unlock';
        html += `<button type="button" data-type="${type}" data-id="${id}" class="${eq[type] === id ? 'active' : ''}"`
          + `${owned ? '' : ' disabled'} title="${escapeHtml(tip)}">${c.glyph ? c.glyph + ' ' : ''}${escapeHtml(c.name)}</button>`;
      }
      html += '</div>';
    }
    document.getElementById('achLoadout').innerHTML = html;
  },

  showAchievementToast(id) {
    const def = ProgressDefs.ACHIEVEMENTS[id];
    if (!def) return;
    const el = document.getElementById('achToast');
    const row = document.createElement('div');
    row.className = 'achToastRow';
    row.innerHTML = `<span class="achMedal" aria-hidden="true">★</span>`
      + `<span class="achText"><small>Achievement earned</small><b>${escapeHtml(def.name)}</b>${this.unlockLine(def)}</span>`;
    el.appendChild(row);
    el.classList.remove('hidden');
    // Matches the achToastFade animation length in style.css.
    setTimeout(() => {
      row.remove();
      if (!el.firstChild) el.classList.add('hidden');
    }, 5000);
  },

  // What an achievement unlocked, as a line for the toast and the panel.
  unlockLine(def) {
    const c = def.unlocks ? ProgressDefs.COSMETICS[def.unlocks] : null;
    if (!c) return '';
    const kind = { title: 'title', emblem: 'emblem', banner: 'victory banner' }[c.type];
    return `<small>Unlocked ${kind}: ${c.glyph ? c.glyph + ' ' : ''}${escapeHtml(c.name)}</small>`;
  },

  renderEndEarned() {
    const el = document.getElementById('endEarned');
    const ids = Progress.matchEarned || [];
    el.classList.toggle('hidden', ids.length === 0);
    if (!ids.length) { el.textContent = ''; return; }
    el.innerHTML = '<small>Earned this match</small>' + ids.map(id => {
      const def = ProgressDefs.ACHIEVEMENTS[id];
      return def ? `<div><span class="achMedal" aria-hidden="true">★</span> ${escapeHtml(def.name)}</div>` : '';
    }).join('');
  },

  // --- Lobby ------------------------------------------------------------------
  //
  // Pure DOM: mode switching, roster rendering, reading and writing the
  // lobby form fields. No Transport call lives here; js/main.js owns every
  // click that opens a connection. Host and join share one screen
  // (#friendsMode).

  setupLobby() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.modeTab'));
    const bodies = {
      sp: document.getElementById('spMode'),
      friends: document.getElementById('friendsMode'),
      replay: document.getElementById('replayMode')
    };
    // Picking a mode swaps the home screen (brand, open-game card, mode rows)
    // out for that mode's screen; Back (#modeBack) undoes it. A class on
    // #overlay rather than `hidden` on the card, because hideLobby() owns the
    // card's `hidden` for the lobby screens.
    const overlay = document.getElementById('overlay');
    const back = document.getElementById('modeBack');
    const title = document.getElementById('modeTitle');
    // Solo / Friends switch in the header: forwards to the matching mode row.
    const segs = Array.prototype.slice.call(document.querySelectorAll('#modeSeg button'));
    segs.forEach((b) => b.addEventListener('click', () => {
      const tab = tabs.find((t) => t.dataset.mode === b.dataset.seg);
      if (tab) tab.click();
    }));
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        segs.forEach((b) => b.classList.toggle('active', b.dataset.seg === tab.dataset.mode));
        for (const key in bodies) bodies[key].classList.toggle('hidden', key !== tab.dataset.mode);
        overlay.classList.add('modeOpen');
        overlay.dataset.mode = tab.dataset.mode;
        title.textContent = tab.dataset.title || '';
        back.classList.remove('hidden');
        this.setLobbyError('');
        // The preview skips drawing while its panel is hidden.
        if (tab.dataset.mode === 'sp') this.refreshMapPreview('');
        if (tab.dataset.mode === 'replay') this.refreshReplayList();
      });
    });
    back.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      for (const key in bodies) bodies[key].classList.add('hidden');
      overlay.classList.remove('modeOpen');
      delete overlay.dataset.mode;
      back.classList.add('hidden');
      this.setLobbyError('');
    });

    document.getElementById('lobbyCode').addEventListener('click', () => this.copyLobbyCode());
    this.bindModeSelect('');
    this.bindModeSelect('host');
    this.setupMapGen('');
    this.setupMapGen('host');
    this.bindFogToggle('');
    this.bindFogToggle('host');
    this.setupPickers();

    // Prefill the shared name field from the last time this browser played.
    let savedName = '';
    try { savedName = localStorage.getItem('borderwar_username') || ''; } catch (e) { /* ignore */ }
    if (savedName) document.getElementById('playerName').value = savedName;
    let savedTag = '';
    try { savedTag = localStorage.getItem('borderwar_tag') || ''; } catch (e) { /* ignore */ }
    document.getElementById('playerTag').value = savedTag;
  },

  // --- Replays (js/replay.js, docs/replays.md) ---------------------------------
  //
  // The menu's Replays tab and the playback bar. Replay holds the state and
  // does the work; this is the DOM around it.

  setupReplays() {
    const $ = (id) => document.getElementById(id);

    $('replayLoadBtn').addEventListener('click', () => $('replayFile').click());
    $('replayFile').addEventListener('change', () => {
      const file = $('replayFile').files[0];
      $('replayFile').value = '';
      if (!file) return;
      Replay.readFile(file)
        .then((record) => Replay.put(record).then(() => this.playReplay(record)))
        .catch((err) => this.setLobbyError(err.message));
    });

    $('endReplayBtn').addEventListener('click', () => {
      const record = Replay.snapshot();
      if (record) this.playReplay(record);
    });
    $('endSaveBtn').addEventListener('click', () => {
      const record = Replay.snapshot();
      if (record) Replay.download(record);
    });

    $('replayPlay').addEventListener('click', () => this.togglePause());
    $('replaySpeed').addEventListener('click', () => Replay.cycleSpeed());
    // Dragging only moves the readout; the jump happens on release, because a
    // backward jump replays the match from the start.
    $('replaySeek').addEventListener('input', () => { this._replayDragging = true; });
    $('replaySeek').addEventListener('change', () => {
      this._replayDragging = false;
      Replay.seek(+$('replaySeek').value);
    });
    $('replayView').addEventListener('change', () => Replay.setView(+$('replayView').value));
    $('replayReveal').addEventListener('change', () => { Replay.revealAll = $('replayReveal').checked; });
    $('replayExit').addEventListener('click', () => Replay.host.exit());
  },

  playReplay(record) {
    const err = Replay.play(record);
    if (err) this.setLobbyError(err);
  },

  refreshReplayList() {
    Replay.list().then((list) => this.renderReplayList(list));
  },

  // "12:40" from a turn count.
  replayClock(turns) {
    const s = Math.floor(turns * Game.TICK_DT);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  },

  renderReplayList(list) {
    const ul = document.getElementById('replayList');
    ul.innerHTML = '';
    if (list.length === 0) {
      const li = document.createElement('li');
      li.className = 'lobbyListEmpty';
      li.textContent = 'No replays yet. Matches you play are saved here automatically.';
      ul.appendChild(li);
      return;
    }
    list.forEach((record) => {
      const info = record.gameStartInfo || {};
      const cfg = info.config || {};
      const humans = Array.isArray(info.players) ? info.players.length : 1;
      const when = new Date(record.startedAt || record.savedAt);
      const older = record.build && window.BUILD_ID && record.build !== window.BUILD_ID;

      const li = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'replayInfo';
      label.title = 'Watch';
      label.textContent = (record.result || 'Unfinished') + ' · ' +
        (cfg.map === 'world' ? 'The World' : 'Procedural ' + (cfg.mapSize || ''));
      const sub = document.createElement('small');
      sub.textContent = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
        when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) +
        ' · ' + this.replayClock(record.turnCount) +
        ' · ' + (humans > 1 ? humans + ' players' : 'Solo') +
        (older ? ' · older version' : '');
      label.appendChild(sub);
      label.addEventListener('click', () => this.playReplay(record));

      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = 'Save';
      save.title = 'Download as a file';
      save.addEventListener('click', () => Replay.download(record));

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Delete';
      del.addEventListener('click', () => Replay.remove(record.id).then(() => this.refreshReplayList()));

      li.appendChild(label);
      li.appendChild(save);
      li.appendChild(del);
      ul.appendChild(li);
    });
  },

  // Once a frame from main.js. Shows the bar only while a replay plays.
  updateReplayBar() {
    const $ = (id) => document.getElementById(id);
    const bar = $('replayBar');
    if (bar._record !== Replay.record) {
      bar._record = Replay.record;
      bar.classList.toggle('hidden', !Replay.active);
      if (Replay.active) {
        // Humans only: they are whose views differ in an interesting way.
        const players = Replay.record.gameStartInfo.players || [];
        const view = $('replayView');
        view.innerHTML = '';
        for (const p of players) {
          const opt = document.createElement('option');
          opt.value = p.playerId;
          opt.textContent = p.username;
          view.appendChild(opt);
        }
        view.value = Replay.viewAs;
        view.classList.toggle('hidden', players.length < 2);
        $('replayReveal').checked = Replay.revealAll;
        this._replayDragging = false;
      }
    }
    if (!Replay.active) return;

    const seek = $('replaySeek');
    const len = Replay.length();
    if (+seek.max !== len) seek.max = len;
    if (!this._replayDragging) seek.value = Replay.turn();
    $('replayTime').textContent = (Replay.seeking() ? 'Seeking ' : '') +
      this.replayClock(this._replayDragging ? +seek.value : Replay.turn()) + ' / ' + this.replayClock(len);

    const waiting = Replay.paused || Replay.ended();
    const play = $('replayPlay');
    if (play._waiting !== waiting) {
      play._waiting = waiting;
      play.innerHTML = iconHtml(waiting ? 'play' : 'pause');
      play.classList.toggle('paused', waiting);
    }
    $('replaySpeed').textContent = Replay.speed + 'x';
    $('replayRevealRow').classList.toggle('hidden', !Game.fog);
  },

  // --- Accounts (docs/accounts-auth.md §2.1) -----------------------------------
  //
  // The menu strip ("Playing as guest · Sign in") and the sign-in / create
  // account dialog. Account (js/account.js) does the talking to the server.
  setupAccount() {
    const $ = (id) => document.getElementById(id);
    const overlay = $('accountOverlay');
    const email = $('accountEmail'), pass = $('accountPassword'), confirm = $('accountConfirm');
    const error = $('accountError'), submit = $('accountSubmit');
    let creating = false, busy = false;

    const showError = (msg) => {
      error.textContent = msg || '';
      error.classList.toggle('hidden', !msg);
    };
    const setCreating = (on) => {
      creating = on;
      $('accountTitle').textContent = on ? 'Create account' : 'Sign in';
      submit.textContent = on ? 'Create account' : 'Sign in';
      $('accountToggle').textContent = on ? 'I have an account' : 'Create account';
      confirm.classList.toggle('hidden', !on);
      $('accountNote').classList.toggle('hidden', !on);
      $('accountPrivacy').classList.toggle('hidden', !on);
      $('accountAge').classList.toggle('hidden', !on);
      $('accountAgeBox').checked = false;
      pass.autocomplete = on ? 'new-password' : 'current-password';
      showError('');
    };
    const close = () => {
      overlay.classList.add('hidden');
      pass.value = confirm.value = '';
    };

    $('accountSignIn').addEventListener('click', () => {
      setCreating(false);
      overlay.classList.remove('hidden');
      email.focus();
    });
    $('accountToggle').addEventListener('click', () => setCreating(!creating));
    $('accountCancel').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
    $('accountSignOut').addEventListener('click', () => {
      Account.logout().catch(() => {}).then(() => this.renderAccount());
    });

    $('accountForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (busy) return;
      const addr = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return showError('Enter a valid email address');
      if (creating && pass.value.length < 8) return showError('Password must be at least 8 characters');
      if (creating && pass.value !== confirm.value) return showError('The passwords do not match');
      if (!pass.value) return showError('Enter your password');
      if (creating && !$('accountAgeBox').checked) return showError('You must be 13 or older to create an account');

      // A new account starts with whatever is in the menu's name and tag fields.
      const name = ($('playerName').value || '').trim();
      const tag = ($('playerTag').value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5);
      const request = creating
        ? Account.register(addr, pass.value, /[\[\]]/.test(name) ? '' : name, tag)
        : Account.login(addr, pass.value);
      busy = true;
      submit.disabled = true;
      showError('');
      request.then((user) => {
        // Signing in brings the account's name and tag to this browser.
        if (!creating) {
          $('playerName').value = user.displayName;
          $('playerTag').value = user.tag;
          try {
            localStorage.setItem('borderwar_username', user.displayName);
            localStorage.setItem('borderwar_tag', user.tag);
          } catch (err) { /* ignore */ }
        }
        close();
        this.renderAccount();
      }, (err) => showError(err.message)).then(() => {
        busy = false;
        submit.disabled = false;
      });
    });

    this.setupManageAccount();
    Account.init().then(() => this.renderAccount());
  },

  // The signed-in "Account" dialog: change email, change password, delete
  // account. Each asks for the current password, as the server requires.
  setupManageAccount() {
    const $ = (id) => document.getElementById(id);
    const overlay = $('manageOverlay');
    const email = $('manageEmail'), current = $('manageCurrent'), next = $('manageNew'), confirm = $('manageConfirm');
    const error = $('manageError'), submit = $('manageSubmit');
    const MODES = {
      email: { title: 'Change email', submit: 'Save email', note: '', done: 'Email changed.' },
      password: { title: 'Change password', submit: 'Save password', note: 'At least 8 characters. This signs you out on your other devices.', done: 'Password changed.' },
      delete: { title: 'Delete account', submit: 'Delete my account', note: 'This permanently deletes your account and its stats. It cannot be undone.', done: 'Your account has been deleted.' }
    };
    let mode = null, busy = false;

    const showError = (msg) => {
      error.textContent = msg || '';
      error.classList.toggle('hidden', !msg);
    };
    // mode: null (the menu), one of MODES, or 'done' (a result message).
    const show = (m, doneText) => {
      mode = m;
      const def = MODES[m];
      $('manageTitle').textContent = def ? def.title : 'Account';
      $('manageMenu').classList.toggle('hidden', m !== null);
      $('manageFields').classList.toggle('hidden', !def);
      $('manageDone').classList.toggle('hidden', m !== 'done');
      $('manageDone').textContent = doneText || '';
      $('manageBack').classList.toggle('hidden', !def);
      email.value = current.value = next.value = confirm.value = '';
      showError('');
      if (!def) return;
      email.classList.toggle('hidden', m !== 'email');
      next.classList.toggle('hidden', m !== 'password');
      confirm.classList.toggle('hidden', m !== 'password');
      $('manageNote').textContent = def.note;
      $('manageNote').classList.toggle('hidden', !def.note);
      submit.textContent = def.submit;
      submit.classList.toggle('dangerBtn', m === 'delete');
      (m === 'email' ? email : current).focus();
    };
    const close = () => {
      overlay.classList.add('hidden');
      show(null);
    };

    $('accountManage').addEventListener('click', () => {
      show(null);
      overlay.classList.remove('hidden');
    });
    $('manageMenu').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-manage]');
      if (btn) show(btn.dataset.manage);
    });
    $('manageBack').addEventListener('click', () => show(null));
    $('manageClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });

    $('manageForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (busy || !MODES[mode]) return;
      const addr = email.value.trim();
      if (mode === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return showError('Enter a valid email address');
      if (!current.value) return showError('Enter your current password');
      if (mode === 'password' && next.value.length < 8) return showError('Password must be at least 8 characters');
      if (mode === 'password' && next.value !== confirm.value) return showError('The passwords do not match');

      const request = mode === 'email' ? Account.changeEmail(addr, current.value)
        : mode === 'password' ? Account.changePassword(current.value, next.value)
        : Account.deleteAccount(current.value);
      const done = MODES[mode].done;
      busy = true;
      submit.disabled = true;
      showError('');
      request.then(() => {
        show('done', done);
        this.renderAccount();
      }, (err) => showError(err.message)).then(() => {
        busy = false;
        submit.disabled = false;
      });
    });
  },

  renderAccount() {
    const strip = document.getElementById('accountStrip');
    strip.classList.toggle('hidden', !Account.available);
    if (!Account.available) return;
    Progress.accountChanged();
    const user = Account.user;
    document.getElementById('accountStatus').textContent = user ? 'Signed in as ' + user.email + ' ·' : 'Playing as guest ·';
    document.getElementById('accountSignIn').classList.toggle('hidden', !!user);
    document.getElementById('accountManage').classList.toggle('hidden', !user);
    document.getElementById('accountSignOut').classList.toggle('hidden', !user);
  },

  // The one name field on the main menu, shared by singleplayer, host and
  // join. Read (and remembered) at the moment a game or lobby is started, so
  // it is written once per use rather than on every keystroke. Empty means the
  // caller falls back to its own default.
  getPlayerName() {
    const name = (document.getElementById('playerName').value || '').trim();
    if (name) { try { localStorage.setItem('borderwar_username', name); } catch (e) { /* ignore */ } }
    // The optional team tag rides in the name as "[TAG] name" (OpenFront's
    // clan-tag convention), so it needs no protocol change; the sim reads it
    // back out in Teams.tagOf.
    const tag = (document.getElementById('playerTag').value || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5);
    document.getElementById('playerTag').value = tag;
    try { localStorage.setItem('borderwar_tag', tag); } catch (e) { /* ignore */ }
    // Signed in: the account remembers the name and tag too, so they follow
    // the player to another browser. Best effort; a name the server refuses
    // (it is stricter than this field) just stays local.
    const user = Account.user;
    if (user && ((name && name !== user.displayName) || tag !== user.tag)) {
      Account.saveProfile(name ? { displayName: name, tag: tag } : { tag: tag }).catch(() => {});
    }
    if (tag.length < 2) return name;
    return '[' + tag + '] ' + (name || 'Player');
  },

  // Read the host panel's controls into the shape `start_game` carries
  // ({map, mapSize, bots, tribes}), clamped like main.js's singleplayer start().
  getHostConfig() {
    const map = document.getElementById('hostMapType').value === 'world' ? 'world' : 'procedural';
    const mapSize = document.getElementById('hostMapSize').value;
    const bots = Math.max(0, Math.min(100, parseInt(document.getElementById('hostBotCount').value, 10) || 0));
    const tribes = Math.max(0, Math.min(400, parseInt(document.getElementById('hostTribeCount').value, 10) || 0));
    const difficulty = document.getElementById('hostDifficulty').value;
    const mode = this.getModeConfig('host');
    const gen = this.getMapGenConfig('host');
    const config = { map: map, mapSize: mapSize, mapGen: gen.mapGen, bots: bots, tribes: tribes,
      difficulty: difficulty, gameMode: mode.gameMode, playerTeams: mode.playerTeams,
      fogOfWar: mode.fogOfWar };
    // Procedural maps use the preview's seed; World keeps a fresh server seed.
    if (map === 'procedural') config.seed = gen.seed;
    return config;
  },

  // Issue #31: the Mode/Teams pair on the singleplayer ('') and host ('host')
  // panels, read into gameStartInfo.config's {gameMode, playerTeams}. A team
  // count is sent as an integer, the named modes (Duos, Humans Vs Nations...)
  // as their OpenFront strings.
  modeIds(prefix) {
    return prefix
      ? { mode: prefix + 'GameMode', teams: prefix + 'PlayerTeams', row: prefix + 'PlayerTeamsRow', fog: prefix + 'FogOfWar' }
      : { mode: 'gameMode', teams: 'playerTeams', row: 'playerTeamsRow', fog: 'fogOfWar' };
  },

  getModeConfig(prefix) {
    const ids = this.modeIds(prefix);
    const gameMode = document.getElementById(ids.mode).value === 'team' ? 'team' : 'ffa';
    const raw = document.getElementById(ids.teams).value;
    const playerTeams = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
    // Fog of war (docs/fog-of-war.md) rides in the same config.
    const fogOfWar = !!document.getElementById(ids.fog).checked;
    return { gameMode, playerTeams, fogOfWar };
  },

  // Ticking Fog of war hides the whole map preview block (canvas, note, seed
  // box and New map), so the host does not see the map the players will be
  // dropped into. Only the display changes: the seed input keeps its value,
  // so a procedural match still uses the seed the preview was last drawn
  // from, and un-ticking shows the block, which the ResizeObserver in
  // setupMapGen redraws.
  bindFogToggle(prefix) {
    const box = document.getElementById(this.modeIds(prefix).fog);
    const block = document.getElementById(this.mapGenId(prefix, 'mapPreviewBlock'));
    const sync = () => block.classList.toggle('hidden', box.checked);
    box.addEventListener('change', sync);
    // Browsers can restore a ticked box on reload without a change event.
    window.addEventListener('pageshow', sync);
    sync();
  },

  // The Teams row only shows once Teams is picked.
  bindModeSelect(prefix) {
    const ids = this.modeIds(prefix);
    const mode = document.getElementById(ids.mode);
    const sync = () => document.getElementById(ids.row).classList.toggle('hidden', mode.value !== 'team');
    mode.addEventListener('change', sync);
    sync();
  },

  // Create-game settings: each [data-pick] select shows as a row of tiles and
  // each [data-toggle] checkbox as a toggle tile. The native control stays the
  // source of truth (hidden), so reads and change listeners are unchanged.
  MAP_PICK_NOTES: { world: 'Real-world map', procedural: 'Generated, with a seed' },
  setupPickers() {
    for (const sel of document.querySelectorAll('select[data-pick]')) {
      const wrap = document.createElement('div');
      wrap.className = 'pickGrid' + (sel.dataset.pick === 'map' ? ' pickMap' : '');
      const tiles = Array.from(sel.options).map((opt) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pickTile';
        b.dataset.value = opt.value;
        b.innerHTML = '<b></b>' + (sel.dataset.pick === 'map' ? '<small></small>' : '');
        b.querySelector('b').textContent = opt.text;
        if (sel.dataset.pick === 'map') b.querySelector('small').textContent = this.MAP_PICK_NOTES[opt.value] || '';
        b.addEventListener('click', () => {
          if (sel.value === opt.value) return;
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        wrap.appendChild(b);
        return b;
      });
      const sync = () => tiles.forEach(t => t.classList.toggle('active', t.dataset.value === sel.value));
      sel.addEventListener('change', sync);
      window.addEventListener('pageshow', sync);
      sel.classList.add('hidden');
      sel.after(wrap);
      sync();
    }
    for (const box of document.querySelectorAll('input[data-toggle]')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pickTile toggleTile';
      b.title = box.title;
      b.textContent = box.dataset.toggle;
      b.addEventListener('click', () => {
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const sync = () => b.classList.toggle('active', box.checked);
      box.addEventListener('change', sync);
      window.addEventListener('pageshow', sync);
      box.classList.add('hidden');
      box.after(b);
      sync();
    }
  },

  // --- Procedural map options -------------------------------------------------
  //
  // The knobs under the Map row (Protocol.MAP_GEN, one select each), a live
  // preview and the seed it was drawn from, built into #mapGenBox /
  // #hostMapGenBox. main.js shows the box only while Procedural is picked.
  // The preview runs the real generator on its own small GameMap copy, never
  // the singleton, and at a fixed small size: shapes are drawn in map
  // fractions, so they match the chosen size closely (details like rivers and
  // specks of island differ a little).
  MAP_GEN_LABELS: {
    landform: ['Landform', { random: 'Random', continent: 'Continent', twin: 'Twin Continents',
      continents: 'Continents', archipelago: 'Archipelago', pangaea: 'Pangaea', inland: 'Inland Sea' }],
    land: ['Land', { normal: 'Normal', scarce: 'Scarce', abundant: 'Abundant' }],
    terrain: ['Terrain', { normal: 'Normal', flat: 'Flat', rugged: 'Rugged', alpine: 'Alpine' }],
    rivers: ['Rivers', { normal: 'Normal', none: 'None', few: 'Few', many: 'Many' }],
    coast: ['Coastline', { normal: 'Normal', smooth: 'Smooth', jagged: 'Jagged' }]
  },
  MAP_PREVIEW_W: 400,
  MAP_PREVIEW_H: 200,

  mapGenId(prefix, name) { return prefix ? prefix + name.charAt(0).toUpperCase() + name.slice(1) : name; },

  setupMapGen(prefix) {
    const box = document.getElementById(this.mapGenId(prefix, 'mapGenBox'));
    const select = (key) => {
      const [label, names] = this.MAP_GEN_LABELS[key];
      const opts = Protocol.MAP_GEN[key].map(v => '<option value="' + v + '">' + names[v] + '</option>').join('');
      return '<label>' + label + '<select id="' + this.mapGenId(prefix, 'gen_' + key) + '">' + opts + '</select></label>';
    };
    // The preview comes first (the wide layout puts it in the right pane, the
    // narrow one on top); the five knobs sit in a collapsed "Map options".
    box.innerHTML =
      '<div class="mapPreview" id="' + this.mapGenId(prefix, 'mapPreviewBlock') + '">' +
        '<canvas id="' + this.mapGenId(prefix, 'mapPreview') + '" width="' + this.MAP_PREVIEW_W +
          '" height="' + this.MAP_PREVIEW_H + '"></canvas>' +
        '<span id="' + this.mapGenId(prefix, 'mapPreviewNote') + '" class="mapPreviewNote"></span>' +
        '<div class="mapPreviewBar">' +
          '<label>Seed <input id="' + this.mapGenId(prefix, 'mapSeed') + '" type="number" min="0" max="4294967295"></label>' +
          '<button type="button" id="' + this.mapGenId(prefix, 'mapReroll') + '">New map</button>' +
        '</div>' +
      '</div>' +
      '<details class="mapOpts" id="' + this.mapGenId(prefix, 'mapOpts') + '">' +
        '<summary>Map options <span class="mapOptsSummary" id="' + this.mapGenId(prefix, 'mapOptsSummary') + '"></span></summary>' +
        '<div class="optRow2">' + select('landform') + select('land') + '</div>' +
        '<div class="optRow2">' + select('terrain') + select('rivers') + select('coast') + '</div>' +
        '<button type="button" class="linkBtn" id="' + this.mapGenId(prefix, 'mapOptsReset') + '">Reset</button>' +
      '</details>';

    const seedInput = document.getElementById(this.mapGenId(prefix, 'mapSeed'));
    seedInput.value = String(Math.floor(Math.random() * 1e9));
    for (const key of Object.keys(Protocol.MAP_GEN)) {
      document.getElementById(this.mapGenId(prefix, 'gen_' + key))
        .addEventListener('change', () => { this.updateMapOptsSummary(prefix); this.refreshMapPreview(prefix); });
    }
    document.getElementById(this.mapGenId(prefix, 'mapOptsReset')).addEventListener('click', () => {
      for (const key of Object.keys(Protocol.MAP_GEN)) {
        document.getElementById(this.mapGenId(prefix, 'gen_' + key)).selectedIndex = 0;
      }
      this.updateMapOptsSummary(prefix);
      this.refreshMapPreview(prefix);
    });
    this.updateMapOptsSummary(prefix);
    seedInput.addEventListener('change', () => this.refreshMapPreview(prefix));
    const reroll = () => {
      seedInput.value = String(Math.floor(Math.random() * 1e9));
      this.refreshMapPreview(prefix);
    };
    document.getElementById(this.mapGenId(prefix, 'mapReroll')).addEventListener('click', reroll);
    document.getElementById(this.mapGenId(prefix, 'mapSize')).addEventListener('change', reroll);
    // Draw whenever the preview comes into view, however it got there (tab
    // switch, Map select, the browser restoring the form on load): a hidden
    // canvas has no size, and gains one the moment it is shown.
    if (typeof ResizeObserver === 'function') {
      const canvas = document.getElementById(this.mapGenId(prefix, 'mapPreview'));
      new ResizeObserver(() => { if (canvas.clientWidth > 0) this.refreshMapPreview(prefix); }).observe(canvas);
    }
  },

  // The closed "Map options" header's one-liner: the landform, plus how many
  // of the other knobs are off their default (the first option of each).
  updateMapOptsSummary(prefix) {
    const sel = (key) => document.getElementById(this.mapGenId(prefix, 'gen_' + key));
    const landform = sel('landform');
    let changed = 0;
    for (const key of Object.keys(Protocol.MAP_GEN)) {
      if (key !== 'landform' && sel(key).selectedIndex !== 0) changed++;
    }
    document.getElementById(this.mapGenId(prefix, 'mapOptsSummary')).textContent =
      landform.options[landform.selectedIndex].text + (changed ? ' · ' + changed + ' changed' : '');
  },

  // {mapGen, seed} for gameStartInfo.config. An empty or invalid seed box
  // means a fresh random seed, as before the box existed.
  getMapGenConfig(prefix) {
    const mapGen = {};
    for (const key of Object.keys(Protocol.MAP_GEN)) {
      mapGen[key] = document.getElementById(this.mapGenId(prefix, 'gen_' + key)).value;
    }
    const raw = document.getElementById(this.mapGenId(prefix, 'mapSeed')).value.trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    const seed = n <= 0xFFFFFFFF ? n : Math.floor(Math.random() * 1e9);
    return { mapGen: Protocol.normalizeMapGen(mapGen), seed: seed };
  },

  // Redraws the preview shortly after the last change; generation takes a
  // noticeable moment, so a burst of changes only pays for one.
  refreshMapPreview(prefix) {
    this._previewTimers = this._previewTimers || {};
    clearTimeout(this._previewTimers[prefix]);
    this._previewTimers[prefix] = setTimeout(() => this.drawMapPreview(prefix), 80);
  },

  // Runs the real generator on a throwaway GameMap copy and paints the
  // unclaimed-ground view onto `canvas` (MAP_PREVIEW_W x _H). Returns the map,
  // or null if generation threw.
  paintMap(canvas, seed, mapGen) {
    const w = this.MAP_PREVIEW_W, h = this.MAP_PREVIEW_H;
    const map = Object.create(GameMap);
    try {
      map.generate(w, h, seed >>> 0, mapGen);
    } catch (e) {
      console.error('[map preview]', e);
      return null;
    }
    // Painted on a scratch canvas and stamped across with drawImage, as
    // menubg.js does: Firefox drops a putImageData made straight onto a
    // displayed (GPU-backed) canvas, leaving the preview blank.
    const off = this._previewScratch || (this._previewScratch = document.createElement('canvas'));
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h);
    // render.js's unclaimed-ground tones: water, plains, highland, mountain.
    const water = [18, 34, 60], ground = [[78, 94, 72], [104, 96, 66], [122, 120, 114]];
    for (let i = 0; i < w * h; i++) {
      const c = map.owner[i] === WATER ? water : ground[map.terrain[i]];
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    canvas.getContext('2d').drawImage(off, 0, 0);
    return map;
  },

  drawMapPreview(prefix) {
    const canvas = document.getElementById(this.mapGenId(prefix, 'mapPreview'));
    const note = document.getElementById(this.mapGenId(prefix, 'mapPreviewNote'));
    // Hidden (no size): the ResizeObserver in setupMapGen draws it once shown.
    if (!canvas || canvas.clientWidth === 0) return;
    const gen = this.getMapGenConfig(prefix);
    // Resizes (and repeat refreshes) with nothing changed keep the drawing.
    const key = gen.seed + JSON.stringify(gen.mapGen);
    this._previewKeys = this._previewKeys || {};
    if (this._previewKeys[prefix] === key) return;
    const map = this.paintMap(canvas, gen.seed, gen.mapGen);
    if (!map) {
      note.textContent = 'Preview unavailable';
      return;
    }
    this._previewKeys[prefix] = key;

    const names = this.MAP_GEN_LABELS.landform[1];
    const lm = map.landmasses.filter(l => l.size >= 400).length;
    note.textContent =
      (gen.mapGen.landform === 'random' ? 'Random: ' : '') + names[map.layout] +
      (lm > 1 ? ' · ' + lm + ' landmasses' : '');
  },

  getJoinInputs() {
    const code = (document.getElementById('joinCode').value || '').trim().toUpperCase();
    return { code: code, username: this.getPlayerName() };
  },

  // Issue #9: the host form's "Public" checkbox, read at the same moment
  // getHostConfig() is (hostLobby(), just before Transport.connect).
  isPublicLobby() {
    return !!document.getElementById('hostPublic').checked;
  },

  // The hero card above the mode tabs. `entry` is GET /lobbies' one
  // `isAuto` row, or null (poll pending, or server down). The button stays
  // live either way: with nothing to join it starts a match against bots.
  renderQuickJoin(entry) {
    const info = document.getElementById('quickJoinInfo');
    const btn = document.getElementById('quickJoinBtn');
    if (!entry) {
      this._quickJoinEntry = null;
      info.textContent = 'No open game right now. Play now starts a match against bots.';
      btn.disabled = false;
      this.renderQuickJoinMap(null);
      return;
    }
    this._quickJoinEntry = entry;
    this.updateQuickJoinInfo();
    // The poll only lands every few seconds; tick the countdown locally.
    if (!this._quickJoinTickID) {
      this._quickJoinTickID = setInterval(() => this.updateQuickJoinInfo(), 1000);
    }
    btn.disabled = !!entry.debugFake;
    this.renderQuickJoinMap(entry);
  },

  updateQuickJoinInfo() {
    const entry = this._quickJoinEntry;
    const info = document.getElementById('quickJoinInfo');
    if (!entry || !info) return;
    const mapLabel = String(entry.mapSize || '').replace(/^./, (c) => c.toUpperCase());
    let text = mapLabel + ' map · ' + entry.playerCount + '/' + entry.maxPlayers + ' players';
    if (typeof entry.autoStartAt === 'number') {
      const secs = Math.max(0, Math.round((entry.autoStartAt - Date.now()) / 1000));
      text += ' · starts in ' + secs + 's';
    } else if (entry.playerCount === 0) {
      text += ' · be the first in';
    }
    info.textContent = text;
  },

  // The open game's map, drawn from the seed the server picked for it. Only
  // repainted when the seed changes (the poll re-renders every 4s).
  renderQuickJoinMap(entry) {
    const wrap = document.getElementById('quickJoinMap');
    const canvas = document.getElementById('quickJoinMapCanvas');
    if (!entry || typeof entry.seed !== 'number') { wrap.classList.add('hidden'); return; }
    if (this._quickJoinSeed !== entry.seed) {
      const map = this.paintMap(canvas, entry.seed, Protocol.normalizeMapGen({}));
      if (!map) { wrap.classList.add('hidden'); return; }
      this._quickJoinSeed = entry.seed;
      const names = this.MAP_GEN_LABELS.landform[1];
      document.getElementById('quickJoinMapNote').textContent = names[map.layout] || '';
    }
    wrap.classList.remove('hidden');
  },

  // Renders manually-hosted public lobbies into the Join screen's list;
  // main.js filters the `isAuto` entry out first (it gets the hero card).
  // `onPick(gameID)` is called on click. Re-rendered wholesale each refresh.
  renderPublicLobbies(list, onPick) {
    const ul = document.getElementById('publicLobbyList');
    ul.innerHTML = '';
    if (!list || list.length === 0) {
      const li = document.createElement('li');
      li.className = 'lobbyListEmpty';
      li.textContent = 'No other public lobbies right now.';
      ul.appendChild(li);
      return;
    }
    list.forEach((entry) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = (entry.host || 'Host') + "'s game";
      const count = document.createElement('span');
      count.className = 'lobbyListCount';
      count.textContent = entry.playerCount + (entry.playerCount === 1 ? ' player' : ' players');
      li.appendChild(name);
      li.appendChild(count);
      li.addEventListener('click', () => onPick(entry.gameID));
      ul.appendChild(li);
    });
  },

  // Called the moment Transport.connect is issued, so the join code can be
  // shared while the socket is still opening.
  showHostLobby(gameID) {
    this.setLobbyError('');
    this._lobbyKnownIDs = null;
    document.getElementById('lobbyCode').textContent = gameID;
    document.getElementById('hostLobby').classList.remove('hidden');
    document.getElementById('hostCreateBtn').classList.add('hidden');
    document.getElementById('hostStartBtn').classList.add('hidden');
    document.getElementById('lobbyRoster').innerHTML = '';
    document.getElementById('hostPlayerCount').textContent = '';
    this.setLobbyStatus('host', 'Connecting to server…', false);
    this._hidePreLobbyChrome();
  },

  showJoinLobby() {
    this.setLobbyError('');
    this._lobbyKnownIDs = null;
    document.getElementById('joinLobby').classList.remove('hidden');
    document.getElementById('joinBtn').classList.add('hidden');
    document.getElementById('publicLobbyBrowser').classList.add('hidden');
    document.getElementById('joinRoster').innerHTML = '';
    document.getElementById('joinPlayerCount').textContent = '';
    this.setLobbyStatus('join', 'Connecting to server…', false);
    this._setOpenLobby(false);
    this._hidePreLobbyChrome();
  },

  // The open game's wait screen (#joinLobby.isOpen): what the match is, when
  // it starts, and a few tips to read meanwhile. Two pages of three, turned
  // every OPEN_LOBBY_TIP_MS. Open games always run with fog, so nothing here
  // mentions picking a spawn or shows the map.
  OPEN_LOBBY_TIP_MS: 9000,
  OPEN_LOBBY_TIPS: [
    { icon: 'troops', title: 'Grow your nation', text: 'Tap unclaimed land next to your border. Your troops march out and claim it.' },
    { icon: 'attack', title: 'Take tribes early', text: 'Beige land belongs to tribes. They make no alliances, so nobody comes to their defence.' },
    { icon: 'radio', title: 'The map starts hidden', text: 'You only see what you have discovered. Scouts, warships and Radio Towers reveal more.' },
    { icon: 'city', title: 'Build Cities', text: 'Cities raise your maximum troops.' },
    { icon: 'port', title: 'Build a Port', text: 'Ports earn gold from trade ships and launch your navy.' },
    { icon: 'ally', title: 'Make peace', text: 'Right-click a nation, or press and hold on a phone, and choose Peace. Allies cannot attack each other.' }
  ],

  // Play now, into the open game: switch to the wait screen straight away
  // from the menu's /lobbies entry, rather than when the first lobby_info
  // lands. Call after showJoinLobby, which resets it.
  showOpenLobby(entry) {
    this._setOpenLobby(true);
    this._renderOpenLobbyFacts(entry);
  },

  _setOpenLobby(on) {
    document.getElementById('joinLobby').classList.toggle('isOpen', on);
    if (this._olTipIntervalID) { clearInterval(this._olTipIntervalID); this._olTipIntervalID = null; }
    this._olCountdown = null;
    if (!on) return;
    document.getElementById('olTimerLabel').textContent = 'Connecting…';
    document.getElementById('olTimerNum').textContent = '';
    document.getElementById('olBarFill').style.width = '0';
    document.getElementById('olBots').textContent = '';
    this._renderOpenLobbyTips(0);
    this._restartOpenLobbyTipTimer();
    // Tapping the card turns the page; the dots jump to theirs.
    document.getElementById('olTips').onclick = (e) => {
      if (e.target.closest('.olDot')) return;
      this._turnOpenLobbyTips(this._olTipPage + 1);
    };
  },

  _renderOpenLobbyFacts(lobby) {
    const mapLabel = String(lobby.mapSize || '').replace(/^./, (c) => c.toUpperCase());
    document.getElementById('olFacts').textContent =
      (mapLabel ? mapLabel + ' map · ' : '') + (lobby.maxPlayers ? lobby.maxPlayers + ' nations · ' : '') + 'Fog of war';
  },

  // A page turned by hand gets its full time before the next automatic turn.
  _restartOpenLobbyTipTimer() {
    if (this._olTipIntervalID) clearInterval(this._olTipIntervalID);
    this._olTipIntervalID = setInterval(() => this._renderOpenLobbyTips(this._olTipPage + 1), this.OPEN_LOBBY_TIP_MS);
  },

  _turnOpenLobbyTips(page) {
    this._renderOpenLobbyTips(page);
    this._restartOpenLobbyTipTimer();
  },

  // Every page is laid out, stacked in one grid cell with only the current
  // one visible, so the card is as tall as its tallest page and never resizes.
  _renderOpenLobbyTips(page) {
    const PER_PAGE = 3;
    const pages = Math.ceil(this.OPEN_LOBBY_TIPS.length / PER_PAGE);
    page = ((page % pages) + pages) % pages;
    this._olTipPage = page;
    const list = document.getElementById('olTipList');
    list.innerHTML = '';
    this.OPEN_LOBBY_TIPS.forEach((tip, n) => {
      if (n % PER_PAGE === 0) {
        const group = document.createElement('div');
        group.className = 'olTipPage' + (n / PER_PAGE === page ? ' on' : '');
        list.appendChild(group);
      }
      const row = document.createElement('div');
      row.className = 'olTip';
      const img = document.createElement('img');
      img.className = 'ic';
      img.src = 'assets/icons/' + tip.icon + '.svg';
      img.alt = '';
      img.draggable = false;
      const body = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = tip.title;
      const text = document.createElement('span');
      text.textContent = tip.text;
      body.appendChild(title);
      body.appendChild(text);
      row.appendChild(img);
      row.appendChild(body);
      list.lastChild.appendChild(row);
    });
    const dots = document.getElementById('olTipDots');
    dots.innerHTML = '';
    for (let i = 0; i < pages; i++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'olDot' + (i === page ? ' on' : '');
      dot.setAttribute('aria-label', 'Tips page ' + (i + 1));
      dot.addEventListener('click', () => this._turnOpenLobbyTips(i));
      dots.appendChild(dot);
    }
  },

  // `autoStartAt` is null until enough players are in. The bar drains from
  // wherever the countdown stood when this client first saw it.
  _renderOpenLobbyTimer(autoStartAt, waitingText) {
    const label = document.getElementById('olTimerLabel');
    const num = document.getElementById('olTimerNum');
    const fill = document.getElementById('olBarFill');
    if (typeof autoStartAt !== 'number') {
      this._olCountdown = null;
      label.textContent = waitingText;
      num.textContent = '';
      fill.style.width = '0';
      return;
    }
    const left = Math.max(0, autoStartAt - Date.now());
    if (!this._olCountdown || this._olCountdown.at !== autoStartAt) {
      this._olCountdown = { at: autoStartAt, total: Math.max(left, 1) };
    }
    const secs = Math.round(left / 1000);
    label.textContent = 'Starts in';
    num.textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    fill.style.width = (100 * left / this._olCountdown.total) + '%';
  },

  // Play now, into the open game: the menu's hero card is hidden once
  // connected, so carry its already-painted map into the lobby panel.
  showJoinLobbyMap() {
    const src = document.getElementById('quickJoinMapCanvas');
    const dst = document.getElementById('joinLobbyMapCanvas');
    const wrap = document.getElementById('joinLobbyMap');
    if (document.getElementById('quickJoinMap').classList.contains('hidden')) {
      wrap.classList.add('hidden');
      return;
    }
    dst.getContext('2d').drawImage(src, 0, 0);
    document.getElementById('joinLobbyMapNote').textContent =
      document.getElementById('quickJoinMapNote').textContent;
    wrap.classList.remove('hidden');
  },

  // While connected to a lobby, hide the other ways to start a match so
  // the lobby screen is the only thing on screen.
  _hidePreLobbyChrome() {
    document.getElementById('nameRow').classList.add('hidden');
    document.getElementById('quickJoin').classList.add('hidden');
    document.querySelector('.orDivider').classList.add('hidden');
    document.getElementById('modeTabs').classList.add('hidden');
  },

  // Back to the plain create/join forms. Used by Leave, by a lost connection,
  // and when the match-end screen returns to the menu, so a dead lobby's code
  // and roster never linger.
  hideLobby() {
    this._lobbyKnownIDs = null;
    if (this._autoLobbyCountdownIntervalID) {
      clearInterval(this._autoLobbyCountdownIntervalID);
      this._autoLobbyCountdownIntervalID = null;
    }
    this._autoLobbyCountdown = null;
    this._setOpenLobby(false);
    document.getElementById('hostLobby').classList.add('hidden');
    document.getElementById('hostCreateBtn').classList.remove('hidden');
    document.getElementById('joinLobby').classList.add('hidden');
    document.getElementById('joinLobbyMap').classList.add('hidden');
    document.getElementById('joinBtn').classList.remove('hidden');
    document.getElementById('publicLobbyBrowser').classList.remove('hidden');
    document.getElementById('nameRow').classList.remove('hidden');
    document.getElementById('quickJoin').classList.remove('hidden');
    document.querySelector('.orDivider').classList.remove('hidden');
    document.getElementById('modeTabs').classList.remove('hidden');
  },

  // `ok` adds the green "live" dot; the connecting state has none.
  setLobbyStatus(role, text, ok) {
    const el = document.getElementById(role === 'host' ? 'hostStatus' : 'joinStatus');
    el.textContent = text;
    el.classList.toggle('ok', !!ok);
  },

  // Copies a direct invite link (main.js opens ?join=CODE straight into the
  // lobby). Nothing is written to the clipboard unless the browser allows it;
  // the code is on screen either way, so a refusal is not worth an error.
  copyLobbyCode() {
    const code = document.getElementById('lobbyCode').textContent;
    if (!code || !navigator.clipboard) return;
    navigator.clipboard.writeText('https://borderwar.io/?join=' + encodeURIComponent(code)).then(() => {
      this.setLobbyStatus('host', 'Invite link copied — share it with your friends.', true);
    }, () => { /* clipboard blocked */ });
  },

  // Rendered from a `lobby_info` broadcast. `role` ('host' or 'join')
  // picks which panel's roster to update; `isHost` gates #hostStartBtn. The
  // join panel has no Start button in the DOM at all.
  updateLobbyFromInfo(lobby, role, isHost, myClientID) {
    const players = (lobby && lobby.players) || [];
    const creatorClientId = lobby && lobby.creatorClientId;

    // Anyone not in the previous roster gets a brief highlight — but not on the
    // first roster we receive, where everybody is "new" only to us.
    const known = this._lobbyKnownIDs;
    const fresh = new Set();
    if (known) for (const p of players) if (!known.has(p.clientID)) fresh.add(p.clientID);
    this._lobbyKnownIDs = new Set(players.map((p) => p.clientID));

    const ids = role === 'host'
      ? { roster: 'lobbyRoster', count: 'hostPlayerCount' }
      : { roster: 'joinRoster', count: 'joinPlayerCount' };
    // No human host to badge in an auto lobby (issue #12) — creatorClientId
    // here is just whichever player happened to join first, not a role.
    const open = role === 'join' && !!(lobby && lobby.isAuto);
    this.renderLobbyRoster(document.getElementById(ids.roster), players,
      (lobby && lobby.isAuto) ? null : creatorClientId, myClientID, fresh, open);
    document.getElementById(ids.count).textContent = '(' + players.length + ')';

    // The open game's wait screen. Also reached by typing the open game's
    // code into the join form, which showOpenLobby never saw.
    const humans = players.filter((p) => !p.spectator).length;
    if (open) {
      if (!document.getElementById('joinLobby').classList.contains('isOpen')) this._setOpenLobby(true);
      this._renderOpenLobbyFacts(lobby);
      const need = Math.max(0, (lobby.minPlayers || 2) - humans);
      this._renderOpenLobbyTimer(lobby.autoStartAt,
        need > 0 ? 'Waiting for ' + need + ' more player' + (need === 1 ? '' : 's') : 'Starting soon');
      const bots = Math.max(0, (lobby.maxPlayers || 0) - humans);
      document.getElementById('olBots').textContent =
        bots > 0 ? '+ ' + bots + (bots === 1 ? ' bot fills' : ' bots fill') + ' the rest' : '';
    }

    let status;
    const newcomer = players.find((p) => fresh.has(p.clientID));
    if (newcomer) status = (newcomer.username || 'A player') + ' joined the lobby.';
    else if (role === 'host') status = players.length > 1 ? 'Ready when you are.' : 'Lobby open — waiting for players to join.';
    // An auto lobby has no host: say so, and show the countdown once
    // lobby.autoStartAt is set.
    else if (lobby && lobby.isAuto) {
      status = typeof lobby.autoStartAt === 'number'
        ? 'Match starting soon.'
        : 'Open lobby — starts once ' + (lobby.minPlayers || 2) + ' or more players join.';
    }
    else status = 'Connected to the lobby.';
    this.setLobbyStatus(role, status, true);

    // lobby_info only arrives on roster or countdown changes, so tick the
    // text locally once a second from lobby.autoStartAt.
    this._autoLobbyCountdown = (lobby && lobby.isAuto && typeof lobby.autoStartAt === 'number')
      ? { role: role, autoStartAt: lobby.autoStartAt }
      : null;
    if (this._autoLobbyCountdown && !this._autoLobbyCountdownIntervalID) {
      this._autoLobbyCountdownIntervalID = setInterval(() => this._tickAutoLobbyCountdown(), 1000);
    } else if (!this._autoLobbyCountdown && this._autoLobbyCountdownIntervalID) {
      clearInterval(this._autoLobbyCountdownIntervalID);
      this._autoLobbyCountdownIntervalID = null;
    }

    if (role === 'host') document.getElementById('hostStartBtn').classList.toggle('hidden', !isHost);
    // The static join caption assumes a human host; blank it for an auto lobby.
    if (role === 'join') {
      document.getElementById('joinWaiting').textContent =
        (lobby && lobby.isAuto) ? '' : 'Waiting for the host to start…';
    }
  },

  // Runs once a second while an auto lobby's countdown is live; recomputes
  // the 'Starting in Ns…' text from the stored autoStartAt.
  _tickAutoLobbyCountdown() {
    const state = this._autoLobbyCountdown;
    if (!state) return;
    this._renderOpenLobbyTimer(state.autoStartAt, '');
  },

  // `swatches` (open game only): each player's nation colour. Game.init gives
  // human N, counted in roster order without spectators, PLAYER_COLORS[N]; a
  // free-for-all never recolours them. Someone ahead leaving shifts the rest.
  renderLobbyRoster(ul, players, creatorClientId, myClientID, fresh, swatches) {
    ul.innerHTML = '';
    let slot = 0;
    for (const p of players) {
      const li = document.createElement('li');
      li.textContent = p.username || ('Player ' + p.clientID);
      const title = Progress.titleName(p.cosmetics && p.cosmetics.title);
      if (title) li.insertAdjacentHTML('beforeend', ` <small class="playerTitle">${escapeHtml(title)}</small>`);
      if (swatches && !p.spectator) {
        const sw = document.createElement('span');
        sw.className = 'rosterSwatch';
        sw.style.background = 'rgb(' + PLAYER_COLORS[slot++ % PLAYER_COLORS.length].join(',') + ')';
        li.prepend(sw);
      }
      if (p.clientID === creatorClientId) li.classList.add('isHost');
      if (p.clientID === myClientID) li.classList.add('isYou');
      if (fresh && fresh.has(p.clientID)) li.classList.add('justJoined');
      ul.appendChild(li);
    }
  },

  setLobbyError(msg) {
    const el = document.getElementById('lobbyError');
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  },

  // Diagnostic notice that the server's hash tally flagged this client.
  // Informational only: shown once and left up for the rest of the match
  // (the server never re-notifies); clicking it away is a convenience.
  showDesyncWarning(text) {
    const el = document.getElementById('desyncBanner');
    const textEl = document.getElementById('desyncBannerText');
    if (!el || !textEl) return;
    textEl.textContent = text;
    el.classList.remove('hidden');
  },

  // How many turns behind counts as 'catching up' rather than jitter:
  // about 1s of game time at 100ms/turn.
  CATCHUP_THRESHOLD: 10,

  // Called once a frame with Runner's queued turn count. Readout only:
  // show the banner while meaningfully behind, hide it when the backlog
  // is gone. Driven by the count alone, not a reconnect flag.
  updateCatchup(pendingTurns) {
    const el = document.getElementById('catchupBanner');
    if (!el) return;
    if (pendingTurns >= this.CATCHUP_THRESHOLD) {
      document.getElementById('catchupBannerText').textContent =
        'Catching up — ' + pendingTurns + ' turns behind';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }
};
