const UI = {
  ratio: 0.2,
  lastLeaderboard: 0,
  diplo: null,        // the offer currently on the banner, if any
  dismissed: new Set(),

  placing: null,      // structure type armed for placement, if any
  placeHover: -1,     // tile under the cursor while armed (mouse only)
  flashText: '',
  flashUntil: 0,

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

    this.setupBuildBar();

    // Dev-only gold cheats — panel is hidden until a match actually exists
    // (see update()) so it can't be pressed against an empty player list.
    for (const btn of document.querySelectorAll('#debugPanel button[data-gold]')) {
      btn.addEventListener('click', () => {
        const me = Game.players[Game.me];
        if (me) me.gold += +btn.dataset.gold;
      });
    }

    // Hotkeys, one digit per structure in bar order, and Escape to disarm.
    // Guarded on the focused element so typing a bot count in the start menu
    // cannot arm a build.
    window.addEventListener('keydown', e => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') { this.placing = null; this.selectedWarships.clear(); return; }
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
  },

  // Arming is a toggle: the same button, or the same hotkey, puts it away.
  togglePlacing(type) {
    if (!Game.running) return;
    this.placing = this.placing === type ? null : type;
    this.placeHover = -1;
    this.selectedWarships.clear();
    if (this.placing) { Radial.hide(); this.hideHoverPanel(); }
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
    this.placeHover = -1;
    this.selectedWarships.clear();
    this.flashUntil = 0;
    this.spawnFlashUntil = 0;
    this._frontChipByRef = null;
    document.getElementById('frontsRow').classList.add('hidden');
    document.getElementById('frontsRow').innerHTML = '';
    document.getElementById('diploBanner').classList.add('hidden');
    document.getElementById('traitorChip').textContent = '';
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
    document.getElementById('spawnBannerText').textContent = this.SPAWN_HINT;
  },

  exitSpawnSelect() {
    document.getElementById('spawnBanner').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
  },

  SPAWN_HINT: 'Tap the map to place your capital',

  flashSpawn(text) {
    this.spawnFlashText = text;
    this.spawnFlashUntil = performance.now() + 1400;
  },

  updateSpawnBanner() {
    const el = document.getElementById('spawnBannerText'), banner = document.getElementById('spawnBanner');
    if (performance.now() < this.spawnFlashUntil) {
      el.textContent = this.spawnFlashText;
      banner.classList.add('warn');
      return;
    }
    banner.classList.remove('warn');
    el.textContent = this.SPAWN_HINT;
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
      const reason = Game.spawnBlockReason(tile);
      if (reason) { this.flashSpawn(reason); return; }
      Game.chooseSpawn(tile);
      this.exitSpawnSelect();
      return;
    }
    if (!Game.running) return;

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
      Game.buildWarship(Game.me, tile);
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
    if (this.selectedWarships.size) {
      const tile = Render.screenToTile(sx, sy);
      const moved = tile >= 0 && Game.moveWarships(Array.from(this.selectedWarships), tile);
      this.selectedWarships.clear();
      if (moved) return;
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
        Game.upgrade(Game.me, existing.tile);
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
      Game.build(Game.me, this.placing, tile);
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
    // own land falls for free — no siege, no troops — instead of opening a
    // normal attack. Checked ahead of launchAttack so surrounding a tribe (or
    // just the piece of a bigger nation that got cut off from its mainland)
    // and tapping it is a one-click annexation, per OpenFront's rule.
    if (target >= 0) {
      const region = Game.enclosedRegion(tile, Game.me);
      if (region) { Game.annexRegion(region, Game.me); return; }
    }

    // Land only, exactly as OpenFront's own plain-click behaviour: it expands
    // the whole contiguous border wherever we actually touch that nation or
    // neutral land, regardless of precisely which tile got tapped, and simply
    // does nothing if we don't touch it anywhere. A boat is a deliberate
    // action from here — right-click or hold the tile for the radial menu.
    const me = Game.players[Game.me];
    Game.launchAttack(Game.me, target, Math.floor(me.troops * this.ratio));
  },

  update() {
    const me = Game.players[Game.me];
    if (!me) return;

    // Dev-only gold cheats: live for the whole match, including spawn
    // selection, same as the leaderboard — only gone before a match exists.
    document.getElementById('debugPanel').classList.remove('hidden');

    // The HUD stays hidden until the human has claimed a capital — only the
    // banner (and the leaderboard, already outside #hud) is live.
    if (Game.spawning) { this.updateSpawnBanner(); return; }

    const max = Game.maxTroops(me);
    const growth = Game.growthPerSecond(me);
    const marching = Game.marchingTroops(me.id);
    // Bar, number, rate and colour all read the home reserve, so they can never
    // disagree. Committing half your troops halves the bar on the spot and puts
    // you lower on the growth curve at the same moment.
    const ratio = Math.min(1, me.troops / max);

    document.getElementById('troopValue').textContent = Math.floor(me.troops).toLocaleString();
    document.getElementById('troopCap').textContent = '/ ' + Math.round(max).toLocaleString();

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

    const marchEl = document.getElementById('troopMarching');
    marchEl.textContent = marching >= 1 ? '⚔ ' + Math.floor(marching).toLocaleString() : '';

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
    document.getElementById('goldRate').textContent =
      '+' + formatGold(Game.goldPerSecond(me)) + '/s';

    // A traitor is cheaper and faster to conquer for everyone on the map, so
    // the countdown is the most important number on screen while it runs.
    const traitorEl = document.getElementById('traitorChip');
    traitorEl.textContent = Game.isTraitor(me)
      ? '🗡 TRAITOR ' + Math.ceil(me.traitorUntil - Game.elapsed) + 's' : '';

    this.updateBanner();
    this.updateBuildBar(me);
    this.updateFronts();
    Radial.refresh();
    this.refreshHoverPanel();

    document.getElementById('tileValue').textContent =
      me.tiles.size.toLocaleString() + ' tiles · ' +
      (me.tiles.size / GameMap.landTiles * 100).toFixed(1) + '%';

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
                   (Game.isTraitor(p) ? '🗡' : '');
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
    }

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
        // there's no array position to go stale.
        btn.addEventListener('click', () => {
          if (it.kind === 'attack') Game.retreatAttack(it.ref);
          else Game.retreatBoat(it.ref);
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
        accept: () => Game.acceptAlliance(req),
        reject: () => Game.rejectAlliance(req)
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
        accept: () => Game.requestExtension(Game.me, otherId),
        reject: () => {}
      };
    }
    return null;
  },

  checkEndGame() {
    const me = Game.players[Game.me];
    const alive = Game.players.filter(p => p.alive && p.tiles.size > 0);

    if (!me.alive || me.tiles.size === 0) return this.showEnd('Defeated', 'Your nation has been wiped off the map.');
    if (alive.length === 1) return this.showEnd('Victory', 'You control the entire map.');
    if (me.tiles.size / GameMap.landTiles > 0.95) {
      return this.showEnd('Victory', 'You control over 95% of the world.');
    }
  },

  showEnd(title, text) {
    Game.running = false;
    document.getElementById('endTitle').textContent = title;
    document.getElementById('endText').textContent = text;
    document.getElementById('endOverlay').classList.remove('hidden');
  }
};
