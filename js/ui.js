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

  // Debug-panel nuke: 'debugnuke' is a distinct UI.placing value (armed via
  // armDebugNuke, not togglePlacing/Game.UNITS) since it's a two-click flow
  // — first click picks the launch point, second picks the target — rather
  // than the single-click "strike here" the real atombomb/hydrogenbomb
  // placing values use. debugNukeType holds which bomb is armed;
  // debugNukeSrc is -1 while waiting for the first click, then the launch
  // tile while waiting for the second. See onTap's 'debugnuke' branch and
  // Game.debugNuke.
  debugNukeType: null,
  debugNukeSrc: -1,
  // Whether the debug panel is expanded; closed by default, toggled by #debugToggle.
  debugOpen: false,

  // The player's own warships currently selected via Input's shift-drag box
  // (or a shift-click on a single one) — see selectWarshipsInBox/
  // selectWarshipAt below. Holds direct object references straight into
  // Game.warships, same identity-based pattern updateFronts already uses
  // for attack/boat chips, so nothing here goes stale across a splice
  // elsewhere in that array.
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
    this.setupLobby();
    this.setupAccount();
    this.setupReplays();

    // DEBUG BYPASS #1 — dev-only gold cheats.
    //
    // These write straight into the simulation, which is exactly what nothing
    // else in this file is allowed to do any more (MP-1.5: every player action
    // is an intent, and Executor is the only thing that mutates Game). It is a
    // deliberate exception, and it is legitimate for one reason only: there is
    // no gold intent and there is not going to be one — §4 lists the debug
    // gold buttons among the things that are "singleplayer-only and must be
    // hard disabled in multiplayer, not converted to intents". Handing one
    // client a private +5M would desync the match on the next hash.
    //
    // So it is gated on Transport.isLocal, twice: here, and by hiding the whole
    // panel in update(). The panel is also hidden until a match exists so it
    // can't be pressed against an empty player list.
    for (const btn of document.querySelectorAll('#debugPanel button[data-gold]')) {
      btn.addEventListener('click', () => {
        if (!Transport.isLocal) return;
        const me = Game.players[Game.me];
        if (me) me.gold += +btn.dataset.gold;
      });
    }

    // Mean match length is ~630s over six seeds (see game/combat.js's "How fast a
    // front advances" comment) — 300s of simulated time lands roughly at the
    // midpoint, with
    // nations built up, bots fighting, and territory well past the opening land
    // grab. 300s is 3000 turns at Game.TICK_DT.
    //
    // NOT a bypass, unlike the two either side of it. This used to be
    // Game.fastForward(300), a bare `for (…) Game.tick()` loop that reached
    // past the whole pipeline — and, being synchronous, hung the tab for the
    // length of the burst. LocalServer.burst emits the same 3000 turns through
    // the ordinary path (bucketed as turns, queued in Runner, applied by
    // Executor, one tick each), as fast as this client drains them and no
    // faster, so the page keeps rendering the whole way through and what you
    // watch is genuinely the same simulation you would have played. Still
    // singleplayer-only in effect — a real server would ignore the request —
    // but there is nothing here for it to desync.
    document.getElementById('debugFastForward').addEventListener('click', () => {
      if (!Transport.isLocal) return;
      LocalServer.burst(Math.round(300 / Game.TICK_DT));
    });

    // Speed-up: cycles LocalServer.speed, which only shortens the pump's turn
    // gate. Turns still flow through the normal path, so nothing to desync;
    // singleplayer only. Backpressure caps it at what the client can drain.
    document.getElementById('debugSpeed').addEventListener('click', () => {
      if (!Transport.isLocal) return;
      const steps = [1, 2, 4, 8, 16];
      LocalServer.speed = steps[(steps.indexOf(LocalServer.speed) + 1) % steps.length];
    });

    document.getElementById('pauseBtn').addEventListener('click', () => this.togglePause());
    document.getElementById('musicBtn').addEventListener('click', () => this.toggleMusic());

    document.getElementById('debugToggle').addEventListener('click', () => {
      this.debugOpen = !this.debugOpen;
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
        this.cancelPlacing();
        this.clearShipSelection();
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

  // Singleplayer only, and only while a match is live: LocalServer stops its
  // pump when paused, which freezes the sim since it advances on turn arrival.
  togglePause() {
    if (Replay.active) { Replay.setPaused(Replay.ended() ? false : !Replay.paused); return; }
    if (!Transport.isLocal || !Game.players[Game.me] || Game.winnerId !== null) return;
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

    // The scrollbar is hidden (see #buildBar::-webkit-scrollbar in style.css),
    // so on a narrow window a mouse user has no visible handle and no touch
    // surface to reach the buttons past the fold — only a shift-scroll or a
    // trackpad's horizontal gesture would move it otherwise. Redirecting a
    // plain vertical wheel here is the same trick most horizontal carousels
    // use to stay reachable with an ordinary mouse.
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

  // (Re)writes the buttons. Entries marked fogOnly (the Scout) are in the bar
  // only while the match has fog: the bar is first built at page load, before
  // any match has said whether it has fog, so syncBuildBar redoes it when the
  // answer changes from one match to the next. A fog-off bar comes out exactly
  // as it always was.
  rebuildBuildBar() {
    const bar = document.getElementById('buildBar');
    const fog = this._barFog = !!Game.fog;
    bar.innerHTML = Game.UNITS.filter(u => !u.fogOnly || fog).map(u =>
      `<button class="buildBtn" data-type="${u.type}">
         <span class="bbKey">${u.hotkey || this.EXTRA_HOTKEYS[u.type] || ''}</span>
         <span class="bbIcon">${iconHtml(this.UNIT_ICONS[u.type] || u.type)}</span>
         <span class="bbBody">
           <span class="bbName">${u.name}</span>
           <span class="bbCost"></span>
         </span>
         <span class="bbCount"></span>
       </button>`).join('');

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

  // Cheap enough for every frame; a no-op unless the match's fog setting
  // differs from what the bar was built for.
  syncBuildBar() {
    if (this._barFog !== !!Game.fog) this.rebuildBuildBar();
  },

  // Drag-to-place: pressing a build button and dragging up onto the map arms
  // it and carries the placement ghost along; letting go places it there, as
  // a tap on that spot would. Mostly for touch, which has no hover and so
  // otherwise never sees the ghost before committing. Dragging sideways still
  // scrolls the bar (touch-action: pan-x on .buildBtn), which is why only an
  // upward drag starts one.
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
    // the nearest tile that is clear of it (and, for a Port, on the coast).
    // Warship placement has no click-time snap at all — a click can land
    // anywhere on the map (Game.resolveWarshipLaunch snaps it to the nearest
    // open water and picks a launching Port on its own) — and
    // structureSiteNear answers -1 for it and every other non-structure, so
    // those just get the raw tile.
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
    if (!Transport.isLocal) return;
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
    if (!Transport.isLocal || !Game.running) return;
    const me = Game.players[Game.me];
    if (!me || !me.alive) return;
    for (const tile of [...me.tiles]) Game.setOwner(tile, NEUTRAL);
    me.troops = 0;
    Game.eliminatePlayer(me);
  },

  armDebugPeace() {
    if (!Game.running) return;
    // DEBUG BYPASS #3 — singleplayer only, same reasoning as armDebugNuke.
    if (!Transport.isLocal) return;
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

  // The player's own warships and scouts whose drawn hull falls inside a
  // shift-drag box, in CSS-pixel client coordinates (same space screenToTile/
  // findStructureNear use) — replaces whatever was selected before, same as
  // a fresh marquee in any RTS. An empty box (nothing of yours inside it)
  // simply clears the selection. A scout the fog hides cannot be picked, like
  // everything else the fog hides; one's own never is, since a scout lights up
  // the water around it.
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
  // docs/fog-of-war.md, "Meeting a nation". Contact is sim state
  // (Game.hasMet); these two only read it. Everything in the UI that names a
  // nation goes through nameOf(), and everything that shows a nation's details
  // or acts on one asks knows() first, so the rule lives in one place. Both
  // answer "yes, the real name" whenever Render.fogActive() is false: a fog-off
  // match, the end of a match, and an eliminated viewer all see everything.
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
    // MP-3.5: whether this client has already reacted to Game.winnerId — see
    // checkEndGame. A fresh match's Game.init() puts winnerId back to null,
    // but reset() runs on that same restart, so this has to be cleared here
    // too or a second match would find it still true from the first.
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
    // MP-4.1: a fresh match starts with nothing queued — no reason for a
    // stale "catching up" readout from whatever this client was doing before
    // to still be on screen. updateCatchup would hide it on the next frame
    // regardless (pendingTurns() is 0 right after Runner.reset()), but a
    // restart shows the menu overlay for a beat first, so hide it explicitly
    // here rather than leave it visible during that gap.
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

  // True between the two calls above. The banner used to come down on the
  // click that placed the capital, because that click WAS the placement. It
  // isn't any more — the tap sends a `spawn` intent and the capital appears a
  // turn later (§5) — so the banner now comes down when the simulation says
  // the spawn phase is over, which update() watches for. Tracked as a flag
  // rather than read back off the DOM so there is one owner of the state.
  spawnBannerOpen: false,

  // A spawn intent is in flight. Purely for what the banner says; a second tap
  // is deliberately still allowed to send another (the first one to be applied
  // wins and the rest are dropped by spawnBlockReason inside the Executor), so
  // a spawn that is refused for any reason can never wedge the player on a
  // banner that no longer does anything.
  spawnSent: false,

  SPAWN_HINT: 'Tap the map to place your capital',
  SPAWN_SENT_HINT: 'Placing your capital…',
  // Fog matches: spawns are random and fixed, so there is nothing to tap.
  SPAWN_FOG_HINT: 'You start here',

  flashSpawn(text) {
    this.spawnFlashText = text;
    this.spawnFlashUntil = performance.now() + 1400;
  },

  // How many troops the ratio slider actually commits, next to the percent
  // itself — the percent alone means nothing without a sense of scale, and
  // this is the same Math.floor(me.troops * this.ratio) onTap and Radial's
  // boat/attack launchers use, so the readout never promises a size the
  // click doesn't deliver. Called both on slider input (immediate feedback)
  // and every update() tick (troops change on their own between drags).
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
    // MP-3.2: the spawn phase is now a fixed timed window (up to 15s with
    // 2+ humans), not "ends the instant someone taps" — without a visible
    // countdown that reads as the game having frozen. Game.spawnPhaseTicks is
    // the phase's own turn counter (Game.ticks stays frozen at 0 throughout
    // the whole spawn phase by design, so it can't drive this).
    const remaining = Math.max(0, Math.ceil((Game.SPAWN_PHASE_TURNS - Game.spawnPhaseTicks) * Game.TICK_DT));
    const hint = Game.fog ? this.SPAWN_FOG_HINT : (this.spawnSent ? this.SPAWN_SENT_HINT : this.SPAWN_HINT);
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
    document.getElementById('hpName').textContent = p.name;
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

    // Treasuries are public in OpenFront — its leaderboard carries a gold
    // column for every nation — so what a rival can afford is meant to be
    // readable before you decide whether to fight them. The per-second rate
    // is dropped here since it's the same formula for every nation and adds
    // nothing a rival doesn't already know.
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
      // Advisory, not authoritative: spawnBlockReason runs again inside the
      // Executor when the intent comes back, and that verdict is the one that
      // counts. Running it here too is what keeps an illegal tap refused
      // instantly, with the reason on the banner, instead of costing a round
      // trip to say nothing happened.
      const reason = Game.spawnBlockReason(tile);
      if (reason) { this.flashSpawn(reason); return; }
      Transport.sendIntent(Protocol.intent.spawn(tile));
      // The banner stays up until the sim leaves the spawn phase — see
      // spawnBannerOpen and update(). Nothing has been placed yet.
      this.spawnSent = true;
      return;
    }
    if (!Game.running) return;

    // Debug panel's two-click nuke: first tap sets the launch point and
    // stays armed for the second, which fires it via Game.debugNuke and
    // disarms — unlike the real atombomb/hydrogenbomb branch below, any tile
    // at all works for both clicks since there's no Silo/cooldown/gold to
    // resolve against.
    if (this.placing === 'debugnuke') {
      const tile = Render.screenToTile(sx, sy);
      if (tile < 0) { this.flash('Off the map'); return; }
      if (this.debugNukeSrc < 0) {
        this.debugNukeSrc = tile;
        return;
      }
      // DEBUG BYPASS #2 — mutates the sim directly. There is no intent for
      // this and §4 says there must not be one: Game.debugNuke fires a bomb
      // with no Silo, no cooldown and no gold, from an arbitrary tile, which
      // is a dev tool for looking at blast/fallout behaviour rather than a
      // move a player can make. Singleplayer only — armDebugNuke refuses to
      // arm it when the transport is not local, and update() hides the panel.
      if (!Transport.isLocal) return;
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
      if (!Transport.isLocal) return;
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

    // Warship placement is its own branch, not the generic land-structure one
    // below: it's priced/placed via warshipBlockReason/buildWarship rather
    // than buildBlockReason/build, since a Warship click means "launch one
    // toward here," not "place one exactly here" — Game.resolveWarshipLaunch
    // picks the nearest owned Port to launch from and snaps the click to the
    // nearest open water on its own (per the user's explicit design request:
    // no coast-clicking required, and a Port is a hard requirement).
    // findStructureNear/upgrade never apply to it (Game.buildings has no
    // warship entries — nothing to upgrade), and it spawns instantly rather
    // than arming a construction timer.
    if (this.placing === 'warship') {
      const tile = Render.screenToTile(sx, sy);
      const reason = Game.warshipBlockReason(Game.me, tile);
      if (reason) {
        this.flash(reason);
        // "No open water there"/"No sea route there" are about THIS specific
        // click, not about being unable to build one at all — stay armed so
        // the player can just click elsewhere. Everything else (no Port, no
        // gold, fleet capped) means the order can't succeed anywhere right
        // now, so it disarms rather than leaving a placement armed that
        // every subsequent tap would also refuse.
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

    // Atom/Hydrogen Bomb: same "click anywhere, the game resolves the
    // launch point" shape as Warship above, via Game.resolveNukeLaunch/
    // nukeBlockReason/launchNuke rather than buildBlockReason/build — a
    // nuke click means "strike here," not "place one exactly here," and
    // unlike a Warship purchase, any tile at all (land, water, even the
    // player's own territory) is a legal target, so there's no snap-related
    // reason text to special-case the way Warship's "No open water there"
    // is.
    // MIRV (ticket #28) rides this exact same branch — nukeBlockReason/
    // Protocol.intent.buildUnit are both already generic over nukeType/unit,
    // and the executor routes 'mirv' to Game.launchMirv on its own (see its
    // own comment), so nothing here needs to know MIRV is a different shape
    // once it's airborne.
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

    // A selected fleet consumes the next tap as a relocate order — shift-
    // drag/shift-click select first (Input.onUp), then a plain click here
    // moves them (see Game.moveWarships/warshipPatrol). moveWarships itself
    // snaps a non-water click to the nearest open water (same leniency a
    // purchase click gets) and returns false only when nothing reachable is
    // nearby at all — that's read as the player pointing somewhere else on
    // purpose, and the tap falls through to whatever it would normally do
    // (attack, etc.) instead of silently eating it. Either way the selection
    // is dropped right after this tap: an early version kept it armed for a
    // follow-up order, but in practice a player who has already moved on to
    // a normal tap has no way to tell the fleet is still selected — the only
    // way out was Esc, which nothing on screen suggested. Selecting again is
    // one shift-drag away if another order is actually wanted.
    //
    // MP-1.5 changed how "did this tap get consumed" is decided. It used to be
    // Game.moveWarships' own return value, which is no longer available: an
    // intent cannot answer, because the answer does not exist until the turn
    // comes back. So the decision is made here, up front, from the same sim
    // query moveWarships itself starts with — is there reachable water near
    // the tap at all. That is the case the old return value was really
    // reporting: a tap far inland is the player pointing at something else and
    // should fall through to a normal attack.
    //
    // One deliberate behaviour change falls out of that. moveWarships also
    // returns false when water is close by but no selected ship can find a sea
    // route to it (an enclosed lake, the far side of a continent); that tap now
    // consumes the selection and issues an order that the Executor quietly
    // drops, rather than falling through to an attack. Re-running seaPath for
    // every selected ship on the click — a full water search across the map,
    // done twice, once here and once for real a turn later — is not worth
    // buying that case back.
    //
    // Fog of war: the selection can hold scouts too, and the tap orders both.
    // A scout goes wherever the tap was (moveScout never refuses a tile, so
    // the tap is always consumed). A warship still needs a tap on discovered
    // water, so in a mixed selection it simply stays put when the tap is in
    // the black, and the hint line says so.
    if (this.selectedWarships.size || this.selectedScouts.size) {
      const tile = Render.screenToTile(sx, sy);
      // Objects can't cross a wire, so the order names ids (MP-1.2). Ships
      // that have sunk since the selection was made are skipped here; the
      // Executor drops any that sink in the ~100 ms after, so an order over a
      // fleet that is losing ships still moves the ones that are left.
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
      // Tapping anywhere across an existing same-type structure's drawn disc
      // — not just its exact backing tile — upgrades it instead of placing a
      // new one, matching how big the icon actually looks on screen. Checked
      // ahead of screenToTile's exact-tile hit test (and its own tile<0
      // guard) since the disc's buffer can extend past what that single tile
      // would resolve to. The same button doing double duty this way matches
      // OpenFront's own build menu (its buildableUnits() resolves to either
      // canBuild or canUpgrade depending on what's already standing there).
      // OpenFront also reads a click anywhere inside the minimum spacing
      // around one (Game.upgradeTargetNear) the same way, since nothing new
      // could be built that close to it anyway.
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
        // Most refusals stay armed and just say why — a fat-fingered tap can
        // land on an occupied tile or you can be a coin short, and disarming
        // on every one of those would make placing anything a chore. But a
        // tap off your own land entirely (including off the map, which also
        // reads as tile < 0 and lands here) isn't a near miss, it's the player
        // pointing somewhere else on purpose — so that one cancels placement
        // instead of also needing the hotkey/button.
        if (reason === 'Your own land only') { this.placing = null; this.placeHover = -1; }
        return;
      }
      // The snapped tile is what travels — unlike the warship/boat cases, the
      // snapping here is click interpretation (findRailSnapTile literally
      // reads screen pixels) rather than a rule of the sim, so it stays on the
      // client and the resolved tile goes on the wire. executor.js's
      // build_unit comment says the same thing from the other end.
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

    // A tile whose whole connected patch of territory is walled in by our
    // own land falls for free — no siege, no troops — per OpenFront's rule,
    // and *every* such patch of theirs falls on the same tap, not just the
    // one that got clicked. That second half is what makes cleaning up after
    // a nuke bearable: the blast leaves their survivors scattered through
    // irradiated ground, and once we have resettled that ground each survivor
    // is its own sealed one-tile pocket. Taking only the tapped one meant
    // picking the rest off pixel by pixel.
    //
    // No early return: whatever of theirs is still standing against our
    // border — the specks the blast left touching unclaimed fallout, their
    // mainland — falls through to the ordinary attack below, so one tap goes
    // after everything of theirs we are touching. launchAttack costs nothing
    // if there is no longer anything to touch (its frontier scan comes up
    // empty and it commits no troops), which is exactly the case when the
    // annexation above just finished them off.
    //
    // The intent carries the tapped tile and nothing else. The enclosed region
    // is not computed here and shipped: enclosedPocketsOf runs inside the
    // Executor, off sim state, so every client derives the same pockets on the
    // same turn — and the target nation comes back out of GameMap.owner[tile]
    // there too, rather than being a second thing on the wire that could
    // disagree with the first.
    if (target >= 0) Transport.sendIntent(Protocol.intent.annexRegion(tile));

    // Land only: it expands the whole border we share with that nation or
    // neutral land on the tapped tile's own landmass, regardless of precisely
    // which tile on that landmass got tapped, and simply does nothing if we
    // don't touch them there. This deviates from OpenFront's plain-click
    // (which expands every border touching that nation, on any landmass) so
    // that fighting the same enemy across two separate islands stays two
    // separate fronts — see Game.launchAttack's landmassId comment. A boat is
    // a deliberate action from here — right-click or hold the tile for the
    // radial menu — except a short hop, which the quick-boat check below
    // sends straight away.
    //
    // Both intents go out on the same tap and in this order, which is the
    // order they will be applied in: a turn's intents are an ordered list and
    // the server buckets them as they arrive (§1). So the annexation still
    // resolves before the attack scans the frontier, exactly as when both were
    // direct calls.
    //
    // The troop count is absolute, not the ratio: the slider is client-local
    // view state and its value travels inside the intent (§4).
    const me = Game.players[Game.me];
    const troops = Math.floor(me.troops * this.ratio);

    // Quick boat (ticket #27): a tap on a target we don't touch by land on
    // that landmass, but that sits a short sail from our coast, sends the
    // same `boat` intent the radial's Boat wedge does instead of a land attack
    // that would find no frontier and do nothing. Anything farther than
    // QUICK_BOAT_MAX_STEPS still needs the radial, so a long crossing is
    // always a deliberate choice. Checked only here, on the click itself —
    // never on hover.
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

    // Dev-only cheats: live for the whole match, including spawn selection,
    // same as the leaderboard — gone before a match exists, and gone entirely
    // once the transport is not local, because two of the three controls on
    // the panel reach past the intent pipeline into the sim (see the DEBUG
    // BYPASS notes in setup()) and would desync a networked match.
    // The panel itself additionally stays closed until the toggle opens it.
    const debugToggle = document.getElementById('debugToggle');
    debugToggle.classList.toggle('hidden', !Transport.isLocal);
    debugToggle.textContent = this.debugOpen ? 'Debug ▾' : 'Debug ▸';
    document.getElementById('debugPanel').classList.toggle('hidden', !Transport.isLocal || !this.debugOpen);

    const pauseBtn = document.getElementById('pauseBtn');
    pauseBtn.classList.toggle('hidden', !Transport.isLocal || Game.winnerId !== null);
    pauseBtn.classList.toggle('paused', LocalServer.paused);
    // Only rewritten on a change: this runs every frame, and replacing the
    // button's contents at 60Hz would reload its icon and break :active.
    if (pauseBtn._paused !== LocalServer.paused) {
      pauseBtn._paused = LocalServer.paused;
      pauseBtn.innerHTML = LocalServer.paused ? iconHtml('play') + ' Resume' : iconHtml('pause') + ' Pause';
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
          ' · ' + def.buildTime + 's · Esc to cancel';
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

  // Every attack or boat touching the player, either direction: pushes and
  // boats they sent (with an X to retreat/recall them) and ones aimed at
  // them (read-only — a defense line, not a control).
  //
  // Chips are reconciled by the underlying attack/boat object's identity
  // rather than rebuilt wholesale each frame. An innerHTML rewrite every
  // tick — the first cut of this did exactly that — replaces the X button
  // with a brand new element on every single frame; a real mouse press and
  // release spans several of those frames, and a click event needs the same
  // element to still be there when it releases. Keeping each chip's DOM node
  // (and its listener) alive for as long as its attack/boat is means a click
  // can never race a rebuild out from under it. Only the mutable bits —
  // troop count, retreating state, whether the X is shown — are touched
  // in place; new chips are created only for fronts that just appeared, and
  // old chips are removed only once their front is actually gone.
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
        // Closed over `it.ref` at creation time, not looked up by index —
        // there's no array position to go stale. The intent carries the
        // attack's/boat's id rather than the object (MP-1.2 gave every one of
        // them an id precisely because a reference cannot cross a wire); the
        // Executor looks it up again and checks we are the one who launched
        // it. An id whose attack has already ended by the time the turn lands
        // is dropped there, which is the ordinary case for a chip clicked as
        // its front resolves, not an error.
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

  // Ticket #25: incoming-nuke warning. Read-only over Game.nukes — nothing
  // here writes sim state. A nuke has no id, but it stays the same object from
  // launch until stepNukes (landed) or stepSAMs (shot down) splices it
  // out, so the object itself is the key: one row per nuke, never duplicated,
  // and the row disappears the frame the nuke leaves Game.nukes.
  updateNukeAlert() {
    const el = document.getElementById('nukeAlert');
    const prev = this._nukeRowByRef || new Map();
    const next = new Map();

    // MIRV (ticket #28): warn on the mothership itself, same as any other
    // nuke, from the moment it launches — matching real OpenFront's own
    // displayIncomingUnit call, which fires the instant the missile spawns,
    // not once it splits. Skipped in the this.nukes loop below is the
    // opposite case — once it splits into MIRV_WARHEAD_COUNT individual
    // mirvwarhead entries, those do NOT each get their own alert row (see
    // that loop's own comment): the player already knows a strike is
    // inbound from this row, and 40 simultaneous rows replacing it the
    // instant it splits would be pure noise, not information.
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

  // Ticket #36: a toast whenever a teammate donates gold or troops to you.
  // Fx.donationToasts is pushed unconditionally by Game.donateGold/
  // donateTroops for every recipient (see Fx's own file comment on the
  // sim/Fx contract); this filters to Game.me and ages rows out on its own,
  // same one-row-per-event diffing as updateNukeAlert but keyed to a fixed
  // lifetime instead of "while the threat exists".
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

  // MP-3.5: purely reactive. The win condition itself lives in Game.tick()
  // (see the block right after its elimination sweep) as a global,
  // Game.me-blind fact — Game.winnerId — set identically on every client on
  // the same turn. This function never computes anything and never writes to
  // Game: it only reads Game.winnerId/Game.players/Game.placements and
  // decides, locally, which overlay *this* client should show, then casts
  // this client's one vote.
  //
  // This client's own elimination is split out from that vote on purpose.
  // Game.winnerId only exists once the whole match is decided, which can be
  // long after this player is out — bots keep fighting each other, or a
  // multiplayer match keeps running for everyone else — so waiting for it
  // would leave a defeated player watching a nation they no longer control
  // for the rest of the match. `lossShown` fires the instant `me.alive` goes
  // false, independent of winnerId, so the defeat screen (with the
  // placement Game.eliminatePlayer recorded) shows right away. The
  // network-visible part — casting this client's `winner` vote — still
  // waits for Game.winnerId itself to be decided; voting a still-null
  // winner here would tell the server the match ended before it has.
  // `endGameHandled`/`lossShown` (both cleared by reset(), which every
  // restart runs) are the "already reacted" latches so each half fires once
  // per match instead of every frame main.js calls this.
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
  },

  // --- Lobby (MP-2.3) ---------------------------------------------------------
  //
  // Pure DOM: mode-tab switching, roster rendering, and reading/writing the
  // lobby form fields. No Transport call lives here — js/main.js owns every
  // click that actually opens a connection (hostCreateBtn/hostStartBtn/
  // joinBtn), the same division it already uses for the existing startBtn/
  // restartBtn. This file only shows what the network told main.js, or hands
  // main.js what the host/join forms currently say.
  //
  // #spMode (map/bots/tribes/#startBtn) is the pre-existing singleplayer
  // panel, untouched — this section only adds the tab chrome around it and
  // the two new panels beside it.

  setupLobby() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.modeTab'));
    const bodies = {
      sp: document.getElementById('spMode'),
      host: document.getElementById('hostMode'),
      join: document.getElementById('joinMode'),
      replay: document.getElementById('replayMode')
    };
    // Picking a mode swaps the open-game card out for that mode's form; Back
    // (#modeBack) undoes it. A class on #overlay rather than `hidden` on the
    // card, because hideLobby() owns the card's `hidden` for the lobby screens.
    const overlay = document.getElementById('overlay');
    const back = document.getElementById('modeBack');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        for (const key in bodies) bodies[key].classList.toggle('hidden', key !== tab.dataset.mode);
        overlay.classList.add('modeOpen');
        back.classList.remove('hidden');
        this.setLobbyError('');
        // The preview skips drawing while its panel is hidden.
        this.refreshMapPreview(tab.dataset.mode === 'host' ? 'host' : '');
        if (tab.dataset.mode === 'replay') this.refreshReplayList();
      });
    });
    back.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      for (const key in bodies) bodies[key].classList.add('hidden');
      overlay.classList.remove('modeOpen');
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

  // Read the host panel's map/bot/tribe controls into the shape `start_game`
  // carries (protocol.js's {map, mapSize, bots, tribes}). Clamped the same way
  // main.js's singleplayer start() clamps its own controls (BOT_CAP/TRIBE_CAP
  // there), so a host cannot send the server a config outside what the sim
  // actually supports.
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
    box.innerHTML =
      '<div class="optRow2">' + select('landform') + select('land') + '</div>' +
      '<div class="optRow2">' + select('terrain') + select('rivers') + select('coast') + '</div>' +
      '<div class="mapPreview" id="' + this.mapGenId(prefix, 'mapPreviewBlock') + '">' +
        '<canvas id="' + this.mapGenId(prefix, 'mapPreview') + '" width="' + this.MAP_PREVIEW_W +
          '" height="' + this.MAP_PREVIEW_H + '"></canvas>' +
        '<span id="' + this.mapGenId(prefix, 'mapPreviewNote') + '" class="mapPreviewNote"></span>' +
        '<div class="mapPreviewBar">' +
          '<label>Seed <input id="' + this.mapGenId(prefix, 'mapSeed') + '" type="number" min="0" max="4294967295"></label>' +
          '<button type="button" id="' + this.mapGenId(prefix, 'mapReroll') + '">New map</button>' +
        '</div>' +
      '</div>';

    const seedInput = document.getElementById(this.mapGenId(prefix, 'mapSeed'));
    seedInput.value = String(Math.floor(Math.random() * 1e9));
    for (const key of Object.keys(Protocol.MAP_GEN)) {
      document.getElementById(this.mapGenId(prefix, 'gen_' + key))
        .addEventListener('change', () => this.refreshMapPreview(prefix));
    }
    seedInput.addEventListener('change', () => this.refreshMapPreview(prefix));
    document.getElementById(this.mapGenId(prefix, 'mapReroll')).addEventListener('click', () => {
      seedInput.value = String(Math.floor(Math.random() * 1e9));
      this.refreshMapPreview(prefix);
    });
    // Draw whenever the preview comes into view, however it got there (tab
    // switch, Map select, the browser restoring the form on load): a hidden
    // canvas has no size, and gains one the moment it is shown.
    if (typeof ResizeObserver === 'function') {
      const canvas = document.getElementById(this.mapGenId(prefix, 'mapPreview'));
      new ResizeObserver(() => { if (canvas.clientWidth > 0) this.refreshMapPreview(prefix); }).observe(canvas);
    }
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

  // Main menu redesign: the hero card above the mode tabs. `entry` is the
  // GET /lobbies result's one `isAuto` row (main.js's refreshLobbyList picks
  // it out), or null while the poll hasn't resolved yet / genuinely no auto
  // lobby exists (should not happen in practice — GameManager always keeps
  // one — but a server that's down or between restarts is exactly the case
  // this falls back for, per Transport.fetchLobbyList's own "resolves to []
  // on any network failure" contract). Disables the button rather than
  // leaving it clickable with nothing to join.
  renderQuickJoin(entry) {
    const info = document.getElementById('quickJoinInfo');
    const btn = document.getElementById('quickJoinBtn');
    if (!entry) {
      this._quickJoinEntry = null;
      info.textContent = 'No open game right now — check back shortly.';
      btn.disabled = true;
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

  // Issue #9: renders GET /lobbies' result into the Join screen's browser
  // list. `onPick(gameID)` is called on click — main.js owns what that
  // means (fill the join code and connect), same division as everywhere
  // else in this file. Re-rendered wholesale on every refresh; this list is
  // never large enough (§6.1: "never many concurrent games on a self-hosted
  // box") to need the incremental diffing updateLobbyFromInfo does for the
  // in-lobby roster.
  //
  // Main menu redesign: `list` is expected to have the `isAuto` entry
  // already filtered out by main.js's refreshLobbyList — that one lobby now
  // gets its own hero card (renderQuickJoin above) instead of a row here, so
  // this only ever renders manually-hosted lobbies.
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

  // Called by main.js's hostLobby() the moment Transport.connect is issued —
  // shows the join code immediately so it can be shared while the socket is
  // still opening (§6.1 derivation, backpressure buffering in transport.js
  // both mean this is safe to show before the server has said anything).
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
    this._hidePreLobbyChrome();
  },

  // Join Open Game: the menu's hero card is hidden once connected, so carry
  // its already-painted map into the lobby panel.
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

  // Once connected to a lobby (host or join), the other ways to start a
  // match no longer make sense to show — clicking the hero "Join Open Game"
  // button or another mode tab wouldn't leave this lobby, just show a
  // confusingly unconnected panel next to a still-live one. Hidden rather
  // than disabled so the lobby screen (roster, code/status, leave button)
  // is the only thing on screen while connected.
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

  // Rendered from a `lobby_info` broadcast (protocol.js's {lobby, myClientID})
  // relayed by main.js's onServerMessage. `role` is 'host' or 'join' — which
  // panel's roster to update — and `isHost` (myClientID === lobby's recorded
  // creatorClientId, computed by main.js) gates whether #hostStartBtn shows
  // at all: per the task spec, a joiner's screen must have no way to start
  // the match, so on the join panel there is no Start button in the DOM to
  // begin with, and on the host panel it stays hidden for anyone who is not
  // (yet, or ever, on this connection) the recorded creator.
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
    this.renderLobbyRoster(document.getElementById(ids.roster), players,
      (lobby && lobby.isAuto) ? null : creatorClientId, myClientID, fresh);
    document.getElementById(ids.count).textContent = '(' + players.length + ')';

    let status;
    const newcomer = players.find((p) => fresh.has(p.clientID));
    if (newcomer) status = (newcomer.username || 'A player') + ' joined the lobby.';
    else if (role === 'host') status = players.length > 1 ? 'Ready when you are.' : 'Lobby open — waiting for players to join.';
    // Issue #12: this lobby has no human host to start it — say so instead
    // of the generic join message, and show the countdown once one is
    // running (lobby.autoStartAt, set by GameServer._maybeAdvanceAutoLobby)
    // so a joiner isn't left guessing when the match will begin.
    else if (lobby && lobby.isAuto) {
      if (typeof lobby.autoStartAt === 'number') {
        const secs = Math.max(0, Math.round((lobby.autoStartAt - Date.now()) / 1000));
        status = 'Starting in ' + secs + 's…';
      } else {
        status = 'Open lobby — starts once ' + (lobby.minPlayers || 2) + ' or more players join.';
      }
    }
    else status = 'Connected to the lobby.';
    this.setLobbyStatus(role, status, true);

    // The status text above is only recomputed when a `lobby_info` broadcast
    // arrives (roster changes, or the countdown starting/stopping) — between
    // those it would sit frozen at whatever second it last showed. Tick it
    // locally once a second from the same lobby.autoStartAt so the number
    // actually counts down; _tickAutoLobbyCountdown clears itself once the
    // countdown is no longer running.
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
    // index.html's static join-panel caption assumes a human host; an auto
    // lobby (issue #12) has none, and joinStatus above already carries the
    // real status for it, so the caption is blanked rather than left saying
    // something untrue.
    if (role === 'join') {
      document.getElementById('joinWaiting').textContent =
        (lobby && lobby.isAuto) ? '' : 'Waiting for the host to start…';
    }
  },

  // Runs once a second while an auto lobby's countdown is live (started by
  // updateLobbyFromInfo above). Recomputes the same "Starting in Ns…" text
  // from the stored autoStartAt without waiting for the next lobby_info
  // broadcast — otherwise the number sits frozen between roster changes.
  _tickAutoLobbyCountdown() {
    const state = this._autoLobbyCountdown;
    if (!state) return;
    const secs = Math.max(0, Math.round((state.autoStartAt - Date.now()) / 1000));
    this.setLobbyStatus(state.role, 'Starting in ' + secs + 's…', true);
  },

  renderLobbyRoster(ul, players, creatorClientId, myClientID, fresh) {
    ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.textContent = p.username || ('Player ' + p.clientID);
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

  // MP-4.2: diagnostic-only notice that the server's hash tally
  // (GameServer._tallyHashes) flagged this client — either its own hash
  // disagreed with the trusted plurality, or the active clients couldn't
  // agree on any plurality at all (everyone gets flagged in that case). This
  // is purely informational: main.js's onServerMessage does not disconnect
  // or otherwise act on a `desync` message, it only calls this. Shown once
  // and left up for the rest of the match — the server never re-notifies a
  // client it has already flagged, so there is nothing later to reconcile
  // the banner against, and clicking it away is just a convenience, not an
  // acknowledgement the server needs to hear about.
  showDesyncWarning(text) {
    const el = document.getElementById('desyncBanner');
    const textEl = document.getElementById('desyncBannerText');
    if (!el || !textEl) return;
    textEl.textContent = text;
    el.classList.remove('hidden');
  },

  // MP-4.1: how many turns behind counts as "catching up" rather than
  // ordinary same-frame jitter. At Protocol.TURN_INTERVAL_MS (100ms/turn)
  // this is ~1s of missed game time — comfortably past the odd turn a slow
  // frame leaves queued, well short of the hundreds of turns a real rejoin
  // backlog is for a match that's been running a while.
  CATCHUP_THRESHOLD: 10,

  // Called once a frame (main.js's loop, right after the frame-budgeted
  // drain) with however many turns Runner still has queued. Owns no drain
  // logic itself — Runner.executeNextTurn/the loop's own while-condition do
  // that regardless of whether this is ever called — this is purely the
  // readout: show/update the banner while meaningfully behind, hide it the
  // moment the backlog is gone. Driven by the count alone rather than any
  // "am I reconnecting" flag, so it works the same way whether the backlog
  // came from a rejoin (MP-4.1's actual case) or, in principle, an ordinary
  // multi-turn burst — one fewer piece of state to keep in sync with
  // Transport's own reconnect bookkeeping.
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
