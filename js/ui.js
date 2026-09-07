const UI = {
  ratio: 0.2,
  lastLeaderboard: 0,
  diplo: null,        // the offer currently on the banner, if any
  dismissed: new Set(),

  placing: null,      // structure type armed for placement, if any
  placeHover: -1,     // tile under the cursor while armed (mouse only)
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

  // The player's own warships currently selected via Input's shift-drag box
  // (or a shift-click on a single one) — see selectWarshipsInBox/
  // selectWarshipAt below. Holds direct object references straight into
  // Game.warships, same identity-based pattern updateFronts already uses
  // for attack/boat chips, so nothing here goes stale across a splice
  // elsewhere in that array.
  selectedWarships: new Set(),

  DEFAULT_HINT: 'Tap land to attack · right-click or hold for diplomacy/boat · shift-drag to select warships · drag to pan',

  setup() {
    const slider = document.getElementById('ratio');
    const label = document.getElementById('ratioValue');
    slider.addEventListener('input', () => {
      this.ratio = slider.value / 100;
      label.textContent = slider.value + '%';
      this.updateRatioTroops();
    });

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

    this.setupBuildBar();
    this.setupLobby();

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

    // Mean match length is ~630s over six seeds (see game.js's NEUTRAL_RATE_SCALE
    // comment) — 300s of simulated time lands roughly at the midpoint, with
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

    document.getElementById('debugNukeAtom').addEventListener('click', () => this.armDebugNuke('atombomb'));
    document.getElementById('debugNukeHydrogen').addEventListener('click', () => this.armDebugNuke('hydrogenbomb'));

    // Hotkeys, one digit per structure in bar order, and Escape to disarm.
    // Guarded on the focused element so typing a bot count in the start menu
    // cannot arm a build.
    window.addEventListener('keydown', e => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        this.placing = null;
        this.debugNukeType = null;
        this.debugNukeSrc = -1;
        this.selectedWarships.clear();
        return;
      }
      const u = Game.UNITS.find(x => x.hotkey === e.key);
      if (u) this.togglePlacing(u.type);
    });
  },

  // Built once from Game.UNITS rather than written into the HTML, so adding a
  // structure to that table is the only edit a new building needs. Only the
  // live parts — cost, count, affordability — are rewritten per frame; redoing
  // the innerHTML at 60Hz would kill :active and the button's own press state.
  setupBuildBar() {
    const bar = document.getElementById('buildBar');
    bar.innerHTML = Game.UNITS.map(u =>
      `<button class="buildBtn" data-type="${u.type}">
         <span class="bbKey">${u.hotkey}</span>
         <span class="bbIcon">${u.icon}</span>
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
      btn.addEventListener('click', () => this.togglePlacing(btn.dataset.type));
    }

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
    updateFade();
  },

  // Arming is a toggle: the same button, or the same hotkey, puts it away.
  togglePlacing(type) {
    if (!Game.running) return;
    this.placing = this.placing === type ? null : type;
    this.placeHover = -1;
    this.selectedWarships.clear();
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
    this.selectedWarships.clear();
    Radial.hide();
    this.hideHoverPanel();
  },

  // The player's own warships whose drawn hull falls inside a shift-drag
  // box, in CSS-pixel client coordinates (same space screenToTile/
  // findStructureNear use) — replaces whatever was selected before, same as
  // a fresh marquee in any RTS. An empty box (nothing of yours inside it)
  // simply clears the selection.
  selectWarshipsInBox(x0, y0, x1, y1) {
    this.selectedWarships.clear();
    for (const w of Game.warships) {
      if (w.owner !== Game.me) continue;
      const p = Render.warshipClientPos(w);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) this.selectedWarships.add(w);
    }
  },

  // A shift-click (not a drag) on a single warship — replaces the selection
  // with just that one, or clears it if the click didn't land on any.
  selectWarshipAt(sx, sy) {
    const TAP_RADIUS = 22;   // CSS px, roughly matching the drawn hull size
    let best = null, bestDist = TAP_RADIUS;
    for (const w of Game.warships) {
      if (w.owner !== Game.me) continue;
      const p = Render.warshipClientPos(w);
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d <= bestDist) { best = w; bestDist = d; }
    }
    this.selectedWarships.clear();
    if (best) this.selectedWarships.add(best);
  },

  flash(text) {
    this.flashText = text;
    this.flashUntil = performance.now() + 1600;
  },

  reset() {
    this.diplo = null;
    this.dismissed.clear();
    this.placing = null;
    this.debugNukeType = null;
    this.debugNukeSrc = -1;
    this.placeHover = -1;
    this.selectedWarships.clear();
    this.flashUntil = 0;
    this.spawnFlashUntil = 0;
    this.spawnBannerOpen = false;
    this.spawnSent = false;
    this._frontChipByRef = null;
    // MP-3.5: whether this client has already reacted to Game.winnerId — see
    // checkEndGame. A fresh match's Game.init() puts winnerId back to null,
    // but reset() runs on that same restart, so this has to be cleared here
    // too or a second match would find it still true from the first.
    this.endGameHandled = false;
    document.getElementById('frontsRow').classList.add('hidden');
    document.getElementById('frontsRow').innerHTML = '';
    document.getElementById('diploBanner').classList.add('hidden');
    document.getElementById('traitorChip').textContent = '';
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
    document.getElementById('spawnBannerText').textContent = this.SPAWN_HINT;
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
    // MP-3.2: the spawn phase is now a fixed timed window (up to 30s with
    // 2+ humans), not "ends the instant someone taps" — without a visible
    // countdown that reads as the game having frozen. Game.spawnPhaseTicks is
    // the phase's own turn counter (Game.ticks stays frozen at 0 throughout
    // the whole spawn phase by design, so it can't drive this).
    const remaining = Math.max(0, Math.ceil((Game.SPAWN_PHASE_TURNS - Game.spawnPhaseTicks) * Game.TICK_DT));
    const hint = this.spawnSent ? this.SPAWN_SENT_HINT : this.SPAWN_HINT;
    el.textContent = hint + ' · ' + remaining + 's';
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
    this.hoverId = playerId;
    const el = document.getElementById('hoverPanel');
    el.classList.remove('hidden');
    document.getElementById('hpSwatch').style.background =
      `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
    document.getElementById('hpName').textContent = p.name;
    document.getElementById('hpSub').textContent =
      (p.isTribe ? 'Tribe' : '') +
      (Game.areAllied(Game.me, p.id) ? ' Allied' : '') +
      (Game.isTraitor(p) ? ' 🗡 Traitor' : '');
    document.getElementById('hpTiles').textContent =
      p.tiles.size.toLocaleString() + ' (' + (p.tiles.size / GameMap.landTiles * 100).toFixed(1) + '%)';

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
    // readable before you decide whether to fight them.
    document.getElementById('hpGoldValue').textContent = formatGold(p.gold);
    document.getElementById('hpGoldRate').textContent =
      '+' + formatGold(Game.goldPerSecond(p)) + '/s';
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

    // Atom/Hydrogen Bomb: same "click anywhere, the game resolves the
    // launch point" shape as Warship above, via Game.resolveNukeLaunch/
    // nukeBlockReason/launchNuke rather than buildBlockReason/build — a
    // nuke click means "strike here," not "place one exactly here," and
    // unlike a Warship purchase, any tile at all (land, water, even the
    // player's own territory) is a legal target, so there's no snap-related
    // reason text to special-case the way Warship's "No open water there"
    // is.
    if (this.placing === 'atombomb' || this.placing === 'hydrogenbomb') {
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
    if (this.selectedWarships.size) {
      const tile = Render.screenToTile(sx, sy);
      // Objects can't cross a wire, so the order names ids (MP-1.2). Ships
      // that have sunk since the selection was made are skipped here; the
      // Executor drops any that sink in the ~100 ms after, so an order over a
      // fleet that is losing ships still moves the ones that are left.
      const unitIds = [];
      for (const w of this.selectedWarships) if (Game.warshipById(w.id)) unitIds.push(w.id);
      this.selectedWarships.clear();
      const reachable = tile >= 0 &&
        Game.nearestWaterNear(tile, Game.NEAREST_COAST_MAX_DIST) >= 0;
      if (unitIds.length && reachable) {
        // The raw clicked tile travels, not the snapped one: the snap is a rule
        // of the sim (moveWarships does it) and every client must perform it
        // identically rather than trust one client's answer.
        Transport.sendIntent(Protocol.intent.moveWarship(unitIds, tile));
        return;
      }
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
      const existing = Render.findStructureNear(sx, sy, this.placing);
      if (existing) {
        const reason = Game.upgradeBlockReason(Game.me, existing.tile);
        if (reason) { this.flash(reason); return; }
        Transport.sendIntent(Protocol.intent.upgradeStructure(existing.tile));
        this.placing = null;
        this.placeHover = -1;
        return;
      }

      const railSnap = this.placing === 'city' ? Render.findRailSnapTile(sx, sy) : -1;
      // A Port has to land on the coast — snap a click near the shore onto
      // the nearest actual coastal tile of the player's own territory, same
      // idea as the city/rail snap just above but geometric (BFS) rather
      // than a line-distance test, since a coastline isn't straight.
      const coastSnap = this.placing === 'port'
        ? Game.nearestOwnedCoastNear(Game.me, Render.screenToTile(sx, sy), Game.PORT_SNAP_MAX_DIST) : -1;
      const tile = railSnap >= 0 ? railSnap : coastSnap >= 0 ? coastSnap : Render.screenToTile(sx, sy);
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

    // Land only, exactly as OpenFront's own plain-click behaviour: it expands
    // the whole contiguous border wherever we actually touch that nation or
    // neutral land, regardless of precisely which tile got tapped, and simply
    // does nothing if we don't touch it anywhere. A boat is a deliberate
    // action from here — right-click or hold the tile for the radial menu.
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
    Transport.sendIntent(Protocol.intent.attack(target, Math.floor(me.troops * this.ratio)));
  },

  update() {
    const me = Game.players[Game.me];
    if (!me) return;

    // Dev-only cheats: live for the whole match, including spawn selection,
    // same as the leaderboard — gone before a match exists, and gone entirely
    // once the transport is not local, because two of the three controls on
    // the panel reach past the intent pipeline into the sim (see the DEBUG
    // BYPASS notes in setup()) and would desync a networked match.
    document.getElementById('debugPanel').classList.toggle('hidden', !Transport.isLocal);

    // The HUD stays hidden until the human has claimed a capital — only the
    // banner (and the leaderboard, already outside #hud) is live.
    if (Game.spawning) { this.updateSpawnBanner(); return; }

    // The spawn phase is over. The tap that ended it did so a turn ago and
    // could not know it had worked, so the handoff from banner to HUD happens
    // here, off the simulation's own state, rather than on the click.
    if (this.spawnBannerOpen) this.exitSpawnSelect();

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
    traitorEl.textContent = Game.isTraitor(me)
      ? '🗡 TRAITOR ' + Math.ceil(me.traitorUntil - Game.elapsed) + 's' : '';

    this.updateBanner();
    this.updateBuildBar(me);
    this.updateFronts();
    Radial.refresh();
    this.refreshHoverPanel();

    const now = performance.now();
    if (now - this.lastLeaderboard < 500) return;
    this.lastLeaderboard = now;

    const ranked = Game.players
      .filter(p => p.alive && p.tiles.size > 0)
      .sort((a, b) => b.tiles.size - a.tiles.size)
      .slice(0, 6);

    document.getElementById('leaderboard').innerHTML = ranked.map(p => {
      const pct = (p.tiles.size / GameMap.landTiles * 100).toFixed(1);
      const c = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
      const mark = (Game.areAllied(Game.me, p.id) ? '🤝' : '') +
                   (Game.isTraitor(p) ? '🗡' : '') +
                   (p.isDisconnected ? '🔌' : '');
      return `<div class="lbRow${p.id === Game.me ? ' me' : ''}">
        <div class="lbSwatch" style="background:${c}"></div>
        <div class="lbName">${p.name}</div>
        <div class="lbMark">${mark}</div>
        <div class="lbGold">${formatGold(p.gold)}</div>
        <div class="lbPct">${pct}%</div>
      </div>`;
    }).join('');
  },

  // Cost, count and affordability, plus the hint line under the bar — which is
  // where placement actually explains itself, since an armed build changes what
  // tapping the map does.
  updateBuildBar(me) {
    if (this.placing && !me.alive) this.placing = null;

    for (const u of Game.UNITS) {
      const els = this.buildEls.get(u.type);
      if (!els) continue;
      const cost = Game.unitCost(me, u.type);
      const owned = Game.unitsOwned(me, u.type);
      els.cost.textContent = formatGold(cost);
      els.count.textContent = owned ? '×' + owned : '';
      // Affordability drives the dim, not the disabled attribute: a button you
      // cannot press is also a button that cannot tell you the price.
      els.btn.classList.toggle('poor', me.gold < cost);
      els.btn.classList.toggle('armed', this.placing === u.type);
      els.btn.classList.toggle('locked',
        (u.type === 'atombomb' || u.type === 'hydrogenbomb') && Game.unitsOwned(me, 'silo') < 1);
    }

    document.getElementById('debugNukeAtom').classList.toggle('armed',
      this.placing === 'debugnuke' && this.debugNukeType === 'atombomb');
    document.getElementById('debugNukeHydrogen').classList.toggle('armed',
      this.placing === 'debugnuke' && this.debugNukeType === 'hydrogenbomb');

    const hintEl = document.getElementById('hint');
    if (performance.now() < this.flashUntil) {
      hintEl.textContent = this.flashText;
      hintEl.classList.add('warn');
      return;
    }
    hintEl.classList.remove('warn');
    if (this.placing === 'warship') {
      hintEl.textContent = Game.unitsOwned(me, 'port') < 1
        ? 'Build a Port first to unlock Warships · Esc to cancel'
        : 'Tap anywhere to launch a Warship from your nearest Port · ' +
          formatGold(Game.unitCost(me, 'warship')) + ' gold · Esc to cancel';
    } else if (this.placing === 'atombomb' || this.placing === 'hydrogenbomb') {
      const def = Game.unitDef(this.placing);
      const article = this.placing === 'atombomb' ? 'an' : 'a';
      hintEl.textContent = Game.unitsOwned(me, 'silo') < 1
        ? 'Build a Missile Silo first to unlock the ' + def.name + ' · Esc to cancel'
        : 'Tap anywhere to strike with ' + article + ' ' + def.name + ' from your nearest ready Silo · ' +
          formatGold(Game.unitCost(me, this.placing)) + ' gold · Esc to cancel';
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
      const hoverB = this.placeHover >= 0 ? Game.buildings.get(this.placeHover) : null;
      if (hoverB && hoverB.type === this.placing && hoverB.built) {
        hintEl.textContent = 'Tap to upgrade this ' + def.name + ' to level ' + (hoverB.level + 1) +
          ' · ' + formatGold(Game.unitCost(me, this.placing)) + ' gold' +
          ' · ' + def.buildTime + 's · Esc to cancel';
      } else {
        hintEl.textContent = 'Tap your own land to place a ' + def.name +
          ' · ' + formatGold(Game.unitCost(me, this.placing)) + ' gold' +
          ' · ' + def.buildTime + 's to build · Esc to cancel';
      }
    } else if (this.selectedWarships.size) {
      hintEl.textContent = this.selectedWarships.size + ' warship' + (this.selectedWarships.size > 1 ? 's' : '') +
        ' selected — tap open water to relocate · shift-drag to reselect · Esc to deselect';
    } else {
      hintEl.textContent = this.DEFAULT_HINT;
    }
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
        icon: mine ? '⚔' : '🛡',
        troops: a.troops,
        name: mine
          ? (a.target >= 0 ? Game.players[a.target].name : 'Unclaimed land')
          : Game.players[a.attacker].name,
        retreating: !!a.retreating
      });
    }
    for (const b of Game.boats) {
      if (b.attacker !== Game.me && b.target !== Game.me) continue;
      if (b.target === Game.me && b.attacker !== Game.me && Game.players[b.attacker].isTribe) continue;
      const mine = b.attacker === Game.me;
      items.push({
        kind: 'boat', ref: b, mine,
        icon: mine ? '⛵' : '🚤',
        troops: b.troops,
        name: mine
          ? (b.target >= 0 ? Game.players[b.target].name : 'Unclaimed land')
          : Game.players[b.attacker].name,
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
          `<span class="frontIcon">${it.icon}</span>` +
          `<span class="frontTroops"></span>` +
          `<span class="frontName">${it.name}</span>`;
        chip._troopsEl = chip.querySelector('.frontTroops');
      }
      chip.className = 'frontChip ' + (it.mine ? 'mine' : 'theirs') + (it.retreating ? ' retreating' : '');
      chip._troopsEl.textContent = formatCountTight(it.troops);

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
        btn.addEventListener('click', () => {
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

  // One offer at a time: a peace deal someone has put to you, or an ally asking
  // to renew before the clock runs out. Ignoring either is a valid answer —
  // both simply lapse, and neither costs you anything.
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
      const from = Game.players[req.from];
      return {
        key: 'req:' + req.from + ':' + req.createdAt.toFixed(1),
        text: from.name + ' proposes a peace deal',
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
      const name = Game.players[otherId].name;
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

  // MP-3.5: purely reactive. The win condition itself now lives in
  // Game.tick() (see the block right after its elimination sweep) as a
  // global, Game.me-blind fact — Game.winnerId — set identically on every
  // client on the same turn. This function never computes anything and never
  // writes to Game: it only reads Game.winnerId/Game.players and decides,
  // locally, which of three overlays *this* client should show, then casts
  // this client's one vote. `endGameHandled` (cleared by reset(), which every
  // restart runs) is the "already reacted" latch so it fires once per match
  // instead of every frame main.js calls it while winnerId stays set.
  checkEndGame() {
    if (Game.winnerId === null || this.endGameHandled) return;
    this.endGameHandled = true;

    const me = Game.players[Game.me];
    if (Game.winnerId === Game.me) {
      this.showEnd('Victory', 'You control the world.');
    } else if (!me.alive) {
      this.showEnd('Defeated', 'Your nation has been wiped off the map.');
    } else {
      // Bug #2 (MP-3.5 brief): still alive, but someone else won — the case
      // the old me-relative checks could never reach, so this client used to
      // show nothing at all once the match ended for everyone else.
      const winner = Game.players[Game.winnerId];
      this.showEnd('Game Over', (winner ? winner.name : 'Another player') + ' has won the game.');
    }

    // This client's one vote (§4 `winner`) — sent in every case above,
    // exactly once, regardless of which overlay this client itself shows.
    Transport.sendWinner(Game.winnerId);
  },

  showEnd(title, text) {
    document.getElementById('endTitle').textContent = title;
    document.getElementById('endText').textContent = text;
    document.getElementById('endOverlay').classList.remove('hidden');
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
      join: document.getElementById('joinMode')
    };
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('active', t === tab));
        for (const key in bodies) bodies[key].classList.toggle('hidden', key !== tab.dataset.mode);
        this.setLobbyError('');
      });
    });

    // Nicety only (task spec: "not a requirement") — prefill whichever
    // username field exists from the last time this browser hosted/joined.
    let savedUsername = '';
    try { savedUsername = localStorage.getItem('borderwar_username') || ''; } catch (e) { /* ignore */ }
    if (savedUsername) {
      document.getElementById('hostUsername').value = savedUsername;
      document.getElementById('joinUsername').value = savedUsername;
    }
  },

  // Read the host panel's map/bot/tribe controls into the shape `start_game`
  // carries (protocol.js's {mapSize, bots, tribes}). Clamped the same way
  // main.js's singleplayer start() clamps its own controls, so a host cannot
  // send the server a config outside what the sim actually supports.
  getHostConfig() {
    const mapSize = document.getElementById('hostMapSize').value;
    const bots = Math.max(0, Math.min(31, parseInt(document.getElementById('hostBotCount').value, 10) || 0));
    const tribes = Math.max(0, Math.min(80, parseInt(document.getElementById('hostTribeCount').value, 10) || 0));
    return { mapSize: mapSize, bots: bots, tribes: tribes };
  },

  // Username persistence is a nicety (see setupLobby) so it is written from
  // both read points rather than once — whichever panel the player actually
  // used is the one worth remembering.
  getHostUsername() {
    const username = (document.getElementById('hostUsername').value || '').trim();
    if (username) { try { localStorage.setItem('borderwar_username', username); } catch (e) { /* ignore */ } }
    return username;
  },

  getJoinInputs() {
    const code = (document.getElementById('joinCode').value || '').trim().toUpperCase();
    const username = (document.getElementById('joinUsername').value || '').trim();
    if (username) { try { localStorage.setItem('borderwar_username', username); } catch (e) { /* ignore */ } }
    return { code: code, username: username };
  },

  // Called by main.js's hostLobby() the moment Transport.connect is issued —
  // shows the join code immediately so it can be shared while the socket is
  // still opening (§6.1 derivation, backpressure buffering in transport.js
  // both mean this is safe to show before the server has said anything).
  showHostLobby(gameID) {
    this.setLobbyError('');
    document.getElementById('lobbyCode').textContent = gameID;
    document.getElementById('hostLobby').classList.remove('hidden');
    document.getElementById('hostStartBtn').classList.add('hidden');
    document.getElementById('lobbyRoster').innerHTML = '';
  },

  showJoinLobby() {
    this.setLobbyError('');
    document.getElementById('joinLobby').classList.remove('hidden');
    document.getElementById('joinRoster').innerHTML = '';
  },

  // Rendered from a `lobby_info` broadcast (protocol.js's {lobby, myClientID})
  // relayed by main.js's onServerMessage. `role` is 'host' or 'join' — which
  // panel's roster to update — and `isHost` (myClientID === lobby's recorded
  // creatorClientId, computed by main.js) gates whether #hostStartBtn shows
  // at all: per the task spec, a joiner's screen must have no way to start
  // the match, so on the join panel there is no Start button in the DOM to
  // begin with, and on the host panel it stays hidden for anyone who is not
  // (yet, or ever, on this connection) the recorded creator.
  updateLobbyFromInfo(lobby, role, isHost) {
    const players = (lobby && lobby.players) || [];
    const creatorClientId = lobby && lobby.creatorClientId;
    if (role === 'host') {
      this.renderLobbyRoster(document.getElementById('lobbyRoster'), players, creatorClientId);
      document.getElementById('hostStartBtn').classList.toggle('hidden', !isHost);
    } else if (role === 'join') {
      this.renderLobbyRoster(document.getElementById('joinRoster'), players, creatorClientId);
    }
  },

  renderLobbyRoster(ul, players, creatorClientId) {
    ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.textContent = p.username || ('Player ' + p.clientID);
      if (p.clientID === creatorClientId) li.classList.add('isHost');
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
