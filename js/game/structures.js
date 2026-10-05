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
  // unitsBuilt) — see unitCost. unitsBuilt is a lifetime counter that only
  // this player's own build() and upgrade() calls raise; capturing a unit
  // changes its owner and nothing else. The min() is what that buys:
  // captured cities cannot push the price past what the player's own build
  // history set as the ceiling, though a count that fell behind (a built
  // city lost) can climb back up to it. A self-built run costs 125k, 250k,
  // 500k, 1M, then 1M forever, and an upgrade counts exactly as a build.
  //
  // `unitsOwned` (units[type] below) is therefore a SUM OF LEVELS, not a
  // headcount: a built unit contributes its level, one still under
  // construction a flat 1. A second city and a first city upgraded to level
  // 2 cost, and are worth, exactly the same. See maxTroopsRaw, which spends
  // that same sum on the pop bonus.
  //
  // buildTime is seconds of construction after placement, ticked in
  // Game.tick — see updateConstruction. City and Factory take 2, Port and
  // Defense Fort 5, Missile Silo 10, SAM Launcher 30, Radio Tower 5.
  //
  // Upgrades are instant: UPGRADE_TIME is 0, so the level lands on the next
  // updateConstruction pass. It is its own dial rather than buildTime so an
  // upgrade never inherits a structure's construction time.
  UPGRADE_TIME: 0,
  UNITS: [
    {
      type: 'city', name: 'City', icon: '🏙', hotkey: '1',
      baseCost: 125000, maxCost: 1000000, buildTime: 2, upgradable: true
    },
    // Factory: City's cost curve and build time, but priced against Factory
    // and Port counted together (costGroup) rather than its own count alone.
    // What it does — recruiting nearby cities into a rail network and
    // running trains between them for gold — is the "Rail network & trains"
    // section, hooked in through updateConstruction() the instant one
    // finishes.
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
    // Warship: LINEAR like Fort and pooled with nothing — (n+1)*250k capped
    // at 1M. Not upgradable. Placed on WATER near the player's own coast
    // rather than on owned land — see warshipBlockReason/buildWarship in the
    // "Warships" section, which does not read this entry's buildTime: a
    // warship spawns instantly, and the field is only here so the build-bar
    // hint has a number to show.
    //
    // `action: true` marks an entry that is never placed on a land tile
    // through buildBlockReason/build and never lands in Game.buildings.
    // AI.economy's generic cost-group loop skips these and gives each its
    // own purchase call instead (buildWarship / launchNuke). Without the
    // flag that loop would call Game.build(p.id, 'warship', buildSite(p)),
    // and with buildTime 0 a hit would plant a phantom "warship" in
    // Game.buildings that completes at once and raises units.warship,
    // inflating the real buildWarship price with builds that never touched
    // the fleet.
    {
      type: 'warship', name: 'Warship', icon: '🚢', hotkey: '5',
      baseCost: 250000, maxCost: 1000000, buildTime: 0, upgradable: false, linear: true, action: true
    },
    // Missile Silo: FLAT cost — a 2nd or 5th Silo costs exactly what the 1st
    // did. See unitCost's `flat` handling. Upgradable: each level is one
    // more missile slot that reloads on its own SILO_COOLDOWN (ticket #41,
    // see siloFreeSlots). Placement is the ordinary own-land
    // buildBlockReason/build path, exactly like City. What it does —
    // hosting nuke launches on a cooldown — is the "Missile Silo & Nukes"
    // section.
    {
      type: 'silo', name: 'Missile Silo', icon: '🚀', hotkey: '6',
      baseCost: 1000000, maxCost: 1000000, buildTime: 10, upgradable: true, flat: true
    },
    // Atom Bomb / Hydrogen Bomb: flat cost too, and `action: true` for the
    // same reason Warship is — a bomb click means "launch one at this tile
    // from my nearest ready Silo", not "place one exactly here", resolved
    // through resolveNukeLaunch/launchNuke rather than buildBlockReason/
    // build. See the "Missile Silo & Nukes" section for launch, flight and
    // detonation, and nukeMagnitudes for each type's inner/outer blast
    // radii. buildTime is carried only for build-bar consistency, as on
    // Warship: a nuke launches the instant it is ordered.
    {
      type: 'atombomb', name: 'Atom Bomb', icon: '☢', hotkey: '7',
      baseCost: 750000, maxCost: 750000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    {
      type: 'hydrogenbomb', name: 'Hydrogen Bomb', icon: '💥', hotkey: '8',
      baseCost: 5000000, maxCost: 5000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // SAM Launcher: the defensive interceptor. Named "SAM Launcher" rather
    // than anything with "Silo" in it, because Missile Silo (the offensive
    // nuke launcher above) is a separate building. LINEAR cost like Fort:
    // first SAM 1.5M, second and later pinned at the 3M cap. Own-land
    // placement with no special-casing, same as City/Fort/Silo. What it
    // does — charges, range per level, shooting down incoming nukes — is
    // the "SAM Launcher & Interceptors" section.
    {
      type: 'sam', name: 'SAM Launcher', icon: '📡', hotkey: '9',
      baseCost: 1500000, maxCost: 3000000, buildTime: 30, upgradable: true, linear: true
    },
    // MIRV (ticket #28): the top-tier multi-warhead strike. Same
    // `action: true` "strike here" shape as the two bombs above
    // (resolveNukeLaunch/launchMirv, not buildBlockReason/build), but its
    // cost follows none of baseCost/maxCost/flat/linear/costGroup: it is
    // 25M plus 15M for every MIRV any player has launched this match — a
    // whole-match counter, not this player's own build history — so
    // Game.unitCost special-cases type==='mirv' and returns before reading
    // these fields. They are set to MIRV_BASE_COST anyway so the entry
    // holds a sane number if anything reads it first. See nukes.js's
    // "MIRV" section for launch, flight, split and detonation.
    {
      type: 'mirv', name: 'MIRV', icon: '🛰', hotkey: '0',
      baseCost: 25000000, maxCost: 25000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // Fog of war's Scout (docs/fog-of-war.md, game/scouts.js): an unarmed
    // ship that uncovers the map. Flat 25k, and `action: true` for the same
    // reason Warship is: a click means "send one toward this tile from one
    // of my Ports" (resolveScoutLaunch/buildScout), not "place one here".
    // `fogOnly` marks an entry that only exists in fog matches: buildScout
    // refuses with fog off, and the build bar leaves the entry out. It has
    // no hotkey for the same reason. Last in the table so no other entry's
    // position moves.
    {
      type: 'scout', name: 'Scout', icon: '🔭',
      baseCost: 25000, maxCost: 25000, buildTime: 0, upgradable: false, flat: true, action: true, fogOnly: true
    },
    // Battle Royale's Drill (docs/battle-royale.md, game/drill.js). This
    // game's own unit. Flat 20M (DRILL_COST). `action: true` because it never
    // lands in Game.buildings: placement is drillBlockReason/placeDrill
    // (own land, instant, one per match), not buildBlockReason/build — and
    // the flag is also what keeps AI.economy's generic loop from buying it.
    // No hotkey yet; the build bar entry is BR-5. Last in the table so no
    // other entry's position moves.
    {
      type: 'drill', name: 'The Drill', icon: '🌀',
      baseCost: 20000000, maxCost: 20000000, buildTime: 0, upgradable: false, flat: true, action: true
    },
    // Fog of war's Radio Tower (docs/fog-of-war.md). This game's own unit: a
    // cheap structure on the builder's own land that uncovers a wide disc of
    // the map (VISION_SIGHT_RADIO) once, the moment it finishes — see
    // updateConstruction. It is how a landlocked nation, which can launch no
    // Scout, looks past its border. Discovery is permanent, so the tower has
    // done all it ever will by then; it stands on as an ordinary capturable
    // structure and what it showed survives its loss. LINEAR like Fort
    // (50k, 100k ... capped at 250k), so carpeting a border with them is a
    // real spend. Placed through the ordinary buildBlockReason/build path —
    // no `action` flag — but `fogOnly` like the Scout: refused with fog off,
    // left out of the build bar, no hotkey, and skipped by AI.economy's
    // generic loop (AI.buyRadio buys it instead). Last in the table so no
    // other entry's position moves.
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
    // Committed = finished-and-owned plus still-building — so queuing a
    // second one before the first finishes still prices at the doubled rate,
    // not the base rate `units` alone would show until completion.
    // costGroup (Port/Factory — see their UNITS entries) sums this same
    // per-type min() across every type in the group instead of just this
    // one: building either one raises the price of both, not just its own
    // kind.
    const types = def.costGroup || [type];
    let n = 0;
    for (const t of types) {
      const committed = this.unitsOwned(p, t) + this.unitsPending(p, t);
      n += Math.min(committed, this.unitsBuilt(p, t));
    }
    // Fort uses a LINEAR curve: (n+1)*baseCost, capped at maxCost.
    // City/factory/port use the exponential: 2^n * baseCost, capped at maxCost.
    //
    // This Math.pow is deliberately NOT routed through Game.det: base 2 with a
    // small non-negative integer exponent is exactly representable, so every
    // engine returns the identical double with no approximation involved. It
    // is the one exempt case in the determinism audit (architecture doc §7.2)
    // — leave it alone rather than "fixing" it.
    return def.linear
      ? Math.min(def.maxCost, (n + 1) * def.baseCost)
      : Math.min(def.maxCost, Math.pow(2, n) * def.baseCost);
  },

  // No structure may stand closer than this many tiles (Euclidean, strict
  // <) to any other structure — any type, any owner, finished or still
  // under construction. It is what stops icons stacking on top of each
  // other. The distance is one icon's width — a structure disc is about
  // 5.8 tiles across at the zooms where it scales with the map
  // (Render.structureRadius) — so two icons can sit side by side but never
  // overlap.
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

  // Where a placement click at `tile` should actually land: the nearest tile
  // to it that is the player's own, connected to the click through their own
  // land, within STRUCTURE_MIN_DIST of it, and clear of every other
  // structure. It takes the closest valid tile rather than refusing a click
  // that is merely near a structure. A Port also needs the coast, and is
  // allowed a click just off the player's shore. -1 when nothing qualifies.
  // Click interpretation for the UI, like nearestOwnedCoastNear: build()
  // takes the tile it is given.
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
    // tile — a Port sitting one tile inland could never actually touch
    // water for a trade ship to sail from. The placement UI snaps a click
    // near the coast onto the nearest valid tile first (see
    // nearestOwnedCoastNear), so this only fires for a tap too far inland to
    // snap at all.
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
    // Placed immediately, but not functional until `built` flips — see
    // updateConstruction. `progress`/`buildTime` are what the small bar drawn
    // in Render.drawStructures reads. `level` is set to 1 once construction
    // completes.
    // station/rails/lastTrainAt are only ever touched for city/factory types
    // (see the "Rail network & trains" section) but are cheap enough to carry
    // on every building rather than special-case the record shape by type.
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
      // SAM-only (see "SAM Launcher & Interceptors"). samQueue holds one
      // timestamp per charge currently reloading, capacity-capped at `level`
      // (the SAM is in cooldown when queue.length === level), so a level-2 SAM
      // can have two independent charges reloading on their own clocks at once.
      // samRangeUpgrade holds the in-progress range ramp after a level-up
      // (null once settled) — see dynamicSamRange.
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

  // Advances every structure still under construction OR mid-upgrade, and
  // hands the level increase to its owner — units[type] += 1, unlocking
  // whatever it grants (a city's pop cap) — the instant its timer runs out.
  // A fresh build's first level and an upgrade's next level are the same
  // += 1 here, since units[type] is a sum of levels, not a headcount — see
  // the UNITS comment. Ownership is read fresh off the tile rather than
  // cached on the building, so a structure captured mid-upgrade (or a Fort
  // captured mid-build) never reaches here at all: setOwner() unwinds that
  // in-flight progress on capture instead of letting it finish under a new
  // flag. A non-Fort captured mid-*build*, though, is deliberately left
  // alone by setOwner() and DOES keep ticking here — reading ownership off
  // the tile is exactly what lets it finish under its new owner with no
  // other bookkeeping.
  updateConstruction() {
    for (const b of this.buildings.values()) {
      if (!b.built) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.built = true;
        b.level = 1;
        const owner = GameMap.owner[b.tile];
        if (owner < 0) continue;
        const p = this.players[owner];
        p.unitsPending[b.type] = Math.max(0, this.unitsPending(p, b.type) - 1);
        p.units[b.type] = this.unitsOwned(p, b.type) + 1;
        // Joining the rail network is a one-time event on first completion —
        // see the "Rail network & trains" section. An upgrade (the branch
        // below) never re-triggers it.
        this.onStructureCompleted(b);
        // Fog of war's Radio Tower: its one reveal, to whoever holds the
        // tile now — a tower overrun mid-build finishes, and reveals, under
        // its new owner. A finished tower captured later reveals nothing.
        if (b.type === 'radio') this.revealAround(owner, b.tile, this.VISION_SIGHT_RADIO);
      } else if (b.upgrading) {
        b.progress += this.TICK_DT;
        if (b.progress < b.buildTime) continue;
        b.progress = b.buildTime;
        b.upgrading = false;
        // A SAM's range doesn't jump instantly on upgrade, it ramps smoothly
        // (see dynamicSamRange) — captured before b.level++ so the ramp starts
        // from whatever range is actually in effect right now (mid-ramp or
        // settled), so chained upgrades carry on from there rather than
        // resetting hard each time. The freshly gained charge slot also starts
        // consumed/reloading immediately, exactly like a real launch.
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
