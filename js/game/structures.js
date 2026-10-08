// js/game/structures.js — Structures & construction.
// Extends the Game singleton declared in game/core.js. Move-only split of the
// former js/game.js; see docs/game-split-plan.md.
Object.assign(Game, {
  // --- Structures ----------------------------------------------------------
  // The build menu, one table entry per unit.
  //
  // Cost: City, Factory and Port double with each one held, min(maxCost,
  // 2^n * baseCost). `linear` entries climb by baseCost a step, min(maxCost,
  // (n+1) * baseCost). `flat` entries never move. n is min(unitsOwned,
  // unitsBuilt) (see unitCost). unitsBuilt is a lifetime counter that only
  // this player's own build() and upgrade() calls raise, so captured cities
  // cannot push the price past what the player's own build history allows.
  //
  // `unitsOwned` (units[type]) is a SUM OF LEVELS, not a headcount: a built
  // unit contributes its level, one under construction a flat 1. A second
  // city and a first city upgraded to level 2 cost, and are worth, the same
  // (see maxTroopsRaw).
  //
  // buildTime is seconds of construction after placement (see
  // updateConstruction). Upgrades are instant: UPGRADE_TIME is its own dial
  // so an upgrade never inherits a structure's construction time.
  UPGRADE_TIME: 0,
  UNITS: [
    {
      type: 'city', name: 'City', icon: '🏙', hotkey: '1',
      baseCost: 125000, maxCost: 1000000, buildTime: 2, upgradable: true
    },
    // Factory: City's cost curve and build time, but priced against
    // Factory and Port counted together (costGroup). What it does is in
    // rail.js.
    {
      type: 'factory', name: 'Factory', icon: '🏭', hotkey: '2',
      baseCost: 125000, maxCost: 1000000, buildTime: 2, upgradable: true,
      costGroup: ['factory', 'port']
    },
    // Port: the same doubling curve, pooled with Factory — building either
    // one makes the next Port OR Factory dearer. See unitCost's costGroup
    // handling. Takes 5s to build against City and Factory's 2.
    {
      type: 'port', name: 'Port', icon: '⚓', hotkey: '3',
      baseCost: 125000, maxCost: 1000000, buildTime: 5, upgradable: true,
      costGroup: ['factory', 'port']
    },
    // Defense Fort: LINEAR cost, (n+1)*50k capped at 250k — first fort 50k,
    // second 100k, fifth and later 250k. Not upgradable. See the FORT_*
    // constants and fortInRange() for the combat hooks, and tileCost()/
    // stepAttack() for where those bonuses fire.
    {
      type: 'fort', name: 'Defense Fort', icon: '🛡', hotkey: '4',
      baseCost: 50000, maxCost: 250000, buildTime: 5, upgradable: false, linear: true
    },
    // Warship: linear cost, pooled with nothing, not upgradable. Placed
    // on WATER via warshipBlockReason/buildWarship, which ignore
    // buildTime (a warship spawns instantly; the field is only for the
    // build-bar hint).
    //
    // `action: true` marks an entry that never goes through
    // buildBlockReason/build and never lands in Game.buildings.
    // AI.economy's generic loop skips these; without the flag it would
    // plant a phantom 'warship' building and inflate the real price.
    {
      type: 'warship', name: 'Warship', icon: '🚢', hotkey: '5',
      baseCost: 250000, maxCost: 1000000, buildTime: 0, upgradable: false, linear: true, action: true
    },
    // Missile Silo: FLAT cost. Upgradable: each level is one more
    // missile slot that reloads on its own SILO_COOLDOWN (see
    // siloFreeSlots). Ordinary own-land placement. See nukes.js.
    {
      type: 'silo', name: 'Missile Silo', icon: '🚀', hotkey: '6',
      baseCost: 1000000, maxCost: 1000000, buildTime: 10, upgradable: true, flat: true
    },
    // Atom Bomb / Hydrogen Bomb: flat cost, `action: true`. A click
    // means 'launch one at this tile from my nearest ready Silo'
    // (resolveNukeLaunch/launchNuke). See nukes.js. buildTime is only
    // for the build bar: a nuke launches the instant it is ordered.
    {
      type: 'atombomb', name: 'Atom Bomb', icon: '☢', hotkey: '7',
      baseCost: 750000, maxCost: 750000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    {
      type: 'hydrogenbomb', name: 'Hydrogen Bomb', icon: '💥', hotkey: '8',
      baseCost: 5000000, maxCost: 5000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // SAM Launcher: the defensive interceptor (the Missile Silo above
    // is the offensive one). Linear cost, ordinary own-land placement.
    // See sam.js.
    {
      type: 'sam', name: 'SAM Launcher', icon: '📡', hotkey: '9',
      baseCost: 1500000, maxCost: 3000000, buildTime: 30, upgradable: true, linear: true
    },
    // MIRV: the multi-warhead strike. `action: true` like the bombs
    // (resolveNukeLaunch/launchMirv). Its cost follows none of the
    // fields here: Game.unitCost special-cases type==='mirv' (a base
    // plus an increment per MIRV anyone has launched this match). The
    // fields are set to MIRV_BASE_COST anyway so the entry holds a sane
    // number. See nukes.js.
    {
      type: 'mirv', name: 'MIRV', icon: '🛰', hotkey: '0',
      baseCost: 25000000, maxCost: 25000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // Fog of war's Scout (docs/fog-of-war.md, game/scouts.js): an
    // unarmed ship that uncovers the map. Flat cost, `action: true`
    // (resolveScoutLaunch/buildScout). `fogOnly` marks an entry that
    // only exists in fog matches: buildScout refuses with fog off and
    // the build bar leaves it out. Last in the table so no other
    // entry's position moves.
    {
      type: 'scout', name: 'Scout', icon: '🔭',
      baseCost: 25000, maxCost: 25000, buildTime: 0, upgradable: false, flat: true, action: true, fogOnly: true
    },
    // Battle Royale's Drill (docs/battle-royale.md, game/drill.js).
    // Flat DRILL_COST. `action: true` because it never lands in
    // Game.buildings: placement is drillBlockReason/placeDrill (own
    // land, instant, one per match). The flag also keeps AI.economy's
    // generic loop from buying it. Last in the table so no other
    // entry's position moves.
    {
      type: 'drill', name: 'The Drill', icon: '🌀',
      baseCost: 20000000, maxCost: 20000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // Fog of war's Radio Tower (docs/fog-of-war.md): a cheap structure
    // on the builder's own land that uncovers a wide disc of the map
    // (VISION_SIGHT_RADIO) once, the moment it finishes, and is then
    // removed (see updateConstruction). It is how a landlocked nation
    // looks past its border. Linear cost. Ordinary buildBlockReason/
    // build placement, but `fogOnly` like the Scout, and skipped by
    // AI.economy's generic loop (AI.buyRadio buys it). Last in the
    // table so no other entry's position moves.
    {
      type: 'radio', name: 'Radio Tower', icon: '🗼',
      baseCost: 50000, maxCost: 250000, buildTime: 5, upgradable: false, linear: true, fogOnly: true
    }
  ],

  unitDef(type) { return this.UNITS.find(u => u.type === type) || null; },

  // Sum of levels across this player's built structures of `type`, plus a
  // flat 1 for each one still under construction — see the UNITS comment.
  // Floored at 0: `|| 0` alone only catches falsy values, so a genuine
  // negative count (a bug elsewhere) would otherwise sail through into
  // unitCost's exponent and underprice the next build.
  unitsOwned(p, type) { return Math.max(0, (p && p.units && p.units[type]) || 0); },

  // Lifetime count of this player's own builds/upgrades of `type` — never
  // decremented, whether by losing the unit or by it being captured away.
  unitsBuilt(p, type) { return Math.max(0, (p && p.unitsBuilt && p.unitsBuilt[type]) || 0); },

  // Still-under-construction structures this player has paid for. See the
  // field comment on Player.unitsPending.
  unitsPending(p, type) { return Math.max(0, (p && p.unitsPending && p.unitsPending[type]) || 0); },

  unitCost(p, type) {
    const def = this.unitDef(type);
    if (!def) return Infinity;
    // MIRV: priced off Game.mirvsLaunched — a whole-match counter across
    // EVERY player (see nukes.js's launchMirv) — not this player's own
    // unitsOwned/unitsBuilt history the way every curve below is, so it
    // cannot be expressed as flat/linear/exponential over `n` and gets its
    // own early return. See the UNITS 'mirv' entry.
    if (type === 'mirv') return this.MIRV_BASE_COST + this.mirvsLaunched * this.MIRV_COST_STEP;
    // Silo, Atom Bomb, Hydrogen Bomb and the other flat entries: the price
    // never moves however many have been bought, so no n/costGroup
    // accounting applies. See the UNITS entries.
    if (def.flat) return def.baseCost;
    // Committed = finished-and-owned plus still-building, so queuing a
    // second one before the first finishes prices at the doubled rate.
    // costGroup (Port/Factory) sums the per-type min() across the group:
    // building either raises the price of both.
    const types = def.costGroup || [type];
    let n = 0;
    // Radio Tower: no standing building, so no units.radio to count — the
    // lifetime unitsBuilt (bumped the moment gold is committed) is the count.
    if (type === 'radio') return Math.min(def.maxCost, (this.unitsBuilt(p, type) + 1) * def.baseCost);
    for (const t of types) {
      const committed = this.unitsOwned(p, t) + this.unitsPending(p, t);
      n += Math.min(committed, this.unitsBuilt(p, t));
    }
    // Linear: (n+1)*baseCost, capped at maxCost. Otherwise exponential:
    // 2^n * baseCost, capped at maxCost.
    //
    // This Math.pow is deliberately NOT routed through Game.det: base 2 with
    // a small non-negative integer exponent is exact on every engine. It is
    // the one exempt case in the determinism audit (architecture doc §7.2).
    return def.linear
      ? Math.min(def.maxCost, (n + 1) * def.baseCost)
      : Math.min(def.maxCost, Math.pow(2, n) * def.baseCost);
  },

  // No structure may stand closer than this many tiles (Euclidean, strict
  // <) to any other structure of any type, owner or state. About one icon's
  // width, so icons sit side by side but never overlap.
  STRUCTURE_MIN_DIST: 6,

  // Whether `tile` is inside STRUCTURE_MIN_DIST of something already standing
  // (the tile itself included, at distance 0).
  structureTooClose(tile) {
    const w = GameMap.width, x = tile % w, y = (tile / w) | 0;
    const r2 = this.STRUCTURE_MIN_DIST * this.STRUCTURE_MIN_DIST;
    for (const t of this.buildings.keys()) {
      const dx = t % w - x, dy = ((t / w) | 0) - y;
      if (dx * dx + dy * dy < r2) return true;
    }
    return false;
  },

  // Where a placement click at `tile` should land: the nearest tile that is
  // the player's own, connected to the click through their own land, within
  // STRUCTURE_MIN_DIST of it, and clear of every other structure. A Port
  // also needs the coast, and is allowed a click just off the player's
  // shore. -1 when nothing qualifies. Click interpretation for the UI:
  // build() takes the tile it is given.
  structureSiteNear(playerId, type, tile) {
    const def = this.unitDef(type);
    if (!def || def.action || tile < 0) return -1;
    if (type === 'port' && GameMap.owner[tile] !== playerId) {
      tile = this.nearestOwnedCoastNear(playerId, tile, this.PORT_SNAP_MAX_DIST);
    }
    if (tile < 0 || GameMap.owner[tile] !== playerId) return -1;
    const w = GameMap.width, cx = tile % w, cy = (tile / w) | 0;
    const r2 = this.STRUCTURE_MIN_DIST * this.STRUCTURE_MIN_DIST;
    // Only structures within twice the radius can rule out a tile in it.
    const near = [];
    for (const t of this.buildings.keys()) {
      const dx = t % w - cx, dy = ((t / w) | 0) - cy;
      if (dx * dx + dy * dy < 4 * r2) near.push(t);
    }
    const seen = new Set([tile]);
    const queue = [tile];
    const nb = new Int32Array(4);
    let best = -1, bestDist = Infinity;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], ix = i % w, iy = (i / w) | 0;
      const dist = (ix - cx) * (ix - cx) + (iy - cy) * (iy - cy);
      if (dist < bestDist && (type !== 'port' || GameMap.isCoastal(i))) {
        let clear = true;
        for (const t of near) {
          const dx = t % w - ix, dy = ((t / w) | 0) - iy;
          if (dx * dx + dy * dy < r2) { clear = false; break; }
        }
        if (clear) { best = i; bestDist = dist; }
      }
      const n = GameMap.neighbors(i, nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k];
        if (seen.has(j) || GameMap.owner[j] !== playerId) continue;
        const dx = j % w - cx, dy = ((j / w) | 0) - cy;
        if (dx * dx + dy * dy >= r2) continue;
        seen.add(j);
        queue.push(j);
      }
    }
    return best;
  },

  // The player's own finished structure of `type` nearest to `tile` and
  // within STRUCTURE_MIN_DIST of it, or null. Nothing new can be built that
  // close to it, so a click there with the same type armed means "upgrade
  // that one".
  upgradeTargetNear(playerId, type, tile) {
    const def = this.unitDef(type);
    if (!def || !def.upgradable || tile < 0) return null;
    const w = GameMap.width, x = tile % w, y = (tile / w) | 0;
    let best = null, bestDist = this.STRUCTURE_MIN_DIST * this.STRUCTURE_MIN_DIST;
    for (const b of this.buildings.values()) {
      if (b.type !== type || !b.built || GameMap.owner[b.tile] !== playerId) continue;
      const dx = b.tile % w - x, dy = ((b.tile / w) | 0) - y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { best = b; bestDist = dist; }
    }
    return best;
  },

  // Why a structure cannot go here, for the UI to say out loud. null when it
  // can, in the same shape as allianceBlockReason.
  //
  // The placement rule for a structure on land: your own land, and at least
  // STRUCTURE_MIN_DIST from anything already standing.
  buildBlockReason(playerId, type, tile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    if (!this.unitDef(type)) return 'Unknown structure';
    if (tile < 0 || GameMap.owner[tile] !== playerId) return 'Your own land only';
    if (this.structureTooClose(tile)) return 'Too close to another structure';
    // A Port must stand on the player's own land AND on an ocean shore
    // tile. The placement UI snaps a click near the coast first, so this
    // only fires for a tap too far inland to snap.
    if (type === 'port' && !GameMap.isCoastal(tile)) return 'Ports must be on the coast';
    // Radio Tower: fog matches only, and only where its disc still holds
    // something the builder has not discovered — a tower that would show
    // nothing is gold thrown away, since it does nothing else. That answer
    // comes from the builder's own discovered set alone, so it gives nothing
    // away about what the fog hides.
    if (type === 'radio') {
      if (!this.fog) return 'Fog of war matches only';
      if (this.visionHiddenAround(playerId, tile, this.VISION_SIGHT_RADIO) === 0) return 'Nothing left to uncover here';
    }
    if (p.gold < this.unitCost(p, type)) return 'Not enough gold';
    return null;
  },

  canBuild(playerId, type, tile) { return !this.buildBlockReason(playerId, type, tile); },

  build(playerId, type, tile) {
    if (!this.canBuild(playerId, type, tile)) return false;
    const p = this.players[playerId];
    const def = this.unitDef(type);
    p.gold -= this.unitCost(p, type);   // priced before any count goes up
    // Placed immediately, but not functional until `built` flips (see
    // updateConstruction). `level` is set to 1 once construction completes.
    // station/rails/lastTrainAt are only used by rail stations but are
    // carried on every building.
    this.buildings.set(tile, {
      type, tile, built: false, progress: 0, buildTime: def.buildTime, level: 0, upgrading: false,
      station: false, rails: new Map(), lastTrainAt: -Infinity,
      // Port-only fields (see "Ports & trade ships"), carried on every
      // building for the same reason station/rails/lastTrainAt are: cheaper
      // to always have the slot than to special-case the record shape.
      tradeRejections: 0, lastTradeCheckAt: -Infinity,
      // Silo-only (see "Missile Silo & Nukes"), carried on every building for
      // the same reason as the Port fields above. One launch time per missile
      // slot still reloading, capped at `level` — same model as samQueue
      // below.
      siloQueue: [],
      // SAM-only (sam.js). samQueue holds one timestamp per charge
      // reloading, capped at `level` (the SAM is in cooldown when
      // queue.length === level). samRangeUpgrade holds the in-progress range
      // ramp after a level-up (null once settled); see dynamicSamRange.
      samQueue: [], samRangeUpgrade: null
    });
    // The lifetime counter unitCost actually prices against — see unitCost's
    // comment. Only this call site and upgrade() touch it; setOwner()'s
    // capture path deliberately does not.
    p.unitsBuilt[type] = this.unitsBuilt(p, type) + 1;
    p.unitsPending[type] = this.unitsPending(p, type) + 1;
    return true;
  },

  // Why an existing structure can't be upgraded right now, for the UI to say
  // out loud — same null-or-reason shape as buildBlockReason. Priced and
  // gated exactly like a fresh build (see UNITS' cost comment): the next
  // level costs whatever unitCost says the next unit of this type costs,
  // because a level and a unit are the same pricing pool.
  upgradeBlockReason(playerId, tile) {
    const p = this.players[playerId];
    if (!p || !p.alive) return 'Nation defeated';
    const b = this.buildings.get(tile);
    if (!b) return 'Nothing built here';
    if (GameMap.owner[tile] !== playerId) return 'Your own land only';
    const def = this.unitDef(b.type);
    if (!def || !def.upgradable) return 'Cannot be upgraded';
    if (!b.built) return 'Still under construction';
    if (b.upgrading) return 'Already upgrading';
    if (p.gold < this.unitCost(p, b.type)) return 'Not enough gold';
    return null;
  },

  canUpgrade(playerId, tile) { return !this.upgradeBlockReason(playerId, tile); },

  upgrade(playerId, tile) {
    if (!this.canUpgrade(playerId, tile)) return false;
    const p = this.players[playerId];
    const b = this.buildings.get(tile);
    p.gold -= this.unitCost(p, b.type);   // priced before the level goes up
    b.upgrading = true;
    b.progress = 0;
    b.buildTime = this.UPGRADE_TIME;   // the upgrade timer, reusing the same bar
    // Same two counters a fresh build touches — an in-flight upgrade prices
    // the next build/upgrade higher immediately, exactly like a queued build
    // does, and unitsBuilt's ceiling climbs the moment gold is committed.
    p.unitsBuilt[b.type] = this.unitsBuilt(p, b.type) + 1;
    p.unitsPending[b.type] = this.unitsPending(p, b.type) + 1;
    return true;
  },

  // Advances every structure under construction or mid-upgrade and, when
  // its timer runs out, gives its owner the level: units[type] += 1 (a
  // fresh build and an upgrade are the same += 1, since units[type] is a
  // sum of levels). Ownership is read off the tile, not cached on the
  // building. setOwner() unwinds a captured mid-upgrade structure or
  // mid-build Fort; any other structure captured mid-build keeps ticking
  // here and finishes under its new owner.
  updateConstruction() {
    for (const b of this.buildings.values()) {
      if (!b.built) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.built = true;
        b.level = 1;
        const owner = GameMap.owner[b.tile];
        if (owner < 0) {
          if (b.type === 'radio') this.buildings.delete(b.tile);
          continue;
        }
        const p = this.players[owner];
        p.unitsPending[b.type] = Math.max(0, this.unitsPending(p, b.type) - 1);
        if (b.type !== 'radio') p.units[b.type] = this.unitsOwned(p, b.type) + 1;
        // Joining the rail network is a one-time event on first completion —
        // see the "Rail network & trains" section. An upgrade (the branch
        // below) never re-triggers it.
        this.onStructureCompleted(b);
        // Radio Tower: its one reveal, to whoever holds the tile now. Then
        // the record is removed, the tile is free again, and Fx plays the
        // scan. No units.radio is kept; unitCost prices off the lifetime
        // unitsBuilt.
        if (b.type === 'radio') {
          this.revealAround(owner, b.tile, this.VISION_SIGHT_RADIO);
          Fx.radioScan(b.tile, owner);
          this.buildings.delete(b.tile);
        }
      } else if (b.upgrading) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.upgrading = false;
        // A SAM's range ramps after an upgrade (see dynamicSamRange). The
        // start is captured before b.level++ so chained upgrades carry on
        // from the range in effect now. The new charge slot starts out
        // reloading, like a real launch.
        if (b.type === 'sam') {
          b.samRangeUpgrade = {
            startAt: this.elapsed,
            startRange: this.dynamicSamRange(b, this.elapsed),
            targetLevel: b.level + 1
          };
          b.samQueue.push(this.elapsed);
        }
        // Same for a Silo: the level-up pushes its missile queue too, so the
        // new slot reloads once before it can fire.
        if (b.type === 'silo') b.siloQueue.push(this.elapsed);
        b.level++;
        const owner = GameMap.owner[b.tile];
        if (owner < 0) continue;
        const p = this.players[owner];
        p.unitsPending[b.type] = Math.max(0, this.unitsPending(p, b.type) - 1);
        p.units[b.type] = this.unitsOwned(p, b.type) + 1;
      }
    }
  },

});
